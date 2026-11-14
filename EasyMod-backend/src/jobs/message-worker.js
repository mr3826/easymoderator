'use strict';

/**
 * BullMQ Message Processing Worker
 *
 * Consumes the 'message-processing' queue and runs the full AI pipeline for
 * each incoming customer message. Replaces the n8n → /api/ai-chatbot/process flow.
 *
 * Guards applied (in order):
 *   1. Redis idempotency  — drop duplicates via NX key (24 h TTL)
 *   2. HITL flag          — skip if a human agent has taken over the conversation
 *   3. AI pause           — skip if agent sent a manual message within the last 30 min
 *   4. Automation mode    — business mode controls send/draft/manual for all channels
 *   5. Meta rate limit    — delay job if the page has hit 170 sends/hr (leaky bucket)
 *
 * Fair queueing: each job is dispatched with group.id = shopId. BullMQ v5 processes
 * groups fairly so a viral shop cannot starve other shops.
 *
 * To start this worker as a standalone process:
 *   RUN_WORKER=true node src/jobs/message-worker.js
 */

const { Worker, Queue, UnrecoverableError, DelayedError } = require('bullmq');
const { connection } = require('./message-queue');
const { cacheRedis } = require('../config/redis');
const { opsAlert } = require('../utils/ops-alert');
const { createLogger } = require('../utils/structured-logger');
const { Conversation, Message } = require('../modules/conversation/conversation.entity');
const ConversationStateService = require('../modules/conversation/conversation-state-standalone.service');
const { getProvider } = require('../modules/channel-providers/provider.registry');
const sseManager = require('../utils/sse-manager');
const policyEngine = require('../modules/policy/policy.engine');
const metaChannelService = require('../modules/channel-providers/meta-channel.service');
const conversationLockService = require('../modules/conversation/conversation-lock.service');
const Customer = require('../modules/customer/customer.entity');
const grounding = require('../modules/ai/grounding');
const { faqContentHash, normalizeKnowledgeId } = require('../modules/ai/knowledge-snapshot');
const { Op, literal } = require('sequelize');
const { sequelize } = require('../utils/database/database-setup');
const {
    AI_REPLY_MODES,
    normalizeAiReplyMode,
    getEffectiveAiReplyMode,
    isAutoSendMode,
} = require('../modules/shop/ai-reply-mode');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    normalizeDeliveryState,
    isProviderConfirmed,
    providerAcknowledgementId,
    hasProviderAcknowledgement,
    deriveAutomaticSendIdempotencyKey,
    timestampStateFor,
    resumeBoundaryStateFor,
    candidateStartedAtStateFor,
    candidateStartedAtFor,
    isBeforeResumeBoundary,
} = require('../modules/conversation/message-lifecycle');
const lifecycleLogger = createLogger('InboxLifecycle');

async function recordAcceptedAiReplyShadow(shopId, message) {
    try {
        const { recordAcceptedAiReply } = require('../modules/subscription/ai-reply-shadow-ledger.service');
        const result = await recordAcceptedAiReply({
            shopId,
            message,
            acceptedAt: messageMetadata(message).provider_accepted_at,
        });
        if (['gate_unavailable', 'subscription_unavailable'].includes(result.reason)) {
            throw new Error('Shadow usage state is temporarily unavailable');
        }
    } catch (error) {
        const code = /^[A-Za-z0-9_-]{1,64}$/.test(String(error?.code || ''))
            ? error.code
            : 'UNKNOWN';
        lifecycleLogger.warn('ai_reply_shadow_record_failed', { code });
        // Provider acceptance and the outbound message are already durable. Retrying
        // this job reaches the provider-confirmed branch and retries only the ledger write.
        throw asRetryableDependencyError(error, 'AI_REPLY_SHADOW_LEDGER_FAILED');
    }
}

async function recoverAcceptedAutoReplyShadow(shopId, message, deliveryState) {
    if (![MESSAGE_DELIVERY_STATES.SENT, MESSAGE_DELIVERY_STATES.DELIVERED].includes(deliveryState)) return false;
    await recordAcceptedAiReplyShadow(shopId, message);
    return true;
}

async function finishAlreadyClaimedAutomaticSend(shopId, conversationId, message, deliveryState) {
    const sent = deliveryState === MESSAGE_DELIVERY_STATES.SENT
        || deliveryState === MESSAGE_DELIVERY_STATES.DELIVERED;
    if (sent) await recoverAcceptedAutoReplyShadow(shopId, message, deliveryState);
    return {
        success: true,
        conversationId,
        sent,
        reason: 'provider_send_already_claimed',
    };
}

const asRetryableDependencyError = (error, code) => {
    const normalized = error instanceof Error
        ? error
        : new Error(error == null ? code : String(error));
    if (!normalized.code) normalized.code = code;
    normalized.retryable = true;
    return normalized;
};

const providerSendSucceeded = hasProviderAcknowledgement;
const DELIVERY_LOCK_TIMEOUT_MS = 300_000;
const DELIVERY_LOCK_WAIT_MS = 10_000;

const revalidateProductEvidenceBeforeSend = async (evidence) => {
    const ids = [...new Set([
        ...(evidence?.verifiedProducts || []),
        ...(evidence?.relatedProducts || []),
    ].map(product => product?.id).filter(Boolean).map(String))];
    if (!ids.length) return { valid: true, changedProductIds: [] };
    try {
        const productSearch = require('../modules/product/product-search.service');
        const liveProducts = await productSearch.getProductsByIds(ids, evidence.shopId, { throwOnError: true });
        return grounding.revalidateEvidenceProducts(evidence, liveProducts);
    } catch (error) {
        error.code = error.code || 'PRODUCT_EVIDENCE_REVALIDATION_FAILED';
        error.retryable = true;
        throw error;
    }
};

const revalidateKnowledgeEvidenceBeforeSend = async (evidence) => {
    const knowledgeIds = [...new Set((evidence?.knowledgeIds || [])
        .filter(Boolean).map(normalizeKnowledgeId))];
    if (!evidence?.knowledgeFound && knowledgeIds.length === 0) {
        return { valid: true, changedKnowledgeIds: [] };
    }

    const snapshots = new Map((evidence?.knowledgeSnapshots || [])
        .filter(snapshot => snapshot?.type === 'faq' && snapshot.id && snapshot.contentHash)
        .map(snapshot => [normalizeKnowledgeId(snapshot.id), snapshot]));
    const untrackedIds = knowledgeIds.filter(id => !snapshots.has(id));
    if (untrackedIds.length || (evidence?.knowledgeFound && knowledgeIds.length === 0)) {
        return {
            valid: false,
            changedKnowledgeIds: untrackedIds.length ? untrackedIds : ['unattributed_knowledge'],
        };
    }

    try {
        const { FaqResponse } = require('../modules/entities');
        const currentFaqs = await FaqResponse.findAll({
            where: {
                id: { [Op.in]: knowledgeIds },
                shop_id: evidence.shopId,
                is_active: true,
            },
            attributes: ['id', 'category', 'template_en', 'template_bn'],
        });
        const currentById = new Map(currentFaqs.map(faq => [normalizeKnowledgeId(faq.id), faq]));
        const changedKnowledgeIds = knowledgeIds.filter(id => {
            const current = currentById.get(id);
            const snapshot = snapshots.get(id);
            return !current || faqContentHash(current) !== snapshot.contentHash;
        });
        return { valid: changedKnowledgeIds.length === 0, changedKnowledgeIds };
    } catch (error) {
        error.code = error.code || 'KNOWLEDGE_EVIDENCE_REVALIDATION_FAILED';
        error.retryable = true;
        throw error;
    }
};

const revalidateOperatingContextBeforeSend = async (evidence) => {
    if (!evidence?.operatingContextHash) {
        const hasKnowledgeEvidence = Boolean(evidence?.knowledgeFound)
            || (Array.isArray(evidence?.knowledgeIds) && evidence.knowledgeIds.length > 0);
        const hasOperatingPolicyEvidence = /\b(?:payment|delivery|shipping|courier|fee|charge)\b|পেমেন্ট|ডেলিভারি|চার্জ/i
            .test(String(evidence?.policyText || ''));
        return hasKnowledgeEvidence || hasOperatingPolicyEvidence
            ? { valid: false, changed: true }
            : { valid: true, changed: false };
    }
    try {
        const { getOperatingContext, hashOperatingContext } = require('../modules/ai/shop-operating-context.service');
        const currentContext = await getOperatingContext(evidence.shopId, { strict: true });
        const currentHash = hashOperatingContext(currentContext);
        return {
            valid: currentHash === evidence.operatingContextHash,
            changed: currentHash !== evidence.operatingContextHash,
        };
    } catch (error) {
        throw asRetryableDependencyError(error, 'OPERATING_CONTEXT_REVALIDATION_FAILED');
    }
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const messageMetadata = (message) => {
    if (typeof message?.metadata === 'string') {
        try {
            const parsed = JSON.parse(message.metadata);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    return message?.metadata && typeof message.metadata === 'object'
        ? message.metadata
        : {};
};

// Lazy imports to avoid circular dependency issues at module load
const getShopAISettings = async (shopId) => {
    const shopService = require('../modules/shop/shop.service');
    try {
        const settings = await shopService.getShopAiSettings(shopId);
        if (!settings
            || typeof settings !== 'object'
            || Array.isArray(settings)
            || Object.keys(settings).length === 0) {
            const error = new Error(`Shop AI settings are unavailable for shop ${shopId}`);
            error.code = 'SHOP_SETTINGS_UNAVAILABLE';
            error.retryable = true;
            throw error;
        }
        return settings;
    } catch (error) {
        throw asRetryableDependencyError(error, 'SHOP_SETTINGS_UNAVAILABLE');
    }
};

const getAutomaticSendGuard = async (shopId, conversationId) => {
    const [businessMode, conversation, manualPause, recentMessages] = await Promise.all([
        getEffectiveAiReplyMode(shopId),
        Conversation.findOne({
            where: { id: conversationId, shop_id: shopId },
            attributes: ['id', 'customer_id', 'channel', 'meta_channel_id', 'hitl', 'status'],
        }),
        cacheRedis.get(`ai:pause:${conversationId}`),
        typeof Message.findAll === 'function'
            ? Message.findAll({
                where: {
                    conversation_id: conversationId,
                    sender: { [Op.in]: ['customer', 'business'] },
                },
                order: [['created_at', 'DESC']],
                limit: 2,
            })
            : [],
    ]);

    if (!isAutoSendMode(businessMode)) {
        return { allowed: false, mode: businessMode, reason: 'mode_changed' };
    }
    if (!conversation) {
        return { allowed: false, mode: businessMode, reason: 'conversation_unavailable' };
    }
    if (conversation.hitl === true) {
        return { allowed: false, mode: businessMode, reason: 'human_active' };
    }
    if (['closed', 'archived'].includes(conversation.status)) {
        return { allowed: false, mode: businessMode, reason: 'conversation_closed' };
    }
    if (manualPause) {
        return { allowed: false, mode: businessMode, reason: 'ai_paused' };
    }

    // STOP/opt-out can arrive while the LLM or policy engine is running. Read
    // the customer again at the irreversible boundary so an old in-memory
    // policy context cannot send after the latest consent change.
    const metaConversation = ['messenger', 'facebook', 'instagram'].includes(conversation.channel);
    if (metaConversation && conversation.customer_id && typeof Customer.findOne === 'function') {
        try {
            const customerWhere = {
                id: conversation.customer_id,
                shop_id: shopId,
            };
            const customer = await Customer.findOne({
                where: customerWhere,
                attributes: ['id', 'shop_id', 'channel_type', 'meta_channel_id', 'messaging_consent'],
            });
            if (!customer || String(customer.shop_id) !== String(shopId)) {
                return { allowed: false, mode: businessMode, reason: 'customer_context_unavailable' };
            }
            const consentPlatform = conversation.channel === 'instagram' ? 'instagram' : 'facebook';
            if (customer.messaging_consent?.[consentPlatform]?.opted_out_at) {
                return { allowed: false, mode: businessMode, reason: 'opted_out' };
            }
        } catch (_) {
            return { allowed: false, mode: businessMode, reason: 'consent_state_unavailable' };
        }
    }

    const latestCustomer = recentMessages?.find((item) => item.sender === 'customer');
    const latestBusiness = recentMessages?.find((item) => item.sender === 'business');
    if (latestBusiness && (!latestCustomer
        || new Date(latestBusiness.created_at).getTime() > new Date(latestCustomer.created_at).getTime())) {
        return { allowed: false, mode: businessMode, reason: 'human_active' };
    }

    return { allowed: true, mode: businessMode, reason: null };
};

const matchesChannelScope = (channel, shopId, platform, metaAssetId = null) => (
    Boolean(channel)
    && channel.status === 'CONNECTED'
    && channel.shop_id != null
    && String(channel.shop_id) === String(shopId)
    && channel.platform === platform
    && (!metaAssetId
        || (channel.meta_asset_id != null && String(channel.meta_asset_id) === String(metaAssetId)))
);

function captureKnowledgeGap(params) {
    return Promise.resolve()
        .then(() => require('../modules/knowledge/knowledge-gap-capture.service').recordKnowledgeGap(params))
        .catch((err) => {
            console.warn(`[worker] Knowledge gap capture skipped: ${err.message}`);
        });
}

function buildOrderFlowFailureResponse(message, language = 'mixed') {
    const { hasPurchaseIntent } = require('../modules/conversation/order-flow.service');
    if (!hasPurchaseIntent(message)) return null;

    return {
        handled: true,
        response: language === 'en'
            ? 'I could not start the order system right now. Please send the product name or a photo again, and our team will help if it still does not start.'
            : 'অর্ডার সিস্টেমটি এখন শুরু করা যায়নি। প্রোডাক্টের নাম বা ছবি আবার পাঠান, না হলে আমাদের টিম আপনাকে সাহায্য করবে।',
        confidence: 1.0,
        sourceReferences: null,
        meta: { order_session: 'unavailable', reason: 'order_flow_error' },
    };
}

function buildPostMutationResponse(orderFlow, language = 'mixed') {
    const order = orderFlow?.meta?.order;
    const orderNumber = order?.order_number || 'the order';
    const orderStatus = order?.order_status || 'confirmed';
    return language === 'en'
        ? `Order #${orderNumber} | Status: ${orderStatus}`
        : `অর্ডার #${orderNumber} | স্ট্যাটাস: ${orderStatus}`;
}

function isUnrecoverableJobError(error) {
    return error instanceof UnrecoverableError || error?.name === 'UnrecoverableError';
}

async function notifyExecutedMutationWithoutOutbound({ shopId, conversationId, orderFlow, reason }) {
    try {
        const merchantNotificationService = require('../modules/notification/merchant-notification.service');
        const { NOTIFICATION_EVENTS } = require('../modules/notification/notification-events');
        await merchantNotificationService.notifyShop(
            shopId,
            NOTIFICATION_EVENTS.AI_HITL,
            {
                reason: 'executed_mutation_without_outbound_send',
                orderId: orderFlow?.meta?.order?.id || null,
                orderNumber: orderFlow?.meta?.order?.order_number || null,
                conversationId,
                detail: reason,
            },
            {
                dedupeKey: `executed_mutation_without_outbound_send:${orderFlow?.meta?.order?.id || conversationId}`,
                dedupeTtlSeconds: 24 * 60 * 60,
            }
        );
    } catch (err) {
        console.error(`[worker] Failed to notify merchant about committed order without outbound send: ${err.message}`);
    }
}

/**
 * Resolve the MetaChannel row for this job. Prefers `metaChannelId` from the
 * job payload (set by the webhook dispatcher, unambiguous when a shop owns
 * multiple Pages of the same platform). A supplied Page asset is also an
 * exact routing constraint. Only jobs with neither exact value may use the
 * unique connected shop+platform fallback.
 */
const resolveChannelForJob = async (shopId, platform, metaChannelId, metaAssetId) => {
    const expectedPlatform = platform === 'facebook' || platform === 'messenger'
        ? 'facebook'
        : null;
    if (!expectedPlatform) return null;
    if (metaChannelId) {
        const channel = await metaChannelService.findConnectedById(metaChannelId, {
            shopId,
            platform: expectedPlatform,
            metaAssetId,
        });
        return matchesChannelScope(channel, shopId, expectedPlatform, metaAssetId) ? channel : null;
    }

    if (metaAssetId) {
        const channel = await metaChannelService.findByMetaAssetId(metaAssetId);
        return matchesChannelScope(channel, shopId, expectedPlatform, metaAssetId) ? channel : null;
    }

    const channel = await metaChannelService.findUniqueConnectedByShopAndPlatform(shopId, expectedPlatform);
    if (!matchesChannelScope(channel, shopId, expectedPlatform)) {
        return null;
    }
    return channel;
};

const getChannelAISettings = async (channel) => {
    if (!channel) {
        const error = new Error('Meta channel settings require a resolved channel');
        error.code = 'META_CHANNEL_UNAVAILABLE';
        error.retryable = true;
        throw error;
    }
    try {
        const settings = await metaChannelService.getSettings(channel.id);
        const normalized = typeof settings?.toJSON === 'function' ? settings.toJSON() : settings;
        if (!normalized
            || typeof normalized !== 'object'
            || Array.isArray(normalized)
            || Object.keys(normalized).length === 0) {
            const error = new Error(`Channel AI settings are unavailable for channel ${channel.id}`);
            error.code = 'CHANNEL_SETTINGS_UNAVAILABLE';
            error.retryable = true;
            throw error;
        }
        return normalized;
    } catch (error) {
        throw asRetryableDependencyError(error, 'CHANNEL_SETTINGS_UNAVAILABLE');
    }
};

const buildWorkerAiSettings = (shopSettings = {}, channelSettings = {}, businessMode) => ({
    business_hours: channelSettings.business_hours,
    confidence_threshold_send: channelSettings.confidence_threshold_send,
    confidence_threshold_suggest: channelSettings.confidence_threshold_suggest,
    allow_order_creation: channelSettings.allow_order_creation,
    purpose_label: channelSettings.purpose_label,
    ...shopSettings,
    automation_mode: businessMode,
});

function hasExplicitDeliveryLifecycle(message) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
        ? message.metadata
        : {};
    return message?.delivery_state != null
        || message?.provider_message_id != null
        || metadata.delivery_state != null
        || metadata.delivery_status != null
        || metadata.delivered !== undefined
        || metadata.suggestion_visibility != null;
}

/**
 * Load the last 10 messages prior to the current turn, as LLM conversation
 * history. `excludeIds` is the id (or ids, for a coalesced burst) of the message(s)
 * that make up the *current* turn — they must not appear in history as well.
 */
async function loadConversationHistory(conversationId, excludeIds) {
    const exclude = new Set((Array.isArray(excludeIds) ? excludeIds : [excludeIds]).filter(Boolean));
    const messages = await Message.findAll({
        where: { conversation_id: conversationId },
        order: [['created_at', 'DESC']],
        limit: 11 + exclude.size,
    });
    return messages
        .filter(m => !exclude.has(m.id))
        // Legacy AI rows without lifecycle metadata predate the hotfix and are
        // retained as historical context. New unsent candidates always carry
        // an explicit lifecycle marker and must stay out of the transcript.
        .filter(m => m.sender !== 'ai' || isProviderConfirmed(m) || !hasExplicitDeliveryLifecycle(m))
        .slice(0, 10)
        .reverse()
        .map(m => {
            const metadata = messageMetadata(m);
            return {
                role: m.sender === 'customer' ? 'user' : 'assistant',
                content: m.content,
                message: m.content,
                createdAt: m.created_at || m.createdAt || null,
                sourceReferences: metadata.sourceReferences || metadata.source_references || null,
                productPresentation: metadata.product_presentation || metadata.productPresentation || null,
            };
        });
}

/**
 * Legacy helper kept for focused unit coverage around burst-flush customer-turn
 * detection. Customer-visible disclosure now uses hasPriorCustomerVisibleAiReply
 * so a held AI draft does not consume the customer's first visible AI identity.
 */
async function isFirstCustomerTurn(conversationId, currentTurnMessageIds) {
    const excludeIds = (Array.isArray(currentTurnMessageIds) ? currentTurnMessageIds : [currentTurnMessageIds]).filter(Boolean);
    const where = { conversation_id: conversationId, sender: 'customer' };
    if (excludeIds.length > 0) {
        where.id = { [Op.notIn]: excludeIds };
    }
    const customerCount = await Message.count({ where });
    return excludeIds.length > 0 ? customerCount === 0 : customerCount <= 1;
}

function wasAiMessageCustomerVisible(message) {
    return isProviderConfirmed(message);
}

function hasAiDisclosure(message) {
    const metadata = message?.metadata || {};
    if (metadata.ai_disclosure_applied === true) return true;

    const content = String(message?.content || '').toLowerCase();
    return content.includes('ai assistant') || content.includes('ai সহকার');
}

async function hasPriorCustomerVisibleAiDisclosure(conversationId) {
    const priorAiMessages = await Message.findAll({
        where: { conversation_id: conversationId, sender: 'ai' },
        attributes: ['id', 'content', 'metadata'],
        order: [['created_at', 'ASC']],
    });
    return priorAiMessages.some((message) => (
        wasAiMessageCustomerVisible(message) && hasAiDisclosure(message)
    ));
}

async function shouldApplyAiDisclosureGreeting({ conversationId, currentTurnMessageIds, aiSettings, channel } = {}) {
    if (!isAutoSendMode(aiSettings?.automation_mode)) return false;
    if (channel?.status !== 'CONNECTED') return false;
    if (!(await isFirstCustomerTurn(conversationId, currentTurnMessageIds))) return false;
    return !(await hasPriorCustomerVisibleAiDisclosure(conversationId));
}

/**
 * Atomic NX set with 24 h TTL. Returns true if the key was newly set (first time).
 * Falls back to a get+setex pattern for mock Redis clients in dev.
 */
async function claimDedupKey(key) {
    try {
        const result = await cacheRedis.set(key, '1', 'NX', 'EX', 86400);
        return result === 'OK' || result === 1;
    } catch {
        const exists = await cacheRedis.get(key);
        if (exists) return false;
        await cacheRedis.setex(key, 86400, '1');
        return true;
    }
}

const STALE_PROVIDER_CLAIM_MS = 10 * 60 * 1000;

/**
 * A crash between the candidate claim and the provider boundary can leave a row
 * claimed forever. Release the claim only while the send has not started, so the
 * reconciler still owns genuinely attempted deliveries.
 */
async function releaseStaleProviderClaim(message) {
    if (!message?.id || typeof Message.update !== 'function') return false;
    const metadata = messageMetadata(message);
    if (metadata.provider_send_attempted === true) return false;
    const releasedMetadata = { ...metadata };
    delete releasedMetadata.provider_send_claimed;
    delete releasedMetadata.provider_send_claimed_at;
    delete releasedMetadata.provider_send_claim_token;
    try {
        const result = await Message.update(
            { metadata: releasedMetadata },
            {
                where: {
                    id: message.id,
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    provider_message_id: null,
                    [Op.and]: [literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`)],
                },
            },
        );
        const updatedCount = Array.isArray(result) ? result[0] : 1;
        if (updatedCount !== 1) return false;
    } catch (error) {
        console.warn(`[worker] Unable to release stale provider claim for message ${message.id}: ${error.message}`);
        return false;
    }
    message.metadata = releasedMetadata;
    return true;
}

async function claimAutomaticCandidate(message, idempotencyKey, shopId) {
    if (!message?.id || !idempotencyKey) return false;
    const metadata = messageMetadata(message);
    const claimedMetadata = {
        ...metadata,
        delivered: false,
        delivery_status: 'pending',
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
        provider_send_claimed: true,
        provider_send_claimed_at: new Date().toISOString(),
        provider_send_attempted: false,
    };

    if (typeof Message.update === 'function') {
        const claim = async (transaction) => {
            if (typeof Conversation.findOne === 'function') {
                const conversation = await Conversation.findOne({
                    where: { id: message.conversation_id, shop_id: shopId },
                    attributes: ['id', 'customer_id', 'channel', 'hitl', 'status', 'metadata'],
                    ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                });
                if (!conversation || conversation.hitl === true || ['closed', 'archived'].includes(conversation.status)) {
                    return false;
                }
                const resumeBoundaryState = resumeBoundaryStateFor(conversation);
                if (resumeBoundaryState.present && !resumeBoundaryState.valid) {
                    return false;
                }
                if (resumeBoundaryState.valid && !candidateStartedAtStateFor(message).valid) {
                    return false;
                }
                if (resumeBoundaryState.valid
                    && messageMetadata(message).provider_send_attempted !== true
                    && isBeforeResumeBoundary(message, resumeBoundaryState.timestamp)) {
                    return false;
                }
                if (typeof cacheRedis.get === 'function' && await cacheRedis.get(`ai:pause:${message.conversation_id}`)) {
                    return false;
                }
                if (typeof Message.findOne === 'function') {
                    const [latestBusiness, latestCustomer] = await Promise.all([
                        Message.findOne({
                            where: { conversation_id: message.conversation_id, sender: 'business' },
                            order: [['created_at', 'DESC']],
                            attributes: ['created_at'],
                            ...(transaction ? { transaction } : {}),
                        }),
                        Message.findOne({
                            where: { conversation_id: message.conversation_id, sender: 'customer' },
                            order: [['created_at', 'DESC']],
                            attributes: ['created_at'],
                            ...(transaction ? { transaction } : {}),
                        }),
                    ]);
                    if (latestBusiness && (!latestCustomer
                        || new Date(latestBusiness.created_at).getTime() >= new Date(latestCustomer.created_at).getTime())) {
                        return false;
                    }
                }
                if (conversation.customer_id && typeof Customer.findOne === 'function') {
                    const customer = await Customer.findOne({
                        where: { id: conversation.customer_id, shop_id: shopId },
                        attributes: ['id', 'messaging_consent'],
                        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                    });
                    const consentPlatform = conversation.channel === 'instagram' ? 'instagram' : 'facebook';
                    if (!customer || customer.messaging_consent?.[consentPlatform]?.opted_out_at) return false;
                }
            }
            const claimResult = await Message.update(
                {
                    metadata: claimedMetadata,
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                },
                {
                    where: {
                        id: message.id,
                        conversation_id: message.conversation_id,
                        sender: 'ai',
                        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    provider_message_id: null,
                    send_idempotency_key: idempotencyKey,
                    [Op.and]: [
                        literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`),
                        literal(`(metadata->>'provider_send_claimed') IS DISTINCT FROM 'true'`),
                    ],
                },
                    ...(transaction ? { transaction } : {}),
                },
            );
            const updatedCount = Array.isArray(claimResult) ? claimResult[0] : 1;
            if (updatedCount !== 1) return false;
            message.metadata = claimedMetadata;
            message.delivery_state = MESSAGE_DELIVERY_STATES.SEND_PENDING;
            return true;
        };

        // PostgreSQL is the production concurrency boundary. SQLite unit
        // fixtures lack the conversation table and use the Redis fallback.
        if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
            return sequelize.transaction((transaction) => claim(transaction));
        }
        return claim(null);
    }

    // Focused unit harnesses may not expose a static update method. Keep the
    // Redis claim as a compatibility fallback; production uses the row fence.
    return claimDedupKey(`provider-send:${idempotencyKey}`);
}

