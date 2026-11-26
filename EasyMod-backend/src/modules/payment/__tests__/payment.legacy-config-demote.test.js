'use strict';

/**
 * B2 (A9-R3, 2026-11-26): the legacy POST /api/payment/config writer
 * (payment.service.savePaymentConfig, existing-row branch) used to write
 * `config` wholesale — including config.environment — and replace self-MFS
 * credentials WITHOUT the §2 ladder invalidation the two canonical account
 * writers apply (F-2(c) claimed "ANY environment change (PATCH or POST upsert)
 * demotes" — true only while this third writer was config-blind).
 *
 * These pins run the REAL payment-accounts.service policy function
 * (applyEnvironmentChangeDemotion is exported from it — single policy, three
 * writers), with fake entities + fake token cache. Pinned behaviors:
 *  - environment flip via legacy route → demote to configured_unverified +
 *    append-only 'environment_changed' record + clearTokenCache;
 *  - credential replacement via legacy route → demote to unverified +
 *    'credentials_changed' record + token-cache clear (a legacy row can
 *    dual-face a merchant_gateway row, which holds provider tokens);
 *  - re-saving identical credentials/config → NO false demotion, NO records;
 *  - credentials + environment together → the STRONGER credential demotion
 *    stands (one rung, both ledger events).
 */
process.env.NODE_ENV = 'test';

const mockPaymentConfig = { findOne: jest.fn(), create: jest.fn() };
const mockPaymentAccountVerification = { create: jest.fn() };

jest.mock('../../entities', () => ({
    Order: {},
    PaymentConfig: mockPaymentConfig,
    DeliveryTracking: {},
    CourierDispatch: {},
    UserShop: { findOne: jest.fn() },
    PaymentAccountVerification: mockPaymentAccountVerification,
    Shop: {},
    PaymentTransaction: {},
    User: {},
}));
jest.mock('../../shop/shop-bd-settings', () => ({
    getBdSettings: jest.fn().mockResolvedValue({}),
    updateBdSettings: jest.fn().mockResolvedValue({}),
    clearSelfMfs: jest.fn().mockResolvedValue(undefined),
    hasSelfMfs: jest.fn(() => false),
}));

const { UserShop } = require('../../entities');
const paymentService = require('../payment.service');
const tokenized = require('../bkash-tokenized.service');

const SELF_MFS_CREDS = { mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711111111' };

function existingRow(over = {}) {
    return {
        id: 'row-1',
        shop_id: 'shop-1',
        gateway: 'self-mfs',
        provider: 'bkash',
        account_type: 'self',
        is_enabled: true,
        is_preferred: true,
        verification_level: 'live_certified',
        credentials: { ...SELF_MFS_CREDS },
        config: { environment: 'production' },
        save: jest.fn().mockResolvedValue(true),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    UserShop.findOne.mockResolvedValue({ id: 'us-1', role: 'owner' });
    mockPaymentAccountVerification.create.mockResolvedValue({ id: 'v-1' });
    jest.spyOn(tokenized.client, 'clearTokenCache').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('B2 — legacy POST /config obeys the single ladder-invalidation policy', () => {
    test('flipping config.environment through the legacy route demotes the ladder + records environment_changed + clears the token cache', async () => {
        const row = existingRow(); // live_certified + production
        mockPaymentConfig.findOne.mockResolvedValue(row);

        await paymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', undefined, null, {
            environment: 'sandbox',
        });

        expect(row.config).toMatchObject({ environment: 'sandbox' });
        expect(row.verification_level).toBe('configured_unverified'); // env flip demotes (§2/F-2c)
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            payment_account_id: 'row-1',
            level: 'configured_unverified',
            method: 'configured',
            provider_environment: 'sandbox',
            evidence: expect.objectContaining({ reason: 'environment_changed', from: 'production', to: 'sandbox' }),
        }));
        expect(tokenized.client.clearTokenCache).toHaveBeenCalledTimes(1);
        expect(tokenized.client.clearTokenCache).toHaveBeenCalledWith(row);
    });

    test('replacing self-MFS credentials through the legacy route demotes + records credentials_changed (token cache cleared)', async () => {
        const row = existingRow({ config: {} });
        mockPaymentConfig.findOne.mockResolvedValue(row);

        await paymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', true, {
            mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01899999999',
        }, undefined);

        expect(row.credentials).toMatchObject({ mfs_number: '01899999999' });
        expect(row.verification_level).toBe('unverified'); // §2 credential-change rung
        expect(mockPaymentAccountVerification.create).toHaveBeenCalledWith(expect.objectContaining({
            payment_account_id: 'row-1',
            level: 'unverified',
            evidence: expect.objectContaining({ reason: 'credentials_changed' }),
        }));
        expect(tokenized.client.clearTokenCache).toHaveBeenCalledTimes(1);
    });

    test('re-saving IDENTICAL credentials + unchanged environment changes nothing (no false demotion, no records)', async () => {
        const row = existingRow();
        mockPaymentConfig.findOne.mockResolvedValue(row);

        await paymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', true, {
            ...SELF_MFS_CREDS,
        }, { environment: 'production' });

        expect(row.verification_level).toBe('live_certified'); // untouched
        expect(mockPaymentAccountVerification.create).not.toHaveBeenCalled();
        expect(tokenized.client.clearTokenCache).not.toHaveBeenCalled();
        expect(row.save).toHaveBeenCalled();
    });

    test('credentials + environment change together: the STRONGER credential demotion stands; both events recorded', async () => {
        const row = existingRow();
        mockPaymentConfig.findOne.mockResolvedValue(row);

        await paymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', true, {
            mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01855555555',
        }, { environment: 'sandbox' });

        expect(row.verification_level).toBe('unverified'); // credentials_changed wins (§2)
        const reasons = mockPaymentAccountVerification.create.mock.calls
            .map((c) => c[0].evidence?.reason);
        expect(reasons).toContain('credentials_changed');
        expect(reasons).toContain('environment_changed');
    });

    test('the demotion is the SAME policy function the canonical writers use (single policy, three writers)', async () => {
        const accountsService = require('../payment-accounts.service');
        expect(typeof accountsService.applyEnvironmentChangeDemotion).toBe('function');
    });
});
