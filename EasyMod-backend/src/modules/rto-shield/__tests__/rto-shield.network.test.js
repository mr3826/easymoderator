'use strict';

/**
 * rto-shield.network.test.js
 *
 * Unit tests for the cross-shop "network" behavior of RtoShieldService:
 *  - getNetworkStats aggregation
 *  - evaluateNetworkPromotion thresholds (promote / hold / refresh)
 *  - checkPhone risk tiers (block / verify / clear), whitelist override, enforce opt-out
 *  - whitelistPhone appeal path
 *
 * The two Sequelize entities are mocked; the real phone validator is used.
 */

const mockBlacklistFindOne = jest.fn();
const mockBlacklistCreate = jest.fn();
const mockBlacklistFindAndCountAll = jest.fn();
const mockStatsFindOne = jest.fn();
const mockStatsFindAll = jest.fn();
const mockStatsFindOrCreate = jest.fn();
const mockShopFindAll = jest.fn();
const mockShopFindByPk = jest.fn();
const mockShopTransaction = jest.fn();
const mockGetNetworkSettings = jest.fn();
const mockShop = {
  findAll: (...args) => mockShopFindAll(...args),
  findByPk: (...args) => mockShopFindByPk(...args),
  sequelize: { transaction: (...args) => mockShopTransaction(...args) },
};

jest.mock('../rto-blacklist.entity', () => ({
  findOne: (...a) => mockBlacklistFindOne(...a),
  create: (...a) => mockBlacklistCreate(...a),
  findAndCountAll: (...a) => mockBlacklistFindAndCountAll(...a)
}));

jest.mock('../customer-delivery-stats.entity', () => ({
  findOne: (...a) => mockStatsFindOne(...a),
  findAll: (...a) => mockStatsFindAll(...a),
  findOrCreate: (...a) => mockStatsFindOrCreate(...a)
}));

jest.mock('../../shop/shop.entity', () => mockShop);
jest.mock('../rto-network-settings', () => ({ getNetworkSettings: (...a) => mockGetNetworkSettings(...a) }));

const RtoShieldService = require('../rto-shield.service');
const { THRESHOLDS, TIERS, WHITELIST_REASON } = RtoShieldService;
const { Op } = require('sequelize');

const PHONE = '01712345678';

