'use strict';

/**
 * Human Handoff Service
 *
 * escalateToHuman() pauses the AI for a conversation (hitl=true), notifies any
 * connected agent tabs, and sends the customer one short reassurance ("holding")
 * message so they are not left in silence while a human takes over.
 *
 * Shared by the two worker paths that hand a conversation to a human:
 *   1. sentiment auto-escalation (angry / frustrated customer)
 *   2. low-confidence handoff (AI unsure → hold the reply, fetch a human)
 *
 * Best-effort and non-throwing: the conversation is already flagged for a human,
 * so a failure to deliver the holding message must never break the escalation.
 */

const sseManager = require('../../utils/sse-manager');
const { getProvider } = require('../channel-providers/provider.registry');
const { sendEscalationAutoReply } = require('./escalation-auto-reply.service');
const policyEngine = require('../policy/policy.engine');
const { Customer, MetaChannelSettings, Message, Conversation } = require('../entities');
const conversationLockService = require('./conversation-lock.service');
const { Op, literal } = require('sequelize');
const { selectChannelRuntimeSettings } = require('../channel-providers/meta-channel-settings.runtime');
const { DEFAULT_AI_SETTINGS } = require('../shop/shop-defaults');
const { loadEffectiveChannelAutomation } = require('../channel-providers/channel-automation.resolver');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    isProviderConfirmed,
    providerMessageIdFor,
    providerAcknowledgementId,
    hasProviderAcknowledgement,
} = require('./message-lifecycle');
const DEFAULT_HANDOFF_COOLDOWN_MINUTES = DEFAULT_AI_SETTINGS.handoff_settings.cooldown_minutes;
const MAX_HANDOFF_COOLDOWN_MINUTES = 1440;
const DELIVERY_LOCK_TIMEOUT_MS = 300_000;
const DELIVERY_LOCK_WAIT_MS = 10_000;
const SUPPORTED_HANDOFF_PLATFORMS = new Set(['facebook', 'messenger', 'instagram']);

function hasRequiredContextValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function isContextRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHandoffPlatform(platform) {
    return platform === 'messenger' ? 'facebook' : platform;
}

const providerSendSucceeded = hasProviderAcknowledgement;

async function stampHoldingMessage(holdingMsg, convId, state, sendResult = null, extra = {}) {
    if (!holdingMsg?.id || !Message || typeof Message.update !== 'function') return;
    const providerMessageId = providerAcknowledgementId(sendResult)
        || providerMessageIdFor(holdingMsg)
        || null;
    if (state === MESSAGE_DELIVERY_STATES.SENT && !providerMessageId) return;
    const metadata = {
        ...(holdingMsg.metadata && typeof holdingMsg.metadata === 'object' ? holdingMsg.metadata : {}),
        delivered: state === MESSAGE_DELIVERY_STATES.SENT,
        delivery_status: state === MESSAGE_DELIVERY_STATES.SENT ? 'sent' : state === MESSAGE_DELIVERY_STATES.FAILED ? 'failed' : 'held',
        delivery_state: state,
        delivery_source: 'HITL_ESCALATION',
        provider_message_id: providerMessageId,
        provider_send_confirmed: state === MESSAGE_DELIVERY_STATES.SENT && Boolean(providerMessageId),
        ...extra,
    };
    await Message.update({
        ...(providerMessageId ? { external_id: providerMessageId } : {}),
        delivery_state: state,
        delivery_source: 'HITL_ESCALATION',
        provider_message_id: providerMessageId,
        metadata,
    }, {
        where: {
            id: holdingMsg.id,
            conversation_id: convId,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
        },
    });
}

function emitHoldingDelivery(shopId, convId, holdingMsg, state, sendResult = null, metadata = null) {
    sseManager.emit(shopId, 'message_delivery_updated', {
        conversation_id: convId,
        message_id: holdingMsg?.id || null,
        delivery_state: state,
        provider_message_id: providerAcknowledgementId(sendResult) || holdingMsg?.provider_message_id || null,
        metadata: metadata || holdingMsg?.metadata || {},
    });
}

