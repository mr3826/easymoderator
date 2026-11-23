'use strict';

const migration = require('../migrations/20261123_001_ai_usage_ledger');

describe('20261123_001_ai_usage_ledger migration', () => {
    it('creates the additive AI cost ledger with idempotency and attribution indexes', async () => {
        const queries = [];
        const sequelize = { query: jest.fn(async (sql) => queries.push(sql)) };

        await migration.up(sequelize);

        const sql = queries.join('\n');
        expect(migration.name).toBe('20261123_001_ai_usage_ledger');
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ai_usage_ledger/);
        expect(sql).toMatch(/occurred_at\s+TIMESTAMPTZ NOT NULL/);
        expect(sql).toMatch(/shop_id\s+UUID REFERENCES shops\(id\) ON DELETE CASCADE/);
        expect(sql).toMatch(/request_id\s+VARCHAR\(128\)/);
        expect(sql).toMatch(/estimated_cost_usd\s+NUMERIC\(14,8\)/);
        // Unknown cost must be storable as NULL — a NOT NULL cost column would
        // force a fabricated zero, which is exactly what D-P2-04 forbids.
        expect(sql).not.toMatch(/estimated_cost_usd[^,\n]*NOT NULL/i);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_ledger_request/);
        expect(sql).toMatch(/ON ai_usage_ledger\(request_id\)/);
        expect(sql).toMatch(/ON ai_usage_ledger\(shop_id, occurred_at\)/);
    });

    it('has no PII-capable text column', async () => {
        const queries = [];
        const sequelize = { query: jest.fn(async (sql) => queries.push(sql)) };
        await migration.up(sequelize);

        const sql = queries.join('\n');
        // The ledger stores counts/ids/labels only. No free-text column may
        // ever hold prompt, reply, customer, or FAQ content.
        expect(sql).not.toMatch(/\b(text|prompt|reply|answer|content|question|customer|phone|message_body)\b/i);
        expect(sql).not.toMatch(/JSONB/i);
    });

    it('rolls back only the ledger table', async () => {
        const sequelize = { query: jest.fn() };
        await migration.down(sequelize);
        expect(sequelize.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS ai_usage_ledger;');
    });
});
