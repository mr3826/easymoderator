'use strict';

/**
 * Canonical payment vocabulary — the single enum source for provider,
 * account_type, verification level and payment-transaction status across DB /
 * API / service (Payment Data Contract §1.1, §2, §3).
 *
 * Entity ENUMs, validators, services and notification helpers import this and
 * must NOT keep local arrays. The frontend mirror
 * (`EasyMod-frontend/src/app/components/payment/taxonomy.ts`) is pinned against
 * these exports by the mirror-invariant test.
 *
 * Nothing here asserts a LIVE provider verification: the ladder is inert by
 * default (R-12) and `live_certified` is never self-declared by the app (§2.3).
 */

// ── Providers ────────────────────────────────────────────────────────────────
const PROVIDERS = Object.freeze(['cod', 'bkash', 'nagad', 'rocket']);

// ── Account semantics per provider (§1.1) ────────────────────────────────────
//   cod              → 'standard'           (single, credential-free)
//   bkash/nagad/rocket → 'self' | 'business' (wallet number, manual + confirm)
//   bkash            → 'merchant_gateway'    (official Tokenized Checkout v2)
const ACCOUNT_TYPES = Object.freeze(['standard', 'self', 'business', 'merchant_gateway']);

// The one account_type a `cod` provider may carry; everything else is a wallet.
const COD_ACCOUNT_TYPE = 'standard';
const WALLET_ACCOUNT_TYPES = Object.freeze(['self', 'business']);
// Account kinds that reach the customer as a "send to this number" wallet step.
const SELF_MFS_ACCOUNT_TYPES = Object.freeze(['self', 'business']);
// Only this kind is ever automatable, and only at live_certified (§2.3).
const GATEWAY_ACCOUNT_TYPE = 'merchant_gateway';

// Providers whose payments are wallet-number only (no official verify API).
const WALLET_ONLY_PROVIDERS = Object.freeze(['nagad', 'rocket']);
// Providers that support a self/business wallet account row.
const PROVIDERS_WITH_WALLETS = Object.freeze(['bkash', 'nagad', 'rocket']);

// ── Verification ladder (§2) — strictly ordered, low → high ──────────────────
const VERIFICATION_LEVELS = Object.freeze([
    'unverified',
    'configured_unverified',
    'sandbox_verified',
    'live_certified',
]);

// A credential write or account change demotes to this (§2 invalidation).
const DEMOTED_LEVEL = 'unverified';
// Save path stamps this once credentials are locally validated (§2, R-12).
const DEFAULT_CONFIGURED_LEVEL = 'configured_unverified';

// ── Payment-transaction status vocabulary (§1.3-003, §3.1) ───────────────────
const PAYMENT_TRANSACTION_STATUSES = Object.freeze([
    'pending',
    'initiated',
    'payment_claimed',
    'processing',
    'paid',
    'verified',
    'failed',
    'rejected',
]);
// The self-MFS claim state that awaits merchant judgment (§3.2-3).
const CLAIM_STATUS = 'payment_claimed';
// Statuses accepted on a merchant approval of a claim (§3.2-4).
const APPROVABLE_STATUSES = Object.freeze([
    'pending',
    'initiated',
    'processing',
    CLAIM_STATUS,
]);
// An active attempt on an order blocks re-initiation (§4.4).
const ACTIVE_ATTEMPT_STATUSES = Object.freeze(['initiated', 'processing', CLAIM_STATUS]);

// ── Advance-payment policy enums (§5.2) ──────────────────────────────────────
const ADVANCE_POLICIES = Object.freeze(['none', 'full', 'delivery_charge', 'percentage', 'fixed']);
// Legacy FE radio values that must still be accepted at the boundary (§5.2 note).
const ADVANCE_POLICY_ALIASES = Object.freeze({ delivery: 'delivery_charge' });
// advance_value bounds (taka), per policy (§5.2).
const ADVANCE_PERCENTAGE_MIN = 1;
const ADVANCE_PERCENTAGE_MAX = 99;
const ADVANCE_FIXED_MIN = 1;
const ADVANCE_FIXED_MAX = 100000;

