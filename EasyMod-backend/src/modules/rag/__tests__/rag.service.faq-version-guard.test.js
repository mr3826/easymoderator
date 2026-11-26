'use strict';

/**
 * FAQ version guard (20261126_001 lifecycle, A5): ingestData must refuse to
 * overwrite a Qdrant point whose stored payload faq_version is NEWER than the
 * incoming write, so a stale async sync can never clobber newer content.
 * A guard-READ failure must NOT block the ingest (availability wins — the
 * row's own latest sync re-converges the point). scrollShopPointsByType must
 * report {id, documentId, faqVersion} for the reconcile-prune, scoped to the
 * calling shop and one payload type.
 *
 * Harness mirrors rag.service.test.js: local provider (no network embeddings),
 * point-addressable Qdrant simulator over a fetch mock.
 */

process.env.NODE_ENV = 'test';
process.env.EMBEDDING_PROVIDER = 'local';
delete process.env.QDRANT_PER_TENANT;

jest.mock('src/config/config', () => ({ env: 'test' }));

const {
    EMBEDDING_SPACE_MANIFEST_FIELD,
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
const pointsById = new Map();
let failPointRetrieval = false;

// The manifest probe is the only scroll that filters ON the manifest field
// itself (and never carries the shopId term); content scrolls exclude the
// manifest via must_not, so they mention the field name too — key on shape.
const isManifestQuery = (body) => {
    let parsed;
    try { parsed = JSON.parse(String(body || '{}')); } catch { return false; }
    const must = parsed?.filter?.must || [];
    return must.some((t) => t.key === EMBEDDING_SPACE_MANIFEST_FIELD)
        && !must.some((t) => t.key === 'shopId');
};

const defaultFetch = async (url, init) => {
    const endpoint = String(url);
    calls.push({ url: endpoint, init, body: init?.body ? String(init.body) : '' });

    if (endpoint.includes('/points/scroll')) {
        // readCollectionBinding asks for the manifest; everything else is the
        // content scroll used by scrollShopPointsByType (simulated filter:
        // payload shopId + type must match, manifest never returned).
        if (init?.body && isManifestQuery(init.body)) {
            return jsonOk({ result: { points: [{ id: EMBEDDING_SPACE_MANIFEST_POINT_ID, payload: manifestPayload }] } });
        }
        const parsed = JSON.parse(String(init?.body || '{}'));
        const must = parsed?.filter?.must || [];
        const shopTerm = must.find((t) => String(JSON.stringify(t)).includes('"shopId"'));
        const typeTerm = must.find((t) => String(JSON.stringify(t)).includes('"type"'));
        const matched = [...pointsById.values()]
            .filter((point) => !point.payload?.[EMBEDDING_SPACE_MANIFEST_FIELD])
            .filter((point) => !shopTerm || String(point.payload?.shopId) === String(shopTerm.match?.value))
            .filter((point) => !typeTerm || String(point.payload?.type) === String(typeTerm.match?.value))
            .map((point) => ({ id: point.id, payload: point.payload }));
        return jsonOk({ result: { points: matched, next_page_offset: null } });
    }
    if (endpoint.includes('/points?wait=true') && init?.method === 'PUT') {
        for (const point of JSON.parse(init.body).points) pointsById.set(String(point.id), point);
        return jsonOk({ result: { acknowledged: true } });
    }
    if (endpoint.includes('/points/delete')) {
        for (const id of JSON.parse(init.body).points || []) pointsById.delete(String(id));
        return jsonOk({ result: { acknowledged: true } });
    }
    if (endpoint.endsWith('/points') && init?.method === 'POST') {
        if (failPointRetrieval) throw new Error('connection reset');
        const { ids = [], with_payload } = JSON.parse(init.body);
        const found = ids.map((id) => pointsById.get(String(id))).filter(Boolean)
            .map((point) => ({ id: point.id, payload: point.payload }));
        return jsonOk({ result: found });
    }
    if (/\/collections\/[^/]+$/.test(endpoint)) {
        return jsonOk({ result: { config: { params: { vectors: { size: 384 } } } } });
    }
    return jsonOk({ result: [] });
};
const jsonOk = (payload) => ({
    ok: true, status: 200, text: async () => '', json: async () => payload,
});

global.fetch = jest.fn(defaultFetch);

const rag = require('src/modules/rag/rag.service');

const upserts = () => calls.filter((c) => c.url.includes('/points?wait=true') && c.init?.method === 'PUT');

beforeEach(() => {
    calls.length = 0;
    pointsById.clear();
    failPointRetrieval = false;
    global.fetch.mockClear().mockImplementation(defaultFetch);
});

describe('rag.service — FAQ sync version guard', () => {
    test('refuses a stale upsert: stored faq_version NEWER than the incoming write', async () => {
        const pointId = rag.toScopedPointId('s1', 'faq-9');
        pointsById.set(String(pointId), {
            id: pointId,
            payload: { shopId: 's1', documentId: 'faq-9', type: 'faq', faq_id: 9, faq_version: 5 },
        });

        const res = await rag.ingestData({
            text: 'stale async content must never clobber',
            metadata: { documentId: 'faq-9', shopId: 's1', type: 'faq', faq_id: 9, faq_version: 2 },
        });

        expect(res).toEqual(expect.objectContaining({
            success: false, guarded: true, message: 'FAQ_VERSION_GUARDED',
        }));
        // The newer point is untouched — no upsert was attempted at all.
        expect(upserts()).toHaveLength(0);
        expect(pointsById.get(String(pointId)).payload.faq_version).toBe(5);
    });

    test('the guard read asks for exactly the ownership + version payload fields', async () => {
        const res = await rag.ingestData({
            text: 'fresh content',
            metadata: { documentId: 'faq-9', shopId: 's1', type: 'faq', faq_id: 9, faq_version: 1 },
        });
        expect(res.success).toBe(true);
        const guardRead = calls.find((c) => c.url.endsWith('/points') && c.init?.method === 'POST');
        expect(JSON.parse(guardRead.body).with_payload).toEqual(['shopId', 'faq_version']);
    });

    test('equal or newer incoming version upserts normally (no false guarding)', async () => {
        const pointId = rag.toScopedPointId('s1', 'faq-9');
        pointsById.set(String(pointId), {
            id: pointId,
            payload: { shopId: 's1', documentId: 'faq-9', type: 'faq', faq_id: 9, faq_version: 4 },
        });

        const res = await rag.ingestData({
            text: 'new save', metadata: { documentId: 'faq-9', shopId: 's1', type: 'faq', faq_id: 9, faq_version: 4 },
        });
        expect(res.success).toBe(true);
        const stored = pointsById.get(String(pointId));
        expect(stored.payload.text).toBe('new save');
        expect(stored.payload.faq_version).toBe(4);
    });

    test("a guard-read failure does NOT block the ingest (the row's own latest sync re-converges)", async () => {
        failPointRetrieval = true; // every POST /points retrieval throws

        const res = await rag.ingestData({
            text: 'proceed despite unknown stored version',
            metadata: { documentId: 'faq-9', shopId: 's1', type: 'faq', faq_id: 9, faq_version: 2 },
        });

        expect(res.success).toBe(true);
        expect(upserts().length).toBeGreaterThan(0);
    });

    test('points with no stored faq_version never trip the guard (legacy points)', async () => {
        const pointId = rag.toScopedPointId('s1', 'faq-9');
        pointsById.set(String(pointId), {
            id: pointId, payload: { shopId: 's1', documentId: 'faq-9', type: 'faq' },
        });

        const res = await rag.ingestData({
            text: 'first versioned write',
            metadata: { documentId: 'faq-9', shopId: 's1', type: 'faq', faq_id: 9, faq_version: 1 },
        });
        expect(res.success).toBe(true);
        expect(pointsById.get(String(pointId)).payload.faq_version).toBe(1);
    });

    test('non-FAQ documents without faq_version skip the guard read entirely', async () => {
        await rag.ingestData({
            text: 'business info vector',
            metadata: { documentId: 'biz-s1', shopId: 's1', type: 'business_info' },
        });
        // The FAQ version guard read is the retrieve asking for faq_version.
        // (The legacy-key convergence probe — with_payload ["shopId"] — is a
        // different read and stays for every document type.)
        const guardReads = calls.filter((c) => c.url.endsWith('/points')
            && c.init?.method === 'POST'
            && String(c.init.body).includes('faq_version'));
        expect(guardReads).toHaveLength(0);
        expect(upserts().length).toBeGreaterThan(0);
    });
});

describe('rag.service — scrollShopPointsByType (reconcile-prune feed)', () => {
    test('returns {id, documentId, faqVersion} for one type of the calling shop only', async () => {
        pointsById.set('faq-point', {
            id: 'faq-point',
            payload: { shopId: 's1', documentId: 'faq-9', type: 'faq', faq_version: 3 },
        });
        pointsById.set('other-faq-point', {
            id: 'other-faq-point',
            payload: { shopId: 'other-shop', documentId: 'faq-10', type: 'faq', faq_version: 7 },
        });
        pointsById.set('product-point', {
            id: 'product-point',
            payload: { shopId: 's1', documentId: 'product:p1', type: 'product' },
        });

        const faqPoints = await rag.scrollShopPointsByType('s1', 'faq');
        expect(faqPoints).toEqual([{ id: 'faq-point', documentId: 'faq-9', faqVersion: 3 }]);

        const productPoints = await rag.scrollShopPointsByType('s1', 'product');
        expect(productPoints).toEqual([{ id: 'product-point', documentId: 'product:p1', faqVersion: null }]);
    });
});
