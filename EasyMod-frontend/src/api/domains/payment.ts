/**
 * Payment API Domain — legacy compat surface + the canonical Payment Settings
 * redesign surface (contract §1–§6; routes landed by A5 in
 * `EasyMod-backend/src/modules/payment/payment.routes.js`, mounted `/api/payment`).
 *
 * NAMES AND PATHS HERE ARE A BOUND CONTRACT:
 * `src/app/components/payment-settings/paymentClient.ts` casts this module to
 * its `PaymentContractApi` seam — every function name below MUST match that
 * seam exactly (getPaymentAccounts, savePaymentAccount, updatePaymentAccount,
 * deletePaymentAccount, setPreferredAccount, verifyPaymentAccountCredentials,
 * certifyLiveAccount, getPaymentPolicy, updatePaymentPolicy). The settings
 * components are the single consumer; changing a name here breaks the cast at
 * runtime, not at compile time — so rename only TOGETHER with paymentClient.ts.
 *
 * Honesty posture (R-12): `verifyPaymentAccountCredentials` / `certifyLiveAccount`
 * render whatever the SERVER reports (A3's ladder service). Nothing here
 * implies a live provider check succeeded; a 501/429/409 flows through the
 * thrown error and the drawer surfaces the server message verbatim.
 */

import { httpClient } from '@/shared/lib/http/client';
import type { AxiosResponse } from 'axios';
import type {
  PaymentConfig,
  PaymentCredentials,
  PaymentAccountView,
  SavePaymentAccountPayload,
  UpdatePaymentAccountPatch,
  PaymentPolicyView,
  PaymentPolicyPayload,
} from '../types/payment';

// Legacy compat exports (kept importable from this module for existing consumers).
export type {
  PaymentConfig,
  PaymentCredentials,
  PaymentCredentialSummary,
  PaymentAccountView,
  PaymentProvider,
  PaymentAccountType,
  PaymentVerificationLevel,
  PaymentAdvancePolicy,
  SavePaymentAccountPayload,
  UpdatePaymentAccountPatch,
  PaymentPolicyView,
  PaymentPolicyPayload,
} from '../types/payment';

/** Loose envelope for legacy/rich server payloads (kept honest-typed instead of `any`). */
export interface PaymentLooseEnvelope {
  success: boolean;
  data?: unknown;
  message?: string;
  [key: string]: unknown;
}

/** Ladder verdict envelope: A3's verify/certify results spread at the TOP level. */
type PaymentVerdictEnvelope = { success: boolean; status?: string; message?: string; data?: unknown };

export async function getPaymentConfig(): Promise<{ success: boolean; data: PaymentConfig[] }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentConfig[] }> =
    await httpClient.get('/api/payment/config');
  return response.data;
}

export async function updatePaymentConfig(payload: {
  gateway: string;
  credentials?: PaymentCredentials | null;
  config?: Record<string, unknown>;
  is_enabled?: boolean;
}): Promise<PaymentLooseEnvelope> {
  const response: AxiosResponse<PaymentLooseEnvelope> =
    await httpClient.post('/api/payment/config', payload);
  return response.data;
}

export async function testPaymentConnection(payload: {
  gateway: string;
  credentials?: PaymentCredentials | null;
}): Promise<PaymentLooseEnvelope> {
  const response: AxiosResponse<PaymentLooseEnvelope> =
    await httpClient.post('/api/payment/config/test', payload);
  return response.data;
}

export async function deletePaymentConfig(gateway: string): Promise<{ success: boolean; message?: string }> {
  const response: AxiosResponse<{ success: boolean; message?: string }> =
    await httpClient.delete(`/api/payment/config/${gateway}`);
  return response.data;
}

// ── Canonical multi-account API (§1.3/§2/§6 — paymentClient seam) ────────────

export async function getPaymentAccounts(): Promise<{ success: boolean; data: PaymentAccountView[] }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentAccountView[] }> =
    await httpClient.get('/api/payment/accounts');
  return response.data;
}

export async function savePaymentAccount(
  payload: SavePaymentAccountPayload,
): Promise<{ success: boolean; data: PaymentAccountView; message?: string }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentAccountView; message?: string }> =
    await httpClient.post('/api/payment/accounts', payload);
  return response.data;
}

export async function updatePaymentAccount(
  accountId: string,
  patch: UpdatePaymentAccountPatch,
): Promise<{ success: boolean; data: PaymentAccountView; message?: string }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentAccountView; message?: string }> =
    await httpClient.patch(`/api/payment/accounts/${accountId}`, patch);
  return response.data;
}

export async function deletePaymentAccount(accountId: string): Promise<{ success: boolean; message?: string }> {
  const response: AxiosResponse<{ success: boolean; message?: string }> =
    await httpClient.delete(`/api/payment/accounts/${accountId}`);
  return response.data;
}

/**
 * D-8: preference is DB truth (`payment_accounts.is_preferred`, exactly one per
 * shop). This REPLACES the legacy `platform_priority` ['bkash','cod'] PUT shape —
 * the old endpoint survives as display order only, with no dual authority.
 */
export async function setPreferredAccount(
  accountId: string,
): Promise<{ success: boolean; message?: string; preferred_account_id?: string }> {
  const response: AxiosResponse<{ success: boolean; message?: string; preferred_account_id?: string }> =
    await httpClient.put(`/api/payment/accounts/${accountId}/preferred`, {});
  return response.data;
}

/**
 * §2.1 — the ONLY grant-bearing settings action (bKash merchant_gateway).
 * Rate-limited server-side (2 grant+refresh / rolling hour, 30-min cached
 * verdict); a wallet number gets a format verdict with ZERO provider contact.
 * The caller renders `status`/`message` verbatim — never upgraded to
 * "connected"/"verified with provider" anywhere client-side (R-12).
 */
export async function verifyPaymentAccountCredentials(
  accountId: string,
): Promise<PaymentVerdictEnvelope & Record<string, unknown>> {
  const response: AxiosResponse<PaymentVerdictEnvelope> = await httpClient.post(
    `/api/payment/accounts/${accountId}/verify-credentials`,
    {},
  );
  return response.data;
}

/**
 * §2.3 — records the OWNER's go-live evidence reference; `live_certified` is
 * never self-declared. The server enforces the sandbox_verified prerequisite
 * (409 SANDBOX_HANDSHAKE_REQUIRED) and the audit trail.
 */
export async function certifyLiveAccount(
  accountId: string,
  evidence: string,
): Promise<PaymentVerdictEnvelope & Record<string, unknown>> {
  const response: AxiosResponse<PaymentVerdictEnvelope> = await httpClient.post(
    `/api/payment/accounts/${accountId}/certify-live`,
    { evidence },
  );
  return response.data;
}

// ── Policies (§5.2, R-14 one write pair) ─────────────────────────────────────

export async function getPaymentPolicy(): Promise<{ success: boolean; data: PaymentPolicyView }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentPolicyView }> =
    await httpClient.get('/api/payment/policy');
  return response.data;
}

export async function updatePaymentPolicy(
  payload: PaymentPolicyPayload,
): Promise<{ success: boolean; data: PaymentPolicyView; message?: string }> {
  const response: AxiosResponse<{ success: boolean; data: PaymentPolicyView; message?: string }> =
    await httpClient.put('/api/payment/policy', payload);
  return response.data;
}
