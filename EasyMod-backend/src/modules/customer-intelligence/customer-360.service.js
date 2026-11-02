'use strict';

/**
 * Customer 360 Lite read models (ADR-0005): computed on read from recorded
 * orders, conversations, courier tracking and opportunities. Nothing here
 * writes. Every query is scoped by the caller's shop.
 *
 * Query cost: the list issues a fixed number of queries per page (customers,
 * their orders, conversation activity, live opportunities) — never one per
 * customer. The detail issues a fixed number for one customer.
 */

const { Op, fn, col } = require('sequelize');
const { AppError } = require('../../utils/AppError');
const { loadOrdersForCustomers } = require('./customer-orders');
const { classifyOrderOutcome, summarizeOrders, normalizeBdMobile, OUTCOMES } = require('./order-outcome');
const { deriveCustomerState } = require('./customer-state');
const { contactability } = require('./contactability');
const { LIVE_STATUSES, serializeOpportunity } = require('./opportunity.service');

const entities = () => require('../entities');
const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);
const ms = (value) => (value ? new Date(value).getTime() : 0);
const latest = (...values) => {
    const best = Math.max(0, ...values.map(ms).filter(Number.isFinite));
    return best > 0 ? new Date(best).toISOString() : null;
};

const CUSTOMER_ATTRIBUTES = Object.freeze([
    'id', 'name', 'phone', 'email', 'channel_type', 'meta_channel_id',
    'messaging_consent', 'metadata', 'createdAt',
]);

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

function lastInboundAt(customer) {
    const consent = customer?.messaging_consent || {};
    return latest(...Object.values(consent).map((entry) => entry?.last_inbound_at));
}

function identityOf(customer) {
    const metadata = customer.metadata || {};
    return {
        id: customer.id,
        name: customer.name,
        phone: customer.phone || null,
        email: customer.email || null,
        channel_type: customer.channel_type,
        profile_pic: typeof metadata.profile_pic === 'string' ? metadata.profile_pic : null,
        first_seen_at: customer.createdAt ? new Date(customer.createdAt).toISOString() : null,
    };
}

async function loadConversationActivity(shopId, customerIds) {
    if (!customerIds.length) return new Map();
    const rows = await entities().Conversation.findAll({
        where: { shop_id: shopId, customer_id: { [Op.in]: customerIds } },
        attributes: [
            'customer_id',
            [fn('MAX', col('updated_at')), 'last_at'],
            [fn('COUNT', col('id')), 'conversation_count'],
        ],
        group: ['customer_id'],
        raw: true,
    });
    return new Map(rows.map((row) => [row.customer_id, {
        last_at: row.last_at ? new Date(row.last_at).toISOString() : null,
        count: Number(row.conversation_count) || 0,
    }]));
}

function buildSummary(customer, orders, activity, liveOpportunity, now) {
    const summary = summarizeOrders(orders);
    const lastActivityAt = latest(
        activity?.last_at, summary.last_order_at, lastInboundAt(customer), customer.createdAt,
    );
    const state = deriveCustomerState({
        summary,
        lastActivityAt,
        hasLiveOpportunity: Boolean(liveOpportunity),
    }, now);
    return { summary, lastActivityAt, state };
}

/**
 * GET /customer-intelligence/customers
 * @param {object} query { page, pageSize, search, view: 'all' | 'opportunities' }
 */
