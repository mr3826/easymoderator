/**
 * Phase 2 — Canonical Meta channel API client.
 *
 * Talks to the new /api/channels/meta surface backed by the meta_channels
 * table (single source of truth). The legacy /api/channel/* client in
 * channel.ts still works during the dual-write window and remains the
 * default until the Channels UI flips its feature flag.
 *
 * Surface:
 *   listMetaChannels()                         — GET    /api/channels/meta
 *   initiateMetaOAuth(platform)                — POST   /api/channels/meta/oauth/initiate
 *   handleMetaOAuthCallback(code, state)       — POST   /api/channels/meta/oauth/callback
 *   connectMetaAsset({assetId, displayName, tempToken})
 *                                              — POST   /api/channels/meta/oauth/connect-asset
 *   disconnectMetaChannel(channelId)           — POST   /api/channels/meta/:id/disconnect
 *   reconnectMetaChannel(channelId)            — POST   /api/channels/meta/:id/reconnect
 *   pingMetaChannel(channelId)                 — POST   /api/channels/meta/:id/test-webhook
 *                                              (subscribed_apps verification)
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type {
  AiReplyMode,
  AiReplyModeSource,
  ChannelAutomationWarning,
  EmergencyStopState,
} from '../types/conversation';
import type { AxiosResponse } from 'axios';

export type MetaPlatform = 'facebook';

export type MetaChannelStatus =
  | 'CONNECTED'
  | 'TOKEN_EXPIRED'
  | 'REVOKED'
  | 'DISCONNECTED'
  | 'ERROR';

export interface MetaChannel {
  id: string;
  shopId: string;
  platform: MetaPlatform;
  metaAssetId: string;
  displayName: string;
  pictureUrl: string | null;
  status: MetaChannelStatus;
  isHealthy: boolean;
  needsReconnect: boolean;
  lastError: string | null;
  tokenExpiresAt: string | null;
  tokenLastRefreshedAt: string | null;
  webhookSubscribedFields: string[];
  webhookLastVerifiedAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Cosmetic merchant-facing tag (e.g. "Sales", "Support"). Display only. */
  purposeLabel: string | null;
  // Additive effective-automation fields (ADR-0013 §2, list endpoint).
  effective_mode?: AiReplyMode;
  mode_source?: AiReplyModeSource;
  override_count?: number;
  emergency_stop?: EmergencyStopState;
  billing_ai_active?: boolean;
}

export interface MetaOAuthAsset {
  id: string;
  name: string;
  category: string | null;
  pictureUrl: string | null;
  /** Normalized non-secret Page tasks returned by Meta. */
  tasks: string[];
  /** Server-derived eligibility for Messenger connection. */
  connectable: boolean;
  /** Stable reason code when this asset is not connectable. */
  reason: string | null;
  /** Provenance for eligibility when Meta's optional task field was unavailable. */
  eligibilitySource?: 'META_TASKS' | 'GRANULAR_PERMISSIONS' | null;
  /** Whether Meta returned the Page's tasks or omitted the optional field. */
  taskAvailability?: 'PRESENT' | 'UNAVAILABLE';
}

export interface MetaOAuthCallbackResult {
  pages: MetaOAuthAsset[];
  /** Opaque callback token; never a raw Meta access token. */
  tempToken: string;
  reconnectChannelId: string | null;
  reconnectAssetId: string | null;
}

export interface MetaConnectAssetResult extends MetaChannel {
  webhookWarning: string | null;
}

export interface MetaReconnectResult {
  redirectUrl: string;
  state: string;
  channelId: string;
  platform: MetaPlatform;
}

export interface MetaChannelPingResult {
  channelId: string;
  platform: MetaPlatform;
  /** Backward-compatible alias for the canonical subscribed_apps result. */
  ping: { ok: boolean; latencyMs?: number; error?: string };
  connection: { ok: boolean; status: MetaChannelStatus };
  subscription: { ok: boolean; fields: string[]; requiredFields: string[]; repaired: boolean };
  transport: { status: 'NOT_PROBED'; reason: string };
  checkedAt: string;
}

export type MetaConsentEventType =
  | 'OPT_IN_IMPLICIT'
  | 'OPT_IN_EXPLICIT'
  | 'OPT_OUT'
  | 'DEAUTHORIZED'
  | 'DATA_DELETED';

