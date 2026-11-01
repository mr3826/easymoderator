'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { Message, InboxDeliveryOutbox } = require('../modules/entities');
const { isProviderConfirmed } = require('../modules/conversation/message-lifecycle');
const { createLogger } = require('../utils/structured-logger');
const { opsAlert } = require('../utils/ops-alert');

const logger = createLogger('InboxDeliveryReconciler');
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
const BATCH_SIZE = Number(process.env.INBOX_DELIVERY_RECONCILE_BATCH) > 0
    ? Number(process.env.INBOX_DELIVERY_RECONCILE_BATCH)
    : 25;
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const STALE_PROVIDER_CLAIM_MS = 15 * 60 * 1000;

async function recordAcceptedAiReplyShadow(shopId, message) {
    const { recordAcceptedAiReply } = require('../modules/subscription/ai-reply-shadow-ledger.service');
    const result = await recordAcceptedAiReply({
        shopId,
        message,
        acceptedAt: metadataFor(message).provider_accepted_at,
    });
    return !['gate_unavailable', 'subscription_unavailable'].includes(result.reason);
}

const metadataFor = (message) => {
    if (typeof message?.metadata === 'string') {
        try {
            const parsed = JSON.parse(message.metadata);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    return message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
};

async function updateOutbox(row, token, fields) {
    const result = await InboxDeliveryOutbox.update(fields, {
        where: { id: row.id, processing_token: token },
    });
    return (Array.isArray(result) ? result[0] : 1) === 1;
}

class InboxDeliveryReconcilerJob {
    async execute({ dryRun = false } = {}) {
        const results = { claimed: 0, completed: 0, retried: 0, reconciliations: 0, failed: 0, dryRun };
        if (!InboxDeliveryOutbox || typeof InboxDeliveryOutbox.findAll !== 'function') return results;

        const now = new Date();
        const due = await InboxDeliveryOutbox.findAll({
            where: {
                delivery_source: 'DRAFT_APPROVAL',
                [Op.or]: [
                    { status: 'PENDING', next_attempt_at: { [Op.lte]: now } },
                    {
                        status: 'PROCESSING',
                        updated_at: { [Op.lt]: new Date(now.getTime() - STALE_PROCESSING_MS) },
                    },
                    {
                        status: 'NEEDS_RECONCILIATION',
                        provider_message_id: { [Op.ne]: null },
                    },
                ],
            },
            order: [['next_attempt_at', 'ASC']],
            limit: BATCH_SIZE,
        });
        if (dryRun) {
            results.claimed = due.length;
            return results;
        }

        for (const row of due) {
            const token = crypto.randomBytes(16).toString('hex');
            const claimed = await InboxDeliveryOutbox.update({
                status: 'PROCESSING',
                processing_token: token,
            }, {
                where: {
                    id: row.id,
                    status: row.status,
                    processing_token: row.processing_token || null,
                },
            });
            if ((Array.isArray(claimed) ? claimed[0] : 1) !== 1) continue;
            results.claimed += 1;

            try {
                const message = await Message.findOne({
                    where: {
                        id: row.message_id,
                        conversation_id: row.conversation_id,
                        sender: 'ai',
                    },
                });
                if (!message) {
                    await updateOutbox(row, token, {
                        status: 'NEEDS_RECONCILIATION',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: 'DRAFT_MESSAGE_MISSING',
                    });
                    results.reconciliations += 1;
                    continue;
                }

                if (isProviderConfirmed(message)) {
                    const meterCanProceed = await recordAcceptedAiReplyShadow(row.shop_id, message);
                    if (!meterCanProceed) {
                        await updateOutbox(row, token, {
                            status: 'PENDING',
                            processing_token: null,
                            next_attempt_at: new Date(Date.now() + RETRY_BACKOFF_MS[0]),
                            last_error_code: 'AI_REPLY_SHADOW_GATE_UNAVAILABLE',
                        });
                        results.retried += 1;
                        continue;
                    }
                    await updateOutbox(row, token, {
                        status: 'COMPLETED',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: null,
                    });
                    results.completed += 1;
                    continue;
                }

                const currentMetadata = metadataFor(message);
                if (['human_active', 'conversation_closed'].includes(currentMetadata.held_reason)
                    || currentMetadata.suggestion_visibility === 'HIDDEN_DISMISSED') {
                    await updateOutbox(row, token, {
                        status: 'COMPLETED',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: currentMetadata.held_reason === 'conversation_closed'
                            ? 'CONVERSATION_CLOSED'
                            : 'HUMAN_TAKEOVER',
                    });
                    results.reconciliations += 1;
                    continue;
                }

                if (row.provider_message_id) {
                    const metadata = metadataFor(message);
                    const acceptedAt = metadata.provider_accepted_at
                        || (row.updated_at ? new Date(row.updated_at).toISOString() : null);
                    const reconciledMetadata = {
                        ...metadata,
                        delivered: true,
                        delivery_status: 'sent',
                        delivery_state: 'SENT',
                        provider_message_id: row.provider_message_id,
                        provider_send_confirmed: true,
                        outbox_reconciled: true,
                        ...(acceptedAt ? { provider_accepted_at: acceptedAt } : {}),
                    };
                    const reconciled = await Message.update({
                        external_id: row.provider_message_id,
                        metadata: reconciledMetadata,
                        delivery_state: 'SENT',
                        provider_message_id: row.provider_message_id,
                    }, {
                        where: {
                            id: row.message_id,
                            conversation_id: row.conversation_id,
                            sender: 'ai',
                            delivery_state: { [Op.in]: ['SEND_PENDING', 'FAILED'] },
                            provider_message_id: null,
                        },
                    });
                    if ((Array.isArray(reconciled) ? reconciled[0] : 1) === 1) {
                        const messageData = typeof message.get === 'function'
                            ? message.get({ plain: true })
                            : message;
                        const meterCanProceed = await recordAcceptedAiReplyShadow(row.shop_id, {
                            ...messageData,
                            delivery_source: row.delivery_source,
                            delivery_state: 'SENT',
                            provider_message_id: row.provider_message_id,
                            metadata: reconciledMetadata,
                        });
                        if (!meterCanProceed) {
                            await updateOutbox(row, token, {
                                status: 'PENDING',
                                processing_token: null,
                                next_attempt_at: new Date(Date.now() + RETRY_BACKOFF_MS[0]),
                                last_error_code: 'AI_REPLY_SHADOW_GATE_UNAVAILABLE',
                            });
                            results.retried += 1;
                            continue;
                        }
                        await updateOutbox(row, token, {
                            status: 'COMPLETED',
                            processing_token: null,
                            next_attempt_at: null,
                            last_error_code: null,
                        });
                        results.reconciliations += 1;
                        continue;
                    }
                }

                const metadata = currentMetadata;
                if (metadata.provider_send_attempted === true) {
                    await updateOutbox(row, token, {
                        status: 'NEEDS_RECONCILIATION',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: 'PROVIDER_OUTCOME_UNKNOWN',
                    });
                    results.reconciliations += 1;
                    continue;
                }

                if (metadata.provider_send_claimed === true) {
                    const claimedAt = metadata.provider_send_claimed_at
                        ? new Date(metadata.provider_send_claimed_at).getTime()
                        : NaN;
                    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < STALE_PROVIDER_CLAIM_MS) {
                        await updateOutbox(row, token, {
                            status: 'PENDING',
                            processing_token: null,
                            next_attempt_at: new Date(Date.now() + 60_000),
                            last_error_code: 'DRAFT_PROVIDER_CLAIM_IN_PROGRESS',
                        });
                        results.retried += 1;
                        continue;
                    }
                    const resetResult = await Message.update({
                        metadata: {
                            ...metadata,
                            provider_send_claimed: false,
                            provider_send_claim_token: null,
                            provider_send_claimed_at: null,
                        },
                    }, {
                        where: {
                            id: row.message_id,
                            conversation_id: row.conversation_id,
                            sender: 'ai',
                            delivery_state: 'SEND_PENDING',
                            provider_message_id: null,
                        },
                    });
                    if ((Array.isArray(resetResult) ? resetResult[0] : 1) !== 1) {
                        await updateOutbox(row, token, {
                            status: 'NEEDS_RECONCILIATION',
                            processing_token: null,
                            next_attempt_at: null,
                            last_error_code: 'PROVIDER_CLAIM_RESET_FAILED',
                        });
                        results.reconciliations += 1;
                        continue;
                    }
                }

                const controller = require('../modules/conversation/conversation.controller');
                const delivery = await controller._deliverViaMetaIfApplicable(
                    row.conversation_id,
                    row.shop_id,
                    message,
                    'agent',
                    {
                        failureState: 'HELD',
                        failureSuggestionVisibility: 'VISIBLE_HITL_REVIEW',
                    },
                );
                const refreshed = typeof Message.findOne === 'function'
                    ? await Message.findOne({
                        where: { id: row.message_id, conversation_id: row.conversation_id, sender: 'ai' },
                    })
                    : message;
                if (delivery?.sent === true || isProviderConfirmed(refreshed)) {
                    const meterCanProceed = await recordAcceptedAiReplyShadow(row.shop_id, refreshed || message);
                    if (!meterCanProceed) {
                        await updateOutbox(row, token, {
                            status: 'PENDING',
                            processing_token: null,
                            next_attempt_at: new Date(Date.now() + RETRY_BACKOFF_MS[0]),
                            last_error_code: 'AI_REPLY_SHADOW_GATE_UNAVAILABLE',
                        });
                        results.retried += 1;
                        continue;
                    }
                    await updateOutbox(row, token, {
                        status: 'COMPLETED',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: null,
                    });
                    results.completed += 1;
                    continue;
                }

                const refreshedMetadata = metadataFor(refreshed || message);
                const attempted = refreshedMetadata.provider_send_attempted === true
                    || refreshedMetadata.provider_send_claimed === true;
                const attemptCount = Number(row.attempt_count || 0) + 1;
                if (attempted || attemptCount >= MAX_ATTEMPTS) {
                    await updateOutbox(row, token, {
                        status: 'NEEDS_RECONCILIATION',
                        processing_token: null,
                        next_attempt_at: null,
                        last_error_code: attempted ? 'PROVIDER_OUTCOME_UNKNOWN' : 'DRAFT_DELIVERY_RETRY_EXHAUSTED',
                        attempt_count: attemptCount,
                    });
                    results.reconciliations += 1;
                    continue;
                }

                await updateOutbox(row, token, {
                    status: 'PENDING',
                    processing_token: null,
                    attempt_count: attemptCount,
                    next_attempt_at: new Date(Date.now() + RETRY_BACKOFF_MS[attemptCount - 1]),
                    last_error_code: 'DRAFT_DELIVERY_NOT_CONFIRMED',
                });
                results.retried += 1;
            } catch (error) {
                const attemptCount = Number(row.attempt_count || 0) + 1;
                const terminal = attemptCount >= MAX_ATTEMPTS;
                await updateOutbox(row, token, {
                    status: terminal ? 'NEEDS_RECONCILIATION' : 'PENDING',
                    processing_token: null,
                    attempt_count: attemptCount,
                    next_attempt_at: terminal ? null : new Date(Date.now() + RETRY_BACKOFF_MS[attemptCount - 1]),
                    last_error_code: terminal ? 'DRAFT_DELIVERY_RETRY_EXHAUSTED' : 'DRAFT_DELIVERY_RECONCILE_FAILED',
                }).catch(() => {});
                if (terminal) {
                    results.reconciliations += 1;
                    opsAlert('Inbox draft delivery requires reconciliation', {
                        detail: `shop=${row.shop_id} conversation=${row.conversation_id} message=${row.message_id}`,
                        level: 'error',
                        context: { shopId: row.shop_id, conversationId: row.conversation_id, messageId: row.message_id },
                    }).catch(() => {});
                } else {
                    results.failed += 1;
                }
                logger.warn('Inbox draft delivery reconciliation failed', {
                    shopId: row.shop_id,
                    conversationId: row.conversation_id,
                    messageId: row.message_id,
                    errorCode: error.code || error.name || 'UNKNOWN',
                });
            }
        }
        return results;
    }
}

module.exports = InboxDeliveryReconcilerJob;
