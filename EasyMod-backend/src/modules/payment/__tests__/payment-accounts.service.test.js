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
const mockUserShop = { findOne: jest.fn() };
const mockShop = {
    sequelize: { transaction: jest.fn((cb) => cb({ LOCK: { UPDATE: 'FOR UPDATE' } })) },
    findByPk: jest.fn(),
};

jest.mock('../../entities', () => ({
    PaymentConfig: mockPaymentAccount,
    PaymentAccountVerification: mockPaymentAccountVerification,
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

describe('payment-accounts.service — A3/A4 dispatch (services LANDED; R-12 stays inert)', () => {
    // These two pins were written by A5 as "honest 501 while the owner module
    // is absent" (open question in the A5 handoff). A3 (payment-verification
    // .service) and A4 (payment-claim.service) have both landed, so the
    // lazy delegate must dispatch for REAL — keeping the placeholder 501
    // would itself now be dishonest. The migrated intent: dispatch resolves
    // to the owner service, still never implying provider verification.
    test('verify-credentials dispatches to the landed A3 ladder — format verdict, zero provider contact', async () => {
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
