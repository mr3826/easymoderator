'use strict';

/**
 * 20261126_001_faq_question_lifecycle — fake-sequelize replay (pattern of
 * delivery-schema.test.js): the up must be idempotent (every DDL guarded by
 * IF NOT EXISTS, every backfill guarded by a WHERE clause), the backfills copy
 * real data only (question = category, status CASE from is_active — never an
 * invented category_tag or timestamp), and the down must drop ONLY what the up
 * added so the whole change is reversible during any rollback window.
 */

process.env.NODE_ENV = 'test';

const path = require('path');
const migration = require(path.join(__dirname, '../migrations/20261126_001_faq_question_lifecycle.js'));

const NEW_COLUMNS = [
    'question', 'category_tag', 'status', 'keywords', 'internal_notes',
    'updated_at', 'sync_status', 'sync_version', 'synced_at',
];
const PREEXISTING_COLUMNS = ['id', 'shop_id', 'category', 'template_bn', 'template_en', 'is_active', 'created_at', 'use_count'];

/**
 * Tiny stateful simulator good enough to replay this migration's statements:
 *  - ALTER TABLE ... ADD COLUMN IF NOT EXISTS <col> ...  → adds col (honours
 *    the NOT NULL DEFAULT for the column set),
 *  - the two guarded UPDATE backfills are applied against fake rows,
 *  - CREATE/DROP INDEX and DROP COLUMN IF EXISTS track presence.
 */
const createFakeDb = ({ rows = [] } = {}) => {
    const state = {
        columns: new Set(PREEXISTING_COLUMNS),
        indexes: new Set(),
        rows: rows.map((row) => ({ ...row })),
        executed: [],
    };
    state.query = async (sql) => {
        const text = String(sql);
        state.executed.push(text);

        for (const match of text.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)\s+([^\n,]+)/g)) {
            const [, column, def] = match;
            if (!state.columns.has(column)) {
                state.columns.add(column);
                const defMatch = def.match(/NOT NULL DEFAULT '([^']+)'/) || def.match(/NOT NULL DEFAULT (\d+)/);
                if (defMatch) {
                    const raw = defMatch[1];
                    const value = /^\d+$/.test(raw) ? Number(raw) : raw;
                    for (const row of state.rows) if (row[column] === undefined) row[column] = value;
                }
            }
        }
        for (const match of text.matchAll(/DROP COLUMN IF EXISTS\s+(\w+)/g)) {
            state.columns.delete(match[1]);
            for (const row of state.rows) delete row[match[1]];
        }
        for (const match of text.matchAll(/CREATE INDEX IF NOT EXISTS\s+(\w+)/g)) {
            state.indexes.add(match[1]);
        }
        for (const match of text.matchAll(/DROP INDEX IF EXISTS\s+(\w+)/g)) {
            state.indexes.delete(match[1]);
        }
        // Backfill 1: question = category (guarded WHERE question IS NULL).
        if (/UPDATE\s+faq_responses\s+SET\s+question\s*=\s*category/i.test(text) && /WHERE\s+question\s+IS\s+NULL/i.test(text)) {
            for (const row of state.rows) if (row.question === undefined || row.question === null) row.question = row.category;
        }
        // Backfill 2: inactive rows become disabled (guarded WHERE is_active = FALSE AND status = 'published').
        if (/SET\s+status\s*=\s*'disabled'/i.test(text) && /is_active\s*=\s*FALSE/i.test(text) && /status\s*=\s*'published'/i.test(text)) {
            for (const row of state.rows) if (row.is_active === false && row.status === 'published') row.status = 'disabled';
        }
        // No other DML is allowed by this migration (word-checked at the
        // statement start so COMMENT ON prose — e.g. "a category update…" —
        // never trips this).
        if (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(text)
            && !/UPDATE\s+faq_responses\s+SET\s+question\s*=\s*category/i.test(text)
            && !/SET\s+status\s*=\s*'disabled'/i.test(text)) {
            throw new Error(`unexpected mutating statement: ${text}`);
        }
        return [[], {}];
    };
    return state;
};

