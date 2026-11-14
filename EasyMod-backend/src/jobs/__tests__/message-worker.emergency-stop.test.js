'use strict';

/**
 * ADR-0013 §6 / TEST_STRATEGY §2C — business-wide emergency stop in the worker.
 *
 * Pins: Guard 4 skip (no LLM), channel override cannot bypass, pre-policy hold,
 * provider-boundary hold, recovery holding suppression, fail-closed loader
 * errors (hold, never a retry storm), and that human state (hitl) is untouched.
 */

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
const mockCacheDel = jest.fn(async () => 1);
const mockEvaluateOutbound = jest.fn();
const mockSendMessage = jest.fn();
const mockGetProvider = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockProcessNewIntent = jest.fn();
const mockHandleOrderFlow = jest.fn();
const mockHasPurchaseIntent = jest.fn();
const mockConversationFindOne = jest.fn();
const mockMessageFindAll = jest.fn();
const mockMessageCount = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageUpdate = jest.fn();
const mockStoreAIResponse = jest.fn();
const mockStoredMessageUpdate = jest.fn();
const mockSubscriptionFindOne = jest.fn();
const mockRecoveryStartTurn = jest.fn();
const mockRecoveryTransition = jest.fn();
const mockMessageFindByPk = jest.fn();
const mockResolveInteraction = jest.fn();
const mockFindNumberedLivePayload = jest.fn();
const mockRenderQuickReplies = jest.fn();
const mockMarkSent = jest.fn();
const mockCreateProposal = jest.fn();
const mockIsInteractionChoicesEnabled = jest.fn(async () => true);
const mockGetSessionForInteraction = jest.fn();
const mockNotifyShop = jest.fn(async () => ({ queued: true }));
const mockShopFindByPk = jest.fn();
const mockLoadEffectiveChannelAutomation = jest.fn();

jest.mock('src/modules/interactions/interactions.service', () => ({
    resolveInteraction: mockResolveInteraction,
    findNumberedLivePayload: mockFindNumberedLivePayload,
    renderQuickReplies: mockRenderQuickReplies,
    markSent: mockMarkSent,
    createProposal: mockCreateProposal,
    contextVersionFor: (session) => `${session.current_step}:`,
}));
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({
    isInteractionChoicesEnabled: mockIsInteractionChoicesEnabled,
}));
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
        del: mockCacheDel,
    },
}));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne },
    Message: {
        findAll: mockMessageFindAll,
        count: mockMessageCount,
        findOne: mockMessageFindOne,
        findByPk: mockMessageFindByPk,
        update: mockMessageUpdate,
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
    findConnectedById: jest.fn(async () => mockChannel),
    findByMetaAssetId: jest.fn(async () => null),
    findUniqueConnectedByShopAndPlatform: jest.fn(async () => mockChannel),
    getSettings: mockGetChannelSettings,
}));
jest.mock('src/modules/channel-providers/channel-automation.resolver', () => {
    const actual = jest.requireActual('src/modules/channel-providers/channel-automation.resolver');
    return {
        ...actual,
        loadEffectiveChannelAutomation: (...args) => mockLoadEffectiveChannelAutomation(...args),
    };
});
jest.mock('src/modules/customer/customer.entity', () => ({
    findOne: jest.fn(async () => ({
        id: 'customer-1',
        shop_id: 'shop-1',
        channel_type: 'messenger',
        channel_user_id: 'recipient-1',
        messaging_consent: {},
    })),
}));
jest.mock('src/modules/shop/shop.service', () => ({ getShopAiSettings: mockGetShopAiSettings }));
jest.mock('src/modules/entities', () => ({
    Shop: { findByPk: (...args) => mockShopFindByPk(...args) },
    Subscription: { findOne: mockSubscriptionFindOne },
}));
jest.mock('src/modules/subscription/subscription.access', () => ({ isAiActive: jest.fn(() => true) }));
jest.mock('src/modules/ai/sentiment.service', () => ({
    analyzeSentiment: jest.fn(async () => ({ sentiment: 'neutral', score: 0, method: 'keyword' })),
    shouldAutoEscalate: jest.fn(() => false),
}));
jest.mock('src/modules/conversation/order-flow.service', () => ({
    handleOrderFlow: mockHandleOrderFlow,
    hasPurchaseIntent: mockHasPurchaseIntent,
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
    requireHuman: jest.fn(async () => ({})),
}));
jest.mock('src/modules/order/order-session-standalone.service', () => ({
    getActiveSession: jest.fn(async () => null),
    getSessionForInteraction: mockGetSessionForInteraction,
}));
jest.mock('src/modules/ai/intent/stage2-rules', () => ({
    classify: jest.fn(() => ({
        intentId: 'GENERAL_INQUIRY', domain: 'CONVERSATION', slots: {}, confidence: 1, source: 'RULE', matchedRule: 'test',
    })),
}));
jest.mock('src/modules/ai/contracts/intent.contract', () => ({ createIntentRecord: jest.fn((input) => ({ ...input })) }));
jest.mock('src/modules/ai/grounding', () => ({
    GroundingDecision: { SEND: 'SEND', SUPPRESS: 'SUPPRESS', SAFE_FALLBACK: 'SAFE_FALLBACK' },
    ReasonCode: { GROUNDED: 'GROUNDED', RETRIEVAL_FAILED: 'RETRIEVAL_FAILED' },
    emptyEvidence: jest.fn(() => ({ verifiedProducts: [], knowledgeIds: [] })),
    evaluateCandidate: jest.fn(({ candidate }) => ({
        decision: 'SEND', reasonCode: 'GROUNDED', text: candidate, attachments: [], violations: [],
    })),
    logGroundingDecision: jest.fn(),
    isModelGenerated: jest.fn(() => false),
    withSourceText: jest.fn((evidence) => evidence),
}));
jest.mock('src/modules/notification/merchant-notification.service', () => ({ notifyShop: mockNotifyShop }));
jest.mock('src/modules/notification/notification-events', () => ({ NOTIFICATION_EVENTS: { AI_HITL: 'ai_hitl' } }));

