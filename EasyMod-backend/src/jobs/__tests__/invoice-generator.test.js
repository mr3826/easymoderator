/**
 * InvoiceGenerator unit tests (DB mocked).
 *
 * Two behaviours are covered:
 *  1. Legacy flat subscriptions are billed when their paid period ends, not
 *     when the calendar month turns (BILLING-YEARLY-*).
 *  2. ADR-0011: every per-order/MERCHANT subscription aggregates `billing_lines`
 *     over the previous UTC calendar month and issues one delivered-order
 *     invoice, with credits, dedupe and zero-rated-only periods.
 */

jest.mock('../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } })),
    },
}));

jest.mock('../../modules/entities', () => ({
    Subscription: { findAll: jest.fn() },
    Invoice: { findOne: jest.fn(), create: jest.fn() },
    Shop: {},
    BillingLine: { update: jest.fn(), findAll: jest.fn() },
    PartnerBillingAdjustment: { findAll: jest.fn().mockResolvedValue([]) },
}));

// Keep the real pure derivation, stub only the DB-touching lookups.
jest.mock('../../modules/commercial/delivered-order-billing.service', () => ({
    ...jest.requireActual('../../modules/commercial/delivered-order-billing.service'),
    getCommercialCutoverAt: jest.fn(),
    catchUpLines: jest.fn(),
    aggregateUninvoicedLines: jest.fn(),
    // Unit tests have no transaction: hand the candidate rows straight back as
    // the "locked" set. Integration tests exercise the real FOR UPDATE read.
    lockLinesForInvoice: jest.fn(async ({ lines }) => lines),
}));

const {
    Subscription,
    Invoice,
    BillingLine,
    PartnerBillingAdjustment,
} = require('../../modules/entities');
const billing = require('../../modules/commercial/delivered-order-billing.service');
const InvoiceGenerator = require('../invoice-generator');

const MONTHLY_PRICE = 999;
const YEARLY_PRICE = 9990;
const CUTOVER = new Date('2026-09-01T00:00:00.000Z');

const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const addYears = (d, n) => { const x = new Date(d); x.setFullYear(x.getFullYear() + n); return x; };

const RUN_DATE = new Date('2026-09-01T01:00:00.000Z');

const makeSubscription = (overrides = {}) => ({
    id: 'sub-1',
    shop_id: 'shop-1',
    plan_code: 'GROWTH',
    plan_name: 'Growth',
    plan_price: String(MONTHLY_PRICE),
    billing_model: 'flat_monthly',
    billing_cycle: 'monthly',
    status: 'active',
    conversations_used: 0,
    orders_used: 0,
    products_used: 0,
    extra_charge: '0.00',
    shop: { id: 'shop-1', name: 'Test Shop' },
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
});

/** A yearly subscriber who paid on `paidAt` and is entitled for a year. */
const yearlySubscription = (paidAt, overrides = {}) => makeSubscription({
    billing_cycle: 'yearly',
    plan_price: String(YEARLY_PRICE),
    current_period_start: paidAt,
    current_period_end: addYears(paidAt, 1),
    next_billing_date: addYears(paidAt, 1),
    ...overrides,
});

const monthlySubscription = (paidAt, overrides = {}) => makeSubscription({
    billing_cycle: 'monthly',
    plan_price: String(MONTHLY_PRICE),
    current_period_start: paidAt,
    current_period_end: addMonths(paidAt, 1),
    next_billing_date: addMonths(paidAt, 1),
    ...overrides,
});

/** The single MERCHANT / per-order subscription (ADR-0011). */
const merchantSubscription = (overrides = {}) => makeSubscription({
    plan_code: 'MERCHANT',
    plan_name: 'Merchant',
    plan_price: '0',
    billing_model: 'per_order',
    billing_cycle: 'per_order',
    next_billing_date: null,
    current_period_start: null,
    current_period_end: null,
    ...overrides,
});

