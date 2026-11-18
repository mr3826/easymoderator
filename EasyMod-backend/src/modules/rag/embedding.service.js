const vectorSize = Number.parseInt(process.env.QDRANT_VECTOR_SIZE || '384', 10);
const EMBEDDING_HTTP_MAX_RETRIES = Number.parseInt(process.env.EMBEDDING_HTTP_MAX_RETRIES || '3', 10);
const EMBEDDING_RETRY_BACKOFF_MS = Number.parseInt(process.env.EMBEDDING_RETRY_BACKOFF_MS || '1200', 10);
const OPENAI_FALLBACK_MODEL = 'text-embedding-3-small';

const {
  DEFAULT_SPACE_VERSIONS,
  createEmbeddingSpaceIdentity,
} = require('./embedding-space');
const {
  normalizeEmbeddingText,
  prepareRetrievalDocument,
  prepareRetrievalQuery,
} = require('./embedding-input');

const normalizeText = normalizeEmbeddingText;

// ── Local embedding ───────────────────────────────────────────────────────────
// Character n-gram hash fallback — NOT semantically meaningful.
// Use EMBEDDING_PROVIDER=gemini (preferred), openai, or gcp in production.
// ─────────────────────────────────────────────────────────────────────────────
const localEmbed = (text, dimensions = vectorSize) => {
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '⚠️  WARNING: Using local (non-semantic) embedding in production. ' +
      'Set EMBEDDING_PROVIDER=gemini (with GEMINI_API_KEY), openai (with OPENAI_API_KEY), or gcp (with EMBEDDING_API_URL) for real semantic search.'
    );
  }

  const vector = new Array(dimensions).fill(0);
  const normalized = normalizeText(text);

  // Bigram overlap — captures some token co-occurrence, still not semantic
  for (let i = 0; i < normalized.length - 1; i++) {
    const bigram = normalized.charCodeAt(i) * 31 + normalized.charCodeAt(i + 1);
    const index = bigram % dimensions;
    vector[index] += 1;
  }
  // Single chars too
  for (let i = 0; i < normalized.length; i++) {
    vector[normalized.charCodeAt(i) % dimensions] += 0.5;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
};

const ensureVectorSize = (vector, expectedSize = vectorSize) => {
  if (!Array.isArray(vector)) {
    throw new Error('Embedding vector is not an array');
  }
  if (vector.length !== expectedSize) {
    throw new Error(
      `Embedding vector length (${vector.length}) does not match QDRANT_VECTOR_SIZE (${expectedSize}).`
    );
  }
  return vector;
};

const abortError = (signal) => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Embedding request aborted');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError(signal);
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError(signal));
    return;
  }

  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError(signal));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const sanitizeProviderError = (error) => {
  let summary = String(error?.message || error || 'unknown error')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/([?&](?:key|token|api[-_]?key|apikey)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();

  for (const secret of [process.env.GEMINI_API_KEY, process.env.OPENAI_API_KEY]) {
    if (secret) summary = summary.split(secret).join('[redacted]');
  }

  return summary.slice(0, 240) || 'unknown error';
};

const shouldRetryStatus = (status) => [408, 429, 500, 502, 503, 504].includes(status);

const fetchWithRetries = async (
  url,
  requestInit,
  signal,
  retries = Number.parseInt(process.env.EMBEDDING_HTTP_MAX_RETRIES || String(EMBEDDING_HTTP_MAX_RETRIES), 10),
) => {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(signal);
    try {
      const response = await fetch(url, { ...requestInit, signal });

      if (response.ok) {
        return response;
      }

      const body = await response.text();
      const error = new Error(`HTTP ${response.status}: ${body}`);
      error.status = response.status;

      if (attempt < retries && shouldRetryStatus(response.status)) {
        await sleep(EMBEDDING_RETRY_BACKOFF_MS * (attempt + 1), signal);
        continue;
      }

      throw error;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      lastError = error;
      if (attempt < retries) {
        await sleep(EMBEDDING_RETRY_BACKOFF_MS * (attempt + 1), signal);
        continue;
      }
    }
  }

  throw lastError || new Error('Embedding request failed');
};

