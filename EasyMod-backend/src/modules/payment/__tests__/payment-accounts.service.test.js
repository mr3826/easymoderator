'use strict';

/**
 * A5 canonical multi-account CRUD + preference + ladder storage helpers +
 * D-6 settings.bd sync. Fake entities; the payment.service legacy helpers and
 * the shop settings merge/cache are mocked at their seams.
 */
process.env.NODE_ENV = 'test';

const mockPaymentAccount = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findByPk: jest.fn(),
    sequelize: { transaction: jest.fn((cb) => cb({ LOCK: { UPDATE: 'FOR UPDATE' } })) },
};
const mockPaymentAccountVerification = { create: jest.fn(), findAll: jest.fn() };
const mockPaymentTransaction = { count: jest.fn(), findOne: jest.fn(), findAll: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockShop = {
    sequelize: { transaction: jest.fn((cb) => cb({ LOCK: { UPDATE: 'FOR UPDATE' } })) },
    findByPk: jest.fn(),
};

jest.mock('../../entities', () => ({
    PaymentConfig: mockPaymentAccount,
    PaymentAccountVerification: mockPaymentAccountVerification,
    PaymentTransaction: mockPaymentTransaction,
    UserShop: mockUserShop,
    Shop: mockShop,
}));
jest.mock('../../shop/shop-settings.validator', () => ({
    mergeSettingsPreservingRtoConsent: (current, patch) => ({ ...(current || {}), ...(patch || {}) }),
}));
jest.mock('../../../utils/shop-settings-cache', () => ({
    invalidateShopSettingsCaches: jest.fn().mockResolvedValue(undefined),
}));

const accounts = require('../payment-accounts.service');
const { invalidateShopSettingsCaches } = require('../../../utils/shop-settings-cache');

const WALLET_CREDS = { mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711111111' };

beforeEach(() => {
    jest.clearAllMocks();
    mockUserShop.findOne.mockResolvedValue({ id: 'us-1', role: 'owner' });
    mockPaymentAccountVerification.create.mockResolvedValue({ id: 'v-1' });
});
afterEach(() => jest.restoreAllMocks());

describe('payment-accounts.service — multi-account CRUD', () => {
    test('creates a bkash SELF wallet: dual-writes legacy gateway, canonical provider, configured_unverified', async () => {
        mockPaymentAccount.findOne.mockResolvedValue(null);
        mockPaymentAccount.create.mockImplementation(async (a) => ({ ...a, credentials: a.credentials, save: jest.fn() }));
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn().mockResolvedValue(true) });

        const res = await accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'bkash', account_type: 'self', is_enabled: true, credentials: WALLET_CREDS,
        });

        expect(mockPaymentAccount.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: 'shop-1',
            provider: 'bkash',
            account_type: 'self',
            gateway: 'self-mfs',            // §1.4 dual-write
            verification_level: 'configured_unverified',
            is_preferred: false,
        }));
        expect(res.provider).toBe('bkash');
        expect(res.credential_summary).not.toHaveProperty('app_secret');
        // a "configured" evidence row was appended (§2 save path)
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            level: 'configured_unverified', method: 'configured',
        }));
    });

    test('merchant_gateway is bKash-only (§1.1)', async () => {
        await expect(accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'nagad', account_type: 'merchant_gateway', credentials: {},
        })).rejects.toMatchObject({ code: 'GATEWAY_PROVIDER_UNSUPPORTED' });
    });

    test('merchant_gateway stores app creds, never validated as a wallet number (§1.3-2)', async () => {
        mockPaymentAccount.findOne.mockResolvedValue(null);
        mockPaymentAccount.create.mockImplementation(async (a) => ({ ...a, credentials: a.credentials, save: jest.fn() }));
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        const res = await accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'bkash', account_type: 'merchant_gateway',
            credentials: { app_key: 'k', app_secret: 's', username: 'u' },
        });
        expect(res.account_type).toBe('merchant_gateway');
        // no mfs_number required for a gateway row; provider dual-written self-mfs
        expect(mockPaymentAccount.create).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'self-mfs' }));
    });

    test('rejects credentials whose mfs_type disagrees with the provider', async () => {
        await expect(accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'nagad', account_type: 'self',
            credentials: { mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711111111' },
        })).rejects.toMatchObject({ code: 'MFS_TYPE_PROVIDER_MISMATCH' });
    });

    test('cross-tenant guard: a foreign shopId on membership is rejected', async () => {
        mockUserShop.findOne.mockResolvedValue(null);
        await expect(accounts.listPaymentAccounts('shop-2', 'user-1')).rejects.toMatchObject({ status: 403 });
    });

    test('getPaymentAccount is scoped by shop_id (no cross-tenant read)', async () => {
        mockPaymentAccount.findOne.mockResolvedValue(null);
        await expect(accounts.getPaymentAccount('shop-1', 'user-1', 'a-9')).rejects.toMatchObject({ status: 404 });
        expect(mockPaymentAccount.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'a-9', shop_id: 'shop-1' },
        }));
    });

    test('credential CHANGE demotes the ladder to unverified + records it (§2)', async () => {
        const existing = {
            id: 'a-1', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs',
            is_enabled: true, verification_level: 'configured_unverified', is_preferred: false,
            credentials: { ...WALLET_CREDS }, config: {}, save: jest.fn().mockResolvedValue(true),
        };
        mockPaymentAccount.findOne.mockResolvedValue(existing);

        await accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'bkash', account_type: 'self', is_enabled: true,
            credentials: { ...WALLET_CREDS, mfs_number: '01799999999' },
        });

        expect(existing.verification_level).toBe('unverified'); // demoted (§2 invalidation)
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            level: 'unverified', method: 'configured',
        }));
    });
});

