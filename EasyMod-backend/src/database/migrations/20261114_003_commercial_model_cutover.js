'use strict';

/**
 * 20261114_003 — commercial model cutover (ADR-0011).
 *
 * This migration is the DATA cutover that pairs with the additive ledger in
 * 20261114_001/002. It collapses every historical plan onto the single
 * delivered-order MERCHANT tier and records the cutover instant that
 * `delivered-order-billing.service.getCommercialCutoverAt()` reads. Nothing is
 * ever deleted: before-values live in `commercial_cutover_events` (and a
 * per-subscription `legacy_plan_snapshot`) so `down` can restore the pre-cutover
 * rows exactly.
 *
 * Contract (ADR-0011):
 *  - every subscription becomes MERCHANT / per_order / BDT 10 per delivered
 *    order, unlimited (-1) conversation and order counters;
 *  - legacy statuses (trialing/trial_expired/inactive/suspended/past_due)
 *    become `active`;
 *  - the current UTC calendar month becomes the recorded period;
 *  - a row that is a GROWTH yearly subscription whose yearly invoice was paid
 *    through `manual_test_reconciliation` is a test fixture: it is still
 *    collapsed, but its snapshot carries reason
 *    `annual_test_fixture_full_credit_no_charge` and its PAID invoice is never
 *    touched;
 *  - OPEN legacy recurring invoices (pending/overdue, monthly_subscription /
 *    yearly_subscription / partner_per_order) are cancelled with an explicit
 *    full-credit note. PAID invoices are immutable and are never rewritten;
 *  - billing lines are NOT backfilled. `catchUpLines()` heals post-cutover
 *    history against the persisted cutover instant.
 *
 * The custom migration runner already wraps `up` in a single transaction on
 * PostgreSQL, so this module issues plain statements and never opens its own.
 * `down` is a reverse replay of the event ledger and is idempotent: a second
 * rollback finds no table/column and does nothing.
 */

const crypto = require('crypto');

const { COMMERCIAL_CONTRACT_VERSION } = require('../../modules/commercial/commercial.contract');

const EVENTS_TABLE = 'commercial_cutover_events';
const SNAPSHOT_COLUMN = 'legacy_plan_snapshot';

/** Columns captured before and restored by `down`. */
const SUBSCRIPTION_FIELDS = Object.freeze([
    'plan_code',
    'plan_name',
    'plan_price',
    'billing_cycle',
    'billing_model',
    'per_order_charge_bdt',
    'conversations_limit',
    'orders_limit',
    'status',
    'current_period_start',
    'current_period_end',
    'next_billing_date',
    'usage_reset_at',
    'trial_ends_at',
]);

/** Statuses that meant "not paying / not active" before the cutover. */
const LEGACY_STATUSES = Object.freeze([
    'trialing', 'trial_expired', 'inactive', 'suspended', 'past_due',
]);

/** Legacy recurring invoice types that are superseded by the delivered model. */
const LEGACY_INVOICE_TYPES = Object.freeze([
    'monthly_subscription', 'yearly_subscription', 'partner_per_order',
]);

const CANCELLED_INVOICE_NOTE = 'Superseded by delivered-order model (ADR-0011), full credit';

const REASON = Object.freeze({
    ANNUAL_FIXTURE: 'annual_test_fixture_full_credit_no_charge',
    LEGACY_STATUS_AND_PLAN: 'legacy_status_and_plan_cutover',
    LEGACY_STATUS: 'legacy_status_activated',
    LEGACY_PLAN: 'legacy_plan_collapsed_to_merchant',
    CONFIRMED: 'merchant_tier_confirmed',
});

const dialectOf = (sequelize) => (
    typeof sequelize.getDialect === 'function' ? sequelize.getDialect() : 'postgres'
);

/**
 * Production stores invoice status in a native enum, so a bare comparison is
 * fine there; the cast keeps the expression valid for the SQLite test dialect
 * (which has no `::text` operator).
 */
const statusText = (postgres, column = 'status') => (
    postgres ? `LOWER(COALESCE(${column}::text, ''))` : `LOWER(COALESCE(${column}, ''))`
);

const tableExists = async (sequelize, postgres, table) => {
    if (postgres) {
        const [rows] = await sequelize.query(`SELECT to_regclass('public.${table}') AS reg`);
        return Boolean(rows?.[0]?.reg);
    }
    const [rows] = await sequelize.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
    );
    return Array.isArray(rows) && rows.length > 0;
};

