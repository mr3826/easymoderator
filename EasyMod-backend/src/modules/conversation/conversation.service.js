const {
    Conversation,
    Message,
    Customer,
    MetaChannel,
    MetaChannelSettings,
    InboxDeliveryOutbox,
    User,
    UserShop,
    AuditLog,
} = require('../entities');
const crypto = require('crypto');
const { Op, literal } = require('sequelize');
const subscriptionService = require('../subscription/subscription.service');
const { createLogger } = require('../../utils/structured-logger');
const { AppError } = require('../../utils/AppError');
const sseManager = require('../../utils/sse-manager');
const { cacheRedis } = require('../../config/redis');
const conversationLockService = require('./conversation-lock.service');
const { getEffectiveAiReplyMode, normalizeAiReplyMode } = require('../shop/ai-reply-mode');
const {
    resolveChannelAutomation,
    readEmergencyStopState,
} = require('../channel-providers/channel-automation.resolver');
const { DEFAULT_AI_SETTINGS } = require('../shop/shop-defaults');
const { sequelize } = require('../../utils/database/database-setup');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    normalizeDeliveryState,
    providerMessageIdFor,
    isProviderConfirmed,
    isReviewableSuggestion,
    deriveMessageSendIdempotencyKey,
    RESUME_BOUNDARY_METADATA_KEY,
    resumeBoundaryStateFor,
    candidateStartedAtStateFor,
    isBeforeResumeBoundary,
} = require('./message-lifecycle');
const {
    ATTACHMENT_URL_TTL_SECONDS,
    PREPARED_ATTACHMENT_METADATA,
    attachmentExists,
    mintAttachmentUrl,
    parseStorageKey,
    resolveAttachmentStorageKey,
} = require('./attachment-storage');
const { resolvePublicAssetOrigin } = require('../../config/origins');

const PLACEHOLDER_CUSTOMER_NAMES = new Set([
    'customer',
    'facebook user',
    'messenger user',
    'instagram user',
    'no title',
    'unknown',
]);

const DELIVERY_LOCK_TIMEOUT_MS = 300_000;
const DELIVERY_LOCK_WAIT_MS = 10_000;
const CURRENT_TURN_PROJECTION_LIMIT = 200;

async function acquireBulkDeliveryLock(conversationId) {
    if (!cacheRedis || typeof cacheRedis.set !== 'function'
        || typeof conversationLockService?.acquireForDelivery !== 'function') {
        if (process.env.NODE_ENV === 'test') return null;
        throw Object.assign(new Error('Conversation delivery lock is unavailable'), {
            statusCode: 503,
            code: 'DELIVERY_LOCK_UNAVAILABLE',
        });
    }
    const lock = await conversationLockService.acquireForDelivery(conversationId, {
        lockTimeoutMs: DELIVERY_LOCK_TIMEOUT_MS,
        maxWaitMs: DELIVERY_LOCK_WAIT_MS,
    });
    if (lock?.available === false && process.env.NODE_ENV !== 'test') {
        throw Object.assign(new Error('Conversation delivery lock is unavailable'), {
            statusCode: 503,
            code: 'DELIVERY_LOCK_UNAVAILABLE',
        });
    }
    if (!lock?.success) {
        const error = new Error('Another Inbox delivery is in progress; retry after it completes');
        error.statusCode = 409;
        error.code = 'CONVERSATION_DELIVERY_BUSY';
        throw error;
    }
    return lock;
}

async function releaseBulkDeliveryLock(lock, conversationId) {
    if (!lock?.success || typeof conversationLockService?.releaseLock !== 'function') return;
    await conversationLockService.releaseLock(conversationId, lock.lockId).catch(() => {});
}

const normalizeObject = (value) => {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
};

const EMPTY_EMERGENCY_STOP = Object.freeze({
    active: false, at: null, by: null, source: null, prior_mode: null,
});

/**
 * One batched read for conversation list/detail: shop AI settings + emergency
 * stop + is_active + billing standing. A single Shop/Subscription pair per
 * request — never per row (no N+1).
 */
async function loadShopAutomationContext(shopId) {
    let shopAiSettings = null;
    try {
        const shopService = require('../shop/shop.service');
        shopAiSettings = await shopService.getShopAiSettings(shopId);
    } catch (_) {
        shopAiSettings = null;
    }

    // Fail CLOSED (ADR-0013 §9 / ADR-0011 C5): when the safety state cannot be
    // read, the UI must not present AI as active. The worker independently
    // blocks these cases; the display must agree.
    let emergencyStop = { ...EMPTY_EMERGENCY_STOP, active: true };
    let shopIsActive = true;
    let billingAiActive = false;
    try {
        const { Shop, Subscription } = require('../entities');
        if (Shop && typeof Shop.findByPk === 'function') {
            const shop = await Shop.findByPk(shopId, {
                attributes: [
                    'id',
                    'is_active',
                    'ai_emergency_stop',
                    'ai_emergency_stop_at',
                    'ai_emergency_stop_by',
                    'ai_emergency_stop_source',
                    'ai_emergency_stop_prior_mode',
                ],
            });
            if (shop) {
                emergencyStop = readEmergencyStopState(shop);
                shopIsActive = shop.is_active !== false;
            }
        }
        if (Subscription && typeof Subscription.findOne === 'function') {
            const { isAiActive } = require('../subscription/subscription.access');
            const subscription = await Subscription.findOne({
                where: { shop_id: shopId },
                attributes: ['status'],
            }).catch(() => null);
            billingAiActive = subscription ? isAiActive(subscription) : false;
        }
    } catch (_) { /* fail-closed defaults above stay in effect */ }

    return {
        shopAiSettings: shopAiSettings || { ...DEFAULT_AI_SETTINGS },
        emergencyStop,
        shopIsActive,
        billingAiActive,
    };
}

/**
 * Resolve the effective display configuration per channel from one settings
 * batch. Rows without a channel id use the business default (no stop bypass:
 * emergency stop still wins).
 */
function buildAutomationByChannel(context, settingsRows) {
    const byChannel = new Map(
        (settingsRows || []).map((row) => [String(row.channel_id), row]),
    );
    const resolveFor = (channelId) => {
        const channelSettings = channelId ? byChannel.get(String(channelId)) : null;
        return resolveChannelAutomation({
            shopAiSettings: context.shopAiSettings,
            channelSettings: channelSettings || {},
            emergencyStop: context.emergencyStop,
            shopIsActive: context.shopIsActive,
        });
    };
    return resolveFor;
}

const workflowTimestamp = (message) => {
    const value = message?.created_at ?? message?.createdAt;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : NaN;
};

const workflowDeliverySource = (message) => {
    const metadata = normalizeObject(message?.metadata);
    return message?.delivery_source || metadata.delivery_source || null;
};

const isAnsweringOutbound = (message) => {
    if (message?.sender === 'business') {
        const state = normalizeDeliveryState(message);
        return ![
            MESSAGE_DELIVERY_STATES.GENERATING,
            MESSAGE_DELIVERY_STATES.SEND_PENDING,
            MESSAGE_DELIVERY_STATES.FAILED,
        ].includes(state);
    }
    return message?.sender === 'ai'
        && workflowDeliverySource(message) !== 'HITL_ESCALATION'
        && isProviderConfirmed(message);
};

const isCurrentWorkflowMessage = (message, latestCustomerAt, latestAnswerAt) => {
    const timestamp = workflowTimestamp(message);
    const afterCustomer = !Number.isFinite(latestCustomerAt)
        || !Number.isFinite(timestamp)
        || timestamp >= latestCustomerAt;
    const afterAnswer = !Number.isFinite(latestAnswerAt)
        || !Number.isFinite(timestamp)
        || timestamp > latestAnswerAt;
    return afterCustomer && afterAnswer;
};

const isActiveProviderAttempt = (message, latestCustomerAt, latestAnswerAt) => {
    if (!['ai', 'business'].includes(message?.sender)
        || isProviderConfirmed(message)
        || workflowDeliverySource(message) === 'HITL_ESCALATION'
        || !isCurrentWorkflowMessage(message, latestCustomerAt, latestAnswerAt)) return false;
    const metadata = normalizeObject(message.metadata);
    if (metadata.provider_send_attempted === true) return false;
    return [MESSAGE_DELIVERY_STATES.GENERATING, MESSAGE_DELIVERY_STATES.SEND_PENDING]
        .includes(normalizeDeliveryState(message));
};

const isResumableStaleCandidate = (message, resumeBoundaryAt) => {
    if (!message || isProviderConfirmed(message)) return false;
    const metadata = normalizeObject(message.metadata);
    if (metadata.provider_send_attempted === true) return false;
    if (!candidateStartedAtStateFor(message).valid) return true;
    return isBeforeResumeBoundary(message, resumeBoundaryAt);
};

const logicalTurnIdFor = (message) => {
    const logicalTurnId = normalizeObject(message?.metadata).logical_turn_id;
    return logicalTurnId ? String(logicalTurnId) : null;
};

const currentCustomerTurn = (rows) => {
    const ordered = (Array.isArray(rows) ? rows : [])
        .filter((row) => Number.isFinite(workflowTimestamp(row)))
        .sort((left, right) => workflowTimestamp(left) - workflowTimestamp(right));
    let latestAnswerAt = NaN;
    for (const row of ordered) {
        if (isAnsweringOutbound(row)) latestAnswerAt = workflowTimestamp(row);
    }
    const pendingCustomers = ordered.filter((row) => (
        row?.sender === 'customer'
            && (!Number.isFinite(latestAnswerAt) || workflowTimestamp(row) > latestAnswerAt)
    ));
    const persistedTurnIds = new Set(
        pendingCustomers.map(logicalTurnIdFor).filter(Boolean),
    );
    pendingCustomers.forEach((row) => {
        if (row?.id) persistedTurnIds.add(`burst:${row.id}`);
    });
    return {
        pendingCustomers,
        persistedTurnIds,
        firstCustomerAt: pendingCustomers.length ? workflowTimestamp(pendingCustomers[0]) : NaN,
    };
};

