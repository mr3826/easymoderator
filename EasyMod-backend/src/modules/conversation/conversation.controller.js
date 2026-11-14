const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Op, literal, where: sequelizeWhere } = require('sequelize');
const conversationService = require('./conversation.service');
const cacheService = require('../../utils/cache.service');
const sseManager = require('../../utils/sse-manager');
const { cacheRedis } = require('../../config/redis');
const { AppError } = require('../../utils/AppError');
const {
    Conversation: ConvModel,
    Customer: CustomerModel,
    Message: MessageModel,
    AuditLog,
} = require('../entities');
const metaChannelService = require('../channel-providers/meta-channel.service');
const { getProvider } = require('../channel-providers/provider.registry');
const conversationLockService = require('./conversation-lock.service');
const policyEngine = require('../policy/policy.engine');
const { getEffectiveAiReplyMode } = require('../shop/ai-reply-mode');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    normalizeDeliveryState,
    isProviderConfirmed,
    providerAcknowledgementId,
    hasProviderAcknowledgement,
} = require('./message-lifecycle');
const { resolvePublicAssetOrigin } = require('../../config/origins');
const { createLogger } = require('../../utils/structured-logger');
const {
    ATTACHMENT_URL_TTL_SECONDS,
    PREPARED_ATTACHMENT_METADATA,
    absolutePathForKey,
    attachmentSigningSecret,
    buildStorageKey,
    markPreparedAttachmentMetadata,
    mintAttachmentUrl,
    parseStorageKey,
    recoverStorageKeyFromLegacyUrl,
    resolveAttachmentStorageKey,
    signAttachmentPath,
} = require('./attachment-storage');

const lifecycleLogger = createLogger('InboxLifecycle');

const AI_PAUSE_TTL_SECS = 1800; // 30 minutes
const DELIVERY_LOCK_TIMEOUT_MS = 300_000;
const DELIVERY_LOCK_WAIT_MS = 10_000;
const META_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_META_ATTACHMENT_TYPES = {
    'image/jpeg': { ext: 'jpg', metaType: 'image' },
    'image/png': { ext: 'png', metaType: 'image' },
    'image/gif': { ext: 'gif', metaType: 'image' },
    'image/webp': { ext: 'webp', metaType: 'image' },
    'application/pdf': { ext: 'pdf', metaType: 'file' },
    'text/plain': { ext: 'txt', metaType: 'file' },
    'text/csv': { ext: 'csv', metaType: 'file' },
    'application/msword': { ext: 'doc', metaType: 'file' },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', metaType: 'file' },
    'application/vnd.ms-excel': { ext: 'xls', metaType: 'file' },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', metaType: 'file' },
};

// Channels that route through Meta Graph API for delivery (Facebook-only).
// Legacy 'instagram' conversation rows resolve to undefined here and are
// skipped — Instagram is no longer a deliverable channel.
const META_CHANNEL_PLATFORM = {
    messenger: 'facebook',
    facebook:  'facebook',
};

function makeHttpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

async function acquireDeliveryLock(conversationId) {
    // Narrow test doubles and single-process callers may not expose a lock
    // primitive. Production Redis does, and then a busy lock is fail-closed.
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
        const error = makeHttpError(409, 'Another Inbox delivery is in progress; retry after it completes');
        error.code = 'CONVERSATION_DELIVERY_BUSY';
        throw error;
    }
    return lock;
}

async function releaseDeliveryLock(lock, conversationId) {
    if (!lock?.success || typeof conversationLockService?.releaseLock !== 'function') return;
    await conversationLockService.releaseLock(conversationId, lock.lockId).catch((error) => {
        lifecycleLogger.warn('Unable to release conversation delivery lock', {
            conversationId,
            error: error.message,
        });
    });
}

function parseDataUrl(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) return null;
    return {
        mimeType: match[1].toLowerCase(),
        buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    };
}

function isHttpsUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        return new URL(value).protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function safePublicBaseUrl(req) {
    return resolvePublicAssetOrigin(req);
}

async function serveConversationAttachment(req, res, next) {
    try {
        const { shopId, fileName } = req.params;
        const expires = Number(req.query.expires);
        const signature = String(req.query.signature || '');
        const secret = attachmentSigningSecret();
        const storageKey = parseStorageKey(`${shopId}/${fileName}`);

        if (!secret || !/^\d+$/.test(String(req.query.expires || ''))
            || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)
            || !storageKey
            || !/^[a-f0-9]{64}$/.test(signature)) {
            return res.status(404).end();
        }

        const expected = signAttachmentPath(storageKey.shopId, storageKey.fileName, expires);
        const expectedBuffer = Buffer.from(expected, 'utf8');
        const receivedBuffer = Buffer.from(signature, 'utf8');
        if (expectedBuffer.length !== receivedBuffer.length
            || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
            return res.status(404).end();
        }

        const absolutePath = absolutePathForKey(`${storageKey.shopId}/${storageKey.fileName}`);
        if (!absolutePath) return res.status(404).end();
        const stat = await fs.stat(absolutePath).catch(() => null);
        if (!stat?.isFile()) return res.status(404).end();
        return res.sendFile(absolutePath, { dotfiles: 'deny' }, (error) => {
            if (error) next(error);
        });
    } catch (error) {
        next(error);
    }
}

function getAttachmentUrlFromMetadata(metadata = {}) {
    return metadata.image_url || metadata.file_url || metadata.file_data_url;
}

function hasConversationAttachmentPath(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        const parsed = value.startsWith('/') && !value.startsWith('//')
            ? new URL(value, 'https://local.invalid')
            : new URL(value);
        const decodedPath = decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
        return decodedPath.startsWith('/uploads/conversation-attachments/');
    } catch (_) {
        return false;
    }
}

function preparedAttachmentResult(messageData, metadata, preparedMetadata) {
    return markPreparedAttachmentMetadata({
        ...messageData,
        metadata,
    }, preparedMetadata);
}

