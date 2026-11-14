/**
 * meta-channel.controller.js
 *
 * Canonical channel CRUD/lifecycle controller for /api/channels/meta/*.
 * Reads exclusively from meta_channels via MetaChannelService (single source of truth).
 *
 * Endpoints:
 *   GET    /api/channels/meta
 *   POST   /api/channels/meta/:channelId/disconnect
 *   POST   /api/channels/meta/:channelId/reconnect
 *   POST   /api/channels/meta/:channelId/test-webhook
 */

'use strict';

const { Op } = require('sequelize');
const MetaChannel = require('./meta-channel.entity');
const MetaChannelSettings = require('./meta-channel-settings.entity');
const MetaChannelConsentEvent = require('./meta-channel-consent-event.entity');
const { DEFAULT_AI_SETTINGS } = require('../shop/shop-defaults');
const {
    resolveChannelAutomation,
    loadEffectiveChannelAutomation,
    readEmergencyStopState,
} = require('./channel-automation.resolver');
const metaChannelService = require('./meta-channel.service');
const oauthService = require('./meta-oauth.service');
const { getProvider } = require('./provider.registry');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const { serializeChannel } = require('./meta-channel.serializer');

const logger = createLogger('MetaChannelController');

async function assertChannelBelongsToShop(channelId, shopId) {
    const row = await MetaChannel.findByPk(channelId);
    if (!row) throw new AppError('Channel not found', 404);
    // Cross-shop access is a 404 (API_CONTRACT §2): never reveal that another
    // shop's channel exists. Matches the service/loader fail-closed convention.
    if (row.shop_id !== shopId) throw new AppError('Channel not found', 404);
    return row;
}

/**
 * GET /api/channels/meta
 * Lists this shop's meta channels with the additive effective-mode fields.
 * One batched resolver pass: a single Shop read + one settings findAll.
 */
exports.list = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const channels = await metaChannelService.listByShop(shopId);
        const channelIds = (channels || []).map((channel) => channel.id);

        // Lazy require keeps the controller loadable in tests that stub the
        // model registry.
        const { Shop, Subscription } = require('../entities');
        const [settingsRows, shop, subscription] = await Promise.all([
            channelIds.length > 0
                ? MetaChannelSettings.findAll({ where: { channel_id: { [Op.in]: channelIds } } })
                : Promise.resolve([]),
            Shop.findByPk(shopId),
            Subscription.findOne({ where: { shop_id: shopId }, attributes: ['status'] }).catch(() => null),
        ]);

        const settingsByChannel = new Map(
            (settingsRows || []).map((row) => [String(row.channel_id), row]),
        );
        const emergencyStop = readEmergencyStopState(shop);
        const shopAiSettings = shop
            ? { ...DEFAULT_AI_SETTINGS, ...(shop.settings?.ai || {}) }
            : null;
        const { isAiActive } = require('../subscription/subscription.access');
        // Fail closed (ADR-0011 C5): a missing subscription row blocks AI at the
        // worker (subscription_missing), so the UI must not show AUTO effective.
        const billingAiActive = subscription ? isAiActive(subscription) : false;

        const data = (channels || []).map((channel) => {
            const settingsRow = settingsByChannel.get(String(channel.id));
            let resolved = null;
            try {
                resolved = resolveChannelAutomation({
                    shopAiSettings,
                    channelSettings: settingsRow || {
                        business_hours: null,
                        allow_order_creation: true,
                        purpose_label: channel.settings?.purpose_label ?? null,
                    },
                    emergencyStop,
                    shopIsActive: shop ? shop.is_active !== false : true,
                });
            } catch (_) {
                resolved = null;
            }
            return {
                ...serializeChannel(channel),
                effective_mode: resolved?.mode ?? 'MANUAL',
                mode_source: resolved?.modeSource ?? 'fail_closed',
                override_count: Object.keys(resolved?.overrides || {}).length,
                warnings: resolved?.warnings || [],
                emergency_stop: serializeEmergencyStop(emergencyStop),
                billing_ai_active: billingAiActive,
            };
        });

        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/channels/meta/:channelId/disconnect
 * Marks status=DISCONNECTED, clears the encrypted token, and best-effort
 * unsubscribes the page from the Meta App's webhook subscription. The row
 * is preserved for audit history.
 */
