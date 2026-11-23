'use strict';

/**
 * D-P2-04 (A7) — intent-router usageContext attribution, end to end.
 *
 * Unlike intent-router.test.js (which stubs llm.service and stops at the
 * router boundary), this lane runs the REAL llm.service against a stubbed
 * fetch and the REAL usage-recorder against a stubbed ledger store, so it
 * proves the attribution wired at every intent-router call site actually
 * reaches the ledger sink:
 *
 *   route() FAQ reply (:chat_reply suffix)          → chat_reply  + shopId
 *   _callLlm() main reply                            → chat_reply  + shopId
 *   _extractProductAttributes() photo call           → product_attrs + shopId
 *
 * plus the contract properties the recorder promises:
 *   - a turn that makes TWO AI calls (photo attrs + reply) records BOTH —
 *     the suffixed requestIds must not dedupe distinct calls apart;
 *   - a retried turn with the same traceId is counted once;
 *   - no traceId (today's production controller) still records, attributed
 *     by shopId with a null requestId — never dropped, never guessed;
 *   - AI_USAGE_ACCOUNTING=false keeps the whole path a total no-op;
 *   - no prompt text, customer message, phone number, or model reply body
 *     reaches either sink (the ledger has no text columns; the projection
 *     test proves attribution survives into the row shape).
 *
 * Hermetic: fetch is stubbed (no network), redis is stubbed to null (the
 * recorder falls back to its bounded in-process dedupe guard), and the
 * Postgres sink is mocked — the REAL projectLedgerRow maps the captured
 * record so the assertions test what would actually be persisted.
 */

process.env.NODE_ENV = 'test';
// Cache disabled at intent-router module-load: every scenario must reach a
// real chat call; recorder-level dedupe is what this lane tests, not cache.
process.env.INTENT_CACHE_TTL_SECONDS = '0';

const mockLedger = {
    insertUsageRow: jest.fn(async () => true),
    summarizeUsage: jest.fn(async () => ({ costStatus: 'NO_DATA' })),
    COST_STATUS: {
        LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE', NO_DATA: 'NO_DATA',
        UNKNOWN: 'UNKNOWN', PARTIAL: 'PARTIAL', COMPLETE: 'COMPLETE',
    },
};

jest.mock('../usage-ledger.store', () => mockLedger);
// No Redis in the unit lane: claimOnce uses the recorder's in-process guard.
jest.mock('../../../config/redis', () => ({ cacheRedis: null }));
// llm.service wraps provider calls in the breaker; bypass it, call straight through.
jest.mock('../circuit-breaker.service', () => ({
    circuitBreaker: { callWithBreaker: async (_provider, fn) => fn() },
}));

const mockGetGeneration = jest.fn();
const mockRecordReadAction = jest.fn(async () => ({ recorded: true }));
const mockIntentEntries = new Map();

jest.mock('src/config/memory-cache', () => ({
    MemoryCache: class {
        async get(key) { return mockIntentEntries.get(key) || null; }
        async setex() { return 'OK'; }
        async del(key) { mockIntentEntries.delete(key); return 1; }
    }
}));
jest.mock('src/utils/shop-settings-cache', () => ({
    getShopSettingsGeneration: mockGetGeneration,
}));
jest.mock('src/modules/ai/bert-client.service', () => ({ classify: jest.fn(async () => null) }));
jest.mock('src/modules/ai/gemini-cache.service', () => ({ getOrCreate: jest.fn(async () => null) }));
jest.doMock(require.resolve('../action-gate'), () => ({ recordReadAction: (...args) => mockRecordReadAction(...args) }));
jest.mock('src/modules/knowledge/knowledge.service', () => ({ incrementFaqHit: jest.fn() }));
jest.mock('src/modules/product/product-search.service', () => ({
    searchByAttributes: jest.fn(),
    getProductsByIds: jest.fn(),
}));
jest.mock('src/modules/rag/rag.service', () => ({ queryData: jest.fn() }));
jest.mock('src/modules/entities', () => ({
    Order: { findOne: jest.fn(async () => null) },
    FaqResponse: { findAll: jest.fn(async () => []), findOne: jest.fn(async () => null) },
}));

jest.resetModules();
const { route: routeIntent } = require('src/modules/ai/intent-router.service');
const { projectLedgerRow } = jest.requireActual('../usage-ledger.store');
const productSearch = require('src/modules/product/product-search.service');
const rag = require('src/modules/rag/rag.service');
const { FaqResponse } = require('src/modules/entities');
const { loadSyntheticMediaFixture } = require('../../../../scripts/product-experience/synthetic-media-fixtures');