/**
 * Move the candidate across the irreversible provider boundary. This second
 * conditional update is deliberately separate from the candidate claim: a
 * merchant reply can cancel a claimed-but-not-started send, while a provider
 * call that has actually started remains reconciliation-visible.
 */
async function claimProviderSendBoundary(message, idempotencyKey, shopId) {
    if (!message?.id || !idempotencyKey) return { allowed: false, reason: 'candidate_invalidated' };
    if (typeof Message.update !== 'function') return { allowed: true, reason: null };

    const attempt = async (transaction) => {
        const conversation = typeof Conversation.findOne === 'function'
            ? await Conversation.findOne({
                where: { id: message.conversation_id, shop_id: shopId },
                attributes: ['id', 'customer_id', 'channel', 'hitl', 'status', 'metadata'],
                ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
            })
            : null;
        if (!conversation) return { allowed: false, reason: 'conversation_unavailable' };
        if (conversation.hitl === true) return { allowed: false, reason: 'human_active' };
        if (['closed', 'archived'].includes(conversation.status)) {
            return { allowed: false, reason: 'conversation_closed' };
        }
        const resumeBoundaryState = resumeBoundaryStateFor(conversation);
        if (resumeBoundaryState.present && !resumeBoundaryState.valid) {
            return { allowed: false, reason: 'resume_boundary_invalid' };
        }
        if (resumeBoundaryState.valid && !candidateStartedAtStateFor(message).valid) {
            return { allowed: false, reason: 'resume_candidate_timestamp_invalid' };
        }
        if (resumeBoundaryState.valid
            && messageMetadata(message).provider_send_attempted !== true
            && isBeforeResumeBoundary(message, resumeBoundaryState.timestamp)) {
            return { allowed: false, reason: 'resume_obsolete' };
        }
        const currentBusinessMode = await getEffectiveAiReplyMode(shopId);
        if (!isAutoSendMode(currentBusinessMode)) {
            return { allowed: false, reason: 'mode_changed' };
        }
        if (typeof cacheRedis.get === 'function' && await cacheRedis.get(`ai:pause:${message.conversation_id}`)) {
            return { allowed: false, reason: 'ai_paused' };
        }

        if (typeof Message.findOne === 'function') {
            const [latestBusiness, latestCustomer] = await Promise.all([
                Message.findOne({
                    where: { conversation_id: message.conversation_id, sender: 'business' },
                    order: [['created_at', 'DESC']],
                    attributes: ['created_at'],
                    ...(transaction ? { transaction } : {}),
                }),
                Message.findOne({
                    where: { conversation_id: message.conversation_id, sender: 'customer' },
                    order: [['created_at', 'DESC']],
                    attributes: ['created_at'],
                    ...(transaction ? { transaction } : {}),
                }),
            ]);
            if (latestBusiness && (!latestCustomer
                || new Date(latestBusiness.created_at).getTime() >= new Date(latestCustomer.created_at).getTime())) {
                return { allowed: false, reason: 'human_active' };
            }
        }

        if (conversation.customer_id && typeof Customer.findOne === 'function') {
            const customer = await Customer.findOne({
                where: { id: conversation.customer_id, shop_id: shopId },
                attributes: ['id', 'messaging_consent'],
                ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
            });
            const consentPlatform = conversation.channel === 'instagram' ? 'instagram' : 'facebook';
            if (!customer || customer.messaging_consent?.[consentPlatform]?.opted_out_at) {
                return { allowed: false, reason: 'opted_out' };
            }
        }

        const metadata = messageMetadata(message);
        const attemptedMetadata = {
            ...metadata,
            provider_send_attempted: true,
            provider_send_claimed: true,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            delivery_status: 'pending',
            delivered: false,
        };
        const attemptResult = await Message.update(
            {
                metadata: attemptedMetadata,
                delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            },
            {
                where: {
                    id: message.id,
                    conversation_id: message.conversation_id,
                    sender: 'ai',
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    provider_message_id: null,
                    send_idempotency_key: idempotencyKey,
                    [Op.and]: [
                        literal(`(metadata->>'provider_send_claimed') = 'true'`),
                        literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`),
                    ],
                },
                ...(transaction ? { transaction } : {}),
            },
        );
        const updatedCount = Array.isArray(attemptResult) ? attemptResult[0] : 1;
        if (updatedCount !== 1) return { allowed: false, reason: 'candidate_invalidated' };
        message.metadata = attemptedMetadata;
        message.delivery_state = MESSAGE_DELIVERY_STATES.SEND_PENDING;
        return { allowed: true, reason: null };
    };

    if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
        return sequelize.transaction((transaction) => attempt(transaction));
    }
    return attempt(null);
}

async function releaseAutomaticCandidate(message, idempotencyKey) {
    if (message?.id && typeof Message.update === 'function') {
        const metadata = messageMetadata(message);
        const retryMetadata = {
            ...metadata,
            delivered: false,
            delivery_status: 'pending',
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            provider_send_claimed: false,
            provider_send_claimed_at: null,
            provider_send_attempted: false,
        };
        await Message.update(
            { metadata: retryMetadata, delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING },
            {
                where: {
                    id: message.id,
                    conversation_id: message.conversation_id,
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    provider_message_id: null,
                },
            },
        );
        message.metadata = retryMetadata;
        return;
    }
    if (typeof cacheRedis.del === 'function') {
        await cacheRedis.del(`provider-send:${idempotencyKey}`).catch(() => {});
    }
}

/**
 * Recovery callers may opt into a durable provider-delay holding message. The
 * normal AI pipeline keeps that customer-facing message suppressed while
 * context, grounding, and model work are still in flight; it still records the
 * timeout state so stalled turns remain observable and recoverable.
 */
function createRecoveryControl({
    turnId,
    shopId,
    conversationId,
    platform,
    recipientId,
    channel,
    language = 'en',
    turnStartedAt = new Date(),
    initialState = 'RECEIVED',
    providerDelayRecovery = true,
}) {
    const recovery = require('../modules/ai/recovery/turn-recovery.service');
    const { getHoldingTemplate } = require('../modules/ai/recovery/holding-templates');
    let currentState = initialState;
    let closed = false;
    let holdingSent = false;
    let holdingMessage = null;
    let providerAccepted = false;
    let providerAttempted = false;
    let inFlight = null;
    let policySettings = null;
    let resolvePolicySettings;
    const policySettingsReady = new Promise((resolve) => { resolvePolicySettings = resolve; });
    let hardTimeoutTransition = null;
    let providerDelayTransition = null;
    const startedAtMs = new Date(turnStartedAt).getTime();
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;

    const transitionTo = async (state, metadata = {}) => {
        currentState = state;
        try {
            await recovery.transition({ turnId, conversationId }, state, metadata);
        } catch (_) { /* telemetry must not fail the customer turn */ }
    };

    const sendHolding = async (recoveryKind, { hardTimeout = false } = {}) => {
        const suppressed = hardTimeout
            ? recovery.isHardTimeoutSuppressed(currentState)
            : recovery.isHoldingSuppressed(currentState);
        if (closed || suppressed) return;
        try {
            const conversation = typeof Conversation.findOne === 'function'
                ? await Conversation.findOne({
                    where: { id: conversationId, shop_id: shopId },
                    attributes: ['id', 'metadata'],
                })
                : null;
            const resumeBoundaryState = resumeBoundaryStateFor(conversation);
            const turnStartedState = timestampStateFor(turnStartedAt);
            const turnIsObsolete = !turnStartedState.valid
                || (resumeBoundaryState.present && (!resumeBoundaryState.valid
                    || isBeforeResumeBoundary({
                        metadata: { turn_started_at: turnStartedState.timestamp },
                        created_at: turnStartedState.timestamp,
                    }, resumeBoundaryState.timestamp)));
            if (turnIsObsolete) {
                if (holdingMessage?.id && typeof Message.update === 'function') {
                    const metadata = {
                        ...messageMetadata(holdingMessage),
                        delivered: false,
                        delivery_status: 'dismissed',
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                        held_reason: 'resume_obsolete',
                        dismissed_at: new Date().toISOString(),
                        dismissed_by_resume: true,
                    };
                    await Message.update({
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        metadata,
                    }, {
                        where: {
                            id: holdingMessage.id,
                            conversation_id: conversationId,
                            provider_message_id: null,
                            [Op.and]: [literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`)],
                        },
                    }).catch(() => {});
                    sseManager.emit(shopId, 'message_delivery_updated', {
                        conversation_id: conversationId,
                        message_id: holdingMessage.id,
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        metadata,
                    });
                }
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }
        } catch (_) {
            // A boundary read failure must not turn a held pre-resume turn into a send.
            return null;
        }
        if (hardTimeout) {
            await transitionTo('RETRY_PENDING', {
                recoveryKind,
                hardTimeoutAt: new Date().toISOString(),
            });
        }
        if (holdingSent) return;
        const holdingKey = `holding:${conversationId}:${turnId}:${recoveryKind}`;
        const providerName = platform === 'messenger' ? 'facebook' : platform;
        const normalizedMessage = {
            text: getHoldingTemplate(recoveryKind, language),
            attachments: [],
            platform: providerName,
            direction: 'outbound',
            senderRole: 'ai',
        };
        if (!channel) {
            await transitionTo('RETRY_PENDING', {
                retryState: 'HOLDING_SEND_FAILED',
                recoveryKind,
                outboundStatus: 'FAILED',
            });
            return null;
        }
        await policySettingsReady;
        if (!policySettings
            || typeof policySettings !== 'object'
            || Array.isArray(policySettings)
            || typeof policySettings.automation_mode !== 'string'
            || policySettings.automation_mode.trim() === '') {
            await transitionTo('RETRY_PENDING', {
                retryState: 'HOLDING_SEND_FAILED',
                recoveryKind,
                outboundStatus: 'BLOCKED',
            });
            return null;
        }
        // Recovery timers can outlive the initial Guard 4 read. Do not let a
        // holding message bypass a later AUTO -> MANUAL change.
        const latestBusinessMode = await getEffectiveAiReplyMode(shopId);
        if (!isAutoSendMode(latestBusinessMode)) {
            await transitionTo('RETRY_PENDING', {
                retryState: 'HOLDING_SEND_FAILED',
                recoveryKind,
                outboundStatus: 'BLOCKED',
            });
            return null;
        }
        policySettings = {
            ...policySettings,
            automation_mode: latestBusinessMode,
        };
        if (closed || (hardTimeout
            ? recovery.isHardTimeoutSuppressed(currentState)
            : recovery.isHoldingSuppressed(currentState))) return null;
        let decision;
        try {
            const customerWhere = {
                shop_id: shopId,
                channel_type: providerName === 'facebook' ? 'messenger' : providerName,
                channel_user_id: String(recipientId),
            };
            const channelIdForLookup = UUID_PATTERN.test(String(channel?.id || '')) ? channel.id : null;
            let customer = channelIdForLookup
                ? await Customer.findOne({ where: { ...customerWhere, meta_channel_id: channelIdForLookup } })
                : null;
            if (!customer) {
                customer = await Customer.findOne({
                    where: { ...customerWhere, ...(channel?.id ? { meta_channel_id: null } : {}) },
                });
            }
            const expectedCustomerChannel = providerName === 'facebook' ? 'messenger' : providerName;
            if (!customer
                || String(customer.shop_id) !== String(shopId)
                || customer.channel_type !== expectedCustomerChannel
                || (channel?.id && customer.meta_channel_id != null
                    && String(customer.meta_channel_id) !== String(channel.id))) {
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }
            decision = await policyEngine.evaluateOutbound(normalizedMessage, {
                shopId,
                channelId: channel.id,
                conversationId,
                recipientId: String(recipientId),
                channel,
                customer,
                settings: policySettings,
                platform: providerName,
            });
            if (decision?.allow !== true) {
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }
        } catch (error) {
            await transitionTo('RETRY_PENDING', {
                retryState: 'HOLDING_SEND_FAILED',
                recoveryKind,
                outboundStatus: 'FAILED',
            });
            opsAlert('holding_message_delivery_failed', {
                detail: `shop=${shopId} conv=${conversationId} turn=${turnId}\nerror: ${error.message}`,
                level: 'error',
                context: { shopId, conversationId, turnId, recoveryKind },
            }).catch(() => {});
            return null;
        }
        let holdingDeliveryLock = null;
        try {
            if (typeof conversationLockService?.acquireForDelivery === 'function') {
                const lock = await conversationLockService.acquireForDelivery(conversationId, {
                    lockTimeoutMs: DELIVERY_LOCK_TIMEOUT_MS,
                    maxWaitMs: DELIVERY_LOCK_WAIT_MS,
                });
                if (lock?.available === false || (lock && !lock.success)) {
                    if (process.env.NODE_ENV !== 'test') {
                        await transitionTo('RETRY_PENDING', {
                            retryState: 'HOLDING_SEND_FAILED',
                            recoveryKind,
                            outboundStatus: 'BLOCKED',
                        });
                        return null;
                    }
                } else {
                    holdingDeliveryLock = lock?.success ? lock : null;
                }
            } else if (process.env.NODE_ENV !== 'test') {
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }

            // Re-read the boundary after taking the same delivery fence as
            // Resume. Either Resume wins and this turn is obsolete, or this
            // holding send owns the fence through the provider call.
            const latestConversation = typeof Conversation.findOne === 'function'
                ? await Conversation.findOne({
                    where: { id: conversationId, shop_id: shopId },
                    attributes: ['id', 'status', 'metadata'],
                })
                : null;
            const latestResumeBoundaryState = resumeBoundaryStateFor(latestConversation);
            const latestTurnStartedState = timestampStateFor(turnStartedAt);
            if (!latestTurnStartedState.valid
                || (latestResumeBoundaryState.present && (!latestResumeBoundaryState.valid
                    || isBeforeResumeBoundary({
                        metadata: { turn_started_at: latestTurnStartedState.timestamp },
                        created_at: latestTurnStartedState.timestamp,
                    }, latestResumeBoundaryState.timestamp)))) {
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }

            const finalSendGuard = await getAutomaticSendGuard(shopId, conversationId);
            if (!finalSendGuard.allowed) {
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    outboundStatus: 'BLOCKED',
                });
                return null;
            }
            // ponytail: Redis-durable dedup; move to a DB unique constraint if a lost key ever double-sends.
            if (!(await claimDedupKey(holdingKey))) {
                holdingSent = true;
                return null;
            }
            if (closed || (hardTimeout
                ? recovery.isHardTimeoutSuppressed(currentState)
                : recovery.isHoldingSuppressed(currentState))) {
                holdingSent = false;
                if (typeof cacheRedis.del === 'function') await cacheRedis.del(holdingKey).catch(() => {});
                return null;
            }

            holdingSent = true;
            providerAccepted = false;
            const content = normalizedMessage.text;
            if (!holdingMessage) {
                holdingMessage = await Message.create({
                    conversation_id: conversationId,
                    content,
                    sender: 'ai',
                    external_id: null,
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    delivery_source: 'HITL_ESCALATION',
                    provider_message_id: null,
                    send_idempotency_key: holdingKey.slice(0, 128),
                    metadata: {
                        type: 'recovery_holding',
                        recovery_kind: recoveryKind,
                        turn_id: turnId,
                        delivered: false,
                        delivery_status: 'pending',
                        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                        delivery_source: 'HITL_ESCALATION',
                        suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
                        logical_turn_id: turnId,
                        turn_started_at: turnStartedAt,
                    },
                });
                sseManager.emit(shopId, 'new_message', {
                    conversation_id: conversationId,
                    message: holdingMessage,
                });
            }
            const provider = getProvider(providerName);
            if (holdingMessage?.update) {
                await holdingMessage.update({
                    metadata: {
                        ...(holdingMessage.metadata || {}),
                        provider_send_attempted: true,
                        provider_send_claimed: true,
                    },
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                });
            }
            providerAttempted = true;
            const sendResult = await provider.sendMessage({
                channel,
                recipientId: String(recipientId),
                normalizedMessage: decision.transform || normalizedMessage,
                decision,
            });
            if (!providerSendSucceeded(sendResult)) {
                const error = new Error('Provider did not confirm the holding message send');
                error.code = 'PROVIDER_NO_SEND';
                throw error;
            }
            providerAccepted = true;
            if (holdingMessage?.update) {
                const providerMessageId = providerAcknowledgementId(sendResult);
                const providerMessageIds = Array.isArray(sendResult.providerMessageIds)
                    ? [...new Set(sendResult.providerMessageIds.filter(Boolean).map(String))]
                    : (providerMessageId ? [providerMessageId] : []);
                const sentMetadata = {
                    ...(holdingMessage.metadata || {}),
                    delivered: true,
                    delivery_status: 'sent',
                    delivery_state: MESSAGE_DELIVERY_STATES.SENT,
                    delivery_source: 'HITL_ESCALATION',
                    suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_SENT,
                    provider_send_confirmed: true,
                    provider_message_id: providerMessageId,
                    provider_message_ids: providerMessageIds,
                };
                holdingMessage.metadata = sentMetadata;
                holdingMessage.delivery_state = MESSAGE_DELIVERY_STATES.SENT;
                holdingMessage.provider_message_id = providerMessageId;
                holdingMessage.external_id = providerMessageId;
                await holdingMessage.update({
                    external_id: providerMessageId,
                    delivery_state: MESSAGE_DELIVERY_STATES.SENT,
                    delivery_source: 'HITL_ESCALATION',
                    provider_message_id: providerMessageId,
                    metadata: sentMetadata,
                });
                sseManager.emit(shopId, 'message_delivery_updated', {
                    conversation_id: conversationId,
                    message_id: holdingMessage.id,
                    delivery_state: MESSAGE_DELIVERY_STATES.SENT,
                    provider_message_id: providerMessageId,
                    metadata: holdingMessage.metadata,
                });
            }
            await transitionTo('RETRY_PENDING', {
                retryState: 'NOT_STARTED',
                recoveryKind,
                firstHoldingAt: new Date().toISOString(),
                outboundStatus: 'SENT',
            });
            return holdingMessage;
        } catch (error) {
            if (providerAccepted || providerAttempted) {
                holdingSent = true;
                await transitionTo('INDETERMINATE', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    firstHoldingAt: new Date().toISOString(),
                    outboundStatus: 'INDETERMINATE',
                });
            } else {
                holdingSent = false;
                if (typeof cacheRedis.del === 'function') await cacheRedis.del(holdingKey).catch(() => {});
                await transitionTo('RETRY_PENDING', {
                    retryState: 'HOLDING_SEND_FAILED',
                    recoveryKind,
                    firstHoldingAt: new Date().toISOString(),
                    outboundStatus: 'FAILED',
                });
            }
            opsAlert('holding_message_delivery_failed', {
                detail: `shop=${shopId} conv=${conversationId} turn=${turnId}\nerror: ${error.message}`,
                level: 'error',
                context: { shopId, conversationId, turnId, recoveryKind, providerAccepted },
            }).catch(() => {});
            return null;
        } finally {
            if (holdingDeliveryLock?.success && typeof conversationLockService?.releaseLock === 'function') {
                await conversationLockService.releaseLock(conversationId, holdingDeliveryLock.lockId).catch(() => {});
            }
        }
    };

    const scheduleHolding = (recoveryKind, options) => {
        if (inFlight) {
            if (options?.hardTimeout
                && !closed
                && !recovery.isHardTimeoutSuppressed(currentState)) {
                // Do not mutate currentState while the already-running holding
                // send is awaiting its provider/database work. That would make
                // the in-flight send observe its own hard-timeout state and
                // suppress itself. The durable timeout marker is written after
                // the in-flight attempt settles.
                hardTimeoutTransition = inFlight.then(() => recovery.transition(
                    { turnId, conversationId },
                    'RETRY_PENDING',
                    { recoveryKind, hardTimeoutAt: new Date().toISOString() },
                )).catch(() => {});
            }
            return inFlight;
        }
        inFlight = sendHolding(recoveryKind, options).finally(() => {
            inFlight = null;
        });
        return inFlight;
    };
    const recordProviderDelay = ({ hardTimeout = false } = {}) => {
        const transition = transitionTo('RETRY_PENDING', {
            recoveryKind: 'PROVIDER_DELAY',
            retryState: hardTimeout ? 'HARD_TIMEOUT' : 'PROVIDER_DELAY',
            outboundStatus: 'PENDING',
            ...(hardTimeout ? { hardTimeoutAt: new Date().toISOString() } : {}),
        });
        providerDelayTransition = transition;
        if (hardTimeout) hardTimeoutTransition = transition;
        return transition;
    };
    const scheduleProviderDelay = (options) => (
        providerDelayRecovery ? scheduleHolding('PROVIDER_DELAY', options) : recordProviderDelay(options)
    );
    const fiveSecondTimer = setTimeout(
        () => { void scheduleProviderDelay(); },
        Math.max(0, 5000 - elapsedMs),
    );
    const eightSecondTimer = setTimeout(
        () => { void scheduleProviderDelay({ hardTimeout: true }); },
        Math.max(0, 8000 - elapsedMs),
    );

    if (!providerDelayRecovery) {
        lifecycleLogger.info('ai_recovery_provider_delay_holding_suppressed', {
            shopId,
            conversationId,
            turnId,
            stage: 'AI_PIPELINE_BEFORE_PROVIDER_BOUNDARY',
            decision: 'RECORD_TIMEOUT_WITHOUT_PROVIDER_MESSAGE',
            reason: 'model_and_grounding_work_must_not_emit_a_provider_holding_message',
        });
    }

    return {
        transitionTo,
        complete: async (state, metadata = {}) => {
            if (state === 'SENT' && inFlight) await inFlight;
            if (state === 'SENT' && hardTimeoutTransition) await hardTimeoutTransition;
            if (state === 'SENT' && providerDelayTransition) await providerDelayTransition;
            closed = true;
            clearTimeout(fiveSecondTimer);
            clearTimeout(eightSecondTimer);
            resolvePolicySettings(policySettings);
            await transitionTo(state, metadata);
        },
        setPolicySettings: (settings) => {
            policySettings = settings && typeof settings === 'object' && !Array.isArray(settings)
                ? settings
                : null;
            resolvePolicySettings(policySettings);
        },
        flush: () => inFlight || Promise.resolve(),
        close: () => {
            closed = true;
            resolvePolicySettings(policySettings);
            clearTimeout(fiveSecondTimer);
            clearTimeout(eightSecondTimer);
            return Promise.all([inFlight, hardTimeoutTransition, providerDelayTransition].filter(Boolean));
        },
        sendHolding: scheduleHolding,
    };
}

