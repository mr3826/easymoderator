'use strict';

/**
 * A3 verification-ladder service tests (contract §2, §2.1, §2.2/D-3, §2.3,
 * §4.5, R-12/R-13).
 *
 * ALL provider interactions are CONTRACT-MOCK fixtures derived from the
 * official bKash Tokenized v2 docs sweep (§4). NOTHING here is, or may be
 * presented as, live-provider-verified: with the shipped defaults
 * (BKASH_ENABLED=false, no live credentials, no live_certified rung) every
 * provider-traffic branch must be provably INERT — the zero-HTTP assertions
 * below are the point of this suite (§8.1).
 */
process.env.NODE_ENV = 'test';

const mockPaymentConfig = { findOne: jest.fn(), findByPk: jest.fn() };
const mockPaymentTransaction = { findOne: jest.fn(), update: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockAuditLog = { create: jest.fn() };
const mockAccounts = {
    _private: { verifyShopAccess: jest.fn() },
    readVerificationRecords: jest.fn(),
    appendVerificationRecord: jest.fn(),
    writeLadderLevel: jest.fn(),
    serializeAccount: jest.fn((a) => a),
};
const mockTokenized = {
    client: {
        grantToken: jest.fn(),
        sandboxCreateQueryHandshake: jest.fn(),
        refundPayment: jest.fn(),
    },
    resolveEnvironment: jest.fn(() => 'production'),
    REFUND_WINDOW_DAYS: 60,
};

jest.mock('../../entities', () => ({
    PaymentConfig: mockPaymentConfig,
    PaymentTransaction: mockPaymentTransaction,
    UserShop: mockUserShop,
    AuditLog: mockAuditLog,
}));
jest.mock('../payment-accounts.service', () => mockAccounts);
jest.mock('../bkash-tokenized.service', () => mockTokenized);

const service = require('../payment-verification.service');

const ORIGINAL_ENV = { ...process.env };

function setEnv(vars = {}) {
    for (const key of ['BKASH_ENABLED']) delete process.env[key];
    Object.assign(process.env, vars);
}
afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
});
beforeEach(() => {
    mockAccounts._private.verifyShopAccess.mockResolvedValue({ id: 'us-1', role: 'owner' });
    mockUserShop.findOne.mockResolvedValue({ id: 'us-1', role: 'owner' });
    mockAccounts.readVerificationRecords.mockResolvedValue([]);
    mockAccounts.appendVerificationRecord.mockResolvedValue({ id: 'v-1' });
    mockAccounts.writeLadderLevel.mockImplementation(async (id, level) => ({ id, verification_level: level }));
});

const GATEWAY_ACCOUNT = () => ({
    id: 'acc-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
    verification_level: 'configured_unverified', is_enabled: true,
    credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: 'pw', mfs_type: 'bkash', mfs_mode: 'business' },
});

// ── provider-inert wallets (§2, R-12/R-13) ──────────────────────────────────
describe('verifyPaymentAccount — wallet accounts NEVER touch a provider', () => {
    test('nagad: honest verification-unavailable copy, zero provider calls, no ladder write', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-n', shop_id: 'shop-1', provider: 'nagad', account_type: 'self',
            verification_level: 'configured_unverified', is_enabled: true,
            credentials: { mfs_type: 'nagad', mfs_mode: 'self', mfs_number: '01811111111' },
        });
        setEnv({ BKASH_ENABLED: 'true' });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-n');

        expect(res.status).toBe('verification_unavailable');
        expect(res.provider_contact).toBe(false);
        expect(res.message).toContain('Official automated verification is not available for Nagad/Rocket');
        expect(res.verification_level).toBe('configured_unverified');
        expect(res.max_level).toBe('configured_unverified');
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
        expect(mockTokenized.client.sandboxCreateQueryHandshake).not.toHaveBeenCalled();
        expect(mockAccounts.writeLadderLevel).not.toHaveBeenCalled();
    });

    test('rocket: same inert ceiling with the identical honest copy (gap fixed)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-r', shop_id: 'shop-1', provider: 'rocket', account_type: 'business',
            verification_level: 'unverified', is_enabled: true,
            credentials: { mfs_type: 'rocket', mfs_mode: 'business', mfs_number: '01911111111' },
        });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-r');

        expect(res.status).toBe('verification_unavailable');
        expect(res.message).toContain('confirmed by you (the merchant), never automatically');
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
    });

    test('bkash self wallet: format check only — never a provider check (§7 row 1)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-b', shop_id: 'shop-1', provider: 'bkash', account_type: 'self',
            verification_level: 'configured_unverified', is_enabled: true,
            credentials: { mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711111111' },
        });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-b');

        expect(res.status).toBe('format_validated');
        expect(res.message).toBe('Number format validated — not a provider check');
        expect(res.provider_contact).toBe(false);
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
    });

    test('bkash self wallet with a malformed number → format_invalid, still zero provider calls', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-b', shop_id: 'shop-1', provider: 'bkash', account_type: 'self',
            verification_level: 'configured_unverified', is_enabled: true,
            credentials: { mfs_type: 'bkash', mfs_number: '12345' },
        });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-b');
        expect(res.status).toBe('format_invalid');
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
    });

    test('cod has nothing to verify (§1.1)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({ id: 'acc-c', shop_id: 'shop-1', provider: 'cod', account_type: 'standard' });
        await expect(service.verifyPaymentAccount('shop-1', 'user-1', 'acc-c'))
            .rejects.toMatchObject({ code: 'NOTHING_TO_VERIFY', status: 400 });
    });
});

