const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const Subscription = sequelize.define('Subscription', {
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
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
    },
    plan_code: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: 'MERCHANT'
    },
    plan_name: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'EasyModerator'
    },
    plan_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
    },
    billing_cycle: {
        type: DataTypes.ENUM('monthly', 'yearly', 'per_order'),
        allowNull: false,
        defaultValue: 'monthly'
    },
    // Partner (per_order) billing fields
    billing_model: {
        type: DataTypes.ENUM('flat_monthly', 'per_order'),
        allowNull: false,
        defaultValue: 'flat_monthly'
    },
    // ৳ charged per delivered order (null for flat plans)
    per_order_charge_bdt: {
        type: DataTypes.DECIMAL(6, 2),
        allowNull: true,
        defaultValue: null
    },
    // Legacy weekly accrual fields retained for old rows; month-end billing now
    // recomputes from orders.delivered_at and never writes these fields.
    partner_orders_this_week: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    partner_pending_invoice_amount: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    status: {
        // active         — the single MERCHANT delivered-order model
        // past_due       — a delivered-order invoice is overdue; billing dunning owns it
        // suspended      — a delivered-order invoice is materially overdue; AI paused
        // trialing/trial_expired remain readable for pre-migration rows only
        type: DataTypes.ENUM('active', 'inactive', 'cancelled', 'suspended', 'trialing', 'trial_expired', 'past_due'),
        allowNull: false,
        defaultValue: 'active'
    },
    // Usage counters. There is no conversation or order entitlement under
    // ADR-0011, so every limit defaults to the unlimited sentinel (-1).
    conversations_limit: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: -1
    },
    orders_limit: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: -1
    },
    products_limit: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: -1
    },
    // Current usage (resets monthly/yearly)
    conversations_used: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    orders_used: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    products_used: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    // Legacy overage fields retained for historical rows. New usage never writes
    // or invoices these fields; purchased/bonus credit uses topup_balance.
    extra_conversations: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    extra_charge: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
    },
    // Legacy conversation credit retained so historical rows remain readable.
    // No new credit is sold; the top-up programme is retired.
    topup_balance: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    // Legacy threshold debt column retained so old rows remain readable. The
    // retired grace-buffer flow no longer changes it.
    threshold_debt: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    // Features — available on every package; packages differ only by conversation quota.
    features: {
        type: DataTypes.JSON,
        defaultValue: {
            image_understanding: true,
            advanced_ai: true,
            priority_support: true,
            custom_branding: true
        }
    },
    // Billing dates
    current_period_start: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    current_period_end: {
        type: DataTypes.DATE,
        allowNull: false
    },
    next_billing_date: {
        type: DataTypes.DATE,
        allowNull: false
    },
    usage_reset_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    trial_ends_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    cancelled_at: {
        type: DataTypes.DATE,
        allowNull: true
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
    tableName: 'subscriptions',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            unique: true,
            fields: ['shop_id']
        },
        {
            fields: ['status']
        },
        {
            fields: ['next_billing_date']
        }
    ]
});

module.exports = Subscription;
