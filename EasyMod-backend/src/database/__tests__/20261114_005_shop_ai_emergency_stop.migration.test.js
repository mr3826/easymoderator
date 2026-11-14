'use strict';

const migration = require('../migrations/20261114_005_shop_ai_emergency_stop');

describe('20261114_005_shop_ai_emergency_stop', () => {
    test('exports the custom-runner contract { name, up, down }', () => {
        expect(migration.name).toBe('20261114_005_shop_ai_emergency_stop');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('adds the five additive stop columns with a fail-closed default', async () => {
        const sequelize = { query: jest.fn().mockResolvedValue(undefined) };

        await migration.up(sequelize);

        const sql = sequelize.query.mock.calls.map(([statement]) => statement).join('\n');
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS ai_emergency_stop BOOLEAN NOT NULL DEFAULT FALSE');
        expect(sql).toContain('ai_emergency_stop_at TIMESTAMPTZ NULL');
        expect(sql).toContain('ai_emergency_stop_by UUID NULL');
        expect(sql).toContain('ai_emergency_stop_source TEXT NULL');
        expect(sql).toContain('ai_emergency_stop_prior_mode TEXT NULL');
        expect(sql).toContain('COMMENT ON COLUMN shops.ai_emergency_stop IS');
        // Expand-only: no backfill / row rewrite.
        expect(sql).not.toMatch(/UPDATE\s+shops/i);
    });

    test('down drops the stop columns in one statement', async () => {
        const sequelize = { query: jest.fn().mockResolvedValue(undefined) };

        await migration.down(sequelize);

        const statements = sequelize.query.mock.calls.map(([statement]) => statement.trim());
        expect(statements).toHaveLength(1);
        for (const column of [
            'ai_emergency_stop',
            'ai_emergency_stop_at',
            'ai_emergency_stop_by',
            'ai_emergency_stop_source',
            'ai_emergency_stop_prior_mode',
        ]) {
            expect(statements[0]).toContain(`DROP COLUMN IF EXISTS ${column}`);
        }
    });
});