async function listCustomers(shopId, { page = 1, pageSize = 20, search = '', view = 'all' } = {}, now = new Date()) {
    const { Customer, CustomerOpportunity } = entities();
    const where = { shop_id: shopId };
    const term = String(search || '').trim().slice(0, 100);
    if (term) {
        const pattern = `%${escapeLike(term)}%`;
        const or = [{ name: { [Op.iLike]: pattern } }, { phone: { [Op.iLike]: pattern } }];
        const normalized = normalizeBdMobile(term);
        if (normalized) or.push({ phone: { [Op.iLike]: `%${normalized.slice(1)}` } });
        where[Op.or] = or;
    }
    const include = view === 'opportunities' ? [{
        model: CustomerOpportunity,
        as: 'opportunities',
        attributes: [],
        where: { shop_id: shopId, status: { [Op.in]: LIVE_STATUSES } },
        required: true,
    }] : [];

    const { count, rows } = await Customer.findAndCountAll({
        where,
        include,
        attributes: CUSTOMER_ATTRIBUTES,
        // Attribute name, so Sequelize qualifies it with the Customer alias
        // (the opportunities join also has a created_at column).
        order: [['createdAt', 'DESC'], ['id', 'ASC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
        distinct: true,
        subQuery: false,
    });
    const customers = rows.map(plain);
    const ids = customers.map((c) => c.id);

    const [ordersByCustomer, activityByCustomer, liveOpportunities] = await Promise.all([
        loadOrdersForCustomers(shopId, customers),
        loadConversationActivity(shopId, ids),
        ids.length ? CustomerOpportunity.findAll({
            where: { shop_id: shopId, customer_id: { [Op.in]: ids }, status: { [Op.in]: LIVE_STATUSES } },
            attributes: ['id', 'customer_id', 'status', 'strength', 'reasons', 'last_signal_at'],
        }) : [],
    ]);
    const liveByCustomer = new Map(liveOpportunities.map((o) => [o.customer_id, plain(o)]));

    const data = customers.map((customer) => {
        const live = liveByCustomer.get(customer.id) || null;
        const { summary, lastActivityAt, state } = buildSummary(
            customer, ordersByCustomer.get(customer.id) || [], activityByCustomer.get(customer.id), live, now,
        );
        return {
            ...identityOf(customer),
            state: state.state,
            state_reasons: state.reasons,
            total_orders: summary.total_orders,
            delivered_orders: summary.delivered_orders,
            returned_orders: summary.returned_orders,
            delivered_value: summary.delivered_value,
            last_order_at: summary.last_order_at,
            last_activity_at: lastActivityAt,
            open_opportunity: live ? {
                id: live.id, status: live.status, strength: live.strength, reasons: live.reasons,
            } : null,
        };
    });
    return { data, total: count, page, pageSize };
}

async function loadRtoSignal(shopId, phone) {
    const normalized = normalizeBdMobile(phone);
    if (!normalized) return { available: false, reason: 'NO_VALID_PHONE' };
    try {
        const RtoShieldService = require('../rto-shield/rto-shield.service');
        const { getNetworkSettings } = require('../rto-shield/rto-network-settings');
        const { enforce } = await getNetworkSettings(shopId);
        const result = await RtoShieldService.checkPhone(normalized, shopId, {
            trustedContext: true,
            enforceNetwork: enforce !== false,
        });
        return {
            available: true,
            tier: result.tier,
            risk_score: result.risk_score,
            list: result.entry ? (result.entry.is_global ? 'NETWORK_LIST' : 'SHOP_LIST') : null,
            network: result.network ? {
                shops_reported: result.network.shops_reported,
                total_attempts: result.network.total_attempts,
                rto_rate: Math.round((result.network.rto_rate || 0) * 100) / 100,
            } : null,
        };
    } catch (_) {
        return { available: false, reason: 'UNAVAILABLE' };
    }
}

function statusTimestamp(tracking, statuses) {
    const history = Array.isArray(tracking?.status_history) ? tracking.status_history : [];
    const hit = history.filter((h) => statuses.includes(String(h?.status || '').toLowerCase())).pop();
    return hit?.timestamp || null;
}

function buildTimeline({ customer, conversations, messageCounts, orders, trackingByOrder, opportunities }) {
    const events = [];
    const push = (type, at, data = {}) => { if (at) events.push({ type, at: new Date(at).toISOString(), ...data }); };

    push('CUSTOMER_FIRST_SEEN', customer.createdAt, { channel_type: customer.channel_type });
    for (const conversation of conversations) {
        push('CONVERSATION', conversation.created_at, {
            conversation_id: conversation.id,
            channel: conversation.channel,
            customer_messages: messageCounts.get(conversation.id) || 0,
            last_activity_at: conversation.updated_at ? new Date(conversation.updated_at).toISOString() : null,
        });
    }
    for (const order of orders) {
        const base = { order_id: order.id, order_number: order.order_number, link: order.link };
        push('ORDER_PLACED', order.created_at, { ...base, total: Number(order.total) || 0 });
        if (order.delivery_dispatched_at) {
            push('COURIER_BOOKED', order.delivery_dispatched_at, { ...base, provider: order.delivery_provider || null });
        }
        const outcome = classifyOrderOutcome(order);
        const tracking = trackingByOrder.get(order.id);
        if (outcome === OUTCOMES.DELIVERED) {
            push('ORDER_DELIVERED', order.delivered_at || statusTimestamp(tracking, ['delivered', 'partial_delivered']) || order.updated_at, base);
        } else if (outcome === OUTCOMES.RETURNED) {
            const at = statusTimestamp(tracking, ['returned', 'partial_returned', 'cancelled']);
            push('ORDER_RETURNED', at || order.updated_at, { ...base, approximate_time: !at });
        } else if (outcome === OUTCOMES.CANCELLED) {
            push('ORDER_CANCELLED', order.updated_at, { ...base, approximate_time: true });
        }
    }
    for (const opportunity of opportunities) {
        push('OPPORTUNITY_DETECTED', opportunity.detected_at, {
            opportunity_id: opportunity.id, strength: opportunity.strength, reasons: opportunity.reasons,
        });
        if (opportunity.resolved_at) {
            push(`OPPORTUNITY_${opportunity.status}`, opportunity.resolved_at, {
                opportunity_id: opportunity.id,
                converted_order_id: opportunity.converted_order_id || null,
                reason: opportunity.resolution_reason || null,
            });
        }
    }
    return events.sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 60);
}

/** GET /customer-intelligence/customers/:customerId */
async function getCustomerDetail(shopId, customerId, now = new Date()) {
    const {
        Customer, Conversation, Message, CustomerOpportunity, OrderConfidence, DeliveryTracking, MetaChannel,
    } = entities();
    const row = await Customer.findOne({ where: { id: customerId, shop_id: shopId }, attributes: CUSTOMER_ATTRIBUTES });
    if (!row) throw new AppError('Customer not found', 404, 'NOT_FOUND');
    const customer = plain(row);

    const [ordersByCustomer, conversations, opportunities, page] = await Promise.all([
        loadOrdersForCustomers(shopId, [customer], { limit: 500 }),
        Conversation.findAll({
            where: { shop_id: shopId, customer_id: customer.id },
            attributes: ['id', 'channel', 'status', 'created_at', 'updated_at'],
            order: [['updated_at', 'DESC']],
            limit: 20,
        }),
        CustomerOpportunity.findAll({
            where: { shop_id: shopId, customer_id: customer.id },
            order: [['last_signal_at', 'DESC']],
            limit: 10,
        }),
        customer.meta_channel_id ? MetaChannel.findOne({
            where: { id: customer.meta_channel_id, shop_id: shopId },
            attributes: ['id', 'display_name', 'platform'],
        }) : null,
    ]);
    const orders = ordersByCustomer.get(customer.id) || [];
    const orderIds = orders.map((o) => o.id);
    const conversationRows = conversations.map(plain);
    const conversationIds = conversationRows.map((c) => c.id);

    const [countsRows, confidenceRows, trackingRows, rtoSignal] = await Promise.all([
        conversationIds.length ? Message.findAll({
            where: { conversation_id: { [Op.in]: conversationIds }, sender: 'customer' },
            attributes: ['conversation_id', [fn('COUNT', col('id')), 'count']],
            group: ['conversation_id'],
            raw: true,
        }) : [],
        orderIds.length ? OrderConfidence.findAll({
            where: { shop_id: shopId, order_id: { [Op.in]: orderIds } },
            attributes: ['order_id', 'decision', 'resolution', 'last_gate_result', 'outcome'],
        }) : [],
        orderIds.length ? DeliveryTracking.findAll({
            where: { order_id: { [Op.in]: orderIds } },
            attributes: ['order_id', 'current_status', 'status_history'],
        }) : [],
        loadRtoSignal(shopId, customer.phone),
    ]);
    const messageCounts = new Map(countsRows.map((r) => [r.conversation_id, Number(r.count) || 0]));
    const confidenceByOrder = new Map(confidenceRows.map((r) => [r.order_id, plain(r)]));
    const trackingByOrder = new Map(trackingRows.map((r) => [r.order_id, plain(r)]));
    const opportunityRows = opportunities.map(plain);
    const live = opportunityRows.find((o) => LIVE_STATUSES.includes(o.status)) || null;
    const activity = {
        last_at: latest(...conversationRows.map((c) => c.updated_at)),
    };
    const { summary, lastActivityAt, state } = buildSummary(customer, orders, activity, live, now);

    return {
        customer: {
            ...identityOf(customer),
            page: page ? { id: page.id, name: page.display_name, platform: page.platform } : null,
            last_activity_at: lastActivityAt,
            last_inbound_at: lastInboundAt(customer),
        },
        contactability: contactability(customer, now),
        state: state.state,
        state_reasons: state.reasons,
        state_rules_version: state.rules_version,
        summary,
        rto_signal: rtoSignal,
        orders: orders.slice(0, 50).map((order) => {
            const confidence = confidenceByOrder.get(order.id);
            return {
                id: order.id,
                order_number: order.order_number,
                created_at: order.created_at,
                total: Number(order.total) || 0,
                order_status: order.order_status,
                payment_status: order.payment_status,
                delivery_status: order.delivery_status,
                delivery_provider: order.delivery_provider || null,
                outcome: classifyOrderOutcome(order),
                link: order.link,
                confidence: confidence ? {
                    decision: confidence.decision,
                    resolution: confidence.resolution,
                    last_gate_result: confidence.last_gate_result,
                    outcome: confidence.outcome,
                } : null,
            };
        }),
        conversations: conversationRows.map((c) => ({
            id: c.id,
            channel: c.channel,
            status: c.status,
            started_at: c.created_at,
            last_activity_at: c.updated_at,
            customer_messages: messageCounts.get(c.id) || 0,
        })),
        opportunities: opportunityRows.map((o) => serializeOpportunity({ ...o, customer }, now)),
        timeline: buildTimeline({
            customer, conversations: conversationRows, messageCounts, orders, trackingByOrder, opportunities: opportunityRows,
        }),
    };
}

module.exports = { listCustomers, getCustomerDetail, buildTimeline, CUSTOMER_ATTRIBUTES };