// ── Display labels (en + bn) — all three providers labeled, fixes Rocket gap (§1.1, §6) ──
const PROVIDER_LABELS = Object.freeze({
    cod: Object.freeze({ en: 'Cash on Delivery', bn: 'ক্যাশ অন ডেলিভারি' }),
    bkash: Object.freeze({ en: 'bKash', bn: 'বিকাশ' }),
    nagad: Object.freeze({ en: 'Nagad', bn: 'নগদ' }),
    rocket: Object.freeze({ en: 'Rocket', bn: 'রকেট' }),
});

// Customer-facing keyword map for the chatbot provider selection (§3.4, §6).
const PROVIDER_KEYWORDS = Object.freeze({
    cod: Object.freeze(['cod', 'cash', 'cash on delivery', 'সিওডি', 'ক্যাশ অন ডেলিভারি', 'ক্যাশ']),
    bkash: Object.freeze(['bkash', 'b-kash', 'বিকাশ']),
    nagad: Object.freeze(['nagad', 'নগদ']),
    rocket: Object.freeze(['rocket', 'রকেট']),
});

// Honest surface copy for the wallet-only providers (§2).
const WALLET_ONLY_VERIFICATION_NOTICE = Object.freeze({
    en: 'Official automated verification is not available for Nagad/Rocket. Payments to these numbers are confirmed by you (the merchant), never automatically.',
    bn: 'নাগদ/রকেটের জন্য অফিসিয়াল স্বয়ংক্রিয় যাচাই নেই। এই নম্বরে পেমেন্ট আপনি (দোকান মালিক) নিশ্চিত করেন, স্বয়ংক্রিয়ভাবে নয়।',
});

// Exact sandbox copy mandated by D-3 (§2.2).
const SANDBOX_NO_SETTLEMENT_COPY = Object.freeze({
    en: 'sandbox checkout handshake verified; no settlement implied',
});

// ── Legacy alias translation (§1.1, §1.2) ─────────────────────────────────────
// 'self-mfs' is a LEGACY gateway label. It is not a provider: the real provider
// lives inside the encrypted credentials (mfs_type), so it is resolved during
// migration/backfill from the row, never assumed to be bkash. The API boundary
// tolerates it for one release (compat window §1.4) but new canonical payloads
// must carry {provider, account_type}. normalizeProvider('self-mfs') therefore
// returns null so callers fall back to credentials, NOT a silent bkash mapping.
const LEGACY_GATEWAY_SELF_MFS = 'self-mfs';
const LEGACY_GATEWAY_COD = 'cod';
// Dual-write value the legacy `gateway` column keeps for the compat window:
// every wallet account row writes gateway='self-mfs'; cod writes 'cod' (§1.4).
const legacyGatewayFor = (provider) => {
    const p = normalizeProvider(provider);
    if (!p) return null;
    return p === 'cod' ? LEGACY_GATEWAY_COD : LEGACY_GATEWAY_SELF_MFS;
};

const PROVIDER_ALIASES = Object.freeze({
    cash: 'cod',
    cash_on_delivery: 'cod',
    cashondelivery: 'cod',
    'cash-on-delivery': 'cod',
    bkash: 'bkash',
    'b-kash': 'bkash',
    bikas: 'bkash',
    nagad: 'nagad',
    rocket: 'rocket',
});

/**
 * Lowercase + trim a raw provider-ish token and canonicalize it.
 * Returns null for empty, for the ambiguous legacy 'self-mfs', and for anything
 * outside the provider set (callers validate / fall back to credentials).
 */
function normalizeProvider(raw) {
    if (typeof raw !== 'string') return null;
    const token = raw.trim().toLowerCase();
    if (!token) return null;
    if (token === LEGACY_GATEWAY_SELF_MFS || token === 'mfs' || token === 'self mfs') return null;
    if (token === 'cod') return 'cod';
    if (Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, token)) return PROVIDER_ALIASES[token];
    return PROVIDERS.includes(token) ? token : null;
}

const ACCOUNT_TYPE_ALIASES = Object.freeze({
    personal: 'self',
    private: 'self',
    merchant: 'business', // legacy mfs_mode; upgrade to merchant_gateway needs gateway creds (§1.3 backfill)
    wallet: 'self',
    business: 'business',
    standard: 'standard',
    n_a: 'standard',
});

