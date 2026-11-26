'use strict';

/**
 * A5 routes contract — the Payment Methods + Policies "one PUT pair per tab"
 * (R-14). Real router + real Joi validators; service layers are mocked so this
 * proves WIRING and request-shape enforcement only (no DB, no provider — R-12).
 * Legacy /config routes must still dispatch to the untouched legacy service (§1.4).
 */
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const mockAccounts = {
    listPaymentAccounts: jest.fn(), getPaymentAccount: jest.fn(), savePaymentAccount: jest.fn(),
    updatePaymentAccount: jest.fn(), deletePaymentAccount: jest.fn(), setPreferredAccount: jest.fn(),
    verifyPaymentAccount: jest.fn(), certifyLiveAccount: jest.fn(), refundPaymentTransaction: jest.fn(),
    createSelfMfsClaim: jest.fn(),
};
const mockPolicy = { getPaymentPolicy: jest.fn(), updatePaymentPolicy: jest.fn() };
const mockLegacy = {
    getPaymentConfigs: jest.fn(), savePaymentConfig: jest.fn(), testPaymentConnection: jest.fn(),
    deletePaymentConfig: jest.fn(), confirmCodPayment: jest.fn(),
    _private: { sanitizePaymentConfigOptions: (v) => v, buildCredentialSummary: (v) => v, validateSelfMfsCredentials: (v) => v },
};

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => { req.user = { userId: 'user-1', shopId: 'shop-1' }; next(); },
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({ verifyShopAccess: (_r, _s, n) => n() }));
jest.mock('../../../middleware/shop-permission.middleware', () => ({
    requireOwner: (_r, _s, n) => n(), requireOwnerOrAdmin: (_r, _s, n) => n(),
}));
jest.mock('../../entities', () => ({ PaymentConfig: {}, UserShop: {}, Shop: {} }));
jest.mock('../payment.service', () => mockLegacy);
jest.mock('../payment-accounts.service', () => mockAccounts);
jest.mock('../payment-policy.service', () => mockPolicy);

const router = require('../payment.routes');

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api/payment', router);
    instance.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
    return instance;
}

const UUID = '11111111-1111-4111-8111-111111111111';

describe('payment.routes — accounts API', () => {
    test('GET /api/payment/accounts dispatches to the account service', async () => {
        mockAccounts.listPaymentAccounts.mockResolvedValue([]);
        const res = await request(app()).get('/api/payment/accounts');
        expect(res.status).toBe(200);
        expect(mockAccounts.listPaymentAccounts).toHaveBeenCalledWith('shop-1', 'user-1');
    });

    test('POST /api/payment/accounts rejects a non-canonical provider (validator)', async () => {
        const res = await request(app()).post('/api/payment/accounts').send({ provider: 'self-mfs', account_type: 'self' });
        expect(res.status).toBe(400);
        expect(mockAccounts.savePaymentAccount).not.toHaveBeenCalled();
    });

    test('POST /api/payment/accounts rejects a bad account_type', async () => {
        const res = await request(app()).post('/api/payment/accounts').send({ provider: 'bkash', account_type: 'gold' });
        expect(res.status).toBe(400);
    });

    test('POST /api/payment/accounts valid shape dispatches', async () => {
        mockAccounts.savePaymentAccount.mockResolvedValue({ id: UUID });
        const res = await request(app()).post('/api/payment/accounts').send({
            provider: 'bkash', account_type: 'self', is_enabled: true, credentials: { mfs_number: '01711111111' },
        });
        expect(res.status).toBe(200);
        expect(mockAccounts.savePaymentAccount).toHaveBeenCalledWith('shop-1', 'user-1', expect.objectContaining({ provider: 'bkash' }));
    });

    test('GET /api/payment/accounts/:non-uuid → 400', async () => {
        const res = await request(app()).get('/api/payment/accounts/not-a-uuid');
        expect(res.status).toBe(400);
    });

    test('PUT /api/payment/accounts/:id/preferred is an owner write (§6/D-8)', async () => {
        mockAccounts.setPreferredAccount.mockResolvedValue({ success: true, preferred_account_id: UUID });
        const res = await request(app()).put(`/api/payment/accounts/${UUID}/preferred`);
        expect(res.status).toBe(200);
        expect(mockAccounts.setPreferredAccount).toHaveBeenCalledWith('shop-1', 'user-1', UUID);
    });

    test('POST /accounts/:id/verify-credentials dispatches to the A3 delegate', async () => {
        mockAccounts.verifyPaymentAccount.mockResolvedValue({ status: 'format_validated', message: 'ok' });
        const res = await request(app()).post(`/api/payment/accounts/${UUID}/verify-credentials`);
        expect(res.status).toBe(200);
        expect(mockAccounts.verifyPaymentAccount).toHaveBeenCalledWith('shop-1', 'user-1', UUID);
    });

    test('POST /accounts/:id/certify-live requires non-empty evidence (§2.3)', async () => {
        const bad = await request(app()).post(`/api/payment/accounts/${UUID}/certify-live`).send({});
        expect(bad.status).toBe(400);
        expect(mockAccounts.certifyLiveAccount).not.toHaveBeenCalled();

        mockAccounts.certifyLiveAccount.mockResolvedValue({ success: true });
        const good = await request(app()).post(`/api/payment/accounts/${UUID}/certify-live`).send({ evidence: 'bKash onboarding email 2026-11-30' });
        expect(good.status).toBe(200);
    });
});

