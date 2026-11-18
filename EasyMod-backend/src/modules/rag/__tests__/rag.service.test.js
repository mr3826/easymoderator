'use strict';

/**
 * rag.service — Qdrant point-ID normalization.
 *
 * Qdrant only accepts unsigned-int or UUID point IDs. Product/knowledge code
 * passes human-readable documentIds ("product:<uuid>", "faq-42", "biz-<shopId>")
 * which Qdrant rejects with a 400 — and ingestData swallows that, so the upsert
 * silently never lands. These tests lock in the deterministic UUIDv5 mapping
 * that makes those upserts valid (and keeps deletes targeting the same point).
 */

process.env.NODE_ENV = 'test';
process.env.EMBEDDING_PROVIDER = 'local';
delete process.env.QDRANT_PER_TENANT;

jest.mock('src/config/config', () => ({ env: 'test' }));

const { validate: uuidValidate } = require('uuid');
const { createServer } = require('node:http');
const { once, getEventListeners } = require('node:events');
const {
    EMBEDDING_SPACE_MANIFEST_POINT_ID,
    createEmbeddingSpaceIdentity,
    createManifestPayload,
} = require('../embedding-space');

const localIdentity = createEmbeddingSpaceIdentity({
    provider: 'local',
    model: 'local-ngram',
    version: 'local-ngram-v1',
    dimensions: 384,
});
const manifestPayload = createManifestPayload({
    collection: 'knowledge_documents',
    identity: localIdentity,
    state: 'ACTIVE',
});

const calls = [];
const defaultFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const endpoint = String(url);
    if (endpoint.includes('/points/scroll')) {
        return {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ result: { points: [{ id: EMBEDDING_SPACE_MANIFEST_POINT_ID, payload: manifestPayload }] } }),
        };
    }
    if (/\/collections\/[^/]+$/.test(endpoint)) {
        return {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({ result: { config: { params: { vectors: { size: 384 } } } } }),
        };
    }
    // All remaining Qdrant calls "succeed": upsert, search, count, delete.
    return { ok: true, status: 200, text: async () => '', json: async () => ({ result: [] }) };
};
const transportFetch = global.fetch;
global.fetch = jest.fn(defaultFetch);

const rag = require('src/modules/rag/rag.service');

const upsertBody = () => {
    const c = calls.find(x => x.url.includes('/points?wait=true'));
    return c ? JSON.parse(c.init.body) : null;
};

beforeEach(() => {
    calls.length = 0;
    global.fetch.mockClear().mockImplementation(defaultFetch);
});