describe('payment-accounts.service — preference (D-8)', () => {
    test('setPreferred clears all then elects one, owner-scoped by shop_id', async () => {
        mockPaymentAccount.findOne.mockResolvedValue({ id: 'a-1', shop_id: 'shop-1', is_enabled: true });
        mockPaymentAccount.update.mockResolvedValue([1]);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.setPreferredAccount('shop-1', 'user-1', 'a-1');

        // two updates: clear-all-preferred, then set-this-one, both scoped to shop-1
        const shopScoped = mockPaymentAccount.update.mock.calls.filter((c) => c[1].where.shop_id === 'shop-1');
        expect(shopScoped.length).toBeGreaterThanOrEqual(2);
        expect(shopScoped[0][0]).toEqual({ is_preferred: false });
        expect(shopScoped[1][0]).toEqual({ is_preferred: true });
    });

    test('cannot elect a disabled account as preferred', async () => {
        mockPaymentAccount.findOne.mockResolvedValue({ id: 'a-1', shop_id: 'shop-1', is_enabled: false });
        await expect(accounts.setPreferredAccount('shop-1', 'user-1', 'a-1'))
            .rejects.toMatchObject({ code: 'PREFERRED_ACCOUNT_DISABLED' });
    });
});

describe('payment-accounts.service — disable/delete clear the mirror (P0-3 / §8.1)', () => {
    test('disabling the last enabled wallet blanks settings.bd mfs_* (no stale advertised number)', async () => {
        const existing = {
            id: 'a-1', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs',
            is_enabled: true, verification_level: 'configured_unverified', is_preferred: true,
            credentials: { ...WALLET_CREDS }, config: {}, save: jest.fn().mockResolvedValue(true),
        };
        mockPaymentAccount.findOne.mockResolvedValue(existing);
        // after disable, no enabled wallet rows remain
        mockPaymentAccount.findAll.mockResolvedValue([]);
        const shopUpdate = jest.fn().mockResolvedValue(true);
        mockShop.findByPk.mockResolvedValue({ settings: { bd: { mfs_number: '01711111111', mfs_type: 'bkash' } }, update: shopUpdate });

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'a-1', { is_enabled: false });

        expect(existing.is_enabled).toBe(false);
        const settings = shopUpdate.mock.calls[0][0].settings;
        expect(settings.bd.wallets).toEqual([]);
        expect(settings.bd.mfs_number).toBeNull(); // §7 #3: stale number must not survive
        expect(settings.bd.mfs_type).toBeNull();
    });
});