export interface MetaConsentEvent {
  id: string;
  event: MetaConsentEventType;
  source: string;
  customerId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MetaChannelConsentSummary {
  channelId: string;
  counts: {
    optIns: number;
    optOuts: number;
    deauthorized: number;
    dataDeleted: number;
  };
  recentEvents: MetaConsentEvent[];
}

const BASE = '/api/channels/meta';

export async function listMetaChannels(): Promise<MetaChannel[]> {
  const res: AxiosResponse<ApiResponse<MetaChannel[]>> = await httpClient.get(BASE);
  return res.data.data;
}

export async function initiateMetaOAuth(
  platform: MetaPlatform,
): Promise<{ redirectUrl: string; state: string }> {
  const res: AxiosResponse<ApiResponse<{ redirectUrl: string; state: string }>> =
    await httpClient.post(`${BASE}/oauth/initiate`, { platform });
  return res.data.data;
}

export async function handleMetaOAuthCallback(
  code: string,
  state: string,
): Promise<MetaOAuthCallbackResult> {
  const res: AxiosResponse<ApiResponse<MetaOAuthCallbackResult>> = await httpClient.post(
    `${BASE}/oauth/callback`,
    { code, state },
  );
  return res.data.data;
}

export async function connectMetaAsset(input: {
  assetId: string;
  displayName: string;
  tempToken: string;
  platform: 'facebook';
}): Promise<MetaConnectAssetResult> {
  const res: AxiosResponse<ApiResponse<MetaConnectAssetResult>> = await httpClient.post(
    `${BASE}/oauth/connect-asset`,
    input,
  );
  return res.data.data;
}

export async function disconnectMetaChannel(channelId: string): Promise<MetaChannel> {
  const res: AxiosResponse<ApiResponse<MetaChannel>> = await httpClient.post(
    `${BASE}/${channelId}/disconnect`,
  );
  return res.data.data;
}

export async function reconnectMetaChannel(channelId: string): Promise<MetaReconnectResult> {
  const res: AxiosResponse<ApiResponse<MetaReconnectResult>> = await httpClient.post(
    `${BASE}/${channelId}/reconnect`,
  );
  return res.data.data;
}

export async function pingMetaChannel(channelId: string): Promise<MetaChannelPingResult> {
  const res: AxiosResponse<ApiResponse<MetaChannelPingResult>> = await httpClient.post(
    `${BASE}/${channelId}/test-webhook`,
  );
  return res.data.data;
}

export async function updateMetaChannelPurposeLabel(
  channelId: string,
  purposeLabel: string | null,
): Promise<MetaChannel> {
  const res: AxiosResponse<ApiResponse<MetaChannel>> = await httpClient.patch(
    `${BASE}/${channelId}/purpose-label`,
    { purposeLabel },
  );
  return res.data.data;
}

export async function getMetaChannelConsentSummary(
  channelId: string,
): Promise<MetaChannelConsentSummary> {
  const res: AxiosResponse<ApiResponse<MetaChannelConsentSummary>> = await httpClient.get(
    `${BASE}/${channelId}/consent-summary`,
  );
  return res.data.data;
}

/**
 * Channel automation types (ADR-0013 §2). `overrides` contains ONLY explicit
 * keys ({} when the channel inherits everything); `effective` is the resolved
 * configuration after the narrow-only clamp and channel-native defaults.
 */
export interface ChannelBusinessHoursSlot {
  open: string;
  close: string;
}

/** Accepts both `{day:{open,close}}` and `{day:[{open,close},…]}` shapes. */
export interface ChannelBusinessHours {
  timezone?: string;
  mon?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  tue?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  wed?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  thu?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  fri?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  sat?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
  sun?: ChannelBusinessHoursSlot | ChannelBusinessHoursSlot[];
}

export interface ChannelAutomationGreeting {
  enabled: boolean;
  custom_text: string;
}

/** Canonical explicit overrides; NULL/absent key means inherit. */
export interface ChannelAutomationOverrides {
  automation_mode?: AiReplyMode;
  confidence_threshold?: number;
  greeting?: ChannelAutomationGreeting;
}

export interface ChannelAutomationEffective {
  automation_mode: AiReplyMode;
  confidence_threshold: number;
  greeting: ChannelAutomationGreeting;
  business_hours: ChannelBusinessHours | null;
  allow_order_creation: boolean;
  purpose_label: string | null;
}

export interface MetaChannelSettings {
  confidenceThresholdSend: number;
  confidenceThresholdSuggest: number;
  businessHours: ChannelBusinessHours | null;
  allowOrderCreation: boolean;
  purposeLabel: string | null;
  /** Only explicit override keys; empty object when nothing is overridden. */
  overrides: ChannelAutomationOverrides;
  effective: ChannelAutomationEffective;
  mode_source: AiReplyModeSource;
  warnings: ChannelAutomationWarning[];
  emergency_stop: EmergencyStopState;
  billing_ai_active: boolean;
  /** Legacy runtime-dead thresholds; the redesigned UI never renders these. */
  deprecated_fields: string[];
}

/**
 * PATCH body. `null` reverts a key to inherit (the server deletes it);
 * an absent key leaves the stored override untouched. Legacy mode aliases are
 * accepted for old clients but always stored canonical.
 */
export interface ChannelAutomationOverridesPatch {
  automation_mode?: AiReplyMode | 'AI_ACTIVE' | 'AI_SUGGEST_ONLY' | 'HUMAN_ACTIVE' | null;
  confidence_threshold?: number | null;
  greeting?: ChannelAutomationGreeting | null;
}

export interface MetaChannelSettingsPatch {
  businessHours?: ChannelBusinessHours | null;
  confidenceThresholdSend?: number;
  confidenceThresholdSuggest?: number;
  allowOrderCreation?: boolean;
  purposeLabel?: string | null;
  overrides?: ChannelAutomationOverridesPatch | null;
}

/** Canonical react-query keys for the redesigned channel surfaces. */
export const channelQueryKeys = {
  list: () => ['channels'] as const,
  settings: (channelId: string) => ['channel-settings', channelId] as const,
};

export async function getMetaChannelSettings(
  channelId: string,
): Promise<MetaChannelSettings> {
  const res: AxiosResponse<ApiResponse<MetaChannelSettings>> = await httpClient.get(
    `${BASE}/${channelId}/settings`,
  );
  return res.data.data;
}

export async function updateMetaChannelSettings(
  channelId: string,
  patch: MetaChannelSettingsPatch,
): Promise<MetaChannelSettings> {
  const res: AxiosResponse<ApiResponse<MetaChannelSettings>> = await httpClient.patch(
    `${BASE}/${channelId}/settings`,
    patch,
  );
  return res.data.data;
}
