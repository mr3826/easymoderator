'use strict';

/**
 * Webhook Send Compatibility Shim
 *
 * Multiple modules (payment-webhook.controller, invoice.service,
 * delivery-tracking.service, order-session-standalone.service,
 * owner-notification.service) require this path to send outbound
 * Messenger messages via a channel record.
 *
 * Routing-boundary cutover: the legacy meta-send.service import is removed.
 * Outbound transport lives exclusively in the provider registry.
 *
 * Call-site signature (unchanged):
 *   webhookService.sendMessage(channel, recipientId, messageText)
 *
 * Where `channel` carries:
 *   channel.shop_id          — tenant scoping
 *   channel.type             — 'facebook' | 'messenger'
 *   channel.meta_channel_id  — optional exact MetaChannel UUID. When present,
 *                              it is validated against the tenant/platform and
 *                              never replaced by a shop-wide lookup.
 *   channel.meta_asset_id    — optional exact Page asset when no channel UUID
 *                              is available.
 *
 * The shim resolves an exact MetaChannel, or the only connected channel for
 * the shop/platform when no exact ID is available. It then builds a minimal
 * NormalizedMessage, runs policy pre-flight, and delegates to the provider.
 */

const Customer = require('../customer/customer.entity');
const { Conversation } = require('../conversation/conversation.entity');
const metaChannelService = require('../channel-providers/meta-channel.service');
const { selectChannelRuntimeSettings } = require('../channel-providers/meta-channel-settings.runtime');
const { getProvider } = require('../channel-providers/provider.registry');
const policyEngine = require('../policy/policy.engine');
const { loadEffectiveChannelAutomation } = require('../channel-providers/channel-automation.resolver');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger('WebhookService');

/**
 * Normalize a supported legacy channel.type string to the provider key.
 *
 * @param {string} channelType
 * @returns {'facebook'|null}
 */
function normalizePlatform(channelType) {
    if (channelType === 'facebook' || channelType === 'messenger') return 'facebook';
    return null;
}

const matchesMetaChannel = (channel, { shopId, platform, metaAssetId = null } = {}) => (
    Boolean(channel)
    && channel.status === 'CONNECTED'
    && String(channel.shop_id) === String(shopId)
    && channel.platform === platform
    && (!metaAssetId || String(channel.meta_asset_id) === String(metaAssetId))
);

const normalizeSettings = (settings) => {
    const value = typeof settings?.toJSON === 'function' ? settings.toJSON() : settings;
    return value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).length > 0
        ? value
        : null;
};

/**
 * Send a text message to a customer via the shop's active Meta channel.
 *
 * @param {object} channel       - Channel-like object (shop_id, type, optional exact IDs)
 * @param {string|number} recipientId   - Customer PSID
 * @param {string} messageText   - Plain-text message content
 * @param {object} [options]
 * @param {'transactional'} [options.messageType] - Post-purchase notification marker
 * @returns {Promise<{sent: boolean, reason?: string, providerMessageId?: string}>}
 */
