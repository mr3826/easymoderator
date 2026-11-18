'use strict';

/**
 * Embedding provider self-check — getProviderInfo() / probe().
 * Guards the #1 hallucination cause: silently running on the non-semantic
 * local fallback (or a typo'd provider that falls through to it).
 */

const svc = require('../embedding.service');

const ENV_KEYS = [
    'EMBEDDING_PROVIDER', 'EMBEDDING_API_URL', 'OPENAI_API_KEY',
    'EMBEDDING_MODEL', 'GEMINI_API_KEY', 'GEMINI_EMBEDDING_MODEL',
    'EMBEDDING_SPACE_VERSION', 'GEMINI_EMBEDDING_SPACE_VERSION',
    'OPENAI_EMBEDDING_SPACE_VERSION', 'EMBEDDING_HTTP_MAX_RETRIES',
    'NODE_ENV',
];
const saved = {};
beforeEach(() => { ENV_KEYS.forEach(k => { saved[k] = process.env[k]; }); });
afterEach(() => {
    ENV_KEYS.forEach(k => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    });
});

describe('getProviderInfo', () => {
    test('unset → non-semantic local fallback', () => {
        delete process.env.EMBEDDING_PROVIDER;
        const info = svc.getProviderInfo();
        expect(info.effective).toBe('local');
        expect(info.semantic).toBe(false);
    });

    test('production defaults to Gemini as the primary provider', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.EMBEDDING_PROVIDER;
        const info = svc.getProviderInfo();
        expect(info).toMatchObject({
            configured: 'gemini',
            effective: 'gemini',
            semantic: true,
            model: 'gemini-embedding-2',
            fallbackProvider: 'openai',
            fallbackModel: 'text-embedding-3-small',
        });
    });

    test("'http' is a valid alias for the HTTP embedding client (semantic)", () => {
        process.env.EMBEDDING_PROVIDER = 'http';
        process.env.EMBEDDING_API_URL = 'http://tei:8080/embed';
        const info = svc.getProviderInfo();
        expect(info.effective).toBe('gcp');
        expect(info.semantic).toBe(true);
        expect(info.keyPresent).toBe(true); // EMBEDDING_API_URL present
    });

    test("'tei' alias also maps to the HTTP client", () => {
        process.env.EMBEDDING_PROVIDER = 'tei';
        expect(svc.getProviderInfo().effective).toBe('gcp');
    });

    test('openai reports OPENAI_API_KEY presence', () => {
        process.env.EMBEDDING_PROVIDER = 'openai';
        process.env.OPENAI_API_KEY = '';
        expect(svc.getProviderInfo()).toMatchObject({ effective: 'openai', semantic: true, keyPresent: false });
        process.env.OPENAI_API_KEY = 'sk-test';
        expect(svc.getProviderInfo().keyPresent).toBe(true);
    });

    test('gemini is semantic and reports GEMINI_API_KEY presence', () => {
        process.env.EMBEDDING_PROVIDER = 'gemini';
        delete process.env.GEMINI_API_KEY;
        expect(svc.getProviderInfo()).toMatchObject({
            effective: 'gemini', semantic: true, keyPresent: false, model: 'gemini-embedding-2',
        });
        process.env.GEMINI_API_KEY = 'AIza-test';
        expect(svc.getProviderInfo().keyPresent).toBe(true);
    });

    test("'google' alias maps to gemini", () => {
        process.env.EMBEDDING_PROVIDER = 'google';
        expect(svc.getProviderInfo().effective).toBe('gemini');
    });

    test('anthropic / unknown values fall back to non-semantic local', () => {
        process.env.EMBEDDING_PROVIDER = 'anthropic';
        expect(svc.getProviderInfo().semantic).toBe(false);
        process.env.EMBEDDING_PROVIDER = 'banana';
        expect(svc.getProviderInfo().effective).toBe('local');
    });
});