// ── merchant_gateway credential check (§2.1) ────────────────────────────────
describe('verifyPaymentAccount — bKash merchant_gateway ladder rules', () => {
    test('incomplete credentials are rejected before anything else (§2.3 predicate)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
            verification_level: 'unverified', is_enabled: true, credentials: { app_key: 'AK' },
        });
        await expect(service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw'))
            .rejects.toMatchObject({ code: 'GATEWAY_CREDENTIALS_INCOMPLETE', status: 400 });
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
    });

    test('BKASH_ENABLED=false ⇒ automation_disabled and ZERO provider traffic (R-12)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'false' });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('automation_disabled');
        expect(res.provider_contact).toBe(false);
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
        expect(mockTokenized.client.sandboxCreateQueryHandshake).not.toHaveBeenCalled();
    });

    test('30-minute cooldown returns the cached verdict with no provider contact (§2.1)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        mockAccounts.readVerificationRecords.mockResolvedValue([
            { method: 'credentials_check', created_at: new Date(Date.now() - 5 * 60 * 1000), evidence: { outcome: 'credentials_valid' } },
        ]);

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('cached_verdict');
        expect(res.cached).toBe(true);
        expect(res.provider_contact).toBe(false);
        expect(res.cooldown_remaining_seconds).toBeGreaterThan(20 * 60);
        expect(mockTokenized.client.grantToken).not.toHaveBeenCalled();
    });

    test('grant success = CREDENTIALS_VALID only: ladder never raised above configured_unverified, copy never claims connected (§2.1)', async () => {
        const account = GATEWAY_ACCOUNT();
        account.verification_level = 'sandbox_verified'; // must NOT change on a grant
        mockPaymentConfig.findOne.mockResolvedValue(account);
        mockPaymentConfig.findByPk.mockResolvedValue(account);
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.client.grantToken.mockResolvedValue('id_token_xyz');

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('credentials_valid');
        expect(res.message).toBe('bKash accepted your app credentials (one of 2 hourly checks used).');
        expect(res.message).not.toMatch(/connected|verified live/i);
        expect(res.verification_level).toBe('sandbox_verified');
        expect(mockAccounts.writeLadderLevel).not.toHaveBeenCalled(); // no promotion
        expect(mockAccounts.appendVerificationRecord).toHaveBeenCalledWith(expect.objectContaining({
            level: 'sandbox_verified', // attests the CURRENT level, honest ledger
            method: 'credentials_check',
            providerEnvironment: 'production',
            evidence: expect.objectContaining({ outcome: 'credentials_valid', settlement: false }),
        }));
    });

    test('grant success from unverified promotes ONLY to configured_unverified (§2.1)', async () => {
        const account = GATEWAY_ACCOUNT();
        account.verification_level = 'unverified';
        mockPaymentConfig.findOne.mockResolvedValue(account);
        mockPaymentConfig.findByPk.mockResolvedValue({ ...account, verification_level: 'unverified' });
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.client.grantToken.mockResolvedValue('t');

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.verification_level).toBe('configured_unverified');
        expect(mockAccounts.writeLadderLevel).toHaveBeenCalledWith('acc-gw', 'configured_unverified');
    });

    test('grant refusal propagates the 429 CREDENTIAL_CHECK_RATE_LIMITED (2/hour, §2.1)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        const { AppError } = require('../../../utils/AppError');
        mockTokenized.client.grantToken.mockRejectedValue(new AppError('budget', 429, 'CREDENTIAL_CHECK_RATE_LIMITED'));

        await expect(service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw'))
            .rejects.toMatchObject({ status: 429, code: 'CREDENTIAL_CHECK_RATE_LIMITED' });
        expect(mockAccounts.appendVerificationRecord).not.toHaveBeenCalled();
    });

    test('provider 401 → credentials_invalid recorded; ladder untouched', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.client.grantToken.mockRejectedValue(
            Object.assign(new Error('denied'), { grantHttpStatus: 401, response: { status: 401 } }),
        );

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('credentials_invalid');
        expect(mockAccounts.writeLadderLevel).not.toHaveBeenCalled();
        expect(mockAccounts.appendVerificationRecord).toHaveBeenCalledWith(expect.objectContaining({
            method: 'credentials_check',
            evidence: expect.objectContaining({ outcome: 'credentials_invalid', http_status: 401 }),
        }));
    });

    test('network failure → honest PROVIDER_UNREACHABLE, no verdict recorded as provider contact', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.client.grantToken.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

        await expect(service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw'))
            .rejects.toMatchObject({ status: 502, code: 'PROVIDER_UNREACHABLE' });
    });

    // ── sandbox rung (§2.2 / D-3) ────────────────────────────────────────────
    test('sandbox create→query handshake sets sandbox_verified with the exact D-3 copy and no settlement claim', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.resolveEnvironment.mockReturnValueOnce('sandbox');
        mockTokenized.client.sandboxCreateQueryHandshake.mockResolvedValue({
            grantOk: true, createOk: true, queryOk: true, invoiceEcho: true, paymentId: 'PID-1', settlement: false,
        });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('sandbox_verified');
        expect(res.message).toBe('sandbox checkout handshake verified; no settlement implied');
        expect(mockAccounts.writeLadderLevel).toHaveBeenCalledWith('acc-gw', 'sandbox_verified');
        expect(mockAccounts.appendVerificationRecord).toHaveBeenCalledWith(expect.objectContaining({
            level: 'sandbox_verified',
            method: 'sandbox_create_query',
            providerEnvironment: 'sandbox',
            evidence: expect.objectContaining({ settlement: false, no_settlement_implied: true, invoice_echo: true }),
        }));
    });

    test('handshake with a failed invoice echo does NOT raise the ladder', async () => {
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT());
        setEnv({ BKASH_ENABLED: 'true' });
        mockTokenized.resolveEnvironment.mockReturnValueOnce('sandbox');
        mockTokenized.client.sandboxCreateQueryHandshake.mockResolvedValue({
            grantOk: true, createOk: true, queryOk: true, invoiceEcho: false, paymentId: 'PID-1',
        });

        const res = await service.verifyPaymentAccount('shop-1', 'user-1', 'acc-gw');

        expect(res.status).toBe('sandbox_handshake_incomplete');
        expect(res.verification_level).toBe('configured_unverified');
        expect(mockAccounts.writeLadderLevel).not.toHaveBeenCalled();
    });
});

