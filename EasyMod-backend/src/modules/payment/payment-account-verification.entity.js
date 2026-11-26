const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

/**
 * Append-only evidence ledger for the payment verification ladder (contract §2).
 *
 * One row per ladder event (configured / credentials_check / sandbox_create_query
 * / certify_live / demote …) with the recorded evidence and who performed it.
 * Rows are INSERT-only: the ladder is a history, not a mutable field. The
 * transition LOGIC lives in the A3 ladder service; this module owns only the
 * storage shape + (in payment.service) the read/write helpers.
 *
 * A `live_certified` row here is provider/owner-recorded evidence only — the app
 * never self-declares it (R-12). Nothing in this table implies a completed
 * settlement: `sandbox_verified` means the create→query handshake only (D-3).
 */
const PaymentAccountVerification = sequelize.define('PaymentAccountVerification', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    payment_account_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'payment_accounts',
            key: 'id',
        },
        onDelete: 'CASCADE',
    },
    level: {
        type: DataTypes.STRING(24),
        allowNull: false,
        comment: 'the ladder level this record attests (§2)',
    },
    method: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'e.g. credentials_check | sandbox_create_query | certify_live | configured',
    },
    evidence: {
        // A0 ruling (spec-audit #9): JSONB — the migration column (001) and every
        // other schema-audit-passing JSON column on these tables are JSONB; an
        // entity that says JSON drifts schema:audit against the real DB.
        type: DataTypes.JSONB,
        allowNull: true,
        comment: 'structured evidence; never stores raw provider secrets',
    },
    performed_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
    },
    provider_environment: {
        type: DataTypes.STRING(24),
        allowNull: true,
        comment: 'sandbox | production',
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
}, {
    tableName: 'payment_account_verifications',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false, // append-only ledger — no updated_at
});

module.exports = PaymentAccountVerification;
