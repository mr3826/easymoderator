'use strict';

const { AppError } = require('../../utils/AppError');
const pilotFeatures = require('../pilot-features/pilot-features.service');
const { getPublicAddonCatalog } = require('./shop-addons.catalog');

const FEATURE_BY_ADDON = Object.freeze({
    ADS_STUDIO: 'adsStudio',
    STOREFRONT: 'storefront',
    AI_REPLY_METER: 'aiReplyShadowMeter',
});

const getModels = () => {
    const entities = require('../entities');
    return { ShopAddon: entities.ShopAddon, UserShop: entities.UserShop };
};

async function assertShopAddonEnabled(shopId, addonCode) {
    const featureKey = FEATURE_BY_ADDON[addonCode];
    if (!featureKey || !shopId) {
        throw new AppError('Add-on is unavailable for this shop', 404, 'ADDON_NOT_AVAILABLE');
    }

    const features = await pilotFeatures.getPilotFeaturesStrict(shopId);
    if (features[featureKey] !== true) {
        throw new AppError('Add-on is not enabled for this shop', 404, 'ADDON_NOT_AVAILABLE');
    }

    // Shadow support metering is an internal opt-in pilot, not a third paid add-on.
    if (addonCode === 'AI_REPLY_METER') return true;

    try {
        const { ShopAddon } = getModels();
        const selection = await ShopAddon.findOne({ where: { shop_id: shopId, addon_code: addonCode } });
        if (!selection?.enabled) {
            throw new AppError('Add-on is not enabled for this shop', 404, 'ADDON_NOT_AVAILABLE');
        }
        return true;
    } catch (error) {
        if (error.code === 'ADDON_NOT_AVAILABLE') throw error;
        throw new AppError('Add-on eligibility could not be verified', 503, 'ADDON_GATE_UNAVAILABLE');
    }
}

async function getShopAddonState(userId, shopId) {
    const { ShopAddon, UserShop } = getModels();
    const membership = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true },
        attributes: ['role'],
    });
    if (!membership) throw new AppError('You do not have access to this shop', 403, 'SHOP_ACCESS_DENIED');

    const features = await pilotFeatures.getPilotFeatures(shopId);
    const selections = await ShopAddon.findAll({ where: { shop_id: shopId } });
    const byCode = new Map(selections.map((selection) => [selection.addon_code, selection]));
    const addons = getPublicAddonCatalog().map((addon) => {
        const selection = byCode.get(addon.code);
        const eligible = features[FEATURE_BY_ADDON[addon.code]] === true;
        return {
            ...addon,
            eligible,
            enabled: eligible && selection?.enabled === true,
            enabled_at: eligible && selection?.enabled ? selection.enabled_at : null,
        };
    });

    return { shop_id: shopId, role: membership.role, addons };
}

async function setShopAddonEnabled({ userId, shopId, addonCode, enabled, transaction = null }) {
    if (!['ADS_STUDIO', 'STOREFRONT'].includes(addonCode) || typeof enabled !== 'boolean') {
        throw new AppError('Invalid add-on selection', 400, 'VALIDATION_ERROR');
    }

    const { ShopAddon, UserShop } = getModels();
    const membership = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true },
        attributes: ['role'],
        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
    });
    if (!membership) throw new AppError('You do not have access to this shop', 403, 'SHOP_ACCESS_DENIED');
    if (!['owner', 'admin'].includes(membership.role)) {
        throw new AppError('Only a shop owner or admin can change add-ons', 403, 'SHOP_ROLE_DENIED');
    }

    const before = await ShopAddon.findOne({
        where: { shop_id: shopId, addon_code: addonCode },
        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
    });
    const previous = { enabled: before?.enabled === true, enabled_at: before?.enabled_at || null };

    if (previous.enabled === enabled) {
        return { previous, current: previous };
    }

    if (enabled) {
        const features = await pilotFeatures.getPilotFeatures(shopId);
        if (features[FEATURE_BY_ADDON[addonCode]] !== true) {
            throw new AppError('This add-on is not approved for this shop yet', 403, 'ADDON_NOT_ELIGIBLE');
        }
    }

    const now = enabled ? new Date() : null;
    const Model = ShopAddon;
    if (typeof Model.upsert === 'function') {
        await Model.upsert({
            shop_id: shopId,
            addon_code: addonCode,
            enabled,
            enabled_by: enabled ? userId : null,
            enabled_at: now,
        }, {
            ...(transaction ? { transaction } : {}),
            conflictFields: ['shop_id', 'addon_code'],
        });
    } else if (before) {
        await before.update({ enabled, enabled_by: enabled ? userId : null, enabled_at: now }, transaction ? { transaction } : {});
    } else {
        try {
            await Model.create({
                shop_id: shopId,
                addon_code: addonCode,
                enabled,
                enabled_by: enabled ? userId : null,
                enabled_at: now,
            }, transaction ? { transaction } : {});
        } catch (error) {
            if (error.name !== 'SequelizeUniqueConstraintError') throw error;
            const raced = await Model.findOne({ where: { shop_id: shopId, addon_code: addonCode }, ...(transaction ? { transaction } : {}) });
            await raced.update({ enabled, enabled_by: enabled ? userId : null, enabled_at: now }, transaction ? { transaction } : {});
        }
    }

    return {
        previous,
        current: { enabled, enabled_at: now },
    };
}

module.exports = {
    ADDON_CODES: Object.freeze(['ADS_STUDIO', 'STOREFRONT']),
    assertAddonEnabled: assertShopAddonEnabled,
    assertShopAddonEnabled,
    getShopAddonState,
    setShopAddonEnabled,
};
