const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const OrderItem = sequelize.define('OrderItem', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'orders',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    product_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'products',
            key: 'id'
        },
        onDelete: 'RESTRICT'
    },
    variant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
            model: 'product_variants',
            key: 'id'
        },
        onDelete: 'RESTRICT'
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
    },
    price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: 'Price per unit at the time of order'
    },
    total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: 'price * quantity'
    }
}, {
    tableName: 'order_items',
    underscored: true,
    timestamps: true
});

module.exports = OrderItem;
