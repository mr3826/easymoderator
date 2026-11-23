'use strict';

/**
 * A9 MF-1 — the D-P2-01 fallback seed must carry the REAL meta_channel_id.
 *
 * ai-chatbot.controller.js reads `ingestionResult.meta_channel_id` when seeding an
 * order session from the keyword-fallback tier, and getActiveSession matches that
 * column EXACTLY. Before the fix, NO producer emitted `meta_channel_id`, so the
 * fallback always seeded under a null channel and the worker (which resumes on the
 * real id) never found the session → duplicate/orphan sessions during an outage.
 *
 * This test calls the real ConversationStateService.ingestMessage producer and
 * asserts on its OUTPUT (not a hand-made fixture): the returned ingestionResult now
 * exposes the resolved meta channel, and it equals the id the same call uses to
 * look up the active session (so seed and resume agree). Fails against the pre-fix
 * producer because the key was absent.
 */

process.env.NODE_ENV = 'test';

const mockCustomerFindOne = jest.fn();
const mockCustomerCreate = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationCreate = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageFindAll = jest.fn();
const mockGetActiveSession = jest.fn();

jest.mock('../conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne, create: mockConversationCreate },
    Message: { create: mockMessageCreate, findAll: mockMessageFindAll },
}));
jest.mock('../../customer/customer.entity', () => ({ findOne: mockCustomerFindOne, create: mockCustomerCreate }));
jest.mock('../../order/order-session-standalone.service', () => ({ getActiveSession: mockGetActiveSession }));
jest.mock('../../shop/ai-reply-mode', () => ({ normalizeAiReplyMode: (m) => m }));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { getDialect: () => 'postgres', transaction: async (cb) => cb({ LOCK: { UPDATE: 'UPDATE' } }) },
}));

const ConversationStateService = require('../conversation-state-standalone.service');

const existingConversation = (over = {}) => ({
    id: 'conv-1', shop_id: 'shop-1', customer_id: 'cust-1', channel: 'messenger',
    meta_channel_id: 'chan-1', status: 'active', metadata: { message_count: 0 },
    update: jest.fn(async () => {}),
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockCustomerFindOne.mockResolvedValue({ id: 'cust-1', name: 'C', channel_user_id: 'psid-1' });
    mockConversationFindOne.mockResolvedValue(existingConversation());
    mockMessageCreate.mockResolvedValue({ id: 'msg-1', metadata: {} });
    mockMessageFindAll.mockResolvedValue([]);
    mockGetActiveSession.mockResolvedValue(null);
});

describe('A9 MF-1 — ingestMessage exposes the resolved meta channel', () => {
    test('the returned ingestionResult carries meta_channel_id (was absent pre-fix → orphaned seed)', async () => {
        const result = await ConversationStateService.ingestMessage({
            shop_id: 'shop-1', customer_channel_id: 'psid-1', platform: 'facebook',
            message: 'what is the price?', meta_channel_id: 'chan-1',
        });
        expect(result).toHaveProperty('meta_channel_id');
        expect(result.meta_channel_id).toBe('chan-1');
    });

    test('the exposed meta channel equals the id used to resume the active session', async () => {
        const result = await ConversationStateService.ingestMessage({
            shop_id: 'shop-1', customer_channel_id: 'psid-1', platform: 'facebook',
            message: 'price?', meta_channel_id: 'chan-1',
        });
        // getActiveSession(shop_id, customer_channel_id, metaChannelId, customer_id)
        expect(mockGetActiveSession).toHaveBeenCalledWith('shop-1', 'psid-1', 'chan-1', 'cust-1');
        expect(result.meta_channel_id).toBe(mockGetActiveSession.mock.calls[0][2]);
    });

    test('a conversation row that carries the channel wins even when the input omits it', async () => {
        mockConversationFindOne.mockResolvedValue(existingConversation({ meta_channel_id: 'chan-1' }));
        const result = await ConversationStateService.ingestMessage({
            shop_id: 'shop-1', customer_channel_id: 'psid-1', platform: 'facebook', message: 'hi',
        });
        expect(result.meta_channel_id).toBe('chan-1');
    });

    test('no channel anywhere → explicit null (never undefined, still matchable)', async () => {
        mockConversationFindOne.mockResolvedValue(existingConversation({ meta_channel_id: null }));
        const result = await ConversationStateService.ingestMessage({
            shop_id: 'shop-1', customer_channel_id: 'psid-1', platform: 'facebook', message: 'hi',
        });
        expect(result).toHaveProperty('meta_channel_id');
        expect(result.meta_channel_id).toBeNull();
    });
});