describe('probe', () => {
    test('local provider still returns a vector of the configured size', async () => {
        delete process.env.EMBEDDING_PROVIDER;
        const info = svc.getProviderInfo();
        const result = await svc.probe();
        expect(result.ok).toBe(true);
        expect(result.semantic).toBe(false);
        expect(result.dimensions).toBe(info.vectorSize);
    });

    test('openai with no API key fails the probe (never throws)', async () => {
        process.env.EMBEDDING_PROVIDER = 'openai';
        process.env.OPENAI_API_KEY = '';
        const result = await svc.probe();
        expect(result.ok).toBe(false);
        expect(result.provider).toBe('openai');
        expect(result.error).toBeTruthy();
    });

    test('gemini asks for exactly QDRANT_VECTOR_SIZE dimensions', async () => {
        process.env.EMBEDDING_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'AIza-test';
        const vectorSize = svc.getProviderInfo().vectorSize;

        const realFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embedding: { values: new Array(svc.getProviderInfo().vectorSize).fill(0.1) } }),
        }));
        try {
            const result = await svc.probe();
            expect(result).toMatchObject({ ok: true, provider: 'gemini', semantic: true, dimensions: svc.getProviderInfo().vectorSize });

            const [url, init] = global.fetch.mock.calls[0];
            expect(url).toContain('models/gemini-embedding-2:embedContent');
            expect(JSON.parse(init.body).outputDimensionality).toBe(svc.getProviderInfo().vectorSize);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('Gemini failure does not create an OpenAI vector at the embedding boundary', async () => {
        process.env.NODE_ENV = 'production';
        process.env.EMBEDDING_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'AIza-test-primary';
        process.env.OPENAI_API_KEY = 'sk-test-fallback';
        process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
        process.env.EMBEDDING_HTTP_MAX_RETRIES = '0';
        const calls = [];
        const realFetch = global.fetch;
        global.fetch = jest.fn(async (url) => {
            calls.push(String(url).includes('generativelanguage') ? 'gemini' : 'openai');
            if (String(url).includes('generativelanguage')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ embedding: { values: [0.1] } }),
                };
            }
            throw new Error('OpenAI must not be called for per-vector fallback');
        });
        try {
            await expect(svc.getEmbedding('fallback test')).rejects.toThrow(/length/);
            expect(calls).toEqual(['gemini']);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('a Gemini provider error remains terminal until rag.service routes to a READY collection', async () => {
        process.env.NODE_ENV = 'production';
        process.env.EMBEDDING_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'AIza-test-primary';
        process.env.OPENAI_API_KEY = 'sk-test-fallback';
        process.env.EMBEDDING_HTTP_MAX_RETRIES = '0';
        const realFetch = global.fetch;
        const calls = [];
        global.fetch = jest.fn(async (url) => {
            calls.push(String(url));
            if (String(url).includes('generativelanguage')) {
                return {
                    ok: false,
                    status: 503,
                    text: async () => 'provider unavailable',
                };
            }
            throw new Error('OpenAI must not be called by getEmbeddingResult');
        });
        try {
            await expect(svc.getEmbeddingResult('terminal failure test')).rejects.toThrow(/Gemini embeddings failed/);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toContain('generativelanguage');
        } finally {
            global.fetch = realFetch;
        }
    });

    test('Gemini Embedding 2 uses the asymmetric query/document input contract', async () => {
        process.env.EMBEDDING_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'AIza-test';
        process.env.EMBEDDING_HTTP_MAX_RETRIES = '0';
        const vectorSize = svc.getProviderInfo().vectorSize;

        const realFetch = global.fetch;
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embedding: { values: new Array(svc.getProviderInfo().vectorSize).fill(0.1) } }),
        }));
        try {
            await svc.getEmbeddingResult('delivery query', { purpose: 'query' });
            await svc.getEmbeddingResult('delivery answer', { purpose: 'document', title: 'FAQ' });
            const queryBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            const documentBody = JSON.parse(global.fetch.mock.calls[1][1].body);
            expect(queryBody.content.parts[0].text).toBe('task: search result | query: delivery query');
            expect(documentBody.content.parts[0].text).toBe('title: FAQ | text: delivery answer');
            expect(queryBody).not.toHaveProperty('taskType');
            expect(documentBody).not.toHaveProperty('taskType');
        } finally {
            global.fetch = realFetch;
        }
    });
});

