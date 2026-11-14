'use strict';

/**
 * Commercial contract — the ONLY module permitted to define merchant-facing
 * price, billing model, and entitlement truth. Every derived surface (API,
 * invoice, email, landing, collateral, mobile, Growth OS) must read this module
 * or its hand-mirrored frontend twin and render `contractVersion` so drift is
 * detectable. See docs/adr/0011-delivered-order-commercial-contract.md.
 *
 * Pure module: node:crypto only. No DB, no network, no service imports. Money is
 * integer poisha (BDT minor units) per docs/ai/AGENT_CONTRACTS.md §1.
 *
 * Founder decisions 2026-11-14 (ADR-0011):
 *   C1 full supersession of the 2026-11-01 subscription ledger — flat BDT 10 per
 *      provider-confirmed delivered order, from order 1, all shops.
 *   C5 overdue blocks new courier booking AND pauses automated AI replies
 *      (founder-approved deviation from the task's literal onOverdue clause);
 *      manual inbox + history stay readable; nothing is deleted.
 */

const crypto = require('crypto');

const COMMERCIAL_CONTRACT_VERSION = '1.0.0';

const deepFreeze = (value) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
};

/** Stable JSON: object keys sorted recursively so hashes are order-independent. */
const canonicalJson = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
};

const COMMERCIAL_CONTRACT = deepFreeze({
    contractVersion: COMMERCIAL_CONTRACT_VERSION,
    schemaName: 'commercial.contract',
    model: 'DELIVERED_ORDER',
    currency: 'BDT',
    trigger: 'ORDER_DELIVERED_PROVIDER_CONFIRMED',
    unitPriceMinor: 1000,
    zeroRatedOutcomes: deepFreeze([
        'RETURNED', 'CANCELLED', 'DRAFT', 'CONFIRMED', 'BOOKED', 'IN_TRANSIT', 'FAILED',
    ]),
    subscriptionFeeMinor: 0,
    setupFeeMinor: 0,
    monthlyMinimumMinor: 0,
    conversationEntitlement: null,
    cycle: 'MONTHLY',
    payment: 'POSTPAID',
    dueDays: 7,
    onOverdue: deepFreeze({
        blockCourierBooking: true,
        pauseAutomatedAi: true,
        keepInboxReadable: true,
        keepHistoryReadable: true,
        deleteData: false,
    }),
});

/**
 * Forbidden merchant-facing tokens. A CI scanner (scripts/verify-claims) fails
 * the build when any of these appears outside this module and its tests.
 *
 * Design rules:
 *  - Patterns are QUALIFIED so bare numbers (ports, ids, product prices) never
 *    match. `source` + `flags` are serialized for the snapshot and the scanner.
 *  - The NEW price (BDT 10 / ৳10 / ৳১০) is deliberately NOT forbidden. Only the
 *    retired subscription prices and the retired Partner bands (15/12) are.
 *  - `Growth` excludes the internal "Growth OS" product and GROWTH_USER/GROWTH_OS_*
 *    role identifiers, which are not the retired GROWTH plan.
 *  - Uppercase plan CODES (SHURU/GROWTH/PARTNER) are historical data identifiers,
 *    not display tokens; a separate scanner rule restricts them to compat paths.
 */
