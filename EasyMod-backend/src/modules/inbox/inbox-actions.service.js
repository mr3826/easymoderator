'use strict';

/**
 * P+03 Merchant Action Queue — a READ MODEL, not a store.
 *
 * Every item is computed per request from the authoritative rows (HITL
 * conversations, delivery/outbox failures, suspended or waiting checkouts,
 * reviewable suggestions, live opportunities, knowledge suggestions). There
 * is deliberately no task table: an action cannot be "stale pending" because
 * it IS the current state of its source fact, and resolution (which happens
 * through the source's own audited endpoint) removes it immediately — this is
 * the durable/idempotent/reopen-safe guarantee spec §9.3 asks for.
 *
 * Fail-closed per bucket: a failing source marks `partial` and simply
 * contributes no items; the queue never fabricates work and never blocks the
 * inbox.
 */

const { Op } = require('sequelize');
const {
    ACTION_BUCKETS, ACTION_REASONS, RECONCILIATION_DELIVERY_STATES,
    RECOVERY_DELIVERY_STATES, OUTBOX_RECONCILIATION_STATUS, NEXT_ACTION, compareItems,
} = require('./action-reasons');

const entities = () => require('../entities');
const CONVERSATION_SCAN_CAP = 200;
const QUEUE_CAP = 50;

