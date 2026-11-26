const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const crypto = require('crypto');

// AES-256-CBC (no authentication tag) — kept for payment credentials because
// existing encrypted rows in production used this algorithm. Meta tokens use
// AES-256-GCM (authenticated) in meta-integration.entity.js. Do not mix the
// two — decrypt with the algorithm that was used to encrypt.
const getEncryptionKey = () => {
    const keyEnv = process.env.PAYMENT_ENCRYPTION_KEY;
    const env = process.env.NODE_ENV || 'development';
    if (keyEnv) {
        // If it's hex, convert from hex; otherwise treat as string and hash
        if (/^[a-f0-9]{64}$/i.test(keyEnv)) {
            // Already 64 hex chars = 32 bytes
            return Buffer.from(keyEnv, 'hex');
        } else {
            // Hash the string to get consistent 32 bytes
            return crypto.createHash('sha256').update(keyEnv).digest();
        }
    }
    if (env === 'production' || env === 'staging') {
        throw new Error('PAYMENT_ENCRYPTION_KEY must be set in production/staging');
    }

    return crypto.createHash('sha256').update('default-payment-encryption-key-change-me').digest();
};

const ENCRYPTION_KEY = getEncryptionKey();

// NOTE: the table was renamed payment_configs → payment_accounts by migration
// 20261127_001 (D-1, Option A in-place rename; the orders FK follows by OID).
// The model keeps the `PaymentConfig` runtime identity for backward-compat with
// existing readers (§1.4 dual-write window) and is ALSO exported as
// `PaymentAccount` (module.exports.PaymentAccount) as the canonical name the
// redesign implies. One physical row = one account.
const PaymentConfig = sequelize.define('PaymentConfig', {
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
    // Canonical provider vocabulary (payment-taxonomy §1.1). Validated in the
    // service layer against PROVIDERS; not a DB ENUM to survive the compat window.
    provider: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'cod | bkash | nagad | rocket (canonical; backfilled in 20261127_001)'
    },
    // self | business | merchant_gateway | standard(cod). Distinguishes the
    // merchant gateway from a business wallet that the legacy mfs_mode collapsed (§1.1).
    account_type: {
        type: DataTypes.STRING(24),
        allowNull: true,
        comment: 'standard | self | business | merchant_gateway'
    },
    // LEGACY gateway label, kept for one release and DUAL-WRITTEN (§1.4):
    // cod → 'cod', any wallet → 'self-mfs'. Unchanged readers still key on it.
    gateway: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'LEGACY compat value (cod | self-mfs); dual-written from provider'
    },
    is_enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    // Squash-era flag, unused by the redesign; kept so an in-place schema/
    // data comparison never loses a pre-existing column. Dropped in a later release.
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // Verification ladder level (§2). Transitions happen ONLY via the A3 ladder
    // service; the save path may stamp configured_unverified and demote on change.
    verification_level: {
        type: DataTypes.STRING(24),
        allowNull: false,
        defaultValue: 'unverified',
        comment: 'unverified | configured_unverified | sandbox_verified | live_certified'
    },
    // DB truth for the single preferred account per shop (D-8). Partial unique
    // (shop_id) WHERE is_preferred is enforced by migration 20261127_002.
    is_preferred: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // Encrypted credentials stored as JSON
    credentials: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const value = this.getDataValue('credentials');
            if (!value) return null;
            try {
                // Decrypt and parse JSON
                const algorithm = 'aes-256-cbc';
                
                const parts = value.split(':');
                const iv = Buffer.from(parts[0], 'hex');
                const encrypted = parts[1];
                
                const decipher = crypto.createDecipheriv(algorithm, ENCRYPTION_KEY, iv);
                let decrypted = decipher.update(encrypted, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                
                return JSON.parse(decrypted);
            } catch (error) {
                console.error('Failed to decrypt credentials:', error.message);
                return null;
            }
        },
        set(value) {
            if (!value) {
                this.setDataValue('credentials', null);
                return;
            }
            try {
                // Encrypt JSON data
                const algorithm = 'aes-256-cbc';
                const iv = crypto.randomBytes(16);
                
                const cipher = crypto.createCipheriv(algorithm, ENCRYPTION_KEY, iv);
                let encrypted = cipher.update(JSON.stringify(value), 'utf8', 'hex');
                encrypted += cipher.final('hex');
                
                this.setDataValue('credentials', iv.toString('hex') + ':' + encrypted);
            } catch (error) {
                console.error('Failed to encrypt credentials:', error.message);
                throw new Error('Credential encryption failed: ' + error.message);
            }
        }
    },
    // Additional configuration options (non-sensitive)
    config: {
        type: DataTypes.JSON,
        defaultValue: {}
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
    tableName: 'payment_accounts',
    timestamps: true,
    underscored: true,
    indexes: [
        // One account per (shop, provider, account_type) — self / business /
        // merchant_gateway coexist. Migration 20261127_002 owns the partial form.
        {
            name: 'idx_payment_accounts_shop_provider_type',
            unique: true,
            fields: ['shop_id', 'provider', 'account_type'],
            where: '"provider" IS NOT NULL AND "account_type" IS NOT NULL',
        },
        // Exactly one preferred account per shop (D-8).
        {
            name: 'idx_payment_accounts_one_preferred',
            unique: true,
            fields: ['shop_id'],
            where: '"is_preferred" = TRUE',
        },
    ]
});

module.exports = PaymentConfig;
// Canonical redesign name for the same single-row-per-account model (§1.2).
module.exports.PaymentAccount = PaymentConfig;
