/**
 * Subscription & Billing API Domain
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
import { getPublicSubscriptionCatalog } from './publicSubscription';
import type { SubscriptionPlanDefinition } from '@/app/lib/subscriptionPlans';

export { getCurrentPublicSubscriptionCatalog, getPublicSubscriptionCatalog } from './publicSubscription';

/**
 * Get current subscription details
 * @returns Promise resolving to the subscription and allowance envelope
 * @throws {Error} When subscription retrieval fails
 * @example
 * ```typescript
 * const details = await getSubscription();
 * console.log('Plan:', details.subscription.plan_name);
 * ```
 */
export async function getSubscription(): Promise<SubscriptionData> {
  const response: AxiosResponse<ApiResponse<SubscriptionData>> = await httpClient.get('/api/subscription');
  return response.data.data;
}

/**
 * Get available subscription plans
 * @returns Promise resolving to array of subscription plans
 * @throws {Error} When plan retrieval fails
 * @example
 * ```typescript
 * const plans = await getSubscriptionPlans();
 * console.log('Available plans:', plans.length);
 * ```
 */
export async function getSubscriptionPlans(): Promise<SubscriptionPlanDefinition[]> {
  return (await getPublicSubscriptionCatalog()).plans;
}

export async function getAiReplyShadowUsage(): Promise<unknown> {
  const response: AxiosResponse<ApiResponse<unknown>> = await httpClient.get('/api/subscription/ai-reply-shadow-ledger/usage');
  return response.data.data;
}

/**
 * Subscribe to a plan
 * @param planId - ID of plan to subscribe to
 * @param billingCycle - Billing cycle ('monthly' | 'yearly', default: 'monthly')
 * @returns Promise resolving to subscription object
 * @throws {Error} When subscription fails
 * @example
 * ```typescript
 * const subscription = await subscribeToPlan('plan123', 'yearly');
 * console.log('Subscribed to yearly plan');
 * ```
 */
export async function subscribeToPlan(
  planId: string,
  billingCycle: 'monthly' | 'yearly' = 'monthly'
): Promise<Subscription> {
  const response: AxiosResponse<ApiResponse<Subscription>> = await httpClient.put(
    '/api/subscription/plan',
    { plan_code: planId.toUpperCase(), billing_cycle: billingCycle }
  );
  return response.data.data;
}

/**
 * Cancel current subscription
 * @param reason - Optional reason for cancellation
 * @returns Promise resolving to updated subscription object
 * @throws {Error} When cancellation fails
 * @example
 * ```typescript
 * const cancelled = await cancelSubscription('Too expensive');
 * console.log('Status:', cancelled.status);
 * ```
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
 * @returns Promise resolving to reactivated subscription object
 * @throws {Error} When reactivation fails
 * @example
 * ```typescript
 * const reactivated = await reactivateSubscription();
 * console.log('Status:', reactivated.status);
 * ```
 */
export async function reactivateSubscription(): Promise<Subscription> {
  const response: AxiosResponse<ApiResponse<Subscription>> = await httpClient.post(
    '/api/subscription/reactivate'
  );
  return response.data.data;
}

// Payment Methods
/**
 * Get available payment methods
 * @returns Promise resolving to array of payment methods
 * @throws {Error} When payment methods retrieval fails
 * @example
 * ```typescript
 * const methods = await getPaymentMethods();
 * console.log('Available methods:', methods.length);
 * ```
 */
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const response: AxiosResponse<ApiResponse<PaymentMethod[]>> = await httpClient.get(
    '/api/payment-methods/available'
  );
  return response.data.data;
}

/**
 * Add new payment method
 * @param paymentMethodId - ID of payment method to add
 * @returns Promise resolving to added payment method object
 * @throws {Error} When payment method addition fails
 * @example
 * ```typescript
 * const method = await addPaymentMethod('payment123');
 * console.log('Added:', method.type);
 * ```
 */
export async function addPaymentMethod(
  paymentMethodId: string
): Promise<PaymentMethod> {
  const response: AxiosResponse<ApiResponse<PaymentMethod>> = await httpClient.post(
    '/api/payment-methods/save-config',
    { paymentMethodId }
  );
  return response.data.data;
}

/**
 * Remove payment method
 * @param paymentMethodId - ID of payment method to remove
 * @returns Promise that resolves when removal completes
 * @throws {Error} When payment method removal fails
 * @example
 * ```typescript
 * await removePaymentMethod('payment123');
 * // Payment method removed
 * ```
 */
export async function removePaymentMethod(paymentMethodId: string): Promise<void> {
  await httpClient.post('/api/payment-methods/save-config', { removeId: paymentMethodId });
}

