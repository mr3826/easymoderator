'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const ShopAddon = sequelize.define('ShopAddon', {
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
    },
    addon_code: {
        type: DataTypes.STRING(40),
        allowNull: false,
        validate: { isIn: [['ADS_STUDIO', 'STOREFRONT']] },
    },
    enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    enabled_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
    },
    enabled_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'shop_addons',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['shop_id', 'addon_code'], name: 'idx_shop_addons_shop_code' }],
});

module.exports = ShopAddon;
