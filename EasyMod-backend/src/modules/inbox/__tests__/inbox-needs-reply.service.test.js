'use strict';

const { Op } = require('sequelize');

jest.mock('../../shop/ai-reply-mode', () => ({
    getEffectiveAiReplyMode: jest.fn().mockResolvedValue('DRAFT'),
    normalizeAiReplyMode: (value) => value,
}));

const {
    getNeedsReplyCount,
    NEEDS_REPLY_SCAN_CAP,
    MESSAGE_SCAN_ATTRIBUTES,
} = require('../inbox-needs-reply.service');

const shopId = 'shop-a';
const now = new Date('2026-11-24T10:00:00.000Z');

const conversation = (id, overrides = {}) => ({
    id,
    status: 'active',
    hitl: false,
    metadata: {},
    updated_at: now,
    meta_channel_id: null,
    ...overrides,
});

/**
 * Stand-in for deriveWorkflowProjection: verdict pinned per row via the
 * `flagged` marker. Parity of the REAL verdict is conversation.service's own
 * contract (this service consumes it verbatim via the additive export).
 */
const projection = (conversationRow) => ({
    needs_merchant_reply: conversationRow?.flagged === true,
    needs_merchant_reply_reason: conversationRow?.flagged === true ? 'CUSTOMER_UNANSWERED' : null,
    ai_is_replying: false,
});

const wireMessages = (rows = []) => rows.map((message) => ({
    id: message.id,
    conversation_id: message.conversation_id,
    sender: message.sender,
    created_at: message.created_at,
    delivery_state: message.delivery_state,
    delivery_source: message.delivery_source,
    provider_message_id: message.provider_message_id,
    metadata: message.metadata,
}));

const makeModels = ({ rows = [], total = rows.length, messages = [] } = {}) => {
    const Conversation = {
        findAll: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(total),
    };
    const Message = { findAll: jest.fn().mockResolvedValue(wireMessages(messages)) };
    return { Conversation, Message };
};

const baseArgs = (overrides = {}) => ({
    shopId,
    now,
    deriveWorkflowProjection: projection,
    aiReplyMode: 'MANUAL',
    ...overrides,
});

