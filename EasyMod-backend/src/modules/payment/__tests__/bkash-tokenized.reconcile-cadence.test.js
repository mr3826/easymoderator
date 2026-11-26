'use strict';

/**
 * §4.3 attempt-bounded sweep ledger (A0 scheduler integration).
 *
 * The sweep clock now runs every minute (gateway-attempt-reconciler job), so
 * PROVIDER TRAFFIC must stay bounded per row by the attempt ledger inside
 * gateway_response.reconcile: rungs 1/5/15/30 minutes, four queries total,
 * then quiet (the read-only admin report is the manual path — untouched).
 *
 * Hermetic: client.queryPayment is spied (the A3 suite owns what the client
 * itself does); these tests pin ONLY the sweep's gate + bookkeeping logic —
 * zero HTTP by construction.
 */
process.env.NODE_ENV = 'test';

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../../../utils/cache.service', () => ({
    getForShop: jest.fn(async () => null),
    setForShop: jest.fn(async () => true),
    deleteForShop: jest.fn(async () => true),
}));
const mockPaymentTransaction = { findAll: jest.fn(), update: jest.fn(), findOne: jest.fn(), create: jest.fn() };
const mockPaymentConfig = { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn() };
jest.mock('../../entities', () => ({
    PaymentConfig: mockPaymentConfig,
    PaymentTransaction: mockPaymentTransaction,
    Order: { findOne: jest.fn() },
    Shop: { findByPk: jest.fn() },
}));

const tokenized = require('../bkash-tokenized.service');

const NOW = new Date('2026-11-27T10:00:00.000Z');
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();

const makeRow = (over = {}) => ({
    id: over.id || 'txn-1',
    shop_id: 'shop-1',
    status: 'initiated',
    transaction_id: 'PID-1',
    amount: 250,
    order_id: 'order-1',
    payment_account_id: 'acc-gw',
    gateway_response: {},
    updated_at: new Date(NOW.getTime() - 30 * 60 * 1000),
    update: jest.fn().mockImplementation(async function patch(fields) {
        Object.assign(this, fields);
    }),
    ...over,
});

