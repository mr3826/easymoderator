'use strict';

/**
 * Remediation migration unit test (PR-B, 2026-11-27). Unlike the 002 fake, the
 * stubs here are SHAPE-aware: the constraint lookup (unnest(con.conkey)) and
 * the index lookup (unnest(x.indkey)) answer independently, so the
 * self-verification loop in up() is actually exercised — the 002 lesson is
 * that a stub returning rows for ANY pg_constraint query hides a query that
 * matches nothing on real PG16.
 */
const migration = require('../migrations/20261127_003_payment_accounts_legacy_unique_drop');

const makeSequelize = ({
    dialect = 'postgres',
    constraints = ['payment_configs_shop_id_provider_key'],
    indexes = [],
    dupes = [],
    claimDupes = [],
    // whether the pending-claim index existence probe answers "visible"
    indexVisible = true,
    // when true, lookups keep answering even after the DDL (simulated failed drop)
    persistAfterDrop = false,
} = {}) => {
    const calls = [];
    let dropped = false;
    return {
        getDialect: () => dialect,
        query: async (sql) => {
            calls.push(sql);
            // NOTE: only LEGACY-object drops flip the "gone" flag — down()'s
            // own DROP INDEX (pending-claim unique) must not make the
            // already-present constraint probe answer empty.
            if (/DROP CONSTRAINT|DROP INDEX IF EXISTS (payment|idx_payment_accounts)/.test(sql)) dropped = true;
            const live = !(dropped && persistAfterDrop === false);
            if (/unnest\(con\.conkey\)/.test(sql)) return [live ? constraints.map((c) => ({ conname: c })) : [], {}];
            if (/unnest\(x\.indkey\)/.test(sql)) return [live ? indexes.map((i) => { const o = {}; o[i] = i; return o; }) : [], {}];
            if (/GROUP BY shop_id, provider/.test(sql)) return [dupes, {}];
            if (/status = 'payment_claimed'/.test(sql)) return [claimDupes, {}];
            if (/FROM pg_indexes/.test(sql)) return [indexVisible ? [{ present: 1 }] : [], {}];
            return [[], {}];
        },
        calls,
    };
};
const sqlOf = (s) => s.calls.join('\n');

describe('20261127_003_payment_accounts_legacy_unique_drop', () => {
    test('exports { name, up, down }', () => {
        expect(migration.name).toBe('20261127_003_payment_accounts_legacy_unique_drop');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('no-ops on non-postgres', async () => {
        const s = makeSequelize({ dialect: 'sqlite' });
        await migration.up(s);
        expect(s.calls).toHaveLength(0);
    });

    test('REGRESSION PIN: the constraint match uses the CONSTRAINT column list (LATERAL unnest(conkey)), never a whole-table pg_attribute join', async () => {
        const s = makeSequelize();
        await migration.up(s);
        // 002's bug verbatim: joining pg_attribute without conkey aggregation.
        expect(migration.__FIND_LEGACY_CONSTRAINT).toContain('unnest(con.conkey) WITH ORDINALITY');
        expect(migration.__FIND_LEGACY_CONSTRAINT).not.toMatch(/JOIN pg_attribute a ON a\.attrelid = rel\.oid\s+WHERE rel\.relname[\s\S]*?GROUP BY con\.conname\s+HAVING array_agg\(a\.attname/);
        expect(migration.__FIND_LEGACY_INDEX).toContain('unnest(x.indkey) WITH ORDINALITY');
        expect(migration.__FIND_LEGACY_INDEX).toContain('con.conindid = c.oid');
    });

    test('drops a leftover squash-era UNIQUE CONSTRAINT by discovered name', async () => {
        const s = makeSequelize();
        await migration.up(s);
        expect(sqlOf(s)).toMatch(/ALTER TABLE payment_accounts DROP CONSTRAINT IF EXISTS payment_configs_shop_id_provider_key/);
    });

    test('drops a leftover standalone UNIQUE INDEX shape too', async () => {
        const s = makeSequelize({ constraints: [], indexes: ['payment_accounts_shop_provider_key'] });
        await migration.up(s);
        expect(sqlOf(s)).toMatch(/DROP INDEX IF EXISTS payment_accounts_shop_provider_key/);
    });

    test('idempotent: clean schema issues no DDL and passes', async () => {
        const s = makeSequelize({ constraints: [], indexes: [] });
        await migration.up(s);
        expect(sqlOf(s)).not.toMatch(/DROP CONSTRAINT|DROP INDEX/);
    });

    test('SELF-VERIFY: throws when uniqueness survives the drop (silent no-op impossible)', async () => {
        const s = makeSequelize({ persistAfterDrop: true });
        await expect(migration.up(s)).rejects.toThrow(/still present on payment_accounts/i);
    });

    // ── F-1(b): DB backstop for the one-pending-claim-per-order rule ─────────
    test('creates the pending-claim partial unique mirroring the service rule', async () => {
        const s = makeSequelize();
        await migration.up(s);
        const sql = sqlOf(s);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_one_pending_claim_per_order/);
        expect(sql).toMatch(/ON payment_transactions\(order_id\)/);
        expect(sql).toMatch(/WHERE status = 'payment_claimed'/);
        // D-4 honesty: rejected/verified rows are OUTSIDE the predicate — a
        // re-claim after a reject must stay possible.
        expect(sql).not.toMatch(/status IN \(.*payment_claimed.*\)/);
    });

    test('REFUSES when orders already hold two pending claims (report, never dedupe)', async () => {
        const s = makeSequelize({ claimDupes: [{ order_id: 'o-1', occurrences: 2 }] });
        await expect(migration.up(s)).rejects.toThrow(/multiple[\s\S]*'payment_claimed'|already carry multiple/i);
        expect(sqlOf(s)).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_txn_one_pending_claim_per_order/);
    });

    test('SELF-VERIFY: throws when the pending-claim index is absent after CREATE', async () => {
        const s = makeSequelize({ indexVisible: false });
        await expect(migration.up(s)).rejects.toThrow(/idx_payment_txn_one_pending_claim_per_order is absent/i);
    });

    test('down refuses when multiple accounts share (shop_id, provider)', async () => {
        const s = makeSequelize({ dupes: [{ shop_id: 'x', provider: 'bkash', occurrences: 2 }] });
        await expect(migration.down(s)).rejects.toThrow(/Cannot roll back 20261127_003/);
        expect(sqlOf(s)).not.toMatch(/ADD CONSTRAINT/);
    });

    test('down recreates the legacy unique when safe, and skips it when already present', async () => {
        const safe = makeSequelize({ dupes: [], constraints: [] }); // post-up state: constraint gone
        await migration.down(safe);
        expect(sqlOf(safe)).toMatch(/ADD CONSTRAINT payment_configs_shop_id_provider_key UNIQUE \(shop_id, provider\)/);
        expect(sqlOf(safe)).toMatch(/DROP INDEX IF EXISTS idx_payment_txn_one_pending_claim_per_order/);

        const present = makeSequelize({ dupes: [] }); // default stub: constraint lookup answers rows
        await migration.down(present);
        expect(sqlOf(present)).not.toMatch(/ADD CONSTRAINT/);
    });
});
