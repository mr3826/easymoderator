'use strict';

/**
 * Payment redesign migration #2 of 2 (D-1/D-2, R-11 numbering) — CONSTRAINT SWAP.
 *
 * Replaces the legacy one-config-per-(shop,gateway) shape with the account model:
 *   - drops the squash-era table UNIQUE(shop_id, provider) (looked up via
 *     pg_constraint by column set) and the 20260522_003 partial unique
 *     idx_payment_configs_shop_gateway (20260522_003:94);
 *   - creates partial UNIQUE (shop_id, provider, account_type) so a shop can hold
 *     self / business / merchant_gateway bkash rows side by side (§1.3);
 *   - creates partial UNIQUE (shop_id) WHERE is_preferred so the DB is the single
 *     source of "one preferred per shop" (D-8);
 *   - creates partial UNIQUE (shop_id, transaction_id) WHERE transaction_id <> ''
 *     on payment_transactions, after a duplicate pre-flight that FAILS WITH A
 *     ROW REPORT (never silently dedupes) — the 20261026_001 pattern (§1.3-003).
 *
 * Additive/dropping only; no rows are deleted. down() reverses this file's own
 * objects and RE-FUSES to run if existing rows would violate the legacy uniques it
 * recreates, stating so honestly in-file (§1.3 Down() honesty).
 */
const ACCOUNT_UNIQUE = 'idx_payment_accounts_shop_provider_type';
const PREFERRED_UNIQUE = 'idx_payment_accounts_one_preferred';
const TXN_UNIQUE = 'idx_payment_txn_shop_transaction_id';
// §4.4 duplicate-attempt prevention (A0 ruling 2026-11-26: folded into this
// file instead of a third migration — migrations stay the 001/002 pair):
// at most ONE active gateway attempt per order at the DB level. 'initiated'
// and 'processing' are the live-attempt statuses the tokenized create path
// occupies; the service returns a friendly 409 PAYMENT_IN_PROGRESS, and a
// race between two creates is now impossible in Postgres, not just unlikely.
// payment_claimed (self-MFS) is deliberately NOT in this predicate: multiple
// merchant-judgment claims per order are policed at the claim service, and
// D-4 forbids automatic money-state collisions on rows a human still owns.
const ACTIVE_ATTEMPT_UNIQUE = 'idx_payment_txn_one_active_attempt_per_order';
const LEGACY_GATEWAY_INDEX = 'idx_payment_configs_shop_gateway';

const failWithReport = (label, rows) => {
    const preview = rows
        .map((r) => JSON.stringify(r))
        .join('\n  ');
    throw new Error(
        `Cannot enforce ${label}: duplicated rows exist in production. `
        + `Reconcile them before deploying this migration. Sample (up to 5):\n  ${preview}`,
    );
};

async function findLegacyProviderConstraint(sequelize) {
    // Look the squash-era UNIQUE(shop_id, provider) up by its columns; it may be
    // absent (environments that never ran the squash) and its name is generated.
    const [rows] = await sequelize.query(`
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_attribute a ON a.attrelid = rel.oid
         WHERE rel.relname = 'payment_accounts'
           AND con.contype = 'u'
         GROUP BY con.conname
        HAVING array_agg(a.attname ORDER BY a.attnum) = ARRAY['shop_id','provider'];
    `).catch(() => [[]]);
    return Array.isArray(rows) && rows.length ? rows[0].conname : null;
}

async function duplicateGroups(sequelize, table, cols, where) {
    const [rows] = await sequelize.query(`
        SELECT ${cols}, COUNT(*) AS occurrences
          FROM ${table}
         ${where}
         GROUP BY ${cols}
        HAVING COUNT(*) > 1
         LIMIT 5;
    `);
    return Array.isArray(rows) ? rows : [];
}

