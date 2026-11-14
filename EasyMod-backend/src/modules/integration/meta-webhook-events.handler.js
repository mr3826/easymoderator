'use strict';

/**
 * Meta Webhook — Page Event Handler
 *
 * Handles inbound Messenger (page) webhooks:
 *   - Persist a durable receipt for every event BEFORE acknowledging Meta
 *   - Find-or-create customer
 *   - Find-or-create conversation (rolling 24h window)
 *   - Store message with idempotency guard
 *   - Emit SSE event to connected dashboard clients
 *   - Process consent (STOP keyword → opt-out, else OPT_IN_IMPLICIT)
 *   - Dispatch BullMQ job for AI processing (unless STOP or duplicate)
 *   - Record the outcome on the receipt so nothing is ever silently dropped
 *
 * F-02 / F-03: an unmapped Page or a failed message INSERT used to be logged and
 * abandoned while Meta was told 200 — which suppresses Meta's own retry and
 * destroys the only copy of a real customer message. Every event now lands in
 * meta_webhook_receipts first, and every terminal outcome is written back.
 */

const { Customer, AuditLog, InboxDeliveryOutbox } = require('../entities');
const { Conversation, Message } = require('../conversation/conversation.entity');
const { sequelize } = require('../../utils/database/database-setup');
const { Op, literal } = require('sequelize');
const sseManager = require('../../utils/sse-manager');
const consentService = require('../consent/consent.service');
const { createLogger } = require('../../utils/structured-logger');
const { opsAlert } = require('../../utils/ops-alert');
const { recordReceiptClaimConflict, recordInboundEventMetric } = require('./meta-webhook-metrics');
const { cacheRedis } = require('../../config/redis');
const receiptService = require('./meta-webhook-receipt.service');

const logger = createLogger('MetaWebhookEvents');

/**
 * Resolve a customer without allowing a Page-scoped identifier to create a
 * duplicate of a pre-Page legacy row. The conditional adoption update is the
 * ownership fence when two Pages receive the same historical PSID at once.
 */
async function findOrAdoptCustomer({
    shopId,
    channelType,
    channelUserId,
    metaChannelId = null,
    defaults,
    transaction = null,
    createIfMissing = true,
}) {
    const baseWhere = {
        shop_id: shopId,
        channel_type: channelType,
        channel_user_id: String(channelUserId),
    };

    // Keep the fallback for narrow unit-test doubles and older callers. The
    // production Customer model has all three explicit methods below.
    if (typeof Customer.findOne !== 'function'
        || typeof Customer.update !== 'function'
        || (createIfMissing && typeof Customer.create !== 'function')) {
        if (!createIfMissing || typeof Customer.findOrCreate !== 'function') return null;
        const result = await Customer.findOrCreate({
            where: {
                ...baseWhere,
                ...(metaChannelId ? { meta_channel_id: metaChannelId } : {}),
            },
            defaults: {
                ...defaults,
                ...baseWhere,
                meta_channel_id: metaChannelId,
            },
            ...(transaction ? { transaction } : {}),
        });
        return Array.isArray(result) ? result[0] : result;
    }

    const findOptions = (where) => ({
        where,
        ...(transaction ? { transaction } : {}),
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const exactWhere = {
        ...baseWhere,
        meta_channel_id: metaChannelId || null,
    };

    let customer = await Customer.findOne(findOptions(exactWhere));
    if (customer || !metaChannelId) return customer;

    const legacyCustomer = await Customer.findOne(findOptions({
        ...baseWhere,
        meta_channel_id: null,
    }));
    if (legacyCustomer && !legacyCustomer.meta_channel_id) {
        const [adoptedCount] = await Customer.update(
            { meta_channel_id: metaChannelId },
            {
                where: {
                    id: legacyCustomer.id,
                    ...baseWhere,
                    meta_channel_id: null,
                },
                ...(transaction ? { transaction } : {}),
            },
        );
        if (adoptedCount === 1) {
            if (typeof legacyCustomer.set === 'function') legacyCustomer.set({ meta_channel_id: metaChannelId });
            else legacyCustomer.meta_channel_id = metaChannelId;
            return legacyCustomer;
        }

        // Another Page may have won the conditional adoption. Re-read only
        // the requested Page before deciding whether a new scoped row is safe.
        customer = await Customer.findOne(findOptions(exactWhere));
        if (customer) return customer;
    }

    if (!createIfMissing) return null;

    try {
        return await Customer.create({
            ...defaults,
            ...baseWhere,
            meta_channel_id: metaChannelId,
        }, transaction ? { transaction } : undefined);
    } catch (err) {
        // A concurrent create can win the Page-scoped unique index. Re-read
        // that exact Page row; never fall back to a different Page's customer.
        if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
        customer = await Customer.findOne(findOptions(exactWhere));
        if (customer) return customer;
        throw err;
    }
}

const displayChannelForPlatform = (platform) => {
    if (platform === 'facebook' || platform === 'messenger') return 'Facebook';
    if (platform === 'instagram') return 'Instagram';
    return platform || 'Unknown';
};

const fallbackCustomerName = (platform, providerId = null) => {
    const prefix = platform === 'facebook' || platform === 'messenger'
        ? 'Facebook customer'
        : `${displayChannelForPlatform(platform)} customer`;
    const normalizedId = typeof providerId === 'string' ? providerId.trim() : '';
    const suffix = normalizedId.replace(/[^A-Za-z0-9]/g, '').slice(-4);
    return suffix ? `${prefix} · …${suffix}` : prefix;
};

const fallbackCustomerMetadata = ({ platform, source = 'webhook' }) => ({
    source,
    platform: platform === 'messenger' ? 'facebook' : platform,
    channel: displayChannelForPlatform(platform),
});

async function lockInboundConversationKey({ shopId, channelType, metaChannelId, customerId, transaction }) {
    if (sequelize?.getDialect?.() !== 'postgres' || typeof sequelize.query !== 'function') return;
    const key = [shopId, channelType, metaChannelId || 'unbound', customerId].join(':');
    // The 24-hour conversation window is intentionally not a unique index: a
    // shop may have multiple historical threads. Serialize only the
    // find-or-create key so two first messages cannot open two live threads.
    await sequelize.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(:conversation_key, 0))',
        { replacements: { conversation_key: key }, transaction },
    );
}

async function applyFallbackCustomerProfile({ customer, platform, psid, isPlaceholderName }) {
    if (!customer || typeof customer.update !== 'function' || !isPlaceholderName(customer.name)) return;

    const fallbackName = fallbackCustomerName(platform, psid);
    const safeMetadata = Object.fromEntries(
        Object.entries(customer.metadata || {}).filter(([key]) => key !== 'external_id'),
    );
    const hasLegacyExternalId = Object.prototype.hasOwnProperty.call(customer.metadata || {}, 'external_id');
    const fallbackMeta = {
        ...safeMetadata,
        ...fallbackCustomerMetadata({ platform }),
    };
    const currentMeta = safeMetadata;
    const alreadySafe = !hasLegacyExternalId
        && customer.name === fallbackName
        && currentMeta.channel === displayChannelForPlatform(platform)
        && currentMeta.platform === fallbackMeta.platform;

    if (alreadySafe) return;

    try {
        await customer.update({ name: fallbackName, metadata: fallbackMeta });
    } catch (err) {
        logger.warn('Unable to persist fallback customer profile after Meta enrichment miss', {
            customerId: customer.id,
            platform,
            error: err.message,
        });
    }
}