async function requireHumanRecovery({
    turnId,
    traceId,
    turnStartedAt,
    recoveryAvailable,
    conversation,
    shopId,
    conversationId,
    platform,
    recipientId,
    channel,
    reason,
}) {
    try {
        const recovery = require('../modules/ai/recovery/turn-recovery.service');
        return await recovery.requireHuman({
            turnId,
            traceId: traceId || turnId,
            turnStartedAt,
            conversation,
            shopId,
            conversationId,
            platform,
            recipientId,
            channel,
            reason,
        });
    } catch (recoveryErr) {
        if (recoveryErr?.retryable) throw recoveryErr;
        if (recoveryAvailable || process.env.NODE_ENV !== 'test') {
            opsAlert('human_recovery_transaction_failed', {
                detail: `shop=${shopId} conv=${conversationId} turn=${turnId}\nerror: ${recoveryErr.message}`,
                level: 'error',
                context: { shopId, conversationId, turnId, reason },
            }).catch(() => {});
            return null;
        }
        // Unit-only compatibility fallback for harnesses that do not load the
        // recovery table. Production never flips HITL outside the transaction.
        const { escalateToHuman } = require('../modules/conversation/human-handoff.service');
        return escalateToHuman({ conversation, shopId, conversationId, platform, recipientId, channel, reason })
            .catch((handoffErr) => {
                console.error(`[worker] Human recovery failed for conv ${conversationId}: ${recoveryErr.message}; handoff: ${handoffErr.message}`);
                return null;
            });
    }
}

async function resolveStaticConfigAvailability(shopId, aiSettings = {}) {
    if (aiSettings.staticConfigAvailable !== undefined) return aiSettings.staticConfigAvailable;
    try {
        const { Shop } = require('../modules/entities');
        const shop = await Shop.findByPk(shopId, { attributes: ['settings'] });
        const settings = shop?.settings || {};
        const delivery = settings.delivery || {};
        const businessInfo = settings.businessInfo || {};
        const hasDeliveryPolicy = Boolean(
            delivery.policy
            || businessInfo.deliveryPolicy
            || (Array.isArray(businessInfo.deliveryAreas) && businessInfo.deliveryAreas.length > 0),
        );
        const hasDeliveryCharge = Boolean(
            (Array.isArray(delivery.area_pricing) && delivery.area_pricing.length > 0)
            || delivery.default_delivery_charge !== undefined,
        );
        return { DELIVERY_POLICY: hasDeliveryPolicy, DELIVERY_CHARGE: hasDeliveryCharge };
    } catch (_) {
        return false;
    }
}

/**
 * Stamp the delivery outcome on a stored AI message and emit it to agent tabs.
 *
 * `delivered:false` flags the message as a HELD suggestion the inbox should
 * surface (Use this / Edit / Ignore); `delivered:true` is a normal sent reply
 * and shows no suggestion panel. `held_reason` lets the UI distinguish a
 * low-confidence hold (shows an "AI wasn't sure" note) from a draft/policy hold.
 *
 * The SSE emit moved here (from immediately after storeAIResponse) so connected
 * agent tabs receive the message with its final delivery flag already set.
 */