const FORBIDDEN_TOKENS = deepFreeze([
    { id: 'name.get_your_moderator', source: 'Get Your Moderator', flags: 'g', description: 'Retired SHURU public name' },
    { id: 'name.moderator_plus', source: 'Moderator Plus', flags: 'g', description: 'Retired GROWTH public name' },
    { id: 'name.partnership', source: 'Partnership', flags: 'g', description: 'Retired PARTNER public name' },
    { id: 'name.shuru', source: '\\bShuru\\b', flags: 'g', description: 'Retired SHURU display name' },
    {
        id: 'name.growth',
        source: '\\bGrowth\\b',
        flags: 'g',
        description: 'Retired GROWTH display name (not Growth OS / role ids)',
        excludeSources: ['Growth\\s*OS', 'GROWTH_USER', 'GROWTH_OS_', 'growth-os'],
        excludeFlags: 'gi',
    },
    { id: 'price.bdt999', source: '(?:৳|BDT\\s*)\\s*999\\b', flags: 'g', description: 'Retired GROWTH monthly price' },
    { id: 'price.999_per_month', source: '\\b999\\s*/\\s*(?:month|mo|মাস)', flags: 'gi', description: 'Retired monthly price' },
    { id: 'price.any_per_month', source: '(?:৳|BDT)\\s*\\d[\\d,]*\\s*/\\s*(?:month|mo|মাস)', flags: 'gi', description: 'Any retired subscription monthly price' },
    { id: 'price.yearly9990', source: '\\b9990\\b', flags: 'g', description: 'Retired GROWTH yearly price' },
    { id: 'price.bn999', source: '৳৯৯৯', flags: 'g', description: 'Retired GROWTH price (Bengali numerals)' },
    { id: 'price.bn9990', source: '৯৯৯০', flags: 'g', description: 'Retired yearly price (Bengali numerals)' },
    { id: 'price.legacy_annual', source: '11,?988', flags: 'g', description: 'Legacy annual tester invoice amount' },
    { id: 'band.retired_rate_15', source: '(?:৳|BDT\\s*)\\s*15\\b|৳১৫', flags: 'g', description: 'Retired Partner band rate 15' },
    { id: 'band.retired_rate_12', source: '(?:৳|BDT\\s*)\\s*12\\b|৳১২', flags: 'g', description: 'Retired Partner band rate 12' },
    { id: 'band.range_300_999', source: '300\\s*[–-]\\s*999', flags: 'g', description: 'Retired Partner band range' },
    { id: 'band.range_1000_2999', source: '1,?000\\s*[–-]\\s*2,?999', flags: 'g', description: 'Retired Partner band range' },
    { id: 'band.range_3000_plus', source: '3,?000\\+', flags: 'g', description: 'Retired Partner band range' },
    { id: 'band.qualification', source: '300\\+?\\s*delivered|৩০০\\+', flags: 'gi', description: 'Retired Partner qualification threshold' },
    { id: 'band.phrase', source: 'delivered-order band|rate band', flags: 'gi', description: 'Retired tiered-band language' },
    { id: 'entitlement.conv100', source: '100\\s*(?:customer\\s*)?conversations', flags: 'gi', description: 'Retired SHURU conversation entitlement' },
    { id: 'entitlement.conv500', source: '500\\s*(?:customer\\s*)?conversations', flags: 'gi', description: 'Retired GROWTH conversation entitlement' },
    { id: 'entitlement.bn_conv', source: '(?:১০০|৫০০)টি?\\s*(?:customer\\s*)?(?:conversations|কথোপকথন)', flags: 'gi', description: 'Retired conversation entitlement (Bengali)' },
    { id: 'entitlement.allowance', source: 'conversation allowance|conversation limit|conversations per month', flags: 'gi', description: 'Retired conversation metering language' },
    { id: 'entitlement.topup_pack', source: 'top-up pack|topup pack|PACK_100|PACK_300|PACK_700', flags: 'gi', description: 'Retired conversation top-up packs' },
]);

const BENGALI_DIGITS = Object.freeze(['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']);
const toBengaliNumerals = (text) => String(text).replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)]);

/** formatBdt(1000) -> '৳10.00' */
const formatBdt = (minor) => {
    const value = Number(minor);
    if (!Number.isFinite(value)) throw new TypeError('formatBdt requires a finite integer minor amount');
    return `৳${(value / 100).toFixed(2)}`;
};

/** formatBdtBn(1000) -> '৳১০.০০' */
const formatBdtBn = (minor) => toBengaliNumerals(formatBdt(minor));

const unitPriceDisplay = (locale = 'en') => (
    locale === 'bn' ? formatBdtBn(COMMERCIAL_CONTRACT.unitPriceMinor) : formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor)
);