const billingLine = (overrides = {}) => ({
    id: 'line-1',
    shop_id: 'shop-1',
    order_id: 'order-1',
    line_kind: 'billable',
    outcome: 'DELIVERED',
    amount_minor: 1000,
    occurred_at: '2026-10-05',
    invoice_id: null,
    ...overrides,
});

const runWith = async (subscriptions, runDate = RUN_DATE) => {
    Subscription.findAll.mockResolvedValueOnce(subscriptions);
    const job = new InvoiceGenerator();
    return job.run({ dryRun: false, runDate });
};

beforeEach(() => {
    jest.clearAllMocks();
    Invoice.findOne.mockResolvedValue(null);
    Invoice.create.mockImplementation(async (v) => ({ id: 'inv-1', ...v }));
    BillingLine.update.mockResolvedValue([1]);
    BillingLine.findAll.mockResolvedValue([]);
    PartnerBillingAdjustment.findAll.mockResolvedValue([]);
    billing.getCommercialCutoverAt.mockResolvedValue(CUTOVER);
    billing.catchUpLines.mockResolvedValue({ considered: 0, created: 0, skipped: 0, wouldCreate: 0 });
    billing.aggregateUninvoicedLines.mockResolvedValue([]);
    billing.lockLinesForInvoice.mockImplementation(async ({ lines }) => lines);
});

describe('BILLING-YEARLY-002 — one month into a paid year', () => {
    it('issues no invoice while the annual entitlement is still valid', async () => {
        const sub = yearlySubscription(new Date('2026-08-10T11:40:39.602Z'));

        const res = await runWith([sub]);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(res.invoicesGenerated).toBe(0);
        expect(res.invoicesSkipped).toBe(1);
    });

    it('issues no invoice on any monthly run across the whole year', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');

        for (let month = 1; month <= 11; month++) {
            jest.clearAllMocks();
            Invoice.findOne.mockResolvedValue(null);
            const res = await runWith([yearlySubscription(paidAt)], addMonths(paidAt, month));

            expect(Invoice.create).not.toHaveBeenCalled();
            expect(res.invoicesGenerated).toBe(0);
        }
    });

    it('does not touch subscription status — AI stays available', async () => {
        const sub = yearlySubscription(new Date('2026-08-10T11:40:39.602Z'));

        await runWith([sub]);

        expect(sub.update).not.toHaveBeenCalled();
        expect(sub.status).toBe('active');
    });
});

describe('BILLING-YEARLY-003 — the annual boundary', () => {
    it('issues exactly one annual renewal invoice, typed as yearly', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');
        const atBoundary = addYears(paidAt, 1);

        const res = await runWith([yearlySubscription(paidAt)], atBoundary);

        expect(Invoice.create).toHaveBeenCalledTimes(1);
        expect(Invoice.create).toHaveBeenCalledWith(expect.objectContaining({
            invoice_type: 'yearly_subscription',
        }), expect.anything());
        expect(res.invoicesGenerated).toBe(1);
    });

    it('bills the period the subscriber actually held — a year, not a month', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');

        await runWith([yearlySubscription(paidAt)], addYears(paidAt, 1));

        const [[created]] = Invoice.create.mock.calls;
        expect(created.billing_period_start).toEqual(paidAt);
        expect(created.billing_period_end).toEqual(addYears(paidAt, 1));
    });
});

describe('BILLING-YEARLY-004 — annual amount', () => {
    it('charges the annual plan price, not the monthly price', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');

        await runWith([yearlySubscription(paidAt)], addYears(paidAt, 1));

        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(YEARLY_PRICE);
        expect(created.base_amount).toBe(YEARLY_PRICE);
    });
});

