'use strict';

const mockShopFindByPk = jest.fn();
const mockDeliveryFindAll = jest.fn();
const mockSetupStatus = {
  getSetupStatus: jest.fn(),
  toLegacyOnboardingStatus: jest.fn(),
};
const mockInvalidateShopSettingsCaches = jest.fn().mockResolvedValue(undefined);
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockShopModel = {
  findByPk: (...args) => mockShopFindByPk(...args),
  sequelize: { transaction: (callback) => callback(mockTransaction) },
};
const mockDeliveryIntegration = { findAll: (...args) => mockDeliveryFindAll(...args) };

jest.mock('../../entities', () => ({ Shop: mockShopModel, DeliveryIntegration: mockDeliveryIntegration }));
jest.mock('../shop.service', () => new Proxy({}, { get: () => jest.fn() }));
jest.mock('../shop-bd-settings', () => ({ getBdSettings: jest.fn(), updateBdSettings: jest.fn() }));
jest.mock('../../setup/setup-status.service', () => mockSetupStatus);
jest.mock('../../knowledge/knowledge.service', () => ({}));
jest.mock('express-validator', () => ({ validationResult: () => ({ isEmpty: () => true, array: () => [] }) }));
jest.mock('../../../utils/shop-settings-cache', () => ({
  invalidateShopSettingsCaches: (...args) => mockInvalidateShopSettingsCaches(...args),
}));

const shopController = require('../shop.controller');

describe('shop controller settings writers preserve RTO consent', () => {
  let shop;

  beforeEach(() => {
    jest.clearAllMocks();
    shop = {
      settings: {
        rto_network: { contribute: false, enforce: true },
        onboarding_completed: false,
        businessInfo: { shopName: 'Shop One' },
      },
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockShopFindByPk.mockResolvedValue(shop);
    mockDeliveryFindAll.mockResolvedValue([{ provider: 'pathao' }]);
    mockSetupStatus.getSetupStatus.mockResolvedValue({ can_complete: true, missing: [] });
    mockSetupStatus.toLegacyOnboardingStatus.mockReturnValue({ can_complete: true });
    mockInvalidateShopSettingsCaches.mockResolvedValue(undefined);
  });

  it('preserves opt-out when completing onboarding under the shop row lock', async () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await shopController.completeOnboarding({ user: { shopId: 'shop-1', userId: 'owner-1' } }, response, jest.fn());

    expect(mockShopFindByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
      transaction: mockTransaction,
      lock: 'UPDATE',
    }));
    expect(shop.update).toHaveBeenCalledWith({ settings: expect.objectContaining({
      rto_network: { contribute: false, enforce: true },
      onboarding_completed: true,
    }) }, { transaction: mockTransaction });
    expect(mockInvalidateShopSettingsCaches).toHaveBeenCalledWith('shop-1');
  });

  it('preserves opt-out when updating platform priorities under the shop row lock', async () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await shopController.updatePlatformPriority({
      user: { shopId: 'shop-1' },
      body: { payment: ['bkash'], delivery: ['pathao'] },
    }, response, jest.fn());

    expect(mockShopFindByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
      transaction: mockTransaction,
      lock: 'UPDATE',
    }));
    expect(shop.update).toHaveBeenCalledWith({ settings: expect.objectContaining({
      rto_network: { contribute: false, enforce: true },
      payment_platform_priority: ['bkash'],
      delivery_platform_priority: ['pathao'],
    }) }, { transaction: mockTransaction });
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      data: { payment: ['bkash'], delivery: ['pathao'] },
    });
  });
});
