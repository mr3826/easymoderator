'use strict';

/**
 * P+03 action queue read-model tests: one item per source fact, authoritative
 * removal after resolution, operational-risk ordering, shop isolation,
 * fail-closed partiality — with NO task table anywhere.
 */

process.env.NODE_ENV = 'test';

jest.mock('../../entities', () => ({
    Conversation: { findAll: jest.fn() },
    Message: { findAll: jest.fn() },
    InboxDeliveryOutbox: { findAll: jest.fn() },
    CustomerOpportunity: { findAll: jest.fn() },
}));
jest.mock('../../order/order-session.entity', () => ({ findAll: jest.fn() }));
jest.mock('../../pilot-features/pilot-features.service', () => ({
    isCustomerIntelligenceEnabled: jest.fn(async () => false),
    isKnowledgeSuggestionsEnabled: jest.fn(async () => false),
}));

const E = require('../../entities');
const OrderSession = require('../../order/order-session.entity');
const pilot = require('../../pilot-features/pilot-features.service');
const { getInboxActions } = require('../inbox-actions.service');
const { ACTION_BUCKETS, ACTION_REASONS } = require('../action-reasons');

const conv = (over = {}) => ({
    id: 'conv-1', customer_id: 'cust-1', hitl: false, assignee_id: null,
    status: 'active', updated_at: new Date('2026-10-24T10:00:00Z'), metadata: {}, ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    E.Conversation.findAll.mockResolvedValue([conv()]);
    E.Message.findAll.mockResolvedValue([]);
    E.InboxDeliveryOutbox.findAll.mockResolvedValue([]);
    OrderSession.findAll.mockResolvedValue([]);
    E.CustomerOpportunity.findAll.mockResolvedValue([]);
});

test('one open handoff = exactly one actionable item; resolution removes it', async () => {
    E.Conversation.findAll.mockResolvedValue([conv({ hitl: true, metadata: { handoff_reason: 'sentiment_escalation' } })]);
    const first = await getInboxActions('shop-1');
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
        bucket: ACTION_BUCKETS.NEEDS_HUMAN,
        reason_code: ACTION_REASONS.HANDOFF_SUSPENDED_CHECKOUT,
        conversation_id: 'conv-1',
        next_action: { type: 'open_conversation' },
    });
    // repeated read is stable (no persistence, no duplicates)
    const again = await getInboxActions('shop-1');
    expect(again.items).toHaveLength(1);
    expect(again.items[0].item_key).toBe(first.items[0].item_key);

    // merchant resolves the source fact -> item disappears at once
    E.Conversation.findAll.mockResolvedValue([conv({ hitl: false })]);
    const after = await getInboxActions('shop-1');
    expect(after.items).toHaveLength(0);
});

test('a MANUAL takeover reason is classified as manual, never HANDOFF_SUSPENDED_CHECKOUT', async () => {
    E.Conversation.findAll.mockResolvedValue([conv({
        hitl: true,
        metadata: {
            // A concurrent SYSTEM reason must not win over the merchant's reason.
            handoff_reason: 'sentiment_escalation',
            manual_handoff_reason: 'customer_request',
        },
    })]);

    const res = await getInboxActions('shop-1');
    const item = res.items.find((i) => i.bucket === ACTION_BUCKETS.NEEDS_HUMAN);
    expect(item).toMatchObject({
        reason_code: ACTION_REASONS.HITL_REQUIRED,
        handoff_source: 'manual',
        manual_handoff_reason: 'customer_request',
    });
    expect(item.reason_code).not.toBe(ACTION_REASONS.HANDOFF_SUSPENDED_CHECKOUT);
});

test('system handoff_reason keeps the suspended-checkout classification', async () => {
    E.Conversation.findAll.mockResolvedValue([conv({
        hitl: true,
        metadata: { handoff_reason: 'low_confidence' },
    })]);

    const res = await getInboxActions('shop-1');
    expect(res.items[0]).toMatchObject({
        reason_code: ACTION_REASONS.HANDOFF_SUSPENDED_CHECKOUT,
        handoff_source: 'system',
    });
});

