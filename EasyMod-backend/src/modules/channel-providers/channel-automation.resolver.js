'use strict';

/**
 * Channel automation resolver (ADR-0013 §5, API_CONTRACT §1).
 *
 * The single authority for channel automation configuration. Display and
 * consumer paths keep using the business-default reader; every send path must
 * consult this module.
 *
 * - `resolveChannelAutomation` is pure: no I/O, never throws on bad input.
 * - `loadEffectiveChannelAutomation` performs fresh, tenant-asserted reads.
 *
 * Narrow-only ceiling: MANUAL > DRAFT > AUTO. An override may only narrow or
 * repeat the business default. Stored values are never rewritten by a read; a
 * now-widening stored override is clamped at runtime and reported through
 * `warnings`.
 */

const { DEFAULT_AI_SETTINGS } = require('../shop/shop-defaults');
const {
    AI_REPLY_MODES,
    normalizeAiReplyMode,
    isKnownAiReplyMode,
} = require('../shop/ai-reply-mode');

const OVERRIDE_KEYS = Object.freeze(['automation_mode', 'confidence_threshold', 'greeting']);

// Lower rank = more restrictive.
const MODE_RESTRICTIVENESS = Object.freeze({
    [AI_REPLY_MODES.MANUAL]: 0,
    [AI_REPLY_MODES.DRAFT]: 1,
    [AI_REPLY_MODES.AUTO]: 2,
});