beforeEach(() => {
  mockBlacklistFindOne.mockReset();
  mockBlacklistCreate.mockReset();
  mockBlacklistFindAndCountAll.mockReset().mockResolvedValue({ count: 0, rows: [] });
  mockStatsFindOne.mockReset();
  mockStatsFindAll.mockReset().mockResolvedValue([]);
  mockStatsFindOrCreate.mockReset();
  mockShopFindAll.mockReset().mockResolvedValue([]);
  mockShopFindByPk.mockReset().mockResolvedValue({
    id: 'shop-1', settings: { rto_network: { contribute: false, enforce: true } },
  });
  let transactionTail = Promise.resolve();
  mockShopTransaction.mockReset().mockImplementation(async (callback) => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const afterCommit = [];
    try {
      const result = await callback({
        LOCK: { UPDATE: 'UPDATE' },
        afterCommit: (handler) => afterCommit.push(handler),
      });
      for (const handler of afterCommit) await handler();
      return result;
    } finally {
      release();
    }
  });
  mockGetNetworkSettings.mockReset().mockResolvedValue({ contribute: true, enforce: true });
  mockBlacklistCreate.mockImplementation(async (row) => ({ ...row, update: jest.fn() }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const setNetworkRows = (shopStats, shops = shopStats.map(({ shop_id }) => ({ id: shop_id, settings: {} }))) => {
  mockStatsFindAll.mockResolvedValue(shopStats);
  mockShopFindAll.mockResolvedValue(shops);
};

const makeAtomicStats = (deliveryAttempts = 0, rtoCount = 0) => {
  const stats = {
    delivery_attempts: deliveryAttempts,
    rto_count: rtoCount,
    increment: jest.fn(async (increments) => {
      stats.delivery_attempts += increments.delivery_attempts || 0;
      stats.rto_count += increments.rto_count || 0;
      return stats;
    }),
    update: jest.fn(async (updates) => Object.assign(stats, updates)),
    reload: jest.fn(async () => stats),
  };
  return stats;
};

describe('getNetworkStats', () => {
  it('aggregates distinct shops, attempts, rtos and computes rate', async () => {
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 3, rto_count: 2 },
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-3', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-4', delivery_attempts: 3, rto_count: 2 },
    ]);
    const stats = await RtoShieldService.getNetworkStats(PHONE, null, { trustedContext: true });
    expect(stats).toEqual({ shops_reported: 4, total_attempts: 10, total_rtos: 6, rto_rate: 0.6 });
  });

  it('excludes previously recorded outcomes from a shop that opted out', async () => {
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 3, rto_count: 3 },
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 4, rto_count: 4 },
    ], [
      { id: 'shop-1', settings: {} },
      { id: 'shop-2', settings: { rto_network: { contribute: false } } },
      { id: 'shop-3', settings: { rto_network: { contribute: true } } },
    ]);

    const stats = await RtoShieldService.getNetworkStats(PHONE, null, { trustedContext: true });

    expect(stats).toEqual({ shops_reported: 2, total_attempts: 7, total_rtos: 7, rto_rate: 1 });
  });

  it('coalesces duplicate rows per shop without counting the shop twice', async () => {
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-1', delivery_attempts: 3, rto_count: 2 },
      { shop_id: 'shop-2', delivery_attempts: 5, rto_count: 2 },
    ]);

    const stats = await RtoShieldService.getNetworkStats(PHONE, null, { trustedContext: true });

    expect(stats).toEqual({ shops_reported: 2, total_attempts: 10, total_rtos: 5, rto_rate: 0.5 });
  });

  it('returns zeros for an invalid phone without querying', async () => {
    const stats = await RtoShieldService.getNetworkStats('not-a-phone');
    expect(stats).toEqual({ shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 });
    expect(mockStatsFindAll).not.toHaveBeenCalled();
  });

  it('does not aggregate an arbitrary phone without a verified server context', async () => {
    setNetworkRows([{ shop_id: 'shop-2', delivery_attempts: 8, rto_count: 6 }]);

    const stats = await RtoShieldService.getNetworkStats(PHONE, 'shop-1');

    expect(stats).toEqual({ shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 });
    expect(mockStatsFindOne).not.toHaveBeenCalled();
    expect(mockStatsFindAll).not.toHaveBeenCalled();
  });

  it('allows a verified first-order context to use cross-shop history without local stats', async () => {
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 2, rto_count: 1 },
    ]);

    const stats = await RtoShieldService.getNetworkStats(PHONE, 'shop-1', { trustedContext: true });

    expect(stats).toEqual({ shops_reported: 3, total_attempts: 6, total_rtos: 4, rto_rate: 4 / 6 });
    expect(mockStatsFindOne).not.toHaveBeenCalled();
  });
});

