'use strict';

const { Op, fn, col } = require('sequelize');

// An intentionally small, fixed set of merchant operational events. Never
// project audit metadata, message content, customer details or user identity.
const ACTIONS = Object.freeze(['CREATE', 'UPDATE', 'DELETE', 'CHANNEL_CONNECT', 'CHANNEL_DISCONNECT', 'ORDER_CONFIRM', 'ORDER_CANCEL', 'PAYMENT_PROCESS', 'HUMAN_TAKEOVER', 'AI_SUGGESTION_ACCEPTED', 'AI_SUGGESTION_REJECTED']);
const RESOURCES = Object.freeze(['ORDER', 'CONVERSATION', 'MESSAGE', 'CHANNEL', 'PRODUCT', 'PAYMENT', 'SHOP']);

async function deliveredCharges(BillingLine, shopId, dayUtc) {
    const rows = await BillingLine.findAll({
        where: { shop_id: shopId, occurred_at: dayUtc, line_kind: 'billable', outcome: 'DELIVERED', currency: 'BDT', amount_minor: { [Op.gt]: 0 } },
        attributes: [[fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('amount_minor')), 0), 'amountMinor']],
        raw: true,
    });
    const row = rows[0];
    if (!row || row.count == null || row.amountMinor == null) throw new Error('Missing ledger aggregate');
    const count = Number(row.count);
    const amountMinor = Number(row.amountMinor);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('Invalid ledger aggregate');
    return { dayUtc, count, amountMinor };
}

async function recentActivity(AuditLog, shopId) {
    const rows = await AuditLog.findAll({
        where: { shop_id: shopId, action: { [Op.in]: ACTIONS }, resource_type: { [Op.in]: RESOURCES } },
        attributes: ['id', 'action', 'resource_type', 'created_at'],
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: 6,
        raw: true,
    });
    return rows.filter(row => ACTIONS.includes(row.action) && RESOURCES.includes(row.resource_type))
        .map(row => ({ id: row.id, action: row.action, resourceType: row.resource_type, occurredAt: new Date(row.created_at).toISOString() }));
}

/** Both reads are isolated; failure never becomes zero or blocks the queue.
 * Billing occurred_at is DATEONLY UTC by contract, not Dhaka delivery time.
 * This is current positive ledger charges, NOT paid invoices, net credits or
 * proof of a live courier booking. No mutation or new permission.
 */
async function getCommerceSignals({ shopId, BillingLine, AuditLog, now = new Date() }) {
    if (!shopId) return { deliveredCharges: null, recentActivity: null };
    const dayUtc = now.toISOString().slice(0, 10);
    const [billing, activity] = await Promise.allSettled([
        deliveredCharges(BillingLine, shopId, dayUtc),
        recentActivity(AuditLog, shopId),
    ]);
    return {
        deliveredCharges: billing.status === 'fulfilled' ? billing.value : null,
        recentActivity: activity.status === 'fulfilled' ? activity.value : null,
    };
}

module.exports = { getCommerceSignals };
