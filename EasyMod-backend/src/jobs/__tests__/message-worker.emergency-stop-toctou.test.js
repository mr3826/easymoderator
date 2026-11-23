'use strict';

/**
 * W3 — emergency-stop / mode TOCTOU at the irreversible order-commit boundary.
 *
 * `resolveMutationsAllowed` previously consumed the stale `guardEffectiveMode`
 * captured early in the turn and only re-read the channel, so a mid-turn
 * emergency stop could still COMMIT an order while only the reply was held.
 * The fix recomputes the effective stop/mode via the authoritative resolver
 * (fresh Shop safety read) immediately before the commit / interaction boundary.
 *
 * These tests interleave stop activation at each race point and assert the
 * backend mutation flag, the outbox send decision, and the audit HELD state.
 */

process.env.NODE_ENV = 'test';

const mockChannel = { id: 'channel-1', shop_id: 'shop-1', platform: 'facebook', status: 'CONNECTED', meta_asset_id: 'page-1' };

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
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({ isInteractionChoicesEnabled: mockIsInteractionChoicesEnabled }));
jest.mock('bullmq', () => ({ Worker: jest.fn(), Queue: jest.fn(() => ({ add: jest.fn() })), UnrecoverableError: class UnrecoverableError extends Error {} }));
jest.mock('src/jobs/message-queue', () => ({ connection: {} }));
jest.mock('src/config/redis', () => ({ cacheRedis: { get: mockCacheGet, set: jest.fn(async () => 'OK'), setex: jest.fn(async () => 'OK'), del: mockCacheDel } }));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne },
    Message: { findAll: mockMessageFindAll, count: mockMessageCount, findOne: mockMessageFindOne, findByPk: mockMessageFindByPk, update: mockMessageUpdate },
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({
    detectLanguage: jest.fn(() => 'en'), extractEntities: jest.fn(() => ({})), storeAIResponse: mockStoreAIResponse, updateConversationState: jest.fn(),
}));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: mockGetProvider }));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: mockEvaluateOutbound }));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({
    findConnectedById: jest.fn(async () => mockChannel), findByMetaAssetId: jest.fn(async () => null),
    findUniqueConnectedByShopAndPlatform: jest.fn(async () => mockChannel), getSettings: mockGetChannelSettings,
}));
jest.mock('src/modules/channel-providers/channel-automation.resolver', () => {
    const actual = jest.requireActual('src/modules/channel-providers/channel-automation.resolver');
    return { ...actual, loadEffectiveChannelAutomation: (...args) => mockLoadEffectiveChannelAutomation(...args) };
});
jest.mock('src/modules/customer/customer.entity', () => ({ findOne: jest.fn(async () => ({ id: 'customer-1', shop_id: 'shop-1', channel_type: 'messenger', channel_user_id: 'recipient-1', messaging_consent: {} })) }));
jest.mock('src/modules/shop/shop.service', () => ({ getShopAiSettings: mockGetShopAiSettings }));
jest.mock('src/modules/entities', () => ({ Shop: { findByPk: (...args) => mockShopFindByPk(...args) }, Subscription: { findOne: mockSubscriptionFindOne } }));
jest.mock('src/modules/subscription/subscription.access', () => ({ isAiActive: jest.fn(() => true) }));
jest.mock('src/modules/ai/sentiment.service', () => ({ analyzeSentiment: jest.fn(async () => ({ sentiment: 'neutral', score: 0, method: 'keyword' })), shouldAutoEscalate: jest.fn(() => false) }));
jest.mock('src/modules/conversation/order-flow.service', () => ({ handleOrderFlow: mockHandleOrderFlow, hasPurchaseIntent: mockHasPurchaseIntent }));
jest.mock('src/modules/conversation/ai-chatbot.controller', () => ({ processNewIntent: mockProcessNewIntent }));
jest.mock('src/modules/conversation/human-handoff.service', () => ({ escalateToHuman: jest.fn(async () => {}) }));
jest.mock('src/modules/knowledge/knowledge-gap-capture.service', () => ({ recordKnowledgeGap: jest.fn(async () => {}) }));
jest.mock('src/modules/analytics/growth-metrics.service', () => ({ recordActivation: jest.fn(() => Promise.resolve()) }));
jest.mock('src/modules/analytics/funnel-events.service', () => ({ recordInternalFunnelEvent: jest.fn(() => Promise.resolve()) }));
jest.mock('src/modules/shop/ai-messaging', () => ({ buildGreeting: jest.fn(() => '') }));
jest.mock('src/modules/shop/shop.entity', () => ({ findByPk: jest.fn(async () => ({ name: 'Test shop', settings: {} })) }));
jest.mock('src/modules/ai/recovery/turn-recovery.service', () => ({
    startTurn: mockRecoveryStartTurn, transition: mockRecoveryTransition,
    isHoldingSuppressed: jest.fn(() => false), isHardTimeoutSuppressed: jest.fn(() => false), requireHuman: jest.fn(async () => ({})),
}));
jest.mock('src/modules/order/order-session-standalone.service', () => ({ getActiveSession: jest.fn(async () => null), getSessionForInteraction: mockGetSessionForInteraction }));
jest.mock('src/modules/ai/intent/stage2-rules', () => ({ classify: jest.fn(() => ({ intentId: 'GENERAL_INQUIRY', domain: 'CONVERSATION', slots: {}, confidence: 1, source: 'RULE', matchedRule: 'test' })) }));
jest.mock('src/modules/ai/contracts/intent.contract', () => ({ createIntentRecord: jest.fn((input) => ({ ...input })) }));
jest.mock('src/modules/ai/grounding', () => ({
    GroundingDecision: { SEND: 'SEND', SUPPRESS: 'SUPPRESS', SAFE_FALLBACK: 'SAFE_FALLBACK' },
    ReasonCode: { GROUNDED: 'GROUNDED', RETRIEVAL_FAILED: 'RETRIEVAL_FAILED' },
    emptyEvidence: jest.fn(() => ({ verifiedProducts: [], knowledgeIds: [] })),
    evaluateCandidate: jest.fn(({ candidate }) => ({ decision: 'SEND', reasonCode: 'GROUNDED', text: candidate, attachments: [], violations: [] })),
    logGroundingDecision: jest.fn(), isModelGenerated: jest.fn(() => false), withSourceText: jest.fn((e) => e),
}));
jest.mock('src/modules/notification/merchant-notification.service', () => ({ notifyShop: mockNotifyShop }));
jest.mock('src/modules/notification/notification-events', () => ({ NOTIFICATION_EVENTS: { AI_HITL: 'ai_hitl' } }));

