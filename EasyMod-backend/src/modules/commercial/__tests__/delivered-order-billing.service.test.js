'use strict';

/**
 * Delivered-order billing engine unit tests (no DB, no network).
 *
 * Covers the pure invoice derivation, deterministic idempotency, reversal
 * semantics (pre- vs post-invoice), and cut-up backfill.
 */

jest.mock('../../entities', () => ({
    BillingLine: {
        findOne: jest.fn(),
        findOrCreate: jest.fn(),
        findAll: jest.fn(),
        update: jest.fn(),
    },
    Order: { findAll: jest.fn() },
}));

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        query: jest.fn(),
        getDialect: jest.fn(() => 'postgres'),
    },
}));

const { BillingLine, Order } = require('../../entities');
const { sequelize } = require('../../../utils/database/database-setup');
const billing = require('../delivered-order-billing.service');
const { COMMERCIAL_CONTRACT, COMMERCIAL_CONTRACT_VERSION } = require('../commercial.contract');

const line = (overrides = {}) => ({
    id: 'line-1',
    shop_id: 'shop-1',
    order_id: 'order-1',
    line_kind: 'billable',
    outcome: 'DELIVERED',
    unit_price_minor: 1000,
    amount_minor: 1000,
    invoice_id: null,
    source: 'courier_webhook',
    metadata: {},
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    billing.__resetForTests();
    BillingLine.findOne.mockResolvedValue(null);
    BillingLine.findAll.mockResolvedValue([]);
    BillingLine.update.mockResolvedValue([1]);
    sequelize.query.mockResolvedValue([[{ id: 'line-1' }], 1]);
    sequelize.getDialect.mockReturnValue('postgres');
});

describe('computeInvoiceFromLines (pure)', () => {
    const delivered = (n) => Array.from({ length: n }, (_, i) => ({
        order_id: `o-${i}`, line_kind: 'billable', outcome: 'DELIVERED',
        amount_minor: 1000, occurred_at: '2026-10-05',
    }));

    it('sums delivered lines, keeps zero-rated lines, and nets credits', () => {
        const lines = [
            ...delivered(10),
            { order_id: 'r-1', line_kind: 'zero_rated', outcome: 'RETURNED', amount_minor: 0, occurred_at: '2026-10-11' },
            { order_id: 'c-1', line_kind: 'zero_rated', outcome: 'CANCELLED', amount_minor: 0, occurred_at: '2026-10-12' },
        ];

        const result = billing.computeInvoiceFromLines(lines, 1500);

        expect(result).toMatchObject({
            grossMinor: 10000,
            creditMinor: 1500,
            netMinor: 8500,
            deliveredCount: 10,
            zeroRatedCount: 2,
        });
        expect(result.lines).toHaveLength(12);
        expect(result.lines[0]).toEqual({
            orderId: 'o-0',
            kind: 'billable',
            outcome: 'DELIVERED',
            amountMinor: 1000,
            occurredAt: '2026-10-05',
        });
    });

    it('clamps the net at zero and ignores negative credits', () => {
        const result = billing.computeInvoiceFromLines(delivered(2), 999999);
        expect(result.grossMinor).toBe(2000);
        expect(result.creditMinor).toBe(999999);
        expect(result.netMinor).toBe(0);

        const negative = billing.computeInvoiceFromLines(delivered(1), -500);
        expect(negative.creditMinor).toBe(0);
        expect(negative.netMinor).toBe(1000);
    });

    it('returns zeroed totals for no lines', () => {
        expect(billing.computeInvoiceFromLines()).toEqual({
            grossMinor: 0,
            creditMinor: 0,
            netMinor: 0,
            deliveredCount: 0,
            zeroRatedCount: 0,
            lines: [],
        });
    });

    it('accepts camelCase service-boundary rows', () => {
        const result = billing.computeInvoiceFromLines([{
            orderId: 'o-9', lineKind: 'billable', outcome: 'delivered',
            amountMinor: 1000, occurredAt: new Date('2026-10-09T12:00:00Z'),
        }]);
        expect(result.netMinor).toBe(1000);
        expect(result.lines[0].occurredAt).toBe('2026-10-09');
    });
});