const { processMessageJob, _private } = require('src/jobs/message-worker');

const makeJob = () => ({
    id: 'job-1',
    data: {
        shopId: 'shop-1',
        conversationId: 'conv-1',
        messageId: 'message-1',
        externalId: 'external-1',
        message: 'What is the price?',
        platform: 'facebook',
        recipientId: 'recipient-1',
        senderInfo: {},
    },
    moveToDelayed: jest.fn(),
    token: 'job-token',
});

const shopSettings = (automation_mode = 'AUTO') => ({
    automation_mode,
    confidence_threshold: 75,
    // Avoid the extra static-config Shop read between Guard 4 and the
    // pre-policy re-check so the mock sequence stays deterministic.
    staticConfigAvailable: { DELIVERY_POLICY: false, DELIVERY_CHARGE: false },
});

const openConversation = (over = {}) => ({
    id: 'conv-1',
    shop_id: 'shop-1',
    customer_id: 'customer-1',
    channel: 'messenger',
    meta_channel_id: 'channel-1',
    hitl: false,
    status: 'open',
    metadata: {},
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockChannel.status = 'CONNECTED';
    mockMessageFindByPk.mockResolvedValue(null);
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageUpdate.mockResolvedValue([1]);
    mockIsInteractionChoicesEnabled.mockResolvedValue(true);
    mockFindNumberedLivePayload.mockResolvedValue(null);
    mockRenderQuickReplies.mockResolvedValue(null);
    mockCreateProposal.mockResolvedValue(null);
    mockMarkSent.mockResolvedValue(true);
    mockGetSessionForInteraction.mockResolvedValue(null);
    mockCacheGet.mockReset().mockResolvedValue(null);
    mockCacheDel.mockReset().mockResolvedValue(1);
    mockConversationFindOne.mockResolvedValue(openConversation());
    mockMessageFindAll.mockResolvedValue([]);
    mockMessageCount.mockResolvedValue(0);
    mockGetShopAiSettings.mockReset().mockResolvedValue(shopSettings());
    mockGetChannelSettings.mockReset().mockResolvedValue({
        business_hours: null,
        allow_order_creation: true,
        overrides: {},
    });
    mockSubscriptionFindOne.mockResolvedValue({ status: 'active' });
    mockShopFindByPk.mockResolvedValue({ id: 'shop-1', is_active: true, ai_emergency_stop: false });
    mockLoadEffectiveChannelAutomation.mockResolvedValue({
        mode: 'AUTO',
        modeSource: 'business_default',
        emergencyStop: { active: false },
        shopIsActive: true,
        billingAiActive: true,
        effective: { automation_mode: 'AUTO', confidence_threshold: 75, business_hours: null, allow_order_creation: true, purpose_label: null },
        overrides: {},
        warnings: [],
    });
    mockRecoveryStartTurn.mockImplementation(async ({ traceId }) => ({
        turn: { trace_id: traceId, turn_started_at: new Date(), state: 'RECEIVED' },
    }));
    mockRecoveryTransition.mockResolvedValue(undefined);
    mockHandleOrderFlow.mockResolvedValue({ handled: false });
    mockHasPurchaseIntent.mockReturnValue(false);
    mockProcessNewIntent.mockResolvedValue({
        response: 'candidate response',
        confidence: 0.95,
        source: 'llm',
        grounding: { productStatus: 'NO_CANDIDATE', mediaStatus: 'NOT_REQUESTED', mediaProductId: null, verifiedProducts: [], knowledgeIds: [] },
        attachments: [],
    });
    mockEvaluateOutbound.mockReset().mockResolvedValue({ allow: true, decisionId: 'policy-1', transform: null });
    mockSendMessage.mockReset().mockResolvedValue({ providerMessageId: 'provider-1' });
    mockStoreAIResponse.mockImplementation(async (_conversationId, content, opts = {}) => ({
        message: {
            id: 'ai-1',
            content,
            metadata: {},
            update: mockStoredMessageUpdate,
        },
    }));
});

