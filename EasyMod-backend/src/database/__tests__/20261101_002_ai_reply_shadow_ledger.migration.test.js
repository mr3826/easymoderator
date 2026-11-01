'use strict';

const migration = require('../migrations/20261101_002_ai_reply_shadow_ledger');

describe('20261101_002_ai_reply_shadow_ledger migration', () => {
    it('creates a tenant-scoped append-only unit ledger with DB idempotency and period indexes', async () => {
        const queries = [];
        const sequelize = { query: jest.fn(async (sql) => queries.push(sql)) };

        await migration.up(sequelize);

        const sql = queries.join('\n');
        expect(migration.name).toBe('20261101_002_ai_reply_shadow_ledger');
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ai_reply_shadow_ledger/);
        expect(sql).toMatch(/shop_id UUID NOT NULL REFERENCES shops\(id\)/);
        expect(sql).toMatch(/idempotency_key VARCHAR\(64\) NOT NULL/);
        expect(sql).toMatch(/period_start DATE NOT NULL/);
        expect(sql).toMatch(/accepted_at TIMESTAMPTZ NOT NULL/);
        expect(sql).toMatch(/CHECK \(units = 1\)/);
        expect(sql).toMatch(/UNIQUE \(shop_id, idempotency_key\)/);
        expect(sql).toMatch(/ON ai_reply_shadow_ledger\(shop_id, period_start\)/);
        expect(sql).not.toMatch(/content|customer_id|provider_message_id/i);
    });

    it('rolls back only the shadow ledger table', async () => {
        const sequelize = { query: jest.fn() };

        await migration.down(sequelize);

        expect(sequelize.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS ai_reply_shadow_ledger;');
    });
});
