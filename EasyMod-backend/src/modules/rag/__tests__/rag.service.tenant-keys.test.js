'use strict';

/**
 * W1 hardening — tenant-safe Qdrant point keys on the shared collection.
 *
 * Threat model (phase2 ledger W1 / CO10): FAQ documentIds embed the global
 * SERIAL primary key ("faq-<id>"). Normal ops cannot collide, but a
 * backup-restore sequence reset or a cross-environment import CAN hand the
 * same label to a second shop. Under the legacy keying (uuidv5(docId) alone)
 * the second shop's ingest would OVERWRITE the first shop's point, and either
 * shop's blind delete could wipe the other's data.
 *
 * These tests simulate exactly that restore collision against an in-memory
 * Qdrant that (like the real one) enforces one point per id:
 *   - two shops holding overlapping FAQ PKs → distinct scoped ids, no global
 *     overwrite, no cross-tenant answers through the search path;
 *   - deletes are ownership-checked: a foreign-owned legacy id is SKIPPED;
 *   - legacy points stay readable by the unchanged read path (vector search +
 *     shop must-filter, which never keys by point id).
 */

process.env.NODE_ENV = 'test';
process.env.EMBEDDING_PROVIDER = 'local';
delete process.env.QDRANT_PER_TENANT;

jest.mock('src/config/config', () => ({ env: 'test' }));

const { validate: uuidValidate } = require('uuid');
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

// In-memory collection: enforces the one-point-per-id invariant that makes an
// id collision an OVERWRITE in real Qdrant, honours payload shop must-filters,
// and lets deletes only ever see what retrieval proves is owned.
const collection = new Map();
const calls = [];

const seedPoint = ({ id, payload, vector }) => {
    collection.set(String(id), { id, payload, vector: vector || new Array(384).fill(0.01) });
};

const matchesShopFilter = (point, filter) => {
    const must = Array.isArray(filter?.must) ? filter.must : [];
    return must.every((clause) => {
        if (clause?.key === 'shopId' && clause?.match?.value !== undefined) {
            return String(point.payload?.shopId ?? '') === String(clause.match.value);
        }
        return true;
    });
};

const fetchSim = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const endpoint = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};

    if (endpoint.includes('/points/scroll')) {
        return { ok: true, status: 200, json: async () => ({ result: { points: [{ id: EMBEDDING_SPACE_MANIFEST_POINT_ID, payload: manifestPayload }], next_page_offset: null } }) };
    }
    if (/\/collections\/[^/]+$/.test(endpoint)) {
        return { ok: true, status: 200, json: async () => ({ result: { config: { params: { vectors: { size: 384 } } } } }) };
    }
    if (endpoint.includes('/points?wait=true') && init?.method === 'PUT') {
        for (const point of body.points || []) {
            collection.set(String(point.id), { id: point.id, payload: point.payload, vector: point.vector });
        }
        return { ok: true, status: 200, json: async () => ({ result: { acknowledged: true } }) };
    }
    if (endpoint.includes('/points/delete')) {
        for (const id of body.points || []) collection.delete(String(id));
        return { ok: true, status: 200, json: async () => ({ result: { acknowledged: true } }) };
    }
    if (endpoint.endsWith('/points') && init?.method === 'POST') {
        const found = (body.ids || [])
            .map((id) => collection.get(String(id)))
            .filter(Boolean)
            .map(({ id, payload }) => ({ id, payload }));
        return { ok: true, status: 200, json: async () => ({ result: found }) };
    }
    if (endpoint.includes('/points/search')) {
        const hits = [...collection.values()]
            .filter((point) => String(point.payload?.embedding_space_manifest) !== 'true')
            .filter((point) => matchesShopFilter(point, body.filter))
            .map((point, index) => ({ id: point.id, score: 1 - index * 0.01, payload: point.payload }));
        return { ok: true, status: 200, json: async () => ({ result: hits }) };
    }
    return { ok: true, status: 200, json: async () => ({ result: [] }) };
};

global.fetch = jest.fn(fetchSim);

const rag = require('src/modules/rag/rag.service');

const SHOP_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SHOP_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const LEGACY_FAQ7 = rag.toPointId('faq-7');
const SCOPED_A_FAQ7 = rag.toScopedPointId(SHOP_A, 'faq-7');
const SCOPED_B_FAQ7 = rag.toScopedPointId(SHOP_B, 'faq-7');

beforeEach(() => {
    collection.clear();
    calls.length = 0;
    global.fetch.mockClear().mockImplementation(fetchSim);
});

const deleteCalls = () => calls.filter((c) => c.url.includes('/points/delete')).map((c) => JSON.parse(c.init.body));

