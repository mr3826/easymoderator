'use strict';

/**
 * bKash Tokenized Checkout v2 client tests (contract §4, §4.1-§4.5, D-7, R-12).
 *
 * ⚠ CONTRACT-MOCK ONLY. Every provider fixture below is shaped from the
 * official bKash Tokenized v2 docs sweep recorded in the Payment Data Contract
 * (§4 endpoints/fields). These tests prove CLIENT LOGIC against the documented
 * contract — they are NOT, and must never be presented as, live-provider
 * verification (R-12/R-15). Zero network: axios and the controller are mocked.
 */
process.env.NODE_ENV = 'test';

const mockAxiosPost = jest.fn();
const mockPaymentConfig = { findOne: jest.fn(), findByPk: jest.fn() };
const mockPaymentTransaction = { findOne: jest.fn(), update: jest.fn(), create: jest.fn(), findAll: jest.fn() };
const mockOrder = { findOne: jest.fn() };
const mockShop = { findByPk: jest.fn() };

jest.mock('axios', () => ({ post: mockAxiosPost }));
jest.mock('../../entities', () => ({
    PaymentConfig: mockPaymentConfig,
    PaymentTransaction: mockPaymentTransaction,
    Order: mockOrder,
    Shop: mockShop,
}));
// Minimal deterministic cache double for the Redis token store + grant budget.
const mockCacheStore = new Map();
jest.mock('../../../utils/cache.service', () => ({
    getForShop: async (shopId, key) => {
        const hit = mockCacheStore.get(`${shopId}|${key}`);
        return hit === undefined ? null : hit;
    },
    setForShop: async (shopId, key, value) => { mockCacheStore.set(`${shopId}|${key}`, value); return true; },
    deleteForShop: async (shopId, key) => { mockCacheStore.delete(`${shopId}|${key}`); return true; },
}));
jest.mock('../../webhooks/payment-webhook.controller', () => ({
    processSuccessfulPayment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const tokenized = require('../bkash-tokenized.service');
const { BkashTokenizedService, client } = tokenized;
const webhookController = require('../../webhooks/payment-webhook.controller');

const ORIGINAL_ENV = { ...process.env };
const AUTOMATABLE_ACCOUNT = (over = {}) => ({
    id: 'acc-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
    verification_level: 'live_certified', is_enabled: true,
    credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: 'pw', mfs_type: 'bkash', mfs_mode: 'business' },
    config: { environment: 'production' },
    ...over,
});

const grantReply = () => ({ data: { id_token: `T-${mockAxiosPost.mock.calls.length}`, refresh_token: 'R-1' } });
const createReply = (over = {}) => ({
    data: { paymentId: 'PID-1', bkashURL: 'https://tokenized.pay.bka.sh/checkout/PID-1', signature: 'RAW-SIGN-DO-NOT-STORE', ...over },
});
const settledQuery = (over = {}) => ({
    // contract-mock: official query/payment response shape (§4-5)
    data: {
        paymentId: 'PID-1',
        transactionStatus: 'Completed', // title-case per docs (§4.1)
        verificationStatus: 'VERIFIED',
        merchantInvoice: 'ORDER-1',
        amount: '100.00',
        trxID: 'TRX-FROM-QUERY',
        ...over,
    },
});

function routeCalls() {
    return mockAxiosPost.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCacheStore.clear();
    Object.assign(process.env, ORIGINAL_ENV, { BKASH_ENABLED: 'true' });
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

// ── inert fail-closed posture (R-12) ────────────────────────────────────────
describe('v2 client never reaches the network when automation is off (§8.1)', () => {
    test('BKASH_ENABLED=false ⇒ initiateGatewayPayment throws 503 with ZERO HTTP', async () => {
        process.env.BKASH_ENABLED = 'false';
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100, payment_status: 'pending' });
        mockShop.findByPk.mockResolvedValue({ settings: {} });
        mockPaymentTransaction.findOne.mockResolvedValue(null);
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT());

        await expect(tokenized.initiateGatewayPayment('shop-1', 'user-1', { orderId: 'o-1' }))
            .rejects.toMatchObject({ status: 503 });
        expect(mockAxiosPost).not.toHaveBeenCalled();
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
    });

    test('below live_certified ⇒ GATEWAY_AUTOMATION_DISABLED, zero HTTP (§2.3 predicate)', async () => {
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100, payment_status: 'pending' });
        mockShop.findByPk.mockResolvedValue({ settings: {} });
        mockPaymentTransaction.findOne.mockResolvedValue(null);
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT({ verification_level: 'sandbox_verified' }));

        await expect(tokenized.initiateGatewayPayment('shop-1', 'user-1', { orderId: 'o-1' }))
            .rejects.toMatchObject({ code: 'GATEWAY_AUTOMATION_DISABLED' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});

// ── create leg (§4-2, §4.4, D-7) ────────────────────────────────────────────
describe('initiateGatewayPayment', () => {
    test('creates per the documented v2 contract and stores NO raw signature', async () => {
        mockOrder.findOne.mockResolvedValue({
            id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 2400, payment_status: 'pending',
            customer_phone: '01711111111', payment_method_id: null, update: jest.fn().mockResolvedValue(true),
        });
        mockShop.findByPk.mockResolvedValue({ settings: { payments: { advance_policy: 'none' } } });
        mockPaymentTransaction.findOne.mockResolvedValue(null);
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT());
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce(createReply());

        const res = await tokenized.initiateGatewayPayment('shop-1', 'user-1', { orderId: 'o-1' });

        expect(res.payment_id).toBe('PID-1');
        expect(res.amount).toBe('2400.00'); // official BigDecimal-string taka (§4-2)
        expect(routeCalls()[0]).toContain('/v2/tokenized-checkout/auth/grant-token');
        expect(routeCalls()[1]).toContain('/v2/tokenized-checkout/create/payment');
        const createBody = mockAxiosPost.mock.calls[1][1];
        expect(createBody).toMatchObject({ amount: '2400.00', currency: 'BDT', merchantInvoiceNumber: 'ORDER-1' });
        expect(mockPaymentTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
            status: 'initiated',
            payment_method: 'bkash',
            payment_account_id: 'acc-gw',
            transaction_id: 'PID-1',
            amount: '2400.00',
            gateway_response: { source: 'tokenized_v2_create', createSignature: true },
        }));
        expect(JSON.stringify(mockPaymentTransaction.create.mock.calls[0][0])).not.toContain('RAW-SIGN-DO-NOT-STORE');
        expect(JSON.stringify(mockPaymentTransaction.create.mock.calls[0][0])).not.toContain('AS'); // app_secret never persisted
    });

    test('D-7: percentage/fixed advance policies never trigger a gateway link', async () => {
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100, payment_status: 'pending' });
        mockShop.findByPk.mockResolvedValue({ settings: { payments: { advance_policy: 'percentage', advance_value: 50 } } });
        await expect(tokenized.initiateGatewayPayment('shop-1', 'user-1', { orderId: 'o-1' }))
            .rejects.toMatchObject({ status: 409, code: 'GATEWAY_POLICY_PARTIAL_UNSUPPORTED' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    test('§4.4: an active attempt (initiated|processing|payment_claimed) blocks re-initiation', async () => {
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100, payment_status: 'pending' });
        mockShop.findByPk.mockResolvedValue({ settings: {} });
        mockPaymentTransaction.findOne.mockResolvedValue({ id: 'txn-old', status: 'processing' });
        await expect(tokenized.initiateGatewayPayment('shop-1', 'user-1', { orderId: 'o-1' }))
            .rejects.toMatchObject({ status: 409, code: 'PAYMENT_IN_PROGRESS' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});

// ── execute-once + reconciliation (§4-4, §4.2, §4.3) ────────────────────────
describe('executeOnceGatewayPayment — execute happens at most once', () => {
    const initiatedTxn = () => ({
        id: 'txn-1', shop_id: 'shop-1', order_id: 'o-1', transaction_id: 'PID-1',
        status: 'initiated', amount: '100.00', payment_account_id: 'acc-gw',
        gateway_response: {}, reload: jest.fn().mockResolvedValue(undefined),
    });

    test('timeout during execute is NEVER re-executed; the second leg reconciles by Query (§4.3)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT());
        mockPaymentTransaction.update.mockResolvedValue([1]);
        const txn = initiatedTxn();
        mockPaymentTransaction.findOne.mockResolvedValue(txn);

        // First leg: grant ok, execute TIMES OUT.
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        const first = await tokenized.executeOnceGatewayPayment('shop-1', { paymentId: 'PID-1' });
        expect(first.success).toBe(false);
        expect(first.deferred).toBe(true);
        const executeCallsAfterFirst = routeCalls().filter((u) => u.includes('/execute/payment')).length;
        expect(executeCallsAfterFirst).toBe(1);

        // Second leg (browser re-return / retry of the trigger): the row now
        // carries executeAttempted ⇒ must go straight to Query, never execute.
        const claimedTxn = { ...initiatedTxn(), status: 'processing', gateway_response: { ...txn.gateway_response, executeAttempted: true } };
        mockPaymentTransaction.findOne.mockResolvedValue(claimedTxn);
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())          // cache miss (cleared below) → grant
            .mockResolvedValueOnce(settledQuery());       // query
        mockCacheStore.clear();
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100 });
        const second = await tokenized.executeOnceGatewayPayment('shop-1', { paymentId: 'PID-1' });

        expect(second.confirmed).toBe(true);
        const executeCallsAfterSecond = routeCalls().filter((u) => u.includes('/execute/payment')).length;
        expect(executeCallsAfterSecond).toBe(1); // STILL one — never re-executed
        expect(routeCalls().some((u) => u.includes('/query/payment'))).toBe(true);
        expect(webhookController.processSuccessfulPayment).toHaveBeenCalledWith(claimedTxn, expect.objectContaining({
            transactionId: 'TRX-FROM-QUERY',
        }));
    });

    test('a second trigger on an already-attempted row settles via Query without any execute call', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT());
        const claimedTxn = {
            ...initiatedTxn(), status: 'processing',
            gateway_response: { executeAttempted: true, executeAttemptedAt: new Date().toISOString() },
        };
        mockPaymentTransaction.findOne.mockResolvedValue(claimedTxn);
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce(settledQuery());
        mockOrder.findOne.mockResolvedValue({ id: 'o-1', shop_id: 'shop-1', order_number: 'ORDER-1', total: 100 });

        const res = await tokenized.executeOnceGatewayPayment('shop-1', { paymentId: 'PID-1' });

        expect(res.confirmed).toBe(true);
        expect(routeCalls().some((u) => u.includes('/execute/payment'))).toBe(false);
    });

    test('already-paid rows return immediately without touching the provider', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue({ ...initiatedTxn(), status: 'paid' });
        const res = await tokenized.executeOnceGatewayPayment('shop-1', { paymentId: 'PID-1' });
        expect(res.already_settled).toBe(true);
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});

