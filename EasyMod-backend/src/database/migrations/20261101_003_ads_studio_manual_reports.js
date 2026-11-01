'use strict';

async function ensureConstraint(sequelize, table, name, definition) {
    if (sequelize.getDialect?.() !== 'postgres') return;
    await sequelize.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '${name}' AND conrelid = '${table}'::regclass
            ) THEN
                ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
            END IF;
        END;
        $$;
    `);
}

module.exports = {
    name: '20261101_003_ads_studio_manual_reports',

    up: async (sequelize) => {
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ads_studio_reports (
                id UUID PRIMARY KEY,
                shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
                period_start DATE NOT NULL,
                period_end DATE NOT NULL,
                currency VARCHAR(3) NOT NULL,
                importer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                source VARCHAR(32) NOT NULL CHECK (source = 'manual_csv_upload'),
                content_hash CHAR(64) NOT NULL,
                columns_present JSONB NOT NULL DEFAULT '[]',
                columns_missing JSONB NOT NULL DEFAULT '[]',
                unsupported_columns JSONB NOT NULL DEFAULT '[]',
                rows_count INTEGER NOT NULL CHECK (rows_count BETWEEN 1 AND 5000),
                imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT ads_studio_reports_period_check CHECK (period_start <= period_end),
                CONSTRAINT ads_studio_reports_id_shop_unique UNIQUE (shop_id, id)
            );
        `);
        await ensureConstraint(sequelize, 'ads_studio_reports', 'ads_studio_reports_source_check', "CHECK (source = 'manual_csv_upload')");
        await ensureConstraint(sequelize, 'ads_studio_reports', 'ads_studio_reports_rows_count_check', 'CHECK (rows_count BETWEEN 1 AND 5000)');
        await ensureConstraint(sequelize, 'ads_studio_reports', 'ads_studio_reports_period_check', 'CHECK (period_start <= period_end)');
        await ensureConstraint(sequelize, 'ads_studio_reports', 'ads_studio_reports_id_shop_unique', 'UNIQUE (shop_id, id)');
        await ensureConstraint(sequelize, 'ads_studio_reports', 'ads_studio_reports_importer_user_id_fkey', 'FOREIGN KEY (importer_user_id) REFERENCES users(id) ON DELETE RESTRICT');
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_studio_reports_shop_hash
                ON ads_studio_reports(shop_id, content_hash);
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ads_studio_reports_shop_period
                ON ads_studio_reports(shop_id, period_start DESC, imported_at DESC);
        `);

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ads_studio_campaign_metrics (
                id UUID PRIMARY KEY,
                shop_id UUID NOT NULL,
                report_id UUID NOT NULL,
                row_number INTEGER NOT NULL CHECK (row_number BETWEEN 2 AND 5001),
                campaign_name VARCHAR(255) NOT NULL,
                raw_metrics JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT ads_studio_metrics_report_shop_fk
                    FOREIGN KEY (shop_id, report_id)
                    REFERENCES ads_studio_reports(shop_id, id) ON DELETE CASCADE,
                CONSTRAINT ads_studio_metrics_row_unique UNIQUE (shop_id, report_id, row_number),
                CONSTRAINT ads_studio_metrics_id_scope_unique UNIQUE (shop_id, report_id, id)
            );
        `);
        await ensureConstraint(sequelize, 'ads_studio_campaign_metrics', 'ads_studio_campaign_metrics_row_number_check', 'CHECK (row_number BETWEEN 2 AND 5001)');
        await ensureConstraint(sequelize, 'ads_studio_campaign_metrics', 'ads_studio_metrics_report_shop_fk', 'FOREIGN KEY (shop_id, report_id) REFERENCES ads_studio_reports(shop_id, id) ON DELETE CASCADE');
        await ensureConstraint(sequelize, 'ads_studio_campaign_metrics', 'ads_studio_metrics_row_unique', 'UNIQUE (shop_id, report_id, row_number)');
        await ensureConstraint(sequelize, 'ads_studio_campaign_metrics', 'ads_studio_metrics_id_scope_unique', 'UNIQUE (shop_id, report_id, id)');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ads_studio_metrics_shop_report
                ON ads_studio_campaign_metrics(shop_id, report_id, row_number);
        `);

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS ads_studio_drafts (
                id UUID PRIMARY KEY,
                shop_id UUID NOT NULL,
                report_id UUID NOT NULL,
                campaign_metric_id UUID NOT NULL,
                recommendation_id CHAR(64) NOT NULL,
                recommendation_code VARCHAR(48) NOT NULL CHECK (
                    recommendation_code IN ('SPEND_WITHOUT_LINK_CLICKS', 'LINK_CLICK_FOLLOWUP')
                ),
                title VARCHAR(120) NOT NULL,
                objective VARCHAR(120),
                audience_notes TEXT,
                creative_notes TEXT,
                copy_draft TEXT,
                status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
                created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
                approved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT ads_studio_drafts_report_shop_fk
                    FOREIGN KEY (shop_id, report_id)
                    REFERENCES ads_studio_reports(shop_id, id) ON DELETE RESTRICT,
                CONSTRAINT ads_studio_drafts_metric_scope_fk
                    FOREIGN KEY (shop_id, report_id, campaign_metric_id)
                    REFERENCES ads_studio_campaign_metrics(shop_id, report_id, id) ON DELETE RESTRICT,
                CONSTRAINT ads_studio_drafts_approval_check CHECK (
                    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
                    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
                )
            );
        `);
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_recommendation_code_check', "CHECK (recommendation_code IN ('SPEND_WITHOUT_LINK_CLICKS', 'LINK_CLICK_FOLLOWUP'))");
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_status_check', "CHECK (status IN ('draft', 'approved'))");
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_report_shop_fk', 'FOREIGN KEY (shop_id, report_id) REFERENCES ads_studio_reports(shop_id, id) ON DELETE RESTRICT');
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_metric_scope_fk', 'FOREIGN KEY (shop_id, report_id, campaign_metric_id) REFERENCES ads_studio_campaign_metrics(shop_id, report_id, id) ON DELETE RESTRICT');
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT');
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_approved_by_fkey', 'FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE RESTRICT');
        await ensureConstraint(sequelize, 'ads_studio_drafts', 'ads_studio_drafts_approval_check', "CHECK ((status = 'draft' AND approved_by IS NULL AND approved_at IS NULL) OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL))");
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ads_studio_drafts_shop_created
                ON ads_studio_drafts(shop_id, created_at DESC);
        `);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_ads_studio_drafts_shop_status
                ON ads_studio_drafts(shop_id, status, created_at DESC);
        `);
    },

    down: async (sequelize) => {
        const cascade = sequelize.getDialect?.() === 'sqlite' ? '' : ' CASCADE';
        await sequelize.query(`DROP TABLE IF EXISTS ads_studio_drafts${cascade};`);
        await sequelize.query(`DROP TABLE IF EXISTS ads_studio_campaign_metrics${cascade};`);
        await sequelize.query(`DROP TABLE IF EXISTS ads_studio_reports${cascade};`);
    },
};
