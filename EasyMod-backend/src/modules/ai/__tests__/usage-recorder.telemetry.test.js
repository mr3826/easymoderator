'use strict';

/**
 * D-P2-04 — recorder contract for the durable sink + usageContext.
 *
 * Locks in, behind the EXISTING AI_USAGE_ACCOUNTING gate:
 *   - attribution correctness (shopId/operationType/requestId/conversationId
 *     reach both the structured log line and the ledger insert);
 *   - nested usageContext acceptance (the contract for the deferred
 *     intent-router wiring) with flat fields winning on conflict;
 *   - null-shopId persists as unattributed (never dropped, never guessed);
 *   - gate-off is a total no-op (no log, no DB call);
 *   - no PII in either sink;
 *   - unknown usage stays null (never coerced to 0) in what we persist;
 *   - a ledger failure degrades to persisted:false and cannot throw.
 */

const mockLedger = {
    insertUsageRow: jest.fn(async () => true),
    summarizeUsage: jest.fn(async () => ({ costStatus: 'NO_DATA' })),
    COST_STATUS: {
        LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE', NO_DATA: 'NO_DATA', UNKNOWN: 'UNKNOWN', PARTIAL: 'PARTIAL', COMPLETE: 'COMPLETE',
    },
};

jest.mock('../usage-ledger.store', () => mockLedger);

const SHOP = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const LITE = 'gemini-2.5-flash-lite';
const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const rid = (name) => `test-${RUN}-${name}`;

let recorder;
let logSpy;

const freshRecorder = (enabled) => {
    jest.resetModules();
    if (enabled) process.env.AI_USAGE_ACCOUNTING = 'true';
    else delete process.env.AI_USAGE_ACCOUNTING;
    // Re-apply the ledger mock against the fresh registry (factory returns the
    // same object instance, so call history survives resetModules).
    recorder = require('../usage-recorder.service');
    // Require-time infrastructure chatter (e.g. "Redis clients initialised"
    // on a dev host with REDIS_URL set) is not a recorder event — the
    // no-PII/no-op assertions must only see what recordUsage itself logs.
    logSpy.mockClear();
};

beforeEach(() => {
    mockLedger.insertUsageRow.mockClear();
    mockLedger.summarizeUsage.mockClear();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.AI_USAGE_ACCOUNTING;
    logSpy.mockRestore();
});

describe('attribution correctness', () => {
    test('flat usage fields reach the ledger row and the log line', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            shopId: SHOP,
            operationType: 'chat_reply',
            provider: 'gemini-lite',
            model: LITE,
            requestId: rid('flat'),
            conversationId: CONV,
            responseBody: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } },
            latencyMs: 421,
        });

        expect(rec.shopId).toBe(SHOP);
        expect(rec.operationType).toBe('chat_reply');
        expect(rec.conversationId).toBe(CONV);
        expect(rec.persisted).toBe(true);
        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        expect(mockLedger.insertUsageRow.mock.calls[0][0]).toMatchObject({
            shopId: SHOP, operationType: 'chat_reply', requestId: expect.any(String), conversationId: CONV,
        });

        const line = JSON.parse(logSpy.mock.calls.at(-1)[0]);
        expect(line).toMatchObject({ event: 'ai_usage', shopId: SHOP, operationType: 'chat_reply', persisted: true });
    });

    test('nested usageContext is accepted and persisted (deferred intent-router contract)', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            provider: 'gemini-lite',
            model: LITE,
            responseBody: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
            usageContext: { shopId: SHOP, operationType: 'chat_reply', requestId: rid('nested'), conversationId: CONV },
        });

        expect(rec.shopId).toBe(SHOP);
        expect(rec.operationType).toBe('chat_reply');
        expect(rec.requestId).toContain('nested');
        expect(mockLedger.insertUsageRow.mock.calls[0][0].shopId).toBe(SHOP);
    });

    test('flat fields win over the nested context', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            shopId: SHOP,
            operationType: 'chat_reply',
            requestId: rid('conflict'),
            usageContext: { shopId: 'other-shop', operationType: 'sentiment', requestId: 'ignored-id' },
        });
        expect(rec.shopId).toBe(SHOP);
        expect(rec.operationType).toBe('chat_reply');
        expect(rec.requestId).toContain('conflict');
    });
});