describe('payment-accounts.service — D-6 settings.bd sync', () => {
    test('wallets[] array + legacy mfs_* mirror the preferred are written (single writer)', async () => {
        mockPaymentAccount.findAll.mockResolvedValue([
            { id: 'a-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, credentials: { mfs_number: '01711111111' } },
            { id: 'a-2', provider: 'nagad', account_type: 'self', is_enabled: true, is_preferred: false, credentials: { mfs_number: '01822222222' } },
            { id: 'cod', provider: 'cod', account_type: 'standard', is_enabled: true, is_preferred: false, credentials: null },
        ]);
        const shopUpdate = jest.fn().mockResolvedValue(true);
        mockShop.findByPk.mockResolvedValue({ settings: { bd: { google_sheet_id: 'sheet-9' } }, update: shopUpdate });

        await accounts.syncBdFromAccounts('shop-1');

        expect(invalidateShopSettingsCaches).toHaveBeenCalledWith('shop-1');
        const settings = shopUpdate.mock.calls[0][0].settings;
        expect(settings.bd.google_sheet_id).toBe('sheet-9'); // unrelated bd keys preserved
        expect(settings.bd.wallets).toHaveLength(2);          // cod excluded (not a wallet)
        expect(settings.bd.wallets[0]).toEqual(expect.objectContaining({ provider: 'bkash', number: '01711111111' }));
        // legacy mirror keys = PREFERRED wallet (self-mfs-handler + owner-notification read these)
        expect(settings.bd.mfs_number).toBe('01711111111');
        expect(settings.bd.mfs_type).toBe('bkash');
    });
});

describe('payment-accounts.service — delete safety (F4, 2026-11-26)', () => {
    const deletableAccount = () => ({
        id: 'acct-gw-1', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs',
        is_enabled: true, is_preferred: true, verification_level: 'configured_unverified',
        credentials: { ...WALLET_CREDS }, config: {}, destroy: jest.fn().mockResolvedValue(true),
    });

    test('deletes when only TERMINAL (settled/rejected) transactions reference the account', async () => {
        const account = deletableAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockPaymentTransaction.count.mockResolvedValue(0); // zero NON-TERMINAL refs
        mockPaymentAccount.findAll.mockResolvedValue([]);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        const res = await accounts.deletePaymentAccount('shop-1', 'user-1', 'acct-gw-1');

        expect(res.success).toBe(true);
        expect(account.destroy).toHaveBeenCalled();
    });

    test('the reference check blocks ONLY non-terminal statuses (taxonomy single source)', async () => {
        const taxonomy = require('../payment-taxonomy');
        const { Op } = require('sequelize');
        const account = deletableAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockPaymentTransaction.count.mockResolvedValue(0);
        mockPaymentAccount.findAll.mockResolvedValue([]);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.deletePaymentAccount('shop-1', 'user-1', 'acct-gw-1');

        const call = mockPaymentTransaction.count.mock.calls[0][0];
        expect(call.where.payment_account_id).toBe('acct-gw-1');
        const blocked = [...call.where.status[Op.in]];
        expect(blocked.sort()).toEqual([...taxonomy.APPROVABLE_STATUSES].sort()); // pending, initiated, payment_claimed, processing
        for (const terminal of ['paid', 'verified', 'failed', 'rejected']) {
            expect(blocked).not.toContain(terminal); // settled history never blocks (FK SET NULL keeps the row)
        }
    });

    test('delete REFUSES with 409 ACCOUNT_IN_USE while a non-terminal claim points here', async () => {
        const account = deletableAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockPaymentTransaction.count.mockResolvedValue(1); // e.g. a payment_claimed awaiting judgment

        await expect(accounts.deletePaymentAccount('shop-1', 'user-1', 'acct-gw-1'))
            .rejects.toMatchObject({ status: 409, code: 'ACCOUNT_IN_USE' });

        expect(account.destroy).not.toHaveBeenCalled();
        expect(mockShop.findByPk).not.toHaveBeenCalled(); // refusal causes no mirror churn
    });

    test('an unverifiable reference check FAILS CLOSED — nothing is deleted', async () => {
        const account = deletableAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockPaymentTransaction.count.mockRejectedValue(new Error('db down'));

        await expect(accounts.deletePaymentAccount('shop-1', 'user-1', 'acct-gw-1'))
            .rejects.toMatchObject({ status: 503, code: 'ACCOUNT_USAGE_CHECK_UNAVAILABLE' });

        expect(account.destroy).not.toHaveBeenCalled();
    });
});

describe('payment-accounts.service — deterministic mirror election (M7)', () => {
    test('no preferred row: tie-break = provider then account_id regardless of DB order — agreement with resolvePaymentWallet (§6)', async () => {
        mockPaymentAccount.findAll.mockResolvedValue([
            // deliberately adverse DB order:
            { id: 'acct-n-9', provider: 'nagad', account_type: 'self', is_enabled: true, is_preferred: false, credentials: { mfs_number: '01822222222' } },
            { id: 'acct-b-7', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: false, credentials: { mfs_number: '01711111111' } },
            { id: 'acct-b-5', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: false, credentials: { mfs_number: '01700000000' } },
        ]);
        const shopUpdate = jest.fn().mockResolvedValue(true);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: shopUpdate });

        await accounts.syncBdFromAccounts('shop-1');

        const bd = shopUpdate.mock.calls[0][0].settings.bd;
        // The legacy mfs_* mirror (self-mfs-handler + owner-notification + AI
        // operating context read it) elects the SAME wallet the chatbot's
        // payment-claim.resolvePaymentWallet does: bkash < nagad, then acct-b-5.
        expect(bd.mfs_type).toBe('bkash');
        expect(bd.mfs_number).toBe('01700000000');
        expect(bd.wallets[0]).toMatchObject({ account_id: 'acct-b-5', provider: 'bkash' });
    });

    test('an explicit preferred row wins over the tie-break', async () => {
        mockPaymentAccount.findAll.mockResolvedValue([
            { id: 'acct-a', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: false, credentials: { mfs_number: '01700000000' } },
            { id: 'acct-z', provider: 'rocket', account_type: 'self', is_enabled: true, is_preferred: true, credentials: { mfs_number: '01966666666' } },
        ]);
        const shopUpdate = jest.fn().mockResolvedValue(true);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: shopUpdate });

        await accounts.syncBdFromAccounts('shop-1');

        expect(shopUpdate.mock.calls[0][0].settings.bd.mfs_number).toBe('01966666666');
    });
});

