'use strict';

/**
 * ADR M-008 — `GET /api/mobile/attention` collectors.
 *
 * Implements MOBILE_PRODUCT_SPEC.md §2.1's tier/urgency-score table exactly,
 * composed entirely from existing services (no new scoring model, no AI
 * ranking, no new tables). See docs/mobile/adr/M-008-attention-and-today.md
 * "Phase 2 amendments" for the D1-D6 decisions this file implements.
 *
 * | Tier | Signal                                                | Urgency score |
 * |------|--------------------------------------------------------|---------------|
 * | 1    | Courier dispatch FAILED or INDETERMINATE                | hours since the dispatch attempt |
 * | 1    | Courier setup required, blocking a ready-to-ship order  | hours since the order became ready to ship |
 * | 2    | Inbox needs_merchant_reply or hitl handoff               | hours since the customer's last inbound message |
 * | 3    | Draft order awaiting confirmation                        | order.total (BDT) x hours since creation |
 * | 4    | RTO-risk customer awaiting verification on a pending order | hours since the order entered a verification-required state |
 * | 5    | Product below low_stock_threshold                        | 1 - (quantity / threshold) |
 */

const { Op, col, fn, where: sequelizeWhere } = require('sequelize');
const { Order, Product, CourierDispatch, Message } = require('../entities');
const conversationService = require('../conversation/conversation.service');
const courierReadinessService = require('../delivery/courier-readiness.service');
const RtoShieldService = require('../rto-shield/rto-shield.service');
const { getNetworkSettings } = require('../rto-shield/rto-network-settings');
const { hoursSince, readTimestamp } = require('./mobile-day-window.util');

// D6: getConversations has no server-side "needs reply / open" filter, so
// the candidate scan is bounded to the most recent N conversations (any
// status) rather than run unbounded over the whole shop.
const CONVERSATION_SCAN_LIMIT = 200;

// The order module has three overlapping vocabularies: the state-machine
// declaration, the validator, and statuses written by live flows. Home must
// use only the two non-terminal statuses that are both actionable and
// supported by current code. In particular, do not treat legacy declared
// states (placed/paid/fulfilled) or unknown values as committed orders.
const COMMITTED_ORDER_STATUSES = Object.freeze(['confirmed', 'processing']);
const RTO_PENDING_ORDER_STATUSES = Object.freeze(['draft', ...COMMITTED_ORDER_STATUSES]);
const TERMINAL_ORDER_STATUSES = Object.freeze([
    'delivered',
    'completed',
    'finalized',
    'cancelled',
    'refunded',
    'fulfilled',
]);
const ACTIVE_FULFILLMENT_STATUSES = Object.freeze(['unfulfilled', 'partially_fulfilled']);

// Retain the old exported names for callers that imported the Phase 2
// constants, but use positive status allowlists in every collector below.
const READY_TO_SHIP_EXCLUDED_STATUSES = Object.freeze(['draft', ...TERMINAL_ORDER_STATUSES]);
const RTO_PENDING_EXCLUDED_STATUSES = TERMINAL_ORDER_STATUSES;

/**
 * Build the common order predicate used by active Home collectors. The
 * delivered_at and fulfillment checks cover rows whose order_status was not
 * updated atomically with the delivery webhook; refunded payment rows are not
 * merchant-actionable even if their order status is stale.
 */
const activeOrderWhere = (statuses) => ({
    order_status: { [Op.in]: statuses },
    fulfillment_status: { [Op.in]: ACTIVE_FULFILLMENT_STATUSES },
    [Op.or]: [
        { payment_status: { [Op.ne]: 'refunded' } },
        { payment_status: null },
    ],
    delivered_at: null,
});

const roundScore = (value) => Math.round(value * 100) / 100;

/**
 * Tier 1a — courier_dispatch rows the shop needs to act on. D2: courier
 * problems are read from courier_dispatch.status (the ['shop_id','status']
 * index already exists for this), never from orders.delivery_status, which
 * is a best-effort, order-side marker written inside try{}catch(_){} and can
 * drift from the real dispatch state.
 */
