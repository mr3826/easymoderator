import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';

const BASE_PATH = '/api/ads-studio';

export type AdsStudioRecommendationCode = 'SPEND_WITHOUT_LINK_CLICKS' | 'LINK_CLICK_FOLLOWUP';
export type AdsStudioProvenance = 'merchant_uploaded_unverified';

export interface AdsStudioReport {
  id: string;
  shop_id: string;
  period_start: string;
  period_end: string;
  currency: string;
  importer_user_id: string;
  source: string;
  provenance: AdsStudioProvenance;
  content_hash: string;
  columns_present: string[];
  columns_missing: string[];
  unsupported_columns: string[];
  rows_count: number;
  imported_at: string;
}

export interface AdsStudioImportedReport extends AdsStudioReport {
  duplicate: boolean;
  campaign_count: number;
}

export interface AdsStudioCampaignMetric {
  id: string;
  campaign_name: string;
  row_number: number;
  raw_metrics: Record<string, string>;
}

export interface AdsStudioRecommendation {
  id: string;
  code: AdsStudioRecommendationCode;
  report_id: string;
  campaign_metric_id: string;
  campaign_name: string;
  evidence: Record<string, string>;
  text: string;
}

export interface AdsStudioReportDetail extends AdsStudioReport {
  campaigns: AdsStudioCampaignMetric[];
  recommendations: AdsStudioRecommendation[];
}

export interface AdsStudioDraftFields {
  title: string;
  objective?: string;
  audience_notes?: string;
  creative_notes?: string;
  copy_draft?: string;
}

export interface CreateAdsStudioDraftInput extends Omit<AdsStudioDraftFields, 'title'> {
  report_id: string;
  campaign_metric_id: string;
  recommendation_code: AdsStudioRecommendationCode;
  title?: string;
}

export interface UpdateAdsStudioDraftInput {
  title?: string;
  objective?: string;
  audience_notes?: string;
  creative_notes?: string;
  copy_draft?: string;
}

export interface AdsStudioDraft {
  id: string;
  report_id: string;
  campaign_metric_id: string;
  recommendation_id: string;
  recommendation_code: AdsStudioRecommendationCode;
  title: string;
  objective: string | null;
  audience_notes: string | null;
  creative_notes: string | null;
  copy_draft: string | null;
  status: 'draft' | 'approved' | string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  recommendation?: AdsStudioRecommendation;
}

export interface AdsStudioApprovalResult extends AdsStudioDraft {
  approval: {
    changed: boolean;
    external_operation_performed: false;
  };
}

export async function listAdsStudioReports(): Promise<AdsStudioReport[]> {
  const response = await httpClient.get<ApiResponse<AdsStudioReport[]>>(`${BASE_PATH}/reports`);
  return response.data.data;
}

export async function importAdsStudioReport(csvText: string): Promise<AdsStudioImportedReport> {
  const response = await httpClient.post<ApiResponse<AdsStudioImportedReport>>(
    `${BASE_PATH}/reports/import`,
    csvText,
    { headers: { 'Content-Type': 'text/csv' } },
  );
  return response.data.data;
}

export async function getAdsStudioReport(reportId: string): Promise<AdsStudioReportDetail> {
  const response = await httpClient.get<ApiResponse<AdsStudioReportDetail>>(
    `${BASE_PATH}/reports/${encodeURIComponent(reportId)}`,
  );
  return response.data.data;
}

export async function listAdsStudioDrafts(): Promise<AdsStudioDraft[]> {
  const response = await httpClient.get<ApiResponse<AdsStudioDraft[]>>(`${BASE_PATH}/drafts`);
  return response.data.data;
}

export async function createAdsStudioDraft(input: CreateAdsStudioDraftInput): Promise<AdsStudioDraft> {
  const response = await httpClient.post<ApiResponse<AdsStudioDraft>>(`${BASE_PATH}/drafts`, input);
  return response.data.data;
}

export async function updateAdsStudioDraft(
  draftId: string,
  updates: UpdateAdsStudioDraftInput,
): Promise<AdsStudioDraft> {
  const response = await httpClient.patch<ApiResponse<AdsStudioDraft>>(
    `${BASE_PATH}/drafts/${encodeURIComponent(draftId)}`,
    updates,
  );
  return response.data.data;
}

export async function approveAdsStudioDraft(draftId: string): Promise<AdsStudioApprovalResult> {
  const response = await httpClient.post<ApiResponse<AdsStudioApprovalResult>>(
    `${BASE_PATH}/drafts/${encodeURIComponent(draftId)}/approve`,
    {},
  );
  return response.data.data;
}