const { processMessageJob, _private } = require('src/jobs/message-worker');
const stage2Rules = require('src/modules/ai/intent/stage2-rules');
const turnRecovery = require('src/modules/ai/recovery/turn-recovery.service');

const makeJob = (over = {}) => ({
    id: 'job-1',
    data: { shopId: 'shop-1', conversationId: 'conv-1', messageId: 'message-1', externalId: 'external-1', message: 'What is the price?', platform: 'facebook', recipientId: 'recipient-1', senderInfo: {}, ...over },
    moveToDelayed: jest.fn(), token: 'job-token',
});

const shopSettings = (automation_mode = 'AUTO') => ({ automation_mode, confidence_threshold: 75, staticConfigAvailable: { DELIVERY_POLICY: false, DELIVERY_CHARGE: false } });
const openConversation = (o = {}) => ({ id: 'conv-1', shop_id: 'shop-1', customer_id: 'customer-1', channel: 'messenger', meta_channel_id: 'channel-1', hitl: false, status: 'open', metadata: {}, ...o });
const activeShop = () => ({ id: 'shop-1', is_active: true, ai_emergency_stop: false });
const stoppedShop = () => ({ id: 'shop-1', is_active: true, ai_emergency_stop: true });

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
    mockGetShopAiSettings.mockReset().mockResolvedValue(shopSettings('AUTO'));
    mockGetChannelSettings.mockReset().mockResolvedValue({ business_hours: null, allow_order_creation: true, overrides: {} });
    mockSubscriptionFindOne.mockResolvedValue({ status: 'active' });
    mockShopFindByPk.mockResolvedValue(activeShop());
    mockLoadEffectiveChannelAutomation.mockResolvedValue({ mode: 'AUTO', modeSource: 'business_default', emergencyStop: { active: false }, shopIsActive: true, billingAiActive: true, effective: { automation_mode: 'AUTO', confidence_threshold: 75, business_hours: null, allow_order_creation: true, purpose_label: null }, overrides: {}, warnings: [] });
    mockRecoveryStartTurn.mockImplementation(async ({ traceId }) => ({ turn: { trace_id: traceId, turn_started_at: new Date(), state: 'RECEIVED' } }));
    mockRecoveryTransition.mockResolvedValue(undefined);
    mockHandleOrderFlow.mockResolvedValue({ handled: false });
    mockHasPurchaseIntent.mockReturnValue(false);
    mockProcessNewIntent.mockResolvedValue({ response: 'candidate response', confidence: 0.95, source: 'llm', grounding: { verifiedProducts: [], knowledgeIds: [] }, attachments: [] });
    mockEvaluateOutbound.mockReset().mockResolvedValue({ allow: true, decisionId: 'policy-1', transform: null });
    mockSendMessage.mockReset().mockResolvedValue({ providerMessageId: 'provider-1' });
    mockStoreAIResponse.mockImplementation(async (_conversationId, content) => ({ message: { id: 'ai-1', content, metadata: {}, update: mockStoredMessageUpdate } }));
});