describe('payment-accounts.service — gateway password blank-means-keep (M8)', () => {
    const gwAccount = (password = 'stored-pw') => ({
        id: 'acct-gw', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
        gateway: 'self-mfs', is_enabled: true, is_preferred: false, verification_level: 'live_certified',
        credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password, mfs_type: 'bkash', mfs_mode: 'business' },
        config: {}, save: jest.fn().mockResolvedValue(true),
    });

    test('PATCH replace WITHOUT password keeps the stored secret and does NOT falsely demote', async () => {
        const account = gwAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-gw', {
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x' },
        });

        expect(account.credentials).toMatchObject({ app_key: 'AK', password: 'stored-pw' });
        expect(account.verification_level).toBe('live_certified'); // secret re-save ≠ credential change
        expect(mockPaymentAccountVerification.create).not.toHaveBeenCalled();
    });

    test('PATCH replace with a BLANK password also keeps it (documented blank-means-keep)', async () => {
        const account = gwAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-gw', {
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: '   ' },
        });

        expect(account.credentials.password).toBe('stored-pw');
        expect(account.verification_level).toBe('live_certified');
    });

    test('a REAL password change still replaces AND demotes the ladder (§2 unchanged)', async () => {
        const account = gwAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-gw', {
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: 'rotated-pw' },
        });

        expect(account.credentials.password).toBe('rotated-pw');
        expect(account.verification_level).toBe('unverified');
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            level: 'unverified', evidence: { reason: 'credentials_changed' },
        }));
    });

    test('POST upsert on an existing gateway row follows the same blank-means-keep rule', async () => {
        const account = gwAccount();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });

        await accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'bkash', account_type: 'merchant_gateway', is_enabled: true,
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x' },
        });

        expect(account.credentials).toMatchObject({ password: 'stored-pw' });
        expect(account.verification_level).toBe('live_certified');
    });
});