async function finalizeAiMessage(
    aiMessage,
    shopId,
    conversationId,
    {
        delivered,
        heldReason = null,
        providerMessageId = null,
        providerMessageIds = [],
        providerComponents = [],
        providerFailure = null,
        deliveryState = null,
        deliverySource = 'AUTO',
        suggestionVisibility = null,
    },
) {
    const acknowledgedProviderIds = [
        ...(Array.isArray(providerMessageIds) ? providerMessageIds : []),
        providerMessageId,
    ].filter((id, index, ids) => id && ids.indexOf(id) === index).map(String);
    const primaryProviderMessageId = providerMessageId || acknowledgedProviderIds[acknowledgedProviderIds.length - 1] || null;
    if (delivered && !primaryProviderMessageId) {
        const error = new Error('Provider acknowledgement did not include a message ID');
        error.code = 'PROVIDER_NO_ACK';
        throw error;
    }

    let currentMessage = aiMessage;
    let lifecycleReadError = null;
    if (aiMessage?.id && typeof Message.findOne === 'function') {
        try {
            currentMessage = await Message.findOne({
                where: { id: aiMessage.id, conversation_id: conversationId, sender: 'ai' },
            }) || aiMessage;
        } catch (err) {
            console.warn(`[worker] Failed to re-read AI message lifecycle: ${err.message}`);
            lifecycleReadError = err;
        }
    }
    if (lifecycleReadError) {
        return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
    }

    // Resume AI establishes a durable boundary, not just a boolean toggle. A
    // worker that started before Resume may finish generation afterward; it is
    // allowed to persist history, but it must never recreate reviewable work.
    if (currentMessage && !isProviderConfirmed(currentMessage)
        && messageMetadata(currentMessage).provider_send_attempted !== true
        && typeof Conversation.findOne === 'function') {
        try {
            const conversation = await Conversation.findOne({
                where: { id: conversationId },
                attributes: ['id', 'metadata'],
            });
            if (!conversation && process.env.NODE_ENV !== 'test') {
                return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
            }
            const resumeBoundaryState = resumeBoundaryStateFor(conversation);
            const candidateStartedAt = candidateStartedAtFor(currentMessage);
            if (resumeBoundaryState.present && !resumeBoundaryState.valid) {
                return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
            }
            if (resumeBoundaryState.valid && candidateStartedAt === null) {
                return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
            }
            if (resumeBoundaryState.valid && isBeforeResumeBoundary(currentMessage, resumeBoundaryState.timestamp)) {
                const resumeMetadata = {
                    ...messageMetadata(currentMessage),
                    delivered: false,
                    delivery_status: 'dismissed',
                    delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                    suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                    held_reason: 'resume_obsolete',
                    dismissed_at: new Date().toISOString(),
                    dismissed_by_resume: true,
                    provider_message_id: null,
                };
                const result = typeof Message.update === 'function'
                    ? await Message.update({
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        delivery_source: currentMessage.delivery_source || resumeMetadata.delivery_source || 'AUTO',
                        provider_message_id: null,
                        metadata: resumeMetadata,
                    }, {
                        where: {
                            id: currentMessage.id,
                            conversation_id: conversationId,
                            sender: 'ai',
                            provider_message_id: null,
                            [Op.and]: [literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`)],
                        },
                    })
                    : [1];
                const updatedCount = Array.isArray(result) ? result[0] : 1;
                if (updatedCount === 1 || normalizeDeliveryState(currentMessage) === MESSAGE_DELIVERY_STATES.DISMISSED) {
                    currentMessage.metadata = resumeMetadata;
                    currentMessage.delivery_state = MESSAGE_DELIVERY_STATES.DISMISSED;
                    currentMessage.provider_message_id = null;
                    sseManager.emit(shopId, 'message_delivery_updated', {
                        conversation_id: conversationId,
                        message_id: currentMessage.id,
                        metadata: resumeMetadata,
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        delivery_source: currentMessage.delivery_source || resumeMetadata.delivery_source || 'AUTO',
                        provider_message_id: null,
                    });
                    return { providerConfirmed: false, persisted: true, resumeObsolete: true, message: currentMessage };
                }
            }
        } catch (err) {
            console.warn(`[worker] Failed to enforce Resume boundary on AI message: ${err.message}`);
            return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
        }
    }

    // A Meta echo can win the race with the original provider request. Never
    // downgrade that durable truth to FAILED, and never replace its MID with a
    // stale response from the request that timed out.
    if (isProviderConfirmed(currentMessage)) {
        if (delivered && acknowledgedProviderIds.length > 0 && typeof Message.update === 'function') {
            const mergeConfirmedProviderIds = async (transaction = null) => {
                const locked = typeof Message.findOne === 'function'
                    ? await Message.findOne({
                        where: { id: currentMessage.id, conversation_id: conversationId, sender: 'ai' },
                        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                    })
                    : currentMessage;
                if (!locked) return;
                const lockedMetadata = messageMetadata(locked);
                const mergedProviderIds = [
                    ...(Array.isArray(lockedMetadata.provider_message_ids) ? lockedMetadata.provider_message_ids : []),
                    locked.provider_message_id,
                    lockedMetadata.provider_message_id,
                    ...acknowledgedProviderIds,
                ].filter((id, index, ids) => id && ids.indexOf(id) === index);
                const mergedMetadata = {
                    ...lockedMetadata,
                    provider_message_ids: mergedProviderIds,
                    ...(delivered ? {
                        provider_accepted_at: lockedMetadata.provider_accepted_at || new Date().toISOString(),
                    } : {}),
                };
                await Message.update({ metadata: mergedMetadata }, {
                    where: { id: currentMessage.id, conversation_id: conversationId, sender: 'ai' },
                    ...(transaction ? { transaction } : {}),
                });
                currentMessage.metadata = mergedMetadata;
                currentMessage.provider_message_id = locked.provider_message_id
                    || lockedMetadata.provider_message_id
                    || primaryProviderMessageId;
            };
            if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
                await sequelize.transaction((transaction) => mergeConfirmedProviderIds(transaction));
            } else {
                await mergeConfirmedProviderIds();
            }
        }
        const confirmedMetadata = messageMetadata(currentMessage);
        const confirmedState = normalizeDeliveryState(currentMessage);
        const confirmedProviderMessageId = currentMessage.provider_message_id
            || confirmedMetadata.provider_message_id
            || null;
        sseManager.emit(shopId, 'message_delivery_updated', {
            conversation_id: conversationId,
            message_id: currentMessage.id,
            metadata: confirmedMetadata,
            delivery_state: confirmedState,
            provider_message_id: confirmedProviderMessageId,
            delivery_source: currentMessage.delivery_source || confirmedMetadata.delivery_source || null,
            content: currentMessage.content || null,
            sender: currentMessage.sender === 'business' ? 'agent' : currentMessage.sender || null,
            created_at: currentMessage.created_at || null,
        });
        await recordAcceptedAiReplyShadow(shopId, currentMessage);
        return { providerConfirmed: true, persisted: false, message: currentMessage };
    }

    const resolvedState = deliveryState || (delivered
        ? MESSAGE_DELIVERY_STATES.SENT
        : heldReason === 'draft_mode'
            ? MESSAGE_DELIVERY_STATES.DRAFT_READY
            : MESSAGE_DELIVERY_STATES.HELD);
    const resolvedVisibility = suggestionVisibility || (delivered
        ? SUGGESTION_VISIBILITY.HIDDEN_SENT
        : resolvedState === MESSAGE_DELIVERY_STATES.DRAFT_READY
            ? SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW
            : SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW);
    const resolvedMetadata = {
        ...messageMetadata(currentMessage),
        delivered: Boolean(delivered),
        delivery_status: delivered ? 'sent' : resolvedState === MESSAGE_DELIVERY_STATES.DRAFT_READY ? 'pending' : 'held',
        delivery_state: resolvedState,
        delivery_source: deliverySource,
        held_reason: heldReason,
        suggestion_visibility: resolvedVisibility,
        // Meta's own mid for the reply — the only durable link between our row
        // and what the customer actually received.
        provider_message_id: primaryProviderMessageId,
        ...(acknowledgedProviderIds.length > 0 ? { provider_message_ids: acknowledgedProviderIds } : {}),
        ...(Array.isArray(providerComponents) && providerComponents.length > 0
            ? { provider_components: providerComponents }
            : {}),
        ...(providerFailure ? { provider_failure: providerFailure } : {}),
        provider_send_confirmed: Boolean(delivered),
        ...(delivered ? {
            provider_accepted_at: messageMetadata(currentMessage).provider_accepted_at || new Date().toISOString(),
        } : {}),
        ...(heldReason === 'provider_send_failed' ? { provider_send_attempted: true } : {}),
    };
    lifecycleLogger.info(
        resolvedState === MESSAGE_DELIVERY_STATES.DRAFT_READY
            ? 'ai_draft_ready'
            : delivered
                ? 'ai_provider_send_success'
                : 'ai_candidate_held',
        {
            shopId,
            conversationId,
            messageId: aiMessage?.id || null,
            deliveryState: resolvedState,
            providerMessageId: primaryProviderMessageId,
            providerMessageIds: acknowledgedProviderIds,
            heldReason,
        },
    );
    if (resolvedVisibility === SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW) {
        lifecycleLogger.info('ai_suggestion_shown_hitl', {
            shopId,
            conversationId,
            messageId: aiMessage?.id || null,
            heldReason,
        });
    }
    const updateValues = {
        ...(providerMessageId ? { external_id: providerMessageId } : {}),
        metadata: resolvedMetadata,
        delivery_state: resolvedState,
        delivery_source: deliverySource,
        provider_message_id: primaryProviderMessageId,
    };
    if (currentMessage) {
        const providerBoundaryFinalization = delivered || heldReason === 'provider_send_failed';
        let providerOutcomePersisted = false;
        try {
            if (providerBoundaryFinalization && typeof Message.update === 'function') {
                const finalizationResult = await Message.update(updateValues, {
                    where: {
                        id: currentMessage.id,
                        conversation_id: conversationId,
                        sender: 'ai',
                        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                        provider_message_id: null,
                    },
                });
                const updatedCount = Array.isArray(finalizationResult) ? finalizationResult[0] : 1;
                if (updatedCount !== 1) {
                    const latest = typeof Message.findOne === 'function'
                        ? await Message.findOne({
                            where: { id: currentMessage.id, conversation_id: conversationId, sender: 'ai' },
                        })
                        : null;
                    if (latest && isProviderConfirmed(latest)) {
                        const latestMetadata = messageMetadata(latest);
                        const latestProviderMessageId = latest.provider_message_id
                            || latestMetadata.provider_message_id
                            || primaryProviderMessageId;
                        const latestProviderMessageIds = [
                            ...(Array.isArray(latestMetadata.provider_message_ids)
                                ? latestMetadata.provider_message_ids
                                : []),
                            ...acknowledgedProviderIds,
                            latestProviderMessageId,
                        ].filter((id, index, ids) => id && ids.indexOf(id) === index);
                        return finalizeAiMessage(latest, shopId, conversationId, {
                            delivered: true,
                            providerMessageId: latestProviderMessageId,
                            providerMessageIds: latestProviderMessageIds,
                        });
                    }
                    const error = new Error('AI message lifecycle changed before provider outcome was persisted');
                    error.code = 'LIFECYCLE_CONFLICT';
                    throw error;
                }
                providerOutcomePersisted = Boolean(delivered);
            } else if (typeof Message.update === 'function') {
                const finalizationResult = await Message.update(updateValues, {
                    where: {
                        id: currentMessage.id,
                        conversation_id: conversationId,
                        sender: 'ai',
                        provider_message_id: null,
                        delivery_state: { [Op.ne]: MESSAGE_DELIVERY_STATES.DISMISSED },
                        [Op.and]: [literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`)],
                    },
                });
                const updatedCount = Array.isArray(finalizationResult) ? finalizationResult[0] : 1;
                if (updatedCount !== 1) {
                    const latest = typeof Message.findOne === 'function'
                        ? await Message.findOne({
                            where: { id: currentMessage.id, conversation_id: conversationId, sender: 'ai' },
                        })
                        : null;
                    if (latest && isProviderConfirmed(latest)) {
                        return { providerConfirmed: true, persisted: false, message: latest };
                    }
                    if (latest && normalizeDeliveryState(latest) === MESSAGE_DELIVERY_STATES.DISMISSED) {
                        return { providerConfirmed: false, persisted: false, resumeObsolete: true, message: latest };
                    }
                    const error = new Error('AI message lifecycle changed before non-provider outcome was persisted');
                    error.code = 'LIFECYCLE_CONFLICT';
                    throw error;
                }
            } else if (typeof currentMessage.update === 'function') {
                // Focused unit harnesses may only expose the instance API. Production
                // always has the conditional static update above.
                await currentMessage.update(updateValues);
                providerOutcomePersisted = Boolean(delivered);
            }
            currentMessage.metadata = resolvedMetadata;
            currentMessage.delivery_state = resolvedState;
            currentMessage.delivery_source = deliverySource;
            currentMessage.provider_message_id = primaryProviderMessageId;
            if (delivered && providerOutcomePersisted) {
                await recordAcceptedAiReplyShadow(shopId, currentMessage);
            }
            if (delivered && typeof Conversation.update === 'function' && currentMessage.content) {
                await Conversation.update(
                    { message: currentMessage.content },
                    { where: { id: conversationId, shop_id: shopId } },
                );
            }
        } catch (err) {
            if (providerBoundaryFinalization) throw err;
            console.warn(`[worker] Failed to stamp delivery flag on AI message: ${err.message}`);
            return { providerConfirmed: false, persisted: false, invalidated: true, message: currentMessage };
        }
    }
    const message = currentMessage?.toJSON ? currentMessage.toJSON() : currentMessage;
    sseManager.emit(shopId, 'new_message', {
        conversation_id: conversationId,
        message: message
            ? {
                ...message,
                metadata: resolvedMetadata,
                delivery_state: resolvedState,
                delivery_source: deliverySource,
                provider_message_id: primaryProviderMessageId,
                is_transcript_message: Boolean(delivered),
            }
            : null,
    });
    return { providerConfirmed: Boolean(delivered), persisted: true, message: currentMessage };
}

/**
 * Make a billing pause visible to the merchant, without telling the customer.
 *
 * Pausing the AI when billing lapses is correct; leaving nobody aware of it is
 * not. The customer's message is stored and the inbox still works, but before
 * this the only trace was a console line: the merchant saw a message arrive and
 * no reply, with nothing anywhere saying why. The one job that alerts on a
 * waiting customer (customer-waiting-notifier) only scans conversations flagged
 * `hitl`, which these never are, so it could not see them either.
 *
 * Deliberately merchant-only. Nothing is sent to the customer: a suspended shop
 * may have churned, so an automated "the shop will reply shortly" is a promise
 * we cannot keep, and it would spend Send API calls on a shop that is not paying.
 * The customer is never told anything about the merchant's billing.
 *
 * Deliberately does NOT set `hitl`. The HITL guard runs *before* this one, so
 * flagging the conversation would outlive the pause — paying the invoice would
 * restore billing but the AI would stay silent on every conversation touched
 * while suspended, until a human cleared each one by hand.
 *
 * Best-effort throughout: the reply is already being withheld, and a failure to
 * announce that must not also fail the job and send it to the DLQ.
 */
async function signalBillingPause({ shopId, conversationId, messageId, status, platform }) {
    // Why the AI stayed silent, on the message itself — a container log rotates,
    // and "why did my customer get no answer on the 3rd?" is asked much later.
    try {
        if (messageId) {
            const inbound = await Message.findByPk(messageId);
            if (inbound) {
                await inbound.update({
                    metadata: {
                        ...(inbound.metadata || {}),
                        ai_skipped_reason: 'subscription_inactive',
                        ai_skipped_at: new Date().toISOString(),
                        subscription_status: status || null,
                    },
                });
            }
        }
    } catch (err) {
        console.warn(`[worker] Could not record billing pause on message ${messageId}: ${err.message}`);
    }

    // One alert per shop per day, however many customers write in. The merchant
    // needs to know they have customers waiting, not one notification each.
    try {
        const merchantNotificationService = require('../modules/notification/merchant-notification.service');
        const { NOTIFICATION_EVENTS } = require('../modules/notification/notification-events');
        await merchantNotificationService.notifyShop(
            shopId,
            NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE,
            {
                issue: 'AI replies are paused because your subscription needs attention. '
                    + 'Customer messages are arriving and waiting for a manual reply.',
                subscriptionStatus: status || 'unknown',
                conversationId,
                platform,
            },
            {
                dedupeKey: `billing_paused:${shopId}:${new Date().toISOString().split('T')[0]}`,
                dedupeTtlSeconds: 24 * 60 * 60,
            },
        );
    } catch (err) {
        console.warn(`[worker] Could not queue billing-pause alert for shop ${shopId}: ${err.message}`);
    }

    // Open dashboards reflect it immediately rather than at the next poll.
    try {
        sseManager.emit(shopId, 'ai_paused', {
            conversation_id: conversationId,
            reason: 'subscription_inactive',
        });
    } catch (_) { /* SSE is a convenience, never a requirement */ }
}

/**
 * Legacy conversation-quota decision — RETIRED by ADR-0011.
 *
 * The commercial contract sets `conversationEntitlement = null`: no conversation
 * is metered, capped or sold, and there is no monthly reset. Usage events
 * remain non-gating telemetry. Automated replies are gated solely by billing
 * status (Guard 4c / `isAiActive`), which runs before this decision.
 *
 * Kept as a function so pre-cutover jobs and callers keep resolving; it no
 * longer reads `within_allowance`, conversation metadata or quota fields, so an
 * exhausted historical counter can never silently withhold a reply again.
 *
 * @returns {boolean} true when the shop has a subscription row; false only when
 *          no row exists (entitlement cannot be proven — fail closed).
 */
function resolveAllowanceDecision({ subscription } = {}) {
    return Boolean(subscription);
}

/**
 * Core job handler. Called by the BullMQ worker for each message job.
 *
 * Expected job.data shape:
 *   shopId, conversationId, messageId, externalId, message,
 *   platform, recipientId, senderInfo, metaChannelId, metaAssetId, replyContext
 */
