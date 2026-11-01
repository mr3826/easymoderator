import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, Save, ShieldCheck } from 'lucide-react';
import {
  approveAdsStudioDraft,
  createAdsStudioDraft,
  getAdsStudioReport,
  importAdsStudioReport,
  listAdsStudioDrafts,
  listAdsStudioReports,
  updateAdsStudioDraft,
  type AdsStudioCampaignMetric,
  type AdsStudioDraft,
  type AdsStudioDraftFields,
  type AdsStudioImportedReport,
  type AdsStudioRecommendation,
  type AdsStudioReport,
  type AdsStudioReportDetail,
} from '@/api/domains/adsStudio';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader } from '@/app/components/ui/card';
import { Input } from '@/app/components/ui/input';

type Operation = 'initial-load' | 'report-load' | 'import' | 'create-draft' | 'save-draft' | 'approve-draft';

interface DraftEditorValues {
  title: string;
  objective: string;
  audience_notes: string;
  creative_notes: string;
  copy_draft: string;
}

type AdsStudioTranslate = (key: string, defaultValue: string, values?: Record<string, string | number>) => string;

const EMPTY_DRAFT: DraftEditorValues = {
  title: '',
  objective: '',
  audience_notes: '',
  creative_notes: '',
  copy_draft: '',
};

const TEXTAREA_CLASS = 'min-h-24 w-full rounded-md border border-input bg-input-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60';
const METADATA_COLUMNS = new Set(['campaign_name', 'period_start', 'period_end', 'currency']);

