'use strict';

const crypto = require('crypto');
const { v5: uuidv5, validate: uuidValidate } = require('uuid');

const {
    getEmbeddingResult,
    getEmbeddingSpaceIdentity,
} = require('./embedding.service');
const {
    EMBEDDING_SPACE_MANIFEST_FIELD,
    EMBEDDING_SPACE_MANIFEST_POINT_ID,
    EMBEDDING_SPACE_STATES,
    assertEmbeddingSpaceCompatible,
    assertCollectionState,
    assertStateTransition,
    createManifestPayload,
    createManifestVector,
    identityFromPayload,
    identityToPayload,
    isQueryableState,
    isWritableState,
} = require('./embedding-space');

const config = require('../../config/config');
const { normalizeQdrantUrl } = require('../../config/url-normalizer');
const { AppError } = require('../../utils/AppError');

// Vector store: Qdrant only (Pinecone removed 2026-05-31 — one vector store).
// Qdrant REST API uses paths without a /v1/ prefix (both old and current versions).
const qdrantUrl = process.env.QDRANT_URL
    ? normalizeQdrantUrl(process.env.QDRANT_URL)
    : 'http://localhost:6333';
const qdrantCollection = process.env.QDRANT_COLLECTION || 'knowledge_documents';
const qdrantFallbackCollection = String(process.env.QDRANT_FALLBACK_COLLECTION || '').trim() || null;
const qdrantApiKey = process.env.QDRANT_API_KEY;
const perTenantMode = process.env.QDRANT_PER_TENANT === 'true';
const DEFAULT_QUERY_TIMEOUT_MS = 8000;
const configuredQueryTimeoutMs = Number(process.env.RAG_QUERY_TIMEOUT_MS);
const RAG_QUERY_TIMEOUT_MS = Number.isSafeInteger(configuredQueryTimeoutMs)
    && configuredQueryTimeoutMs > 0 && configuredQueryTimeoutMs <= 2 ** 31 - 1
    ? configuredQueryTimeoutMs : DEFAULT_QUERY_TIMEOUT_MS;

// RAG collections contain merchant-domain data, not Growth OS administration data.
// Every service path must have a selected merchant shop before touching Qdrant.
const requireShopId = (shopId) => {
    if (!shopId) throw new AppError('No shop selected. Please login again.', 400);
    return shopId;
};

if ((config.env === 'production' || config.env === 'staging') && qdrantUrl && qdrantUrl.includes('6333') && !qdrantApiKey) {
    console.warn('⚠️  QDRANT_API_KEY should be set when using Qdrant in production. Run Qdrant on VPC-internal IP only.');
}

const normalizeText = (text) => (text || '').toString().trim();

// Qdrant ONLY accepts unsigned-integer or UUID point IDs. Human-readable
// document IDs are retained in payloads but mapped to deterministic UUIDs.
//
// W1 hardening (tenant-safe keying): the legacy scheme keyed a point by
// uuidv5(documentId) ALONE. FAQ documentIds embed the global SERIAL PK
// ("faq-<id>"), so a backup-restore sequence reset or a cross-environment
// import can hand the same "faq-<id>" label to a different shop — the new
// shop's upsert would then silently OVERWRITE the old shop's vector point,
// and a delete by that id could wipe another tenant's data. New writes are
// keyed by uuidv5(`shop:<shopId>:<documentId>`) so the same document label
// can never collide across shops.
//
//   - toPointId stays exported UNCHANGED for legacy compatibility: existing
//     points keep their old ids and stay readable by the vector+shop-filter
//     search path (search never keys by point id). The tenant key-migration
//     script (src/scripts/migrate-qdrant-tenant-keys.js) and the delete path
//     both use it to find legacy points.
//   - ingestData writes the scoped id and best-effort prunes the shop-owned
//     legacy point, so documents converge to the new scheme on next touch
//     without any collection drop/recreate.
//   - deletePoint resolves BOTH candidate ids and deletes only points whose
//     payload shopId matches the caller's shop — a colliding legacy id owned
//     by another tenant is skipped, never overwritten or deleted.
//   - In QDRANT_PER_TENANT=true mode the collection itself is per shop; the
//     scoped id adds defence-in-depth without changing behaviour (ids stay
//     deterministic within the shop's own collection).
const POINT_ID_NAMESPACE = '5f6c1f1e-6b2a-4c3d-8e7f-0a1b2c3d4e5f';
const toPointId = (documentId) => {
    if (!documentId) return crypto.randomUUID();
    const id = String(documentId);
    return uuidValidate(id) ? id : uuidv5(id, POINT_ID_NAMESPACE);
};

