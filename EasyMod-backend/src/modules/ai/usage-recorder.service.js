'use strict';

/**
 * AI usage accounting — minimal, production-safe, OFF BY DEFAULT.
 *
 * Enable with AI_USAGE_ACCOUNTING=true. While the flag is unset every entry
 * point is a cheap no-op, so wiring it into the reply path cannot change
 * production behaviour.
 *
 * Sinks (D-P2-04): when — and only when — the gate is on, each call is
 *   1. persisted to the durable `ai_usage_ledger` table via usage-ledger.store
 *      (survives log rotation; the read path reports unknown cost as UNKNOWN,
 *      never $0), and
 *   2. emitted as one structured log line (`ai_usage` event), preserving the
 *      existing container-log pipeline.
 * When the gate is off NOTHING happens — production cost stays UNKNOWN with a
 * citation, which is the honest pilot posture until the gate is turned on.
 *
 * Attribution: callers may supply usageContext {shopId, operationType,
 * requestId, conversationId} either as flat fields (how llm.service spreads
 * them today) or as a nested `usageContext` object (the shape the deferred
 * intent-router wiring will use). Both are accepted; every field is null-safe.
 * A null shopId is recorded as unattributed — never dropped, never guessed.
 *
 * SAFETY INVARIANTS (asserted by tests):
 *   - NEVER records prompt bodies, customer message text, replies, or FAQ text.
 *     Only counts, ids, and model names — in the log line AND in the table
 *     (the store projects onto an allow-list; there is no text column).
 *   - NEVER records secrets, tokens, phone numbers, or customer identifiers.
 *   - Idempotent on requestId, so a BullMQ retry or a duplicate webhook cannot
 *     double-count (Redis claim + unique DB index as the durable backstop).
 *   - Records estimated cost and provider-confirmed usage separately via
 *     `sourceOfUsage`; a call with no usage metadata is recorded with
 *     estimatedCostUsd: null, never 0.
 *   - Can never throw into the caller: a ledger write failure degrades the
 *     record to `persisted: false` instead of failing the reply.
 */

const { calculateCost, normalizeProviderUsage, USAGE_SOURCE } = require('./cost.service');
const ledger = require('./usage-ledger.store');

const ENABLED = () => process.env.AI_USAGE_ACCOUNTING === 'true';

const IDEMPOTENCY_TTL_SECONDS = parseInt(process.env.AI_USAGE_IDEMPOTENCY_TTL || '86400', 10);

// Fallback guard for when Redis is unavailable. Bounded so it cannot leak.
// ponytail: bounded Set, not an LRU — a per-process cap is enough for a
// best-effort dedupe backstop; move to Redis-only if the cap starts evicting hot keys.
const SEEN = new Set();
const SEEN_MAX = 5000;

let redis = null;
try {
    ({ cacheRedis: redis } = require('../../config/redis'));
} catch (_) { /* Redis unavailable — fall back to the in-process guard */ }

/** True the FIRST time a requestId is seen; false on every repeat. */
async function claimOnce(requestId) {
    if (!requestId) return true; // nothing to dedupe on — record it
    const key = `ai_usage:seen:${requestId}`;
    if (redis) {
        try {
            const res = await redis.set(key, '1', 'NX', 'EX', IDEMPOTENCY_TTL_SECONDS);
            return res === 'OK' || res === 1;
        } catch (_) { /* fall through to the in-process guard */ }
    }
    if (SEEN.has(key)) return false;
    if (SEEN.size >= SEEN_MAX) SEEN.clear();
    SEEN.add(key);
    return true;
}