describe('BILLING-YEARLY-005 — dunning waits for the entitlement to expire', () => {
    it('creates no dunnable invoice at any point inside the paid year', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');
        const dayBeforeBoundary = new Date(addYears(paidAt, 1).getTime() - 1);

        const res = await runWith([yearlySubscription(paidAt)], dayBeforeBoundary);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(res.invoicesGenerated).toBe(0);
    });

    it('the invoice it writes at the boundary is dunnable, so a real lapse still suspends', () => {
        const { RECURRING_INVOICE_TYPES } = require('../../modules/subscription/subscription.plans');
        expect(RECURRING_INVOICE_TYPES).toContain('yearly_subscription');
    });
});

describe('BILLING-MONTHLY-REGRESSION — monthly subscriptions still renew monthly', () => {
    it('issues a monthly invoice once the month is up', async () => {
        const paidAt = new Date('2026-08-01T00:00:00.000Z');

        const res = await runWith([monthlySubscription(paidAt)], addMonths(paidAt, 1));

        expect(Invoice.create).toHaveBeenCalledTimes(1);
        expect(Invoice.create).toHaveBeenCalledWith(expect.objectContaining({
            invoice_type: 'monthly_subscription',
            amount: MONTHLY_PRICE,
        }), expect.anything());
        expect(res.invoicesGenerated).toBe(1);
    });

    it('does not bill a monthly subscriber mid-month', async () => {
        const paidAt = new Date('2026-08-01T00:00:00.000Z');

        await runWith([monthlySubscription(paidAt)], new Date('2026-08-15T01:00:00.000Z'));

        expect(Invoice.create).not.toHaveBeenCalled();
    });
});

describe('BILLING-IDEMPOTENCY — re-running the job for the same boundary', () => {
    it('does not write a second invoice when one already covers the period', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');
        const atBoundary = addYears(paidAt, 1);

        const first = await runWith([yearlySubscription(paidAt)], atBoundary);
        expect(first.invoicesGenerated).toBe(1);

        jest.clearAllMocks();
        Invoice.findOne.mockResolvedValue({ id: 'inv-1', invoice_number: 'INV-1' });
        const second = await runWith([yearlySubscription(paidAt)], atBoundary);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(second.invoicesGenerated).toBe(0);
        expect(second.invoicesSkipped).toBe(1);
    });

    it('looks the invoice up by the period being billed, not the calendar month', async () => {
        const paidAt = new Date('2026-08-10T11:40:39.602Z');

        await runWith([yearlySubscription(paidAt)], addYears(paidAt, 1));

        expect(Invoice.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ billing_period_start: paidAt }),
        }));
    });
});

describe('subscriptions with no recorded period', () => {
    it('is billed rather than skipped — failing closed would stop invoicing a real customer', async () => {
        const sub = makeSubscription({
            current_period_start: null, current_period_end: null, next_billing_date: null,
        });

        const res = await runWith([sub]);

        expect(res.invoicesGenerated).toBe(1);
    });
});

describe('SHURU tier', () => {
    it('is never invoiced even once its period has lapsed', async () => {
        const sub = monthlySubscription(new Date('2026-01-01T00:00:00.000Z'), {
            plan_code: 'SHURU', plan_name: 'Shuru', plan_price: '0',
        });

        const res = await runWith([sub]);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(res.invoicesSkipped).toBe(1);
    });
});

