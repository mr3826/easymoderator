const shopService = require('./shop.service');
const { Shop, DeliveryIntegration } = require('../entities');
const knowledgeService = require('../knowledge/knowledge.service');
const setupStatusService = require('../setup/setup-status.service');
const { validationResult } = require('express-validator');
const { AppError } = require('../../utils/AppError');
const cacheService = require('../../utils/cache.service');
const { getBdSettings: getBdSettingsHelper, updateBdSettings: updateBdSettingsHelper } = require('./shop-bd-settings');
const {
    mergeSettingsPreservingRtoConsent,
    stripAutomationModeFromShopUpdate,
} = require('./shop-settings.validator');
const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');
const { PlanCode, normalizePlanCode, getTierByCode } = require('../subscription/subscription.plans');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
} = require('../commercial/commercial.contract');
const {
    AI_REPLY_MODES,
    normalizeAiReplyMode,
    isAutoSendMode,
    isKnownAiReplyMode,
} = require('./ai-reply-mode');

// Resolve the shop's plan code, with Redis caching (5 min TTL). Under ADR-0011
// every row normalizes to the single MERCHANT tier; a missing row or read error
// therefore fails closed to MERCHANT, which grants nothing beyond the contract.
async function getShopPlanCode(shopId) {
    try {
        const cached = await cacheService.getForShop(shopId, 'subscription:plan_code');
        if (cached) return normalizePlanCode(cached);
        const { Subscription } = require('../entities');
        const sub = await Subscription.findOne({ where: { shop_id: shopId }, attributes: ['plan_code'] });
        const planCode = normalizePlanCode(sub?.plan_code || PlanCode.MERCHANT);
        await cacheService.setForShop(shopId, 'subscription:plan_code', planCode, 300);
        return planCode;
    } catch (_) {
        return PlanCode.MERCHANT;
    }
}

/**
 * Get all shops for user
 */
