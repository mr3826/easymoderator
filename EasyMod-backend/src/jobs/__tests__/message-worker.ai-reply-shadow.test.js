'use strict';

process.env.NODE_ENV = 'test';

const mockConversationFindOne = jest.fn();
const mockConversationUpdate = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageUpdate = jest.fn();
const mockSseEmit = jest.fn();
const mockRecordAcceptedAiReply = jest.fn();

jest.mock('bullmq', () => ({
    Worker: jest.fn(),
    Queue: jest.fn(() => ({ add: jest.fn() })),
    UnrecoverableError: class UnrecoverableError extends Error {},
    DelayedError: class DelayedError extends Error {},
}), { virtual: true });
jest.mock('sequelize', () => ({
    Op: {
        and: Symbol('and'),
        in: Symbol('in'),
        ne: Symbol('ne'),
        notIn: Symbol('notIn'),
    },
    literal: (value) => value,
}), { virtual: true });
jest.mock('src/jobs/message-queue', () => ({ connection: {} }));
jest.mock('src/config/redis', () => ({
    cacheRedis: { get: jest.fn(async () => null), set: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('src/utils/sse-manager', () => ({ emit: mockSseEmit }));
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { getDialect: () => 'sqlite' },
}));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne, update: mockConversationUpdate },
    Message: {
        findOne: mockMessageFindOne,
        update: mockMessageUpdate,
        findAll: jest.fn(async () => []),
        count: jest.fn(async () => 0),
    },
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({}));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({}));
jest.mock('src/modules/customer/customer.entity', () => ({}));
jest.mock('src/modules/entities', () => ({}));
jest.mock('src/modules/shop/shop.service', () => ({}));
jest.mock('src/modules/shop/ai-messaging', () => ({}));
jest.mock('src/modules/shop/shop.entity', () => ({}));
jest.mock('src/modules/ai/sentiment.service', () => ({}));
jest.mock('src/modules/conversation/order-flow.service', () => ({}));
jest.mock('src/modules/conversation/ai-chatbot.controller', () => ({}));
jest.mock('src/modules/conversation/human-handoff.service', () => ({}));
jest.mock('src/modules/knowledge/knowledge-gap-capture.service', () => ({}));
jest.mock('src/modules/analytics/growth-metrics.service', () => ({}));
jest.mock('src/modules/analytics/funnel-events.service', () => ({}));
jest.mock('src/modules/subscription/ai-reply-shadow-ledger.service', () => ({
    recordAcceptedAiReply: mockRecordAcceptedAiReply,
}));

const { _private } = require('../message-worker');

function pendingAiMessage() {
    return {
        id: 'message-1',
        conversation_id: 'conversation-1',
        sender: 'ai',
        content: 'reply content not passed to the meter',
        created_at: new Date('2026-11-01T00:00:00.000Z'),
        delivery_state: 'SEND_PENDING',
        delivery_source: 'AUTO',
        metadata: {
            logical_turn_id: 'turn-1',
            turn_started_at: '2026-11-01T00:00:00.000Z',
        },
        update: jest.fn(),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockConversationFindOne.mockResolvedValue({ id: 'conversation-1', metadata: {} });
    mockConversationUpdate.mockResolvedValue([1]);
    mockMessageUpdate.mockResolvedValue([1]);
    mockRecordAcceptedAiReply.mockResolvedValue({ recorded: true });
});

it('invokes the meter only after the accepted AUTO message is durably finalized', async () => {
    const message = pendingAiMessage();
    mockMessageFindOne.mockResolvedValue(message);

    const result = await _private.finalizeAiMessage(message, 'shop-1', 'conversation-1', {
        delivered: true,
        providerMessageId: 'meta-mid-1',
    });

    expect(result).toEqual(expect.objectContaining({ providerConfirmed: true, persisted: true }));
    expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        delivery_state: 'SENT',
        provider_message_id: 'meta-mid-1',
        metadata: expect.objectContaining({
            provider_send_confirmed: true,
            provider_accepted_at: expect.any(String),
        }),
    }), expect.any(Object));
    expect(mockMessageUpdate.mock.invocationCallOrder[0])
        .toBeLessThan(mockRecordAcceptedAiReply.mock.invocationCallOrder[0]);
    expect(mockRecordAcceptedAiReply).toHaveBeenCalledWith(expect.objectContaining({
        shopId: 'shop-1',
        acceptedAt: expect.any(String),
        message: expect.objectContaining({
            id: 'message-1',
            delivery_state: 'SENT',
            delivery_source: 'AUTO',
        }),
    }));
});