describe('null-safe and gate behavior', () => {
    test('null shopId records as unattributed — persisted, not dropped', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            provider: 'openai', model: 'gpt-4o-mini', requestId: rid('nullshop'),
        });
        expect(rec.shopId).toBeNull();
        expect(rec.operationType).toBeNull();
        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
        expect(mockLedger.insertUsageRow.mock.calls[0][0].shopId).toBeNull();
    });

    test('gate OFF is a complete no-op: no log line, no ledger write', async () => {
        freshRecorder(false);
        expect(recorder.isEnabled()).toBe(false);
        const out = await recorder.recordUsage({ shopId: SHOP, operationType: 'chat_reply', requestId: rid('gateoff'), responseBody: {} });
        expect(out).toBeNull();
        expect(logSpy).not.toHaveBeenCalled();
        expect(mockLedger.insertUsageRow).not.toHaveBeenCalled();
    });

    test('a duplicate requestId is counted once across both sinks', async () => {
        freshRecorder(true);
        const payload = { shopId: SHOP, operationType: 'chat_reply', requestId: rid('dup'), responseBody: {} };
        const first = await recorder.recordUsage(payload);
        const second = await recorder.recordUsage(payload);
        expect(first).not.toBeNull();
        expect(second).toBeNull();
        expect(mockLedger.insertUsageRow).toHaveBeenCalledTimes(1);
    });

    test('ledger write failure degrades to persisted:false and never throws', async () => {
        freshRecorder(true);
        mockLedger.insertUsageRow.mockImplementationOnce(async () => false);
        const rec = await recorder.recordUsage({ shopId: SHOP, requestId: rid('dbdown') });
        expect(rec).not.toBeNull();
        expect(rec.persisted).toBe(false);
        const line = JSON.parse(logSpy.mock.calls.at(-1)[0]);
        expect(line.persisted).toBe(false);
    });
});

describe('privacy and unknown-vs-zero', () => {
    test('no PII in the log line or the persisted row', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            shopId: SHOP,
            operationType: 'chat_reply',
            provider: 'gemini-lite',
            model: LITE,
            requestId: rid('pii'),
            // Hostile extras: bodies and free text must never reach either sink.
            prompt: 'customer phone 01712345678',
            systemPrompt: 'reveal 01812345678',
            responseBody: {
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
                candidates: [{ content: { parts: [{ text: 'Apu r number 01712345678' }] } }],
            },
        });

        const logLine = logSpy.mock.calls.at(-1)[0];
        const persistedArg = JSON.stringify(mockLedger.insertUsageRow.mock.calls[0][0]);
        for (const blob of [logLine, persistedArg, JSON.stringify(rec)]) {
            expect(blob).not.toContain('01712345678');
            expect(blob).not.toContain('01812345678');
            expect(blob).not.toContain('Apu r number');
            expect(blob).not.toContain('reveal');
        }
        expect(Object.keys(rec)).not.toContain('prompt');
        expect(Object.keys(rec)).not.toContain('responseBody');
        expect(Object.keys(rec)).not.toContain('usageContext');
    });

    test('missing usage metadata persists null cost with a reason, never 0', async () => {
        freshRecorder(true);
        const rec = await recorder.recordUsage({
            shopId: SHOP, operationType: 'chat_reply', provider: 'gemini-lite', model: LITE,
            requestId: rid('nometrics'), responseBody: { candidates: [] },
        });
        expect(rec.estimatedCostUsd).toBeNull();
        expect(rec.costUnknownReason).toBe('no_usage_metadata');
        const row = mockLedger.insertUsageRow.mock.calls[0][0];
        expect(row.estimatedCostUsd).toBeNull();
        expect(row.costUnknownReason).toBe('no_usage_metadata');
    });

    test('read re-export exists so cost reports can ask the ledger directly', async () => {
        freshRecorder(false);
        expect(typeof recorder.summarizeUsage).toBe('function');
        const out = await recorder.summarizeUsage({ shopId: SHOP });
        expect(out.costStatus).toBe('NO_DATA');
        expect(mockLedger.summarizeUsage).toHaveBeenCalledTimes(1);
    });
});