describe('evaluateNetworkPromotion', () => {
  it('does NOT promote when too few shops report', async () => {
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 4, rto_count: 3 },
      { shop_id: 'shop-2', delivery_attempts: 4, rto_count: 3 },
    ]);
    mockBlacklistFindOne.mockResolvedValueOnce(null);
    const result = await RtoShieldService.evaluateNetworkPromotion(PHONE);
    expect(result).toBeNull();
    expect(mockBlacklistCreate).not.toHaveBeenCalled();
  });

  it('promotes to a global blacklist entry when cross-shop thresholds are crossed', async () => {
    setNetworkRows(Array.from({ length: THRESHOLDS.NETWORK_MIN_SHOPS }, (_, index) => ({
      shop_id: `shop-${index + 1}`,
      delivery_attempts: index === 0 ? 3 : 1,
      rto_count: index === 0 ? 3 : 1,
    })));
    mockBlacklistFindOne.mockResolvedValueOnce(null); // no existing global entry
    await RtoShieldService.evaluateNetworkPromotion(PHONE);
    expect(mockBlacklistCreate).toHaveBeenCalledTimes(1);
    const created = mockBlacklistCreate.mock.calls[0][0];
    expect(created.is_global).toBe(true);
    expect(created.shop_id).toBeNull();
    expect(created.risk_score).toBeGreaterThanOrEqual(THRESHOLDS.BLOCK_SCORE);
  });

  it('recomputes an existing auto-promoted score from current contributing outcomes', async () => {
    setNetworkRows(Array.from({ length: 5 }, (_, index) => ({
      shop_id: `shop-${index + 1}`,
      delivery_attempts: 2,
      rto_count: index < 3 ? 2 : 0,
    })));
    const update = jest.fn();
    mockBlacklistFindOne.mockResolvedValueOnce({ risk_score: 95, notes: 'Auto-promoted by cross-shop network aggregation', update });
    await RtoShieldService.evaluateNetworkPromotion(PHONE);
    expect(mockBlacklistCreate).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ risk_score: 60 }));
  });

  it('demotes a stale auto-promoted global entry when contributing shops fall below threshold', async () => {
    setNetworkRows([{ shop_id: 'shop-1', delivery_attempts: 1, rto_count: 1 }]);
    const destroy = jest.fn();
    mockBlacklistFindOne.mockResolvedValueOnce({ notes: 'Auto-promoted by cross-shop network aggregation', destroy });

    await RtoShieldService.evaluateNetworkPromotion(PHONE);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not use a stale auto-promoted global entry after opted-out outcomes leave the network threshold', async () => {
    mockBlacklistFindOne
      .mockResolvedValueOnce(null) // whitelist
      .mockResolvedValueOnce({
        is_global: true,
        notes: 'Auto-promoted by cross-shop network aggregation',
        risk_score: 90,
        reason: 'stale shared signal',
        toJSON: () => ({ risk_score: 90 }),
      })
      .mockResolvedValueOnce(null); // no local entry
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([{ shop_id: 'shop-1', delivery_attempts: 2, rto_count: 2 }]);

    const result = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });

    expect(result.flagged).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('uses the lower live aggregate after a post-commit signal refresh fails', async () => {
    const staleGlobal = {
      is_global: true,
      notes: 'Auto-promoted by cross-shop network aggregation',
      risk_score: 95,
      reason: 'stale pre-refresh score',
      toJSON() { return { phone: PHONE, risk_score: this.risk_score, reason: this.reason, is_global: this.is_global }; },
    };
    const failedRefresh = jest.spyOn(RtoShieldService, 'evaluateNetworkPromotion').mockRejectedValueOnce(
      new Error('post-commit refresh unavailable'),
    );

    await RtoShieldService.processDeliveryOutcomeSignals({
      phone: PHONE,
      shopId: 'shop-1',
      isRto: true,
      contributesToNetwork: true,
      attempts: 1,
      rtoCount: 1,
      rtoRate: 1,
    });
    expect(failedRefresh).toHaveBeenCalledWith(PHONE);

    mockBlacklistFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(staleGlobal);
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 4, rto_count: 2 },
      { shop_id: 'shop-2', delivery_attempts: 3, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 3, rto_count: 2 },
    ]);

    const result = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });

    expect(result.risk_score).toBe(60);
    expect(result.entry.risk_score).toBe(60);
    expect(result.entry.reason).toContain('60% of 10 deliveries');
    expect(result.tier).toBe(TIERS.TIER_VERIFY);
    expect(result.flagged).toBe(false);
    expect(failedRefresh).toHaveBeenCalledWith(PHONE);
  });

  it('returns neutral review for a first order with qualifying network history and no local or cached row', async () => {
    const failedRefresh = jest.spyOn(RtoShieldService, 'evaluateNetworkPromotion').mockRejectedValueOnce(
      new Error('post-commit refresh unavailable'),
    );
    await RtoShieldService.processDeliveryOutcomeSignals({
      phone: PHONE,
      shopId: 'shop-1',
      isRto: true,
      contributesToNetwork: true,
      attempts: 1,
      rtoCount: 1,
      rtoRate: 1,
    });

    mockBlacklistFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    setNetworkRows([
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-4', delivery_attempts: 2, rto_count: 1 },
    ]);

    const result = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });

    expect(failedRefresh).toHaveBeenCalledWith(PHONE);
    expect(mockStatsFindOne).not.toHaveBeenCalled();
    expect(mockStatsFindAll).toHaveBeenCalledWith(expect.objectContaining({ where: { phone: PHONE } }));
    expect(mockShopFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { [Op.in]: ['shop-2', 'shop-3', 'shop-4'] } },
    }));
    expect(result).toMatchObject({
      flagged: false,
      reason: 'Elevated cross-shop return history',
      risk_score: 0,
      tier: TIERS.TIER_VERIFY,
      entry: null,
      network: { shops_reported: 3, total_attempts: 6, total_rtos: 4 },
    });
  });
});