describe('billingIdempotencyKey', () => {
    it('is deterministic and distinguishes line kinds', () => {
        const a = billing.billingIdempotencyKey('shop-1', 'order-1', 'billable');
        const b = billing.billingIdempotencyKey('shop-1', 'order-1', 'billable');
        const c = billing.billingIdempotencyKey('shop-1', 'order-1', 'zero_rated');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('recordOutcomeLine', () => {
    it('writes a billable line at the contract unit price with a single INSERT', async () => {
        const created = line();
        BillingLine.findOne
            .mockResolvedValueOnce(null)    // pre-check: no terminal line yet
            .mockResolvedValueOnce(created); // read back after INSERT

        const result = await billing.recordOutcomeLine({
            shopId: 'shop-1', orderId: 'order-1', outcome: 'DELIVERED',
            provider: 'pathao', occurredAt: '2026-10-05', source: 'courier_webhook',
        }, { LOCK: { UPDATE: 'UPDATE' } });

        expect(result.created).toBe(true);
        const [sql, options] = sequelize.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO billing_lines/i);
        // A6: the insert must survive a duplicate without aborting the caller's
        // transaction — ON CONFLICT DO NOTHING, never findOrCreate.
        expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
        expect(BillingLine.findOrCreate).not.toHaveBeenCalled();
        expect(options.replacements).toMatchObject({
            shop_id: 'shop-1',
            order_id: 'order-1',
            line_kind: 'billable',
            outcome: 'DELIVERED',
            unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
            amount_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
            currency: 'BDT',
            contract_version: COMMERCIAL_CONTRACT_VERSION,
            source: 'courier_webhook',
            provider: 'pathao',
            occurred_at: '2026-10-05',
            invoice_id: null,
        });
        expect(options.replacements.idempotency_key).toBe(
            billing.billingIdempotencyKey('shop-1', 'order-1', 'billable'),
        );
    });

    it('writes a zero-rated line for RETURNED and CANCELLED', async () => {
        // No prior row: each call takes the insert path.
        BillingLine.findOne.mockResolvedValue(null);

        await billing.recordOutcomeLine({ shopId: 's', orderId: 'o', outcome: 'RETURNED' });
        await billing.recordOutcomeLine({ shopId: 's', orderId: 'o', outcome: 'CANCELLED' });

        const kinds = sequelize.query.mock.calls.map(([, options]) => [
            options.replacements.line_kind, options.replacements.amount_minor,
        ]);
        expect(kinds).toEqual([['zero_rated', 0], ['zero_rated', 0]]);
    });

    it('is idempotent: a replayed outcome returns the existing row', async () => {
        const existing = line();
        BillingLine.findOne.mockResolvedValueOnce(existing);

        const result = await billing.recordOutcomeLine({
            shopId: 'shop-1', orderId: 'order-1', outcome: 'DELIVERED',
        });

        expect(result).toEqual({ line: existing, created: false });
        expect(sequelize.query).not.toHaveBeenCalled();
    });

    it('A6 — a duplicate insert is a no-op, not a transaction-aborting error', async () => {
        const existing = line();
        // pre-check finds nothing (a concurrent writer has not committed yet)
        // and the INSERT ... ON CONFLICT DO NOTHING returns zero rows.
        BillingLine.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(existing);
        sequelize.query.mockResolvedValueOnce([[], 0]);

        const result = await billing.recordOutcomeLine({
            shopId: 'shop-1', orderId: 'order-1', outcome: 'DELIVERED',
        });

        expect(result).toEqual({ line: existing, created: false });
        const [sql] = sequelize.query.mock.calls[0];
        expect(sql).toMatch(/ON CONFLICT DO NOTHING/i);
    });

    it('A7 — a later DELIVERED upgrades a CANCELLED zero line to billable', async () => {
        const cancelled = line({
            line_kind: 'zero_rated', outcome: 'CANCELLED', amount_minor: 0, invoice_id: null,
        });
        BillingLine.findOne.mockResolvedValueOnce(cancelled);
        BillingLine.update.mockResolvedValueOnce([1]);

        const result = await billing.recordOutcomeLine({
            shopId: 'shop-1', orderId: 'order-1', outcome: 'DELIVERED',
            provider: 'pathao', occurredAt: '2026-10-06', source: 'courier_webhook',
        });

        expect(result.created).toBe(false);
        expect(result.upgraded).toBe(true);
        expect(result.line.line_kind).toBe('billable');
        expect(result.line.amount_minor).toBe(COMMERCIAL_CONTRACT.unitPriceMinor);
        const [[values, options]] = BillingLine.update.mock.calls;
        expect(values).toMatchObject({
            line_kind: 'billable',
            outcome: 'DELIVERED',
            amount_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
            idempotency_key: billing.billingIdempotencyKey('shop-1', 'order-1', 'billable'),
        });
        expect(options.where).toMatchObject({
            id: cancelled.id,
            line_kind: 'zero_rated',
            outcome: 'CANCELLED',
            invoice_id: null,
        });
        // No second row is written for the same order.
        expect(sequelize.query).not.toHaveBeenCalled();
    });

    it('A7 — RETURNED is final: a DELIVERED callback leaves the zero line unchanged', async () => {
        const returned = line({
            line_kind: 'zero_rated', outcome: 'RETURNED', amount_minor: 0, invoice_id: null,
        });
        BillingLine.findOne.mockResolvedValueOnce(returned);

        const result = await billing.recordOutcomeLine({
            shopId: 'shop-1', orderId: 'order-1', outcome: 'DELIVERED',
        });

        expect(result).toEqual({ line: returned, created: false });
        expect(BillingLine.update).not.toHaveBeenCalled();
        expect(result.line.amount_minor).toBe(0);
    });

    it('rejects unsupported outcomes and missing tenant identifiers', async () => {
        await expect(billing.recordOutcomeLine({ shopId: 's', orderId: 'o', outcome: 'DRAFT' }))
            .rejects.toThrow(/unsupported billing outcome/i);
        await expect(billing.recordOutcomeLine({ shopId: null, orderId: 'o', outcome: 'DELIVERED' }))
            .rejects.toThrow(/shopId and orderId/i);
    });
});

describe('reverseLineForReturn', () => {
    it('zero-rates a not-yet-invoiced billable line in place', async () => {
        const billable = line();
        BillingLine.findOne.mockResolvedValueOnce(billable);

        const result = await billing.reverseLineForReturn({ shopId: 'shop-1', orderId: 'order-1' });

        expect(result.reversed).toBe(true);
        const [[values]] = BillingLine.update.mock.calls;
        expect(values).toMatchObject({
            line_kind: 'zero_rated',
            outcome: 'RETURNED',
            amount_minor: 0,
            source: 'return_approval',
        });
        expect(values.metadata).toMatchObject({ reversedFrom: 'billable' });
    });

    it('never rewrites an invoiced document', async () => {
        BillingLine.findOne.mockResolvedValueOnce(line({ invoice_id: 'inv-1' }));

        const result = await billing.reverseLineForReturn({ shopId: 'shop-1', orderId: 'order-1' });

        expect(result).toEqual({ reversed: false, reason: 'invoiced', invoiceId: 'inv-1' });
        expect(BillingLine.update).not.toHaveBeenCalled();
    });

    it('no-ops when the order has no billable line', async () => {
        BillingLine.findOne.mockResolvedValueOnce(null);
        await expect(billing.reverseLineForReturn({ shopId: 's', orderId: 'o' }))
            .resolves.toEqual({ reversed: false, reason: 'no_billable_line' });
    });
});

describe('catchUpLines', () => {
    const period = {
        periodStart: new Date('2026-10-01T00:00:00Z'),
        periodEnd: new Date('2026-11-01T00:00:00Z'),
    };

    it('does nothing without a cutover instant', async () => {
        const result = await billing.catchUpLines({ shopId: 'shop-1', ...period, cutoverAt: null });
        expect(result).toEqual({ considered: 0, created: 0, skipped: 0, wouldCreate: 0 });
        expect(Order.findAll).not.toHaveBeenCalled();
    });

    it('inserts a zero-rated line for a delivered order that was returned', async () => {
        Order.findAll
            .mockResolvedValueOnce([{
                id: 'o-1',
                order_status: 'delivered',
                delivered_at: new Date('2026-10-05T10:00:00Z'),
                updated_at: new Date('2026-10-06T10:00:00Z'),
                metadata: { returnStatus: 'approved' },
            }])
            .mockResolvedValueOnce([]);
        BillingLine.findAll.mockResolvedValueOnce([]);

        const result = await billing.catchUpLines({
            shopId: 'shop-1', ...period, cutoverAt: '2026-09-01',
        });

        expect(result).toEqual({ considered: 1, created: 1, skipped: 0, wouldCreate: 0 });
        const [, options] = sequelize.query.mock.calls[0];
        expect(options.replacements).toMatchObject({
            outcome: 'RETURNED',
            line_kind: 'zero_rated',
            amount_minor: 0,
            source: 'invoice_catchup',
            occurred_at: '2026-10-05',
        });
    });

    it('A2 — dry-run counts candidates but writes zero rows', async () => {
        Order.findAll
            .mockResolvedValueOnce([{
                id: 'o-1', order_status: 'delivered',
                delivered_at: new Date('2026-10-05T10:00:00Z'),
                updated_at: new Date('2026-10-06T10:00:00Z'), metadata: {},
            }])
            .mockResolvedValueOnce([]);
        BillingLine.findAll.mockResolvedValueOnce([]);

        const result = await billing.catchUpLines({
            shopId: 'shop-1', ...period, cutoverAt: '2026-09-01', dryRun: true,
        });

        expect(result).toEqual({ considered: 1, created: 0, skipped: 0, wouldCreate: 1 });
        expect(sequelize.query).not.toHaveBeenCalled();
        expect(BillingLine.findOrCreate).not.toHaveBeenCalled();
    });

    it('skips orders that already have a recorded line', async () => {
        Order.findAll
            .mockResolvedValueOnce([{
                id: 'o-1', order_status: 'delivered',
                delivered_at: new Date('2026-10-05T10:00:00Z'),
                updated_at: new Date('2026-10-05T10:00:00Z'), metadata: {},
            }])
            .mockResolvedValueOnce([]);
        BillingLine.findAll.mockResolvedValueOnce([{ order_id: 'o-1' }]);

        const result = await billing.catchUpLines({
            shopId: 'shop-1', ...period, cutoverAt: '2026-09-01',
        });

        expect(result).toEqual({ considered: 1, created: 0, skipped: 1, wouldCreate: 0 });
        expect(sequelize.query).not.toHaveBeenCalled();
    });
});

describe('aggregateUninvoicedLines (A5 fail closed)', () => {
    const range = {
        shopId: 'shop-1',
        periodStart: new Date('2026-10-01T00:00:00Z'),
        periodEnd: new Date('2026-11-01T00:00:00Z'),
    };

    it('returns NO lines when the cutover instant is unavailable', async () => {
        const result = await billing.aggregateUninvoicedLines({ ...range, cutoverAt: null });

        expect(result).toEqual([]);
        expect(BillingLine.findAll).not.toHaveBeenCalled();
    });

    it('floors aggregation at the cutover instant when it is present', async () => {
        await billing.aggregateUninvoicedLines({ ...range, cutoverAt: '2026-10-15' });

        expect(BillingLine.findAll).toHaveBeenCalledTimes(1);
        const { where } = BillingLine.findAll.mock.calls[0][0];
        expect(where).toMatchObject({ shop_id: 'shop-1', invoice_id: null });
        expect(where.occurred_at).toBeDefined();
    });
});

describe('getCommercialCutoverAt', () => {
    it('reads from an injected loader', async () => {
        const value = await billing.getCommercialCutoverAt({
            loader: async () => '2026-10-01T00:00:00Z',
        });
        expect(value.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    });

    it('supports a test override and resets to DB reads', async () => {
        billing.__setCutoverAtForTests('2026-10-02');
        await expect(billing.getCommercialCutoverAt()).resolves.toBeInstanceOf(Date);
        billing.__resetForTests();
    });

    it('return null when the loader has no state', async () => {
        await expect(billing.getCommercialCutoverAt({ loader: async () => null })).resolves.toBeNull();
    });
});