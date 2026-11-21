'use strict';

/**
 * Durable inbound Meta webhook receipts (F-02 / F-03).
 *
 * Contract:
 *   1. Every messaging event gets a row BEFORE the webhook is acknowledged.
 *   2. If that write fails the caller must return a retryable 5xx so Meta
 *      redelivers — never a 200, which would destroy the only copy of the event.
 *   3. Every downstream outcome is recorded on the row: processed, skipped,
 *      identity unresolved, store failed, retry pending, dead-lettered.
 *   4. Nothing here logs or alerts with a message body, PSID, or token.
 */

const crypto = require('crypto');
const { literal, Op } = require('sequelize');
const MetaWebhookReceipt = require('./meta-webhook-receipt.entity');
const { encryptPayload, decryptPayload } = require('../../utils/webhook-payload-cipher');
const { createLogger } = require('../../utils/structured-logger');
const { opsAlert } = require('../../utils/ops-alert');
const { recordInboundEventMetric } = require('./meta-webhook-metrics');

const logger = createLogger('MetaWebhookReceipt');

/**
 * Retry ladders in minutes. Storage failures are usually transient, so they
 * retry fast and give up in hours. An unconnected Page is a human problem — the
 * merchant has to reconnect — so those events are held for ~3 days first.
 */
const STORE_RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const IDENTITY_RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720, 1440, 1440];
const MAX_STORE_RETRIES = STORE_RETRY_BACKOFF_MINUTES.length;
const MAX_IDENTITY_RETRIES = IDENTITY_RETRY_BACKOFF_MINUTES.length;
const QUEUE_RECOVERY_DELAY_MS = 5 * 60 * 1000;
const QUEUED_RECOVERY_DELAY_MS = 15 * 60 * 1000;
const QUEUED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A claim older than this is assumed abandoned (crashed runner) and reclaimed. */
const STALE_CLAIM_MS = 15 * 60 * 1000;
/** A receipt left at RECEIVED after the HTTP handler escaped is recoverable. */
const ORPHANED_RECEIVED_MS = 60 * 1000;

/** Retention — receipts are operational evidence, not an archive. */
const TERMINAL_RETENTION_DAYS = 7;
const DEAD_LETTER_RETENTION_DAYS = 30;

const RETRYABLE_STATUSES = ['RETRY_PENDING', 'MESSAGE_STORE_FAILED', 'IDENTITY_NOT_RESOLVED'];
const RECOVERABLE_STATUSES = [...RETRYABLE_STATUSES, 'QUEUED'];
const TERMINAL_STATUSES = ['PROCESSED', 'SKIPPED', 'DEAD_LETTERED'];

/**
 * Event types that carry a business action and MUST be replayable. The live
 * handler's recovery allowlists (channel-resolution failure, disconnected Page,
 * bound-channel loss) use this same list, so classification, encrypted replay
 * retention, and recovery can never drift apart.
 */
const REPLAYABLE_EVENT_TYPES = ['message', 'optin', 'echo', 'postback', 'referral'];

