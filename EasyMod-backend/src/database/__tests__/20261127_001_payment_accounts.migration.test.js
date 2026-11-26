'use strict';

/**
 * Migration #1 unit test — fake-sequelize, following the repo convention
 * (see 20261026_001_order_idempotency_unique.migration.test.js). Proves the
 * rename is guarded + additive, the ladder/verif table + payment_account_id FK
 * are created, self-mfs credentials are recovered in NODE (merchant_gateway vs
 * business), and NO existing row/id is destroyed (data-preservation).
 */
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const migration = require('../migrations/20261127_001_payment_accounts');

const defaultKey = () => crypto.createHash('sha256').update('default-payment-encryption-key-change-me').digest();
const encrypt = (obj) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', defaultKey(), iv);
    let enc = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
    enc += cipher.final('hex');
    return iv.toString('hex') + ':' + enc;
};

const makeSequelize = ({ walletRows = [], survivorCount = 0 } = {}) => {
    const calls = [];
    const updates = [];
    return {
        getDialect: () => 'postgres',
        models: {},
        query: async (sql, opts) => {
            calls.push({ sql, replacements: opts && opts.replacements });
            if (/FROM payment_accounts\s+WHERE gateway = 'self-mfs'/.test(sql) && /^\s*SELECT/i.test(sql)) {
                return [walletRows, { rowCount: walletRows.length }];
            }
            if (/SELECT COUNT\(\*\)::int AS c/.test(sql) && /survivor|DISTINCT FROM 'self-mfs'|IS NULL OR provider NOT IN/.test(sql)) {
                return [[{ c: survivorCount }], { rowCount: 1 }];
            }
            if (/UPDATE payment_accounts\s+SET provider = COALESCE/.test(sql)) {
                updates.push(opts.replacements);
                return [[], { rowCount: 1 }];
            }
            return [[], { rowCount: 0 }];
        },
        calls,
        updates,
    };
};

describe('20261127_001_payment_accounts', () => {
    test('exports { name, up, down } with the ratified number/name', () => {
        expect(migration.name).toBe('20261127_001_payment_accounts');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('rename is GUARDED (existence check), not unconditional', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = s.calls.map((c) => c.sql).join('\n');
        expect(sql).toMatch(/to_regclass\('payment_configs'\) IS NOT NULL/);
        expect(sql).toMatch(/to_regclass\('payment_accounts'\) IS NULL/);
        expect(sql).toMatch(/ALTER TABLE payment_configs RENAME TO payment_accounts/);
    });

    test('additive columns use IF NOT EXISTS and are NOT dropped for data-preservation', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = s.calls.map((c) => c.sql).join('\n');
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS account_type VARCHAR\(24\)/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS verification_level VARCHAR\(24\) NOT NULL DEFAULT 'unverified'/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_preferred BOOLEAN NOT NULL DEFAULT FALSE/);
        // Never deletes rows / drops the table / drops pre-existing columns in up()
        expect(sql).not.toMatch(/DELETE FROM payment_accounts/i);
        expect(sql).not.toMatch(/DROP TABLE/i);
        expect(sql).not.toMatch(/DROP COLUMN/i);
    });

    test('creates the append-only ladder table + payment_account_id FK + non-unique index', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = s.calls.map((c) => c.sql).join('\n');
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payment_account_verifications/);
        expect(sql).toMatch(/REFERENCES payment_accounts\(id\) ON DELETE CASCADE/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS payment_account_id UUID/);
        expect(sql).toMatch(/REFERENCES payment_accounts\(id\) ON DELETE SET NULL/);
        expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_ptxn_payment_account/);
        // this migration must NOT create the UNIQUE txn index — that is #2
        expect(sql).not.toMatch(/CREATE UNIQUE INDEX/);
    });

    test('cod backfill sets provider cod / account_type standard', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = s.calls.map((c) => c.sql).join('\n');
        expect(sql).toMatch(/SET provider = 'cod', account_type = 'standard'/);
        expect(sql).toMatch(/gateway = 'cod'/);
    });

    test('self-mfs credentials are recovered in NODE: bkash-business stays business, merchant creds → merchant_gateway (§1.3-2)', async () => {
        const s = makeSequelize({
            walletRows: [
                { id: 'a1', gateway: 'self-mfs', provider: 'self-mfs', account_type: null, verification_level: 'unverified', is_enabled: true, credentials: encrypt({ mfs_type: 'bkash', mfs_mode: 'business', mfs_number: '01700000000' }) },
                { id: 'a2', gateway: 'self-mfs', provider: 'self-mfs', account_type: null, verification_level: 'unverified', is_enabled: true, credentials: encrypt({ mfs_type: 'bkash', mfs_mode: 'merchant', app_key: 'k', app_secret: 's', username: 'u' }) },
                { id: 'a3', gateway: 'self-mfs', provider: 'self-mfs', account_type: null, verification_level: 'unverified', is_enabled: true, credentials: encrypt({ mfs_type: 'nagad', mfs_mode: 'self', mfs_number: '01800000000' }) },
            ],
        });
        const recovered = await migration.__classifyWalletRows(s);
        expect(recovered).toBe(3);
        const byId = Object.fromEntries(s.updates.map((u) => [u.id, u]));
        expect(byId.a1.provider).toBe('bkash');
        expect(byId.a1.accountType).toBe('business');
        // a2 has gateway creds → merchant_gateway (the today-lost distinction)
        expect(byId.a2.accountType).toBe('merchant_gateway');
        expect(byId.a2.provider).toBe('bkash');
        expect(byId.a3.provider).toBe('nagad');
        expect(byId.a3.accountType).toBe('self');
    });

    test('undecryptable self-mfs credentials are NOT misclassified as cod (§1.3-3 honesty)', async () => {
        const s = makeSequelize({
            walletRows: [
                { id: 'bad', gateway: 'self-mfs', provider: null, account_type: null, verification_level: null, is_enabled: true, credentials: 'not-encrypted-at-all' },
            ],
        });
        const recovered = await migration.__classifyWalletRows(s);
        expect(recovered).toBe(0); // nothing provable → no update
    });

    test('down() is honest: restores gateway dual-write, drops only THIS file\'s objects, keeps pre-existing provider column', async () => {
        const s = makeSequelize();
        await migration.down(s);
        const sql = s.calls.map((c) => c.sql).join('\n');
        expect(sql).toMatch(/DROP COLUMN IF EXISTS account_type/);
        expect(sql).toMatch(/DROP COLUMN IF EXISTS verification_level/);
        expect(sql).toMatch(/DROP COLUMN IF EXISTS is_preferred/);
        expect(sql).toMatch(/DROP TABLE IF EXISTS payment_account_verifications/);
        expect(sql).toMatch(/DROP COLUMN IF EXISTS payment_account_id/);
        expect(sql).toMatch(/ALTER TABLE payment_accounts RENAME TO payment_configs/);
        // provider pre-dated this migration → down() must NOT drop it
        expect(sql).not.toMatch(/DROP COLUMN IF EXISTS provider/);
        expect(sql).not.toMatch(/DROP TABLE IF EXISTS payment_accounts/);
    });
});
