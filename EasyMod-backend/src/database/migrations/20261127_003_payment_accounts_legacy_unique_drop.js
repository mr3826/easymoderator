'use strict';

/**
 * Payment redesign migration #3 (remediation, 2026-11-27 post-deploy audit).
 *
 * WHY THIS FILE EXISTS: 20261127_002 step 1 is supposed to drop the squash-era
 * UNIQUE(shop_id, provider) on payment_accounts before the account model's
 * partial uniques go in. Its lookup joined pg_attribute to the WHOLE table
 * (no conkey/indkey filter), so array_agg collected ALL columns of
 * payment_accounts (13 after 001) and the HAVING equality could never match.
 * The DROP was a silent no-op in every real environment. Fake-sequelize unit
 * tests stubbed any "FROM pg_constraint" query and could not see it. Discovered
 * by reading the LIVE production schema after the bf6d38 deploy:
 * `payment_configs_shop_id_provider_key UNIQUE (shop_id, provider)` was still
 * there — a second account row for one provider (self + merchant_gateway)
 * would 23505, which is exactly the §1.3 model this release ships.
 *
 * This migration is the safety net for BOTH shapes of the leftover:
 *   1. table-level UNIQUE constraint whose column set is (shop_id, provider)
 *      — matched correctly this time via LATERAL unnest(conkey) with ordinality;
 *   2. standalone (non-constraint-backed) UNIQUE index over the same columns,
 *      in case an environment materialised it that way.
 * It then SELF-VERIFIES: if any (shop_id, provider) uniqueness survives, up()
 * throws with what it still sees — so the CI PG16 full-chain rehearsal and the
 * live deploy are both conclusive, and a silent no-op cannot recur.
 *
 * 002 is deliberately NOT edited: it is already recorded as applied (its
 * semantics for already-migrated environments cannot change), and this file
 * runs after it on fresh chains too, so every path ends at the intended state.
 *
 * down() recreates the legacy table-level unique, refusing honestly when
 * existing rows would violate it (same convention as 002/001).
 */
const TABLE = 'payment_accounts';
const RECREATED_CONSTRAINT = 'payment_configs_shop_id_provider_key';
// F-1(b) (A9-remediation, 2026-11-27): the self-MFS claim dedupe in the claim
// service (5b) is read-then-insert — two concurrent claims with DIFFERENT
// TrxIDs can both pass the check and coexist, and the 002 one-active-attempt
// partial unique deliberately covers only initiated/processing gateway rows
// (D-4: rejected attempts must repeat, claims are "policed at the claim
// service"). That policing now gets a DB backstop: AT MOST ONE row per order
// in status 'payment_claimed' (a pending merchant judgment). Rejected and
// verified history stay free, so legitimate re-claims after a reject are
// untouched — the partial predicate mirrors the service rule EXACTLY.
const PENDING_CLAIM_UNIQUE = 'idx_payment_txn_one_pending_claim_per_order';

// Constraint backed by exactly (shop_id, provider), matched on the CONSTRAINT's
// own column list — conkey ordered by its ordinality, not the table's attributes.
const FIND_LEGACY_CONSTRAINT = `
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN LATERAL (
          SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ) sc ON true
     WHERE rel.relname = '${TABLE}'
       AND con.contype = 'u'
       AND sc.cols = ARRAY['shop_id','provider']::text[];
`;

// Standalone UNIQUE INDEX over exactly (shop_id, provider) that is NOT the
// physical index of a constraint (constraint indexes are dropped with the
// constraint above; indkey uses 0 for expression columns — filtered out by the
// attname join simply not matching 0).
const FIND_LEGACY_INDEX = `
    SELECT c.relname
      FROM pg_class c
      JOIN pg_index x ON x.indexrelid = c.oid
     WHERE x.indrelid = '${TABLE}'::regclass
       AND x.indisunique
       AND NOT x.indisprimary
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = c.oid)
       AND (
           SELECT array_agg(a.attname::text ORDER BY k.ord)
             FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
       ) = ARRAY['shop_id','provider']::text[];
`;

async function lookup(sequelize, sql) {
    const [rows] = await sequelize.query(sql);
    // NO error-swallowing here (20261127_002 lesson): a thrown statement inside
    // the runner's per-migration transaction aborts it; every later statement
    // would fail 25P02 behind a masked error.
    return Array.isArray(rows) ? rows.map((r) => Object.values(r)[0]) : [];
}