async function prepareOutboundAttachmentMetadata(req, shopId, messageData) {
    const metadata = { ...(messageData.metadata || {}) };
    const incomingDataUrl = metadata.file_data_url || (parseDataUrl(metadata.image_url) ? metadata.image_url : null) || (parseDataUrl(metadata.file_url) ? metadata.file_url : null);
    const existingUrl = metadata.image_url || metadata.file_url;
    const suppliedStorageKey = metadata.attachment_storage_key;
    let storageKey = null;

    if (suppliedStorageKey !== undefined && suppliedStorageKey !== null) {
        const parsedStorageKey = parseStorageKey(suppliedStorageKey);
        if (!parsedStorageKey || parsedStorageKey.shopId !== String(shopId)) {
            throw makeHttpError(400, 'Attachment storage key is invalid for this shop');
        }
        storageKey = `${parsedStorageKey.shopId}/${parsedStorageKey.fileName}`;
    } else if (existingUrl) {
        storageKey = recoverStorageKeyFromLegacyUrl(existingUrl, { expectedShopId: shopId });
        if (!storageKey && hasConversationAttachmentPath(existingUrl)) {
            throw makeHttpError(400, 'Attachment URL is not valid for this shop');
        }
    }

    if (!incomingDataUrl && !existingUrl && !storageKey) {
        return messageData;
    }

    if (!incomingDataUrl && storageKey) {
        const parsedStorageKey = parseStorageKey(storageKey);
        const publicBaseUrl = safePublicBaseUrl(req);
        if (!isHttpsUrl(publicBaseUrl)) {
            throw makeHttpError(400, 'Attachment delivery requires an HTTPS PUBLIC_BASE_URL or BASE_URL');
        }
        const publicUrl = mintAttachmentUrl({
            shopId: parsedStorageKey.shopId,
            fileName: parsedStorageKey.fileName,
            baseUrl: publicBaseUrl,
            ttlSeconds: ATTACHMENT_URL_TTL_SECONDS,
        });
        const messageType = metadata.message_type || messageData.message_type
            || (metadata.image_url ? 'image' : 'file');
        const storedMetadata = {
            ...metadata,
            file_url: publicUrl,
            delivery_status: metadata.delivery_status || 'pending',
            attachment_source: 'inbox_upload',
            attachment_storage_key: storageKey,
            attachment_available: true,
        };
        delete storedMetadata.file_data_url;
        if (messageType === 'image') {
            storedMetadata.image_url = publicUrl;
        } else {
            delete storedMetadata.image_url;
        }
        return preparedAttachmentResult(messageData, storedMetadata, {
            attachment_storage_key: storageKey,
            attachment_source: 'inbox_upload',
            attachment_available: true,
        });
    }

    if (!incomingDataUrl && existingUrl && !isHttpsUrl(existingUrl)) {
        throw makeHttpError(400, 'Attachment URL must be HTTPS');
    }

    const parsed = parseDataUrl(incomingDataUrl);
    if (!parsed) {
        return {
            ...messageData,
            metadata: {
                ...metadata,
                delivery_status: metadata.delivery_status || 'pending',
            },
        };
    }

    const allowed = ALLOWED_META_ATTACHMENT_TYPES[parsed.mimeType];
    if (!allowed) {
        throw makeHttpError(400, 'Attachment type is not supported for Messenger');
    }
    if (parsed.buffer.length > META_ATTACHMENT_MAX_BYTES) {
        throw makeHttpError(400, 'Attachment exceeds the 25MB Messenger limit');
    }

    const messageType = allowed.metaType === 'image' ? 'image' : 'file';
    const publicBaseUrl = safePublicBaseUrl(req);
    if (!isHttpsUrl(publicBaseUrl)) {
        throw makeHttpError(400, 'Attachment delivery requires an HTTPS PUBLIC_BASE_URL or BASE_URL');
    }
    if (!attachmentSigningSecret()) {
        throw makeHttpError(503, 'Attachment delivery is not configured');
    }
    const fileName = `${Date.now()}-${crypto.randomUUID()}.${allowed.ext}`;
    const newStorageKey = buildStorageKey(shopId, fileName);
    const absolutePath = absolutePathForKey(newStorageKey);
    if (!absolutePath) throw makeHttpError(500, 'Attachment storage path is invalid');
    const uploadDir = path.dirname(absolutePath);
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.writeFile(absolutePath, parsed.buffer);

    const publicUrl = mintAttachmentUrl({
        shopId,
        fileName,
        baseUrl: publicBaseUrl,
        ttlSeconds: ATTACHMENT_URL_TTL_SECONDS,
    });
    const storedMetadata = {
        ...metadata,
        message_type: messageType,
        mime_type: parsed.mimeType,
        file_size: parsed.buffer.length,
        file_url: publicUrl,
        delivery_status: 'pending',
        attachment_source: 'inbox_upload',
        attachment_storage_key: newStorageKey,
        attachment_available: true,
    };
    delete storedMetadata.file_data_url;
    if (messageType === 'image') {
        storedMetadata.image_url = publicUrl;
    } else {
        delete storedMetadata.image_url;
    }

    return preparedAttachmentResult({
        ...messageData,
        message_type: messageType,
    }, storedMetadata, {
        attachment_storage_key: newStorageKey,
        attachment_source: 'inbox_upload',
        attachment_available: true,
    });
}

function buildOutboundAttachments(message, shopId) {
    const metadata = messageMetadata(message);
    const messageType = metadata.message_type || message?.message_type;
    if (!['image', 'file'].includes(messageType)) return [];
    const isStoredAttachment = metadata.attachment_source === 'inbox_upload'
        || metadata.attachment_storage_key !== undefined;
    let url = getAttachmentUrlFromMetadata(metadata);
    if (isStoredAttachment) {
        const storageKey = resolveAttachmentStorageKey(metadata, shopId);
        const parsedStorageKey = parseStorageKey(storageKey);
        if (!parsedStorageKey) {
            throw new Error('Outbound attachment storage key is invalid');
        }
        url = mintAttachmentUrl({
            shopId: parsedStorageKey.shopId,
            fileName: parsedStorageKey.fileName,
            baseUrl: resolvePublicAssetOrigin(),
            ttlSeconds: ATTACHMENT_URL_TTL_SECONDS,
        });
    }
    if (!isHttpsUrl(url)) {
        throw new Error('Outbound attachment URL must be HTTPS');
    }
    return [{
        type: messageType === 'image' ? 'image' : 'file',
        url,
        name: metadata.file_name || null,
        mime_type: metadata.mime_type || null,
        size: metadata.file_size || null,
    }];
}

