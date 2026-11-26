/**
 * Payment Settings — settings-UI projection of the CANONICAL frontend mirror.
 *
 * The single FE vocabulary source is `../payment/taxonomy` (contract §1.1),
 * which `../payment/__tests__/payment-taxonomy.mirror.test.ts` pins
 * field-for-field against the backend enum source
 * (`EasyMod-backend/src/modules/payment/payment-taxonomy.js`). This file keeps
 * ONLY what the two settings tabs need on top of that vocabulary: the i18n
 * key helpers, English fallback labels, and the wire view shapes — no enum is
 * declared here anymore (canonical drift starts with a second local array, so
 * there must not be one).
 *
 * Inert by default (R-12): nothing here asserts a live provider check. The
 * highest level a wallet/self-MFS or Nagad/Rocket account can ever display is
 * `configured_unverified`; `live_certified` is a recorded owner act only (§2.3).
 */

import type {
  Provider,
  AccountType,
  AdvancePolicy,
  VerificationLevel,
} from '../payment/taxonomy';

// ── Canonical vocabulary (re-exported so tab components have one import) ─────
export type { Provider, AccountType, VerificationLevel, AdvancePolicy } from '../payment/taxonomy';
export {
  PROVIDERS,
  ACCOUNT_TYPES,
  VERIFICATION_LEVELS,
  ADVANCE_POLICIES,
  WALLET_PROVIDERS,
  WALLET_ONLY_PROVIDERS,
  COD_ACCOUNT_TYPE,
  GATEWAY_ACCOUNT_TYPE,
  ADVANCE,
  channelsForProvider,
  maxLevelFor,
  levelRank,
  isWalletOnly,
} from '../payment/taxonomy';

// ── English fallback labels (rendered ONLY as `t()` defaultValue) ────────────

/**
 * English fallback labels used as `t()` defaultValue so a provider renders a
 * proper display name even before the locale keys land — never a raw lowercase
 * token. bkash/cod keys already exist in en+bn and take precedence.
 */
export const PROVIDER_DEFAULT_LABEL: Record<Provider, string> = {
  cod: 'Cash on Delivery',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
};

export const providerDefaultLabel = (p: Provider): string => PROVIDER_DEFAULT_LABEL[p] ?? p;

/** mfs_mode stored for a merchant_gateway account (backend stamps business). */
export const GATEWAY_MFS_MODE = 'business' as const;

/** English fallbacks so an account channel renders a label pre-locale. */
export const ACCOUNT_TYPE_DEFAULT_LABEL: Record<AccountType, string> = {
  standard: 'Standard',
  self: 'Personal wallet',
  business: 'Business wallet',
  merchant_gateway: 'Merchant API',
};

export const accountTypeDefaultLabel = (type: AccountType): string =>
  ACCOUNT_TYPE_DEFAULT_LABEL[type] ?? type;

// ── i18n key helpers (labels resolve through `t()`, never hard-coded here) ───


/** Provider display-name key. bkashName/codName already exist; nagadName/rocketName are new. */
export function providerNameKey(provider: Provider): string {
  return `manageShop.paymentSettings.${provider}Name`;
}

/** Human account-channel label key. */
export function accountTypeKey(type: AccountType): string {
  return `manageShop.paymentSettings.accountTypes.${type}`;
}

/** Advance-policy radio title key (reuses existing noPayment/fullPayment/deliveryOnly/percentage/fixedAmount). */
export function advancePolicyKey(policy: AdvancePolicy): string {
  switch (policy) {
    case 'none':
      return `manageShop.paymentSettings.noPayment`;
    case 'full':
      return `manageShop.paymentSettings.fullPayment`;
    case 'delivery_charge':
      return `manageShop.paymentSettings.deliveryOnly`;
    case 'percentage':
      return `manageShop.paymentSettings.percentage`;
    case 'fixed':
      return `manageShop.paymentSettings.fixedAmount`;
    default:
      return `manageShop.paymentSettings.advancePolicy`;
  }
}

// ── View shapes (mirror serializeAccount + getPaymentPolicy responses) ───────

export interface CredentialSummary {
  has_credentials: boolean;
  mfs_type: string | null;
  mfs_mode: string | null;
  mfs_number: string | null;
}

/** One payment account row as returned by `listPaymentAccounts` (§1.3/§6). */
export interface PaymentAccountView {
  id: string;
  shop_id: string;
  provider: Provider | null;
  account_type: AccountType | null;
  gateway: string | null;
  is_enabled: boolean;
  is_preferred: boolean;
  verification_level: VerificationLevel;
  automated_checkout_active: boolean;
  provider_notice?: { en: string; bn: string } | null;
  config?: Record<string, unknown>;
  credential_summary?: CredentialSummary;
  created_at?: string;
  updated_at?: string;
}

/** Policy draft/persisted shape (GET/PUT /api/payment/policy, §5.2). */
export interface PaymentPolicyView {
  advance_policy: AdvancePolicy;
  advance_value: number | null;
  payment_message: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

export const DEFAULT_POLICY_VIEW: PaymentPolicyView = {
  advance_policy: 'none',
  advance_value: null,
  payment_message: '',
};

/** Wallet credentials the FE sends (mfs_type must match the chosen provider). */
export interface WalletCredentials {
  mfs_type: Provider;
  mfs_number: string;
  mfs_mode: 'self' | 'business';
}

/** bKash merchant_gateway tokenized-app credentials — NEVER re-hydrated, only replaced by entry. */
export interface GatewayCredentials {
  app_key: string;
  app_secret: string;
  username: string;
  password?: string;
}