const getUserShops = async (req, res, next) => {
    try {
        const shops = await shopService.getShopsByUserId(req.user.userId);

        res.status(200).json({
            success: true,
            data: shops
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get current logged-in shop from token
 */
const getShop = async (req, res, next) => {
    try {
        // Get shopId from token
        const { shopId } = req.user;

        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        // Get shop details with user's role
        const shop = await shopService.getShopById(shopId, req.user.userId);

        res.status(200).json({
            success: true,
            data: shop
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get business info for current shop
 * ai_settings are now included by knowledgeService.getKnowledge — no stitching needed here.
 */
const getBusinessInfo = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;

        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const data = await knowledgeService.getKnowledge(userId, shopId);

        res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        next(error);
    }
};

const getOnboardingStatus = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);
        const setupStatus = await setupStatusService.getSetupStatus({ shopId, userId });
        const status = setupStatusService.toLegacyOnboardingStatus(setupStatus);
        res.status(200).json({ success: true, data: status });
    } catch (error) {
        next(error);
    }
};

const completeOnboarding = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const setupStatus = await setupStatusService.getSetupStatus({ shopId, userId });
        const status = setupStatusService.toLegacyOnboardingStatus(setupStatus);
        if (!status.can_complete) {
            return res.status(409).json({
                success: false,
                error: {
                    code: 'ONBOARDING_INCOMPLETE',
                    message: 'Complete the required launch setup before finishing onboarding.',
                    missing: status.missing,
                    checks: status.checks,
                },
            });
        }

        await Shop.sequelize.transaction(async (transaction) => {
            const shop = await Shop.findByPk(shopId, {
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!shop) throw new AppError('Shop not found', 404);
            await shop.update({
                settings: mergeSettingsPreservingRtoConsent(shop.settings || {}, {
                    onboarding_completed: true,
                    onboarding_completed_at: new Date().toISOString(),
                    onboarding_status_snapshot: status,
                }),
            }, { transaction });
        });
        await invalidateShopSettingsCaches(shopId);

        const nextSetupStatus = await setupStatusService.getSetupStatus({ shopId, userId });
        const nextStatus = setupStatusService.toLegacyOnboardingStatus(nextSetupStatus);
        res.status(200).json({ success: true, data: nextStatus });
    } catch (error) {
        next(error);
    }
};

/**
 * Update business info for current shop
 */
const updateBusinessInfo = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId, userId } = req.user;

        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const data = await knowledgeService.updateBusinessInfo(userId, shopId, req.body);

        res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Create new shop
 */
const createShop = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const shop = await shopService.createShop(req.user.userId, req.body);

        res.status(201).json({
            success: true,
            data: shop
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update shop
 */
const updateShop = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        // Always use the shop from the authenticated token — never trust shopId from the body.
        const shopId = req.user.shopId;
        const updateData = stripAutomationModeFromShopUpdate({ ...req.body });
        delete updateData.id;      // immutable
        delete updateData.shopId;  // strip if accidentally sent
        const shop = await shopService.updateShopById(shopId, req.user.userId, updateData);

        res.status(200).json({
            success: true,
            data: shop
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete shop
 */
const deleteShop = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId } = req.body;
        const result = await shopService.deleteShopById(shopId, req.user.userId);

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Add user to shop
 */
const addUserToShop = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId, email, role } = req.body;
        const userShop = await shopService.addUserToShop(shopId, req.user.userId, email, role);

        res.status(200).json({
            success: true,
            data: userShop
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Remove user from shop
 */
const removeUserFromShop = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId, userId } = req.body;
        const result = await shopService.removeUserFromShop(shopId, req.user.userId, userId);

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update user role
 */
const updateUserRole = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId, userId, role } = req.body;
        const userShop = await shopService.updateUserRole(shopId, req.user.userId, userId, role);

        res.status(200).json({
            success: true,
            data: userShop
        });
    } catch (error) {
        next(error);
    }
};

// Allowed model IDs — validated server-side so callers can't store arbitrary strings.
const ALLOWED_LLM_MODELS = new Set([
    'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo',
    'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'
]);

/**
 * GET /shop/llm-config
 */
const getLLMConfig = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const aiSettings = await shopService.getShopAiSettings(shopId);
        res.status(200).json({
            success: true,
            data: {
                model: aiSettings.llm_model || 'gpt-4o-mini',
                temperature: aiSettings.llm_temperature ?? 0.7
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /shop/llm-config
 */
const updateLLMConfig = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const { model, temperature } = req.body;

        if (!model || !ALLOWED_LLM_MODELS.has(model)) {
            throw new AppError(`Invalid model. Allowed: ${[...ALLOWED_LLM_MODELS].join(', ')}`, 400);
        }
        if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
            throw new AppError('temperature must be a number between 0 and 2', 400);
        }

        await shopService.getShopById(shopId, req.user.userId);
        await shopService.updateShopSettingsPreservingRtoConsent(shopId, (currentSettings) => ({
            ai: {
                ...(currentSettings.ai || {}),
                llm_model: model,
                ...(temperature !== undefined && { llm_temperature: temperature })
            }
        }));

        res.status(200).json({ success: true, data: { model, temperature } });
    } catch (error) {
        next(error);
    }
};

const ALLOWED_LANGUAGES        = new Set(['mixed', 'en', 'bn']);
const ALLOWED_NOTIF_CHANNELS   = new Set(['in_app', 'email', 'sms', 'telegram']);

/**
 * GET /shop/ai-settings
 */
const getAISettings = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const [aiSettings, planCode] = await Promise.all([
            shopService.getShopAiSettings(shopId),
            getShopPlanCode(shopId)
        ]);

        const normalizedAiSettings = aiSettings
            ? { ...aiSettings, automation_mode: normalizeAiReplyMode(aiSettings.automation_mode) }
            : aiSettings;

        // Capabilities are contract/tier derived: one MERCHANT tier, one price
        // authority, no plan-gated feature list that could drift from the API.
        const tier = getTierByCode(planCode) || getTierByCode(PlanCode.MERCHANT);
        const planCapabilities = {
            plan_code: tier.code,
            billing_model: tier.billingModel,
            contract_version: COMMERCIAL_CONTRACT_VERSION,
            unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
            ai_settings_access: [...tier.ai_settings_access],
            allowed_languages: [...tier.features.allowed_languages],
            allowed_automation_modes: Object.values(AI_REPLY_MODES),
            language_autodetect: false
        };

        res.status(200).json({ success: true, data: normalizedAiSettings, plan_capabilities: planCapabilities });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /shop/ai-settings
 */
const updateAISettings = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const {
            automation_mode, confidence_threshold, auto_reply_enabled,
            max_auto_order_value, ask_email, primary_language,
            required_fields, handoff_settings, payment_methods,
            greeting, closing
        } = req.body || {};

        // Legacy aliases are accepted only at this boundary and are stored and
        // returned using the canonical three-value vocabulary.
        if (automation_mode !== undefined) {
            if (!isKnownAiReplyMode(automation_mode)) {
                throw new AppError('automation_mode must be AUTO, DRAFT, MANUAL, or a supported legacy alias', 400);
            }
        }

        // Language — format validation
        if (primary_language !== undefined) {
            if (!ALLOWED_LANGUAGES.has(primary_language)) {
                throw new AppError(`primary_language must be one of: ${[...ALLOWED_LANGUAGES].join(', ')}`, 400);
            }
        }

        // ── Value-range validations ────────────────────────────────────────────
        if (confidence_threshold !== undefined && (typeof confidence_threshold !== 'number' || confidence_threshold < 0 || confidence_threshold > 100)) {
            throw new AppError('confidence_threshold must be a number between 0 and 100', 400);
        }
        if (max_auto_order_value !== undefined && (typeof max_auto_order_value !== 'number' || max_auto_order_value < 0)) {
            throw new AppError('max_auto_order_value must be a non-negative number', 400);
        }
        if (handoff_settings?.notification_channel !== undefined && !ALLOWED_NOTIF_CHANNELS.has(handoff_settings.notification_channel)) {
            throw new AppError(`notification_channel must be one of: ${[...ALLOWED_NOTIF_CHANNELS].join(', ')}`, 400);
        }

        const updates = {};
        if (automation_mode      !== undefined) {
            const normalizedMode = normalizeAiReplyMode(automation_mode);
            updates.automation_mode = normalizedMode;
            updates.auto_reply_enabled = isAutoSendMode(normalizedMode);
        }
        if (confidence_threshold !== undefined) updates.confidence_threshold = confidence_threshold;
        if (automation_mode === undefined && auto_reply_enabled !== undefined) updates.auto_reply_enabled = Boolean(auto_reply_enabled);
        if (max_auto_order_value !== undefined) updates.max_auto_order_value = max_auto_order_value;
        if (ask_email            !== undefined) updates.ask_email            = Boolean(ask_email);
        if (primary_language     !== undefined) updates.primary_language     = primary_language;
        if (required_fields      !== undefined) updates.required_fields      = required_fields;
        if (handoff_settings     !== undefined) updates.handoff_settings     = handoff_settings;
        if (payment_methods      !== undefined) updates.payment_methods      = payment_methods;
        if (greeting             !== undefined) updates.greeting             = greeting;
        if (closing              !== undefined) updates.closing              = closing;

        const data = await shopService.updateShopAiSettings(shopId, userId, updates);
        const normalizedData = data
            ? { ...data, automation_mode: normalizeAiReplyMode(data.automation_mode) }
            : data;
        res.status(200).json({ success: true, data: normalizedData });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /shop/ai-settings/intent-thresholds
 * Return per-intent confidence thresholds for the current shop.
 */
const getIntentThresholds = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const aiSettings = await shopService.getShopAiSettings(shopId);
        const intentThresholds = aiSettings.intentThresholds || {};
        res.status(200).json({ success: true, data: intentThresholds });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /shop/ai-settings/intent-thresholds
 * Update per-intent confidence thresholds.
 * Body: { greeting: 70, refund: 90, product_inquiry: 65 }
 */
const updateIntentThresholds = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const intentThresholdService = require('../ai/intent-threshold.service');
        const updated = await intentThresholdService.updateIntentThresholds(shopId, req.body);
        res.status(200).json({ success: true, data: updated });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /shop/settings/ai-defaults
 * Returns the canonical DEFAULT_AI_SETTINGS so the frontend can show them
 * without making per-shop DB reads.
 */
const getAiDefaults = async (req, res, next) => {
    try {
        const defaults = shopService.getAiDefaults();
        res.status(200).json({ success: true, data: defaults });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /shop/branding-preset
 * Apply a named branding preset to the shop's AI settings.
 * Body: { preset: 'FRIENDLY' | 'PROFESSIONAL' | 'FUN' }
 */
const applyBrandingPreset = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);

        const { preset } = req.body;
        if (!preset) throw new AppError('preset is required', 400);

        const branding = await shopService.applyBrandingPreset(shopId, preset.toUpperCase());
        res.status(200).json({ success: true, data: branding });
    } catch (error) {
        next(error);
    }
};