/** Pure human summary used by collateral, emails and the public API. */
const describeContract = (locale = 'en') => {
    const price = unitPriceDisplay(locale);
    if (locale === 'bn') {
        return `${price} প্রতি ডেলিভারি করা অর্ডার। রিটার্ন বা বাতিল অর্ডারে ${formatBdtBn(0)}। কোনো সাবস্ক্রিপশন নেই, সেটআপ ফি নেই, মাসিক ন্যূনতম নেই। মাসিক পোস্টপেইড, ${COMMERCIAL_CONTRACT.dueDays} দিনের মধ্যে পরিশোধ।`;
    }
    return `${price} per delivered order. ${formatBdt(0)} on returned or cancelled orders. No subscription, no setup fee, no monthly minimum. Monthly postpaid, due within ${COMMERCIAL_CONTRACT.dueDays} days.`;
};

const contractHash = `sha256:${crypto.createHash('sha256')
    .update(canonicalJson({ version: COMMERCIAL_CONTRACT_VERSION, contract: COMMERCIAL_CONTRACT }), 'utf8')
    .digest('hex')}`;

/**
 * Public API payload. Public catalog convention is snake_case whole BDT (see
 * .easymod/standards/api-contract-rules.md); minor units + version + hash are
 * included so every consumer can detect drift.
 */
const publicContractPayload = () => deepFreeze({
    contract_version: COMMERCIAL_CONTRACT_VERSION,
    contract_hash: contractHash,
    model: COMMERCIAL_CONTRACT.model,
    currency: COMMERCIAL_CONTRACT.currency,
    trigger: COMMERCIAL_CONTRACT.trigger,
    unit_price_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
    unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
    zero_rated_outcomes: COMMERCIAL_CONTRACT.zeroRatedOutcomes,
    subscription_fee_bdt: 0,
    setup_fee_bdt: 0,
    monthly_minimum_bdt: 0,
    conversation_entitlement: null,
    cycle: COMMERCIAL_CONTRACT.cycle,
    payment: COMMERCIAL_CONTRACT.payment,
    due_days: COMMERCIAL_CONTRACT.dueDays,
    on_overdue: COMMERCIAL_CONTRACT.onOverdue,
    description: { en: describeContract('en'), bn: describeContract('bn') },
});

/** Require-time invariants (ceiling pattern from provider-capabilities.js). */
const assertContractInvariants = () => {
    const c = COMMERCIAL_CONTRACT;
    if (!(c.unitPriceMinor > 0)) throw new Error('commercial contract: unitPriceMinor must be > 0');
    if (c.dueDays !== 7) throw new Error('commercial contract: dueDays must be 7');
    if (c.conversationEntitlement !== null) throw new Error('commercial contract: conversationEntitlement must be null');
    if (c.subscriptionFeeMinor !== 0 || c.setupFeeMinor !== 0 || c.monthlyMinimumMinor !== 0) {
        throw new Error('commercial contract: subscription/setup/monthlyMinimum fees must be 0');
    }
    for (const outcome of ['RETURNED', 'CANCELLED']) {
        if (!c.zeroRatedOutcomes.includes(outcome)) throw new Error(`commercial contract: ${outcome} must be zero-rated`);
    }
    if (c.onOverdue.deleteData !== false) throw new Error('commercial contract: onOverdue must never delete data');
    for (const token of FORBIDDEN_TOKENS) {
        // eslint-disable-next-line no-new
        new RegExp(token.source, token.flags);
        for (const ex of token.excludeSources || []) new RegExp(ex, token.excludeFlags || 'gi');
    }
};

assertContractInvariants();

module.exports = {
    COMMERCIAL_CONTRACT_VERSION,
    COMMERCIAL_CONTRACT,
    FORBIDDEN_TOKENS,
    contractHash,
    canonicalJson,
    deepFreeze,
    formatBdt,
    formatBdtBn,
    toBengaliNumerals,
    unitPriceDisplay,
    describeContract,
    publicContractPayload,
};