function triggerCustomerProfileEnrichment({ customer, metaChannelId, shopId, platform, psid }) {
    if (!customer || !psid) return;

    try {
        const { enrichCustomerNameFromMeta, isPlaceholderName } = require('../customer/customer-profile.service');
        const metadata = customer.metadata || {};
        const missingProfileFields = !metadata.first_name || !metadata.last_name || !metadata.profile_pic;
        if (!isPlaceholderName(customer.name) && !missingProfileFields) return;

        const logContext = {
            customerId: customer.id,
            shopId,
            platform,
            metaChannelId: metaChannelId || null,
            hasExternalId: true,
        };

        // The fallback is intentional while the profile feature is disabled;
        // do not report that expected path as an enrichment failure.
        if (process.env.META_USER_PROFILE_ENABLED !== 'true') {
            void applyFallbackCustomerProfile({ customer, platform, psid, isPlaceholderName });
            return;
        }

        enrichCustomerNameFromMeta({
            customerId: customer.id,
            metaChannelId,
            shopId,
            platform,
            psid,
        })
            .then(async (updated) => {
                if (updated) {
                    logger.info('Shared inbox customer profile enriched from Meta', logContext);
                    return;
                }
                await applyFallbackCustomerProfile({ customer, platform, psid, isPlaceholderName });
                logger.warn('Shared inbox customer profile enrichment did not update customer; using fallback', logContext);
            })
            .catch(async (err) => {
                await applyFallbackCustomerProfile({ customer, platform, psid, isPlaceholderName });
                logger.warn('Shared inbox customer profile enrichment failed; using fallback', {
                    ...logContext,
                    error: err.message,
                });
            });
    } catch (err) {
        logger.warn('Shared inbox customer profile enrichment unavailable; using fallback', {
            customerId: customer.id,
            shopId,
            platform,
            metaChannelId: metaChannelId || null,
            hasExternalId: true,
            error: err.message,
        });
    }
}

// ─── BullMQ dispatch ──────────────────────────────────────────────────────────

let _messageQueue = null;

class QueueDispatchError extends Error {
    constructor(message, cause = null, code = 'QUEUE_DISPATCH_FAILED') {
        super(message);
        this.name = 'QueueDispatchError';
        this.code = code;
        this.retryable = true;
        this.cause = cause;
    }
}

// The receipt service stores error.name as last_error_code. Keep its existing
// contract while preserving the original failure for diagnostics and tests.
function toReceiptFailure(error, fallbackCode) {
    const code = error?.code || fallbackCode;
    const failure = new Error(error?.message || code);
    failure.name = code;
    failure.code = code;
    failure.retryable = true;
    failure.cause = error?.cause || error || null;
    return failure;
}

async function markQueuedReceipt(receipt, channel, queueJob) {
    try {
        if (!queueJob?.id) {
            throw new QueueDispatchError('Queue did not return a durable job identity', null, 'QUEUE_JOB_ID_MISSING');
        }
        await receiptService.markQueued(receipt, {
            shopId: channel.shop_id,
            metaChannelId: channel.id,
            queueJobId: queueJob.id,
        });
        const receiptIds = queueJob.data?.receiptIds;
        const previousReceiptIds = Array.isArray(receiptIds)
            ? receiptIds.filter((receiptId) => String(receiptId) !== String(receipt.id))
            : [];
        if (previousReceiptIds.length > 0) {
            try {
                await receiptService.rebindQueuedReceipts(previousReceiptIds, {
                    shopId: channel.shop_id,
                    metaChannelId: channel.id,
                    queueJobId: queueJob.id,
                    expectedQueueJobId: queueJob.data?.replacedQueueJobId,
                });
            } catch (rebindError) {
                // The current receipt is already durable and bound to this job.
                // Older coalesced receipts retain their own replay path if a
                // best-effort bulk rebind cannot complete.
                logger.warn('Could not rebind an older burst receipt', {
                    queueJobId: String(queueJob.id),
                    error: rebindError.message,
                });
            }
        }
    } catch (err) {
        throw new QueueDispatchError(
            'Queued receipt update did not take effect',
            err,
            'QUEUE_RECEIPT_UPDATE_FAILED',
        );
    }

    // `updateOrThrow` deliberately treats a lost processing fence as success:
    // another concurrent delivery owns the receipt and will settle it. Do not
    // inspect the stale in-memory instance and turn that safe race into a 503.
}

function getMessageQueue() {
    if (!_messageQueue) {
        try {
            _messageQueue = require('../../jobs/message-queue').messageQueue;
        } catch (err) {
            logger.warn('BullMQ message queue unavailable', { error: err.message });
        }
    }
    return _messageQueue;
}

/**
 * Schedule AI processing after a message has been stored to DB.
 *
 * Rather than enqueue one reply job per message, we (re)schedule a single
 * debounced "burst-flush" per conversation: rapid-fire messages collapse into
 * ONE AI turn and ONE reply (see burst-coalescer.js). The exact Page asset is
 * retained in the job payload so the worker cannot substitute another Page.
 */
async function dispatchMessageJob(storeResult, event, receipt = null) {
    const queue = getMessageQueue();
    if (!queue || typeof queue.add !== 'function') {
        recordInboundEventMetric('inbound_enqueue_failure');
        // No Error object here (queue is simply null), so pass null as the 2nd
        // arg and put context in meta — otherwise the logger reads .message off
        // this object (undefined) and the shop/platform context is dropped.
        logger.error('BullMQ unavailable — message stored in DB but AI pipeline skipped', null, {
            shopId: event.shop_id,
            platform: event.platform,
            externalId: event.raw_event?.message?.mid || event.raw_event?.id || null
        });
        // Stage alert: webhook receipt OK, but the queue is down → no replies at all.
        opsAlert('Webhook→AI dispatch skipped — message queue unavailable', {
            detail: `shop=${event.shop_id} platform=${event.platform}. Messages are being stored `
                + `but the AI pipeline is not running (Redis/BullMQ down?). No auto-replies are going out.`,
            level: 'error',
            context: { shopId: event.shop_id, platform: event.platform },
        }).catch(() => {});
        throw new QueueDispatchError('Message queue is unavailable', null, 'MESSAGE_QUEUE_UNAVAILABLE');
    }

    const {
        shop_id,
        sender,
        platform,
        meta_channel_id = null,
        metaAssetId = null,
    } = event;
    const { conversation_id, customer_id } = storeResult;

    try {
        const { scheduleBurstFlush } = require('../../jobs/burst-coalescer');
        const burstPayload = {
            shopId: shop_id,
            conversationId: conversation_id,
            platform,
            recipientId: sender,
            metaChannelId: meta_channel_id,
            metaAssetId,
            senderInfo: { customer_id },
            messageId: storeResult.message_id || storeResult.id,
            replyContext: storeResult.message?.metadata?.reply_to || null,
            receiptIds: receipt?.id ? [receipt.id] : [],
        };
        if (storeResult.within_allowance !== undefined) {
            burstPayload.within_allowance = storeResult.within_allowance;
        }
        const queueResult = await scheduleBurstFlush(burstPayload);
        return queueResult;
    } catch (err) {
        recordInboundEventMetric('inbound_enqueue_failure');
        logger.error('Failed to schedule burst flush — message stored but auto-reply skipped', err, {
            shop_id,
            conversationId: conversation_id,
            platform,
        });
        // Stage alert: scheduling threw → this customer gets no reply. Throttled
        // per-title so a systemic bug pages once, not per message.
        opsAlert('Webhook→AI schedule FAILED — message stored but no auto-reply', {
            detail: `shop=${shop_id} platform=${platform} conv=${conversation_id}\nerror: ${err.message}`,
            level: 'error',
            context: { shop_id, conversationId: conversation_id, platform, error: err.message },
        }).catch(() => {});
        if (err instanceof QueueDispatchError) throw err;
        throw new QueueDispatchError('Failed to enqueue message for AI processing', err);
    }
}

