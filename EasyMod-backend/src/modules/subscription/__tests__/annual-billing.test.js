/**
 * Historical annual rows — ADR-0011 retirement.
 *
 * Annual billing and plan selection are retired. A pre-cutover yearly row that
 * settles a residual invoice must still reactivate the shop, but activation
 * normalizes it to the single MERCHANT delivered-order tier and anchors a
 * monthly window; it never re-prices a year or revives an annual cycle.
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
        plan_code: 'GROWTH',
        plan_name: 'Growth',
        plan_price: 9990,
        billing_cycle: billingCycle,
        status: 'suspended',
        update: jest.fn(async (values) => { Object.assign(sub, values); return sub; }),
    };
    return sub;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / MS_PER_DAY);

beforeEach(() => jest.clearAllMocks());

describe('BILLING-YEARLY-HISTORICAL — a residual annual row activates on the single tier', () => {
    it('normalizes the plan to MERCHANT per_order with no annual fee', async () => {
        const sub = makeSubscription('yearly');

        await subscriptionService.activateFromPaidInvoice(sub, {
            targetPlanCode: 'GROWTH',
            targetBillingCycle: 'yearly',
        });

        expect(sub.plan_code).toBe('MERCHANT');
        expect(sub.plan_name).toBe('MERCHANT');
        expect(sub.plan_price).toBe(0);
        expect(sub.billing_cycle).toBe('monthly');
        expect(sub.billing_model).toBe('per_order');
        expect(sub.per_order_charge_bdt).toBe(10);
    });

    it('anchors a monthly window, never a year', async () => {
        const sub = makeSubscription('yearly');

        await subscriptionService.activateFromPaidInvoice(sub);

        const days = daysBetween(sub.current_period_start, sub.current_period_end);
        expect(days).toBeGreaterThanOrEqual(28);
        expect(days).toBeLessThanOrEqual(31);
        expect(sub.next_billing_date).toEqual(sub.current_period_end);
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

    // Residual pre-cutover invoices must still dunning-gate AI until settled.
    it('keeps every historical recurring type dunnable', () => {
        expect(RECURRING_INVOICE_TYPES).toEqual(
            expect.arrayContaining(['delivered_order', 'monthly_subscription', 'yearly_subscription', 'partner_per_order']),
        );
    });

    // Discretionary or retired one-offs must never suspend a shop.
    it('never treats a one-off as recurring', () => {
        expect(RECURRING_INVOICE_TYPES).not.toContain('Proration (upgrade)');
        expect(RECURRING_INVOICE_TYPES).not.toContain('topup');
    });
});