module.exports = {
    name: '20261127_003_payment_accounts_legacy_unique_drop',

    up: async (sequelize) => {
        if (sequelize.getDialect() !== 'postgres') return;

        for (const conname of await lookup(sequelize, FIND_LEGACY_CONSTRAINT)) {
            await sequelize.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${conname};`);
            console.log(`[migration 20261127_003] dropped legacy UNIQUE constraint ${conname} (shop_id, provider).`);
        }
        for (const idxname of await lookup(sequelize, FIND_LEGACY_INDEX)) {
            await sequelize.query(`DROP INDEX IF EXISTS ${idxname};`);
            console.log(`[migration 20261127_003] dropped legacy standalone UNIQUE index ${idxname} (shop_id, provider).`);
        }

        // Self-verification: a silent no-op must be impossible. If BOTH lookups
        // still see anything, the uniqueness is still enforced and merchants
        // cannot hold two accounts on one provider — fail the deploy loudly.
        const leftoverConstraint = await lookup(sequelize, FIND_LEGACY_CONSTRAINT);
        const leftoverIndex = await lookup(sequelize, FIND_LEGACY_INDEX);
        if (leftoverConstraint.length > 0 || leftoverIndex.length > 0) {
            throw new Error(
                'Cannot enforce 20261127_003: UNIQUE(shop_id, provider) still present on payment_accounts after drop — '
                + `[${[...leftoverConstraint, ...leftoverIndex].join(', ')}]. `
                + 'The account model requires at most the partial (shop_id, provider, account_type) uniqueness.',
            );
        }
        console.log('[migration 20261127_003] verified: no (shop_id, provider) uniqueness remains on payment_accounts.');

        // ── F-1(b): one PENDING self-MFS claim per order, enforced by the DB ──
        // Preflight mirrors the 001/002 convention: report rows, never silently
        // dedupe. (The duplicate GROUP BY below is also what a pre-remediation
        // production DB would surface here if merchants had already raced.)
        const [claimDupes] = await sequelize.query(`
            SELECT order_id, COUNT(*) AS occurrences
              FROM payment_transactions
             WHERE status = 'payment_claimed' AND order_id IS NOT NULL
             GROUP BY order_id
            HAVING COUNT(*) > 1
             LIMIT 5;
        `);
        if (Array.isArray(claimDupes) && claimDupes.length > 0) {
            const preview = claimDupes.map((r) => JSON.stringify(r)).join('\n  ');
            throw new Error(
                'Cannot enforce one pending claim per order: orders already carry multiple '
                + `'payment_claimed' rows. Reconcile them (approve one, reject the rest) before `
                + `deploying this migration. Sample (up to 5):\n  ${preview}`,
            );
        }
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${PENDING_CLAIM_UNIQUE}
                ON payment_transactions(order_id)
                WHERE status = 'payment_claimed';
        `);
        const [seen] = await sequelize.query(`
            SELECT 1 FROM pg_indexes
             WHERE tablename = 'payment_transactions' AND indexname = '${PENDING_CLAIM_UNIQUE}'
             LIMIT 1;
        `);
        if (!Array.isArray(seen) || seen.length === 0) {
            throw new Error(
                `Cannot enforce 20261127_003: ${PENDING_CLAIM_UNIQUE} is absent after CREATE — `
                + 'the pending-claim dedupe has no DB backstop.',
            );
        }
        console.log(`[migration 20261127_003] created + verified ${PENDING_CLAIM_UNIQUE} (one pending self-MFS claim per order).`);
    },

    down: async (sequelize) => {
        if (sequelize.getDialect() !== 'postgres') return;

        // Reversal order mirrors creation: drop this file's own pending-claim
        // unique first (dropping a unique never violates rows — the widened
        // world it prevented simply returns), then restore the legacy unique.
        await sequelize.query(`DROP INDEX IF EXISTS ${PENDING_CLAIM_UNIQUE};`);

        const [dupes] = await sequelize.query(`
            SELECT shop_id, provider, COUNT(*) AS occurrences
              FROM ${TABLE}
             WHERE provider IS NOT NULL
             GROUP BY shop_id, provider
            HAVING COUNT(*) > 1
             LIMIT 5;
        `);
        if (Array.isArray(dupes) && dupes.length > 0) {
            throw new Error(
                `Cannot roll back 20261127_003: ${dupes.length}+ (shop_id, provider) groups already hold multiple `
                + 'payment_accounts rows; the legacy unique cannot hold them. No rows will be dropped.',
            );
        }
        // PG has no ADD CONSTRAINT IF NOT EXISTS — re-check first.
        const existing = await lookup(sequelize, FIND_LEGACY_CONSTRAINT);
        if (existing.length === 0) {
            await sequelize.query(`
                ALTER TABLE ${TABLE}
                    ADD CONSTRAINT ${RECREATED_CONSTRAINT} UNIQUE (shop_id, provider);
            `);
        }
    },

    __FIND_LEGACY_CONSTRAINT: FIND_LEGACY_CONSTRAINT,
    __FIND_LEGACY_INDEX: FIND_LEGACY_INDEX,
};