async function collectCourierFailures(shopId, now) {
    const dispatches = await CourierDispatch.findAll({
        where: { shop_id: shopId, status: { [Op.in]: ['FAILED', 'INDETERMINATE'] } },
        order: [['created_at', 'ASC']],
    });
    if (!dispatches.length) return [];

    const orderIds = [...new Set(dispatches.map((dispatch) => dispatch.order_id))];
    const orders = await Order.findAll({
        where: {
            shop_id: shopId,
            id: { [Op.in]: orderIds },
            ...activeOrderWhere(COMMITTED_ORDER_STATUSES),
        },
        attributes: ['id', 'order_number', 'order_status', 'fulfillment_status', 'payment_status', 'delivered_at'],
    });
    const orderById = new Map(orders.map((order) => [order.id, order]));

    return dispatches.filter((dispatch) => orderById.has(dispatch.order_id)).map((dispatch) => {
        const order = orderById.get(dispatch.order_id);
        const label = order?.order_number || dispatch.order_id;
        const isFailed = dispatch.status === 'FAILED';
        const createdAt = readTimestamp(dispatch);
        return {
            // Multiple providers may fail for the same order; the dispatch UUID keeps
            // FlatList/entity keys distinct without changing backend ranking semantics.
            id: `courier_failed:dispatch:${dispatch.id}`,
            tier: 1,
            urgency_score: roundScore(hoursSince(createdAt, now)),
            signal_type: isFailed ? 'COURIER_FAILED' : 'COURIER_INDETERMINATE',
            reason_code: isFailed ? 'COURIER_DISPATCH_FAILED' : 'COURIER_DISPATCH_INDETERMINATE',
            reason: isFailed
                ? `Courier dispatch failed for order ${label} — needs manual retry`
                : `Courier dispatch status is unresolved for order ${label} — verify with the provider`,
            entity: { type: 'order', id: dispatch.order_id },
            created_at: createdAt,
        };
    });
}

/**
 * Tier 1b — the shop is missing courier setup AND it is actually blocking a
 * real, ready-to-ship order (not just theoretically incomplete). One item
 * per shop, referencing the oldest blocked order for urgency/deep-link.
 */
async function collectCourierSetupBlocked(shopId, now) {
    const readiness = await courierReadinessService.getReadiness(shopId);
    if (readiness.ready) return [];

    const candidateOrders = await Order.findAll({
        where: {
            shop_id: shopId,
            ...activeOrderWhere(COMMITTED_ORDER_STATUSES),
        },
        order: [['created_at', 'ASC']],
        // Order's timestamp attribute is `createdAt` (no explicit rename —
        // see the accessor-trap note below); requesting the raw column name
        // 'created_at' here instead of the real attribute name silently
        // fails to populate the value on the returned instance at all,
        // which is a *stricter* failure mode than the read-side trap
        // `readTimestamp()` guards against (there is nothing for it to find
        // under either key). ORDER BY is unaffected — raw column names work
        // there regardless of the JS attribute name.
        attributes: [
            'id',
            'order_number',
            'createdAt',
            'order_status',
            'fulfillment_status',
            'payment_status',
            'delivered_at',
        ],
    });
    if (!candidateOrders.length) return [];

    const orderIds = candidateOrders.map((order) => order.id);
    const committedDispatches = await CourierDispatch.findAll({
        where: { shop_id: shopId, order_id: { [Op.in]: orderIds }, status: 'COMMITTED' },
        attributes: ['order_id'],
    });
    const committedOrderIds = new Set(committedDispatches.map((dispatch) => dispatch.order_id));
    const stillBlocked = candidateOrders.filter((order) => !committedOrderIds.has(order.id));
    if (!stillBlocked.length) return [];

    const oldest = stillBlocked[0]; // ASC order => earliest became ready to ship
    const createdAt = readTimestamp(oldest);
    const label = oldest.order_number || oldest.id;
    return [{
        id: `courier_setup_required:shop:${shopId}`,
        tier: 1,
        urgency_score: roundScore(hoursSince(createdAt, now)),
        signal_type: 'COURIER_SETUP_REQUIRED',
        reason_code: 'COURIER_SETUP_REQUIRED',
        reason: stillBlocked.length === 1
            ? `Courier setup is incomplete and order ${label} is ready to ship`
            : `Courier setup is incomplete — ${stillBlocked.length} orders are ready to ship (oldest: ${label})`,
        entity: { type: 'order', id: oldest.id },
        created_at: createdAt,
    }];
}