describe('payment.routes — policies API (R-14 one write pair)', () => {
    test('GET /api/payment/policy hydrates from the service', async () => {
        mockPolicy.getPaymentPolicy.mockResolvedValue({ advance_policy: 'none', advance_value: null, payment_message: '', _shop_id: 'shop-1' });
        const res = await request(app()).get('/api/payment/policy');
        expect(res.status).toBe(200);
        expect(res.body.data).not.toHaveProperty('_shop_id'); // internal marker stripped
    });

    test('PUT /api/payment/policy dispatches (§5.2 write)', async () => {
        mockPolicy.updatePaymentPolicy.mockResolvedValue({ advance_policy: 'percentage', advance_value: 50 });
        const res = await request(app()).put('/api/payment/policy').send({ advance_policy: 'percentage', advance_value: 50 });
        expect(res.status).toBe(200);
        expect(mockPolicy.updatePaymentPolicy).toHaveBeenCalledWith('shop-1', 'user-1', expect.objectContaining({ advance_policy: 'percentage' }));
    });

    test('PATCH /api/payment/policy is an accepted alias for the same handler', async () => {
        mockPolicy.updatePaymentPolicy.mockResolvedValue({});
        const res = await request(app()).patch('/api/payment/policy').send({ advance_policy: 'none' });
        expect(res.status).toBe(200);
        expect(mockPolicy.updatePaymentPolicy).toHaveBeenCalled();
    });
});

