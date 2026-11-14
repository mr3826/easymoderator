/**
 * Annual billing invariant — a yearly entitlement is a year long, and the
 * renewal it schedules is an annual one (entities and cache mocked).
 *
 * Pairs with jobs/__tests__/invoice-generator.test.js: this asserts the period
 * that gets *written* when a yearly invoice is paid, that one asserts the
 * generator honours it.
 */

jest.mock('../../entities', () => ({
    Subscription: { findOne: jest.fn(), create: jest.fn() },
    Invoice: { findOne: jest.fn(), create: jest.fn() },
    UsageEvent: {},
    AuditLog: {},
    UserShop: { findOne: jest.fn() },
}));
jest.mock('../../../utils/cache.service', () => ({
    clearForShop: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const subscriptionService = require('../subscription.service');
const { recurringInvoiceTypeFor, RECURRING_INVOICE_TYPES } = require('../subscription.plans');

/** Captures what activateFromPaidInvoice writes back to the subscription. */
const makeSubscription = (billingCycle) => {
    const sub = {
        id: 'sub-1',
        shop_id: 'shop-1',
        billing_cycle: billingCycle,
        status: 'suspended',
        update: jest.fn(async (values) => { Object.assign(sub, values); return sub; }),
    };
    return sub;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / MS_PER_DAY);

beforeEach(() => jest.clearAllMocks());

describe('BILLING-YEARLY-001 — a paid yearly subscription is entitled for a year', () => {
    it('anchors a period one year long', async () => {
        const sub = makeSubscription('yearly');

        await subscriptionService.activateFromPaidInvoice(sub);

        const days = daysBetween(sub.current_period_start, sub.current_period_end);
        expect(days).toBeGreaterThanOrEqual(365);
        expect(days).toBeLessThanOrEqual(366);
    });

    it('schedules the next renewal at the annual boundary, not a month out', async () => {
        const sub = makeSubscription('yearly');

        await subscriptionService.activateFromPaidInvoice(sub);

        expect(sub.next_billing_date).toEqual(sub.current_period_end);
        expect(daysBetween(sub.current_period_start, sub.next_billing_date))
            .toBeGreaterThanOrEqual(365);
    });

    it('restores AI access', async () => {
        const sub = makeSubscription('yearly');

        await subscriptionService.activateFromPaidInvoice(sub);

        expect(sub.status).toBe('active');
    });
});

describe('BILLING-MONTHLY-REGRESSION — a monthly subscription is still a month', () => {
    it('anchors a period about a month long', async () => {
        const sub = makeSubscription('monthly');

        await subscriptionService.activateFromPaidInvoice(sub);

        const days = daysBetween(sub.current_period_start, sub.current_period_end);
        expect(days).toBeGreaterThanOrEqual(28);
        expect(days).toBeLessThanOrEqual(31);
    });
});

describe('recurring invoice types', () => {
    it.each([
        ['yearly', 'yearly_subscription'],
        ['monthly', 'monthly_subscription'],
        ['per_order', 'delivered_order'],
    ])('maps the %s cycle to %s', (cycle, expected) => {
        expect(recurringInvoiceTypeFor(cycle)).toBe(expected);
    });

    // A yearly renewal that genuinely lapses must still gate AI — the fix defers
    // annual dunning, it does not exempt annual subscribers from it.
    it('treats every cycle as dunnable once actually overdue', () => {
        expect(RECURRING_INVOICE_TYPES).toEqual(
            expect.arrayContaining(['monthly_subscription', 'yearly_subscription', 'partner_per_order']),
        );
    });

    // Discretionary purchases must never suspend a shop.
    it('never treats a one-off as recurring', () => {
        expect(RECURRING_INVOICE_TYPES).not.toContain('Proration (upgrade to Growth)');
        expect(RECURRING_INVOICE_TYPES).not.toContain('topup');
    });
});
