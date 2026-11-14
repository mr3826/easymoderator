'use strict';

/**
 * MW-V1 Increment 2 — merchant work-ownership contract (doc 03 §Ownership).
 * Closes the four defects recorded in doc 02 (D1-D4):
 *  D1 force rejected by the HTTP validator although the controller passes it
 *  D2 assignee_id accepted without checking shop membership
 *  D3 mapConversation hides assignee/resolution so no client can see who owns work
 *  D4 ownership changes are written to no server-side audit trail
 */

const mockConversation = (over = {}) => ({
    id: 'conv-1',
    channel: 'messenger',
    customer_id: 'cust-1',
    hitl: false,
    status: 'active',
    assignee_id: null,
    resolution_note: null,
    resolved_at: null,
    metadata: {},
    update: jest.fn(async function (fields) { Object.assign(this, fields); return this; }),
    ...over,
});

jest.mock('../../entities', () => ({
    Conversation: { findOne: jest.fn(), findAll: jest.fn() },
    Message: { findAll: jest.fn(async () => []), findOne: jest.fn(async () => null) },
    Customer: {},
    MetaChannel: {},
    MetaChannelSettings: {},
    InboxDeliveryOutbox: {},
    UserShop: { findOne: jest.fn() },
    User: { findAll: jest.fn(async () => []) },
    AuditLog: { create: jest.fn(async () => ({})) },
}));
jest.mock('../../subscription/subscription.service', () => ({ trackUsage: jest.fn() }));
jest.mock('../../shop/shop.service', () => ({ getShopAiSettings: jest.fn(async () => ({})) }));
jest.mock('../../shop/ai-reply-mode', () => ({
    ...jest.requireActual('../../shop/ai-reply-mode'),
    getEffectiveAiReplyMode: jest.fn(async () => 'MANUAL'),
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { getDialect: () => 'sqlite', transaction: undefined },
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));

const entities = require('../../entities');
const sseManager = require('../../../utils/sse-manager');
const { sequelize } = require('../../../utils/database/database-setup');
const conversationService = require('../conversation.service');

describe('D2 — assignee must be an active member of the acting shop', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        entities.Conversation.findOne.mockResolvedValue(mockConversation({ hitl: true }));
        entities.Message.findAll.mockResolvedValue([]);
    });

    it('rejects an assignee who is not a member of this shop (INVALID_ASSIGNEE, 400)', async () => {
        entities.UserShop.findOne.mockResolvedValue(null); // not a member

        await expect(
            conversationService.updateConversation('conv-1', 'shop-1',
                { assignee_id: 'user-from-another-shop' },
                { actor: { userId: 'owner-1', role: 'owner' } })
        ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE', statusCode: 400 });
    });

    it('accepts an active member and persists the assignment', async () => {
        entities.UserShop.findOne.mockResolvedValue({ user_id: 'staff-2', shop_id: 'shop-1' });

        const result = await conversationService.updateConversation('conv-1', 'shop-1',
            { assignee_id: 'staff-2' },
            { actor: { userId: 'owner-1', role: 'owner' } });

        expect(result.assignee_id).toBe('staff-2');
        expect(result.assignee).toMatchObject({ id: 'staff-2' });
    });

    it('null assignee clears ownership without membership lookup', async () => {
        const result = await conversationService.updateConversation('conv-1', 'shop-1',
            { assignee_id: null },
            { actor: { userId: 'owner-1', role: 'owner' } });

        expect(entities.UserShop.findOne).not.toHaveBeenCalled();
        expect(result.assignee_id).toBeNull();
    });
});

describe('D3 — ownership is visible in read shapes', () => {
    it('mapConversation exposes assignee_id, assignee name when attached, resolution fields', () => {
        const row = mockConversation({
            assignee_id: 'staff-2',
            resolution_note: 'sized exchange agreed',
            resolved_at: '2026-10-25T10:00:00.000Z',
            hitl: true,
        });
        const mapped = conversationService.mapConversation(row);
        expect(mapped.assignee_id).toBe('staff-2');
        expect(mapped.resolution_note).toBe('sized exchange agreed');
        expect(mapped.resolved_at).toBe('2026-10-25T10:00:00.000Z');
    });

    it('update response carries the resolved assignee name from the users table', async () => {
        jest.clearAllMocks();
        entities.Conversation.findOne.mockResolvedValue(mockConversation({ hitl: true }));
        entities.UserShop.findOne.mockResolvedValue({ user_id: 'staff-2' });
        entities.User.findAll.mockResolvedValue([{ id: 'staff-2', full_name: 'Nowrin Sultana' }]);
        entities.Message.findAll.mockResolvedValue([]);

        const result = await conversationService.updateConversation('conv-1', 'shop-1',
            { assignee_id: 'staff-2' },
            { actor: { userId: 'owner-1', role: 'owner' } });

        expect(result.assignee).toEqual({ id: 'staff-2', name: 'Nowrin Sultana' });
        // one batched name query, never per-row (no N+1)
        expect(entities.User.findAll).toHaveBeenCalledTimes(1);
    });
});

