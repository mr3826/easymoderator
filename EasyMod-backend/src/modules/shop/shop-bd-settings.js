/**
 * BD (Bangladesh) Shop Settings Helper
 *
 * Reads/writes Bangladesh-specific settings from shop.settings.bd.
 * Follows the same pattern as settings.ai (see shop.service.js).
 *
 * Schema — shop.settings.bd:
 * {
 *   mfs_mode:    "self" | "business"   // "self" = personal bKash/Nagad number
 *   mfs_type:    "bkash" | "nagad" | "rocket"
 *   mfs_number:  "01XXXXXXXXX"         // shop owner's personal MFS number (Self mode only)
 *
 *   google_sheet_id:    "spreadsheet_id"   // for stock sync via Sheets webhook
 *   google_sheet_range: "Sheet1!A:Z"       // range that contains product/stock data
 * }
 *
 * Courier credentials are stored in the delivery_integrations table (DeliveryIntegration entity),
 * NOT here — that table is already per-shop and credential-aware.
 */

const Shop = require('./shop.entity');
const { AppError } = require('../../utils/AppError');
const { bdMobileRegex: BD_PHONE_REGEX } = require('../../utils/validators/phone.validator');
const { mergeSettingsPreservingRtoConsent } = require('./shop-settings.validator');
const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');
const VALID_MFS_TYPES = ['bkash', 'nagad', 'rocket'];
const VALID_MFS_MODES = ['self', 'business'];

const DEFAULT_BD_SETTINGS = {
    mfs_mode: null,
    mfs_type: null,
    mfs_number: null,
    google_sheet_id: null,
    google_sheet_range: 'Sheet1!A:Z'
};

/**
 * Get BD settings for a shop, merged with defaults.
 * @param {string} shopId
 * @returns {Promise<object>}
 */
const getBdSettings = async (shopId) => {
    const shop = await Shop.findByPk(shopId, { attributes: ['id', 'settings'] });
    if (!shop) return { ...DEFAULT_BD_SETTINGS };
    return { ...DEFAULT_BD_SETTINGS, ...(shop.settings?.bd || {}) };
};

/**
 * Update BD settings for a shop (partial update, preserves other settings keys).
 * Validates sensitive fields before saving.
 * @param {string} shopId
 * @param {object} updates  — partial BD settings
 * @returns {Promise<object>} updated BD settings
 */
const updateBdSettings = async (shopId, updates) => {
    if (updates.mfs_type && !VALID_MFS_TYPES.includes(updates.mfs_type)) {
        throw new AppError(`mfs_type must be one of: ${VALID_MFS_TYPES.join(', ')}`, 400);
    }
    if (updates.mfs_mode && !VALID_MFS_MODES.includes(updates.mfs_mode)) {
        throw new AppError(`mfs_mode must be one of: ${VALID_MFS_MODES.join(', ')}`, 400);
    }
    if (updates.mfs_number && !BD_PHONE_REGEX.test(updates.mfs_number)) {
        throw new AppError('mfs_number must be a valid Bangladesh mobile number', 400);
    }

    const allowedKeys = new Set([
        'mfs_mode', 'mfs_type', 'mfs_number', 'google_sheet_id', 'google_sheet_range'
    ]);
    const bdUpdates = Object.fromEntries(
        Object.entries(updates).filter(([key]) => allowedKeys.has(key))
    );
    const newBd = await Shop.sequelize.transaction(async (transaction) => {
        const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
        if (!shop) throw new AppError('Shop not found', 404);
        const newSettings = mergeSettingsPreservingRtoConsent(shop.settings || {}, { bd: bdUpdates });
        await shop.update({ settings: newSettings }, { transaction });
        return newSettings.bd || {};
    });
    await invalidateShopSettingsCaches(shopId);
    return { ...DEFAULT_BD_SETTINGS, ...newBd };
};

/**
 * Returns true if the shop has Self MFS configured (personal number + mfs_mode = self).
 * @param {object} bdSettings — result of getBdSettings()
 */
const hasSelfMfs = (bdSettings) =>
    bdSettings.mfs_mode === 'self' &&
    Boolean(bdSettings.mfs_number) &&
    Boolean(bdSettings.mfs_type);

/**
 * Remove personal-MFS payment truth from shop.settings.bd (P0-3).
 *
 * Called when the merchant DISABLES or DELETES the self-mfs PaymentConfig, so
 * no stale number can keep being advertised after the authoritative row is
 * off. Unrelated bd keys (google sheet etc.) and other settings domains are
 * preserved; a shop with nothing configured is a silent no-op.
 * @param {string} shopId
 * @returns {Promise<object|null>} cleared bd settings, or null when nothing to clear
 */
const clearSelfMfs = async (shopId) => {
    const result = await Shop.sequelize.transaction(async (transaction) => {
        const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
        if (!shop) return null;
        const bd = shop.settings?.bd;
        if (!bd || (bd.mfs_mode == null && bd.mfs_type == null && bd.mfs_number == null)) return null;

        const clearedBd = { ...bd, mfs_mode: null, mfs_type: null, mfs_number: null };
        const newSettings = mergeSettingsPreservingRtoConsent(shop.settings || {}, { bd: clearedBd });
        await shop.update({ settings: newSettings }, { transaction });
        return newSettings.bd;
    });
    if (result === null) return null;
    await invalidateShopSettingsCaches(shopId);
    return result;
};

module.exports = { getBdSettings, updateBdSettings, hasSelfMfs, clearSelfMfs, BD_PHONE_REGEX };