/**
 * Cancel any pending burst-flush for a conversation (e.g. on a STOP keyword,
 * where no reply should be sent). The STOP path uses strict cancellation so a
 * queue/bookkeeping failure cannot be reported as a successful opt-out.
 */
async function cancelPendingDispatch(conversationId) {
    try {
        const { cancelBurstFlush } = require('../../jobs/burst-coalescer');
        await cancelBurstFlush(conversationId, { strict: true });
    } catch (error) {
        if (error?.code === 'BURST_CANCELLATION_FAILED') throw error;
        const failure = new Error('Burst cancellation failed');
        failure.name = 'BurstCancellationError';
        failure.code = 'BURST_CANCELLATION_FAILED';
        failure.retryable = true;
        failure.cause = error;
        throw failure;
    }
}

// ─── Consent processing ────────────────────────────────────────────────────────

function requireConsentState(result, operation) {
    if (result && typeof result === 'object' && result.id) return result;
    const error = new Error(`${operation} did not return consent state`);
    error.code = 'CONSENT_STATE_UNAVAILABLE';
    error.retryable = true;
    throw error;
}

/**
 * After storing an inbound message: update per-channel consent and detect STOP keywords.
 * Returns whether the AI dispatch should proceed.
 * A consent failure is an explicit no-dispatch outcome. It must never be
 * interpreted as permission to send an automated reply.
 */
async function processInboundConsent({ storeResult, normalizedEvent, channel }) {
    try {
        const platform = normalizedEvent.platform === 'messenger' ? 'facebook' : normalizedEvent.platform;
        const messageText = normalizedEvent.message || '';

        if (consentService.isStopKeyword(messageText)) {
            const consentState = await consentService.recordOptOut({
                shopId: storeResult.shop_id,
                channelId: channel?.id || null,
                customerId: storeResult.customer_id,
                platform,
                source: 'keyword_stop',
                metadata: { message_id: storeResult.message_id, keyword: messageText.trim() },
            });
            requireConsentState(consentState, 'recordOptOut');
            logger.info('Inbound STOP keyword — suppressing AI dispatch', {
                shopId: storeResult.shop_id, customerId: storeResult.customer_id, platform,
            });
            return { shouldDispatch: false };
        }

        const consentState = await consentService.recordInbound({
            shopId: storeResult.shop_id,
            channelId: channel?.id || null,
                customerId: storeResult.customer_id,
                platform,
                metadata: {
                    message_id: storeResult.message_id,
                    event_timestamp: normalizedEvent.timestamp?.toISOString?.() || null,
                },
        });
        requireConsentState(consentState, 'recordInbound');
        return { shouldDispatch: true };
    } catch (err) {
        logger.error('processInboundConsent failed — suppressing AI dispatch', { error: err.message });
        if (!err.code) err.code = 'CONSENT_STATE_UNAVAILABLE';
        err.retryable = true;
        throw err;
    }
}

// ─── messaging_optins ─────────────────────────────────────────────────────────

async function handleMessagingOptin({ channel, senderId, optin }) {
    try {
        const channelType = channel.platform === 'facebook' ? 'messenger' : channel.platform;
        const customer = await findOrAdoptCustomer({
            shopId: channel.shop_id,
            channelType,
            channelUserId: senderId,
            metaChannelId: channel.id || null,
            defaults: {
                name: fallbackCustomerName(channel.platform, String(senderId)),
                metadata: fallbackCustomerMetadata({
                    platform: channel.platform,
                    source: 'messaging_optins',
                }),
            },
        });
        requireConsentState(customer, 'findOrCreate customer');

        const consentState = await consentService.recordOptIn({
            shopId: channel.shop_id,
            channelId: channel.id || null,
            customerId: customer.id,
            platform: channel.platform,
            source: 'webhook_messaging_optins',
            metadata: { ref: optin?.ref || null, user_ref: optin?.user_ref || null },
        });
        requireConsentState(consentState, 'recordOptIn');
        logger.info('messaging_optins recorded', { shopId: channel.shop_id, customerId: customer.id });
    } catch (err) {
        logger.error('handleMessagingOptin failed', { error: err.message });
        throw err;
    }
}

// ─── Message storage ──────────────────────────────────────────────────────────

const REPLY_PREVIEW_MAX_LENGTH = 1000;
const META_TIMESTAMP_MIN_MS = Date.parse('2000-01-01T00:00:00.000Z');
const META_TIMESTAMP_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

function normalizeMetaTimestamp(value, nowMs = Date.now()) {
    const numericValue = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN;
    if (!Number.isFinite(numericValue) || numericValue <= 0) return new Date(nowMs);

    // Meta emits milliseconds, but seconds-scale values must not become
    // 1970-dated messages that disappear from unread and page-one projections.
    const timestampMs = numericValue < 1e12 ? numericValue * 1000 : numericValue;
    if (!Number.isFinite(timestampMs)
        || timestampMs < META_TIMESTAMP_MIN_MS
        || timestampMs > nowMs + META_TIMESTAMP_MAX_FUTURE_MS) {
        return new Date(nowMs);
    }
    return new Date(timestampMs);
}

async function resolveLocalReplyContext({
    providerMessageId,
    shopId,
    channelType,
    metaChannelId,
    conversationId,
    customerId,
    transaction,
}) {
    if (!providerMessageId || !shopId || !metaChannelId || !conversationId || typeof Message.findOne !== 'function') return null;

    const conversationWhere = {
        shop_id: shopId,
        channel: channelType,
        meta_channel_id: metaChannelId,
    };
    const providerMessageWhere = {
        [Op.or]: [
            { external_id: providerMessageId },
            { provider_message_id: providerMessageId },
            // Meta sends text and each attachment as separate provider
            // messages. Outbound persistence keeps all returned MIDs in this
            // JSON array while exposing the last MID as provider_message_id.
            { metadata: { [Op.contains]: { provider_message_ids: [providerMessageId] } } },
        ],
    };
    const includeConversation = (where) => ({
        model: Conversation,
        as: 'conversation',
        required: true,
        where,
        attributes: ['id', 'shop_id', 'channel', 'meta_channel_id'],
    });
    let referenced = await Message.findOne({
        where: {
            conversation_id: conversationId,
            ...providerMessageWhere,
        },
        include: [includeConversation(conversationWhere)],
        transaction,
    });
    if (!referenced && customerId) {
        referenced = await Message.findOne({
            where: providerMessageWhere,
            include: [includeConversation({ ...conversationWhere, customer_id: customerId })],
            transaction,
        });
    }
    if (!referenced) return null;

    const metadata = referenced.metadata && typeof referenced.metadata === 'object'
        ? referenced.metadata
        : {};
    return {
        provider_message_id: providerMessageId,
        internal_message_id: referenced.id,
        is_self_reply: null,
        status: 'resolved',
        sender: referenced.sender === 'business' ? 'agent' : referenced.sender || null,
        content: typeof referenced.content === 'string'
            ? referenced.content.slice(0, REPLY_PREVIEW_MAX_LENGTH)
            : null,
        message_type: metadata.message_type || 'text',
        file_name: metadata.file_name || null,
    };
}

