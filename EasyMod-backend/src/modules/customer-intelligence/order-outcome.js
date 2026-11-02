'use strict';

/**
 * Deterministic order-outcome classification and phone association helpers.
 *
 * The single place that decides what a recorded order state *means* for
 * Customer 360 metrics and Order Confidence history, so the two features can
 * never disagree about whether an order was delivered or returned.
 *
 * Outcomes are derived only from recorded fields:
 *   order_status, delivery_status (normalized courier status), delivered_at,
 *   delivery_consignment_id / delivery_tracking_code / delivery_dispatched_at.
 */

const { normalizePhone, validatePhone } = require('../../utils/validators/phone.validator');

const OUTCOMES = Object.freeze({
    DELIVERED: 'DELIVERED',
    RETURNED: 'RETURNED',
    CANCELLED: 'CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
});

// Normalized courier statuses (delivery/providers/provider.registry.js).
const RETURN_STATUSES = new Set(['returned', 'partial_returned']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

const lower = (value) => String(value || '').trim().toLowerCase();

const wasDispatched = (order) => Boolean(
    order?.delivery_consignment_id
    || order?.delivery_tracking_code
    || order?.delivery_dispatched_at
);

/**
 * @returns {'DELIVERED'|'RETURNED'|'CANCELLED'|'IN_PROGRESS'}
 */
function classifyOrderOutcome(order) {
    const deliveryStatus = lower(order?.delivery_status);
    const orderStatus = lower(order?.order_status);

    // Only provider-normalized final return states count as RTO; courier
    // cancellation remains cancellation even when the parcel was dispatched.
    if (RETURN_STATUSES.has(deliveryStatus)) return OUTCOMES.RETURNED;
    // A partial receipt is still in progress, even if a legacy callback wrote
    // full-delivery fields before item-level amounts were available.
    if (deliveryStatus === 'partial_delivered') return OUTCOMES.IN_PROGRESS;
    if (deliveryStatus === 'delivered' || orderStatus === 'delivered' || order?.delivered_at) {
        return OUTCOMES.DELIVERED;
    }
    if (CANCELLED_STATUSES.has(deliveryStatus) || orderStatus === 'cancelled' || orderStatus === 'refunded') {
        return OUTCOMES.CANCELLED;
    }
    // failed_delivery is an attempt, not an outcome: the courier retries.
    return OUTCOMES.IN_PROGRESS;
}

/** Normalized BD mobile (01XXXXXXXXX) or null when not a valid BD mobile. */
function normalizeBdMobile(phone) {
    if (phone === null || phone === undefined) return null;
    const normalized = normalizePhone(String(phone).replace(/[\s-]/g, ''));
    return normalized && validatePhone(normalized, 'BD_MOBILE_STRICT') ? normalized : null;
}

/**
 * The stored spellings of one normalized BD mobile. Orders keep the phone as
 * entered, so an exact-match lookup must cover each spelling the checkout and
 * dashboard forms produce. Empty for anything that is not a valid BD mobile —
 * an invalid number never associates two records.
 */
function phoneVariants(phone) {
    const normalized = normalizeBdMobile(phone);
    if (!normalized) return [];
    return [normalized, `+88${normalized}`, `88${normalized}`];
}

const numeric = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Aggregate recorded orders into commerce facts. Pure; callers pass already
 * tenant-scoped rows.
 */
function summarizeOrders(orders = []) {
    const summary = {
        total_orders: 0,
        delivered_orders: 0,
        returned_orders: 0,
        cancelled_orders: 0,
        in_progress_orders: 0,
        ordered_value: 0,
        delivered_value: 0,
        first_order_at: null,
        last_order_at: null,
        last_delivered_at: null,
    };
    for (const order of orders) {
        const outcome = classifyOrderOutcome(order);
        const total = numeric(order.total);
        const createdAt = order.created_at || order.createdAt || null;
        summary.total_orders += 1;
        if (outcome !== OUTCOMES.CANCELLED) summary.ordered_value += total;
        if (outcome === OUTCOMES.DELIVERED) {
            summary.delivered_orders += 1;
            summary.delivered_value += total;
            const deliveredAt = order.delivered_at || order.updated_at || order.updatedAt || createdAt;
            if (deliveredAt && (!summary.last_delivered_at || new Date(deliveredAt) > new Date(summary.last_delivered_at))) {
                summary.last_delivered_at = new Date(deliveredAt).toISOString();
            }
        } else if (outcome === OUTCOMES.RETURNED) {
            summary.returned_orders += 1;
        } else if (outcome === OUTCOMES.CANCELLED) {
            summary.cancelled_orders += 1;
        } else {
            summary.in_progress_orders += 1;
        }
        if (createdAt) {
            const iso = new Date(createdAt).toISOString();
            if (!summary.first_order_at || iso < summary.first_order_at) summary.first_order_at = iso;
            if (!summary.last_order_at || iso > summary.last_order_at) summary.last_order_at = iso;
        }
    }
    summary.ordered_value = Math.round(summary.ordered_value * 100) / 100;
    summary.delivered_value = Math.round(summary.delivered_value * 100) / 100;
    return summary;
}

module.exports = {
    OUTCOMES,
    classifyOrderOutcome,
    normalizeBdMobile,
    phoneVariants,
    summarizeOrders,
    wasDispatched,
};
