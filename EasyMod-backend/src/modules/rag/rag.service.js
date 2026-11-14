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
const POINT_ID_NAMESPACE = '5f6c1f1e-6b2a-4c3d-8e7f-0a1b2c3d4e5f';
const toPointId = (documentId) => {
    if (!documentId) return crypto.randomUUID();
    const id = String(documentId);
    return uuidValidate(id) ? id : uuidv5(id, POINT_ID_NAMESPACE);
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
    const response = await fetch(url, {
        ...init,
        headers: { ...getQdrantHeaders(), ...(init.headers || {}) },
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

const readCollectionInfo = async (collection) => {
    const response = await fetch(qdrantPath(collection), { headers: getQdrantHeaders() });
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

const readCollectionBinding = async (collection) => {
    const info = await readCollectionInfo(collection);
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

const createCollection = async (collection, identity) => {
    const response = await fetch(qdrantPath(collection), {
        method: 'PUT',
        headers: getQdrantHeaders(),
        body: JSON.stringify({
            vectors: { size: identity.dimensions, distance: 'Cosine' },
        }),
    });
    if (!response.ok && response.status !== 409) {
        throw new Error(`Failed to create Qdrant collection: HTTP ${response.status}`);
    }

    if (response.status === 409) return readCollectionBinding(collection);

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
    { baseCollection = qdrantCollection, allowCreate = false, forQuery = false, requestedIdentity = null } = {},
) => {
    const collection = resolveCollectionName(shopId, baseCollection);
    const desiredIdentity = requestedIdentity || getEmbeddingSpaceIdentity();
    const info = await readCollectionInfo(collection);

    let binding;
    if (!info) {
        if (!allowCreate) {
            const error = new Error(`Qdrant collection is unavailable: ${collection}`);
            error.name = 'EmbeddingCollectionUnavailableError';
            error.code = 'EMBEDDING_COLLECTION_UNAVAILABLE';
            throw error;
        }
        binding = await createCollection(collection, desiredIdentity);
    } else {
        binding = await readCollectionBinding(collection);
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

const setCollectionState = async (collection, state) => {
    const binding = await readCollectionBinding(collection);
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

const upsertPoint = async ({ id, vector, identity, payload, binding }) => {
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
    });
};

const searchPoints = async ({ vector, identity, limit = 5, filter, binding }) => {
    assertEmbeddingSpaceCompatible(binding.identity, identity, 'query');
    const result = await qdrantJson(qdrantPath(binding.collection, '/points/search'), {
        method: 'POST',
        body: JSON.stringify({
            vector,
            limit,
            with_payload: true,
            filter: contentFilter(filter),
        }),
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
        const embedding = await getEmbeddingResult(content, {
            identity: binding.identity,
            purpose: 'document',
            title: embeddingTitle(metadata),
        });

        await upsertPoint({
            id: toPointId(metadata.documentId),
            vector: embedding.vector,
            identity: embedding.identity,
            binding,
            payload: { text: content, ...metadata },
        });

        return {
            success: true,
            message: 'Data ingested successfully',
            ingestionId: toPointId(metadata.documentId),
            documentId: metadata.documentId || null,
            embeddingSpace: binding.identity,
        };
    } catch (error) {
        console.warn('RAG ingestion skipped (service unavailable):', error.code || error.name || 'EmbeddingError');
        return {
            success: false,
            message: error.code || 'RAG service unavailable',
            ingestionId: null,
        };
    }
};

const searchWithBinding = async ({ embedding, limit, filter, binding }) => {
    const results = await searchPoints({
        vector: embedding.vector,
        identity: embedding.identity,
        limit,
        filter,
        binding,
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

const embedQueryForBinding = (content, binding) => getEmbeddingResult(content, {
    identity: binding.identity,
    purpose: 'query',
});

const queryData = async ({ query, limit = 5, filters, shopId }) => {
    const scopedShopId = requireShopId(shopId);
    const content = normalizeText(query);
    if (!content) throw new Error('Query text is required');

    const primaryBinding = await ensureCollection(scopedShopId, { forQuery: true, allowCreate: false });
    const searchFilter = perTenantMode ? filters : buildShopFilter(scopedShopId, filters);

    let primaryEmbedding;
    try {
        primaryEmbedding = await embedQueryForBinding(content, primaryBinding);
    } catch (error) {
        // Only query embedding failure may trigger collection-level fallback. A
        // Qdrant search failure is never converted into a provider switch.
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
        });
        if (fallbackBinding.identity.provider !== 'openai') {
            const invalid = new Error('configured embedding fallback collection is not OpenAI-bound');
            invalid.name = 'EmbeddingFallbackCollectionMismatchError';
            invalid.code = 'EMBEDDING_FALLBACK_COLLECTION_MISMATCH';
            throw invalid;
        }

        console.warn('Embedding collection fallback: gemini -> ready openai collection');
        const fallbackEmbedding = await embedQueryForBinding(content, fallbackBinding);
        return searchWithBinding({
            embedding: fallbackEmbedding,
            limit,
            filter: searchFilter,
            binding: fallbackBinding,
        });
    }

    return searchWithBinding({
        embedding: primaryEmbedding,
        limit,
        filter: searchFilter,
        binding: primaryBinding,
    });
};

const deletePoint = async (id, shopId) => {
    const binding = await ensureCollection(requireShopId(shopId), { allowCreate: false });
    return qdrantJson(qdrantPath(binding.collection, '/points/delete?wait=true'), {
        method: 'POST',
        body: JSON.stringify({ points: [toPointId(id)] }),
    });
};

module.exports = {
    ingestData,
    queryData,
    deletePoint,
    // Public contract helpers are used by proof/tests and do not perform writes.
    readCollectionBinding,
    setCollectionState,
    assertEmbeddingSpaceCompatible,
    resolveCollectionName,
    contentFilter,
    toPointId,
};