describe('Qdrant point-id normalization', () => {
    test('a non-UUID documentId is upserted under a valid UUID', async () => {
        const res = await rag.ingestData({
            text: 'Blue Cotton Shirt',
            metadata: { documentId: 'product:abc-123', shopId: 's1', type: 'product', product_id: 'abc-123' }
        });
        expect(res.success).toBe(true);

        const body = upsertBody();
        expect(body).toBeTruthy();
        const point = body.points[0];
        expect(uuidValidate(point.id)).toBe(true);
        // The human-readable documentId + product_id survive in the payload so
        // source references and live re-fetch (product_id) still work.
        expect(point.payload.documentId).toBe('product:abc-123');
        expect(point.payload.product_id).toBe('abc-123');
        expect(point.payload.embedding_provider).toBe('local');
        expect(point.payload.embedding_model).toBe('local-ngram');
        expect(point.payload.embedding_space_version).toBe('local-ngram-v1');
        expect(point.payload.embedding_dimensions).toBe(384);
        expect(point.payload.embedding_space_manifest).toBe(false);
    });

    test('the same documentId is deterministic, and delete targets that exact point', async () => {
        await rag.ingestData({ text: 'a', metadata: { documentId: 'faq-42', shopId: 's1' } });
        const upsertId = upsertBody().points[0].id;

        calls.length = 0;
        await rag.deletePoint('faq-42', 's1');
        const delCall = calls.find(c => c.url.includes('/points/delete'));
        const delBody = JSON.parse(delCall.init.body);
        expect(delBody.points[0]).toBe(upsertId);
    });

    test('an already-valid UUID documentId is preserved unchanged', async () => {
        const uuid = '11111111-2222-4333-8444-555555555555';
        await rag.ingestData({ text: 'x', metadata: { documentId: uuid, shopId: 's1' } });
        expect(upsertBody().points[0].id).toBe(uuid);
    });

    test('a provider transition cannot reuse the active collection for writes', async () => {
        const previousProvider = process.env.EMBEDDING_PROVIDER;
        process.env.EMBEDDING_PROVIDER = 'openai';
        try {
            const res = await rag.ingestData({
                text: 'provider transition must reindex',
                metadata: { documentId: 'transition-1', shopId: 's1', type: 'faq' },
            });
            expect(res.success).toBe(false);
            expect(res.message).toBe('EMBEDDING_SPACE_MISMATCH');
            expect(calls.some((call) => call.url.includes('/points?wait=true'))).toBe(false);
        } finally {
            if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
            else process.env.EMBEDDING_PROVIDER = previousProvider;
        }
    });

    test('queryData removes corrupt blank-payload hits from RAG answers', async () => {
        global.fetch.mockImplementation(async (url, init) => {
            calls.push({ url: String(url), init });
            if (String(url).includes('/points/search')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({
                        result: [
                            { score: 0.95, payload: { text: 'Delivery takes 2 days', type: 'faq' } },
                            { score: 0.90, payload: {} },
                            { score: 0.85, payload: { content: 'Legacy content payload', type: 'legacy' } },
                        ],
                    }),
                };
            }
            if (String(url).includes('/points/scroll')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({ result: { points: [{ id: EMBEDDING_SPACE_MANIFEST_POINT_ID, payload: manifestPayload }] } }),
                };
            }
            if (/\/collections\/[^/]+$/.test(String(url))) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '',
                    json: async () => ({ result: { config: { params: { vectors: { size: 384 } } } } }),
                };
            }
            return { ok: true, status: 200, text: async () => '', json: async () => ({ result: [] }) };
        });

        const res = await rag.queryData({ query: 'delivery', shopId: 's1', limit: 3 });
        const searchBody = JSON.parse(calls.find((call) => call.url.includes('/points/search')).init.body);

        expect(res.success).toBe(true);
        expect(searchBody.with_payload).toBe(true);
        expect(res.results.map((item) => item.content)).toEqual([
            'Delivery takes 2 days',
            'Legacy content payload',
        ]);
        expect(searchBody.filter.must_not).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'embedding_space_manifest' }),
        ]));
    });
});