module.exports = {
    name: '20261127_002_payment_account_constraints',

    up: async (sequelize) => {
        if (sequelize.getDialect() !== 'postgres') {
            // SQLite (local sync path) is satisfied by the entity index
            // declarations; this swap is PostgreSQL-specific like its siblings.
            return;
        }

        // ── 1. Drop legacy uniques (both guarded; may already differ per env) ───
        const legacyProviderConstraint = await findLegacyProviderConstraint(sequelize);
        if (legacyProviderConstraint) {
            await sequelize.query(`ALTER TABLE payment_accounts DROP CONSTRAINT IF EXISTS ${legacyProviderConstraint};`);
        }
        await sequelize.query(`DROP INDEX IF EXISTS ${LEGACY_GATEWAY_INDEX};`);

        // ── 2. Pre-flight duplicate checks (reject, never dedupe) ───────────────
        const acctDupes = await duplicateGroups(
            sequelize,
            'payment_accounts',
            'shop_id, provider, account_type',
            'WHERE provider IS NOT NULL AND account_type IS NOT NULL',
        );
        if (acctDupes.length > 0) failWithReport('payment_accounts (shop_id, provider, account_type)', acctDupes);

        const preferredDupes = await duplicateGroups(
            sequelize,
            'payment_accounts',
            'shop_id',
            'WHERE is_preferred = TRUE',
        );
        if (preferredDupes.length > 0) failWithReport('payment_accounts preferred-per-shop (is_preferred)', preferredDupes);

        const txnDupes = await duplicateGroups(
            sequelize,
            'payment_transactions',
            'shop_id, transaction_id',
            "WHERE transaction_id IS NOT NULL AND transaction_id <> ''",
        );
        if (txnDupes.length > 0) failWithReport('payment_transactions (shop_id, transaction_id)', txnDupes);

        // §4.4 fold-in: two simultaneous active attempts on ONE order would
        // mean double capture; reject pre-flight with a row report (same rule
        // as the duplicates above — reconcile manually, never silently dedupe).
        const activeAttemptDupes = await duplicateGroups(
            sequelize,
            'payment_transactions',
            'order_id',
            "WHERE order_id IS NOT NULL AND status IN ('initiated','processing')",
        );
        if (activeAttemptDupes.length > 0) {
            failWithReport(
                'payment_transactions one-active-attempt-per-order (status initiated/processing)',
                activeAttemptDupes,
            );
        }

        // ── 3. Create the new partial uniques ───────────────────────────────────
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${ACCOUNT_UNIQUE}
                ON payment_accounts(shop_id, provider, account_type)
                WHERE provider IS NOT NULL AND account_type IS NOT NULL;
        `);
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${PREFERRED_UNIQUE}
                ON payment_accounts(shop_id)
                WHERE is_preferred = TRUE;
        `);
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${TXN_UNIQUE}
                ON payment_transactions(shop_id, transaction_id)
                WHERE transaction_id <> '';
        `);
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${ACTIVE_ATTEMPT_UNIQUE}
                ON payment_transactions(order_id)
                WHERE order_id IS NOT NULL AND status IN ('initiated','processing');
        `);
        console.log('[migration 20261127_002] swapped legacy payment uniques → account-scoped partial uniques + one-preferred + txn-id uniqueness + one-active-attempt-per-order (§4.4).');
    },

    down: async (sequelize) => {
        if (sequelize.getDialect() !== 'postgres') return;

        // This file created the legacy uniques it now restores only if they can
        // legally hold. REJECT down when a live payment_claimed row (self-MFS
        // claim) or multi-account row would collide with the legacy uniques —
        // silently returning to one-config-per-gateway would drop data (§1.3).
        const [walletCount] = await sequelize.query(`
            SELECT COUNT(*)::int AS c FROM payment_accounts WHERE gateway = 'self-mfs';
        `).catch(() => [[{ c: 0 }]]);
        const distinctSelfMfsShops = walletCount && walletCount[0] && walletCount[0].c > 0;

        const [legacyDupes] = await sequelize.query(`
            SELECT shop_id, gateway, COUNT(*) AS occurrences
              FROM payment_accounts
             WHERE gateway IS NOT NULL
             GROUP BY shop_id, gateway
            HAVING COUNT(*) > 1
             LIMIT 1;
        `).catch(() => [[]]);

        if (Array.isArray(legacyDupes) && legacyDupes.length > 0) {
            throw new Error(
                'Cannot roll back 20261127_002: multiple payment_accounts share one (shop_id, gateway), '
                + 'which the legacy unique forbids. Manual reconciliation required — no rows will be dropped.',
            );
        }

        // The active-attempt guard only ever RESTRICTS new writes; dropping it
        // on rollback is safe (no legacy counterpart existed) — the widened
        // world it prevented simply returns until a human reconciles.
        await sequelize.query(`DROP INDEX IF EXISTS ${ACTIVE_ATTEMPT_UNIQUE};`);
        await sequelize.query(`DROP INDEX IF EXISTS ${TXN_UNIQUE};`);
        await sequelize.query(`DROP INDEX IF EXISTS ${PREFERRED_UNIQUE};`);
        await sequelize.query(`DROP INDEX IF EXISTS ${ACCOUNT_UNIQUE};`);

        // Recreate the legacy partial unique on gateway if there are multiple
        // self-mfs rows per shop the rollback cannot safely merge.
        if (distinctSelfMfsShops) {
            const multi = await sequelize.query(`
                SELECT shop_id, COUNT(*) AS c FROM payment_accounts
                 WHERE gateway = 'self-mfs' GROUP BY shop_id HAVING COUNT(*) > 1 LIMIT 1;
            `).then(([r]) => r).catch(() => []);
            if (Array.isArray(multi) && multi.length > 0) {
                throw new Error(
                    'Cannot roll back 20261127_002: a shop holds more than one self-mfs account; '
                    + 'the legacy (shop_id, gateway) unique cannot hold them. No rows will be dropped.',
                );
            }
        }
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${LEGACY_GATEWAY_INDEX}
                ON payment_accounts(shop_id, gateway) WHERE gateway IS NOT NULL;
        `);
    },

    __findLegacyProviderConstraint: findLegacyProviderConstraint,
};
