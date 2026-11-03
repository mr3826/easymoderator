'use strict';

/**
 * COD reconciliation correctness (launch audit 2026-11-03).
 *
 * Every statement line now carries WHY it matched:
 *   state            → PROVIDER_REPORTED | MATCHED | DIFFERENCE_FOUND |
 *                      UNDERPAID_REVIEW | UNMATCHED | INCOMPLETE_EVIDENCE
 *   expected_amount  → gross COD the linked orders expect the courier to
 *                      collect; NULL while linkage/basis is unresolved.
 *
 * The legacy `expected_amount` column was dropped by 20260611_003 as unused
 * drift; the service now needs it, so it is re-added here (guarded for
 * databases that never applied that sweep). Existing rows keep their history:
 * `state` defaults to PROVIDER_REPORTED (stored, not yet evaluated) rather than
 * guessing a match, and expected_amount stays NULL until the service evaluates
 * a future import.
 */
module.exports = {
    name: '20261103_001_courier_collection_recon_state',

    up: async (sequelize) => {
        await sequelize.query(`
            ALTER TABLE courier_cod_collections
                ADD COLUMN IF NOT EXISTS state VARCHAR(32) NOT NULL DEFAULT 'PROVIDER_REPORTED';
        `);
        await sequelize.query(`
            ALTER TABLE courier_cod_collections
                ADD COLUMN IF NOT EXISTS expected_amount DECIMAL(12,2);
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ccc_shop_state
                ON courier_cod_collections(shop_id, state);
        `);
        console.log('[migration] 20261103_001_courier_collection_recon_state: UP complete');
    },

    down: async (sequelize) => {
        await sequelize.query(`DROP INDEX IF EXISTS idx_ccc_shop_state;`);
        await sequelize.query(`ALTER TABLE courier_cod_collections DROP COLUMN IF EXISTS state;`);
        await sequelize.query(`ALTER TABLE courier_cod_collections DROP COLUMN IF EXISTS expected_amount;`);
        console.log('[migration] 20261103_001_courier_collection_recon_state: DOWN complete');
    },
};