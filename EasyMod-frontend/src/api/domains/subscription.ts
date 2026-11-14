/**
 * Subscription & Billing API Domain
 *
 * The subscription catalog is retired (ADR-0011): the only merchant price is
 * the delivered-order commercial contract. This domain keeps the authenticated
 * account/invoice endpoints that still exist and adds the tenant-scoped
 * billing-lines read. Retired catalog and top-up calls fail closed instead of
 * reaching a 410 endpoint.
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type {
  Subscription,
  SubscriptionData,
  PaymentMethod,
  Invoice,
} from '../types/subscription';
import type { AxiosResponse } from 'axios';
import { COMMERCIAL_CONTRACT, COMMERCIAL_CONTRACT_VERSION } from '@/shared/contracts/commercial-contract';

export {
  getCurrentPublicSubscriptionCatalog,
  getPublicSubscriptionCatalog,
  hasRequiredPublicPlans,
  SubscriptionCatalogRetiredError,
  SUBSCRIPTION_CATALOG_RETIRED,
} from './publicSubscription';

export {
  getPublicCommercialContract,
  useCommercialContract,
  useClaimDecisions,
} from './commercialContract';

import { SubscriptionCatalogRetiredError } from './publicSubscription';

/**
 * Get current subscription details
 * @returns Promise resolving to the subscription and allowance envelope
 * @throws {Error} When subscription retrieval fails
 */
export async function getSubscription(): Promise<SubscriptionData> {
  const response: AxiosResponse<ApiResponse<SubscriptionData>> = await httpClient.get('/api/subscription');
  return response.data.data;
}

/**
 * @deprecated The subscription catalog is retired (ADR-0011). Resolves nothing
 * and never issues a request: there is no plan list to read.
 */
export async function getSubscriptionPlans(): Promise<never> {
  throw new SubscriptionCatalogRetiredError();
}

export async function getAiReplyShadowUsage(): Promise<unknown> {
  const response: AxiosResponse<ApiResponse<unknown>> = await httpClient.get('/api/subscription/ai-reply-shadow-ledger/usage');
  return response.data.data;
}

/**
 * Subscribe to a plan
 * @deprecated Plans are retired (ADR-0011); the endpoint answers 410.
 */
export async function subscribeToPlan(
  _planId: string,
  _billingCycle: 'monthly' | 'yearly' = 'monthly'
): Promise<Subscription> {
  void _planId;
  void _billingCycle;
  throw new SubscriptionCatalogRetiredError();
}

/**
 * Cancel current subscription
 * @param reason - Optional reason for cancellation
 */
export async function cancelSubscription(reason?: string): Promise<Subscription> {
  const response: AxiosResponse<ApiResponse<Subscription>> = await httpClient.post(
    '/api/subscription/cancel',
    { reason }
  );
  return response.data.data;
}

/**
 * Reactivate cancelled subscription
 */
export async function reactivateSubscription(): Promise<Subscription> {
  const response: AxiosResponse<ApiResponse<Subscription>> = await httpClient.post(
    '/api/subscription/reactivate'
  );
  return response.data.data;
}

// Payment Methods
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const response: AxiosResponse<ApiResponse<PaymentMethod[]>> = await httpClient.get(
    '/api/payment-methods/available'
  );
  return response.data.data;
}

export async function addPaymentMethod(
  paymentMethodId: string
): Promise<PaymentMethod> {
  const response: AxiosResponse<ApiResponse<PaymentMethod>> = await httpClient.post(
    '/api/payment-methods/save-config',
    { paymentMethodId }
  );
  return response.data.data;
}

export async function removePaymentMethod(paymentMethodId: string): Promise<void> {
  await httpClient.post('/api/payment-methods/save-config', { removeId: paymentMethodId });
}

export async function setDefaultPaymentMethod(paymentMethodId: string): Promise<void> {
  await httpClient.post('/api/payment-methods/save-config', { defaultId: paymentMethodId });
}

// ── Invoices ────────────────────────────────────────────────────────────────

/**
 * Get invoice history. Delivered-order invoices are generated from billing
 * lines by the billing engine (invoice_type `delivered_order`).
 */
export async function getInvoices(): Promise<Invoice[]> {
  const response: AxiosResponse<ApiResponse<Invoice[]>> = await httpClient.get(
    '/api/subscription/invoices'
  );
  return response.data.data;
}

export async function getInvoice(invoiceId: string): Promise<Invoice> {
  const response: AxiosResponse<ApiResponse<Invoice>> = await httpClient.get(
    `/api/subscription/invoices/${invoiceId}`
  );
  return response.data.data;
}

// ── Commercial billing lines (ADR-0011) ─────────────────────────────────────