/**
 * Tenant-safe point id: uuidv5("shop:<shopId>:<documentId>").
 * A documentId that is already a valid UUID is kept verbatim (globally unique
 * by construction; re-keying it would orphan existing points for no gain).
 * Throws (400) when shopId is missing — refusing to key unscoped is the point.
 */
const toScopedPointId = (shopId, documentId) => {
    if (!documentId) return crypto.randomUUID();
    const id = String(documentId);
    if (uuidValidate(id)) return id;
    const scopedShopId = requireShopId(shopId);
    return uuidv5(`shop:${scopedShopId}:${id}`, POINT_ID_NAMESPACE);
};

const resolveCollectionName = (shopId, baseCollection = qdrantCollection) => {
    const scopedShopId = requireShopId(shopId);
    if (perTenantMode) return `${baseCollection}_${scopedShopId}`;
    return baseCollection;
};

const getQdrantHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (qdrantApiKey) headers['api-key'] = qdrantApiKey;
    return headers;
};

const qdrantPath = (collection, suffix = '') =>
    `${qdrantUrl}/collections/${encodeURIComponent(collection)}${suffix}`;

const qdrantJson = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const response = await fetch(url, {
        ...init,
        headers: { ...getQdrantHeaders(), ...(init.headers || {}) },
        signal: init.signal,
    });
    if (!response.ok) throw new Error(`Qdrant HTTP ${response.status}`);
    return response.json();
};

const extractVectorSize = (info) => {
    const vectors = info?.result?.config?.params?.vectors || info?.config?.params?.vectors;
    if (Number.isInteger(vectors?.size)) return vectors.size;
    if (Number.isInteger(vectors?.default?.size)) return vectors.default.size;
    if (vectors && typeof vectors === 'object') {
        const first = Object.values(vectors).find((value) => Number.isInteger(value?.size));
        if (first) return first.size;
    }
    return null;
};

