'use strict';

const { Op, fn, col, where: sequelizeWhere } = require('sequelize');

/**
 * Phase 1 D4 (doc 05 §4): merchant-operational audit vocabulary, rebuilt
 * case-aware from the ACTUAL `action:`/`resource_type:` literals written
 * across src/modules (2026-11-24 grep of every AuditService.logOperation /
 * AuditLog.create producer). Wildcard families are enumerated from their real
 * writers:
 *   ORDER_CONFIDENCE_*  → EVALUATED | CHANGED | APPROVED | VERIFIED
 *                         (order-confidence/order-confidence.service.js)
 *   AI_EMERGENCY_STOP_* → ENGAGED | RESUMED (shop/shop.service.js)
 *   SHOP_MEMBERSHIP_*   → GRANTED | REVOKED | ROLE_CHANGED (shop/shop.service.js)
 * The #311 allowlist (ORDER_CONFIRM/CHANNEL_CONNECT/…) matched a vocabulary
 * the backend never writes — the feed was near-empty for web merchants.
 *
 * Excluded by construction (anything not listed): `job:…`, `admin:…`,
 * `growth_os:…`, `funnel:…`, auth/session/token flows, usage metering, RTO
 * network settings, ads-studio, addons, notifications, knowledge gaps.
 * Case-aware: producers disagree on case ('order' in mobile, 'ORDER' in
 * order-confidence, 'CUSTOMER' uppercase in the customer controller), so the
 * filter compares lower-cased values (SQL LOWER(...) + a JS membership
 * re-check as defense in depth).
 */
const MERCHANT_ACTIONS = Object.freeze([
    'ORDER_CREATED',
    'ORDER_CONFIRMED',
    'ORDER_CANCELLED',
    'COURIER_BOOKED',
    'COURIER_BOOKING_AUTHORIZED',
    'ORDER_CONFIDENCE_EVALUATED',
    'ORDER_CONFIDENCE_CHANGED',
    'ORDER_CONFIDENCE_APPROVED',
    'ORDER_CONFIDENCE_VERIFIED',
    'INBOX_MESSAGE_SENT',
    'PRODUCT_STOCK_UPDATED',
    'PRODUCT_DRAFT_CREATED',
    'CONVERSATION_OWNERSHIP_UPDATE',
    'ai_draft_approved',
    'ai_draft_dismissed',
    'CHANNEL_AUTOMATION_OVERRIDE_CHANGED',
    'AI_REPLY_MODE_CHANGED',
    'AI_EMERGENCY_STOP_ENGAGED',
    'AI_EMERGENCY_STOP_RESUMED',
    'SHOP_MEMBERSHIP_GRANTED',
    'SHOP_MEMBERSHIP_REVOKED',
    'SHOP_MEMBERSHIP_ROLE_CHANGED',
    'OPPORTUNITY_DISMISSED',
    // Bare generic actions (customer CRUD etc.):
    'CREATE',
    'UPDATE',
    'DELETE',
]);

// Lower-cased canonical resource spellings (covers 'order'/'ORDER',
// 'product'/'PRODUCT', 'conversation'/'CONVERSATION', …).
const MERCHANT_RESOURCES = Object.freeze([
    'order',
    'product',
    'conversation',
    'conversation_message',
    'conversation_ownership',
    'customer',
    'shop',
    'user_shop',
    'meta_channel',
    'meta_channel_settings',
    'shop_settings',
    'customer_opportunity',
]);

const ACTION_MEMBERSHIP = new Set(MERCHANT_ACTIONS.map((action) => action.toLowerCase()));
const RESOURCE_MEMBERSHIP = new Set(MERCHANT_RESOURCES.map((resource) => resource.toLowerCase()));

const ACTIVITY_LIMIT = 6;

/** Case-aware membership test — exported for unit tests. */
const isMerchantOperationalEvent = ({ action, resource_type: resourceType } = {}) => (
    typeof action === 'string'
    && ACTION_MEMBERSHIP.has(action.toLowerCase())
    && typeof resourceType === 'string'
    && RESOURCE_MEMBERSHIP.has(resourceType.toLowerCase())
);

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

/**
 * Recent merchant-operational activity (doc 05 §4). tenantAuditView-style
 * projection ONLY: id/action/resourceType/occurredAt/resource_id/user.
 * old_values/new_values/metadata/ip_address/user_agent are never fetched
 * (explicit `attributes`) and never serialized. The actor is the STORED user
 * (`user_id`, NULL = system ⇒ `user: null` — the client renders "System";
 * there is NO AI/Provider inference). User join is LEFT (required:false) so
 * system rows survive; the limit applies AFTER the SQL vocabulary filter.
 */
async function recentActivity(AuditLog, shopId, User) {
    const include = User
        ? [{ model: User, as: 'user', attributes: ['id', 'full_name'], required: false }]
        : [];

    const rows = await AuditLog.findAll({
        where: {
            // Tenant scope FIRST — a cross-tenant row can never appear.
            shop_id: shopId,
            [Op.and]: [
                sequelizeWhere(fn('LOWER', col('action')), { [Op.in]: [...ACTION_MEMBERSHIP] }),
                sequelizeWhere(fn('LOWER', col('resource_type')), { [Op.in]: [...RESOURCE_MEMBERSHIP] }),
            ],
        },
        attributes: ['id', 'action', 'resource_type', 'resource_id', 'created_at'],
        include,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: ACTIVITY_LIMIT,
    });

    const projected = (Array.isArray(rows) ? rows : []).map((row) => {
        const data = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
        const user = data?.user && data.user.id
            ? { id: data.user.id, full_name: data.user.full_name }
            : null;
        return {
            id: data.id,
            action: data.action,
            resourceType: data.resource_type,
            occurredAt: new Date(data.created_at).toISOString(),
            resource_id: data.resource_id ?? null,
            user,
        };
    });

    // Defense in depth (case-aware): the SQL filter already excludes rogue
    // vocabulary; re-check membership so a rogue row can never leak even if
    // the database-side predicate is weakened.
    return projected.filter((item) => isMerchantOperationalEvent({
        action: item.action,
        resource_type: item.resourceType,
    }));
}

/** Both reads are isolated; failure never becomes zero or blocks the queue.
 * Billing occurred_at is DATEONLY UTC by contract, not Dhaka delivery time.
 * This is current positive ledger charges, NOT paid invoices, net credits or
 * proof of a live courier booking. No mutation or new permission.
 */
async function getCommerceSignals({ shopId, BillingLine, AuditLog, User, now = new Date() }) {
    if (!shopId) return { deliveredCharges: null, recentActivity: null };
    const dayUtc = now.toISOString().slice(0, 10);
    const [billing, activity] = await Promise.allSettled([
        deliveredCharges(BillingLine, shopId, dayUtc),
        recentActivity(AuditLog, shopId, User),
    ]);
    return {
        deliveredCharges: billing.status === 'fulfilled' ? billing.value : null,
        recentActivity: activity.status === 'fulfilled' ? activity.value : null,
    };
}

module.exports = {
    getCommerceSignals,
    isMerchantOperationalEvent,
    MERCHANT_ACTIONS,
    MERCHANT_RESOURCES,
    ACTIVITY_LIMIT,
};
