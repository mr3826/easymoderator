'use strict';

/**
 * Keyword-fallback tier safety (router-outage path), driven directly because the
 * /api/ai-chatbot HTTP router is unmounted (the live worker reaches processNewIntent).
 *
 *  - D-P2-01: an order-intent fallback must NOT throw a ReferenceError on the bare
 *             meta_channel_id; the fallback session start carries the channel from
 *             the ingestion result.
 *  - D-P2-03: a complaint/return fallback escalation must create the durable HITL
 *             handoff (markForHumanHandoff) instead of throwing on a malformed
 *             SupportTicket.
 *  - D-P2-05: a complaint whose wording merely CONTAINS 'hi'/'this' must not be
 *             shadowed by the greeting tier (word-boundary match).
 */

process.env.NODE_ENV = 'test';

const mockStartOrderSession = jest.fn();
const mockMarkForHumanHandoff = jest.fn().mockResolvedValue({ success: true, status: 'needs_human' });
const mockSupportTicketCreate = jest.fn().mockRejectedValue(Object.assign(new Error('notNull Violation: ticket_number'), { name: 'SequelizeValidationError' }));

jest.mock('express-validator', () => ({ validationResult: jest.fn(() => ({ isEmpty: () => true })) }));
jest.mock('../conversation-state-standalone.service', () => ({
    detectLanguage: jest.fn(() => 'en'),
    extractEntities: jest.fn(() => ({})),
    updateConversationState: jest.fn(),
    storeAIResponse: jest.fn(),
    markForHumanHandoff: mockMarkForHumanHandoff,
}));
jest.mock('../../order/order-session-standalone.service', () => ({
    processStep: jest.fn(),
    getActiveSession: jest.fn(),
    handleSelfMfsPayment: jest.fn(),
    startOrderSession: mockStartOrderSession,
}));
jest.mock('../../channel-providers/meta-channel.service', () => ({
    findConnectedById: jest.fn(), findUniqueConnectedByShopAndPlatform: jest.fn(), getSettings: jest.fn(),
}));
jest.mock('../../shop/shop.service', () => ({ getShopAiSettings: jest.fn() }));
jest.mock('../../../utils/cache.service', () => ({ getForShop: jest.fn(async () => null), setForShop: jest.fn(async () => undefined) }));
jest.mock('../../ai/prompt-sanitizer.service', () => ({ isTooLong: jest.fn(() => false) }));
jest.mock('../../entities', () => ({ SupportTicket: { create: (...a) => mockSupportTicketCreate(...a) }, Subscription: { findOne: jest.fn() } }));
jest.mock('../../ai/intent-router.service', () => ({
    buildSystemPrompt: jest.fn(() => 'BASE'),
    route: jest.fn(async () => { throw new Error('forced router outage (fallback tier)'); }),
}));
jest.mock('../../knowledge/knowledge.service', () => ({ getKnowledgeForAI: jest.fn(), getRelevantFaqs: jest.fn() }));
jest.mock('../../knowledge/knowledge-gap-capture.service', () => ({ recordKnowledgeGap: jest.fn(async () => {}) }));
jest.mock('../../ai/shop-operating-context.service', () => ({ getOperatingContext: jest.fn(async () => '') }));
jest.mock('../../subscription/subscription.plans', () => ({ planHasFeature: jest.fn(() => false) }));
jest.mock('../../ai/grounding', () => ({
    evaluateCandidate: jest.fn(({ candidate }) => ({ decision: 'SEND', text: candidate, reasonCode: null, violations: [] })),
    logGroundingDecision: jest.fn(), isModelGenerated: jest.fn(() => false),
    contextSelectedVariants: jest.fn(() => ({})), emptyEvidence: jest.fn(() => ({ verifiedProducts: [], knowledgeIds: [] })),
}));
jest.mock('../../ai/product-experience/product-presentation', () => ({
    buildProductPresentation: jest.fn(() => ({ products: [] })),
    renderMessengerProductPresentation: jest.fn(() => ({ attachments: [] })),
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() })),
}));

const AIChatbotController = require('../ai-chatbot.controller');