// Realistic UUIDs: projectLedgerRow drops non-UUID ids to null, and this lane
// asserts what the DURABLE row would carry, not just the in-memory record.
const SHOP = '7c1f9a2e-5b4d-4e8a-9c3d-2f6a8b1c4d90';
const CONV = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

const REPLY_TEXT = 'Ami apnake product ar price niye help korte pari.';
const ATTRS_JSON = JSON.stringify({
    category: 'saree', color: 'red', material: null,
    query: 'saree red', tags: ['saree', 'red'],
    description: 'a red saree with a gold border',
});

/**
 * Stubbed Gemini transport: the analyzer system prompt (checked by its
 * distinctive role line) returns attribute JSON, everything else returns a
 * plain reply. Both carry usageMetadata so the cost path runs normally.
 */
const geminiResponse = (text) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
        candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 48, totalTokenCount: 860 },
    }),
});
const fetchStub = jest.fn(async (_url, req = {}) => {
    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (_) { /* keep empty */ }
    const systemText = body?.systemInstruction?.parts?.[0]?.text || '';
    const userText = JSON.stringify(body?.contents || '');
    if (/product image analyzer/i.test(systemText) || userText.includes('Identify the product shown')) {
        return geminiResponse(ATTRS_JSON);
    }
    return geminiResponse(REPLY_TEXT);
});

const route = (params = {}) => routeIntent({
    shopId: SHOP,
    conversationId: CONV,
    systemPrompt: 'BASE',
    language: 'en',
    ...params,
});

// The recorder runs on floating promises (void recordUsage). Drain microtasks
// and one macrotask tick so every ai_usage write has settled before asserts.
const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const aiUsageLines = () => logSpy.mock.calls
    .map(([line]) => line)
    .filter((line) => typeof line === 'string' && line.includes('"event":"ai_usage"'));

const capturedRecords = () => mockLedger.insertUsageRow.mock.calls.map(([rec]) => rec);

let logSpy;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetGeneration.mockResolvedValue(0);
    mockRecordReadAction.mockReset().mockResolvedValue({ recorded: true });
    FaqResponse.findAll.mockResolvedValue([]);
    FaqResponse.findOne.mockResolvedValue(null);
    rag.queryData.mockResolvedValue({ results: [] });
    productSearch.searchByAttributes.mockResolvedValue([]);
    productSearch.getProductsByIds.mockResolvedValue([]);
    process.env.AI_USAGE_ACCOUNTING = 'true';
    process.env['EM-GEMINI-KEY'] = 'unit-test-key';
    jest.spyOn(global, 'fetch').mockImplementation(fetchStub);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.AI_USAGE_ACCOUNTING;
    delete process.env['EM-GEMINI-KEY'];
    delete process.env.AI_PHOTO_MATCH_ENABLED;
    jest.restoreAllMocks();
});