exports.disconnect = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId } = req.user;
        const channel = await assertChannelBelongsToShop(channelId, shopId);

        // Best-effort webhook unsubscribe before we lose the token.
        if (channel.page_access_token_ct && channel.meta_asset_id) {
            try {
                const provider = getProvider(channel.platform);
                await provider.unsubscribeWebhook({ channel });
                logger.info('Webhook unsubscribed', { channelId, platform: channel.platform });
            } catch (err) {
                // Non-fatal — the token may already be revoked Meta-side.
                logger.warn('Webhook unsubscribe failed (non-fatal)', {
                    channelId,
                    err: err.message,
                });
            }
        }

        const updated = await metaChannelService.disconnect(channelId);
        res.json({ success: true, data: serializeChannel(updated) });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/channels/meta/:channelId/reconnect
 * Generates a fresh OAuth initiate URL with the channelId baked into state,
 * so the OAuth callback page can route the user back to the right channel.
 * The actual asset-reconnect happens through the normal connect-asset flow —
 * upsertFromOAuth updates the existing row in place when the same
 * (shop_id, platform) pair already exists.
 */
exports.reconnect = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { userId, shopId } = req.user;
        const channel = await assertChannelBelongsToShop(channelId, shopId);

        const { redirectUrl, state } = await oauthService.initiateOAuth(
            userId,
            shopId,
            channel.platform,
            {
                targetChannelId: channel.id,
                targetAssetId: channel.meta_asset_id,
            },
        );

        logger.info('Reconnect initiated', { channelId, platform: channel.platform });
        res.json({
            success: true,
            data: {
                redirectUrl,
                state,
                channelId: channel.id,
                platform: channel.platform,
            },
        });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/channels/meta/:channelId/consent-summary
 * Aggregate opt-in / opt-out counts and the 10 most recent consent events for
 * this channel. Used by the Channels UI to surface compliance state at a glance.
 */
exports.consentSummary = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId } = req.user;
        await assertChannelBelongsToShop(channelId, shopId);

        const [optIns, optOuts, deauths, dataDeletions, recent] = await Promise.all([
            MetaChannelConsentEvent.count({
                where: { channel_id: channelId, event: { [Op.in]: ['OPT_IN_IMPLICIT', 'OPT_IN_EXPLICIT'] } },
            }),
            MetaChannelConsentEvent.count({
                where: { channel_id: channelId, event: 'OPT_OUT' },
            }),
            MetaChannelConsentEvent.count({
                where: { channel_id: channelId, event: 'DEAUTHORIZED' },
            }),
            MetaChannelConsentEvent.count({
                where: { channel_id: channelId, event: 'DATA_DELETED' },
            }),
            MetaChannelConsentEvent.findAll({
                where: { channel_id: channelId },
                order: [['created_at', 'DESC']],
                limit: 10,
            }),
        ]);

        res.json({
            success: true,
            data: {
                channelId,
                counts: {
                    optIns,
                    optOuts,
                    deauthorized: deauths,
                    dataDeleted: dataDeletions,
                },
                recentEvents: recent.map((e) => ({
                    id: e.id,
                    event: e.event,
                    source: e.source,
                    customerId: e.customer_id,
                    metadata: e.metadata,
                    createdAt: e.created_at,
                })),
            },
        });
    } catch (err) {
        next(err);
    }
};

const SETTINGS_WHITELIST = [
    'confidence_threshold_send', 'confidence_threshold_suggest',
    'business_hours',
    'allow_order_creation',
    'purpose_label',
];

const UNSUPPORTED_PAGE_SETTINGS = new Set([
    'aiAutoReply',
    'automationMode',
    'ai_auto_reply',
    'automation_mode',
]);

