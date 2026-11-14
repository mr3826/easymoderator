'use strict';

/**
 * Billing line — the immutable, tenant-scoped ledger of one commercial outcome
 * for one order under ADR-0011 (delivered-order model).
 *
 * Every terminal outcome is recorded exactly once:
 *   DELIVERED            -> line_kind 'billable'   amount_minor = unit price
 *   RETURNED / CANCELLED -> line_kind 'zero_rated' amount_minor = 0
 *
 * The row is the invoice's source of truth: the monthly job aggregates all
 * un-invoiced lines for a shop and stamps `invoice_id`. Reversals before
 * invoicing mutate the billable row in place into an explicit BDT 0 line so a
 * merchant still sees the order accounted for (ADR-0011 "Reversal rule").
 *
 * Money is integer poisha (BDT minor units) per docs/ai/AGENT_CONTRACTS.md §1.
 * `contract_version` records the commercial contract that priced the row.
 */

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const BillingLine = sequelize.define('BillingLine', {
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
    order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    },
    subscription_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
    },
    line_kind: {
        type: DataTypes.ENUM('billable', 'zero_rated'),
        allowNull: false,
    },
    outcome: {
        type: DataTypes.STRING(24),
        allowNull: false,
    },
    unit_price_minor: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    amount_minor: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    currency: {
        type: DataTypes.CHAR(3),
        allowNull: false,
        defaultValue: 'BDT',
    },
    contract_version: {
        type: DataTypes.STRING(16),
        allowNull: false,
    },
    idempotency_key: {
        type: DataTypes.STRING(64),
        allowNull: false,
    },
    source: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'courier_webhook',
    },
    provider: {
        type: DataTypes.STRING(32),
        allowNull: true,
    },
    occurred_at: {
        type: DataTypes.DATEONLY,
        allowNull: false,
    },
    invoice_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'invoices', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
    },
    metadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
    },
}, {
    tableName: 'billing_lines',
    timestamps: true,
    underscored: true,
    paranoid: true,
    indexes: [
        {
            name: 'billing_lines_shop_order_kind_unique',
            unique: true,
            fields: ['shop_id', 'order_id', 'line_kind'],
        },
        {
            // At most one billable row per order — the financial truth for an
            // order can never be charged twice, even if a reversal races.
            name: 'billing_lines_one_billable_per_order',
            unique: true,
            fields: ['order_id'],
            where: { line_kind: 'billable' },
        },
        {
            // Matches the deterministic key findOrCreate() looks up first.
            name: 'billing_lines_idempotency_key_unique',
            unique: true,
            fields: ['idempotency_key'],
        },
        {
            name: 'billing_lines_shop_occurred_idx',
            fields: ['shop_id', 'occurred_at'],
        },
        {
            name: 'billing_lines_invoice_idx',
            fields: ['invoice_id'],
        },
        {
            name: 'billing_lines_shop_invoice_kind_idx',
            fields: ['shop_id', 'invoice_id', 'line_kind'],
        },
    ],
});

module.exports = BillingLine;