// ── query is the ONLY settlement evidence (§4.2, §4.1 casing) ───────────────
describe('evaluateSettlement — case-insensitive canonical comparison (§4.1)', () => {
    const base = {
        verificationStatus: 'VERIFIED', merchantInvoice: 'ORDER-1', amount: '100.00', trxID: 'TRX-1',
    };
    test.each(['Completed', 'COMPLETED', 'completed'])('title/upper/lower %s all settle', (status) => {
        const v = client.evaluateQueryEvidence({ ...base, transactionStatus: status }, {
            expectedOrderNumber: 'ORDER-1',
            expectedAmountMinor: 10000n,
        });
        expect(v.confirmed).toBe(true);
    });

    test.each(['Initiated', 'Pending', 'Cancelled', 'Failed'])('%s never settles', (status) => {
        const v = client.evaluateQueryEvidence({ ...base, transactionStatus: status }, {
            expectedOrderNumber: 'ORDER-1', expectedAmountMinor: 10000n,
        });
        expect(v.confirmed).toBe(false);
    });

    test('invoice echo / amount minor-units / verificationStatus failures each block settlement', () => {
        const minor = (x) => x;
        expect(client.evaluateQueryEvidence({ ...base, transactionStatus: 'Completed', merchantInvoice: 'OTHER' },
            { expectedOrderNumber: 'ORDER-1', expectedAmountMinor: 10000n }).confirmed).toBe(false);
        expect(client.evaluateQueryEvidence({ ...base, transactionStatus: 'Completed', amount: '99.00' },
            { expectedOrderNumber: 'ORDER-1', expectedAmountMinor: 10000n }).confirmed).toBe(false);
        expect(client.evaluateQueryEvidence({ ...base, transactionStatus: 'Completed', verificationStatus: 'NOT_VERIFIED' },
            { expectedOrderNumber: 'ORDER-1', expectedAmountMinor: 10000n }).confirmed).toBe(false);
    });
});

