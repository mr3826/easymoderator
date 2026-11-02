'use strict';

const mockShopFindByPk = jest.fn();
const mockShopUpdate = jest.fn();
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockShop = {
  findByPk: (...args) => mockShopFindByPk(...args),
  sequelize: { transaction: (callback) => callback(mockTransaction) },
};
const mockDeliveryIntegration = {};

jest.mock('../delivery-integration.entity', () => mockDeliveryIntegration);
jest.mock('../../entities', () => ({ Shop: mockShop }));
jest.mock('../delivery.service', () => ({}));
jest.mock('../providers/provider.registry', () => ({ COURIER_REGISTRY: {} }));
jest.mock('../pickup-location.service', () => ({}));
jest.mock('../courier-readiness.service', () => ({}));
jest.mock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));

const deliveryController = require('../delivery.controller');

describe('delivery settings consent-safe update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShopFindByPk.mockResolvedValue({
      settings: {
        rto_network: { contribute: false, enforce: true },
        delivery: { default_delivery_charge: 60, cod_enabled: false },
      },
      update: mockShopUpdate,
    });
    mockShopUpdate.mockResolvedValue(undefined);
  });

  it('merges delivery preferences under the shop row lock without restoring stale consent', async () => {
    const response = { json: jest.fn() };

    await deliveryController.updateSettings({
      user: { shopId: 'shop-1' },
      body: { default_delivery_charge: 90, cod_enabled: true, rto_network: { contribute: true } },
    }, response, jest.fn());

    expect(mockShopFindByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
      transaction: mockTransaction,
      lock: 'UPDATE',
    }));
    const savedSettings = mockShopUpdate.mock.calls[0][0].settings;
    expect(savedSettings.rto_network).toEqual({ contribute: false, enforce: true });
    expect(savedSettings.delivery).toMatchObject({ default_delivery_charge: 90, cod_enabled: true });
    expect(mockShopUpdate.mock.calls[0][1]).toEqual({ transaction: mockTransaction });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ default_delivery_charge: 90, cod_enabled: true }),
    }));
  });
});
