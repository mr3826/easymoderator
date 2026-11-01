'use strict';

const mockReport = {
    findOrCreate: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
};
const mockMetric = {
    bulkCreate: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
};
const mockDraft = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
};
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockSequelize = {
    transaction: jest.fn((callback) => callback(mockTransaction)),
};
const mockAuditLogOperation = jest.fn();

jest.mock('../../entities', () => ({
    AdsStudioReport: mockReport,
    AdsStudioCampaignMetric: mockMetric,
    AdsStudioDraft: mockDraft,
}));
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockSequelize }));
jest.mock('../../audit/audit.service', () => ({ logOperation: mockAuditLogOperation }));

const { AppError } = require('../../../utils/AppError');
const service = require('../ads-studio.service');
const { MAX_CSV_BYTES } = require('../ads-studio.validator');

const CSV = [
    'Campaign name,Reporting starts,Reporting ends,Amount spent (USD),Impressions,Link clicks',
    'Spring launch,2026-10-01,2026-10-07,12.340000,100,0',
    '',
].join('\r\n');

beforeEach(() => {
    jest.clearAllMocks();
    mockSequelize.transaction.mockImplementation((callback) => callback(mockTransaction));
});

describe('Ads Studio manual CSV parsing', () => {
    test('parses supported columns, preserves exact metric strings, and reports absent columns', () => {
        const parsed = service.parseManualMetaCsv(CSV);
        expect(parsed.currency).toBe('USD');
        expect(parsed.period_start).toBe('2026-10-01');
        expect(parsed.period_end).toBe('2026-10-07');
        expect(parsed.campaigns[0].raw_metrics).toEqual({
            amount_spent: '12.340000',
            impressions: '100',
            link_clicks: '0',
        });
        expect(parsed.columns_present).toContain('currency');
        expect(parsed.columns_present).toContain('link_clicks');
        expect(parsed.columns_missing).toContain('reach');
        expect(parsed.unsupported_columns).toEqual([]);
    });

    test('rejects malformed and oversized CSV input', () => {
        expect(() => service.parseManualMetaCsv('Campaign name,"broken')).toThrow(AppError);
        try {
            service.parseManualMetaCsv('x'.repeat(MAX_CSV_BYTES + 1));
            throw new Error('Expected oversized CSV to be rejected');
        } catch (error) {
            expect(error).toMatchObject({ status: 413, code: 'ADS_STUDIO_CSV_TOO_LARGE' });
        }
    });

    test('requires campaign rows, report period, and a currency-bearing spend header', () => {
        expect(() => service.parseManualMetaCsv(
            'Campaign name,Reporting starts,Reporting ends,Amount spent (USD)',
        )).toThrow(/at least one campaign row/i);
        expect(() => service.parseManualMetaCsv([
            'Campaign name,Reporting starts,Reporting ends,Amount spent',
            'Spring,2026-10-01,2026-10-07,12.34',
        ].join('\n'))).toThrow(/currency/i);
        expect(() => service.parseManualMetaCsv([
            'Campaign name,Reporting starts,Reporting ends,Amount spent (USD)',
            'Spring,2026-10-07,2026-10-01,12.34',
        ].join('\n'))).toThrow(/reversed report period/i);
    });

    test('rejects reports above the 5,000 campaign row limit', () => {
        const header = 'Campaign name,Reporting starts,Reporting ends,Amount spent (USD)';
        const campaign = 'Spring,2026-10-01,2026-10-07,1.00';
        const csv = [header, ...Array(5001).fill(campaign)].join('\n');
        expect(() => service.parseManualMetaCsv(csv)).toThrow(/too many data rows/i);
    });

    test('accepts exactly 5,000 campaign rows plus the CSV header', () => {
        const header = 'Campaign name,Reporting starts,Reporting ends,Amount spent (USD)';
        const campaign = 'Spring,2026-10-01,2026-10-07,1.00';
        const parsed = service.parseManualMetaCsv([header, ...Array(5000).fill(campaign)].join('\n'));
        expect(parsed.campaigns).toHaveLength(5000);
    });

    test.each([
        ['negative amount', '-0.10', '100', '1'],
        ['too many decimal places', '1.1234567', '100', '1'],
        ['fractional impressions', '1.10', '100.5', '1'],
        ['exponential notation', '1e3', '100', '1'],
    ])('rejects invalid metric values (%s)', (_label, spend, impressions, clicks) => {
        const csv = [
            'Campaign name,Reporting starts,Reporting ends,Amount spent (USD),Impressions,Link clicks',
            `Spring,2026-10-01,2026-10-07,${spend},${impressions},${clicks}`,
        ].join('\n');
        expect(() => service.parseManualMetaCsv(csv)).toThrow(/nonnegative|supported range/i);
    });

    test('accepts grouped nonnegative values without losing the imported representation', () => {
        const parsed = service.parseManualMetaCsv([
            'Campaign name,Reporting starts,Reporting ends,Amount spent (BDT),Impressions,Link clicks',
            'Spring,2026-10-01,2026-10-07,"1,234.50","1,234",12',
        ].join('\n'));
        expect(parsed.currency).toBe('BDT');
        expect(parsed.campaigns[0].raw_metrics).toEqual({
            amount_spent: '1,234.50',
            impressions: '1,234',
            link_clicks: '12',
        });
    });

    test('enforces the upload limit in UTF-8 bytes, not JavaScript character count', () => {
        const oversizedUtf8 = `é${'x'.repeat(MAX_CSV_BYTES - 1)}`;
        expect(oversizedUtf8.length).toBeLessThanOrEqual(MAX_CSV_BYTES);
        expect(Buffer.byteLength(oversizedUtf8, 'utf8')).toBeGreaterThan(MAX_CSV_BYTES);
        expect(() => service.parseManualMetaCsv(oversizedUtf8)).toThrow(expect.objectContaining({
            status: 413,
            code: 'ADS_STUDIO_CSV_TOO_LARGE',
        }));
    });
});