describe('payment.routes — self-MFS claims edge validation (F-7, A9-R2)', () => {
    // Shape is validated at the boundary; ALL business rules stay in
    // payment-claim.service (defense in depth). A malformed body must be a
    // 400 VALIDATION_ERROR from the route, never a 500 from the DB driver.
    test('malformed orderId ⇒ 400 VALIDATION_ERROR, service never called', async () => {
        const res = await request(app()).post('/api/payment/claims')
            .send({ orderId: 'not-a-uuid', trxId: 'ABC123456' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(mockAccounts.createSelfMfsClaim).not.toHaveBeenCalled();
    });

    test('missing trx id or missing order id ⇒ 400', async () => {
        const noTrx = await request(app()).post('/api/payment/claims').send({ orderId: UUID });
        expect(noTrx.status).toBe(400);
        const noOrder = await request(app()).post('/api/payment/claims').send({ trxId: 'ABC123456' });
        expect(noOrder.status).toBe(400);
        expect(mockAccounts.createSelfMfsClaim).not.toHaveBeenCalled();
    });

    test('trx_id outside the mirrored service pattern (^[A-Z0-9]{6,16}$) ⇒ 400', async () => {
        // B3 (A9-R3) note: 'short' is OUT OF RANGE (5 chars) — 6-char values
        // like the former 'short1' fixture are valid TrxIDs once case is
        // normalized, exactly as the service's validateTrxIdInput accepts
        // them (the two edges must agree — lowercase acceptance pinned below).
        for (const bad of ['short', 'has space', 'punc!123', 'x'.repeat(17)]) {
            const res = await request(app()).post('/api/payment/claims').send({ orderId: UUID, trxId: bad });
            expect(res.status).toBe(400);
        }
        expect(mockAccounts.createSelfMfsClaim).not.toHaveBeenCalled();
    });

    test('oversized screenshot_url / message ⇒ 400', async () => {
        const res = await request(app()).post('/api/payment/claims').send({
            orderId: UUID, trxId: 'ABC123456', screenshotUrl: 'https://x/'.repeat(700) + 'a'.repeat(10),
        });
        expect(res.status).toBe(400);
        const res2 = await request(app()).post('/api/payment/claims').send({
            orderId: UUID, trxId: 'ABC123456', customerMessage: 'm'.repeat(501),
        });
        expect(res2.status).toBe(400);
    });

    // B3 (A9-R3, 2026-11-26): the edge pattern is applied AFTER
    // .uppercase()-normalization so the API edge and the service
    // (validateTrxIdInput uppercases + strips before matching) AGREE on
    // acceptability. Lowercase/mixed-case answers — e.g. '9b7xq2lm', the
    // shape the FE e2e fixture posts — must be ACCEPTED (201), not 400'd.
    test('B3: lowercase/mixed-case trxId is accepted at the edge (201) and arrives upper-normalized', async () => {
        mockAccounts.createSelfMfsClaim.mockResolvedValue({ created: true, status: 'payment_claimed' });
        const res = await request(app()).post('/api/payment/claims').send({ orderId: UUID, trxId: '9b7xq2lm' });
        expect(res.status).toBe(201);
        expect(mockAccounts.createSelfMfsClaim).toHaveBeenCalledWith('shop-1', 'user-1', expect.objectContaining({
            orderId: UUID, trxId: '9B7XQ2LM', // normalized before the service call
        }));

        const snakeMixed = await request(app()).post('/api/payment/claims').send({ order_id: UUID, trx_id: 'Ab12Cd34' });
        expect(snakeMixed.status).toBe(201);
        const lastCall = mockAccounts.createSelfMfsClaim.mock.calls.at(-1)[2];
        expect(lastCall.trx_id).toBe('AB12CD34');
    });

    test('B3: mixed-case duplicate semantics unchanged — an honest service duplicate still answers with its shape', async () => {
        // The service (payment-claim.service.test.js pins the real ledger
        // side) reports the same-normalized TrxID as a duplicate; the edge
        // must not alter that verdict on the way out.
        mockAccounts.createSelfMfsClaim.mockResolvedValue({
            created: false, duplicate: true, reason: 'trx_id_log', trxId: '9B7XQ2LM',
            duplicateReply: { bn: '…', en: 'This TrxID (9B7XQ2LM) was already used.' },
        });
        const res = await request(app()).post('/api/payment/claims').send({ orderId: UUID, trxId: '9b7xq2lm' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, created: false, duplicate: true, reason: 'trx_id_log' });
    });

    test('valid payload dispatches unchanged (camel + snake aliases admitted)', async () => {
        mockAccounts.createSelfMfsClaim.mockResolvedValue({ created: true, status: 'payment_claimed' });
        const res = await request(app()).post('/api/payment/claims').send({
            orderId: UUID, trxId: '8A3F2B9XK1', senderPhone: '01933333333',
            screenshotUrl: 'https://cdn.example.com/receipt.png', customerMessage: 'paid today',
        });
        expect(res.status).toBe(201);
        expect(mockAccounts.createSelfMfsClaim).toHaveBeenCalledWith('shop-1', 'user-1', expect.objectContaining({
            orderId: UUID, trxId: '8A3F2B9XK1',
        }));

        const snake = await request(app()).post('/api/payment/claims').send({
            order_id: UUID, trx_id: 'ABC123456', sender_number: '01933333333', message: 'hi',
        });
        expect(snake.status).toBe(201);
    });
});

describe('payment.routes — legacy config surface preserved (§1.4)', () => {
    test('GET /api/payment/config still works', async () => {
        mockLegacy.getPaymentConfigs.mockResolvedValue([]);
        const res = await request(app()).get('/api/payment/config');
        expect(res.status).toBe(200);
        expect(mockLegacy.getPaymentConfigs).toHaveBeenCalledWith('shop-1', 'user-1');
    });

    test('POST /api/payment/config/test returns the honest format_validated shape (§7 row 1)', async () => {
        mockLegacy.testPaymentConnection.mockResolvedValue({ success: true, status: 'format_validated', message: 'Number format validated — not a provider check' });
        const res = await request(app()).post('/api/payment/config/test').send({ gateway: 'bkash', credentials: { mfs_number: '01711111111' } });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('format_validated');
        expect(res.body.message).toMatch(/not a provider check/);
    });
});
