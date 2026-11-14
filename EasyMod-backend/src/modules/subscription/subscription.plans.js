/**
 * EasyModerator plan definitions — SINGLE TIER.
 *
 * ADR-0011 (2026-11-14) supersedes the 2026-11-01 ledger in full: there is no
 * subscription, no setup fee, no monthly minimum, no conversation entitlement
 * and no purchasable pack. Every shop is on one postpaid, delivered-order model:
 * a flat price per provider-confirmed delivered order, sourced exclusively from
 * `modules/commercial/commercial.contract.js`.
 *
 * This module owns entitlements and invoice typing, NOT price. No merchant
 * price, plan display name or purchasable catalog may appear here. Historical
 * codes/rates that exist only to resolve old invoices live in
 * `subscription.legacy-plans.js` and are re-exported for compatibility.
 */

const { AI_REPLY_MODES } = require('../shop/ai-reply-mode');

const UNLIMITED = -1;

const PlanCode = Object.freeze({
    MERCHANT: 'MERCHANT',
    // Historical codes are retained ONLY so pre-cutover non-customer-facing
    // lifecycle code can resolve them. Every one normalizes to MERCHANT.
    SHURU: 'SHURU',
    GROWTH: 'GROWTH',
    PARTNER: 'PARTNER',
});

/**
 * One entitlement set for every shop. `voice_note_transcription` is removed:
 * voice transcription is mock-only and has never been live-verified, so it may
 * not be claimed or granted (ADR-0011 evidence truth).
 */
const BASE_FEATURES = Object.freeze({
    // The only connectable channel is Facebook Messenger. The
    // instagram/webchat/telegram capability flags below are legacy taxonomy
    // kept for historical/non-Meta conversation records — they are NOT
    // connectable channels in the product and are not surfaced as connect options.
    ai_auto_reply: true,
    facebook_channel: true,
    instagram_channel: false,
    webchat_channel: false,
    telegram_channel: false,
    comment_auto_reply: false,
    banglish_ai: true,
    tone_persona: true,
    image_understanding: true,
    campaign_broadcast: false,
    max_campaigns_per_month: UNLIMITED,
    rto_shield: true,
    rto_shield_level: 'advanced',
    delivery_auto_zone: true,
    all_bd_gateways: true,
    analytics_days: 30,
    analytics_export: true,
    fcommerce_kpis: true,
    customer_journey_timeline: true,
    priority_support: true,
    api_access: false,
    advanced_ai: true,
    // Routes EVERY message to the expensive model instead of using it for
    // qualified escalation only. It is off for every shop; kept as a flag so a
    // future premium capability can enable it with its own evidence.
    // See docs/ai-cost/GEMINI_FIRST_ROUTING.md.
    advanced_model_preset: false,
    allowed_languages: Object.freeze(['en', 'bn', 'mixed']),
    // Canonical business reply modes advertised to the client. All modes are
    // available; legacy aliases are read-only compatibility data.
    allowed_automation_modes: Object.freeze(Object.values(AI_REPLY_MODES)),
    rate_limit_per_minute: 40,
});

const AI_SETTINGS_ALL = Object.freeze([
    'automation_mode',
    'auto_reply_enabled',
    'primary_language',
    'confidence_threshold',
    'max_auto_order_value',
    'handoff_settings',
    'payment_methods',
    'tone_persona',
    'required_fields',
    'llm_model',
    'llm_temperature',
    'api_enable',
    'custom_webhook',
]);

/**
 * The single MERCHANT tier. `priceBdtMonthly`/`priceBdtYearly` are 0 because
 * there is no subscription fee; the only price is the delivered-order unit
 * price in the commercial contract. No display name is carried here.
 */
const MERCHANT_TIER = {
    code: PlanCode.MERCHANT,
    billingModel: 'per_order',
    priceBdtMonthly: 0,
    priceBdtYearly: 0,
    perOrderChargeBdt: null, // price authority is the commercial contract
    conversationsLimit: UNLIMITED,
    ordersLimit: UNLIMITED,
    productsLimit: UNLIMITED,
    canPurchaseTopups: false,
    features: BASE_FEATURES,
    ai_settings_access: AI_SETTINGS_ALL,
};

// Legacy writers copy `tier.name` into subscription.plan_name, whose schema
// default is the retired "Shuru" display string. Rather than let a new shop row
// persist retired copy, expose the machine CODE as a non-enumerable label: it is
// never enumerated into any listing or API payload and it is not a display name.
Object.defineProperty(MERCHANT_TIER, 'name', {
    value: PlanCode.MERCHANT,
    enumerable: false,
    writable: false,
    configurable: false,
});
Object.freeze(MERCHANT_TIER);

