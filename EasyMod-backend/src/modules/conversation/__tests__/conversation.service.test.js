'use strict';

const mockTransaction = {
    id: 'conversation-transaction',
    commit: jest.fn(),
    rollback: jest.fn(),
};
const mockConversation = {
    id: 'conversation-1',
    channel: 'messenger',
    customer_id: 'customer-1',
};
const mockLogger = {
    logUsage: jest.fn(),
    error: jest.fn(),
};

jest.mock('../../entities', () => ({
    Conversation: { create: jest.fn() },
    Message: {},
    Customer: {},
    MetaChannel: {},
    MetaChannelSettings: {},
}));
jest.mock('../../subscription/subscription.service', () => ({
    trackUsage: jest.fn(),
}));
jest.mock('../../shop/shop.service', () => ({
    getShopAiSettings: jest.fn(),
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
    },
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => mockLogger),
}));
jest.mock('../../../utils/sse-manager', () => ({
    emit: jest.fn(),
    register: jest.fn(),
    unregister: jest.fn(),
    disconnectUser: jest.fn(),
    attachToRequest: jest.fn(),
}));

const { Conversation, Message } = require('../../entities');
const subscriptionService = require('../../subscription/subscription.service');
const shopService = require('../../shop/shop.service');
const { sequelize } = require('../../../utils/database/database-setup');
const conversationService = require('../conversation.service');

beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.commit.mockResolvedValue(undefined);
    mockTransaction.rollback.mockResolvedValue(undefined);
    sequelize.transaction.mockResolvedValue(mockTransaction);
    Conversation.create.mockResolvedValue(mockConversation);
    shopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'AI_ACTIVE' });
});

describe('conversation creation after commit', () => {
    it('returns the committed conversation when post-commit usage metering fails', async () => {
        const usageError = new Error('meter unavailable');
        usageError.code = 'USAGE_METER_UNAVAILABLE';
        subscriptionService.trackUsage.mockRejectedValue(usageError);

        await expect(conversationService.createConversation(
            'shop-1',
            { customer_id: 'customer-1', channel: 'messenger', message: 'Hello' },
            'request-1',
        )).resolves.toBe(mockConversation);

        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        expect(mockTransaction.rollback).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
            'Failed to track conversation usage',
            usageError,
            expect.objectContaining({ conversationId: 'conversation-1' }),
        );
    });
});

describe('conversation list reply-mode envelope', () => {
    it('reads the business mode once and returns the normalized mode', async () => {
        const row = {
            id: 'conversation-1',
            customer_id: 'customer-1',
            channel: 'messenger',
            metadata: {},
            hitl: false,
            customer: null,
            metaChannel: null,
            message: null,
        };
        Conversation.findAndCountAll = jest.fn().mockResolvedValue({ rows: [row], count: 1 });
        shopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'AI_ACTIVE' });

        const result = await conversationService.getConversations('shop-1');

        expect(result).toEqual(expect.objectContaining({
            ai_reply_mode: 'AUTO',
            conversations: [expect.objectContaining({ id: 'conversation-1' })],
        }));
        expect(shopService.getShopAiSettings).toHaveBeenCalledTimes(1);
        expect(shopService.getShopAiSettings).toHaveBeenCalledWith('shop-1');
        expect(Conversation.findAndCountAll).toHaveBeenCalledTimes(1);
    });
});