// ---------------------------------------------------------------------------
// BD Settings (Bangladesh-specific MFS + Google Sheets config)
// ---------------------------------------------------------------------------

const getBdSettings = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);
        const settings = await getBdSettingsHelper(shopId);
        res.status(200).json({ success: true, data: settings });
    } catch (error) {
        next(error);
    }
};

const updateBdSettings = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) throw new AppError('No shop selected', 400);
        const updated = await updateBdSettingsHelper(shopId, req.body);
        res.status(200).json({ success: true, data: updated });
    } catch (error) {
        next(error);
    }
};

const getShopAgents = async (req, res, next) => {
    try {
        // Tenant scope comes from the verified access token. Do not accept
        // X-Shop-ID here: this endpoint returns member PII and has no separate
        // membership check for an arbitrary header-supplied shop.
        const shopId = req.user?.shopId;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Shop ID required' } });
        }
        const { UserShop, User } = require('../entities');
        const members = await UserShop.findAll({
            where: { shop_id: shopId, is_active: true },
            include: [{ model: User, as: 'user', attributes: ['id', 'full_name', 'email'] }]
        });
        const agents = members.map((m) => ({
            id: m.user.id,
            name: m.user.full_name,
            email: m.user.email,
            role: m.role
        }));
        res.json({ success: true, data: agents });
    } catch (error) {
        next(error);
    }
};

