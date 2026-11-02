'use strict';

const mockCheckPhone = jest.fn();
const mockGetNetworkStats = jest.fn();

jest.mock('../rto-shield.service', () => ({
  checkPhone: (...args) => mockCheckPhone(...args),
  getNetworkStats: (...args) => mockGetNetworkStats(...args),
}));
jest.mock('../rto-network-settings', () => ({ updateNetworkSettings: jest.fn() }));

const controller = require('../rto-shield.controller');

const response = () => ({ json: jest.fn() });

describe('RTO Shield public phone endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckPhone.mockResolvedValue({ flagged: false, tier: 'clear', network: null });
    mockGetNetworkStats.mockResolvedValue({ shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 });
  });

  it('keeps the free-form check route local-only', async () => {
    const res = response();

    await controller.checkPhone({ body: { phone: '01712345678' }, user: { shopId: 'shop-1' } }, res);

    expect(mockCheckPhone).toHaveBeenCalledWith('01712345678', 'shop-1', {
      trustedContext: false,
      enforceNetwork: false,
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { flagged: false, tier: 'clear', network: null },
    });
  });

  it('does not expose cross-shop stats through a free-form network stats route', async () => {
    const res = response();

    await controller.networkStats({ query: { phone: '01712345678' }, user: { shopId: 'shop-1' } }, res);

    expect(mockGetNetworkStats).toHaveBeenCalledWith('01712345678', 'shop-1', { trustedContext: false });
  });
});
