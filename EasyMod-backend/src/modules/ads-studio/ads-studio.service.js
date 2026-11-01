'use strict';

const crypto = require('crypto');
const { sequelize } = require('../../utils/database/database-setup');
const { AppError } = require('../../utils/AppError');
const AuditService = require('../audit/audit.service');
const { MAX_CSV_BYTES, RECOMMENDATION_CODES } = require('./ads-studio.validator');

const MAX_ROWS = 5000;
const MAX_COLUMNS = 64;
const MAX_CELL_CHARS = 4096;
const SUPPORTED_COLUMNS = Object.freeze([
    'campaign_name', 'period_start', 'period_end', 'currency', 'amount_spent',
    'impressions', 'reach', 'link_clicks', 'ctr_link_click', 'cpc_link_click', 'cpm', 'frequency',
]);
const METRIC_TYPES = Object.freeze({
    amount_spent: 'decimal',
    impressions: 'integer',
    reach: 'integer',
    link_clicks: 'integer',
    ctr_link_click: 'decimal',
    cpc_link_click: 'decimal',
    cpm: 'decimal',
    frequency: 'decimal',
});
const EDITABLE_DRAFT_FIELDS = Object.freeze([
    'title', 'objective', 'audience_notes', 'creative_notes', 'copy_draft',
]);

const entities = () => require('../entities');
const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);
const invalidCsv = (message) => new AppError(message, 400, 'ADS_STUDIO_CSV_INVALID');

function parseCsvRows(csv) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let afterQuote = false;

    const pushField = () => {
        row.push(field);
        field = '';
        afterQuote = false;
        if (row.length > MAX_COLUMNS) throw invalidCsv('CSV has too many columns');
    };
    const pushRow = () => {
        pushField();
        if (row.some((cell) => cell.trim() !== '')) {
            // The first row is the CSV header, so MAX_ROWS campaign rows are
            // represented by MAX_ROWS + 1 parsed rows including that header.
            if (rows.length > MAX_ROWS) throw invalidCsv('CSV has too many data rows');
            rows.push(row);
        }
        row = [];
    };

    for (let i = 0; i < csv.length; i += 1) {
        const character = csv[i];
        if (quoted) {
            if (character === '"') {
                if (csv[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    quoted = false;
                    afterQuote = true;
                }
            } else {
                field += character;
            }
        } else if (afterQuote) {
            if (character === ',') pushField();
            else if (character === '\r' || character === '\n') {
                pushRow();
                if (character === '\r' && csv[i + 1] === '\n') i += 1;
            } else {
                throw invalidCsv('CSV contains characters after a quoted field');
            }
        } else if (character === '"') {
            if (field.length !== 0) throw invalidCsv('CSV contains an invalid quoted field');
            quoted = true;
        } else if (character === ',') {
            pushField();
        } else if (character === '\r' || character === '\n') {
            pushRow();
            if (character === '\r' && csv[i + 1] === '\n') i += 1;
        } else {
            field += character;
        }
        if (field.length > MAX_CELL_CHARS) throw invalidCsv('CSV contains an oversized cell');
    }

    if (quoted) throw invalidCsv('CSV contains an unterminated quoted field');
    if (field.length || row.length || afterQuote) pushRow();
    return rows;
}

function parseIsoDate(value, label) {
    const date = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalidCsv(`${label} must use YYYY-MM-DD`);
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw invalidCsv(`${label} is not a valid calendar date`);
    }
    return date;
}

function parseMetric(rawValue, type, column) {
    const raw = rawValue.trim();
    const decimal = type === 'decimal';
    const match = raw.match(/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?$/);
    if (!match || (!decimal && raw.includes('.'))) {
        throw invalidCsv(`${column} must be a finite nonnegative ${decimal ? 'decimal with at most 6 places' : 'integer'}`);
    }
    const ungrouped = raw.replace(/,/g, '');
    const integerDigits = ungrouped.split('.')[0].length;
    if (integerDigits > (decimal ? 12 : 15)) throw invalidCsv(`${column} is outside the supported range`);
    const number = Number(ungrouped);
    if (!Number.isFinite(number) || number < 0 || (!decimal && !Number.isSafeInteger(number))) {
        throw invalidCsv(`${column} is outside the supported range`);
    }
    return raw;
}

