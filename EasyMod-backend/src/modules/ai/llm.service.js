/**
 * AI1 — LLM Failover Chain
 *
 * Priority order:
 *   1. gemini-lite  — gemini-3.1-flash-lite  (primary, fast + cheap)
 *   2. gemini-pro   — gemini-3.1-pro-preview (fallback, high-stakes or lite failure)
 *   3. openai       — gpt-4.1-mini           (final fallback)
 *
 * For high-stakes tasks, pass preferredProvider: 'gemini-pro' to skip lite.
 * For forced OpenAI, pass preferredProvider: 'openai'.
 *
 * Environment variables:
 *   EM-GEMINI-KEY                — Google Gemini (primary credential name)
 *   GEMINI_API_KEY               — Legacy compatibility fallback
 *   OPENAI_API_KEY               — OpenAI (required for provider 3)
 *   LLM_GEMINI_LITE_MODEL        (default: gemini-3.1-flash-lite)
 *   LLM_GEMINI_PRO_MODEL         (default: gemini-3.1-pro-preview)
 *   LLM_OPENAI_MODEL             (default: gpt-4.1-mini)
 *   LLM_MAX_TOKENS               (default: 1024)
 *   LLM_TEMPERATURE              (default: 0.3)
 *   LLM_GEMINI_TIMEOUT_MS        (default: 30000)
 *   LLM_OPENAI_TIMEOUT_MS        (default: 30000)
 */

const { circuitBreaker } = require('./circuit-breaker.service');
const { decodeDataImage, safeFetchMedia } = require('../../utils/safe-media-fetch');
// Cost accounting. No-op unless AI_USAGE_ACCOUNTING=true; never throws.
const { recordUsage } = require('./usage-recorder.service');

const GEMINI_LITE_MODEL = process.env.LLM_GEMINI_LITE_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_PRO_MODEL  = process.env.LLM_GEMINI_PRO_MODEL  || 'gemini-3.1-pro-preview';
const OPENAI_MODEL      = process.env.LLM_OPENAI_MODEL      || 'gpt-4.1-mini';
const MAX_TOKENS        = parseInt(process.env.LLM_MAX_TOKENS  || '1024', 10);
const TEMPERATURE       = parseFloat(process.env.LLM_TEMPERATURE || '0.3');

const getGeminiApiKey = () => process.env['EM-GEMINI-KEY'] || process.env.GEMINI_API_KEY;
const responseHeader = (response, names) => {
    for (const name of names) {
        const value = response?.headers?.get?.(name);
        if (typeof value === 'string' && value.length <= 128) return value;
    }
    return null;
};
const requestSignal = (timeoutMs, parentSignal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!parentSignal) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
    timeoutSignal.addEventListener('abort', abort, { once: true });
    return controller.signal;
};
const numericUsage = (usage, fields) => Object.fromEntries(fields
    .map(field => [field, Number(usage?.[field])])
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0));
const geminiUsage = (usage) => numericUsage(usage, [
    'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
    'thoughtsTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount',
]);
const openAiUsage = (usage) => numericUsage(usage, [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
]);

const geminiTextOrThrow = (data) => {
    const blockReason = data?.promptFeedback?.blockReason;
    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
        throw new Error('Gemini response was blocked by safety policy');
    }
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(String(finishReason || '').toUpperCase())) {
        throw new Error('Gemini response was blocked by safety policy');
    }
    const text = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('')
        .trim();
    if (!text) throw new Error('Gemini response contained no usable text');
    return text;
};

const openAiTextOrThrow = (data) => {
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
        throw new Error('OpenAI response was blocked by safety policy');
    }
    const content = choice?.message?.content;
    const text = typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
            ? content.filter(part => typeof part?.text === 'string').map(part => part.text).join('').trim()
            : '';
    if (!text) throw new Error('OpenAI response contained no usable text');
    return text;
};

// ---------------------------------------------------------------------------
// Vision helpers
// ---------------------------------------------------------------------------

const hasVisionContent = (messages) =>
    messages.some(m => Array.isArray(m.content));

const fetchImageAsBase64 = async (url) => {
    const { buffer, mimeType } = typeof url === 'string' && url.startsWith('data:')
        ? decodeDataImage(url)
        : await safeFetchMedia(url);
    return { data: buffer.toString('base64'), mimeType };
};

