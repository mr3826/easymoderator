'use strict';

const { Op } = require('sequelize');
const { classifyOrderOutcome, OUTCOMES } = require('./order-outcome');
const { LIVE_STATUSES } = require('./opportunity.service');

const ORDER_SCAN_CAP = 5000;
const NEW_BUYER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const DEFINITIONS = Object.freeze({
    total_records: 'All non-deleted customer records belonging to this shop.',
    open_opportunities: 'Customer opportunities in OPEN or ACTIONED status belonging to this shop.',
    buyers: 'Distinct linked customers with at least one delivered order in the scanned order set.',
    repeat_buyers: 'Distinct linked customers with at least two orders classified DELIVERED.',
    new_buyers: 'Distinct linked customers whose first delivered order was within the last 30 days; unavailable when order coverage is incomplete or delivered timestamps are missing.',
    order_linkage: 'Only orders.customer_id links to a customer; phone-only matches are excluded.',
});

const customerScope = (Customer, shopId) => ({
    model: Customer,
    as: 'customer',
    attributes: [],
    where: { shop_id: shopId },
    required: true,
});

/** Tenant-scoped record/opportunity counts and bounded linked-order segments. */
async function getOverview(shopId, { now = new Date() } = {}) {
    if (!shopId) {
        throw new Error('customer-intelligence-overview: shopId is required (tenant scope)');
    }

    const { Customer, CustomerOpportunity, Order } = require('../entities');
    const linkedOrdersWhere = () => ({
        shop_id: shopId,
        customer_id: { [Op.ne]: null },
    });
    const [records, opportunities, orderRows, linkedOrderTotal] = await Promise.all([
        Customer.count({ where: { shop_id: shopId } }),
        CustomerOpportunity.count({
            where: { shop_id: shopId, status: { [Op.in]: LIVE_STATUSES } },
        }),
        Order.findAll({
            where: linkedOrdersWhere(),
            include: [customerScope(Customer, shopId)],
            attributes: ['customer_id', 'order_status', 'delivery_status', 'delivered_at'],
            order: [['created_at', 'DESC']],
            limit: ORDER_SCAN_CAP,
        }),
        Order.count({
            where: linkedOrdersWhere(),
            include: [customerScope(Customer, shopId)],
        }),
    ]);

    const orderCounts = new Map();
    for (const row of orderRows) {
        const customerId = row.customer_id;
        if (!customerId) continue;
        const outcome = classifyOrderOutcome(row);
        if (outcome !== OUTCOMES.DELIVERED) continue;

        const counts = orderCounts.get(String(customerId)) || {
            delivered: 0,
            firstDeliveredAt: null,
            hasUndatedDeliveredOrder: false,
        };
        counts.delivered += 1;
        const deliveredAt = row.delivered_at ? new Date(row.delivered_at).getTime() : NaN;
        if (Number.isFinite(deliveredAt)) {
            if (counts.firstDeliveredAt === null || deliveredAt < counts.firstDeliveredAt) {
                counts.firstDeliveredAt = deliveredAt;
            }
        } else {
            counts.hasUndatedDeliveredOrder = true;
        }
        orderCounts.set(String(customerId), counts);
    }

    let buyers = 0;
    let repeatBuyers = 0;
    const scanned = orderRows.length;
    const coverageComplete = scanned === Number(linkedOrderTotal);
    const nowAt = new Date(now).getTime();
    const deliveredDatesComplete = [...orderCounts.values()].every((counts) => !counts.hasUndatedDeliveredOrder);
    let newBuyers = coverageComplete && deliveredDatesComplete ? 0 : null;
    for (const counts of orderCounts.values()) {
        if (counts.delivered > 0) buyers += 1;
        if (counts.delivered >= 2) repeatBuyers += 1;
        if (newBuyers !== null && !counts.hasUndatedDeliveredOrder && counts.firstDeliveredAt !== null
            && counts.firstDeliveredAt >= nowAt - NEW_BUYER_WINDOW_MS
            && counts.firstDeliveredAt <= nowAt) {
            newBuyers += 1;
        }
    }

    return {
        total_records: Number(records),
        buyers,
        repeat_buyers: repeatBuyers,
        new_buyers: newBuyers,
        open_opportunities: Number(opportunities),
        scanned_orders: scanned,
        total_linked_orders: Number(linkedOrderTotal),
        order_scan_cap: ORDER_SCAN_CAP,
        coverage_complete: coverageComplete,
        definitions: DEFINITIONS,
    };
}

module.exports = { getOverview, ORDER_SCAN_CAP, DEFINITIONS };
