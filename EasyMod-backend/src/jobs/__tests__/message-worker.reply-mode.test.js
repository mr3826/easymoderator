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
const mockCacheDel = jest.fn(async () => 1);
const mockFindUniqueChannel = jest.fn(async () => mockChannel);
const mockFindChannelById = jest.fn(async () => mockChannel);
const mockFindChannelByAsset = jest.fn(async () => null);
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
const mockStoreAIResponse = jest.fn();
const mockStoredMessageUpdate = jest.fn();
const mockUpdateConversationState = jest.fn();
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
        findByPk: mockMessageFindByPk,
    },
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({
    detectLanguage: jest.fn(() => 'en'),
    extractEntities: jest.fn(() => ({})),
    storeAIResponse: mockStoreAIResponse,
    updateConversationState: mockUpdateConversationState,
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
    })),
}));
jest.mock('src/modules/shop/shop.service', () => ({ getShopAiSettings: mockGetShopAiSettings }));
jest.mock('src/modules/entities', () => ({
    Shop: { findByPk: jest.fn(async () => ({ settings: {} })) },
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
}));
jest.mock('src/modules/order/order-session-standalone.service', () => ({
    getActiveSession: jest.fn(async () => null),
    getSessionForInteraction: mockGetSessionForInteraction,
}));
jest.mock('src/modules/ai/intent/stage2-rules', () => ({
    classify: jest.fn(() => ({
        intentId: 'GENERAL_INQUIRY',
        domain: 'CONVERSATION',
        slots: {},
        confidence: 1,
        source: 'RULE',
        matchedRule: 'test',
    })),
}));
jest.mock('src/modules/ai/contracts/intent.contract', () => ({
    createIntentRecord: jest.fn((input) => ({ ...input })),
}));
jest.mock('src/modules/ai/grounding', () => ({
    GroundingDecision: { SEND: 'SEND', SUPPRESS: 'SUPPRESS', SAFE_FALLBACK: 'SAFE_FALLBACK' },
    ReasonCode: { GROUNDED: 'GROUNDED', RETRIEVAL_FAILED: 'RETRIEVAL_FAILED' },
    emptyEvidence: jest.fn(() => ({
        productStatus: 'NO_CANDIDATE',
        mediaStatus: 'NOT_REQUESTED',
        mediaProductId: null,
        verifiedProducts: [],
        knowledgeIds: [],
    })),
    evaluateCandidate: jest.fn(({ candidate }) => ({
        decision: 'SEND',
        reasonCode: 'GROUNDED',
        text: candidate,
        attachments: [],
        violations: [],
    })),
    logGroundingDecision: jest.fn(),
    isModelGenerated: jest.fn(() => false),
    withSourceText: jest.fn((evidence) => evidence),
}));

const { processMessageJob } = require('src/jobs/message-worker');

const makeJob = (overrides = {}) => ({
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
        ...overrides,
    },
    moveToDelayed: jest.fn(),
    token: 'job-token',
});

const shopSettings = (automation_mode = 'AUTO') => ({
    automation_mode,
    confidence_threshold: 75,
    staticConfigAvailable: { DELIVERY_POLICY: false, DELIVERY_CHARGE: false },
});