const hasColumn = async (sequelize, postgres, table, column) => {
    if (postgres) {
        const [rows] = await sequelize.query(
            'SELECT 1 FROM information_schema.columns WHERE table_name = :table AND column_name = :column LIMIT 1',
            { replacements: { table, column } },
        );
        return Array.isArray(rows) && rows.length > 0;
    }
    const [rows] = await sequelize.query(`PRAGMA table_info(${table});`);
    return Array.isArray(rows) && rows.some((entry) => entry.name === column);
};

const toIso = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * The cutover instant is the CURRENT TRANSACTION's timestamp, not a wall-clock
 * value read before it. On PostgreSQL `NOW()` is frozen at transaction start,
 * so every event row in this migration carries one identical instant — the
 * instant `getCommercialCutoverAt()` will later return as the commercial start.
 */
const readTransactionTimestamp = async (sequelize, postgres) => {
    if (postgres) {
        try {
            const [rows] = await sequelize.query('SELECT NOW() AS now');
            const value = rows?.[0]?.now;
            const date = value instanceof Date ? value : new Date(value);
            if (!Number.isNaN(date.getTime())) return date;
        } catch (_) {
            // Fall through to the local clock on a minimal schema.
        }
    }
    return new Date();
};

const parseJson = (value) => {
    if (!value) return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value) || {}; } catch (_) { return {}; }
    }
    return typeof value === 'object' ? value : {};
};

/** Replacements are JSON strings; PostgreSQL casts them explicitly. */
const jsonParam = (postgres, name) => (postgres ? `CAST(:${name} AS JSONB)` : `:${name}`);

const insertEvent = async (sequelize, postgres, {
    shopId, entityType, entityId, before, after, cutoverAt,
}) => {
    await sequelize.query(
        `INSERT INTO ${EVENTS_TABLE}
            (id, shop_id, entity_type, entity_id, before, after, contract_version, cutover_at, created_at)
         VALUES
            (:id, :shop_id, :entity_type, :entity_id, ${jsonParam(postgres, 'before')},
             ${jsonParam(postgres, 'after')}, :contract_version, :cutover_at, :cutover_at)`,
        {
            replacements: {
                id: crypto.randomUUID(),
                shop_id: shopId || null,
                entity_type: entityType,
                entity_id: entityId,
                before: JSON.stringify(before || {}),
                after: JSON.stringify(after || {}),
                contract_version: COMMERCIAL_CONTRACT_VERSION,
                cutover_at: cutoverAt,
            },
        },
    );
};

const createEventsTable = async (sequelize, postgres) => {
    if (postgres) {
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                shop_id UUID NULL,
                entity_type VARCHAR(32) NOT NULL,
                entity_id UUID NULL,
                before JSONB NOT NULL DEFAULT '{}'::jsonb,
                after JSONB NOT NULL DEFAULT '{}'::jsonb,
                contract_version VARCHAR(16) NOT NULL,
                cutover_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ${EVENTS_TABLE}_cutover_at_idx
                ON ${EVENTS_TABLE} (cutover_at DESC)
        `);
        return;
    }
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
            id TEXT PRIMARY KEY,
            shop_id TEXT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NULL,
            before TEXT NOT NULL DEFAULT '{}',
            after TEXT NOT NULL DEFAULT '{}',
            contract_version TEXT NOT NULL,
            cutover_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS ${EVENTS_TABLE}_cutover_at_idx
            ON ${EVENTS_TABLE} (cutover_at DESC)
    `);
};

