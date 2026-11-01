import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/shared/lib/http/client';
import {
  approveAdsStudioDraft,
  createAdsStudioDraft,
  getAdsStudioReport,
  importAdsStudioReport,
  listAdsStudioDrafts,
  listAdsStudioReports,
  updateAdsStudioDraft,
} from '../adsStudio';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

describe('Ads Studio API domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns report lists and detail without transforming imported values or provenance', async () => {
    const report = {
      id: 'report-1',
      provenance: 'merchant_uploaded_unverified',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      currency: 'BDT',
      columns_present: ['amount_spent', 'link_clicks'],
      columns_missing: ['reach'],
      campaigns: [{
        id: 'metric-1',
        campaign_name: 'Autumn launch',
        row_number: 2,
        raw_metrics: { amount_spent: '12.50', link_clicks: '0' },
      }],
      recommendations: [{
        id: 'recommendation-1',
        code: 'SPEND_WITHOUT_LINK_CLICKS',
        report_id: 'report-1',
        campaign_metric_id: 'metric-1',
        campaign_name: 'Autumn launch',
        evidence: { amount_spent: '12.50', link_clicks: '0' },
        text: 'The imported row records 12.50 BDT and 0 link clicks.',
      }],
    };
    (httpClient.get as any)
      .mockResolvedValueOnce({ data: { success: true, data: [report] } })
      .mockResolvedValueOnce({ data: { success: true, data: report } });

    const reports = await listAdsStudioReports();
    const detail = await getAdsStudioReport('report-1');

    expect(httpClient.get).toHaveBeenNthCalledWith(1, '/api/ads-studio/reports');
    expect(httpClient.get).toHaveBeenNthCalledWith(2, '/api/ads-studio/reports/report-1');
    expect(reports[0].provenance).toBe('merchant_uploaded_unverified');
    expect(detail.campaigns[0].raw_metrics).toEqual({ amount_spent: '12.50', link_clicks: '0' });
    expect(detail.recommendations[0].evidence).toEqual({ amount_spent: '12.50', link_clicks: '0' });
    expect(detail.columns_missing).toEqual(['reach']);
  });

  it('posts the CSV as raw text and returns duplicate and campaign-count metadata', async () => {
    const csvText = 'Campaign name,Reporting starts,Reporting ends,Amount spent (BDT)\nAutumn,2026-10-01,2026-10-31,12.50';
    const imported = {
      id: 'report-2',
      duplicate: false,
      campaign_count: 1,
      provenance: 'merchant_uploaded_unverified',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      currency: 'BDT',
      columns_present: ['campaign_name', 'period_start', 'period_end', 'currency', 'amount_spent'],
      columns_missing: ['impressions', 'reach', 'link_clicks'],
    };
    (httpClient.post as any).mockResolvedValue({ data: { success: true, data: imported } });

    const result = await importAdsStudioReport(csvText);

    expect(httpClient.post).toHaveBeenCalledWith('/api/ads-studio/reports/import', csvText, {
      headers: { 'Content-Type': 'text/csv' },
    });
    expect(result).toMatchObject({ duplicate: false, campaign_count: 1, provenance: 'merchant_uploaded_unverified' });
  });

  it('preserves backend 404, 409, and 503 eligibility/availability failures', async () => {
    for (const statusCode of [404, 409, 503]) {
      const failure = { statusCode, message: `Ads Studio response ${statusCode}` };
      (httpClient.get as any).mockRejectedValueOnce(failure);
      await expect(listAdsStudioReports()).rejects.toBe(failure);
    }
  });

  it('creates a draft from a recommendation and patches editable fields only', async () => {
    const payload = {
      report_id: 'report-1',
      campaign_metric_id: 'metric-1',
      recommendation_code: 'SPEND_WITHOUT_LINK_CLICKS' as const,
    };
    const draft = { id: 'draft-1', ...payload, title: 'Review Autumn', status: 'draft' };
    const updates = { title: 'Revised review', objective: 'Check destination', copy_draft: 'Review before any action.' };
    (httpClient.post as any).mockResolvedValue({ data: { success: true, data: draft } });
    (httpClient.patch as any).mockResolvedValue({ data: { success: true, data: { ...draft, ...updates } } });

    const created = await createAdsStudioDraft(payload);
    const updated = await updateAdsStudioDraft('draft-1', updates);

    expect(httpClient.post).toHaveBeenCalledWith('/api/ads-studio/drafts', payload);
    expect(httpClient.patch).toHaveBeenCalledWith('/api/ads-studio/drafts/draft-1', updates);
    expect(created.id).toBe('draft-1');
    expect(updated.title).toBe('Revised review');
    expect(httpClient.patch).not.toHaveBeenCalledWith('/api/ads-studio/drafts/draft-1', expect.objectContaining({ report_id: expect.anything() }));
  });

  it('lists drafts and records approval as internal-only with no external operation', async () => {
    const draft = { id: 'draft-1', status: 'approved', title: 'Review Autumn' };
    const approval = { ...draft, approval: { changed: true, external_operation_performed: false } };
    (httpClient.get as any).mockResolvedValue({ data: { success: true, data: [draft] } });
    (httpClient.post as any).mockResolvedValue({ data: { success: true, data: approval } });

    const drafts = await listAdsStudioDrafts();
    const result = await approveAdsStudioDraft('draft-1');

    expect(httpClient.get).toHaveBeenCalledWith('/api/ads-studio/drafts');
    expect(httpClient.post).toHaveBeenCalledWith('/api/ads-studio/drafts/draft-1/approve', {});
    expect(drafts).toEqual([draft]);
    expect(result.approval).toEqual({ changed: true, external_operation_performed: false });
  });
});