const channelSettings = {
    automation_mode: 'AI_ACTIVE',
    ai_auto_reply: true,
    business_hours: null,
    confidence_threshold_send: 0.75,
    confidence_threshold_suggest: 0.5,
    allow_order_creation: true,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindByPk.mockResolvedValue(null);
    mockIsInteractionChoicesEnabled.mockResolvedValue(true);
    mockFindNumberedLivePayload.mockResolvedValue(null);
    mockRenderQuickReplies.mockResolvedValue(null);
    mockCreateProposal.mockResolvedValue(null);
    mockMarkSent.mockResolvedValue(true);
    mockGetSessionForInteraction.mockResolvedValue(null);
    mockChannel.status = 'CONNECTED';
    mockFindUniqueChannel.mockReset().mockImplementation(async () => mockChannel);
    mockCacheGet.mockReset().mockResolvedValue(null);
    mockCacheDel.mockReset().mockResolvedValue(1);
    mockConversationFindOne.mockResolvedValue({ id: 'conv-1', hitl: false, status: 'open', metadata: {} });
    mockMessageFindAll.mockResolvedValue([]);
    mockMessageCount.mockResolvedValue(0);
    mockGetShopAiSettings.mockReset().mockResolvedValue(shopSettings());
    mockGetChannelSettings.mockReset().mockResolvedValue({ ...channelSettings });
    mockSubscriptionFindOne.mockResolvedValue({ status: 'active' });
    mockRecoveryStartTurn.mockImplementation(async ({ traceId }) => ({
        turn: {
            trace_id: traceId,
            turn_started_at: new Date(),
            state: 'RECEIVED',
        },
    }));
    mockRecoveryTransition.mockResolvedValue(undefined);
    mockHandleOrderFlow.mockResolvedValue({ handled: false });
    mockHasPurchaseIntent.mockReturnValue(false);
    mockProcessNewIntent.mockResolvedValue({
        response: 'candidate response',
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
    mockEvaluateOutbound.mockReset().mockResolvedValue({ allow: true, decisionId: 'policy-1', transform: null });
    mockSendMessage.mockReset().mockResolvedValue({ providerMessageId: 'provider-1' });
    mockStoreAIResponse.mockImplementation(async (_conversationId, content, opts = {}) => ({
        message: {
            id: 'ai-1',
            content,
            metadata: { ...(opts.interaction_id ? { interaction_id: opts.interaction_id } : {}) },
            update: mockStoredMessageUpdate,
        },
    }));
});

test('MANUAL business mode skips before any LLM or outbound policy work', async () => {
    mockGetShopAiSettings.mockResolvedValueOnce(shopSettings('MANUAL'));

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'manual_mode' }));
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
    expect(mockEvaluateOutbound).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('P+02: a tap with the interaction_choices flag OFF is a pure skip (kill switch)', async () => {
    mockIsInteractionChoicesEnabled.mockResolvedValue(false);
    mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: 'p1:44444444-4444-4444-4444-444444444444:checkout.confirm' } } });

    const result = await processMessageJob(makeJob({ message: '' }));

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'interactions_disabled' }));
    expect(mockResolveInteraction).not.toHaveBeenCalled();
    expect(mockStoreAIResponse).not.toHaveBeenCalled();
});

test('P+04: question-deferred turn appends the deterministic resume hint when storing the answer', async () => {
    mockHandleOrderFlow.mockResolvedValue({
        handled: false,
        meta: {
            order_session: 'question_deferred',
            resume_step: 'COLLECTING_NAME',
            resume_hint: '\n\n(We will continue your order after this: What is your name?)',
        },
    });

    await processMessageJob(makeJob());

    expect(mockStoreAIResponse.mock.calls[0][1])
        .toBe('candidate response\n\n(We will continue your order after this: What is your name?)');
});

test('P+04: an ordinary (non-deferred) stored answer gets no resume suffix', async () => {
    await processMessageJob(makeJob());

    expect(mockStoreAIResponse.mock.calls[0][1]).toBe('candidate response');
});

test('invalid recovery turn start releases the inbound dedup key and retries', async () => {
    mockRecoveryStartTurn.mockResolvedValueOnce({
        turn: { trace_id: 'trace-1', turn_started_at: 'not-a-timestamp', state: 'RECEIVED' },
    });

    await expect(processMessageJob(makeJob())).rejects.toMatchObject({
        code: 'TURN_START_UNAVAILABLE',
        retryable: true,
    });
    expect(mockCacheDel).toHaveBeenCalledWith('msg:dedup:shop-1:facebook:external-1');
});

test('invalid Resume boundary fails before AI or order work starts', async () => {
    mockConversationFindOne.mockResolvedValue({
        id: 'conv-1',
        hitl: false,
        status: 'open',
        metadata: { ai_resume_boundary_at: '0' },
    });

    await expect(processMessageJob(makeJob())).rejects.toMatchObject({
        code: 'RESUME_BOUNDARY_INVALID',
        retryable: true,
    });
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
});

