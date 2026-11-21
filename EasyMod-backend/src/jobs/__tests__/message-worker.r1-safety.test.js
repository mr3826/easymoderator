'use strict';

process.env.NODE_ENV = 'test';

const mockChannel = {
    id: 'channel-1',
    shop_id: 'shop-1',
    platform: 'facebook',
    status: 'CONNECTED',
    meta_asset_id: 'page-1',
};

const mockGetShopAiSettings = jest.fn();
const mockGetChannelSettings = jest.fn();
const mockCacheGet = jest.fn(async () => null);
const mockFindUniqueChannel = jest.fn(async () => mockChannel);
const mockFindChannelById = jest.fn(async () => mockChannel);
const mockFindChannelByAsset = jest.fn(async () => null);
const mockEvaluateOutbound = jest.fn();
const mockSendMessage = jest.fn();
const mockGetProvider = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockProcessNewIntent = jest.fn();
const mockHandleOrderFlow = jest.fn();
const mockConversationFindOne = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageUpdate = jest.fn();
const mockMessageFindAll = jest.fn(async () => []);
const mockMessageCount = jest.fn(async () => 0);
const mockStoreAIResponse = jest.fn();
const mockStoredMessageUpdate = jest.fn();
const mockSubscriptionFindOne = jest.fn();
const mockRecoveryStartTurn = jest.fn();
const mockRecoveryTransition = jest.fn();