describe('trackDeliveryOutcome consent', () => {
  it('keeps opted-out outcomes in local history without evaluating shared network signals', async () => {
    const stats = makeAtomicStats(2, 0);
    mockStatsFindOrCreate.mockResolvedValueOnce([stats]);
    mockShopFindByPk.mockResolvedValueOnce({ id: 'shop-1', settings: { rto_network: { contribute: false, enforce: true } } });
    const evaluate = jest.spyOn(RtoShieldService, 'evaluateNetworkPromotion').mockResolvedValue(null);

    await RtoShieldService.trackDeliveryOutcome(PHONE, 'shop-1', true);

    expect(stats.increment).toHaveBeenCalledWith(
      { delivery_attempts: 1, rto_count: 1 },
      { transaction: expect.any(Object) },
    );
    expect(stats.update).toHaveBeenCalledWith(
      { last_rto_at: expect.any(Date) },
      { transaction: expect.any(Object) },
    );
    expect(stats.delivery_attempts).toBe(3);
    expect(stats.rto_count).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
    evaluate.mockRestore();
  });

  it('does not treat a failed settings read as network contribution consent', async () => {
    mockShopFindByPk.mockRejectedValueOnce(new Error('settings unavailable'));
    const evaluate = jest.spyOn(RtoShieldService, 'evaluateNetworkPromotion').mockResolvedValue(null);

    await expect(RtoShieldService.trackDeliveryOutcome(PHONE, 'shop-1', true))
      .rejects.toThrow('settings unavailable');

    expect(mockStatsFindOrCreate).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    evaluate.mockRestore();
  });

  it('does not lose concurrent same-phone/shop terminal increments', async () => {
    const stats = makeAtomicStats();
    mockShopFindByPk.mockImplementation(async () => ({
      id: 'shop-1', settings: { rto_network: { contribute: false, enforce: true } },
    }));
    let createdStats = null;
    let createdRows = 0;
    mockStatsFindOrCreate.mockImplementation(async () => {
      if (!createdStats) {
        createdStats = stats;
        createdRows += 1;
      }
      return [createdStats];
    });
    const addToBlacklist = jest.spyOn(RtoShieldService, 'addToBlacklist').mockResolvedValue(null);
    const outcomes = [
      true, true, true, false, false, false,
      false, false, false, false, false, false,
    ];

    await Promise.all(outcomes.map((isRto) => RtoShieldService.trackDeliveryOutcome(PHONE, 'shop-1', isRto)));

    expect(stats.delivery_attempts).toBe(outcomes.length);
    expect(stats.rto_count).toBe(outcomes.filter(Boolean).length);
    expect(stats.increment).toHaveBeenCalledTimes(outcomes.length);
    expect(stats.reload).toHaveBeenCalledTimes(outcomes.length);
    expect(createdRows).toBe(1);
    expect(mockShopFindByPk).toHaveBeenCalledTimes(outcomes.length);
    expect(mockShopFindByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
      transaction: expect.any(Object),
      lock: 'UPDATE',
    }));
    expect(mockStatsFindOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      where: { phone: PHONE, shop_id: 'shop-1' },
      transaction: expect.any(Object),
    }));
    addToBlacklist.mockRestore();
  });

  it('coalesces duplicate local rows when recalculating per-shop thresholds', async () => {
    const stats = makeAtomicStats(2, 1);
    mockShopFindByPk.mockResolvedValueOnce({ id: 'shop-1', settings: { rto_network: { contribute: false } } });
    mockStatsFindOrCreate.mockResolvedValueOnce([stats]);
    mockStatsFindAll.mockResolvedValueOnce([
      { delivery_attempts: 3, rto_count: 2 },
      { delivery_attempts: 2, rto_count: 1 },
    ]);

    const result = await RtoShieldService.trackDeliveryOutcome(PHONE, 'shop-1', true);

    expect(result).toMatchObject({ attempts: 5, rtoCount: 3, rtoRate: 0.6 });
  });
});