async function sendMessage(channel, recipientId, messageText, { messageType = null } = {}) {
    if (!channel || !channel.shop_id || !recipientId || !messageText) {
        logger.warn('sendMessage called with missing required args', {
            hasChannel: Boolean(channel),
            hasShop: Boolean(channel?.shop_id),
            hasRecipient: Boolean(recipientId),
            hasMessage: Boolean(messageText)
        });
        return { sent: false, reason: 'missing_args' };
    }

    const platform = normalizePlatform(channel.type);
    if (!platform) {
        logger.warn('sendMessage called with unsupported platform', { hasChannel: true });
        return { sent: false, reason: 'platform_mismatch' };
    }
    const recipientIdStr = String(recipientId);

    let metaChannel = null;
    if (channel.meta_channel_id) {
        const exactScope = {
            shopId: channel.shop_id,
            platform,
        };
        if (channel.meta_asset_id) exactScope.metaAssetId = channel.meta_asset_id;
        const exactChannel = await metaChannelService.findConnectedById(channel.meta_channel_id, exactScope);
        metaChannel = matchesMetaChannel(exactChannel, exactScope) ? exactChannel : null;
    } else if (channel.meta_asset_id) {
        const assetChannel = await metaChannelService.findByMetaAssetId(channel.meta_asset_id);
        metaChannel = matchesMetaChannel(assetChannel, {
            shopId: channel.shop_id,
            platform,
            metaAssetId: channel.meta_asset_id,
        }) ? assetChannel : null;
    } else {
        const uniqueChannel = await metaChannelService.findUniqueConnectedByShopAndPlatform(channel.shop_id, platform);
        metaChannel = matchesMetaChannel(uniqueChannel, { shopId: channel.shop_id, platform })
            ? uniqueChannel
            : null;
    }

    if (!metaChannel) {
        logger.warn('No MetaChannel found for shop+platform — message dropped', {
            shopId: channel.shop_id,
            platform,
            metaChannelId: channel.meta_channel_id || null
        });
        return { sent: false, reason: 'no_channel' };
    }

    let settings;
    try {
        if (typeof metaChannelService.getSettings !== 'function') {
            return { sent: false, reason: 'settings_unavailable' };
        }
        settings = normalizeSettings(await metaChannelService.getSettings(metaChannel.id));
    } catch (settingsErr) {
        logger.warn('Channel settings lookup failed in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
            error: settingsErr.message,
        });
        return { sent: false, reason: 'settings_lookup_error' };
    }
    if (!settings) {
        logger.warn('Channel settings unavailable in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
        });
        // Committed-mutation facts must never disappear (AGENT_ACTION_POLICY):
        // transactional sends proceed with fail-closed defaults; the policy
        // engine still enforces consent/window and exempts transactional mode.
        if (messageType !== 'transactional') {
            return { sent: false, reason: 'settings_unavailable' };
        }
        settings = {};
    }
    // Channel settings still provide per-Page policy inputs. The reply mode is
    // the resolver's EFFECTIVE mode (emergency stop > shop inactive > clamped
    // channel override > business default); this shim never reads the business
    // mode directly.
    let automation;
    try {
        automation = await loadEffectiveChannelAutomation(channel.shop_id, metaChannel.id);
    } catch (automationErr) {
        logger.warn('Effective channel automation unavailable in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
            error: automationErr.message,
        });
        if (messageType !== 'transactional') {
            return { sent: false, reason: 'channel_settings_unavailable' };
        }
        automation = null;
    }
    if (!automation && messageType !== 'transactional') {
        return { sent: false, reason: 'channel_settings_unavailable' };
    }
    if (automation && (automation.emergencyStop?.active === true || automation.modeSource === 'emergency_stop')) {
        // The stop suppresses automatic sends. Transactional post-mutation facts
        // (order confirmation, payment receipt) are not AI replies and must still
        // reach the customer (ADR-0004 delivery truth).
        if (messageType !== 'transactional') {
            return { sent: false, reason: 'emergency_stop' };
        }
    }
    settings = {
        ...selectChannelRuntimeSettings(settings),
        // Transactional sends may proceed without a resolved automation state;
        // MANUAL is the fail-closed placeholder and draftMode exempts them.
        automation_mode: automation?.mode ?? 'MANUAL',
    };

    // Build a minimal NormalizedMessage for the policy engine
    const normalizedMessage = {
        text: messageText,
        attachments: [],
        platform,
        direction: 'outbound',
        senderRole: 'system',
        messageType,
    };

    // Resolve the customer so the policy engine can enforce opt-out / consent.
    // Without this, `messengerOptedOut` and `consentRequired` short-circuit to
    // NO_CUSTOMER_CONTEXT (allow) and transactional sends (payment confirm,
    // delivery, invoice, owner notification) reach opted-out users.
    // channel_type stores 'messenger' for Facebook.
    const customerChannelType = 'messenger';
    let customer = null;
    try {
        customer = await Customer.findOne({
            where: {
                shop_id: channel.shop_id,
                channel_type: customerChannelType,
                channel_user_id: recipientIdStr,
                meta_channel_id: metaChannel.id,
            },
        });
    } catch (lookupErr) {
        logger.warn('Customer lookup failed in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
            error: lookupErr.message,
        });
        return { sent: false, reason: 'customer_lookup_error' };
    }
    if (!customer) {
        logger.warn('Customer context unavailable in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
        });
        return { sent: false, reason: 'customer_context_unavailable' };
    }
    if (String(customer.shop_id) !== String(channel.shop_id)) {
        logger.warn('Customer tenant mismatch in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
        });
        return { sent: false, reason: 'customer_context_unavailable' };
    }
    if (!['messenger', 'facebook'].includes(customer.channel_type)) {
        logger.warn('Customer routing context is incomplete in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
        });
        return { sent: false, reason: 'platform_mismatch' };
    }

    // Policy pre-flight (defense-in-depth — provider also evaluates internally)
    const policyCtx = {
        shopId: channel.shop_id,
        channelId: metaChannel.id,
        recipientId: recipientIdStr,
        channel: metaChannel,
        customer,
        settings,
        platform,
        messageType,
    };

    let decision;
    try {
        decision = await policyEngine.evaluateOutbound(normalizedMessage, policyCtx);
    } catch (policyErr) {
        logger.error('Policy engine error in webhook shim — blocking send', {
            shopId: channel.shop_id,
            platform,
            error: policyErr.message
        });
        return { sent: false, reason: 'policy_error' };
    }

    if (decision?.allow !== true) {
        logger.info('Policy denied outbound send in webhook shim', {
            shopId: channel.shop_id,
            platform,
            reason: decision?.reason || 'POLICY_DENIED',
        });
        return {
            sent: false,
            reason: 'policy_denied',
            policyReason: decision?.reason || 'POLICY_DENIED',
        };
    }

    try {
        const provider = getProvider(platform);
        if (!provider || typeof provider.sendMessage !== 'function') {
            return { sent: false, reason: 'provider_unavailable' };
        }
        const providerResult = await provider.sendMessage({
            channel: metaChannel,
            recipientId: recipientIdStr,
            normalizedMessage: decision.transform || normalizedMessage,
            decision,
        });

        if (!providerResult
            || providerResult.sent === false
            || providerResult.success === false
            || providerResult.ok === false) {
            logger.warn('Provider returned no successful send result in webhook shim', {
                shopId: channel.shop_id,
                platform,
            });
            return { sent: false, reason: 'provider_no_send' };
        }

        logger.info('Message sent via webhook service shim', {
            shopId: channel.shop_id,
            platform,
        });
        return { sent: true, providerMessageId: providerResult.providerMessageId || null };
    } catch (err) {
        logger.error('sendMessage failed', {
            shopId: channel.shop_id,
            platform,
            error: err.message
        });
        throw err;
    }
}