/** Thrown when the durable receipt itself cannot be written. */
class WebhookReceiptPersistenceError extends Error {
    constructor(cause) {
        super('Failed to persist inbound Meta webhook receipt');
        this.name = 'WebhookReceiptPersistenceError';
        this.code = 'WEBHOOK_RECEIPT_PERSISTENCE_FAILED';
        this.retryable = true;
        this.cause = cause;
    }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const scopedDedupeKey = (pageId, eventId, payloadHash) => (
    sha256(`${String(pageId)}|${eventId || payloadHash}`)
);

/**
 * Classify a raw `entry.messaging[]` element without retaining its content.
 * @returns {{eventType: string, eventId: string|null, senderRef: string|null}}
 */
function classifyEvent(messaging = {}, pageId = null) {
    const senderId = messaging.sender?.id;
    const senderRef = senderId ? sha256(senderId) : null;
    // Only a real inbound message mid is an event identity. postback.mid names
    // the OUTBOUND message containing the tapped button — two different button
    // taps on one message share it — so postbacks (like referrals, which carry
    // no mid at all) dedupe on the payload-hash fallback below. That hash covers
    // the full event body: Page scope comes from the key prefix, sender and
    // event identity (timestamp + payload/ref) from the hashed content.
    const eventId = messaging.message?.mid || null;
    const isOutboundEcho = messaging.message?.is_echo === true
        && (pageId == null || String(senderId) === String(pageId));

    let eventType = 'unknown';
    if (messaging.optin) eventType = 'optin';
    else if (isOutboundEcho) eventType = 'echo';
    else if (messaging.message?.text || (messaging.message?.attachments || []).length > 0) eventType = 'message';
    else if (messaging.postback && typeof messaging.postback === 'object') eventType = 'postback';
    else if (messaging.referral && typeof messaging.referral === 'object') eventType = 'referral';
    else if (messaging.delivery) eventType = 'delivery';
    else if (messaging.read) eventType = 'read';

    return { eventType, eventId, senderRef };
}

/**
 * Persist one receipt. Idempotent on dedupe_key: a redelivered event returns the
 * existing row with `duplicate: true` instead of creating a second one.
 *
 * @throws {WebhookReceiptPersistenceError} when the row cannot be written.
 */
async function recordReceipt({
    pageId,
    objectType = 'page',
    messaging,
    shopId = null,
    metaChannelId = null,
}) {
    const { eventType, eventId, senderRef } = classifyEvent(messaging, pageId);
    const payloadHash = sha256(JSON.stringify(messaging ?? null));
    const dedupeKey = scopedDedupeKey(pageId, eventId, payloadHash);

    // Keep echoes too: an echo can arrive before the original provider request
    // finishes, so it may need a later reconciliation pass to attach Meta's MID
    // to the already-persisted outbound row. Postbacks and referrals carry
    // customer selections and referral attribution — the same durability
    // contract applies before the webhook may be acknowledged.
    const replayable = REPLAYABLE_EVENT_TYPES.includes(eventType);

    // A replayable event cannot be acknowledged without a durable recovery
    // body. Reject before inserting a receipt when encryption is unavailable or
    // key rotation makes the cipher unusable; Meta can safely redeliver it.
    let payloadEncrypted = null;
    if (replayable) {
        try {
            payloadEncrypted = encryptPayload(messaging);
        } catch (cipherErr) {
            logger.error('Webhook replay payload could not be encrypted — provider retry required', {
                pageId: String(pageId),
                errorCode: cipherErr?.message === 'CHANNEL_ENCRYPTION_KEY is not set'
                    ? 'CHANNEL_ENCRYPTION_KEY_MISSING'
                    : 'CIPHER_ERROR',
            });
            opsAlert('Meta webhook — replay payload encryption unavailable', {
                detail: 'Inbound event was rejected before durable acceptance so the provider can retry. '
                    + 'Check CHANNEL_ENCRYPTION_KEY.',
                level: 'error',
                context: { pageId: String(pageId) },
            }).catch(() => {});
            throw new WebhookReceiptPersistenceError(cipherErr);
        }
    }

    try {
        const existing = await MetaWebhookReceipt.findOne({
            where: eventId
                ? { page_id: String(pageId), event_id: eventId }
                : { page_id: String(pageId), dedupe_key: dedupeKey },
        });
        if (existing) {
            recordInboundEventMetric('inbound_events_duplicate');
            return { receipt: existing, duplicate: true };
        }

        const receipt = await MetaWebhookReceipt.create({
            provider: 'meta',
            object_type: objectType,
            page_id: String(pageId),
            shop_id: shopId,
            meta_channel_id: metaChannelId,
            event_id: eventId,
            dedupe_key: dedupeKey,
            event_type: eventType,
            sender_ref: senderRef,
            payload_hash: payloadHash,
            payload_encrypted: payloadEncrypted,
            status: 'RECEIVED',
            received_at: new Date(),
        });
        recordInboundEventMetric('inbound_events_received');
        recordInboundEventMetric('inbound_events_durable_accepted');
        return { receipt, duplicate: false };
    } catch (err) {
        // A concurrent delivery of the same event lost the unique-index race.
        // That is a duplicate, not a persistence failure.
        if (err?.name === 'SequelizeUniqueConstraintError') {
            const existing = await MetaWebhookReceipt.findOne({
                where: eventId
                    ? { page_id: String(pageId), event_id: eventId }
                    : { page_id: String(pageId), dedupe_key: dedupeKey },
            })
                .catch(() => null);
            if (existing) {
                recordInboundEventMetric('inbound_events_duplicate');
                return { receipt: existing, duplicate: true };
            }
        }
        logger.error('Durable webhook receipt write failed — returning retryable error to Meta', {
            pageId: String(pageId),
            eventType,
            errorCode: err?.name || 'UnknownError',
        });
        throw new WebhookReceiptPersistenceError(err);
    }
}

async function safeUpdate(receipt, fields, { expectedQueueJobId } = {}) {
    if (!receipt) return false;
    try {
        const expectedStatus = receipt.status;
        const expectedToken = receipt.processing_token;
        const isEntityInstance = typeof MetaWebhookReceipt === 'function'
            && receipt instanceof MetaWebhookReceipt;
        if (isEntityInstance && receipt.id && typeof MetaWebhookReceipt.update === 'function') {
            const where = {
                    id: receipt.id,
                    status: expectedStatus,
                    processing_token: expectedToken,
            };
            if (expectedQueueJobId !== undefined) {
                where.queue_job_id = String(expectedQueueJobId);
            }
            const [updatedCount] = await MetaWebhookReceipt.update(fields, { where });
            if (updatedCount !== 1) {
                const claimLost = Object.assign(
                    new Error('Webhook receipt update lost its processing fence'),
                    { code: 'WEBHOOK_RECEIPT_CLAIM_LOST', retryable: true },
                );
                logger.warn('Webhook receipt update skipped after claim ownership changed', {
                    receiptId: receipt.id,
                    expectedStatus,
                    requestedStatus: fields.status || null,
                    requestedErrorCode: fields.last_error_code || null,
                });
                return { ok: false, claimLost: true, error: claimLost };
            }
            if (typeof receipt.set === 'function') receipt.set(fields);
            return { ok: true };
        }
        if (typeof receipt.update !== 'function') return { ok: false, error: null };
        await receipt.update(fields);
        return { ok: true };
    } catch (err) {
        logger.error('Failed to update webhook receipt status', {
            receiptId: receipt.id,
            errorCode: err?.name || 'UnknownError',
            errorMessage: err?.message || null,
        });
        return { ok: false, claimLost: false, error: err };
    }
}

async function updateOrThrow(receipt, fields, options = {}) {
    // A missing receipt can only occur in a mocked/incomplete caller; the
    // create path already throws when persistence returns no row.
    if (!receipt) return;
    const result = await safeUpdate(receipt, fields, options);
    if (result === true || result?.ok === true) return;
    // A stale live request must not turn a successful reconciler claim into a
    // 503 or overwrite the newer owner's state. The warning above records the
    // fence loss and the requested failure code for diagnosis.
    if (result?.claimLost) return;
    throw new WebhookReceiptPersistenceError(result?.error || new Error('Failed to update inbound Meta webhook receipt status'));
}

/** Event carries no business action (echo, delivery, read, unrecognised). */
async function markSkipped(receipt, reasonCode) {
    await updateOrThrow(receipt, {
        status: 'SKIPPED',
        last_error_code: reasonCode || null,
        payload_encrypted: null,
        queue_job_id: null,
        processed_at: new Date(),
        next_retry_at: null,
    });
}

async function markProcessing(receipt) {
    await updateOrThrow(receipt, { status: 'PROCESSING' });
}

/** Bind the first resolved tenant/channel without overwriting an older owner. */
async function bindReceiptTenant(receipt, { shopId, metaChannelId } = {}) {
    if (!receipt || !shopId || !metaChannelId) return false;
    const { Op } = require('sequelize');
    const [updatedCount] = await MetaWebhookReceipt.update(
        { shop_id: shopId, meta_channel_id: metaChannelId },
        {
            where: {
                id: receipt.id,
                shop_id: null,
                meta_channel_id: null,
                status: { [Op.in]: ['RECEIVED', 'PROCESSING'] },
            },
        },
    );
    if (updatedCount === 1 && typeof receipt.set === 'function') {
        receipt.set({ shop_id: shopId, meta_channel_id: metaChannelId });
    }
    return updatedCount === 1;
}

/**
 * Claim a live receipt before doing any ingestion work. The conditional update
 * is the live-webhook equivalent of the reconciler's processing fence: two
 * concurrent Meta deliveries may observe the same receipt, but only one owns
 * the transition out of RECEIVED/retryable state.
 */
async function claimProcessing(receipt) {
    if (!receipt) return true;
    const token = crypto.randomBytes(16).toString('hex');
    const { Op } = require('sequelize');
    const claimableStatuses = ['RECEIVED', ...RETRYABLE_STATUSES];
    const [updatedCount] = await MetaWebhookReceipt.update(
        { status: 'PROCESSING', processing_token: token },
        {
            where: {
                id: receipt.id,
                status: { [Op.in]: claimableStatuses },
                processing_token: null,
            },
        },
    );
    if (updatedCount !== 1) return false;
    if (typeof receipt.set === 'function') receipt.set({ status: 'PROCESSING', processing_token: token });
    return true;
}

async function markProcessed(
    receipt,
    { shopId = null, metaChannelId = null } = {},
    { expectedQueueJobId } = {},
) {
    await updateOrThrow(receipt, {
        status: 'PROCESSED',
        shop_id: shopId,
        meta_channel_id: metaChannelId,
        payload_encrypted: null,
        processing_token: null,
        queue_job_id: null,
        last_error_code: null,
        next_retry_at: null,
        processed_at: new Date(),
    }, { expectedQueueJobId });
}

/**
 * Durable queue handoff completed. The replay body and queue identity remain
 * until the worker confirms completion. Redis is transport, not the receipt's
 * durability boundary.
 */
async function markQueued(receipt, {
    shopId = null,
    metaChannelId = null,
    queueJobId = null,
} = {}) {
    await updateOrThrow(receipt, {
        status: 'QUEUED',
        shop_id: shopId,
        meta_channel_id: metaChannelId,
        processing_token: null,
        queue_job_id: queueJobId == null ? null : String(queueJobId),
        last_error_code: null,
        next_retry_at: new Date(Date.now() + QUEUED_RECOVERY_DELAY_MS),
        processed_at: null,
    });
}

/** Defer inspection of a still-live BullMQ job without releasing durability. */
async function deferQueued(receipt) {
    await updateOrThrow(receipt, {
        status: 'QUEUED',
        processing_token: null,
        next_retry_at: new Date(Date.now() + QUEUED_RECOVERY_DELAY_MS),
    });
}

/** Rebind every receipt in a coalesced burst to the replacement BullMQ job. */
async function rebindQueuedReceipts(receiptIds, {
    shopId,
    metaChannelId,
    queueJobId,
    expectedQueueJobId,
} = {}) {
    const ids = [...new Set((Array.isArray(receiptIds) ? receiptIds : []).filter(Boolean).map(String))];
    if (ids.length === 0 || !queueJobId || !shopId || !metaChannelId) {
        throw new Error('QUEUE_RECEIPT_REBIND_INVALID');
    }

    const { Op } = require('sequelize');
    const where = {
        id: { [Op.in]: ids },
        shop_id: shopId,
        meta_channel_id: metaChannelId,
        status: { [Op.in]: ['PROCESSING', 'QUEUED'] },
        payload_encrypted: { [Op.ne]: null },
    };
    if (expectedQueueJobId !== undefined) where.queue_job_id = String(expectedQueueJobId);
    const [updatedCount] = await MetaWebhookReceipt.update(
        {
            status: 'QUEUED',
            shop_id: shopId,
            meta_channel_id: metaChannelId,
            queue_job_id: String(queueJobId),
            processing_token: null,
            last_error_code: null,
            next_retry_at: new Date(Date.now() + QUEUED_RECOVERY_DELAY_MS),
            processed_at: null,
        },
        {
            where,
        },
    );
    // A resident/completed burst job may carry receipt IDs that have already
    // settled. Already-terminal IDs are intentionally ignored; the current
    // receipt is settled separately by markQueued before this best-effort
    // historical rebinding.
    return updatedCount;
}

function nextRetryAt(ladder, retryCount) {
    const minutes = ladder[Math.min(retryCount, ladder.length - 1)];
    return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * The Page is unknown, or its channel is not CONNECTED. The event stays
 * retryable: a legitimate reconnect makes it deliverable without data loss.
 *
 * @param {boolean} [opts.incrementRetry] true when called from the reconciler,
 *   so the backoff ladder actually advances instead of resetting each cycle.
 */
async function markIdentityNotResolved(receipt, { pageId, alert = true, incrementRetry = false } = {}) {
    if (!receipt) return;
    const retryCount = (receipt.retry_count || 0) + (incrementRetry ? 1 : 0);

    if (retryCount >= MAX_IDENTITY_RETRIES) {
        await deadLetter(receipt, 'PAGE_NOT_CONNECTED_EXHAUSTED');
        return;
    }

    await updateOrThrow(receipt, {
        status: 'IDENTITY_NOT_RESOLVED',
        retry_count: retryCount,
        last_error_code: 'PAGE_NOT_CONNECTED',
        processing_token: null,
        queue_job_id: null,
        next_retry_at: nextRetryAt(IDENTITY_RETRY_BACKOFF_MINUTES, retryCount),
    });

    if (alert) {
        // PII-free: page id and counts only, never the sender or message body.
        opsAlert('Meta webhook — Page not connected, inbound message held', {
            detail: `page_id=${pageId || receipt.page_id} receipt=${receipt.id} `
                + `retry=${retryCount}/${MAX_IDENTITY_RETRIES}. The event is durably held and will be `
                + 'retried; reconnect the channel to deliver it.',
            level: 'error',
            context: { pageId: String(pageId || receipt.page_id), receiptId: receipt.id, retryCount },
        }).catch(() => {});
    }
}

/**
 * Message storage failed. Bounded backoff, then dead-letter.
 */
async function markStoreFailure(receipt, err, { pageId } = {}) {
    if (!receipt) return;
    const retryCount = (receipt.retry_count || 0) + 1;
    const errorCode = String(err?.name || 'UnknownError').slice(0, 64);

    if (retryCount > MAX_STORE_RETRIES) {
        await deadLetter(receipt, errorCode);
        return;
    }

    await updateOrThrow(receipt, {
        status: 'RETRY_PENDING',
        retry_count: retryCount,
        last_error_code: errorCode,
        processing_token: null,
        queue_job_id: null,
        next_retry_at: nextRetryAt(STORE_RETRY_BACKOFF_MINUTES, retryCount),
    });

    opsAlert('Meta webhook — inbound message store failed, retry scheduled', {
        detail: `page_id=${pageId || receipt.page_id} receipt=${receipt.id} `
            + `attempt=${retryCount}/${MAX_STORE_RETRIES} code=${errorCode}`,
        level: 'error',
        context: { pageId: String(pageId || receipt.page_id), receiptId: receipt.id, retryCount, errorCode },
    }).catch(() => {});
}

/**
 * Queue/Redis outages are not message-store failures. The message is already
 * durable, so do not consume the finite storage retry ladder or dead-letter it
 * merely because transport is unavailable.
 */
async function markQueueFailure(receipt, err, { pageId } = {}) {
    if (!receipt) return;
    const errorCode = String(err?.name || err?.code || 'MESSAGE_QUEUE_UNAVAILABLE').slice(0, 64);

    await updateOrThrow(receipt, {
        status: 'QUEUED',
        last_error_code: errorCode,
        processing_token: null,
        queue_job_id: null,
        next_retry_at: new Date(Date.now() + QUEUE_RECOVERY_DELAY_MS),
        processed_at: null,
    });

    opsAlert('Meta webhook — queue unavailable, durable receipt held', {
        detail: `page_id=${pageId || receipt.page_id} receipt=${receipt.id} code=${errorCode}. `
            + 'The persisted inbound message will be replayed when Redis/BullMQ recovers.',
        level: 'error',
        context: { pageId: String(pageId || receipt.page_id), receiptId: receipt.id, errorCode },
    }).catch(() => {});
}

/** Terminal failure sink — queryable DLQ surfaced by /health/detailed. */
async function deadLetter(receipt, errorCode, { expectedQueueJobId } = {}) {
    await updateOrThrow(receipt, {
        status: 'DEAD_LETTERED',
        last_error_code: String(errorCode || 'UNKNOWN').slice(0, 64),
        next_retry_at: null,
        processing_token: null,
        queue_job_id: null,
        processed_at: new Date(),
    }, { expectedQueueJobId });
    recordInboundEventMetric('inbound_dead_letter');

    opsAlert('Meta webhook — inbound message DEAD-LETTERED', {
        detail: `page_id=${receipt.page_id} receipt=${receipt.id} code=${errorCode}. `
            + 'A real customer message was never ingested. Manual replay required.',
        level: 'error',
        context: { pageId: receipt.page_id, receiptId: receipt.id, errorCode: String(errorCode || '') },
    }).catch(() => {});
}

/**
 * Claim receipts whose retry is due, fencing each with a processing token so two
 * reconciler runs can never replay the same event concurrently.
 *
 * @returns {Promise<Array<{receipt: object, payload: object|null}>>}
 */
async function claimDueReceipts(limit = 25) {
    const { Op } = require('sequelize');
    const now = new Date();
    const due = await MetaWebhookReceipt.findAll({
        where: {
            [Op.or]: [
                {
                    status: { [Op.in]: RECOVERABLE_STATUSES },
                    next_retry_at: { [Op.lte]: now },
                },
                // Reclaim a claim abandoned by a crashed runner.
                {
                    status: 'PROCESSING',
                    updated_at: { [Op.lt]: new Date(now.getTime() - STALE_CLAIM_MS) },
                },
                // A handler can fail after recording the receipt but before
                // claiming it. Such rows are not covered by the retry ladder;
                // recover them once they have aged past the short orphan window.
                {
                    status: 'RECEIVED',
                    received_at: { [Op.lt]: new Date(now.getTime() - ORPHANED_RECEIVED_MS) },
                },
            ],
        },
        order: [[literal('COALESCE(next_retry_at, updated_at)'), 'ASC']],
        limit,
    });

    const claimed = [];
    for (const receipt of due) {
        const priorStatus = receipt.status;
        if (priorStatus === 'QUEUED'
            && receipt.created_at
            && new Date(receipt.created_at).getTime() < Date.now() - QUEUED_MAX_AGE_MS) {
            await deadLetter(receipt, 'QUEUE_RECOVERY_EXHAUSTED');
            continue;
        }
        const token = crypto.randomBytes(16).toString('hex');
        const [updatedCount] = await MetaWebhookReceipt.update(
            { status: 'PROCESSING', processing_token: token },
            { where: { id: receipt.id, status: receipt.status, processing_token: receipt.processing_token } },
        );
        if (updatedCount !== 1) continue; // lost the race to another runner
        if (typeof receipt.set === 'function') receipt.set({ status: 'PROCESSING', processing_token: token });

        let payload = null;
        if (receipt.payload_encrypted) {
            try {
                payload = decryptPayload(receipt.payload_encrypted);
            } catch (_) {
                await deadLetter(receipt, 'PAYLOAD_UNREADABLE');
                continue;
            }
        }
        if (!payload) {
            await deadLetter(receipt, 'PAYLOAD_MISSING');
            continue;
        }

        claimed.push({ receipt, payload, priorStatus });
    }
    return claimed;
}

/** Count of events that were never ingested. Non-zero = customers lost messages. */
async function countDeadLettered() {
    return MetaWebhookReceipt.count({ where: { status: 'DEAD_LETTERED' } });
}

/** Count of events held because their Page is not connected. */
async function countUnresolved() {
    const { Op } = require('sequelize');
    return MetaWebhookReceipt.count({
        where: { status: { [Op.in]: RECOVERABLE_STATUSES } },
    });
}

async function oldestUnresolvedAt() {
    const oldest = await MetaWebhookReceipt.findOne({
        where: { status: { [Op.in]: RECOVERABLE_STATUSES } },
        attributes: ['received_at'],
        order: [['received_at', 'ASC']],
    });
    return oldest?.received_at || null;
}

/** Retention sweep — receipts are evidence with an expiry, not an archive. */
async function purgeExpiredReceipts(now = new Date()) {
    const { Op } = require('sequelize');
    const terminalCutoff = new Date(now.getTime() - TERMINAL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const deadCutoff = new Date(now.getTime() - DEAD_LETTER_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const removed = await MetaWebhookReceipt.destroy({
        where: {
            [Op.or]: [
                { status: { [Op.in]: ['PROCESSED', 'SKIPPED'] }, created_at: { [Op.lt]: terminalCutoff } },
                // Legacy QUEUED rows predate durable queue identity and have no
                // replay body. New QUEUED rows always retain payload_encrypted.
                { status: 'QUEUED', payload_encrypted: null, created_at: { [Op.lt]: terminalCutoff } },
                { status: 'DEAD_LETTERED', created_at: { [Op.lt]: deadCutoff } },
            ],
        },
    });
    return removed;
}

module.exports = {
    WebhookReceiptPersistenceError,
    classifyEvent,
    recordReceipt,
    markSkipped,
    markProcessing,
    bindReceiptTenant,
    claimProcessing,
    markProcessed,
    markQueued,
    deferQueued,
    rebindQueuedReceipts,
    markIdentityNotResolved,
    markStoreFailure,
    markQueueFailure,
    deadLetter,
    claimDueReceipts,
    countDeadLettered,
    countUnresolved,
    oldestUnresolvedAt,
    purgeExpiredReceipts,
    MAX_STORE_RETRIES,
    MAX_IDENTITY_RETRIES,
    STORE_RETRY_BACKOFF_MINUTES,
    IDENTITY_RETRY_BACKOFF_MINUTES,
    TERMINAL_STATUSES,
    RETRYABLE_STATUSES,
    RECOVERABLE_STATUSES,
    REPLAYABLE_EVENT_TYPES,
    QUEUED_RECOVERY_DELAY_MS,
    QUEUE_RECOVERY_DELAY_MS,
    QUEUED_MAX_AGE_MS,
};
