/**
 * Payment API types — Payment Settings redesign (data contract
 * docs/payment-redesign/00_PAYMENT_DATA_CONTRACT.md §1–§6).
 *
 * `PaymentCredentialSummary` / `PaymentConfig` are the LEGACY compat shapes
 * (§1.4 dual-write window) still consumed by `PaymentSettings.tsx`.
 * `PaymentAccountView` / `PaymentPolicyView` are the canonical wire shapes
 * produced by A5's `payment-accounts.service.serializeAccount` and
 * `payment-policy.service.getPaymentPolicy` — field-for-field, never echoing
 * decrypted credentials (§8.1 serialization pin).
 */

export interface PaymentCredentialSummary {
  has_credentials: boolean;
  mfs_type: 'bkash' | 'nagad' | 'rocket' | null;
  mfs_mode: 'self' | 'business' | 'merchant' | null;
  mfs_number: string | null;
}

export interface PaymentConfig {
  id?: string;
  gateway: string;
  is_enabled: boolean;
  config?: Record<string, unknown>;
  credential_summary?: PaymentCredentialSummary;
  created_at?: string;
  updated_at?: string;
}

export type PaymentCredentials = Record<string, unknown>;

// ── Canonical account model (§1.1 / §1.3 / §6) ───────────────────────────────

export type PaymentProvider = 'cod' | 'bkash' | 'nagad' | 'rocket';
export type PaymentAccountType = 'standard' | 'self' | 'business' | 'merchant_gateway';
export type PaymentVerificationLevel =
  | 'unverified'
  | 'configured_unverified'
  | 'sandbox_verified'
  | 'live_certified';
export type PaymentAdvancePolicy = 'none' | 'full' | 'delivery_charge' | 'percentage' | 'fixed';

export interface PaymentAccountView {
  id: string;
  shop_id: string;
  /** NULL only on honest drift rows whose credentials cannot be decrypted (§1.3-3, A5 Q6). */
  provider: PaymentProvider | null;
  account_type: PaymentAccountType | null;
  /** Legacy dual-write compat value during the §1.4 window; will disappear next release. */
  gateway: string | null;
  is_enabled: boolean;
  is_preferred: boolean;
  verification_level: PaymentVerificationLevel;
  /** Honest automation predicate (§2.3 isAutomatable) — false in every inert deployment. */
  automated_checkout_active: boolean;
  /** Exact §2 "official verification unavailable" notice for nagad/rocket, else null. */
  provider_notice?: { en: string; bn: string } | null;
  config?: Record<string, unknown>;
  credential_summary?: PaymentCredentialSummary;
  created_at?: string;
  updated_at?: string;
}

export interface SavePaymentAccountPayload {
  provider: PaymentProvider;
  account_type: PaymentAccountType;
  is_enabled?: boolean;
  credentials?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
}

export interface UpdatePaymentAccountPatch {
  is_enabled?: boolean;
  credentials?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
}

// ── Advance-payment policy (§5.2) ────────────────────────────────────────────

export interface PaymentPolicyView {
  advance_policy: PaymentAdvancePolicy;
  advance_value: number | null;
  payment_message: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface PaymentPolicyPayload {
  advance_policy: PaymentAdvancePolicy;
  advance_value: number | null;
  payment_message: string;
}
