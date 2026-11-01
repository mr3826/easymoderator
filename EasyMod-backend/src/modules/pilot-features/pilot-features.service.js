'use strict';

const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const metrics = require('./pilot-metrics');

const logger = createLogger('PilotFeatures');

const ORDER_CONFIDENCE_MODES = Object.freeze(['off', 'shadow', 'enforce']);

// Merchant-facing thresholds are platform-configured during the pilot so a
// shop member cannot weaken the gate by editing shop settings.
const DEFAULT_ORDER_CONFIDENCE_CONFIG = Object.freeze({
    high_value_cod_threshold: 10000,
    address_min_length: 15,
});

const CONFIG_LIMITS = Object.freeze({
    high_value_cod_threshold: [0, 1000000],
    address_min_length: [0, 100],
});

const OFF = Object.freeze({
    customerIntelligence: false,
    orderConfidenceMode: 'off',
    orderConfidenceConfig: { ...DEFAULT_ORDER_CONFIDENCE_CONFIG },
    // Pilot+ V1 flags (ADR-0009 discipline: platform-controlled, default off).
    interactionChoices: false,
    actionQueue: false,
    knowledgeSuggestions: false,
    adsStudio: false,
    storefront: false,
    aiReplyShadowMeter: false,
    aiReplyShadowMeterEnabledAt: null,
});

const getModel = () => {
    try {
        return require('../entities').ShopPilotFeatures || null;
    } catch (_) {
        // Narrow unit fixtures replace the entity registry; no model = no pilot.
        return null;
    }
};

function sanitizeConfig(config = {}) {
    const clean = { ...DEFAULT_ORDER_CONFIDENCE_CONFIG };
    for (const [key, [min, max]] of Object.entries(CONFIG_LIMITS)) {
        const value = Number(config?.[key]);
        if (Number.isInteger(value) && value >= min && value <= max) clean[key] = value;
    }
    return clean;
}

function toFeatures(row) {
    if (!row) return { ...OFF, orderConfidenceConfig: { ...OFF.orderConfidenceConfig } };
    const mode = ORDER_CONFIDENCE_MODES.includes(row.order_confidence_mode)
        ? row.order_confidence_mode
        : 'off';
    return {
        customerIntelligence: row.customer_intelligence === true,
        orderConfidenceMode: mode,
        orderConfidenceConfig: sanitizeConfig(row.order_confidence_config),
        interactionChoices: row.interaction_choices === true,
        actionQueue: row.action_queue === true,
        knowledgeSuggestions: row.knowledge_suggestions === true,
        adsStudio: row.ads_studio === true,
        storefront: row.storefront === true,
        aiReplyShadowMeter: row.ai_reply_shadow_meter === true,
        aiReplyShadowMeterEnabledAt: row.ai_reply_shadow_meter_enabled_at
            ? new Date(row.ai_reply_shadow_meter_enabled_at).toISOString()
            : null,
    };
}

/**
 * Read a shop's pilot flags. A missing row, or a lookup failure, resolves to
 * every feature OFF — i.e. exactly the pre-pilot behaviour. The flag read is
 * never the reason an order cannot be booked.
 */
async function getPilotFeaturesStrict(shopId) {
    const Model = getModel();
    if (!shopId || typeof Model?.findByPk !== 'function') {
        throw new AppError('Pilot feature state is unavailable', 503, 'PILOT_FEATURES_UNAVAILABLE');
    }
    try {
        const row = await Model.findByPk(shopId);
        return toFeatures(row);
    } catch (error) {
        metrics.increment('pilot_features.lookup_failed');
        logger.warn('Pilot feature lookup failed; treating features as off', {
            shopId,
            error: error.message,
        });
        throw new AppError('Pilot feature state is unavailable', 503, 'PILOT_FEATURES_UNAVAILABLE');
    }
}

async function getPilotFeatures(shopId) {
    try {
        return await getPilotFeaturesStrict(shopId);
    } catch (_) {
        return toFeatures(null);
    }
}

async function isCustomerIntelligenceEnabled(shopId) {
    return (await getPilotFeatures(shopId)).customerIntelligence;
}

async function isInteractionChoicesEnabled(shopId) {
    return (await getPilotFeatures(shopId)).interactionChoices;
}

async function isActionQueueEnabled(shopId) {
    return (await getPilotFeatures(shopId)).actionQueue;
}

async function isKnowledgeSuggestionsEnabled(shopId) {
    return (await getPilotFeatures(shopId)).knowledgeSuggestions;
}