const WARNINGS = Object.freeze({
    OVERRIDE_CLAMPED_BY_BUSINESS: 'override_clamped_by_business',
    INVALID_OVERRIDE_VALUE: 'invalid_override_value',
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const isPlainObject = (value) => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Read a setting from either a plain object or a Sequelize instance. */
const pick = (source, ...keys) => {
    if (!source) return undefined;
    for (const key of keys) {
        const value = source[key];
        if (value !== undefined) return value;
    }
    return undefined;
};

// ── Override canonicalization (shared with the write API) ────────────────────

/**
 * Canonicalize an automation-mode override value.
 * Legacy aliases are accepted at the boundary; storage is always canonical.
 * @returns {'AUTO'|'DRAFT'|'MANUAL'|null} null when the value is not a known mode
 */
const canonicalizeOverrideMode = (value) => {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    if (!isKnownAiReplyMode(input)) return null;
    return normalizeAiReplyMode(input);
};

/**
 * Canonicalize a confidence-threshold override (0–100, finite).
 * @returns {number|null} null when the value cannot be coerced into range
 */
const canonicalizeOverrideThreshold = (value) => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
    return numeric;
};

/**
 * Canonicalize a greeting override block. Only known keys survive; an empty
 * result is invalid (nothing to override) and returns null.
 * @returns {{enabled?: boolean, custom_text?: string}|null}
 */
const canonicalizeOverrideGreeting = (value) => {
    if (!isPlainObject(value)) return null;
    const out = {};
    if (hasOwn(value, 'enabled')) {
        if (typeof value.enabled !== 'boolean') return null;
        out.enabled = value.enabled;
    }
    if (hasOwn(value, 'custom_text')) {
        if (typeof value.custom_text !== 'string' || value.custom_text.length > 500) return null;
        out.custom_text = value.custom_text;
    }
    return Object.keys(out).length > 0 ? out : null;
};

/** Whether `overrideMode` is at least as restrictive as `businessMode`. */
const isModeWithinCeiling = (overrideMode, businessMode) => {
    const override = canonicalizeOverrideMode(overrideMode);
    const business = normalizeAiReplyMode(businessMode);
    if (!override || MODE_RESTRICTIVENESS[override] === undefined) return false;
    return MODE_RESTRICTIVENESS[override] <= MODE_RESTRICTIVENESS[business];
};

// ── Business/channel value normalization ────────────────────────────────────

const normalizeBusinessThreshold = (value) => {
    const numeric = canonicalizeOverrideThreshold(value);
    return numeric === null ? DEFAULT_AI_SETTINGS.confidence_threshold : numeric;
};

const normalizeBusinessGreeting = (value) => {
    const base = DEFAULT_AI_SETTINGS.greeting;
    if (!isPlainObject(value)) return { ...base };
    const out = { ...base };
    if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
    // Business values are already validated at write time (the business
    // validator allows up to 1000 chars). Pass them through VERBATIM — the
    // 500-char bound applies to channel overrides only. Substituting the
    // default here would silently rewrite existing merchants' greetings
    // (ADR-0013 §10 byte-identical behavior).
    if (typeof value.custom_text === 'string') {
        out.custom_text = value.custom_text;
    }
    return out;
};

const normalizeAllowOrderCreation = (value) => (value === false ? false : true);

const isEmergencyStopActive = (emergencyStop) => (
    isPlainObject(emergencyStop) ? emergencyStop.active === true : emergencyStop === true
);

/**
 * Map the dedicated shops.ai_emergency_stop* columns to the public block shape.
 * @returns {{active: boolean, at: *, by: *, source: *, prior_mode: *}}
 */
const readEmergencyStopState = (shop) => ({
    active: shop?.ai_emergency_stop === true,
    at: shop?.ai_emergency_stop_at ?? null,
    by: shop?.ai_emergency_stop_by ?? null,
    source: shop?.ai_emergency_stop_source ?? null,
    prior_mode: shop?.ai_emergency_stop_prior_mode ?? null,
});

const canonicalizeStoredOverrides = (rawOverrides, warnings) => {
    const out = {};
    if (!isPlainObject(rawOverrides)) return out;
    for (const key of OVERRIDE_KEYS) {
        if (!hasOwn(rawOverrides, key)) continue;
        const value = rawOverrides[key];
        if (value === null || value === undefined) continue; // explicit inherit
        let canonical = null;
        if (key === 'automation_mode') canonical = canonicalizeOverrideMode(value);
        else if (key === 'confidence_threshold') canonical = canonicalizeOverrideThreshold(value);
        else canonical = canonicalizeOverrideGreeting(value);
        if (canonical === null) {
            warnings.push(WARNINGS.INVALID_OVERRIDE_VALUE);
            continue;
        }
        out[key] = canonical;
    }
    return out;
};

// ── Pure resolver ────────────────────────────────────────────────────────────

/**
 * Resolve the effective channel automation configuration.
 *
 * @param {object} input
 * @param {object|null} input.shopAiSettings  business `settings.ai` (already merged is fine)
 * @param {object|null} input.channelSettings MetaChannelSettings row (snake_case or camelCase)
 * @param {boolean|object} [input.emergencyStop] stop flag or the emergency block
 * @param {boolean} [input.shopIsActive] false => shop inactive
 * @returns {{mode: string, modeSource: string, effective: object, overrides: object, warnings: string[]}}
 */
function resolveChannelAutomation({
    shopAiSettings,
    channelSettings,
    emergencyStop = false,
    shopIsActive = true,
} = {}) {
    const warnings = [];
    const businessKnown = isPlainObject(shopAiSettings);
    const business = businessKnown
        ? { ...DEFAULT_AI_SETTINGS, ...shopAiSettings }
        : { ...DEFAULT_AI_SETTINGS };

    const businessMode = businessKnown
        ? normalizeAiReplyMode(business.automation_mode)
        : AI_REPLY_MODES.MANUAL;

    const channel = isPlainObject(channelSettings) ? channelSettings : {};
    const overrides = canonicalizeStoredOverrides(
        pick(channel, 'overrides'),
        warnings,
    );

    // Channel-native values come from the channel row ONLY. A merchant JSON key
    // named business_hours/allow_order_creation on the business settings must
    // never override them.
    const channelBusinessHours = pick(channel, 'business_hours', 'businessHours');
    const channelAllowOrder = pick(channel, 'allow_order_creation', 'allowOrderCreation');
    const channelPurposeLabel = pick(channel, 'purpose_label', 'purposeLabel');

    const businessThreshold = normalizeBusinessThreshold(business.confidence_threshold);
    const businessGreeting = normalizeBusinessGreeting(business.greeting);

    const effectiveThreshold = hasOwn(overrides, 'confidence_threshold')
        ? overrides.confidence_threshold
        : businessThreshold;

    const effectiveGreeting = hasOwn(overrides, 'greeting')
        ? { ...businessGreeting, ...overrides.greeting }
        : businessGreeting;

    let mode;
    let modeSource;

    if (isEmergencyStopActive(emergencyStop)) {
        mode = AI_REPLY_MODES.MANUAL;
        modeSource = 'emergency_stop';
    } else if (shopIsActive === false) {
        mode = AI_REPLY_MODES.MANUAL;
        modeSource = 'shop_inactive';
    } else if (!businessKnown) {
        mode = AI_REPLY_MODES.MANUAL;
        modeSource = 'fail_closed';
    } else if (hasOwn(overrides, 'automation_mode')) {
        const overrideMode = overrides.automation_mode;
        if (MODE_RESTRICTIVENESS[overrideMode] <= MODE_RESTRICTIVENESS[businessMode]) {
            mode = overrideMode;
            modeSource = 'channel_override';
        } else {
            mode = businessMode;
            modeSource = 'business_default';
            warnings.push(WARNINGS.OVERRIDE_CLAMPED_BY_BUSINESS);
        }
    } else {
        mode = businessMode;
        modeSource = 'business_default';
    }

    return {
        mode,
        modeSource,
        effective: {
            automation_mode: mode,
            confidence_threshold: effectiveThreshold,
            greeting: effectiveGreeting,
            business_hours: channelBusinessHours === undefined ? null : channelBusinessHours,
            allow_order_creation: normalizeAllowOrderCreation(channelAllowOrder),
            purpose_label: channelPurposeLabel === undefined ? null : channelPurposeLabel,
        },
        overrides,
        warnings,
    };
}

// ── Async tenant-asserted loader ────────────────────────────────────────────

const shopSettingsUnavailableError = () => {
    const error = new Error('SHOP_SETTINGS_UNAVAILABLE');
    error.code = 'SHOP_SETTINGS_UNAVAILABLE';
    error.retryable = true;
    return error;
};

const parseShopAiSettings = (shop) => {
    let settings = shop?.settings;
    if (typeof settings === 'string') {
        try { settings = JSON.parse(settings); } catch (_) { settings = {}; }
    }
    const ai = isPlainObject(settings) && isPlainObject(settings.ai) ? settings.ai : {};
    return { ...DEFAULT_AI_SETTINGS, ...ai };
};

/**
 * Fresh, tenant-asserted effective configuration load.
 *
 * Contract:
 * - channel missing or owned by another shop -> null (fail-closed)
 * - missing/unreadable shop row -> throws {code:'SHOP_SETTINGS_UNAVAILABLE', retryable:true}
 * - empty settings.ai -> DEFAULT_AI_SETTINGS merge (MANUAL), not an error
 * - missing channel-settings row: createIfMissing (Guard 4, no transaction) ->
 *   findOrCreate defaults; otherwise -> null (caller holds with
 *   channel_settings_unavailable)
 * - no INSERT and no Shop row lock when a boundary transaction is supplied
 *
 * @param {string} shopId
 * @param {string} channelId
 * @param {{transaction?: object, createIfMissing?: boolean}} [options]
 */
async function loadEffectiveChannelAutomation(shopId, channelId, { transaction = null, createIfMissing = false } = {}) {
    if (!shopId || !channelId) return null;

    // Lazy requires keep unit tests able to mock the models.
    const MetaChannel = require('./meta-channel.entity');
    const MetaChannelSettings = require('./meta-channel-settings.entity');
    const { Shop, Subscription } = require('../entities');

    const readOptions = transaction ? { transaction } : {};

    const channel = await MetaChannel.findByPk(channelId, {
        attributes: ['id', 'shop_id'],
        ...readOptions,
    });
    if (!channel || String(channel.shop_id) !== String(shopId)) return null;

    const shop = await Shop.findByPk(shopId, readOptions);
    if (!shop) throw shopSettingsUnavailableError();

    let settingsRow = await MetaChannelSettings.findByPk(channelId, readOptions);
    if (!settingsRow) {
        // A boundary transaction must never INSERT or take a Shop lock.
        if (!createIfMissing || transaction) return null;
        [settingsRow] = await MetaChannelSettings.findOrCreate({
            where: { channel_id: channelId },
            defaults: { channel_id: channelId },
        });
    }

    const emergencyStop = readEmergencyStopState(shop);
    const resolved = resolveChannelAutomation({
        shopAiSettings: parseShopAiSettings(shop),
        channelSettings: settingsRow,
        emergencyStop,
        shopIsActive: shop.is_active !== false,
    });

    // Display honesty (ADR-0011 C5): fail CLOSED. The worker blocks sends when
    // the subscription row is missing (subscription_missing) or inactive, so the
    // UI must not present AUTO as effective in those cases. A read error also
    // resolves to false rather than optimistically true.
    //
    // Inside a provider-boundary transaction this display-only read is SKIPPED:
    // a failed SELECT would abort the Postgres transaction even if caught,
    // turning a display concern into a failed send. The boundary never consumes
    // billingAiActive (the worker's own Guard 4c enforces billing).
    let billingAiActive = false;
    if (!transaction) {
        try {
            const { isAiActive } = require('../subscription/subscription.access');
            const billingSub = await Subscription.findOne({
                where: { shop_id: shopId },
                attributes: ['status'],
            }).catch(() => null);
            billingAiActive = billingSub ? isAiActive(billingSub) : false;
        } catch (_) {
            billingAiActive = false;
        }
    }

    return {
        ...resolved,
        emergencyStop,
        shopIsActive: shop.is_active !== false,
        billingAiActive,
    };
}

// ── Worker settings delegate ────────────────────────────────────────────────

/**
 * Whitelist-merge the business settings for the worker. Keeps the existing
 * three-argument call signature so the runtime can delegate without churn.
 *
 * The dangerous `...shopSettings` spread is replaced: only explicit
 * DEFAULT_AI_SETTINGS keys are copied, so an unknown merchant JSON key cannot
 * shadow a channel-native value.
 *
 * @param {object} shopSettings  merged business `settings.ai`
 * @param {object} channelSettings MetaChannelSettings row
 * @param {string} [businessMode] explicit business mode (legacy reader)
 */
function buildEffectiveWorkerAiSettings(shopSettings = {}, channelSettings = {}, businessMode) {
    const shopBase = isPlainObject(shopSettings) ? shopSettings : {};
    const shopAiSettings = { ...shopBase };
    if (businessMode !== undefined && businessMode !== null) {
        shopAiSettings.automation_mode = businessMode;
    }
    const channel = isPlainObject(channelSettings) ? channelSettings : {};

    const resolved = resolveChannelAutomation({
        shopAiSettings,
        channelSettings: channel,
        emergencyStop: false,
        shopIsActive: true,
    });

    const workerSettings = {};
    for (const key of Object.keys(DEFAULT_AI_SETTINGS)) {
        if (hasOwn(shopBase, key)) workerSettings[key] = shopBase[key];
    }

    workerSettings.business_hours = resolved.effective.business_hours;
    workerSettings.allow_order_creation = resolved.effective.allow_order_creation;
    workerSettings.purpose_label = resolved.effective.purpose_label;
    // Legacy dead thresholds stay available for old consumers; they are never
    // read as automation authority.
    workerSettings.confidence_threshold_send = pick(channel, 'confidence_threshold_send', 'confidenceThresholdSend');
    workerSettings.confidence_threshold_suggest = pick(channel, 'confidence_threshold_suggest', 'confidenceThresholdSuggest');
    workerSettings.confidence_threshold = resolved.effective.confidence_threshold;
    workerSettings.greeting = resolved.effective.greeting;
    workerSettings.automation_mode = resolved.mode;
    workerSettings.auto_reply_enabled = resolved.mode === AI_REPLY_MODES.AUTO;
    return workerSettings;
}

module.exports = {
    OVERRIDE_KEYS,
    MODE_RESTRICTIVENESS,
    WARNINGS,
    canonicalizeOverrideMode,
    canonicalizeOverrideThreshold,
    canonicalizeOverrideGreeting,
    isModeWithinCeiling,
    readEmergencyStopState,
    resolveChannelAutomation,
    loadEffectiveChannelAutomation,
    buildEffectiveWorkerAiSettings,
};