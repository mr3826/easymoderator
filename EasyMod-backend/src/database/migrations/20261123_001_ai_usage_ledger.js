'use strict';

/**
 * D-P2-04 — durable AI usage/cost ledger (additive only).
 *
 * The AI_USAGE_ACCOUNTING gate previously emitted one console.log line per AI
 * call and stored nothing. Production cost was therefore UNKNOWN and
 * unrecoverable after the container log rotated. This table is the durable
 * server-side sink the recorder writes when (and only when) that gate is on.
 *
 * Invariants encoded here (asserted by tests):
 *   - Additive: new table only; no existing table is altered. An image
 *     rollback does NOT revert this DDL and must keep working — the old image
 *     simply never writes to or reads from this table.
 *   - No PII: token counts, model/provider labels, opaque ids, latency, cost.
 *     There is deliberately no text column: no prompt, no reply, no customer
 *     content can be stored even if a caller tried.
 *   - Unknown cost is NULL, never 0. estimated_cost_usd NULL plus
 *     cost_unknown_reason keeps the ledger honest (mirrors cost.service.js
 *     rule 1+2: unknown never silently becomes zero).
 *   - Idempotent: unique index on request_id (NULLs allowed — a caller with no
 *     request label is recorded once per process without dedupe, matching the
 *     recorder's claimOnce semantics).
 *   - Portable DDL: no PG-only defaults (occurred_at is app-supplied), so the
 *     statement parses on both Postgres and SQLite like the other ledgers.
 */

module.exports = {
    name: '20261123_001_ai_usage_ledger',

    up: async (sequelize) => {
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_ledger (
                id                  UUID PRIMARY KEY,
                occurred_at         TIMESTAMPTZ NOT NULL,
                shop_id             UUID REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
                operation_type      VARCHAR(64),
                provider            VARCHAR(32),
                model               VARCHAR(128),
                request_id          VARCHAR(128),
                conversation_id     UUID,
                message_id          UUID,
                product_id          UUID,
                input_tokens        BIGINT,
                cached_input_tokens BIGINT,
                output_tokens       BIGINT,
                reasoning_tokens    BIGINT,
                embedding_tokens    BIGINT,
                image_tokens        BIGINT,
                image_count         INTEGER NOT NULL DEFAULT 0,
                retry_sequence      SMALLINT NOT NULL DEFAULT 0,
                fallback_sequence   SMALLINT NOT NULL DEFAULT 0,
                latency_ms          INTEGER,
                success             BOOLEAN NOT NULL DEFAULT TRUE,
                estimated_cost_usd  NUMERIC(14,8),
                cost_unknown_reason VARCHAR(64),
                source_of_usage     VARCHAR(32),
                pricing_version     VARCHAR(32)
            );
        `);
        // Idempotency backstop for restarts (the Redis claim is best effort).
        // Postgres treats NULLs as distinct, so usage lines without a request
        // label are never collapsed by this index.
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_ledger_request
                ON ai_usage_ledger(request_id);
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_shop_time
                ON ai_usage_ledger(shop_id, occurred_at);
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_time
                ON ai_usage_ledger(occurred_at);
        `);
    },

    down: async (sequelize) => {
        await sequelize.query('DROP TABLE IF EXISTS ai_usage_ledger;');
    },
};