/**
 * Canonicalize an account_type token. For a `cod` provider this is always
 * 'standard'. Unknown/empty → null (caller rejects in the new API).
 */
function normalizeAccountType(raw, provider) {
    if (normalizeProvider(provider) === 'cod') return COD_ACCOUNT_TYPE;
    if (typeof raw !== 'string') return null;
    const token = raw.trim().toLowerCase();
    if (!token) return null;
    if (ACCOUNT_TYPES.includes(token)) return token;
    if (Object.prototype.hasOwnProperty.call(ACCOUNT_TYPE_ALIASES, token)) {
        return ACCOUNT_TYPE_ALIASES[token];
    }
    return null;
}

/**
 * Resolve the account_type for a legacy self-mfs row from its credentials,
 * recovering the today-lost merchant_gateway distinction (§1.3-2, §1.2):
 * a `merchant` mode row that carries app_key/app_secret + username is a real
 * gateway account, not a business personal wallet.
 */
function accountTypeFromCredentials(credentials, provider) {
    const p = normalizeProvider(provider);
    if (p === 'cod') return COD_ACCOUNT_TYPE;
    const creds = credentials && typeof credentials === 'object' ? credentials : {};
    const mode = typeof creds.mfs_mode === 'string' ? creds.mfs_mode.toLowerCase() : '';
    const hasGatewayCreds = Boolean(creds.app_key && creds.app_secret && creds.username);
    if (mode === 'merchant' || mode === 'business') {
        return hasGatewayCreds ? GATEWAY_ACCOUNT_TYPE : 'business';
    }
    if (mode === 'self' || mode === 'personal') return 'self';
    // No explicit mode: infer gateway from credentials, else a personal wallet.
    return hasGatewayCreds ? GATEWAY_ACCOUNT_TYPE : 'self';
}

/**
 * Resolve the provider for a legacy self-mfs row: credentials.mfs_type first,
 * then the already-canonical provider column; never assumes bkash (§1.2, §1.3-2).
 */
function providerFromCredentials(credentials, fallbackProvider) {
    const creds = credentials && typeof credentials === 'object' ? credentials : {};
    const fromCreds = normalizeProvider(creds.mfs_type);
    if (fromCreds) return fromCreds;
    return normalizeProvider(fallbackProvider);
}

// ── Verification ladder helpers (§2, §2.3) ───────────────────────────────────
function levelRank(level) {
    const idx = VERIFICATION_LEVELS.indexOf(level);
    return idx === -1 ? -1 : idx;
}

/** Highest ladder rung a given account kind can ever reach (§2). */
function maxVerificationLevel(provider, accountType) {
    const p = normalizeProvider(provider);
    const a = normalizeAccountType(accountType, p);
    if (p === 'cod') return 'live_certified'; // COD never needs certification; ladder unused (§1.1)
    if (p === 'bkash' && a === GATEWAY_ACCOUNT_TYPE) return 'live_certified';
    // self/business wallets and nagad/rocket top out here (§2, R-12).
    return 'configured_unverified';
}

/** Whether `level` is reachable/allowed for this account kind. */
function canReachLevel(provider, accountType, level) {
    const rank = levelRank(level);
    if (rank < 0) return false;
    return rank <= levelRank(maxVerificationLevel(provider, accountType));
}

/** Are the merchant-gateway credential fields present (§2.3 automation predicate). */
function credentialsComplete(account) {
    const creds = account && typeof account.credentials === 'object' && account.credentials
        ? account.credentials
        : null;
    if (!creds) return false;
    return Boolean(creds.app_key && creds.app_secret && creds.username);
}

/**
 * The single automation-enable predicate (§2.3). False unless the account is a
 * live_certified bKash merchant_gateway with complete credentials AND the runtime
 * flag is on. R-12: in this environment the flag is false and no live creds exist,
 * so this is always false for every account — gateway automation ships INERT.
 */
