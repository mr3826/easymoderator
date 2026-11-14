/**
 * MetaChannelService
 *
 * Singleton CRUD entry point for the meta_channels table.
 * All methods are scoped by shop_id for multi-tenant safety.
 *
 * Dual-write intent: called AFTER legacy writes succeed so the legacy
 * path can continue to function during the Phase 1-5 transition.
 *
 * Token encryption is handled transparently by the MetaChannel entity's
 * virtual getter/setter — callers pass and receive plaintext tokens.
 */

'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const MetaChannel = require('./meta-channel.entity');
const MetaChannelSettings = require('./meta-channel-settings.entity');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const { drainChannelJobs } = require('../../jobs/message-queue');
const { VALID_STATUSES } = require('./meta-channel.statuses');
const { normalizeAiReplyMode } = require('../shop/ai-reply-mode');
const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');
const {
    canonicalizeOverrideMode,
    canonicalizeOverrideThreshold,
    canonicalizeOverrideGreeting,
    isModeWithinCeiling,
} = require('./channel-automation.resolver');

const logger = createLogger('MetaChannelService');

const REASSIGNED_LAST_ERROR = 'reassigned_to_new_shop_after_fresh_meta_oauth';

/** Channel-native (non-override) settings the PATCH endpoint may write. */
const SETTINGS_ALLOWED_KEYS = Object.freeze([
    'confidence_threshold_send',
    'confidence_threshold_suggest',
    'business_hours',
    'allow_order_creation',
    'purpose_label',
]);

/** The only keys accepted inside `overrides` (ADR-0013 §2). */
const OVERRIDE_ALLOWED_KEYS = Object.freeze(['automation_mode', 'confidence_threshold', 'greeting']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const canonicalizeStoredOverrides = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const key of OVERRIDE_ALLOWED_KEYS) {
        if (!hasOwn(raw, key)) continue;
        const value = raw[key];
        if (value === null || value === undefined) continue;
        const canonical = key === 'automation_mode'
            ? canonicalizeOverrideMode(value)
            : key === 'confidence_threshold'
                ? canonicalizeOverrideThreshold(value)
                : canonicalizeOverrideGreeting(value);
        if (canonical !== null) out[key] = canonical;
    }
    return out;
};

/**
 * Validate and canonicalize an incoming `overrides` object.
 * Per-key `null` is preserved as a revert marker.
 * @throws {AppError} OVERRIDE_KEY_FORBIDDEN / INVALID_OVERRIDE_VALUE
 */
const canonicalizeOverridePatch = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new AppError('overrides must be an object', 400, 'INVALID_OVERRIDE_VALUE');
    }
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (!OVERRIDE_ALLOWED_KEYS.includes(key)) {
            throw new AppError(`Override key "${key}" is not supported`, 400, 'OVERRIDE_KEY_FORBIDDEN');
        }
        if (value === null) {
            out[key] = null;
            continue;
        }
        const canonical = key === 'automation_mode'
            ? canonicalizeOverrideMode(value)
            : key === 'confidence_threshold'
                ? canonicalizeOverrideThreshold(value)
                : canonicalizeOverrideGreeting(value);
        if (canonical === null) {
            throw new AppError(`Invalid value for override "${key}"`, 400, 'INVALID_OVERRIDE_VALUE');
        }
        out[key] = canonical;
    }
    return out;
};

const emitChannelSettingsChanged = async (shopId, channelId, fallbackOverrides) => {
    try {
        const { loadEffectiveChannelAutomation } = require('./channel-automation.resolver');
        const state = await loadEffectiveChannelAutomation(shopId, channelId);
        const sseManager = require('../../utils/sse-manager');
        sseManager.emit(shopId, 'channel_settings_changed', {
            channel_id: channelId,
            effective_mode: state?.mode ?? 'MANUAL',
            mode_source: state?.modeSource ?? 'fail_closed',
            override_keys: Object.keys(state?.overrides || fallbackOverrides || {}),
        });
    } catch (error) {
        logger.warn('Failed to publish channel settings change', {
            channelId,
            error: error.message,
        });
    }
};