async function reconcileOutboundEcho({ messaging, channel }) {
    const providerMessageId = messaging.message?.mid;
    const recipientId = messaging.recipient?.id;
    if (!providerMessageId || !recipientId || typeof Conversation.findOne !== 'function') {
        return { reconciled: false, retryable: false };
    }

    const customer = await findOrAdoptCustomer({
        shopId: channel.shop_id,
        channelType: 'messenger',
        channelUserId: recipientId,
        metaChannelId: channel.id || null,
        defaults: {},
        createIfMissing: false,
    });
    if (!customer) return { reconciled: false, retryable: true };

    const conversation = await Conversation.findOne({
        where: {
            shop_id: channel.shop_id,
            channel: 'messenger',
            meta_channel_id: channel.id,
        },
        include: [{
            model: Customer,
            as: 'customer',
            required: true,
            where: {
                id: customer.id,
                shop_id: channel.shop_id,
                channel_type: 'messenger',
                channel_user_id: String(recipientId),
                meta_channel_id: channel.id || null,
            },
        }],
        order: [['updated_at', 'DESC']],
    });
    if (!conversation || typeof Message.findOne !== 'function') {
        return { reconciled: false, retryable: true };
    }

    const providerMessageWhere = {
        conversation_id: conversation.id,
        [Op.or]: [
            { external_id: providerMessageId },
            { provider_message_id: providerMessageId },
            { metadata: { [Op.contains]: { provider_message_ids: [providerMessageId] } } },
        ],
    };
    const alreadyReconciled = await Message.findOne({ where: providerMessageWhere });
    if (alreadyReconciled) return { reconciled: true, retryable: false, alreadyReconciled: true };

    const candidateWhere = {
        conversation_id: conversation.id,
        sender: { [Op.in]: ['ai', 'business'] },
        delivery_state: { [Op.in]: ['SEND_PENDING', 'FAILED', 'SENT'] },
        [Op.and]: [
            // A FAILED row is eligible only when a provider call actually
            // started; pre-provider failures must not absorb an unrelated echo.
            literal(`(metadata->>'provider_send_attempted') = 'true'`),
        ],
    };
    const candidates = typeof Message.findAll === 'function'
        ? (await Message.findAll({ where: candidateWhere, order: [['created_at', 'DESC']], limit: 10 }) || [])
        : [await Message.findOne({ where: candidateWhere, order: [['created_at', 'DESC']] })].filter(Boolean);
    const echoText = typeof messaging.message?.text === 'string'
        ? messaging.message.text.trim()
        : null;
    const textMatches = echoText
        ? candidates.filter((item) => String(item.content || '').trim() === echoText)
        : [];
    // Do not assign a provider MID by recency alone when multiple sends are
    // pending. The durable echo receipt is settled as SKIPPED below instead
    // of retrying an event that cannot be matched safely.
    const candidate = textMatches.length === 1
        ? textMatches[0]
        : !echoText && candidates.length === 1
            ? candidates[0]
            : null;
    if (!candidates.length || !candidate) return { reconciled: false, retryable: true };

    let candidateMetadata = candidate.metadata;
    if (typeof candidateMetadata === 'string') {
        try { candidateMetadata = JSON.parse(candidateMetadata); } catch (_) { candidateMetadata = {}; }
    }
    if (!candidateMetadata || typeof candidateMetadata !== 'object' || Array.isArray(candidateMetadata)) candidateMetadata = {};
    const knownProviderIds = [
        candidate.provider_message_id,
        candidateMetadata.provider_message_id,
        ...(Array.isArray(candidateMetadata.provider_message_ids) ? candidateMetadata.provider_message_ids : []),
    ].filter(Boolean).map(String);
    if (knownProviderIds.includes(String(providerMessageId))) {
        return { reconciled: true, retryable: false, alreadyReconciled: true };
    }
    const appendEarlyEcho = candidate.delivery_state === 'SENT'
        && candidateMetadata.provider_send_attempted === true;
    if ((candidate.provider_message_id || candidateMetadata.provider_message_id) && !appendEarlyEcho) {
        return { reconciled: false, retryable: true };
    }

    let providerMessageIds = [
        ...(Array.isArray(candidateMetadata.provider_message_ids)
            ? candidateMetadata.provider_message_ids
            : []),
        providerMessageId,
    ].filter((id, index, ids) => id && ids.indexOf(id) === index);
    let metadata = {
        ...candidateMetadata,
        delivered: true,
        delivery_status: 'sent',
        delivery_state: 'SENT',
        provider_message_id: providerMessageId,
        provider_message_ids: providerMessageIds,
        provider_send_confirmed: true,
        echo_reconciled: true,
    };
    let updatedCount = 0;
    if (typeof Message.update === 'function' && typeof sequelize.transaction === 'function') {
        ({ updatedCount, metadata, providerMessageIds } = await sequelize.transaction(async (transaction) => {
            const locked = await Message.findOne({
                where: { id: candidate.id, conversation_id: conversation.id },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!locked) return { updatedCount: 0, metadata, providerMessageIds };
            let lockedMetadata = locked.metadata;
            if (typeof lockedMetadata === 'string') {
                try { lockedMetadata = JSON.parse(lockedMetadata); } catch (_) { lockedMetadata = {}; }
            }
            if (!lockedMetadata || typeof lockedMetadata !== 'object' || Array.isArray(lockedMetadata)) lockedMetadata = {};
            providerMessageIds = [
                ...(Array.isArray(lockedMetadata.provider_message_ids) ? lockedMetadata.provider_message_ids : []),
                locked.provider_message_id,
                lockedMetadata.provider_message_id,
                providerMessageId,
            ].filter((id, index, ids) => id && ids.indexOf(id) === index);
            metadata = {
                ...lockedMetadata,
                delivered: true,
                delivery_status: 'sent',
                delivery_state: 'SENT',
                provider_message_id: providerMessageId,
                provider_message_ids: providerMessageIds,
                provider_send_confirmed: true,
                echo_reconciled: true,
            };
            const [count] = await Message.update({
                external_id: providerMessageId,
                metadata,
                delivery_state: 'SENT',
                provider_message_id: providerMessageId,
            }, {
                where: {
                    id: candidate.id,
                    conversation_id: conversation.id,
                    delivery_state: { [Op.in]: ['SEND_PENDING', 'FAILED', 'SENT'] },
                    [Op.and]: [literal(`(metadata->>'provider_send_attempted') = 'true'`)],
                },
                transaction,
            });
            return { updatedCount: count, metadata, providerMessageIds };
        }));
    } else if (typeof Message.update === 'function') {
        [updatedCount] = await Message.update({
            external_id: providerMessageId,
            metadata,
            delivery_state: 'SENT',
            provider_message_id: providerMessageId,
        }, {
            where: {
                id: candidate.id,
                conversation_id: conversation.id,
                delivery_state: { [Op.in]: ['SEND_PENDING', 'FAILED', 'SENT'] },
                [Op.and]: [literal(`(metadata->>'provider_send_attempted') = 'true'`)],
            },
        });
    } else {
        updatedCount = 1;
    }
    if (updatedCount !== 1) return { reconciled: false, retryable: true };
    if (InboxDeliveryOutbox && typeof InboxDeliveryOutbox.update === 'function') {
        await InboxDeliveryOutbox.update({
            status: 'COMPLETED',
            processing_token: null,
            last_error_code: null,
            next_attempt_at: null,
        }, {
            where: {
                message_id: candidate.id,
                status: { [Op.in]: ['PENDING', 'PROCESSING', 'NEEDS_RECONCILIATION'] },
            },
        }).catch(() => {});
    }
    sseManager.emit(channel.shop_id, 'message_delivery_updated', {
        conversation_id: conversation.id,
        message_id: candidate.id,
        metadata,
        delivery_state: 'SENT',
        provider_message_id: providerMessageId,
    });
    logger.info('Reconciled Meta outbound echo to existing Inbox message', {
        shopId: channel.shop_id,
        metaChannelId: channel.id,
        conversationId: conversation.id,
        messageId: candidate.id,
    });
    return { reconciled: true, retryable: false };
}

function buildReplyMetadata(replyTo, resolvedReply) {
    if (!replyTo?.mid) return {};
    return {
        reply_to_provider_message_id: String(replyTo.mid),
        reply_to_is_self_reply: replyTo.is_self_reply === true,
        reply_to_internal_message_id: resolvedReply?.internal_message_id || null,
        reply_to: {
            ...(resolvedReply || {}),
            provider_message_id: String(replyTo.mid),
            is_self_reply: replyTo.is_self_reply === true,
            status: resolvedReply ? 'resolved' : 'unavailable',
        },
    };
}

async function mergeConversationMetadata(shopId, conversationId, patch, metaChannelId = null) {
    if (typeof Conversation.findOne !== 'function') return;
    await sequelize.transaction(async (transaction) => {
        const conversation = await Conversation.findOne({
            where: {
                id: conversationId,
                shop_id: shopId,
                ...(metaChannelId ? { meta_channel_id: metaChannelId } : {}),
            },
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
        if (!conversation || typeof conversation.update !== 'function') return;
        if (metaChannelId && String(conversation.meta_channel_id) !== String(metaChannelId)) return;
        let metadata = conversation.metadata;
        if (typeof metadata === 'string') {
            try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
        }
        metadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
        await conversation.update({ metadata: { ...metadata, ...patch } }, { transaction });
    });
}

/**
 * Store incoming customer message in database.
 * Find-or-create customer → find-or-create conversation → create message.
 * Returns { customer_id, conversation_id, message_id, message, shop_id, duplicate? }
 */
async function storeIncomingMessage(event) {
    try {
        const { platform, shop_id, sender, message, meta_channel_id = null } = event;
        const { Op } = require('sequelize');
        const channelType = platform === 'facebook' ? 'messenger' : platform;
        let customerForEnrichment = null;

        const externalId = event.raw_event?.message?.mid || event.raw_event?.id || null;
        if (externalId) {
            const duplicateConversationWhere = {
                shop_id,
                channel: channelType,
            };
            if (meta_channel_id) duplicateConversationWhere.meta_channel_id = meta_channel_id;
            const existing = await Message.findOne({
                where: { external_id: externalId },
                include: [{
                    model: Conversation,
                    as: 'conversation',
                    required: true,
                    where: duplicateConversationWhere,
                    attributes: ['id', 'shop_id', 'customer_id', 'channel', 'meta_channel_id', 'metadata'],
                }],
            });
            if (existing) {
                logger.debug(`Duplicate webhook event skipped (external_id=${externalId})`);
                const fallbackDuplicateConversationWhere = {
                    id: existing.conversation_id,
                    shop_id,
                    channel: channelType,
                };
                if (meta_channel_id) fallbackDuplicateConversationWhere.meta_channel_id = meta_channel_id;

                const existingConversation = existing.conversation || await Conversation.findOne({
                    where: fallbackDuplicateConversationWhere,
                    attributes: ['id', 'shop_id', 'customer_id', 'channel', 'meta_channel_id', 'metadata'],
                });
                const duplicateContextMatches = existingConversation
                    && String(existingConversation.shop_id) === String(shop_id)
                    && existingConversation.channel === channelType
                    && (!meta_channel_id
                        || String(existingConversation.meta_channel_id) === String(meta_channel_id))
                    && existingConversation.customer_id;
                if (!duplicateContextMatches) {
                    const error = new Error('Duplicate message conversation context is unavailable');
                    error.code = 'DUPLICATE_MESSAGE_CONTEXT_UNAVAILABLE';
                    error.retryable = true;
                    throw error;
                }

                let conversationMetadata = existingConversation.metadata || {};
                if (typeof conversationMetadata === 'string') {
                    try { conversationMetadata = JSON.parse(conversationMetadata); } catch (_) { conversationMetadata = {}; }
                }
                const withinAllowance = typeof conversationMetadata?.within_allowance === 'boolean'
                    ? conversationMetadata.within_allowance
                    : false;
                return {
                    customer_id: existingConversation.customer_id,
                    customer_name: null,
                    conversation_id: existing.conversation_id,
                    message_id: existing.id,
                    message: existing,
                    shop_id: event.shop_id,
                    meta_channel_id,
                    within_allowance: withinAllowance,
                    conversation_metadata: conversationMetadata,
                    duplicate: true
                };
            }
        }

        const storedMessage = await sequelize.transaction(async (t) => {
            const customer = await findOrAdoptCustomer({
                shopId: shop_id,
                channelType,
                channelUserId: sender,
                metaChannelId: meta_channel_id,
                defaults: {
                    name: fallbackCustomerName(platform, String(sender)),
                    metadata: fallbackCustomerMetadata({ platform }),
                },
                transaction: t,
            });
            customerForEnrichment = customer;

            await lockInboundConversationKey({
                shopId: shop_id,
                channelType,
                metaChannelId: meta_channel_id,
                customerId: customer.id,
                transaction: t,
            });

            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const conversationScope = {
                shop_id,
                customer_id: customer.id,
                channel: channelType,
                updated_at: { [Op.gte]: oneDayAgo }
            };
            const exactConversationWhere = {
                ...conversationScope,
                meta_channel_id: meta_channel_id || null,
            };
            let conversation = await Conversation.findOne({
                where: exactConversationWhere,
                order: [['updated_at', 'DESC']],
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (conversation && meta_channel_id
                && conversation.meta_channel_id != null
                && String(conversation.meta_channel_id) !== String(meta_channel_id)) conversation = null;

            if (!conversation && meta_channel_id) {
                const legacyConversation = await Conversation.findOne({
                    where: { ...conversationScope, meta_channel_id: null },
                    order: [['updated_at', 'DESC']],
                    lock: t.LOCK.UPDATE,
                    transaction: t,
                });

                if (legacyConversation && !legacyConversation.meta_channel_id
                    && typeof Conversation.update === 'function') {
                    const [adoptedCount] = await Conversation.update(
                        { meta_channel_id },
                        {
                            where: {
                                id: legacyConversation.id,
                                ...conversationScope,
                                meta_channel_id: null,
                            },
                            transaction: t,
                        },
                    );
                    if (adoptedCount === 1) {
                        if (typeof legacyConversation.set === 'function') {
                            legacyConversation.set({ meta_channel_id });
                        } else {
                            legacyConversation.meta_channel_id = meta_channel_id;
                        }
                        conversation = legacyConversation;
                    } else {
                        // A concurrent Page may have adopted the legacy row.
                        // Re-read only the requested Page before creating a new
                        // thread, never a row pinned elsewhere.
                        conversation = await Conversation.findOne({
                            where: exactConversationWhere,
                            order: [['updated_at', 'DESC']],
                            lock: t.LOCK.UPDATE,
                            transaction: t,
                        });
                    }
                }
            }

            const attachments = event.attachments || [];
            const msgContent = message || (attachments.length > 0 ? '[Attachment]' : '');
            const eventTime = event.timestamp instanceof Date && Number.isFinite(event.timestamp.getTime())
                ? event.timestamp
                : new Date();
            if (!conversation) {
                conversation = await Conversation.create({
                    shop_id,
                    customer_id: customer.id,
                    channel: channelType,
                    meta_channel_id,
                    role: 'user',
                    message: msgContent,
                    metadata: {
                        source: 'webhook',
                        platform,
                        last_message_at: eventTime.toISOString(),
                    }
                }, { transaction: t });
            }

            let msgMeta = {};
            if (attachments.length > 0) {
                msgMeta.attachments = attachments.map((attachment) => ({
                    type: attachment?.type || null,
                    url: attachment?.payload?.url || null,
                    name: attachment?.payload?.name || null,
                    mime_type: attachment?.payload?.mime_type || null,
                }));
                const first = attachments[0];
                if (first.type === 'image') {
                    msgMeta = { ...msgMeta, message_type: 'image', image_url: first.payload?.url || null };
                } else {
                    msgMeta = { ...msgMeta, message_type: 'file', file_url: first.payload?.url || null, file_name: first.payload?.name || null };
                }
            }
            const replyTo = event.raw_event?.message?.reply_to || event.reply_to || null;
            const resolvedReply = await resolveLocalReplyContext({
                providerMessageId: replyTo?.mid ? String(replyTo.mid) : null,
                shopId: shop_id,
                channelType,
                metaChannelId: meta_channel_id,
                conversationId: conversation.id,
                customerId: customer.id,
                transaction: t,
            });
            const replyMetadata = buildReplyMetadata(replyTo, resolvedReply);
            const quickReply = event.raw_event?.message?.quick_reply;
            const quickReplyMetadata = quickReply
                && Object.prototype.hasOwnProperty.call(quickReply, 'payload')
                ? { quick_reply: { payload: quickReply.payload } }
                : {};
            if (replyTo?.mid) {
                logger.info(resolvedReply ? 'reply_context_resolved' : 'reply_context_unresolved', {
                    shopId: shop_id,
                    metaChannelId: meta_channel_id,
                    conversationId: conversation.id,
                    providerMessageId: String(replyTo.mid),
                    internalMessageId: resolvedReply?.internal_message_id || null,
                });
            }
            let currentConversationMetadata = conversation.metadata;
            if (typeof currentConversationMetadata === 'string') {
                try { currentConversationMetadata = JSON.parse(currentConversationMetadata); } catch (_) { currentConversationMetadata = {}; }
            }
            if (!currentConversationMetadata || typeof currentConversationMetadata !== 'object' || Array.isArray(currentConversationMetadata)) {
                currentConversationMetadata = {};
            }
            if (['closed', 'archived'].includes(conversation.status)) {
                // A new customer event starts a fresh interaction. Reopen the
                // rolling thread and end any previous human ownership without
                // changing the shop-wide automation mode.
                currentConversationMetadata = {
                    ...currentConversationMetadata,
                    status: 'active',
                };
                await conversation.update({
                    status: 'active',
                    hitl: false,
                    resolved_at: null,
                    resolution_note: null,
                    metadata: currentConversationMetadata,
                }, { transaction: t });
                if (cacheRedis && typeof cacheRedis.del === 'function') {
                    await Promise.resolve(cacheRedis.del(`ai:pause:${conversation.id}`)).catch(() => {});
                }
            }
            const unreadCount = Math.max(0, Number(currentConversationMetadata.unreadCount) || 0) + 1;
            const inboundMetadata = { ...msgMeta, ...replyMetadata, ...quickReplyMetadata };
            const msgRecord = await Message.create({
                conversation_id: conversation.id,
                content: msgContent,
                sender: 'customer',
                external_id: externalId,
                created_at: eventTime,
                metadata: inboundMetadata,
            }, { transaction: t });
            const logicalTurnId = msgRecord?.id ? `burst:${msgRecord.id}` : null;
            if (logicalTurnId) {
                const metadataWithTurn = { ...inboundMetadata, logical_turn_id: logicalTurnId };
                if (typeof msgRecord.update === 'function') {
                    await msgRecord.update({ metadata: metadataWithTurn }, { transaction: t });
                } else if (typeof Message.update === 'function') {
                    await Message.update(
                        { metadata: metadataWithTurn },
                        { where: { id: msgRecord.id, conversation_id: conversation.id }, transaction: t },
                    );
                }
                msgRecord.metadata = metadataWithTurn;
            }

            // The preview watermark is the only comparable event clock. A
            // legacy conversation without it has no prior watermark, even if
            // Sequelize exposes a server-side updated_at value from another
            // operation.
            const currentLastMessageAt = currentConversationMetadata.last_message_at
                ? new Date(currentConversationMetadata.last_message_at)
                : null;
            const eventIsAtOrAfterCurrent = !currentLastMessageAt
                || !Number.isFinite(currentLastMessageAt.getTime())
                || eventTime.getTime() >= currentLastMessageAt.getTime();
            let persistedUnreadCount = unreadCount;
            if (typeof Message.count === 'function') {
                const unreadWhere = {
                    conversation_id: conversation.id,
                    sender: 'customer',
                };
                const readAt = currentConversationMetadata.last_read_message_at
                    ? new Date(currentConversationMetadata.last_read_message_at)
                    : null;
                if (readAt && Number.isFinite(readAt.getTime())) {
                    unreadWhere.created_at = { [Op.gt]: readAt };
                }
                persistedUnreadCount = await Message.count({ where: unreadWhere, transaction: t });
            } else if (currentConversationMetadata.last_read_message_at) {
                const readAt = new Date(currentConversationMetadata.last_read_message_at).getTime();
                if (Number.isFinite(readAt) && eventTime.getTime() <= readAt) {
                    persistedUnreadCount = Math.max(0, Number(currentConversationMetadata.unreadCount) || 0);
                }
            }
            const nextConversationMetadata = {
                ...currentConversationMetadata,
                unreadCount: persistedUnreadCount,
                ...(eventIsAtOrAfterCurrent ? {
                    last_actual_message: msgContent,
                    last_message_at: eventTime.toISOString(),
                } : {}),
            };
            await conversation.update({
                ...(eventIsAtOrAfterCurrent ? { message: msgContent, updated_at: eventTime } : {}),
                metadata: nextConversationMetadata,
            }, { transaction: t });

            logger.info(`Stored ${platform} message`, { customerId: customer.id, convId: conversation.id, msgId: msgRecord.id });

            return {
                customer_id: customer.id,
                customer_name: customer.name,
                conversation_id: conversation.id,
                message_id: msgRecord.id,
                message: msgRecord,
                shop_id,
                meta_channel_id,
                conversation_metadata: nextConversationMetadata,
                unread_count: persistedUnreadCount,
            };
        });

        // Meter every inbound message using the conversation id as the
        // idempotency key. New conversations increment usage; later messages
        // reuse the original decision without incrementing again. Persisting the
        // decision on the conversation prevents a later message from bypassing
        // an exhausted legacy allowance after the burst job has completed.
        if (storedMessage?.conversation_id) {
            try {
                const subscriptionService = require('../subscription/subscription.service');
                const usageResult = await subscriptionService.trackUsage(
                    shop_id,
                    'conversations',
                    1,
                    // Bare conversation id — usage_events.request_id is a uuid column, so a
                    // prefixed key ("conv:<uuid>") makes Postgres reject every insert.
                    // resource_type already namespaces this against orders/products.
                    storedMessage.conversation_id,
                    { resourceId: storedMessage.conversation_id, channel: channelType }
                );
                storedMessage.within_allowance = usageResult.within_allowance === true;
                await mergeConversationMetadata(shop_id, storedMessage.conversation_id, {
                    within_allowance: storedMessage.within_allowance,
                }, storedMessage.meta_channel_id);
            } catch (usageErr) {
                logger.warn('Conversation usage metering failed (non-fatal)', {
                    shopId: shop_id,
                    conversationId: storedMessage.conversation_id,
                    error: usageErr.message,
                });
                opsAlert('Conversation usage metering failed — quota decision unavailable', {
                    detail: `shop=${shop_id} conversation=${storedMessage.conversation_id}. `
                        + 'The message was retained and the AI path was stopped safely.',
                    level: 'warning',
                    context: {
                        shopId: shop_id,
                        conversationId: storedMessage.conversation_id,
                        error: usageErr.message,
                    },
                }).catch(() => {});
                if (AuditLog && typeof AuditLog.create === 'function') {
                    AuditLog.create({
                        shop_id,
                        resource_type: 'subscription_usage',
                        resource_id: storedMessage.conversation_id,
                        action: 'usage_metering_failed',
                        metadata: {
                            conversationId: storedMessage.conversation_id,
                            error: usageErr.message,
                        },
                        user_id: null,
                        idempotency_key: `usage_metering_failed:${storedMessage.conversation_id}`,
                    }).catch(() => {});
                }
                storedMessage.within_allowance = false;
                mergeConversationMetadata(shop_id, storedMessage.conversation_id, {
                    within_allowance: false,
                }, storedMessage.meta_channel_id).catch(() => {});
            }
        }

        triggerCustomerProfileEnrichment({
            customer: customerForEnrichment,
            metaChannelId: meta_channel_id,
            shopId: shop_id,
            platform: channelType,
            psid: sender,
        });

        return storedMessage;
    } catch (error) {
        logger.error('Failed to store incoming message', {
            error: error.message, platform: event?.platform, shop_id: event?.shop_id, stack: error.stack
        });
        throw error;
    }
}

// ─── Page event handler ──────────────────────────────────────────────────────

/**
 * Notify the owning shop that its Page is no longer routable. Best-effort — the
 * durable receipt, not this SSE frame, is what keeps the message recoverable.
 */
async function notifyPageDisconnected(pageId) {
    try {
        const MetaChannel = require('../channel-providers/meta-channel.entity');
        const candidates = await MetaChannel.findAll({
            where: { meta_asset_id: pageId },
            attributes: ['shop_id', 'display_name', 'status']
        });
        if (!Array.isArray(candidates) || candidates.length !== 1) return;
        const [prev] = candidates;
        if (prev) {
            sseManager.emit(prev.shop_id, 'channel_error', {
                type: 'page_disconnected',
                page_id: pageId,
                display_name: prev.display_name || pageId,
                status: prev.status,
                message: `Facebook page messages are not being delivered — the channel is ${prev.status}. Reconnect it in Settings → Channels.`
            });
        }
    } catch (_) { /* best-effort SSE */ }
}

/**
 * Ingest one `entry.messaging[]` event against an already-resolved channel and
 * record the outcome on its durable receipt.
 *
 * Shared by the live webhook path and the reconciler that replays held events,
 * so a retry follows exactly the same code path as a first delivery.
 *
 * @returns {Promise<'processed'|'skipped'|'failed'>}
 */
async function processMessagingEvent({ messaging, channel, receipt, pageId, metaAssetId = pageId, receiptClaimed = false }) {
    const senderId = messaging.sender?.id;

    const channelAssetId = channel?.meta_asset_id || channel?.asset_id;
    if (!channel
        || channel.status !== 'CONNECTED'
        || channel.platform !== 'facebook'
        || !metaAssetId
        || !channelAssetId
        || String(channelAssetId) !== String(metaAssetId)) {
        await receiptService.markIdentityNotResolved(receipt, {
            pageId: metaAssetId || pageId,
            alert: true,
        });
        return 'failed';
    }

    try {
        // A duplicate delivery may find the same non-terminal receipt while the
        // first request is still ingesting it. Claim the row before any side
        // effect so only one live webhook can create a customer message or
        // queue a turn. Keeping this inside the catch is essential: a claim
        // failure must become retryable receipt state, never an unreachable
        // RECEIVED row acknowledged with HTTP 200.
        if (!receiptClaimed) {
            if (typeof receiptService.claimProcessing === 'function') {
                const claimed = await receiptService.claimProcessing(receipt);
                if (!claimed) {
                    logger.warn('Skipped Meta webhook delivery after receipt claim conflict', {
                        pageId: metaAssetId || pageId,
                        receiptId: receipt?.id || null,
                        status: receipt?.status || null,
                    });
                    recordReceiptClaimConflict({
                        pageId: metaAssetId || pageId,
                        receiptId: receipt?.id,
                        status: receipt?.status,
                    });
                    return 'skipped';
                }
            } else {
                await receiptService.markProcessing(receipt);
            }
        }

        if (messaging.optin) {
            try {
                await handleMessagingOptin({ channel, senderId, optin: messaging.optin });
            } catch (err) {
                throw toReceiptFailure(err, 'CONSENT_STATE_UNAVAILABLE');
            }
            await receiptService.markProcessed(receipt, { shopId: channel.shop_id, metaChannelId: channel.id });
            return 'processed';
        }

        const isPageEcho = messaging.message?.is_echo === true
            && senderId != null
            && String(senderId) === String(metaAssetId || pageId);
        if (isPageEcho) {
            logger.debug('Skipped Meta outbound echo', { pageId: metaAssetId });
            const reconciliation = await reconcileOutboundEcho({ messaging, channel }).catch((err) => {
                logger.warn('Unable to reconcile Meta outbound echo', {
                    shopId: channel.shop_id,
                    metaChannelId: channel.id,
                    error: err.message,
                });
                return { reconciled: false, retryable: true };
            });
            if (!reconciliation?.reconciled) {
                logger.warn('Meta outbound echo did not match a unique pending message', {
                    shopId: channel.shop_id,
                    metaChannelId: channel.id,
                });
                if (reconciliation?.retryable) {
                    const error = new Error('Meta outbound echo reconciliation is pending');
                    error.code = 'ECHO_RECONCILIATION_PENDING';
                    error.retryable = true;
                    throw error;
                }
            }
            await receiptService.markSkipped(receipt, 'ECHO');
            return 'skipped';
        }

        const messageText = messaging.message?.text || null;
        const attachments = messaging.message?.attachments || [];
        if (!messageText && attachments.length === 0) {
            logger.debug('Skipped non-message event', { pageId: metaAssetId, keys: Object.keys(messaging) });
            await receiptService.markSkipped(receipt, 'NON_MESSAGE_EVENT');
            return 'skipped';
        }

        const receiptTime = receipt?.received_at ? new Date(receipt.received_at).getTime() : Date.now();
        const normalizedTimestamp = normalizeMetaTimestamp(
            messaging.timestamp,
            Number.isFinite(receiptTime) ? receiptTime : Date.now(),
        );
        const normalizedEvent = {
            platform: 'facebook',
            shop_id: channel.shop_id,
            meta_channel_id: channel.id,
            metaAssetId,
            sender: senderId,
            message: messageText || '',
            attachments,
            reply_to: messaging.message?.reply_to || null,
            timestamp: normalizedTimestamp,
            raw_event: messaging
        };

        logger.info('Processing inbound Facebook message', {
            shopId: channel.shop_id,
            metaChannelId: channel.id,
            metaAssetId,
            hasText: Boolean(messageText),
            attachmentCount: attachments.length,
        });
        const storeResult = await storeIncomingMessage(normalizedEvent);
        if (!storeResult.duplicate) {
            const msgJson = storeResult.message.toJSON ? storeResult.message.toJSON() : storeResult.message;
            sseManager.emit(channel.shop_id, 'new_message', {
                conversation_id: storeResult.conversation_id,
                unread_count: storeResult.unread_count,
                message: {
                    ...msgJson,
                    message_type: msgJson.metadata?.message_type || 'text',
                    sender: 'customer',
                    delivery_state: null,
                    is_transcript_message: true,
                }
            });
        }
        const consentResult = await processInboundConsent({ storeResult, normalizedEvent, channel });
        if (consentResult?.shouldDispatch === true) {
            const queueJob = await dispatchMessageJob(storeResult, normalizedEvent, receipt);
            await markQueuedReceipt(receipt, channel, queueJob);
        } else {
            await cancelPendingDispatch(storeResult.conversation_id);
            await receiptService.markProcessed(receipt, { shopId: channel.shop_id, metaChannelId: channel.id });
        }

        return 'processed';
    } catch (err) {
        logger.error('Failed to process inbound Facebook message', {
            pageId: metaAssetId || pageId,
            error: err.message,
        });
        // Durable, retryable, and alerted. Previously this branch swallowed the
        // failure and the message was gone.
        if (err instanceof QueueDispatchError || err?.code === 'BURST_CANCELLATION_FAILED') {
            await receiptService.markQueueFailure(
                receipt,
                toReceiptFailure(err, 'MESSAGE_QUEUE_UNAVAILABLE'),
                { pageId: metaAssetId || pageId },
            );
        } else {
            await receiptService.markStoreFailure(
                receipt,
                toReceiptFailure(err, 'MESSAGE_STORE_FAILED'),
                { pageId: metaAssetId || pageId },
            );
        }
        return 'failed';
    }
}

/**
 * Handle Facebook Messenger (page object) webhooks.
 *
 * Throws {@link receiptService.WebhookReceiptPersistenceError} when the durable
 * receipt cannot be written; the router turns that into a retryable 5xx so Meta
 * redelivers instead of the event being lost.
 */
async function handlePageWebhook(payload, resolveConnectedChannel) {
    for (const entry of (payload.entry || [])) {
        const pageId = entry.id;
        const events = entry.messaging || [];
        logger.info(`Processing Facebook page ${pageId}`, { eventCount: events.length });

        // Phase 1 — durable receipts BEFORE channel resolution or any business
        // work. Nothing below this point can lose an event.
        const recorded = [];
        for (const messaging of events) {
            const { receipt, duplicate } = await receiptService.recordReceipt({
                pageId,
                messaging,
            });
            recorded.push({ messaging, receipt, duplicate });
        }

        let channel;
        try {
            channel = await resolveConnectedChannel(pageId, 'facebook');
        } catch (err) {
            // The receipt already exists, so acknowledge only after leaving a
            // replayable message in the reconciler's retry set. Non-business
            // events do not carry a replay body and can be settled as skipped.
            logger.error('Meta channel resolution failed after receipt creation', {
                pageId,
                eventCount: recorded.length,
                errorCode: err?.code || err?.name || 'CHANNEL_RESOLUTION_FAILED',
            });
            const resolutionFailure = new Error('Meta channel resolution failed');
            resolutionFailure.name = 'CHANNEL_RESOLUTION_FAILED';
            resolutionFailure.code = 'CHANNEL_RESOLUTION_FAILED';
            resolutionFailure.retryable = true;
            resolutionFailure.cause = err;
            for (const { receipt } of recorded) {
                if (receipt && receiptService.TERMINAL_STATUSES.includes(receipt.status)) continue;
                if (receipt?.status === 'PROCESSING' && receipt.processing_token) {
                    logger.debug('Receipt is already owned while channel resolution failed; leaving it untouched', {
                        pageId,
                        receiptId: receipt.id,
                    });
                    continue;
                }
                if (['message', 'optin', 'echo'].includes(receipt?.event_type)) {
                    await receiptService.markStoreFailure(receipt, resolutionFailure, { pageId });
                } else {
                    await receiptService.markSkipped(receipt, 'CHANNEL_RESOLUTION_FAILED');
                }
            }
            continue;
        }

        if (!channel) {
            logger.error(`No CONNECTED facebook channel for page_id=${pageId} — inbound messages held for retry`);
            let alerted = false;
            for (const { receipt } of recorded) {
                if (receipt && receiptService.TERMINAL_STATUSES.includes(receipt.status)) continue;
                if (receipt?.status === 'PROCESSING' && receipt.processing_token) {
                    logger.debug('Receipt is already owned while Page is disconnected; leaving it untouched', {
                        pageId,
                        receiptId: receipt.id,
                    });
                    continue;
                }
                if (!['message', 'optin', 'echo'].includes(receipt?.event_type)) {
                    await receiptService.markSkipped(receipt, 'PAGE_NOT_CONNECTED');
                    continue;
                }
                await receiptService.markIdentityNotResolved(receipt, { pageId, alert: !alerted });
                alerted = true;
            }
            await notifyPageDisconnected(pageId);
            continue;
        }

        for (const { messaging, receipt, duplicate } of recorded) {
            // A redelivery of something already settled must not re-run ingestion.
            if (duplicate && receipt && receiptService.TERMINAL_STATUSES.includes(receipt.status)) {
                logger.debug(`Duplicate webhook event skipped (receipt ${receipt.id} is ${receipt.status})`);
                continue;
            }
            let eventChannel = channel;
            const wasBound = Boolean(receipt?.shop_id && receipt?.meta_channel_id);
            if (!wasBound && channel?.shop_id && channel?.id) {
                await receiptService.bindReceiptTenant(receipt, {
                    shopId: channel.shop_id,
                    metaChannelId: channel.id,
                });
            }
            if (wasBound) {
                const { resolveConnectedChannelForReceipt } = require('./meta-channel-resolver');
                eventChannel = await resolveConnectedChannelForReceipt({
                    channelId: receipt.meta_channel_id,
                    shopId: receipt.shop_id,
                    assetId: pageId,
                    platform: 'facebook',
                });
                if (!eventChannel) {
                    if (['message', 'optin', 'echo'].includes(receipt.event_type)) {
                        await receiptService.markIdentityNotResolved(receipt, { pageId });
                    } else {
                        await receiptService.markSkipped(receipt, 'BOUND_CHANNEL_UNAVAILABLE');
                    }
                    continue;
                }
            }
            await processMessagingEvent({ messaging, channel: eventChannel, receipt, pageId, metaAssetId: pageId });
        }
    }
}

module.exports = {
    handlePageWebhook,
    processMessagingEvent,
    storeIncomingMessage,
    _private: {
        dispatchMessageJob,
        processInboundConsent,
        QueueDispatchError,
        fallbackCustomerName,
        normalizeMetaTimestamp,
        resolveLocalReplyContext,
        buildReplyMetadata,
    },
};