describe('reconcileStaleGatewayAttempts — bounded attempt ledger (§4.3, A0 wiring)', () => {
    let querySpy;
    const gatewayAccount = {
        id: 'acc-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
        verification_level: 'live_certified', is_enabled: true,
        credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x' },
        config: { environment: 'production' },
    };
    beforeEach(() => {
        jest.clearAllMocks();
        // reconcileAttemptByQuery loads the stamped account first — provide it
        // for every case so the tests exercise the sweep logic, not account miss.
        mockPaymentConfig.findByPk.mockResolvedValue(gatewayAccount);
        mockPaymentConfig.findOne.mockResolvedValue(gatewayAccount);
        querySpy = jest.spyOn(tokenized.client, 'queryPayment');
    });
    afterEach(() => { querySpy.mockRestore(); });

    test('the exported ladder is exactly [1, 5, 15, 30] minutes', () => {
        expect(Array.from(tokenized.RECONCILE_LADDER_MINUTES)).toEqual([1, 5, 15, 30]);
    });

    test('rows WITHOUT a reconcile ledger are queried (pre-job rows stay compatible)', async () => {
        const row = makeRow();
        mockPaymentTransaction.findAll.mockResolvedValue([row]);
        querySpy.mockResolvedValue({ transactionStatus: 'Initiated', paymentID: 'PID-1' });
        const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 15, now: NOW });
        expect(res.scanned).toBe(1);
        expect(querySpy).toHaveBeenCalledTimes(1);
        expect(row.update).toHaveBeenCalledTimes(1);
        const stamp = row.update.mock.calls[0][0].gateway_response.reconcile;
        expect(stamp.attempts).toBe(1);
        // after attempt 1 the next rung is 5 minutes out
        expect(stamp.next_due_at).toBe(iso(5 * 60 * 1000));
        expect(stamp.exhausted).toBe(false);
    });

    test('a row before its next rung is SKIPPED with zero provider calls', async () => {
        const row = makeRow({
            gateway_response: { source: 'tokenized_v2_create', reconcile: { attempts: 1, next_due_at: iso(4 * 60 * 1000) } },
        });
        mockPaymentTransaction.findAll.mockResolvedValue([row]);
        const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 1, now: NOW });
        expect(querySpy).not.toHaveBeenCalled();
        expect(row.update).not.toHaveBeenCalled();
        expect(res.results[0]).toMatchObject({ paymentId: 'txn-1', reconcile: 'not_due' });
    });

    test('a row that exhausted the 4-rung ladder goes quiet forever (bounded, no infinite retry)', async () => {
        const row = makeRow({
            gateway_response: { reconcile: { attempts: 4, next_due_at: iso(-10 * 60 * 1000), exhausted: true } },
        });
        mockPaymentTransaction.findAll.mockResolvedValue([row]);
        const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 1, now: NOW });
        expect(querySpy).not.toHaveBeenCalled();
        expect(row.update).not.toHaveBeenCalled();
        expect(res.results[0]).toMatchObject({ reconcile: 'exhausted' });
    });

    test('rung cadence: attempt 2 waits 15 min, attempt 3 waits 30, attempt 4 marks exhausted', async () => {
        const expectations = [
            { attempts: 1, nextAttempts: 2, waitMin: 15, exhausted: false },
            { attempts: 2, nextAttempts: 3, waitMin: 30, exhausted: false },
            { attempts: 3, nextAttempts: 4, waitMin: 30, exhausted: true },
        ];
        for (const exp of expectations) {
            querySpy.mockReset();
            querySpy.mockResolvedValue({ transactionStatus: 'Pending' });
            const row = makeRow({
                id: `txn-${exp.attempts}`,
                gateway_response: { reconcile: { attempts: exp.attempts, next_due_at: iso(-1) } },
            });
            mockPaymentTransaction.findAll.mockResolvedValue([row]);
            await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 1, now: NOW });
            const stamp = row.update.mock.calls[0][0].gateway_response.reconcile;
            expect(stamp.attempts).toBe(exp.nextAttempts);
            expect(stamp.next_due_at).toBe(iso(exp.waitMin * 60 * 1000));
            expect(stamp.exhausted).toBe(exp.exhausted);
        }
    });

    test('a provider UNREACHABLE throw still consumes the rung (never re-query every minute forever)', async () => {
        const row = makeRow();
        mockPaymentTransaction.findAll.mockResolvedValue([row]);
        querySpy.mockRejectedValue(new Error('socket hang up'));
        const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 1, now: NOW });
        expect(res.results[0].confirmed).toBe(false);
        expect(row.update).toHaveBeenCalledTimes(1);
        const stamp = row.update.mock.calls[0][0].gateway_response.reconcile;
        expect(stamp.attempts).toBe(1);
        expect(stamp.next_due_at).toBe(iso(5 * 60 * 1000));
    });

    test('a terminal FAILED outcome from Query does NOT get a bookkeeping stamp (row already moved)', async () => {
        const row = makeRow({ status: 'processing' });
        mockPaymentTransaction.findAll.mockResolvedValue([row]);
        // loadGatewayAccount seam for reconcileAttemptByQuery's internal account load:
        mockPaymentConfig.findByPk.mockResolvedValue({
            id: 'acc-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
            verification_level: 'live_certified', is_enabled: true,
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x' },
            config: { environment: 'production' },
        });
        process.env.BKASH_ENABLED = 'true';
        querySpy.mockResolvedValue({ transactionStatus: 'Failed', paymentID: 'PID-1' });
        try {
            const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 1, now: NOW });
            expect(res.results[0].status).toBe('failed');
            expect(querySpy).toHaveBeenCalledTimes(1);
            // the row moved to failed inside the service — no extra ledger stamp:
            const stampCalls = row.update.mock.calls.filter(
                (c) => c[0] && c[0].gateway_response && c[0].gateway_response.reconcile,
            );
            expect(stampCalls).toHaveLength(0);
        } finally {
            delete process.env.BKASH_ENABLED;
        }
    });
});
