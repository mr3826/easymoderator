'use strict';

const migration = require('../migrations/20261101_003_ads_studio_manual_reports');

describe('20261101_003_ads_studio_manual_reports migration', () => {
    test('restores tenant-scoped constraints after entity sync created the tables first', async () => {
        const queries = [];
        const sequelize = {
            getDialect: () => 'postgres',
            query: jest.fn(async (sql) => queries.push(sql)),
        };

        await migration.up(sequelize);

        const sql = queries.join('\n');
        expect(sql).toContain('pg_constraint');
        expect(sql).toContain('ads_studio_reports_id_shop_unique');
        expect(sql).toContain('ads_studio_reports_importer_user_id_fkey');
        expect(sql).toContain('ads_studio_metrics_report_shop_fk');
        expect(sql).toContain('ads_studio_metrics_id_scope_unique');
        expect(sql).toContain('ads_studio_drafts_report_shop_fk');
        expect(sql).toContain('ads_studio_drafts_metric_scope_fk');
        expect(sql).toContain('ads_studio_drafts_created_by_fkey');
        expect(sql).toContain('ads_studio_drafts_approved_by_fkey');
        expect(sql).toContain('ads_studio_drafts_approval_check');
        expect(sql).toContain('ON DELETE RESTRICT');

        const reportScopeIndex = sql.indexOf('ads_studio_reports_id_shop_unique');
        const metricReferenceIndex = sql.indexOf('ads_studio_metrics_report_shop_fk');
        const metricScopeIndex = sql.indexOf('ads_studio_metrics_id_scope_unique');
        const draftReferenceIndex = sql.indexOf('ads_studio_drafts_metric_scope_fk');
        expect(reportScopeIndex).toBeLessThan(metricReferenceIndex);
        expect(metricScopeIndex).toBeLessThan(draftReferenceIndex);
    });

    test('keeps non-PostgreSQL migration smoke runs free of PostgreSQL DO blocks', async () => {
        const queries = [];
        const sequelize = {
            getDialect: () => 'sqlite',
            query: jest.fn(async (sql) => queries.push(sql)),
        };

        await migration.up(sequelize);

        expect(queries.join('\n')).not.toContain('pg_constraint');
    });

    test('drops only the Ads Studio tables on rollback', async () => {
        const sequelize = { getDialect: () => 'postgres', query: jest.fn() };

        await migration.down(sequelize);

        expect(sequelize.query).toHaveBeenCalledTimes(3);
        expect(sequelize.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS ads_studio_drafts CASCADE;');
        expect(sequelize.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS ads_studio_campaign_metrics CASCADE;');
        expect(sequelize.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS ads_studio_reports CASCADE;');
    });
});