test('an unknown business mode fails closed as MANUAL before the LLM', async () => {
    mockGetShopAiSettings.mockResolvedValueOnce(shopSettings('GARBAGE'));

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'manual_mode' }));
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('DRAFT stores a reviewable candidate and never calls the provider', async () => {
    mockGetShopAiSettings.mockResolvedValue(shopSettings('DRAFT'));
    mockEvaluateOutbound.mockResolvedValueOnce({ allow: false, reason: 'DRAFT_MODE' });

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ sent: false }));
    expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStoreAIResponse).toHaveBeenCalledWith(
        'conv-1',
        'candidate response',
        expect.objectContaining({
            delivery_state: 'DRAFT_READY',
            suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
            logical_turn_id: 'external-1',
        }),
    );
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        delivery_state: 'DRAFT_READY',
        metadata: expect.objectContaining({
            delivered: false,
            delivery_state: 'DRAFT_READY',
            suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
        }),
    }));
});

test('AUTO waits for a slow model without sending a recovery holding message', async () => {
    let resolveModel;
    mockProcessNewIntent.mockImplementationOnce(() => new Promise((resolve) => {
        resolveModel = resolve;
    }));

    const processing = processMessageJob(makeJob());
    for (let attempt = 0; attempt < 20 && !mockProcessNewIntent.mock.calls.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 5500));
    expect(mockSendMessage).not.toHaveBeenCalled();

    resolveModel({
        response: 'candidate response',
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

    const result = await processing;
    expect(result.sent).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
});

/**
 * TEST_STRATEGY §4 deliberate amendment.
 *
 * The legacy Page columns (`automation_mode`, `ai_auto_reply`) remain DEAD
 * storage: they can never widen or narrow the business default. The NEW
 * mechanism is `overrides.automation_mode`, which is narrow-only. This test
 * keeps both pins: legacy ignored, overrides honored only when narrower.
 */
test('legacy Page automation_mode/ai_auto_reply columns are still ignored', async () => {
    mockGetChannelSettings.mockResolvedValue({
        ...channelSettings,
        automation_mode: 'MANUAL',
        ai_auto_reply: false,
        purpose_label: 'legacy page value',
    });

    const result = await processMessageJob(makeJob());

    expect(result.sent).toBe(true);
    expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockEvaluateOutbound).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
        settings: expect.objectContaining({
            automation_mode: 'AUTO',
            purpose_label: 'legacy page value',
        }),
    }));
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        delivery_state: 'SENT',
        provider_message_id: 'provider-1',
        metadata: expect.objectContaining({
            delivered: true,
            delivery_state: 'SENT',
            suggestion_visibility: 'HIDDEN_SENT',
            provider_message_id: 'provider-1',
        }),
    }));
});

test('an AUTO override cannot widen a DRAFT business default (runtime clamp)', async () => {
    // Business DRAFT, channel tries AUTO (legacy alias accepted at the edge).
    mockGetShopAiSettings.mockResolvedValue(shopSettings('DRAFT'));
    mockGetChannelSettings.mockResolvedValue({
        ...channelSettings,
        overrides: { automation_mode: 'AI_ACTIVE' },
    });

    await processMessageJob(makeJob());

    // Clamped to DRAFT: generation runs, nothing is delivered.
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStoreAIResponse).toHaveBeenCalledWith(
        'conv-1',
        'candidate response',
        expect.objectContaining({ delivery_state: 'DRAFT_READY' }),
    );
});