describe('20261126_001_faq_question_lifecycle', () => {
    test('exports the custom-runner contract { name, up, down }', () => {
        expect(migration.name).toBe('20261126_001_faq_question_lifecycle');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('up adds ALL nine columns guarded by IF NOT EXISTS, nullable/defaulted for the old image', async () => {
        const db = createFakeDb();
        await migration.up(db);

        for (const column of NEW_COLUMNS) {
            expect(db.columns.has(column)).toBe(true);
            expect(db.executed.join('\n')).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
        }
        const sql = db.executed.join('\n');
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+question\s+TEXT\s+NULL/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+category_tag\s+VARCHAR\(60\)\s+NULL/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+status\s+VARCHAR\(16\)\s+NOT NULL DEFAULT 'published'/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+keywords\s+JSON\s+NULL/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+internal_notes\s+TEXT\s+NULL/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+updated_at\s+TIMESTAMPTZ\s+NULL DEFAULT NOW\(\)/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+sync_status\s+VARCHAR\(12\)\s+NOT NULL DEFAULT 'pending'/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+sync_version\s+INTEGER\s+NOT NULL DEFAULT 0/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+synced_at\s+TIMESTAMPTZ\s+NULL/);
        expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_faq_shop_status\s+ON faq_responses\(shop_id, status\)/);
    });

    test('every DDL statement in up AND down is idempotent (IF NOT EXISTS / IF EXISTS)', async () => {
        const db = createFakeDb();
        await migration.up(db);
        await migration.down(db);
        for (const statement of db.executed) {
            if (/ADD COLUMN/.test(statement)) expect(statement).toContain('IF NOT EXISTS');
            if (/DROP COLUMN/.test(statement)) expect(statement).toContain('IF EXISTS');
            if (/CREATE INDEX/.test(statement)) expect(statement).toContain('IF NOT EXISTS');
            if (/DROP INDEX/.test(statement)) expect(statement).toContain('IF EXISTS');
        }
    });

    test('backfill: question copies category verbatim; status maps is_active; nothing invented', async () => {
        const rows = [
            { id: 1, category: 'Delivery time?', is_active: true },
            { id: 2, category: 'Refund policy?', is_active: false },
            { id: 3, category: 'Color?', is_active: true },
        ];
        const db = createFakeDb({ rows });
        await migration.up(db);

        expect(db.rows[0].question).toBe('Delivery time?');
        expect(db.rows[1].question).toBe('Refund policy?');
        expect(db.rows[2].question).toBe('Color?');
        // status CASE mapping from is_active (A0 contract).
        expect(db.rows.map((r) => r.status)).toEqual(['published', 'disabled', 'published']);
        // NO invention: category_tag stays NULL (no backfill), every row starts
        // sync pending/version 0 (honest until a re-touch/reindex settles it).
        expect(db.rows.every((r) => r.category_tag === undefined)).toBe(true);
        expect(db.rows.every((r) => r.sync_status === 'pending' && r.sync_version === 0)).toBe(true);

        const sql = db.executed.join('\n');
        expect(sql).toMatch(/SET\s+question\s*=\s*category/i);
        expect(sql).toMatch(/WHERE\s+question\s+IS\s+NULL/i);        // guarded ⇒ idempotent
        expect(sql).toMatch(/is_active\s*=\s*FALSE/i);               // guarded CASE
        expect(sql).not.toMatch(/SET\s+category_tag/i);              // never invented
        expect(sql).not.toMatch(/SET\s+updated_at\s*=/i);            // never a fabricated edit stamp
    });

    test('up is idempotent: running it twice converges with no extra state change', async () => {
        const db = createFakeDb({ rows: [{ id: 1, category: 'Q?', is_active: false }] });
        await migration.up(db);
        const afterFirst = { columns: new Set(db.columns), rows: db.rows.map((r) => ({ ...r })) };
        await migration.up(db); // re-run (e.g. retried deploy)

        expect(db.columns).toEqual(afterFirst.columns);
        expect(db.rows).toEqual(afterFirst.rows);
    });

    test('down drops ONLY the new columns and index — category/is_active untouched ⇒ reversible', async () => {
        const db = createFakeDb({ rows: [{ id: 1, category: 'Q?', is_active: true, question: 'Q?' }] });
        await migration.up(db);
        await migration.down(db);

        for (const column of NEW_COLUMNS) expect(db.columns.has(column)).toBe(false);
        for (const column of PREEXISTING_COLUMNS) expect(db.columns.has(column)).toBe(true);
        expect(db.indexes.has('idx_faq_shop_status')).toBe(false);
        expect(db.rows[0].category).toBe('Q?');   // legacy mirror data survives the down
        expect(db.rows[0].question).toBeUndefined();
        const downSql = db.executed.slice(db.executed.findIndex((s) => /DROP COLUMN/i.test(s))).join('\n');
        expect(downSql).not.toMatch(/DROP COLUMN IF EXISTS category\b/i); // category_tag is fine; bare `category` is NOT dropped
        expect(downSql).not.toMatch(/DROP COLUMN IF EXISTS is_active\b/i);
        expect(downSql).not.toMatch(/DROP COLUMN IF EXISTS created_at\b/i);
    });

    test('rehearses the full up/up/down/down cycle against fake state', async () => {
        const db = createFakeDb({
            rows: [{ id: 1, category: 'Size?', is_active: true }, { id: 2, category: 'COD?', is_active: false }],
        });
        await migration.up(db);
        await migration.up(db);
        await migration.down(db);
        await migration.down(db); // second down is a safe no-op
        expect(db.columns).toEqual(new Set(PREEXISTING_COLUMNS));
        expect(db.indexes.size).toBe(0);
        // ...and a fresh up after a rollback works again (paired-promotion floor).
        await migration.up(db);
        expect(db.columns.has('question')).toBe(true);
    });
});