function mapHeaders(headerRow) {
    const headerIndexes = {};
    const unsupported = [];
    let currency = null;
    const aliases = new Map([
        ['campaign name', 'campaign_name'],
        ['reporting starts', 'period_start'],
        ['reporting ends', 'period_end'],
        ['impressions', 'impressions'],
        ['reach', 'reach'],
        ['link clicks', 'link_clicks'],
        ['ctr (link click-through rate)', 'ctr_link_click'],
        ['cpc (cost per link click)', 'cpc_link_click'],
        ['cpm (cost per 1,000 impressions)', 'cpm'],
        ['frequency', 'frequency'],
    ]);

    headerRow.forEach((rawHeader, index) => {
        const header = rawHeader.replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ');
        if (!header) throw invalidCsv('CSV contains a blank column name');
        const normalized = header.toLowerCase();
        let key = aliases.get(normalized);
        if (/^amount spent(?:\s*\(.*\))?$/i.test(header)) {
            key = 'amount_spent';
            const currencyMatch = header.match(/^amount spent\s*\(([A-Z]{3})\)$/i);
            currency = currencyMatch ? currencyMatch[1].toUpperCase() : null;
        }
        if (!key) {
            unsupported.push(header.slice(0, 128));
            return;
        }
        if (Object.hasOwn(headerIndexes, key)) throw invalidCsv(`CSV contains duplicate ${key} columns`);
        headerIndexes[key] = index;
    });

    for (const required of ['campaign_name', 'period_start', 'period_end', 'amount_spent']) {
        if (!Object.hasOwn(headerIndexes, required)) throw invalidCsv(`CSV is missing required ${required} data`);
    }
    if (!currency) throw invalidCsv('CSV must include currency in the Amount spent (XXX) column name');
    if (!/^[A-Z]{3}$/.test(currency)) throw invalidCsv('CSV currency code is invalid');

    const present = SUPPORTED_COLUMNS.filter((key) => key === 'currency' ? Boolean(currency) : Object.hasOwn(headerIndexes, key));
    return {
        headerIndexes,
        currency,
        columnsPresent: present,
        columnsMissing: SUPPORTED_COLUMNS.filter((key) => !present.includes(key)),
        unsupportedColumns: unsupported,
    };
}

function parseManualMetaCsv(csv) {
    if (typeof csv !== 'string' || !csv.length) throw invalidCsv('CSV content is required');
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) throw new AppError('CSV exceeds the 2 MiB upload limit', 413, 'ADS_STUDIO_CSV_TOO_LARGE');
    if (csv.includes('\0')) throw invalidCsv('CSV contains an invalid NUL character');

    const rows = parseCsvRows(csv);
    if (rows.length < 2) throw invalidCsv('CSV must contain headers and at least one campaign row');
    const {
        headerIndexes, currency, columnsPresent, columnsMissing, unsupportedColumns,
    } = mapHeaders(rows[0]);
    const dataRows = rows.slice(1);
    if (!dataRows.length) throw invalidCsv('CSV must contain at least one campaign row');

    let periodStart = null;
    let periodEnd = null;
    const campaigns = dataRows.map((cells, index) => {
        if (cells.length !== rows[0].length) throw invalidCsv(`CSV row ${index + 2} has a different number of columns`);
        const campaignName = cells[headerIndexes.campaign_name].trim();
        if (!campaignName || campaignName.length > 255 || /[\u0000-\u001f\u007f]/.test(campaignName)) {
            throw invalidCsv(`CSV row ${index + 2} has an invalid campaign name`);
        }
        const rowStart = parseIsoDate(cells[headerIndexes.period_start], 'Reporting starts');
        const rowEnd = parseIsoDate(cells[headerIndexes.period_end], 'Reporting ends');
        if (rowStart > rowEnd) throw invalidCsv(`CSV row ${index + 2} has a reversed report period`);
        if (periodStart && (rowStart !== periodStart || rowEnd !== periodEnd)) {
            throw invalidCsv('All campaign rows must use the same report period');
        }
        periodStart = rowStart;
        periodEnd = rowEnd;

        const rawMetrics = {};
        for (const [key, type] of Object.entries(METRIC_TYPES)) {
            if (!Object.hasOwn(headerIndexes, key)) continue;
            rawMetrics[key] = parseMetric(cells[headerIndexes[key]], type, key);
        }
        return {
            row_number: index + 2,
            campaign_name: campaignName,
            raw_metrics: rawMetrics,
        };
    });

    return {
        period_start: periodStart,
        period_end: periodEnd,
        currency,
        columns_present: columnsPresent,
        columns_missing: columnsMissing,
        unsupported_columns: unsupportedColumns,
        campaigns,
    };
}