test('committed-without-ack outranks drafts and never double-lists the same message', async () => {
    E.Conversation.findAll.mockResolvedValue([conv({ hitl: true })]);
    E.Message.findAll.mockImplementation(async ({ where }) => {
        const states = where.delivery_state[Object.getOwnPropertySymbols(where.delivery_state)[0]];
        return states.includes('FAILED')
            ? [{
                id: 'msg-f', conversation_id: 'conv-1', created_at: new Date('2026-10-24T09:00:00Z'),
                delivery_state: 'FAILED', metadata: { executed_mutation_without_outbound_send: true },
            }]
            : [{ id: 'msg-f', conversation_id: 'conv-1', created_at: new Date(), delivery_state: 'DRAFT_READY', metadata: { executed_mutation_without_outbound_send: true } }];
    });

    const res = await getInboxActions('shop-1');
    const buckets = res.items.map((i) => i.bucket);
    expect(buckets).toEqual([
        ACTION_BUCKETS.NEEDS_HUMAN,
        ACTION_BUCKETS.COMMITTED_WITHOUT_ACK,
    ]); // draft copy of the same fact suppressed
    expect(res.items[1].reason_code).toBe(ACTION_REASONS.SEND_FAILED_AFTER_MUTATION);
});

test('suspended checkout is a blocked-customer item with its grounded deadline', async () => {
    E.Conversation.findAll.mockResolvedValue([conv()]);
    OrderSession.findAll.mockResolvedValue([{
        id: 'sess-1', shop_id: 'shop-1', customer_id: 'cust-1', conversation_id: 'conv-1',
        status: 'SUSPENDED', current_step: 'COLLECTING_ADDRESS', step_data: { suspended_reason: 'HUMAN_HANDOFF_REQUEST' },
        last_activity_at: new Date('2026-10-24T08:00:00Z'),
        expires_at: new Date('2026-10-26T08:00:00Z'),
    }]);

    const res = await getInboxActions('shop-1');
    const item = res.items.find((i) => i.source.type === 'order_session');
    expect(item).toMatchObject({
        bucket: ACTION_BUCKETS.CUSTOMER_BLOCKED,
        reason_code: ACTION_REASONS.CHECKOUT_WAITING_CUSTOMER,
        status: 'suspended',
        next_action: { type: 'resume_checkout', step: 'COLLECTING_ADDRESS' },
    });
    expect(item.grounded_deadline).toBe('2026-10-26T08:00:00.000Z');
});

test('ACTIVE session is listed only when deferred AND waiting > 15 minutes', async () => {
    const fresh = {
        id: 'sess-2', status: 'ACTIVE', current_step: 'COLLECTING_NAME',
        step_data: { awaiting_resume: 'COLLECTING_NAME' },
        last_activity_at: new Date(), expires_at: null,
    };
    OrderSession.findAll.mockResolvedValue([fresh]);
    expect((await getInboxActions('shop-1')).items.filter((i) => i.source.type === 'order_session')).toHaveLength(0);

    OrderSession.findAll.mockResolvedValue([{
        ...fresh, last_activity_at: new Date(Date.now() - 16 * 60 * 1000),
    }]);
    expect((await getInboxActions('shop-1')).items.filter((i) => i.source.type === 'order_session')).toHaveLength(1);
});

test('opportunities appear only for flagged shops and match the authoritative rows', async () => {
    E.CustomerOpportunity.findAll.mockResolvedValue([{
        id: 'opp-1', conversation_id: 'conv-1', customer_id: 'cust-1',
        strength: 'HIGH', status: 'OPEN', last_signal_at: new Date('2026-10-24T09:00:00Z'),
    }]);
    expect((await getInboxActions('shop-1')).items.filter((i) => i.source.type === 'customer_opportunity')).toHaveLength(0);

    pilot.isCustomerIntelligenceEnabled.mockResolvedValue(true);
    const res = await getInboxActions('shop-1');
    const item = res.items.find((i) => i.source.type === 'customer_opportunity');
    expect(item).toMatchObject({
        bucket: ACTION_BUCKETS.PURCHASE_OPPORTUNITY,
        source: { type: 'customer_opportunity', id: 'opp-1' },
        next_action: { type: 'review_opportunity', strength: 'HIGH' },
    });
});