/**
 * Set default payment method
 * @param paymentMethodId - ID of payment method to set as default
 * @returns Promise that resolves when default is set
 * @throws {Error} When setting default payment method fails
 * @example
 * ```typescript
 * await setDefaultPaymentMethod('payment123');
 * // Payment method set as default
 * ```
 */
export async function setDefaultPaymentMethod(paymentMethodId: string): Promise<void> {
  await httpClient.post('/api/payment-methods/save-config', { defaultId: paymentMethodId });
}

/**
 * Get invoice history
 * @returns Promise resolving to array of invoices
 * @throws {Error} When invoice retrieval fails
 * @example
 * ```typescript
 * const invoices = await getInvoices();
 * console.log('Total invoices:', invoices.length);
 * ```
 */
export async function getInvoices(): Promise<Invoice[]> {
  const response: AxiosResponse<ApiResponse<Invoice[]>> = await httpClient.get(
    '/api/subscription/invoices'
  );
  return response.data.data;
}

/**
 * Get single invoice by ID
 * @param invoiceId - Unique identifier of invoice to retrieve
 * @returns Promise resolving to invoice object
 * @throws {Error} When invoice not found or retrieval fails
 * @example
 * ```typescript
 * const invoice = await getInvoice('invoice123');
 * console.log('Amount:', invoice.amount);
 * ```
 */
export async function getInvoice(invoiceId: string): Promise<Invoice> {
  const response: AxiosResponse<ApiResponse<Invoice>> = await httpClient.get(
    `/api/subscription/invoices/${invoiceId}`
  );
  return response.data.data;
}

// ── bKash invoice payment (monthly renewal / activation) ────────────────────

export interface BkashCheckout {
  bkash_url: string;
  payment_id: string;
  invoice_id: string;
  invoice_number?: string;
  amount?: number;
}

/**
 * Start a bKash checkout for a specific outstanding invoice.
 * Redirect the browser to the returned `bkash_url`; the backend supplies the
 * canonical return URL. Settle the returned `paymentID` + `status` via
 * {@link completeInvoicePayment}.
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
 * Used by the "Activate / Renew with bKash" CTA for lapsed shops.
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

/**
 * Verify a returned bKash payment and settle the invoice (reactivating the AI when
 * the invoice is a monthly/partner renewal).
 */
export async function completeInvoicePayment(
  invoiceId: string,
  paymentId: string
): Promise<{ success: boolean; invoice_id: string; status: string; subscription_status?: string | null }> {
  const response: AxiosResponse<ApiResponse<any>> = await httpClient.post(
    '/api/subscription/invoices/pay/complete',
    { invoice_id: invoiceId, payment_id: paymentId }
  );
  return response.data.data;
}

/** Release a bound invoice checkout after a cancelled or failed browser return. */
export async function cancelInvoicePayment(
  invoiceId: string,
  paymentId: string,
): Promise<{ success: boolean; invoice_id: string; status: string; already_paid?: boolean; already_released?: boolean }> {
  const response: AxiosResponse<ApiResponse<any>> = await httpClient.post(
    '/api/subscription/invoices/pay/cancel',
    { invoice_id: invoiceId, payment_id: paymentId },
  );
  return response.data.data;
}

// ── Conversation top-up (integrated bKash) ──────────────────────────────────

export interface TopupPack {
  code: string;
  conversations: number;
  priceBdt: number;
}

export async function getTopupPacks(): Promise<TopupPack[]> {
  const response: AxiosResponse<ApiResponse<TopupPack[]>> = await httpClient.get(
    '/api/subscription/topup/packs'
  );
  return response.data.data;
}

/**
 * Start a bKash checkout for a conversation top-up pack.
 * Redirect to the returned `bkash_url`; settle the return via {@link completeTopup}.
 */
export async function initiateTopup(
  packCode: string,
  extra?: { phone?: string; name?: string; idempotency_key?: string }
): Promise<{ topup_id: string; bkash_url: string; payment_id: string; invoice_number?: string }> {
  const response: AxiosResponse<ApiResponse<any>> = await httpClient.post(
    '/api/subscription/topup/initiate',
    { pack_code: packCode, ...extra }
  );
  return response.data.data;
}

/**
 * Verify a returned bKash top-up payment and credit conversations to the balance.
 */
export async function completeTopup(
  topupId: string,
  paymentId: string
): Promise<{ success: boolean; conversations_added?: number; invoice_url?: string }> {
  const response: AxiosResponse<ApiResponse<any>> = await httpClient.post(
    '/api/subscription/topup/complete',
    { topup_id: topupId, payment_id: paymentId }
  );
  return response.data.data;
}