describe('intent-router attribution reaches the ledger sink (real llm.service + recorder)', () => {
    test('main reply records chat_reply attributed to the authoritative shop and conversation', async () => {
        await route({ traceId: `${RUN}-main`, message: 'What should I know before choosing?' });
        await settle();

        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        const [rec] = capturedRecords();
        expect(rec).toMatchObject({
            shopId: SHOP,
            operationType: 'chat_reply',
            requestId: `${RUN}-main:chat_reply`,
            conversationId: CONV,
        });
        expect(rec.provider).toBe('gemini-lite');

        // The durable row keeps full attribution (UUIDs survive projection).
        const row = projectLedgerRow(rec);
        expect(row.shopId).toBe(SHOP);
        expect(row.operationType).toBe('chat_reply');
        expect(row.conversationId).toBe(CONV);
        expect(row.requestId).toBe(`${RUN}-main:chat_reply`);

        // Structured log line carries the same attribution for the log pipeline.
        expect(JSON.parse(aiUsageLines().at(-1))).toMatchObject({
            shopId: SHOP, operationType: 'chat_reply', requestId: `${RUN}-main:chat_reply`,
        });
    });

    test('FAQ reply records chat_reply with suffixed requestId', async () => {
        FaqResponse.findAll.mockResolvedValue([{
            id: 'faq-9', category: 'delivery',
            template_en: 'Delivery takes 3 to 5 days within Dhaka. The delivery charge is 60 Taka.',
            template_bn: null, priority: 5, use_count: 1, is_active: true,
        }]);

        const result = await route({ traceId: `${RUN}-faq`, message: 'delivery days dhaka' });
        await settle();

        expect(result.source).toBe('faq');
        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        const [rec] = capturedRecords();
        expect(rec).toMatchObject({
            shopId: SHOP,
            operationType: 'chat_reply',
            requestId: `${RUN}-faq:chat_reply`,
            conversationId: CONV,
        });
        expect(projectLedgerRow(rec).shopId).toBe(SHOP);
    });

    test('a photo turn records BOTH calls — product_attrs and chat_reply — each attributed, neither deduped away', async () => {
        process.env.AI_PHOTO_MATCH_ENABLED = 'true';
        const fixture = loadSyntheticMediaFixture('denim-jacket-blue');
        productSearch.searchByAttributes.mockResolvedValue([{
            id: 'p-saree', shop_id: SHOP, name: 'Red Saree', category: 'saree',
            price: 1200, quantity: 3, track_quantity: true, variants: [],
        }]);

        await route({
            traceId: `${RUN}-photo`,
            message: '[image]',
            imageUrls: [fixture.dataUrl],
        });
        await settle();

        expect(fetchStub).toHaveBeenCalledTimes(2); // attrs call + reply call
        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(2);
        const byOp = Object.fromEntries(capturedRecords().map((r) => [r.operationType, r]));
        expect(byOp.product_attrs).toMatchObject({
            shopId: SHOP,
            requestId: `${RUN}-photo:product_attrs`,
            conversationId: CONV,
            imageCount: 1,
        });
        expect(byOp.chat_reply).toMatchObject({
            shopId: SHOP,
            requestId: `${RUN}-photo:chat_reply`,
            conversationId: CONV,
        });
        // The suffixed ids are distinct: the two real calls cannot collapse.
        expect(byOp.product_attrs.requestId).not.toBe(byOp.chat_reply.requestId);
    });

    test('a retried turn with the same traceId counts once (requestId idempotency)', async () => {
        const trace = `${RUN}-retry`;
        await route({ traceId: trace, message: 'What should I know before choosing?' });
        await settle();
        await route({ traceId: trace, message: 'What should I know before choosing?' });
        await settle();

        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        expect(aiUsageLines()).toHaveLength(1);
    });

    test('no traceId (today production controller) still records, attributed by shopId with a null requestId', async () => {
        await route({ traceId: null, message: 'What should I know before choosing?' });
        await settle();

        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        const [rec] = capturedRecords();
        expect(rec.shopId).toBe(SHOP);
        expect(rec.operationType).toBe('chat_reply');
        expect(rec.requestId).toBeNull();
        expect(rec.conversationId).toBe(CONV);
        // A null request_id never conflicts, so retries cannot silently drop.
        const row = projectLedgerRow(rec);
        expect(row.shopId).toBe(SHOP);
        expect(row.requestId).toBeNull();
    });

    test('gate OFF: the wired call sites are a total no-op — no log line, no ledger write', async () => {
        delete process.env.AI_USAGE_ACCOUNTING;

        await route({ traceId: `${RUN}-gateoff`, message: 'What should I know before choosing?' });
        await settle();

        expect(mockLedger.insertUsageRow).not.toHaveBeenCalled();
        expect(aiUsageLines()).toHaveLength(0);
    });

    test('no customer content or PII reaches either sink from the wired sites', async () => {
        const phone = '01712345678';
        FaqResponse.findAll.mockResolvedValue([{
            id: 'faq-11', category: 'exchange',
            template_en: 'Exchange is allowed within 7 days.',
            template_bn: null, priority: 3, use_count: 0, is_active: true,
        }]);

        await route({
            traceId: `${RUN}-pii`,
            message: `exchange days ${phone}`,
        });
        await settle();

        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        const blobs = [
            ...capturedRecords().map((r) => JSON.stringify(r)),
            ...aiUsageLines(),
        ];
        for (const blob of blobs) {
            expect(blob).not.toContain(phone);
            expect(blob).not.toContain('exchange days');
            expect(blob).not.toContain('Exchange is allowed');
        }
        // And attribution survived: the record is still fully attributed.
        const [rec] = capturedRecords();
        expect(rec.shopId).toBe(SHOP);
        expect(rec.operationType).toBe('chat_reply');
    });
});