function assertNoUnsupportedPageSettings(body) {
    const unsupportedKey = Object.keys(body || {}).find((key) => UNSUPPORTED_PAGE_SETTINGS.has(key));
    if (unsupportedKey) {
        throw new AppError(
            `${unsupportedKey} is not supported for Page settings; configure the business AI reply mode instead`,
            400,
            'VALIDATION_ERROR'
        );
    }
}

function serializeEmergencyStop(state) {
    return {
        active: state?.active === true,
        at: state?.at ?? null,
        by: state?.by ?? null,
        source: state?.source ?? null,
        prior_mode: state?.prior_mode ?? null,
    };
}

function fallbackEffective(settings) {
    return {
        automation_mode: 'MANUAL',
        confidence_threshold: DEFAULT_AI_SETTINGS.confidence_threshold,
        greeting: { ...DEFAULT_AI_SETTINGS.greeting },
        business_hours: settings?.business_hours ?? null,
        allow_order_creation: settings?.allow_order_creation !== false,
        purpose_label: settings?.purpose_label ?? null,
    };
}

function serializeSettings(settings, resolved) {
    if (!settings) return null;
    const effective = resolved?.effective || fallbackEffective(settings);
    return {
        confidenceThresholdSend:    parseFloat(settings.confidence_threshold_send),
        confidenceThresholdSuggest: parseFloat(settings.confidence_threshold_suggest),
        businessHours:              settings.business_hours ?? null,
        allowOrderCreation:         settings.allow_order_creation,
        purposeLabel:               settings.purpose_label ?? null,
        // Additive effective-config fields (API_CONTRACT §2).
        overrides:                  resolved?.overrides || {},
        effective: {
            automation_mode:      effective.automation_mode,
            confidence_threshold: effective.confidence_threshold,
            greeting:             effective.greeting,
            business_hours:       effective.business_hours,
            allow_order_creation: effective.allow_order_creation,
            purpose_label:        effective.purpose_label,
        },
        mode_source:                resolved?.modeSource || 'fail_closed',
        warnings:                   resolved?.warnings || [],
        emergency_stop:             serializeEmergencyStop(resolved?.emergencyStop),
        billing_ai_active:          resolved ? resolved.billingAiActive === true : false,
        // Legacy dead thresholds: accepted for old clients, never rendered by the new UI.
        deprecated_fields:          ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
    };
}

async function loadSettingsState(shopId, channelId) {
    try {
        return await loadEffectiveChannelAutomation(shopId, channelId);
    } catch (_) {
        // Display reads never fail the request on a transient shop-read error;
        // they surface fail-closed mode_source instead.
        return null;
    }
}

/**
 * GET /api/channels/meta/:channelId/settings
 */
exports.getSettings = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId } = req.user;
        await assertChannelBelongsToShop(channelId, shopId);
        const settings = await metaChannelService.getSettings(channelId, { shopId });
        const resolved = await loadSettingsState(shopId, channelId);
        res.json({ success: true, data: serializeSettings(settings, resolved) });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/channels/meta/:channelId/settings
 * Accepts camelCase keys (frontend-friendly); converts to snake_case before writing.
 */
