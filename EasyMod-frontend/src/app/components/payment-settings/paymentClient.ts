/**
 * Payment Settings — documented cast seam to the payment API domain.
 *
 * The redesign's client calls are named after the contract §API surface (the
 * endpoints A5 landed in `payment.routes.js`). The `@/api/domains/payment`
 * module is OWNED BY ANOTHER ROLE (api layer / integration); I must not edit it.
 * Exactly as `delivery/ProvidersTab.tsx` references `clearAiDefault` "added to
 * the order domain by the integration (A0)", this file augments the imported
 * namespace locally so the settings components stay self-consistent while the
 * domain owner exposes these functions. Once they exist on the module the cast
 * is a no-op; the runtime call is by the exact contract name.
 *
 * Endpoint ↔ name map (mounted at `/api/payment` per A5 `payment.routes.js`):
 *   getPaymentAccounts()                  → GET    /api/payment/accounts
 *   savePaymentAccount(payload)           → POST   /api/payment/accounts
 *   updatePaymentAccount(id, patch)       → PATCH  /api/payment/accounts/:id
 *   deletePaymentAccount(id)              → DELETE /api/payment/accounts/:id
 *   setPreferredAccount(id)               → PUT    /api/payment/accounts/:id/preferred
 *   verifyPaymentAccountCredentials(id)   → POST   /api/payment/accounts/:id/verify-credentials
 *   certifyLiveAccount(id, evidence)      → POST   /api/payment/accounts/:id/certify-live
 *   getPaymentPolicy()                    → GET    /api/payment/policy
 *   updatePaymentPolicy(payload)          → PUT    /api/payment/policy
 *
 * The A3-owned verify/certify endpoints return an honest 501
 * PAYMENT_SERVICE_NOT_IMPLEMENTED until A3 lands them (never presented as
 * verified — R-12); the FE surfaces exactly what the server says.
 */
import * as paymentDomain from '@/api/domains/payment';
import type {
  GatewayCredentials,
  PaymentAccountView,
  PaymentPolicyView,
  Provider,
  AccountType,
  WalletCredentials,
} from './taxonomy';

export interface SavePaymentAccountPayload {
  provider: Provider;
  account_type: AccountType;
  is_enabled?: boolean;
  credentials?: WalletCredentials | GatewayCredentials | null;
  config?: Record<string, unknown>;
}

export interface UpdatePaymentAccountPatch {
  is_enabled?: boolean;
  credentials?: WalletCredentials | GatewayCredentials | null;
  config?: Record<string, unknown>;
}

export interface PaymentPolicyPayload {
  advance_policy: PaymentPolicyView['advance_policy'];
  advance_value: number | null;
  payment_message: string;
}

type Envelope<T> = { success: boolean; data: T; message?: string };
type Ack = { success: boolean; message?: string };

interface PaymentContractApi {
  getPaymentAccounts: () => Promise<Envelope<PaymentAccountView[]>>;
  savePaymentAccount: (payload: SavePaymentAccountPayload) => Promise<Envelope<PaymentAccountView>>;
  updatePaymentAccount: (accountId: string, patch: UpdatePaymentAccountPatch) => Promise<Envelope<PaymentAccountView>>;
  deletePaymentAccount: (accountId: string) => Promise<Ack>;
  setPreferredAccount: (accountId: string) => Promise<Ack & { preferred_account_id?: string }>;
  // A3 dispatch — the FE renders the server verdict honestly, never claims verification.
  verifyPaymentAccountCredentials: (
    accountId: string,
  ) => Promise<Ack & { status?: string; message?: string; data?: unknown }>;
  certifyLiveAccount: (accountId: string, evidence: string) => Promise<Ack & { data?: unknown }>;
  // Policies (one write pair for the Policies tab, R-14).
  getPaymentPolicy: () => Promise<Envelope<PaymentPolicyView>>;
  updatePaymentPolicy: (payload: PaymentPolicyPayload) => Promise<Envelope<PaymentPolicyView>>;
}

export type PaymentClient = typeof paymentDomain & PaymentContractApi;

export const paymentClient = paymentDomain as PaymentClient;
