const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const { CUSTOMER_CHANNEL_TYPES } = require('./customer-channels');

const Customer = sequelize.define('Customer', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
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
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    channel_type: {
        // Same canonical list the customer-intelligence filter validates
        // against; order matches the live Postgres enum exactly.
        type: DataTypes.ENUM(...CUSTOMER_CHANNEL_TYPES),
        allowNull: false
    },
    channel_user_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    // Messenger/Instagram user IDs are Page-scoped. Keep the owning channel
    // on the customer row so profile enrichment cannot merge two Pages.
    meta_channel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
            model: 'meta_channels',
            key: 'id',
        },
        onDelete: 'SET NULL',
    },
    language_preference: {
        type: DataTypes.ENUM('bangla', 'english', 'banglish'),
        allowNull: true
    },
    phone: {
        type: DataTypes.STRING,
        allowNull: true
    },
    email: {
        type: DataTypes.STRING,
        allowNull: true
    },
    last_active: {
        type: DataTypes.DATE,
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        defaultValue: {}
    },
    // Per-channel consent (Phase 5: single source of truth).
    // Shape: { facebook: { opted_in, opted_out_at, last_inbound_at },
    //          instagram: { opted_in, opted_out_at, last_inbound_at } }
    messaging_consent: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false
    }
}, {
    tableName: 'customers',
    underscored: true,
    timestamps: true,
    scopes: {
        shopScoped(shopId) {
            return { where: { shop_id: shopId } };
        }
    },
    indexes: [
        {
            unique: true,
            fields: ['shop_id', 'phone']
        },
        {
            unique: true,
            fields: ['shop_id', 'email']
        },
        {
            // Primary webhook lookup: find-or-create customer on every inbound message
            fields: ['shop_id', 'channel_type', 'channel_user_id']
        },
        {
            unique: true,
            fields: ['shop_id', 'channel_type', 'meta_channel_id', 'channel_user_id'],
            where: { meta_channel_id: { [require('sequelize').Op.ne]: null } },
        },
        {
            // Data-deletion callback: delete by channel_user_id across all shops
            fields: ['channel_user_id']
        }
    ],
    hooks: {
        beforeDestroy: (customer, options) => {
            customer.phone = null;
            customer.email = null;
            customer.name = null;
        }
    }
});
// ...existing code...

module.exports = Customer;