jest.mock('bullmq', () => ({
    Worker: jest.fn(),
    Queue: jest.fn(() => ({ add: jest.fn() })),
    UnrecoverableError: class UnrecoverableError extends Error {},
}));
jest.mock('src/jobs/message-queue', () => ({ connection: {} }));
jest.mock('src/config/redis', () => ({
    cacheRedis: {
        get: mockCacheGet,
        set: jest.fn(async () => 'OK'),
        setex: jest.fn(async () => 'OK'),
        del: jest.fn(async () => 1),
    },
}));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne },
    Message: {
        findOne: mockMessageFindOne,
        update: mockMessageUpdate,
        findAll: mockMessageFindAll,
        count: mockMessageCount,
        findByPk: jest.fn(async () => null),
    },
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({
    detectLanguage: jest.fn(() => 'en'),
    extractEntities: jest.fn(() => ({})),
    storeAIResponse: mockStoreAIResponse,
    updateConversationState: jest.fn(),
}));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: mockGetProvider }));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: mockEvaluateOutbound }));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({
    findConnectedById: mockFindChannelById,
    findByMetaAssetId: mockFindChannelByAsset,
    findUniqueConnectedByShopAndPlatform: mockFindUniqueChannel,
    getSettings: mockGetChannelSettings,
}));
jest.mock('src/modules/customer/customer.entity', () => ({
    findOne: jest.fn(async () => ({
        id: 'customer-1',
        shop_id: 'shop-1',
        channel_type: 'messenger',
        channel_user_id: 'recipient-1',
        messaging_consent: {},
    })),
}));
jest.mock('src/modules/channel-providers/meta-channel.entity', () => ({
    findByPk: jest.fn(async () => mockChannel),
}));
jest.mock('src/modules/channel-providers/meta-channel-settings.entity', () => ({
    findByPk: jest.fn(async () => ({
        channel_id: 'channel-1',
        overrides: {},
        automation_mode: 'AI_ACTIVE',
    })),
    findOrCreate: jest.fn(async () => [{
        channel_id: 'channel-1',
        overrides: {},
        automation_mode: 'AI_ACTIVE',
    }]),
}));
jest.mock('src/modules/shop/shop.service', () => ({ getShopAiSettings: mockGetShopAiSettings }));
jest.mock('src/modules/entities', () => ({
    Shop: { findByPk: jest.fn(async () => ({ is_active: true, settings: { ai: { automation_mode: 'AUTO' } } })) },
    Subscription: { findOne: mockSubscriptionFindOne },
    MetaChannel: { findByPk: jest.fn(async () => mockChannel) },
    MetaChannelSettings: {
        findByPk: jest.fn(async () => ({
            channel_id: 'channel-1',
            overrides: {},
            automation_mode: 'AI_ACTIVE',
        })),
        findOrCreate: jest.fn(async () => [{
            channel_id: 'channel-1',
            overrides: {},
            automation_mode: 'AI_ACTIVE',
        }]),
    },
}));
jest.mock('src/modules/subscription/subscription.access', () => ({ isAiActive: jest.fn(() => true) }));
jest.mock('src/modules/ai/sentiment.service', () => ({
    analyzeSentiment: jest.fn(async () => ({ sentiment: 'neutral', score: 0, method: 'keyword' })),
    shouldAutoEscalate: jest.fn(() => false),
}));
jest.mock('src/modules/conversation/order-flow.service', () => ({
    handleOrderFlow: mockHandleOrderFlow,
    hasPurchaseIntent: jest.fn(() => false),
}));
jest.mock('src/modules/conversation/ai-chatbot.controller', () => ({ processNewIntent: mockProcessNewIntent }));
jest.mock('src/modules/conversation/human-handoff.service', () => ({ escalateToHuman: jest.fn(async () => {}) }));
jest.mock('src/modules/knowledge/knowledge-gap-capture.service', () => ({ recordKnowledgeGap: jest.fn(async () => {}) }));
jest.mock('src/modules/analytics/growth-metrics.service', () => ({ recordActivation: jest.fn(() => Promise.resolve()) }));
jest.mock('src/modules/analytics/funnel-events.service', () => ({ recordInternalFunnelEvent: jest.fn(() => Promise.resolve()) }));
jest.mock('src/modules/shop/ai-messaging', () => ({ buildGreeting: jest.fn(() => '') }));
jest.mock('src/modules/shop/shop.entity', () => ({ findByPk: jest.fn(async () => ({ name: 'Test shop', settings: {} })) }));
jest.mock('src/modules/ai/recovery/turn-recovery.service', () => ({
    startTurn: mockRecoveryStartTurn,
    transition: mockRecoveryTransition,
    isHoldingSuppressed: jest.fn(() => false),
    isHardTimeoutSuppressed: jest.fn(() => false),
}));
jest.mock('src/modules/order/order-session-standalone.service', () => ({
    getActiveSession: jest.fn(async () => null),
    getSessionForInteraction: jest.fn(async () => null),
}));
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({
    isInteractionChoicesEnabled: jest.fn(async () => false),
}));
jest.mock('src/modules/interactions/interactions.service', () => ({
    resolveInteraction: jest.fn(),
    findNumberedLivePayload: jest.fn(async () => null),
    renderQuickReplies: jest.fn(async () => null),
    markSent: jest.fn(async () => true),
    createProposal: jest.fn(async () => null),
    contextVersionFor: () => 'INIT:',
}));

const { processMessageJob, _private } = require('src/jobs/message-worker');

beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockFindUniqueChannel.mockResolvedValue(mockChannel);
    mockFindChannelById.mockResolvedValue(mockChannel);
    mockGetShopAiSettings.mockResolvedValue({
        automation_mode: 'AUTO',
        confidence_threshold: 75,
        staticConfigAvailable: { DELIVERY_POLICY: false, DELIVERY_CHARGE: false },
    });
    mockGetChannelSettings.mockResolvedValue({
        automation_mode: 'AI_ACTIVE',
        ai_auto_reply: true,
        business_hours: null,
        confidence_threshold_send: 0.75,
        confidence_threshold_suggest: 0.5,
        allow_order_creation: true,
    });
    mockSubscriptionFindOne.mockResolvedValue({ status: 'active' });
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageUpdate.mockResolvedValue([1]);
    mockRecoveryStartTurn.mockImplementation(async ({ traceId }) => ({
        turn: { trace_id: traceId, turn_started_at: new Date(), state: 'RECEIVED' },
    }));
    mockRecoveryTransition.mockResolvedValue(undefined);
    mockHandleOrderFlow.mockResolvedValue({ handled: false });
    mockProcessNewIntent.mockResolvedValue({
        response: 'Price is 990 BDT',
        confidence: 0.95,
        source: 'llm',
        grounding: {
            productStatus: 'NO_CANDIDATE',
            mediaStatus: 'NOT_REQUESTED',
            mediaProductId: null,
            verifiedProducts: [],
            knowledgeIds: [],
        },
        attachments: [],
    });
    mockStoreAIResponse.mockImplementation(async (_conversationId, content) => ({
        message: {
            id: 'ai-1',
            conversation_id: 'conv-1',
            content,
            delivery_state: 'SEND_PENDING',
            metadata: { provider_send_claimed: true },
            update: mockStoredMessageUpdate,
        },
    }));
});

