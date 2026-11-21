'use strict';

/**
 * 20261122_001 — backfill: clear webhook verification stamps that no longer
 * have a connected channel behind them (D2 / A5-2).
 *
 * The D2 code fix stops NEW unsupported stamps from being written (disable,
 * degrade, disconnect, released claim, token-refresh failure). Rows that
 * degraded BEFORE that fix still carry webhook_last_verified_at +
 * webhook_subscribed_fields, so the channel health grid shows Webhook
 * "Active" and setup-status still counts them verified — the exact stale-stamp
 * symptom, one row at a time.
 *
 * Purely a data UPDATE on one table (no DDL, no new columns/indexes), so the
 * reader floor image is unaffected: old code keeps reading the same columns.
 * `webhook_subscribed_fields` is JSONB DEFAULT '[]' (20260520_000:982) — the
 * array-empty literal is the model's own clear value (code writes [] via
 * Sequelize), not '{}'.
 *
 * down is a REQUIRED EXPORT by src/database/migrate.js's validator but is a
 * NO-OP BY DESIGN: the original stamp values are destroyed deliberately and
 * cannot be safely restored; they reappear naturally on the next successful
 * probe/reconnect. A "real" down would reintroduce the misreported health.
 */
module.exports = {
    name: '20261122_001_clear_stale_webhook_stamps',

    up: async (sequelize) => {
        await sequelize.query(`
            UPDATE meta_channels
               SET webhook_last_verified_at = NULL,
                   webhook_subscribed_fields = '[]'::jsonb
             WHERE status <> 'CONNECTED'
               AND (
                     webhook_last_verified_at IS NOT NULL
                     OR webhook_subscribed_fields IS NOT NULL
                        AND webhook_subscribed_fields <> '[]'::jsonb
                   );
        `);
    },

    down: async () => {
        // Intentional no-op — see header comment.
    },
};
