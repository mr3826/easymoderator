'use strict';

/**
 * D-P2-04 — durable ledger store. The database module is mocked: the store
 * must (a) never throw, (b) project records onto the allow-list only, and
 * (c) report unknown cost as UNKNOWN on the read path, never zero.
 */

process.env.NODE_ENV = 'test';
process.env.AI_USAGE_LEDGER_DB = 'true'; // opt this suite into the (mocked) client path

const mockSeq = { query: jest.fn() };
jest.mock('src/utils/database/database-setup', () => ({ sequelize: mockSeq }));

const ledger = require('../usage-ledger.store');

const SHOP = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
    mockSeq.query.mockReset();
    ledger.resetLedgerClientForTests();
});

describe('insertUsageRow', () => {
    test('persists attribution fields with a parameterized query', async () => {
        mockSeq.query.mockResolvedValue([{ rowCount: 1 }]);
        const ok = await ledger.insertUsageRow({
            timestamp: '2026-11-23T00:00:00.000Z',
            shopId: SHOP,
            operationType: 'chat_reply',
            provider: 'gemini-lite',
            model: 'gemini-2.5-flash-lite',
            requestId: 'msg-1',
            conversationId: CONV,
            inputTokens: 100,
            outputTokens: 20,
            estimatedCostUsd: 0.001,
            success: true,
        });

        expect(ok).toBe(true);
        const [sql, options] = mockSeq.query.mock.calls[0];
        expect(sql).toContain('INSERT INTO ai_usage_ledger');
        expect(sql).toContain('ON CONFLICT (request_id) DO NOTHING');
        expect(sql).toContain(':shopId');
        expect(options.replacements).toMatchObject({
            shopId: SHOP,
            operationType: 'chat_reply',
            requestId: 'msg-1',
            conversationId: CONV,
            estimatedCostUsd: 0.001,
        });
        // Values are never concatenated into SQL text (injection-safe by shape).
        expect(sql).not.toContain('msg-1');
    });

    test('null shopId is stored as unattributed, never dropped', async () => {
        mockSeq.query.mockResolvedValue([{}]);
        await expect(ledger.insertUsageRow({ operationType: 'embed', provider: 'openai', model: 'm', requestId: 'r-1' }))
            .resolves.toBe(true);
        expect(mockSeq.query.mock.calls[0][1].replacements.shopId).toBeNull();
    });

    test('unknown cost persists as null with its reason (never 0)', async () => {
        mockSeq.query.mockResolvedValue([{}]);
        const row = ledger.projectLedgerRow({ estimatedCostUsd: null, costUnknownReason: 'no_usage_metadata' });
        expect(row.estimatedCostUsd).toBeNull();
        expect(row.costUnknownReason).toBe('no_usage_metadata');
    });

    test('malformed ids degrade to null instead of losing the cost row', async () => {
        mockSeq.query.mockResolvedValue([{}]);
        const row = ledger.projectLedgerRow({ shopId: 'shop-1', conversationId: 'not-a-uuid', requestId: 'x'.repeat(500) });
        expect(row.shopId).toBeNull();
        expect(row.conversationId).toBeNull();
        expect(row.requestId.length).toBeLessThanOrEqual(128);
    });

    test('prompt or reply text cannot reach the projection', async () => {
        mockSeq.query.mockResolvedValue([{}]);
        const row = ledger.projectLedgerRow({
            shopId: SHOP,
            // Hostile/extra keys a caller might carry — allow-list must drop them.
            prompt: 'hi 01712345678',
            messages: [{ role: 'user', content: 'Apu number 01712345678' }],
            systemPrompt: 'secret instructions',
            responseBody: { candidates: [{ text: '01712345678' }] },
        });
        expect(Object.keys(row).sort()).toEqual([
            'cachedInputTokens', 'conversationId', 'costUnknownReason', 'embeddingTokens', 'estimatedCostUsd',
            'fallbackSequence', 'id', 'imageCount', 'imageTokens', 'inputTokens', 'latencyMs', 'messageId',
            'model', 'occurredAt', 'operationType', 'outputTokens', 'pricingVersion', 'productId',
            'provider', 'reasoningTokens', 'requestId', 'retrySequence', 'shopId', 'sourceOfUsage', 'success',
        ].sort());
        expect(JSON.stringify(row)).not.toContain('01712345678');
        expect(JSON.stringify(row)).not.toContain('secret');
    });

    test('a database failure returns false and never throws', async () => {
        mockSeq.query.mockRejectedValue(new Error('connection reset'));
        await expect(ledger.insertUsageRow({ shopId: SHOP, requestId: 'r-2' })).resolves.toBe(false);
    });
});