describe('conversation message privacy projection', () => {
    it('preserves the inbox transcript contract while projecting typed nested metadata', async () => {
        const createdAt = new Date('2026-11-18T12:00:00.000Z');
        Conversation.findOne = jest.fn().mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-1' });
        Message.findAndCountAll = jest.fn().mockResolvedValue({
            rows: [{
                id: 'message-1',
                conversation_id: 'conversation-1',
                sender: 'customer',
                content: 'Can you share the catalog?',
                message_type: 'file',
                created_at: createdAt,
                ai_confidence: 0.9,
                source_references: [{ kind: 'faq', id: 'faq-1', title: 'Catalog', internal_note: 'fixture' }],
                metadata: {
                    message_type: 'file',
                    file_name: 'catalog.pdf',
                    file_url: 'https://assets.example.test/catalog.pdf',
                    attachments: [{ type: 'file', url: 'https://assets.example.test/catalog.pdf', name: 'catalog.pdf', private_note: 'fixture' }],
                    delivery_state: 'SENT',
                    delivery_status: 'sent',
                    delivered: true,
                    provider_message_id: 'provider-1',
                    provider_send_confirmed: true,
                    reply_to: { provider_message_id: 'provider-0', content: 'Previous message', nested_private: { fixture: true } },
                    confidence_score: 0.91,
                    confidence_components: { fixture: 'private' },
                    grounding_knowledge_ids: ['knowledge-1'],
                    reply_evidence: { label: 'GROUNDED', fixture: 'private' },
                    unexpected: { fixture: 'private' },
                },
            }],
            count: 1,
        });
        Message.findAll = jest.fn().mockResolvedValue([]);

        const result = await conversationService.getMessages('conversation-1', 'shop-1');

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual(expect.objectContaining({
            id: 'message-1',
            message_type: 'file',
            ai_confidence: 0.9,
            source_references: [{ kind: 'faq', id: 'faq-1', title: 'Catalog' }],
            reply_to: { provider_message_id: 'provider-0', content: 'Previous message' },
            is_transcript_message: true,
            metadata: {
                message_type: 'file',
                file_name: 'catalog.pdf',
                file_url: 'https://assets.example.test/catalog.pdf',
                attachments: [{ type: 'file', url: 'https://assets.example.test/catalog.pdf', name: 'catalog.pdf' }],
                delivery_state: 'SENT',
                delivery_status: 'sent',
                delivered: true,
                provider_message_id: 'provider-1',
                provider_send_confirmed: true,
                reply_to: { provider_message_id: 'provider-0', content: 'Previous message' },
            },
        }));
        expect(result.pagination).toEqual({ total: 1, page: 1, limit: 50, totalPages: 1 });
        expect(Conversation.findOne).toHaveBeenCalledWith({ where: { id: 'conversation-1', shop_id: 'shop-1' } });
    });
});

describe('message projection turn scoping', () => {
    it('does not expose a stale reviewable draft from before the latest customer turn', async () => {
        Conversation.findOne = jest.fn().mockResolvedValue({
            id: 'conversation-1',
            shop_id: 'shop-1',
        });
        const staleDraft = {
            id: 'draft-old',
            conversation_id: 'conversation-1',
            sender: 'ai',
            content: 'Old draft',
            created_at: new Date('2026-09-07T09:00:00.000Z'),
            metadata: {
                delivery_state: 'DRAFT_READY',
                logical_turn_id: 'turn-old',
                suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
            },
        };
        const latestInbound = {
            id: 'customer-new',
            conversation_id: 'conversation-1',
            sender: 'customer',
            content: 'New inbound',
            created_at: new Date('2026-09-07T09:05:00.000Z'),
            metadata: { logical_turn_id: 'turn-new' },
        };
        Message.findAndCountAll = jest.fn().mockResolvedValue({
            rows: [latestInbound, staleDraft],
            count: 2,
        });

        const result = await conversationService.getMessages('conversation-1', 'shop-1');

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].id).toBe('customer-new');
        expect(result.suggestions).toEqual([]);
    });

    it('filters stale drafts outside the requested message page', async () => {
        Conversation.findOne = jest.fn().mockResolvedValue({
            id: 'conversation-1',
            shop_id: 'shop-1',
        });
        const latestInbound = {
            id: 'customer-new',
            conversation_id: 'conversation-1',
            sender: 'customer',
            content: 'New inbound',
            created_at: new Date('2026-09-07T09:05:00.000Z'),
            metadata: { logical_turn_id: 'burst:customer-new' },
        };
        const staleDraft = {
            id: 'draft-old',
            conversation_id: 'conversation-1',
            sender: 'ai',
            content: 'Old draft',
            created_at: new Date('2026-09-07T09:00:00.000Z'),
            metadata: {
                delivery_state: 'DRAFT_READY',
                logical_turn_id: 'burst:customer-old',
                suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
            },
        };
        Message.findAndCountAll = jest.fn().mockResolvedValue({
            rows: [latestInbound],
            count: 2,
        });
        Message.findAll = jest.fn().mockResolvedValue([latestInbound, staleDraft]);

        const result = await conversationService.getMessages('conversation-1', 'shop-1', { page: 2 });

        expect(result.suggestions).toEqual([]);
        expect(Message.findAll).toHaveBeenCalledWith(expect.objectContaining({
            limit: expect.any(Number),
            order: [['created_at', 'DESC'], ['id', 'DESC']],
        }));
    });
});

