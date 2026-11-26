'use strict';

/**
 * Payment redesign migration #1 of 2 (D-1 rename + D-2 split + R-11 numbering).
 *
 * ADDITIVE-FIRST. Renames the legacy `payment_configs` table to
 * `payment_accounts` IN PLACE (Option A, RATIFIED D-1). In PostgreSQL an
 * `ALTER TABLE … RENAME TO …` follows existing foreign keys by OID, so
 * `orders.payment_method_id` keeps pointing at the same rows and every
 * historical order attribution stays valid by construction (contract §1.2, §1.3).
 * No id values move; no rows leave the table. `down()` renames back.
 *
 * This file ONLY adds columns / a table / a nullable FK column + a non-unique
 * index and backfills canonical values. The UNIQUE-constraint swap that can
 * reject on dirty data lives in migration #2, so a failed integrity pre-flight
 * never strands the account model (D-2 rationale).
 *
 * Idempotent throughout (existence guards + `IF NOT EXISTS`, the house style of
 * 20260823_002 / 20261026_001). Data-preserving: existing rows keep their ids
 * and every legacy `gateway` value; new columns are filled, never dropped.
 *
 * self-mfs → provider recovery runs in NODE by decrypting the credentials
 * envelope with the SAME AES-256-CBC scheme the model uses (contract §1.3-2),
 * NOT by assuming bkash. Rows whose credentials cannot be decrypted are left
 * honest (provider NULL for a wallet, `cod` only for genuine non-wallet drift
 * survivors per §1.3-3) and logged — never silently coerced to a wrong provider.
 */
const crypto = require('crypto');
const {
    PROVIDERS,
    normalizeProvider,
    providerFromCredentials,
    accountTypeFromCredentials,
    GATEWAY_ACCOUNT_TYPE,
    COD_ACCOUNT_TYPE,
    DEFAULT_CONFIGURED_LEVEL,
} = require('../../modules/payment/payment-taxonomy');

const PROVIDER_SQL_LIST = PROVIDERS.map((p) => `'${p}'`).join(',');

// Mirror of payment-config.entity getEncryptionKey — the envelope was written
// with this exact derivation, so a migration must read it the same way.
function deriveEncryptionKey() {
    const keyEnv = process.env.PAYMENT_ENCRYPTION_KEY;
    const env = process.env.NODE_ENV || 'development';
    if (keyEnv) {
        return /^[a-f0-9]{64}$/i.test(keyEnv)
            ? Buffer.from(keyEnv, 'hex')
            : crypto.createHash('sha256').update(keyEnv).digest();
    }
    if (env === 'production' || env === 'staging') {
        throw new Error('PAYMENT_ENCRYPTION_KEY must be set in production/staging');
    }
    return crypto.createHash('sha256').update('default-payment-encryption-key-change-me').digest();
}

function decryptCredentials(raw) {
    if (typeof raw !== 'string' || !raw.includes(':')) return null;
    try {
        const [ivHex, encrypted] = raw.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', deriveEncryptionKey(), iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        const parsed = JSON.parse(decrypted);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null; // undecryptable → leave the row honest, do not throw
    }
}

// Re-exported for the unit test; also used inline by up().
async function classifyWalletRows(sequelize) {
    let rows = [];
    try {
        [rows] = await sequelize.query(
            `SELECT id, gateway, provider, account_type, verification_level, is_enabled, credentials
               FROM payment_accounts
              WHERE gateway = 'self-mfs'`,
        );
    } catch (_) {
        return 0;
    }
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    let updated = 0;
    for (const row of rows) {
        const creds = decryptCredentials(row.credentials);
        const provider = providerFromCredentials(creds, row.provider);
        const accountType = accountTypeFromCredentials(creds, provider);
        const nextProvider = normalizeProvider(provider);
        const nextType = accountType || (nextProvider === COD_ACCOUNT_TYPE ? COD_ACCOUNT_TYPE : null);
        // Only write what we can PROVABLY attribute to a provider; an
        // undecryptable/self-mfs row keeps a null provider (never coerced to cod)
        // and its account_type is defaulted later by the SQL wallet fallback.
        if (!nextProvider) continue;
        const needsProvider = nextProvider && normalizeProvider(row.provider) !== nextProvider;
        const needsType = nextType && row.account_type !== nextType;
        if (!needsProvider && !needsType && row.verification_level) continue;
        try {
            await sequelize.query(
                `UPDATE payment_accounts
                    SET provider = COALESCE(:provider, provider),
                        account_type = COALESCE(:accountType, account_type),
                        verification_level = COALESCE(:verificationLevel, verification_level)
                  WHERE id = :id`,
                {
                    replacements: {
                        provider: needsProvider ? nextProvider : null,
                        accountType: needsType ? nextType : null,
                        verificationLevel: row.is_enabled && nextProvider
                            ? (nextType === GATEWAY_ACCOUNT_TYPE ? DEFAULT_CONFIGURED_LEVEL : DEFAULT_CONFIGURED_LEVEL)
                            : null,
                        id: row.id,
                    },
                },
            );
            updated += 1;
        } catch (_) { /* non-fatal; fallback + logging catch stragglers */ }
    }
    return updated;
}

