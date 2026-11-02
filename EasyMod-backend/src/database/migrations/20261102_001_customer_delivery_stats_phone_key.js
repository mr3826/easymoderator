'use strict';

module.exports = {
    name: '20261102_001_customer_delivery_stats_phone_key',

    // Drift left open by 20260522_004: the entity CustomerDeliveryStats is keyed
    // by (phone, shop_id) and declares no customer_id column, but the squashed
    // initial schema kept `customer_id UUID NOT NULL UNIQUE`. Every real
    // findOrCreate from the delivery-outcome path (trackDeliveryOutcome) omits
    // customer_id, so on a fully migrated database each delivered/returned
    // courier webhook failed with a NOT NULL violation, 500'd the webhook, and
    // silently lost every RTO-outcome statistic. The CI integration suite
    // ('delivered outcome is recorded once') was the first test to execute the
    // path against the real migrated schema and caught it.
    up: async (sequelize) => {
        // Guarded so databases whose stats table was built from the entity
        // (no legacy customer_id column) also migrate cleanly.
        await sequelize.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'customer_delivery_stats'
                      AND column_name = 'customer_id'
                      AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE customer_delivery_stats ALTER COLUMN customer_id DROP NOT NULL;
                END IF;
            END $$;
        `);
        // The entity reads by (phone, shop_id) on every webhook and risk check.
        // Non-unique: the service relies on a shop-row lock plus findOrCreate,
        // and pre-existing legacy rows may contain duplicate phone groupings.
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_cds_phone_shop
                ON customer_delivery_stats(phone, shop_id)
                WHERE phone IS NOT NULL;
        `);
        console.log('[migration] 20261102_001_customer_delivery_stats_phone_key: UP complete');
    },

    down: async (sequelize) => {
        // Restoring NOT NULL is only safe when no row was ever written through
        // the phone-keyed path; re-applying it would hard-fail otherwise, so
        // the reversal only drops the index added above.
        await sequelize.query(`DROP INDEX IF EXISTS idx_cds_phone_shop;`);
        console.log('[migration] 20261102_001_customer_delivery_stats_phone_key: DOWN partial (index only; NOT NULL is not restorable once phone-keyed rows exist)');
    },
};