function draftEditorValues(draft: AdsStudioDraft): DraftEditorValues {
  return {
    title: draft.title ?? '',
    objective: draft.objective ?? '',
    audience_notes: draft.audience_notes ?? '',
    creative_notes: draft.creative_notes ?? '',
    copy_draft: draft.copy_draft ?? '',
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.statusCode ?? candidate.status ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function describeError(error: unknown, fallback: string, translate: AdsStudioTranslate): string {
  if (!error || typeof error !== 'object') return fallback;

  const candidate = error as {
    message?: unknown;
    response?: { data?: { message?: unknown; error?: { message?: unknown } } };
  };
  const message = typeof candidate.message === 'string'
    ? candidate.message
    : typeof candidate.response?.data?.error?.message === 'string'
      ? candidate.response.data.error.message
      : typeof candidate.response?.data?.message === 'string'
        ? candidate.response.data.message
        : fallback;
  const status = getErrorStatus(error);
  if (status === 404) return `${translate('errors.http404', 'HTTP 404 - Resource availability')}: ${message}`;
  if (status === 409) return `${translate('errors.http409', 'HTTP 409 - Eligibility / conflict state')}: ${message}`;
  if (status === 503) return `${translate('errors.http503', 'HTTP 503 - Service availability')}: ${message}`;
  return status ? `${translate('errors.httpStatus', `HTTP ${status}`, { status })}: ${message}` : message;
}

function metricLabel(column: string, translate: AdsStudioTranslate): string {
  const labels: Record<string, string> = {
    amount_spent: 'Amount spent',
    impressions: 'Impressions',
    reach: 'Reach',
    link_clicks: 'Link clicks',
    ctr_link_click: 'CTR (link click-through rate)',
    cpc_link_click: 'CPC (cost per link click)',
    cpm: 'CPM',
    frequency: 'Frequency',
  };
  return translate(`metrics.${column}`, labels[column] ?? column);
}

function DraftFields({
  values,
  disabled,
  translate,
  onChange,
}: {
  values: DraftEditorValues;
  disabled: boolean;
  translate: AdsStudioTranslate;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  return (
    <>
      <label className="block space-y-1.5 text-sm font-medium text-slate-800">
        {translate('draft.title', 'Draft title')}
        <Input name="title" value={values.title} onChange={onChange} maxLength={120} required disabled={disabled} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-slate-800">
        {translate('draft.objective', 'Objective')}
        <Input name="objective" value={values.objective} onChange={onChange} maxLength={120} disabled={disabled} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-slate-800">
        {translate('draft.audienceNotes', 'Audience notes')}
        <textarea name="audience_notes" className={TEXTAREA_CLASS} value={values.audience_notes} onChange={onChange} maxLength={1000} disabled={disabled} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-slate-800">
        {translate('draft.creativeNotes', 'Creative notes')}
        <textarea name="creative_notes" className={TEXTAREA_CLASS} value={values.creative_notes} onChange={onChange} maxLength={2000} disabled={disabled} />
      </label>
      <label className="block space-y-1.5 text-sm font-medium text-slate-800">
        {translate('draft.copy', 'Copy draft')}
        <textarea name="copy_draft" className={TEXTAREA_CLASS} value={values.copy_draft} onChange={onChange} maxLength={4000} disabled={disabled} />
      </label>
    </>
  );
}

export default function AdsStudioPage() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [reports, setReports] = useState<AdsStudioReport[]>([]);
  const [drafts, setDrafts] = useState<AdsStudioDraft[]>([]);
  const [activeReport, setActiveReport] = useState<AdsStudioReportDetail | null>(null);
  const [latestImport, setLatestImport] = useState<AdsStudioImportedReport | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftValues, setDraftValues] = useState<DraftEditorValues>(EMPTY_DRAFT);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [operation, setOperation] = useState<Operation | null>('initial-load');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null;
  const busy = operation !== null;
  const tAds: AdsStudioTranslate = (key, defaultValue, values = {}) => String(t(`adsStudio.${key}`, { ...values, defaultValue }));

  useEffect(() => {
    let mounted = true;

    async function loadInitialData() {
      const [reportResult, draftResult] = await Promise.allSettled([
        listAdsStudioReports(),
        listAdsStudioDrafts(),
      ]);
      if (!mounted) return;

      let firstError: unknown;
      if (reportResult.status === 'fulfilled') {
        setReports(reportResult.value);
      } else {
        firstError = reportResult.reason;
      }
      if (draftResult.status === 'fulfilled') {
        setDrafts(draftResult.value);
      } else if (!firstError) {
        firstError = draftResult.reason;
      }
      if (firstError) {
        setError(describeError(firstError, tAds('errors.load', 'Ads Studio data could not be loaded.'), tAds));
      }

      if (reportResult.status === 'fulfilled' && reportResult.value[0]) {
        try {
          const detail = await getAdsStudioReport(reportResult.value[0].id);
          if (mounted) setActiveReport(detail);
        } catch (loadError) {
          if (mounted) setError(describeError(loadError, tAds('errors.report', 'The report could not be opened.'), tAds));
        }
      }
      if (mounted) setOperation(null);
    }

    void loadInitialData();
    return () => {
      mounted = false;
    };
  }, []);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
    setNotice(null);
  }

  async function handleImportSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) return;
    if (!selectedFile.name.toLowerCase().endsWith('.csv')) {
      setError(tAds('errors.csvFile', 'Choose a CSV file ending in .csv.'));
      return;
    }

    setOperation('import');
    setError(null);
    setNotice(null);
    try {
      const csvText = await selectedFile.text();
      const imported = await importAdsStudioReport(csvText);
      setLatestImport(imported);
      setReports((current) => [imported, ...current.filter((report) => report.id !== imported.id)]);
      setNotice(imported.duplicate
        ? tAds('notices.duplicateImport', 'This CSV was already imported. {{count}} campaign rows are available for review.', { count: imported.campaign_count })
        : tAds('notices.imported', 'Imported {{count}} campaign rows for review.', { count: imported.campaign_count }));
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      try {
        setActiveReport(await getAdsStudioReport(imported.id));
      } catch (detailError) {
        setError(describeError(detailError, tAds('errors.reportAfterImport', 'The report was imported, but its details could not be loaded.'), tAds));
      }
    } catch (importError) {
      setError(describeError(importError, tAds('errors.import', 'The CSV could not be imported. Check the file and try again.'), tAds));
    } finally {
      setOperation(null);
    }
  }

  async function handleReportSelect(event: MouseEvent<HTMLButtonElement>) {
    const reportId = event.currentTarget.dataset.reportId;
    if (!reportId) return;
    setOperation('report-load');
    setError(null);
    setNotice(null);
    try {
      setActiveReport(await getAdsStudioReport(reportId));
    } catch (loadError) {
      setError(describeError(loadError, tAds('errors.report', 'The report could not be opened.'), tAds));
    } finally {
      setOperation(null);
    }
  }

  async function handleCreateDraft(event: MouseEvent<HTMLButtonElement>) {
    const { reportId, campaignMetricId, recommendationCode } = event.currentTarget.dataset;
    if (!reportId || !campaignMetricId || !recommendationCode) return;
    setOperation('create-draft');
    setError(null);
    setNotice(null);
    try {
      const draft = await createAdsStudioDraft({
        report_id: reportId,
        campaign_metric_id: campaignMetricId,
        recommendation_code: recommendationCode as AdsStudioRecommendation['code'],
      });
      setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
      setActiveDraftId(draft.id);
      setDraftValues(draftEditorValues(draft));
      setApprovalConfirmed(false);
      setNotice(tAds('notices.draftCreated', 'Internal draft created from this report-grounded recommendation. Review and edit it before approval.'));
    } catch (createError) {
      setError(describeError(createError, tAds('errors.createDraft', 'The internal draft could not be created.'), tAds));
    } finally {
      setOperation(null);
    }
  }

  function handleDraftSelect(event: MouseEvent<HTMLButtonElement>) {
    const draftId = event.currentTarget.dataset.draftId;
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) return;
    setActiveDraftId(draft.id);
    setDraftValues(draftEditorValues(draft));
    setApprovalConfirmed(false);
    setError(null);
    setNotice(null);
  }

  function handleDraftValueChange(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const target = event.currentTarget;
    const field = target.name as keyof DraftEditorValues;
    if (!Object.prototype.hasOwnProperty.call(EMPTY_DRAFT, field)) return;
    setDraftValues((current) => ({ ...current, [field]: target.value }));
    setApprovalConfirmed(false);
  }

  async function handleDraftSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeDraft || activeDraft.status !== 'draft' || !draftValues.title.trim()) return;
    setOperation('save-draft');
    setError(null);
    setNotice(null);
    try {
      const updated = await updateAdsStudioDraft(activeDraft.id, draftValues as AdsStudioDraftFields);
      const merged = { ...updated, recommendation: activeDraft.recommendation };
      setDrafts((current) => current.map((item) => item.id === merged.id ? merged : item));
      setDraftValues(draftEditorValues(merged));
      setNotice(tAds('notices.draftSaved', 'Internal draft changes saved. No campaign action was taken.'));
    } catch (saveError) {
      setError(describeError(saveError, tAds('errors.saveDraft', 'The draft changes could not be saved.'), tAds));
    } finally {
      setOperation(null);
    }
  }

  async function handleDraftApprove() {
    if (!activeDraft || activeDraft.status !== 'draft' || !approvalConfirmed) return;
    setOperation('approve-draft');
    setError(null);
    setNotice(null);
    try {
      const result = await approveAdsStudioDraft(activeDraft.id);
      if (result.approval.external_operation_performed !== false) {
        setError(tAds('errors.approvalUnexpected', 'Approval response did not confirm that no external operation was performed.'));
        return;
      }
      const merged = { ...result, recommendation: activeDraft.recommendation };
      setDrafts((current) => current.map((item) => item.id === merged.id ? merged : item));
      setDraftValues(draftEditorValues(merged));
      setApprovalConfirmed(false);
      setNotice(tAds('notices.approved', 'Approved as an internal draft record only. No external operation was performed.'));
    } catch (approveError) {
      setError(describeError(approveError, tAds('errors.approveDraft', 'The internal draft could not be approved.'), tAds));
    } finally {
      setOperation(null);
    }
  }

  function handleApprovalConfirmationChange(event: ChangeEvent<HTMLInputElement>) {
    setApprovalConfirmed(event.currentTarget.checked);
  }

  const metricColumns = activeReport?.columns_present.filter((column) => (
    !METADATA_COLUMNS.has(column)
    && activeReport.campaigns.some((campaign) => Object.prototype.hasOwnProperty.call(campaign.raw_metrics, column))
  )) ?? [];

  function renderCampaignRow(campaign: AdsStudioCampaignMetric) {
    return (
      <tr key={campaign.id} className="border-t border-slate-200 align-top">
        <th scope="row" className="min-w-48 px-4 py-3 text-left font-medium text-slate-900">
          <span className="block">{campaign.campaign_name}</span>
          <span className="mt-1 block text-xs font-normal text-slate-500">{tAds('report.csvRow', 'CSV row {{number}}', { number: campaign.row_number })}</span>
        </th>
        {metricColumns.map((column) => (
          <td key={column} className="whitespace-nowrap px-4 py-3 text-right font-mono text-sm text-slate-800">
            {campaign.raw_metrics[column] ?? ''}
          </td>
        ))}
      </tr>
    );
  }

  return (
    <main className="min-h-full bg-[#f4f3ed] px-4 py-6 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-800">{tAds('eyebrow', 'Merchant workspace / manual review')}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{tAds('title', 'Ads Studio')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
              {tAds('subtitle', 'Review a Meta Ads CSV, inspect its source values, and turn a grounded observation into an internal draft.')}
            </p>
          </div>
          <span className="rounded-full border border-emerald-900/15 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-900">
            {tAds('noAutoSpend', 'No auto-spend')}
          </span>
        </header>

        <section aria-labelledby="ads-studio-safety" className="rounded-xl border border-amber-400 bg-amber-50 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-800" />
            <div>
              <h2 id="ads-studio-safety" className="font-semibold text-amber-950">{tAds('safety.title', 'Important data and action limits')}</h2>
              <p className="mt-1 text-sm leading-6 text-amber-950">
                {tAds('safety.description', 'Imports are merchant-supplied and unverified. Approval only saves an internal draft record: there is no Meta API account connection, campaign publishing, or spend change. Ads Studio does not attribute EasyModerator orders or calculate ROAS or profit, and it does not send Messenger promotions. No auto-spend and no fabricated metrics; values below are shown from the uploaded CSV.')}
              </p>
            </div>
          </div>
        </section>

        {error && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" aria-live="polite" className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            <span className="inline-flex items-center gap-2"><CheckCircle2 aria-hidden="true" className="size-4" />{notice}</span>
          </div>
        )}
        {operation === 'initial-load' && (
          <p role="status" aria-live="polite" className="text-sm text-slate-600">{tAds('loading', 'Loading your Ads Studio records...')}</p>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.85fr)]">
          <div className="space-y-6">
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-800">
                    <FileUp aria-hidden="true" className="size-4" />
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold">{tAds('import.title', '1. Choose a CSV to import')}</h2>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{tAds('import.description', 'Only upload a report you are authorized to share. The original figures are not verified by EasyModerator.')}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                <form onSubmit={handleImportSubmit} className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <label className="block w-full space-y-2 text-sm font-medium text-slate-800">
                    {tAds('import.fileLabel', 'Meta Ads CSV file')}
                    <Input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      aria-describedby="ads-studio-csv-help"
                      onChange={handleFileChange}
                      disabled={busy}
                    />
                  </label>
                  <Button type="submit" disabled={!selectedFile || busy} className="w-full shrink-0 sm:w-auto">
                    {operation === 'import' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                    {operation === 'import' ? tAds('import.importing', 'Importing...') : tAds('import.submit', 'Import CSV')}
                  </Button>
                </form>
                <p id="ads-studio-csv-help" className="text-xs leading-5 text-slate-500">
                  {selectedFile
                    ? tAds('import.selectedFile', 'Selected: {{fileName}}', { fileName: selectedFile.name })
                    : tAds('import.help', 'Choose a .csv file. The backend validates its required campaign, period, currency, and spend columns.')}
                </p>
                {latestImport && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
                    {tAds('import.latest', 'Latest import: {{count}} campaign rows | {{start}} to {{end}} | {{currency}} | provenance: {{provenance}}.', {
                      count: latestImport.campaign_count,
                      start: latestImport.period_start,
                      end: latestImport.period_end,
                      currency: latestImport.currency,
                      provenance: latestImport.provenance,
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100">
                <div>
                  <h2 className="text-lg font-semibold">{tAds('report.title', '2. Review uploaded report')}</h2>
                  <p className="mt-1 text-sm text-slate-600">{tAds('report.description', 'Imported values are displayed as received; no totals, ROAS, or profit are derived here.')}</p>
                </div>
              </CardHeader>
              <CardContent className="space-y-5 pt-5">
                {reports.length > 0 && (
                  <div role="group" className="flex flex-wrap gap-2" aria-label={tAds('report.listLabel', 'Imported reports')}>
                    {reports.map((report) => (
                      <Button
                        key={report.id}
                        type="button"
                        variant={activeReport?.id === report.id ? 'default' : 'outline'}
                        size="sm"
                        data-report-id={report.id}
                        onClick={handleReportSelect}
                        disabled={busy}
                        aria-pressed={activeReport?.id === report.id}
                      >
                        {tAds('report.periodButton', '{{start}} - {{end}}', { start: report.period_start, end: report.period_end })}
                      </Button>
                    ))}
                  </div>
                )}

                {activeReport ? (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-slate-50 p-4">
                      <div>
                        <h3 className="font-semibold">{tAds('report.source', 'Source report')}</h3>
                        <p className="mt-1 text-sm text-slate-600">{tAds('report.summary', '{{start}} to {{end}} | {{currency}} | {{count}} campaign rows', {
                          start: activeReport.period_start,
                          end: activeReport.period_end,
                          currency: activeReport.currency,
                          count: activeReport.rows_count,
                        })}</p>
                      </div>
                      <span className="rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-950">
                        {tAds('report.unverified', 'Merchant-supplied - unverified')}
                      </span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <section aria-labelledby="ads-studio-columns-present" className="rounded-lg border border-slate-200 p-3">
                        <h4 id="ads-studio-columns-present" className="text-xs font-semibold uppercase tracking-wide text-slate-600">{tAds('report.columnsPresent', 'Columns present')}</h4>
                        <p className="mt-2 break-words text-sm text-slate-800">{activeReport.columns_present.join(', ') || tAds('report.noneReported', 'None reported')}</p>
                      </section>
                      <section aria-labelledby="ads-studio-columns-missing" className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                        <h4 id="ads-studio-columns-missing" className="text-xs font-semibold uppercase tracking-wide text-amber-950">{tAds('report.columnsMissing', 'Columns missing from upload')}</h4>
                        <p className="mt-2 break-words text-sm text-amber-950">{activeReport.columns_missing.join(', ') || tAds('report.noColumnsMissing', 'No supported columns missing')}</p>
                      </section>
                    </div>
                    {activeReport.unsupported_columns.length > 0 && (
                      <p className="text-sm text-slate-600">
                        {tAds('report.unsupportedColumns', 'Not imported (unsupported columns):')} <span className="font-medium text-slate-800">{activeReport.unsupported_columns.join(', ')}</span>
                      </p>
                    )}

                    <div>
                      <h3 className="mb-2 font-semibold">{tAds('report.metricsTitle', 'Exact imported campaign metrics')}</h3>
                      {activeReport.campaigns.length > 0 ? (
                        <div className="overflow-x-auto rounded-lg border border-slate-200">
                          <table className="w-full min-w-max text-sm">
                            <caption className="sr-only">{tAds('report.metricsCaption', 'Raw campaign metrics as imported from the merchant CSV')}</caption>
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                              <tr>
                                <th scope="col" className="px-4 py-3 text-left">{tAds('report.campaign', 'Campaign')}</th>
                                {metricColumns.map((column) => <th scope="col" key={column} className="px-4 py-3 text-right">{metricLabel(column, tAds)}</th>)}
                              </tr>
                            </thead>
                            <tbody>{activeReport.campaigns.map(renderCampaignRow)}</tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{tAds('report.noMetrics', 'No campaign metrics were returned for this report.')}</p>
                      )}
                    </div>

                    <section aria-labelledby="ads-studio-recommendations" className="space-y-3 border-t border-slate-200 pt-5">
                      <div>
                        <h3 id="ads-studio-recommendations" className="font-semibold">{tAds('recommendations.title', '3. Review report-grounded recommendations')}</h3>
                        <p className="mt-1 text-sm text-slate-600">{tAds('recommendations.description', 'Each note references this report and an exact campaign metric. Compare with your own analytics before deciding.')}</p>
                      </div>
                      {activeReport.recommendations.length === 0 ? (
                        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{tAds('recommendations.empty', 'No recommendations were generated from the supplied metrics.')}</p>
                      ) : activeReport.recommendations.map((recommendation) => (
                        <article key={recommendation.id} className="rounded-lg border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <h4 className="font-semibold">{recommendation.campaign_name}</h4>
                              <p className="mt-1 text-xs font-medium uppercase tracking-wide text-emerald-800">{tAds(`recommendations.codes.${recommendation.code}`, recommendation.code.replace(/_/g, ' '))}</p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              data-report-id={recommendation.report_id}
                              data-campaign-metric-id={recommendation.campaign_metric_id}
                              data-recommendation-code={recommendation.code}
                              onClick={handleCreateDraft}
                              disabled={busy}
                            >
                              {tAds('draft.create', 'Create internal draft')}
                            </Button>
                          </div>
                          <p className="mt-3 text-sm leading-6 text-slate-700">{recommendation.text}</p>
                          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
                            {Object.entries(recommendation.evidence).map(([key, value]) => (
                              <div key={key} className="flex gap-1.5">
                                <dt>{metricLabel(key, tAds)}:</dt><dd className="font-mono font-medium text-slate-900">{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </article>
                      ))}
                    </section>
                  </div>
                ) : (
                  <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-600">
                    {operation === 'report-load'
                      ? tAds('report.loading', 'Loading report details...')
                      : tAds('report.empty', 'Import a CSV or select an imported report to review its exact values and available recommendations.')}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-6" aria-label={tAds('draft.workspaceLabel', 'Internal draft workspace')}>
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700">
                    <ShieldCheck aria-hidden="true" className="size-4" />
                  </span>
                  <div>
                    <h2 className="text-lg font-semibold">{tAds('draft.titleSection', '4. Edit and approve an internal draft')}</h2>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{tAds('draft.description', 'Approval changes only this internal record. It cannot publish or change an ad.')}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-5">
                {drafts.length > 0 && (
                  <section aria-label={tAds('draft.savedLabel', 'Saved internal drafts')} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tAds('draft.savedTitle', 'Saved drafts')}</h3>
                    {drafts.map((draft) => (
                      <button
                        key={draft.id}
                        type="button"
                        data-draft-id={draft.id}
                        onClick={handleDraftSelect}
                        disabled={busy}
                        aria-pressed={activeDraft?.id === draft.id}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 ${activeDraft?.id === draft.id ? 'border-emerald-700 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        <span className="min-w-0 truncate font-medium">{draft.title}</span>
                        <span className="shrink-0 text-xs capitalize text-slate-500">{draft.status}</span>
                      </button>
                    ))}
                  </section>
                )}

                {activeDraft ? (
                  <form onSubmit={handleDraftSave} className="space-y-4">
                    <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                      {tAds('draft.recommendation', 'Recommendation')}: <span className="font-semibold text-slate-900">{tAds(`recommendations.codes.${activeDraft.recommendation_code}`, activeDraft.recommendation_code.replace(/_/g, ' '))}</span><br />
                      {tAds('draft.reportId', 'Report ID')}: <span className="font-mono">{activeDraft.report_id}</span>
                    </div>
                    <DraftFields
                      values={draftValues}
                      disabled={busy || activeDraft.status !== 'draft'}
                      translate={tAds}
                      onChange={handleDraftValueChange}
                    />

                    {activeDraft.status === 'draft' ? (
                      <>
                        <Button type="submit" variant="outline" disabled={busy || !draftValues.title.trim()} className="w-full">
                          {operation === 'save-draft' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Save aria-hidden="true" className="size-4" />}
                          {operation === 'save-draft' ? tAds('draft.saving', 'Saving draft...') : tAds('draft.save', 'Save draft edits')}
                        </Button>
                        <div className="border-t border-slate-200 pt-4">
                          <label className="flex items-start gap-2 text-sm leading-5 text-slate-800">
                            <input
                              type="checkbox"
                              checked={approvalConfirmed}
                              onChange={handleApprovalConfirmationChange}
                              disabled={busy}
                              className="mt-1 size-4 accent-emerald-800"
                            />
                            <span>{tAds('draft.confirmApproval', 'I understand this approves only an internal draft record. It will not connect an account, publish a campaign, or change spend.')}</span>
                          </label>
                          <Button
                            type="button"
                            variant="default"
                            onClick={handleDraftApprove}
                            disabled={busy || !approvalConfirmed}
                            className="mt-3 w-full bg-emerald-800 text-white hover:bg-emerald-900"
                          >
                            {operation === 'approve-draft' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
                            {operation === 'approve-draft' ? tAds('draft.approving', 'Approving internal draft...') : tAds('draft.approve', 'Approve internal draft record')}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
                        {tAds('draft.approvedState', 'This internal record is approved. No external operation was performed.')}
                      </p>
                    )}
                  </form>
                ) : (
                  <p className="rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                    {tAds('draft.empty', 'Create a draft from one of the report-grounded recommendations. Drafts can be edited here before the separate approval step.')}
                  </p>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}