function toNumber(raw) {
    const number = Number(String(raw).replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

function recommendationId(reportId, campaignMetricId, code) {
    return crypto.createHash('sha256')
        .update(`${reportId}\0${campaignMetricId}\0${code}`)
        .digest('hex');
}

function generateRecommendations(reportInput, metricRows) {
    const report = plain(reportInput) || {};
    const recommendations = [];
    for (const metricInput of metricRows || []) {
        const metric = plain(metricInput) || {};
        const metrics = metric.raw_metrics || {};
        const spend = toNumber(metrics.amount_spent);
        const clicks = toNumber(metrics.link_clicks);
        let code;
        let evidence;
        let text;

        if (spend > 0 && clicks === 0) {
            code = 'SPEND_WITHOUT_LINK_CLICKS';
            evidence = { amount_spent: metrics.amount_spent, link_clicks: metrics.link_clicks };
            text = `Imported report ${report.id} (${report.period_start} to ${report.period_end}) records ${metrics.amount_spent} ${report.currency} spent and ${metrics.link_clicks} link clicks for campaign "${metric.campaign_name}". Review the creative and destination before making any manual change.`;
        } else if (clicks > 0) {
            code = 'LINK_CLICK_FOLLOWUP';
            evidence = { link_clicks: metrics.link_clicks };
            text = `Imported report ${report.id} (${report.period_start} to ${report.period_end}) records ${metrics.link_clicks} link clicks for campaign "${metric.campaign_name}". Compare this exact count with your own destination analytics before deciding on a manual change.`;
        }

        if (code && RECOMMENDATION_CODES.includes(code)) {
            recommendations.push({
                id: recommendationId(report.id, metric.id, code),
                code,
                report_id: report.id,
                campaign_metric_id: metric.id,
                campaign_name: metric.campaign_name,
                evidence,
                text,
            });
        }
    }
    return recommendations;
}

function requireModels(...names) {
    let registry;
    try {
        registry = entities();
    } catch (_) {
        throw new AppError('Ads Studio storage is unavailable', 503, 'ADS_STUDIO_STORAGE_UNAVAILABLE');
    }
    for (const name of names) {
        if (!registry?.[name]) throw new AppError('Ads Studio storage is unavailable', 503, 'ADS_STUDIO_STORAGE_UNAVAILABLE');
    }
    return registry;
}

function reportView(row) {
    const report = plain(row);
    return {
        id: report.id,
        shop_id: report.shop_id,
        period_start: report.period_start,
        period_end: report.period_end,
        currency: report.currency,
        importer_user_id: report.importer_user_id,
        source: report.source,
        provenance: 'merchant_uploaded_unverified',
        content_hash: report.content_hash,
        columns_present: report.columns_present,
        columns_missing: report.columns_missing,
        unsupported_columns: report.unsupported_columns,
        rows_count: report.rows_count,
        imported_at: report.imported_at,
    };
}

function campaignView(row) {
    const metric = plain(row);
    return {
        id: metric.id,
        campaign_name: metric.campaign_name,
        row_number: metric.row_number,
        raw_metrics: metric.raw_metrics,
    };
}

function draftView(row) {
    const draft = plain(row);
    return {
        id: draft.id,
        report_id: draft.report_id,
        campaign_metric_id: draft.campaign_metric_id,
        recommendation_id: draft.recommendation_id,
        recommendation_code: draft.recommendation_code,
        title: draft.title,
        objective: draft.objective,
        audience_notes: draft.audience_notes,
        creative_notes: draft.creative_notes,
        copy_draft: draft.copy_draft,
        status: draft.status,
        created_by: draft.created_by,
        approved_by: draft.approved_by,
        approved_at: draft.approved_at,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
    };
}

function isReportHashUniqueConflict(error) {
    if (error?.name !== 'SequelizeUniqueConstraintError' && error?.original?.code !== '23505' && error?.parent?.code !== '23505') {
        return false;
    }
    const fieldValues = error?.fields;
    const fields = new Set(Array.isArray(fieldValues) ? fieldValues : Object.keys(fieldValues || {}));
    const constraint = error?.original?.constraint || error?.parent?.constraint || '';
    return (fields.has('shop_id') && fields.has('content_hash'))
        || constraint === 'idx_ads_studio_reports_shop_hash'
        || constraint === 'ads_studio_reports_shop_id_content_hash_key';
}

async function importManualReport(shopId, userId, csv) {
    if (!shopId || !userId) throw new AppError('Authenticated shop and user are required', 403, 'SHOP_ACCESS_REQUIRED');
    const parsed = parseManualMetaCsv(csv);
    const contentHash = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
    const { AdsStudioReport: Report, AdsStudioCampaignMetric: CampaignMetric } = requireModels(
        'AdsStudioReport', 'AdsStudioCampaignMetric',
    );
    if (typeof sequelize.transaction !== 'function') {
        throw new AppError('Ads Studio storage is unavailable', 503, 'ADS_STUDIO_STORAGE_UNAVAILABLE');
    }

    let result;
    try {
        result = await sequelize.transaction(async (transaction) => {
            const [report, created] = await Report.findOrCreate({
                where: { shop_id: shopId, content_hash: contentHash },
                defaults: {
                    shop_id: shopId,
                    period_start: parsed.period_start,
                    period_end: parsed.period_end,
                    currency: parsed.currency,
                    importer_user_id: userId,
                    source: 'manual_csv_upload',
                    content_hash: contentHash,
                    columns_present: parsed.columns_present,
                    columns_missing: parsed.columns_missing,
                    unsupported_columns: parsed.unsupported_columns,
                    rows_count: parsed.campaigns.length,
                },
                transaction,
            });
            if (!created) {
                const metrics = await CampaignMetric.findAll({
                    where: { shop_id: shopId, report_id: report.id },
                    attributes: ['id'],
                    transaction,
                });
                return { report, duplicate: true, campaign_count: metrics.length };
            }

            await CampaignMetric.bulkCreate(parsed.campaigns.map((campaign) => ({
                shop_id: shopId,
                report_id: report.id,
                ...campaign,
            })), { transaction });
            return { report, duplicate: false, campaign_count: parsed.campaigns.length };
        });
    } catch (error) {
        if (!isReportHashUniqueConflict(error)) throw error;
        // The transaction that lost the unique race has rolled back before this
        // lookup, so PostgreSQL can safely read the committed winning import.
        const report = await Report.findOne({ where: { shop_id: shopId, content_hash: contentHash } });
        if (!report) throw error;
        const metrics = await CampaignMetric.findAll({
            where: { shop_id: shopId, report_id: report.id },
            attributes: ['id'],
        });
        result = { report, duplicate: true, campaign_count: metrics.length };
    }

    return { ...reportView(result.report), duplicate: result.duplicate, campaign_count: result.campaign_count };
}

async function listReports(shopId) {
    const { AdsStudioReport: Report } = requireModels('AdsStudioReport');
    const reports = await Report.findAll({
        where: { shop_id: shopId },
        order: [['imported_at', 'DESC']],
        limit: 50,
    });
    return reports.map(reportView);
}

async function getReport(shopId, reportId) {
    const { AdsStudioReport: Report, AdsStudioCampaignMetric: CampaignMetric } = requireModels(
        'AdsStudioReport', 'AdsStudioCampaignMetric',
    );
    const report = await Report.findOne({ where: { id: reportId, shop_id: shopId } });
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    const metrics = await CampaignMetric.findAll({
        where: { report_id: reportId, shop_id: shopId },
        order: [['row_number', 'ASC']],
        limit: MAX_ROWS,
    });
    const data = reportView(report);
    const campaigns = metrics.map(campaignView);
    return { ...data, campaigns, recommendations: generateRecommendations(report, metrics) };
}

async function listDrafts(shopId) {
    const { AdsStudioDraft: Draft } = requireModels('AdsStudioDraft');
    const drafts = await Draft.findAll({
        where: { shop_id: shopId },
        order: [['created_at', 'DESC']],
        limit: 100,
    });
    return drafts.map(draftView);
}

async function createDraft(shopId, userId, input) {
    const { AdsStudioReport: Report, AdsStudioCampaignMetric: CampaignMetric, AdsStudioDraft: Draft } = requireModels(
        'AdsStudioReport', 'AdsStudioCampaignMetric', 'AdsStudioDraft',
    );
    const report = await Report.findOne({ where: { id: input.report_id, shop_id: shopId } });
    if (!report) throw new AppError('Recommendation not found', 404, 'NOT_FOUND');
    const metric = await CampaignMetric.findOne({
        where: { id: input.campaign_metric_id, report_id: input.report_id, shop_id: shopId },
    });
    if (!metric) throw new AppError('Recommendation not found', 404, 'NOT_FOUND');
    const recommendation = generateRecommendations(report, [metric])
        .find((item) => item.code === input.recommendation_code);
    if (!recommendation) throw new AppError('Recommendation not found', 404, 'NOT_FOUND');

    const title = input.title || `Review ${plain(metric).campaign_name}`.slice(0, 120);
    const draft = await Draft.create({
        shop_id: shopId,
        report_id: input.report_id,
        campaign_metric_id: input.campaign_metric_id,
        recommendation_id: recommendation.id,
        recommendation_code: recommendation.code,
        title,
        objective: input.objective || null,
        audience_notes: input.audience_notes || null,
        creative_notes: input.creative_notes || null,
        copy_draft: input.copy_draft || null,
        status: 'draft',
        created_by: userId,
        approved_by: null,
        approved_at: null,
    });
    return { ...draftView(draft), recommendation };
}

async function updateDraft(shopId, draftId, input) {
    const { AdsStudioDraft: Draft } = requireModels('AdsStudioDraft');
    const updates = Object.fromEntries(EDITABLE_DRAFT_FIELDS
        .filter((field) => Object.hasOwn(input, field))
        .map((field) => [field, input[field]]));
    if (!Object.keys(updates).length) throw new AppError('At least one editable draft field is required', 400, 'VALIDATION_ERROR');

    const updated = await sequelize.transaction(async (transaction) => {
        const draft = await Draft.findOne({
            where: { id: draftId, shop_id: shopId },
            transaction,
            lock: true,
        });
        if (!draft) throw new AppError('Draft not found', 404, 'NOT_FOUND');
        if (draft.status !== 'draft') throw new AppError('Approved drafts cannot be edited', 409, 'DRAFT_ALREADY_APPROVED');
        const updateResult = await Draft.update(updates, {
            where: { id: draftId, shop_id: shopId, status: 'draft' },
            transaction,
        });
        const updatedCount = Array.isArray(updateResult) ? updateResult[0] : updateResult;
        if (!updatedCount) throw new AppError('Draft changed while it was being edited', 409, 'DRAFT_STATE_CONFLICT');
        return Draft.findOne({ where: { id: draftId, shop_id: shopId }, transaction });
    });
    return draftView(updated);
}

async function approveDraft(shopId, userId, draftId) {
    const { AdsStudioDraft: Draft } = requireModels('AdsStudioDraft');
    if (!sequelize.transaction || typeof AuditService.logOperation !== 'function') {
        throw new AppError('Approval audit storage is unavailable', 503, 'ADS_STUDIO_AUDIT_UNAVAILABLE');
    }

    const result = await sequelize.transaction(async (transaction) => {
        const draft = await Draft.findOne({
            where: { id: draftId, shop_id: shopId },
            transaction,
            lock: true,
        });
        if (!draft) throw new AppError('Draft not found', 404, 'NOT_FOUND');
        if (draft.status === 'approved') return { draft, changed: false };
        if (draft.status !== 'draft') throw new AppError('Draft cannot be approved in its current state', 409, 'DRAFT_STATE_INVALID');

        const approvedAt = new Date();
        const updateResult = await Draft.update({
            status: 'approved',
            approved_by: userId,
            approved_at: approvedAt,
        }, {
            where: { id: draftId, shop_id: shopId, status: 'draft' },
            transaction,
        });
        const updatedCount = Array.isArray(updateResult) ? updateResult[0] : updateResult;
        if (!updatedCount) {
            const current = await Draft.findOne({ where: { id: draftId, shop_id: shopId }, transaction });
            if (current?.status === 'approved') return { draft: current, changed: false };
            throw new AppError('Draft changed while it was being approved', 409, 'DRAFT_STATE_CONFLICT');
        }
        await AuditService.logOperation({
            userId,
            shopId,
            action: 'ads_studio.draft_approved',
            resourceType: 'ads_studio_draft',
            resourceId: draftId,
            newValues: { status: 'approved', approved_by: userId, approved_at: approvedAt.toISOString() },
            metadata: { external_operation_performed: false },
        }, { transaction, required: true });
        const approved = await Draft.findOne({ where: { id: draftId, shop_id: shopId }, transaction });
        return { draft: approved, changed: true };
    });

    return {
        ...draftView(result.draft),
        approval: { changed: result.changed, external_operation_performed: false },
    };
}

module.exports = {
    MAX_ROWS,
    parseManualMetaCsv,
    generateRecommendations,
    _private: { isReportHashUniqueConflict },
    importManualReport,
    listReports,
    getReport,
    listDrafts,
    createDraft,
    updateDraft,
    approveDraft,
};