async function processMessageJob(job) {
    // ── Canary short-circuit ────────────────────────────────────────────────
    // Synthetic probe enqueued by pipeline-canary.job.js to prove the
    // enqueue → worker → complete loop is alive (the exact path the BullMQ jobId
    // bug silently broke). Sets a heartbeat and returns BEFORE any DB / AI / send
    // work, so it costs nothing and never messages a real customer.
    if (job.data && job.data.canary) {
        try { await cacheRedis.set('canary:msg:last_ok', String(Date.now())); } catch (_) { /* best-effort */ }
        return { canary: true, ok: true };
    }
    const workerJob = job;

    const {
        shopId,
        conversationId,
        messageId,
        externalId,
        message,
        platform,
        recipientId,
        senderInfo = {},
        metaChannelId = null,
        metaAssetId = null,
        traceId: jobTraceId = null,
        idempotencyKey: jobIdempotencyKey = null,
        turnId: requestedTurnId = null,
        within_allowance: jobWithinAllowance,
        replyContext: jobReplyContext = null,
    } = job.data;

    // ── Burst flush: coalesce a rapid-fire multi-message turn into ONE reply ──
    // A burst-flush job carries no single message — it stands in for every
    // unanswered customer message in the conversation. Load them, fold them into
    // one turn, and feed the rest of the pipeline as if they were one message.
    // See burst-coalescer.js for why this exists (multi-message → one answer).
    let effMessage = message;
    let effExternalId = externalId;
    let effImageUrls = [];
    let historyExcludeIds = messageId ? [messageId] : [];
    let replyContext = jobReplyContext;
    let logicalTurnId = null;
    let burstTurnMessages = null;
    if (job.data.burstFlush) {
        const burst = require('../jobs/burst-coalescer');
        await burst.clearBurstState(conversationId); // next inbound opens a fresh window
        const turn = await burst.loadPendingCustomerTurn(conversationId);
        if (!turn.messages.length) {
            return { skipped: true, reason: 'burst_already_handled' };
        }
        effMessage = turn.combinedText || '';
        // Dedup anchor for the coalesced reply — a retried flush won't double-send.
        effExternalId = `burst:${turn.lastMessageId}`;
        effImageUrls = turn.imageUrls;
        historyExcludeIds = turn.messageIds;
        replyContext = turn.messages.at(-1)?.metadata?.reply_to || null;
        logicalTurnId = turn.logicalTurnId;
        burstTurnMessages = turn.messages;
    }

    // P+02: an interactive choice tap arrives as an ordinary (text-empty)
    // inbound whose durable row carries quick_reply.payload — the ingress
    // already verified signature, persisted the receipt and deduped. Here we
    // only READ the reference; execution happens after the guards, through the
    // interaction kernel, which reloads all business state server-side.
    let tappedPayload = null;
    try {
        if (job.data.burstFlush) {
            tappedPayload = burstTurnMessages?.at(-1)?.metadata?.quick_reply?.payload || null;
        } else if (messageId && typeof Message.findByPk === 'function') {
            const inboundRow = await Message.findByPk(messageId, { attributes: ['metadata'] });
            tappedPayload = inboundRow?.metadata?.quick_reply?.payload || null;
        }
    } catch (_) { tappedPayload = null; }

    // P+05 hygiene: gap evidence stores the LAST customer utterance of a burst
    // turn, not the concatenated mini-transcript (PII surface reduction; the
    // capture service masks the rest).
    const gapUtterance = burstTurnMessages?.at(-1)?.content || effMessage;

    // Resolve the channel once and pass it to every step that needs it. With
    // multi-page shops (one shop owns N FB Pages), routing
    // every send back through the same channel the message arrived on is the
    // only correct behavior — see Phase 1-2 of the multi-channel rework.
    const jobChannel = await resolveChannelForJob(shopId, platform, metaChannelId, metaAssetId);
    if (!jobChannel) {
        const error = new Error(`Meta channel is unavailable for shop ${shopId} and platform ${platform}`);
        error.code = 'META_CHANNEL_UNAVAILABLE';
        error.retryable = true;
        throw error;
    }

    // ── Guard 1: Redis idempotency ──────────────────────────────────────────
    const dedupScope = metaChannelId || metaAssetId || platform || 'unknown';
    const dedupKey = effExternalId ? `msg:dedup:${shopId}:${dedupScope}:${effExternalId}` : null;
    const turnId = requestedTurnId || effExternalId || messageId || String(job.id);
    logicalTurnId = logicalTurnId || turnId;
    const automaticCandidateKey = deriveAutomaticSendIdempotencyKey({
        shopId,
        conversationId,
        turnId: logicalTurnId,
    });
    if (dedupKey) {
        const isNew = await claimDedupKey(dedupKey);
        if (!isNew) {
            const staleCandidate = typeof Message.findOne === 'function'
                ? await Message.findOne({
                    where: {
                        conversation_id: conversationId,
                        sender: 'ai',
                        send_idempotency_key: automaticCandidateKey,
                    },
                })
                : null;
            const staleMetadata = staleCandidate?.metadata && typeof staleCandidate.metadata === 'object'
                ? staleCandidate.metadata
                : {};
            const claimedAtMs = Date.parse(staleMetadata.provider_send_claimed_at || '');
            const staleClaim = staleCandidate
                && normalizeDeliveryState(staleCandidate) === MESSAGE_DELIVERY_STATES.SEND_PENDING
                && staleMetadata.provider_send_claimed === true
                && staleMetadata.provider_send_attempted !== true
                && (Number(workerJob.attemptsMade || 0) > 0
                    || !Number.isFinite(claimedAtMs)
                    || Date.now() - claimedAtMs > STALE_PROVIDER_CLAIM_MS);
            if (!staleClaim || !(await releaseStaleProviderClaim(staleCandidate))) {
                return { skipped: true, reason: 'duplicate', externalId: effExternalId };
            }
            await cacheRedis.del(dedupKey).catch(() => {});
        }
    }

    let recoveryControl = null;
    let recoveryStarted = false;
    let turnStartedAt = null;
    let deliveryLock = null;
    let stableTraceId = jobTraceId || job.id || effExternalId || conversationId;
    try {
        const recovery = require('../modules/ai/recovery/turn-recovery.service');
        const { deriveIdempotencyKey } = require('../modules/ai/contracts/action.contract');
        const started = await recovery.startTurn({
            turnId,
            traceId: stableTraceId,
            shopId,
            conversationId,
            idempotencyKey: jobIdempotencyKey || deriveIdempotencyKey(['turn', shopId, conversationId, turnId]),
        });
        const startedAtState = timestampStateFor(started?.turn?.turn_started_at);
        if (!startedAtState.valid) {
            const error = new Error(`Recovery returned an invalid durable turn start for ${turnId}`);
            error.code = 'TURN_START_UNAVAILABLE';
            error.retryable = true;
            throw error;
        }
        recoveryStarted = true;
        turnStartedAt = new Date(startedAtState.timestamp).toISOString();
        stableTraceId = started.turn.trace_id || stableTraceId;
        recoveryControl = createRecoveryControl({
            turnId,
            shopId,
            conversationId,
            platform,
            recipientId,
            channel: jobChannel,
            language: job.data.language || 'en',
            turnStartedAt: started.turn.turn_started_at,
            initialState: started.turn.state || 'RECEIVED',
            // A model can legitimately take longer than the recovery holding
            // threshold. Do not send a second provider message while the AI
            // pipeline is still before its irreversible send boundary.
            providerDelayRecovery: false,
        });
    } catch (recoveryErr) {
        console.warn(`[worker] Recovery state unavailable for turn ${turnId}: ${recoveryErr.message}`);
    }
    if (!turnStartedAt) {
        if (recoveryControl) await recoveryControl.close().catch(() => {});
        if (dedupKey) await cacheRedis.del(dedupKey).catch(() => {});
        const error = new Error(`Durable turn start is unavailable for ${turnId}`);
        error.code = 'TURN_START_UNAVAILABLE';
        error.retryable = true;
        throw error;
    }
    try {
    // ── Guard 2: HITL (human-in-the-loop) ──────────────────────────────────
    const conversation = await Conversation.findOne({
        where: { id: conversationId, shop_id: shopId },
        attributes: ['id', 'customer_id', 'channel', 'meta_channel_id', 'hitl', 'status', 'metadata'],
    });
    if (!conversation) {
        console.warn(`[worker] Conversation ${conversationId} not found for shop ${shopId} — skipping job`);
        return { skipped: true, reason: 'conversation_not_found' };
    }
    const resumeBoundaryState = resumeBoundaryStateFor(conversation);
    if (resumeBoundaryState.present && !resumeBoundaryState.valid) {
        const error = new Error(`Resume boundary is invalid for conversation ${conversationId}`);
        error.code = 'RESUME_BOUNDARY_INVALID';
        error.retryable = true;
        throw error;
    }
    await recoveryControl?.transitionTo('CONTEXT_BUILDING');
    if (conversation.hitl) return { skipped: true, reason: 'hitl_active' };
    if (['closed', 'archived'].includes(conversation.status)) {
        return { skipped: true, reason: 'conversation_closed' };
    }

    // ── Guard 3: AI pause (30-min mute when agent sends manually) ──────────
    const paused = await cacheRedis.get(`ai:pause:${conversationId}`);
    if (paused) return { skipped: true, reason: 'ai_paused' };

    // ── Guard 4: Automation mode ────────────────────────────────────────────
    // Only the business mode controls whether the AI pipeline runs. Page mode
    // fields are legacy data and cannot upgrade a MANUAL business.
    const [shopAISettings, channelAISettings] = await Promise.all([
        getShopAISettings(shopId),
        getChannelAISettings(jobChannel),
    ]);
    const businessMode = normalizeAiReplyMode(shopAISettings.automation_mode);
    const aiSettings = buildWorkerAiSettings(shopAISettings, channelAISettings, businessMode);
    recoveryControl?.setPolicySettings(aiSettings);
    if (businessMode === AI_REPLY_MODES.MANUAL) {
        try {
            const merchantNotificationService = require('../modules/notification/merchant-notification.service');
            const { NOTIFICATION_EVENTS } = require('../modules/notification/notification-events');
            await merchantNotificationService.notifyShop(
                shopId,
                NOTIFICATION_EVENTS.AI_HITL,
                {
                    reason: 'manual_mode_inbound_message',
                    conversationId,
                    lastMessage: effMessage ? String(effMessage).slice(0, 180) : undefined,
                },
                {
                    dedupeKey: `manual_mode:${conversationId}`,
                    dedupeTtlSeconds: 120,
                }
            ).catch(() => {});
        } catch {
            // notification failure must not fail the job
        }
        return { skipped: true, reason: 'manual_mode', scope: 'shop' };
    }


    // Replays and prospective mode changes must reuse the candidate already
    // associated with this turn. In particular, a DRAFT candidate must not be
    // upgraded into an AUTO send when the business mode changes later.
    const automaticSendIdempotencyKey = deriveAutomaticSendIdempotencyKey({
        shopId,
        conversationId,
        turnId: logicalTurnId,
    });
    let existingAutomaticCandidate = null;
    if (typeof Message.findOne === 'function') {
        const foundAutomaticCandidate = await Message.findOne({
            where: {
                conversation_id: conversationId,
                sender: 'ai',
                send_idempotency_key: automaticSendIdempotencyKey,
            },
        });
        if (foundAutomaticCandidate) {
            const existingState = normalizeDeliveryState(foundAutomaticCandidate);
            const existingMetadata = foundAutomaticCandidate.metadata
                && typeof foundAutomaticCandidate.metadata === 'object'
                ? foundAutomaticCandidate.metadata
                : {};
            const claimedAtMs = Date.parse(existingMetadata.provider_send_claimed_at || '');
            const claimIsStale = existingMetadata.provider_send_claimed === true
                && (Number(workerJob.attemptsMade || 0) > 0
                    || !Number.isFinite(claimedAtMs)
                    || Date.now() - claimedAtMs > STALE_PROVIDER_CLAIM_MS);
            let reusable = existingState === MESSAGE_DELIVERY_STATES.SEND_PENDING
                && existingMetadata.provider_send_attempted !== true
                && isAutoSendMode(businessMode)
                && (existingMetadata.provider_send_claimed !== true || claimIsStale);
            if (reusable && claimIsStale) {
                reusable = await releaseStaleProviderClaim(foundAutomaticCandidate);
            }
            if (reusable) {
                // A previous attempt was delayed before provider delivery (for
                // example by Meta rate limiting). Reuse the persisted candidate
                // instead of creating a second row.
                existingAutomaticCandidate = foundAutomaticCandidate;
            } else {
                // An earlier attempt may have durably saved provider acceptance
                // but exhausted retries before writing the shadow event.
                return finishAlreadyClaimedAutomaticSend(
                    shopId,
                    conversationId,
                    foundAutomaticCandidate,
                    existingState,
                );
            }
        }
    }

    // ── Guard 4b: Connected channel safety gate ─────────────────────────────
    // A missing/revoked token is represented by the channel status, not by the
    // deprecated Page AI settings fields.
    if (jobChannel.status !== 'CONNECTED') {
        return { skipped: true, reason: 'channel_disconnected' };
    }

    // ── Guard 4c: Subscription billing status ───────────────────────────────
    // Pause automated AI replies when the shop's plan is suspended/cancelled. The
    // inbound message is already persisted and
    // the manual inbox still works — we withhold only the *automated* reply, and
    // do so before the (LLM-costing) sentiment/AI steps below. Fails open: a
    // missing subscription row never blocks AI.
    let billingSub = null;
    {
        const { Subscription } = require('../modules/entities');
        const { isAiActive } = require('../modules/subscription/subscription.access');
        billingSub = await Subscription.findOne({
            where: { shop_id: shopId },
            attributes: ['status', 'conversations_limit', 'conversations_used', 'topup_balance'],
        }).catch(() => null);
        if (!isAiActive(billingSub)) {
            console.log(`[worker] AI paused for shop ${shopId}: subscription status=${billingSub?.status}`);
            await signalBillingPause({
                shopId,
                conversationId,
                messageId,
                status: billingSub?.status,
                platform,
            });
            return { skipped: true, reason: 'subscription_inactive', status: billingSub?.status || null };
        }
    }

    // ── Guard 4d: Conversation quota — RETIRED (ADR-0011) ───────────────────
    // conversationEntitlement is null; no conversation is metered, billed or
    // blocked. Usage events stay as non-gating telemetry. This decision is kept
    // only as a fail-closed "a shop must have a subscription row" check, and it
    // can never withhold a reply for an exhausted historical counter.
    const allowanceDecision = resolveAllowanceDecision({ subscription: billingSub });
    if (allowanceDecision === false) {
        return { skipped: true, reason: 'subscription_missing' };
    }

    // ── Guard 5: Sentiment — auto-escalate angry/frustrated customers ──────
    // Fast keyword pre-check first (no LLM cost); LLM used only for ambiguous cases.
    // On any failure, default to treating the customer as negative/escalation-needed (safe fallback).
    {
        let sentimentResult;
        try {
            const { analyzeSentiment } = require('../modules/ai/sentiment.service');
            sentimentResult = await analyzeSentiment(effMessage, shopId);
        } catch (sentimentErr) {
            console.error(`[worker] Sentiment analysis failed, defaulting to escalation`, { error: sentimentErr.message });
            sentimentResult = { sentiment: 'negative', score: -1, method: 'fallback' };
        }
        try {
            const { shouldAutoEscalate } = require('../modules/ai/sentiment.service');
            if (shouldAutoEscalate(sentimentResult.sentiment)) {
                console.log(`[worker] Auto-escalating conv ${conversationId}: sentiment=${sentimentResult.sentiment} (${sentimentResult.method})`);
                // Pause AI + reassure the customer + deliver on the same channel the
                // inbound arrived on (shared with the low-confidence handoff path).
                await requireHumanRecovery({
                    turnId,
                    traceId: stableTraceId,
                    turnStartedAt,
                    recoveryAvailable: recoveryStarted,
                    conversation, shopId, conversationId,
                    platform, recipientId, channel: jobChannel,
                    reason: `sentiment_${sentimentResult.sentiment}`,
                });
                return { skipped: true, reason: 'auto_escalated', sentiment: sentimentResult.sentiment };
            }
        } catch (escalateErr) {
            // If escalation itself fails, log and proceed with normal AI processing
            if (escalateErr?.retryable) throw escalateErr;
            console.error(`[worker] Auto-escalation handler failed (continuing)`, { error: escalateErr.message });
        }
    }

    // ── Run AI pipeline ─────────────────────────────────────────────────────
    const history = await loadConversationHistory(conversationId, historyExcludeIds);
    const detectedLanguage = ConversationStateService.detectLanguage(effMessage);
    const entities = ConversationStateService.extractEntities(effMessage);
    await recoveryControl?.transitionTo('AGENT_RUNNING');
    const staticConfigAvailable = await resolveStaticConfigAvailability(shopId, aiSettings);

    // Stage 2 is a read-only shadow. It records the deterministic proposal and
    // never decides routing, sends, or mutations; the existing order-flow and
    // conversational paths below remain authoritative.
    let shadowProposal = null;
    let shadowIntentRecord = null;
    let shadowTraceId = stableTraceId;
    try {
        const { classify } = require('../modules/ai/intent/stage2-rules');
        const { createIntentRecord } = require('../modules/ai/contracts/intent.contract');
        const OrderSessionService = require('../modules/order/order-session-standalone.service');
        const activeOrderSession = typeof OrderSessionService.getActiveSession === 'function'
            ? await OrderSessionService.getActiveSession(shopId, recipientId, metaChannelId, conversation.customer_id || null).catch(() => null)
            : null;
        shadowProposal = classify(effMessage, {
            language: detectedLanguage,
            hasAttachment: effImageUrls.length > 0,
            staticConfigAvailable,
            activeSession: activeOrderSession?.status === 'ACTIVE',
        });
        shadowTraceId = stableTraceId;
        shadowIntentRecord = {
            ...createIntentRecord({
                intentId: shadowProposal.intentId,
                domain: shadowProposal.domain,
                slots: shadowProposal.slots,
                confidence: shadowProposal.confidence,
                source: shadowProposal.source,
                evidenceIds: [],
                traceId: shadowTraceId,
            }),
            matchedRule: shadowProposal.matchedRule,
        };
        await ConversationStateService.updateConversationState(conversationId, {
            intent: shadowIntentRecord.intentId,
            language: detectedLanguage,
            confidence: Math.round(shadowIntentRecord.confidence * 100),
            intentConfidence: shadowIntentRecord.confidence,
            intentRecord: shadowIntentRecord,
        });
    } catch (shadowErr) {
        // Shadow telemetry must never make an inbound turn fail.
        console.warn(`[worker] Stage-2 shadow classification skipped for conv ${conversationId}: ${shadowErr.message}`);
    }

    const ingestionResult = {
        shop_id: shopId,
        customer_channel_id: recipientId,
        platform,
        conversation_id: conversationId,
        sender_info: senderInfo,
        reply_context: replyContext,
    };

    // ── Order capture (deterministic step-machine) ─────────────────────────
    // Runs BEFORE the conversational LLM. Continues an active order session, or
    // starts one when the customer shows clear purchase intent for an identified
    // product. While a session is in progress the LLM is skipped so order data is
    // captured reliably and an Order row is actually created on confirmation.
    // (Without this, the bot collects name/phone/address as chat but never makes
    // an order — see order-flow.service.js.)
    let rawResponse, confidence, sourceReferences, productPresentation = null;
    let groundingEvidence = grounding.emptyEvidence(shopId);
    let replySource = null;
    let replyProvider = null;
    let proposedAttachments = [];
    let humanRequired = false;
    let orderFlow = { handled: false };
    let knowledgeGapCaptured = false;
    let fallbackKnowledgeGapSource = null;

    // P+02: resolve a choice tap (opaque p1: reference, or a bare number that
    // matches a live registry proposal outside capture-steps) BEFORE the order
    // bridge. The kernel re-checks shop/customer/page/conversation scope,
    // expiry, single-use and the bound business context, and executes ONLY
    // through existing authoritative paths with the same mutationsAllowed
    // policy a typed answer gets. Replays are pure no-ops.
    let interactionTurn = false;
    {
        let payloadToResolve = tappedPayload && String(tappedPayload).startsWith('p1:')
            ? String(tappedPayload)
            : null;
        // Rollback contract (docs 03 §12): flag OFF must disable ALL interaction
        // execution — an in-flight SENT proposal must not act after a kill switch.
        if (payloadToResolve) {
            let choicesEnabled = false;
            try {
                const pilotFeatures = require('../modules/pilot-features/pilot-features.service');
                choicesEnabled = await pilotFeatures.isInteractionChoicesEnabled(shopId);
            } catch (_) { choicesEnabled = false; }
            if (!choicesEnabled) {
                return { skipped: true, reason: 'interactions_disabled', conversationId };
            }
        }
        if (!payloadToResolve && /^[1-9]$/.test(String(effMessage || '').trim())) {
            try {
                const pilotFeatures = require('../modules/pilot-features/pilot-features.service');
                if (await pilotFeatures.isInteractionChoicesEnabled(shopId)) {
                    const interactions = require('../modules/interactions/interactions.service');
                    payloadToResolve = await interactions.findNumberedLivePayload({
                        shopId, conversationId, number: String(effMessage).trim(),
                    });
                }
            } catch (_) { payloadToResolve = null; }
        }
        if (payloadToResolve) {
            interactionTurn = true;
            try {
                const interactions = require('../modules/interactions/interactions.service');
                const outcome = await interactions.resolveInteraction({
                    payload: payloadToResolve,
                    shopId,
                    customerChannelId: recipientId,
                    metaChannelId,
                    conversationId,
                    conversation,
                    mutationsAllowed: isAutoSendMode(businessMode)
                        && channelAISettings.allow_order_creation !== false,
                    platform,
                    recipientId,
                    turnId,
                    turnStartedAt,
                    traceId: stableTraceId,
                });
                if (!outcome.resolved && outcome.code === 'INTERACTION_ALREADY_HANDLED') {
                    return { skipped: true, reason: 'interaction_replay', conversationId };
                }
                if (!outcome.resolved && outcome.code === 'INTERACTION_CHOICES_DISABLED') {
                    return { skipped: true, reason: 'interactions_disabled', conversationId };
                }
                orderFlow = outcome.resolved ? {
                    handled: true,
                    response: outcome.response,
                    confidence: 1.0,
                    sourceReferences: null,
                    meta: { order_session: 'interaction_resolved', ...(outcome.meta || {}) },
                } : {
                    handled: true,
                    confidence: 1.0,
                    sourceReferences: null,
                    response: detectedLanguage === 'en'
                        ? 'That option is no longer active — just send me a message instead. 🙂'
                        : 'এই অপশনটি আর সক্রিয় নেই — সরাসরি বার্তা লিখুন। 🙂',
                    meta: { order_session: 'interaction_rejected', code: outcome.code },
                };
            } catch (interactionErr) {
                console.error(`[worker] interaction resolve failed for conv ${conversationId}:`, interactionErr.message);
                orderFlow = {
                    handled: true,
                    confidence: 1.0,
                    sourceReferences: null,
                    response: detectedLanguage === 'en'
                        ? 'Something went wrong — send me a message instead and I will help. 🙂'
                        : 'কিছু একটা সমস্যা হয়েছে — সরাসরি বার্তা লিখুন, সাহায্য করব। 🙂',
                    meta: { order_session: 'interaction_error' },
                };
            }
        }
    }

    if (!interactionTurn) {
        try {
            const { handleOrderFlow } = require('../modules/conversation/order-flow.service');
        {
            // Preserve the original turn trace for the existing live call site;
            // retries may arrive as a new BullMQ job ID without mutating BullMQ's
            // own identity or delayed-job bookkeeping.
            const job = { ...workerJob, id: stableTraceId };
            orderFlow = await handleOrderFlow({
                shopId,
                customerChannelId: recipientId,
                platform,
                message: effMessage,
                entities,
                language: detectedLanguage,
                imageUrls: effImageUrls,
                mutationsAllowed: isAutoSendMode(businessMode)
                    && channelAISettings.allow_order_creation !== false,
                conversationId,
                traceId: job.id || effExternalId || conversationId,
                metaChannelId,
                customerId: conversation.customer_id || null,
            });
        }
    } catch (ofErr) {
        console.error(`[worker] handleOrderFlow failed for conv ${conversationId}:`, ofErr.message);
        const failureOrderFlow = buildOrderFlowFailureResponse(effMessage, detectedLanguage);
        if (failureOrderFlow) {
            orderFlow = failureOrderFlow;
            opsAlert('Order flow failed on purchase intent — sent safe fallback instead of LLM', {
                detail: `shop=${shopId} conv=${conversationId}\nerror: ${ofErr.message}`,
                level: 'warning',
                context: { shopId, conversationId, error: ofErr.message },
            }).catch(() => {});
        }
        // Non-purchase messages remain non-fatal and fall through to conversational AI.
    }
    } // if (!interactionTurn)

    if (shadowProposal?.intentId === 'PURCHASE_INTENT_START') {
        try {
            const { hasPurchaseIntent } = require('../modules/conversation/order-flow.service');
            const liveStartedSession = orderFlow.meta?.order_session === 'started';
            if (!hasPurchaseIntent(effMessage) && !liveStartedSession) {
                await ConversationStateService.updateConversationState(conversationId, {
                    unsafeShadowActions: 1,
                    shadowDivergence: {
                        proposedIntent: shadowProposal.intentId,
                        livePurchaseIntent: false,
                        liveOrderSessionStarted: liveStartedSession,
                        traceId: shadowTraceId,
                    },
                });
            }
        } catch (shadowDivergenceErr) {
            console.warn(`[worker] Stage-2 divergence record skipped for conv ${conversationId}: ${shadowDivergenceErr.message}`);
        }
    }

    // P+02: at verified friction points, attach a registry proposal to this
    // turn's reply so the customer can tap instead of type. Flag-gated
    // (interaction_choices, default off) and non-fatal: any failure means the
    // plain-text conversation continues exactly as before.
    let turnInteractionId = null;
    {
        const ofMeta = orderFlow.meta || {};
        let proposalKind = null;
        if (ofMeta.order_session === 'continue' && ofMeta.step === 'ORDER_SUMMARY' && ofMeta.session_id) {
            proposalKind = 'CHECKOUT_DECISION';
        } else if (ofMeta.order_session === 'question_deferred' && ofMeta.session_id) {
            proposalKind = 'CHECKOUT_RESUME';
        } else if (ofMeta.order_session === 'suspended_for_handoff' && ofMeta.session_id) {
            proposalKind = 'HUMAN_SUPPORT';
        }
        if (proposalKind) {
            try {
                const pilotFeatures = require('../modules/pilot-features/pilot-features.service');
                if (await pilotFeatures.isInteractionChoicesEnabled(shopId)) {
                    const interactions = require('../modules/interactions/interactions.service');
                    const OrderSessionService = require('../modules/order/order-session-standalone.service');
                    const boundSession = await OrderSessionService
                        .getSessionForInteraction(ofMeta.session_id, shopId)
                        .catch(() => null);
                    // Without a reloadable bound session there is no honest
                    // context version — do NOT create a proposal whose confirm
                    // could fire against repriced state.
                    const proposal = boundSession
                        ? await interactions.createProposal({
                            shopId,
                            customerId: conversation.customer_id || null,
                            customerChannelId: recipientId,
                            metaChannelId,
                            conversationId,
                            kind: proposalKind,
                            language: detectedLanguage === 'en' ? 'en' : 'bn',
                            session: boundSession,
                            contextVersion: interactions.contextVersionFor(boundSession),
                        })
                        : null;
                    turnInteractionId = proposal?.interactionId || null;
                }
            } catch (proposalErr) {
                console.error(`[worker] interaction proposal failed (non-fatal) conv ${conversationId}:`, proposalErr.message);
            }
        }
    }

    // AIChatbotController is loaded lazily to avoid circular requires
    const AIChatbotController = require('../modules/conversation/ai-chatbot.controller');
    if (orderFlow.handled) {
        rawResponse = orderFlow.response;
        confidence = orderFlow.confidence ?? 1.0;
        sourceReferences = orderFlow.sourceReferences || null;
    } else {
        try {
            const intentResult = await AIChatbotController.processNewIntent(
                effMessage,
                history,
                entities,
                detectedLanguage,
                aiSettings,
                ingestionResult,
                effImageUrls,
                replyContext,
            );
            ({ response: rawResponse, confidence, sourceReferences, humanRequired = false, productPresentation = null } = intentResult);
            groundingEvidence = intentResult.grounding || groundingEvidence;
            replySource = intentResult.source || null;
            replyProvider = intentResult.provider || null;
            proposedAttachments = intentResult.attachments || [];
            if (humanRequired) {
                await requireHumanRecovery({
                    turnId,
                    traceId: stableTraceId,
                    turnStartedAt,
                    recoveryAvailable: recoveryStarted,
                    conversation, shopId, conversationId,
                    platform, recipientId, channel: jobChannel,
                    reason: 'order_status_customer_context_missing',
                });
                return {
                    success: true,
                    conversationId,
                    confidence,
                    sent: false,
                    reason: 'human_required',
                    handoff: true,
                };
            }
        } catch (aiErr) {
            if (aiErr?.retryable) throw aiErr;
            console.error(`[worker] processNewIntent failed for conv ${conversationId}:`, aiErr.message);
            // Stage alert (warning): the customer still gets a reply, but it's the
            // generic fallback — the AI pipeline (LLM/RAG/Gemini) is degraded. Throttled.
            opsAlert('AI reply degraded — LLM pipeline failed, sent fallback message', {
                detail: `shop=${shopId} conv=${conversationId}\nerror: ${aiErr.message}`,
                level: 'warning',
                context: { shopId, conversationId, error: aiErr.message },
            }).catch(() => {});
            rawResponse = detectedLanguage === 'bn'
                ? 'আপনার বার্তার জন্য ধন্যবাদ! আমরা শীঘ্রই সাড়া দেব।'
                : 'Thank you for your message! We will respond shortly.';
            confidence = 0;
            sourceReferences = null;
            fallbackKnowledgeGapSource = 'ai_pipeline_error';
        }
    }

    const committedOrder = orderFlow.meta?.completed && orderFlow.meta?.order
        ? orderFlow.meta.order
        : null;
    if (committedOrder) {
        rawResponse = buildPostMutationResponse(orderFlow, detectedLanguage);
        confidence = 1.0;
        proposedAttachments = [];
        groundingEvidence = grounding.withSourceText(grounding.emptyEvidence(shopId), rawResponse);
    }

    // ── Grounding gate: EasyModerator owns the SEND decision ────────────────
    // The last point at which merchant facts can still be withdrawn. Runs on
    // every reply regardless of which provider (or cache tier) produced it, so
    // a provider swap or a fallback cannot route around it.
    let groundingVerdict;
    try {
        groundingVerdict = grounding.evaluateCandidate({
            candidate: rawResponse,
            evidence: groundingEvidence,
            language: detectedLanguage,
            attachments: proposedAttachments,
            modelGenerated: !orderFlow.handled && grounding.isModelGenerated(replySource),
        });
    } catch (groundingErr) {
        if (!committedOrder) throw groundingErr;
        groundingVerdict = {
            decision: grounding.GroundingDecision.SUPPRESS,
            reasonCode: grounding.ReasonCode.RETRIEVAL_FAILED,
            text: null,
            attachments: [],
            violations: ['grounding_dependency_error'],
        };
    }
    grounding.logGroundingDecision({
        shopId,
        conversationId,
        messageId: effExternalId,
        provider: replyProvider,
        decision: groundingVerdict.decision,
        reasonCode: groundingVerdict.reasonCode,
        evidence: groundingEvidence,
        violations: groundingVerdict.violations,
    });

    let outboundAttachments = groundingVerdict.attachments || [];

    // Store the candidate before any branch that may need the deterministic
    // post-mutation response. The closure reads the final grounding verdict.
    const storeAiResponse = (content, aiDisclosureApplied, lifecycle = {}) => {
        const autoMode = isAutoSendMode(aiSettings.automation_mode);
        const suggestionVisibility = lifecycle.suggestionVisibility
            || (autoMode
                ? SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING
                : SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW);
        lifecycleLogger.info('ai_candidate_generated', {
            shopId,
            conversationId,
            turnId,
            deliveryState: lifecycle.deliveryState
                || (autoMode ? MESSAGE_DELIVERY_STATES.SEND_PENDING : MESSAGE_DELIVERY_STATES.DRAFT_READY),
            suggestionVisibility,
        });
        if (suggestionVisibility === SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING) {
            lifecycleLogger.info('ai_suggestion_hidden_auto_processing', { shopId, conversationId, turnId });
        }
        // P+04: when an informational question interrupted a checkout step, the
        // grounded answer is followed by the DETERMINISTIC resume re-ask (fixed
        // service text, no model content) so the customer's cart visibly
        // continues right where it paused.
        const resumeHint = orderFlow.meta?.order_session === 'question_deferred'
            && typeof orderFlow.meta.resume_hint === 'string'
            ? orderFlow.meta.resume_hint
            : null;
        const contentWithResume = resumeHint && String(content || '').trim()
            ? `${content}${resumeHint}`
            : content;
        return ConversationStateService.storeAIResponse(conversationId, contentWithResume, {
            platform,
            confidence,
            automation_mode: aiSettings.automation_mode,
            ai_disclosure_applied: aiDisclosureApplied,
            order_flow: orderFlow.meta || null,
            interaction_id: turnInteractionId || null,
            sourceReferences: sourceReferences || null,
            product_presentation: productPresentation || null,
            grounding_decision: groundingVerdict?.decision || null,
            grounding_reason: groundingVerdict?.reasonCode || null,
            grounding_product_status: groundingEvidence.productStatus,
            grounding_media_status: groundingEvidence.mediaStatus,
            grounding_media_product_id: groundingEvidence.mediaProductId,
            grounding_verified_product_ids: groundingEvidence.verifiedProducts.map(p => p.id),
            grounding_knowledge_ids: groundingEvidence.knowledgeIds,
            grounding_violations: groundingVerdict?.violations || [],
            grounding_provider: replyProvider,
            grounding_attachment_urls: outboundAttachments.map(a => a.url),
            human_required: humanRequired,
            logical_turn_id: logicalTurnId,
            turn_started_at: turnStartedAt,
            delivery_state: lifecycle.deliveryState
                || (autoMode ? MESSAGE_DELIVERY_STATES.SEND_PENDING : MESSAGE_DELIVERY_STATES.DRAFT_READY),
            delivery_source: lifecycle.deliverySource || (autoMode ? 'AUTO' : 'AI_DRAFT'),
            suggestion_visibility: suggestionVisibility,
            send_idempotency_key: lifecycle.sendIdempotencyKey || deriveAutomaticSendIdempotencyKey({
                shopId,
                conversationId,
                turnId: logicalTurnId,
            }),
        });
    };

    const sendPostMutationTemplate = async (reason) => {
        rawResponse = buildPostMutationResponse(orderFlow, detectedLanguage);
        confidence = 1.0;
        proposedAttachments = [];
        groundingEvidence = grounding.withSourceText(grounding.emptyEvidence(shopId), rawResponse);
        groundingVerdict = {
            decision: grounding.GroundingDecision.SEND,
            reasonCode: grounding.ReasonCode.GROUNDED,
            text: rawResponse,
            attachments: [],
            violations: [],
        };
        outboundAttachments = [];

        let persistenceError = null;
        try {
            const aiMessage = (await storeAiResponse(rawResponse, false, {
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            })).message;
            await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'executed_mutation_without_outbound_send',
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
        } catch (error) {
            persistenceError = error;
        }
        await opsAlert('executed_mutation_without_outbound_send', {
            detail: `shop=${shopId} conv=${conversationId} order=${orderFlow.meta.order.order_number || 'unknown'}\nreason: ${reason}`
                + (persistenceError ? `\nerror: ${persistenceError.message}` : ''),
            level: 'error',
            context: {
                shopId,
                conversationId,
                orderId: orderFlow.meta.order.id || null,
                reason,
                error: persistenceError?.message || null,
            },
        }).catch(() => {});
        await notifyExecutedMutationWithoutOutbound({ shopId, conversationId, orderFlow, reason });
        if (persistenceError) throw persistenceError;
        return { sent: false, reason, held: true };
    };

    if (groundingVerdict.decision === grounding.GroundingDecision.SUPPRESS) {
        if (committedOrder) {
            await recoveryControl?.close();
            const templateResult = await sendPostMutationTemplate('grounding_suppressed');
            if (templateResult.sent) await recoveryControl?.transitionTo('SENT', { outboundStatus: 'SENT' });
            return {
                success: true,
                conversationId,
                sent: templateResult.sent,
                reason: 'post_mutation_template',
            };
        }
        // Nothing truthful can be said. Silence plus a human beats a guess.
        await requireHumanRecovery({
            turnId,
            traceId: stableTraceId,
            turnStartedAt,
            recoveryAvailable: recoveryStarted,
            conversation, shopId, conversationId,
            platform, recipientId, channel: jobChannel, reason: 'grounding_suppressed',
        });
        return {
            success: true, conversationId, sent: false,
            reason: 'grounding_suppressed', reasonCode: groundingVerdict.reasonCode, handoff: true,
        };
    }

    if (groundingVerdict.decision === grounding.GroundingDecision.SAFE_FALLBACK) {
        rawResponse = groundingVerdict.text;
        // A retrieval outage is not an answer: drop confidence so the existing
        // low-confidence gate below holds the turn and pulls in a human.
        if (groundingVerdict.reasonCode === grounding.ReasonCode.RETRIEVAL_FAILED) confidence = 0;
        // P+02 (safe clarification): when the grounded answer offers no path
        // forward, let the customer pick delivery info / a human instead of
        // typing. Non-session turns only; flag-gated; non-fatal.
        if (!orderFlow.handled && !turnInteractionId) {
            try {
                const pilotFeatures = require('../modules/pilot-features/pilot-features.service');
                if (await pilotFeatures.isInteractionChoicesEnabled(shopId)) {
                    const interactions = require('../modules/interactions/interactions.service');
                    const proposal = await interactions.createProposal({
                        shopId,
                        customerId: conversation.customer_id || null,
                        customerChannelId: recipientId,
                        metaChannelId,
                        conversationId,
                        kind: 'CLARIFY_NEEDS',
                        language: detectedLanguage === 'en' ? 'en' : 'bn',
                    });
                    turnInteractionId = proposal?.interactionId || null;
                }
            } catch (_) { turnInteractionId = turnInteractionId || null; }
        }
    }
    let repliedText = rawResponse;
    let disclosureApplied = false;

    // ── Confidence gate: hold + hand off when the AI is unsure ──────────────
    // In auto-send mode, an answer below the shop's confidence_threshold is NOT
    // delivered. We mark it as a held suggestion, pause AI, pull in a human (who
    // sees the held draft in the inbox), and send the customer one reassurance
    // message so they are not left in silence. Order-flow turns are deterministic
    // (confidence 1.0) and never held.
    const { shouldHoldForLowConfidence } = require('../modules/ai/confidence-gate.service');
    const holdForLowConfidence = !committedOrder && shouldHoldForLowConfidence({
        confidence,
        automationMode: aiSettings.automation_mode,
        confidenceThreshold: aiSettings.confidence_threshold,
        orderFlowHandled: orderFlow.handled,
    });
    {
        if (holdForLowConfidence) {
            if (!knowledgeGapCaptured) {
                knowledgeGapCaptured = true;
                void captureKnowledgeGap({
                    shopId,
                    question: gapUtterance,
                    platform,
                    language: detectedLanguage,
                    source: fallbackKnowledgeGapSource || 'low_confidence_handoff',
                });
            }
            const aiMessage = (await storeAiResponse(rawResponse, false, {
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            })).message;
            await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'low_confidence',
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
            await requireHumanRecovery({
                turnId,
                traceId: stableTraceId,
                turnStartedAt,
                recoveryAvailable: recoveryStarted,
                conversation, shopId, conversationId,
                platform, recipientId, channel: jobChannel, reason: 'low_confidence',
            });
            console.log(`[worker] Low-confidence handoff conv ${conversationId} (confidence=${confidence})`);
            return { success: true, conversationId, confidence, sent: false, reason: 'low_confidence_handoff', handoff: true };
        }
    }

    if (
        !knowledgeGapCaptured
        && !orderFlow.handled
        && (fallbackKnowledgeGapSource || Number(confidence) <= 0.3)
    ) {
        knowledgeGapCaptured = true;
        void captureKnowledgeGap({
            shopId,
            question: effMessage,
            platform,
            language: detectedLanguage,
            source: fallbackKnowledgeGapSource || 'ai_unknown_response',
        });
    }

    // ── First-turn AI-disclosure greeting ───────────────────────────────────
    // Apply only when this reply will be attempted as an auto-send on the
    // customer's first turn. Held draft/manual suggestions must stay as plain
    // suggested copy for the shop owner to review.
    try {
        if (rawResponse && await shouldApplyAiDisclosureGreeting({
            conversationId,
            currentTurnMessageIds: historyExcludeIds,
            aiSettings,
            channel: jobChannel,
        })) {
            const { buildGreeting } = require('../modules/shop/ai-messaging');
            const Shop = require('../modules/shop/shop.entity');
            const shopRow = await Shop.findByPk(shopId, { attributes: ['name', 'settings'] });
            const shopName = shopRow?.settings?.businessInfo?.shopName || shopRow?.name || '';
            const greetingText = buildGreeting({ shopName, language: detectedLanguage, greeting: aiSettings.greeting });
            if (greetingText) {
                repliedText = `${greetingText}\n\n${rawResponse}`;
                disclosureApplied = true;
            }
        }
    } catch (greetErr) {
        console.error(`[worker] AI-disclosure greeting failed for conv ${conversationId}:`, greetErr.message);
    }

    // ── AI disclosure ───────────────────────────────────────────────────────
    // Disclosure happens through a clear-text first-turn disclaimer only when
    // the automated reply is actually allowed to go out. No per-message icon.
    const response = repliedText;

    // ── Policy Engine: mandatory outbound gate ─────────────────────────────
    // Replaces the ad-hoc DRAFT/MANUAL/opt-out checks scattered through the
    // old guard list. Every send (including non-AI) flows through this gate.
    const policyChannelType = platform === 'messenger' ? 'facebook' : platform;
    // channel_type must be included because the same channel_user_id can exist
    // on legacy rows for different platforms. The tenant/platform predicate
    // keeps consent and window checks on the Messenger customer row.
    // Customers are stored with channel_type='messenger' for Facebook (mirrors
    // the webhook handler mapping: facebook→messenger). The job platform is
    // already normalised to 'facebook', so we reverse the mapping here.
    const customerChannelType = platform === 'facebook' ? 'messenger' : platform;
    let customer;
    try {
        const customerWhere = {
            shop_id: shopId,
            ...(conversation.customer_id
                ? { id: conversation.customer_id }
                : {
                    channel_type: customerChannelType,
                    channel_user_id: String(recipientId),
                }),
        };
        customer = await Customer.findOne({ where: customerWhere });
    } catch (customerErr) {
        if (committedOrder) {
            await recoveryControl?.close();
            await sendPostMutationTemplate('customer_context_error');
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'post_mutation_template',
            };
        }
        throw customerErr;
    }
    const customerContextAvailable = Boolean(customer)
        && String(customer.shop_id) === String(shopId)
        && customer.channel_type === customerChannelType
        && String(customer.channel_user_id) === String(recipientId)
        && (!metaChannelId || customer.meta_channel_id == null
            || String(customer.meta_channel_id) === String(metaChannelId));
    const channel = jobChannel;
    let channelSettings = aiSettings;
    let latestChannelAISettings = channelAISettings;
    if (channel) {
        let latestSettings;
        try {
            latestSettings = await getChannelAISettings(channel);
        } catch (settingsErr) {
            if (committedOrder) {
                await recoveryControl?.close();
                await sendPostMutationTemplate('channel_settings_error');
                return {
                    success: true,
                    conversationId,
                    confidence,
                    sent: false,
                    reason: 'post_mutation_template',
                };
            }
            throw settingsErr;
        }
        latestChannelAISettings = { ...channelAISettings, ...latestSettings };
        channelSettings = buildWorkerAiSettings(shopAISettings, latestChannelAISettings, businessMode);
    }

    // The channel can lose its token while the LLM is running. Keep the
    // candidate visible to the merchant instead of attempting a send.
    if (channel.status !== 'CONNECTED') {
        if (committedOrder) {
            await recoveryControl?.close();
            await sendPostMutationTemplate('channel_disconnected');
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'post_mutation_template',
            };
        }
        const heldMessage = (await storeAiResponse(rawResponse, false, {
            deliveryState: MESSAGE_DELIVERY_STATES.HELD,
            deliverySource: 'AUTO',
            suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
        })).message;
        await finalizeAiMessage(heldMessage, shopId, conversationId, {
            delivered: false,
            heldReason: 'channel_disconnected',
            deliveryState: MESSAGE_DELIVERY_STATES.HELD,
            suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
        });
        return {
            success: true,
            conversationId,
            confidence,
            sent: false,
            reason: 'channel_disconnected',
        };
    }

    const normalizedOutbound = {
        text: response,
        platform: policyChannelType,
        senderRole: 'ai',
        direction: 'outbound',
    };

    // Re-read the business mode after generation. An AUTO job must not send
    // after the merchant changes the business mode to a non-delivering mode.
    const latestBusinessMode = await getEffectiveAiReplyMode(shopId);
    if (!isAutoSendMode(businessMode) || !isAutoSendMode(latestBusinessMode)) {
        const heldReason = isAutoSendMode(businessMode) ? 'mode_changed' : 'draft_mode';
        const deliveryState = heldReason === 'draft_mode'
            ? MESSAGE_DELIVERY_STATES.DRAFT_READY
            : MESSAGE_DELIVERY_STATES.HELD;
        const deliverySource = heldReason === 'draft_mode' ? 'AI_DRAFT' : 'AUTO';
        const suggestionVisibility = heldReason === 'draft_mode'
            ? SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW
            : SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW;
        const heldMessage = (await storeAiResponse(rawResponse, false, {
            deliveryState,
            deliverySource,
            suggestionVisibility,
        })).message;
        await finalizeAiMessage(heldMessage, shopId, conversationId, {
            delivered: false,
            heldReason,
            deliveryState,
            deliverySource,
            suggestionVisibility,
        });
        return {
            success: true,
            conversationId,
            confidence,
            sent: false,
            reason: heldReason,
        };
    }
    channelSettings = {
        ...channelSettings,
        automation_mode: latestBusinessMode,
    };

    let decision;
    try {
        decision = await policyEngine.evaluateOutbound(normalizedOutbound, {
            shopId,
            platform: policyChannelType,
            customer,
            channel,
            settings: channelSettings,
            conversationId,
        });
    } catch (policyErr) {
        if (committedOrder) {
            await recoveryControl?.close();
            const templateResult = await sendPostMutationTemplate('policy_error');
            if (templateResult.sent) await recoveryControl?.transitionTo('SENT', { outboundStatus: 'SENT' });
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'post_mutation_template',
            };
        }
        throw policyErr;
    }

    const policyAllows = decision?.allow === true && customerContextAvailable;
    if (!policyAllows) {
        const denialReason = customerContextAvailable
            ? (decision?.reason || 'POLICY_DENIED')
            : 'CUSTOMER_CONTEXT_UNAVAILABLE';
        if (committedOrder) {
            await recoveryControl?.close();
            const templateResult = await sendPostMutationTemplate(`policy_${denialReason}`);
            if (templateResult.sent) await recoveryControl?.transitionTo('SENT', { outboundStatus: 'SENT' });
            return {
                success: true,
                conversationId,
                confidence,
                sent: templateResult.sent,
                reason: 'post_mutation_template',
                decisionId: decision?.decisionId,
            };
        }
        // RATE_LIMIT: defer the job until the bucket clears.
        if (decision?.reason === 'RATE_LIMIT' && decision.retryAfterMs) {
            await job.moveToDelayed(Date.now() + decision.retryAfterMs, job.token);
            // BullMQ must not emit `completed` after the job was moved back to
            // delayed. The completion listener settles durable webhook receipts;
            // DelayedError tells BullMQ this is a state transition, not success.
            throw new DelayedError();
        }
        // DRAFT / SUGGEST_ONLY / MANUAL / OPTED_OUT / NO_CONSENT / OUTSIDE_24H:
        // Store the raw AI response as a held suggestion. Do not include the
        // automated-assistant disclosure in draft/manual suggestions.
        const aiMessage = (await storeAiResponse(rawResponse, false, {
            deliveryState: latestBusinessMode === AI_REPLY_MODES.DRAFT
                ? MESSAGE_DELIVERY_STATES.DRAFT_READY
                : MESSAGE_DELIVERY_STATES.HELD,
            deliverySource: latestBusinessMode === AI_REPLY_MODES.DRAFT ? 'AI_DRAFT' : 'AUTO',
            suggestionVisibility: latestBusinessMode === AI_REPLY_MODES.DRAFT
                ? SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW
                : SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
        })).message;
        await finalizeAiMessage(aiMessage, shopId, conversationId, {
            delivered: false,
            heldReason: latestBusinessMode === AI_REPLY_MODES.DRAFT ? 'draft_mode' : 'policy_blocked',
            deliveryState: latestBusinessMode === AI_REPLY_MODES.DRAFT
                ? MESSAGE_DELIVERY_STATES.DRAFT_READY
                : MESSAGE_DELIVERY_STATES.HELD,
            deliverySource: latestBusinessMode === AI_REPLY_MODES.DRAFT ? 'AI_DRAFT' : 'AUTO',
            suggestionVisibility: latestBusinessMode === AI_REPLY_MODES.DRAFT
                ? SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW
                : SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
        });
        return {
            success: true, conversationId, confidence,
            sent: false, reason: denialReason, decisionId: decision?.decisionId,
        };
    }

    // Policy evaluation can take long enough for a merchant reply or HITL
    // takeover to arrive. Re-read the business and conversation state at the
    // last reversible point so an in-flight AUTO turn cannot send after a
    // manual action or mode change. Provider calls remain the irreversible
    // boundary and are protected by the provider idempotency contract.
    const sendGuard = await getAutomaticSendGuard(shopId, conversationId);
    if (!sendGuard.allowed) {
        const heldReason = sendGuard.reason;
        lifecycleLogger.info('ai_auto_send_blocked', {
            shopId,
            conversationId,
            turnId,
            heldReason,
        });
        const heldMessage = (await storeAiResponse(rawResponse, false)).message;
        await finalizeAiMessage(heldMessage, shopId, conversationId, {
            delivered: false,
            heldReason,
        });
        return {
            success: true,
            conversationId,
            confidence,
            sent: false,
            reason: heldReason,
        };
    }

    // ── Store AI response ───────────────────────────────────────────────────
    const aiStoreResult = existingAutomaticCandidate
        ? { message: existingAutomaticCandidate }
        : await storeAiResponse(response, disclosureApplied, {
            deliveryState: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            deliverySource: 'AUTO',
            suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
            sendIdempotencyKey: automaticSendIdempotencyKey,
        });
    let aiMessage = aiStoreResult.message;
    // NOTE: the new_message SSE is emitted later (finalizeAiMessage) once the
    // delivery outcome is known, so the inbox never shows a "suggestion" panel
    // for a reply that was actually auto-sent.

    if (!(await claimAutomaticCandidate(aiMessage, automaticSendIdempotencyKey, shopId))) {
        if (typeof Message.findOne === 'function') {
            const currentCandidate = await Message.findOne({
                where: { id: aiMessage?.id, conversation_id: conversationId, sender: 'ai' },
            }).catch(() => null);
            const candidateMetadata = messageMetadata(currentCandidate || aiMessage);
            if (currentCandidate
                && !isProviderConfirmed(currentCandidate)
                && candidateMetadata.provider_send_attempted !== true
                && candidateMetadata.provider_send_claimed !== true) {
                const guard = await getAutomaticSendGuard(shopId, conversationId).catch(() => ({
                    allowed: false,
                    reason: 'conversation_unavailable',
                }));
                const terminal = {
                    human_active: {
                        heldReason: 'human_active',
                        suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                    },
                    conversation_closed: {
                        heldReason: 'conversation_closed',
                        suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                    },
                    conversation_unavailable: {
                        heldReason: 'conversation_unavailable',
                        suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                    },
                    ai_paused: {
                        heldReason: 'ai_paused',
                        suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                    },
                    mode_changed: {
                        heldReason: 'mode_changed',
                        suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                    },
                }[guard.reason];
                if (terminal) {
                    await finalizeAiMessage(aiMessage, shopId, conversationId, {
                        delivered: false,
                        heldReason: terminal.heldReason,
                        deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                        deliverySource: 'AUTO',
                        suggestionVisibility: terminal.suggestionVisibility,
                    });
                }
            }
        }
        return {
            success: true,
            conversationId,
            sent: false,
            reason: 'provider_send_already_claimed',
        };
    }

    // ── Send to Meta via provider registry ─────────────────────────────────
    const finalText = decision.transform?.text || aiMessage?.content || response;
    const policyChannelTypeForSend = platform === 'messenger' ? 'facebook' : platform;
    if (typeof Message.findOne === 'function') {
        const currentCandidate = await Message.findOne({
            where: { id: aiMessage?.id, conversation_id: conversationId, sender: 'ai' },
        });
        if (!currentCandidate || normalizeDeliveryState(currentCandidate) !== MESSAGE_DELIVERY_STATES.SEND_PENDING) {
            return {
                success: true,
                conversationId,
                sent: false,
                reason: 'candidate_invalidated',
            };
        }
    }
    let sendResult = null;
    let providerSendAttempted = false;
    try {
        if (typeof cacheRedis?.set === 'function'
            && typeof conversationLockService?.acquireForDelivery === 'function') {
            deliveryLock = await conversationLockService.acquireForDelivery(conversationId, {
                lockTimeoutMs: DELIVERY_LOCK_TIMEOUT_MS,
                maxWaitMs: DELIVERY_LOCK_WAIT_MS,
            });
            if ((deliveryLock?.available === false && process.env.NODE_ENV !== 'test')
                || (deliveryLock?.available !== false && !deliveryLock?.success)) {
                const error = new Error(deliveryLock?.error || 'delivery_lock_busy');
                error.code = deliveryLock?.error || 'DELIVERY_LOCK_BUSY';
                error.retryable = true;
                throw error;
            }
        }
        if (!channel) {
            throw new Error(`No MetaChannel found for shop ${shopId} platform ${policyChannelTypeForSend}`);
        }
        const providerBoundary = await claimProviderSendBoundary(
            aiMessage,
            automaticSendIdempotencyKey,
            shopId,
        );
        if (!providerBoundary.allowed) {
            const terminal = {
                human_active: {
                    heldReason: 'human_active',
                    suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                },
                ai_paused: {
                    heldReason: 'ai_paused',
                    suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                },
                conversation_closed: {
                    heldReason: 'conversation_closed',
                    suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                },
                conversation_unavailable: {
                    heldReason: 'conversation_unavailable',
                    suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                },
                opted_out: {
                    heldReason: 'opted_out',
                    suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                },
                mode_changed: {
                    heldReason: 'mode_changed',
                    suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                },
            }[providerBoundary.reason];
            if (terminal) {
                await finalizeAiMessage(aiMessage, shopId, conversationId, {
                    delivered: false,
                    heldReason: terminal.heldReason,
                    deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                    deliverySource: 'AUTO',
                    suggestionVisibility: terminal.suggestionVisibility,
                });
            }
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: providerBoundary.reason,
            };
        }
        const currentProductEvidence = await revalidateProductEvidenceBeforeSend(groundingEvidence);
        if (!currentProductEvidence.valid) {
            await releaseAutomaticCandidate(aiMessage, automaticSendIdempotencyKey);
            lifecycleLogger.warn('ai_auto_send_blocked', {
                shopId,
                conversationId,
                turnId,
                heldReason: 'product_evidence_stale',
                changedProductCount: currentProductEvidence.changedProductIds.length,
            });
            await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'product_evidence_stale',
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'product_evidence_stale',
            };
        }
        const currentKnowledgeEvidence = await revalidateKnowledgeEvidenceBeforeSend(groundingEvidence);
        if (!currentKnowledgeEvidence.valid) {
            await releaseAutomaticCandidate(aiMessage, automaticSendIdempotencyKey);
            lifecycleLogger.warn('ai_auto_send_blocked', {
                shopId,
                conversationId,
                turnId,
                heldReason: 'knowledge_evidence_stale',
                changedKnowledgeCount: currentKnowledgeEvidence.changedKnowledgeIds.length,
            });
            await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'knowledge_evidence_stale',
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'knowledge_evidence_stale',
            };
        }
        const currentOperatingContext = await revalidateOperatingContextBeforeSend(groundingEvidence);
        if (!currentOperatingContext.valid) {
            await releaseAutomaticCandidate(aiMessage, automaticSendIdempotencyKey);
            lifecycleLogger.warn('ai_auto_send_blocked', {
                shopId,
                conversationId,
                turnId,
                heldReason: 'operating_context_stale',
            });
            await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'operating_context_stale',
                deliveryState: MESSAGE_DELIVERY_STATES.HELD,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
            return {
                success: true,
                conversationId,
                confidence,
                sent: false,
                reason: 'operating_context_stale',
            };
        }
        const provider = getProvider(policyChannelTypeForSend);
        let turnQuickReplies = null;
        const turnInteractionIdForSend = aiMessage?.metadata?.interaction_id || null;
        if (turnInteractionIdForSend) {
            try {
                const interactions = require('../modules/interactions/interactions.service');
                const rendered = await interactions.renderQuickReplies(turnInteractionIdForSend);
                if (rendered?.quick_replies?.length) turnQuickReplies = rendered.quick_replies;
            } catch (_) { turnQuickReplies = null; }
        }
        providerSendAttempted = true;
        lifecycleLogger.info('ai_auto_send_attempt', {
            shopId,
            conversationId,
            turnId,
            messageId: aiMessage?.id || null,
        });
        sendResult = await provider.sendMessage({
            channel,
            recipientId: String(recipientId),
            normalizedMessage: {
                text: finalText,
                // P+02: server-rendered registry quick replies bound to THIS
                // message's interaction row (opaque payloads only). Sending
                // still went through the full policy chain above; render
                // failure degrades to plain text — the conversation never
                // depends on interactive capability.
                quick_replies: turnQuickReplies || undefined,
                // Only media the grounding gate accepted: a verified product of
                // THIS shop, owning this exact URL.
                attachments: outboundAttachments,
                platform: policyChannelTypeForSend,
                direction: 'outbound',
                senderRole: 'ai',
            },
            decision,
        });
        if (!providerSendSucceeded(sendResult)) {
            const error = new Error('Provider did not confirm the outbound send');
            error.code = 'PROVIDER_NO_SEND';
            throw error;
        }
        if (turnInteractionIdForSend) {
            // Delivery ack makes the proposal genuinely tappable (GENERATED->SENT).
            try {
                const { markSent } = require('../modules/interactions/interactions.service');
                await markSent(turnInteractionIdForSend);
            } catch (_) { /* text conversation unaffected */ }
        }
    } catch (err) {
        if (err?.retryable || err?.code === 'DELIVERY_LOCK_BUSY' || err?.code === 'DELIVERY_LOCK_UNAVAILABLE') {
            await releaseAutomaticCandidate(aiMessage, automaticSendIdempotencyKey).catch(() => {});
            if (dedupKey && typeof cacheRedis.del === 'function') {
                await cacheRedis.del(dedupKey).catch(() => {});
            }
            throw err;
        }
        // Check for rate limit signal from the provider
        if (err.retryAfterMs) {
            // A provider-side rate-limit response is a negative acknowledgement
            // before delivery. Release the turn claim so the delayed job can
            // make the one eventual attempt without creating a second message.
            await releaseAutomaticCandidate(aiMessage, automaticSendIdempotencyKey);
            if (typeof cacheRedis.del === 'function' && dedupKey) {
                await cacheRedis.del(dedupKey).catch(() => {});
            }
            await job.moveToDelayed(Date.now() + err.retryAfterMs, job.token);
            // The completed listener settles durable inbound receipts. Signal a
            // BullMQ state transition instead of successful processing.
            throw new DelayedError();
        }
        if (err.code === 'META_AUTHORIZATION_REQUIRED') {
            lifecycleLogger.info('ai_provider_send_failure', {
                shopId,
                conversationId,
                messageId: aiMessage?.id || null,
                errorCode: err.code,
            });
            const finalized = await finalizeAiMessage(aiMessage, shopId, conversationId, {
                delivered: false,
                heldReason: 'provider_send_failed',
                providerMessageIds: Array.isArray(err.providerMessageIds) ? err.providerMessageIds : [],
                providerComponents: Array.isArray(err.providerComponents) ? err.providerComponents : [],
                providerFailure: err.providerFailure || null,
                deliveryState: MESSAGE_DELIVERY_STATES.FAILED,
                deliverySource: 'AUTO',
                suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
            });
            if (finalized?.providerConfirmed) {
                await recoveryControl?.complete('SENT', { outboundStatus: 'SENT' });
                return { success: true, conversationId, confidence, sent: true, reason: 'echo_reconciled' };
            }
            sseManager.emit(shopId, 'delivery_failed', {
                conversation_id: conversationId,
                message_id: aiMessage?.id,
                reason: err.message,
            });
            throw new UnrecoverableError(
                'Meta authorization is invalid; reconnect is required before delivery can resume',
            );
        }
        lifecycleLogger.info('ai_provider_send_failure', {
            shopId,
            conversationId,
            messageId: aiMessage?.id || null,
            errorCode: err.code || 'PROVIDER_SEND_FAILED',
        });
        const finalized = await finalizeAiMessage(aiMessage, shopId, conversationId, {
            delivered: false,
            heldReason: 'provider_send_failed',
            providerMessageIds: Array.isArray(err.providerMessageIds) ? err.providerMessageIds : [],
            providerComponents: Array.isArray(err.providerComponents) ? err.providerComponents : [],
            providerFailure: err.providerFailure || null,
            deliveryState: MESSAGE_DELIVERY_STATES.FAILED,
            deliverySource: 'AUTO',
            suggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
        });
        if (finalized?.providerConfirmed) {
            await recoveryControl?.complete('SENT', { outboundStatus: 'SENT' });
            return { success: true, conversationId, confidence, sent: true, reason: 'echo_reconciled' };
        }
        sseManager.emit(shopId, 'delivery_failed', {
            conversation_id: conversationId,
            message_id: aiMessage?.id,
            reason: err.message,
            provider_send_attempted: providerSendAttempted,
        });
        throw err; // Other send errors bubble up for normal retry/DLQ handling
    }

    // Mark the reply delivered (no suggestion panel) and emit to agent tabs.
    const finalized = await finalizeAiMessage(aiMessage, shopId, conversationId, {
        delivered: true,
        heldReason: null,
        providerMessageId: providerAcknowledgementId(sendResult),
        providerMessageIds: Array.isArray(sendResult.providerMessageIds)
            ? sendResult.providerMessageIds
            : [],
        providerComponents: Array.isArray(sendResult.providerComponents)
            ? sendResult.providerComponents
            : [],
        deliveryState: MESSAGE_DELIVERY_STATES.SENT,
        deliverySource: 'AUTO',
        suggestionVisibility: SUGGESTION_VISIBILITY.HIDDEN_SENT,
    });

    // Activation tracking: the first successful AI reply activates the shop.
    // Await the bookkeeping before acknowledging the job, but never throw after
    // the provider has accepted the reply; a failed claim is retried later.
    try {
        await require('../modules/analytics/growth-metrics.service')
            .recordActivation(shopId, conversationId);
        require('../modules/analytics/funnel-events.service')
            .recordInternalFunnelEvent({
                event: 'first_ai_reply_sent',
                    shopId,
                    onceKey: shopId,
                    oncePerEntity: true,
                metadata: {
                    conversation_id: conversationId,
                    channel_id: channel?.id || null,
                    platform: policyChannelTypeForSend,
                },
            })
            .catch((err) => {
                console.error('Funnel event write failed:', {
                    name: err?.name,
                    code: err?.code,
                    statusCode: err?.statusCode,
                });
            });
    } catch (_) { /* analytics must never fail a sent reply */ }

    if (recoveryControl) await recoveryControl.complete('SENT', { outboundStatus: 'SENT' });
    return {
        success: true,
        conversationId,
        confidence,
        sent: finalized?.providerConfirmed !== false,
        decisionId: decision.decisionId,
    };
    } catch (err) {
        if (dedupKey && !isUnrecoverableJobError(err) && typeof cacheRedis.del === 'function') {
            await cacheRedis.del(dedupKey).catch(() => {});
        }
        throw err;
    } finally {
        if (deliveryLock?.success) {
            await conversationLockService.releaseLock(conversationId, deliveryLock.lockId).catch((error) => {
                lifecycleLogger.warn('Unable to release automatic delivery lock', {
                    shopId,
                    conversationId,
                    error: error.message,
                });
            });
            deliveryLock = null;
        }
        await recoveryControl?.close();
    }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