// ── certify-live (§2.3) ──────────────────────────────────────────────────────
describe('certifyLiveAccount — recorded, never self-declared', () => {
    test('non-owner membership is refused even when middleware let it through', async () => {
        mockUserShop.findOne.mockResolvedValue({ id: 'us-2', role: 'staff' });
        await expect(service.certifyLiveAccount('shop-1', 'user-2', 'acc-gw', 'evidence'))
            .rejects.toMatchObject({ status: 403, code: 'OWNER_ONLY' });
    });

    test('wallet accounts can never reach live_certified (§2 ceiling)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-w', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', verification_level: 'sandbox_verified',
        });
        await expect(service.certifyLiveAccount('shop-1', 'user-1', 'acc-w', 'onboarding email'))
            .rejects.toMatchObject({ status: 409, code: 'LADDER_CEILING' });

        mockPaymentConfig.findOne.mockResolvedValue({
            id: 'acc-r', shop_id: 'shop-1', provider: 'rocket', account_type: 'business', verification_level: 'sandbox_verified',
        });
        await expect(service.certifyLiveAccount('shop-1', 'user-1', 'acc-r', 'x'.repeat(10)))
            .rejects.toMatchObject({ status: 409, code: 'LADDER_CEILING' });
    });

    test('only a sandbox_verified gateway account can be certified (§2.3)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({
            ...GATEWAY_ACCOUNT(), verification_level: 'configured_unverified',
        });
        await expect(service.certifyLiveAccount('shop-1', 'user-1', 'acc-gw', 'bKash onboarding email 2026-11-30'))
            .rejects.toMatchObject({ status: 409, code: 'SANDBOX_HANDSHAKE_REQUIRED' });
    });

    test('empty evidence is rejected (§2.3)', async () => {
        mockPaymentConfig.findOne.mockResolvedValue({ ...GATEWAY_ACCOUNT(), verification_level: 'sandbox_verified' });
        await expect(service.certifyLiveAccount('shop-1', 'user-1', 'acc-gw', '   '))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_EVIDENCE' });
    });

    test('valid certification writes ladder + append-only record + AuditLog, and never implies automation is on', async () => {
        const account = { ...GATEWAY_ACCOUNT(), verification_level: 'sandbox_verified' };
        mockPaymentConfig.findOne.mockResolvedValue(account);
        mockAuditLog.create.mockResolvedValue({});

        const res = await service.certifyLiveAccount('shop-1', 'user-1', 'acc-gw', 'bKash onboarding email 2026-11-30');

        expect(res.verification_level).toBe('live_certified');
        expect(mockAccounts.writeLadderLevel).toHaveBeenCalledWith('acc-gw', 'live_certified');
        expect(mockAccounts.appendVerificationRecord).toHaveBeenCalledWith(expect.objectContaining({
            level: 'live_certified',
            method: 'certify_live',
            providerEnvironment: 'production',
            evidence: expect.objectContaining({ source: 'owner_recorded', self_declared: false }),
        }));
        expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'payment_account_live_certified',
            resource_type: 'payment_account',
            resource_id: 'acc-gw',
        }));
        // Honest: certification ≠ payment automation in this environment.
        expect(res.message).toContain('BKASH_ENABLED');
    });
});

