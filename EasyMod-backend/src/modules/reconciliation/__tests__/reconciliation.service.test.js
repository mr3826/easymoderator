'use strict';

/**
 * ReconciliationService — COD payout correctness.
 *
 * The 2026-11-03 launch audit found three defects this suite pins shut:
 *   1. Expected amount was `order.total - order.delivery_fee`, but courier
 *      booking collects the fee-INCLUSIVE `order.total` (order.service.js
 *      buildCourierOrderData). Prepaid orders were also summed, so a fully
 *      prepaid shop produced structural false disputes.
 *   2. When a payout had no consignment linkage, expected silently fell back
 *      to the courier-claimed amount, which made discrepancy exactly zero and
 *      the auto-dispute never fired.
 *   3. Nothing recorded WHY a collection matched (or didn't), so re-runs could
 *      flip states and neither merchant nor operator could see the basis.
 *
 * Contract under test:
 *   - Expected = sum of order.total for linked COD orders whose payment is
 *     still outstanding (pending/unpaid); 0 for prepaid/paid orders.
 *   - Missing or partial linkage -> UNMATCHED / INCOMPLETE_EVIDENCE, never a
 *     numeric match against the claimed amount.
 *   - claimed > expected beyond threshold  -> DIFFERENCE_FOUND + open dispute
 *     (cannot be explained by unseen courier deductions).
 *   - claimed < expected beyond threshold  -> UNDERPAID_REVIEW with expected
 *     recorded (may legitimately be courier fees; never auto-settled).
 *   - Duplicate imports never re-evaluate or double-count.
 */