const isCurrentTurnSuggestion = (candidate, rows) => {
    const current = currentCustomerTurn(rows);
    if (!current.pendingCustomers.length) return false;
    const candidateTurnId = logicalTurnIdFor(candidate);
    if (candidateTurnId && current.persistedTurnIds.size) {
        return current.persistedTurnIds.has(candidateTurnId);
    }
    const candidateAt = workflowTimestamp(candidate);
    return !Number.isFinite(current.firstCustomerAt)
        || !Number.isFinite(candidateAt)
        || candidateAt >= current.firstCustomerAt;
};

const legacyLogicalTurnIdFor = (message, rows) => {
    const candidateAt = workflowTimestamp(message);
    if (!Number.isFinite(candidateAt)) return null;
    const ordered = (Array.isArray(rows) ? rows : [])
        .filter((row) => Number.isFinite(workflowTimestamp(row))
            && workflowTimestamp(row) <= candidateAt)
        .sort((left, right) => workflowTimestamp(left) - workflowTimestamp(right));
    const answerTimes = ordered
        .filter(isAnsweringOutbound)
        .map(workflowTimestamp)
        .filter(Number.isFinite);
    const latestAnswerAt = answerTimes.length ? Math.max(...answerTimes) : NaN;
    const firstPendingCustomer = ordered.find((row) => (
        row?.sender === 'customer'
        && (!Number.isFinite(latestAnswerAt) || workflowTimestamp(row) > latestAnswerAt)
    ));
    return firstPendingCustomer?.id ? `burst:${firstPendingCustomer.id}` : null;
};

const dismissalLogicalTurnIdFor = (message, rows) => {
    const persisted = logicalTurnIdFor(message);
    if (persisted) return persisted;
    return legacyLogicalTurnIdFor(message, rows);
};

const isDismissableDuplicateSibling = (candidate, sibling, rows) => {
    if (!candidate?.id || !sibling?.id || candidate.id === sibling.id) return false;
    if (!isReviewableSuggestion(sibling)) return false;

    const candidateTurnId = dismissalLogicalTurnIdFor(candidate, rows);
    const siblingTurnId = dismissalLogicalTurnIdFor(sibling, rows);
    return Boolean(candidateTurnId && siblingTurnId && candidateTurnId === siblingTurnId);
};

const dismissedMetadata = (message, actorId, dismissedAt, duplicateOf = null) => ({
    ...normalizeObject(message?.metadata),
    delivered: false,
    delivery_status: 'dismissed',
    delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
    suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
    held_reason: 'dismissed',
    dismissed_at: dismissedAt,
    dismissed_by_user_id: actorId || null,
    ...(duplicateOf ? {
        dismissed_as_duplicate: true,
        dismissed_duplicate_of: duplicateOf,
    } : {}),
});

const loadDismissalCandidates = async (conversationId, transaction, candidate) => {
    if (typeof Message.findAll !== 'function') return [candidate];
    const rows = await Message.findAll({
        where: { conversation_id: conversationId },
        transaction,
        lock: transaction.LOCK?.UPDATE,
    });
    const byId = new Map([[candidate.id, candidate]]);
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    }
    return [...byId.values()];
};

const terminalizeDuplicateSiblings = async (candidate, rows, transaction, actorId, dismissedAt) => {
    const dismissedSiblingMessageIds = [];
    for (const sibling of rows) {
        if (!isDismissableDuplicateSibling(candidate, sibling, rows)) continue;
        await sibling.update({
            metadata: dismissedMetadata(sibling, actorId, dismissedAt, candidate.id),
            delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
            delivery_source: sibling.delivery_source || 'AI_DRAFT',
        }, { transaction });
        dismissedSiblingMessageIds.push(sibling.id);
    }
    return dismissedSiblingMessageIds;
};

/**
 * P+01: read-only projection of the AUTHORITATIVE live Sales Opportunity for
 * the Inbox. Pilot-flag gated (fail-closed: any lookup error => no projection,
 * never a failed inbox), reuses opportunity.service's canonical serializer so
 * Inbox and Customer 360 can never disagree, and computes no second score.
 */
async function liveOpportunityMap(shopId, customerIds) {
    const ids = [...new Set((customerIds || []).filter(Boolean))];
    if (!ids.length) return new Map();
    try {
        const { isCustomerIntelligenceEnabled } = require('../pilot-features/pilot-features.service');
        const enabled = await isCustomerIntelligenceEnabled(shopId);
        if (!enabled) return new Map();
        const { liveOpportunitiesForCustomers } = require('../customer-intelligence/opportunity.service');
        return await liveOpportunitiesForCustomers(shopId, ids);
    } catch (_) {
        return new Map();
    }
}

const deriveWorkflowProjection = (conversation, messages, aiReplyMode) => {
    const metadata = normalizeObject(conversation?.metadata);
    const status = conversation?.status || metadata.status || 'active';
    const open = !['closed', 'archived'].includes(status);
    const rows = Array.isArray(messages) ? messages : [];
    const customerTimes = rows
        .filter((message) => message?.sender === 'customer')
        .map(workflowTimestamp)
        .filter(Number.isFinite);
    const answerTimes = rows
        .filter(isAnsweringOutbound)
        .map(workflowTimestamp)
        .filter(Number.isFinite);
    const latestCustomerAt = customerTimes.length ? Math.max(...customerTimes) : NaN;
    const latestAnswerAt = answerTimes.length ? Math.max(...answerTimes) : NaN;
    const unanswered = Number.isFinite(latestCustomerAt)
        && (!Number.isFinite(latestAnswerAt) || latestCustomerAt > latestAnswerAt);
    const currentRows = rows.filter((message) => isCurrentWorkflowMessage(
        message,
        latestCustomerAt,
        latestAnswerAt,
    ));
    const reviewable = currentRows.filter(isReviewableSuggestion);
    const failed = currentRows.filter((message) => {
        const metadataForMessage = normalizeObject(message.metadata);
        return ['ai', 'business'].includes(message?.sender)
            && (normalizeDeliveryState(message) === MESSAGE_DELIVERY_STATES.FAILED
                || (normalizeDeliveryState(message) === MESSAGE_DELIVERY_STATES.SEND_PENDING
                    && metadataForMessage.provider_send_attempted === true)
                || metadataForMessage.held_reason === 'provider_send_failed');
    });
    const activeAttempts = currentRows.filter((message) => isActiveProviderAttempt(
        message,
        latestCustomerAt,
        latestAnswerAt,
    ));
    const aiProcessing = activeAttempts.some((message) => (
        message.sender === 'ai'
        && workflowDeliverySource(message) !== 'DRAFT_APPROVAL'
        && workflowDeliverySource(message) !== 'HITL_ESCALATION'
    ));

    let needsMerchantReply = false;
    if (open) {
        if (reviewable.length > 0 || failed.length > 0) {
            needsMerchantReply = true;
        } else if (unanswered) {
            // Dismissal is not an answer. AUTO suppresses this flag only
            // while a provider attempt is genuinely active.
            needsMerchantReply = conversation?.hitl === true || activeAttempts.length === 0;
        }
    }

    let reason = null;
    if (needsMerchantReply) {
        if (failed.length > 0) {
            reason = failed.some((message) => message.sender === 'business')
                ? 'PROVIDER_SEND_FAILED'
                : 'AI_FAILED';
        } else if (reviewable.length > 0) {
            const hasDraft = reviewable.some((message) => {
                const messageMetadata = normalizeObject(message.metadata);
                return messageMetadata.suggestion_visibility === SUGGESTION_VISIBILITY.VISIBLE_DRAFT_REVIEW
                    || normalizeDeliveryState(message) === MESSAGE_DELIVERY_STATES.DRAFT_READY;
            });
            reason = hasDraft ? 'DRAFT_REVIEW_REQUIRED' : 'HITL_REQUIRED';
        } else if (conversation?.hitl === true) {
            reason = 'HITL_REQUIRED';
        } else {
            reason = 'CUSTOMER_UNANSWERED';
        }
    }

    return {
        needs_merchant_reply: needsMerchantReply,
        needs_merchant_reply_reason: reason,
        ai_is_replying: open
            && aiReplyMode === 'AUTO'
            && conversation?.hitl !== true
            && aiProcessing,
    };
};

const displayChannelName = (channel) => (
    channel === 'facebook' || channel === 'messenger' ? 'Facebook customer' : 'Customer'
);

const customerFallbackName = (channel, providerId) => {
    const prefix = displayChannelName(channel);
    const normalizedId = typeof providerId === 'string' ? providerId.trim() : '';
    const suffix = normalizedId.replace(/[^A-Za-z0-9]/g, '').slice(-4);
    return suffix ? `${prefix} · …${suffix}` : prefix;
};

const isPlaceholderCustomerName = (name) => {
    if (!name) return true;
    const normalized = String(name).trim().toLowerCase();
    return PLACEHOLDER_CUSTOMER_NAMES.has(normalized)
        || normalized.startsWith('facebook user ')
        || normalized.startsWith('messenger user ')
        || normalized.startsWith('instagram user ')
        || normalized.startsWith('facebook customer ·');
};