let worker = null;

async function settleInboundReceipts(job, { failed = false, errorCode = null } = {}) {
    const receiptIds = Array.isArray(job?.data?.receiptIds) ? job.data.receiptIds.filter(Boolean) : [];
    if (receiptIds.length === 0) return;

    const receiptService = require('../modules/integration/meta-webhook-receipt.service');
    const MetaWebhookReceipt = require('../modules/integration/meta-webhook-receipt.entity');
    const { recordInboundEventMetric } = require('../modules/integration/meta-webhook-metrics');
    const shopId = job.data?.shopId || null;
    const metaChannelId = job.data?.metaChannelId || null;
    if (!shopId || !metaChannelId) {
        console.error('[worker] Refusing to settle inbound receipts without tenant scope', { jobId: job.id });
        return;
    }
    for (const receiptId of receiptIds) {
        try {
            const receipt = await MetaWebhookReceipt.findOne({
                where: {
                    id: receiptId,
                    shop_id: shopId,
                    meta_channel_id: metaChannelId,
                    queue_job_id: String(job.id),
                },
            });
            if (!receipt || receipt.status !== 'QUEUED') continue;
            if (failed) {
                await receiptService.deadLetter(receipt, errorCode || 'MESSAGE_PROCESSING_FAILED', {
                    expectedQueueJobId: job.id,
                });
                recordInboundEventMetric('inbound_processing_failure');
            } else {
                await receiptService.markProcessed(receipt, {
                    shopId,
                    metaChannelId,
                }, {
                    expectedQueueJobId: job.id,
                });
                recordInboundEventMetric('inbound_processing_success');
            }
        } catch (err) {
            console.error('[worker] Failed to settle inbound webhook receipt', {
                receiptId,
                jobId: job.id,
                error: err.message,
            });
        }
    }
}