const readCollectionInfo = async (collection, { signal } = {}) => {
    signal?.throwIfAborted();
    const response = await fetch(qdrantPath(collection), { headers: getQdrantHeaders(), signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Qdrant collection check failed: HTTP ${response.status}`);
    return response.json();
};

const manifestFilter = {
    must: [{ key: EMBEDDING_SPACE_MANIFEST_FIELD, match: { value: true } }],
};

const contentFilter = (filter = null) => {
    if (!filter) return {
        must_not: [{ key: EMBEDDING_SPACE_MANIFEST_FIELD, match: { value: true } }],
    };

    return {
        ...filter,
        must_not: [
            ...(Array.isArray(filter.must_not) ? filter.must_not : []),
            { key: EMBEDDING_SPACE_MANIFEST_FIELD, match: { value: true } },
        ],
    };
};

const readCollectionBinding = async (collection, { signal } = {}) => {
    const info = await readCollectionInfo(collection, { signal });
    if (!info) {
        const error = new Error(`Qdrant collection is unavailable: ${collection}`);
        error.name = 'EmbeddingCollectionUnavailableError';
        error.code = 'EMBEDDING_COLLECTION_UNAVAILABLE';
        throw error;
    }

    const manifestResult = await qdrantJson(qdrantPath(collection, '/points/scroll'), {
        method: 'POST',
        body: JSON.stringify({
            filter: manifestFilter,
            limit: 1,
            with_payload: true,
            with_vector: false,
        }),
        signal,
    });
    const manifestPoint = manifestResult?.result?.points?.[0];
    const identity = identityFromPayload(manifestPoint?.payload);
    if (!identity || manifestPoint?.payload?.embedding_collection !== collection) {
        const error = new Error(`Qdrant collection has no trusted embedding-space binding: ${collection}`);
        error.name = 'EmbeddingCollectionIdentityUnknownError';
        error.code = 'EMBEDDING_COLLECTION_IDENTITY_UNKNOWN';
        throw error;
    }

    const state = manifestPoint.payload.embedding_collection_state;
    assertCollectionState(state);
    const collectionSize = extractVectorSize(info);
    if (collectionSize !== identity.dimensions) {
        const error = new Error(`Qdrant collection dimension does not match its embedding-space binding: ${collection}`);
        error.name = 'EmbeddingCollectionDimensionMismatchError';
        error.code = 'EMBEDDING_COLLECTION_DIMENSION_MISMATCH';
        throw error;
    }

    return {
        collection,
        identity,
        state,
        manifestPointId: manifestPoint.id || EMBEDDING_SPACE_MANIFEST_POINT_ID,
        vectorSize: collectionSize,
    };
};

const createCollection = async (collection, identity, { signal } = {}) => {
    const response = await fetch(qdrantPath(collection), {
        method: 'PUT',
        headers: getQdrantHeaders(),
        body: JSON.stringify({
            vectors: { size: identity.dimensions, distance: 'Cosine' },
        }),
        signal,
    });
    if (!response.ok && response.status !== 409) {
        throw new Error(`Failed to create Qdrant collection: HTTP ${response.status}`);
    }

    if (response.status === 409) return readCollectionBinding(collection, { signal });

    const manifest = createManifestPayload({
        collection,
        identity,
        state: EMBEDDING_SPACE_STATES.BUILDING,
    });
    await qdrantJson(qdrantPath(collection, '/points?wait=true'), {
        method: 'PUT',
        body: JSON.stringify({
            points: [{
                id: EMBEDDING_SPACE_MANIFEST_POINT_ID,
                vector: createManifestVector(identity.dimensions),
                payload: manifest,
            }],
        }),
    });

    return readCollectionBinding(collection);
};

const ensureCollection = async (
    shopId,
    { baseCollection = qdrantCollection, allowCreate = false, forQuery = false, requestedIdentity = null, signal } = {},
) => {
    const collection = resolveCollectionName(shopId, baseCollection);
    const desiredIdentity = requestedIdentity || getEmbeddingSpaceIdentity();
    const info = await readCollectionInfo(collection, { signal });

    let binding;
    if (!info) {
        if (!allowCreate) {
            const error = new Error(`Qdrant collection is unavailable: ${collection}`);
            error.name = 'EmbeddingCollectionUnavailableError';
            error.code = 'EMBEDDING_COLLECTION_UNAVAILABLE';
            throw error;
        }
        binding = await createCollection(collection, desiredIdentity, { signal });
    } else {
        binding = await readCollectionBinding(collection, { signal });
    }

    if (requestedIdentity) assertEmbeddingSpaceCompatible(binding.identity, requestedIdentity, 'collection');
    if (forQuery && !isQueryableState(binding.state)) {
        const error = new Error(`Qdrant collection is not READY for retrieval: ${collection}`);
        error.name = 'EmbeddingCollectionNotReadyError';
        error.code = 'EMBEDDING_COLLECTION_NOT_READY';
        throw error;
    }
    if (!forQuery && !isWritableState(binding.state)) {
        const error = new Error(`Qdrant collection is not writable in state ${binding.state}: ${collection}`);
        error.name = 'EmbeddingCollectionNotWritableError';
        error.code = 'EMBEDDING_COLLECTION_NOT_WRITABLE';
        throw error;
    }

    return binding;
};

const setCollectionState = async (collection, state, { signal } = {}) => {
    const binding = await readCollectionBinding(collection, { signal });
    assertStateTransition(binding.state, state);
    if (binding.state === state) return binding;

    await qdrantJson(qdrantPath(collection, '/points/payload?wait=true'), {
        method: 'POST',
        body: JSON.stringify({
            payload: { embedding_collection_state: state },
            points: [binding.manifestPointId],
        }),
    });
    return readCollectionBinding(collection);
};

const buildShopFilter = (shopId, extraFilters) => {
    const scopedShopId = requireShopId(shopId);

    const shopFilter = {
        must: [{ key: 'shopId', match: { value: scopedShopId } }],
    };

    if (!extraFilters) return shopFilter;
    if (extraFilters.must || extraFilters.should || extraFilters.must_not) {
        return {
            ...extraFilters,
            must: [...(extraFilters.must || []), ...shopFilter.must],
        };
    }

    return { must: [shopFilter, extraFilters] };
};

/**
 * Retrieve existing points by id. Used by the ownership-checked delete path,
 * by the ingest cross-tenant guard, and by the FAQ version guard. A point that
 * does not exist is simply absent from the result. `payloadFields` defaults to
 * the ownership projection; the FAQ version guard adds 'faq_version'.
 */
const retrievePoints = async (collection, ids, { signal, payloadFields = ['shopId'] } = {}) => {
    const unique = [...new Set((ids || []).filter(Boolean).map(String))];
    if (!unique.length) return [];
    const result = await qdrantJson(qdrantPath(collection, '/points'), {
        method: 'POST',
        body: JSON.stringify({
            ids: unique,
            with_payload: payloadFields,
            with_vector: false,
        }),
        signal,
    });
    return result?.result || [];
};

/**
 * Retrieve candidate point ids and return only those that belong to `shopId`
 * (payload shopId match). Points that do not exist, or exist under a
 * different tenant after an id collision, are excluded — the caller must
 * never act on them. Missing/unreadable points are simply not returned.
 */
const findOwnedPointIds = async (collection, candidateIds, shopId, { signal } = {}) => {
    const scopedShopId = requireShopId(shopId);
    const shopKey = String(scopedShopId);
    const found = await retrievePoints(collection, candidateIds, { signal });
    return found
        .filter((point) => String(point?.payload?.shopId ?? '') === shopKey)
        .map((point) => point.id);
};

/**
 * F1 (A9 adversarial review): a UUID-shaped documentId keeps its value as the
 * point id, which hands the CALLER arbitrary point-id selection. Legacy ids
 * are deterministic (uuidv5("faq-<N>")), so a malicious authenticated shop
 * could compute another shop's legacy point id and POST it as its own
 * documentId to overwrite that tenant's vector+payload. Before any upsert onto
 * a passthrough id, verify the point does not exist or belongs to this shop.
 */
const CROSS_TENANT_DOCUMENT_ID = 'CROSS_TENANT_DOCUMENT_ID';
const assertPassthroughOwnership = async (binding, pointId, shopId) => {
    const found = await retrievePoints(binding.collection, [pointId]);
    const existing = found.find((point) => String(point?.id) === String(pointId));
    if (existing && String(existing?.payload?.shopId ?? '') !== String(shopId)) {
        throw new AppError(
            'This document id belongs to another shop.',
            400,
            CROSS_TENANT_DOCUMENT_ID,
        );
    }
};

const upsertPoint = async ({ id, vector, identity, payload, binding, signal }) => {
    assertEmbeddingSpaceCompatible(binding.identity, identity, 'document');
    return qdrantJson(qdrantPath(binding.collection, '/points?wait=true'), {
        method: 'PUT',
        body: JSON.stringify({
            points: [{
                id,
                vector,
                payload: {
                    ...payload,
                    ...identityToPayload(identity),
                    [EMBEDDING_SPACE_MANIFEST_FIELD]: false,
                },
            }],
        }),
        signal,
    });
};

const searchPoints = async ({ vector, identity, limit = 5, filter, binding, signal }) => {
    assertEmbeddingSpaceCompatible(binding.identity, identity, 'query');
    const result = await qdrantJson(qdrantPath(binding.collection, '/points/search'), {
        method: 'POST',
        body: JSON.stringify({
            vector,
            limit,
            with_payload: true,
            filter: contentFilter(filter),
        }),
        signal,
    });
    return result.result || [];
};

const embeddingTitle = (metadata = {}) => metadata.embeddingTitle
    || metadata.title
    || metadata.product_name
    || null;

const ingestData = async ({ text, metadata = {} }) => {
    const content = normalizeText(text);
    if (!content) throw new Error('No text provided for ingestion');

    const shopId = requireShopId(metadata.shopId);

    try {
        // Writes follow the configured provider identity. A provider/model/
        // input-contract change therefore fails against the old collection
        // instead of silently reusing it; reindex into a new target first.
        const configuredIdentity = getEmbeddingSpaceIdentity();
        const binding = await ensureCollection(shopId, {
            allowCreate: true,
            requestedIdentity: configuredIdentity,
        });
        const pointId = toScopedPointId(shopId, metadata.documentId);
        // F1 (A9): a UUID-shaped documentId maps verbatim to a point id, so the
        // caller controls point identity. Only proceed when the target does not
        // exist or is owned by this shop — otherwise another tenant's FAQ point
        // could be overwritten through POST /api/rag/ingest. Checked BEFORE
        // embedding spend so rejected attempts cost nothing.
        if (metadata.documentId && uuidValidate(String(metadata.documentId))) {
            await assertPassthroughOwnership(binding, pointId, shopId);
        }

        // FAQ version guard (20261126_001 lifecycle): when the caller carries a
        // sync version (knowledge.service writes faq_version into the point
        // payload), refuse to overwrite a point whose stored faq_version is
        // NEWER than this write — a stale async sync can never clobber newer
        // content. Checked BEFORE embedding spend, like the F1 passthrough
        // guard. A guard-read failure is treated as "unknown" and does not
        // block the ingest: the row's own latest async sync re-converges the
        // point (idempotent upsert on the scoped documentId), so availability
        // wins over a best-effort safety read.
        if (Number.isSafeInteger(metadata.faq_version) && metadata.documentId) {
            let storedVersion = null;
            try {
                const existing = await retrievePoints(binding.collection, [pointId], {
                    payloadFields: ['shopId', 'faq_version'],
                });
                const existingPoint = existing.find((point) => String(point?.id) === String(pointId));
                if (existingPoint && String(existingPoint?.payload?.shopId ?? '') === String(shopId)
                    && Number.isSafeInteger(existingPoint?.payload?.faq_version)) {
                    storedVersion = existingPoint.payload.faq_version;
                }
            } catch (_) {
                storedVersion = null;
            }
            if (storedVersion !== null && storedVersion > metadata.faq_version) {
                return {
                    success: false,
                    guarded: true,
                    message: 'FAQ_VERSION_GUARDED',
                    ingestionId: pointId,
                    documentId: metadata.documentId,
                };
            }
        }

        const embedding = await getEmbeddingResult(content, {
            identity: binding.identity,
            purpose: 'document',
            title: embeddingTitle(metadata),
        });

        await upsertPoint({
            id: pointId,
            vector: embedding.vector,
            identity: embedding.identity,
            binding,
            // documentId + shopId are always present in the payload so legacy
            // points stay identifiable for the key migration and deletes.
            payload: { text: content, ...metadata, shopId, documentId: metadata.documentId ?? null },
        });

        // Converge legacy keys: best-effort removal of the old shop-agnostic
        // point for the SAME document (only if it belongs to this shop). A
        // collision owned by another tenant is skipped — never deleted here.
        if (metadata.documentId) {
            try {
                const legacyId = toPointId(metadata.documentId);
                if (legacyId !== pointId) {
                    const owned = await findOwnedPointIds(binding.collection, [legacyId], shopId);
                    if (owned.length) {
                        await qdrantJson(qdrantPath(binding.collection, '/points/delete?wait=true'), {
                            method: 'POST',
                            body: JSON.stringify({ points: owned }),
                        });
                    }
                }
            } catch (_) {
                // Duplicate legacy copies are harmless (same text) and will be
                // reaped by the key-migration script; ingestion must not fail.
            }
        }

        return {
            success: true,
            message: 'Data ingested successfully',
            ingestionId: pointId,
            documentId: metadata.documentId || null,
            embeddingSpace: binding.identity,
        };
    } catch (error) {
        // The cross-tenant passthrough rejection is a client error (400), not a
        // degraded-unavailable case — surface it to the caller instead of
        // swallowing it into { success: false }.
        if (error?.code === CROSS_TENANT_DOCUMENT_ID) throw error;
        console.warn('RAG ingestion skipped (service unavailable):', error.code || error.name || 'EmbeddingError');
        return {
            success: false,
            message: error.code || 'RAG service unavailable',
            ingestionId: null,
        };
    }
};

const searchWithBinding = async ({ embedding, limit, filter, binding, signal }) => {
    const results = await searchPoints({
        vector: embedding.vector,
        identity: embedding.identity,
        limit,
        filter,
        binding,
        signal,
    });
    return {
        success: true,
        provider: 'qdrant',
        collection: binding.collection,
        embeddingSpace: binding.identity,
        results: results
            .map((item) => ({
                content: normalizeText(item.payload?.text || item.payload?.content || ''),
                score: item.score,
                metadata: item.payload || {},
            }))
        .filter((item) => item.content),
    };
};

const embedQueryForBinding = (content, binding, { signal } = {}) => getEmbeddingResult(content, {
    identity: binding.identity,
    purpose: 'query',
    signal,
});

const queryData = async ({ query, limit = 5, filters, shopId }, { timeoutMs = RAG_QUERY_TIMEOUT_MS, signal: parentSignal } = {}) => {
    const scopedShopId = requireShopId(shopId);
    const content = normalizeText(query);
    if (!content) throw new Error('Query text is required');

    const controller = new AbortController();
    const { signal } = controller;
    const abort = () => controller.abort(new DOMException('RAG query cancelled', 'AbortError'));
    if (parentSignal?.aborted) abort();
    signal.throwIfAborted();
    parentSignal?.addEventListener('abort', abort, { once: true });

    const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, RAG_QUERY_TIMEOUT_MS) : RAG_QUERY_TIMEOUT_MS;
    const timer = setTimeout(() => {
        controller.abort(new DOMException('RAG query deadline exceeded', 'TimeoutError'));
    }, budget);
    let rejectOnAbort;
    const cancelled = new Promise((_, reject) => {
        rejectOnAbort = () => reject(signal.reason);
        signal.addEventListener('abort', rejectOnAbort, { once: true });
    });

    const retrieve = async () => {
        const primaryBinding = await ensureCollection(scopedShopId, { forQuery: true, allowCreate: false, signal });
        const searchFilter = perTenantMode ? filters : buildShopFilter(scopedShopId, filters);

        let primaryEmbedding;
        try {
            signal.throwIfAborted();
            primaryEmbedding = await embedQueryForBinding(content, primaryBinding, { signal });
        } catch (error) {
            // Only query embedding failure may trigger collection-level fallback. A
            // Qdrant search failure is never converted into a provider switch.
            signal.throwIfAborted();
            if (primaryBinding.identity.provider !== 'gemini' || error.code === 'EMBEDDING_SPACE_MISMATCH') throw error;
            if (!qdrantFallbackCollection) {
                const controlled = new Error('Gemini query embedding unavailable and no READY OpenAI collection is configured');
                controlled.name = 'EmbeddingFallbackCollectionUnavailableError';
                controlled.code = 'EMBEDDING_FALLBACK_COLLECTION_UNAVAILABLE';
                throw controlled;
            }

            const fallbackBinding = await ensureCollection(scopedShopId, {
                baseCollection: qdrantFallbackCollection,
                forQuery: true,
                allowCreate: false,
                signal,
            });
            signal.throwIfAborted();
            if (fallbackBinding.identity.provider !== 'openai') {
                const invalid = new Error('configured embedding fallback collection is not OpenAI-bound');
                invalid.name = 'EmbeddingFallbackCollectionMismatchError';
                invalid.code = 'EMBEDDING_FALLBACK_COLLECTION_MISMATCH';
                throw invalid;
            }

            console.warn('Embedding collection fallback: gemini -> ready openai collection');
            const fallbackEmbedding = await embedQueryForBinding(content, fallbackBinding, { signal });
            return searchWithBinding({
                embedding: fallbackEmbedding,
                limit,
                filter: searchFilter,
                binding: fallbackBinding,
                signal,
            });
        }

        return searchWithBinding({
            embedding: primaryEmbedding,
            limit,
            filter: searchFilter,
            binding: primaryBinding,
            signal,
        });
    };

    try {
        // Fetch receives the signal; the race also bounds the caller if an adapter ignores it.
        const result = await Promise.race([retrieve(), cancelled]);
        signal.throwIfAborted();
        return result;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', rejectOnAbort);
        parentSignal?.removeEventListener('abort', abort);
    }
};

// W1: a delete must only ever touch the CALLING shop's points. The legacy
// scheme could map a reused document label onto another tenant's point (id
// collision after a restore/sequence reset), so deletes now resolve the
// legacy + tenant-scoped candidate ids, verify ownership via the payload
// shopId, and delete only the owned subset.
const deletePoint = async (id, shopId) => {
    const scopedShopId = requireShopId(shopId);
    const binding = await ensureCollection(scopedShopId, { allowCreate: false });
    const candidateIds = [...new Set([toPointId(id), toScopedPointId(scopedShopId, id)])];
    const ownedIds = await findOwnedPointIds(binding.collection, candidateIds, scopedShopId);
    if (!ownedIds.length) {
        // Nothing owned by this shop under any of the candidate ids — an
        // unowned match (legacy collision) is deliberately SKIPPED, never
        // deleted, so no tenant can remove another tenant's data.
        return { result: { acknowledged: true, operation_id: null, deleted: 0, skippedForeignIds: candidateIds.length } };
    }
    return qdrantJson(qdrantPath(binding.collection, '/points/delete?wait=true'), {
        method: 'POST',
        body: JSON.stringify({ points: ownedIds }),
    });
};

/**
 * Scroll the CALLING shop's non-manifest points of one payload `type`
 * ('faq' | 'business_info' | 'product'), returning {id, documentId,
 * faqVersion} per point. Tenant scoping is the payload shopId match
 * (defence-in-depth: in QDRANT_PER_TENANT mode the collection is already
 * shop-scoped). Used by the reindex reconcile-prune to find FAQ points whose
 * source row is gone/ineligible OR whose stored faq_version trails the row's
 * sync_version (stale vector content must not survive a reindex).
 */
const scrollShopPointsByType = async (shopId, type, { pageSize = 100, signal } = {}) => {
    const scopedShopId = requireShopId(shopId);
    const binding = await ensureCollection(scopedShopId, { allowCreate: false });
    const filter = contentFilter({
        must: [
            ...buildShopFilter(scopedShopId).must,
            { key: 'type', match: { value: String(type) } },
        ],
    });
    const points = [];
    let offset = null;
    for (;;) {
        const result = await qdrantJson(qdrantPath(binding.collection, '/points/scroll'), {
            method: 'POST',
            body: JSON.stringify({
                filter,
                limit: pageSize,
                offset,
                with_payload: ['documentId', 'faq_version'],
                with_vector: false,
            }),
            signal,
        });
        const page = result?.result?.points || [];
        for (const point of page) {
            points.push({
                id: point.id,
                documentId: point?.payload?.documentId ?? null,
                faqVersion: Number.isSafeInteger(point?.payload?.faq_version)
                    ? point.payload.faq_version
                    : null,
            });
        }
        offset = result?.result?.next_page_offset ?? null;
        if (!offset || !page.length) break;
    }
    return points;
};

module.exports = {
    ingestData,
    queryData,
    deletePoint,
    scrollShopPointsByType,
    // Public contract helpers are used by proof/tests and do not perform writes.
    readCollectionBinding,
    setCollectionState,
    assertEmbeddingSpaceCompatible,
    resolveCollectionName,
    contentFilter,
    toPointId,
    toScopedPointId,
    findOwnedPointIds,
};
