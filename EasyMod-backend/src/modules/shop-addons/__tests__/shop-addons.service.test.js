'use strict';

const mockShopAddon = { findOne: jest.fn(), findAll: jest.fn(), upsert: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockGetPilotFeatures = jest.fn();
jest.mock('../../entities', () => ({ ShopAddon: mockShopAddon, UserShop: mockUserShop }));
jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: mockGetPilotFeatures,
    getPilotFeaturesStrict: mockGetPilotFeatures,
}));

const pilotFeatures = require('../../pilot-features/pilot-features.service');
const service = require('../shop-addons.service');

beforeEach(() => {
    jest.clearAllMocks();
    pilotFeatures.getPilotFeatures.mockResolvedValue({
        adsStudio: false,
        storefront: false,
        aiReplyShadowMeter: false,
    });
});

describe('assertAddonEnabled', () => {
    test('requires both platform eligibility and merchant opt-in for Ads Studio', async () => {
        pilotFeatures.getPilotFeatures.mockResolvedValue({ adsStudio: true });
        mockShopAddon.findOne.mockResolvedValue({ enabled: true });

        await expect(service.assertAddonEnabled('shop-1', 'ADS_STUDIO')).resolves.toBe(true);
        expect(mockShopAddon.findOne).toHaveBeenCalledWith({
            where: { shop_id: 'shop-1', addon_code: 'ADS_STUDIO' },
        });
    });

    test('fails closed before reading a merchant selection when the platform gate is off', async () => {
        await expect(service.assertAddonEnabled('shop-1', 'STOREFRONT'))
            .rejects.toMatchObject({ status: 404, code: 'ADDON_NOT_AVAILABLE' });
        expect(mockShopAddon.findOne).not.toHaveBeenCalled();
    });

    test('fails closed when an eligible shop has not selected the add-on', async () => {
        pilotFeatures.getPilotFeatures.mockResolvedValue({ storefront: true });
        mockShopAddon.findOne.mockResolvedValue({ enabled: false });

        await expect(service.assertAddonEnabled('shop-1', 'STOREFRONT'))
            .rejects.toMatchObject({ status: 404, code: 'ADDON_NOT_AVAILABLE' });
    });

    test('treats an unavailable gate record as unavailable rather than granting access', async () => {
        pilotFeatures.getPilotFeatures.mockResolvedValue({ adsStudio: true });
        mockShopAddon.findOne.mockRejectedValue(new Error('database unavailable'));

        await expect(service.assertAddonEnabled('shop-1', 'ADS_STUDIO'))
            .rejects.toMatchObject({ status: 503, code: 'ADDON_GATE_UNAVAILABLE' });
    });

    test('keeps the internal shadow meter separate from the two commercial add-ons', async () => {
        pilotFeatures.getPilotFeatures.mockResolvedValue({ aiReplyShadowMeter: true });

        await expect(service.assertAddonEnabled('shop-1', 'AI_REPLY_METER')).resolves.toBe(true);
        expect(mockShopAddon.findOne).not.toHaveBeenCalled();
        expect(service.ADDON_CODES).toEqual(['ADS_STUDIO', 'STOREFRONT']);
    });
});

describe('shop add-on selection', () => {
    test('returns only the two optional add-ons with platform eligibility and shop selection', async () => {
        mockUserShop.findOne.mockResolvedValue({ role: 'owner' });
        pilotFeatures.getPilotFeatures.mockResolvedValue({ adsStudio: true, storefront: false });
        mockShopAddon.findAll.mockResolvedValue([
            { addon_code: 'ADS_STUDIO', enabled: true, enabled_at: new Date('2026-11-01T00:00:00Z') },
        ]);

        const result = await service.getShopAddonState('user-1', 'shop-1');

        expect(result.addons.map(({ code }) => code)).toEqual(['ADS_STUDIO', 'STOREFRONT']);
        expect(result.addons.map(({ eligible, enabled }) => ({ eligible, enabled }))).toEqual([
            { eligible: true, enabled: true },
            { eligible: false, enabled: false },
        ]);
    });

    test('denies a staff member from enabling an add-on even when the shop is eligible', async () => {
        mockUserShop.findOne.mockResolvedValue({ role: 'staff' });
        mockShopAddon.findOne.mockResolvedValue(null);

        await expect(service.setShopAddonEnabled({
            userId: 'staff-1', shopId: 'shop-1', addonCode: 'ADS_STUDIO', enabled: true,
        })).rejects.toMatchObject({ status: 403, code: 'SHOP_ROLE_DENIED' });
        expect(mockShopAddon.upsert).not.toHaveBeenCalled();
    });

    test('requires platform eligibility before an owner can opt in', async () => {
        mockUserShop.findOne.mockResolvedValue({ role: 'owner' });
        mockShopAddon.findOne.mockResolvedValue(null);

        await expect(service.setShopAddonEnabled({
            userId: 'owner-1', shopId: 'shop-1', addonCode: 'ADS_STUDIO', enabled: true,
        })).rejects.toMatchObject({ status: 403, code: 'ADDON_NOT_ELIGIBLE' });
        expect(mockShopAddon.upsert).not.toHaveBeenCalled();
    });

    test('records an eligible owner opt-in idempotently', async () => {
        mockUserShop.findOne.mockResolvedValue({ role: 'owner' });
        mockShopAddon.findOne.mockResolvedValue(null);
        pilotFeatures.getPilotFeatures.mockResolvedValue({ storefront: true });
        mockShopAddon.upsert.mockResolvedValue(undefined);

        const result = await service.setShopAddonEnabled({
            userId: 'owner-1', shopId: 'shop-1', addonCode: 'STOREFRONT', enabled: true,
        });

        expect(mockShopAddon.upsert).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: 'shop-1', addon_code: 'STOREFRONT', enabled: true, enabled_by: 'owner-1',
        }), expect.objectContaining({ conflictFields: ['shop_id', 'addon_code'] }));
        expect(result.previous.enabled).toBe(false);
        expect(result.current.enabled).toBe(true);
    });

    test('does not reset activation time or write again on an unchanged selection', async () => {
        const enabledAt = new Date('2026-11-01T00:00:00Z');
        mockUserShop.findOne.mockResolvedValue({ role: 'admin' });
        mockShopAddon.findOne.mockResolvedValue({ enabled: true, enabled_at: enabledAt });

        const result = await service.setShopAddonEnabled({
            userId: 'admin-1', shopId: 'shop-1', addonCode: 'STOREFRONT', enabled: true,
        });

        expect(mockShopAddon.upsert).not.toHaveBeenCalled();
        expect(result.current.enabled_at).toBe(enabledAt);
    });
});