// P+03: ownership is server-authoritative. A second staff member cannot
// silently overwrite (or resolve) an assigned, open handoff; owner/admin may
// force; a takeover claims ownership explicitly.
describe('handoff ownership enforcement (P+03)', () => {
    const assignedOpen = (over = {}) => ({
        id: 'conversation-1',
        shop_id: 'shop-1',
        status: 'active',
        hitl: true,
        assignee_id: 'staff-owner',
        metadata: { handoff_reason: 'customer_choice_support', handoff_at: '2026-10-24T09:00:00Z' },
        update: jest.fn().mockResolvedValue(undefined),
        ...over,
    });

    beforeEach(() => {
        // Held-candidate scan must resolve empty for these ownership tests.
        Message.findAll = jest.fn().mockResolvedValue([]);
        shopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'AUTO' });
    });

    it('rejects a silent second takeover with 409 HUMAN_TAKEOVER_CONFLICT', async () => {
        Conversation.findOne = jest.fn().mockResolvedValue(assignedOpen());
        await expect(conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: true },
            { actor: { userId: 'staff-other', role: 'staff' } },
        )).rejects.toMatchObject({ code: 'HUMAN_TAKEOVER_CONFLICT', statusCode: 409 });
    });

    it('rejects a non-owner staff resolving another owner\'s open handoff', async () => {
        Conversation.findOne = jest.fn().mockResolvedValue(assignedOpen());
        await expect(conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: false },
            { actor: { userId: 'staff-other', role: 'staff' } },
        )).rejects.toMatchObject({ code: 'HANDOFF_RESOLUTION_CONFLICT', statusCode: 409 });
    });

    it('the assigned owner can resume their own handoff', async () => {
        const row = assignedOpen();
        Conversation.findOne = jest.fn().mockResolvedValue(row);
        shopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'AUTO' });
        await conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: false },
            { actor: { userId: 'staff-owner', role: 'staff' } },
        );
        expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ hitl: false }));
    });

    it('an owner/admin may force over, and a takeover claims ownership', async () => {
        const row = assignedOpen();
        Conversation.findOne = jest.fn().mockResolvedValue(row);
        await conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: true },
            { actor: { userId: 'boss-1', role: 'owner' } },
        );
        expect(row.update).toHaveBeenCalledWith(expect.objectContaining({
            hitl: true,
            assignee_id: 'boss-1',
        }));
    });

    it('a staff force flag is IGNORED — force is privileged-only', async () => {
        Conversation.findOne = jest.fn().mockResolvedValue(assignedOpen());
        await expect(conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: true },
            { actor: { userId: 'staff-other', role: 'staff' }, force: true },
        )).rejects.toMatchObject({ code: 'HUMAN_TAKEOVER_CONFLICT', statusCode: 409 });
    });

    it('a fresh (unassigned) handoff takeover simply claims it', async () => {
        const row = assignedOpen({ hitl: false, assignee_id: null });
        Conversation.findOne = jest.fn().mockResolvedValue(row);
        await conversationService.updateConversation(
            'conversation-1', 'shop-1', { hitl: true },
            { actor: { userId: 'staff-first', role: 'staff' } },
        );
        expect(row.update).toHaveBeenCalledWith(expect.objectContaining({
            hitl: true,
            assignee_id: 'staff-first',
        }));
    });
});