describe('Ads Studio report persistence and recommendations', () => {
    test('deduplicates a repeated shop-scoped import by the raw CSV hash', async () => {
        const savedReport = {
            id: 'report-1', shop_id: 'shop-a', period_start: '2026-10-01', period_end: '2026-10-07',
            currency: 'USD', importer_user_id: 'user-a', source: 'manual_csv_upload', content_hash: 'a'.repeat(64),
            columns_present: ['campaign_name'], columns_missing: [], unsupported_columns: [], rows_count: 1,
        };
        mockReport.findOrCreate.mockResolvedValue([savedReport, false]);
        mockMetric.findAll.mockResolvedValue([{ id: 'metric-1' }]);

        const result = await service.importManualReport('shop-a', 'user-a', CSV);

        expect(result.duplicate).toBe(true);
        expect(result.campaign_count).toBe(1);
        expect(result.provenance).toBe('merchant_uploaded_unverified');
        expect(mockReport.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
            where: { shop_id: 'shop-a', content_hash: expect.any(String) },
            defaults: expect.objectContaining({
                importer_user_id: 'user-a',
                source: 'manual_csv_upload',
                currency: 'USD',
            }),
        }));
        expect(mockMetric.findAll).toHaveBeenCalledWith(expect.objectContaining({
            where: { shop_id: 'shop-a', report_id: 'report-1' },
        }));
        expect(mockMetric.bulkCreate).not.toHaveBeenCalled();
    });

    test('persists campaign rows in the same transaction as a new report', async () => {
        const report = {
            id: 'report-2', shop_id: 'shop-a', period_start: '2026-10-01', period_end: '2026-10-07',
            currency: 'USD', importer_user_id: 'user-a', source: 'manual_csv_upload', content_hash: 'b'.repeat(64),
            columns_present: ['campaign_name', 'amount_spent'], columns_missing: ['reach'],
            unsupported_columns: [], rows_count: 1,
        };
        mockReport.findOrCreate.mockResolvedValue([report, true]);
        mockMetric.bulkCreate.mockResolvedValue([]);

        const result = await service.importManualReport('shop-a', 'user-a', CSV);

        expect(result.duplicate).toBe(false);
        expect(mockMetric.bulkCreate).toHaveBeenCalledWith([
            expect.objectContaining({
                shop_id: 'shop-a',
                report_id: 'report-2',
                row_number: 2,
                campaign_name: 'Spring launch',
                raw_metrics: { amount_spent: '12.340000', impressions: '100', link_clicks: '0' },
            }),
        ], { transaction: mockTransaction });
    });

    test('recovers a concurrent identical import after its unique transaction rolls back', async () => {
        const report = {
            id: 'report-race', shop_id: 'shop-a', period_start: '2026-10-01', period_end: '2026-10-07',
            currency: 'USD', importer_user_id: 'user-a', source: 'manual_csv_upload', content_hash: 'd'.repeat(64),
            columns_present: ['campaign_name'], columns_missing: [], unsupported_columns: [], rows_count: 1,
        };
        let attempts = 0;
        mockReport.findOrCreate.mockImplementation(async () => {
            attempts += 1;
            if (attempts === 1) return [report, true];
            const duplicate = new Error('unique conflict');
            duplicate.name = 'SequelizeUniqueConstraintError';
            duplicate.fields = { shop_id: 'shop-a', content_hash: 'd'.repeat(64) };
            throw duplicate;
        });
        mockReport.findOne.mockResolvedValue(report);
        mockMetric.findAll.mockResolvedValue([{ id: 'metric-1' }]);
        mockMetric.bulkCreate.mockResolvedValue([]);

        const results = await Promise.all([
            service.importManualReport('shop-a', 'user-a', CSV),
            service.importManualReport('shop-a', 'user-a', CSV),
        ]);

        expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([false, true]);
        expect(results.every(({ id }) => id === 'report-race')).toBe(true);
        expect(mockMetric.bulkCreate).toHaveBeenCalledTimes(1);
        expect(mockReport.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { shop_id: 'shop-a', content_hash: expect.any(String) },
        }));
    });

    test('does not convert unrelated unique-constraint failures into duplicate reports', async () => {
        const unique = new Error('metric row unique conflict');
        unique.name = 'SequelizeUniqueConstraintError';
        unique.fields = { report_id: 'report-1', row_number: 2 };
        mockReport.findOrCreate.mockRejectedValue(unique);

        await expect(service.importManualReport('shop-a', 'user-a', CSV)).rejects.toBe(unique);
        expect(mockReport.findOne).not.toHaveBeenCalled();
    });

    test('scopes report lookup by shop and does not look up a foreign report metric', async () => {
        mockReport.findOne.mockResolvedValue(null);
        await expect(service.getReport('shop-a', 'foreign-report')).rejects.toMatchObject({ status: 404 });
        expect(mockReport.findOne).toHaveBeenCalledWith({ where: { id: 'foreign-report', shop_id: 'shop-a' } });
        expect(mockMetric.findAll).not.toHaveBeenCalled();
    });

    test('recommendations cite the report, campaign, and exact imported metrics only', () => {
        const recommendations = service.generateRecommendations({
            id: 'report-3', period_start: '2026-10-01', period_end: '2026-10-07', currency: 'USD',
        }, [{
            id: 'metric-3', campaign_name: 'Spring launch',
            raw_metrics: { amount_spent: '12.340000', link_clicks: '0', purchase_roas: '999' },
        }]);

        expect(recommendations).toHaveLength(1);
        expect(recommendations[0]).toMatchObject({
            code: 'SPEND_WITHOUT_LINK_CLICKS',
            report_id: 'report-3',
            campaign_metric_id: 'metric-3',
            campaign_name: 'Spring launch',
            evidence: { amount_spent: '12.340000', link_clicks: '0' },
        });
        expect(recommendations[0].text).toContain('report-3');
        expect(recommendations[0].text).toContain('Spring launch');
        expect(recommendations[0].text).toContain('12.340000 USD');
        expect(recommendations[0].text).toContain('0 link clicks');
        expect(recommendations[0].text).not.toMatch(/ROAS|profit|orders|sales attributed/i);
    });
});