describe('ADR-0011 delivered-order aggregation', () => {
    const runDate = new Date('2026-11-01T01:00:00.000Z');
    const octoberStart = new Date(Date.UTC(2026, 9, 1));
    const novemberStart = new Date(Date.UTC(2026, 10, 1));

    it('aggregates the previous UTC month and issues one delivered-order invoice', async () => {
        const lines = [
            ...Array.from({ length: 10 }, (_, i) => billingLine({ id: `b-${i}`, order_id: `o-${i}` })),
            billingLine({ id: 'z-1', order_id: 'r-1', line_kind: 'zero_rated', outcome: 'RETURNED', amount_minor: 0 }),
            billingLine({ id: 'z-2', order_id: 'c-1', line_kind: 'zero_rated', outcome: 'CANCELLED', amount_minor: 0 }),
        ];
        billing.aggregateUninvoicedLines.mockResolvedValueOnce(lines);

        const res = await runWith([merchantSubscription()], runDate);

        expect(billing.catchUpLines).toHaveBeenCalledWith({
            shopId: 'shop-1',
            periodStart: octoberStart,
            periodEnd: novemberStart,
            cutoverAt: CUTOVER,
        });
        expect(billing.aggregateUninvoicedLines).toHaveBeenCalledWith({
            shopId: 'shop-1',
            periodStart: octoberStart,
            periodEnd: novemberStart,
            cutoverAt: CUTOVER,
        });

        expect(Invoice.create).toHaveBeenCalledTimes(1);
        const [[created]] = Invoice.create.mock.calls;
        expect(created).toMatchObject({
            invoice_type: 'delivered_order',
            amount: 100,
            base_amount: 0,
            extra_usage_amount: 100,
            status: 'pending',
            billing_period_start: octoberStart,
            billing_period_end: novemberStart,
            due_date: new Date(runDate.getTime() + 7 * 24 * 60 * 60 * 1000),
        });
        expect(created.metadata).toMatchObject({
            contractVersion: '1.0.0',
            model: 'DELIVERED_ORDER',
            unitPriceMinor: 1000,
            deliveredCount: 10,
            zeroRatedCount: 2,
            grossMinor: 10000,
            creditMinor: 0,
            netMinor: 10000,
        });
        expect(created.metadata.lines).toHaveLength(12);
        expect(created.metadata).not.toHaveProperty('customerName');

        expect(BillingLine.update).toHaveBeenCalledWith(
            { invoice_id: 'inv-1' },
            expect.objectContaining({
                where: expect.objectContaining({ shop_id: 'shop-1', invoice_id: null }),
            }),
        );
        expect(res.invoicesGenerated).toBe(1);
        expect(res.totalInvoiceAmount).toBe(100);
    });

    it('issues an explicit BDT 0 invoice when the period only has zero-rated lines', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([
            billingLine({ line_kind: 'zero_rated', outcome: 'RETURNED', amount_minor: 0 }),
        ]);

        const res = await runWith([merchantSubscription()], runDate);

        expect(Invoice.create).toHaveBeenCalledTimes(1);
        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(0);
        expect(created.metadata).toMatchObject({
            grossMinor: 0,
            netMinor: 0,
            deliveredCount: 0,
            zeroRatedCount: 1,
        });
        expect(res.invoicesGenerated).toBe(1);
    });

    it('nets pending reversal credits against the delivered total', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([billingLine()]);
        const adjustment = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        PartnerBillingAdjustment.findAll.mockResolvedValueOnce([adjustment]);

        await runWith([merchantSubscription()], runDate);

        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(0);
        expect(created.metadata).toMatchObject({ grossMinor: 1000, creditMinor: 1000, netMinor: 0 });
        expect(adjustment.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'applied', invoice_id: 'inv-1',
        }), expect.anything());
    });

    it('skips when the period has no lines at all', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([]);

        const res = await runWith([merchantSubscription()], runDate);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(res.invoicesSkipped).toBe(1);
        expect(res.invoicesGenerated).toBe(0);
    });

    it('dedupes on an existing delivered-order invoice before aggregating', async () => {
        Invoice.findOne.mockResolvedValueOnce({ id: 'inv-existing', invoice_number: 'INV-X' });

        const res = await runWith([merchantSubscription()], runDate);

        expect(Invoice.create).not.toHaveBeenCalled();
        expect(billing.aggregateUninvoicedLines).not.toHaveBeenCalled();
        expect(res.invoicesSkipped).toBe(1);
    });

    it('recovers from a concurrent unique-violation as an existing invoice', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([billingLine()]);
        const existing = { id: 'inv-existing', invoice_number: 'INV-X' };
        Invoice.findOne
            .mockResolvedValueOnce(null)     // pre-check
            .mockResolvedValueOnce(existing); // unique-constraint recovery
        Invoice.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), {
            name: 'SequelizeUniqueConstraintError',
        }));

        const res = await runWith([merchantSubscription()], runDate);

        expect(res.invoicesSkipped).toBe(1);
        expect(res.invoicesGenerated).toBe(0);
    });

    it('does not write catch-up or an invoice in dry-run mode', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([billingLine()]);
        Subscription.findAll.mockResolvedValueOnce([merchantSubscription()]);

        const job = new InvoiceGenerator();
        await job.run({ dryRun: true, runDate });

        expect(billing.catchUpLines).not.toHaveBeenCalled();
        expect(Invoice.create).not.toHaveBeenCalled();
    });
});
describe('ADR-0011 late-delivery charge-forward', () => {
    const runDate = new Date('2026-11-01T01:00:00.000Z');
    const octoberStart = new Date(Date.UTC(2026, 9, 1));

    it('carries an un-invoiced prior-period line into the current invoice and flags it', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([
            billingLine({ id: 'oct-1', order_id: 'o-oct', occurred_at: '2026-10-05' }),
        ]);
        BillingLine.findAll.mockResolvedValueOnce([
            billingLine({ id: 'sep-1', order_id: 'o-sep', occurred_at: '2026-09-15' }),
        ]);

        const res = await runWith([merchantSubscription()], runDate);

        // Prior-period query is an un-invoiced, pre-periodStart read.
        expect(BillingLine.findAll).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                shop_id: 'shop-1',
                invoice_id: null,
            }),
        }));

        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(20);
        expect(created.metadata).toMatchObject({
            grossMinor: 2000,
            netMinor: 2000,
            deliveredCount: 2,
            priorPeriodAdjustmentMinor: 1000,
            priorPeriodAdjustmentCount: 1,
        });
        const lateLine = created.metadata.lines.find((line) => line.orderId === 'o-sep');
        expect(lateLine).toMatchObject({
            kind: 'billable',
            amountMinor: 1000,
            occurredAt: '2026-09-15',
            priorPeriodAdjustment: true,
        });
        const currentLine = created.metadata.lines.find((line) => line.orderId === 'o-oct');
        expect(currentLine.priorPeriodAdjustment).toBe(false);

        // Both lines are claimed by the new invoice; no issued invoice is rewritten.
        const [updateValues, updateOptions] = BillingLine.update.mock.calls[0];
        expect(updateValues).toEqual({ invoice_id: 'inv-1' });
        expect(updateOptions.where).toMatchObject({ shop_id: 'shop-1', invoice_id: null });
        expect(res.invoicesGenerated).toBe(1);
    });

    it('A5 — defers the whole period when no cutover instant is persisted', async () => {
        billing.getCommercialCutoverAt.mockResolvedValueOnce(null);

        const res = await runWith([merchantSubscription()], runDate);

        // Fail closed: no aggregation, no catch-up, no invoice. Billing a
        // period without the cutover would charge pre-cutover history.
        expect(billing.aggregateUninvoicedLines).not.toHaveBeenCalled();
        expect(billing.catchUpLines).not.toHaveBeenCalled();
        expect(BillingLine.findAll).not.toHaveBeenCalled();
        expect(Invoice.create).not.toHaveBeenCalled();
        expect(res.invoicesGenerated).toBe(0);
        expect(res.invoicesSkipped).toBe(1);
    });

    it('charges forward when the current period itself has no usage', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([]);
        BillingLine.findAll.mockResolvedValueOnce([
            billingLine({ id: 'sep-2', order_id: 'o-sep-2', occurred_at: '2026-09-20' }),
        ]);

        const res = await runWith([merchantSubscription()], runDate);

        expect(Invoice.create).toHaveBeenCalledTimes(1);
        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(10);
        expect(created.metadata).toMatchObject({
            grossMinor: 1000,
            priorPeriodAdjustmentMinor: 1000,
            priorPeriodAdjustmentCount: 1,
        });
        expect(res.invoicesGenerated).toBe(1);
    });
});