const CLIENT_MESSAGE_METADATA_FIELDS = new Set([
    'external_id',
    'provider_message_id',
    'provider_message_ids',
    'provider_send_confirmed',
    'provider_send_attempted',
    'provider_send_claimed',
    'provider_send_claimed_at',
    'provider_send_claim_token',
    'outbox_reconciled',
    'delivery_state',
    'delivery_status',
    'delivered',
    'suggestion_visibility',
    'reply_to',
    'reply_to_provider_message_id',
    'reply_to_internal_message_id',
    'reply_to_is_self_reply',
    'attachment_storage_key',
    'attachment_source',
    'attachment_available',
]);

const sanitizeClientMessageMetadata = (metadata) => Object.fromEntries(
    Object.entries(normalizeObject(metadata))
        .filter(([key]) => !CLIENT_MESSAGE_METADATA_FIELDS.has(key)),
);

const internalIntentTitle = (value, intent) => {
    if (!value) return true;
    const title = String(value).trim();
    return title.toLowerCase() === 'no title'
        || title.toLowerCase() === 'facebook user'
        || title.toLowerCase() === 'messenger user'
        || title === intent
        || title === 'GENERAL_CHAT_OR_UNKNOWN'
        || title === 'PURCHASE_INTENT_START'
        || title === 'ORDER_STATUS_LOOKUP'
        || title === 'SUPPORT_HANDOFF'
        || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(title);
};

const plainCustomer = (customer, channel) => {
    if (!customer) return null;
    const raw = typeof customer.toJSON === 'function' ? customer.toJSON() : { ...customer };
    if (isPlaceholderCustomerName(raw.name)) {
        raw.name = customerFallbackName(channel, raw.channel_user_id);
    }
    return raw;
};

const projectedAttachmentMetadata = (message, metadata, shopId) => {
    const isStoredAttachment = metadata.attachment_source === 'inbox_upload'
        || Object.prototype.hasOwnProperty.call(metadata, 'attachment_storage_key');
    if (!isStoredAttachment) return message?.metadata || null;

    const storageKey = resolveAttachmentStorageKey(metadata, shopId);
    const parsedStorageKey = parseStorageKey(storageKey);
    if (!parsedStorageKey) {
        const unavailable = { ...metadata, attachment_available: false };
        delete unavailable.image_url;
        delete unavailable.file_url;
        return unavailable;
    }

    try {
        const publicUrl = mintAttachmentUrl({
            shopId: parsedStorageKey.shopId,
            fileName: parsedStorageKey.fileName,
            baseUrl: resolvePublicAssetOrigin(),
            ttlSeconds: ATTACHMENT_URL_TTL_SECONDS,
        });
        const projected = {
            ...metadata,
            attachment_storage_key: storageKey,
            attachment_available: true,
            file_url: publicUrl,
        };
        if ((metadata.message_type || message?.message_type) === 'image') {
            projected.image_url = publicUrl;
        } else {
            delete projected.image_url;
        }
        return projected;
    } catch (_) {
        const unavailable = { ...metadata, attachment_available: false };
        delete unavailable.image_url;
        delete unavailable.file_url;
        return unavailable;
    }
};

const mapMessage = (message, shopId) => {
    const metadata = normalizeObject(message?.metadata);
    const responseMetadata = projectedAttachmentMetadata(message, metadata, shopId);
    const deliveryState = normalizeDeliveryState(message);
    const sender = message?.sender === 'business' ? 'agent' : message?.sender;
    return {
        id: message.id,
        conversation_id: message.conversation_id,
        content: message.content,
        sender,
        message_type: metadata.message_type || 'text',
        metadata: responseMetadata,
        ai_suggestion: message.ai_suggestion || null,
        ai_confidence: message.ai_confidence ? Number(message.ai_confidence) : null,
        source_references: message.source_references || null,
        message_tag: message.message_tag || null,
        delivery_state: deliveryState,
        provider_message_id: providerMessageIdFor(message),
        delivery_source: message.delivery_source || metadata.delivery_source || null,
        reply_to: metadata.reply_to || (metadata.reply_to_provider_message_id
            ? {
                provider_message_id: metadata.reply_to_provider_message_id,
                internal_message_id: metadata.reply_to_internal_message_id || null,
                is_self_reply: metadata.reply_to_is_self_reply === true,
                status: metadata.reply_to_internal_message_id ? 'resolved' : 'unavailable',
            }
            : null),
        is_transcript_message: sender !== 'ai' || isProviderConfirmed(message),
        created_at: message.created_at,
        updated_at: message.updated_at || message.created_at,
    };
};

async function markMissingAttachments(messages) {
    const keys = [...new Set(messages
        .filter((message) => message.metadata?.attachment_available !== false)
        .map((message) => message.metadata?.attachment_storage_key)
        .filter((key) => typeof key === 'string'))];
    if (!keys.length) return messages;

    const availability = new Map(await Promise.all(keys.map(async (key) => (
        [key, await attachmentExists(key)]
    ))));
    return messages.map((message) => {
        const key = message.metadata?.attachment_storage_key;
        if (!key || availability.get(key) !== false) return message;
        const metadata = { ...(message.metadata || {}), attachment_available: false };
        delete metadata.image_url;
        delete metadata.file_url;
        return { ...message, metadata };
    });
}

class ConversationService {
    mapMessage(message, shopId) {
        return mapMessage(message, shopId);
    }

    mapConversation(conversation) {
        const meta = normalizeObject(conversation.metadata);
        const channel = conversation.channel === 'messenger'
            ? 'facebook'
            : conversation.channel === 'web'
                ? 'webchat'
                : conversation.channel;

        const customer = plainCustomer(conversation.customer, channel);
        const customerName = customer?.name || customerFallbackName(channel, customer?.channel_user_id);
        const titleCandidate = conversation.title || meta.title;
        const title = internalIntentTitle(titleCandidate, conversation.intent)
            ? customerName
            : titleCandidate;

        // Phase 2 FK + Phase 4 purpose label. Lets the inbox label which page
        // / IG account a thread arrived on without a separate API call.
        const metaChannel = conversation.metaChannel || null;
        const metaChannelInfo = metaChannel
            ? {
                id: metaChannel.id,
                displayName: metaChannel.display_name || null,
                platform: metaChannel.platform || null,
                purposeLabel: metaChannel.settings?.purpose_label || null,
            }
            : null;

        return {
            id: conversation.id,
            customer_id: conversation.customer_id,
            customer,
            channel,
            meta_channel_id: conversation.meta_channel_id || null,
            metaChannel: metaChannelInfo,
            title,
            status: conversation.status || meta.status || 'active',
            hitl: conversation.hitl ?? false,
            // MW-V1 D3: ownership must be visible or "who owns the next action"
            // cannot be answered. Names are attached by the list/detail loaders
            // (loadAssigneeNames); assignee_id alone is already authoritative.
            assignee_id: conversation.assignee_id ?? null,
            assignee: null,
            resolution_note: conversation.resolution_note ?? null,
            resolved_at: conversation.resolvedAt ?? conversation.resolved_at ?? null,
            lastMessage: meta.last_actual_message ?? conversation.message ?? null,
            unreadCount: Math.max(0, Number(meta.unreadCount) || 0),
            lastReadMessageId: meta.last_read_message_id || null,
            lastReadMessageAt: meta.last_read_message_at || null,
            // Sequelize timestamps with `underscored: true` are exposed on the
            // instance as camelCase accessors (createdAt/updatedAt) even though
            // the DB columns are snake_case. Reading conversation.created_at
            // directly returns undefined → the inbox rendered "Invalid Date" and
            // the 24h-window guard computed against NaN. Prefer the real accessor,
            // falling back to the snake_case key for plain-object inputs.
            created_at: conversation.createdAt ?? conversation.created_at,
            updated_at: conversation.updatedAt ?? conversation.updated_at
        };
    }

    // MW-V1: one batched name query per page, never per row. assignee_id values
    // were membership-checked at write time, so display lookup is safe.
    async loadAssigneeNames(assigneeIds) {
        const ids = [...new Set((assigneeIds || []).filter(Boolean).map(String))];
        const out = new Map();
        if (ids.length === 0 || typeof User?.findAll !== 'function') return out;
        try {
            const rows = await User.findAll({
                where: ids.length === 1 ? { id: ids[0] } : { id: { [Op.in]: ids } },
                attributes: ['id', 'full_name'],
            });
            for (const row of rows || []) out.set(String(row.id), { id: row.id, name: row.full_name || null });
        } catch { /* names are display-only; the id remains authoritative */ }
        for (const id of ids) if (!out.has(id)) out.set(id, { id, name: null });
        return out;
    }