describe('Ads Studio draft approval', () => {
    test('approval is idempotent, records one actor audit, and performs no external operation', async () => {
        const row = {
            id: 'draft-1', shop_id: 'shop-a', report_id: 'report-1', campaign_metric_id: 'metric-1',
            recommendation_id: 'c'.repeat(64), recommendation_code: 'LINK_CLICK_FOLLOWUP',
            title: 'Review Spring', status: 'draft', created_by: 'user-a', approved_by: null, approved_at: null,
        };
        mockDraft.findOne.mockImplementation(async ({ where }) => (
            where.shop_id === 'shop-a' && where.id === 'draft-1' ? row : null
        ));
        mockDraft.update.mockImplementation(async (values) => {
            Object.assign(row, values);
            return [1];
        });
        mockAuditLogOperation.mockResolvedValue(undefined);

        const first = await service.approveDraft('shop-a', 'user-a', 'draft-1');
        const second = await service.approveDraft('shop-a', 'user-a', 'draft-1');

        expect(first.status).toBe('approved');
        expect(first.approval).toEqual({ changed: true, external_operation_performed: false });
        expect(second.approval).toEqual({ changed: false, external_operation_performed: false });
        expect(mockDraft.update).toHaveBeenCalledTimes(1);
        expect(mockAuditLogOperation).toHaveBeenCalledTimes(1);
        expect(mockAuditLogOperation).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-a', shopId: 'shop-a', action: 'ads_studio.draft_approved',
            resourceType: 'ads_studio_draft', resourceId: 'draft-1',
            metadata: { external_operation_performed: false },
        }), { transaction: mockTransaction, required: true });
    });

    test('does not expose or update drafts from another shop', async () => {
        mockDraft.findOne.mockResolvedValue(null);
        await expect(service.approveDraft('shop-a', 'user-a', 'foreign-draft')).rejects.toMatchObject({ status: 404 });
        expect(mockDraft.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'foreign-draft', shop_id: 'shop-a' },
        }));
        expect(mockDraft.update).not.toHaveBeenCalled();
        expect(mockAuditLogOperation).not.toHaveBeenCalled();
    });
});