describe('C1 inbox-needs-reply.service (doc 05 §1)', () => {
    it('scans open conversations tenant-scoped FIRST, capped 200, updated_at DESC', async () => {
        const models = makeModels();
        await getNeedsReplyCount(baseArgs(models));

        const options = models.Conversation.findAll.mock.calls[0][0];
        expect(Object.keys(options.where)).toContain('shop_id');
        expect(options.where.shop_id).toBe(shopId);
        expect(options.where.status).toEqual({ [Op.notIn]: ['closed', 'archived'] });
        expect(options.attributes).toEqual(['id', 'status', 'hitl', 'metadata', 'updated_at', 'meta_channel_id']);
        expect(options.order).toEqual([['updated_at', 'DESC']]);
        expect(options.limit).toBe(NEEDS_REPLY_SCAN_CAP);
        expect(options.limit).toBe(200);
        expect(models.Conversation.count.mock.calls[0][0].where.status).toEqual({ [Op.notIn]: ['closed', 'archived'] });
    });

    it('fetches messages with ONE batched query using the Inbox projection attribute set (never content beyond it)', async () => {
        const models = makeModels({
            rows: [conversation('c-1'), conversation('c-2')],
            messages: [
                { id: 'm-1', conversation_id: 'c-1', sender: 'customer' },
                { id: 'm-2', conversation_id: 'c-2', sender: 'ai' },
                { id: 'm-3', conversation_id: 'c-1', sender: 'business' },
            ],
        });
        await getNeedsReplyCount(baseArgs(models));

        expect(models.Message.findAll).toHaveBeenCalledTimes(1);
        const options = models.Message.findAll.mock.calls[0][0];
        expect(options.where.conversation_id[Op.in]).toEqual(['c-1', 'c-2']);
        expect(options.attributes).toEqual(MESSAGE_SCAN_ATTRIBUTES);
        expect(options.attributes).not.toContain('content');
    });

    it('skips the message query entirely for an empty scan', async () => {
        const models = makeModels();
        const result = await getNeedsReplyCount(baseArgs(models));
        expect(models.Message.findAll).not.toHaveBeenCalled();
        expect(result.count).toBe(0);
        expect(result.scanned).toBe(0);
    });

    it('counts only needs_merchant_reply === true (strict) and groups per conversation', async () => {
        const rows = [
            conversation('c-1', { flagged: true }),
            conversation('c-2', { flagged: false }),
            conversation('c-3', { flagged: true }),
        ];
        const models = makeModels({
            rows,
            messages: [
                { id: 'm-1', conversation_id: 'c-1', sender: 'customer' },
                { id: 'm-2', conversation_id: 'c-3', sender: 'customer' },
            ],
        });
        const seen = [];
        const result = await getNeedsReplyCount(baseArgs({
            ...models,
            deriveWorkflowProjection: (conversationRow, messages, aiReplyModeArg) => {
                seen.push({
                    id: conversationRow.id,
                    messages,
                    aiReplyMode: aiReplyModeArg,
                });
                return projection(conversationRow);
            },
        }));

        expect(result.count).toBe(2);
        expect(result.scanned).toBe(3);
        // Per-row messages come from the batched map (c-2 gets none).
        expect(seen.find((s) => s.id === 'c-1').messages).toHaveLength(1);
        expect(seen.find((s) => s.id === 'c-2').messages).toEqual([]);
        expect(seen.find((s) => s.id === 'c-3').messages).toHaveLength(1);
        expect(seen.every((s) => s.aiReplyMode === 'MANUAL')).toBe(true);
    });

    it('coverageComplete is honest: true only when the bounded scan saw every open conversation', async () => {
        const full = makeModels({ rows: [conversation('c-1')], total: 1 });
        expect((await getNeedsReplyCount(baseArgs(full))).coverageComplete).toBe(true);

        const truncated = makeModels({
            rows: Array.from({ length: 200 }, (_, index) => conversation(`c-${index}`)),
            total: 250,
        });
        const truncatedResult = await getNeedsReplyCount(baseArgs(truncated));
        expect(truncatedResult.scanned).toBe(200);
        expect(truncatedResult.coverageComplete).toBe(false);

        const partial = makeModels({
            rows: [conversation('c-1'), conversation('c-2')],
            total: 5,
        });
        expect((await getNeedsReplyCount(baseArgs(partial))).coverageComplete).toBe(false);

        // scanned === cap ⇒ never complete, even when counts agree.
        const atCap = makeModels({
            rows: Array.from({ length: 200 }, (_, index) => conversation(`c-${index}`)),
            total: 200,
        });
        expect((await getNeedsReplyCount(baseArgs(atCap))).coverageComplete).toBe(false);
    });

    it('carries cap + server-clock generated_at in the payload', async () => {
        const models = makeModels();
        const result = await getNeedsReplyCount(baseArgs(models));
        expect(result).toEqual({
            count: 0,
            scanned: 0,
            cap: 200,
            coverageComplete: true,
            generated_at: '2026-11-24T10:00:00.000Z',
        });
    });

    it('rejects (never answers 0) on any read failure — the route maps this to 5xx, the client to null', async () => {
        const dbDown = {
            Conversation: { findAll: jest.fn().mockRejectedValue(new Error('db down')), count: jest.fn() },
            Message: { findAll: jest.fn() },
        };
        await expect(getNeedsReplyCount(baseArgs(dbDown))).rejects.toThrow('db down');

        const badProjection = makeModels({ rows: [conversation('c-1')] });
        await expect(getNeedsReplyCount(baseArgs({
            ...badProjection,
            deriveWorkflowProjection: () => { throw new Error('projection crashed'); },
        }))).rejects.toThrow('projection crashed');
    });

    it('requires the tenant scope — no shopId, no query', async () => {
        const models = makeModels();
        await expect(getNeedsReplyCount(baseArgs({ ...models, shopId: null }))).rejects.toThrow(/tenant scope/);
        expect(models.Conversation.findAll).not.toHaveBeenCalled();
    });

    it('resolves the shop aiReplyMode the way the Inbox list does when not injected', async () => {
        const { getEffectiveAiReplyMode } = require('../../shop/ai-reply-mode');
        const models = makeModels({ rows: [conversation('c-1', { flagged: true })] });
        let receivedMode = null;
        await getNeedsReplyCount({
            shopId,
            now,
            ...models,
            deriveWorkflowProjection: (conversationRow, messages, aiReplyModeArg) => {
                receivedMode = aiReplyModeArg;
                return projection(conversationRow);
            },
        });
        expect(getEffectiveAiReplyMode).toHaveBeenCalledWith(shopId);
        expect(receivedMode).toBe('DRAFT');
    });
});