describe('payment-accounts.service — environment-change demotion (F-2c, A9-R2 2026-11-26)', () => {
    // config.environment is the proven posture: the sandbox handshake (§2.2)
    // and — post A9-R2 — live certification (§2.3) both attest against it.
    // Flipping it must mirror the credentials-change policy: demote the ladder
    // (record 'environment_changed') + clear the account token cache, so no
    // stale-environment rung or id_token survives the posture change.
    const tokenized = require('../bkash-tokenized.service');
    const gwEnv = (over = {}) => ({
        id: 'acct-env', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway',
        gateway: 'self-mfs', is_enabled: true, is_preferred: false,
        verification_level: 'sandbox_verified',
        credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: 'pw', mfs_type: 'bkash', mfs_mode: 'business' },
        config: { environment: 'sandbox' }, save: jest.fn().mockResolvedValue(true),
        ...over,
    });

    test('PATCH flipping config.environment demotes the ladder + writes an environment_changed record + clears token cache', async () => {
        const account = gwEnv();
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });
        const clearSpy = jest.spyOn(tokenized.client, 'clearTokenCache').mockResolvedValue(undefined);

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-env', {
            config: { environment: 'production' },
        });

        expect(account.verification_level).toBe('configured_unverified'); // demoted (§2 invalidation, env flip)
        expect(account.config).toMatchObject({ environment: 'production' });
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            payment_account_id: 'acct-env',
            level: 'configured_unverified',
            method: 'configured',
            evidence: expect.objectContaining({ reason: 'environment_changed', from: 'sandbox', to: 'production' }),
        }));
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(clearSpy).toHaveBeenCalledWith(account);
    });

    test('re-saving the SAME environment changes nothing (no false demotion, no cache flush)', async () => {
        const account = gwEnv({ verification_level: 'live_certified' });
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });
        const clearSpy = jest.spyOn(tokenized.client, 'clearTokenCache').mockResolvedValue(undefined);

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-env', {
            config: { environment: 'sandbox' }, // unchanged value
        });

        expect(account.verification_level).toBe('live_certified');
        expect(mockPaymentAccountVerification.create).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
    });

    test('credentials + environment changed together: the STRONGER credential demotion stands', async () => {
        const account = gwEnv({ verification_level: 'live_certified' });
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });
        jest.spyOn(tokenized.client, 'clearTokenCache').mockResolvedValue(undefined);

        await accounts.updatePaymentAccount('shop-1', 'user-1', 'acct-env', {
            credentials: { app_key: 'AK', app_secret: 'NEW-SECRET', username: 'u@x', password: 'pw' },
            config: { environment: 'production' },
        });

        expect(account.verification_level).toBe('unverified'); // credentials_changed wins (§2)
        const reasons = mockPaymentAccountVerification.create.mock.calls.map((c) => c[0].evidence?.reason);
        expect(reasons).toContain('credentials_changed');
        expect(reasons).toContain('environment_changed');
    });

    test('POST upsert REPLACE with a flipped environment demotes identically (one policy, both writers)', async () => {
        const account = gwEnv({ verification_level: 'live_certified' });
        mockPaymentAccount.findOne.mockResolvedValue(account);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn() });
        jest.spyOn(tokenized.client, 'clearTokenCache').mockResolvedValue(undefined);

        await accounts.savePaymentAccount('shop-1', 'user-1', {
            provider: 'bkash', account_type: 'merchant_gateway', is_enabled: true,
            credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', password: 'pw' },
            config: { environment: 'production' },
        });

        expect(account.verification_level).toBe('configured_unverified');
        const reasons = mockPaymentAccountVerification.create.mock.calls.map((c) => c[0].evidence?.reason);
        expect(reasons).toContain('environment_changed');
    });
});

describe('payment-accounts.service — A3/A4 dispatch (services LANDED; R-12 stays inert)', () => {
    // These two pins were written by A5 as "honest 501 while the owner module
    // is absent" (open question in the A5 handoff). A3 (payment-verification
    // .service) and A4 (payment-claim.service) have both landed, so the
    // lazy delegate must dispatch for REAL — keeping the placeholder 501
    // would itself now be dishonest. The migrated intent: dispatch resolves
    // to the owner service, still never implying provider verification.
    test('verify-credentials dispatches to the landed A3 ladder — format verdict, zero provider contact', async () => {
        // Hermetic fixture (F4/M7/M8 describes run before this one and must not
        // leak a different account into the shared PaymentConfig mock).
        mockPaymentAccount.findOne.mockResolvedValue({
            id: 'a-1', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs',
            is_enabled: true, is_preferred: false, verification_level: 'configured_unverified',
            credentials: { ...WALLET_CREDS },
        });
        const res = await accounts.verifyPaymentAccount('shop-1', 'user-1', 'a-1');
        expect(res).toMatchObject({
            status: 'format_validated',
            provider_contact: false,
            automated: false,
            max_level: 'configured_unverified',
        });
    });
    test('createSelfMfsClaim dispatches to the landed A4 claim service — shape validated before any write', async () => {
        await expect(accounts.createSelfMfsClaim('shop-1', 'user-1', {}))
            .rejects.toMatchObject({ code: 'ORDER_ID_REQUIRED', status: 400 });
    });
});