test('two channels diverge under one AUTO business: A AUTO sends, B DRAFT holds', async () => {
    const channelA = { ...mockChannel, id: 'channel-a' };
    const channelB = { ...mockChannel, id: 'channel-b' };
    const overridesByChannel = {
        'channel-a': { automation_mode: 'AUTO' },
        'channel-b': { automation_mode: 'DRAFT' },
    };
    mockFindUniqueChannel.mockImplementation(async () => channelA);
    mockGetChannelSettings.mockImplementation(async (channelId) => ({
        ...channelSettings,
        overrides: { ...(overridesByChannel[channelId] || {}) },
    }));

    const resultA = await processMessageJob(makeJob());
    expect(resultA.sent).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // Channel B is a different Page of the same shop; A's override never leaks.
    mockFindUniqueChannel.mockImplementation(async () => channelB);
    mockStoreAIResponse.mockClear();
    mockStoredMessageUpdate.mockClear();
    const resultB = await processMessageJob(makeJob());

    expect(resultB).toEqual(expect.objectContaining({ sent: false, reason: 'draft_mode' }));
    expect(mockSendMessage).toHaveBeenCalledTimes(1); // still only A's send
    expect(mockStoreAIResponse).toHaveBeenCalledWith(
        'conv-1',
        'candidate response',
        expect.objectContaining({ delivery_state: 'DRAFT_READY' }),
    );
    // A's stored override object was never mutated by evaluating B.
    expect(overridesByChannel['channel-a']).toEqual({ automation_mode: 'AUTO' });
});

test('changing channel A override never changes channel B (independent settings rows)', async () => {
    mockFindUniqueChannel.mockImplementation(async () => ({ ...mockChannel, id: 'channel-a' }));
    mockGetChannelSettings.mockImplementation(async (channelId) => ({
        ...channelSettings,
        overrides: { ...(channelId === 'channel-a' ? { automation_mode: 'DRAFT' } : {}) },
    }));
    await processMessageJob(makeJob());
    expect(mockSendMessage).not.toHaveBeenCalled();

    mockFindUniqueChannel.mockImplementation(async () => ({ ...mockChannel, id: 'channel-b' }));
    mockStoreAIResponse.mockClear();
    await processMessageJob(makeJob());
    // B inherits business AUTO and sends; changing A did not touch B.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
});

test('a channel MANUAL override skips before the LLM with reason manual_mode', async () => {
    mockGetChannelSettings.mockResolvedValue({
        ...channelSettings,
        overrides: { automation_mode: 'MANUAL' },
    });

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({
        skipped: true,
        reason: 'manual_mode',
        mode_source: 'channel_override',
    }));
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('a pre-override SEND_PENDING candidate is not reused after the channel narrows to DRAFT', async () => {
    mockGetChannelSettings.mockResolvedValue({
        ...channelSettings,
        overrides: { automation_mode: 'DRAFT' },
    });
    // This focused harness does not expose Message.findOne globally (the
    // candidate gate is otherwise inert); add it just for this scenario.
    const { Message } = require('src/modules/conversation/conversation.entity');
    Message.findOne = mockMessageFindOne;
    mockMessageFindOne.mockResolvedValueOnce({
        id: 'candidate-1',
        conversation_id: 'conv-1',
        sender: 'ai',
        delivery_state: 'SEND_PENDING',
        metadata: { provider_send_attempted: false },
    });

    try {
        const result = await processMessageJob(makeJob());

        expect(result).toEqual(expect.objectContaining({ sent: false }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    } finally {
        delete Message.findOne;
    }
});

test('needs_human (legacy handoff status) pauses the worker before the LLM', async () => {
    mockConversationFindOne.mockResolvedValue({
        id: 'conv-1',
        hitl: false,
        status: 'needs_human',
        metadata: {},
    });

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'needs_human' }));
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('AUTO persists every provider MID returned for a multi-part send', async () => {
    mockSendMessage.mockResolvedValueOnce({
        providerMessageIds: ['provider-text', 'provider-image'],
    });

    const result = await processMessageJob(makeJob());

    expect(result.sent).toBe(true);
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        provider_message_id: 'provider-image',
        metadata: expect.objectContaining({
            provider_message_id: 'provider-image',
            provider_message_ids: ['provider-text', 'provider-image'],
        }),
    }));
});

test('AUTO fails closed when the provider returns no message ID', async () => {
    mockSendMessage.mockResolvedValueOnce({ sent: true, providerMessageId: null });

    await expect(processMessageJob(makeJob())).rejects.toMatchObject({ code: 'PROVIDER_NO_SEND' });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        delivery_state: 'FAILED',
        metadata: expect.objectContaining({ delivered: false, held_reason: 'provider_send_failed' }),
    }));
});

