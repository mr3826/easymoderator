import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdsStudioPage from './AdsStudioPage';
import type { AdsStudioDraft, AdsStudioReport, AdsStudioReportDetail } from '@/api/domains/adsStudio';

const adsStudioMocks = vi.hoisted(() => ({
  approveAdsStudioDraft: vi.fn(),
  createAdsStudioDraft: vi.fn(),
  getAdsStudioReport: vi.fn(),
  importAdsStudioReport: vi.fn(),
  listAdsStudioDrafts: vi.fn(),
  listAdsStudioReports: vi.fn(),
  updateAdsStudioDraft: vi.fn(),
}));

vi.mock('@/api/domains/adsStudio', () => adsStudioMocks);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const summary: AdsStudioReport = {
  id: 'report-1',
  shop_id: 'shop-1',
  period_start: '2026-10-01',
  period_end: '2026-10-31',
  currency: 'BDT',
  importer_user_id: 'user-1',
  source: 'manual_csv_upload',
  provenance: 'merchant_uploaded_unverified',
  content_hash: 'hash-1',
  columns_present: ['campaign_name', 'period_start', 'period_end', 'currency', 'amount_spent', 'impressions', 'link_clicks', 'ctr_link_click'],
  columns_missing: ['reach', 'cpc_link_click', 'cpm', 'frequency'],
  unsupported_columns: [],
  rows_count: 1,
  imported_at: '2026-11-01T12:00:00.000Z',
};

const detail: AdsStudioReportDetail = {
  ...summary,
  campaigns: [{
    id: 'metric-1',
    campaign_name: 'Autumn launch',
    row_number: 2,
    raw_metrics: {
      amount_spent: '12.50',
      impressions: '400',
      link_clicks: '0',
      ctr_link_click: '0.00',
    },
  }],
  recommendations: [{
    id: 'recommendation-1',
    code: 'SPEND_WITHOUT_LINK_CLICKS',
    report_id: 'report-1',
    campaign_metric_id: 'metric-1',
    campaign_name: 'Autumn launch',
    evidence: { amount_spent: '12.50', link_clicks: '0' },
    text: 'Imported report report-1 records 12.50 BDT spent and 0 link clicks for campaign Autumn launch. Review before any manual change.',
  }],
};

const draft: AdsStudioDraft = {
  id: 'draft-1',
  report_id: 'report-1',
  campaign_metric_id: 'metric-1',
  recommendation_id: 'recommendation-1',
  recommendation_code: 'SPEND_WITHOUT_LINK_CLICKS',
  title: 'Review Autumn launch',
  objective: null,
  audience_notes: null,
  creative_notes: null,
  copy_draft: null,
  status: 'draft',
  created_by: 'user-1',
  approved_by: null,
  approved_at: null,
  created_at: '2026-11-01T12:00:00.000Z',
  updated_at: '2026-11-01T12:00:00.000Z',
};

async function renderReady() {
  render(<AdsStudioPage />);
  await waitFor(() => expect(screen.queryByText('Loading your Ads Studio records...')).not.toBeInTheDocument());
}

describe('AdsStudioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adsStudioMocks.listAdsStudioReports.mockResolvedValue([]);
    adsStudioMocks.listAdsStudioDrafts.mockResolvedValue([]);
    adsStudioMocks.getAdsStudioReport.mockResolvedValue(detail);
    adsStudioMocks.importAdsStudioReport.mockResolvedValue({ ...summary, duplicate: false, campaign_count: 1 });
    adsStudioMocks.createAdsStudioDraft.mockResolvedValue(draft);
    adsStudioMocks.updateAdsStudioDraft.mockImplementation(async (_draftId, updates) => ({ ...draft, ...updates }));
    adsStudioMocks.approveAdsStudioDraft.mockResolvedValue({
      ...draft,
      status: 'approved',
      approval: { changed: true, external_operation_performed: false },
    });
  });

  it('shows unverified provenance, missing columns, and exact uploaded metrics', async () => {
    adsStudioMocks.listAdsStudioReports.mockResolvedValue([summary]);
    await renderReady();

    await waitFor(() => expect(screen.getAllByText('12.50').length).toBeGreaterThan(0));
    expect(screen.getByText('400')).toBeInTheDocument();
    expect(screen.getByText('0.00')).toBeInTheDocument();
    expect(screen.getByText('Merchant-supplied - unverified')).toBeInTheDocument();
    expect(screen.getByText(/reach, cpc_link_click, cpm, frequency/)).toBeInTheDocument();
    expect(screen.getByText(/12\.50 BDT spent and 0 link clicks/)).toBeInTheDocument();
    expect(screen.getAllByText('Amount spent').length).toBeGreaterThan(0);
  });

  it('renders backend 409 as an eligibility/conflict state without inventing a permission result', async () => {
    adsStudioMocks.listAdsStudioReports.mockRejectedValue({
      statusCode: 409,
      message: 'Ads Studio is not enabled for this shop',
    });
    await renderReady();

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 409 - Eligibility / conflict state');
    expect(screen.getByRole('alert')).toHaveTextContent('Ads Studio is not enabled for this shop');
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });

  it('submits the selected CSV and shows a backend availability error on failure', async () => {
    const csvText = 'Campaign name,Reporting starts,Reporting ends,Amount spent (BDT)\nAutumn,2026-10-01,2026-10-31,12.50';
    const file = new File([csvText], 'ads-report.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csvText) });
    adsStudioMocks.importAdsStudioReport.mockRejectedValue({
      statusCode: 503,
      message: 'Ads Studio gate unavailable',
    });
    await renderReady();

    fireEvent.change(screen.getByLabelText('Meta Ads CSV file'), { target: { files: [file] } });
    await userEvent.click(screen.getByRole('button', { name: 'Import CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503 - Service availability');
    expect(screen.getByRole('alert')).toHaveTextContent('Ads Studio gate unavailable');
    expect(adsStudioMocks.importAdsStudioReport).toHaveBeenCalledWith(csvText);
  });

  it('creates and edits a recommendation-linked draft, then requires explicit internal approval confirmation', async () => {
    adsStudioMocks.listAdsStudioReports.mockResolvedValue([summary]);
    await renderReady();

    await userEvent.click(screen.getByRole('button', { name: 'Create internal draft' }));
    await waitFor(() => expect(adsStudioMocks.createAdsStudioDraft).toHaveBeenCalledWith({
      report_id: 'report-1',
      campaign_metric_id: 'metric-1',
      recommendation_code: 'SPEND_WITHOUT_LINK_CLICKS',
    }));

    const title = screen.getByLabelText('Draft title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Revised launch review');
    await userEvent.type(screen.getByLabelText('Audience notes'), 'Check destination analytics first.');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft edits' }));

    await waitFor(() => expect(adsStudioMocks.updateAdsStudioDraft).toHaveBeenCalledWith('draft-1', {
      title: 'Revised launch review',
      objective: '',
      audience_notes: 'Check destination analytics first.',
      creative_notes: '',
      copy_draft: '',
    }));

    const approveButton = screen.getByRole('button', { name: 'Approve internal draft record' });
    expect(approveButton).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(approveButton).toBeEnabled();
    await userEvent.click(approveButton);

    await waitFor(() => expect(adsStudioMocks.approveAdsStudioDraft).toHaveBeenCalledWith('draft-1'));
    expect(await screen.findByText('Approved as an internal draft record only. No external operation was performed.')).toBeInTheDocument();
    expect(screen.getByText(/This internal record is approved/)).toBeInTheDocument();
  });
});
