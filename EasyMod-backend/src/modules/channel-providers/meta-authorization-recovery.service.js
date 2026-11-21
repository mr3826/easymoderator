'use strict';

const crypto = require('crypto');
const {
    AuditLog,
    Customer,
    MetaChannel,
    MetaUserIdentity,
    OwnerNotification,
} = require('../entities');
const { getProvider } = require('./provider.registry');
const consentService = require('../consent/consent.service');
const { drainChannelJobs } = require('../../jobs/message-queue');
const { opsAlert } = require('../../utils/ops-alert');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger('MetaAuthorizationRecovery');

function anonymousIdentityId(appScopedUserId) {
    return crypto.createHash('sha256')
        .update(`meta-app-user:${appScopedUserId}`)
        .digest('hex');
}

async function writeAudit(action, channel, metadata = null) {
    await AuditLog.create({
        user_id: null,
        shop_id: channel?.shop_id || null,
        action,
        resource_type: channel ? 'meta_channel' : 'meta_app_user',
        resource_id: channel?.id || metadata.identity_hash,
        metadata,
        idempotency_key: channel
            ? `${action}:${channel.id}:${channel.status}`
            : `${action}:${metadata.identity_hash}`,
    });
}

async function notifyOwner(channel, reason) {
    await OwnerNotification.create({
        shop_id: channel.shop_id,
        type: 'meta_reconnect_required',
        customer_message: null,
        customer_data: {
            channelId: channel.id,
            pageId: channel.meta_asset_id,
            displayName: channel.display_name,
            reason,
            reconnectRequired: true,
        },
        status: 'pending',
    });
}

async function disableChannel(channel, {
    status,
    reason,
    auditAction,
    strictAudit = false,
    attemptUnsubscribe = true,
}) {
    const alreadyDisabled =
        channel.status === status
        && !channel.page_access_token_ct
        && channel.last_error === reason;
    if (alreadyDisabled) {
        // D2 self-heal: a channel disabled before webhook verification was
        // cleared may still carry a stale stamp. Clearing it here is idempotent
        // and does not re-run notifications, drains, or token mutations.
        if (channel.webhook_last_verified_at || (channel.webhook_subscribed_fields ?? []).length > 0) {
            await channel.update({
                webhook_last_verified_at: null,
                webhook_subscribed_fields: [],
            });
        }
        // A previous attempt may have disabled the channel and then failed its
        // strict compliance audit. Retry the audit without repeating external
        // notifications, queue drains, or token mutations.
        if (strictAudit) {
            await writeAudit(auditAction, channel, {
                reason,
                reconnect_required: true,
                repeated_callback: true,
            });
        }
        return { channel, changed: false, unsubscribeOk: null };
    }

    let unsubscribeOk = null;
    if (attemptUnsubscribe && channel.page_access_token_ct) {
        try {
            const result = await getProvider('facebook').unsubscribeWebhook({ channel });
            unsubscribeOk = result?.ok !== false;
        } catch (err) {
            unsubscribeOk = false;
            logger.warn('Meta webhook unsubscribe failed during authorization recovery', {
                channelId: channel.id,
                error: err.message,
            });
        }
    }

    // Channel connectivity is the token-loss kill switch. The legacy Page AI
    // settings are retained for compatibility but must not be used as runtime
    // authority or mutated by recovery.
    await channel.update({
        status,
        page_access_token_ct: null,
        token_expires_at: null,
        last_error: reason,
        disconnected_at: new Date(),
        // D2: revoked/expired channels must not keep a webhook verification
        // stamp — the health grid shows "Active" purely from it. The token and
        // (best-effort) Meta subscription are gone, so the stamp is no longer
        // ours to assert; a successful reconnect re-stamps it.
        webhook_last_verified_at: null,
        webhook_subscribed_fields: [],
    });

    try {
        await writeAudit(auditAction, channel, {
            reason,
            reconnect_required: true,
            webhook_unsubscribe_succeeded: unsubscribeOk,
        });
    } catch (err) {
        if (strictAudit) throw err;
        logger.error('Authorization recovery audit failed', {
            channelId: channel.id,
            error: err.message,
        });
    }

    await Promise.allSettled([
        drainChannelJobs({
            metaChannelId: channel.id,
            shopId: channel.shop_id,
            platform: channel.platform,
        }),
        notifyOwner(channel, reason),
        opsAlert('Meta channel reconnect required', {
            detail: `${channel.display_name} (${channel.id}) was disabled: ${reason}`,
            context: { channelId: channel.id, shopId: channel.shop_id, reason },
        }),
    ]);

    return { channel, changed: true, unsubscribeOk };
}

async function processDeauthorization(appScopedUserId) {
    const mappings = await MetaUserIdentity.findAll({
        where: {
            app_scoped_user_id: String(appScopedUserId),
            is_current_connection: true,
        },
        include: [{ model: MetaChannel, as: 'channel', required: true }],
    });

    if (!mappings.length) {
        const identityHash = anonymousIdentityId(appScopedUserId);
        await writeAudit('meta_deauthorization_unmapped', null, {
            identity_hash: identityHash,
            reconnect_required: true,
        });
        return { mappingsFound: 0, channelsDisabled: 0, repeated: false };
    }

    let channelsDisabled = 0;
    let repeated = true;
    const seen = new Set();
    for (const mapping of mappings) {
        const channel = mapping.channel;
        if (!channel || seen.has(channel.id)) continue;
        seen.add(channel.id);

        const needsTransition = !(
            channel.status === 'REVOKED'
            && !channel.page_access_token_ct
            && channel.last_error === 'meta_deauthorized_reconnect_required'
        );
        if (needsTransition && mapping.page_scoped_user_id) {
            const customer = await Customer.findOne({
                where: {
                    shop_id: mapping.shop_id,
                    channel_type: 'messenger',
                    channel_user_id: mapping.page_scoped_user_id,
                },
            });
            if (customer) {
                await consentService.recordDeauthorize({
                    shopId: mapping.shop_id,
                    channelId: mapping.channel_id,
                    customerId: customer.id,
                    platform: 'facebook',
                    metadata: { source: 'meta_deauthorize_callback' },
                    strictAudit: true,
                });
            }
        }

        const result = await disableChannel(channel, {
            status: 'REVOKED',
            reason: 'meta_deauthorized_reconnect_required',
            auditAction: 'meta_channel_deauthorized',
            strictAudit: true,
        });
        if (result.changed) {
            repeated = false;
            channelsDisabled += 1;
        }
    }

    return { mappingsFound: mappings.length, channelsDisabled, repeated };
}

async function recoverInvalidToken(channel, metaError = {}) {
    if (!channel?.id) {
        throw new Error('recoverInvalidToken requires a persisted Meta channel');
    }
    return disableChannel(channel, {
        status: 'TOKEN_EXPIRED',
        reason: 'meta_token_invalid_reconnect_required',
        auditAction: 'meta_channel_token_invalidated',
        strictAudit: false,
        attemptUnsubscribe: false,
        metaError,
    });
}

module.exports = {
    processDeauthorization,
    recoverInvalidToken,
    _private: {
        anonymousIdentityId,
        disableChannel,
    },
};
