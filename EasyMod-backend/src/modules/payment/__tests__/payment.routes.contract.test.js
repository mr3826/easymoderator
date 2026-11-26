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
