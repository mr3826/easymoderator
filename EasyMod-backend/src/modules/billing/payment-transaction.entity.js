const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const PaymentTransaction = sequelize.define('PaymentTransaction', {
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
    shop_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'shops',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    // The exact account shown to the customer (§1.3-003, §6 "no silent number
    // switching"). Nullable so historical/billing-era rows stay valid. FK +
    // non-unique index created by migration 20261127_001; (shop_id,transaction_id)
    // uniqueness by 20261127_002.
    payment_account_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
            model: 'payment_accounts',
            key: 'id'
        },
        onDelete: 'SET NULL',
        comment: 'payment_accounts.id that was used for this attempt'
    },
    payment_method: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'Payment method (provider vocabulary): bkash, nagad, rocket, aamarpay, sslcommerz, cod, self-mfs'
    },
    payment_gateway: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Gateway used: bkash, nagad, aamarpay, sslcommerz'
    },
    transaction_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'Gateway transaction ID or payment reference'
    },
    amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: 'Payment amount in BDT'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending, initiated, payment_claimed, processing, paid, verified, failed, rejected (payment-taxonomy §1.3-003)'
    },
    gateway_response: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Raw response from payment gateway'
    },
    verified_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'When payment was verified'
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'payment_transactions',
    underscored: true,
    timestamps: true,
    indexes: [
        { fields: ['order_id'] },
        { fields: ['shop_id'] },
        { fields: ['transaction_id'] },
        { fields: ['payment_method'] },
        { fields: ['status'] },
        { fields: ['shop_id', 'status'] },
        { fields: ['created_at'] }
    ]
});

module.exports = PaymentTransaction;
