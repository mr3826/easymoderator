'use strict';

const migration = require('../migrations/20261114_004_channel_automation_overrides');

describe('20261114_004_channel_automation_overrides', () => {
    test('exports the custom-runner contract { name, up, down }', () => {
        expect(migration.name).toBe('20261114_004_channel_automation_overrides');
        expect(typeof migration.up).toBe('function');
        expect(typeof migration.down).toBe('function');
    });

    test('adds one nullable JSONB column idempotently with a documenting comment', async () => {
        const sequelize = { query: jest.fn().mockResolvedValue(undefined) };

        await migration.up(sequelize);

        const sql = sequelize.query.mock.calls.map(([statement]) => statement).join('\n');
        expect(sql).toContain('ALTER TABLE meta_channel_settings ADD COLUMN IF NOT EXISTS overrides JSONB NULL');
        expect(sql).toContain('COMMENT ON COLUMN meta_channel_settings.overrides IS');
        expect(sql).toContain('Narrow-only');
        // Expand-only: never writes rows, never backfills.
        expect(sql).not.toMatch(/UPDATE\s+meta_channel_settings/i);
        expect(sql).not.toMatch(/INSERT\s+INTO/i);
        // No NOT NULL/default: existing channels must inherit (NULL).
        expect(sql).not.toMatch(/overrides JSONB\s+(NOT NULL|DEFAULT)/i);
    });

    test('down drops only the new column', async () => {
        const sequelize = { query: jest.fn().mockResolvedValue(undefined) };

        await migration.down(sequelize);

        expect(sequelize.query.mock.calls.map(([statement]) => statement.trim())).toEqual([
            'ALTER TABLE meta_channel_settings DROP COLUMN IF EXISTS overrides;',
        ]);
    });
});