describe('summarizeUsage read path (UNKNOWN is never zero)', () => {
    const agg = (over = {}) => [[{
        calls: 0, known_cost_calls: 0, unknown_cost_calls: 0, known_cost_usd: 0,
        input_tokens: 0, output_tokens: 0, pricing_version: null, ...over,
    }], []];

    test('empty ledger reports NO_DATA with a null total', async () => {
        mockSeq.query.mockResolvedValue(agg());
        const res = await ledger.summarizeUsage({ shopId: SHOP });
        expect(res.costStatus).toBe('NO_DATA');
        expect(res.costKnown).toBe(false);
        expect(res.totalEstimatedCostUsd).toBeNull();
        expect(res.totalEstimatedCostUsd).not.toBe(0);
    });

    test('all calls lacking cost report UNKNOWN with a null total', async () => {
        mockSeq.query.mockResolvedValue(agg({ calls: 5, unknown_cost_calls: 5 }));
        const res = await ledger.summarizeUsage({ shopId: SHOP });
        expect(res.costStatus).toBe('UNKNOWN');
        expect(res.totalEstimatedCostUsd).toBeNull();
        expect(res.knownCostUsd).toBe(0);
        expect(res.unknownCostCalls).toBe(5);
    });

    test('mixed scope reports PARTIAL: partial sum labeled, total stays null', async () => {
        mockSeq.query.mockResolvedValue(agg({ calls: 4, known_cost_calls: 2, unknown_cost_calls: 2, known_cost_usd: '0.003' }));
        const res = await ledger.summarizeUsage({ shopId: SHOP });
        expect(res.costStatus).toBe('PARTIAL');
        expect(res.costKnown).toBe(false);
        expect(res.totalEstimatedCostUsd).toBeNull();
        expect(res.knownCostUsd).toBeCloseTo(0.003, 10);
    });

    test('fully measured scope reports the sum (Postgres returns NUMERIC as string)', async () => {
        mockSeq.query.mockResolvedValue(agg({ calls: 3, known_cost_calls: 3, unknown_cost_calls: 0, known_cost_usd: '1.25', pricing_version: '2026-10-01' }));
        const res = await ledger.summarizeUsage({ shopId: SHOP, from: '2026-11-01', to: '2026-11-23' });
        expect(res.costStatus).toBe('COMPLETE');
        expect(res.totalEstimatedCostUsd).toBeCloseTo(1.25, 10);
        expect(res.scope).toEqual({ shopId: SHOP, from: '2026-11-01', to: '2026-11-23', operationType: null });
        expect(res.pricingVersion).toBe('2026-10-01');
    });

    test('filters are parameterized, not interpolated', async () => {
        mockSeq.query.mockResolvedValue(agg());
        await ledger.summarizeUsage({ shopId: SHOP, operationType: 'chat_reply', from: '2026-11-01' });
        const [sql, options] = mockSeq.query.mock.calls[0];
        expect(sql).toContain('shop_id = :shopId');
        expect(sql).toContain('operation_type = :operationType');
        expect(options.replacements).toEqual({ shopId: SHOP, operationType: 'chat_reply', from: '2026-11-01' });
        expect(sql).not.toContain(SHOP);
    });

    test('query failure reports LEDGER_UNAVAILABLE with a null total', async () => {
        mockSeq.query.mockRejectedValue(new Error('boom'));
        const res = await ledger.summarizeUsage({ shopId: SHOP });
        expect(res.costStatus).toBe('LEDGER_UNAVAILABLE');
        expect(res.totalEstimatedCostUsd).toBeNull();
    });
});