const getPlatformPriority = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        // Persisted inside the shops.settings JSONB column. The dedicated
        // payment_platform_priority / delivery_platform_priority columns were never
        // migrated into the live schema (that migration was archived), so SELECTing
        // them threw "column does not exist" → 500. settings always exists.
        const shop = await Shop.findByPk(shopId, { attributes: ['settings'] });
        if (!shop) return res.status(404).json({ success: false, message: 'Shop not found' });
        const settings = shop.settings || {};
        res.json({
            success: true,
            data: {
                payment: settings.payment_platform_priority || [],
                delivery: settings.delivery_platform_priority || []
            }
        });
    } catch (error) {
        next(error);
    }
};

const updatePlatformPriority = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const { payment, delivery } = req.body;
        if (!Array.isArray(payment) || !Array.isArray(delivery)) {
            return res.status(400).json({ success: false, message: 'payment and delivery must be arrays' });
        }
        const updateResult = await Shop.sequelize.transaction(async (transaction) => {
            const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
            if (!shop) return { missing: true };

            if (delivery.length > 0) {
                const integrations = await DeliveryIntegration.findAll({
                    where: { shop_id: shopId, is_active: true, is_connected: true },
                    attributes: ['provider'],
                    transaction,
                });
                const connectedProviders = new Set(integrations.map((integration) => integration.provider));
                const invalidProvider = delivery.find((provider) => !connectedProviders.has(provider));
                if (invalidProvider !== undefined) return { invalidProvider };
            }

            await shop.update({
                settings: mergeSettingsPreservingRtoConsent(shop.settings || {}, {
                    payment_platform_priority: payment,
                    delivery_platform_priority: delivery,
                }),
            }, { transaction });
            return { updated: true };
        });
        if (updateResult.missing) return res.status(404).json({ success: false, message: 'Shop not found' });
        if (updateResult.invalidProvider !== undefined) {
            return res.status(400).json({
                success: false,
                message: `Delivery priority provider is not active and connected: ${updateResult.invalidProvider}`
            });
        }
        await invalidateShopSettingsCaches(shopId);
        res.json({ success: true, data: { payment, delivery } });
    } catch (error) {
        next(error);
    }
};