describe('emergency stop — Guard 4', () => {
    test('stop skips before any LLM/policy work and preserves the merchant notification', async () => {
        mockShopFindByPk.mockResolvedValue({ id: 'shop-1', is_active: true, ai_emergency_stop: true });

        const result = await processMessageJob(makeJob());

        expect(result).toEqual(expect.objectContaining({
            skipped: true,
            reason: 'emergency_stop',
            mode_source: 'emergency_stop',
        }));
        expect(mockProcessNewIntent).not.toHaveBeenCalled();
        expect(mockEvaluateOutbound).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockNotifyShop).toHaveBeenCalled();
    });

    test('a channel AUTO override cannot bypass the business-wide stop', async () => {
        mockShopFindByPk.mockResolvedValue({ id: 'shop-1', is_active: true, ai_emergency_stop: true });
        mockGetChannelSettings.mockResolvedValue({
            business_hours: null,
            allow_order_creation: true,
            overrides: { automation_mode: 'AUTO' },
        });

        const result = await processMessageJob(makeJob());

        expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'emergency_stop' }));
        expect(mockProcessNewIntent).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('an inactive shop skips with reason shop_inactive', async () => {
        mockShopFindByPk.mockResolvedValue({ id: 'shop-1', is_active: false, ai_emergency_stop: false });

        const result = await processMessageJob(makeJob());

        expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'shop_inactive' }));
        expect(mockProcessNewIntent).not.toHaveBeenCalled();
    });

    test('a stop engaged after Guard 4 holds the generated reply at the pre-policy re-check', async () => {
        const activeShop = { id: 'shop-1', is_active: true, ai_emergency_stop: false };
        const stoppedShop = { id: 'shop-1', is_active: true, ai_emergency_stop: true };
        let safetyReads = 0;
        mockShopFindByPk.mockImplementation(async (_id, options = {}) => {
            if ((options.attributes || []).includes('ai_emergency_stop')) {
                safetyReads += 1;
                return safetyReads === 1 ? activeShop : stoppedShop;
            }
            return { id: 'shop-1', settings: {}, is_active: true, ai_emergency_stop: false };
        });

        const result = await processMessageJob(makeJob());

        expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'emergency_stop' }));
        expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                delivered: false,
                held_reason: 'emergency_stop',
                delivery_state: 'HELD',
            }),
        }), expect.any(Object));
    });
});