    async getConversations(shopId, options = {}) {
        try {
            const { page = 1, limit = 20, channel, customer_id, status } = options;
            const offset = (page - 1) * limit;

            const whereClause = { shop_id: shopId };
            if (channel) whereClause.channel = channel;
            if (customer_id) whereClause.customer_id = customer_id;
            
            // Add status filter for conversation management
            // Valid statuses: 'active', 'unanswered', 'pending_order', 'completed', 'followed_up'
            if (status) {
                const validStatuses = [
                    'active',
                    'unanswered',
                    'pending_order',
                    'completed',
                    'followed_up',
                    'closed',
                    'archived',
                ];
                if (validStatuses.includes(status)) {
                    whereClause.status = status;
                }
            }

            const [conversations, automationContext] = await Promise.all([
                Conversation.findAndCountAll({
                    where: whereClause,
                    order: [['updated_at', 'DESC']],
                    limit,
                    offset,
                    include: [
                        {
                            model: Customer,
                            as: 'customer',
                            attributes: ['id', 'name', 'phone', 'channel_user_id']
                        },
                        {
                            model: MetaChannel,
                            as: 'metaChannel',
                            required: false,
                            attributes: ['id', 'display_name', 'platform'],
                            include: [{
                                model: MetaChannelSettings,
                                as: 'settings',
                                required: false,
                                attributes: ['purpose_label']
                            }]
                        }
                    ]
                }),
                // One shop-level read for the envelope; never resolve this per row.
                loadShopAutomationContext(shopId),
            ]);
            const aiReplyMode = normalizeAiReplyMode(automationContext.shopAiSettings.automation_mode);

            // Effective per-channel configuration: ONE settings query for the
            // whole page, then the pure resolver per row (no N+1).
            const channelIds = [...new Set(conversations.rows
                .map((row) => row.meta_channel_id)
                .filter(Boolean)
                .map(String))];
            let channelSettingsRows = [];
            if (channelIds.length > 0 && typeof MetaChannelSettings?.findAll === 'function') {
                channelSettingsRows = await MetaChannelSettings.findAll({
                    where: { channel_id: { [Op.in]: channelIds } },
                }).catch(() => []);
            }
            const resolveAutomation = buildAutomationByChannel(automationContext, channelSettingsRows);

            const suggestionCounts = new Map();
            const messagesByConversation = new Map();
            const conversationIds = conversations.rows.map((row) => row.id);
            if (conversationIds.length > 0 && typeof Message.findAll === 'function') {
                const candidates = await Message.findAll({
                    where: {
                        conversation_id: { [Op.in]: conversationIds },
                    },
                    attributes: [
                        'id',
                        'conversation_id',
                        'sender',
                        'created_at',
                        'delivery_state',
                        'delivery_source',
                        'provider_message_id',
                        'metadata',
                    ],
                }) || [];
                for (const candidate of candidates) {
                    const conversationMessages = messagesByConversation.get(candidate.conversation_id) || [];
                    conversationMessages.push(candidate);
                    messagesByConversation.set(candidate.conversation_id, conversationMessages);
                }
                for (const candidate of candidates.filter((message) => (
                    isReviewableSuggestion(message)
                        && isCurrentTurnSuggestion(
                            message,
                            messagesByConversation.get(message.conversation_id) || [],
                        )
                ))) {
                    suggestionCounts.set(
                        candidate.conversation_id,
                        (suggestionCounts.get(candidate.conversation_id) || 0) + 1,
                    );
                }
            }

            const opportunitiesByCustomer = await liveOpportunityMap(
                shopId,
                conversations.rows.map((row) => row.customer_id),
            );

            const mappedConversations = conversations.rows.map((row) => {
                const automation = resolveAutomation(row.meta_channel_id);
                return {
                    ...this.mapConversation(row),
                    suggestionCount: suggestionCounts.get(row.id) || 0,
                    hasAiSuggestion: suggestionCounts.has(row.id),
                    open_opportunity: opportunitiesByCustomer.get(row.customer_id) || null,
                    // Additive effective fields (API_CONTRACT §6). `ai_reply_mode`
                    // stays the business default for old clients.
                    effective_ai_reply_mode: automation.mode,
                    mode_source: automation.modeSource,
                    emergency_stop: { ...automationContext.emergencyStop },
                    billing_ai_active: automationContext.billingAiActive,
                    ...deriveWorkflowProjection(
                        row,
                        messagesByConversation.get(row.id) || [],
                        aiReplyMode,
                    ),
                };
            });
            const assigneeNames = await this.loadAssigneeNames(mappedConversations.map((m) => m.assignee_id));
            for (const m of mappedConversations) m.assignee = assigneeNames.get(String(m.assignee_id)) || null;

            return {
                conversations: mappedConversations,
                ai_reply_mode: aiReplyMode,                pagination: {
                    total: conversations.count,
                    page,
                    limit,
                    totalPages: Math.ceil(conversations.count / limit)
                }
            };
        } catch (error) {
            throw new Error(`Failed to fetch conversations: ${error.message}`);
        }
    }

    async getConversationById(conversationId, shopId) {
        try {
            const conversation = await Conversation.findOne({
                where: {
                    id: conversationId,
                    shop_id: shopId
                },
                include: [
                    { model: Customer, as: 'customer' },
                    {
                        model: MetaChannel,
                        as: 'metaChannel',
                        required: false,
                        attributes: ['id', 'display_name', 'platform'],
                        include: [{
                            model: MetaChannelSettings,
                            as: 'settings',
                            required: false,
                            attributes: ['purpose_label']
                        }]
                    }
                ]
            });

            if (!conversation) {
                throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
            }

            const [automationContext, messages] = await Promise.all([
                loadShopAutomationContext(shopId),
                typeof Message.findAll === 'function'
                    ? Message.findAll({
                        where: { conversation_id: conversationId },
                        attributes: [
                            'id',
                            'conversation_id',
                            'sender',
                            'created_at',
                            'delivery_state',
                            'delivery_source',
                            'provider_message_id',
                            'metadata',
                        ],
                    })
                    : [],
            ]);
            const aiReplyMode = normalizeAiReplyMode(automationContext.shopAiSettings.automation_mode);
            let detailSettingsRow = null;
            const detailChannelId = conversation.meta_channel_id || conversation.metaChannel?.id || null;
            if (detailChannelId && typeof MetaChannelSettings?.findOne === 'function') {
                detailSettingsRow = await MetaChannelSettings.findOne({
                    where: { channel_id: detailChannelId },
                }).catch(() => null);
            }
            const detailAutomation = buildAutomationByChannel(
                automationContext,
                detailSettingsRow ? [detailSettingsRow] : [],
            )(detailChannelId);
            const opportunitiesByCustomer = await liveOpportunityMap(shopId, [conversation.customer_id]);
            const detail = {
                ...this.mapConversation(conversation),
                ...deriveWorkflowProjection(conversation, messages || [], aiReplyMode),
                open_opportunity: opportunitiesByCustomer.get(conversation.customer_id) || null,
                effective_ai_reply_mode: detailAutomation.mode,
                mode_source: detailAutomation.modeSource,
                emergency_stop: { ...automationContext.emergencyStop },
                billing_ai_active: automationContext.billingAiActive,
            };
            if (detail.assignee_id) {
                const names = await this.loadAssigneeNames([detail.assignee_id]);
                detail.assignee = names.get(String(detail.assignee_id)) || null;
            }
            return detail;
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new Error(`Failed to fetch conversation: ${error.message}`);
        }
    }

