'use strict';

/**
 * Delivery Settings must publish capability truth alongside connection state:
 * a merchant decides what to trust from this payload, so a provider that has
 * never been exercised live must say so here, not only in a doc comment.
 */

jest.mock('../delivery-integration.entity', () => ({ findAll: jest.fn().mockResolvedValue([]) }));
jest.mock('../../entities', () => ({
  Shop: { findByPk: jest.fn().mockResolvedValue({ settings: {} }) },
}));
jest.mock('../delivery.service', () => ({}));
jest.mock('../providers/provider.registry', () => ({
  COURIER_REGISTRY: {
    pathao: { label: 'Pathao' },
    steadfast: { label: 'Steadfast' },
    redx: { label: 'RedX' },
  },
}));
jest.mock('../pickup-location.service', () => ({ listPickupLocations: jest.fn().mockResolvedValue([]) }));
jest.mock('../courier-readiness.service', () => ({
  getReadiness: jest.fn().mockResolvedValue({ missing: [] }),
}));
jest.mock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));

const deliveryController = require('../delivery.controller');
const { CAPABILITY_LEVELS, CAPABILITY_CEILING } = require('../provider-capabilities');

describe('delivery settings capabilities payload', () => {
  it('serves every provider with capabilities capped at the stated ceiling', async () => {
    const response = { json: jest.fn() };

    await deliveryController.getSettings({ user: { shopId: 'shop-1' } }, response, jest.fn());

    expect(response.json).toHaveBeenCalledTimes(1);
    const payload = response.json.mock.calls[0][0];
    expect(payload.success).toBe(true);

    const ceiling = CAPABILITY_LEVELS.indexOf(CAPABILITY_CEILING);
    for (const provider of payload.data.providers) {
      expect(provider.capabilities).toBeDefined();
      expect(provider.capabilities.ceiling).toBe(CAPABILITY_CEILING);
      expect(provider.capabilities.last_verified_at).toBeNull();
      for (const entry of Object.values(provider.capabilities)) {
        if (!entry || typeof entry.level !== 'string') continue;
        expect(CAPABILITY_LEVELS.indexOf(entry.level)).toBeLessThanOrEqual(ceiling);
      }
    }
    const byProvider = Object.fromEntries(payload.data.providers.map((p) => [p.provider, p]));
    expect(byProvider.steadfast.capabilities.coverage.level).toBe('UNKNOWN');
    expect(byProvider.pathao.capabilities.cancel.level).toBe('UNSUPPORTED');
  });
});