const getAIDiagnostics = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const { MetaChannel, PolicyDecision } = require('../entities');

        // Shop-level effective AI settings
        const shopAI = await shopService.getShopAiSettings(shopId);

        // All connected channels. Legacy Page AI settings are intentionally not
        // read here; the business mode above is the only automation authority.
        const channels = await MetaChannel.findAll({
            where: { shop_id: shopId, status: 'CONNECTED' },
            attributes: [
                'id',
                'display_name',
                'platform',
                'meta_asset_id',
                'status',
                'webhook_subscribed_fields',
                'webhook_last_verified_at',
                'page_access_token_ct',
            ],
        });
        const channelDiagnostics = channels.map((ch) => ({
            channel_id: ch.id,
            display_name: ch.display_name,
            platform: ch.platform,
            meta_asset_id: ch.meta_asset_id,
            status: ch.status,
            token_present: Boolean(ch.getDataValue('page_access_token_ct')),
            webhook_subscribed_fields: ch.webhook_subscribed_fields || [],
            webhook_last_verified_at: ch.webhook_last_verified_at,
        }));

        // Last 5 policy decisions for this shop (shows what's blocking)
        const decisions = await PolicyDecision.findAll({
            where: { shop_id: shopId },
            order: [['created_at', 'DESC']],
            limit: 5,
            attributes: ['allow', 'reason', 'platform', 'created_at'],
        });

        // BullMQ queue stats
        let queueStats = null;
        try {
            const { messageQueue } = require('../../jobs/message-queue');
            queueStats = await messageQueue.getJobCounts('waiting', 'active', 'failed', 'delayed');
        } catch (_) { /* Redis unavailable */ }

        res.json({
            success: true,
            data: {
                worker_queue: queueStats,
                shop_automation_mode: normalizeAiReplyMode(shopAI?.automation_mode),
                shop_auto_reply_enabled: shopAI.auto_reply_enabled,
                channels: channelDiagnostics,
                recent_policy_decisions: decisions.map(d => ({
                    allow: d.allow,
                    reason: d.reason,
                    platform: d.platform,
                    created_at: d.created_at,
                })),
            },
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getUserShops,
    getShop,
    createShop,
    updateShop,
    deleteShop,
    addUserToShop,
    removeUserFromShop,
    updateUserRole,
    getBusinessInfo,
    updateBusinessInfo,
    getOnboardingStatus,
    completeOnboarding,
    getLLMConfig,
    updateLLMConfig,
    getAISettings,
    updateAISettings,
    getIntentThresholds,
    updateIntentThresholds,
    getAiDefaults,
    applyBrandingPreset,
    getBdSettings,
    updateBdSettings,
    getShopAgents,
    getPlatformPriority,
    updatePlatformPriority,
    getAIDiagnostics,
    getShopPlanCode,
};