    async getMessages(conversationId, shopId, options = {}) {
        try {
            const { page = 1, limit = 50 } = options;
            const offset = (page - 1) * limit;

            const conversation = await Conversation.findOne({
                where: {
                    id: conversationId,
                    shop_id: shopId
                }
            });

            if (!conversation) {
                throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
            }

            const results = await Message.findAndCountAll({
                where: {
                    conversation_id: conversationId
                },
                // Page one must contain the newest messages so the merchant
                // actually sees the latest inbound before the read watermark is
                // advanced. Reverse the bounded page for chronological render.
                order: [['created_at', 'DESC']],
                limit,
                offset
            });

            const projectedMessages = results.rows.map((message) => mapMessage(message, shopId)).reverse();
            const transcriptMessages = projectedMessages.filter((message) => message.is_transcript_message);
            const allProjectionRows = typeof Message.findAll === 'function'
                ? (await Message.findAll({
                    where: { conversation_id: conversationId },
                    attributes: [
                        'id',
                        'conversation_id',
                        'sender',
                        'content',
                        'ai_suggestion',
                        'ai_confidence',
                        'source_references',
                        'message_tag',
                        'created_at',
                        'delivery_state',
                        'delivery_source',
                        'provider_message_id',
                        'metadata',
                    ],
                    order: [['created_at', 'DESC'], ['id', 'DESC']],
                    limit: CURRENT_TURN_PROJECTION_LIMIT,
                }) || [])
                : [];
            const projectionRows = allProjectionRows.length ? allProjectionRows : results.rows;
            const projectedSuggestions = projectionRows
                .filter(isReviewableSuggestion)
                .filter((message) => isCurrentTurnSuggestion(message, projectionRows))
                .map((message) => mapMessage(message, shopId));
            const [messages, suggestions] = await Promise.all([
                markMissingAttachments(transcriptMessages),
                markMissingAttachments(projectedSuggestions),
            ]);

            return {
                messages,
                suggestions,
                pagination: {
                    total: results.count,
                    page,
                    limit,
                    totalPages: Math.ceil(results.count / limit)
                }
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new Error(`Failed to fetch messages: ${error.message}`);
        }
    }

    async createConversation(shopId, conversationData, requestId = null) {
        const logger = createLogger(requestId, shopId);
        const { sequelize } = require('../../utils/database/database-setup');
        const transaction = await sequelize.transaction();
        let committed = false;
        
        try {
            if (conversationData.customer_id && typeof Customer.findOne === 'function') {
                const ownedCustomer = await Customer.findOne({
                    where: { id: conversationData.customer_id, shop_id: shopId },
                    transaction,
                });
                if (!ownedCustomer) {
                    throw new AppError('Customer not found for this shop', 404);
                }
            }
            const resolvedTitle = conversationData.title
                || conversationData.metadata?.title
                || null;
            const resolvedStatus = conversationData.status
                || conversationData.metadata?.status
                || 'active';

            const metadata = {
                ...(conversationData.metadata || {}),
                title: resolvedTitle || conversationData.metadata?.title || null,
                status: resolvedStatus || conversationData.metadata?.status || 'active'
            };

            // Create conversation within transaction
            const conversation = await Conversation.create({
                ...conversationData,
                shop_id: shopId,
                title: resolvedTitle,
                status: resolvedStatus,
                metadata
            }, { transaction });

            // Commit transaction - NOW conversation is persisted
            await transaction.commit();
            committed = true;

            // ATOMIC: Track usage ONLY after successful DB commit
            // Uses transaction-safe idempotent tracking with request_id
            // Usage increments ONLY on successful database persistence
            try {
                const usageResult = await subscriptionService.trackUsage(
                    shopId,
                    'conversations',
                    1,
                    requestId || conversation.id, // Request-scoped idempotency key - prevents double counting
                    {
                        resourceId: conversation.id,
                        channel: conversation.channel,
                        customerId: conversation.customer_id
                    }
                );
                
                logger.logUsage('conversation_created', shopId, null, {
                    conversationId: conversation.id,
                    channel: conversation.channel,
                    transactionId: usageResult.transactionId,
                    isRetry: usageResult.isRetry
                });
            } catch (usageError) {
                logger.error('Failed to track conversation usage', usageError, {
                    conversationId: conversation.id,
                    severity: usageError.code === 'USAGE_LIMIT_EXCEEDED' ? 'critical' : 'error'
                });
                // The conversation transaction is already committed. Keep the
                // successful resource visible; the worker can use the persisted
                // allowance decision or retry metering without creating a
                // duplicate conversation on the client's retry.
            }

            return conversation;
        } catch (error) {
            if (!committed) await transaction.rollback();
            if (error instanceof AppError) throw error;
            logger.error('Failed to create conversation', error);
            throw new AppError(`Failed to create conversation: ${error.message}`, 500);
        }
    }

    async createMessage(conversationId, shopId, messageData) {
        const create = async (transaction) => {
            const conversation = await Conversation.findOne({
                where: {
                    id: conversationId,
                    shop_id: shopId
                },
                ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
            });

            if (!conversation) {
                throw new Error('Conversation not found');
            }

            const sender = messageData.sender === 'agent'
                ? 'business'
                : messageData.sender || 'customer';
            const isManualOutbound = sender === 'business';
            const isMetaOutbound = ['facebook', 'messenger'].includes(conversation.channel);
            const sendIdempotencyKey = messageData.send_idempotency_key || null;
            if (isManualOutbound && sendIdempotencyKey && typeof Message.findOne === 'function') {
                const existing = await Message.findOne({
                    where: {
                        conversation_id: conversationId,
                        send_idempotency_key: sendIdempotencyKey,
                    },
                    ...(transaction ? { transaction } : {}),
                });
                if (existing) {
                    return { ...mapMessage(existing, shopId), idempotency_replay: true };
                }
            }
            const preparedAttachmentMetadata = messageData[PREPARED_ATTACHMENT_METADATA] || null;
            const metadata = {
                ...sanitizeClientMessageMetadata(messageData.metadata),
                ...(preparedAttachmentMetadata || {}),
                message_type: messageData.message_type || messageData.metadata?.message_type || 'text',
                ...(isManualOutbound ? {
                    delivered: !isMetaOutbound,
                    delivery_status: isMetaOutbound ? 'pending' : 'sent',
                    delivery_state: isMetaOutbound
                        ? MESSAGE_DELIVERY_STATES.SEND_PENDING
                        : MESSAGE_DELIVERY_STATES.SENT,
                    delivery_source: isMetaOutbound ? 'MANUAL' : 'LOCAL',
                } : {}),
            };

            const message = await Message.create({
                conversation_id: conversationId,
                content: messageData.content || messageData.message || '',
                sender,
                metadata,
                ai_suggestion: messageData.ai_suggestion || null,
                ai_confidence: messageData.ai_confidence || null,
                message_tag: messageData.message_tag || null,
                external_id: null,
                delivery_state: isManualOutbound
                    ? isMetaOutbound ? MESSAGE_DELIVERY_STATES.SEND_PENDING : MESSAGE_DELIVERY_STATES.SENT
                    : null,
                delivery_source: isManualOutbound ? (isMetaOutbound ? 'MANUAL' : 'LOCAL') : null,
                provider_message_id: null,
                send_idempotency_key: sendIdempotencyKey,
            }, transaction ? { transaction } : undefined);

            return { ...mapMessage(message, shopId), idempotency_replay: false };
        };

        try {
            if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
                return await sequelize.transaction((transaction) => create(transaction));
            }
            return await create(null);
        } catch (error) {
            throw new Error(`Failed to create message: ${error.message}`);
        }
    }

    async approveAiDraft(conversationId, shopId, messageId, content, actorId = null) {
        const transaction = await sequelize.transaction();
        try {
            const conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!conversation) {
                const error = new Error('Conversation not found');
                error.statusCode = 404;
                throw error;
            }

            const candidate = await Message.findOne({
                where: { id: messageId, conversation_id: conversationId, sender: 'ai' },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!candidate) {
                const error = new Error('AI suggestion not found');
                error.statusCode = 404;
                throw error;
            }

            const state = normalizeDeliveryState(candidate);
            if (state === MESSAGE_DELIVERY_STATES.SENT || state === MESSAGE_DELIVERY_STATES.DELIVERED) {
                await transaction.commit();
                return { message: mapMessage(candidate, shopId), alreadySent: true };
            }
            if (state === MESSAGE_DELIVERY_STATES.SEND_PENDING) {
                const error = new Error('AI suggestion send is already in progress');
                error.statusCode = 409;
                error.code = 'DRAFT_SEND_IN_PROGRESS';
                throw error;
            }
            if (normalizeObject(candidate.metadata).provider_send_attempted === true) {
                const error = new Error('Provider delivery was already attempted; send a fresh merchant reply after checking the channel');
                error.statusCode = 409;
                error.code = 'PROVIDER_SEND_ALREADY_ATTEMPTED';
                throw error;
            }
            if (state === MESSAGE_DELIVERY_STATES.DISMISSED) {
                const error = new Error('AI suggestion was dismissed');
                error.statusCode = 409;
                error.code = 'DRAFT_DISMISSED';
                throw error;
            }
            if (!isReviewableSuggestion(candidate)) {
                const error = new Error('AI suggestion is not awaiting merchant approval');
                error.statusCode = 409;
                error.code = 'DRAFT_NOT_APPROVABLE';
                throw error;
            }

            const approvedContent = content === undefined || content === null
                ? candidate.content
                : String(content).trim();
            if (!approvedContent) {
                const error = new Error('Approved message content is required');
                error.statusCode = 400;
                throw error;
            }
            if (approvedContent.length > 4000) {
                const error = new Error('Approved message content must not exceed 4000 characters');
                error.statusCode = 400;
                throw error;
            }

            const sendIdempotencyKey = deriveMessageSendIdempotencyKey({
                shopId,
                conversationId,
                messageId,
            });
            const nextMetadata = {
                ...normalizeObject(candidate.metadata),
                delivered: false,
                delivery_status: 'pending',
                delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                delivery_source: 'DRAFT_APPROVAL',
                suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
                held_reason: null,
                approved_at: new Date().toISOString(),
                approved_by_user_id: actorId || null,
                send_idempotency_key: sendIdempotencyKey,
            };

            await candidate.update({
                content: approvedContent,
                metadata: nextMetadata,
                delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                delivery_source: 'DRAFT_APPROVAL',
                provider_message_id: null,
                send_idempotency_key: sendIdempotencyKey,
            }, { transaction });
            if (InboxDeliveryOutbox && typeof InboxDeliveryOutbox.create === 'function'
                && ['facebook', 'messenger'].includes(conversation.channel)) {
                await InboxDeliveryOutbox.create({
                    shop_id: shopId,
                    conversation_id: conversationId,
                    message_id: messageId,
                    delivery_source: 'DRAFT_APPROVAL',
                    status: 'PENDING',
                    next_attempt_at: new Date(),
                }, { transaction });
            }
            await transaction.commit();
            return { message: candidate, sendIdempotencyKey, alreadySent: false };
        } catch (error) {
            if (!transaction.finished) await transaction.rollback();
            throw error;
        }
    }

    async settleInboxDeliveryOutbox(messageId, {
        sent = false,
        providerAttempted = false,
        providerMessageId = null,
        errorCode = null,
    } = {}) {
        if (!InboxDeliveryOutbox || typeof InboxDeliveryOutbox.update !== 'function' || !messageId) return;
        const status = sent ? 'COMPLETED' : providerAttempted ? 'NEEDS_RECONCILIATION' : 'PENDING';
        await InboxDeliveryOutbox.update({
            status,
            processing_token: null,
            ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
            last_error_code: errorCode || null,
            next_attempt_at: status === 'PENDING' ? new Date() : null,
        }, {
            where: {
                message_id: messageId,
                status: { [Op.in]: ['PENDING', 'PROCESSING'] },
            },
        });
    }

