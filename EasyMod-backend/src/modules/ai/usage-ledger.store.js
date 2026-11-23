'use strict';

/**
 * D-P2-04 — durable storage sink for AI usage accounting.
 *
 * Written by usage-recorder.service.js only when AI_USAGE_ACCOUNTING=true.
 * Read helpers (summarizeUsage) are safe to call regardless of the gate: the
 * gate controls WRITES. When nothing was recorded, cost is reported as
 * UNKNOWN/NO_DATA with a null total — never as $0. A production environment
 * with the gate off therefore surfaces honestly as "cost not measured",
 * which is exactly the posture the pilot cost audit requires.
 *
 * Schema: ai_usage_ledger (migration 20261123_001_ai_usage_ledger). The
 * allow-list below is the ONLY path into SQL: token counts, labels, opaque
 * ids, latency and cost — never prompt text, reply text, phone numbers or
 * customer content. Extra keys on a record are dropped here, not stored.
 *
 * Hermeticity: the default Jest unit lane forbids Postgres/Redis/network
 * (see jest.config.js). The database module is therefore lazily required and
 * skipped under NODE_ENV=test unless a suite explicitly opts in with
 * AI_USAGE_LEDGER_DB=true (integration lanes do). A missing or failing
 * database degrades to persisted:false / LEDGER_UNAVAILABLE — the recorder
 * can never throw into a customer reply because of this module.
 */

const crypto = require('crypto');

const UNIT_LANE_DB_ENV = 'AI_USAGE_LEDGER_DB';

let sequelizeRef;
let sequelizeResolved = false;

/** Lazily resolve the shared sequelize instance; null when unavailable. */
function getSequelize() {
    if (sequelizeResolved) return sequelizeRef;
    sequelizeResolved = true;
    if (process.env.NODE_ENV === 'test' && process.env[UNIT_LANE_DB_ENV] !== 'true') {
        sequelizeRef = null; // unit lane: never touch a real database
        return sequelizeRef;
    }
    try {
        // eslint-disable-next-line global-require
        ({ sequelize: sequelizeRef } = require('../../utils/database/database-setup'));
    } catch (_) {
        sequelizeRef = null;
    }
    return sequelizeRef;
}

/** Reset the lazy resolution (test helper — integration suites re-point env). */
function resetLedgerClientForTests() {
    sequelizeResolved = false;
    sequelizeRef = undefined;
}

const isUuid = (value) => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Clamp a token count to a safe non-negative integer, preserving null/unknown. */
const tokenCount = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

const smallInt = (value, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), max);
};

const truncate = (value, max) => {
    if (value === null || value === undefined) return null;
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
};