const NEEDS_REPLY_REASON_TEXT = {
    PROVIDER_SEND_FAILED: 'A reply failed to send and needs a manual retry',
    AI_FAILED: 'The AI reply failed and needs manual attention',
    DRAFT_REVIEW_REQUIRED: 'An AI-drafted reply is waiting for your review',
    HITL_REQUIRED: 'This conversation was handed off to you by the AI',
    CUSTOMER_UNANSWERED: "The customer's last message has not been answered",
};

/**
 * Tier 2 — Inbox conversations needing a reply or an AI handoff. Reuses
 * conversationService.getConversations + deriveWorkflowProjection (the exact
 * needs_merchant_reply/hitl projection the Inbox itself uses) rather than
 * re-deriving that logic. D6: bounded to the most recent
 * CONVERSATION_SCAN_LIMIT conversations; if the shop has more than that,
 * `conversationScanTruncated` is reported rather than silently treating a
 * partial scan as complete.
 */
async function collectConversationSignals(shopId, now) {
    const result = await conversationService.getConversations(shopId, {
        page: 1,
        limit: CONVERSATION_SCAN_LIMIT,
    });
    const conversations = result.conversations || [];
    const totalConversations = result.pagination?.total ?? conversations.length;
    const conversationScanTruncated = totalConversations > CONVERSATION_SCAN_LIMIT;

    const candidates = conversations.filter((conversation) => (
        !['closed', 'archived'].includes(conversation.status)
        && (conversation.needs_merchant_reply === true || conversation.hitl === true)
    ));
    if (!candidates.length) return { items: [], conversationScanTruncated };

    const candidateIds = candidates.map((conversation) => conversation.id);
    const lastCustomerRows = await Message.findAll({
        where: { conversation_id: { [Op.in]: candidateIds }, sender: 'customer' },
        attributes: ['conversation_id', [fn('MAX', col('created_at')), 'last_customer_at']],
        group: ['conversation_id'],
        raw: true,
    });
    const lastCustomerAtById = new Map(
        lastCustomerRows
            .filter((row) => row.last_customer_at)
            .map((row) => [row.conversation_id, new Date(row.last_customer_at)]),
    );

    const items = candidates.map((conversation) => {
        // mapConversation() already applies the createdAt/created_at
        // accessor fix (conversation.service.js:570-577) before returning
        // this plain object, so conversation.updated_at here is safe as-is.
        const fallbackAt = conversation.updated_at
            ? new Date(conversation.updated_at)
            : new Date(conversation.created_at);
        const lastCustomerAt = lastCustomerAtById.get(conversation.id) || fallbackAt;
        const reasonCode = NEEDS_REPLY_REASON_TEXT[conversation.needs_merchant_reply_reason]
            ? conversation.needs_merchant_reply_reason
            : (conversation.hitl ? 'HITL_REQUIRED' : 'CUSTOMER_UNANSWERED');
        const reason = NEEDS_REPLY_REASON_TEXT[reasonCode];
        return {
            id: `inbox_needs_reply:conversation:${conversation.id}`,
            tier: 2,
            urgency_score: roundScore(hoursSince(lastCustomerAt, now)),
            signal_type: 'INBOX_NEEDS_REPLY',
            reason_code: reasonCode,
            reason,
            entity: { type: 'conversation', id: conversation.id },
            created_at: lastCustomerAt,
        };
    });

    return { items, conversationScanTruncated };
}

/**
 * Tier 3 — draft orders awaiting confirmation. D3: `order_status: 'draft'`
 * is the only reliable "awaiting confirmation" signal; 'placed'/'fulfilled'
 * are declared in ORDER_STATES but never written by production code.
 */