// ── refund (§4.5) ────────────────────────────────────────────────────────────
describe('refundPaymentTransaction — owner-only v2 gateway refund', () => {
    const settledTxn = () => ({
        id: 'txn-1', order_id: 'order-1', shop_id: 'shop-1', status: 'paid',
        payment_gateway: 'bkash', payment_account_id: 'acc-gw', transaction_id: 'PID-1',
        amount: '500.00', verified_at: new Date(), gateway_response: { trxID: 'TRX-9' },
        update: jest.fn().mockResolvedValue(true),
    });

    test('not-found / non-settled / non-gateway rows are refused honestly', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue(null);
        await expect(service.refundPaymentTransaction('shop-1', 'user-1', 'txn-x', {}))
            .rejects.toMatchObject({ status: 404 });

        mockPaymentTransaction.findOne.mockResolvedValue({ ...settledTxn(), status: 'payment_claimed' });
        await expect(service.refundPaymentTransaction('shop-1', 'user-1', 'txn-1', {}))
            .rejects.toMatchObject({ status: 409, code: 'NOT_REFUNDABLE' });

        mockPaymentTransaction.findOne.mockResolvedValue({ ...settledTxn(), payment_gateway: null, payment_account_id: null });
        await expect(service.refundPaymentTransaction('shop-1', 'user-1', 'txn-1', {}))
            .rejects.toMatchObject({ status: 409, code: 'REFUND_NOT_SUPPORTED' });
        expect(mockTokenized.client.refundPayment).not.toHaveBeenCalled();
    });

    test('60-day window is enforced (§4.5 docs sweep)', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue({ ...settledTxn(), verified_at: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000) });
        await expect(service.refundPaymentTransaction('shop-1', 'user-1', 'txn-1', {}))
            .rejects.toMatchObject({ status: 409, code: 'REFUND_WINDOW_EXPIRED' });
    });

    test('inert automation (R-12) refuses rather than simulating a refund', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue(settledTxn());
        setEnv({ BKASH_ENABLED: 'false' });
        mockPaymentConfig.findOne.mockResolvedValue(GATEWAY_ACCOUNT()); // not live_certified

        await expect(service.refundPaymentTransaction('shop-1', 'user-1', 'txn-1', {}))
            .rejects.toMatchObject({ status: 503, code: 'GATEWAY_AUTOMATION_DISABLED' });
        expect(mockTokenized.client.refundPayment).not.toHaveBeenCalled();
    });

    test('live_certified + enabled flag ⇒ provider refund recorded + audited, message stays honest (submitted, not provider-declared)', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue(settledTxn());
        setEnv({ BKASH_ENABLED: 'true' });
        mockPaymentConfig.findOne.mockResolvedValue({ ...GATEWAY_ACCOUNT(), verification_level: 'live_certified' });
        mockTokenized.client.refundPayment.mockResolvedValue({ refundID: 'RF-1' });
        mockAuditLog.create.mockResolvedValue({});

        const res = await service.refundPaymentTransaction('shop-1', 'user-1', 'txn-1', { reason: 'wrong item' });

        expect(res.success).toBe(true);
        expect(res.refund_id).toBe('RF-1');
        expect(mockTokenized.client.refundPayment).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-gw' }), {
            paymentId: 'PID-1', trxId: 'TRX-9', refundAmount: '500.00', reason: 'wrong item',
        });
        expect(res.message).toMatch(/Query/i); // completion tracked via Query, never asserted
        expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_transaction_refund' }));
    });
});