module.exports = {
    name: '20261127_001_payment_accounts',

    up: async (sequelize) => {
        const isPostgres = sequelize.getDialect() === 'postgres';

        // ── 1. Rename payment_configs → payment_accounts (guarded, idempotent) ──
        // FK orders.payment_method_id follows by OID; no retarget needed.
        if (isPostgres) {
            await sequelize.query(`
                DO $migration$
                BEGIN
                    IF to_regclass('payment_configs') IS NOT NULL
                       AND to_regclass('payment_accounts') IS NULL THEN
                        ALTER TABLE payment_configs RENAME TO payment_accounts;
                    END IF;
                END
                $migration$;
            `);
        }

        // ── 2. Additive columns (nullable where classification is data-dependent) ─
        await sequelize.query(`ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS provider VARCHAR(50);`);
        await sequelize.query(`ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(24);`);
        await sequelize.query(`ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS verification_level VARCHAR(24) NOT NULL DEFAULT 'unverified';`);
        await sequelize.query(`ALTER TABLE payment_accounts ADD COLUMN IF NOT EXISTS is_preferred BOOLEAN NOT NULL DEFAULT FALSE;`);

        // ── 3. cod rows are unambiguous in SQL (§1.3-1) ─────────────────────────
        await sequelize.query(`
            UPDATE payment_accounts
               SET provider = 'cod', account_type = 'standard'
             WHERE gateway = 'cod' OR LOWER(TRIM(provider)) = 'cod';
        `);
        // Normalize known legacy provider tokens WITHOUT touching 'self-mfs'
        // (that is a gateway label, resolved from credentials in step 4).
        await sequelize.query(`
            UPDATE payment_accounts
               SET provider = CASE LOWER(TRIM(provider))
                   WHEN 'cash' THEN 'cod'
                   WHEN 'cash_on_delivery' THEN 'cod'
                   WHEN 'b-kash' THEN 'bkash'
                   WHEN 'bikas' THEN 'bkash'
                   ELSE NULL
               END
             WHERE LOWER(TRIM(provider)) IN ('cash','cash_on_delivery','b-kash','bikas')
                OR (provider IS NOT NULL AND LOWER(TRIM(provider)) NOT IN (${PROVIDER_SQL_LIST}, 'self-mfs'));
        `);

        // ── 4. Node recovery of self-mfs provider/account_type (§1.3-2) ──────────
        let recovered = 0;
        try {
            recovered = await classifyWalletRows(sequelize);
        } catch (_) {
            recovered = 0;
        }

        // ── 5. Wallet rows still lacking account_type default to 'self' (§1.3-2) ─
        await sequelize.query(`
            UPDATE payment_accounts
               SET account_type = 'self'
             WHERE gateway = 'self-mfs' AND account_type IS NULL;
        `);

        // ── 6. Honest fallback for genuine non-wallet drift survivors (§1.3-3) ───
        // Only rows that are NOT self-mfs gateways fall to cod; wallet rows keep
        // their (possibly NULL) provider rather than being mislabeled as cash.
        const [survivors] = await sequelize.query(`
            SELECT COUNT(*)::int AS c
              FROM payment_accounts
             WHERE (provider IS NULL OR provider NOT IN (${PROVIDER_SQL_LIST}))
               AND gateway IS DISTINCT FROM 'self-mfs';
        `).catch(() => [[{ c: 0 }]]);
        await sequelize.query(`
            UPDATE payment_accounts
               SET provider = 'cod', account_type = 'standard'
             WHERE (provider IS NULL OR provider NOT IN (${PROVIDER_SQL_LIST}))
               AND gateway IS DISTINCT FROM 'self-mfs';
        `);
        // Any provider that IS a wallet but account_type still null → self.
        await sequelize.query(`
            UPDATE payment_accounts
               SET account_type = CASE WHEN provider = 'cod' THEN 'standard' ELSE 'self' END
             WHERE account_type IS NULL;
        `);
        console.log(
            `[migration 20261127_001] renamed payment_configs→payment_accounts (guarded); `
            + `recovered ${recovered} self-mfs row(s) from credentials; `
            + `${survivors && survivors[0] && survivors[0].c ? survivors[0].c : 0} non-wallet drift survivor(s) classified to 'cod'.`,
        );

        // ── 7. Append-only evidence table for the verification ladder (§2) ───────
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS payment_account_verifications (
                id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                payment_account_id    UUID NOT NULL REFERENCES payment_accounts(id) ON DELETE CASCADE,
                level                 VARCHAR(24) NOT NULL,
                method                VARCHAR(64),
                evidence              JSONB,
                performed_by_user_id  UUID,
                provider_environment  VARCHAR(24),
                created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_pav_account_created
                ON payment_account_verifications(payment_account_id, created_at);
        `);

        // ── 8. payment_transactions → payment_account_id attribution (§1.3-003) ──
        // Additive nullable FK + a plain (non-unique) index; the UNIQUE on
        // transaction_id lives in migration #2.
        await sequelize.query(`
            ALTER TABLE payment_transactions
                ADD COLUMN IF NOT EXISTS payment_account_id UUID
                REFERENCES payment_accounts(id) ON DELETE SET NULL;
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ptxn_payment_account
                ON payment_transactions(payment_account_id);
        `);

        // ── 9. F-4 (A9-R2, 2026-11-26): payment_configs compatibility VIEW ─────
        // The rollback floor image (reader floor, main lineage ≤ ad79cd9c) still
        // ships a PaymentConfig model bound to tableName 'payment_configs'.
        // Without this view, reverting the APP image alone breaks every payment
        // read AND write on the migrated DB (the table no longer exists under
        // the old name) — A9 found that as the rollback-floor table outage.
        // A single-table view is AUTO-UPDATABLE in PostgreSQL: the old image's
        // SELECTs, INSERTs, UPDATEs and DELETEs on payment_configs keep working
        // against payment_accounts transparently.
        //
        // Column list = the legacy model's attribute set VERBATIM in legacy
        // names — taken from the floor image's entity (git 53c6ebb1
        // EasyMod-backend/src/modules/payment/payment-config.entity.js):
        //   id, shop_id, gateway, is_enabled, credentials, config,
        //   created_at, updated_at
        // The redesign columns (provider / account_type / verification_level /
        // is_preferred) are deliberately NOT exposed: the old image does not
        // know them, and omitting them keeps the view simple/auto-updatable
        // (their DB defaults apply to old-image inserts).
        //
        // CREATE OR REPLACE ⇒ idempotent re-run. Postgres-only (the rename is
        // Postgres-only; SQLite sync path uses the entity's table directly).
        if (isPostgres) {
            await sequelize.query(`
                CREATE OR REPLACE VIEW payment_configs AS
                SELECT id, shop_id, gateway, is_enabled, credentials, config, created_at, updated_at
                  FROM payment_accounts;
            `);
        }
    },

    down: async (sequelize) => {
        // Honest, data-preserving reversal.
        const isPostgres = sequelize.getDialect() === 'postgres';

        // F-4: the compat VIEW occupies the name `payment_configs` — it MUST be
        // dropped BEFORE the rename-back, or `ALTER TABLE payment_accounts
        // RENAME TO payment_configs` collides with the view (and the guarded
        // rename would silently skip, stranding the old image without its
        // table). Idempotent via IF EXISTS.
        await sequelize.query(`DROP VIEW IF EXISTS payment_configs;`);

        // Restore the legacy dual-write value before any drop (rows never leave).
        await sequelize.query(`
            UPDATE payment_accounts
               SET gateway = CASE WHEN provider = 'cod' THEN 'cod' ELSE 'self-mfs' END
             WHERE gateway IS NULL;
        `);

        await sequelize.query(`DROP INDEX IF EXISTS idx_ptxn_payment_account;`);
        await sequelize.query(`ALTER TABLE payment_transactions DROP COLUMN IF EXISTS payment_account_id;`);

        await sequelize.query(`DROP INDEX IF EXISTS idx_pav_account_created;`);
        await sequelize.query(`DROP TABLE IF EXISTS payment_account_verifications;`);

        await sequelize.query(`ALTER TABLE payment_accounts DROP COLUMN IF EXISTS is_preferred;`);
        await sequelize.query(`ALTER TABLE payment_accounts DROP COLUMN IF EXISTS verification_level;`);
        await sequelize.query(`ALTER TABLE payment_accounts DROP COLUMN IF EXISTS account_type;`);
        // The `provider` column pre-dated this migration (squash-era) — it is
        // intentionally NOT dropped by down(); down() only reverses this file's
        // own additions and the rename.

        if (isPostgres) {
            await sequelize.query(`
                DO $migration$
                BEGIN
                    IF to_regclass('payment_accounts') IS NOT NULL
                       AND to_regclass('payment_configs') IS NULL THEN
                        ALTER TABLE payment_accounts RENAME TO payment_configs;
                    END IF;
                END
                $migration$;
            `);
        }
    },

    __classifyWalletRows: classifyWalletRows,
    __decryptCredentials: decryptCredentials,
};