async function claimHoldingMessage(holdingMsg, convId) {
    if (!holdingMsg?.id || !Message || typeof Message.update !== 'function') return true;
    const metadata = holdingMsg.metadata && typeof holdingMsg.metadata === 'object'
        ? holdingMsg.metadata
        : {};
    const claimResult = await Message.update({
        metadata: {
            ...metadata,
            provider_send_attempted: true,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            delivery_status: 'pending',
            delivered: false,
        },
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
    }, {
        where: {
            id: holdingMsg.id,
            conversation_id: convId,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            provider_message_id: null,
            [Op.and]: [literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`)],
        },
    });
    const updatedCount = Array.isArray(claimResult) ? claimResult[0] : 1;
    return updatedCount === 1;
}

async function getHandoffCooldownMinutes(shopId) {
    try {
        const shopService = require('../shop/shop.service');
        const settings = await shopService.getShopAiSettings(shopId);
        const configured = settings?.handoff_settings?.cooldown_minutes;
        if (typeof configured === 'number'
            && Number.isFinite(configured)
            && configured >= 0
            && configured <= MAX_HANDOFF_COOLDOWN_MINUTES) {
            return configured;
        }
    } catch (_) { /* use the canonical default when settings are unavailable */ }
    return DEFAULT_HANDOFF_COOLDOWN_MINUTES;
}

/**
 * @param {object}   params
 * @param {object}   params.conversation    - Sequelize Conversation instance (needs .update)
 * @param {string}   params.shopId
 * @param {string}   [params.conversationId] - defaults to conversation.id
 * @param {string}   [params.turnId]          - existing logical conversation turn
 * @param {Date|string} [params.turnStartedAt] - durable turn start boundary
 * @param {string}   params.platform         - 'messenger' | 'facebook' | 'instagram'
 * @param {string}   params.recipientId      - customer PSID/IGSID
 * @param {object}   [params.channel]        - resolved MetaChannel for delivery (null skips delivery)
 * @param {string}   [params.reason]         - audit/log reason (e.g. 'low_confidence', 'sentiment_angry')
 * @returns {Promise<object|null>} the stored holding message, or null
 */
async function escalateToHuman({
    conversation,
    shopId,
    conversationId,
    turnId,
    turnStartedAt,
    platform,
    recipientId,
    channel,
    reason,
    deliveryLock: providedDeliveryLock = null,
} = {}) {
    const convId = conversationId || conversation?.id;
    let hitlReady = conversation?.hitl === true;

    // 1. Pause AI + notify agent tabs (idempotent — don't re-flip if already HITL)
    try {
        if (!conversation) {
            throw new Error('Conversation context is unavailable');
        }
        if (conversation.hitl !== true) {
            await conversation.update({
                hitl: true,
                // P+03: record WHY the human is needed on the authoritative
                // record itself (queue reason + evidence source), not a copy.
                metadata: {
                    ...(conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {}),
                    handoff_reason: reason || 'human_required',
                    handoff_at: new Date().toISOString(),
                },
            });
            hitlReady = true;
            try {
                const merchantNotificationService = require('../notification/merchant-notification.service');
                const { NOTIFICATION_EVENTS } = require('../notification/notification-events');
                const cooldownMinutes = await getHandoffCooldownMinutes(shopId);
                const notificationOptions = cooldownMinutes > 0
                    ? {
                        dedupeKey: `shop:${shopId}:ai_handoff`,
                        dedupeTtlSeconds: cooldownMinutes * 60,
                    }
                    : {};
                Promise.resolve(merchantNotificationService.notifyShop(
                    shopId,
                    NOTIFICATION_EVENTS.AI_HITL,
                    {
                        conversationId: convId,
                        reason,
                        platform
                    },
                    notificationOptions
                )).catch(() => {});
            } catch (_) { /* alert failure must never block HITL */ }
        } else {
            hitlReady = true;
        }
        sseManager.emit(shopId, 'hitl_changed', {
            conversation_id: convId,
            hitl: true,
            needs_merchant_reply: true,
            needs_merchant_reply_reason: 'HITL_REQUIRED',
            ai_is_replying: false,
        });
    } catch (err) {
        console.error(`[handoff] Failed to set hitl for conv ${convId} (${reason}): ${err.message}`);
    }

    let deliveryLock = providedDeliveryLock;
    let ownsDeliveryLock = false;
    let deliveryLockBusy = false;
    if (channel && hitlReady) {
        try {
            if (!deliveryLock) {
                const lock = await conversationLockService.acquireForDelivery(convId, {
                    lockTimeoutMs: DELIVERY_LOCK_TIMEOUT_MS,
                    maxWaitMs: DELIVERY_LOCK_WAIT_MS,
                });
                if (lock?.available === false && process.env.NODE_ENV !== 'test') {
                    deliveryLockBusy = true;
                } else if (lock && lock.available !== false && !lock.success) {
                    deliveryLockBusy = true;
                } else {
                    deliveryLock = lock?.success ? lock : null;
                    ownsDeliveryLock = Boolean(deliveryLock);
                }
            }

            if (typeof Conversation?.findOne === 'function') {
                const latestConversation = await Conversation.findOne({
                    where: { id: convId, shop_id: shopId },
                    attributes: ['id', 'status', 'hitl'],
                });
                if (!latestConversation
                    || latestConversation.hitl !== true
                    || ['closed', 'archived'].includes(latestConversation.status)) {
                    if (ownsDeliveryLock && deliveryLock?.success) {
                        await conversationLockService.releaseLock(convId, deliveryLock.lockId).catch(() => {});
                        deliveryLock = null;
                    }
                    return null;
                }
            }
        } catch (err) {
            console.warn(`[handoff] Holding message delivery lock unavailable for conv ${convId}: ${err.message}`);
            deliveryLockBusy = true;
        }
    }

    try {
        // 2. Reassure the customer with one templated holding message
        const holdingMsg = await (turnId || turnStartedAt
            ? sendEscalationAutoReply(convId, shopId, platform, {
                logicalTurnId: turnId,
                turnStartedAt,
            })
            : sendEscalationAutoReply(convId, shopId)
        ).catch(() => null);
        if (!holdingMsg) return null;

        const holdingMetadata = holdingMsg.metadata && typeof holdingMsg.metadata === 'object'
            ? holdingMsg.metadata
            : {};
        if (isProviderConfirmed(holdingMsg) || holdingMetadata.provider_send_attempted === true) {
            return holdingMsg;
        }

        sseManager.emit(shopId, 'new_message', { conversation_id: convId, message: holdingMsg });

    // 3. Deliver it on the same channel the inbound arrived on
    if (channel && hitlReady) {
        if (deliveryLockBusy) {
            await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.HELD, null, {
                held_reason: 'delivery_lock_busy',
                suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            }).catch(() => {});
            emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.HELD);
            return holdingMsg;
        }
        const pf = normalizeHandoffPlatform(platform);
        if (!hasRequiredContextValue(convId)
            || !hasRequiredContextValue(shopId)
            || !SUPPORTED_HANDOFF_PLATFORMS.has(platform)
            || !hasRequiredContextValue(recipientId)
            || !hasRequiredContextValue(channel.id)) {
            console.warn(`[handoff] Holding message not sent for conv ${convId}: delivery context unavailable`);
            return holdingMsg;
        }

        try {
            const customerChannelType = pf === 'facebook' ? 'messenger' : pf;
            const [customer, settings, automation] = await Promise.all([
                Customer.findOne({
                    where: {
                        shop_id: shopId,
                        channel_type: customerChannelType,
                        channel_user_id: String(recipientId),
                        ...(channel.id ? { meta_channel_id: channel.id } : {}),
                    },
                }),
                MetaChannelSettings.findOne({ where: { channel_id: channel.id } }),
                loadEffectiveChannelAutomation(shopId, channel.id).catch(() => null),
            ]);

            const customerKnown = isContextRecord(customer) && hasRequiredContextValue(customer.id);
            const settingsKnown = isContextRecord(settings)
                && hasRequiredContextValue(settings.channel_id)
                && String(settings.channel_id) === String(channel.id);
            if (!customerKnown || !settingsKnown) {
                const missing = !customerKnown ? 'customer context' : 'channel settings';
                console.warn(`[handoff] Holding message not sent for conv ${convId}: ${missing} unavailable`);
                return holdingMsg;
            }
            if (!automation) {
                await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.HELD, null, {
                    held_reason: 'channel_settings_unavailable',
                    suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                }).catch(() => {});
                emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.HELD);
                return holdingMsg;
            }
            if (automation.emergencyStop?.active === true || automation.modeSource === 'emergency_stop') {
                // Business-wide emergency stop suppresses every automatic send,
                // including this reassurance holding message. The conversation
                // stays HITL for the human team; hitl is never cleared here.
                await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.HELD, null, {
                    held_reason: 'emergency_stop',
                    suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                }).catch(() => {});
                emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.HELD);
                return holdingMsg;
            }

            const policySettings = {
                ...selectChannelRuntimeSettings(settings),
                automation_mode: automation.mode,
            };

            const normalizedMessage = {
                text: holdingMsg.content,
                attachments: [],
                platform: pf,
                direction: 'outbound',
                senderRole: 'ai',
            };
            const decision = await policyEngine.evaluateOutbound(normalizedMessage, {
                shopId,
                channelId: channel.id,
                conversationId: convId,
                recipientId: String(recipientId),
                channel,
                customer,
                settings: policySettings,
                platform: pf,
            });
            if (!decision.allow) {
                await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.HELD, null, {
                    held_reason: 'policy_blocked',
                    suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                }).catch(() => {});
                emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.HELD);
                console.warn(`[handoff] Holding message blocked by policy for conv ${convId}: ${decision.reason}`);
                return holdingMsg;
            }

            if (!(await claimHoldingMessage(holdingMsg, convId))) return holdingMsg;

            const provider = getProvider(pf);
            await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.SEND_PENDING, null, {
                provider_send_attempted: true,
                suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
            }).catch(() => {});
            const sendResult = await provider.sendMessage({
                channel,
                recipientId: String(recipientId),
                normalizedMessage: decision.transform || normalizedMessage,
                decision,
            });
            if (!providerSendSucceeded(sendResult)) {
                throw new Error('Provider did not confirm the holding message send');
            }
            await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.SENT, sendResult, {
                suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_SENT,
            }).catch(() => {});
            emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.SENT, sendResult);
        } catch (err) {
            await stampHoldingMessage(holdingMsg, convId, MESSAGE_DELIVERY_STATES.FAILED, null, {
                provider_send_attempted: true,
                held_reason: 'provider_send_failed',
                suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            }).catch(() => {});
            emitHoldingDelivery(shopId, convId, holdingMsg, MESSAGE_DELIVERY_STATES.FAILED);
            console.warn(`[handoff] Holding message delivery failed for conv ${convId}: ${err.message}`);
        }
    }

        return holdingMsg;
    } finally {
        if (ownsDeliveryLock && deliveryLock?.success) {
            await conversationLockService.releaseLock(convId, deliveryLock.lockId).catch(() => {});
        }
    }
}

module.exports = {
    escalateToHuman,
    _private: { getHandoffCooldownMinutes }
};
