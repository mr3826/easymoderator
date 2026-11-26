'use strict';

/**
 * Migration #2 unit test — the constraint swap (D-1/D-8/§1.3-003). Fake-sequelize,
 * duplicate-reject convention from 20261026_001 (reject, never silently dedupe).
 */
const migration = require('../migrations/20261127_002_payment_account_constraints');

const makeSequelize = ({
    dialect = 'postgres',
    legacyProviderConstraint = 'payment_configs_shop_id_provider_key',
    accountDupes = [],
    preferredDupes = [],
    txnDupes = [],
    activeAttemptDupes = [],
    legacyGatewayDupes = [],
    selfMfsCount = 1,
    multiSelfMfs = [],
} = {}) => {
    const calls = [];
    return {
        getDialect: () => dialect,
        query: async (sql) => {
            calls.push(sql);
            if (/FROM pg_constraint/.test(sql)) {
                return [legacyProviderConstraint ? [{ conname: legacyProviderConstraint }] : [], {}];
            }
            if (/GROUP BY shop_id, provider, account_type/.test(sql)) return [accountDupes, {}];
            if (/GROUP BY shop_id\s+WHERE is_preferred/.test(sql) || /WHERE is_preferred = TRUE/.test(sql)) return [preferredDupes, {}];
            if (/GROUP BY shop_id, transaction_id/.test(sql)) return [txnDupes, {}];
            if (/GROUP BY order_id/.test(sql)) return [activeAttemptDupes, {}];
            if (/GROUP BY shop_id, gateway/.test(sql)) return [legacyGatewayDupes, {}];
            if (/SELECT COUNT\(\*\)::int AS c FROM payment_accounts WHERE gateway = 'self-mfs'/.test(sql)) return [[{ c: selfMfsCount }], {}];
            if (/WHERE gateway = 'self-mfs' GROUP BY shop_id HAVING COUNT\(\*\) > 1/.test(sql)) return [multiSelfMfs, {}];
            return [[], {}];
        },
        calls,
    };
};
const sqlOf = (s) => s.calls.join('\n');

describe('20261127_002_payment_account_constraints', () => {
    test('exports { name, up, down }', () => {
        expect(migration.name).toBe('20261127_002_payment_account_constraints');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('no-ops on non-postgres (sqlite sync path uses entity indexes)', async () => {
        const s = makeSequelize({ dialect: 'sqlite' });
        await migration.up(s);
        expect(s.calls).toHaveLength(0);
    });

    test('drops the squash-era provider constraint (looked up via pg_constraint) + legacy gateway index', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = sqlOf(s);
        expect(sql).toMatch(/FROM pg_constraint/);
        expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS payment_configs_shop_id_provider_key/);
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payment_configs_shop_gateway/);
    });

    test('creates the account-scoped partial unique + one-preferred + txn-id unique', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = sqlOf(s);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_accounts_shop_provider_type/);
        expect(sql).toMatch(/ON payment_accounts\(shop_id, provider, account_type\)/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_accounts_one_preferred/);
        expect(sql).toMatch(/ON payment_accounts\(shop_id\)\s+WHERE is_preferred = TRUE/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_shop_transaction_id/);
        expect(sql).toMatch(/ON payment_transactions\(shop_id, transaction_id\)/);
        expect(sql).toMatch(/WHERE transaction_id <> ''/);
        // §4.4 fold-in (A0 ruling): one active gateway attempt per order.
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_one_active_attempt_per_order/);
        expect(sql).toMatch(/ON payment_transactions\(order_id\)/);
        expect(sql).toMatch(/WHERE order_id IS NOT NULL AND status IN \('initiated','processing'\)/);
    });

    test('REFUSES when one order already holds two active attempts (§4.4 fold-in)', async () => {
        const s = makeSequelize({
            activeAttemptDupes: [{ order_id: 'o-1', occurrences: 2 }],
        });
        await expect(migration.up(s)).rejects.toThrow(/one-active-attempt-per-order/i);
        expect(sqlOf(s)).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_one_active_attempt_per_order/);
    });

    test('the active-attempt preflight EXCLUDES payment_claimed rows (D-4: merchant judgment, not DB money-state)', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const preflight = s.calls.find((sql) => /GROUP BY order_id/.test(sql));
        expect(preflight).toMatch(/status IN \('initiated','processing'\)/);
        expect(preflight).not.toMatch(/payment_claimed/);
    });

    test('REFUSES to enforce when payment_transactions already duplicate (shop, transaction_id)', async () => {
        const s = makeSequelize({ txnDupes: [{ shop_id: 'x', transaction_id: 'T1', occurrences: 2 }] });
        await expect(migration.up(s)).rejects.toThrow(/duplicated rows exist/i);
        expect(sqlOf(s)).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_shop_transaction_id/);
    });

    test('REFUSES when two accounts share (shop, provider, account_type)', async () => {
        const s = makeSequelize({ accountDupes: [{ shop_id: 'x', provider: 'bkash', account_type: 'self', occurrences: 2 }] });
        await expect(migration.up(s)).rejects.toThrow(/payment_accounts \(shop_id, provider, account_type\)/);
        expect(sqlOf(s)).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_accounts_shop_provider_type/);
    });

    test('REFUSES when a shop has two preferred rows', async () => {
        const s = makeSequelize({ preferredDupes: [{ shop_id: 'x', occurrences: 2 }] });
        await expect(migration.up(s)).rejects.toThrow(/preferred-per-shop/);
    });

    test('down refuses to recreate the legacy (shop, gateway) unique when rows would collide', async () => {
        const s = makeSequelize({ legacyGatewayDupes: [{ shop_id: 'x', gateway: 'self-mfs', occurrences: 2 }] });
        await expect(migration.down(s)).rejects.toThrow(/Cannot roll back 20261127_002/);
    });

    test('down reverses this file (drops new uniques, recreates legacy gateway unique) when safe', async () => {
        const s = makeSequelize({ legacyGatewayDupes: [], selfMfsCount: 0, multiSelfMfs: [] });
        await migration.down(s);
        const sql = sqlOf(s);
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payment_txn_one_active_attempt_per_order/);
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payment_txn_shop_transaction_id/);
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payment_accounts_one_preferred/);
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payment_accounts_shop_provider_type/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_configs_shop_gateway/);
    });
});
