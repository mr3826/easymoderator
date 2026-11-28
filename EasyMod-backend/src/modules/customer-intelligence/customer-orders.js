'use strict';

/**
 * Tenant-scoped order lookups for a set of customers.
 *
 * Identity rule (ADR-0005): an order belongs to a customer when
 * orders.customer_id says so. An order with NO customer_id is *associated*
 * with a customer when its phone normalizes to the customer's phone — read
 * time only, labelled PHONE_MATCH, never written back, never across shops,
 * and never used to join two customer rows.
 */

const { Op, fn, col } = require('sequelize');
const { normalizeBdMobile, phoneVariants } = require('./order-outcome');
const metrics = require('../pilot-features/pilot-metrics');

// Sequelize attribute names (Order uses the default createdAt/updatedAt names).
const ORDER_FACT_ATTRIBUTES = Object.freeze([
    'id', 'customer_id', 'customer_phone', 'order_number', 'total', 'order_status',
    'payment_status', 'delivery_status', 'delivery_provider', 'delivery_consignment_id',
    'delivery_tracking_code', 'delivery_dispatched_at', 'delivered_at', 'channel',
    'createdAt', 'updatedAt',
]);

const getOrderModel = () => require('../entities').Order;

const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);

/** Normalize the timestamp attribute names so pure helpers see one shape. */
function toOrderFact(row) {
    const data = plain(row);
    return {
        ...data,
        created_at: data.created_at || data.createdAt || null,
        updated_at: data.updated_at || data.updatedAt || null,
    };
}

function buildOrderScope(shopId, customers, since) {
    const customerIdsByPhone = new Map();
    for (const customer of customers) {
        const normalized = normalizeBdMobile(customer.phone);
        if (!normalized) continue;
        if (!customerIdsByPhone.has(normalized)) customerIdsByPhone.set(normalized, []);
        customerIdsByPhone.get(normalized).push(String(customer.id));
    }
    const variants = [...customerIdsByPhone.keys()].flatMap((normalized) => phoneVariants(normalized));
    const or = [{ customer_id: { [Op.in]: customers.map((customer) => customer.id) } }];
    if (variants.length) or.push({ customer_id: null, customer_phone: { [Op.in]: variants } });

    return {
        customerIdsByPhone,
        where: {
            shop_id: shopId,
            [Op.or]: or,
            ...(since ? { created_at: { [Op.gte]: since } } : {}),
        },
    };
}

/**
 * @param {string} shopId
 * @param {Array<{id:string, phone?:string}>} customers
 * @param {object} [options]
 * @returns {Promise<Map<string, Array<object>>>} customerId -> orders (newest first), each with `link`
 */
async function loadOrdersForCustomers(shopId, customers, { since = null, transaction = null, limit = 5000 } = {}) {
    const byCustomer = new Map(customers.map((customer) => [String(customer.id), []]));
    if (!shopId || !customers.length) return byCustomer;

    const { customerIdsByPhone, where } = buildOrderScope(shopId, customers, since);

    const rows = await getOrderModel().findAll({
        where,
        attributes: ORDER_FACT_ATTRIBUTES,
        order: [['created_at', 'DESC']],
        limit,
        ...(transaction ? { transaction } : {}),
    });

    for (const row of rows) {
        const order = toOrderFact(row);
        if (order.customer_id) {
            const customerId = String(order.customer_id);
            if (byCustomer.has(customerId)) {
                byCustomer.get(customerId).push({ ...order, link: 'CUSTOMER' });
            }
            continue;
        }
        const owners = customerIdsByPhone.get(normalizeBdMobile(order.customer_phone)) || [];
        if (owners.length > 1) metrics.increment('customer.phone_match_ambiguous');
        for (const customerId of owners) {
            byCustomer.get(customerId).push({ ...order, link: 'PHONE_MATCH' });
        }
    }
    return byCustomer;
}

async function countOrdersForCustomers(shopId, customers, { since = null, transaction = null } = {}) {
    const totals = new Map(customers.map((customer) => [String(customer.id), 0]));
    if (!shopId || !customers.length) return totals;

    const { customerIdsByPhone, where } = buildOrderScope(shopId, customers, since);
    const rows = await getOrderModel().findAll({
        where,
        attributes: [
            'customer_id',
            'customer_phone',
            [fn('COUNT', col('id')), 'order_count'],
        ],
        group: ['customer_id', 'customer_phone'],
        raw: true,
        ...(transaction ? { transaction } : {}),
    });

    for (const row of rows) {
        const count = Number(row.order_count) || 0;
        if (row.customer_id) {
            const customerId = String(row.customer_id);
            if (totals.has(customerId)) totals.set(customerId, totals.get(customerId) + count);
            continue;
        }
        for (const customerId of customerIdsByPhone.get(normalizeBdMobile(row.customer_phone)) || []) {
            totals.set(customerId, (totals.get(customerId) || 0) + count);
        }
    }
    return totals;
}

async function loadOrdersForCustomersWithCoverage(shopId, customers, options = {}) {
    const limit = options.limit ?? 5000;
    const [ordersByCustomer, totalsByCustomer] = await Promise.all([
        loadOrdersForCustomers(shopId, customers, { ...options, limit }),
        countOrdersForCustomers(shopId, customers, options),
    ]);

    return new Map(customers.map((customer) => {
        const id = String(customer.id);
        const orders = ordersByCustomer.get(id) || [];
        const total = totalsByCustomer.get(id) || 0;
        return [id, {
            orders,
            order_coverage: {
                scanned: orders.length,
                total,
                cap: limit,
                complete: orders.length >= total,
            },
        }];
    }));
}

/**
 * Customers in this shop whose phone normalizes to the given phone. Used when
 * an unlinked order is created, to find the opportunities it converts.
 */
async function findCustomersByPhone(shopId, phone, { transaction = null } = {}) {
    const variants = phoneVariants(phone);
    if (!shopId || !variants.length) return [];
    const { Customer } = require('../entities');
    return Customer.findAll({
        where: { shop_id: shopId, phone: { [Op.in]: variants } },
        attributes: ['id', 'phone'],
        ...(transaction ? { transaction } : {}),
    });
}

module.exports = {
    ORDER_FACT_ATTRIBUTES,
    loadOrdersForCustomers,
    countOrdersForCustomers,
    loadOrdersForCustomersWithCoverage,
    findCustomersByPhone,
    toOrderFact,
};