const PRICING_TIERS = {
    [PlanCode.MERCHANT]: MERCHANT_TIER,
};

// Non-enumerable compatibility pointers so legacy lifecycle code that looks up
// `PRICING_TIERS[PlanCode.SHURU]` etc. keeps resolving to the single tier.
// They are deliberately invisible to Object.keys/values so no listing or API
// payload can publish a retired tier again.
for (const legacyCode of [PlanCode.SHURU, PlanCode.GROWTH, PlanCode.PARTNER]) {
    Object.defineProperty(PRICING_TIERS, legacyCode, {
        value: PRICING_TIERS[PlanCode.MERCHANT],
        enumerable: false,
        writable: false,
        configurable: false,
    });
}
Object.freeze(PRICING_TIERS);

// ── Helpers ────────────────────────────────────────────────────────────────────

const isUnlimitedLimit = (limit) => limit === UNLIMITED || limit === null || limit < 0;

const isLimitExceeded = (used, limit) => {
    if (isUnlimitedLimit(limit)) return false;
    return used > limit;
};

/**
 * Resolve any historical or current plan code to the single MERCHANT tier.
 * Every shop carries the same entitlements; this is not a paid-plan lookup.
 */
const normalizePlanCode = (planCode) => {
    void planCode; // historical code retained at the boundary, never re-priced
    return PlanCode.MERCHANT;
};

const getTierByCode = (planCode) => {
    if (!planCode) return null;
    return MERCHANT_TIER;
};

/**
 * Historical rows may carry a plan *name*. Resolve them to the single tier
 * without publishing any retired display name.
 */
const getTierByPlanName = (planName) => {
    if (!planName) return null;
    return MERCHANT_TIER;
};

const isPerOrderBilling = (planCode) => {
    const tier = getTierByCode(planCode);
    return tier?.billingModel === 'per_order';
};

const getAllowedLanguages = () => new Set(MERCHANT_TIER.features.allowed_languages);

const getAllowedAutomationModes = () => new Set(MERCHANT_TIER.features.allowed_automation_modes);

/**
 * Does the single tier grant a named feature?
 * An unknown feature is false — a typo denies access rather than granting it.
 */
const planHasFeature = (planCode, feature) => MERCHANT_TIER.features[feature] === true;

/**
 * Invoice types. `delivered_order` is the ADR-0011 monthly aggregate. The three
 * legacy types remain in the recurring set so residual dunning still gates AI
 * until every pre-cutover invoice is settled.
 */
const InvoiceType = Object.freeze({
    DELIVERED_ORDER: 'delivered_order',
    MONTHLY_SUBSCRIPTION: 'monthly_subscription',
    YEARLY_SUBSCRIPTION: 'yearly_subscription',
    PARTNER_PER_ORDER: 'partner_per_order',
});

const RECURRING_INVOICE_TYPES = Object.freeze([
    InvoiceType.DELIVERED_ORDER,
    InvoiceType.MONTHLY_SUBSCRIPTION,
    InvoiceType.YEARLY_SUBSCRIPTION,
    InvoiceType.PARTNER_PER_ORDER,
]);

/** The recurring invoice type a subscription's billing cycle should produce. */
const recurringInvoiceTypeFor = (billingCycle) => {
    if (billingCycle === 'per_order') return InvoiceType.DELIVERED_ORDER;
    if (billingCycle === 'yearly') return InvoiceType.YEARLY_SUBSCRIPTION;
    return InvoiceType.MONTHLY_SUBSCRIPTION;
};

// Historical catalog and rate math — import from the archive module, never
// render. Re-exported so pre-cutover readers keep resolving old rows.
const {
    PARTNER_ORDER_TIERS,
    TOPUP_PACKS,
    LEGACY_TOPUP_PACKS,
    LEGACY_PLAN_CODES,
    calculatePartnerCharge,
    getPartnerOrderTier,
    getTopupPack,
} = require('./subscription.legacy-plans');

module.exports = {
    PlanCode,
    UNLIMITED,
    PRICING_TIERS,
    BASE_FEATURES,
    InvoiceType,
    RECURRING_INVOICE_TYPES,
    recurringInvoiceTypeFor,
    // Historical resolution (codes + numbers only; no display names)
    LEGACY_PLAN_CODES,
    PARTNER_ORDER_TIERS,
    TOPUP_PACKS,
    LEGACY_TOPUP_PACKS,
    isUnlimitedLimit,
    isLimitExceeded,
    normalizePlanCode,
    getTierByCode,
    getTierByPlanName,
    isPerOrderBilling,
    calculatePartnerCharge,
    getPartnerOrderTier,
    getPerOrderCharge: calculatePartnerCharge,
    getAllowedLanguages,
    getAllowedAutomationModes,
    getTopupPack,
    planHasFeature,
};