describe('tenant-scoped point keys', () => {
    test('scoped ids differ per shop and are still deterministic UUIDs', () => {
        expect(SCOPED_A_FAQ7).not.toBe(SCOPED_B_FAQ7);
        expect(SCOPED_A_FAQ7).not.toBe(LEGACY_FAQ7);
        expect(SCOPED_B_FAQ7).not.toBe(LEGACY_FAQ7);
        expect(uuidValidate(SCOPED_A_FAQ7)).toBe(true);
        expect(SCOPED_A_FAQ7).toBe(rag.toScopedPointId(SHOP_A, 'faq-7'));
        // A documentId that is already a valid UUID keeps its identity so
        // existing product points stay addressable.
        const uuidDoc = '11111111-2222-4333-8444-555555555555';
        expect(rag.toScopedPointId(SHOP_A, uuidDoc)).toBe(uuidDoc);
    });

    test('refuses to produce a scoped key without a shop', () => {
        expect(() => rag.toScopedPointId(null, 'faq-7')).toThrow('No shop selected');
    });
});

describe('W1 restore-collision scenario (two shops, overlapping FAQ PKs)', () => {
    test('shop B ingest of a reused label cannot overwrite shop A data', async () => {
        // Simulated restore sequence reset: shop A's FAQ 7 exists under the
        // legacy global key; shop B now receives label "faq-7" for its own FAQ.
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A delivery days: 2', type: 'faq' } });

        const res = await rag.ingestData({
            text: 'Shop B delivery days: 5',
            metadata: { documentId: 'faq-7', shopId: SHOP_B, type: 'faq' },
        });
        expect(res.success).toBe(true);
        expect(res.ingestionId).toBe(SCOPED_B_FAQ7);

        // The foreign legacy point SURVIVES untouched (A's text is intact)…
        expect(collection.get(String(LEGACY_FAQ7)).payload.text).toBe('Shop A delivery days: 2');
        // …and B lives at its own scoped key instead of clobbering anything.
        expect(collection.get(String(SCOPED_B_FAQ7)).payload.text).toBe('Shop B delivery days: 5');
        expect(deleteCalls().some((body) => (body.points || []).map(String).includes(String(LEGACY_FAQ7)))).toBe(false);
    });

    test('search never answers across tenants, and legacy points stay readable', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A answer', type: 'faq' } });
        await rag.ingestData({ text: 'Shop B answer', metadata: { documentId: 'faq-7', shopId: SHOP_B, type: 'faq' } });

        const queryA = await rag.queryData({ query: 'delivery', shopId: SHOP_A, limit: 5 });
        const queryB = await rag.queryData({ query: 'delivery', shopId: SHOP_B, limit: 5 });

        // Legacy id + unchanged read path (vector + shop must-filter) keeps A's
        // old point answerable without any reindex.
        expect(queryA.results.map((r) => r.content)).toEqual(['Shop A answer']);
        expect(queryB.results.map((r) => r.content)).toEqual(['Shop B answer']);

        const searchBody = JSON.parse(calls.find((c) => c.url.includes('/points/search')).init.body);
        expect(searchBody.filter.must).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'shopId', match: { value: SHOP_A } }),
        ]));
    });

    test('delete is ownership-checked: foreign legacy id survives, own point is removed', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A answer', type: 'faq' } });
        await rag.ingestData({ text: 'Shop B answer', metadata: { documentId: 'faq-7', shopId: SHOP_B, type: 'faq' } });
        calls.length = 0;

        await rag.deletePoint('faq-7', SHOP_B);

        expect(collection.has(String(SCOPED_B_FAQ7))).toBe(false);
        expect(collection.has(String(LEGACY_FAQ7))).toBe(true); // still A's — untouched

        // A's own delete now removes its legacy point too (ownership proven).
        await rag.deletePoint('faq-7', SHOP_A);
        expect(collection.has(String(LEGACY_FAQ7))).toBe(false);
    });

    test('delete with no owned point is a no-op (never a blind ids delete)', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A answer' } });
        const res = await rag.deletePoint('faq-7', SHOP_B);
        expect(res.result.deleted).toBe(0);
        expect(deleteCalls()).toHaveLength(0);
        expect(collection.has(String(LEGACY_FAQ7))).toBe(true);
    });

    test('re-ingest by the owning shop converges the legacy key to the scoped key', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A old answer', type: 'faq' } });

        await rag.ingestData({
            text: 'Shop A new answer',
            metadata: { documentId: 'faq-7', shopId: SHOP_A, type: 'faq' },
        });

        // New text lives at the scoped key; the shop-owned legacy copy is
        // pruned, so the shop never answers twice from duplicated keys.
        expect(collection.get(String(SCOPED_A_FAQ7)).payload.text).toBe('Shop A new answer');
        expect(collection.has(String(LEGACY_FAQ7))).toBe(false);

        const queryA = await rag.queryData({ query: 'delivery', shopId: SHOP_A, limit: 5 });
        expect(queryA.results.map((r) => r.content)).toEqual(['Shop A new answer']);
    });

    test('ingest payload always carries shopId + documentId for migration and isolation', async () => {
        await rag.ingestData({ text: 'plain', metadata: { documentId: 'faq-9', shopId: SHOP_A } });
        const point = collection.get(String(rag.toScopedPointId(SHOP_A, 'faq-9')));
        expect(point.payload.shopId).toBe(SHOP_A);
        expect(point.payload.documentId).toBe('faq-9');
    });
});