function messageMetadata(message) {
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
}

function projectedMessageMetadata(message, shopId) {
    const projected = typeof conversationService.mapMessage === 'function'
        ? conversationService.mapMessage(message, shopId)
        : null;
    return projected?.metadata || messageMetadata(message);
}

function providerClaimTokenPredicate(token) {
    if (!token) return null;
    if (!/^[a-f0-9]{32}$/i.test(String(token))) return literal('1 = 0');
    return sequelizeWhere(
        literal("metadata->>'provider_send_claim_token'"),
        Op.eq,
        String(token),
    );
}

async function updateDeliveryStatus(shopId, conversationId, message, status, updates = {}) {
    if (!message?.id) return false;
    const deliveryState = updates.delivery_state || (
        status === 'sent'
            ? MESSAGE_DELIVERY_STATES.SENT
            : status === 'failed'
                ? MESSAGE_DELIVERY_STATES.FAILED
                : MESSAGE_DELIVERY_STATES.SEND_PENDING
    );
    const providerMessageId = updates.provider_message_id
        || message.provider_message_id
        || message.metadata?.provider_message_id
        || null;
    const claimToken = messageMetadata(message).provider_send_claim_token;
    const claimTokenPredicate = providerClaimTokenPredicate(claimToken);
    if (status === 'sent' && !providerMessageId) {
        const error = new Error('Provider acknowledgement did not include a message ID');
        error.code = 'PROVIDER_NO_ACK';
        throw error;
    }
    const metadata = {
        ...messageMetadata(message),
        delivery_status: status,
        delivery_state: deliveryState,
        delivered: status === 'sent',
        provider_message_id: providerMessageId,
        ...(updates.provider_message_ids ? { provider_message_ids: updates.provider_message_ids } : {}),
        ...updates,
        ...(status === 'sent' ? {
            provider_accepted_at: messageMetadata(message).provider_accepted_at || new Date().toISOString(),
        } : {}),
    };
    if (typeof message === 'object') {
        message.metadata = metadata;
        message.delivery_state = deliveryState;
        message.provider_message_id = providerMessageId;
        message.delivery_source = metadata.delivery_source || message.delivery_source || null;
    }
    const result = await MessageModel.update({
        ...(providerMessageId ? { external_id: providerMessageId } : {}),
        metadata,
        delivery_state: deliveryState,
        provider_message_id: providerMessageId,
        delivery_source: updates.delivery_source || message.delivery_source || message.metadata?.delivery_source || null,
    }, {
        where: {
            id: message.id,
            conversation_id: conversationId,
            provider_message_id: null,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            ...(claimTokenPredicate ? { [Op.and]: [claimTokenPredicate] } : {}),
        },
    });
    const updatedCount = Array.isArray(result) ? result[0] : 1;
    if (updatedCount !== 1) return false;

    lifecycleLogger.info(status === 'sent' ? 'ai_provider_send_success' : 'ai_provider_send_failure', {
        shopId,
        conversationId,
        messageId: message.id,
        deliveryState,
        providerMessageId,
    });

    if (status === 'sent' && typeof ConvModel.update === 'function' && message.content) {
        await ConvModel.update({
            message: message.content,
        }, { where: { id: conversationId, shop_id: shopId } }).catch(() => {});
    }

    sseManager.emit(shopId, 'message_delivery_updated', {
        conversation_id: conversationId,
        message_id: message.id,
        metadata: projectedMessageMetadata(message, shopId),
        delivery_state: deliveryState,
        provider_message_id: providerMessageId,
        delivery_source: metadata.delivery_source || null,
        content: typeof message === 'object' ? message.content || null : null,
        sender: typeof message === 'object' ? message.sender === 'business' ? 'agent' : message.sender : null,
        created_at: typeof message === 'object' ? message.created_at || null : null,
    });
    return true;
}

async function claimOutboundDelivery(conversationId, message) {
    if (!message?.id || typeof MessageModel.update !== 'function') return true;
    const metadata = messageMetadata(message);
    const claimToken = crypto.randomBytes(16).toString('hex');
    if (metadata.provider_send_attempted === true) return false;
    const claimedMetadata = {
        ...metadata,
        provider_send_attempted: false,
        provider_send_claimed: true,
        provider_send_claim_token: claimToken,
        provider_send_claimed_at: new Date().toISOString(),
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
        delivery_status: 'pending',
        delivered: false,
    };
    const claimResult = await MessageModel.update({
        metadata: claimedMetadata,
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
    }, {
        where: {
            id: message.id,
            conversation_id: conversationId,
            [Op.or]: [
                { delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING },
                {
                    delivery_state: null,
                    [Op.and]: [literal(`metadata->>'delivery_status' = 'pending'`)],
                },
            ],
            provider_message_id: null,
            [Op.and]: [
                literal(`(metadata->>'provider_send_attempted') IS DISTINCT FROM 'true'`),
                literal(`(metadata->>'provider_send_claimed') IS DISTINCT FROM 'true'`),
            ],
        },
    });
    const updatedCount = Array.isArray(claimResult) ? claimResult[0] : 1;
    if (updatedCount !== 1) return false;
    message.metadata = claimedMetadata;
    message.delivery_state = MESSAGE_DELIVERY_STATES.SEND_PENDING;
    return true;
}