// A hung database must never pin the (floating) accounting promise or delay
// the structured log line. The insert itself can never throw; worst case the
// record is logged with persisted:false and the late row lands or not.
const LEDGER_WRITE_TIMEOUT_MS = (() => {
    const n = parseInt(process.env.AI_USAGE_LEDGER_WRITE_TIMEOUT_MS || '2000', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 2000;
})();

async function persistToLedger(record) {
    let timer = null;
    try {
        const raced = await Promise.race([
            ledger.insertUsageRow(record),
            new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), LEDGER_WRITE_TIMEOUT_MS); }),
        ]);
        return raced === true;
    } catch (_) {
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Record one AI call.
 *
 * @param {object} rec
 * @param {string}  [rec.shopId]          merchant shop (UUID); null = unattributed
 * @param {string}  [rec.operationType]   'chat_reply'|'vision_extract'|'sentiment'|'product_attrs'|'embed_product'|'embed_query'|'embed'|'transliterate'|'payment_ocr'
 * @param {string}  rec.provider          'gemini-lite'|'gemini-pro'|'openai'|'local'
 * @param {string}  rec.model
 * @param {string}  [rec.requestId]       idempotency key (message id, product id + revision, ...)
 * @param {string}  [rec.conversationId]
 * @param {string}  [rec.messageId]
 * @param {string}  [rec.productId]
 * @param {object}  [rec.usageContext]    {shopId, operationType, requestId, conversationId}
 *                                        — accepted as an alternative to flat fields (flat wins
 *                                        on conflict); this is the contract the deferred
 *                                        intent-router chat_reply wiring will pass.
 * @param {object}  [rec.responseBody]    raw provider body — usage is extracted, body is discarded
 * @param {object}  [rec.usage]           pre-normalised usage (when no raw body is available)
 * @param {number}  [rec.retrySequence]   0 for the first attempt
 * @param {number}  [rec.fallbackSequence] 0 = primary provider, 1 = second, 2 = third
 * @param {number}  [rec.imageCount]
 * @param {number}  [rec.latencyMs]
 * @param {boolean} [rec.success]
 * @returns {Promise<object|null>} the allow-listed record (with `persisted`),
 *          or null when the gate is off / the call was already counted.
 */
async function recordUsage(rec = {}) {
    if (!ENABLED()) return null;

    try {
        // usageContext may arrive flat (llm.service spread) or nested
        // (deferred intent-router wiring). Flat fields win on conflict.
        const ctx = (rec.usageContext && typeof rec.usageContext === 'object') ? rec.usageContext : {};
        const shopId = rec.shopId ?? ctx.shopId ?? null;
        const operationType = rec.operationType ?? ctx.operationType ?? null;
        const requestId = rec.requestId ?? ctx.requestId ?? null;
        const conversationId = rec.conversationId ?? ctx.conversationId ?? null;

        if (!(await claimOnce(requestId))) return null;

        const usage = rec.usage
            || normalizeProviderUsage(providerFamily(rec.provider), rec.responseBody)
            || null;

        const cost = usage
            ? calculateCost({
                model: rec.model,
                inputTokens: usage.inputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                outputTokens: usage.outputTokens,
                reasoningTokens: usage.reasoningTokens,
                embeddingTokens: usage.embeddingTokens,
            })
            : null;

        const record = {
            event: 'ai_usage',
            timestamp: new Date().toISOString(),
            shopId,
            operationType,
            provider: rec.provider || null,
            model: rec.model || null,
            requestId,
            conversationId,
            messageId: rec.messageId || null,
            productId: rec.productId || null,
            inputTokens: usage?.inputTokens ?? null,
            cachedInputTokens: usage?.cachedInputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            reasoningTokens: usage?.reasoningTokens ?? null,
            embeddingTokens: usage?.embeddingTokens ?? null,
            imageCount: rec.imageCount ?? 0,
            imageTokens: usage?.imageTokens ?? null,
            retrySequence: rec.retrySequence ?? 0,
            fallbackSequence: rec.fallbackSequence ?? 0,
            latencyMs: rec.latencyMs ?? null,
            success: rec.success !== false,
            // Unknown cost stays null. Zero would understate the ledger.
            estimatedCostUsd: cost?.costUsd ?? null,
            costUnknownReason: cost?.reason ?? (usage ? null : 'no_usage_metadata'),
            sourceOfUsage: usage?.sourceOfUsage ?? null,
            pricingVersion: cost?.pricingVersion ?? null,
        };

        // Durable sink first so the logged line can carry the DB result.
        // The store projects onto an allow-list — no text columns exist.
        record.persisted = await persistToLedger(record);

        // Single structured line. Deliberately console.log, matching how the rest
        // of the worker emits machine-readable events into the container log.
        console.log(JSON.stringify(record));
        return record;
    } catch (_) {
        // Accounting must never break a customer reply.
        return null;
    }
}

/** Map the internal provider label onto the usage-shape family. */
function providerFamily(provider) {
    return provider === 'openai' ? 'openai' : 'gemini';
}

module.exports = {
    recordUsage,
    USAGE_SOURCE,
    isEnabled: ENABLED,
    // Read paths (cost reporting / pilot evidence). These work with the gate
    // off too and report UNKNOWN — never $0 — when nothing was measured.
    summarizeUsage: ledger.summarizeUsage,
    COST_STATUS: ledger.COST_STATUS,
};