function isAutomatable(account, { bKashEnabled = process.env.BKASH_ENABLED } = {}) {
    if (!account) return false;
    return Boolean(
        account.is_enabled
        && normalizeProvider(account.provider) === 'bkash'
        && normalizeAccountType(account.account_type, 'bkash') === GATEWAY_ACCOUNT_TYPE
        && account.verification_level === 'live_certified'
        && String(bKashEnabled) === 'true'
        && credentialsComplete(account),
    );
}

// ── Transaction status canonicalization (§4.1) ───────────────────────────────
const STATUS_CANONICAL = Object.freeze({
    PENDING: 'pending',
    INITIATED: 'initiated',
    PAYMENT_CLAIMED: 'payment_claimed',
    PROCESSING: 'processing',
    PAID: 'paid',
    VERIFIED: 'verified',
    COMPLETED: 'paid', // bKash v2 title-case 'Completed' ⇒ settled (§4.1, §4.2)
    SUCCESS: 'paid',
    SUCCEEDED: 'paid',
    FAILED: 'failed',
    CANCELLED: 'failed',
    CANCELED: 'failed',
    REJECTED: 'rejected',
});

/** Lowercase/trim a raw status token and map to the canonical set; else the token lowercased. */
function canonicalStatus(raw) {
    if (typeof raw !== 'string') return null;
    const token = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!token) return null;
    if (Object.prototype.hasOwnProperty.call(STATUS_CANONICAL, token)) return STATUS_CANONICAL[token];
    const lower = token.toLowerCase();
    return PAYMENT_TRANSACTION_STATUSES.includes(lower) ? lower : lower;
}

/**
 * Case-insensitive "did the provider say the money is settled" — the fix for the
 * demonstrated 'Completed' vs 'COMPLETED' mismatch class (§4.1, #7-17 canonical set).
 * The merchant-gateway verification path compares through this, never a raw spelling.
 */
function isSettledStatus(raw) {
    return canonicalStatus(raw) === 'paid';
}

// ── Labels / lookup ──────────────────────────────────────────────────────────
function providerLabel(provider, lang = 'en') {
    const p = normalizeProvider(provider) || (typeof provider === 'string' ? provider.toLowerCase() : provider);
    const entry = PROVIDER_LABELS[p];
    if (!entry) return typeof provider === 'string' ? provider : '';
    return entry[lang] || entry.en;
}

// A safe, non-null, uppercase-able label for notification formatting (§3.3).
function providerLabelSafe(provider, lang = 'en') {
    const label = providerLabel(provider, lang);
    return label || 'Manual payment';
}

module.exports = {
    PROVIDERS,
    ACCOUNT_TYPES,
    COD_ACCOUNT_TYPE,
    WALLET_ACCOUNT_TYPES,
    SELF_MFS_ACCOUNT_TYPES,
    GATEWAY_ACCOUNT_TYPE,
    WALLET_ONLY_PROVIDERS,
    PROVIDERS_WITH_WALLETS,
    VERIFICATION_LEVELS,
    DEMOTED_LEVEL,
    DEFAULT_CONFIGURED_LEVEL,
    PAYMENT_TRANSACTION_STATUSES,
    CLAIM_STATUS,
    APPROVABLE_STATUSES,
    ACTIVE_ATTEMPT_STATUSES,
    ADVANCE_POLICIES,
    ADVANCE_POLICY_ALIASES,
    ADVANCE_PERCENTAGE_MIN,
    ADVANCE_PERCENTAGE_MAX,
    ADVANCE_FIXED_MIN,
    ADVANCE_FIXED_MAX,
    PROVIDER_LABELS,
    PROVIDER_KEYWORDS,
    WALLET_ONLY_VERIFICATION_NOTICE,
    SANDBOX_NO_SETTLEMENT_COPY,
    LEGACY_GATEWAY_SELF_MFS,
    LEGACY_GATEWAY_COD,
    legacyGatewayFor,
    normalizeProvider,
    normalizeAccountType,
    accountTypeFromCredentials,
    providerFromCredentials,
    levelRank,
    maxVerificationLevel,
    canReachLevel,
    credentialsComplete,
    isAutomatable,
    canonicalStatus,
    isSettledStatus,
    providerLabel,
    providerLabelSafe,
};
