const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const RtoBlacklist = require('./rto-blacklist.entity');
const CustomerDeliveryStats = require('./customer-delivery-stats.entity');
const Shop = require('../shop/shop.entity');
const { normalizePhone, validatePhone } = require('../../utils/validators/phone.validator');

// Per-shop auto-flag threshold: ≥3 attempts AND ≥40% RTO rate (single shop's own list)
const AUTO_FLAG_MIN_ATTEMPTS = 3;
const AUTO_FLAG_RTO_RATE = 0.4;

// Network (cross-shop) auto-promotion threshold. A phone is promoted to a GLOBAL
// fraud signal only when MULTIPLE independent shops have bad outcomes — so no single
// shop can blacklist a customer for everyone. This is what makes the shield a network:
// it gets stronger as more shops join.
const NETWORK_MIN_SHOPS = 3;       // reported by at least this many distinct shops
const NETWORK_MIN_ATTEMPTS = 5;    // across at least this many total delivery attempts
const NETWORK_RTO_RATE = 0.5;      // and at least this aggregate RTO rate
const AUTO_NETWORK_NOTE = 'Auto-promoted by cross-shop network aggregation';

// Risk tiers surfaced to the order flow / inbox.
const TIER_BLOCK = 'block';    // risk_score ≥ 70 → high-risk manual review before booking
const TIER_VERIFY = 'verify';  // 50–69, or a strong network signal → allow but verify manually
const TIER_CLEAR = 'clear';    // safe
const BLOCK_SCORE = 70;
const VERIFY_SCORE = 50;

// Sentinel reason marking a per-shop whitelist (appeal) override.
const WHITELIST_REASON = 'WHITELIST_APPEAL';

// Thin wrapper — shared validator covers +88/88/01 prefix variants
const isValidBdPhone = (phone) => validatePhone(phone, 'BD_MOBILE_STRICT');

/**
 * Map a numeric risk score (and optional network signal) to a tier.
 */
const classifyTier = (riskScore, network) => {
  if (riskScore >= BLOCK_SCORE) return TIER_BLOCK;
  if (riskScore >= VERIFY_SCORE) return TIER_VERIFY;
  // Even with no formal blacklist entry, a strong cross-shop signal warrants manual verification.
  if (network && network.shops_reported >= 2 && network.total_attempts >= NETWORK_MIN_ATTEMPTS
      && network.rto_rate >= NETWORK_RTO_RATE) {
    return TIER_VERIFY;
  }
  return TIER_CLEAR;
};

class RtoShieldService {
  /**
   * Cross-shop ("network") delivery signal for a phone, aggregated over every shop's
   * per-shop CustomerDeliveryStats. This is the network moat: a phone that burns many
   * shops carries a signal none of them could see alone. Requires trustedContext from
   * a server-verified order/customer flow; raw phone endpoints cannot enumerate it.
   * No PII beyond the phone is shared.
   * @param {object} [options]
   * @param {boolean} [options.trustedContext=false]
   * @returns {{ shops_reported:number, total_attempts:number, total_rtos:number, rto_rate:number }}
   */
  static async getNetworkStats(phone, _requestingShopId = null, { transaction = null, trustedContext = false } = {}) {
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidBdPhone(normalized)) {
      return { shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 };
    }

    // Only an order/customer context verified by the server may read the
    // cross-shop aggregate. Local history is not sufficient authorization to
    // turn this endpoint into a phone-enumeration oracle.
    if (!trustedContext) return { shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 };