describe('ADR-0011 cutover floor (A4)', () => {
    it('applies occurred_at >= cutoverAt even when the cutover is inside the period', async () => {
        const job = new InvoiceGenerator();
        const periodStart = new Date(Date.UTC(2026, 9, 1));
        const midMonthCutover = new Date(Date.UTC(2026, 9, 15));

        BillingLine.findAll.mockResolvedValueOnce([]);
        await job.priorPeriodUninvoicedLines('shop-1', periodStart, midMonthCutover);

        const { where } = BillingLine.findAll.mock.calls[0][0];
        const floorValues = Object.getOwnPropertySymbols(where.occurred_at)
            .map((symbol) => where.occurred_at[symbol]);
        // The floor is present, so a pre-cutover line cannot leak forward even
        // though `cutoverAt` is not earlier than periodStart.
        expect(floorValues).toContain('2026-10-15');
        expect(floorValues).toContain('2026-10-01');
    });
});

describe('ADR-0011 credit carry-forward (A1)', () => {
    const runDate = new Date('2026-11-01T01:00:00.000Z');

    it('applies only credits that fit the gross and leaves the surplus pending', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([billingLine()]); // gross 1000
        const first = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        const second = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        PartnerBillingAdjustment.findAll.mockResolvedValueOnce([first, second]);

        await runWith([merchantSubscription()], runDate);

        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(0);
        expect(created.metadata).toMatchObject({
            grossMinor: 1000,
            creditMinor: 1000,
            netMinor: 0,
        });
        // Exactly one whole credit is consumed; the second is NOT destroyed —
        // it stays pending and carries forward to the next invoice.
        expect(first.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'applied', invoice_id: 'inv-1',
        }), expect.anything());
        expect(second.update).not.toHaveBeenCalled();
    });

    it('applies no credit at all on a zero-gross period', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([
            billingLine({ line_kind: 'zero_rated', outcome: 'RETURNED', amount_minor: 0 }),
        ]);
        const adjustment = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        PartnerBillingAdjustment.findAll.mockResolvedValueOnce([adjustment]);

        await runWith([merchantSubscription()], runDate);

        const [[created]] = Invoice.create.mock.calls;
        expect(created.amount).toBe(0);
        expect(created.metadata).toMatchObject({
            grossMinor: 0,
            creditMinor: 0,
            netMinor: 0,
        });
        expect(adjustment.update).not.toHaveBeenCalled();
    });

    it('applies multiple credits while they fit under the gross', async () => {
        billing.aggregateUninvoicedLines.mockResolvedValueOnce([
            billingLine({ id: 'b-1', order_id: 'o-1' }),
            billingLine({ id: 'b-2', order_id: 'o-2' }),
            billingLine({ id: 'b-3', order_id: 'o-3' }), // gross 3000
        ]);
        const first = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        const second = { amount_bdt: '15.00', update: jest.fn().mockResolvedValue(undefined) };
        const third = { amount_bdt: '10.00', update: jest.fn().mockResolvedValue(undefined) };
        PartnerBillingAdjustment.findAll.mockResolvedValueOnce([first, second, third]);

        await runWith([merchantSubscription()], runDate);

        const [[created]] = Invoice.create.mock.calls;
        // 1000 + 1500 fit; the remaining 500 blocks the third credit entirely.
        expect(created.metadata).toMatchObject({
            grossMinor: 3000,
            creditMinor: 2500,
            netMinor: 500,
        });
        expect(first.update).toHaveBeenCalled();
        expect(second.update).toHaveBeenCalled();
        expect(third.update).not.toHaveBeenCalled();
    });
});
