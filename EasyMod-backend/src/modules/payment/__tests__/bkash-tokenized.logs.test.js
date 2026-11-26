'use strict';

/**
 * Provider-error logging redaction for the v2 client (§8.1: "bkash-merchant
 * .logs.test.js migrates to the v2 client; keep the safeErrorCode pattern").
 * The v1 suite stays intact; this is its successor target.
 *
 * ⚠ CONTRACT-MOCK fixtures (official-doc-shaped error payloads). Nothing here
 * is live-provider evidence (R-12).
 */
process.env.NODE_ENV = 'test';

const mockAxiosPost = jest.fn();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('axios', () => ({ post: mockAxiosPost }));
jest.mock('../../entities', () => ({
    PaymentConfig: { findOne: jest.fn(), findByPk: jest.fn() },
    PaymentTransaction: { findOne: jest.fn(), update: jest.fn(), create: jest.fn(), findAll: jest.fn() },
    Order: { findOne: jest.fn() },
    Shop: { findByPk: jest.fn() },
}));
jest.mock('../../../utils/cache.service', () => ({
    getForShop: async () => null,
    setForShop: async () => true,
    deleteForShop: async () => true,
    // F-3 (A9-R2): the grant budget now consumes atomically; this suite pins
    // LOG REDACTION only, so the consume always succeeds (slot 1).
    consumeSlotForShopStrict: jest.fn(async () => 1),
}));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: () => mockLogger }));
jest.mock('../../webhooks/payment-webhook.controller', () => ({ processSuccessfulPayment: jest.fn() }));

const { client } = require('../bkash-tokenized.service');

const AUTOMATABLE = {
    id: 'acc-log', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
    verification_level: 'live_certified', is_enabled: true,
    credentials: { app_key: 'AK', app_secret: 'SUPER-SECRET', username: 'u@x', password: 'sup3r-passw0rd' },
    config: { environment: 'production' },
};
const ORIGINAL_ENV = { ...process.env };

const dirtyError = (code) => Object.assign(
    new Error('Rahim 01711111111, Mirpur address, transcript and payment payload'),
    {
        code,
        response: {
            status: 502,
            data: { customer_name: 'Rahim', customer_phone: '01711111111', amount: '2400.00', statusMessage: 'Rahim 01711111111 failed' },
        },
    },
);

beforeEach(() => { jest.clearAllMocks(); Object.assign(process.env, ORIGINAL_ENV, { BKASH_ENABLED: 'true' }); });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('v2 client logs only safe provider error codes', () => {
    test('create failure logs code only — never PII, amount, or secrets', async () => {
        mockAxiosPost
            .mockResolvedValueOnce({ data: { id_token: 'T', refresh_token: 'R' } })
            .mockRejectedValueOnce(dirtyError('UPSTREAM_TIMEOUT'));

        await expect(client.createPayment(AUTOMATABLE, {
            amount: '2400.00', merchantInvoiceNumber: 'ORDER-1',
        })).rejects.toBeDefined();

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('bKash v2 create'),
            expect.objectContaining({ errorCode: 'UPSTREAM_TIMEOUT' }),
        );
        const logs = JSON.stringify([...mockLogger.error.mock.calls, ...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls]);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur address');
        expect(logs).not.toContain('transcript');
        expect(logs).not.toContain('payment payload');
        expect(logs).not.toContain('2400.00');
        expect(logs).not.toContain('SUPER-SECRET');
        expect(logs).not.toContain('sup3r-passw0rd');
        expect(logs).not.toContain('statusMessage');
    });

    test('query failure logs code only', async () => {
        mockAxiosPost
            .mockResolvedValueOnce({ data: { id_token: 'T' } })
            .mockRejectedValueOnce(dirtyError('ECONNREFUSED'));

        await expect(client.queryPayment(AUTOMATABLE, { paymentId: 'PRIVATE-PAYMENT-ID' })).rejects.toBeDefined();

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('bKash v2 query'),
            expect.objectContaining({ errorCode: 'ECONNREFUSED' }),
        );
        const logs = JSON.stringify(mockLogger.error.mock.calls);
        // safeCorrelationId keeps the payment reference (v1 pattern, migrated);
        // PII and amounts must never appear.
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('2400.00');
        expect(logs).not.toContain('Mirpur');
    });

    test('grant failure logs code + numeric status only, never the credential headers', async () => {
        mockAxiosPost.mockRejectedValue(Object.assign(
            new Error('bKash rejected username/password (secret)'),
            { code: 'ERR_BAD_REQUEST', response: { status: 401, data: { statusMessage: 'Invalid username: u@x password sup3r-passw0rd' } } },
        ));

        await expect(client.grantToken(AUTOMATABLE, { force: true })).rejects.toBeDefined();

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('bKash v2 grant failed'),
            expect.objectContaining({ errorCode: 'ERR_BAD_REQUEST' }),
        );
        const logs = JSON.stringify(mockLogger.error.mock.calls);
        expect(logs).not.toContain('sup3r-passw0rd');
        expect(logs).not.toContain('u@x');
    });

    test('non-alphanumeric error codes are replaced, never passed through', async () => {
        mockAxiosPost
            .mockResolvedValueOnce({ data: { id_token: 'T' } })
            .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'evil ${} code with words 01711111111' }));
        await expect(client.queryPayment(AUTOMATABLE, { paymentId: 'p' })).rejects.toBeDefined();
        const codes = mockLogger.error.mock.calls.map(([, ctx]) => ctx?.errorCode);
        expect(codes).toContain('BKASH_V2_ERROR');
    });
});
