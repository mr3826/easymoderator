/**
 * Shop API Domain
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ShopAISettings } from '../types/dashboard';
import {
  normalizeAiReplyMode,
  type AiReplyMode,
  type EmergencyStopState,
} from '../types/conversation';
import type { AxiosResponse } from 'axios';
import type { ApiResponse } from '../types/common';

type NormalizedShopAISettings = Omit<ShopAISettings, 'automation_mode'> & {
  automation_mode: AiReplyMode;
};

function normalizeShopAISettings(
  settings: ShopAISettings | null | undefined
): NormalizedShopAISettings {
  return {
    ...(settings ?? {}),
    automation_mode: normalizeAiReplyMode(settings?.automation_mode),
  } as NormalizedShopAISettings;
}

export async function getShopBusinessInfo(): Promise<{ businessInfo: any; shop: any }> {
  const response: AxiosResponse<any> = await httpClient.get('/api/shop/business-info');
  return response.data.data;
}

export async function updateShopBusinessInfo(data: any): Promise<any> {
  const response: AxiosResponse<any> = await httpClient.put('/api/shop/business-info', data);
  return response.data.data;
}

// ---------------------------------------------------------------------------
// Business Policies (2026-11-26 Business & FAQ redesign) — persisted under
// shop.settings.policies via the validated owner-only writer. INFORMATIONAL
// ONLY: these facts inform customer answers; they never authorize refunds,
// exchanges, cancellations or warranty actions in automation.
// ---------------------------------------------------------------------------

export type PolicyStance = 'unspecified' | 'offered' | 'not_offered' | 'conditional';

export interface PolicyEntry {
  stance?: PolicyStance | null;
  period_days?: number | null;
  details?: string | null;
  exclusions?: string | null;
  process?: string | null;
  duration?: string | null;
  coverage?: string | null;
  coverage_exclusions?: string | null;
}

export interface ShopBusinessPolicies {
  returns?: PolicyEntry | null;
  exchange?: PolicyEntry | null;
  refunds?: PolicyEntry | null;
  warranty?: PolicyEntry | null;
  [key: string]: PolicyEntry | null | undefined;
}

export async function getShopBusinessPolicies(): Promise<ShopBusinessPolicies> {
  const response: AxiosResponse<ApiResponse<ShopBusinessPolicies>> = await httpClient.get(
    '/api/shop/business-policies',
  );
  return response.data.data ?? {};
}

export async function updateShopBusinessPolicies(
  patch: ShopBusinessPolicies,
): Promise<ShopBusinessPolicies> {
  const response: AxiosResponse<ApiResponse<{ policies?: ShopBusinessPolicies } | ShopBusinessPolicies>> =
    await httpClient.put('/api/shop/business-policies', patch);
  const data = response.data.data as { policies?: ShopBusinessPolicies } | ShopBusinessPolicies;
  return ((data as { policies?: ShopBusinessPolicies })?.policies ?? data ?? {}) as ShopBusinessPolicies;
}

export async function getShopAISettings(): Promise<NormalizedShopAISettings> {
  const response: AxiosResponse<any> = await httpClient.get('/api/shop/ai-settings');
  return normalizeShopAISettings(response.data.data);
}

export async function updateShopAISettings(data: ShopAISettings): Promise<NormalizedShopAISettings> {
  const response: AxiosResponse<any> = await httpClient.put('/api/shop/ai-settings', data);
  return normalizeShopAISettings(response.data.data);
}

/** POST /api/shop/ai/emergency-stop — business-wide, OWNER only (ADR-0013 §6). */
export interface EmergencyStopResponse extends EmergencyStopState {
  already_active?: boolean;
}

export async function emergencyStop(reason?: string): Promise<EmergencyStopResponse> {
  const response: AxiosResponse<ApiResponse<EmergencyStopResponse>> = await httpClient.post(
    '/api/shop/ai/emergency-stop',
    reason === undefined ? {} : { reason },
  );
  return response.data.data;
}

/**
 * POST /api/shop/ai/emergency-resume — clears the stop but keeps the business
 * mode at MANUAL; the owner re-chooses afterwards (ADR-0013 §6).
 */
export interface EmergencyResumeResponse {
  active: false;
  automation_mode: AiReplyMode;
  prior_mode: AiReplyMode | null;
  already_inactive?: boolean;
}

export async function emergencyResume(): Promise<EmergencyResumeResponse> {
  const response: AxiosResponse<ApiResponse<EmergencyResumeResponse>> = await httpClient.post(
    '/api/shop/ai/emergency-resume',
    {},
  );
  return response.data.data;
}

export async function getShop(): Promise<{ success: boolean; data: any }> {
  const response: AxiosResponse<any> = await httpClient.get('/api/shop/me');
  return response.data;
}

export async function updateShop(shopId: string, data: any): Promise<any> {
  const response: AxiosResponse<any> = await httpClient.post('/api/shop/update', { shopId, ...data });
  return response.data.data;
}