function startWorker() {
    worker = new Worker('message-processing', processMessageJob, {
        connection,
        concurrency: 10,
        group: { concurrency: 1 }, // Max 1 concurrent job per shop (BullMQ v5 fair groups)
    });

    worker.on('completed', (job) => {
        settleInboundReceipts(job).catch((err) => {
            console.error('[worker] Inbound receipt settlement failed', { jobId: job.id, error: err.message });
        });
        const r = job.returnvalue;
        if (r?.skipped) console.log(`[worker] Job ${job.id} skipped: ${r.reason}`);
        else if (r?.delayed) console.log(`[worker] Job ${job.id} delayed: ${r.reason} (${r.retryAfterMs}ms)`);
        else console.log(`[worker] Job ${job.id} done — conv=${r?.conversationId} confidence=${r?.confidence}`);
    });

    worker.on('failed', async (job, err) => {
        console.error('[worker] Job failed', { jobId: job?.id, shopId: job?.data?.shopId, attempt: job?.attemptsMade, error: err.message });
        if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
            await settleInboundReceipts(job, { failed: true, errorCode: 'MESSAGE_PROCESSING_FAILED' });
            try {
                const dlqQueue = new Queue('message-dlq', { connection });
                await dlqQueue.add('failed-job', {
                    originalJobData: job.data,
                    error: err.message,
                    failedAt: new Date().toISOString()
                });
                console.error(`[worker/DLQ] Job ${job.id} moved to message-dlq after exhausting retries`);
                // A dead-lettered message means this customer got NO reply — page a human.
                opsAlert('Auto-reply job dead-lettered — customer received no reply', {
                    detail: `shop=${job.data?.shopId} platform=${job.data?.platform} jobId=${job.id} `
                        + `conv=${job.data?.conversationId}\nerror: ${err.message}`,
                    level: 'error',
                    context: { shopId: job.data?.shopId, jobId: job.id, error: err.message },
                }).catch(() => {});
            } catch (dlqErr) {
                console.error('[worker] Failed to add to DLQ', { error: dlqErr.message });
                opsAlert('Auto-reply job failed AND could not be dead-lettered', {
                    detail: `jobId=${job.id} dlqError: ${dlqErr.message} originalError: ${err.message}`,
                    level: 'error',
                    context: { jobId: job.id, dlqError: dlqErr.message },
                }).catch(() => {});
            }
        } else {
            console.warn(`[worker] Job ${job?.id} attempt ${job?.attemptsMade} failed (will retry): ${err.message}`);
        }
    });

    worker.on('error', (err) => console.error('[worker] Worker connection error:', err.message));

    console.log('✅ BullMQ message-processing worker started (concurrency=10, groups=fair)');
    return worker;
}

// Auto-start when this file is run directly or via RUN_WORKER env var
if (require.main === module || process.env.RUN_WORKER === 'true') {
    startWorker();
}

module.exports = {
    processMessageJob,
    startWorker,
    getWorker: () => worker,
    _private: {
        loadConversationHistory,
        isFirstCustomerTurn,
        settleInboundReceipts,
        shouldApplyAiDisclosureGreeting,
        hasPriorCustomerVisibleAiDisclosure,
        hasAiDisclosure,
        wasAiMessageCustomerVisible,
        buildOrderFlowFailureResponse,
        signalBillingPause,
        resolveAllowanceDecision,
        resolveChannelForJob,
        createRecoveryControl,
        resolveStaticConfigAvailability,
        finalizeAiMessage,
        recoverAcceptedAutoReplyShadow,
        finishAlreadyClaimedAutomaticSend,
        getAutomaticSendGuard,
        revalidateProductEvidenceBeforeSend,
        revalidateKnowledgeEvidenceBeforeSend,
        revalidateOperatingContextBeforeSend,
    },
};