async function markOutboundProviderAttempted(conversationId, message) {
    if (!message?.id || typeof MessageModel.update !== 'function') return true;
    const metadata = messageMetadata(message);
    if (metadata.provider_send_attempted === true) return true;
    if (!metadata.provider_send_claim_token) return false;
    const attemptedMetadata = {
        ...metadata,
        provider_send_attempted: true,
        provider_send_claimed: true,
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
        delivery_status: 'pending',
        delivered: false,
    };
    const result = await MessageModel.update({
        metadata: attemptedMetadata,
        delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
    }, {
        where: {
            id: message.id,
            conversation_id: conversationId,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            provider_message_id: null,
            [Op.and]: [
                literal(`(metadata->>'provider_send_claimed') = 'true'`),
                providerClaimTokenPredicate(metadata.provider_send_claim_token),
            ],
        },
    });
    const updatedCount = Array.isArray(result) ? result[0] : 1;
    if (updatedCount !== 1) return false;
    message.metadata = attemptedMetadata;
    return true;
}

async function recordLifecycleAudit({ action, shopId, conversationId, messageId, actorId, deliveryState }) {
    if (!AuditLog || typeof AuditLog.create !== 'function') return;
    const idempotencyKey = crypto.createHash('sha256')
        .update([action, shopId, conversationId, messageId, actorId || 'system'].join('|'))
        .digest('hex');
    await AuditLog.create({
        user_id: actorId || null,
        shop_id: shopId,
        action,
        resource_type: 'conversation_message',
        resource_id: messageId,
        idempotency_key: idempotencyKey,
        metadata: {
            conversation_id: conversationId,
            delivery_state: deliveryState || null,
        },
    }).catch((error) => lifecycleLogger.warn('Inbox lifecycle audit write failed', {
        action,
        shopId,
        conversationId,
        messageId,
        error: error.message,
    }));
}

async function loadProjectedMessage(messageId, conversationId, shopId) {
    if (typeof MessageModel.findOne !== 'function') return null;
    const message = await MessageModel.findOne({
        where: { id: messageId, conversation_id: conversationId },
    });
    return message ? conversationService.mapMessage(message, shopId) : null;
}

/**
 * Deliver an outbound message to the customer's Meta channel.
 * Resolves the exact MetaChannel (or a unique connected legacy fallback),
 * evaluates policy, and delegates to the provider registry for transport.
 * Best-effort: never throws. Emits SSE `delivery_failed` on failure.
 */
