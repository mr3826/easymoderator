'use strict';

/**
 * 20261114_004 — explicit per-channel automation overrides (ADR-0013 §10).
 *
 * Expand-only: a single nullable JSONB column. NULL (or an absent key inside the
 * object) means "inherit the business default", so every existing channel keeps
 * byte-identical behavior. No backfill, no data transform, no row writes.
 */
module.exports = {
    name: '20261114_004_channel_automation_overrides',

    up: async (sequelize) => {
        await sequelize.query(
            'ALTER TABLE meta_channel_settings ADD COLUMN IF NOT EXISTS overrides JSONB NULL;'
        );
        await sequelize.query(
            `COMMENT ON COLUMN meta_channel_settings.overrides IS `
            + `'Explicit per-channel automation overrides (automation_mode, confidence_threshold, greeting). `
            + `NULL or absent key = inherit business default. Narrow-only: effective mode = most-restrictive(business, override). `
            + `Legacy automation_mode/ai_auto_reply/confidence_threshold_send/suggest columns remain non-authoritative.';`
        );
    },

    down: async (sequelize) => {
        await sequelize.query(
            'ALTER TABLE meta_channel_settings DROP COLUMN IF EXISTS overrides;'
        );
    },
};