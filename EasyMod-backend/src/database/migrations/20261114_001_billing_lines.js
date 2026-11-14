'use strict';

/**
 * 20261114_001 — billing_lines ledger (ADR-0011 delivered-order model).
 *
 * Additive and idempotent. The DOWN step NEVER drops merchant financial data:
 * it renames the table to a dated archive. Re-running UP renames the archive
 * back so a rolled-back release can resume billing without losing lines.
 */

const ARCHIVE_TABLE = 'billing_lines_archived_20261114';

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

const createPostgres = async (sequelize) => {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS billing_lines (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
            order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
            subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL ON UPDATE CASCADE,
            line_kind VARCHAR(16) NOT NULL,
            outcome VARCHAR(24) NOT NULL,
            unit_price_minor INTEGER NOT NULL,
            amount_minor INTEGER NOT NULL,
            currency CHAR(3) NOT NULL DEFAULT 'BDT',
            contract_version VARCHAR(16) NOT NULL,
            idempotency_key VARCHAR(64) NOT NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'courier_webhook',
            provider VARCHAR(32),
            occurred_at DATE NOT NULL,
            invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL ON UPDATE CASCADE,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            CONSTRAINT billing_lines_line_kind_check
                CHECK (line_kind IN ('billable', 'zero_rated')),
            CONSTRAINT billing_lines_amounts_check
                CHECK (unit_price_minor >= 0 AND amount_minor >= 0),
            CONSTRAINT billing_lines_currency_check CHECK (currency = 'BDT')
        );
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_shop_order_kind_unique
            ON billing_lines(shop_id, order_id, line_kind);
    `);
    // At most one billable row per order — an order is charged at most once.
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_one_billable_per_order
            ON billing_lines(order_id) WHERE line_kind = 'billable';
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_idempotency_key_unique
            ON billing_lines(idempotency_key);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_shop_occurred_idx
            ON billing_lines(shop_id, occurred_at);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_invoice_idx
            ON billing_lines(invoice_id);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_shop_invoice_kind_idx
            ON billing_lines(shop_id, invoice_id, line_kind);
    `);
};

const createSqlite = async (sequelize) => {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS billing_lines (
            id TEXT PRIMARY KEY,
            shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
            order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
            line_kind TEXT NOT NULL CHECK (line_kind IN ('billable', 'zero_rated')),
            outcome TEXT NOT NULL,
            unit_price_minor INTEGER NOT NULL,
            amount_minor INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'BDT',
            contract_version TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'courier_webhook',
            provider TEXT,
            occurred_at TEXT NOT NULL,
            invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            deleted_at TEXT
        );
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_shop_order_kind_unique
            ON billing_lines(shop_id, order_id, line_kind);
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_one_billable_per_order
            ON billing_lines(order_id) WHERE line_kind = 'billable';
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS billing_lines_idempotency_key_unique
            ON billing_lines(idempotency_key);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_shop_occurred_idx
            ON billing_lines(shop_id, occurred_at);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_invoice_idx
            ON billing_lines(invoice_id);
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS billing_lines_shop_invoice_kind_idx
            ON billing_lines(shop_id, invoice_id, line_kind);
    `);
};

module.exports = {
    name: '20261114_001_billing_lines',

    async up(sequelize) {
        const postgres = sequelize.getDialect?.() === 'postgres';

        // A prior rollback archived the ledger. Resume it rather than starting
        // from an empty table (which would silently orphan billed history).
        if (await tableExists(sequelize, postgres, ARCHIVE_TABLE)) {
            const currentExists = await tableExists(sequelize, postgres, 'billing_lines');
            if (!currentExists) {
                await sequelize.query(`ALTER TABLE ${ARCHIVE_TABLE} RENAME TO billing_lines;`);
            }
        }

        if (postgres) await createPostgres(sequelize);
        else await createSqlite(sequelize);
    },

    async down(sequelize) {
        const postgres = sequelize.getDialect?.() === 'postgres';
        if (!(await tableExists(sequelize, postgres, 'billing_lines'))) return;
        if (await tableExists(sequelize, postgres, ARCHIVE_TABLE)) return;
        // Never DROP: archived rows remain available for audit and a re-up.
        await sequelize.query(`ALTER TABLE billing_lines RENAME TO ${ARCHIVE_TABLE};`);
    },
};