const orderFlowMutationFlag = () => {
    const call = mockHandleOrderFlow.mock.calls.find(([args]) => 'mutationsAllowed' in args);
    return call ? call[0].mutationsAllowed : undefined;
};

describe('W3 — emergency stop interleaved with the order-commit boundary', () => {
    test('stop engaged BEFORE the commit boundary blocks the order commit (mutationsAllowed=false)', async () => {
        let safetyReads = 0;
        // Guard 4 (read 1) sees AUTO; every safety read after — including the
        // recompute at the commit boundary — sees the stop.
        mockShopFindByPk.mockImplementation(async (_id, options = {}) => {
            if ((options.attributes || []).includes('ai_emergency_stop')) {
                safetyReads += 1;
                return safetyReads === 1 ? activeShop() : stoppedShop();
            }
            return { id: 'shop-1', settings: {}, is_active: true, ai_emergency_stop: false };
        });
        mockHandleOrderFlow.mockResolvedValue({ handled: true, meta: { order: { order_number: 'ORD-1', order_status: 'confirmed' }, completed: true } });

        const result = await processMessageJob(makeJob());

        // The commit boundary must receive mutationsAllowed=false once the stop is live.
        expect(orderFlowMutationFlag()).toBe(false);
        // The reply must not be delivered — HELD at the post-generation gate.
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ sent: false }));
    });

    test('control: stop engaged only AFTER the commit boundary commits legitimately, then holds the send', async () => {
        let safetyReads = 0;
        mockShopFindByPk.mockImplementation(async (_id, options = {}) => {
            if ((options.attributes || []).includes('ai_emergency_stop')) {
                safetyReads += 1;
                // AUTO through Guard 4 AND the commit boundary; stops at the send gate.
                return safetyReads <= 2 ? activeShop() : stoppedShop();
            }
            return { id: 'shop-1', settings: {}, is_active: true, ai_emergency_stop: false };
        });

        const result = await processMessageJob(makeJob());

        expect(orderFlowMutationFlag()).toBe(true);
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'emergency_stop' }));
    });

    test('interaction resolve boundary also recomputes the stop', async () => {
        mockMessageFindByPk.mockResolvedValue({ metadata: { quick_reply: { payload: 'p1:44444444-4444-4444-4444-444444444444:checkout.confirm' } } });
        mockResolveInteraction.mockResolvedValue({ resolved: false, code: 'INTERACTION_ALREADY_HANDLED' });
        let safetyReads = 0;
        mockShopFindByPk.mockImplementation(async (_id, options = {}) => {
            if ((options.attributes || []).includes('ai_emergency_stop')) {
                safetyReads += 1;
                return safetyReads === 1 ? activeShop() : stoppedShop();
            }
            return { id: 'shop-1', settings: {}, is_active: true, ai_emergency_stop: false };
        });

        await processMessageJob(makeJob({ message: '' }));

        const call = mockResolveInteraction.mock.calls.find(([args]) => 'mutationsAllowed' in args);
        expect(call).toBeTruthy();
        expect(call[0].mutationsAllowed).toBe(false);
    });
});