async function collectDraftOrders(shopId, now) {
    const draftOrders = await Order.findAll({
        where: { shop_id: shopId, order_status: 'draft' },
        order: [['created_at', 'ASC']],
        // See the comment in collectCourierSetupBlocked: Order's real
        // attribute name is `createdAt`, not `created_at`.
        attributes: ['id', 'order_number', 'total', 'createdAt'],
    });

    return draftOrders.map((order) => {
        const createdAt = readTimestamp(order);
        const hours = hoursSince(createdAt, now);
        const total = Number(order.total) || 0;
        const label = order.order_number || order.id;
        return {
            id: `draft_order:order:${order.id}`,
            tier: 3,
            urgency_score: roundScore(total * hours),
            signal_type: 'DRAFT_ORDER',
            reason_code: 'DRAFT_ORDER_AWAITING_CONFIRMATION',
            reason: `Draft order ${label} (৳${total}) has been awaiting confirmation for ${Math.round(hours)}h`,
            entity: { type: 'order', id: order.id },
            created_at: createdAt,
        };
    });
}

/**
 * Tier 4 — RTO-risk customers awaiting verification on a pending order.
 * Uses RtoShieldService.checkPhone(...) exactly as-is (TIER_VERIFY only —
 * TIER_BLOCK customers are already refused COD at the order gate, which is a
 * different, earlier point in the flow than "awaiting verification").
 */
async function collectRtoVerifyOrders(shopId, now) {
    const pendingOrders = await Order.findAll({
        where: {
            shop_id: shopId,
            ...activeOrderWhere(RTO_PENDING_ORDER_STATUSES),
            customer_phone: { [Op.ne]: null },
        },
        order: [['created_at', 'ASC']],
        // See the comment in collectCourierSetupBlocked: Order's real
        // attribute name is `createdAt`, not `created_at`.
        attributes: [
            'id',
            'order_number',
            'customer_phone',
            'createdAt',
            'order_status',
            'fulfillment_status',
            'payment_status',
            'delivered_at',
        ],
    });
    if (!pendingOrders.length) return [];

    let enforceNetwork = false;
    try {
        enforceNetwork = (await getNetworkSettings(shopId)).enforce === true;
    } catch (_) {
        // Shared signals are not consumed when this shop's enforcement setting is unavailable.
    }

    const uniquePhones = [...new Set(pendingOrders.map((order) => order.customer_phone).filter(Boolean))];
    const checks = await Promise.all(
        uniquePhones.map((phone) => RtoShieldService.checkPhone(phone, shopId, {
            trustedContext: true,
            enforceNetwork,
        })),
    );
    const resultByPhone = new Map(uniquePhones.map((phone, index) => [phone, checks[index]]));

    const items = [];
    for (const order of pendingOrders) {
        const result = resultByPhone.get(order.customer_phone);
        if (!result || result.tier !== RtoShieldService.TIERS.TIER_VERIFY) continue;
        const createdAt = readTimestamp(order);
        const label = order.order_number || order.id;
        items.push({
            id: `rto_verify:order:${order.id}`,
            tier: 4,
            urgency_score: roundScore(hoursSince(createdAt, now)),
            signal_type: 'RTO_VERIFY',
            reason_code: 'RTO_VERIFICATION_REQUIRED',
            reason: `Customer on order ${label} has an elevated return history — verify before shipping`,
            entity: { type: 'order', id: order.id },
            created_at: createdAt,
        });
    }
    return items;
}

/**
 * Tier 5 — products below their low_stock_threshold. D1: only fires when
 * `track_quantity = true AND is_active = true` — untracked products default
 * `quantity: 0`, which would otherwise always look "low stock".
 */