const buildEmbeddingCandidateUrls = (rawUrl) => {
  const url = (rawUrl || '').trim();
  if (!url) return [];

  const candidates = [url];

  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    candidates.push(`${origin}/embed`);
    candidates.push(`${origin}/embeddings`);
    candidates.push(`${origin}/v1/embeddings`);

    if (/\/embed$/i.test(parsed.pathname)) {
      candidates.push(url.replace(/\/embed$/i, '/embeddings'));
      candidates.push(url.replace(/\/embed$/i, '/v1/embeddings'));
    }
  } catch (_) {
    // Non-URL values are ignored; caller will fail with original URL attempt.
  }

  return [...new Set(candidates.filter(Boolean))];
};

const getOpenAiEmbedding = async (text, { model = OPENAI_FALLBACK_MODEL, dimensions = vectorSize, signal } = {}) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    // text-embedding-3-* supports a `dimensions` param to truncate output.
    // Always pass it so the embedding size matches the Qdrant collection's
    // configured vector size (QDRANT_VECTOR_SIZE).
    body: JSON.stringify({ model, input: text, dimensions }),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embeddings failed: ${sanitizeProviderError(errorText)}`);
  }

  const data = await response.json();
  // Cost accounting. No-op unless AI_USAGE_ACCOUNTING=true; never throws.
  try {
    const { recordUsage } = require('../ai/usage-recorder.service');
    void recordUsage({
      operationType: 'embed',
      provider: 'openai',
      model,
      usage: {
        embeddingTokens: data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0,
        sourceOfUsage: 'provider_reported',
      },
    });
  } catch (_) { /* accounting must never break retrieval */ }

  const vector = data?.data?.[0]?.embedding;
  return ensureVectorSize(vector, dimensions);
};

// Gemini Embedding 2 uses asymmetric retrieval input formatting. The old
// taskType field belongs to Gemini Embedding 1 and is deliberately not sent.
const getGeminiEmbedding = async (
  text,
  { model = 'gemini-embedding-2', dimensions = vectorSize, purpose = 'query', title = null, signal } = {},
) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const input = purpose === 'document'
    ? prepareRetrievalDocument(text, { title })
    : prepareRetrievalQuery(text);

  let response;
  try {
    response = await fetchWithRetries(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text: input }] },
          outputDimensionality: dimensions,
        })
      },
      signal
    );
  } catch (error) {
    const safeError = new Error(`Gemini embeddings failed: ${sanitizeProviderError(error)}`);
    safeError.name = error?.name || 'GeminiEmbeddingError';
    throw safeError;
  }

  const data = await response.json();
  // Cost accounting. No-op unless AI_USAGE_ACCOUNTING=true; never throws.
  try {
    const { recordUsage } = require('../ai/usage-recorder.service');
    void recordUsage({
      operationType: 'embed',
      provider: 'gemini',
      model,
      usage: {
        embeddingTokens: data?.usageMetadata?.promptTokenCount ?? 0,
        sourceOfUsage: data?.usageMetadata ? 'provider_reported' : 'estimated',
      },
    });
  } catch (_) { /* accounting must never break retrieval */ }

  return ensureVectorSize(data?.embedding?.values, dimensions);
};

const getGcpEmbedding = async (text, { model = 'text-embedding-3-small', dimensions = vectorSize, signal } = {}) => {
  const apiUrl = process.env.EMBEDDING_API_URL;
  if (!apiUrl) {
    throw new Error('EMBEDDING_API_URL is not set for GCP provider');
  }

  const candidateUrls = buildEmbeddingCandidateUrls(apiUrl);

  const apiKey = process.env.EMBEDDING_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const errors = [];
  let data;
  for (const url of candidateUrls) {
    const isOpenAiCompat = /\/v1\/embeddings$/i.test(url);
    const payload = isOpenAiCompat
      ? { model, input: text, dimensions }
      : { inputs: text };

    try {
      const response = await fetchWithRetries(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      }, signal);
      data = await response.json();
      break;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      errors.push(`${url} -> ${error.message}`);
    }
  }

  if (!data) {
    throw new Error(`GCP TEI embeddings failed across endpoints: ${errors.join(' | ')}`);
  }

  // TEI response shape varies by version/deployment.
  // Supported:
  // - [number, ...]
  // - [[number, ...]]
  // - [{ embedding: [number, ...] }]
  // - { embedding: [number, ...] }
  // - { embeddings: [[number, ...]] }
  let vector;
  if (Array.isArray(data)) {
    if (data.length > 0 && typeof data[0] === 'number') {
      vector = data;
    } else if (data.length > 0 && Array.isArray(data[0])) {
      vector = data[0];
    } else if (data.length > 0 && Array.isArray(data[0]?.embedding)) {
      vector = data[0].embedding;
    }
  } else if (Array.isArray(data?.embedding)) {
    vector = data.embedding;
  } else if (Array.isArray(data?.embeddings?.[0])) {
    vector = data.embeddings[0];
  }

  return ensureVectorSize(vector, dimensions);
};

// Providers that produce real semantic vectors. Anything not in this set
// (local fallback, anthropic, unset, typos) is NON-semantic and will wreck
// retrieval quality — getProviderInfo().semantic surfaces that to health checks.
const SEMANTIC_PROVIDERS = new Set(['gemini', 'openai', 'gcp']);

const configuredProvider = () => (process.env.EMBEDDING_PROVIDER
  || (process.env.NODE_ENV === 'production' ? 'gemini' : 'local'))
  .toString().trim().toLowerCase();

/**
 * Resolve the raw EMBEDDING_PROVIDER env value to a canonical provider.
 * 'http' and 'tei' are accepted aliases for the HTTP embedding client
 * (Text-Embeddings-Inference / OpenAI-compatible servers) handled by
 * getGcpEmbedding — so a deployment that followed the documented
 * `EMBEDDING_PROVIDER=http` example gets real semantic embeddings instead of
 * silently degrading to the local n-gram fallback.
 * Anything unrecognised (incl. 'anthropic', which has no embeddings API) → local.
 */
const resolveProvider = (raw) => {
  const p = (raw == null ? configuredProvider() : raw)
    .toString().trim().toLowerCase();
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'openai') return 'openai';
  if (p === 'gcp' || p === 'http' || p === 'tei') return 'gcp';
  return 'local';
};

const resolveSpaceVersion = (provider) => {
  const specificKey = provider === 'gemini'
    ? 'GEMINI_EMBEDDING_SPACE_VERSION'
    : provider === 'openai'
      ? 'OPENAI_EMBEDDING_SPACE_VERSION'
      : null;
  return (specificKey && process.env[specificKey])
    || process.env.EMBEDDING_SPACE_VERSION
    || DEFAULT_SPACE_VERSIONS[provider]
    || `${provider}-embedding-v1`;
};

const resolveProviderModel = (provider) => {
  if (provider === 'gemini') return process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
  if (provider === 'openai') {
    const explicitlyOpenAi = configuredProvider() === 'openai';
    return process.env.OPENAI_EMBEDDING_MODEL
      || (explicitlyOpenAi ? process.env.EMBEDDING_MODEL : null)
      || OPENAI_FALLBACK_MODEL;
  }
  if (provider === 'gcp') return process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  return 'local-ngram';
};

const getEmbeddingSpaceIdentity = ({ provider, model, version, dimensions } = {}) => {
  const effectiveProvider = resolveProvider(provider ?? configuredProvider());
  return createEmbeddingSpaceIdentity({
    provider: effectiveProvider,
    model: model || resolveProviderModel(effectiveProvider),
    version: version || resolveSpaceVersion(effectiveProvider),
    dimensions: dimensions || vectorSize,
  });
};

/**
 * Generate a vector without discarding the provider-bound identity that made
 * it. No provider fallback happens here: fallback is a collection-level
 * decision made by rag.service after resolving a compatible collection.
 */
const getEmbeddingResult = async (text, { identity = null, purpose = 'query', title = null, signal } = {}) => {
  const resolvedIdentity = identity || getEmbeddingSpaceIdentity();
  const content = normalizeText(text);
  if (!content) {
    throw new Error('Text is required for embedding');
  }

  if (resolvedIdentity.provider === 'gemini') {
    const vector = await getGeminiEmbedding(content, {
      model: resolvedIdentity.model,
      dimensions: resolvedIdentity.dimensions,
      purpose,
      title,
      signal,
    });
    return { vector, identity: resolvedIdentity };
  }

  if (resolvedIdentity.provider === 'openai') {
    const vector = await getOpenAiEmbedding(content, {
      model: resolvedIdentity.model,
      dimensions: resolvedIdentity.dimensions,
      signal,
    });
    return { vector, identity: resolvedIdentity };
  }

  if (resolvedIdentity.provider === 'gcp') {
    const vector = await getGcpEmbedding(content, {
      model: resolvedIdentity.model,
      dimensions: resolvedIdentity.dimensions,
      signal,
    });
    return { vector, identity: resolvedIdentity };
  }

  const rawProvider = configuredProvider();
  if (rawProvider === 'anthropic') {
    console.error(
      '❌ EMBEDDING_PROVIDER=anthropic is not supported. ' +
      'Claude does not have an embeddings API. Falling back to local (non-semantic). ' +
      'Switch to EMBEDDING_PROVIDER=gemini, openai, or gcp.'
    );
  }

  return {
    vector: localEmbed(content, resolvedIdentity.dimensions),
    identity: resolvedIdentity,
  };
};

const getEmbedding = async (text, options = {}) => (await getEmbeddingResult(text, options)).vector;

/**
 * Report the effective embedding configuration WITHOUT a network call.
 * Lets /health/detailed and the embedding-audit script detect the silent
 * "running on the non-semantic local fallback" failure mode — the #1 cause of
 * the chatbot hallucinating because RAG retrieval returns near-random matches.
 *
 * @returns {{configured:string, effective:string, semantic:boolean,
 *            keyPresent:boolean|null, vectorSize:number, model:string|null,
 *            fallbackProvider:string|null, fallbackKeyPresent:boolean|null,
 *            fallbackModel:string|null}}
 */
const getProviderInfo = () => {
  const configured = configuredProvider();
  const effective = resolveProvider(configured);
  const semantic = SEMANTIC_PROVIDERS.has(effective);

  // Whether the credential/endpoint that the effective provider needs is present.
  let keyPresent = null;
  if (effective === 'gemini') keyPresent = Boolean(process.env.GEMINI_API_KEY);
  if (effective === 'openai') keyPresent = Boolean(process.env.OPENAI_API_KEY);
  if (effective === 'gcp') keyPresent = Boolean(process.env.EMBEDDING_API_URL);

  return {
    configured,
    effective,
    semantic,
    keyPresent,
    vectorSize,
    fallbackProvider: effective === 'gemini' ? 'openai' : null,
    fallbackMode: effective === 'gemini' ? 'collection' : null,
    fallbackKeyPresent: effective === 'gemini' ? Boolean(process.env.OPENAI_API_KEY) : null,
    fallbackModel: effective === 'gemini'
      ? resolveProviderModel('openai')
      : null,
    model: effective === 'gemini'
      ? (process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2')
      : effective === 'openai'
        ? resolveProviderModel('openai')
        : (process.env.EMBEDDING_MODEL || null),
    embeddingSpaceVersion: getEmbeddingSpaceIdentity().embedding_space_version,
  };
};

/**
 * Live embedding probe — embeds a fixed short string and validates the vector.
 * Returns a structured result (never throws) so health checks stay resilient.
 *
 * @param {string} [sample]
 * @returns {Promise<{ok:boolean, provider:string, semantic:boolean,
 *                     dimensions:number|null, error?:string}>}
 */
const probe = async (sample = 'health check probe') => {
  const info = getProviderInfo();
  try {
    const result = await getEmbeddingResult(sample);
    return {
      ok: true,
      provider: info.effective,
      semantic: info.semantic,
      dimensions: Array.isArray(result.vector) ? result.vector.length : null,
      embeddingSpaceVersion: result.identity.embedding_space_version,
    };
  } catch (error) {
    return {
      ok: false,
      provider: info.effective,
      semantic: info.semantic,
      dimensions: null,
      error: error.message,
    };
  }
};

module.exports = {
  getEmbedding,
  getEmbeddingResult,
  getEmbeddingSpaceIdentity,
  localEmbed,
  getProviderInfo,
  probe,
  fetchWithRetries
};