describe('D4 — ownership changes write a server-side audit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sequelize.getDialect = () => 'sqlite';
        sequelize.transaction = undefined;
        entities.Conversation.findOne.mockResolvedValue(mockConversation({ hitl: true, assignee_id: 'staff-1' }));
        entities.UserShop.findOne.mockResolvedValue({ user_id: 'owner-1' });
        entities.Message.findAll.mockResolvedValue([]);
    });

    it('records an UPDATE / CONVERSATION_OWNERSHIP audit entry with before/after', async () => {
        await conversationService.updateConversation('conv-1', 'shop-1',
            { hitl: true, assignee_id: 'owner-1' },
            { actor: { userId: 'owner-1', role: 'owner' } });

        expect(entities.AuditLog.create).toHaveBeenCalledTimes(1);
        const entry = entities.AuditLog.create.mock.calls[0][0];
        expect(entry.shop_id).toBe('shop-1');
        expect(entry.resource_type).toBe('conversation_ownership');
        expect(entry.resource_id).toBe('conv-1');
        expect(entry.metadata.from.assignee_id).toBe('staff-1');
        expect(entry.metadata.to.assignee_id).toBe('owner-1');
        // PII discipline: no message content in audits
        expect(JSON.stringify(entry)).not.toMatch(/message_content/);
    });

    it('does not write an audit when nothing about ownership/workflow changed', async () => {
        await conversationService.updateConversation('conv-1', 'shop-1',
            { resolution_note: 'still same owner, extra context' },
            { actor: { userId: 'staff-1', role: 'staff' } });

        expect(entities.AuditLog.create).not.toHaveBeenCalled();
    });

    it('keeps the ownership update successful when the best-effort audit insert fails', async () => {
        entities.AuditLog.create.mockRejectedValueOnce(new Error('synthetic audit storage failure'));

        await expect(conversationService.updateConversation('conv-1', 'shop-1',
            { hitl: true, assignee_id: 'owner-1' },
            { actor: { userId: 'owner-1', role: 'owner' } }))
            .resolves.toMatchObject({ assignee_id: 'owner-1', hitl: true });
        expect(entities.AuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('attempts the best-effort audit after the ownership transaction settles', async () => {
        let transactionSettled = false;
        let auditObservedTransactionSettled = false;
        sequelize.getDialect = () => 'postgres';
        sequelize.transaction = jest.fn(async (callback) => {
            const result = await callback({ LOCK: { UPDATE: 'UPDATE' } });
            transactionSettled = true;
            return result;
        });
        entities.AuditLog.create.mockImplementationOnce(async () => {
            auditObservedTransactionSettled = transactionSettled;
            return {};
        });

        await conversationService.updateConversation('conv-1', 'shop-1',
            { hitl: true, assignee_id: 'owner-1' },
            { actor: { userId: 'owner-1', role: 'owner' } });

        expect(sequelize.transaction).toHaveBeenCalledTimes(1);
        expect(auditObservedTransactionSettled).toBe(true);
    });
});

describe('D1 — HTTP layer can express privileged force', () => {
    it('updateConversation validator accepts force:true', () => {
        const validator = require('../conversation.validator');
        const { error } = validator.updateConversation.body.validate(
            { hitl: true, force: true }, { allowUnknown: false }
        );
        expect(error).toBeUndefined();
    });

    it('still rejects unknown body keys beyond the documented contract', () => {
        const validator = require('../conversation.validator');
        const { error } = validator.updateConversation.body.validate(
            { sneaky: true }, { allowUnknown: false }
        );
        expect(error).toBeDefined();
    });
});

describe('ownership SSE carries the new owner', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        entities.Conversation.findOne.mockResolvedValue(mockConversation());
        entities.UserShop.findOne.mockResolvedValue({ user_id: 'staff-2' });
        entities.User.findAll.mockResolvedValue([{ id: 'staff-2', full_name: 'Nowrin' }]);
        entities.Message.findAll.mockResolvedValue([]);
    });

    it('service emits hitl_changed with assignee fields on a claim', async () => {
        await conversationService.updateConversation('conv-1', 'shop-1',
            { assignee_id: 'staff-2', hitl: true },
            { actor: { userId: 'staff-2', role: 'staff' } });

        const emitted = sseManager.emit.mock.calls.filter(([shopId, type]) =>
            type === 'hitl_changed' && shopId === 'shop-1');
        expect(emitted.length).toBeGreaterThanOrEqual(1);
        const payload = emitted[0][2];
        expect(payload).toMatchObject({
            conversation_id: 'conv-1',
            assignee_id: 'staff-2',
        });
        expect(payload.assignee).toEqual({ id: 'staff-2', name: 'Nowrin' });
    });
});