/**
 * Send a transactional message to a customer identified by their internal
 * Customer record id. Resolves the customer's real channel_user_id (PSID)
 * and platform, then delegates to sendMessage().
 *
 * This is the correct way for order/delivery/payment notifications to reach a
 * customer: they hold an order with a `customer_id`, NOT a PSID. Passing a phone
 * number or the internal customer UUID as the Meta recipient (as the legacy call
 * sites did) is rejected by the Graph API and silently dropped.
 *
 * @param {object} params
 * @param {string} params.shopId
 * @param {string} params.customerId  - Customer table primary key
 * @param {string} params.message     - plain-text message
 * @param {string} [params.metaChannelId] - Exact MetaChannel UUID to use
 * @param {string} [params.meta_channel_id] - Snake-case alias for API callers
 * @returns {Promise<{sent: boolean, reason?: string, recipientId?: string, channelType?: string}>}
 */
async function sendToCustomer({
    shopId,
    customerId,
    message,
    metaChannelId = null,
    meta_channel_id: metaChannelIdSnake = null,
} = {}) {
    if (!shopId || !customerId || !message) {
        return { sent: false, reason: 'missing_args' };
    }

    let customer = null;
    try {
        customer = await Customer.findOne({
            where: {
                id: customerId,
                shop_id: shopId,
                ...(metaChannelId || metaChannelIdSnake
                    ? { meta_channel_id: metaChannelId || metaChannelIdSnake }
                    : {}),
            },
        });
    } catch (err) {
        logger.warn('sendToCustomer: customer lookup failed', { shopId, customerId, error: err.message });
        return { sent: false, reason: 'lookup_error' };
    }

    if (!customer || !customer.channel_user_id) {
        // No Meta-side identity for this customer (e.g. a manually-created order
        // with only a phone) — nothing to deliver to over Messenger.
        return { sent: false, reason: 'no_customer_psid' };
    }
    if (String(customer.shop_id) !== String(shopId)) {
        return { sent: false, reason: 'customer_context_unavailable' };
    }

    // channel_type stores 'messenger' for Facebook.
    const channelType = 'messenger';
    if (!['messenger', 'facebook'].includes(customer.channel_type)) {
        return { sent: false, reason: 'platform_mismatch' };
    }

    if (metaChannelId && metaChannelIdSnake && String(metaChannelId) !== String(metaChannelIdSnake)) {
        return { sent: false, reason: 'ambiguous_channel' };
    }

    let resolvedChannelId = metaChannelId || metaChannelIdSnake || customer.meta_channel_id || null;
    if (!resolvedChannelId) {
        let conversations;
        try {
            conversations = await Conversation.findAll({
                where: { shop_id: shopId, customer_id: customer.id, channel: channelType },
                attributes: ['meta_channel_id'],
            });
        } catch (err) {
            logger.warn('sendToCustomer: conversation channel lookup failed', {
                shopId,
                customerId,
                error: err.message,
            });
            return { sent: false, reason: 'lookup_error' };
        }

        if (!Array.isArray(conversations)) {
            return { sent: false, reason: 'lookup_error' };
        }

        const channelIds = [...new Set(conversations
            .map((conversation) => conversation?.meta_channel_id)
            .filter(Boolean)
            .map(String))];
        if (channelIds.length > 1) {
            logger.warn('sendToCustomer: multiple Messenger channels found', {
                shopId,
                customerId,
                channelCount: channelIds.length,
            });
            return { sent: false, reason: 'ambiguous_channel' };
        }

        resolvedChannelId = channelIds[0] || null;
    }

    if (!resolvedChannelId) {
        return { sent: false, reason: 'no_channel' };
    }

    try {
        const result = await sendMessage({
            shop_id: shopId,
            type: channelType,
            meta_channel_id: resolvedChannelId,
        }, customer.channel_user_id, message, { messageType: 'transactional' });
        if (!result?.sent) {
            return { sent: false, reason: result?.reason || 'no_channel' };
        }
        return { sent: true, recipientId: customer.channel_user_id, channelType };
    } catch (err) {
        logger.warn('sendToCustomer: send failed', { shopId, customerId, error: err.message });
        return { sent: false, reason: 'send_error', error: err.message };
    }
}

module.exports = { sendMessage, sendToCustomer };