describe('checkPhone tiers', () => {
  it('returns BLOCK tier for a high-risk blacklist entry', async () => {
    mockBlacklistFindOne
      .mockResolvedValueOnce(null) // whitelist lookup
      .mockResolvedValueOnce({ risk_score: 85, reason: 'fraud', toJSON: () => ({ risk_score: 85 }) }); // entry
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([{ shop_id: 'shop-1', delivery_attempts: 2, rto_count: 2 }]);
    const res = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });
    expect(res.tier).toBe(TIERS.TIER_BLOCK);
    expect(res.flagged).toBe(true);
  });

  it('returns VERIFY tier from a strong network signal with no blacklist entry', async () => {
    mockBlacklistFindOne
      .mockResolvedValueOnce(null) // whitelist
      .mockResolvedValueOnce(null); // no entry
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 2, rto_count: 1 },
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 2, rto_count: 1 },
    ]); // 66%
    const res = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });
    expect(res.tier).toBe(TIERS.TIER_VERIFY);
    expect(res.flagged).toBe(false);
  });

  it('uses the live contributing aggregate score instead of a stale auto-global score', async () => {
    const entry = {
      is_global: true,
      notes: 'Auto-promoted by cross-shop network aggregation',
      risk_score: 95,
      reason: 'stale old score',
      toJSON() { return { risk_score: this.risk_score, reason: this.reason, is_global: this.is_global }; },
    };
    mockBlacklistFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(entry);
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 3, rto_count: 2 },
      { shop_id: 'shop-2', delivery_attempts: 3, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 4, rto_count: 2 },
    ]);

    const result = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });

    expect(result.risk_score).toBe(60);
    expect(result.entry.risk_score).toBe(60);
    expect(result.tier).toBe(TIERS.TIER_VERIFY);
    expect(result.flagged).toBe(false);
  });

  it('returns CLEAR tier for a clean phone', async () => {
    mockBlacklistFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([{ shop_id: 'shop-1', delivery_attempts: 3, rto_count: 0 }]);
    const res = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });
    expect(res.tier).toBe(TIERS.TIER_CLEAR);
  });

  it('honors a per-shop whitelist override (returns clear)', async () => {
    mockBlacklistFindOne.mockResolvedValueOnce({ reason: WHITELIST_REASON }); // whitelist hit
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([
      { shop_id: 'shop-1', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-2', delivery_attempts: 2, rto_count: 2 },
      { shop_id: 'shop-3', delivery_attempts: 2, rto_count: 1 },
    ]);
    const res = await RtoShieldService.checkPhone(PHONE, 'shop-1', { trustedContext: true });
    expect(res.flagged).toBe(false);
    expect(res.tier).toBe(TIERS.TIER_CLEAR);
  });

  it('ignores global/network signals when enforceNetwork is false', async () => {
    mockBlacklistFindOne
      .mockResolvedValueOnce(null) // whitelist
      .mockResolvedValueOnce(null); // own-list entry (global excluded by filter)
    const res = await RtoShieldService.checkPhone(PHONE, 'shop-1', {
      trustedContext: true,
      enforceNetwork: false,
    });
    expect(res.network).toBeNull();
    expect(res.tier).toBe(TIERS.TIER_CLEAR);
    expect(mockStatsFindOne).not.toHaveBeenCalled();
  });

  it('keeps a free-form phone probe local-only without a verified context', async () => {
    mockBlacklistFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    setNetworkRows([{ shop_id: 'shop-2', delivery_attempts: 8, rto_count: 6 }]);

    const result = await RtoShieldService.checkPhone(PHONE, 'shop-1');

    expect(result).toMatchObject({ flagged: false, tier: TIERS.TIER_CLEAR, risk_score: 0, network: null });
    expect(mockBlacklistFindOne).toHaveBeenCalledTimes(2);
    expect(mockBlacklistFindOne.mock.calls[1][0].where.shop_id).toBe('shop-1');
    expect(mockBlacklistFindOne.mock.calls[1][0].where.is_global).toBeUndefined();
    expect(mockStatsFindAll).not.toHaveBeenCalled();
  });
});