/** One delivered-order billing line, service-boundary camelCase shape. */
export interface InvoiceBillingLine {
  id: string;
  invoiceId: string | null;
  orderId: string | null;
  lineKind: string | null;
  outcome: string | null;
  unitPriceMinor: number;
  amountMinor: number;
  currency: string;
  contractVersion: string | null;
  createdAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function rejectBillingLines(message: string): never {
  throw new Error(`Billing line payload rejected: ${message}`);
}

function requireMinor(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    rejectBillingLines(`${label} must be a non-negative integer minor amount`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') rejectBillingLines(`${label} must be a string or null`);
  return value;
}

function parseBillingLine(value: unknown, index: number): InvoiceBillingLine {
  const label = `lines[${index}]`;
  if (!isRecord(value)) rejectBillingLines(`${label} must be an object`);
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') rejectBillingLines(`${label}.id must be a non-empty string`);
  const currency = value.currency;
  if (currency !== COMMERCIAL_CONTRACT.currency) rejectBillingLines(`${label}.currency must be BDT`);
  const contractVersion = optionalString(value.contractVersion, `${label}.contractVersion`);
  const unitPriceMinor = requireMinor(value.unitPriceMinor, `${label}.unitPriceMinor`);
  if (contractVersion === COMMERCIAL_CONTRACT_VERSION
    && unitPriceMinor !== COMMERCIAL_CONTRACT.unitPriceMinor) {
    rejectBillingLines(`${label}.unitPriceMinor does not match contract ${COMMERCIAL_CONTRACT_VERSION}`);
  }
  return {
    id,
    invoiceId: optionalString(value.invoiceId, `${label}.invoiceId`),
    orderId: optionalString(value.orderId, `${label}.orderId`),
    lineKind: optionalString(value.lineKind, `${label}.lineKind`),
    outcome: optionalString(value.outcome, `${label}.outcome`),
    unitPriceMinor,
    amountMinor: requireMinor(value.amountMinor, `${label}.amountMinor`),
    currency,
    contractVersion,
    createdAt: optionalString(value.createdAt, `${label}.createdAt`),
  };
}

/** Validate the billing-lines envelope. Malformed data throws; no price is substituted. */
export function parseBillingLinesPayload(payload: unknown): InvoiceBillingLine[] {
  if (!isRecord(payload)) rejectBillingLines('payload must be an object');
  if (!Array.isArray(payload.lines)) rejectBillingLines('payload.lines must be an array');
  return payload.lines.map((line, index) => parseBillingLine(line, index));
}

/**
 * Tenant-scoped billing lines for one invoice. The backend scopes by the
 * JWT-derived shop; a foreign invoice is a 403, never an empty read.
 */
export async function getBillingLines(invoiceId: string): Promise<InvoiceBillingLine[]> {
  const response: AxiosResponse<ApiResponse<unknown>> = await httpClient.get(
    '/api/commercial/billing-lines',
    { params: { invoiceId } }
  );
  if (!response.data || response.data.success !== true) {
    rejectBillingLines('billing-lines request did not succeed');
  }
  return parseBillingLinesPayload(response.data.data);
}

// ── bKash invoice payment (delivered-order invoices) ────────────────────────

export interface BkashCheckout {
  bkash_url: string;
  payment_id: string;
  invoice_id: string;
  invoice_number?: string;
  amount?: number;
}

/**
 * Start a bKash checkout for a specific outstanding invoice.
 */
export async function payInvoice(
  invoiceId: string,
  extra?: { phone?: string; name?: string }
): Promise<BkashCheckout> {
  const response: AxiosResponse<ApiResponse<BkashCheckout>> = await httpClient.post(
    `/api/subscription/invoices/${invoiceId}/pay`,
    extra
  );
  return response.data.data;
}

/**
 * Ensure a monthly renewal invoice exists and start a bKash checkout for it.
 * Kept for the existing renewal flow; the contract has no renewal fee.
 */
export async function renewSubscription(
  extra?: { phone?: string; name?: string; plan_code?: string }
): Promise<BkashCheckout> {
  const response: AxiosResponse<ApiResponse<BkashCheckout>> = await httpClient.post(
    '/api/subscription/renew',
    extra
  );
  return response.data.data;
}

/** Verify a returned bKash payment and settle the invoice. */
export async function completeInvoicePayment(
  invoiceId: string,
  paymentId: string
): Promise<{ success: boolean; invoice_id: string; status: string; subscription_status?: string | null }> {
  const response: AxiosResponse<ApiResponse<Record<string, unknown>>> = await httpClient.post(
    '/api/subscription/invoices/pay/complete',
    { invoice_id: invoiceId, payment_id: paymentId }
  );
  return response.data.data as {
    success: boolean;
    invoice_id: string;
    status: string;
    subscription_status?: string | null;
  };
}

/** Release a bound invoice checkout after a cancelled or failed browser return. */
export async function cancelInvoicePayment(
  invoiceId: string,
  paymentId: string,
): Promise<{ success: boolean; invoice_id: string; status: string; already_paid?: boolean; already_released?: boolean }> {
  const response: AxiosResponse<ApiResponse<Record<string, unknown>>> = await httpClient.post(
    '/api/subscription/invoices/pay/cancel',
    { invoice_id: invoiceId, payment_id: paymentId }
  );
  return response.data.data as {
    success: boolean;
    invoice_id: string;
    status: string;
    already_paid?: boolean;
    already_released?: boolean;
  };
}

// ── Prepaid conversation credits — RETIRED (ADR-0011) ───────────────────────

/**
 * @deprecated Prepaid conversation credits were retired by ADR-0011. There is
 * no pack catalog and the purchase endpoints answer 410.
 */
export async function getTopupPacks(): Promise<never> {
  throw new SubscriptionCatalogRetiredError();
}

/**
 * @deprecated Retired with the conversation-credit model (ADR-0011).
 */
export async function initiateTopup(
  _packCode: string,
  _extra?: { phone?: string; name?: string; idempotency_key?: string }
): Promise<never> {
  void _packCode;
  void _extra;
  throw new SubscriptionCatalogRetiredError();
}

/**
 * @deprecated Retired with the conversation-credit model (ADR-0011).
 */
export async function completeTopup(
  _topupId: string,
  _paymentId: string
): Promise<never> {
  void _topupId;
  void _paymentId;
  throw new SubscriptionCatalogRetiredError();
}