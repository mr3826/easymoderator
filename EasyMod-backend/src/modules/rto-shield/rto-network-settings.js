/**
 * RTO Network (shared fraud-shield) settings helper.
 *
 * Stores per-shop participation/consent for the cross-shop fraud network under
 * shop.settings.rto_network — same pattern as shop.settings.bd (see shop-bd-settings.js).
 *
 * Privacy framing (see acquisition audit + meta-policy): the network shares only a
 * normalized phone number's *delivery outcome history* (a courier-style return record),
 * never message content or other PII. Participation is opt-out per shop:
 *
 * Schema — shop.settings.rto_network:
 * {
 *   contribute: boolean   // this shop's delivery outcomes feed the shared network aggregate
 *   enforce:    boolean   // this shop's order flow honors global/network signals (not just its own list)
 * }
 *
 * Defaults are ON (the network is only useful at scale), but a shop can opt out of either side.
 */

const Shop = require('../shop/shop.entity');
const { AppError } = require('../../utils/AppError');
const { mergeAndSanitizeSettings } = require('../shop/shop-settings.validator');
const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');

const DEFAULT_NETWORK_SETTINGS = {
  contribute: true,
  enforce: true
};

/**
 * Get RTO-network settings for a shop, merged with defaults.
 * @param {string} shopId
 * @returns {Promise<{contribute:boolean, enforce:boolean}>}
 */
const getNetworkSettings = async (shopId, { transaction = null } = {}) => {
  const shop = await Shop.findByPk(shopId, {
    attributes: ['id', 'settings'],
    ...(transaction ? { transaction } : {}),
  });
  if (!shop) throw new AppError('Shop not found', 404);
  return { ...DEFAULT_NETWORK_SETTINGS, ...(shop.settings?.rto_network || {}) };
};

/**
 * Update RTO-network settings (partial; preserves other settings keys).
 * @param {string} shopId
 * @param {{contribute?:boolean, enforce?:boolean}} updates
 * @returns {Promise<{contribute:boolean, enforce:boolean}>}
 */
const updateNetworkSettings = async (shopId, updates, actor = {}) => {
  const clean = {};
  if (typeof updates.contribute === 'boolean') clean.contribute = updates.contribute;
  if (typeof updates.enforce === 'boolean') clean.enforce = updates.enforce;

  const result = await Shop.sequelize.transaction(async (transaction) => {
    const shop = await Shop.findByPk(shopId, {
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!shop) throw new AppError('Shop not found', 404);

    const currentSettings = shop.settings || {};
    const currentNetwork = { ...DEFAULT_NETWORK_SETTINGS, ...(currentSettings.rto_network || {}) };
    const newNetwork = { ...currentNetwork, ...clean };
    const changedFields = Object.keys(clean).filter((key) => currentNetwork[key] !== newNetwork[key]);
    if (changedFields.length) {
      if (!actor.userId) throw new AppError('An authorized actor is required to update network settings', 403);
      await shop.update({
        settings: mergeAndSanitizeSettings(currentSettings, { rto_network: newNetwork })
      }, { transaction });
      await require('../audit/audit.service').logOperation({
        userId: actor.userId,
        shopId,
        action: 'RTO_NETWORK_SETTINGS_UPDATED',
        resourceType: 'shop_settings',
        resourceId: shopId,
        oldValues: { rto_network: currentNetwork },
        newValues: { rto_network: newNetwork },
        metadata: { changedFields },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
      }, { transaction, required: true });
      if (changedFields.includes('contribute')) {
        try {
          await require('./rto-shield.service').refreshNetworkSignalsForShop(shopId, { transaction });
        } catch (_) {
          throw new AppError(
            'Network signals could not be refreshed; consent was not changed',
            503,
            'RTO_SIGNAL_REFRESH_FAILED'
          );
        }
      }
    }
    return {
      settings: newNetwork,
      changed: changedFields.length > 0,
    };
  });

  if (!result.changed) return result.settings;
  await invalidateShopSettingsCaches(shopId);
  return result.settings;
};

module.exports = { getNetworkSettings, updateNetworkSettings, DEFAULT_NETWORK_SETTINGS };