describe('RAG query deadline', () => {
    const query = { query: 'delivery', shopId: 's1' };
    let server;

    afterEach(async () => {
        jest.useRealTimers();
        if (server) {
            const closed = once(server, 'close');
            server.close();
            server.closeAllConnections();
            await closed;
            server = undefined;
        }
    });

    const useLocalTransport = async (stallAt) => {
        const socketsClosed = [];
        server = createServer(async (req, res) => {
            if (req.url.endsWith(stallAt)) {
                res.once('close', () => socketsClosed.push(req.url));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write('{');
                return;
            }
            const response = await defaultFetch(req.url);
            res.end(JSON.stringify(await response.json()));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        global.fetch.mockImplementation((url, init) => transportFetch(
            `http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init,
        ));
        return socketsClosed;
    };

    test.each(['/knowledge_documents', '/points/scroll', '/points/search'])('deadline closes the response stream for %s', async (phase) => {
        const socketsClosed = await useLocalTransport(phase);
        await expect(rag.queryData(query, { timeoutMs: 600 })).rejects.toMatchObject({ name: 'TimeoutError' });
        const closeDeadline = Date.now() + 1500;
        while (!socketsClosed.length && Date.now() < closeDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
        expect(socketsClosed).toEqual([expect.stringMatching(new RegExp(`${phase}$`))]);
        const signals = global.fetch.mock.calls.map(([, init]) => init.signal);
        expect(new Set(signals).size).toBe(1);
    });

    test('cancellation does not mutate the caller reason or affect another query', async () => {
        const parent = new AbortController();
        const reason = Object.freeze(new Error('caller stopped'));
        let fetchEntered;
        const entered = new Promise((resolve) => { fetchEntered = resolve; });
        global.fetch.mockImplementationOnce((_, { signal }) => {
            fetchEntered();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        });
        const pending = rag.queryData(query, { signal: parent.signal });
        await entered;
        const concurrent = rag.queryData(query);
        parent.abort(reason);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect(concurrent).resolves.toMatchObject({ success: true });
        expect(parent.signal.reason).toBe(reason);
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    });

    test('successful completion detaches later cancellation', async () => {
        const parent = new AbortController();
        await expect(rag.queryData(query, { signal: parent.signal })).resolves.toMatchObject({ success: true });
        const [, { signal }] = global.fetch.mock.calls[0];
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
        parent.abort();
        expect(signal.aborted).toBe(false);
        const priorCalls = global.fetch.mock.calls.length;
        await expect(rag.queryData(query, { signal: parent.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(global.fetch).toHaveBeenCalledTimes(priorCalls);
    });

    test('a non-cooperative adapter cannot extend caller wait or start another phase after timeout', async () => {
        jest.useFakeTimers();
        global.fetch.mockClear();
        let finish;
        global.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const assertion = expect(rag.queryData(query, { timeoutMs: 25 })).rejects.toMatchObject({ name: 'TimeoutError' });
        await jest.advanceTimersByTimeAsync(25);
        await assertion;
        finish(await defaultFetch('/collections/knowledge_documents'));
        await jest.advanceTimersByTimeAsync(0);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('an embedding timeout aborts the provider request and prevents a later search', async () => {
        jest.useFakeTimers();
        const previousProvider = process.env.EMBEDDING_PROVIDER;
        const previousOpenAiKey = process.env.OPENAI_API_KEY;
        process.env.EMBEDDING_PROVIDER = 'openai';
        process.env.OPENAI_API_KEY = 'mock-only-embedding-key';

        let finishEmbedding;
        let embeddingSignal;
        let enterEmbedding;
        const embeddingEntered = new Promise((resolve) => { enterEmbedding = resolve; });
        let searchCalls = 0;
        const openAiIdentity = require('../embedding.service').getEmbeddingSpaceIdentity();
        const openAiManifest = createManifestPayload({
            collection: 'knowledge_documents',
            identity: openAiIdentity,
            state: 'ACTIVE',
        });

        global.fetch.mockImplementation((url, init = {}) => {
            const endpoint = String(url);
            calls.push({ url: endpoint, init });
            if (endpoint.includes('api.openai.com/v1/embeddings')) {
                embeddingSignal = init.signal;
                enterEmbedding();
                return new Promise((resolve) => {
                    finishEmbedding = () => resolve({
                        ok: true,
                        json: async () => ({ data: [{ embedding: new Array(openAiIdentity.dimensions).fill(0.1) }] }),
                    });
                });
            }
            if (endpoint.includes('/points/scroll')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ result: { points: [{ id: EMBEDDING_SPACE_MANIFEST_POINT_ID, payload: openAiManifest }] } }),
                });
            }
            if (/\/collections\/[^/]+$/.test(endpoint)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: async () => ({ result: { config: { params: { vectors: { size: openAiIdentity.dimensions } } } } }),
                });
            }
            if (endpoint.includes('/points/search')) searchCalls++;
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: [] }) });
        });

        try {
            const pending = rag.queryData(query, { timeoutMs: 25 });
            await embeddingEntered;
            const timeout = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
            await jest.advanceTimersByTimeAsync(25);
            await timeout;

            expect(embeddingSignal.aborted).toBe(true);
            finishEmbedding();
            await jest.advanceTimersByTimeAsync(0);
            expect(searchCalls).toBe(0);
        } finally {
            if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
            else process.env.EMBEDDING_PROVIDER = previousProvider;
            if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previousOpenAiKey;
        }
    });
});