describe('embedding abort signal', () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
    });

    test('fetchWithRetries stops retrying after the signal aborts', async () => {
        process.env.EMBEDDING_HTTP_MAX_RETRIES = '3';
        process.env.EMBEDDING_RETRY_BACKOFF_MS = '0';
        const controller = new AbortController();
        const fetchCalls = [];
        global.fetch = jest.fn(() => {
            fetchCalls.push(1);
            return new Promise((resolve, reject) => {
                const poll = () => {
                    if (controller.signal.aborted) {
                        reject(controller.signal.reason || new Error('down'));
                    } else {
                        setTimeout(poll, 5);
                    }
                };
                poll();
            });
        });
        setTimeout(() => controller.abort(), 5);
        await expect(svc.fetchWithRetries('http://tei/embed', {}, controller.signal, 3)).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchCalls).toHaveLength(1);
    });

    test('OpenAI fetch receives the signal', async () => {
        process.env.EMBEDDING_PROVIDER = 'openai';
        process.env.OPENAI_API_KEY = 'sk-test';
        const fetchCalls = [];
        global.fetch = jest.fn((url, init) => {
            fetchCalls.push(init.signal);
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: new Array(svc.getProviderInfo().vectorSize).fill(0.1) }] }) });
        });
        try {
            const signal = new AbortController().signal;
            await svc.getEmbeddingResult('signal test', {
                identity: svc.getEmbeddingSpaceIdentity({ provider: 'openai', dimensions: svc.getProviderInfo().vectorSize }),
                signal,
            });
            expect(fetchCalls[0]).toBe(signal);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('Gemini fetch receives the signal', async () => {
        process.env.GEMINI_API_KEY = 'AIza-test';
        const fetchCalls = [];
        global.fetch = jest.fn((url, init) => {
            if (String(url).includes('generativelanguage')) {
                fetchCalls.push(init.signal);
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ embedding: { values: new Array(svc.getProviderInfo().vectorSize).fill(0.1) } }) });
            }
            return Promise.reject(new Error('unexpected ' + url));
        });
        try {
            const signal = new AbortController().signal;
            await svc.getEmbeddingResult('signal test', {
                identity: svc.getEmbeddingSpaceIdentity({ provider: 'gemini', dimensions: svc.getProviderInfo().vectorSize }),
                signal,
            });
            expect(fetchCalls[0]).toBe(signal);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('GCP fetch receives the signal', async () => {
        process.env.EMBEDDING_API_URL = 'http://tei:8080/embed';
        const fetchCalls = [];
        global.fetch = jest.fn((url, init) => {
            fetchCalls.push(init.signal);
            return Promise.resolve({ ok: true, status: 200, json: async () => ([new Array(svc.getProviderInfo().vectorSize).fill(0.1)]) });
        });
        try {
            const signal = new AbortController().signal;
            await svc.getEmbeddingResult('signal test', {
                identity: svc.getEmbeddingSpaceIdentity({ provider: 'gcp', dimensions: svc.getProviderInfo().vectorSize }),
                signal,
            });
            expect(fetchCalls[0]).toBe(signal);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('local fallback performs no fetch', async () => {
        delete process.env.EMBEDDING_PROVIDER;
        const fetchCalls = [];
        global.fetch = jest.fn(() => {
            fetchCalls.push(1);
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });
        try {
            await svc.getEmbeddingResult('local signal test');
            expect(fetchCalls).toHaveLength(0);
        } finally {
            global.fetch = realFetch;
        }
    });
});