const numeric = (value) => {
    // null/undefined means UNKNOWN. Number(null) === 0, which would turn an
    // unmeasured cost into a fabricated zero — the exact D-P2-04 failure mode.
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Map a recorder record onto the ledger's allow-listed columns. Fields that
 * must be UUIDs degrade to null (with the value preserved nowhere sensitive)
 * rather than failing the whole insert — one malformed id must not lose the
 * cost row. Non-UUID ids simply do not join, which the read path shows.
 */
function projectLedgerRow(rec = {}) {
    const cost = numeric(rec.estimatedCostUsd);
    return {
        id: crypto.randomUUID(),
        occurredAt: rec.timestamp || new Date().toISOString(),
        shopId: isUuid(rec.shopId) ? rec.shopId : null,
        operationType: truncate(rec.operationType, 64),
        provider: truncate(rec.provider, 32),
        model: truncate(rec.model, 128),
        requestId: truncate(rec.requestId, 128),
        conversationId: isUuid(rec.conversationId) ? rec.conversationId : null,
        messageId: isUuid(rec.messageId) ? rec.messageId : null,
        productId: isUuid(rec.productId) ? rec.productId : null,
        inputTokens: tokenCount(rec.inputTokens),
        cachedInputTokens: tokenCount(rec.cachedInputTokens),
        outputTokens: tokenCount(rec.outputTokens),
        reasoningTokens: tokenCount(rec.reasoningTokens),
        embeddingTokens: tokenCount(rec.embeddingTokens),
        imageTokens: tokenCount(rec.imageTokens),
        imageCount: smallInt(rec.imageCount, 1000),
        retrySequence: smallInt(rec.retrySequence, 32767),
        fallbackSequence: smallInt(rec.fallbackSequence, 32767),
        latencyMs: tokenCount(rec.latencyMs),
        success: rec.success !== false,
        // Unknown cost stays NULL — the column is nullable by contract.
        estimatedCostUsd: cost,
        costUnknownReason: rec.estimatedCostUsd == null
            ? truncate(rec.costUnknownReason || 'unknown', 64)
            : null,
        sourceOfUsage: truncate(rec.sourceOfUsage, 32),
        pricingVersion: truncate(rec.pricingVersion, 32),
    };
}

const INSERT_SQL = `
    INSERT INTO ai_usage_ledger (
        id, occurred_at, shop_id, operation_type, provider, model, request_id,
        conversation_id, message_id, product_id,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        embedding_tokens, image_tokens, image_count, retry_sequence,
        fallback_sequence, latency_ms, success, estimated_cost_usd,
        cost_unknown_reason, source_of_usage, pricing_version
    ) VALUES (
        :id, :occurredAt, :shopId, :operationType, :provider, :model, :requestId,
        :conversationId, :messageId, :productId,
        :inputTokens, :cachedInputTokens, :outputTokens, :reasoningTokens,
        :embeddingTokens, :imageTokens, :imageCount, :retrySequence,
        :fallbackSequence, :latencyMs, :success, :estimatedCostUsd,
        :costUnknownReason, :sourceOfUsage, :pricingVersion
    )
    ON CONFLICT (request_id) DO NOTHING
`;

/**
 * Persist one usage record. Returns true when the row landed, false when the
 * database is unavailable or the row was a duplicate (idempotent no-op).
 * NEVER throws.
 */
async function insertUsageRow(rec) {
    try {
        const sequelize = getSequelize();
        if (!sequelize) return false;
        const row = projectLedgerRow(rec);
        await sequelize.query(INSERT_SQL, { replacements: row });
        return true;
    } catch (_) {
        // The ledger is observability: a database outage must not break the
        // reply path or double-record. The structured console event already
        // carries the same fields for the log pipeline.
        return false;
    }
}

const COST_STATUS = Object.freeze({
    LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE', // sink not reachable — UNKNOWN, never 0
    NO_DATA: 'NO_DATA',                       // reachable, nothing recorded — UNKNOWN, never 0
    UNKNOWN: 'UNKNOWN',                       // every recorded call lacks cost data
    PARTIAL: 'PARTIAL',                       // some recorded calls lack cost data
    COMPLETE: 'COMPLETE',                     // every recorded call has cost data
});

/** Postgres returns SUM() of NUMERIC/BIGINT as strings; SQLite returns numbers. */
const toNum = (value) => (value === null || value === undefined || value === '' ? 0 : Number(value) || 0);

function emptySummary(scope, costStatus, reason) {
    return {
        costStatus,
        costKnown: false,
        totalEstimatedCostUsd: null, // UNKNOWN — deliberately not 0
        calls: 0,
        knownCostCalls: 0,
        unknownCostCalls: 0,
        inputTokens: null,
        outputTokens: null,
        pricingVersion: null,
        scope,
        ...(reason ? { reason } : {}),
    };
}

/**
 * Read path for cost reporting. Summarizes persisted usage for a shop (or
 * globally when shopId is null) within an optional time window.
 *
 * Honesty contract (D-P2-04): when any call in scope has unknown cost,
 * totalEstimatedCostUsd is null (UNKNOWN) and unknownCostCalls counts the
 * holes; a fully-known scope returns the sum. An empty or unreachable ledger
 * also returns a null total — the absence of measurement is never a zero.
 */
async function summarizeUsage({ shopId = null, from = null, to = null, operationType = null } = {}) {
    const scope = { shopId: shopId || null, from: from || null, to: to || null, operationType: operationType || null };
    try {
        const sequelize = getSequelize();
        if (!sequelize) return emptySummary(scope, COST_STATUS.LEDGER_UNAVAILABLE, 'ledger_unavailable');

        const where = [];
        const replacements = {};
        if (shopId) { where.push('shop_id = :shopId'); replacements.shopId = shopId; }
        if (from) { where.push('occurred_at >= :from'); replacements.from = from; }
        if (to) { where.push('occurred_at <= :to'); replacements.to = to; }
        if (operationType) { where.push('operation_type = :operationType'); replacements.operationType = operationType; }

        const sql = `
            SELECT
                COUNT(*)                                                          AS calls,
                SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END)   AS known_cost_calls,
                SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END)        AS unknown_cost_calls,
                COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL
                    THEN estimated_cost_usd ELSE 0 END), 0)                        AS known_cost_usd,
                COALESCE(SUM(input_tokens), 0)                                      AS input_tokens,
                COALESCE(SUM(output_tokens), 0)                                     AS output_tokens,
                MAX(pricing_version)                                               AS pricing_version
            FROM ai_usage_ledger
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        `;
        const [rows] = await sequelize.query(sql, { replacements });
        const agg = rows?.[0] || {};
        const calls = toNum(agg.calls);
        const known = toNum(agg.known_cost_calls);
        const unknown = toNum(agg.unknown_cost_calls);

        if (calls === 0) return { ...emptySummary(scope, COST_STATUS.NO_DATA, 'no_usage_recorded'), calls: 0 };

        let costStatus;
        if (known === 0) costStatus = COST_STATUS.UNKNOWN;
        else if (unknown > 0) costStatus = COST_STATUS.PARTIAL;
        else costStatus = COST_STATUS.COMPLETE;

        return {
            costStatus,
            costKnown: costStatus === COST_STATUS.COMPLETE,
            // COMPLETE → the sum. PARTIAL/UNKNOWN → null, never a truncated 0.
            totalEstimatedCostUsd: costStatus === COST_STATUS.COMPLETE ? toNum(agg.known_cost_usd) : null,
            knownCostUsd: toNum(agg.known_cost_usd), // partial sum, explicitly labeled
            calls,
            knownCostCalls: known,
            unknownCostCalls: unknown,
            inputTokens: toNum(agg.input_tokens),
            outputTokens: toNum(agg.output_tokens),
            pricingVersion: agg.pricing_version ?? null,
            scope,
        };
    } catch (_) {
        return emptySummary(scope, COST_STATUS.LEDGER_UNAVAILABLE, 'ledger_query_failed');
    }
}

module.exports = {
    COST_STATUS,
    insertUsageRow,
    summarizeUsage,
    projectLedgerRow,
    resetLedgerClientForTests,
    INSERT_SQL,
};
