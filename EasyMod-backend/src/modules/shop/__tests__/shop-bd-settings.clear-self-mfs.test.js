'use strict';

/**
 * Pilot+ P0-3: clearSelfMfs() — authoritative removal of personal MFS
 * payment truth from shop.settings.bd (used when the merchant disables or
 * deletes the self-mfs PaymentConfig).
 */

process.env.NODE_ENV = 'test';

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
jest.mock('../../shop/shop.entity', () => ({
    findByPk: jest.fn(),
    sequelize: { transaction: (callback) => callback(mockTransaction) },
}));
jest.mock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn().mockResolvedValue(undefined) }));

const Shop = require('../../shop/shop.entity');
const { clearSelfMfs } = require('../../shop/shop-bd-settings');
const { invalidateShopSettingsCaches } = require('../../../utils/shop-settings-cache');

beforeEach(() => jest.clearAllMocks());

test('nulls mfs fields, preserves unrelated bd settings (google sheet)', async () => {
    const shop = {
        id: 'shop-1',
        settings: {
            bd: { mfs_mode: 'self', mfs_type: 'bkash', mfs_number: '01711111111', google_sheet_id: 'sheet-9', google_sheet_range: 'S!A:Z' },
            ai: { reply_mode: 'MANUAL' },
        },
        update: jest.fn().mockResolvedValue(undefined),
    };
    Shop.findByPk.mockResolvedValue(shop);

    await clearSelfMfs('shop-1');

    expect(shop.update).toHaveBeenCalledTimes(1);
    const saved = shop.update.mock.calls[0][0].settings;
    expect(shop.update.mock.calls[0][1]).toEqual({ transaction: mockTransaction });
    expect(Shop.findByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
        transaction: mockTransaction,
        lock: 'UPDATE',
    }));
    expect(saved.bd.mfs_mode).toBeNull();
    expect(saved.bd.mfs_type).toBeNull();
    expect(saved.bd.mfs_number).toBeNull();
    expect(saved.bd.google_sheet_id).toBe('sheet-9');
    expect(saved.ai).toEqual({ reply_mode: 'MANUAL' });
    expect(invalidateShopSettingsCaches).toHaveBeenCalledWith('shop-1');
});

test('missing shop is a silent no-op', async () => {
    Shop.findByPk.mockResolvedValue(null);
    await expect(clearSelfMfs('nope')).resolves.toBeNull();
});

test('shop without bd settings needs no write', async () => {
    const shop = { id: 'shop-2', settings: { ai: {} }, update: jest.fn() };
    Shop.findByPk.mockResolvedValue(shop);

    await clearSelfMfs('shop-2');

    expect(shop.update).not.toHaveBeenCalled();
});