describe('W3 — resolveMutationsAllowed recomputes effective stop/mode (unit)', () => {
    const channel = { id: 'channel-1' };

    test('a stop active at the boundary blocks even when the stale guard mode was AUTO', async () => {
        // Stale in-memory guardEffectiveMode = AUTO, but the fresh Shop read at
        // the boundary reports the emergency stop → resolver must fail it closed.
        mockShopFindByPk.mockImplementation(async (_id, options = {}) => (
            (options.attributes || []).includes('ai_emergency_stop')
                ? stoppedShop()
                : { id: 'shop-1', settings: {}, is_active: true, ai_emergency_stop: false }
        ));
        const allowed = await _private.resolveMutationsAllowed('shop-1', channel, 'AUTO');
        expect(allowed).toBe(false);
    });

    test('AUTO with allow_order_creation allowed permits the commit', async () => {
        mockShopFindByPk.mockResolvedValue(activeShop());
        mockGetChannelSettings.mockResolvedValue({ business_hours: null, allow_order_creation: true, overrides: {} });
        const allowed = await _private.resolveMutationsAllowed('shop-1', channel, 'AUTO');
        expect(allowed).toBe(true);
    });

    test('channel allow_order_creation=false blocks the commit even under AUTO', async () => {
        mockShopFindByPk.mockResolvedValue(activeShop());
        mockGetChannelSettings.mockResolvedValue({ business_hours: null, allow_order_creation: false, overrides: {} });
        const allowed = await _private.resolveMutationsAllowed('shop-1', channel, 'AUTO');
        expect(allowed).toBe(false);
    });

    test('a non-AUTO stale guard mode fast-rejects (no reads)', async () => {
        mockShopFindByPk.mockReset();
        const allowed = await _private.resolveMutationsAllowed('shop-1', channel, 'DRAFT');
        expect(allowed).toBe(false);
        expect(mockShopFindByPk).not.toHaveBeenCalled();
    });

    test('fail-closed: any resolver read throwing → no mutation', async () => {
        mockShopFindByPk.mockRejectedValue(new Error('db down'));
        const allowed = await _private.resolveMutationsAllowed('shop-1', channel, 'AUTO');
        expect(allowed).toBe(false);
    });
});

describe('Guard 5b (PR #302 / D-P2-06) — explicit human request wins over generic product lookup', () => {
    test('a "human agent please" message routes to recovery, never to the conversational fallback', async () => {
        // Guard 5b classify()s the EFFECTIVE message; match on content so an earlier
        // intent-shadow classify call cannot consume this stub.
        stage2Rules.classify.mockImplementation((text) => (
            String(text).includes('human agent') || String(text).includes('manus')
                ? { intentId: 'HUMAN_HANDOFF_REQUEST', domain: 'CONVERSATION', slots: {}, confidence: 1, source: 'RULE', matchedRule: 'human_handoff' }
                : { intentId: 'GENERAL_INQUIRY', domain: 'CONVERSATION', slots: {}, confidence: 1, source: 'RULE', matchedRule: 'test' }
        ));

        const result = await processMessageJob(makeJob({ message: 'aman ushno ekjon manus. human agent please' }));

        expect(result).toEqual(expect.objectContaining({ success: true }));
        expect(turnRecovery.requireHuman).toHaveBeenCalledWith(expect.objectContaining({ reason: 'human_requested' }));
        // Guard 5b short-circuits BEFORE the conversational LLM / generic product lookup.
        expect(mockProcessNewIntent).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});