const toOpenAIContent = async (content) => {
    if (typeof content === 'string') return content;
    return Promise.all(content.map(async (block) => {
        if (block.type === 'image_url') {
            const { data, mimeType } = await fetchImageAsBase64(block.url);
            return {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${data}` },
            };
        }
        return { type: 'text', text: block.text || '' };
    }));
};

const toGeminiParts = async (content) => {
    if (typeof content === 'string') return [{ text: content }];
    const parts = [];
    for (const block of content) {
        if (block.type === 'image_url') {
            const { data, mimeType } = await fetchImageAsBase64(block.url);
            parts.push({ inlineData: { mimeType, data } });
        } else {
            parts.push({ text: block.text || '' });
        }
    }
    return parts;
};

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

const callOpenAI = async ({ systemPrompt, messages, maxTokens, usageContext, fallbackSequence, returnMetadata, timeoutMs: requestedTimeoutMs, signal }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const startedAt = Date.now();
    const timeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? requestedTimeoutMs
        : (parseInt(process.env.LLM_OPENAI_TIMEOUT_MS) || 30000);
    const oaiMessages = [];
    if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
    oaiMessages.push(...await Promise.all(
        messages.map(async (m) => ({
            role: m.role,
            content: await toOpenAIContent(m.content),
        })),
    ));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: oaiMessages,
            max_tokens: maxTokens || MAX_TOKENS,
            temperature: TEMPERATURE
        }),
        signal: requestSignal(timeoutMs, signal)
    });

    if (!response.ok) {
        throw new Error(`OpenAI error ${response.status || 'unknown'}`);
    }

    const data = await response.json();
    void recordUsage({
        ...usageContext,
        provider: 'openai',
        model: OPENAI_MODEL,
        responseBody: data,
        fallbackSequence,
        latencyMs: Date.now() - startedAt,
        imageCount: countImages(messages),
    });
    const text = openAiTextOrThrow(data);
    if (!returnMetadata) return text;
    return {
        text,
        model: OPENAI_MODEL,
        requestId: responseHeader(response, ['x-request-id', 'request-id']),
        latencyMs: Date.now() - startedAt,
        usage: openAiUsage(data?.usage),
    };
};

/**
 * Shared Gemini caller. `geminiModel` selects lite vs pro.
 * When `cachedContentName` is set, the system prompt is already server-cached.
 */
const callGemini = async ({ systemPrompt, messages, maxTokens, cachedContentName, usageContext, fallbackSequence, returnMetadata, timeoutMs: requestedTimeoutMs, signal, evaluationEgressAuthorization }, geminiModel) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error('EM-GEMINI-KEY not set');

    const startedAt = Date.now();
    const timeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? requestedTimeoutMs
        : (parseInt(process.env.LLM_GEMINI_TIMEOUT_MS) || 30000);
    const contents = await Promise.all(messages.map(async (m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: await toGeminiParts(m.content)
    })));

    const body = {
        contents,
        generationConfig: {
            maxOutputTokens: maxTokens || MAX_TOKENS,
            temperature: TEMPERATURE
        }
    };

    if (cachedContentName) {
        body.cachedContent = cachedContentName;
    } else if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestSignal(timeoutMs, signal)
    };
    if (evaluationEgressAuthorization !== undefined
        && (typeof evaluationEgressAuthorization !== 'function'
            || evaluationEgressAuthorization({ url, ...request }) !== true)) {
        throw new Error('Gemini evaluation permit rejected');
    }
    const response = await fetch(url, request);

    if (!response.ok) {
        const error = new Error(`Gemini (${geminiModel}) error ${response.status || 'unknown'}`);
        if (response.status === 429) error.code = 'GEMINI_RATE_LIMIT';
        throw error;
    }

    const data = await response.json();
    void recordUsage({
        ...usageContext,
        provider: geminiModel === GEMINI_PRO_MODEL ? 'gemini-pro' : 'gemini-lite',
        model: geminiModel,
        responseBody: data,
        fallbackSequence,
        latencyMs: Date.now() - startedAt,
        imageCount: countImages(messages),
    });
    const text = geminiTextOrThrow(data);
    if (!returnMetadata) return text;
    return {
        text,
        model: geminiModel,
        requestId: responseHeader(response, ['x-goog-request-id', 'x-request-id', 'request-id']),
        latencyMs: Date.now() - startedAt,
        usage: geminiUsage(data?.usageMetadata),
    };
};

/** Count image blocks across a messages array (for the cost ledger only). */
const countImages = (messages = []) =>
    messages.reduce((n, m) => n + (Array.isArray(m.content)
        ? m.content.filter((b) => b && b.type === 'image_url').length
        : 0), 0);

// ---------------------------------------------------------------------------
// Provider chain
// ---------------------------------------------------------------------------

const PROVIDERS = [
    { name: 'gemini-lite', fn: (params) => callGemini(params, GEMINI_LITE_MODEL) },
    { name: 'gemini-pro',  fn: (params) => callGemini(params, GEMINI_PRO_MODEL)  },
    { name: 'openai',      fn: (params) => callOpenAI(params)                     },
];

// Should a gemini-lite failure escalate automatically to the expensive Gemini
// model? Default NO, for two measured reasons:
//
//   1. On the current free Gemini project, GEMINI_PRO_MODEL returns
//      GenerateContentInputTokensPerModelPerDay-FreeTier limit=0 — it cannot
//      serve a single request, so the attempt is pure added latency on the path
//      to the OpenAI fallback.
//   2. On a paid project it costs ~8× per reply. A transient 500 or a rate-limit
//      blip does not justify an 8× model; that is an escalation decision, not a
//      retry strategy.
//
// gemini-pro stays reachable through preferredProvider:'gemini-pro' for genuine
// escalation (low confidence, order/policy accuracy, an entitled plan).
// Set LLM_AUTO_ESCALATE_TO_PRO=true to restore it in the automatic chain — worth
// revisiting once the key moves to a paid project.
// See docs/ai-cost/GEMINI_FIRST_ROUTING.md.
const autoEscalateToPro = () => process.env.LLM_AUTO_ESCALATE_TO_PRO === 'true';

/**
 * Call LLM with automatic failover: lite → pro → openai.
 *
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {Array<{role,content}>} params.messages
 * @param {string} [params.preferredProvider] - 'gemini-lite' | 'gemini-pro' | 'openai'
 *   Pass 'gemini-pro' for high-stakes tasks to skip lite entirely.
 * @param {string[]} [params.skipProviders] - Exclude specific providers from this call.
 * @param {number} [params.maxTokens]
 * @param {string} [params.cachedContentName] - Gemini Context Cache handle.
 * @param {boolean} [params.observeFallback] - Include whether a later provider supplied the reply.
 * @returns {Promise<{ text: string, provider: string }>}
 */
const chat = async (params) => {
    const { preferredProvider, skipProviders = [] } = params;

    let providers = PROVIDERS.filter(p => !skipProviders.includes(p.name));

    // Drop the expensive tier from the AUTOMATIC chain unless it was explicitly
    // asked for. An explicit preferredProvider is an escalation decision and is
    // always honoured.
    if (!autoEscalateToPro() && preferredProvider !== 'gemini-pro') {
        providers = providers.filter(p => p.name !== 'gemini-pro');
    }

    if (preferredProvider) {
        const pref = providers.find(p => p.name === preferredProvider);
        if (pref) {
            providers = [pref, ...providers.filter(p => p.name !== preferredProvider)];
        }
    }

    const errors = [];
    let soleGeminiRateLimit = false;
    for (const [fallbackSequence, { name, fn }] of providers.entries()) {
        try {
            const response = await circuitBreaker.callWithBreaker(name, () => fn({ ...params, fallbackSequence }));
            const details = response && typeof response === 'object' ? response : null;
            const text = details ? details.text : response;
            if (typeof text !== 'string' || !text.trim()) throw new Error('Provider returned no usable text');
            const observation = params.observeFallback ? { fallbackUsed: fallbackSequence > 0 } : {};
            return params.returnMetadata
                ? {
                    text,
                    provider: name,
                    model: details?.model || null,
                    requestId: details?.requestId || null,
                    latencyMs: details?.latencyMs ?? null,
                    usage: details?.usage || {},
                    ...observation,
                }
                : { text, provider: name, ...observation };
        } catch (err) {
            if (providers.length === 1 && name === 'gemini-lite' && err?.code === 'GEMINI_RATE_LIMIT') {
                soleGeminiRateLimit = true;
            }
            errors.push(`${name}: ${err.message}`);
        }
    }

    const error = new Error(`All LLM providers failed:\n${errors.join('\n')}`);
    if (soleGeminiRateLimit) error.code = 'GEMINI_RATE_LIMIT';
    throw error;
};

/**
 * LLM-assisted Banglish → Bangla transliteration.
 */
const transliterateWithLlm = async (banglish, ruleBasedResult) => {
    const { text } = await chat({
        systemPrompt: 'You are a Banglish to Bangla transliterator. Return only the corrected Bangla text, no explanation.',
        messages: [
            {
                role: 'user',
                content: `Banglish input: "${banglish}"\nRule-based attempt: "${ruleBasedResult}"\n\nReturn the correct Bangla transliteration as a single line.`
            }
        ],
        maxTokens: 256
    });
    return text.trim();
};

module.exports = { chat, callOpenAI, callGemini, transliterateWithLlm, GEMINI_LITE_MODEL, GEMINI_PRO_MODEL, OPENAI_MODEL };
