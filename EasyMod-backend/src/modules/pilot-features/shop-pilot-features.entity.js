'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

/**
 * Platform-controlled pilot flags, one row per shop. Written only through the
 * SUPER_ADMIN admin API — never through shops.settings, which any shop member
 * can patch (ADR-0009). An absent row means every pilot feature is off.
 */
const ShopPilotFeatures = sequelize.define('ShopPilotFeatures', {
    shop_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: { model: 'shops', key: 'id' },
        onDelete: 'CASCADE',
    },
    customer_intelligence: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    order_confidence_mode: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'off',
    },
    order_confidence_config: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
    },
    // Pilot+ V1 feature flags (docs/pilot-plus-v1/03 §9 D8) — default OFF.
    interaction_choices: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    action_queue: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    knowledge_suggestions: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    // Founder pilot flags are platform-controlled and remain off by default.
    ads_studio: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    storefront: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    ai_reply_shadow_meter: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    ai_reply_shadow_meter_enabled_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    updated_by: {
        type: DataTypes.UUID,
        allowNull: true,
    },
}, {
    tableName: 'shop_pilot_features',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
});

module.exports = ShopPilotFeatures;
