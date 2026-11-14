'use strict';

/**
 * 20261114_005 — business-wide AI emergency stop (ADR-0013 §6, §10).
 *
 * Five additive columns on `shops`. The flag is dedicated storage so it cannot
 * be reached through the merchant-writable `settings` JSON. Engaging the stop
 * also writes `MANUAL` through the existing business setting (rollback belt), so
 * old code that ignores these columns still fails closed. Nothing is backfilled;
 * the NOT NULL default is FALSE for every existing row.
 */
module.exports = {
    name: '20261114_005_shop_ai_emergency_stop',

    up: async (sequelize) => {
        await sequelize.query(`
            ALTER TABLE shops
              ADD COLUMN IF NOT EXISTS ai_emergency_stop BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS ai_emergency_stop_at TIMESTAMPTZ NULL,
              ADD COLUMN IF NOT EXISTS ai_emergency_stop_by UUID NULL,
              ADD COLUMN IF NOT EXISTS ai_emergency_stop_source TEXT NULL,
              ADD COLUMN IF NOT EXISTS ai_emergency_stop_prior_mode TEXT NULL;
        `);
        await sequelize.query(
            `COMMENT ON COLUMN shops.ai_emergency_stop IS `
            + `'Business-wide AI emergency stop. True = no automatic AI sends on any channel; bypass-proof. `
            + `Engage also sets settings.ai.automation_mode=MANUAL (rollback belt). Resume clears flag only; mode stays MANUAL.';`
        );
    },

    down: async (sequelize) => {
        await sequelize.query(`
            ALTER TABLE shops
              DROP COLUMN IF EXISTS ai_emergency_stop,
              DROP COLUMN IF EXISTS ai_emergency_stop_at,
              DROP COLUMN IF EXISTS ai_emergency_stop_by,
              DROP COLUMN IF EXISTS ai_emergency_stop_source,
              DROP COLUMN IF EXISTS ai_emergency_stop_prior_mode;
        `);
    },
};