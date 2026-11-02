'use strict';

const mockShopUpdate = jest.fn();
const mockShopFindByPk = jest.fn();
const mockAuditLogOperation = jest.fn();
const mockRefreshNetworkSignalsForShop = jest.fn();
const mockInvalidateSettings = jest.fn();
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };
const mockShop = {
  findByPk: (...args) => mockShopFindByPk(...args),
  sequelize: {
    transaction: async (callback) => {
      try {
        const result = await callback(mockTransaction);
        await mockTransaction.commit();
        return result;
      } catch (error) {
        await mockTransaction.rollback();
        throw error;
      }
    },
  },
};

jest.mock('../../shop/shop.entity', () => mockShop);
jest.mock('../../audit/audit.service', () => ({ logOperation: (...args) => mockAuditLogOperation(...args) }));
jest.mock('../../shop/shop-settings.validator', () => ({
  mergeAndSanitizeSettings: (current, update) => ({ ...current, ...update }),
}));
jest.mock('../../../utils/shop-settings-cache', () => ({
  invalidateShopSettingsCaches: (...args) => mockInvalidateSettings(...args),
}));
jest.mock('../rto-shield.service', () => ({
  refreshNetworkSignalsForShop: (...args) => mockRefreshNetworkSignalsForShop(...args),
}));

const { getNetworkSettings, updateNetworkSettings } = require('../rto-network-settings');

describe('RTO network consent settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.commit.mockClear();
    mockTransaction.rollback.mockClear();
    mockShopFindByPk.mockResolvedValue({
      settings: { locale: 'bn', rto_network: { contribute: true, enforce: true } },
      update: mockShopUpdate,
    });
    mockShopUpdate.mockResolvedValue(undefined);
    mockAuditLogOperation.mockResolvedValue(undefined);
    mockInvalidateSettings.mockResolvedValue(undefined);
    mockRefreshNetworkSignalsForShop.mockResolvedValue({ evaluated: 0 });
  });

  it('does not translate a settings read failure or missing shop into enabled consent', async () => {
    mockShopFindByPk.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(getNetworkSettings('shop-1')).rejects.toThrow('database unavailable');

    mockShopFindByPk.mockResolvedValueOnce(null);
    await expect(getNetworkSettings('missing-shop')).rejects.toMatchObject({ status: 404 });
  });

  it('audits a consent change in the same transaction and refreshes the affected network signals', async () => {
    const settings = await updateNetworkSettings('shop-1', { contribute: false }, {
      userId: 'owner-1',
      ipAddress: '192.0.2.10',
      userAgent: 'orders-test',
    });

    expect(settings).toEqual({ contribute: false, enforce: true });
    expect(mockShopFindByPk).toHaveBeenCalledWith('shop-1', {
      transaction: mockTransaction,
      lock: 'UPDATE',
    });
    expect(mockShopUpdate).toHaveBeenCalledWith({
      settings: { locale: 'bn', rto_network: { contribute: false, enforce: true } },
    }, { transaction: mockTransaction });
    expect(mockAuditLogOperation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      shopId: 'shop-1',
      action: 'RTO_NETWORK_SETTINGS_UPDATED',
      oldValues: { rto_network: { contribute: true, enforce: true } },
      newValues: { rto_network: { contribute: false, enforce: true } },
      metadata: { changedFields: ['contribute'] },
    }), { transaction: mockTransaction, required: true });
    expect(mockInvalidateSettings).toHaveBeenCalledWith('shop-1');
    expect(mockRefreshNetworkSignalsForShop).toHaveBeenCalledWith('shop-1', { transaction: mockTransaction });
    expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
  });

  it('does not persist a consent change when its required audit fails', async () => {
    mockAuditLogOperation.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(updateNetworkSettings('shop-1', { contribute: false }, { userId: 'owner-1' }))
      .rejects.toThrow('audit unavailable');
    expect(mockShopUpdate).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSettings).not.toHaveBeenCalled();
    expect(mockRefreshNetworkSignalsForShop).not.toHaveBeenCalled();
    expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back opt-out when all affected global signals cannot be refreshed', async () => {
    mockRefreshNetworkSignalsForShop.mockRejectedValueOnce(new Error('global signal write failed'));

    await expect(updateNetworkSettings('shop-1', { contribute: false }, { userId: 'owner-1' }))
      .rejects.toMatchObject({ status: 503, code: 'RTO_SIGNAL_REFRESH_FAILED' });
    expect(mockShopUpdate).toHaveBeenCalledTimes(1);
    expect(mockRefreshNetworkSignalsForShop).toHaveBeenCalledWith('shop-1', { transaction: mockTransaction });
    expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(mockTransaction.commit).not.toHaveBeenCalled();
    expect(mockInvalidateSettings).not.toHaveBeenCalled();
  });

  it('requires an actor for a real consent change', async () => {
    await expect(updateNetworkSettings('shop-1', { enforce: false }))
      .rejects.toMatchObject({ status: 403 });
    expect(mockShopUpdate).not.toHaveBeenCalled();
    expect(mockAuditLogOperation).not.toHaveBeenCalled();
  });
});