// Mirrors the REAL ingestionResult shape emitted by BOTH producers: the worker's
// ingestionResult literal (message-worker.js ~:2559) and ConversationStateService
// .ingestMessage's return (conversation-state-standalone.service.js). meta_channel_id
// and customer_id are genuine producer fields — not a fixture invention — and that is
// pinned by conversation-state.ingestion-meta-channel.test.js and the MF-1 block in
// message-worker.emergency-stop-toctou.test.js (both assert the producers emit them).
// getActiveSession matches meta_channel_id exactly, so the seed below must carry the
// same value the worker resumes on, else the session is orphaned during an outage.
const ingestion = (over = {}) => ({
    shop_id: '11111111-1111-4111-8111-111111111111',
    customer_channel_id: 'psid-1',
    platform: 'facebook',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    customer_id: '33333333-3333-4333-8333-333333333333',
    meta_channel_id: '44444444-4444-4444-8444-444444444444',
    conversation_history: [],
    ...over,
});

const SETTINGS = { confidence_threshold: 75, tone_persona: 'friendly_bd', model_preset: 'standard', automation_mode: 'DRAFT' };

const fallback = (message, language = 'en', ing = ingestion()) =>
    AIChatbotController.processNewIntent(message, [], {}, language, SETTINGS, ing, [], null);

beforeEach(() => {
    jest.clearAllMocks();
    mockStartOrderSession.mockResolvedValue({ session_id: 'sess-1', prompt: 'How many would you like?' });
    mockMarkForHumanHandoff.mockResolvedValue({ success: true, status: 'needs_human' });
    mockSupportTicketCreate.mockRejectedValue(Object.assign(new Error('notNull Violation: ticket_number'), { name: 'SequelizeValidationError' }));
});

describe('D-P2-01 — order-intent fallback starts the session', () => {
    test('an explicit order request carries the ingestion channel and does not throw', async () => {
        const r = await fallback('I want to order the red shirt');
        expect(mockStartOrderSession).toHaveBeenCalledTimes(1);
        const arg = mockStartOrderSession.mock.calls[0][0];
        expect(arg.meta_channel_id).toBe('44444444-4444-4444-8444-444444444444');
        expect(arg.customer_id).toBe('33333333-3333-4333-8333-333333333333');
        expect(r.response).toContain('How many');
        expect(r.confidence).toBe(0.75);
    });

    test('meta_channel_id null when the ingestion result has none (no ReferenceError)', async () => {
        const r = await fallback('order the red shirt', 'en', ingestion({ meta_channel_id: undefined }));
        expect(r).toBeTruthy();
        expect(mockStartOrderSession.mock.calls[0][0].meta_channel_id).toBeNull();
    });

    test('"border" does not falsely trigger the order tier (word-boundary)', async () => {
        await fallback('the border design is nice', 'en');
        expect(mockStartOrderSession).not.toHaveBeenCalled();
    });
});

describe('D-P2-03 — fallback escalation records the durable handoff', () => {
    test('a complaint escalation calls markForHumanHandoff and resolves at 0.95', async () => {
        const r = await fallback('the wrong product is defective');
        expect(mockSupportTicketCreate).not.toHaveBeenCalled();
        expect(mockMarkForHumanHandoff).toHaveBeenCalledTimes(1);
        expect(mockMarkForHumanHandoff).toHaveBeenCalledWith(
            '22222222-2222-4222-8222-222222222222', expect.any(String), expect.objectContaining({ intent: 'complaint' }),
        );
        expect(r.confidence).toBe(0.95);
        expect(r.response).toMatch(/representative|contact/i);
    });

    test('escalation fail-closed: if the handoff cannot be recorded, it throws (no false promise reaches the customer)', async () => {
        mockMarkForHumanHandoff.mockRejectedValueOnce(new Error('Conversation not found'));
        await expect(fallback('i want a refund for the wrong product')).rejects.toThrow(/Conversation not found/);
    });
});

describe('D-P2-05 — greeting substring can no longer shadow complaint escalation', () => {
    test('"this complaint is defective" is NOT treated as a greeting', async () => {
        const r = await fallback('this complaint is defective');
        // Baseline matched greeting('hi' in 'this') → 0.90 welcome. After the fix it
        // must reach the complaint escalation branch.
        expect(r.confidence).toBe(0.95);
        expect(mockMarkForHumanHandoff).toHaveBeenCalledTimes(1);
    });

    test('a genuine standalone greeting still greets', async () => {
        const r = await fallback('hi there');
        expect(r.confidence).toBe(0.90);
    });

    test('a Bangla greeting keyword is unaffected (non-ASCII containment)', async () => {
        const r = await fallback('আসসালামু আলাইকুম', 'bn');
        expect(r.confidence).toBe(0.90);
    });
});
