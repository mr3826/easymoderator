'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const AiReplyShadowLedger = sequelize.define('AiReplyShadowLedger', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    shop_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'shops', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    },
    idempotency_key: {
        type: DataTypes.STRING(64),
        allowNull: false,
    },
    period_start: {
        type: DataTypes.DATEONLY,
        allowNull: false,
    },
    period_end: {
        type: DataTypes.DATEONLY,
        allowNull: false,
    },
    accepted_at: {
        type: DataTypes.DATE,
        allowNull: false,
    },
    plan_code: {
        type: DataTypes.STRING(16),
        allowNull: true,
    },
    reply_source: {
        type: DataTypes.STRING(24),
        allowNull: false,
    },
    units: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
}, {
    tableName: 'ai_reply_shadow_ledger',
    timestamps: false,
    underscored: true,
    indexes: [
        {
            name: 'ai_reply_shadow_ledger_shop_idempotency_unique',
            unique: true,
            fields: ['shop_id', 'idempotency_key'],
        },
        {
            name: 'ai_reply_shadow_ledger_shop_period_idx',
            fields: ['shop_id', 'period_start'],
        },
    ],
});

module.exports = { AiReplyShadowLedger };