    async dismissAiDraft(conversationId, shopId, messageId, actorId = null) {
        const transaction = await sequelize.transaction();
        try {
            const conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!conversation) {
                const error = new Error('Conversation not found');
                error.statusCode = 404;
                throw error;
            }
            const candidate = await Message.findOne({
                where: { id: messageId, conversation_id: conversationId, sender: 'ai' },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!candidate) {
                const error = new Error('AI suggestion not found');
                error.statusCode = 404;
                throw error;
            }

            const state = normalizeDeliveryState(candidate);
            const dismissalCandidates = await loadDismissalCandidates(conversationId, transaction, candidate);
            const dismissedAt = new Date().toISOString();
            if (state === MESSAGE_DELIVERY_STATES.DISMISSED) {
                const dismissedSiblingMessageIds = await terminalizeDuplicateSiblings(
                    candidate,
                    dismissalCandidates,
                    transaction,
                    actorId,
                    dismissedAt,
                );
                await transaction.commit();
                return { message: mapMessage(candidate, shopId), alreadyDismissed: true, dismissedSiblingMessageIds };
            }
            if (state === MESSAGE_DELIVERY_STATES.SENT || state === MESSAGE_DELIVERY_STATES.DELIVERED) {
                const error = new Error('A sent AI message cannot be dismissed');
                error.statusCode = 409;
                error.code = 'DRAFT_ALREADY_SENT';
                throw error;
            }
            if (state === MESSAGE_DELIVERY_STATES.SEND_PENDING) {
                const error = new Error('AI suggestion send is already in progress');
                error.statusCode = 409;
                error.code = 'DRAFT_SEND_IN_PROGRESS';
                throw error;
            }
            if (normalizeObject(candidate.metadata).provider_send_attempted === true) {
                const error = new Error('Provider delivery was already attempted; reconcile the message before dismissing it');
                error.statusCode = 409;
                error.code = 'PROVIDER_SEND_ALREADY_ATTEMPTED';
                throw error;
            }
            if (!isReviewableSuggestion(candidate)) {
                const error = new Error('AI suggestion is not dismissible');
                error.statusCode = 409;
                error.code = 'DRAFT_NOT_DISMISSIBLE';
                throw error;
            }

            const metadata = dismissedMetadata(candidate, actorId, dismissedAt);
            await candidate.update({
                metadata,
                delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                delivery_source: candidate.delivery_source || 'AI_DRAFT',
            }, { transaction });
            const dismissedSiblingMessageIds = await terminalizeDuplicateSiblings(
                candidate,
                dismissalCandidates,
                transaction,
                actorId,
                dismissedAt,
            );
            await transaction.commit();
            return { message: candidate, alreadyDismissed: false, dismissedSiblingMessageIds };
        } catch (error) {
            if (!transaction.finished) await transaction.rollback();
            throw error;
        }
    }

