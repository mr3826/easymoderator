'use strict';

const { Op, fn, col, where: sequelizeWhere } = require('sequelize');
const {
    getCommerceSignals,
    isMerchantOperationalEvent,
    MERCHANT_ACTIONS,
    MERCHANT_RESOURCES,
} = require('../dashboard-commerce-signals.service');

const now = new Date('2026-11-24T00:30:00Z');
const shopId = 'shop-a';

const auditRow = (overrides = {}) => ({
    id: 'audit-1',
    action: 'ORDER_CONFIRMED',
    resource_type: 'order',
    resource_id: 'order-1',
    created_at: now,
    user: { id: 'user-1', full_name: 'Rina Begum' },
    ...overrides,
});

const models = (activityRows = [auditRow()]) => ({
    BillingLine: { findAll: jest.fn().mockResolvedValue([{ count: '2', amountMinor: '2000' }]) },
    AuditLog: { findAll: jest.fn().mockResolvedValue(activityRows) },
    User: {},
});

describe('D4 merchant-operational vocabulary (case-aware, real literals)', () => {
    const included = [
        // web + mobile order lifecycle (doc 05 §4)
        ['ORDER_CREATED', 'order'],
        ['ORDER_CONFIRMED', 'order'],
        ['ORDER_CANCELLED', 'order'],
        ['COURIER_BOOKED', 'order'],
        ['COURIER_BOOKING_AUTHORIZED', 'order'],
        // order-confidence family (wildcards enumerated from real writers)
        ['ORDER_CONFIDENCE_EVALUATED', 'ORDER'],
        ['ORDER_CONFIDENCE_CHANGED', 'ORDER'],
        ['ORDER_CONFIDENCE_APPROVED', 'ORDER'],
        ['ORDER_CONFIDENCE_VERIFIED', 'ORDER'],
        // inbox + AI draft lifecycle
        ['INBOX_MESSAGE_SENT', 'conversation_message'],
        ['ai_draft_approved', 'conversation_message'],
        ['ai_draft_dismissed', 'conversation_message'],
        ['CONVERSATION_OWNERSHIP_UPDATE', 'conversation_ownership'],
        // product
        ['PRODUCT_STOCK_UPDATED', 'product'],
        ['PRODUCT_DRAFT_CREATED', 'product'],
        // settings / safety / membership
        ['CHANNEL_AUTOMATION_OVERRIDE_CHANGED', 'META_CHANNEL_SETTINGS'],
        ['AI_REPLY_MODE_CHANGED', 'SHOP'],
        ['AI_EMERGENCY_STOP_ENGAGED', 'SHOP'],
        ['AI_EMERGENCY_STOP_RESUMED', 'SHOP'],
        ['SHOP_MEMBERSHIP_GRANTED', 'USER_SHOP'],
        ['SHOP_MEMBERSHIP_REVOKED', 'USER_SHOP'],
        ['SHOP_MEMBERSHIP_ROLE_CHANGED', 'USER_SHOP'],
        ['OPPORTUNITY_DISMISSED', 'CUSTOMER_OPPORTUNITY'],
        // generic bare actions
        ['CREATE', 'CUSTOMER'],
        ['UPDATE', 'CUSTOMER'],
        ['DELETE', 'CUSTOMER'],
        ['UPDATE', 'shop_settings'],
    ];
    it.each(included)('includes the real writer %s on %s', (action, resource_type) => {
        expect(isMerchantOperationalEvent({ action, resource_type })).toBe(true);
    });

    const excluded = [
        ['job:session_cleanup', 'SYSTEM'],
        ['admin:add_credits', 'SUBSCRIPTION'],
        ['admin:emergency_ai_off', 'SHOP'],
        ['growth_os:prospect_updated', 'GROWTH_OS_ADMIN_MERCHANT'],
        ['funnel:event', 'FUNNEL'],
        ['SESSION_CREATED', 'USER'],
        ['TOKEN_REFRESH', 'USER'],
        ['usage_tracked', 'SUBSCRIPTION'],
        ['RTO_NETWORK_SETTINGS_UPDATED', 'shop_settings'],
        ['AI_PAUSED', 'conversation'],
        ['INBOX_MESSAGE_QUEUED', 'conversation_message'],
        ['ORDER_CONFIRM', 'ORDER'], // the fictional #311 vocabulary must be OUT
        ['ORDER_CANCEL', 'ORDER'],
        ['CHANNEL_CONNECT', 'CHANNEL'],
        ['HUMAN_TAKEOVER', 'CONVERSATION'],
        ['AI_SUGGESTION_ACCEPTED', 'MESSAGE'],
        ['PAYMENT_PROCESS', 'PAYMENT'],
        ['ORDER_CONFIRMED', undefined],
        ['ORDER_CONFIRMED', 'user_shop_extra'],
    ];
    it.each(excluded)('excludes rogue/noise %s on %s', (action, resource_type) => {
        expect(isMerchantOperationalEvent({ action, resource_type })).toBe(false);
    });

    it('is case-aware in both directions', () => {
        expect(isMerchantOperationalEvent({ action: 'order_confirmed', resource_type: 'ORDER' })).toBe(true);
        expect(isMerchantOperationalEvent({ action: 'ai_draft_approved', resource_type: 'CONVERSATION_MESSAGE' })).toBe(true);
        expect(isMerchantOperationalEvent({ action: 'CREATE', resource_type: 'Customer' })).toBe(true);
    });

    it('keeps the allowlist frozen and duplicate-free', () => {
        expect(Object.isFrozen(MERCHANT_ACTIONS)).toBe(true);
        expect(Object.isFrozen(MERCHANT_RESOURCES)).toBe(true);
        expect(new Set(MERCHANT_ACTIONS.map((a) => a.toLowerCase())).size).toBe(MERCHANT_ACTIONS.length);
    });
});

