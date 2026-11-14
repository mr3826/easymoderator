const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const Shop = sequelize.define('Shop', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    unique_code: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: true
    },
    tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'tenants',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    shop_name: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    timezone: {
        type: DataTypes.STRING(50),
        defaultValue: 'Asia/Dhaka'
    },
    business_hours: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {
            start: '09:00',
            end: '22:00',
            days: [0, 1, 2, 3, 4, 5, 6]
        }
    },
    settings: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {}
    },
    // ----- Business-wide AI emergency stop (ADR-0013 §6) -----
    // Dedicated, audited storage — deliberately outside the merchant-writable
    // `settings` JSON so general shop writers cannot toggle a safety control.
    // Engage also writes settings.ai.automation_mode = MANUAL (rollback belt).
    ai_emergency_stop: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'True = no automatic AI sends on any channel; bypass-proof. Engage also sets business mode MANUAL.',
    },
    ai_emergency_stop_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When the current emergency stop was engaged.',
    },
    ai_emergency_stop_by: {
        type: DataTypes.UUID,
        allowNull: true,
        comment: 'Actor who engaged the current emergency stop.',
    },
    ai_emergency_stop_source: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'merchant | admin — controls who may resume the stop.',
    },
    ai_emergency_stop_prior_mode: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Business automation mode snapshotted at engage; preserved on repeat engage. Never auto-restored on resume.',
    },
    config_version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
    }
}, {
    tableName: 'shops',
    underscored: true,
    timestamps: true
});

module.exports = Shop;