describe('addToBlacklist', () => {
  it('ignores a merchant-submitted is_global:true — entry is always tenant-scoped', async () => {
    mockBlacklistFindOne.mockResolvedValueOnce(null); // no existing entry for shop-A
    const created = await RtoShieldService.addToBlacklist({
      phone: PHONE,
      reason: 'shop A says this customer is fraud',
      risk_score: 100,
      is_global: true, // attacker-controlled input from shop A's request body
      shop_id: 'shop-A'
    });
    expect(created.is_global).toBe(false);
    expect(created.shop_id).toBe('shop-A');
  });

  it('requires a shop_id (no path to an unscoped/global write via this method)', async () => {
    await expect(RtoShieldService.addToBlacklist({ phone: PHONE, reason: 'x' }))
      .rejects.toThrow(/shop_id/);
  });

  it("shop A's blacklist entry does not affect shop B's checkPhone result", async () => {
    // Shop A blacklists the phone (attempting is_global:true, which is now ignored).
    mockBlacklistFindOne.mockResolvedValueOnce(null);
    await RtoShieldService.addToBlacklist({
      phone: PHONE, reason: 'fraud', risk_score: 100, is_global: true, shop_id: 'shop-A'
    });
    const shopAEntry = mockBlacklistCreate.mock.calls[0][0];
    expect(shopAEntry.is_global).toBe(false);

    // Shop B checks the same phone. Its blacklist query can only match rows that are
    // either is_global:true or shop_id === 'shop-B' — shop A's row is neither.
    mockBlacklistFindOne.mockReset();
    mockBlacklistFindOne
      .mockResolvedValueOnce(null) // whitelist lookup
      .mockResolvedValueOnce(null); // no entry visible to shop B
    mockStatsFindOne.mockResolvedValueOnce({ id: 'local-record' });
    setNetworkRows([{ shop_id: 'shop-B', delivery_attempts: 1, rto_count: 0 }]);
    const resultForShopB = await RtoShieldService.checkPhone(PHONE, 'shop-B', { trustedContext: true });
    expect(resultForShopB.tier).toBe(TIERS.TIER_CLEAR);
    expect(resultForShopB.flagged).toBe(false);
  });
});

describe('listBlacklist', () => {
  it('filters local and global fixtures so global rows and phones are not listed', async () => {
    const localEntry = { phone: '01711111111', shop_id: 'shop-A', is_global: false };
    const globalEntry = { phone: '01799999999', shop_id: null, is_global: true };
    const databaseRows = [localEntry, globalEntry];
    mockBlacklistFindAndCountAll.mockImplementationOnce(async ({ where }) => {
      const rows = databaseRows.filter((entry) => (
        entry.shop_id === where.shop_id && entry.is_global === where.is_global
      ));
      return { count: rows.length, rows };
    });

    const result = await RtoShieldService.listBlacklist({ shopId: 'shop-A', page: 1, limit: 20 });

    const query = mockBlacklistFindAndCountAll.mock.calls[0][0];
    expect(query.where).toEqual(expect.objectContaining({ shop_id: 'shop-A', is_global: false }));
    expect(result.data).toEqual([localEntry]);
    expect(result.data.some((entry) => entry.is_global)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(globalEntry.phone);
    expect(result.pagination.total).toBe(1);
  });
});

describe('whitelistPhone', () => {
  it('creates a sentinel appeal entry for the shop', async () => {
    mockBlacklistFindOne.mockResolvedValueOnce(null);
    await RtoShieldService.whitelistPhone({ phone: PHONE, shop_id: 'shop-1', added_by: 'user-1' });
    const created = mockBlacklistCreate.mock.calls[0][0];
    expect(created.reason).toBe(WHITELIST_REASON);
    expect(created.risk_score).toBe(0);
    expect(created.shop_id).toBe('shop-1');
  });

  it('throws without a shop_id', async () => {
    await expect(RtoShieldService.whitelistPhone({ phone: PHONE })).rejects.toThrow(/shop_id/);
  });
});