async function collectLowStockProducts(shopId, now) {
    const products = await Product.findAll({
        where: {
            [Op.and]: [
                { shop_id: shopId, is_active: true, track_quantity: true },
                sequelizeWhere(col('quantity'), Op.lte, col('low_stock_threshold')),
            ],
        },
        // Product's real attribute name is `createdAt`, not `created_at` —
        // see the comment in collectCourierSetupBlocked.
        attributes: ['id', 'name', 'quantity', 'low_stock_threshold', 'createdAt'],
    });

    return products
        .filter((product) => Number(product.low_stock_threshold) > 0)
        .map((product) => {
            const threshold = Number(product.low_stock_threshold);
            const quantity = Math.max(0, Number(product.quantity) || 0);
            const createdAt = readTimestamp(product);
            return {
                id: `low_stock:product:${product.id}`,
                tier: 5,
                urgency_score: roundScore(1 - (quantity / threshold)),
                signal_type: 'LOW_STOCK',
                reason_code: 'LOW_STOCK',
                reason: `${product.name} is low on stock (${quantity} left, threshold ${threshold})`,
                entity: { type: 'product', id: product.id },
                created_at: createdAt,
            };
        });
}

/**
 * Runs every collector and returns the unsorted, uncapped candidate set —
 * shared by both /attention (ranks + caps it) and /today (counts it per
 * signal_type for pending-action counts) so the two endpoints can never
 * silently disagree about what counts as a pending action.
 */
async function collectAllSignals(shopId, now = new Date()) {
    const [
        courierFailures,
        courierSetupBlocked,
        conversationResult,
        draftOrders,
        rtoVerify,
        lowStock,
    ] = await Promise.all([
        collectCourierFailures(shopId, now),
        collectCourierSetupBlocked(shopId, now),
        collectConversationSignals(shopId, now),
        collectDraftOrders(shopId, now),
        collectRtoVerifyOrders(shopId, now),
        collectLowStockProducts(shopId, now),
    ]);

    const items = [
        ...courierFailures,
        ...courierSetupBlocked,
        ...conversationResult.items,
        ...draftOrders,
        ...rtoVerify,
        ...lowStock,
    ];

    return { items, conversationScanTruncated: conversationResult.conversationScanTruncated };
}

const toMillis = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** Tier asc, urgency_score desc, then earliest-created-first on ties. */
function sortItems(items) {
    return [...items].sort((left, right) => {
        if (left.tier !== right.tier) return left.tier - right.tier;
        if (right.urgency_score !== left.urgency_score) return right.urgency_score - left.urgency_score;
        return toMillis(left.created_at) - toMillis(right.created_at);
    });
}

const ATTENTION_LIST_CAP = 20;

/** Public entry point for the controller: ranked, capped, response-shaped. */
async function getAttentionList(shopId, now = new Date()) {
    const { items, conversationScanTruncated } = await collectAllSignals(shopId, now);
    const sorted = sortItems(items);
    const capped = sorted.slice(0, ATTENTION_LIST_CAP);
    const truncatedCount = Math.max(0, sorted.length - ATTENTION_LIST_CAP);

    return {
        items: capped.map((item) => ({
            id: item.id,
            tier: item.tier,
            urgency_score: item.urgency_score,
            signal_type: item.signal_type,
            reason_code: item.reason_code,
            reason: item.reason,
            entity: item.entity,
        })),
        truncated_count: truncatedCount,
        // D6: distinct from truncated_count (which counts fully-known items
        // beyond the top 20) — this flags that the tier-2 conversation scan
        // itself hit its bound, so some additional needs-reply conversation
        // may exist outside the scanned window and is not represented at
        // all above, not even as an uncounted truncated item.
        conversation_scan_truncated: conversationScanTruncated,
        generated_at: now.toISOString(),
    };
}

module.exports = {
    getAttentionList,
    collectAllSignals,
    sortItems,
    ATTENTION_LIST_CAP,
    CONVERSATION_SCAN_LIMIT,
    COMMITTED_ORDER_STATUSES,
    RTO_PENDING_ORDER_STATUSES,
    TERMINAL_ORDER_STATUSES,
    ACTIVE_FULFILLMENT_STATUSES,
    activeOrderWhere,
    READY_TO_SHIP_EXCLUDED_STATUSES,
    RTO_PENDING_EXCLUDED_STATUSES,
};
