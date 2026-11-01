'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

const AdsStudioReport = sequelize.define('AdsStudioReport', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    shop_id: { type: DataTypes.UUID, allowNull: false },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end: { type: DataTypes.DATEONLY, allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    importer_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
    },
    source: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'manual_csv_upload' },
    content_hash: { type: DataTypes.STRING(64), allowNull: false },
    columns_present: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    columns_missing: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    unsupported_columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    rows_count: { type: DataTypes.INTEGER, allowNull: false },
    imported_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
    tableName: 'ads_studio_reports',
    underscored: true,
    timestamps: true,
    indexes: [
        { unique: true, fields: ['shop_id', 'content_hash'] },
        { fields: ['shop_id', 'period_start', 'imported_at'] },
    ],
});

const AdsStudioCampaignMetric = sequelize.define('AdsStudioCampaignMetric', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    shop_id: { type: DataTypes.UUID, allowNull: false },
    report_id: { type: DataTypes.UUID, allowNull: false },
    row_number: { type: DataTypes.INTEGER, allowNull: false },
    campaign_name: { type: DataTypes.STRING(255), allowNull: false },
    raw_metrics: { type: DataTypes.JSONB, allowNull: false },
}, {
    tableName: 'ads_studio_campaign_metrics',
    underscored: true,
    timestamps: true,
    indexes: [
        { unique: true, fields: ['shop_id', 'report_id', 'row_number'] },
        { fields: ['shop_id', 'report_id'] },
    ],
});

const AdsStudioDraft = sequelize.define('AdsStudioDraft', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    shop_id: { type: DataTypes.UUID, allowNull: false },
    report_id: { type: DataTypes.UUID, allowNull: false },
    campaign_metric_id: { type: DataTypes.UUID, allowNull: false },
    recommendation_id: { type: DataTypes.STRING(64), allowNull: false },
    recommendation_code: { type: DataTypes.STRING(48), allowNull: false },
    title: { type: DataTypes.STRING(120), allowNull: false },
    objective: { type: DataTypes.STRING(120), allowNull: true },
    audience_notes: { type: DataTypes.TEXT, allowNull: true },
    creative_notes: { type: DataTypes.TEXT, allowNull: true },
    copy_draft: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft' },
    created_by: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
    },
    approved_by: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
    },
    approved_at: { type: DataTypes.DATE, allowNull: true },
}, {
    tableName: 'ads_studio_drafts',
    underscored: true,
    timestamps: true,
    indexes: [
        { fields: ['shop_id', 'created_at'] },
        { fields: ['shop_id', 'status', 'created_at'] },
    ],
});

module.exports = { AdsStudioReport, AdsStudioCampaignMetric, AdsStudioDraft };