    async markConversationRead(conversationId, shopId, messageId) {
        const transaction = await sequelize.transaction();
        let conversation;
        try {
            conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!conversation) {
                const error = new Error('Conversation not found');
                error.statusCode = 404;
                throw error;
            }
            const readThrough = await Message.findOne({
                where: { id: messageId, conversation_id: conversationId, sender: 'customer' },
                transaction,
            });
            if (!readThrough) {
                const error = new Error('Read watermark must reference a customer message in this conversation');
                error.statusCode = 400;
                throw error;
            }

            const currentMetadata = normalizeObject(conversation.metadata);
            const requestedReadAt = new Date(readThrough.created_at).getTime();
            const currentReadAt = currentMetadata.last_read_message_at
                ? new Date(currentMetadata.last_read_message_at).getTime()
                : NaN;
            if (Number.isFinite(currentReadAt)
                && Number.isFinite(requestedReadAt)
                && requestedReadAt <= currentReadAt) {
                await transaction.commit();
                return this.mapConversation(conversation);
            }

            const unreadCount = typeof Message.count === 'function' && Number.isFinite(requestedReadAt)
                ? await Message.count({
                    where: {
                        conversation_id: conversationId,
                        sender: 'customer',
                        created_at: { [Op.gt]: readThrough.created_at },
                    },
                    transaction,
                })
                : 0;
            const metadata = {
                ...currentMetadata,
                unreadCount,
                last_read_message_id: readThrough.id,
                last_read_message_at: readThrough.created_at || new Date().toISOString(),
                last_read_at: new Date().toISOString(),
            };
            await conversation.update({ metadata }, { transaction });
            await transaction.commit();
            return this.mapConversation(conversation);
        } catch (error) {
            if (!transaction.finished) await transaction.rollback();
            throw error;
        }
    }

    async holdPendingAiCandidates(conversationId, shopId, reason = 'human_active') {
        const conversation = await Conversation.findOne({
            where: { id: conversationId, shop_id: shopId },
        });
        if (!conversation || typeof Message.findAll !== 'function') return 0;

        const candidates = await Message.findAll({
            where: { conversation_id: conversationId, sender: 'ai' },
        });
        const pending = candidates.filter((message) => {
            const state = normalizeDeliveryState(message);
            const metadata = normalizeObject(message.metadata);
            return !isProviderConfirmed(message)
                && state !== MESSAGE_DELIVERY_STATES.DISMISSED
                && state !== MESSAGE_DELIVERY_STATES.FAILED
                && metadata.provider_send_attempted !== true;
        });
        await Promise.all(pending.map(async (message) => {
            const metadata = {
                ...normalizeObject(message.metadata),
                delivered: false,
                delivery_status: 'held',
                delivery_state: MESSAGE_DELIVERY_STATES.HELD,
                held_reason: reason,
                suggestion_visibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                cancelled_by_human: true,
                cancelled_at: new Date().toISOString(),
            };
            let updatedCount = 0;
            if (typeof Message.update === 'function') {
                const result = await Message.update({
                    delivery_state: MESSAGE_DELIVERY_STATES.HELD,
                    metadata,
                }, {
                    where: {
                        id: message.id,
                        conversation_id: conversationId,
                        sender: 'ai',
                        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                        provider_message_id: null,
                        [Op.and]: [
                            literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`),
                        ],
                    },
                });
                updatedCount = Array.isArray(result) ? result[0] : 1;
            } else if (typeof message.update === 'function') {
                await message.update({
                    delivery_state: MESSAGE_DELIVERY_STATES.HELD,
                    metadata,
                });
                updatedCount = 1;
            }
            if (updatedCount !== 1) return;
            message.delivery_state = MESSAGE_DELIVERY_STATES.HELD;
            message.metadata = metadata;
            sseManager.emit(shopId, 'message_delivery_updated', {
                conversation_id: conversationId,
                message_id: message.id,
                metadata: mapMessage(message, shopId).metadata,
                delivery_state: MESSAGE_DELIVERY_STATES.HELD,
                delivery_source: message.delivery_source || metadata.delivery_source || null,
                content: message.content || null,
                sender: message.sender === 'business' ? 'agent' : message.sender || 'ai',
                created_at: message.created_at || null,
            });
        }));
        return pending.length;
    }

    async updateConversation(conversationId, shopId, updates, opts = {}) {
        const update = async (transaction) => {
            const conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId },
                ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
            });

            if (!conversation) {
                throw new Error('Conversation not found');
            }

            const currentConversationMetadata = normalizeObject(conversation.metadata);
            const requestedClosing = updates.status === 'closed';
            let closing = requestedClosing;
            let resolutionOutcome = null;
            if (requestedClosing && updates.last_seen_message_id && typeof Message.findOne === 'function') {
                const lastSeenMessage = await Message.findOne({
                    where: {
                        id: updates.last_seen_message_id,
                        conversation_id: conversationId,
                    },
                    attributes: ['id', 'created_at'],
                    ...(transaction ? { transaction } : {}),
                });
                const lastSeenAt = lastSeenMessage?.created_at
                    ? new Date(lastSeenMessage.created_at).getTime()
                    : NaN;
                if (Number.isFinite(lastSeenAt)) {
                    const newerCustomerMessage = await Message.findOne({
                        where: {
                            conversation_id: conversationId,
                            sender: 'customer',
                            created_at: { [Op.gt]: lastSeenMessage.created_at },
                        },
                        attributes: ['id'],
                        order: [['created_at', 'ASC']],
                        ...(transaction ? { transaction } : {}),
                    });
                    if (newerCustomerMessage) {
                        closing = false;
                        resolutionOutcome = 'kept_open_newer_customer_message';
                    }
                }
            }
            const resuming = updates.hitl === false && !closing;
            // P+03 (spec §9.4/9.5): ownership is server-authoritative. A
            // takeover while another agent already owns an OPEN handoff is an
            // explicit conflict (409), never a silent overwrite — same for a
            // resolution written over another owner's pending work. Owner and
            // admin members may force (manager escalation); a forced action
            // still records the new owner below.
            const actor = opts.actor || null;
            const privileged = actor && ['owner', 'admin'].includes(String(actor.role || '').toLowerCase());
            const sameOwner = actor && conversation.assignee_id
                && String(conversation.assignee_id) === String(actor.userId);
            // A client-supplied force is only meaningful for privileged members;
            // staff must never self-escalate over another owner's handoff (FlowGuard).
            const forced = opts.force === true && privileged;
            if (actor && conversation.assignee_id && !sameOwner && !privileged && !forced) {
                if (updates.hitl === true && conversation.hitl === true) {
                    const error = new Error('This conversation is already assigned to another team member');
                    error.code = 'HUMAN_TAKEOVER_CONFLICT';
                    error.statusCode = 409;
                    throw error;
                }
                if ((updates.hitl === false || updates.status === 'closed') && conversation.hitl === true) {
                    const error = new Error('Only the assigned teammate (or an admin/owner) can resolve this handoff');
                    error.code = 'HANDOFF_RESOLUTION_CONFLICT';
                    error.statusCode = 409;
                    throw error;
                }
            }
            // MW-V1 D2: an explicit assignment must reference an ACTIVE MEMBER
            // of the acting shop — never any UUID. (Actor-self claims are already
            // covered by JWT + verifyShopAccess; null unassign needs no lookup.)
            if (updates.assignee_id !== undefined && updates.assignee_id !== null) {
                if (typeof UserShop?.findOne !== 'function') {
                    const error = new Error('Assignee membership check unavailable');
                    error.code = 'ASSIGNEE_CHECK_UNAVAILABLE';
                    error.statusCode = 503;
                    throw error;
                }
                const member = await UserShop.findOne({
                    where: { user_id: updates.assignee_id, shop_id: shopId, is_active: true },
                    ...(transaction ? { transaction } : {}),
                });
                if (!member) {
                    const error = new Error('Assignee must be an active member of this shop');
                    error.code = 'INVALID_ASSIGNEE';
                    error.statusCode = 400;
                    throw error;
                }
            }
            const beforeOwnership = {
                assignee_id: conversation.assignee_id || null,
                hitl: conversation.hitl === true,
                status: conversation.status || 'active',
            };
            const existingResumeBoundaryState = resumeBoundaryStateFor(conversation);
            if (resuming
                && existingResumeBoundaryState.present
                && !existingResumeBoundaryState.valid) {
                const error = new Error('Resume AI boundary is invalid');
                error.code = 'RESUME_BOUNDARY_INVALID';
                throw error;
            }
            const existingResumeBoundary = existingResumeBoundaryState.valid
                ? existingResumeBoundaryState.timestamp
                : null;
            const resumeBoundary = resuming
                ? (conversation.hitl === true || !existingResumeBoundary
                    ? new Date().toISOString()
                    : new Date(existingResumeBoundary).toISOString())
                : null;
            const fields = {};
            if (updates.hitl !== undefined) fields.hitl = updates.hitl;
            if (updates.status !== undefined) {
                const nextStatus = closing ? updates.status : 'active';
                fields.status = nextStatus;
                fields.metadata = { ...currentConversationMetadata, status: nextStatus };
                if (closing && updates.status === 'closed') {
                    // Fence any in-flight pre-close AI turn. A later customer
                    // inbound is newer than this boundary and still reopens normally.
                    fields.metadata[RESUME_BOUNDARY_METADATA_KEY] = new Date().toISOString();
                }
                if (closing && updates.status === 'closed' && !conversation.resolved_at) {
                    fields.resolved_at = new Date();
                }
                if (closing && updates.status === 'closed') {
                    // Resolution ends the transient human session. The shop's
                    // global automation mode is intentionally unchanged.
                    fields.hitl = false;
                }
            }
            if (resuming && (conversation.hitl === true || !existingResumeBoundary)) {
                fields.metadata = {
                    ...(fields.metadata || currentConversationMetadata),
                    [RESUME_BOUNDARY_METADATA_KEY]: resumeBoundary,
                };
            }
            // ADR-0013 §8: manual takeover reason. `handoff_reason` only applies
            // with hitl:true and is a fixed-list merchant reason, distinct from
            // the SYSTEM handoff_reason. Merge into the SINGLE fields.metadata
            // object AFTER the status/resume-boundary writes so no stale
            // snapshot can clobber a concurrent metadata field.
            if (updates.hitl === true && !closing) {
                fields.metadata = {
                    ...(fields.metadata || currentConversationMetadata),
                    manual_handoff_reason: updates.handoff_reason || 'manual_takeover',
                    manual_handoff_at: new Date().toISOString(),
                    manual_handoff_by: actor?.userId || null,
                };
            }
            if (updates.assignee_id !== undefined) fields.assignee_id = updates.assignee_id;
            else if (updates.hitl === true && actor?.userId) {
                // "Take over" == claim: a handoff requested is not a person
                // responsible until someone (or their manager) is assigned.
                fields.assignee_id = actor.userId;
            }
            if (updates.resolution_note !== undefined) fields.resolution_note = updates.resolution_note;

            await conversation.update(fields, ...(transaction ? [{ transaction }] : []));

            // MW-V1 D4: ownership/workflow transitions are audited where they
            // actually happen (server-side, non-fatal). Defer persistence until
            // after commit so the best-effort insert cannot extend the
            // conversation row lock. The idempotency_key is a correlation hash
            // (audit_logs.idempotency_key is a non-unique index, so this records,
            // it does not dedup).
            const afterOwnership = {
                assignee_id: conversation.assignee_id ?? null,
                hitl: conversation.hitl === true,
                status: conversation.status || 'active',
            };
            const ownershipChanged = String(beforeOwnership.assignee_id) !== String(afterOwnership.assignee_id)
                || beforeOwnership.hitl !== afterOwnership.hitl
                || beforeOwnership.status !== afterOwnership.status;
            const ownershipAuditEntry = ownershipChanged && actor
                ? {
                        user_id: actor.userId || null,
                        shop_id: shopId,
                        action: 'CONVERSATION_OWNERSHIP_UPDATE',
                        resource_type: 'conversation_ownership',
                        resource_id: conversationId,
                        idempotency_key: crypto.createHash('sha256')
                            .update([conversationId, JSON.stringify(beforeOwnership), JSON.stringify(afterOwnership), actor.userId || 'system'].join('|'))
                            .digest('hex'),
                        metadata: { from: beforeOwnership, to: afterOwnership, forced: forced === true },
                    }
                : null;

            const heldEvents = [];

            // Takeover and resolution invalidate any candidate that has not
            // crossed the provider boundary. The worker performs the same check
            // at its final send gate, while this update keeps an already-
            // persisted pending candidate from appearing sendable elsewhere.
            if ((updates.hitl === true || updates.hitl === false || updates.status === 'closed')
                && typeof Message.findAll === 'function') {
                const heldReason = resuming
                    ? 'resume_obsolete'
                    : resolutionOutcome
                        ? 'newer_customer_message'
                        : closing
                            ? 'conversation_closed'
                            : 'human_active';
                const nextState = resuming || resolutionOutcome
                    ? MESSAGE_DELIVERY_STATES.DISMISSED
                    : MESSAGE_DELIVERY_STATES.HELD;
                const dismissed = resuming || resolutionOutcome;
                const suggestionVisibility = closing || resuming || resolutionOutcome
                    ? SUGGESTION_VISIBILITY.HIDDEN_DISMISSED
                    : SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW;
                const candidateWhere = {
                    conversation_id: conversationId,
                    sender: 'ai',
                };
                const pending = await Message.findAll({
                    where: candidateWhere,
                    ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                });
                const cancellable = pending.filter((message) => (
                    !isProviderConfirmed(message)
                    && normalizeDeliveryState(message) !== MESSAGE_DELIVERY_STATES.DISMISSED
                    && normalizeObject(message.metadata).provider_send_attempted !== true
                    && (!resuming || isResumableStaleCandidate(message, resumeBoundary))
                ));
                await Promise.all(cancellable.map(async (message) => {
                    const messageMetadata = normalizeObject(message.metadata);
                    const metadata = {
                        ...messageMetadata,
                        delivered: false,
                        delivery_status: dismissed ? 'dismissed' : 'held',
                        delivery_state: nextState,
                        held_reason: resuming ? 'resume_obsolete' : heldReason,
                        suggestion_visibility: suggestionVisibility,
                        ...(dismissed ? {
                            dismissed_at: new Date().toISOString(),
                            ...(resuming ? { dismissed_by_resume: true } : {}),
                            ...(resolutionOutcome ? { dismissed_by_newer_customer_message: true } : {}),
                        } : {}),
                    };
                    await message.update({
                        delivery_state: nextState,
                        metadata,
                    }, ...(transaction ? [{ transaction }] : []));
                    heldEvents.push({ message, metadata });
                }));
            }

            return { conversation, heldEvents, resolutionOutcome, ownershipChanged, ownershipAuditEntry };
        };

        try {
            const result = sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function'
                ? await sequelize.transaction((transaction) => update(transaction))
                : await update(null);
            if (result.ownershipAuditEntry && typeof AuditLog?.create === 'function') {
                try {
                    await AuditLog.create(result.ownershipAuditEntry);
                } catch (_) {
                    // Audit persistence is best-effort; the ownership update is
                    // already committed and must remain successful on failure.
                }
            }
            for (const { message, metadata } of result.heldEvents) {
                sseManager.emit(shopId, 'message_delivery_updated', {
                    conversation_id: conversationId,
                    message_id: message.id,
                    metadata: mapMessage(message, shopId).metadata,
                    delivery_state: metadata.delivery_state,
                    delivery_source: message.delivery_source || metadata.delivery_source || null,
                    content: message.content || null,
                    sender: message.sender === 'business' ? 'agent' : message.sender || 'ai',
                    created_at: message.created_at || null,
                });
            }
            const aiReplyMode = await getEffectiveAiReplyMode(shopId);
            const messages = typeof Message.findAll === 'function'
                ? await Message.findAll({
                    where: { conversation_id: conversationId },
                    attributes: [
                        'id',
                        'conversation_id',
                        'sender',
                        'created_at',
                        'delivery_state',
                        'delivery_source',
                        'provider_message_id',
                        'metadata',
                    ],
                })
                : [];
            const finalShape = {
                ...this.mapConversation(result.conversation),
                hitl: result.conversation.hitl,
                ...deriveWorkflowProjection(result.conversation, messages || [], aiReplyMode),
                ...(result.resolutionOutcome ? { resolution_outcome: result.resolutionOutcome } : {}),
            };
            if (finalShape.assignee_id) {
                const names = await this.loadAssigneeNames([finalShape.assignee_id]);
                finalShape.assignee = names.get(String(finalShape.assignee_id)) || null;
            }
            // MW-V1 D3: ownership-carrying workflow event now has ONE source —
            // the service at the actual write — and includes the assignee.
            // (The controller previously emitted an ownership-blind duplicate.)
            if (result.ownershipChanged) {
                sseManager.emit(shopId, 'hitl_changed', {
                    conversation_id: conversationId,
                    hitl: finalShape.hitl,
                    status: finalShape.status,
                    needs_merchant_reply: finalShape.needs_merchant_reply,
                    needs_merchant_reply_reason: finalShape.needs_merchant_reply_reason,
                    ai_is_replying: finalShape.ai_is_replying,
                    assignee_id: finalShape.assignee_id,
                    assignee: finalShape.assignee || null,
                });
            }
            return finalShape;
        } catch (error) {
            const wrapped = new Error(`Failed to update conversation: ${error.message}`);
            if (error?.code) wrapped.code = error.code;
            if (error?.statusCode) wrapped.statusCode = error.statusCode;
            throw wrapped;
        }
    }

    async updateConversationStatus(conversationId, shopId, status) {
        return this.updateConversation(conversationId, shopId, { status: status || 'active' });
    }

    async bulkUpdateStatus(shopId, conversationIds = [], status) {
        try {
            if (!shopId) {
                const error = new Error('Shop ID is required');
                error.statusCode = 400;
                throw error;
            }

            if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
                const error = new Error('conversationIds must be a non-empty array');
                error.statusCode = 400;
                throw error;
            }

            const allowedStatuses = new Set([
                'active',
                'closed',
                'archived',
                'unanswered',
                'pending_order',
                'completed',
                'followed_up'
            ]);

            if (!allowedStatuses.has(status)) {
                const error = new Error('Invalid status');
                error.statusCode = 400;
                throw error;
            }

            if (status === 'closed') {
                const targets = typeof Conversation.findAll === 'function'
                    ? await Conversation.findAll({
                        where: {
                            shop_id: shopId,
                            id: { [Op.in]: conversationIds },
                        },
                        attributes: ['id'],
                    })
                    : conversationIds.map((id) => ({ id }));
                const updatedConversationIds = [];

                for (const target of targets) {
                    const conversationId = target?.id || target;
                    const deliveryLock = await acquireBulkDeliveryLock(conversationId);
                    try {
                        // MW-V1 D4b: updateConversation is now the single
                        // ownership-event source (it emits hitl_changed with the
                        // assignee); the previous per-item emit here double-fired.
                        await this.updateConversation(conversationId, shopId, { status: 'closed' });
                        updatedConversationIds.push(conversationId);
                        await Promise.resolve(cacheRedis.del(`ai:pause:${conversationId}`)).catch(() => {});
                    } finally {
                        await releaseBulkDeliveryLock(deliveryLock, conversationId);
                    }
                }

                return {
                    requested: conversationIds.length,
                    updated: updatedConversationIds.length,
                    skipped: Math.max(conversationIds.length - updatedConversationIds.length, 0),
                    status,
                    updated_conversation_ids: updatedConversationIds,
                };
            }

            const [updatedCount] = await Conversation.update(
                { status },
                {
                    where: {
                        shop_id: shopId,
                        id: {
                            [Op.in]: conversationIds
                        }
                    }
                }
            );

            if (status === 'active' && typeof Conversation.findAll === 'function') {
                const updatedConversationRows = await Conversation.findAll({
                    where: {
                        shop_id: shopId,
                        id: { [Op.in]: conversationIds },
                    },
                    attributes: ['id'],
                });
                await Promise.all(updatedConversationRows.map(({ id: conversationId }) => (
                    Promise.resolve(cacheRedis.del(`ai:pause:${conversationId}`)).catch(() => {})
                )));
            }

            return {
                requested: conversationIds.length,
                updated: updatedCount,
                skipped: Math.max(conversationIds.length - updatedCount, 0),
                status
            };
        } catch (error) {
            throw error;
        }
    }

    /**
     * Bug #2 Fix: Full-history search across conversations AND messages.
     * Searches customer name, phone, conversation title, and message content.
     * Returns conversations that match, each annotated with the matching message snippet.
     * 
     * Improvements:
     * - Proper pagination on merged results (not per-query)
     * - Returns total count for proper pagination UI
     * - Uses indexed columns for performance
     */
    async searchConversations(shopId, query, options = {}) {
        const { limit = 20, page = 1 } = options;
        const offset = (page - 1) * limit;

        if (!query || query.trim().length < 2) {
            throw new Error('Search query must be at least 2 characters');
        }

        const like = `%${query.trim()}%`;

        // Search conversations by customer name/phone/title
        const conversationMatches = await Conversation.findAll({
            where: {
                shop_id: shopId,
                [Op.or]: [
                    { title: { [Op.like]: like } }
                ]
            },
            include: [{ model: Customer, as: 'customer' }],
            order: [['created_at', 'DESC']]
            // Note: Don't apply limit/offset here — merge first, paginate after
        });

        // Search message content across ALL messages in this shop's conversations
        const messageMatches = await Message.findAll({
            where: { content: { [Op.like]: like } },
            include: [{
                model: Conversation,
                as: 'conversation',
                where: { shop_id: shopId },
                include: [{ model: Customer, as: 'customer' }]
            }],
            order: [['created_at', 'DESC']]
            // Note: Don't apply limit/offset here — merge first, paginate after
        });

        // Merge results, deduplicate by conversation_id
        const seen = new Set();
        const results = [];

        for (const conv of conversationMatches) {
            if (!seen.has(conv.id)) {
                seen.add(conv.id);
                results.push({ ...this.mapConversation(conv), matchType: 'conversation' });
            }
        }

        for (const msg of messageMatches) {
            const conv = msg.conversation;
            if (conv && !seen.has(conv.id)) {
                seen.add(conv.id);
                results.push({
                    ...this.mapConversation(conv),
                    matchType: 'message',
                    matchSnippet: msg.content?.slice(0, 120)
                });
            }
        }

        // FIX BUG #2: Apply pagination AFTER merging to ensure proper page navigation
        const totalResults = results.length;
        const paginatedResults = results.slice(offset, offset + limit);

        return {
            results: paginatedResults,
            pagination: {
                total: totalResults,
                page,
                limit,
                totalPages: Math.ceil(totalResults / limit),
                hasMore: offset + limit < totalResults
            },
            query
        };
    }

    async getHistoryByCustomer(shopId, customerId, options = {}) {
        const { limit = 10, within_hours } = options;
        const whereClause = {
            shop_id: shopId,
            customer_id: customerId
        };

        if (within_hours) {
            const since = new Date(Date.now() - Number(within_hours) * 60 * 60 * 1000);
            whereClause.created_at = {
                [Op.gte]: since
            };
        }

        const entries = await Conversation.findAll({
            where: whereClause,
            order: [['created_at', 'DESC']],
            limit: Number(limit)
        });

        return entries;
    }

    /**
     * Auto-detect and update conversation status based on conversation state
     * Statuses: 'active', 'unanswered', 'pending_order', 'completed', 'followed_up'
     * 
     * Logic:
     *   - 'pending_order': if any attached order is in draft or pending state
     *   - 'followed_up': if agent has sent a message to this conversation
     *   - 'unanswered': if last message is from customer and >30 min old with no AI response
     *   - 'completed': if conversation marked as completed or all orders shipped
     *   - 'active': default for ongoing conversations
     */
    async autoDetectAndUpdateStatus(conversationId, shopId) {
        try {
            const conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId }
            });

            if (!conversation) {
                return null;
            }

            let detectedStatus = 'active';

            // Import Order model to check for pending orders
            const { Order } = require('../order/order.entity');
            const pendingOrder = await Order.findOne({
                where: {
                    conversation_id: conversationId,
                    status: ['draft', 'pending']
                }
            });

            if (pendingOrder) {
                detectedStatus = 'pending_order';
            } else {
                // Check if agent has replied (message from 'business')
                const agentMessage = await Message.findOne({
                    where: {
                        conversation_id: conversationId,
                        sender: 'business'
                    },
                    order: [['created_at', 'DESC']],
                    limit: 1
                });

                if (agentMessage) {
                    detectedStatus = 'followed_up';
                } else {
                    // Check if unanswered (last message from customer, 30+ min old)
                    const lastCustomerMessage = await Message.findOne({
                        where: {
                            conversation_id: conversationId,
                            sender: 'customer'
                        },
                        order: [['created_at', 'DESC']],
                        limit: 1
                    });

                    if (lastCustomerMessage) {
                        const minutesOld = (Date.now() - lastCustomerMessage.created_at.getTime()) / 60000;
                        if (minutesOld > 30) {
                            detectedStatus = 'unanswered';
                        }
                    }
                }
            }

            // Only update if status changed
            if (conversation.status !== detectedStatus) {
                await conversation.update({ status: detectedStatus });
            }

            return detectedStatus;
        } catch (error) {
            // Log but don't throw — status detection is a nice-to-have
            console.warn(`Failed to auto-detect status for conversation ${conversationId}:`, error.message);
            return null;
        }
    }

    /**
     * ✅ NEW: Send auto-reply when conversation is escalated to human agents
     * Fetches the escalation_reply_template from shop settings and creates a message
     *
     * @param {string} conversationId - Conversation to escalate
     * @param {string} shopId - Shop ID for settings lookup
     * @returns {Promise<Message>} - The created escalation message
     */
    async sendEscalationAutoReply(conversationId, shopId) {
        try {
            const shopService = require('../shop/shop.service');
            const aiSettings = await shopService.getShopAiSettings(shopId);
            
            if (!aiSettings || !aiSettings.escalation_reply_template) {
                return null; // No template configured, skip
            }

            const conversation = await Conversation.findOne({
                where: { id: conversationId, shop_id: shopId }
            });

            if (!conversation) {
                throw new Error(`Conversation ${conversationId} not found`);
            }

            // Create escalation message from AI with the template
            const escalationReply = await Message.create({
                conversation_id: conversationId,
                content: aiSettings.escalation_reply_template,
                sender: 'ai',
                ai_confidence: 1.0,  // Escalation replies are always sent
                metadata: {
                    type: 'escalation_auto_reply',
                    timestamp: new Date().toISOString()
                }
            });

            return this._mapMessage(escalationReply, shopId);
        } catch (error) {
            console.warn(`Failed to send escalation auto-reply for conversation ${conversationId}:`, error.message);
            return null;
        }
    }

    /**
     * Helper to map message entity to API response format
     */
    _mapMessage(message, shopId) {
        return mapMessage(message, shopId);
    }
}

module.exports = new ConversationService();
