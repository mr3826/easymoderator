'use strict';

const mockConversationModel = {
    findOne: jest.fn(),
    findAndCountAll: jest.fn(),
    findAll: undefined,
    };
const mockMessageModel = {
    findOne: jest.fn(),
    findAndCountAll: jest.fn(),
    findAll: jest.fn(),
};
const mockInboxDeliveryOutbox = {
    create: jest.fn(),
    update: jest.fn(),
};
const mockTransaction = {
    LOCK: { UPDATE: 'UPDATE' },
    finished: null,
    commit: jest.fn(async () => { mockTransaction.finished = 'commit'; }),
    rollback: jest.fn(async () => { mockTransaction.finished = 'rollback'; }),
};

jest.mock('../../entities', () => ({
    Conversation: mockConversationModel,
    Message: mockMessageModel,
    Customer: {},
    MetaChannel: {},
    MetaChannelSettings: {},
    InboxDeliveryOutbox: mockInboxDeliveryOutbox,
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn(async () => mockTransaction) },
}));
const mockDeliveryLock = {
    acquireForDelivery: jest.fn(async () => ({ available: true, success: true, lockId: 'lock-1' })),
    releaseLock: jest.fn(async () => {}),
};
jest.mock('../conversation-lock.service', () => mockDeliveryLock);
jest.mock('../../../config/redis', () => ({ cacheRedis: { set: jest.fn(), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() })),
}));
jest.mock('../../shop/ai-reply-mode', () => ({
    ...jest.requireActual('../../shop/ai-reply-mode'),
    getEffectiveAiReplyMode: jest.fn(async () => 'AUTO'),
}));
// The effective-config display fields read the business settings once per
// request; this suite pins the BUSINESS mode projection (AUTO).
jest.mock('../../shop/shop.service', () => ({
    getShopAiSettings: jest.fn(async () => ({ automation_mode: 'AUTO' })),
}));

const conversationService = require('../conversation.service');
const { getEffectiveAiReplyMode } = require('../../shop/ai-reply-mode');

const customerMessage = {
    id: 'customer-message',
    conversation_id: 'conversation-1',
    sender: 'customer',
    content: 'Hello',
    created_at: new Date('2026-09-04T10:00:00Z'),
    metadata: {},
};
const draftMessage = {
    id: 'draft-message',
    conversation_id: 'conversation-1',
    sender: 'ai',
    content: 'Draft reply',
    ai_suggestion: 'Draft reply',
    delivery_state: 'DRAFT_READY',
    delivery_source: 'AI_DRAFT',
    metadata: {
        delivered: false,
        delivery_state: 'DRAFT_READY',
        suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
    },
    created_at: new Date('2026-09-04T10:01:00Z'),
    update: jest.fn(async (updates) => Object.assign(draftMessage, updates)),
};

const duplicateDraft = {
    id: 'duplicate-draft',
    conversation_id: 'conversation-1',
    sender: 'ai',
    content: 'Older duplicate reply',
    ai_suggestion: 'Older duplicate reply',
    delivery_state: 'DRAFT_READY',
    delivery_source: 'AI_DRAFT',
    metadata: {
        delivered: false,
        delivery_state: 'DRAFT_READY',
        suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
        logical_turn_id: 'burst:customer-1',
    },
    created_at: new Date('2026-09-04T10:00:30Z'),
    update: jest.fn(async function update(updates) { Object.assign(this, updates); }),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.finished = null;
    mockInboxDeliveryOutbox.create.mockResolvedValue({ id: 'outbox-1' });
    duplicateDraft.delivery_state = 'DRAFT_READY';
    duplicateDraft.metadata = {
        delivered: false,
        delivery_state: 'DRAFT_READY',
        suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
        logical_turn_id: 'burst:customer-1',
    };
    duplicateDraft.created_at = new Date('2026-09-04T10:00:30Z');
});

