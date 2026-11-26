/**
 * Payment taxonomy — CANONICAL frontend mirror of the backend enum source
 * (`EasyMod-backend/src/modules/payment/payment-taxonomy.js`).
 *
 * Contract §1.1: the three disagreeing vocabularies (entity enum vs validator
 * vs service aliasing) were the original disease; this file is the single FE
 * source of payment vocabulary and `__tests__/payment-taxonomy.mirror.test.ts`
 * pins it against the backend module field-for-field (the "mirror invariant"
 * precedent from this repo's redesign waves).
 *
 * UI label TEXT does not live here — every rendered string is an i18n key
 * resolved through `t()` (bn-first). This module is vocabulary + rules only.
 */

export type Provider = 'cod' | 'bkash' | 'nagad' | 'rocket';
export type AccountType = 'standard' | 'self' | 'business' | 'merchant_gateway';
export type VerificationLevel =
  | 'unverified'
  | 'configured_unverified'
  | 'sandbox_verified'
  | 'live_certified';
export type AdvancePolicy = 'none' | 'full' | 'delivery_charge' | 'percentage' | 'fixed';

/** Provider display order — COD first, then the wallet providers (§1.1 table). */
export const PROVIDERS: Provider[] = ['cod', 'bkash', 'nagad', 'rocket'];

/** Legal account channels (§1.1). */
export const ACCOUNT_TYPES: AccountType[] = ['standard', 'self', 'business', 'merchant_gateway'];

/** Verification ladder, low → high (§2). */
export const VERIFICATION_LEVELS: VerificationLevel[] = [
  'unverified',
  'configured_unverified',
  'sandbox_verified',
  'live_certified',
];

/** Advance-policy enum order for the radio set (§5.2). */
export const ADVANCE_POLICIES: AdvancePolicy[] = [
  'none',
  'full',
  'delivery_charge',
  'percentage',
  'fixed',
];

/** Providers that hold a "send to this number" wallet account. */
export const WALLET_PROVIDERS: Provider[] = ['bkash', 'nagad', 'rocket'];

/** Providers with NO official verification API — the §2 ceiling copy applies. */
export const WALLET_ONLY_PROVIDERS: Provider[] = ['nagad', 'rocket'];

export const COD_ACCOUNT_TYPE: AccountType = 'standard';
export const GATEWAY_ACCOUNT_TYPE: AccountType = 'merchant_gateway';

/**
 * Server bounds mirror (payment-policy.service validator; §5.2):
 * percentage 1..99 integer, fixed 1..100000 taka, message ≤ 500 chars.
 */
export const ADVANCE = {
  percentageMin: 1,
  percentageMax: 99,
  fixedMin: 1,
  fixedMax: 100000,
  messageMax: 500,
} as const;

/**
 * The legal (provider → account_type) channel matrix (§1.1):
 *   cod              → standard (single, credential-free)
 *   bkash            → self | business | merchant_gateway
 *   nagad | rocket   → self | business  (no gateway API exists)
 */
export function channelsForProvider(provider: Provider): AccountType[] {
  switch (provider) {
    case 'cod':
      return [COD_ACCOUNT_TYPE];
    case 'bkash':
      return ['self', 'business', GATEWAY_ACCOUNT_TYPE];
    case 'nagad':
    case 'rocket':
      return ['self', 'business'];
    default:
      return [];
  }
}

/**
 * Highest ladder level this account kind can EVER reach (§2
 * maxVerificationLevel mirror). `cod` is ladder-unused; self/business wallets
 * and Nagad/Rocket cap at `configured_unverified`; only bKash
 * merchant_gateway can reach `live_certified` — and even there, ONLY via a
 * recorded owner certification, never self-declared (R-12).
 */
export function maxLevelFor(provider: Provider, type: AccountType): VerificationLevel {
  if (provider === 'cod') return 'live_certified'; // ladder unused (§1.1)
  if (provider === 'bkash' && type === GATEWAY_ACCOUNT_TYPE) return 'live_certified';
  return 'configured_unverified';
}

export const levelRank = (level: VerificationLevel): number =>
  VERIFICATION_LEVELS.indexOf(level);

/** Honest by construction: an unresolvable (null) provider is never claimed
 *  as wallet-only — the row renders its unknown state, not Nagad/Rocket copy. */
export function isWalletOnly(provider: Provider | null): boolean {
  return provider !== null && WALLET_ONLY_PROVIDERS.includes(provider);
}