async function getInboxActions(shopId, { now = Date.now(), view = 'attention', actorUserId = null } = {}) {
    if (!shopId) return { items: [], generated_at: new Date(now).toISOString(), partial: true, counts: { by_bucket: {}, views: {}, total: 0, returned: 0 } };
    const E = entities();
    let partial = false;
    const items = [];

    const shopConversations = await Promise.resolve(
        E.Conversation.findAll({
            where: { shop_id: shopId },
            attributes: ['id', 'customer_id', 'hitl', 'assignee_id', 'status', 'updated_at', 'metadata'],
            order: [['updated_at', 'DESC']],
            limit: CONVERSATION_SCAN_CAP,
        }),
    ).catch(() => { partial = true; return []; });

    const convIds = shopConversations.map((c) => c.id);
    const convMeta = new Map(shopConversations.map((c) => [String(c.id), c]));

    // Bucket 1 — customer explicitly needs a human (HITL open, incl. P+04
    // handoffs that paused a checkout).
    for (const c of shopConversations) {
        if (c.hitl === true && c.status === 'active') {
            const meta = c.metadata || {};
            // A merchant takeover reason (manual_handoff_reason) is NOT a
            // suspended-checkout system handoff; classifying it as one
            // mislabels the cause in the queue (ADR-0013 §8).
            const manualReason = meta.manual_handoff_reason || null;
            const suspended = manualReason ? null : (meta.handoff_reason || null);
            items.push({
                bucket: ACTION_BUCKETS.NEEDS_HUMAN,
                item_key: `hitl:${c.id}`,
                reason_code: suspended
                    ? ACTION_REASONS.HANDOFF_SUSPENDED_CHECKOUT
                    : ACTION_REASONS.HITL_REQUIRED,
                source: { type: 'conversation', id: c.id },
                conversation_id: c.id,
                customer_id: c.customer_id || null,
                status: 'awaiting_human',
                owner: c.assignee_id || null,
                // Explicit source so the UI can render a merchant reason label
                // (literal display map) without guessing from the code.
                handoff_source: manualReason ? 'manual' : (suspended ? 'system' : null),
                manual_handoff_reason: manualReason,
                next_action: { type: NEXT_ACTION.OPEN_CONVERSATION },
                since: c.updated_at,
            });
        }
    }

    // Bucket 2 — a committed business action whose customer acknowledgment
    // failed / awaits reconciliation (FAILED sends w/ executed-mutation meta,
    // plus outbox rows needing reconciliation).
    if (convIds.length) {
        const failedSends = await Promise.resolve(E.Message.findAll({
            where: {
                conversation_id: { [Op.in]: convIds },
                sender: 'ai',
                delivery_state: { [Op.in]: RECONCILIATION_DELIVERY_STATES },
            },
            attributes: ['id', 'conversation_id', 'metadata', 'created_at', 'delivery_state'],
            order: [['created_at', 'DESC']],
            limit: QUEUE_CAP,
        })).catch(() => { partial = true; return []; });
        for (const m of failedSends) {
            const meta = m.metadata || {};
            if (meta.executed_mutation_without_outbound_send) {
                items.push({
                    bucket: ACTION_BUCKETS.COMMITTED_WITHOUT_ACK,
                    item_key: `send:${m.id}`,
                    reason_code: ACTION_REASONS.SEND_FAILED_AFTER_MUTATION,
                    source: { type: 'message', id: m.id },
                    conversation_id: m.conversation_id,
                    customer_id: convMeta.get(String(m.conversation_id))?.customer_id || null,
                    status: 'needs_reconciliation',
                    owner: null,
                    next_action: { type: NEXT_ACTION.RECONCILE_SEND },
                    since: m.created_at,
                });
            }
        }
    }
    const outboxRows = await Promise.resolve(E.InboxDeliveryOutbox.findAll({
        where: { shop_id: shopId, status: OUTBOX_RECONCILIATION_STATUS },
        attributes: ['id', 'conversation_id', 'message_id', 'updated_at'],
        limit: QUEUE_CAP,
    })).catch(() => { partial = true; return []; });
    for (const o of outboxRows) {
        items.push({
            bucket: ACTION_BUCKETS.COMMITTED_WITHOUT_ACK,
            item_key: `outbox:${o.id}`,
            reason_code: ACTION_REASONS.SEND_NEEDS_RECONCILIATION,
            source: { type: 'delivery_outbox', id: o.id },
            conversation_id: o.conversation_id,
            customer_id: convMeta.get(String(o.conversation_id))?.customer_id || null,
            status: 'needs_reconciliation',
            owner: null,
            next_action: { type: NEXT_ACTION.RECONCILE_SEND },
            since: o.updated_at || o.created_at || new Date(),
        });
    }

    // Bucket 3 — customer blocked in an active workflow (suspended checkout or
    // an informational-deferral older than 15 minutes).
    const OrderSession = require('../order/order-session.entity');
    const blockedSessions = await Promise.resolve(OrderSession.findAll({
        where: {
            shop_id: shopId,
            status: { [Op.in]: ['ACTIVE', 'SUSPENDED'] },
            [Op.or]: [
                { expires_at: { [Op.gt]: new Date(now) } },
                { expires_at: { [Op.is]: null } },
            ],
        },
        limit: CONVERSATION_SCAN_CAP,
    })).catch(() => { partial = true; return []; });
    const WAIT_MS = 15 * 60 * 1000;
    for (const s of blockedSessions) {
        const stepData = s.step_data || {};
        const suspended = s.status === 'SUSPENDED';
        const deferredStep = stepData.awaiting_resume || null;
        const lastActivity = s.last_activity_at ? new Date(s.last_activity_at).getTime() : now;
        if (!suspended && !(deferredStep && now - lastActivity > WAIT_MS)) continue;
        items.push({
            bucket: ACTION_BUCKETS.CUSTOMER_BLOCKED,
            item_key: `session:${s.id}`,
            reason_code: ACTION_REASONS.CHECKOUT_WAITING_CUSTOMER,
            source: { type: 'order_session', id: s.id },
            conversation_id: s.conversation_id || null,
            customer_id: s.customer_id || null,
            status: suspended ? 'suspended' : 'waiting_customer',
            owner: null,
            next_action: { type: NEXT_ACTION.RESUME_CHECKOUT, step: suspended ? s.current_step : deferredStep },
            grounded_deadline: s.expires_at || null,
            since: s.last_activity_at || new Date(),
        });
    }

    // Bucket 4 — drafts/held messages awaiting review or recovery.
    if (convIds.length) {
        const recoverable = await Promise.resolve(E.Message.findAll({
            where: {
                conversation_id: { [Op.in]: convIds },
                sender: 'ai',
                delivery_state: { [Op.in]: RECOVERY_DELIVERY_STATES },
            },
            attributes: ['id', 'conversation_id', 'metadata', 'created_at', 'delivery_state'],
            order: [['created_at', 'DESC']],
            limit: QUEUE_CAP,
        })).catch(() => { partial = true; return []; });
        for (const m of recoverable) {
            if (m.metadata?.executed_mutation_without_outbound_send) continue; // bucket 2 wins
            const held = m.delivery_state === 'HELD';
            items.push({
                bucket: ACTION_BUCKETS.DRAFT_RECOVERY,
                item_key: `draft:${m.id}`,
                reason_code: held ? ACTION_REASONS.HELD_MESSAGE : ACTION_REASONS.DRAFT_AWAITING_REVIEW,
                source: { type: 'message', id: m.id },
                conversation_id: m.conversation_id,
                customer_id: convMeta.get(String(m.conversation_id))?.customer_id || null,
                status: m.delivery_state,
                owner: null,
                next_action: { type: NEXT_ACTION.REVIEW_DRAFT },
                since: m.created_at,
            });
        }
    }

    // Bucket 5 — qualified purchase opportunities needing merchant review
    // (customer-intelligence flag gated; the SAME rows the Customers page
    // shows — ids only, one source of truth).
    try {
        const pilot = require('../pilot-features/pilot-features.service');
        if (await pilot.isCustomerIntelligenceEnabled(shopId)) {
            const openOpps = await E.CustomerOpportunity.findAll({
                where: { shop_id: shopId, status: 'OPEN' },
                attributes: ['id', 'conversation_id', 'customer_id', 'strength', 'last_signal_at'],
                order: [['last_signal_at', 'ASC']],
                limit: QUEUE_CAP,
            });
            for (const o of openOpps) {
                items.push({
                    bucket: ACTION_BUCKETS.PURCHASE_OPPORTUNITY,
                    item_key: `opportunity:${o.id}`,
                    reason_code: ACTION_REASONS.OPPORTUNITY_OPEN,
                    source: { type: 'customer_opportunity', id: o.id },
                    conversation_id: o.conversation_id || null,
                    customer_id: o.customer_id,
                    status: o.status,
                    owner: null,
                    next_action: { type: NEXT_ACTION.REVIEW_OPPORTUNITY, strength: o.strength },
                    since: o.last_signal_at,
                });
            }
        }
    } catch (_) { /* flag/pilot infra off or failing: bucket simply absent */ }

    // Bucket 6 — knowledge gaps awaiting merchant approval (P+05 module;
    // absent until its table + flag exist — no fabricated work).
    try {
        const pilot = require('../pilot-features/pilot-features.service');
        if (await pilot.isKnowledgeSuggestionsEnabled(shopId)) {
            const { knowledgeGapSuggestions } = require('../knowledge/gap-suggestions.service');
            const gaps = await knowledgeGapSuggestions.listOpen(shopId, { limit: QUEUE_CAP });
            for (const g of gaps) {
                items.push({
                    bucket: ACTION_BUCKETS.KNOWLEDGE_GAP,
                    item_key: `gap_suggestion:${g.id}`,
                    reason_code: ACTION_REASONS.KNOWLEDGE_GAP_OPEN,
                    source: { type: 'knowledge_gap_suggestion', id: g.id },
                    conversation_id: null,
                    customer_id: null,
                    status: g.status,
                    owner: null,
                    next_action: { type: NEXT_ACTION.REVIEW_KNOWLEDGE_GAP, owner_domain: g.owner_domain },
                    since: g.last_seen_at,
                });
            }
        }
    } catch (_) { /* P+05 not installed yet or failing: bucket absent */ }

    items.sort(compareItems);

    // MW-V1 Phase 6: built-in work views over the SAME recomputed read model
    // (no saved-view engine, no task store). Counts come from the server-side
    // full collection — never from the loaded page. 'mine' compares the
    // authoritative owner id; unknown views fall back to 'attention'.
    const VIEWS = {
        attention: () => true,
        mine: (i) => Boolean(i.owner) && String(i.owner) === String(actorUserId),
        unassigned: (i) => i.bucket === ACTION_BUCKETS.NEEDS_HUMAN && !i.owner,
        handoff: (i) => i.bucket === ACTION_BUCKETS.NEEDS_HUMAN,
        recovery: (i) => i.bucket === ACTION_BUCKETS.COMMITTED_WITHOUT_ACK,
        opportunities: (i) => i.bucket === ACTION_BUCKETS.PURCHASE_OPPORTUNITY,
        review: (i) => i.bucket === ACTION_BUCKETS.DRAFT_RECOVERY || i.bucket === ACTION_BUCKETS.KNOWLEDGE_GAP,
    };
    const viewFn = Object.prototype.hasOwnProperty.call(VIEWS, view) ? VIEWS[view] : VIEWS.attention;
    const byBucket = {};
    for (const item of items) byBucket[item.bucket] = (byBucket[item.bucket] || 0) + 1;
    const viewCounts = {};
    for (const [name, fn] of Object.entries(VIEWS)) viewCounts[name] = items.filter(fn).length;
    const selected = items.filter(viewFn);

    return {
        items: selected.slice(0, QUEUE_CAP).map((item) => ({
            ...item,
            since: item.since ? new Date(item.since).toISOString() : null,
            grounded_deadline: item.grounded_deadline
                ? new Date(item.grounded_deadline).toISOString() : null,
        })),
        generated_at: new Date(now).toISOString(),
        partial,
        counts: {
            by_bucket: byBucket,
            views: viewCounts,
            total: items.length,
            returned: Math.min(selected.length, QUEUE_CAP),
        },
    };
}

module.exports = { getInboxActions };