jest.mock('../../entities', () => ({
    DeliveryIntegration: { findOne: jest.fn() },
    Order: { findAll: jest.fn() },
}));
jest.mock('../courier-collection.entity', () => ({
    findOrCreate: jest.fn(),
}));
jest.mock('../reconciliation-dispute.entity', () => ({
    create: jest.fn(),
}));
jest.mock('../../delivery/delivery.service', () => ({
    getProviderInstance: jest.fn(),
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { Order, DeliveryIntegration } = require('../../entities');
const CourierCodCollection = require('../courier-collection.entity');
const ReconciliationDispute = require('../reconciliation-dispute.entity');
const deliveryService = require('../../delivery/delivery.service');
const ReconciliationService = require('../reconciliation.service');

const SHOP = 'shop-1';

const makeCollection = (overrides = {}) => ({
    id: 'collection-1',
    shop_id: SHOP,
    provider: 'steadfast',
    payment_reference: 'payout-1',
    claimed_amount: 0,
    state: 'PROVIDER_REPORTED',
    expected_amount: null,
    update: jest.fn(function update(values) {
        Object.assign(this, values);
        return Promise.resolve(this);
    }),
    ...overrides,
});

const makeOrder = (overrides = {}) => ({
    total: 1000,
    delivery_fee: 0,
    payment_method: 'cod',
    payment_status: 'pending',
    delivery_consignment_id: 'consignment-1',
    ...overrides,
});

const primeImport = (collection, created = true) => {
    CourierCodCollection.findOrCreate.mockResolvedValue([collection, created]);
};

beforeEach(() => jest.clearAllMocks());

describe('states constant', () => {
    test('exposes the reconciliation state vocabulary', () => {
        expect(ReconciliationService.STATES).toEqual(expect.objectContaining({
            PROVIDER_REPORTED: 'PROVIDER_REPORTED',
            MATCHED: 'MATCHED',
            DIFFERENCE_FOUND: 'DIFFERENCE_FOUND',
            UNDERPAID_REVIEW: 'UNDERPAID_REVIEW',
            UNMATCHED: 'UNMATCHED',
            INCOMPLETE_EVIDENCE: 'INCOMPLETE_EVIDENCE',
        }));
    });
});

describe('recordPayment — expected amount basis', () => {
    test('COD order expectation is fee-inclusive order.total (regression: no − delivery_fee)', async () => {
        const collection = makeCollection({ claimed_amount: 1200, consignment_ids: ['consignment-1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: 1200, delivery_fee: 80, payment_status: 'pending' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1200,
            consignment_ids: ['consignment-1'],
        });

        expect(result.state).toBe('MATCHED');
        expect(result.dispute).toBeNull();
        expect(collection.expected_amount).toBe(1200);
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('fully prepaid order contributes zero and a zero payout matches', async () => {
        const collection = makeCollection({ claimed_amount: 0, consignment_ids: ['consignment-1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: 1500, delivery_fee: 60, payment_method: 'bkash', payment_status: 'paid' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 0,
            consignment_ids: ['consignment-1'],
        });

        expect(result.state).toBe('MATCHED');
        expect(collection.expected_amount).toBe(0);
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('multi-order payout sums only outstanding COD totals', async () => {
        const collection = makeCollection({ claimed_amount: 1500, consignment_ids: ['c1', 'c2', 'c3'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: 500, delivery_consignment_id: 'c1', payment_status: 'pending' }),
            makeOrder({ total: 700, delivery_consignment_id: 'c2', payment_status: 'unpaid' }),
            makeOrder({ total: 300, delivery_consignment_id: 'c3', payment_status: 'pending' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1500,
            consignment_ids: ['c1', 'c2', 'c3'],
        });

        expect(result.state).toBe('MATCHED');
        expect(collection.expected_amount).toBe(1500);
    });

    test('money math stays at two decimals', async () => {
        const collection = makeCollection({ claimed_amount: 100.01, consignment_ids: ['c1', 'c2'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: '99.99', delivery_consignment_id: 'c1' }),
            makeOrder({ total: '0.02', delivery_consignment_id: 'c2' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 100.01,
            consignment_ids: ['c1', 'c2'],
        });

        expect(result.state).toBe('MATCHED');
        expect(collection.expected_amount).toBe(100.01);
    });
});

describe('recordPayment — linkage honesty (regression: no claimed-amount fallback)', () => {
    test('payout without consignment ids is UNMATCHED and never compared to claimed', async () => {
        const collection = makeCollection({ claimed_amount: 900, consignment_ids: [] });
        primeImport(collection);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 900,
            consignment_ids: [],
        });

        expect(result.state).toBe('UNMATCHED');
        expect(collection.expected_amount).toBeNull();
        expect(Order.findAll).not.toHaveBeenCalled();
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
        expect(collection.update).toHaveBeenCalledWith(expect.objectContaining({
            state: 'UNMATCHED',
            expected_amount: null,
        }));
    });

    test('consignment ids that match no order are UNMATCHED (not a fabricated match)', async () => {
        const collection = makeCollection({ claimed_amount: 900, consignment_ids: ['ghost-1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 900,
            consignment_ids: ['ghost-1'],
        });

        expect(result.state).toBe('UNMATCHED');
        expect(collection.expected_amount).toBeNull();
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('partially linked payout is INCOMPLETE_EVIDENCE, not a numeric comparison', async () => {
        const collection = makeCollection({ claimed_amount: 2000, consignment_ids: ['c1', 'c2', 'c3'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([makeOrder({ total: 800, delivery_consignment_id: 'c1' })]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 2000,
            consignment_ids: ['c1', 'c2', 'c3'],
        });

        expect(result.state).toBe('INCOMPLETE_EVIDENCE');
        expect(collection.expected_amount).toBeNull();
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('partially paid COD order is INCOMPLETE_EVIDENCE (balance due is unknown)', async () => {
        const collection = makeCollection({ claimed_amount: 600, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: 1000, payment_status: 'partially_paid', delivery_consignment_id: 'c1' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 600,
            consignment_ids: ['c1'],
        });

        expect(result.state).toBe('INCOMPLETE_EVIDENCE');
        expect(collection.expected_amount).toBeNull();
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('COD order in an unrecognized payment status is INCOMPLETE_EVIDENCE', async () => {
        const collection = makeCollection({ claimed_amount: 600, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([
            makeOrder({ total: 1000, payment_status: 'refunded', delivery_consignment_id: 'c1' }),
        ]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 600,
            consignment_ids: ['c1'],
        });

        expect(result.state).toBe('INCOMPLETE_EVIDENCE');
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });
});

describe('recordPayment — direction-aware discrepancy', () => {
    test('over-claim opens a dispute (cannot be explained by courier deductions)', async () => {
        const collection = makeCollection({ claimed_amount: 1500, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([makeOrder({ total: 500, delivery_consignment_id: 'c1' })]);
        ReconciliationDispute.create.mockImplementation(async (row) => row);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1500,
            consignment_ids: ['c1'],
        });

        expect(result.state).toBe('DIFFERENCE_FOUND');
        expect(result.dispute).toBeTruthy();
        expect(ReconciliationDispute.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: SHOP,
            payment_reference: 'payout-1',
            claimed_amount: 1500,
            expected_amount: 500,
            discrepancy_amount: 1000,
            dispute_status: 'open',
        }));
        expect(collection.expected_amount).toBe(500);
    });

    test('under-claim beyond threshold is REVIEW, never auto-settled or auto-disputed', async () => {
        const collection = makeCollection({ claimed_amount: 900, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([makeOrder({ total: 1200, delivery_consignment_id: 'c1' })]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 900,
            consignment_ids: ['c1'],
        });

        expect(result.state).toBe('UNDERPAID_REVIEW');
        expect(collection.expected_amount).toBe(1200);
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('small under-claim consistent with fees is MATCHED', async () => {
        const collection = makeCollection({ claimed_amount: 1150, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([makeOrder({ total: 1200, delivery_consignment_id: 'c1' })]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1150,
            consignment_ids: ['c1'],
        });

        expect(result.state).toBe('MATCHED');
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });

    test('৳100 over-claim on a ৳1000 expectation is still flagged by the percentage rule', async () => {
        const collection = makeCollection({ claimed_amount: 1100, consignment_ids: ['c1'] });
        primeImport(collection);
        Order.findAll.mockResolvedValue([makeOrder({ total: 1000, delivery_consignment_id: 'c1' })]);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1100,
            consignment_ids: ['c1'],
        });

        // 100 is not > 100; 10% is > 5% — the percentage rule still flags it.
        expect(result.state).toBe('DIFFERENCE_FOUND');
        expect(collection.expected_amount).toBe(1000);
    });
});

describe('recordPayment — duplicate import safety', () => {
    test('re-importing the same statement line does not re-evaluate or dispute', async () => {
        const existing = makeCollection({ state: 'MATCHED', expected_amount: 1000 });
        primeImport(existing, false);

        const result = await ReconciliationService.recordPayment(SHOP, 'steadfast', {
            id: 'payout-1',
            amount: 1000,
            consignment_ids: ['c1'],
        });

        expect(result.duplicate).toBe(true);
        expect(result.dispute).toBeNull();
        expect(Order.findAll).not.toHaveBeenCalled();
        expect(existing.update).not.toHaveBeenCalled();
        expect(ReconciliationDispute.create).not.toHaveBeenCalled();
    });
});

describe('pullSteadfastPayments', () => {
    test('throws when the shop has no active Steadfast integration', async () => {
        DeliveryIntegration.findOne.mockResolvedValue(null);

        await expect(ReconciliationService.pullSteadfastPayments(SHOP))
            .rejects.toThrow(/No active Steadfast integration/);
    });

    test('records each payout, skips id-less entries, and counts disputes', async () => {
        DeliveryIntegration.findOne.mockResolvedValue({ id: 'integration-1', shop_id: SHOP });
        deliveryService.getProviderInstance.mockResolvedValue({
            getPayments: jest.fn().mockResolvedValue({
                data: [
                    { id: 'payout-1', amount: 1200, consignment_ids: ['c1'] },
                    { amount: 500, consignment_ids: ['c2'] }, // no id — cannot be deduped
                ],
            }),
        });

        const recordSpy = jest.spyOn(ReconciliationService, 'recordPayment')
            .mockResolvedValue({ collection: {}, dispute: null, state: 'MATCHED' });

        const result = await ReconciliationService.pullSteadfastPayments(SHOP);

        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy).toHaveBeenCalledWith(SHOP, 'steadfast', expect.objectContaining({ id: 'payout-1' }));
        expect(result).toEqual(expect.objectContaining({ collected: 1, disputes: 0, skipped: 1 }));

        recordSpy.mockRestore();
    });

    test('one failing payout does not abort the rest of the statement', async () => {
        DeliveryIntegration.findOne.mockResolvedValue({ id: 'integration-1', shop_id: SHOP });
        deliveryService.getProviderInstance.mockResolvedValue({
            getPayments: jest.fn().mockResolvedValue([
                { id: 'payout-1', amount: 100, consignment_ids: ['c1'] },
                { id: 'payout-2', amount: 200, consignment_ids: ['c2'] },
            ]),
        });

        const recordSpy = jest.spyOn(ReconciliationService, 'recordPayment')
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValueOnce({ collection: {}, dispute: { id: 'd1' }, state: 'DIFFERENCE_FOUND' });

        const result = await ReconciliationService.pullSteadfastPayments(SHOP);

        expect(result.collected).toBe(1);
        expect(result.disputes).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual(expect.objectContaining({ paymentId: 'payout-1' }));

        recordSpy.mockRestore();
    });
});