async function deliverViaMetaIfApplicable(
    conversationId,
    shopId,
    outboundMessage,
    senderRole = 'agent',
    options = {},
) {
    let isMetaChannel = false;
    let failureReason = null;
    let deliveryResult = null;
    let providerCallStarted = false;
    let deliveryClaimed = false;
    let returnedResult = null;
    let deliveryLock = options.deliveryLock || null;
    let ownsDeliveryLock = false;
    const content = typeof outboundMessage === 'string' ? outboundMessage : outboundMessage?.content || '';
    let attachments = [];
    try {
        attachments = typeof outboundMessage === 'string' ? [] : buildOutboundAttachments(outboundMessage, shopId);
        const conversation = await ConvModel.findOne({
            where: { id: conversationId, shop_id: shopId },
            include: [{ model: CustomerModel, as: 'customer' }]
        });
        if (!conversation) return { sent: false, reason: 'conversation_not_found' };

        const outboundMetadata = outboundMessage?.metadata && typeof outboundMessage.metadata === 'object'
            ? outboundMessage.metadata
            : {};
        const deliverySource = outboundMessage?.delivery_source || outboundMetadata.delivery_source || null;
        const isAiCandidate = outboundMessage?.sender === 'ai' || senderRole === 'ai';
        const isSystemEscalation = deliverySource === 'HITL_ESCALATION';
        if (isAiCandidate
            && !isSystemEscalation
            && (conversation.hitl === true || ['closed', 'archived'].includes(conversation.status))) {
            return {
                sent: false,
                reason: conversation.hitl === true ? 'human_active' : 'conversation_closed',
            };
        }

        const platform = META_CHANNEL_PLATFORM[conversation.channel];
        if (!platform) return { sent: false, reason: 'non_meta_channel' }; // webchat/telegram

        isMetaChannel = true; // past this point: failures should surface to the agent

        if (!deliveryLock) {
            deliveryLock = await acquireDeliveryLock(conversationId);
            ownsDeliveryLock = Boolean(deliveryLock);
        }

        const recipientId = conversation.customer?.channel_user_id;
        if (!recipientId) {
            failureReason = 'Customer Meta ID missing — message saved but not delivered to Messenger';
            return { sent: false, reason: failureReason };
        }
        if (conversation.meta_channel_id
            && conversation.customer?.meta_channel_id
            && String(conversation.customer.meta_channel_id) !== String(conversation.meta_channel_id)) {
            failureReason = 'Customer is not bound to this Messenger Page';
            return { sent: false, reason: failureReason };
        }
        const messageMetadata = outboundMessage?.metadata && typeof outboundMessage.metadata === 'object'
            ? outboundMessage.metadata
            : {};
        if (messageMetadata.provider_send_attempted === true && !isProviderConfirmed(outboundMessage)) {
            failureReason = 'Provider delivery was already attempted; reconciliation is required before retrying';
            return { sent: false, reason: failureReason };
        }

        // Prefer the exact channel pinned to the conversation. Legacy unpinned
        // conversations may use the unique connected channel only when the shop
        // has no routing ambiguity.
        let metaChannel = null;
        if (conversation.meta_channel_id) {
            metaChannel = await metaChannelService.findConnectedById(conversation.meta_channel_id, {
                shopId,
                platform,
            });
        } else {
            metaChannel = await metaChannelService.findUniqueConnectedByShopAndPlatform(shopId, platform);
        }
        if (!metaChannel) {
            failureReason = `No active ${platform} channel — connect your page in Settings → Channels`;
            return { sent: false, reason: failureReason };
        }

        if (metaChannel.status !== 'CONNECTED') {
            failureReason = `Channel is ${metaChannel.status} — reconnect in Settings → Channels`;
            return { sent: false, reason: failureReason };
        }

        const autoFileContent = attachments.length > 0 && outboundMessage?.metadata?.file_name && content === outboundMessage.metadata.file_name;
        const normalizedMessage = {
            text: autoFileContent ? '' : content,
            attachments,
            platform,
            direction: 'outbound',
            senderRole,
        };
        const automationMode = await getEffectiveAiReplyMode(shopId);
        const policyCtx = {
            shopId,
            channelId: metaChannel.id,
            recipientId,
            channel: metaChannel,
            customer: conversation.customer, // already loaded via include above
            settings: { automation_mode: automationMode },
            platform,
        };
        const decision = await policyEngine.evaluateOutbound(normalizedMessage, policyCtx);
        if (!decision.allow) {
            failureReason = `Message blocked by policy: ${decision.reason}`;
            return { sent: false, reason: failureReason };
        }

        deliveryClaimed = await claimOutboundDelivery(conversationId, outboundMessage);
        if (!deliveryClaimed) {
            failureReason = 'Provider delivery is already claimed; reconciliation is required before retrying';
            return { sent: false, reason: failureReason };
        }

        const provider = getProvider(platform);
        if (!(await markOutboundProviderAttempted(conversationId, outboundMessage))) {
            deliveryClaimed = false;
            failureReason = 'Provider delivery was invalidated before the send boundary';
            return { sent: false, reason: failureReason };
        }
        providerCallStarted = true;
        deliveryResult = await provider.sendMessage({
            channel: metaChannel,
            recipientId,
            normalizedMessage: decision.transform || normalizedMessage,
            decision,
        });
        if (!deliveryResult
            || deliveryResult.sent === false
            || deliveryResult.success === false
            || deliveryResult.ok === false) {
            throw new Error('Provider did not confirm the outbound send');
        }
        if (!hasProviderAcknowledgement(deliveryResult)) {
            const error = new Error('Provider acknowledgement did not include a message ID');
            error.code = 'PROVIDER_NO_ACK';
            throw error;
        }
        console.log(`[inbox] Message delivered via ${platform} (conv: ${conversationId})`);
        returnedResult = {
            sent: true,
            providerMessageId: providerAcknowledgementId(deliveryResult),
            providerMessageIds: deliveryResult?.providerMessageIds || null,
        };
        return returnedResult;
    } catch (err) {
        failureReason = err.message;
        console.error(`[inbox] Meta delivery failed for conversation ${conversationId}: ${err.message}`);
        returnedResult = { sent: false, reason: failureReason };
        return returnedResult;
    } finally {
        let foreignProviderClaim = false;
        if (isMetaChannel && failureReason && !deliveryClaimed && outboundMessage?.id
            && typeof MessageModel.findOne === 'function') {
            const latestMessage = await MessageModel.findOne({
                where: { id: outboundMessage.id, conversation_id: conversationId },
            }).catch(() => null);
            const latestMetadata = latestMessage?.metadata && typeof latestMessage.metadata === 'object'
                ? latestMessage.metadata
                : {};
            foreignProviderClaim = latestMetadata.provider_send_claimed === true
                || latestMetadata.provider_send_attempted === true;
        }
        if (isMetaChannel && failureReason && (deliveryClaimed || !foreignProviderClaim)) {
            const failurePersisted = await updateDeliveryStatus(shopId, conversationId, outboundMessage, 'failed', {
                delivery_error: failureReason,
                ...(options.failureState ? { delivery_state: options.failureState } : {}),
                ...(options.failureSuggestionVisibility
                    ? { suggestion_visibility: options.failureSuggestionVisibility }
                    : {}),
                ...(providerCallStarted ? { provider_send_attempted: true, held_reason: 'provider_send_failed' } : {}),
            }).catch(() => false);
            if (failurePersisted) {
                sseManager.emit(shopId, 'delivery_failed', {
                    conversation_id: conversationId,
                    message_id: outboundMessage?.id,
                    reason: failureReason
                });
            }
        } else if (isMetaChannel && outboundMessage?.id && deliveryClaimed
            && !failureReason && hasProviderAcknowledgement(deliveryResult)) {
            const persisted = await updateDeliveryStatus(shopId, conversationId, outboundMessage, 'sent', {
                provider_message_id: providerAcknowledgementId(deliveryResult),
                provider_message_ids: deliveryResult?.providerMessageIds || undefined,
                provider_send_confirmed: true,
            }).catch(() => false);
            if (!persisted) {
                const latest = typeof MessageModel.findOne === 'function'
                    ? await MessageModel.findOne({
                        where: {
                            id: outboundMessage.id,
                            conversation_id: conversationId,
                        },
                    }).catch(() => null)
                    : null;
                const reconciled = latest && isProviderConfirmed(latest)
                    && String(latest.provider_message_id || latest.metadata?.provider_message_id)
                        === String(providerAcknowledgementId(deliveryResult));
                if (!reconciled) {
                    if (returnedResult) {
                        Object.assign(returnedResult, {
                            sent: false,
                            reason: 'Provider acknowledged the message, but local delivery state requires reconciliation',
                            providerMessageId: providerAcknowledgementId(deliveryResult),
                        });
                    }
                    lifecycleLogger.error('provider_ack_persistence_failed', {
                        shopId,
                        conversationId,
                        messageId: outboundMessage.id,
                        providerMessageId: providerAcknowledgementId(deliveryResult),
                    });
                }
            }
        }
        if (ownsDeliveryLock) {
            await releaseDeliveryLock(deliveryLock, conversationId);
            deliveryLock = null;
            ownsDeliveryLock = false;
        }
    }
}

