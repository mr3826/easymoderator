'use strict';

async function ensureShadowLedgerConstraints(sequelize) {
    if (sequelize.getDialect?.() !== 'postgres') return;
    await sequelize.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_reply_shadow_ledger_source_check' AND conrelid = 'ai_reply_shadow_ledger'::regclass
            ) THEN
                ALTER TABLE ai_reply_shadow_ledger ADD CONSTRAINT ai_reply_shadow_ledger_source_check
                    CHECK (reply_source IN ('AUTO', 'DRAFT_APPROVAL'));
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_reply_shadow_ledger_units_check' AND conrelid = 'ai_reply_shadow_ledger'::regclass
            ) THEN
                ALTER TABLE ai_reply_shadow_ledger ADD CONSTRAINT ai_reply_shadow_ledger_units_check
                    CHECK (units = 1);
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ai_reply_shadow_ledger_period_check' AND conrelid = 'ai_reply_shadow_ledger'::regclass
            ) THEN
                ALTER TABLE ai_reply_shadow_ledger ADD CONSTRAINT ai_reply_shadow_ledger_period_check
                    CHECK (period_start < period_end);
            END IF;
        END;
        $$;
    `);
}

module.exports = {
    name: '20261101_002_ai_reply_shadow_ledger',

    up: async (sequelize) => {
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ai_reply_shadow_ledger (
                id UUID PRIMARY KEY,
                shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
                idempotency_key VARCHAR(64) NOT NULL,
                period_start DATE NOT NULL,
                period_end DATE NOT NULL,
                accepted_at TIMESTAMPTZ NOT NULL,
                plan_code VARCHAR(16),
                reply_source VARCHAR(24) NOT NULL,
                units INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT ai_reply_shadow_ledger_shop_idempotency_unique
                    UNIQUE (shop_id, idempotency_key),
                CONSTRAINT ai_reply_shadow_ledger_source_check
                    CHECK (reply_source IN ('AUTO', 'DRAFT_APPROVAL')),
                CONSTRAINT ai_reply_shadow_ledger_units_check CHECK (units = 1),
                CONSTRAINT ai_reply_shadow_ledger_period_check CHECK (period_start < period_end)
            );
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ai_reply_shadow_ledger_shop_period_idx
                ON ai_reply_shadow_ledger(shop_id, period_start);
        `);
        await ensureShadowLedgerConstraints(sequelize);
    },

    down: async (sequelize) => {
        await sequelize.query('DROP TABLE IF EXISTS ai_reply_shadow_ledger;');
    },
};