test('a channel that is no longer CONNECTED is blocked before the LLM', async () => {
    mockGetChannelSettings.mockImplementationOnce(async () => {
        mockChannel.status = 'DISCONNECTED';
        return { ...channelSettings, ai_auto_reply: true };
    });

    const result = await processMessageJob(makeJob());

    expect(result).toEqual({ skipped: true, reason: 'channel_disconnected' });
    expect(mockProcessNewIntent).not.toHaveBeenCalled();
    expect(mockEvaluateOutbound).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('an AUTO to MANUAL flip after Guard 4 holds the generated text and sends nothing', async () => {
    mockGetShopAiSettings
        .mockResolvedValueOnce(shopSettings('AUTO'))
        .mockResolvedValueOnce(shopSettings('MANUAL'));

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'mode_changed' }));
    expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);
    expect(mockStoreAIResponse).toHaveBeenCalledWith(
        'conv-1',
        'candidate response',
        expect.objectContaining({ automation_mode: 'AUTO' }),
    );
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ delivered: false, held_reason: 'mode_changed', delivery_state: 'HELD' }),
        delivery_state: 'HELD',
    }));
    expect(mockEvaluateOutbound).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('a late human pause suppresses an in-flight AUTO send', async () => {
    let pauseReads = 0;
    mockCacheGet.mockImplementation(async (key) => {
        if (key !== 'ai:pause:conv-1') return null;
        pauseReads += 1;
        return pauseReads >= 2 ? '1' : null;
    });

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'ai_paused' }));
    expect(mockProcessNewIntent).toHaveBeenCalledTimes(1);
    expect(mockEvaluateOutbound).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ delivered: false, held_reason: 'ai_paused', delivery_state: 'HELD' }),
        delivery_state: 'HELD',
    }));
});

test('a mode change during policy evaluation is rechecked before provider delivery', async () => {
    mockGetShopAiSettings
        .mockResolvedValueOnce(shopSettings('AUTO'))
        .mockResolvedValueOnce(shopSettings('AUTO'))
        .mockResolvedValueOnce(shopSettings('MANUAL'));

    const result = await processMessageJob(makeJob());

    expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'mode_changed' }));
    expect(mockEvaluateOutbound).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStoredMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ delivered: false, held_reason: 'mode_changed', delivery_state: 'HELD' }),
        delivery_state: 'HELD',
    }));
});

// ─── P+02 structured customer choices ─────────────────────────────────────────
const TAP = 'p1:44444444-4444-4444-4444-444444444444:checkout.confirm';

test('P+02: a resolved choice tap executes through the kernel and flows through normal mode handling', async () => {
    mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: TAP } } });
    mockResolveInteraction.mockResolvedValue({
        resolved: true,
        response: 'Order #7 confirmed ✅',
        meta: { completed: true, order: { id: 'ord-7', order_number: 7 } },
    });

    const result = await processMessageJob(makeJob({ message: '' }));

    expect(mockResolveInteraction).toHaveBeenCalledWith(expect.objectContaining({
        shopId: 'shop-1',
        conversationId: 'conv-1',
        customerChannelId: 'recipient-1',
        mutationsAllowed: true,
    }));
    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
    // committed-order truth: the deterministic post-mutation template carries
    // the order number (never the tap itself as authority)
    expect(mockStoreAIResponse.mock.calls[0][1]).toMatch(/#7/);
    expect(result).toEqual(expect.objectContaining({ sent: true }));
});