describe('ConversationService delivery projection', () => {
    it('adds the effective automation fields while keeping the business ai_reply_mode', async () => {
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
        mockConversationModel.findAndCountAll = jest.fn().mockResolvedValue({ rows: [row], count: 1 });
        mockMessageModel.findAll.mockResolvedValue([]);

        const result = await conversationService.getConversations('shop-a');

        expect(result.ai_reply_mode).toBe('AUTO');
        expect(result.conversations[0]).toEqual(expect.objectContaining({
            effective_ai_reply_mode: 'AUTO',
            mode_source: 'business_default',
            emergency_stop: expect.objectContaining({ active: false }),
            billing_ai_active: true,
        }));
    });

    it('projects customer identity instead of an internal intent enum', () => {
        const result = conversationService.mapConversation({
            id: 'conversation-1',
            channel: 'messenger',
            customer: { id: 'customer-1', name: 'Facebook User', channel_user_id: 'psid-1234' },
            title: 'GENERAL_CHAT_OR_UNKNOWN',
            intent: 'GENERAL_CHAT_OR_UNKNOWN',
            metadata: {},
        });

        expect(result.customer.name).toBe('Facebook customer · …1234');
        expect(result.title).toBe('Facebook customer · …1234');
        expect(result.title).not.toBe('GENERAL_CHAT_OR_UNKNOWN');
    });

    it('separates unsent AI suggestions from the canonical transcript', async () => {
        mockConversationModel.findOne.mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-a' });
        mockMessageModel.findAndCountAll.mockResolvedValue({
            // The service reverses the database's DESC page for chronological
            // rendering, so provide the mocked rows in the same DESC order.
            rows: [{
                ...draftMessage,
                id: 'sent-message',
                content: 'Sent reply',
                delivery_state: 'SENT',
                provider_message_id: 'mid-1',
                metadata: { delivery_state: 'SENT', provider_send_confirmed: true },
            }, draftMessage, customerMessage],
            count: 3,
        });

        const result = await conversationService.getMessages('conversation-1', 'shop-a');

        expect(result.messages.map((message) => message.id)).toEqual(['customer-message', 'sent-message']);
        expect(result.suggestions).toEqual([]);
    });

    it('claims a draft row before approval and does not create a second message', async () => {
        const conversation = { id: 'conversation-1', shop_id: 'shop-a', channel: 'messenger' };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findOne.mockResolvedValue(draftMessage);

        const result = await conversationService.approveAiDraft(
            'conversation-1',
            'shop-a',
            'draft-message',
            'Edited reply',
            'user-1',
        );

        expect(result.alreadySent).toBe(false);
        expect(draftMessage.update).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'Edited reply',
                delivery_state: 'SEND_PENDING',
                delivery_source: 'DRAFT_APPROVAL',
                send_idempotency_key: expect.any(String),
            }),
            { transaction: mockTransaction },
        );
        expect(mockMessageModel.findAndCountAll).not.toHaveBeenCalled();
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        expect(mockInboxDeliveryOutbox.create).toHaveBeenCalledWith(
            expect.objectContaining({
                message_id: 'draft-message',
                status: 'PENDING',
                delivery_source: 'DRAFT_APPROVAL',
            }),
            { transaction: mockTransaction },
        );
    });

    it('does not dismiss a provider-attempted failed candidate', async () => {
        const attempted = {
            id: 'attempted-draft',
            conversation_id: 'conversation-1',
            sender: 'ai',
            delivery_state: 'FAILED',
            metadata: {
                delivered: false,
                delivery_state: 'FAILED',
                delivery_status: 'failed',
                provider_send_attempted: true,
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            update: jest.fn(),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findOne.mockResolvedValue(attempted);

        await expect(conversationService.dismissAiDraft(
            'conversation-1',
            'shop-a',
            'attempted-draft',
            'user-1',
        )).rejects.toMatchObject({
            code: 'PROVIDER_SEND_ALREADY_ATTEMPTED',
            statusCode: 409,
        });
        expect(attempted.update).not.toHaveBeenCalled();
    });

    it('terminalizes duplicate same-turn drafts while preserving an unanswered projection', async () => {
        const candidate = {
            ...draftMessage,
            delivery_state: 'DRAFT_READY',
            metadata: {
                ...draftMessage.metadata,
                delivery_state: 'DRAFT_READY',
                delivery_status: 'pending',
                logical_turn_id: 'burst:customer-1',
            },
            update: jest.fn(async function update(updates) { Object.assign(this, updates); }),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: false,
            update: jest.fn(),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findOne.mockResolvedValue(candidate);
        mockMessageModel.findAll.mockResolvedValue([candidate, duplicateDraft, customerMessage]);

        await expect(conversationService.dismissAiDraft(
            'conversation-1',
            'shop-a',
            'draft-message',
            'user-1',
        )).resolves.toEqual(expect.objectContaining({ alreadyDismissed: false }));

        expect(candidate.delivery_state).toBe('DISMISSED');
        expect(duplicateDraft.delivery_state).toBe('DISMISSED');
        expect(duplicateDraft.metadata).toEqual(expect.objectContaining({
            delivery_state: 'DISMISSED',
            suggestion_visibility: 'HIDDEN_DISMISSED',
            held_reason: 'dismissed',
            dismissed_as_duplicate: true,
            dismissed_duplicate_of: 'draft-message',
        }));
        expect(duplicateDraft.metadata.provider_send_attempted).not.toBe(true);
        expect(duplicateDraft.provider_message_id).toBeUndefined();
        expect(require('../message-lifecycle').isReviewableSuggestion(duplicateDraft)).toBe(false);
    });

    it('does not dismiss a newer legitimate draft when dismissing a legacy candidate', async () => {
        const legacyCandidate = {
            ...draftMessage,
            id: 'legacy-draft',
            created_at: new Date('2026-09-04T10:01:00Z'),
            delivery_state: 'DRAFT_READY',
            metadata: {
                ...draftMessage.metadata,
                delivery_state: 'DRAFT_READY',
                delivery_status: 'pending',
                logical_turn_id: undefined,
            },
            update: jest.fn(async function update(updates) { Object.assign(this, updates); }),
        };
        const newerDraft = {
            ...duplicateDraft,
            id: 'newer-draft',
            created_at: new Date('2026-09-04T10:02:00Z'),
            metadata: {
                ...duplicateDraft.metadata,
                logical_turn_id: 'burst:customer-2',
            },
        };
        mockConversationModel.findOne.mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-a' });
        mockMessageModel.findOne.mockResolvedValue(legacyCandidate);
        mockMessageModel.findAll.mockResolvedValue([legacyCandidate, newerDraft, customerMessage]);

        expect(legacyCandidate.metadata.logical_turn_id).toBeUndefined();
        expect(newerDraft.metadata.logical_turn_id).toBe('burst:customer-2');
        expect(newerDraft.created_at.getTime()).toBeGreaterThan(legacyCandidate.created_at.getTime());

        await conversationService.dismissAiDraft(
            'conversation-1',
            'shop-a',
            'legacy-draft',
            'user-1',
        );

        expect(legacyCandidate.delivery_state).toBe('DISMISSED');
        expect(newerDraft.delivery_state).toBe('DRAFT_READY');
        expect(newerDraft.metadata.suggestion_visibility).toBe('VISIBLE_DRAFT_REVIEW');
    });

    it('rechecks an already dismissed candidate and terminalizes legacy siblings after reload', async () => {
        const dismissed = {
            ...draftMessage,
            delivery_state: 'DISMISSED',
            metadata: {
                ...draftMessage.metadata,
                delivery_state: 'DISMISSED',
                delivery_status: 'dismissed',
                suggestion_visibility: 'HIDDEN_DISMISSED',
                held_reason: 'dismissed',
            },
            update: jest.fn(async function update(updates) { Object.assign(this, updates); }),
        };
        const legacySibling = {
            ...duplicateDraft,
            id: 'legacy-sibling',
            metadata: {
                ...duplicateDraft.metadata,
                logical_turn_id: undefined,
            },
            update: jest.fn(async function update(updates) { Object.assign(this, updates); }),
        };
        mockConversationModel.findOne.mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-a' });
        mockMessageModel.findOne.mockResolvedValue(dismissed);
        mockMessageModel.findAll.mockResolvedValue([dismissed, legacySibling, customerMessage]);

        const result = await conversationService.dismissAiDraft(
            'conversation-1',
            'shop-a',
            'draft-message',
            'user-1',
        );

        expect(result.alreadyDismissed).toBe(true);
        expect(legacySibling.delivery_state).toBe('DISMISSED');
        expect(legacySibling.metadata.suggestion_visibility).toBe('HIDDEN_DISMISSED');
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
    });

    it('persists a read watermark and clears only the owning conversation', async () => {
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            channel: 'messenger',
            metadata: { unreadCount: 2 },
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findOne.mockResolvedValue(customerMessage);

        const result = await conversationService.markConversationRead(
            'conversation-1',
            'shop-a',
            'customer-message',
        );

        expect(conversation.update).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({
                unreadCount: 0,
                last_read_message_id: 'customer-message',
            }) }),
            { transaction: mockTransaction },
        );
        expect(result.unreadCount).toBe(0);
        expect(result.lastReadMessageId).toBe('customer-message');
    });

    it('holds an unsent candidate when a merchant takes over', async () => {
        const candidate = {
            id: 'candidate-1',
            sender: 'ai',
            delivery_state: 'DRAFT_READY',
            metadata: { delivered: false, delivery_state: 'DRAFT_READY' },
            update: jest.fn(async (updates) => Object.assign(candidate, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-a' });
        mockMessageModel.findAll.mockResolvedValue([candidate]);

        await expect(conversationService.holdPendingAiCandidates('conversation-1', 'shop-a'))
            .resolves.toBe(1);
        expect(candidate.delivery_state).toBe('HELD');
        expect(candidate.metadata.suggestion_visibility).toBe('VISIBLE_HITL_REVIEW');
        expect(require('../message-lifecycle').isReviewableSuggestion(candidate)).toBe(true);
    });

    it('closes the conversation and terminalizes pending AI work without exposing a stale draft', async () => {
        const pending = {
            id: 'pending-ai',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date('2026-09-04T10:01:00Z'),
            delivery_state: 'SEND_PENDING',
            metadata: {
                delivered: false,
                delivery_state: 'SEND_PENDING',
                suggestion_visibility: 'HIDDEN_AUTO_PROCESSING',
            },
            update: jest.fn(async (updates) => Object.assign(pending, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([pending]);

        const result = await conversationService.updateConversation(
            'conversation-1',
            'shop-a',
            { status: 'closed' },
        );

        expect(conversation.status).toBe('closed');
        expect(conversation.hitl).toBe(false);
        expect(conversation.metadata.ai_resume_boundary_at).toEqual(expect.any(String));
        expect(pending.delivery_state).toBe('HELD');
        expect(pending.metadata).toEqual(expect.objectContaining({
            held_reason: 'conversation_closed',
            suggestion_visibility: 'HIDDEN_DISMISSED',
        }));
        expect(result).toEqual(expect.objectContaining({
            status: 'closed',
            hitl: false,
            needs_merchant_reply: false,
            ai_is_replying: false,
        }));
    });

    it('keeps a conversation open when a customer message arrives after the merchant last saw it', async () => {
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: false,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findOne
            .mockResolvedValueOnce({
                id: 'last-seen-message',
                created_at: new Date('2026-09-04T10:00:00Z'),
            })
            .mockResolvedValueOnce({ id: 'newer-customer-message' });
        mockMessageModel.findAll.mockResolvedValue([]);

        const result = await conversationService.updateConversation(
            'conversation-1',
            'shop-a',
            { status: 'closed', last_seen_message_id: 'last-seen-message' },
        );

        expect(conversation.status).toBe('active');
        expect(conversation.resolved_at).toBeUndefined();
        expect(conversation.metadata).not.toHaveProperty('ai_resume_boundary_at');
        expect(result).toEqual(expect.objectContaining({
            status: 'active',
            resolution_outcome: 'kept_open_newer_customer_message',
        }));
    });

    it('dismisses human-held AI candidates when Resume AI returns control', async () => {
        const held = {
            id: 'held-ai',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date('2026-09-04T10:01:00Z'),
            delivery_state: 'HELD',
            metadata: {
                delivered: false,
                delivery_state: 'HELD',
                held_reason: 'human_active',
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(async (updates) => Object.assign(held, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([held]);

        await conversationService.updateConversation(
            'conversation-1',
            'shop-a',
            { hitl: false },
        );

        expect(held.delivery_state).toBe('DISMISSED');
        expect(held.metadata).toEqual(expect.objectContaining({
            held_reason: 'resume_obsolete',
            suggestion_visibility: 'HIDDEN_DISMISSED',
            dismissed_by_resume: true,
        }));
        expect(require('../message-lifecycle').isReviewableSuggestion(held)).toBe(false);
    });

    it('bulk closes through the per-conversation delivery fence', async () => {
        const conversations = new Map(['conversation-1', 'conversation-2'].map((id) => [id, {
            id,
            shop_id: 'shop-a',
            status: 'active',
            hitl: false,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversations.get(id), updates)),
        }]));
        mockConversationModel.findOne.mockImplementation(async ({ where }) => conversations.get(where.id));
        mockMessageModel.findAll.mockResolvedValue([]);

        const result = await conversationService.bulkUpdateStatus(
            'shop-a',
            ['conversation-1', 'conversation-2'],
            'closed',
        );

        expect(result).toEqual(expect.objectContaining({
            requested: 2,
            updated: 2,
            skipped: 0,
            status: 'closed',
            updated_conversation_ids: ['conversation-1', 'conversation-2'],
        }));
        expect(mockDeliveryLock.acquireForDelivery).toHaveBeenCalledTimes(2);
        expect(mockDeliveryLock.releaseLock).toHaveBeenCalledTimes(2);
        expect(conversations.get('conversation-1').status).toBe('closed');
        expect(conversations.get('conversation-2').status).toBe('closed');
    });

    it.each([
        {
            name: 'MANUAL inbound',
            mode: 'MANUAL',
            messages: [customerMessage],
            expected: { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED', ai_is_replying: false },
        },
        {
            name: 'MANUAL answered',
            mode: 'MANUAL',
            messages: [
                customerMessage,
                {
                    id: 'business-message',
                    conversation_id: 'conversation-1',
                    sender: 'business',
                    created_at: new Date('2026-09-04T10:02:00Z'),
                    delivery_state: 'SENT',
                    metadata: { delivery_state: 'SENT' },
                },
            ],
            expected: { needs_merchant_reply: false, needs_merchant_reply_reason: null, ai_is_replying: false },
        },
        {
            name: 'DRAFT waiting',
            mode: 'DRAFT',
            messages: [customerMessage, {
                ...draftMessage,
                delivery_state: 'DRAFT_READY',
                delivery_source: 'AI_DRAFT',
                metadata: {
                    delivered: false,
                    delivery_state: 'DRAFT_READY',
                    suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
                },
            }],
            expected: { needs_merchant_reply: true, needs_merchant_reply_reason: 'DRAFT_REVIEW_REQUIRED', ai_is_replying: false },
        },
        {
            name: 'AUTO processing',
            mode: 'AUTO',
            messages: [
                customerMessage,
                {
                    id: 'processing-ai',
                    conversation_id: 'conversation-1',
                    sender: 'ai',
                    created_at: new Date('2026-09-04T10:01:00Z'),
                    delivery_state: 'SEND_PENDING',
                    delivery_source: 'AUTO',
                    metadata: {
                        delivery_state: 'SEND_PENDING',
                        suggestion_visibility: 'HIDDEN_AUTO_PROCESSING',
                    },
                },
            ],
            expected: { needs_merchant_reply: false, needs_merchant_reply_reason: null, ai_is_replying: true },
        },
        {
            name: 'AUTO failure',
            mode: 'AUTO',
            messages: [
                customerMessage,
                {
                    id: 'failed-ai',
                    conversation_id: 'conversation-1',
                    sender: 'ai',
                    created_at: new Date('2026-09-04T10:01:00Z'),
                    delivery_state: 'FAILED',
                    metadata: {
                        delivery_state: 'FAILED',
                        held_reason: 'provider_send_failed',
                        suggestion_visibility: 'VISIBLE_HITL_REVIEW',
                    },
                },
            ],
            expected: { needs_merchant_reply: true, needs_merchant_reply_reason: 'AI_FAILED', ai_is_replying: false },
        },
        {
            name: 'AUTO dismissed draft',
            mode: 'AUTO',
            messages: [
                customerMessage,
                {
                    id: 'dismissed-ai',
                    conversation_id: 'conversation-1',
                    sender: 'ai',
                    created_at: new Date('2026-09-04T10:01:00Z'),
                    delivery_state: 'DISMISSED',
                    metadata: {
                        delivery_state: 'DISMISSED',
                        delivery_status: 'dismissed',
                        suggestion_visibility: 'HIDDEN_DISMISSED',
                        held_reason: 'dismissed',
                    },
                },
            ],
            expected: { needs_merchant_reply: true, needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED', ai_is_replying: false },
        },
        {
            name: 'AUTO provider outcome unknown',
            mode: 'AUTO',
            messages: [
                customerMessage,
                {
                    id: 'attempted-ai',
                    conversation_id: 'conversation-1',
                    sender: 'ai',
                    created_at: new Date('2026-09-04T10:01:00Z'),
                    delivery_state: 'SEND_PENDING',
                    delivery_source: 'AUTO',
                    metadata: {
                        delivery_state: 'SEND_PENDING',
                        provider_send_attempted: true,
                    },
                },
            ],
            expected: { needs_merchant_reply: true, needs_merchant_reply_reason: 'AI_FAILED', ai_is_replying: false },
        },
    ])('projects $name independently of unread state', async ({ mode, messages, expected }) => {
        const row = {
            id: 'conversation-1',
            customer_id: 'customer-1',
            channel: 'messenger',
            status: 'active',
            hitl: false,
            metadata: { unreadCount: 0 },
            customer: null,
            metaChannel: null,
            message: null,
        };
        mockConversationModel.findAndCountAll = jest.fn().mockResolvedValue({ rows: [row], count: 1 });
        getEffectiveAiReplyMode.mockResolvedValue(mode);
        mockMessageModel.findAll.mockResolvedValue(messages);

        const result = await conversationService.getConversations('shop-a');

        expect(result.conversations[0]).toEqual(expect.objectContaining(expected));
    });

    it('keeps Needs your reply while a system HITL escalation is still pending', async () => {
        const row = {
            id: 'conversation-1',
            customer_id: 'customer-1',
            channel: 'messenger',
            status: 'active',
            hitl: true,
            metadata: { unreadCount: 0 },
            customer: null,
            metaChannel: null,
            message: null,
        };
        mockConversationModel.findAndCountAll = jest.fn().mockResolvedValue({ rows: [row], count: 1 });
        getEffectiveAiReplyMode.mockResolvedValue('AUTO');
        mockMessageModel.findAll.mockResolvedValue([
            customerMessage,
            {
                id: 'escalation-pending',
                conversation_id: 'conversation-1',
                sender: 'ai',
                created_at: new Date('2026-09-04T10:01:00Z'),
                delivery_state: 'SEND_PENDING',
                delivery_source: 'HITL_ESCALATION',
                metadata: {
                    delivery_state: 'SEND_PENDING',
                    delivery_source: 'HITL_ESCALATION',
                },
            },
        ]);

        const result = await conversationService.getConversations('shop-a');

        expect(result.conversations[0]).toEqual(expect.objectContaining({
            needs_merchant_reply: true,
            ai_is_replying: false,
        }));
        expect(result.conversations[0].needs_merchant_reply_reason).toBeTruthy();
    });

    it('dismisses stale escalation and low-confidence candidates when Resume AI returns control', async () => {
        const escalation = {
            id: 'escalation-pending',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date('2026-09-04T10:01:00Z'),
            delivery_state: 'SEND_PENDING',
            delivery_source: 'HITL_ESCALATION',
            metadata: {
                delivered: false,
                delivery_state: 'SEND_PENDING',
                delivery_source: 'HITL_ESCALATION',
            },
            update: jest.fn(async (updates) => Object.assign(escalation, updates)),
        };
        const lowConfidence = {
            id: 'low-confidence-ai',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date('2026-09-04T10:02:00Z'),
            delivery_state: 'HELD',
            metadata: {
                delivered: false,
                delivery_state: 'HELD',
                held_reason: 'low_confidence',
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(async (updates) => Object.assign(lowConfidence, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([escalation, lowConfidence]);

        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });

        expect(escalation.delivery_state).toBe('DISMISSED');
        expect(lowConfidence.delivery_state).toBe('DISMISSED');
        expect(require('../message-lifecycle').isReviewableSuggestion(lowConfidence)).toBe(false);
    });

    it.each([
        ['HELD human_active', 'HELD', 'human_active', 'VISIBLE_HITL_REVIEW'],
        ['HELD low_confidence', 'HELD', 'low_confidence', 'VISIBLE_HITL_REVIEW'],
        ['HELD ai_paused', 'HELD', 'ai_paused', 'VISIBLE_HITL_REVIEW'],
        ['HELD mode_changed', 'HELD', 'mode_changed', 'VISIBLE_HITL_REVIEW'],
        ['HELD policy_blocked', 'HELD', 'policy_blocked', 'VISIBLE_HITL_REVIEW'],
        ['DRAFT_READY merchant requested', 'DRAFT_READY', 'merchant_requested', 'VISIBLE_MERCHANT_REQUESTED'],
        ['HITL escalation generating', 'GENERATING', 'handoff', 'HIDDEN_AUTO_PROCESSING'],
        ['HITL escalation pending', 'SEND_PENDING', 'handoff', 'HIDDEN_AUTO_PROCESSING'],
        ['HITL escalation held', 'HELD', 'delivery_lock_busy', 'VISIBLE_HITL_REVIEW'],
    ])('terminalizes every unattempted pre-Resume candidate: %s', async (_name, state, heldReason, visibility) => {
        const candidate = {
            id: `candidate-${state}-${heldReason}`,
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() - 10_000),
            delivery_state: state,
            delivery_source: heldReason === 'handoff' ? 'HITL_ESCALATION' : 'AI_DRAFT',
            metadata: {
                delivered: false,
                delivery_state: state,
                held_reason: heldReason,
                suggestion_visibility: visibility,
                ...(heldReason === 'handoff' ? { delivery_source: 'HITL_ESCALATION' } : {}),
            },
            update: jest.fn(async (updates) => Object.assign(candidate, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([candidate]);

        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });

        expect(candidate.delivery_state).toBe('DISMISSED');
        expect(candidate.metadata).toEqual(expect.objectContaining({
            delivery_state: 'DISMISSED',
            delivery_status: 'dismissed',
            suggestion_visibility: 'HIDDEN_DISMISSED',
            held_reason: 'resume_obsolete',
            dismissed_by_resume: true,
        }));
        expect(candidate.metadata.provider_send_attempted).not.toBe(true);
        expect(require('../message-lifecycle').isReviewableSuggestion(candidate)).toBe(false);
    });

    it('preserves provider-confirmed history and unknown provider outcomes on Resume', async () => {
        const confirmed = {
            id: 'confirmed-old',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() - 10_000),
            delivery_state: 'SENT',
            provider_message_id: 'mid-confirmed',
            metadata: {
                delivery_state: 'SENT',
                provider_message_id: 'mid-confirmed',
                provider_send_confirmed: true,
            },
            update: jest.fn(),
        };
        const unknown = {
            id: 'unknown-old',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() - 10_000),
            delivery_state: 'SEND_PENDING',
            provider_message_id: null,
            metadata: {
                delivery_state: 'SEND_PENDING',
                provider_send_attempted: true,
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([confirmed, unknown]);

        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });

        expect(confirmed.update).not.toHaveBeenCalled();
        expect(unknown.update).not.toHaveBeenCalled();
        expect(confirmed.delivery_state).toBe('SENT');
        expect(unknown.delivery_state).toBe('SEND_PENDING');
        expect(require('../message-lifecycle').isReviewableSuggestion(unknown)).toBe(false);
    });

    it('preserves a newer post-Resume logical turn and keeps Resume idempotent', async () => {
        const oldCandidate = {
            id: 'old-candidate',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() - 10_000),
            delivery_state: 'HELD',
            metadata: {
                delivery_state: 'HELD',
                held_reason: 'human_active',
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(async (updates) => Object.assign(oldCandidate, updates)),
        };
        const newerCandidate = {
            id: 'newer-candidate',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() + 10_000),
            delivery_state: 'DRAFT_READY',
            metadata: {
                delivery_state: 'DRAFT_READY',
                logical_turn_id: 'external-post-resume',
                suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
            },
            update: jest.fn(async (updates) => Object.assign(newerCandidate, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([oldCandidate, newerCandidate]);

        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });
        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });

        expect(oldCandidate.delivery_state).toBe('DISMISSED');
        expect(newerCandidate.delivery_state).toBe('DRAFT_READY');
        expect(newerCandidate.metadata.suggestion_visibility).toBe('VISIBLE_DRAFT_REVIEW');
        expect(conversation.metadata.ai_resume_boundary_at).toBeTruthy();
    });

    it('terminalizes an unattempted candidate with a malformed turn timestamp', async () => {
        const candidate = {
            id: 'malformed-turn-candidate',
            conversation_id: 'conversation-1',
            sender: 'ai',
            created_at: new Date(Date.now() - 10_000),
            delivery_state: 'HELD',
            metadata: {
                delivery_state: 'HELD',
                turn_started_at: '0',
                suggestion_visibility: 'VISIBLE_HITL_REVIEW',
            },
            update: jest.fn(async (updates) => Object.assign(candidate, updates)),
        };
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: {},
            update: jest.fn(async (updates) => Object.assign(conversation, updates)),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);
        mockMessageModel.findAll.mockResolvedValue([candidate]);

        await conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false });

        expect(candidate.delivery_state).toBe('DISMISSED');
        expect(candidate.metadata.held_reason).toBe('resume_obsolete');
    });

    it('rejects Resume instead of overwriting a malformed existing boundary', async () => {
        const conversation = {
            id: 'conversation-1',
            shop_id: 'shop-a',
            status: 'active',
            hitl: true,
            metadata: { ai_resume_boundary_at: '0' },
            update: jest.fn(),
        };
        mockConversationModel.findOne.mockResolvedValue(conversation);

        await expect(conversationService.updateConversation('conversation-1', 'shop-a', { hitl: false }))
            .rejects.toMatchObject({ code: 'RESUME_BOUNDARY_INVALID' });
        expect(conversation.update).not.toHaveBeenCalled();
    });
});