it('keeps the accepted message durable and retries only metering after a ledger failure', async () => {
    const message = pendingAiMessage();
    mockMessageFindOne.mockResolvedValue(message);
    mockRecordAcceptedAiReply.mockRejectedValue(new Error('meter store unavailable'));

    await expect(_private.finalizeAiMessage(message, 'shop-1', 'conversation-1', {
        delivered: true,
        providerMessageId: 'meta-mid-1',
    })).rejects.toMatchObject({ retryable: true, code: 'AI_REPLY_SHADOW_LEDGER_FAILED' });
    expect(mockMessageUpdate).toHaveBeenCalled();
});

it('retries a temporary shadow-gate read failure without undoing provider acceptance', async () => {
    const message = pendingAiMessage();
    mockMessageFindOne.mockResolvedValue(message);
    mockRecordAcceptedAiReply.mockResolvedValue({ recorded: false, reason: 'gate_unavailable' });

    await expect(_private.finalizeAiMessage(message, 'shop-1', 'conversation-1', {
        delivered: true,
        providerMessageId: 'meta-mid-1',
    })).rejects.toMatchObject({ retryable: true, code: 'AI_REPLY_SHADOW_LEDGER_FAILED' });
    expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        delivery_state: 'SENT',
        provider_message_id: 'meta-mid-1',
    }), expect.any(Object));
});

it('recovers the ledger write when a worker retry finds an already accepted AUTO reply', async () => {
    const accepted = {
        ...pendingAiMessage(),
        delivery_state: 'SENT',
        metadata: {
            logical_turn_id: 'turn-1',
            delivery_source: 'AUTO',
            delivered: true,
            provider_send_confirmed: true,
            provider_message_id: 'meta-mid-1',
            provider_accepted_at: '2026-11-01T00:00:01.000Z',
        },
    };

    await expect(_private.recoverAcceptedAutoReplyShadow('shop-1', accepted, 'SENT')).resolves.toBe(true);
    expect(mockRecordAcceptedAiReply).toHaveBeenCalledWith(expect.objectContaining({
        shopId: 'shop-1',
        acceptedAt: '2026-11-01T00:00:01.000Z',
    }));
});

it('does not recover shadow usage for an unsent automatic candidate', async () => {
    await expect(_private.recoverAcceptedAutoReplyShadow('shop-1', pendingAiMessage(), 'SEND_PENDING')).resolves.toBe(false);
    expect(mockRecordAcceptedAiReply).not.toHaveBeenCalled();
});

it('recovers the ledger before returning from an already-claimed AUTO send branch', async () => {
    const accepted = {
        ...pendingAiMessage(),
        delivery_state: 'SENT',
        metadata: {
            logical_turn_id: 'turn-1',
            delivery_source: 'AUTO',
            delivered: true,
            provider_send_confirmed: true,
            provider_message_id: 'meta-mid-1',
            provider_accepted_at: '2026-11-01T00:00:01.000Z',
        },
    };

    await expect(_private.finishAlreadyClaimedAutomaticSend('shop-1', 'conversation-1', accepted, 'SENT'))
        .resolves.toEqual({
            success: true,
            conversationId: 'conversation-1',
            sent: true,
            reason: 'provider_send_already_claimed',
        });
    expect(mockRecordAcceptedAiReply).toHaveBeenCalledTimes(1);
});

it('does not meter an unsent AI draft', async () => {
    const draft = {
        ...pendingAiMessage(),
        delivery_state: 'DRAFT_READY',
        delivery_source: 'AI_DRAFT',
        metadata: { turn_started_at: '2026-11-01T00:00:00.000Z' },
    };
    mockMessageFindOne.mockResolvedValue(draft);

    const result = await _private.finalizeAiMessage(draft, 'shop-1', 'conversation-1', {
        delivered: false,
        heldReason: 'draft_mode',
        deliveryState: 'DRAFT_READY',
        deliverySource: 'AI_DRAFT',
    });

    expect(result).toEqual(expect.objectContaining({ providerConfirmed: false, persisted: true }));
    expect(mockRecordAcceptedAiReply).not.toHaveBeenCalled();
});