    const stats = await CustomerDeliveryStats.findAll({
      where: { phone: normalized },
      attributes: ['shop_id', 'delivery_attempts', 'rto_count'],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
    const shopIds = [...new Set(stats.map((row) => row.shop_id).filter(Boolean))];
    if (!shopIds.length) {
      return { shops_reported: 0, total_attempts: 0, total_rtos: 0, rto_rate: 0 };
    }

    const shopRows = await Shop.findAll({
      where: { id: { [Op.in]: shopIds } },
      attributes: ['id', 'settings'],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
    const contributingShopIds = new Set(shopRows.filter((shop) => {
      let settings = shop.settings;
      if (typeof settings === 'string') {
        try { settings = JSON.parse(settings); } catch (_) { return false; }
      }
      return settings?.rto_network?.contribute !== false;
    }).map((shop) => shop.id));

    const contributingStats = stats.filter((row) => contributingShopIds.has(row.shop_id));
    const shops = new Set(contributingStats.map((row) => row.shop_id)).size;
    const attempts = contributingStats.reduce((sum, row) => sum + (parseInt(row.delivery_attempts, 10) || 0), 0);
    const rtos = contributingStats.reduce((sum, row) => sum + (parseInt(row.rto_count, 10) || 0), 0);
    return {
      shops_reported: shops,
      total_attempts: attempts,
      total_rtos: rtos,
      rto_rate: attempts > 0 ? rtos / attempts : 0
    };
  }

  /**
   * Check a phone against the per-shop + global blacklist AND the cross-shop network signal.
   * Backward compatible: still returns { flagged, reason, risk_score, entry }.
   * Adds { tier, network } for the order flow / inbox risk surface.
   *
   * @param {string} phone
   * @param {string} shopId
   * @param {object} [opts]
   * @param {boolean} [opts.trustedContext=false] - server-verified order/customer context
   * @param {boolean} [opts.enforceNetwork=true] - when false, ignore global/network signals
   *        (the shop has opted out of the shared network and relies only on its own list).
  */
  static async checkPhone(phone, shopId, opts = {}) {
    const trustedContext = opts.trustedContext === true;
    const enforceNetwork = trustedContext && opts.enforceNetwork !== false;
    const normalized = normalizePhone(phone);
    const empty = { flagged: false, reason: null, risk_score: 0, tier: TIER_CLEAR, entry: null, network: null };
    if (!normalized || !isValidBdPhone(normalized)) {
      return empty;
    }

    // Appeal/whitelist override: if this shop has explicitly cleared the customer, trust it.
    const whitelisted = await RtoBlacklist.findOne({
      where: { phone: normalized, shop_id: shopId, reason: WHITELIST_REASON }
    });
    if (whitelisted) {
      return {
        ...empty,
        network: enforceNetwork
          ? await RtoShieldService.getNetworkStats(normalized, shopId, { trustedContext: true })
          : null,
      };
    }

    // Blacklist entries: always the shop's own; global only when the shop enforces the network.
    const phoneFilter = enforceNetwork
      ? { [Op.or]: [{ is_global: true }, { shop_id: shopId }] }
      : { shop_id: shopId };

    const entry = await RtoBlacklist.findOne({
      where: { phone: normalized, reason: { [Op.ne]: WHITELIST_REASON }, ...phoneFilter },
      order: [['risk_score', 'DESC']] // Return highest risk entry
    });

    const network = enforceNetwork
      ? await RtoShieldService.getNetworkStats(normalized, shopId, { trustedContext: true })
      : null;
    const networkPromoted = network
      && network.shops_reported >= NETWORK_MIN_SHOPS
      && network.total_attempts >= NETWORK_MIN_ATTEMPTS
      && network.rto_rate >= NETWORK_RTO_RATE;
    if (entry?.is_global && entry.notes === AUTO_NETWORK_NOTE && networkPromoted) {
      const liveRate = Math.min(1, Math.max(0, network.rto_rate));
      entry.risk_score = Math.round(liveRate * 100);
      entry.reason = `Cross-shop return history: ${network.shops_reported} contributing shops, ${Math.round(liveRate * 100)}% of ${network.total_attempts} deliveries`;
    }
    let activeEntry = entry?.is_global && entry.notes === AUTO_NETWORK_NOTE && !networkPromoted ? null : entry;
    if (!activeEntry && entry?.is_global && entry.notes === AUTO_NETWORK_NOTE) {
      activeEntry = await RtoBlacklist.findOne({
        where: { phone: normalized, shop_id: shopId, reason: { [Op.ne]: WHITELIST_REASON } },
        order: [['risk_score', 'DESC']],
      });
    }
    const riskScore = activeEntry ? activeEntry.risk_score : 0;
    const tier = classifyTier(riskScore, network);

    return {
      flagged: riskScore >= BLOCK_SCORE,
      reason: activeEntry ? activeEntry.reason : (tier === TIER_VERIFY ? 'Elevated cross-shop return history' : null),
      risk_score: riskScore,
      tier,
      entry: activeEntry ? activeEntry.toJSON() : null,
      network
    };
  }

  /**
   * Add a phone number to a shop's own blacklist.
   *
   * Always shop-scoped: `is_global` is intentionally not accepted here. A global entry
   * (visible to every tenant and able to block orders platform-wide) is a system-computed
   * signal — the only path to one is automatic cross-shop promotion in
   * evaluateNetworkPromotion(). No merchant-facing caller may set is_global; accepting it
   * from request input let any shop declare a global fraud signal for a phone it doesn't
   * even do business with, and block COD orders for that phone at every other shop.
   */
  static async addToBlacklist({ phone, reason, risk_score = 80, shop_id, added_by, notes }) {
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidBdPhone(normalized)) {
      throw new Error(`Invalid Bangladeshi phone number: ${phone}`);
    }
    if (!shop_id) throw new Error('shop_id is required to add a shop-scoped blacklist entry');

    // Upsert: if phone + shop_id combo exists, update it.
    // Exclude whitelist (appeal) sentinels so an allow-override and a block can coexist.
    const existing = await RtoBlacklist.findOne({
      where: {
        phone: normalized,
        shop_id,
        reason: { [Op.ne]: WHITELIST_REASON }
      }
    });

    if (existing) {
      await existing.update({ reason, risk_score, notes, added_by });
      return existing;
    }

    return await RtoBlacklist.create({
      id: uuidv4(),
      phone: normalized,
      reason,
      risk_score,
      is_global: false,
      shop_id,
      added_by: added_by || null,
      notes: notes || null
    });
  }

  /**
   * Remove an entry from the blacklist.
   * Tenants can only remove their own entries (not global ones).
   */
  static async removeFromBlacklist(id, shopId) {
    const entry = await RtoBlacklist.findOne({ where: { id } });
    if (!entry) throw new Error('Blacklist entry not found');
    if (entry.is_global) throw new Error('Cannot delete a global blacklist entry via shop API');
    if (entry.shop_id !== shopId) throw new Error('Access denied: entry belongs to a different shop');
    await entry.destroy();
    return { success: true, id };
  }

  /**
   * List only this shop's entries. Shared global signals are for contextual
   * order checks, not a tenant-enumerable list of other customers' phones.
   */
  static async listBlacklist({ shopId, page = 1, limit = 20, search }) {
    const offset = (page - 1) * limit;
    const where = {
      reason: { [Op.ne]: WHITELIST_REASON }, // hide appeal/whitelist sentinels from the blacklist view
      shop_id: shopId,
      is_global: false,
    };

    if (search) {
      where[Op.and] = [{
        [Op.or]: [
          { phone: { [Op.like]: `%${search}%` } },
          { reason: { [Op.like]: `%${search}%` } }
        ]
      }];
    }

    const { count, rows } = await RtoBlacklist.findAndCountAll({
      where,
      order: [['risk_score', 'DESC'], ['created_at', 'DESC']],
      limit,
      offset
    });

    return {
      data: rows,
      pagination: { total: count, page, limit, total_pages: Math.ceil(count / limit) }
    };
  }

  /** Persist local outcome counters under the shop lock and caller transaction. */
  static async recordLocalDeliveryOutcome(phone, shopId, isRto, { transaction } = {}) {
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidBdPhone(normalized)) return;
    if (!transaction) throw new Error('A transaction is required to record a delivery outcome');

    // The shop row serializes first-row creation for this tenant. The active
    // schema has no unique (phone, shop_id) index, so findOrCreate alone is not
    // sufficient when separate orders finish concurrently.
    const shop = await Shop.findByPk(shopId, {
      attributes: ['id', 'settings'],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!shop) throw new AppError('Shop not found', 404);
    let settings = shop.settings;
    if (typeof settings === 'string') {
      try { settings = JSON.parse(settings); } catch (_) { settings = null; }
    }
    const contributesToNetwork = settings?.rto_network?.contribute !== false;

    const [stats] = await CustomerDeliveryStats.findOrCreate({
      where: { phone: normalized, shop_id: shopId },
      defaults: { id: uuidv4(), phone: normalized, shop_id: shopId },
      transaction,
    });

    const increments = { delivery_attempts: 1 };
    if (isRto) increments.rto_count = 1;
    await stats.increment(increments, { transaction });
    await stats.update(isRto ? { last_rto_at: new Date() } : { last_delivered_at: new Date() }, { transaction });
    await stats.reload({ transaction });

    const localRows = await CustomerDeliveryStats.findAll({
      where: { phone: normalized, shop_id: shopId },
      attributes: ['delivery_attempts', 'rto_count'],
      raw: true,
      transaction,
    });
    const newAttempts = localRows.reduce((sum, row) => sum + (parseInt(row.delivery_attempts, 10) || 0), 0);
    const newRtoCount = localRows.reduce((sum, row) => sum + (parseInt(row.rto_count, 10) || 0), 0);

    return {
      phone: normalized,
      shopId,
      isRto,
      contributesToNetwork,
      attempts: newAttempts,
      rtoCount: newRtoCount,
      rtoRate: newAttempts > 0 ? newRtoCount / newAttempts : 0,
    };
  }

  static async processDeliveryOutcomeSignals(result) {
    if (!result) return;
    const { phone, shopId, isRto, contributesToNetwork, attempts, rtoCount, rtoRate } = result;
    try {
      if (attempts >= AUTO_FLAG_MIN_ATTEMPTS && rtoRate >= AUTO_FLAG_RTO_RATE) {
        await RtoShieldService.addToBlacklist({
          phone,
          reason: `Auto-flagged: ${rtoCount} RTOs out of ${attempts} deliveries`,
          risk_score: Math.min(100, Math.round(rtoRate * 100)),
          shop_id: shopId,
        });
      }

      // Keep the shop's own history, but only opted-in shops feed network signals.
      if (isRto && contributesToNetwork) {
      try {
        require('../analytics/funnel-events.service')
          .recordInternalFunnelEvent({
            event: 'first_rto_flag',
            shopId,
            onceKey: shopId,
            oncePerEntity: true,
            metadata: {
              delivery_attempts: attempts,
              rto_count: rtoCount,
              risk_score: Math.min(100, Math.round(rtoRate * 100)),
            },
          })
          .catch(() => {});
        } catch (_) { /* funnel logging must never block RTO tracking */ }
      }
      if (contributesToNetwork) await RtoShieldService.evaluateNetworkPromotion(phone);
    } catch (_) {
      // Local counters are already committed atomically with the delivery
      // transition. A signal refresh failure cannot lose or duplicate outcome data.
    }
  }

  /**
   * Record a final delivery outcome. When called by the delivery transition,
   * local stats share its transaction; duplicate terminal webhooks cannot retry
   * or double-apply the same outcome. Failed delivery attempts never call this.
   */
  static async trackDeliveryOutcome(phone, shopId, isRto, { transaction = null } = {}) {
    const database = Shop.sequelize || CustomerDeliveryStats.sequelize;
    if (!transaction && (!database || typeof database.transaction !== 'function')) {
      throw new Error('A database transaction is required to record a delivery outcome');
    }
    const result = transaction
      ? await RtoShieldService.recordLocalDeliveryOutcome(phone, shopId, isRto, { transaction })
      : await database.transaction((ownedTransaction) => (
        RtoShieldService.recordLocalDeliveryOutcome(phone, shopId, isRto, { transaction: ownedTransaction })
      ));

    if (transaction?.afterCommit) {
      transaction.afterCommit(() => RtoShieldService.processDeliveryOutcomeSignals(result));
    } else if (!transaction) {
      await RtoShieldService.processDeliveryOutcomeSignals(result);
    }
    return result;
  }

  /**
   * Evaluate the cross-shop aggregate for a phone and, when it clears the network
   * thresholds (≥N distinct shops, ≥M attempts, ≥rate), promote it to a GLOBAL fraud
   * signal visible to every shop. Idempotent: re-runs only refresh the existing global entry.
   */
  static async evaluateNetworkPromotion(phone, { transaction = null } = {}) {
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidBdPhone(normalized)) return null;

    const network = await RtoShieldService.getNetworkStats(normalized, null, { transaction, trustedContext: true });
    const existingGlobal = await RtoBlacklist.findOne({
      where: { phone: normalized, is_global: true },
      ...(transaction ? { transaction } : {}),
    });
    const qualifies = network.shops_reported >= NETWORK_MIN_SHOPS
      && network.total_attempts >= NETWORK_MIN_ATTEMPTS
      && network.rto_rate >= NETWORK_RTO_RATE;
    if (!qualifies) {
      if (existingGlobal?.notes === AUTO_NETWORK_NOTE) {
        if (transaction) await existingGlobal.destroy({ transaction });
        else await existingGlobal.destroy();
      }
      return null;
    }

    const riskScore = Math.min(100, Math.round(network.rto_rate * 100));
    const reason = `Network fraud signal: ${network.total_rtos} RTOs / ${network.total_attempts} deliveries across ${network.shops_reported} shops`;

    if (existingGlobal) {
      const nextRiskScore = existingGlobal.notes === AUTO_NETWORK_NOTE
        ? riskScore
        : Math.max(existingGlobal.risk_score, riskScore);
      if (transaction) await existingGlobal.update({ reason, risk_score: nextRiskScore }, { transaction });
      else await existingGlobal.update({ reason, risk_score: nextRiskScore });
      return existingGlobal;
    }

    const values = {
      id: uuidv4(),
      phone: normalized,
      reason,
      risk_score: riskScore,
      is_global: true,
      shop_id: null,
      added_by: null,
      notes: AUTO_NETWORK_NOTE
    };
    return transaction ? RtoBlacklist.create(values, { transaction }) : RtoBlacklist.create(values);
  }

  static async refreshNetworkSignalsForShop(shopId, { transaction = null } = {}) {
    const rows = await CustomerDeliveryStats.findAll({
      where: { shop_id: shopId },
      attributes: ['phone'],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
    const phones = [...new Set(rows.map((row) => normalizePhone(row.phone)).filter(Boolean))];
    const failures = [];
    for (const phone of phones) {
      try {
        await RtoShieldService.evaluateNetworkPromotion(phone, { transaction });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
    return { evaluated: phones.length };
  }

  /**
   * Appeal / whitelist path: a shop vouches for a customer, overriding blacklist + network
   * signals for that shop only. Global entries remain (other shops still see the signal),
   * but this shop's order flow will treat the customer as clear. Upserts a sentinel entry.
   */
  static async whitelistPhone({ phone, shop_id, added_by, notes }) {
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidBdPhone(normalized)) {
      throw new Error(`Invalid Bangladeshi phone number: ${phone}`);
    }
    if (!shop_id) throw new Error('shop_id is required to whitelist a customer');

    const existing = await RtoBlacklist.findOne({
      where: { phone: normalized, shop_id, reason: WHITELIST_REASON }
    });
    if (existing) {
      await existing.update({ notes: notes || existing.notes, added_by });
      return existing;
    }

    return RtoBlacklist.create({
      id: uuidv4(),
      phone: normalized,
      reason: WHITELIST_REASON,
      risk_score: 0,
      is_global: false,
      shop_id,
      added_by: added_by || null,
      notes: notes || 'Shop vouched for this customer (appeal)'
    });
  }

  /**
   * Bulk import phone numbers to the blacklist.
   */
  static async bulkImport(entries, shopId, addedBy) {
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const entry of entries) {
      try {
        await RtoShieldService.addToBlacklist({
          ...entry,
          shop_id: shopId,
          added_by: addedBy
        });
        imported++;
      } catch (err) {
        skipped++;
        errors.push({ phone: entry.phone, error: err.message });
      }
    }

    return { imported, skipped, errors };
  }
}

module.exports = RtoShieldService;
module.exports.THRESHOLDS = {
  AUTO_FLAG_MIN_ATTEMPTS,
  AUTO_FLAG_RTO_RATE,
  NETWORK_MIN_SHOPS,
  NETWORK_MIN_ATTEMPTS,
  NETWORK_RTO_RATE,
  BLOCK_SCORE,
  VERIFY_SCORE
};
module.exports.TIERS = { TIER_BLOCK, TIER_VERIFY, TIER_CLEAR };
module.exports.WHITELIST_REASON = WHITELIST_REASON;