test('P+02: a replayed tap is a pure no-op (no message, no send)', async () => {
    mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: TAP } } });
    mockResolveInteraction.mockResolvedValue({ resolved: false, code: 'INTERACTION_ALREADY_HANDLED' });

    const result = await processMessageJob(makeJob({ message: '' }));

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'interaction_replay' }));
    expect(mockStoreAIResponse).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('P+02: a tap in DRAFT mode never mutates (mutationsAllowed false) and stays a draft', async () => {
    mockGetShopAiSettings.mockResolvedValue(shopSettings('DRAFT'));
    mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: TAP } } });
    mockResolveInteraction.mockResolvedValue({ resolved: true, response: 'Review summary', meta: {} });

    await processMessageJob(makeJob({ message: '' }));

    expect(mockResolveInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ mutationsAllowed: false }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('P+02: ORDER_SUMMARY turn attaches a registry proposal, renders quick replies and marks SENT on ack', async () => {
    mockHandleOrderFlow.mockResolvedValue({
        handled: true,
        response: 'Review: ৳1650 — confirm?',
        confidence: 1.0,
        meta: { order_session: 'continue', step: 'ORDER_SUMMARY', session_id: 'sess-9' },
    });
    mockGetSessionForInteraction.mockResolvedValue({
        id: 'sess-9', current_step: 'ORDER_SUMMARY', status: 'ACTIVE',
        step_data: { confirmed_summary_hash: 'h1' },
    });
    mockCreateProposal.mockResolvedValue({ interactionId: 'iid-1', options: [] });
    mockRenderQuickReplies.mockResolvedValue({
        quick_replies: [{ title: 'Confirm', content_type: 'text', payload: TAP }],
        textFallback: '1) Confirm',
    });

    await processMessageJob(makeJob());

    expect(mockCreateProposal).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'CHECKOUT_DECISION',
        shopId: 'shop-1',
        conversationId: 'conv-1',
    }));
    expect(mockStoreAIResponse.mock.calls[0][2]).toMatchObject({ interaction_id: 'iid-1' });
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
        normalizedMessage: expect.objectContaining({
            quick_replies: [expect.objectContaining({ payload: TAP })],
        }),
    }));
    expect(mockMarkSent).toHaveBeenCalledWith('iid-1');
});

test('P+02: with the pilot flag off no proposal is created and sends stay plain text', async () => {
    mockIsInteractionChoicesEnabled.mockResolvedValue(false);
    mockHandleOrderFlow.mockResolvedValue({
        handled: true,
        response: 'Review: ৳1650',
        confidence: 1.0,
        meta: { order_session: 'continue', step: 'ORDER_SUMMARY', session_id: 'sess-9' },
    });

    await processMessageJob(makeJob());

    expect(mockCreateProposal).not.toHaveBeenCalled();
    const sent = mockSendMessage.mock.calls[0][0];
    expect(sent.normalizedMessage.quick_replies).toBeUndefined();
});

test('P+02: a bare-number reply resolves only via the numbered equivalence path', async () => {
    mockFindNumberedLivePayload.mockResolvedValue(
        'p1:55555555-5555-5555-5555-555555555555:checkout.resume',
    );
    mockResolveInteraction.mockResolvedValue({ resolved: true, response: 'ঠিকানা দিন', meta: { resumed_step: 'COLLECTING_ADDRESS' } });

    await processMessageJob(makeJob({ message: '2' }));

    expect(mockFindNumberedLivePayload).toHaveBeenCalledWith({ shopId: 'shop-1', conversationId: 'conv-1', number: '2' });
    expect(mockResolveInteraction).toHaveBeenCalled();
    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
});

test('P+02: a resolver-observed flag revocation suppresses the in-flight reply', async () => {
    mockIsInteractionChoicesEnabled.mockResolvedValueOnce(true);
    mockFindNumberedLivePayload.mockResolvedValue(
        'p1:55555555-5555-5555-5555-555555555555:checkout.resume',
    );
    mockResolveInteraction.mockResolvedValue({ resolved: false, code: 'INTERACTION_CHOICES_DISABLED' });

    const result = await processMessageJob(makeJob({ message: '2' }));

    expect(mockIsInteractionChoicesEnabled).toHaveBeenCalledTimes(1);
    expect(mockIsInteractionChoicesEnabled).toHaveBeenCalledWith('shop-1');
    expect(mockResolveInteraction).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'interactions_disabled' }));
    expect(mockStoreAIResponse).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('P+02: forged/unknown payload tap gets an honest fallback, not a silent drop', async () => {
    mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: TAP } } });
    mockResolveInteraction.mockResolvedValue({ resolved: false, code: 'INTERACTION_UNKNOWN' });

    await processMessageJob(makeJob({ message: '' }));

    expect(mockHandleOrderFlow).not.toHaveBeenCalled();
    const stored = mockStoreAIResponse.mock.calls[0][1];
    expect(stored).toMatch(/no longer active/i);
});