class ConversationController {
    async getConversations(req, res, next) {
        try {
            const shopId = req.user?.shopId;

            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }

            const options = req.query;
            const result = await conversationService.getConversations(shopId, options);

            res.json({ success: true, data: result });
        } catch (error) {
            next(error);
        }
    }

    async getConversationById(req, res, next) {
        try {
            const { conversationId } = req.params;
            const shopId = req.user?.shopId;

            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }

            const conversation = await conversationService.getConversationById(conversationId, shopId);
            res.json({ success: true, data: conversation });
        } catch (error) {
            next(error);
        }
    }

    async getMessages(req, res, next) {
        try {
            const { conversationId } = req.params;
            const shopId = req.user?.shopId;

            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }

            const result = await conversationService.getMessages(conversationId, shopId, req.query);
            res.json({ success: true, data: result });
        } catch (error) {
            next(error);
        }
    }

    async createConversation(req, res) {
        try {
            const shopId = req.user?.shopId;
            
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Shop ID is required'
                    }
                });
            }
            const {
                customer_id,
                channel_type,
                channel,
                role,
                message,
                normalized_message,
                intent,
                intent_confidence,
                title,
                status,
                entities,
                response_metadata
            } = req.body;

            const resolvedChannel = channel_type || channel;

            const conversationData = {
                customer_id,
                channel: resolvedChannel,
                role,
                message,
                intent: intent || null,
                confidence: intent_confidence ? Math.round(intent_confidence * 100) : null,
                llm_used: Boolean(response_metadata && response_metadata.ai_model),
                cache_hit: Boolean(response_metadata && response_metadata.cache_hit),
                keyword_match: Boolean(response_metadata && response_metadata.keyword_match),
                metadata: {
                    normalized_message: normalized_message || null,
                    entities: entities || {},
                    response_metadata: response_metadata || {},
                    title: title || null,
                    status: status || null
                }
            };

            const conversation = await conversationService.createConversation(shopId, conversationData, req.requestId);

            res.status(201).json({
                conversation_id: conversation.id,
                created_at: conversation.created_at
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: {
                    code: 'CONVERSATION_CREATE_FAILED',
                    message: error.message
                }
            });
        }
    }

    async createMessage(req, res) {
        let deliveryLock = null;
        try {
            const { conversationId } = req.params; // Already validated
            const shopId = req.user?.shopId;
            
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Shop ID is required'
                    }
                });
            }
            const requestedSender = req.body?.sender;
            if (requestedSender === 'agent' || requestedSender === 'business') {
                deliveryLock = await acquireDeliveryLock(conversationId);
            }
            const preparedMessageData = await prepareOutboundAttachmentMetadata(req, shopId, req.body); // Already validated
            const messageData = {
                ...preparedMessageData,
                send_idempotency_key: req.get('Idempotency-Key') || preparedMessageData.send_idempotency_key || null,
            };
            if (preparedMessageData[PREPARED_ATTACHMENT_METADATA]) {
                Object.defineProperty(messageData, PREPARED_ATTACHMENT_METADATA, {
                    value: preparedMessageData[PREPARED_ATTACHMENT_METADATA],
                    enumerable: false,
                });
            }

            const message = await conversationService.createMessage(conversationId, shopId, messageData);

            const idempotencyReplay = message.idempotency_replay === true;
            // Push real-time update to all open agent tabs for this shop once.
            if (!idempotencyReplay) {
                sseManager.emit(shopId, 'new_message', { conversation_id: conversationId, message });
            }

            // AI pause: when a human agent sends a message, mute AI replies for 30 min.
            // Frontend sends sender='agent'; service maps it to 'business' in DB — check both.
            const sender = messageData.sender || req.body.sender;
            if (!idempotencyReplay && (sender === 'agent' || sender === 'business')) {
                if (typeof conversationService.holdPendingAiCandidates === 'function') {
                    const cancelledCount = await conversationService.holdPendingAiCandidates(conversationId, shopId, 'human_active')
                        .catch((error) => lifecycleLogger.warn('Unable to cancel pending AI candidate after merchant reply', {
                            shopId,
                            conversationId,
                            error: error.message,
                        })) || 0;
                    lifecycleLogger.info('ai_candidate_cancelled_human_takeover', {
                        shopId,
                        conversationId,
                        cancelledCount,
                    });
                }
                try {
                    // Persist the human-activity pause before starting delivery
                    // so an in-flight worker can observe the takeover at its
                    // final send-boundary re-check.
                    await cacheRedis.setex(`ai:pause:${conversationId}`, AI_PAUSE_TTL_SECS, '1');
                } catch (_) { /* Redis is a safety hint; the manual send still proceeds. */ }
                // Keep the conversation delivery lock through the provider call
                // so a worker cannot cross the send boundary between takeover
                // cancellation and the manual send.
                await deliverViaMetaIfApplicable(conversationId, shopId, message, 'agent', {
                    deliveryLock,
                });
            }

            res.status(201).json({
                success: true,
                data: message
            });
        } catch (error) {
            const statusCode = error.statusCode || (error.message === 'Conversation not found' ? 404 : 500);
            const errorCode = statusCode === 404 ? 'CONVERSATION_NOT_FOUND' : 'MESSAGE_CREATE_FAILED';

            res.status(statusCode).json({
                success: false,
                error: {
                    code: errorCode,
                    message: error.message
                }
            });
        } finally {
            await releaseDeliveryLock(deliveryLock, req.params?.conversationId);
            deliveryLock = null;
        }
    }

    async approveAiDraft(req, res, next) {
        try {
            const { conversationId, messageId } = req.params;
            const shopId = req.user?.shopId;
            if (!shopId) throw makeHttpError(400, 'Shop ID is required');

            const claim = await conversationService.approveAiDraft(
                conversationId,
                shopId,
                messageId,
                req.body?.content,
                req.user?.userId,
            );
            lifecycleLogger.info('ai_draft_approved', {
                shopId,
                conversationId,
                messageId,
                actorId: req.user?.userId || null,
                alreadySent: claim.alreadySent === true,
            });
            await recordLifecycleAudit({
                action: 'ai_draft_approved',
                shopId,
                conversationId,
                messageId,
                actorId: req.user?.userId,
                deliveryState: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            });
            sseManager.emit(shopId, 'message_delivery_updated', {
                conversation_id: conversationId,
                message_id: messageId,
                delivery_state: normalizeDeliveryState(claim.message) || MESSAGE_DELIVERY_STATES.SEND_PENDING,
                metadata: projectedMessageMetadata(claim.message, shopId),
            });

            if (!claim.alreadySent) {
                const delivery = await deliverViaMetaIfApplicable(
                    conversationId,
                    shopId,
                    claim.message,
                    'agent',
                    {
                        failureState: MESSAGE_DELIVERY_STATES.HELD,
                        failureSuggestionVisibility: SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW,
                    },
                );
                if (typeof conversationService.settleInboxDeliveryOutbox === 'function') {
                    await conversationService.settleInboxDeliveryOutbox(messageId, {
                        sent: delivery?.sent === true,
                        providerAttempted: claim.message?.metadata?.provider_send_attempted === true,
                        errorCode: delivery?.sent === true ? null : 'DRAFT_DELIVERY_NOT_CONFIRMED',
                    }).catch((error) => lifecycleLogger.warn('Unable to settle draft delivery outbox', {
                        shopId,
                        conversationId,
                        messageId,
                        error: error.message,
                    }));
                }
                if (delivery?.sent !== true) {
                    throw new AppError(
                        delivery?.reason || 'Provider delivery was not confirmed; reconciliation is required before retrying',
                        409,
                        'DRAFT_DELIVERY_NOT_CONFIRMED',
                    );
                }
            } else if (typeof conversationService.settleInboxDeliveryOutbox === 'function') {
                await conversationService.settleInboxDeliveryOutbox(messageId, { sent: true })
                    .catch((error) => lifecycleLogger.warn('Unable to settle already-sent draft outbox', {
                        shopId,
                        conversationId,
                        messageId,
                        error: error.message,
                    }));
            }

            const message = await loadProjectedMessage(messageId, conversationId, shopId)
                || conversationService.mapMessage(claim.message, shopId);
            res.status(claim.alreadySent ? 200 : 200).json({
                success: true,
                data: { message },
            });
        } catch (error) {
            next(error);
        }
    }

    async dismissAiDraft(req, res, next) {
        try {
            const { conversationId, messageId } = req.params;
            const shopId = req.user?.shopId;
            if (!shopId) throw makeHttpError(400, 'Shop ID is required');

            const result = await conversationService.dismissAiDraft(
                conversationId,
                shopId,
                messageId,
                req.user?.userId,
            );
            lifecycleLogger.info('ai_draft_dismissed', {
                shopId,
                conversationId,
                messageId,
                actorId: req.user?.userId || null,
                alreadyDismissed: result.alreadyDismissed === true,
            });
            lifecycleLogger.info('ai_suggestion_dismissed', {
                shopId,
                conversationId,
                messageId,
                actorId: req.user?.userId || null,
            });
            await recordLifecycleAudit({
                action: 'ai_draft_dismissed',
                shopId,
                conversationId,
                messageId,
                actorId: req.user?.userId,
                deliveryState: MESSAGE_DELIVERY_STATES.DISMISSED,
            });
            sseManager.emit(shopId, 'message_delivery_updated', {
                conversation_id: conversationId,
                message_id: messageId,
                delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                metadata: projectedMessageMetadata(result.message, shopId),
            });
            for (const siblingMessageId of result.dismissedSiblingMessageIds || []) {
                sseManager.emit(shopId, 'message_delivery_updated', {
                    conversation_id: conversationId,
                    message_id: siblingMessageId,
                    delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                    metadata: {
                        delivery_state: MESSAGE_DELIVERY_STATES.DISMISSED,
                        delivery_status: 'dismissed',
                        suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_DISMISSED,
                        held_reason: 'dismissed',
                        dismissed_as_duplicate: true,
                        dismissed_duplicate_of: messageId,
                    },
                });
            }
            res.json({ success: true, data: { message: conversationService.mapMessage(result.message, shopId) } });
        } catch (error) {
            next(error);
        }
    }

    async markConversationRead(req, res, next) {
        try {
            const { conversationId } = req.params;
            const shopId = req.user?.shopId;
            const messageId = req.body?.message_id;
            if (!shopId) throw makeHttpError(400, 'Shop ID is required');
            if (!messageId) throw makeHttpError(400, 'message_id is required');

            const conversation = await conversationService.markConversationRead(conversationId, shopId, messageId);
            lifecycleLogger.info('conversation_mark_read', {
                shopId,
                conversationId,
                messageId,
            });
            sseManager.emit(shopId, 'conversation_read', {
                conversation_id: conversationId,
                unread_count: conversation.unreadCount,
                last_read_message_id: conversation.lastReadMessageId,
                last_read_message_at: conversation.lastReadMessageAt,
            });
            res.json({ success: true, data: conversation });
        } catch (error) {
            next(error);
        }
    }

    async updateConversation(req, res) {
        let deliveryLock = null;
        try {
            const { conversationId } = req.params;
            const shopId = req.user?.shopId;

            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }

            const { hitl, status, assignee_id, resolution_note, last_seen_message_id, handoff_reason } = req.body;
            if (hitl !== undefined || status === 'closed') {
                deliveryLock = await acquireDeliveryLock(conversationId);
            }
            const conversation = await conversationService.updateConversation(
                conversationId,
                shopId,
                // ADR-0013 §8: handoff_reason must reach the service claim branch
                // (Joi-validated above); dropping it here falsified every reason.
                { hitl, status, assignee_id, resolution_note, last_seen_message_id, handoff_reason },
                {
                    actor: req.user ? {
                        userId: req.user.userId || req.user.id || null,
                        role: req.user.role || null,
                    } : null,
                    force: req.body?.force === true,
                }
            );

            // MW-V1 D3/SSE: the ownership/workflow event is emitted once, inside
            // conversation.service.updateConversation, and now carries the
            // assignee. Manual takeover remains state-only; system escalation
            // (human-handoff.service) keeps its own holding-message path.

            // When re-enabling AI (HITL off), clear the 30-min manual-reply pause so the AI
            // can respond immediately instead of waiting out the remainder of the timer.
            if (hitl === false || (status === 'closed' && conversation?.hitl === false)) {
                cacheRedis.del(`ai:pause:${conversationId}`).catch(() => {});
            }

            res.json({ success: true, data: conversation });
        } catch (error) {
            const statusCode = error.statusCode || (error.message === 'Conversation not found' ? 404 : 500);
            const errorCode = error.code || (statusCode === 404 ? 'CONVERSATION_NOT_FOUND' : 'CONVERSATION_UPDATE_FAILED');
            res.status(statusCode).json({
                success: false,
                error: { code: errorCode, message: error.message }
            });
        } finally {
            await releaseDeliveryLock(deliveryLock, req.params.conversationId);
        }
    }

    async updateConversationStatus(req, res) {
        let deliveryLock = null;
        try {
            const { conversationId } = req.params; // Already validated
            const shopId = req.user?.shopId;
            
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Shop ID is required'
                    }
                });
            }
            const { status } = req.body; // Already validated

            if (status === 'closed') {
                deliveryLock = await acquireDeliveryLock(conversationId);
            }
            const conversation = await conversationService.updateConversationStatus(conversationId, shopId, status);
            if (status === 'closed' || status === 'active') {
                await Promise.resolve(cacheRedis.del(`ai:pause:${conversationId}`)).catch(() => {});
            }

            // Workflow SSE is emitted once by the service (MW-V1 D3).

            res.json({
                success: true,
                data: conversation
            });
        } catch (error) {
            const statusCode = error.statusCode || (error.message === 'Conversation not found' ? 404 : 500);
            const errorCode = error.code || (statusCode === 404 ? 'CONVERSATION_NOT_FOUND' : 'CONVERSATION_UPDATE_FAILED');

            res.status(statusCode).json({
                success: false,
                error: {
                    code: errorCode,
                    message: error.message
                }
            });
        } finally {
            await releaseDeliveryLock(deliveryLock, req.params.conversationId);
        }
    }

    async getHistory(req, res) {
        try {
            const shopId = req.user?.shopId;
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Shop ID is required'
                    }
                });
            }

            const { customer_id, limit, within_hours } = req.query;
            if (!customer_id) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'customer_id is required'
                    }
                });
            }

            const entries = await conversationService.getHistoryByCustomer(shopId, customer_id, {
                limit,
                within_hours
            });

            const conversations = entries.map(entry => ({
                id: entry.id,
                role: entry.role,
                message: entry.message,
                normalized_message: entry.metadata?.normalized_message || null,
                intent: entry.intent || null,
                timestamp: entry.created_at,
                metadata: entry.metadata || {}
            }));

            res.status(200).json({
                conversations,
                total: entries.length
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: {
                    code: 'CONVERSATION_HISTORY_FAILED',
                    message: error.message
                }
            });
        }
    }

    async getEventStream(req, res) {
        if (req.headers['x-shop-id'] || req.query.shop_id) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'UNTRUSTED_SHOP_OVERRIDE',
                    message: 'SSE shop selection must come from the authenticated session',
                },
            });
        }
        const shopId = req.user?.shopId;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // Disable nginx/proxy buffering so events arrive immediately
        res.setHeader('X-Accel-Buffering', 'no');
        // Allow the browser to send Last-Event-ID on reconnect.
        // Browsers automatically include this header when an EventSource reconnects
        // after a dropped connection; no client-side code change is required.
        res.setHeader('Access-Control-Expose-Headers', 'Last-Event-ID');
        res.flushHeaders();

        // attachToRequest reads Last-Event-ID, replays any missed events from
        // the Redis replay buffer, then registers this connection on the bus.
        await sseManager.attachToRequest(req, res, shopId, req.user?.userId);

        // Heartbeat keeps the connection alive through idle proxies (25s < 30s proxy timeout)
        const heartbeat = setInterval(() => {
            try { res.write(':heartbeat\n\n'); } catch (_) {}
        }, 25000);

        req.on('close', () => {
            clearInterval(heartbeat);
            sseManager.unregister(shopId, res);
        });
    }

    async checkDuplicate(req, res) {
        try {
            const { message_id, customer_id, timestamp } = req.body;
            if (!message_id || !customer_id) {
                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'message_id and customer_id are required'
                    }
                });
            }

            const key = `dedup:${customer_id}:${message_id}`;
            const existing = await cacheService.get(key);

            if (existing) {
                return res.status(200).json({
                    is_duplicate: true,
                    original_timestamp: existing
                });
            }

            const originalTimestamp = timestamp || new Date().toISOString();
            await cacheService.set(key, originalTimestamp, 86400);

            res.status(200).json({
                is_duplicate: false,
                original_timestamp: null
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: {
                    code: 'DEDUP_CHECK_FAILED',
                    message: error.message
                }
            });
        }
    }
    /**
     * B3: Bulk update status for multiple conversations.
     * PATCH /conversations/bulk-status
     * Body: { conversationIds: [], status: '' }
     */
    async bulkUpdateStatus(req, res) {
        try {
            const shopId = req.user?.shopId;
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }

            const { conversationIds, status } = req.body;
            const result = await conversationService.bulkUpdateStatus(shopId, conversationIds, status);

            res.json({ success: true, data: result });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            res.status(statusCode).json({
                success: false,
                error: { code: 'BULK_UPDATE_FAILED', message: error.message }
            });
        }
    }

    /**
     * Bug #2: Full-history inbox search.
     * GET /conversations/search?q=<query>&page=1&limit=20
     */
    async searchConversations(req, res) {
        try {
            const shopId = req.user?.shopId;
            if (!shopId) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' }
                });
            }
            const { q, page, limit } = req.query;
            if (!q) {
                return res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: 'q (search query) is required' }
                });
            }
            const results = await conversationService.searchConversations(shopId, q, { page, limit });
            res.json({ success: true, data: results });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: { code: 'SEARCH_FAILED', message: error.message }
            });
        }
    }
}

const conversationController = new ConversationController();
conversationController.serveConversationAttachment = serveConversationAttachment;
// Exposed for unit testing only — not part of the route surface.
conversationController._deliverViaMetaIfApplicable = deliverViaMetaIfApplicable;
conversationController._private = {
    buildOutboundAttachments,
    prepareOutboundAttachmentMetadata,
};

module.exports = conversationController;