function sameId(a, b) {
    return a && b && String(a) === String(b);
}

function normalizePlatform(platform) {
    if (platform === 'facebook' || platform === 'messenger') return 'facebook';
    return null;
}

async function lockMetaAssetClaim(transaction, metaAssetId) {
    if (typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') return;
    if (typeof sequelize.query !== 'function') return;

    // Serialize connects for the same Page before the cross-tenant lookup. The
    // per-shop unique index cannot prevent two shops from winning a race.
    await sequelize.query(
        'SELECT pg_advisory_xact_lock(hashtext(:lockKey))',
        {
            replacements: { lockKey: `easymod:meta-channel:${metaAssetId}` },
            transaction,
        },
    );
}

function canReleaseCrossShopClaim(channel) {
    if (!channel) return false;
    // Only an explicit disconnect relinquishes a claim. A broken connection
    // can still belong to its merchant and must not be taken over silently.
    if (channel.status === 'DISCONNECTED') return true;
    return false;
}

class MetaChannelService {

    /**
     * Upsert a MetaChannel row from an OAuth connect flow, and create a default
     * MetaChannelSettings row if one does not already exist.
     *
     * @param {object} params
     * @param {string} params.shopId
     * @param {string} params.userId             - User who completed OAuth
     * @param {'facebook'} params.platform
     * @param {string} params.metaAssetId        - Facebook Page ID
     * @param {string} params.displayName
     * @param {string|null} params.pictureUrl
     * @param {string} params.pageAccessToken     - Plaintext token (entity setter encrypts it)
     * @param {Date|null} params.tokenExpiresAt
     * @param {string|null} params.webhookVerifyToken
     * @param {string[]|null} params.webhookSubscribedFields
     * @returns {Promise<MetaChannel>}
     */
    async upsertFromOAuth({
        shopId,
        userId,
        platform,
        metaAssetId,
        displayName,
        pictureUrl = null,
        pageAccessToken,
        tokenExpiresAt = null,
        webhookVerifyToken = null,
        webhookSubscribedFields = []
    }) {
        if (!shopId) throw new Error('MetaChannelService.upsertFromOAuth: shopId is required');
        if (!platform) throw new Error('MetaChannelService.upsertFromOAuth: platform is required');
        if (!metaAssetId) throw new Error('MetaChannelService.upsertFromOAuth: metaAssetId is required');

        const transaction = await sequelize.transaction();
        let committed = false;
        let channel = null;
        const releasedConflictingChannels = [];
        try {
            const now = new Date();
            await lockMetaAssetClaim(transaction, metaAssetId);
            // Check if this asset is claimed by a different shop (cross-shop guard).
            // Only explicitly disconnected claims can be released after fresh
            // Meta OAuth. Missing connector audit data is not ownership proof.
            const conflictingChannels = await MetaChannel.findAll({
                where: {
                    meta_asset_id: metaAssetId,
                    shop_id: { [Op.ne]: shopId }
                },
                transaction
            });
            const blockingConflict = conflictingChannels.find((existing) => (
                !canReleaseCrossShopClaim(existing)
            ));
            if (blockingConflict) {
                throw new AppError(
                    'This Facebook Page is already connected to another EasyModerator shop. Disconnect it there first, or ask support to release the old connection.',
                    409,
                    'META_ASSET_ALREADY_CONNECTED',
                    {
                        metaAssetId,
                        conflictingChannelId: blockingConflict.id,
                        conflictingShopId: blockingConflict.shop_id,
                    }
                );
            }

            for (const existing of conflictingChannels) {
                const previousStatus = existing.status;
                existing.status = 'DISCONNECTED';
                existing.page_access_token_ct = null;
                existing.disconnected_at = now;
                existing.last_error = REASSIGNED_LAST_ERROR;
                await existing.save({ transaction });
                releasedConflictingChannels.push({
                    id: existing.id,
                    shop_id: existing.shop_id,
                    platform: existing.platform,
                    previousStatus,
                });
            }

            // Phase 1: upsert on (shop_id, meta_asset_id). A second page of the
            // same platform now creates a new row instead of overwriting the first.
            // Reconnecting the same page still updates in place.
            channel = await MetaChannel.findOne({
                where: { shop_id: shopId, meta_asset_id: metaAssetId },
                transaction
            });

            if (channel) {
                // Update existing row — entity setter encrypts token automatically
                channel.meta_asset_id = metaAssetId;
                channel.display_name = displayName;
                channel.picture_url = pictureUrl;
                // Trigger setter (encryption) only when token provided
                if (pageAccessToken) {
                    channel.page_access_token_ct = pageAccessToken;
                }
                channel.token_expires_at = tokenExpiresAt;
                channel.token_last_refreshed_at = now;
                channel.token_refresh_attempts = 0;
                if (webhookVerifyToken) {
                    channel.webhook_verify_token = webhookVerifyToken;
                }
                if (webhookSubscribedFields && webhookSubscribedFields.length > 0) {
                    channel.webhook_subscribed_fields = webhookSubscribedFields;
                }
                channel.status = 'CONNECTED';
                channel.last_error = null;
                channel.connected_by_user_id = userId;
                channel.connected_at = now;
                channel.disconnected_at = null;
                await channel.save({ transaction });
            } else {
                // Create new row
                channel = await MetaChannel.create({
                    shop_id: shopId,
                    platform,
                    meta_asset_id: metaAssetId,
                    display_name: displayName,
                    picture_url: pictureUrl,
                    page_access_token_ct: pageAccessToken,  // setter encrypts
                    token_expires_at: tokenExpiresAt,
                    token_last_refreshed_at: now,
                    token_refresh_attempts: 0,
                    webhook_verify_token: webhookVerifyToken,
                    webhook_subscribed_fields: webhookSubscribedFields || [],
                    status: 'CONNECTED',
                    connected_by_user_id: userId,
                    connected_at: now
                }, { transaction });
            }

            // Create default settings row if missing (idempotent)
            const [, created] = await MetaChannelSettings.findOrCreate({
                where: { channel_id: channel.id },
                defaults: { channel_id: channel.id },
                transaction
            });
            if (created) {
                logger.info('MetaChannelService: created default settings', { channelId: channel.id });
            }

            await transaction.commit();
            committed = true;
        } catch (err) {
            if (!committed) {
                await transaction.rollback();
            }
            // Expand Sequelize ValidationError/UniqueConstraintError so the
            // log line names the offending field instead of the parent
            // "Validation error" summary, which is useless on its own.
            const fields = Array.isArray(err.errors)
                ? err.errors.map(e => ({ path: e.path, message: e.message, validatorKey: e.validatorKey }))
                : undefined;
            logger.error('MetaChannelService.upsertFromOAuth: failed', {
                error: err.message,
                errorName: err.name,
                fields,
                shopId,
                platform,
                metaAssetId,
            });
            throw err;
        }

        for (const released of releasedConflictingChannels) {
            try {
                const { removed } = await drainChannelJobs({
                    metaChannelId: released.id,
                    shopId: released.shop_id,
                    platform: released.platform,
                });
                logger.info('MetaChannelService.upsertFromOAuth: drained reassigned channel jobs', {
                    releasedChannelId: released.id,
                    previousShopId: released.shop_id,
                    queueJobsDrained: removed,
                });
            } catch (drainErr) {
                logger.warn('MetaChannelService.upsertFromOAuth: failed to drain reassigned channel jobs', {
                    releasedChannelId: released.id,
                    previousShopId: released.shop_id,
                    error: drainErr.message,
                });
            }
        }

        logger.info('MetaChannelService.upsertFromOAuth: success', {
            channelId: channel.id,
            shopId,
            platform,
            metaAssetId,
            releasedCrossShopClaims: releasedConflictingChannels.length,
        });
        return channel;
    }

    /**
     * Resolve a connected channel by its exact primary key and verify every
     * routing fact supplied by the caller. A failed exact lookup is terminal for
     * that routing attempt; callers must not substitute a shop-wide channel.
     *
     * @param {string} channelId
     * @param {object} [scope]
     * @param {string} scope.shopId
     * @param {string} scope.platform - 'facebook' or legacy 'messenger'
     * @param {string} [scope.metaAssetId] - Expected Facebook Page ID
     * @returns {Promise<MetaChannel|null>}
     */
    async findConnectedById(channelId, { shopId = null, platform = null, metaAssetId = null } = {}) {
        if (!channelId || !shopId || !platform) return null;

        const channel = await MetaChannel.findByPk(channelId);
        if (!channel || channel.status !== 'CONNECTED') return null;
        if (!sameId(channel.shop_id, shopId)) return null;

        const expectedPlatform = normalizePlatform(platform);
        if (!expectedPlatform || channel.platform !== expectedPlatform) return null;
        if (metaAssetId && !sameId(channel.meta_asset_id, metaAssetId)) return null;

        return channel;
    }

    /**
     * Resolve the only connected channel for a shop and platform.
     *
     * A shop may own multiple Facebook Pages. This method is deliberately
     * unique-or-null so a legacy caller can continue only when the routing
     * target is unambiguous.
     *
     * @param {string} shopId
     * @param {'facebook'|'messenger'} platform
     * @returns {Promise<MetaChannel|null>}
     */
    async findUniqueConnectedByShopAndPlatform(shopId, platform) {
        const normalizedPlatform = normalizePlatform(platform);
        if (!shopId || !normalizedPlatform) return null;

        const channels = await MetaChannel.findAll({
            where: { shop_id: shopId, platform: normalizedPlatform, status: 'CONNECTED' },
        });
        const connectedChannels = (Array.isArray(channels) ? channels : [])
            .filter((channel) => (
                channel?.status === 'CONNECTED' && channel.platform === normalizedPlatform
            ));
        if (connectedChannels.length === 1) return connectedChannels[0];

        logger.warn('MetaChannelService: unique connected channel resolution failed', {
            shopId,
            platform: normalizedPlatform,
            connectedCount: connectedChannels.length,
        });
        return null;
    }

    /**
     * Find a specific channel by (shop_id, meta_asset_id). This is the
     * unambiguous lookup after Phase 1 — a shop can own multiple channels
     * per platform, but each (shop, asset) pair is unique.
     *
     * @param {string} shopId
     * @param {string} metaAssetId
     * @returns {Promise<MetaChannel|null>}
     */
    async findByShopAndAsset(shopId, metaAssetId) {
        if (!shopId || !metaAssetId) return null;
        return MetaChannel.findOne({ where: { shop_id: shopId, meta_asset_id: metaAssetId } });
    }

    /**
     * List all channels for a shop on a given platform. Returns an empty
     * array when none exist. Use this when iterating over every connected
     * Page/IG account of a platform.
     *
     * @param {string} shopId
     * @param {'facebook'} platform
     * @returns {Promise<MetaChannel[]>}
     */
    async listByShopAndPlatform(shopId, platform) {
        if (!shopId || !platform) return [];
        return MetaChannel.findAll({
            where: { shop_id: shopId, platform },
            order: [['created_at', 'ASC']]
        });
    }

    /**
     * Find a channel by its Meta asset ID (Facebook Page ID).
     * Used by the webhook router to identify which shop owns an incoming event.
     *
     * @param {string} metaAssetId
     * @returns {Promise<MetaChannel|null>}
     */
    async findByMetaAssetId(metaAssetId) {
        if (!metaAssetId) return null;
        const channels = await MetaChannel.findAll({
            where: { meta_asset_id: metaAssetId, status: 'CONNECTED' },
        });
        const connectedChannels = (Array.isArray(channels) ? channels : [])
            .filter((channel) => channel?.status === 'CONNECTED');
        if (connectedChannels.length === 1) return connectedChannels[0];
        if (connectedChannels.length > 1) {
            logger.warn('MetaChannelService: multiple connected channels claim the same Meta asset', {
                metaAssetId,
                connectedCount: connectedChannels.length,
            });
        }
        return null;
    }

    /**
     * Find a channel by its webhook verify token.
     * Used during the Meta webhook GET handshake to identify the channel.
     *
     * @param {string} token
     * @returns {Promise<MetaChannel|null>}
     */
    async findByWebhookVerifyToken(token) {
        if (!token) return null;
        return MetaChannel.findOne({ where: { webhook_verify_token: token } });
    }

    /**
     * List all channels for a shop, ordered by creation time.
     *
     * @param {string} shopId
     * @param {object} [options]
     * @param {object} [options.transaction] - Existing Sequelize transaction
     * @returns {Promise<MetaChannel[]>}
     */
    async listByShop(shopId, { transaction = null } = {}) {
        if (!shopId) return [];
        const options = {
            where: { shop_id: shopId },
            order: [['created_at', 'ASC']],
            include: [{
                model: MetaChannelSettings,
                as: 'settings',
                attributes: ['purpose_label'],
                required: false
            }]
        };
        if (transaction) options.transaction = transaction;
        return MetaChannel.findAll(options);
    }

    /**
     * Update a channel's connection status with optional error message.
     * Status transitions are audited via the updated_at timestamp.
     *
     * @param {string} channelId
     * @param {'CONNECTED'|'TOKEN_EXPIRED'|'REVOKED'|'DISCONNECTED'|'ERROR'} status
     * @param {string|null} [lastError]
     * @param {object} [options]
     * @param {object} [options.transaction] - Existing Sequelize transaction
     * @param {string} [options.shopId] - Expected owning shop for scoped updates
     * @returns {Promise<MetaChannel>}
     */
    async updateStatus(channelId, status, lastError = null, options = {}) {
        // Support updateStatus(channelId, status, { transaction }) while
        // preserving the existing lastError positional argument.
        if (lastError && typeof lastError === 'object' && !Array.isArray(lastError)) {
            options = lastError;
            lastError = null;
        }
        const transaction = options?.transaction || null;
        const shopId = options?.shopId || null;
        if (!VALID_STATUSES.includes(status)) {
            throw new Error(`MetaChannelService.updateStatus: invalid status "${status}"`);
        }
        const channel = transaction
            ? await MetaChannel.findByPk(channelId, { transaction })
            : await MetaChannel.findByPk(channelId);
        if (!channel || (shopId && !sameId(channel.shop_id, shopId))) {
            throw new Error(`MetaChannelService.updateStatus: channel ${channelId} not found`);
        }

        channel.status = status;
        channel.last_error = lastError ?? null;
        if (status === 'DISCONNECTED') {
            channel.disconnected_at = new Date();
        }
        if (transaction) await channel.save({ transaction });
        else await channel.save();
        logger.info('MetaChannelService.updateStatus', { channelId, status });
        return channel;
    }

    /**
     * Confirm a channel's webhook is verified AND active. Performs three writes in
     * one save: stamps webhook_last_verified_at (now), (re)asserts status='CONNECTED',
     * and clears last_error. Call ONLY after verifyWebhookSubscription returns ok.
     *
     * @param {string} channelId
     * @param {string[]|null} webhookSubscribedFields
     * @returns {Promise<MetaChannel>}
     */
    async confirmWebhookActive(channelId, webhookSubscribedFields = null) {
        const channel = await MetaChannel.findByPk(channelId);
        if (!channel) throw new Error(`confirmWebhookActive: channel ${channelId} not found`);
        channel.webhook_last_verified_at = new Date();
        if (Array.isArray(webhookSubscribedFields)) {
            channel.webhook_subscribed_fields = [...new Set(webhookSubscribedFields)];
        }
        channel.status = 'CONNECTED';
        channel.last_error = null;
        await channel.save();
        logger.info('MetaChannelService.confirmWebhookActive', {
            channelId,
            webhookSubscribedFields: channel.webhook_subscribed_fields,
        });
        return channel;
    }

    /**
     * Update a channel's tokens (used by the token refresh job).
     * Resets refresh_attempts to 0 on success and stamps token_last_refreshed_at.
     *
     * @param {string} channelId
     * @param {object} params
     * @param {string} params.pageAccessToken  - New plaintext token
     * @param {Date|null} params.tokenExpiresAt
     * @returns {Promise<MetaChannel>}
     */
    async updateTokens(channelId, { pageAccessToken, tokenExpiresAt }) {
        const channel = await MetaChannel.findByPk(channelId);
        if (!channel) throw new Error(`MetaChannelService.updateTokens: channel ${channelId} not found`);

        channel.page_access_token_ct = pageAccessToken;  // entity setter encrypts
        channel.token_expires_at = tokenExpiresAt ?? null;
        channel.token_last_refreshed_at = new Date();
        channel.token_refresh_attempts = 0;
        channel.status = 'CONNECTED';
        channel.last_error = null;
        await channel.save();
        logger.info('MetaChannelService.updateTokens: success', { channelId });
        return channel;
    }

    /**
     * Disconnect a channel: set status to DISCONNECTED, clear the stored token,
     * and drain any pending message-processing queue jobs for this channel so
     * they don't keep retrying with a now-cleared token until they hit the DLQ.
     *
     * @param {string} channelId
     * @returns {Promise<MetaChannel>}
     */
    async disconnect(channelId, {
        status = 'DISCONNECTED',
        lastError = null,
    } = {}) {
        if (!VALID_STATUSES.includes(status)) {
            throw new Error(`MetaChannelService.disconnect: invalid status "${status}"`);
        }
        const channel = await MetaChannel.findByPk(channelId);
        if (!channel) throw new Error(`MetaChannelService.disconnect: channel ${channelId} not found`);

        channel.status = status;
        channel.page_access_token_ct = null;
        channel.token_expires_at = null;
        channel.disconnected_at = new Date();
        channel.last_error = lastError;
        await channel.save();

        // Best-effort: drain queued jobs for this channel. Non-fatal — if Redis
        // is temporarily unavailable the disconnect still succeeds and the jobs
        // will simply fail on their next attempt with a token-absent error.
        const { removed } = await drainChannelJobs({
            metaChannelId: channel.id,
            shopId: channel.shop_id,
            platform: channel.platform,
        });
        logger.info('MetaChannelService.disconnect', { channelId, queueJobsDrained: removed });
        return channel;
    }

    /**
     * Return MetaChannelSettings for a channel, creating a default row if missing.
     *
     * When `shopId` is supplied the channel's ownership is asserted
     * (defense-in-depth behind the controller); a missing or cross-shop channel
     * is a 404. Public API paths always supply it. Internal callers that have
     * already resolved the channel through tenant-scoped routing may omit it.
     *
     * @param {string} channelId
     * @param {{shopId?: string}} [options]
     * @returns {Promise<MetaChannelSettings>}
     */
    async getSettings(channelId, { shopId = null } = {}) {
        if (shopId) {
            const channel = await MetaChannel.findByPk(channelId, {
                attributes: ['id', 'shop_id'],
            });
            if (!channel || !sameId(channel.shop_id, shopId)) {
                throw new AppError('Channel not found', 404);
            }
        }
        const [settings] = await MetaChannelSettings.findOrCreate({
            where: { channel_id: channelId },
            defaults: { channel_id: channelId }
        });
        return settings;
    }

    /**
     * Partially update MetaChannelSettings for a channel.
     *
     * Overrides are applied as a row-locked read-modify-write merge: per-key
     * `null` reverts to inherit, sibling keys survive, stored values are
     * canonical, and the object is never wholesale-replaced or stored with
     * nulls. Automation-mode overrides are narrow-only versus the current
     * business default.
     *
     * @param {string} channelId
     * @param {object} patch - snake_case channel settings; may include `overrides`
     * @param {{shopId: string, userId?: string}} options
     * @returns {Promise<MetaChannelSettings>}
     */
    async updateSettings(channelId, patch = {}, { shopId = null, userId = null } = {}) {
        if (!shopId) {
            throw new AppError('shopId is required to update channel settings', 400);
        }
        const channel = await MetaChannel.findByPk(channelId, { attributes: ['id', 'shop_id'] });
        if (!channel || !sameId(channel.shop_id, shopId)) {
            throw new AppError('Channel not found', 404);
        }

        // `overrides: null` (or absent) means "no override changes".
        const patchHasOverrides = hasOwn(patch, 'overrides') && patch.overrides !== null;
        const canonicalPatch = patchHasOverrides ? canonicalizeOverridePatch(patch.overrides) : null;
        const touchesMode = Boolean(
            canonicalPatch && hasOwn(canonicalPatch, 'automation_mode') && canonicalPatch.automation_mode,
        );

        const legacyPatch = {};
        for (const key of SETTINGS_ALLOWED_KEYS) {
            if (hasOwn(patch, key)) legacyPatch[key] = patch[key];
        }

        const result = await sequelize.transaction(async (transaction) => {
            const [created] = await MetaChannelSettings.findOrCreate({
                where: { channel_id: channelId },
                defaults: { channel_id: channelId },
                transaction,
            });
            // Row lock serializes concurrent read-modify-write merges so sibling
            // overrides from two PATCHes both survive.
            const locked = await MetaChannelSettings.findByPk(channelId, {
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            const settings = locked || created;

            const oldOverrides = canonicalizeStoredOverrides(settings.overrides);
            let nextOverrides = { ...oldOverrides };
            let overridesChanged = false;

            if (canonicalPatch !== null) {
                for (const [key, value] of Object.entries(canonicalPatch)) {
                    if (value === null) {
                        if (hasOwn(nextOverrides, key)) {
                            delete nextOverrides[key];
                            overridesChanged = true;
                        }
                    } else if (nextOverrides[key] !== value) {
                        nextOverrides[key] = value;
                        overridesChanged = true;
                    }
                }
            }

            if (touchesMode) {
                const { getShopAiSettings } = require('../shop/shop.service');
                const aiSettings = await getShopAiSettings(shopId, { transaction });
                const businessMode = normalizeAiReplyMode(aiSettings?.automation_mode);
                if (!isModeWithinCeiling(canonicalPatch.automation_mode, businessMode)) {
                    throw new AppError(
                        `Channel automation mode cannot be less restrictive than the business default (${businessMode}); narrowing only`,
                        400,
                        'INVALID_OVERRIDE_WIDENING',
                    );
                }
            }

            const updatePayload = { ...legacyPatch };
            if (overridesChanged) {
                updatePayload.overrides = Object.keys(nextOverrides).length > 0
                    ? nextOverrides
                    : null;
            }

            if (Object.keys(updatePayload).length > 0) {
                await settings.update(updatePayload, { transaction });
            }

            if (overridesChanged) {
                const AuditService = require('../audit/audit.service');
                await AuditService.logOperation({
                    userId: userId || null,
                    shopId,
                    action: 'CHANNEL_AUTOMATION_OVERRIDE_CHANGED',
                    resourceType: 'META_CHANNEL_SETTINGS',
                    resourceId: channelId,
                    oldValues: {
                        overrides: Object.keys(oldOverrides).length > 0 ? oldOverrides : null,
                    },
                    newValues: {
                        overrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
                    },
                    metadata: { shop_id: shopId, channel_id: channelId },
                }, { transaction, required: true });
            }

            return { settings, nextOverrides, overridesChanged };
        });

        // API_CONTRACT §8: every settings write propagates (overrides AND
        // channel-native hours/order/label edits) so other open channel pages
        // and the inbox converge without a refresh.
        void invalidateShopSettingsCaches(shopId).catch(() => {});
        void emitChannelSettingsChanged(shopId, channelId, result.nextOverrides);

        logger.info('MetaChannelService.updateSettings', {
            channelId,
            keys: Object.keys(legacyPatch),
            overridesChanged: result.overridesChanged,
        });
        return result.settings;
    }
}

module.exports = new MetaChannelService();
