'use strict';

/**
 * The two transports this suite replaces — and nothing else.
 *
 * Everything between the webhook route and the Graph API call is the real
 * implementation: signature verification, durable receipts, dedup, BullMQ,
 * the worker's guard chain, product/knowledge retrieval, the grounding gate,
 * the policy engine and MetaMessengerProvider's own request construction.
 *
 *   1. META TRANSPORT (axios → graph.facebook.com)
 *      The outbound capture adapter. MetaMessengerProvider.sendMessage runs for
 *      real — attachment mapping, messaging_type, appsecret_proof — and only
 *      the network hop is captured. `capturedSends()` therefore shows the exact
 *      HTTP body Meta would have received.
 *
 *   2. LLM TRANSPORT (global.fetch → Gemini / OpenAI)
 *      llm.service.chat keeps its real provider chain, circuit breaker, request
 *      building and response parsing; only the wire response is scripted. That
 *      is what lets a test hand the pipeline a deliberately hallucinated
 *      candidate and assert it never reaches the Meta transport.
 *
 * Any other outbound host is an error, not a silent live call.
 */

const axios = require('axios');

const GRAPH_HOST = 'graph.facebook.com';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const OPENAI_HOST = 'api.openai.com';

const GEMINI_LITE_MODEL = process.env.LLM_GEMINI_LITE_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_PRO_MODEL = process.env.LLM_GEMINI_PRO_MODEL || 'gemini-3.1-pro-preview';

// ── Meta transport ───────────────────────────────────────────────────────────

/** @type {Array<{url: string, body: object}>} */
let sends = [];
let graphGets = [];
let sendFailure = null;
let sendAckOverride = false;
let messageSeq = 0;

const hostOf = (url) => {
    try { return new URL(String(url)).host; } catch { return ''; }
};

/**
 * Install the Meta capture adapter over axios. Returns a restore function.
 * Both verbs are intercepted: sendMessage POSTs, and the customer-profile
 * enrichment the webhook fires GETs — neither may touch the network.
 */
const installMetaTransport = () => {
    const realPost = axios.post;
    const realGet = axios.get;

    axios.post = async (url, body, config) => {
        if (hostOf(url) !== GRAPH_HOST) {
            throw new Error(`meta-e2e: unexpected outbound axios POST to ${hostOf(url) || '[invalid host]'}`);
        }
        if (!String(url).endsWith('/me/messages')) {
            // Any other Graph write would be a bypass of the send path.
            throw new Error(`meta-e2e: unexpected Graph POST to ${url}`);
        }
        sends.push({ url: String(url), body });
        if (sendFailure) throw sendFailure;
        if (sendAckOverride) {
            sendAckOverride = false;
            // HTTP 200 but NO message_id: a request Meta accepted cannot be
            // proven delivered without its acknowledgement. This is the wire
            // shape that must end in PROVIDER_NO_ACK, never in `sent`.
            return { data: { recipient_id: body?.recipient?.id } };
        }
        messageSeq += 1;
        return { data: { message_id: `mid.e2e.${messageSeq}`, recipient_id: body?.recipient?.id } };
    };

    axios.get = async (url, config) => {
        if (hostOf(url) !== GRAPH_HOST) {
            throw new Error(`meta-e2e: unexpected outbound axios GET to ${hostOf(url) || '[invalid host]'}`);
        }
        graphGets.push(String(url));
        // Profile enrichment / ping. An empty object is the "Meta told us
        // nothing" branch, which the handler already degrades gracefully from.
        return { data: {} };
    };

    return () => { axios.post = realPost; axios.get = realGet; };
};

/** Every message body MetaMessengerProvider handed to the Graph Send API. */
const capturedSends = () => sends.map((s) => s.body);

/** Read-only view of the Graph GETs (profile enrichment) the run produced. */
const capturedGraphGets = () => [...graphGets];

/** Make the next Graph send fail, e.g. to exercise retry / DLQ behaviour. */
const failNextSend = (error) => { sendFailure = error; };

/**
 * Make the next Graph POST be accepted by the transport but answered WITHOUT
 * a message_id — the shape that must end in PROVIDER_NO_ACK (held), never
 * in a `sent` claim. One-shot, like failNextSend.
 */
const succeedNextSendWithoutAck = () => { sendAckOverride = true; };

// ── LLM transport ────────────────────────────────────────────────────────────

/**
 * Per-provider script. A string is returned as the completion; an Error is
 * thrown as a transport failure (HTTP 500), which is what drives failover.
 */
let script = {};
let llmCalls = [];

/** The provider name llm.service would attribute this URL to. */
const providerFor = (url) => {
    const host = hostOf(url);
    if (host === OPENAI_HOST) return 'openai';
    if (host !== GEMINI_HOST) return null;
    return String(url).includes(GEMINI_PRO_MODEL) ? 'gemini-pro' : 'gemini-lite';
};

const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
});

const errorResponse = (status, message) => ({
    ok: false,
    status,
    json: async () => ({ error: { message } }),
    text: async () => message,
});

const wireBody = (provider, text) => (provider === 'openai'
    ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    : { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });

/**
 * Install the LLM transport over global.fetch. Returns a restore function.
 */
const installLlmTransport = () => {
    const realFetch = global.fetch;

    global.fetch = async (url, init) => {
        // The optional BanglaBERT classifier: answer as "service down", which is
        // the state on any machine that is not running it.
        if (hostOf(url) === hostOf(process.env.BERT_SERVICE_URL)) {
            return errorResponse(503, 'bert unavailable');
        }

        const provider = providerFor(url);
        if (!provider) {
            throw new Error(`meta-e2e: unexpected outbound fetch to ${hostOf(url)}`);
        }

        let request = null;
        try { request = JSON.parse(init?.body || '{}'); } catch { /* not JSON */ }
        llmCalls.push({ provider, request });

        const scripted = Object.prototype.hasOwnProperty.call(script, provider)
            ? script[provider]
            : script.default;

        if (scripted instanceof Error) {
            return errorResponse(500, scripted.message);
        }
        if (scripted === undefined) {
            // An unscripted call is a test-authoring bug, not a pass.
            return errorResponse(500, `meta-e2e: no LLM candidate scripted for ${provider}`);
        }
        return jsonResponse(wireBody(provider, scripted));
    };

    return () => { global.fetch = realFetch; };
};

/**
 * Script the model's candidate output for this turn.
 *
 * @param {string|Error|object} candidate - text for every provider, an Error to
 *   fail every provider, or a per-provider map e.g.
 *   `{ 'gemini-lite': new Error('503'), openai: 'fallback text' }`.
 */
const setCandidate = (candidate) => {
    script = (candidate && typeof candidate === 'object' && !(candidate instanceof Error))
        ? { ...candidate }
        : { default: candidate };
};

/** Providers the pipeline actually attempted, in order. */
const llmProvidersCalled = () => llmCalls.map((c) => c.provider);

/** Raw recorded LLM requests — used to assert what the prompt contained. */
const capturedLlmCalls = () => [...llmCalls];

// ── Lifecycle ────────────────────────────────────────────────────────────────

const resetTransports = () => {
    sends = [];
    graphGets = [];
    llmCalls = [];
    sendFailure = null;
    sendAckOverride = false;
    script = {};
};

module.exports = {
    installMetaTransport,
    installLlmTransport,
    resetTransports,
    capturedSends,
    capturedGraphGets,
    failNextSend,
    succeedNextSendWithoutAck,
    setCandidate,
    llmProvidersCalled,
    capturedLlmCalls,
    GEMINI_LITE_MODEL,
    GEMINI_PRO_MODEL,
};
