/**
 * MetaChannelSettings entity
 *
 * 1:1 with MetaChannel. Replaces the JSON blob in channel_configs.settings.
 * Stores per-channel AI and automation configuration.
 */

'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const MetaChannelSettings = sequelize.define('MetaChannelSettings', {
    channel_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: { model: 'meta_channels', key: 'id' },
        onDelete: 'CASCADE',
    },

    // ----- AI / automation mode -----
    ai_auto_reply: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    automation_mode: {
        type: DataTypes.ENUM('AI_ACTIVE', 'AI_SUGGEST_ONLY', 'HUMAN_ACTIVE', 'MANUAL', 'DRAFT'),
        allowNull: false,
        // Legacy compatibility field. Business-level settings are authoritative;
        // default conservatively to the same fail-closed value as the migration.
        defaultValue: 'MANUAL',
    },
    confidence_threshold_send: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0.75,
        comment: 'AI confidence >= this value triggers automatic send',
    },
    confidence_threshold_suggest: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 0.50,
        comment: 'AI confidence >= this value shows suggestion to human agent',
    },

    // ----- Per-channel automation overrides (ADR-0013) -----
    // Explicit overrides only; an absent key (or NULL for the whole object)
    // inherits the business default. automation_mode is narrow-only: the
    // effective mode is the most restrictive of business default and override.
    overrides: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null,
        comment: 'Explicit per-channel overrides {automation_mode, confidence_threshold, greeting}; NULL/absent key = inherit. Narrow-only mode.',
    },

    // ----- Business hours -----
    business_hours: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null,
        comment: [
            'Null = always active.',
            'Accepted shapes: { mon: { open: "09:00", close: "18:00" }, ... } or',
            '{ mon: [{ open, close }, ...], ... } (inside = any slot matches).',
            'Optional `timezone` (IANA) inside the object; falls back to the shop timezone, then Asia/Dhaka.',
            'Overnight ranges (close < open) are allowed; malformed values are treated as CLOSED (fail-closed).',
        ].join(' '),
    },

    // ----- Commerce -----
    allow_order_creation: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },

    // ----- Cosmetic label (Phase 4) -----
    // Merchant-facing tag to disambiguate multiple Pages/IG accounts of the
    // same shop. Does NOT change AI routing or product scope — see
    // [[product-positioning]]. Null = no label set.
    purpose_label: {
        type: DataTypes.STRING(64),
        allowNull: true,
        defaultValue: null,
        comment: 'Cosmetic per-channel tag (e.g. "Sales", "Live selling", "Regional"). Display only.',
    },

}, {
    tableName: 'meta_channel_settings',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
});

module.exports = MetaChannelSettings;