describe('F1 (A9 BLOCK) — passthrough point-id takeover rejected', () => {
    // A9 executed this attack against the pre-fix code (ATTACK_SUCCEEDED true):
    // POST /api/rag/ingest with metadata.documentId set to the victim's
    // deterministic legacy id, which the UUID-passthrough branch mapped
    // verbatim to the victim's point id and rewrote payload.shopId.
    test('shop B cannot overwrite shop A legacy point by submitting its UUID', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'Shop A private answer', type: 'faq' } });

        await expect(rag.ingestData({
            text: 'Shop B malicious content',
            metadata: { documentId: LEGACY_FAQ7, shopId: SHOP_B, type: 'faq' },
        })).rejects.toMatchObject({ status: 400, code: 'CROSS_TENANT_DOCUMENT_ID' });

        // Victim point byte-identical: neither content nor ownership moved.
        expect(collection.get(String(LEGACY_FAQ7)).payload.text).toBe('Shop A private answer');
        expect(collection.get(String(LEGACY_FAQ7)).payload.shopId).toBe(SHOP_A);
        // No upsert was ever issued for the victim id.
        const puts = calls.filter((c) => c.url.includes('/points?wait=true'));
        expect(puts.some((c) => JSON.parse(c.init.body).points.some((p) => String(p.id) === String(LEGACY_FAQ7)))).toBe(false);
    });

    test('the owner may still rewrite its own UUID-keyed point', async () => {
        seedPoint({ id: LEGACY_FAQ7, payload: { shopId: SHOP_A, documentId: 'faq-7', text: 'old' } });
        const res = await rag.ingestData({ text: 'new', metadata: { documentId: LEGACY_FAQ7, shopId: SHOP_A } });
        expect(res.success).toBe(true);
        expect(collection.get(String(LEGACY_FAQ7)).payload.text).toBe('new');
    });

    test('an absent UUID documentId still passes through unchanged (compat path)', async () => {
        const fresh = '99999999-9999-4999-8999-999999999999';
        const res = await rag.ingestData({ text: 'new doc', metadata: { documentId: fresh, shopId: SHOP_B } });
        expect(res.success).toBe(true);
        expect(res.ingestionId).toBe(fresh);
    });

    test('a caller-owned legacy-scoped collision cannot be hijacked via delete either', async () => {
        // B owns faq-7 at its scoped key; A submits the same UUID docId that
        // equals B's scoped key → refused; B's data intact.
        await rag.ingestData({ text: 'B answer', metadata: { documentId: 'faq-7', shopId: SHOP_B } });
        await expect(rag.ingestData({
            text: 'A hijack',
            metadata: { documentId: SCOPED_B_FAQ7, shopId: SHOP_A },
        })).rejects.toMatchObject({ status: 400, code: 'CROSS_TENANT_DOCUMENT_ID' });
        expect(collection.get(String(SCOPED_B_FAQ7)).payload.text).toBe('B answer');
    });
});

describe('QDRANT_PER_TENANT interaction', () => {
    test('per-tenant mode keeps per-shop collections; scoped keys stay deterministic', () => {
        // Module-level config capture — load a fresh copy with the flag on.
        let perTenantRag;
        jest.isolateModules(() => {
            process.env.QDRANT_PER_TENANT = 'true';
            perTenantRag = require('src/modules/rag/rag.service');
        });
        delete process.env.QDRANT_PER_TENANT;

        expect(perTenantRag.resolveCollectionName(SHOP_A)).toBe(`knowledge_documents_${SHOP_A}`);
        // Keying is identical within each collection — defence-in-depth does
        // not change ids the shared-mode path would compute.
        expect(perTenantRag.toScopedPointId(SHOP_A, 'faq-7')).toBe(SCOPED_A_FAQ7);
        expect(() => perTenantRag.resolveCollectionName(null)).toThrow('No shop selected');
    });
});
