'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const Storefront = sequelize.define('Storefront', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    shop_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'shops', key: 'id' },
        onDelete: 'CASCADE',
    },
    slug: {
        type: DataTypes.STRING(80),
        allowNull: false,
        unique: true,
    },
    title: {
        type: DataTypes.STRING(160),
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    logo_url: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    settings: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: { delivery_fee: 0 },
    },
    is_published: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    published_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'storefronts',
    underscored: true,
    timestamps: true,
});

const StorefrontProduct = sequelize.define('StorefrontProduct', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    storefront_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'storefronts', key: 'id' },
        onDelete: 'CASCADE',
    },
    product_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onDelete: 'CASCADE',
    },
    variant_ids: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
    },
    position: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
}, {
    tableName: 'storefront_products',
    underscored: true,
    timestamps: true,
    indexes: [
        { unique: true, fields: ['storefront_id', 'product_id'] },
        { fields: ['storefront_id', 'position'] },
    ],
});

module.exports = { Storefront, StorefrontProduct };