const addSnapshotColumn = async (sequelize, postgres) => {
    if (postgres) {
        await sequelize.query(
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ${SNAPSHOT_COLUMN} JSONB NULL`,
        );
        return;
    }
    if (!(await hasColumn(sequelize, postgres, 'subscriptions', SNAPSHOT_COLUMN))) {
        await sequelize.query(`ALTER TABLE subscriptions ADD COLUMN ${SNAPSHOT_COLUMN} TEXT`);
    }
};

const dropSnapshotColumn = async (sequelize, postgres) => {
    if (postgres) {
        await sequelize.query(
            `ALTER TABLE subscriptions DROP COLUMN IF EXISTS ${SNAPSHOT_COLUMN}`,
        );
        return;
    }
    if (await hasColumn(sequelize, postgres, 'subscriptions', SNAPSHOT_COLUMN)) {
        await sequelize.query(`ALTER TABLE subscriptions DROP COLUMN ${SNAPSHOT_COLUMN}`);
    }
};

/**
 * True when the subscription is the annual test fixture: a yearly GROWTH row
 * whose yearly invoice was settled through manual test reconciliation. That
 * invoice measured a fully-credited annual test and must not be rewritten.
 */
const isAnnualFixture = async (sequelize, postgres, subscriptionId) => {
    const [rows] = await sequelize.query(
        `SELECT 1 FROM invoices
          WHERE subscription_id = :subscription_id
            AND ${statusText(postgres)} = 'paid'
            AND LOWER(invoice_type) = 'yearly_subscription'
            AND payment_method = 'manual_test_reconciliation'
          LIMIT 1`,
        { replacements: { subscription_id: subscriptionId } },
    );
    return Array.isArray(rows) && rows.length > 0;
};

const reasonFor = (before, annualFixture) => {
    if (annualFixture) return REASON.ANNUAL_FIXTURE;
    const legacyStatus = LEGACY_STATUSES.includes(String(before.status || '').toLowerCase());
    const legacyPlan = String(before.plan_code || '').toUpperCase() !== 'MERCHANT';
    if (legacyStatus && legacyPlan) return REASON.LEGACY_STATUS_AND_PLAN;
    if (legacyStatus) return REASON.LEGACY_STATUS;
    if (legacyPlan) return REASON.LEGACY_PLAN;
    return REASON.CONFIRMED;
};

const migrateSubscriptions = async (sequelize, postgres, cutoverAt) => {
    const [rows] = await sequelize.query(
        `SELECT id, shop_id, ${SUBSCRIPTION_FIELDS.join(', ')}
           FROM subscriptions
          WHERE ${SNAPSHOT_COLUMN} IS NULL`,
    );

    const periodStart = new Date(Date.UTC(
        cutoverAt.getUTCFullYear(), cutoverAt.getUTCMonth(), 1,
    ));
    const periodEnd = new Date(Date.UTC(
        cutoverAt.getUTCFullYear(), cutoverAt.getUTCMonth() + 1, 1,
    ));

    for (const row of rows || []) {
        const before = {};
        for (const field of SUBSCRIPTION_FIELDS) {
            before[field] = row[field] === undefined ? null : row[field];
        }

        // Sequential on purpose: the event ledger must stay ordered with the
        // rows it describes, and the runner holds a cluster-wide advisory lock.
        // eslint-disable-next-line no-await-in-loop
        const annualFixture = await isAnnualFixture(sequelize, postgres, row.id);
        const reason = reasonFor(before, annualFixture);

        // Only the trial/inactive/dunning statuses are activated. A row that was
        // explicitly cancelled stays cancelled: the new model has no
        // subscription to revive, and reactivating a cancelled merchant would
        // start charging them again without a decision to do so.
        const priorStatus = String(before.status || '').toLowerCase();
        const nextStatus = LEGACY_STATUSES.includes(priorStatus) ? 'active' : (before.status || 'active');

        const after = {
            plan_code: 'MERCHANT',
            plan_name: 'EasyModerator',
            plan_price: 0,
            billing_cycle: 'per_order',
            billing_model: 'per_order',
            per_order_charge_bdt: 10.0,
            conversations_limit: -1,
            orders_limit: -1,
            status: nextStatus,
            current_period_start: periodStart,
            current_period_end: periodEnd,
            next_billing_date: periodEnd,
            usage_reset_at: periodStart,
            trial_ends_at: null,
        };

        const snapshot = {
            reason,
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            capturedAt: cutoverAt.toISOString(),
            annualTestFixture: annualFixture,
            previous: before,
            previousPeriod: {
                start: toIso(before.current_period_start),
                end: toIso(before.current_period_end),
            },
        };

        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
            `UPDATE subscriptions
                SET plan_code = :plan_code,
                    plan_name = :plan_name,
                    plan_price = :plan_price,
                    billing_cycle = :billing_cycle,
                    billing_model = :billing_model,
                    per_order_charge_bdt = :per_order_charge_bdt,
                    conversations_limit = :conversations_limit,
                    orders_limit = :orders_limit,
                    status = :status,
                    current_period_start = :current_period_start,
                    current_period_end = :current_period_end,
                    next_billing_date = :next_billing_date,
                    usage_reset_at = :usage_reset_at,
                    trial_ends_at = :trial_ends_at,
                    ${SNAPSHOT_COLUMN} = ${jsonParam(postgres, 'snapshot')}
              WHERE id = :id
                AND ${SNAPSHOT_COLUMN} IS NULL`,
            {
                replacements: {
                    id: row.id,
                    ...after,
                    snapshot: JSON.stringify(snapshot),
                },
            },
        );

        // eslint-disable-next-line no-await-in-loop
        await insertEvent(sequelize, postgres, {
            shopId: row.shop_id,
            entityType: 'subscription',
            entityId: row.id,
            before: { ...before, reason },
            after,
            cutoverAt,
        });
    }
};

const cancelOpenLegacyInvoices = async (sequelize, postgres, cutoverAt) => {
    const [rows] = await sequelize.query(
        `SELECT id, shop_id, status, notes
           FROM invoices
          WHERE ${statusText(postgres)} IN ('pending', 'overdue')
            AND LOWER(invoice_type) IN (${LEGACY_INVOICE_TYPES.map((_, i) => `:type${i}`).join(', ')})`,
        {
            replacements: LEGACY_INVOICE_TYPES.reduce((acc, type, index) => {
                acc[`type${index}`] = type;
                return acc;
            }, {}),
        },
    );

    for (const row of rows || []) {
        const before = { status: row.status, notes: row.notes ?? null };
        const after = { status: 'cancelled', notes: CANCELLED_INVOICE_NOTE };

        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
            `UPDATE invoices
                SET status = 'cancelled', notes = :notes
              WHERE id = :id
                AND ${statusText(postgres)} IN ('pending', 'overdue')`,
            { replacements: { id: row.id, notes: CANCELLED_INVOICE_NOTE } },
        );

        // eslint-disable-next-line no-await-in-loop
        await insertEvent(sequelize, postgres, {
            shopId: row.shop_id,
            entityType: 'invoice',
            entityId: row.id,
            before,
            after,
            cutoverAt,
        });
    }
};

const restoreSubscriptions = async (sequelize, events) => {
    for (const event of events) {
        const before = parseJson(event.before);
        if (!before || Object.keys(before).length === 0) continue;
        const replacements = { id: event.entity_id };
        for (const field of SUBSCRIPTION_FIELDS) {
            replacements[field] = before[field] === undefined ? null : before[field];
        }
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
            `UPDATE subscriptions
                SET ${SUBSCRIPTION_FIELDS.map((field) => `${field} = :${field}`).join(', ')}
              WHERE id = :id`,
            { replacements },
        );
    }
};

const restoreInvoices = async (sequelize, postgres, events) => {
    for (const event of events) {
        const before = parseJson(event.before);
        // A8: only a STILL-CANCELLED invoice is restored. A legacy invoice that
        // was paid after the cutover is a settled payment, not a debt — blindly
        // rewriting its status back would corrupt the paid SUM and re-dun a
        // merchant who already paid.
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
            `UPDATE invoices
                SET status = :status, notes = :notes
              WHERE id = :id
                AND ${statusText(postgres)} = 'cancelled'
                AND paid_at IS NULL`,
            {
                replacements: {
                    id: event.entity_id,
                    status: before.status ?? 'pending',
                    notes: before.notes ?? null,
                },
            },
        );
    }
};

const replayEvents = async (sequelize, postgres) => {
    if (!(await tableExists(sequelize, postgres, EVENTS_TABLE))) return;

    const [events] = await sequelize.query(
        `SELECT entity_type, entity_id, before
           FROM ${EVENTS_TABLE}
          ORDER BY cutover_at DESC, created_at DESC`,
    );
    const list = Array.isArray(events) ? events : [];

    // Reverse replay: entities are restored before any later adjustment that
    // referenced them. One event per entity is written by `up`, so order is
    // stable even when timestamps tie.
    await restoreSubscriptions(sequelize, list.filter((e) => e.entity_type === 'subscription'));
    await restoreInvoices(sequelize, postgres, list.filter((e) => e.entity_type === 'invoice'));

    await sequelize.query(`DROP TABLE IF EXISTS ${EVENTS_TABLE}`);
};

module.exports = {
    name: '20261114_003_commercial_model_cutover',

    EVENTS_TABLE,
    SNAPSHOT_COLUMN,
    SUBSCRIPTION_FIELDS,
    CANCELLED_INVOICE_NOTE,
    REASON,

    async up(sequelize) {
        const postgres = dialectOf(sequelize) === 'postgres';
        // The cutover instant is the migration's transaction instant. It is
        // persisted on every event row and read back by the billing engine;
        // it is never hardcoded in application code.
        const cutoverAt = await readTransactionTimestamp(sequelize, postgres);

        await addSnapshotColumn(sequelize, postgres);
        await createEventsTable(sequelize, postgres);
        await migrateSubscriptions(sequelize, postgres, cutoverAt);
        await cancelOpenLegacyInvoices(sequelize, postgres, cutoverAt);
    },

    async down(sequelize) {
        const postgres = dialectOf(sequelize) === 'postgres';
        await replayEvents(sequelize, postgres);
        await dropSnapshotColumn(sequelize, postgres);
    },
};