describe('emergency stop — provider boundary', () => {
    const candidate = () => ({
        id: 'ai-1',
        conversation_id: 'conv-1',
        sender: 'ai',
        metadata: { provider_send_claimed: true },
    });

    test('holds with emergency_stop and never mutates the candidate', async () => {
        mockLoadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL', modeSource: 'emergency_stop', emergencyStop: { active: true },
        });

        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');

        expect(result).toEqual({ allowed: false, reason: 'emergency_stop' });
        expect(mockMessageUpdate).not.toHaveBeenCalled();
    });

    test('holds with shop_inactive', async () => {
        mockLoadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL', modeSource: 'shop_inactive', emergencyStop: { active: false },
        });
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');
        expect(result).toEqual({ allowed: false, reason: 'shop_inactive' });
    });

    test('holds with mode_changed when the channel narrows to DRAFT', async () => {
        mockLoadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'DRAFT', modeSource: 'channel_override', emergencyStop: { active: false },
        });
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');
        expect(result).toEqual({ allowed: false, reason: 'mode_changed' });
    });

    test.each([
        ['throws', () => Promise.reject(new Error('db down'))],
        ['returns null', () => Promise.resolve(null)],
    ])('a loader that %s holds with channel_settings_unavailable (no retry storm)', async (_label, impl) => {
        mockLoadEffectiveChannelAutomation.mockImplementationOnce(impl);
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');
        expect(result).toEqual({ allowed: false, reason: 'channel_settings_unavailable' });
        expect(mockMessageUpdate).not.toHaveBeenCalled();
    });

    test('a conversation without a channel pin falls back to the job channel', async () => {
        mockConversationFindOne.mockResolvedValueOnce(openConversation({ meta_channel_id: null }));
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');
        expect(mockLoadEffectiveChannelAutomation).toHaveBeenCalledWith(
            'shop-1', 'channel-1', expect.objectContaining({ transaction: null }),
        );
        expect(result).toEqual({ allowed: true, reason: null });
    });

    test('no channel pin and no fallback holds with channel_settings_unavailable', async () => {
        mockConversationFindOne.mockResolvedValueOnce(openConversation({ meta_channel_id: null }));
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', null);
        expect(result).toEqual({ allowed: false, reason: 'channel_settings_unavailable' });
    });

    test('needs_human status holds as human_active (legacy handoff defense-in-depth)', async () => {
        mockConversationFindOne.mockResolvedValueOnce(openConversation({ status: 'needs_human' }));
        const result = await _private.claimProviderSendBoundary(candidate(), 'idem-1', 'shop-1', 'channel-1');
        expect(result).toEqual({ allowed: false, reason: 'human_active' });
    });

    test('an AUTO resolver read allows the boundary and claims the candidate', async () => {
        const message = candidate();
        const result = await _private.claimProviderSendBoundary(message, 'idem-1', 'shop-1', 'channel-1');
        expect(result).toEqual({ allowed: true, reason: null });
        expect(mockMessageUpdate).toHaveBeenCalledTimes(1);
        expect(message.metadata).toEqual(expect.objectContaining({ provider_send_attempted: true }));
    });
});

describe('emergency stop — recovery holding path', () => {
    test('suppresses the automatic holding send and records emergency_stop without touching hitl', async () => {
        mockLoadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL', modeSource: 'emergency_stop', emergencyStop: { active: true },
        });
        const control = _private.createRecoveryControl({
            turnId: 'turn-1',
            shopId: 'shop-1',
            conversationId: 'conv-1',
            platform: 'facebook',
            recipientId: 'recipient-1',
            channel: { id: 'channel-1' },
            providerDelayRecovery: true,
        });
        control.setPolicySettings({ automation_mode: 'AUTO' });

        const sent = await control.sendHolding('PROVIDER_DELAY');
        await control.close();

        expect(sent).toBeNull();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockRecoveryTransition).toHaveBeenCalledWith(
            expect.any(Object),
            'RETRY_PENDING',
            expect.objectContaining({ heldReason: 'emergency_stop', outboundStatus: 'BLOCKED' }),
        );
        // Human agency: hitl is not cleared and the conversation row is only READ
        // (the recovery path never mutates conversation state).
        expect(mockConversationFindOne).toHaveBeenCalledWith(expect.objectContaining({
            attributes: ['id', 'metadata'],
        }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});