describe('D5 deliveredCharges (kept #311 UTC-day ledger query)', () => {
    it('aggregates only billable DELIVERED BDT positive-minor rows of the UTC day, tenant-scoped FIRST', async () => {
        const m = models([]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.deliveredCharges).toEqual({ dayUtc: '2026-11-24', count: 2, amountMinor: 2000 });
        expect(m.BillingLine.findAll.mock.calls[0][0].where).toEqual({
            shop_id: shopId,
            occurred_at: '2026-11-24',
            line_kind: 'billable',
            outcome: 'DELIVERED',
            currency: 'BDT',
            amount_minor: { [Op.gt]: 0 },
        });
    });

    it('UTC-day boundary + late-webhook backdate semantics: equality on the UTC calendar day, never a local window', async () => {
        const boundary = models([]);
        await getCommerceSignals({ shopId, now: new Date('2026-11-24T23:59:59Z'), ...boundary });
        expect(boundary.BillingLine.findAll.mock.calls[0][0].where.occurred_at).toBe('2026-11-24');

        const rolled = models([]);
        await getCommerceSignals({ shopId, now: new Date('2026-11-25T00:00:00Z'), ...rolled });
        expect(rolled.BillingLine.findAll.mock.calls[0][0].where.occurred_at).toBe('2026-11-25');
    });

    it('renders minor units as safe integers only', async () => {
        const m = models([]);
        m.BillingLine.findAll.mockResolvedValue([{ count: '7', amountMinor: '999999999999999' }]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.deliveredCharges.amountMinor).toBe(999999999999999);
        expect(Number.isSafeInteger(result.deliveredCharges.amountMinor)).toBe(true);
    });

    it('reversal-shrink: a mutated-to-zero-rated/cancelled row is EXCLUDED, so the day total drops (never negative rows)', async () => {
        const m = models([]);
        m.BillingLine.findAll
            .mockResolvedValueOnce([{ count: '2', amountMinor: '20000' }])
            .mockResolvedValueOnce([{ count: '1', amountMinor: '10000' }]);
        const before = await getCommerceSignals({ shopId, now, ...m });
        const afterReturn = await getCommerceSignals({ shopId, now, ...m });
        expect(before.deliveredCharges.amountMinor).toBe(20000);
        expect(afterReturn.deliveredCharges.amountMinor).toBe(10000);
        // A RETURNED/CANCELLED line becomes a ZERO_RATED line (ADR-0011): the
        // predicate (line_kind billable + amount_minor > 0) excludes it — the
        // sum shrinks because the row stops matching, never because a negative
        // row was subtracted.
        expect(m.BillingLine.findAll.mock.calls[1][0].where.amount_minor[Op.gt]).toBe(0);
    });

    it('rejects missing or corrupt aggregates → null, never a fake zero', async () => {
        const missing = models([]);
        missing.BillingLine.findAll.mockResolvedValue([]);
        expect((await getCommerceSignals({ shopId, now, ...missing })).deliveredCharges).toBeNull();

        const corrupt = models([]);
        corrupt.BillingLine.findAll.mockResolvedValue([{ count: '-2', amountMinor: '2000' }]);
        expect((await getCommerceSignals({ shopId, now, ...corrupt })).deliveredCharges).toBeNull();
    });
});