test('every bucket query is shop-scoped; messages are scoped via shop conversations', async () => {
    await getInboxActions('shop-1');
    expect(E.Conversation.findAll.mock.calls[0][0].where.shop_id).toBe('shop-1');
    expect(E.InboxDeliveryOutbox.findAll.mock.calls[0][0].where.shop_id).toBe('shop-1');
    expect(OrderSession.findAll.mock.calls[0][0].where.shop_id).toBe('shop-1');
    const msgWhere = E.Message.findAll.mock.calls[0][0].where;
    const inSym = Object.getOwnPropertySymbols(msgWhere.conversation_id)[0];
    expect(msgWhere.conversation_id[inSym]).toEqual(['conv-1']); // ids from THIS shop
});

test('a failing source marks the queue partial instead of fabricating or blocking', async () => {
    E.Conversation.findAll.mockRejectedValue(new Error('db down'));
    E.InboxDeliveryOutbox.findAll.mockRejectedValue(new Error('db down'));
    OrderSession.findAll.mockRejectedValue(new Error('db down'));
    const res = await getInboxActions('shop-1');
    expect(res.partial).toBe(true);
    expect(res.items).toEqual([]);
});

test('the queue is capped and ordered by operational risk', async () => {
    E.Conversation.findAll.mockResolvedValue(
        Array.from({ length: 60 }, (_, i) => conv({ id: `conv-${i}`, hitl: true })),
    );
    const res = await getInboxActions('shop-1');
    expect(res.items.length).toBeLessThanOrEqual(50);
    expect(new Set(res.items.map((i) => i.bucket))).toEqual(new Set([ACTION_BUCKETS.NEEDS_HUMAN]));
});

// ─── MW-V1 Phase 6: server-backed views + counts ────────────────────────────
test('counts.by_bucket reflects ALL collected work, not just the returned page', async () => {
    E.Conversation.findAll.mockResolvedValue([
        conv({ id: 'c1', hitl: true, assignee_id: null }),
        conv({ id: 'c2', hitl: true, assignee_id: 'staff-9' }),
        conv({ id: 'c3', hitl: true, assignee_id: 'staff-9' }),
        conv({ id: 'c4', hitl: true, assignee_id: 'staff-8' }),
    ]);
    E.InboxDeliveryOutbox.findAll.mockResolvedValue([
        { id: 'ob-1', conversation_id: 'c1', status: 'NEEDS_RECONCILIATION', updated_at: new Date(), metadata: {} },
    ]);

    const res = await getInboxActions('shop-1', { actorUserId: 'staff-9' });

    expect(res.counts).toBeTruthy();
    expect(res.counts.by_bucket[ACTION_BUCKETS.NEEDS_HUMAN]).toBe(4);
    expect(res.counts.by_bucket[ACTION_BUCKETS.COMMITTED_WITHOUT_ACK]).toBe(1);
    expect(res.counts.total).toBe(5);
});

test('views filter server-side; mine/unassigned/handoff/recovery agree with the items they count', async () => {
    E.Conversation.findAll.mockResolvedValue([
        conv({ id: 'c1', hitl: true, assignee_id: null }),
        conv({ id: 'c2', hitl: true, assignee_id: 'staff-9' }),
    ]);
    E.InboxDeliveryOutbox.findAll.mockResolvedValue([
        { id: 'ob-1', conversation_id: 'c1', status: 'NEEDS_RECONCILIATION', updated_at: new Date(), metadata: {} },
    ]);

    const mine = await getInboxActions('shop-1', { view: 'mine', actorUserId: 'staff-9' });
    expect(mine.items.map((i) => i.item_key)).toEqual([`hitl:c2`]);
    expect(mine.counts.views.mine).toBe(1);

    const unassigned = await getInboxActions('shop-1', { view: 'unassigned' });
    expect(unassigned.items.map((i) => i.item_key)).toEqual(['hitl:c1']);

    const handoff = await getInboxActions('shop-1', { view: 'handoff' });
    expect(handoff.items).toHaveLength(2);

    const recovery = await getInboxActions('shop-1', { view: 'recovery' });
    expect(recovery.items.every((i) => i.bucket === ACTION_BUCKETS.COMMITTED_WITHOUT_ACK)).toBe(true);

    const attention = await getInboxActions('shop-1', { view: 'attention' });
    expect(attention.items).toHaveLength(3);
});

test('unknown views fall back to attention rather than silently returning nothing', async () => {
    const res = await getInboxActions('shop-1', { view: 'bogus' });
    expect(res.counts.views).toHaveProperty('attention');
    expect(res.items).toHaveLength(0); // base fixture: no open work
});