// ── §2.1 grant budget ────────────────────────────────────────────────────────
describe('grant budget: ≤2 grant+refresh per rolling hour, refused BEFORE HTTP', () => {
    test('the 3rd forced grant in the window throws 429 CREDENTIAL_CHECK_RATE_LIMITED', async () => {
        const account = AUTOMATABLE_ACCOUNT({ id: 'acc-budget', verification_level: 'configured_unverified' });
        mockAxiosPost.mockResolvedValue(grantReply());

        await client.grantToken(account, { force: true });
        await client.grantToken(account, { force: true });
        await expect(client.grantToken(account, { force: true }))
            .rejects.toMatchObject({ status: 429, code: 'CREDENTIAL_CHECK_RATE_LIMITED' });
        expect(mockAxiosPost).toHaveBeenCalledTimes(2); // refusal never hit the network
    });

    test('non-forced calls reuse the cached id_token (no extra grants)', async () => {
        const account = AUTOMATABLE_ACCOUNT({ id: 'acc-cache' });
        mockAxiosPost.mockResolvedValueOnce(grantReply());
        const t1 = await client.grantToken(account);
        const t2 = await client.grantToken(account);
        expect(t2).toBe(t1);
        expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });
});

// ── sandbox rung (§2.2, D-3) ─────────────────────────────────────────────────
describe('sandboxCreateQueryHandshake — sandbox credentials ONLY (§2.2)', () => {
    test('production-environment credentials are refused before any HTTP', async () => {
        await expect(client.sandboxCreateQueryHandshake(AUTOMATABLE_ACCOUNT()))
            .rejects.toMatchObject({ status: 409, code: 'SANDBOX_ONLY_OPERATION' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    test('sandbox handshake runs grant→create→query and reports invoice echo, settlement:false', async () => {
        const account = AUTOMATABLE_ACCOUNT({ id: 'acc-sbx', verification_level: 'configured_unverified', config: { environment: 'sandbox' } });
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce(createReply())
            .mockResolvedValueOnce({ data: { transactionStatus: 'Initiated', verificationStatus: null, merchantInvoice: `SANDBOX-${'acc-sbx'.slice(0, 8)}`, amount: '1.00' } });

        const res = await client.sandboxCreateQueryHandshake(account);

        expect(res.grantOk).toBe(true);
        expect(res.createOk).toBe(true);
        expect(res.queryOk).toBe(true);
        expect(res.invoiceEcho).toBe(true);
        expect(res.settlement).toBe(false); // D-3: handshake never implies settlement
        expect(routeCalls()[1]).toContain('/create/payment');
        expect(routeCalls()[2]).toContain('/query/payment');
        // no PaymentTransaction row is created for a handshake (§2.2):
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
    });
});

// ── refund + search (§4.5, §4-5) ────────────────────────────────────────────
describe('refund and reconciliation cross-check', () => {
    test('refund posts the documented paymentId+trxId+refundAmount triple', async () => {
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce({ data: { refundTrxID: 'RF-1' } });
        const res = await client.refundPayment(AUTOMATABLE_ACCOUNT(), {
            paymentId: 'PID-1', trxId: 'TRX-1', refundAmount: '500.00', reason: 'wrong item',
        });
        expect(res.refundTrxID).toBe('RF-1');
        expect(routeCalls()[1]).toContain('/refund/payment/transaction');
        expect(mockAxiosPost.mock.calls[1][1]).toMatchObject({ paymentId: 'PID-1', trxId: 'TRX-1', refundAmount: '500.00' });
    });

    test('search-transaction is a cross-check path that is never used to settle', async () => {
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce({ data: { transactionStatus: 'Completed' } });
        await client.searchTransaction(AUTOMATABLE_ACCOUNT(), { trxId: 'TRX-9' });
        expect(routeCalls()[1]).toContain('/general/search-transaction');
        expect(webhookController.processSuccessfulPayment).not.toHaveBeenCalled();
    });
});

// ── webhook seam (R-12 inert) ────────────────────────────────────────────────
describe('querySettlementEvidence — the webhook trust seam', () => {
    test('rows without an account link (legacy/self-mfs era) report unavailable, never settled', async () => {
        const res = await tokenized.querySettlementEvidence({ payment_account_id: null, shop_id: 'shop-1', transaction_id: 'PID-1' });
        expect(res).toEqual({ available: false, reason: 'no_payment_account' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    test('flag off ⇒ gateway_disabled verdict (confirmation then rides Execute+Query + §4.3 sweep)', async () => {
        process.env.BKASH_ENABLED = 'false';
        const res = await tokenized.querySettlementEvidence({ payment_account_id: 'acc-gw', shop_id: 'shop-1', transaction_id: 'PID-1' });
        expect(res.available).toBe(false);
        expect(res.reason).toBe('gateway_disabled');
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    test('live_certified account ⇒ real (mocked) query returns available evidence', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(AUTOMATABLE_ACCOUNT());
        mockAxiosPost
            .mockResolvedValueOnce(grantReply())
            .mockResolvedValueOnce(settledQuery());
        const res = await tokenized.querySettlementEvidence({ payment_account_id: 'acc-gw', shop_id: 'shop-1', transaction_id: 'PID-1' });
        expect(res.available).toBe(true);
        expect(res.query.transactionStatus).toBe('Completed');
    });
});

// ── §4.3 sweep ───────────────────────────────────────────────────────────────
describe('reconcileStaleGatewayAttempts (§4.3): bounded Query, NEVER re-execute', () => {
    test('sweeps only bkash initiated/processing rows with an account link', async () => {
        mockPaymentTransaction.findAll.mockResolvedValue([]);
        const res = await tokenized.reconcileStaleGatewayAttempts({ olderThanMinutes: 15 });
        expect(res).toEqual({ scanned: 0, results: [] });
        const where = mockPaymentTransaction.findAll.mock.calls[0][0].where;
        expect(where.status[require('sequelize').Op.in]).toEqual(['initiated', 'processing']);
        expect(where.payment_account_id[require('sequelize').Op.ne]).toBeNull();
    });
});
