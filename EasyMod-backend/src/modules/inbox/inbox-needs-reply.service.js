'use strict';

/**
 * Phase 1 — C1 (doc 05 §1 / mission D2/D3): bounded "needs merchant reply" scan.
 *
 * ONE predicate, THREE consumers: the Inbox nav badge, the dashboard queue
 * `needs_reply` chip and the Inbox "needs review" tab all route through this
 * service, so a shop can never see three different numbers. The verdict comes
 * from the AUTHORITATIVE `deriveWorkflowProjection` in
 * conversation.service.js (exposed through one additive module export) — this
 * file never re-derives it.
 *
 * Honesty contract (guardrails §16/§21.1):
 *  - the scan is bounded to the CAP most-recently-updated open conversations;
 *  - `coverageComplete` is true only when the bounded scan saw EVERY open
 *    conversation (`scanned < cap && scanned === openTotal`);
 *  - any read failure REJECTS — the route answers 5xx and the client maps the
 *    rejection to `null` (never 0, never a hidden-with-zero badge).
 *
 * Tenant scoping is the FIRST predicate on every query; shopId comes from the
 * verified JWT only, so a cross-tenant read is impossible by construction.
 */

const NEEDS_REPLY_SCAN_CAP = 200;
const CLOSED_STATUSES = Object.freeze(['closed', 'archived']);

/**
 * Mirrors the batched message attribute set conversation.service's
 * getConversations scan uses (projection inputs ONLY — never message
 * content, never customer fields).
 */
const MESSAGE_SCAN_ATTRIBUTES = Object.freeze([
    'id',
    'conversation_id',
    'sender',
    'created_at',
    'delivery_state',
    'delivery_source',
    'provider_message_id',
    'metadata',
]);

const CONVERSATION_SCAN_ATTRIBUTES = Object.freeze([
    'id',
    'status',
    'hitl',
    'metadata',
    'updated_at',
    'meta_channel_id',
]);

/**
 * Bounded needs-reply scan for one shop.
 *
 * Dependencies (Conversation, Message, deriveWorkflowProjection, aiReplyMode)
 * are injectable for unit tests; in production they resolve lazily from
 * their authoritative modules, exactly the way the Inbox list path reads
 * them (getConversations derives aiReplyMode from the shop AI settings and
 * fails closed to MANUAL — getEffectiveAiReplyMode is that same contract).
 */
async function getNeedsReplyCount({
    shopId,
    now = new Date(),
    Conversation,
    Message,
    deriveWorkflowProjection,
    aiReplyMode,
} = {}) {
    if (!shopId) {
        throw new Error('inbox-needs-reply: shopId is required (tenant scope)');
    }

    const { Op } = require('sequelize');

    if (!Conversation || !Message) {
        const entities = require('../entities');
        Conversation = Conversation || entities.Conversation;
        Message = Message || entities.Message;
    }

    if (typeof deriveWorkflowProjection !== 'function') {
        deriveWorkflowProjection = require('../conversation/conversation.service')
            .deriveWorkflowProjection;
        if (typeof deriveWorkflowProjection !== 'function') {
            throw new Error('inbox-needs-reply: workflow projection is unavailable');
        }
    }

    if (aiReplyMode === undefined) {
        const { getEffectiveAiReplyMode } = require('../shop/ai-reply-mode');
        aiReplyMode = await getEffectiveAiReplyMode(shopId);
    }

    // Open = not closed and not archived — the same terminal statuses the
    // projection itself treats as closed (deriveWorkflowProjection line 391).
    const openWhere = {
        shop_id: shopId,
        status: { [Op.notIn]: [...CLOSED_STATUSES] },
    };

    const [conversations, openTotal] = await Promise.all([
        Conversation.findAll({
            where: openWhere,
            attributes: CONVERSATION_SCAN_ATTRIBUTES,
            order: [['updated_at', 'DESC']],
            limit: NEEDS_REPLY_SCAN_CAP,
        }),
        Conversation.count({ where: openWhere }),
    ]);

    const rows = Array.isArray(conversations) ? conversations : [];
    const scanned = rows.length;

    // ONE batched message read for the whole scanned set (no N+1).
    const messagesByConversation = new Map();
    const conversationIds = rows.map((row) => row?.id).filter(Boolean);
    if (conversationIds.length > 0 && typeof Message.findAll === 'function') {
        const candidates = await Message.findAll({
            where: {
                conversation_id: { [Op.in]: conversationIds },
            },
            attributes: MESSAGE_SCAN_ATTRIBUTES,
        }) || [];
        for (const candidate of candidates) {
            const bucket = messagesByConversation.get(candidate?.conversation_id);
            if (bucket) bucket.push(candidate);
            else messagesByConversation.set(candidate.conversation_id, [candidate]);
        }
    }

    let count = 0;
    for (const conversation of rows) {
        const projection = deriveWorkflowProjection(
            conversation,
            messagesByConversation.get(conversation?.id) || [],
            aiReplyMode,
        );
        if (projection?.needs_merchant_reply === true) count += 1;
    }

    return {
        count,
        scanned,
        cap: NEEDS_REPLY_SCAN_CAP,
        coverageComplete: scanned < NEEDS_REPLY_SCAN_CAP && scanned === openTotal,
        generated_at: new Date(now).toISOString(),
    };
}

module.exports = {
    getNeedsReplyCount,
    NEEDS_REPLY_SCAN_CAP,
    CLOSED_STATUSES,
    MESSAGE_SCAN_ATTRIBUTES,
    CONVERSATION_SCAN_ATTRIBUTES,
};