exports.updateChannelSettings = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId, userId } = req.user;
        await assertChannelBelongsToShop(channelId, shopId);
        assertNoUnsupportedPageSettings(req.body);

        const camelToSnake = {
            confidenceThresholdSend: 'confidence_threshold_send',
            confidenceThresholdSuggest: 'confidence_threshold_suggest',
            businessHours: 'business_hours',
            allowOrderCreation: 'allow_order_creation',
            purposeLabel: 'purpose_label',
        };

        const patch = {};
        for (const [camel, snake] of Object.entries(camelToSnake)) {
            if (req.body[camel] !== undefined) patch[snake] = req.body[camel];
        }
        // also accept snake_case keys directly
        for (const key of SETTINGS_WHITELIST) {
            if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        // Overrides are merged server-side (never wholesale-replaced).
        if (req.body.overrides !== undefined) patch.overrides = req.body.overrides;

        if (Object.keys(patch).length === 0) {
            const settings = await metaChannelService.getSettings(channelId, { shopId });
            const resolved = await loadSettingsState(shopId, channelId);
            return res.json({ success: true, data: serializeSettings(settings, resolved) });
        }

        await metaChannelService.updateSettings(channelId, patch, { shopId, userId });
        const updated = await metaChannelService.getSettings(channelId, { shopId });
        const resolved = await loadSettingsState(shopId, channelId);
        res.json({ success: true, data: serializeSettings(updated, resolved) });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/channels/meta/:channelId/purpose-label
 * Cosmetic per-channel label that lets a merchant disambiguate multiple
 * Pages/IG accounts (e.g. "Sales", "Live selling", "Regional"). Display only —
 * does not affect AI routing or product scope.
 *
 * Body: { purposeLabel: string|null }  (empty string or null clears the label)
 */
exports.updatePurposeLabel = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId } = req.user;
        await assertChannelBelongsToShop(channelId, shopId);

        const raw = req.body.purposeLabel;
        const normalized = (raw === '' || raw === undefined) ? null : raw;

        await metaChannelService.updateSettings(channelId, { purpose_label: normalized }, { shopId });

        // Re-fetch the channel with settings JOIN so the response carries the
        // updated label in the same shape as GET /api/channels/meta.
        const refreshed = await MetaChannel.findByPk(channelId, {
            include: [{
                model: MetaChannelSettings,
                as: 'settings',
                attributes: ['purpose_label'],
                required: false,
            }],
        });

        res.json({ success: true, data: serializeChannel(refreshed) });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/channels/meta/:channelId/test-webhook
 * Verifies the Page's subscribed_apps state using the approved Page permission
 * contract. It deliberately does not read the Page node as a health probe.
 */
exports.testWebhook = async (req, res, next) => {
    try {
        const { channelId } = req.params;
        const { shopId } = req.user;
        const channel = await assertChannelBelongsToShop(channelId, shopId);
        const repairSubscription = req.body?.repairSubscription === true;

        const provider = getProvider(channel.platform);
        const requiredFields = typeof provider.webhookFields === 'function'
            ? provider.webhookFields()
            : ['messages'];
        const verificationStartedAt = Date.now();
        const channelConnectionOk = channel.status === 'CONNECTED'
            && Boolean(channel.page_access_token_ct)
            && Boolean(channel.meta_asset_id);
        let subscriptionResult = channelConnectionOk
            ? await provider.verifyWebhookSubscription({ channel }).catch((err) => ({
                ok: false,
                fields: [],
                error: 'verification_failed',
            }))
            : { ok: false, fields: [], error: 'channel_not_connected' };
        let repaired = false;

        if (channelConnectionOk && !subscriptionResult.ok && repairSubscription) {
            await provider.subscribeWebhook({ channel });
            repaired = true;
            subscriptionResult = await provider.verifyWebhookSubscription({ channel }).catch((err) => ({
                ok: false,
                fields: [],
                error: 'verification_failed',
            }));
        }

        if (subscriptionResult.ok) {
            await metaChannelService.confirmWebhookActive(channelId, subscriptionResult.fields);
        }

        const healthResult = {
            ok: subscriptionResult.ok,
            latencyMs: Date.now() - verificationStartedAt,
            ...(subscriptionResult.error ? { error: subscriptionResult.error } : {}),
        };

        res.json({
            success: true,
            data: {
                channelId,
                platform: channel.platform,
                // Backward-compatible alias for the existing UI client. This
                // is now subscribed_apps verification, not a Page-node read.
                ping: healthResult,
                connection: {
                    ok: channelConnectionOk,
                    status: channel.status,
                },
                subscription: {
                    ok: subscriptionResult.ok,
                    fields: subscriptionResult.fields || [],
                    requiredFields,
                    repaired,
                },
                transport: {
                    status: 'NOT_PROBED',
                    reason: 'requires an inbound Messenger event',
                },
                checkedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        next(err);
    }
};