function serialize(row, shopId) {
    const features = toFeatures(row);
    return {
        shop_id: shopId,
        customer_intelligence: features.customerIntelligence,
        order_confidence_mode: features.orderConfidenceMode,
        order_confidence_config: features.orderConfidenceConfig,
        interaction_choices: features.interactionChoices,
        action_queue: features.actionQueue,
        knowledge_suggestions: features.knowledgeSuggestions,
        ads_studio: features.adsStudio,
        storefront: features.storefront,
        ai_reply_shadow_meter: features.aiReplyShadowMeter,
        ai_reply_shadow_meter_enabled_at: features.aiReplyShadowMeterEnabledAt,
        updated_by: row?.updated_by || null,
        updated_at: row?.updated_at || null,
    };
}

async function getForAdmin(shopId) {
    const row = await getModel().findByPk(shopId);
    return serialize(row, shopId);
}

/**
 * SUPER_ADMIN write. Returns { previous, current } for the audit record.
 */
async function setPilotFeatures(shopId, updates, actorUserId, { transaction = null } = {}) {
    const { Shop } = require('../entities');
    const tx = transaction ? { transaction } : {};
    const shop = await Shop.findByPk(shopId, { attributes: ['id'], ...tx });
    if (!shop) throw new AppError('Shop not found', 404, 'NOT_FOUND');

    const Model = getModel();
    const existing = await Model.findByPk(shopId, { ...tx, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const previous = serialize(existing, shopId);

    const next = {
        customer_intelligence: typeof updates.customer_intelligence === 'boolean'
            ? updates.customer_intelligence
            : previous.customer_intelligence,
        order_confidence_mode: updates.order_confidence_mode !== undefined
            ? updates.order_confidence_mode
            : previous.order_confidence_mode,
        order_confidence_config: updates.order_confidence_config !== undefined
            ? sanitizeConfig({ ...previous.order_confidence_config, ...updates.order_confidence_config })
            : previous.order_confidence_config,
        interaction_choices: typeof updates.interaction_choices === 'boolean'
            ? updates.interaction_choices
            : previous.interaction_choices,
        action_queue: typeof updates.action_queue === 'boolean'
            ? updates.action_queue
            : previous.action_queue,
        knowledge_suggestions: typeof updates.knowledge_suggestions === 'boolean'
            ? updates.knowledge_suggestions
            : previous.knowledge_suggestions,
        ads_studio: typeof updates.ads_studio === 'boolean'
            ? updates.ads_studio
            : previous.ads_studio,
        storefront: typeof updates.storefront === 'boolean'
            ? updates.storefront
            : previous.storefront,
        ai_reply_shadow_meter: typeof updates.ai_reply_shadow_meter === 'boolean'
            ? updates.ai_reply_shadow_meter
            : previous.ai_reply_shadow_meter,
        ai_reply_shadow_meter_enabled_at: false,
        updated_by: actorUserId || null,
    };
    if (next.ai_reply_shadow_meter) {
        next.ai_reply_shadow_meter_enabled_at = previous.ai_reply_shadow_meter
            ? previous.ai_reply_shadow_meter_enabled_at || new Date()
            : new Date();
    } else {
        next.ai_reply_shadow_meter_enabled_at = previous.ai_reply_shadow_meter_enabled_at;
    }
    if (!ORDER_CONFIDENCE_MODES.includes(next.order_confidence_mode)) {
        throw new AppError('Invalid order_confidence_mode', 400, 'VALIDATION_ERROR');
    }

    if (existing) {
        await existing.update(next, tx);
    } else {
        await Model.create({ shop_id: shopId, ...next }, tx);
    }
    const current = serialize(await Model.findByPk(shopId, tx), shopId);
    return { previous, current };
}

/** Global kill switch: every shop back to pre-pilot behaviour, no deploy. */
async function disableAll(actorUserId, { transaction = null } = {}) {
    const [affected] = await getModel().update(
        {
            customer_intelligence: false,
            order_confidence_mode: 'off',
            interaction_choices: false,
            action_queue: false,
            knowledge_suggestions: false,
            ads_studio: false,
            storefront: false,
            ai_reply_shadow_meter: false,
            ai_reply_shadow_meter_enabled_at: null,
            updated_by: actorUserId || null,
        },
        { where: {}, ...(transaction ? { transaction } : {}) },
    );
    return { affected };
}

module.exports = {
    ORDER_CONFIDENCE_MODES,
    DEFAULT_ORDER_CONFIDENCE_CONFIG,
    getPilotFeatures,
    getPilotFeaturesStrict,
    isCustomerIntelligenceEnabled,
    isInteractionChoicesEnabled,
    isActionQueueEnabled,
    isKnowledgeSuggestionsEnabled,
    isAdsStudioEnabled: async (shopId) => (await getPilotFeatures(shopId)).adsStudio,
    isStorefrontEnabled: async (shopId) => (await getPilotFeatures(shopId)).storefront,
    isAiReplyShadowMeterEnabled: async (shopId) => (await getPilotFeatures(shopId)).aiReplyShadowMeter,
    getForAdmin,
    setPilotFeatures,
    disableAll,
    sanitizeConfig,
};