test('claimProviderSendBoundary blocks cross-shop conversation mismatch without updating message', async () => {
    mockConversationFindOne.mockResolvedValueOnce(null);

    const result = await _private.claimProviderSendBoundary(
        { id: 'ai-1', conversation_id: 'conv-other-shop', metadata: { provider_send_claimed: true } },
        'idem-cross-shop',
        'shop-1',
        'channel-1',
    );

    expect(result).toEqual({ allowed: false, reason: 'conversation_unavailable' });
    expect(mockMessageUpdate).not.toHaveBeenCalled();
});

test('claimProviderSendBoundary blocks send when pinned channel is missing', async () => {
    mockConversationFindOne.mockResolvedValueOnce({
        id: 'conv-1',
        customer_id: 'customer-1',
        channel: 'messenger',
        meta_channel_id: null,
        hitl: false,
        status: 'open',
        metadata: {},
    });

    const result = await _private.claimProviderSendBoundary(
        { id: 'ai-1', conversation_id: 'conv-1', metadata: { provider_send_claimed: true } },
        'idem-missing-pin',
        'shop-1',
        null,
    );

    expect(result).toEqual({ allowed: false, reason: 'channel_settings_unavailable' });
    expect(mockMessageUpdate).not.toHaveBeenCalled();
});

test('claimProviderSendBoundary rejects duplicate / already-attempted send when CAS update affects 0 rows', async () => {
    mockConversationFindOne.mockResolvedValueOnce({
        id: 'conv-1',
        customer_id: 'customer-1',
        channel: 'messenger',
        meta_channel_id: 'channel-1',
        hitl: false,
        status: 'open',
        metadata: {},
    });
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageUpdate.mockResolvedValueOnce([0]);

    const result = await _private.claimProviderSendBoundary(
        { id: 'ai-1', conversation_id: 'conv-1', metadata: { provider_send_claimed: true } },
        'idem-dup',
        'shop-1',
        'channel-1',
    );

    expect(result).toEqual({ allowed: false, reason: 'candidate_invalidated' });
});

test('processMessageJob holds candidate and never calls provider when 24h outbound policy blocks', async () => {
    mockConversationFindOne.mockResolvedValue({
        id: 'conv-1',
        customer_id: 'customer-1',
        channel: 'messenger',
        meta_channel_id: 'channel-1',
        hitl: false,
        status: 'open',
        metadata: {},
    });
    mockEvaluateOutbound.mockResolvedValueOnce({ allow: false, reason: 'MESSENGER_WINDOW_EXPIRED' });

    const result = await processMessageJob({
        id: 'job-24h',
        data: {
            shopId: 'shop-1',
            conversationId: 'conv-1',
            messageId: 'message-1',
            externalId: 'external-1',
            message: 'Price please',
            platform: 'facebook',
            recipientId: 'recipient-1',
            senderInfo: {},
        },
        moveToDelayed: jest.fn(),
    });

    expect(result).toEqual(expect.objectContaining({
        sent: false,
        reason: 'MESSENGER_WINDOW_EXPIRED',
    }));
    expect(mockSendMessage).not.toHaveBeenCalled();
});
