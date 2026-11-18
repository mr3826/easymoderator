'use strict';

process.env.NODE_ENV = 'test';

jest.mock('src/config/redis', () => ({
    cacheRedis: {
        get: jest.fn(async () => null),
        set: jest.fn(async () => 'OK'),
        setex: jest.fn(async () => 'OK'),
        del: jest.fn(async () => 1),
        incr: jest.fn(async () => 1),
        expire: jest.fn(async () => 1),
        keys: jest.fn(async () => []),
    },
}));
jest.mock('src/modules/ai/ops-alert.service', () => ({
    alertLlmOutage: jest.fn(),
    notifyOps: jest.fn(),
}));

const response = (body, headers = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => body,
});

describe('LLM provider response and credential contract', () => {
    let llm;
    let priorFetch;
    let priorDashKey;
    let priorLegacyKey;
    let priorOpenAiKey;

    beforeEach(() => {
        jest.resetModules();
        priorFetch = global.fetch;
        priorDashKey = process.env['EM-GEMINI-KEY'];
        priorLegacyKey = process.env.GEMINI_API_KEY;
        priorOpenAiKey = process.env.OPENAI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        process.env['EM-GEMINI-KEY'] = 'test-only-gemini-secret';
        process.env.OPENAI_API_KEY = 'test-only-openai-secret';
        process.env.LLM_GEMINI_TIMEOUT_MS = '1500';
        llm = require('../llm.service');
    });

    afterEach(() => {
        global.fetch = priorFetch;
        if (priorDashKey === undefined) delete process.env['EM-GEMINI-KEY'];
        else process.env['EM-GEMINI-KEY'] = priorDashKey;
        if (priorLegacyKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = priorLegacyKey;
        if (priorOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = priorOpenAiKey;
        delete process.env.LLM_GEMINI_TIMEOUT_MS;
    });

    test('uses EM-GEMINI-KEY in the auth header and returns redacted request metadata', async () => {
        global.fetch = jest.fn(async () => response({
            candidates: [{ content: { parts: [{ text: 'catalog-grounded answer' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 6, totalTokenCount: 23 },
        }, { 'x-request-id': 'request-123' }));

        const result = await llm.chat({
            messages: [{ role: 'user', content: 'price?' }],
            skipProviders: ['gemini-pro', 'openai'],
            returnMetadata: true,
        });

        const [url, options] = global.fetch.mock.calls[0];
        expect(String(url)).toContain(llm.GEMINI_LITE_MODEL);
        expect(String(url)).not.toContain('test-only-gemini-secret');
        expect(String(url)).not.toMatch(/[?&]key=/i);
        expect(options.headers['x-goog-api-key']).toBe('test-only-gemini-secret');
        expect(JSON.stringify(result)).not.toContain('test-only-gemini-secret');
        expect(result).toMatchObject({
            text: 'catalog-grounded answer',
            provider: 'gemini-lite',
            model: llm.GEMINI_LITE_MODEL,
            requestId: 'request-123',
            usage: { promptTokenCount: 17, candidatesTokenCount: 6, totalTokenCount: 23 },
        });
    });

    test('does not report an empty Gemini candidate as a successful response', async () => {
        global.fetch = jest.fn(async (url) => String(url).includes('openai.com')
            ? response({ choices: [{ message: { content: 'fallback answer' } }] })
            : response({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }));

        const result = await llm.chat({ messages: [{ role: 'user', content: 'hello' }] });

        expect(result).toMatchObject({ text: 'fallback answer', provider: 'openai' });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(result).not.toHaveProperty('fallbackUsed');
        global.fetch.mockClear();
        await expect(llm.chat({ messages: [{ role: 'user', content: 'hello' }], observeFallback: true }))
            .resolves.toEqual({ ...result, fallbackUsed: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('treats Gemini safety blocks as provider failures and does not expose response text', async () => {
        global.fetch = jest.fn(async (url) => String(url).includes('openai.com')
            ? response({ choices: [{ message: { content: 'safe fallback' } }] })
            : response({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));

        const result = await llm.chat({ messages: [{ role: 'user', content: 'hello' }] });

        expect(result).toMatchObject({ text: 'safe fallback', provider: 'openai' });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('rejects empty output when only Gemini is permitted', async () => {
        global.fetch = jest.fn(async () => response({ candidates: [{ content: { parts: [{ inlineData: { data: 'AA==' } }] } }] }));

        await expect(llm.chat({
            messages: [{ role: 'user', content: 'hello' }],
            skipProviders: ['gemini-pro', 'openai'],
        })).rejects.toThrow(/All LLM providers failed/);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('does not put provider error bodies into thrown errors', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            text: async () => 'upstream echoed sensitive request context',
        }));

        let thrown;
        try {
            await llm.chat({ messages: [{ role: 'user', content: 'hello' }], skipProviders: ['gemini-pro', 'openai'] });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeDefined();
        expect(thrown.message).toContain('403');
        expect(thrown.message).not.toContain('sensitive request context');
    });

    test('preserves a safe Gemini rate-limit classification without provider response text', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 429,
            text: async () => 'rate limit response contained private request details',
        }));

        let thrown;
        try {
            await llm.chat({
                messages: [{ role: 'user', content: 'hello' }],
                skipProviders: ['gemini-pro', 'openai'],
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ code: 'GEMINI_RATE_LIMIT' });
        expect(thrown.message).toContain('429');
        expect(thrown.message).not.toContain('private request details');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
