'use strict';

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockShopTransaction = jest.fn((callback) => callback(mockTransaction));
const mockInvalidateShopSettingsCaches = jest.fn().mockResolvedValue(undefined);

jest.mock('../shop.entity', () => ({
    findByPk: jest.fn(),
    sequelize: { transaction: (...args) => mockShopTransaction(...args) },
}));
jest.mock('../../../utils/shop-settings-cache', () => ({
    invalidateShopSettingsCaches: (...args) => mockInvalidateShopSettingsCaches(...args),
}));

const Shop = require('../shop.entity');
const { getBdSettings, updateBdSettings } = require('../shop-bd-settings');

beforeEach(() => {
    jest.clearAllMocks();
});

test('reads the default-exported Shop model and merges the shop BD settings', async () => {
    Shop.findByPk.mockResolvedValue({
        settings: {
            bd: {
                mfs_mode: 'self',
                mfs_type: 'bkash',
                mfs_number: '01711111111',
                google_sheet_range: 'Inventory!A:F',
            },
        },
    });

    const settings = await getBdSettings('shop-e2e-id');

    expect(Shop.findByPk).toHaveBeenCalledWith('shop-e2e-id', {
        attributes: ['id', 'settings'],
    });
    expect(settings).toMatchObject({
        mfs_mode: 'self',
        mfs_type: 'bkash',
        mfs_number: '01711111111',
        google_sheet_range: 'Inventory!A:F',
        google_sheet_id: null,
    });
});

test('returns safe BD defaults when the shop does not exist', async () => {
    Shop.findByPk.mockResolvedValue(null);

    await expect(getBdSettings('missing-shop')).resolves.toMatchObject({
        mfs_mode: null,
        mfs_type: null,
        mfs_number: null,
        google_sheet_id: null,
        google_sheet_range: 'Sheet1!A:Z',
    });
});

test('updateBdSettings preserves an opted-out network consent under the shop row lock', async () => {
    const shop = {
        settings: {
            rto_network: { contribute: false, enforce: true },
            bd: { mfs_mode: 'self', mfs_type: 'bkash', mfs_number: '01711111111' },
        },
        update: jest.fn().mockResolvedValue(undefined),
    };
    Shop.findByPk.mockResolvedValueOnce(shop);

    await updateBdSettings('shop-e2e-id', { google_sheet_range: 'Inventory!A:F' });

    expect(Shop.findByPk).toHaveBeenCalledWith('shop-e2e-id', expect.objectContaining({
        transaction: mockTransaction,
        lock: 'UPDATE',
    }));
    expect(shop.update).toHaveBeenCalledWith({
        settings: expect.objectContaining({
            rto_network: { contribute: false, enforce: true },
            bd: expect.objectContaining({ google_sheet_range: 'Inventory!A:F' }),
        }),
    }, { transaction: mockTransaction });
    expect(mockInvalidateShopSettingsCaches).toHaveBeenCalledWith('shop-e2e-id');
});