describe('D4 recentActivity (AuditLog via tenantAuditView-style projection)', () => {
    it('scopes tenant FIRST, filters the case-aware vocabulary SQL-side, joins the stored actor LEFT, and caps at 6', async () => {
        const m = models([]);
        await getCommerceSignals({ shopId, now, ...m });
        const options = m.AuditLog.findAll.mock.calls[0][0];
        expect(Object.keys(options.where)[0]).toBe('shop_id');
        expect(options.where.shop_id).toBe(shopId);
        expect(options.where[Op.and]).toEqual([
            sequelizeWhere(fn('LOWER', col('action')), { [Op.in]: MERCHANT_ACTIONS.map((a) => a.toLowerCase()) }),
            sequelizeWhere(fn('LOWER', col('resource_type')), { [Op.in]: MERCHANT_RESOURCES.map((r) => r.toLowerCase()) }),
        ]);
        expect(options.attributes).toEqual(['id', 'action', 'resource_type', 'resource_id', 'created_at']);
        expect(options.include).toEqual([{ model: m.User, as: 'user', attributes: ['id', 'full_name'], required: false }]);
        expect(options.order).toEqual([['created_at', 'DESC'], ['id', 'DESC']]);
        expect(options.limit).toBe(6);
    });

    it('projects exactly {id, action, resourceType, occurredAt, resource_id, user} — NEVER values/metadata/IP/UA', async () => {
        const m = models([auditRow({
            old_values: { secret: 1 },
            new_values: { secret: 2 },
            metadata: { phone: '01711111111', ip_address: '1.2.3.4', user_agent: 'curl' },
            ip_address: '1.2.3.4',
            user_agent: 'curl',
            user_id: 'user-1',
            shop_id: 'other-shop',
        })]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.recentActivity).toEqual([{
            id: 'audit-1',
            action: 'ORDER_CONFIRMED',
            resourceType: 'order',
            occurredAt: now.toISOString(),
            resource_id: 'order-1',
            user: { id: 'user-1', full_name: 'Rina Begum' },
        }]);
        const serialized = JSON.stringify(result);
        for (const leak of ['old_values', 'new_values', 'metadata', 'ip_address', 'user_agent', 'user_id', '01711111111', 'shop_id']) {
            expect(serialized).not.toContain(leak);
        }
    });

    it('system rows (no stored user) project user:null and survive (LEFT join), case-aware', async () => {
        const m = models([auditRow({
            action: 'ai_draft_approved',
            resource_type: 'CONVERSATION_MESSAGE',
            user: null,
        })]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.recentActivity).toEqual([{
            id: 'audit-1',
            action: 'ai_draft_approved',
            resourceType: 'CONVERSATION_MESSAGE',
            occurredAt: now.toISOString(),
            resource_id: 'order-1',
            user: null,
        }]);
    });

    it('defense-in-depth: a rogue row returned by the database is dropped by the JS re-check', async () => {
        const m = models([
            auditRow(),
            auditRow({ id: 'rogue-1', action: 'admin:emergency_ai_off', resource_type: 'SHOP' }),
            auditRow({ id: 'rogue-2', action: 'job:tick', resource_type: 'order' }),
            auditRow({ id: 'rogue-3', action: 'ORDER_CONFIRM', resource_type: 'ORDER' }), // #311 fiction must NOT leak
        ]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.recentActivity.map((item) => item.id)).toEqual(['audit-1']);
    });

    it('supports Sequelize instances (row.get) as well as plain mock rows', async () => {
        const m = models([{
            get: ({ plain }) => plain ? auditRow({ resource_id: 'order-7' }) : {},
        }]);
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result.recentActivity[0].resource_id).toBe('order-7');
    });

    it('without a User model degrades honestly: user:null (never a fabricated actor)', async () => {
        // No include → a real Sequelize row carries no `user` association at all.
        const rowWithoutUser = auditRow();
        delete rowWithoutUser.user;
        const m = models([rowWithoutUser]);
        const result = await getCommerceSignals({ shopId, now, BillingLine: m.BillingLine, AuditLog: m.AuditLog });
        expect(result.recentActivity[0].user).toBeNull();
        expect(m.AuditLog.findAll.mock.calls[0][0].include).toEqual([]);
    });
});

describe('getCommerceSignals envelope honesty', () => {
    it('distinguishes verified zero from failed source, per sub-source', async () => {
        const m = models();
        m.BillingLine.findAll.mockResolvedValue([{ count: '0', amountMinor: '0' }]);
        m.AuditLog.findAll.mockRejectedValue(new Error('unavailable'));
        expect(await getCommerceSignals({ shopId, now, ...m }))
            .toEqual({ deliveredCharges: { dayUtc: '2026-11-24', count: 0, amountMinor: 0 }, recentActivity: null });
        m.BillingLine.findAll.mockRejectedValue(new Error('unavailable'));
        expect((await getCommerceSignals({ shopId, now, ...m })).deliveredCharges).toBeNull();
    });

    it('never queries unscoped data', async () => {
        const m = models();
        expect(await getCommerceSignals({ now, ...m })).toEqual({ deliveredCharges: null, recentActivity: null });
        expect(m.BillingLine.findAll).not.toHaveBeenCalled();
        expect(m.AuditLog.findAll).not.toHaveBeenCalled();
    });
});
