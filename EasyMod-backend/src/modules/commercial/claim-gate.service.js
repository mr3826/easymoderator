'use strict';

/**
 * Claim gate — the runtime evaluator for the frozen claim registry.
 *
 * A merchant surface may render a claim only when every required evidence flag
 * resolves true. Evidence is resolved through the static authority manifest
 * (evidence-authorities.js), never through ad-hoc feature checks, so the
 * registry stays the allowlist and the gate cannot develop a second opinion.
 *
 * Modes (claim.registry#resolveMode):
 *   off      render the claim unconditionally (internal surfaces only)
 *   shadow   render the claim but log/count the decisions enforce would block
 *   enforce  render the claim only when available, else the truthful fallback
 *
 * Fail-closed rules:
 *   - unknown claim id, unknown surface, surface mismatch, resolver throw =>
 *     enforce renders `none` and counts truth_gate.lookup_failed
 *   - any authority that cannot be read resolves false (add-ons, AI settings)
 *
 * Logging carries identifiers and booleans only: claimId, surface, mode,
 * predicate flags, available, rendered, contractVersion, registryHash. It never
 * carries shopId, customer, phone or order data.
 */

const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    formatBdt,
    formatBdtBn,
    toBengaliNumerals,
} = require('./commercial.contract');
const {
    getClaim,
    resolveMode,
    registryHash,
    PLATFORM_EVIDENCE,
    SURFACES,
} = require('./claim.registry');
const { EVIDENCE_AUTHORITIES } = require('./evidence-authorities');
const { PROVIDER_CAPABILITIES } = require('../delivery/provider-capabilities');
const { createLogger } = require('../../utils/structured-logger');
const metrics = require('./commercial-metrics');

const logger = createLogger('TruthGate');

const CLAIM_CONTRACT_VERSION = COMMERCIAL_CONTRACT_VERSION;
const DEFAULT_LOCALE = 'bn';
const SUPPORTED_LOCALES = Object.freeze(['en', 'bn']);
const RENDER_VALUES = Object.freeze(['claim', 'fallback', 'none']);
const RESOLVE_HINT_SETTLEMENT_BLOCKED = Object.freeze(['UNSUPPORTED', 'UNKNOWN']);

/** Display names only; codes remain the identifiers in scope metadata. */
const PROVIDER_DISPLAY_NAMES = Object.freeze({
    pathao: 'Pathao',
    steadfast: 'Steadfast',
    redx: 'RedX',
});

const providerDisplayName = (provider) => PROVIDER_DISPLAY_NAMES[provider] || provider;

const normalizeLocale = (locale) => (
    SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE
);

/**
 * Safe registry lookup. The registry is a frozen static map, but the gate must
 * fail closed even if a future edit makes the lookup throw.
 */
const safeGetClaim = (claimId) => {
    try {
        return getClaim(claimId) || null;
    } catch (_) {
        return null;
    }
};

/**
 * Resolve the five boolean predicate facets from the required evidence map.
 *
 * A claim with claimedProviders treats its per-provider `production_verified`
 * flags as scope evidence, not as an AND: some verified providers means the
 * claim is available with rewritten copy; zero verified means unavailable.
 */
function predicateFacets(entry, evidenceMap) {
    const predicate = {
        code_present: true,
        merchant_enabled: true,
        production_verified: true,
        deprecated: entry.deprecated === true,
        internal_only: entry.internalOnly === true,
        scope_match: true,
    };

    const scopeFacet = entry.scopeEvidenceFacet || 'production_verified';
    const claimedFlags = new Set(
        (entry.claimedProviders || []).map((provider) => `courier.${provider}.${scopeFacet}`),
    );

    for (const flagId of entry.requiredEvidence) {
        if (claimedFlags.has(flagId)) continue;
        const evidence = evidenceMap[flagId] === true;
        if (flagId.endsWith('.code_present')) {
            if (!evidence) predicate.code_present = false;
        } else if (flagId.endsWith('.merchant_enabled')) {
            if (!evidence) predicate.merchant_enabled = false;
        } else if (flagId.endsWith('.production_verified')) {
            if (!evidence) predicate.production_verified = false;
        } else if (!evidence) {
            // Unknown facet with false evidence: fail closed rather than let an
            // unrecognised required flag leave the claim available.
            predicate.code_present = false;
        }
    }

    if (entry.claimedProviders) {
        const verified = entry.claimedProviders.filter((provider) => (
            evidenceMap[`courier.${provider}.${scopeFacet}`] === true
        ));
        predicate.production_verified = predicate.production_verified && verified.length > 0;
        predicate.scope_match = verified.length === entry.claimedProviders.length;
    }

    return predicate;
}

/**
 * Pure availability rule. Exported so the predicate truth table is pinned by
 * unit tests independent of evidence plumbing.
 */
function isCustomerAvailable(predicate) {
    return Boolean(
        predicate
        && predicate.code_present === true
        && predicate.merchant_enabled === true
        && predicate.production_verified === true
        && predicate.deprecated === false
        && predicate.internal_only === false,
    );
}

/**
 * Scope report for a claim that names the providers it covers. `match` is the
 * predicate's scope_match flag; `count` drives both availability (0 => no) and
 * copy rewriting (0 < count < total => render with verified providers only).
 */
function resolveScope(entry, evidenceMap) {
    if (!entry.claimedProviders || entry.claimedProviders.length === 0) {
        return {
            claimedProviders: null,
            verifiedProviders: null,
            match: true,
            count: 0,
            total: 0,
            text: entry.verifiedScope || null,
        };
    }

    const scopeFacet = entry.scopeEvidenceFacet || 'production_verified';
    const verified = entry.claimedProviders.filter((provider) => (
        evidenceMap[`courier.${provider}.${scopeFacet}`] === true
    ));
    const total = entry.claimedProviders.length;
    const fullMatch = verified.length === total;
    return {
        claimedProviders: [...entry.claimedProviders],
        verifiedProviders: verified,
        match: fullMatch,
        count: verified.length,
        total,
        // Never reuse the frozen `verifiedScope` string here: it records the
        // state at freeze time (e.g. "verified 0 of 3"), which would be a lie
        // once providers are actually verified.
        text: `courier:${entry.claimedProviders.join(', ')} `
            + `(verified ${verified.length} of ${total}: ${verified.join(', ') || 'none'})`,
    };
}

/** True when the surface may render the claimed copy in the current mode. */
function decideRender(mode, available, entry) {
    if (mode === 'off' || mode === 'shadow') return 'claim';
    if (available) return 'claim';
    return entry && entry.fallbackI18nKey ? 'fallback' : 'none';
}

function textKeyFor(entry, render, locale) {
    if (!entry) return null;
    if (render === 'claim') return entry.i18nKey[locale] || null;
    if (render === 'fallback') return entry.fallbackI18nKey ? (entry.fallbackI18nKey[locale] || null) : null;
    return null;
}

/**
 * Rewritten-copy interpolation. A provider-scoped claim always renders
 * `{{providers}}` narrowed to the providers that actually pass, so the sentence
 * never overstates coverage (a full match passes all of them).
 *
 * The price claim is interpolated from COMMERCIAL_CONTRACT, never hardcoded in
 * copy: a future unitPriceMinor change flows to the rendered sentence in both
 * locales, so copy can never drift from the sole price authority.
 */
function interpolationFor(scope, entry) {
    const interpolation = {};

    if (scope.claimedProviders && scope.count > 0) {
        // Display names stay available for merchant-app surfaces; a claim that
        // explicitly scopes on a capability facet (e.g. courier.payout on
        // settlement) additionally gets brand-free provider counts for the
        // public landing. Claims without a declared facet keep the original
        // {providers} interpolation unchanged.
        interpolation.providers = scope.verifiedProviders.map(providerDisplayName).join(', ');
        if (entry && entry.scopeEvidenceFacet) {
            interpolation.providerCount = String(scope.count);
            interpolation.providerCountBn = toBengaliNumerals(String(scope.count));
        }
    }

    // Price claims are always interpolated from the contract, never from copy.
    if (entry && (entry.id === 'billing.delivered_order' || String(entry.id).startsWith('price.'))) {
        interpolation.unitPrice = formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor);
        interpolation.unitPriceBn = formatBdtBn(COMMERCIAL_CONTRACT.unitPriceMinor);
        if (entry.id === 'price.zero') {
            interpolation.zeroAmount = formatBdt(0);
            interpolation.zeroAmountBn = formatBdtBn(0);
        }
    }

    return interpolation;
}

function buildDecision({ entry, claimId, surface, locale, mode, evidenceMap }) {
    const scope = resolveScope(entry, evidenceMap);
    const predicate = predicateFacets(entry, evidenceMap);
    const available = isCustomerAvailable(predicate);
    const render = decideRender(mode, available, entry);
    return {
        claimId,
        available,
        render,
        textKey: textKeyFor(entry, render, locale),
        locale,
        surface,
        scope: {
            claimedProviders: scope.claimedProviders,
            verifiedProviders: scope.verifiedProviders,
            match: scope.match,
            text: scope.text,
        },
        interpolation: interpolationFor(scope, entry),
        mode,
        predicate,
        wouldBlock: mode === 'shadow' && !available,
        contractVersion: CLAIM_CONTRACT_VERSION,
        registryHash,
    };
}

/**
 * Decision for a claim that cannot be evaluated truthfully. The gate never
 * guesses: enforce renders nothing, while shadow/off leave the surface's
 * existing copy in place and record the would-block.
 */
function lookupFailureDecision({ claimId, surface, locale, mode }) {
    metrics.increment('truth_gate.lookup_failed');
    const available = false;
    return {
        claimId: typeof claimId === 'string' ? claimId : String(claimId),
        available,
        render: mode === 'enforce' ? 'none' : 'claim',
        textKey: null,
        locale,
        surface: surface || null,
        scope: {
            claimedProviders: null,
            verifiedProviders: null,
            match: false,
            text: null,
        },
        interpolation: {},
        mode,
        predicate: {
            code_present: false,
            merchant_enabled: false,
            production_verified: false,
            deprecated: false,
            internal_only: false,
            scope_match: false,
        },
        wouldBlock: mode === 'shadow',
        contractVersion: CLAIM_CONTRACT_VERSION,
        registryHash,
    };
}

/** Resolve the mode without ever letting an unknown surface disable the gate. */
function safeResolveMode(surface) {
    try {
        return resolveMode(surface, process.env.CLAIM_GATE_MODE);
    } catch (_) {
        // An unknown surface cannot be an internal exemption; enforce.
        return 'enforce';
    }
}

/** Provider capability evidence, per evidence-authorities resolveHint. */
function resolveCourierFlag(flagId) {
    const match = /^courier\.([a-z]+)\.(code_present|production_verified|settlement_present)$/.exec(flagId);
    if (!match) return undefined;
    const [, provider, facet] = match;
    const capabilities = PROVIDER_CAPABILITIES[provider];
    if (!capabilities) return false;

    if (facet === 'code_present') {
        return capabilities.create_parcel?.level !== 'UNSUPPORTED';
    }
    if (facet === 'production_verified') {
        return capabilities.last_verified_at !== null
            && capabilities.last_verified_at !== undefined
            && capabilities.create_parcel?.level === 'LIVE_VERIFIED';
    }

    const settlement = capabilities.settlement;
    if (!settlement || typeof settlement.level !== 'string') return false;
    return !RESOLVE_HINT_SETTLEMENT_BLOCKED.includes(settlement.level);
}

/** Add-on pilot flag; any lookup failure resolves false (claims fail closed). */
async function resolveAddonFlag(flagId, shopId) {
    const match = /^addons\.([a-z_]+)\.merchant_enabled$/.exec(flagId);
    if (!match) return undefined;
    if (!shopId) return false;
    const field = match[1] === 'ads_studio'
        ? 'adsStudio'
        : (match[1] === 'storefront' ? 'storefront' : null);
    if (!field) return false;
    try {
        const { getPilotFeaturesStrict } = require('../pilot-features/pilot-features.service');
        const features = await getPilotFeaturesStrict(shopId);
        return features?.[field] === true;
    } catch (_) {
        return false;
    }
}

/** Shop AI auto-reply flag; unreadable settings resolve false. */
async function resolveAiAutoReplyFlag(flagId, shopId) {
    if (flagId !== 'ai.auto_reply.merchant_enabled') return undefined;
    if (!shopId) return false;
    try {
        const { getShopAiSettings } = require('../shop/shop.service');
        const settings = await getShopAiSettings(shopId);
        if (!settings || typeof settings !== 'object') return false;
        const nested = settings.ai;
        if (nested && typeof nested === 'object' && typeof nested.auto_reply_enabled === 'boolean') {
            return nested.auto_reply_enabled === true;
        }
        return settings.auto_reply_enabled === true;
    } catch (_) {
        return false;
    }
}

/**
 * Contract-derived price facts. Returns undefined when the flag is not a
 * contract facet so callers fall through to the other resolvers.
 */
function resolveContractFlag(flagId) {
    if (flagId === 'contract') return true;
    if (flagId === 'contract.zero_on_return') {
        return COMMERCIAL_CONTRACT.zeroRatedOutcomes.includes('RETURNED')
            && COMMERCIAL_CONTRACT.zeroRatedOutcomes.includes('CANCELLED');
    }
    if (flagId === 'contract.no_subscription') {
        return COMMERCIAL_CONTRACT.subscriptionFeeMinor === 0
            && COMMERCIAL_CONTRACT.setupFeeMinor === 0
            && COMMERCIAL_CONTRACT.monthlyMinimumMinor === 0
            && COMMERCIAL_CONTRACT.conversationEntitlement === null;
    }
    return undefined;
}

/** Async evidence resolution used by evaluateClaim (request path). */
async function resolveFlag(flagId, shopId) {
    const authority = EVIDENCE_AUTHORITIES[flagId];
    if (!authority) return false;
    const contractFlag = resolveContractFlag(flagId);
    if (contractFlag !== undefined) return contractFlag;
    if (flagId.startsWith('platform.')) return PLATFORM_EVIDENCE[flagId]?.value === true;

    const courier = resolveCourierFlag(flagId);
    if (courier !== undefined) return courier;

    const addon = await resolveAddonFlag(flagId, shopId);
    if (addon !== undefined) return addon;

    const ai = await resolveAiAutoReplyFlag(flagId, shopId);
    if (ai !== undefined) return ai;

    // An authority with no synchronous or async resolver is unprovable.
    return false;
}

/**
 * Synchronous resolution used by renderClaim (email/PDF). Only contract,
 * platform and courier evidence is synchronously provable; per-shop add-on and
 * AI flags cannot be read without a DB round-trip, so they resolve false and
 * the claim renders its truthful fallback. That is the safe direction: a
 * backend document never asserts a shop flag it did not read.
 */
function resolveFlagSync(flagId) {
    const authority = EVIDENCE_AUTHORITIES[flagId];
    if (!authority) return false;
    const contractFlag = resolveContractFlag(flagId);
    if (contractFlag !== undefined) return contractFlag;
    if (flagId.startsWith('platform.')) return PLATFORM_EVIDENCE[flagId]?.value === true;
    const courier = resolveCourierFlag(flagId);
    return courier !== undefined ? courier : false;
}

async function resolveEvidence(entry, shopId) {
    const evidenceMap = {};
    for (const flagId of entry.requiredEvidence) {
        evidenceMap[flagId] = await resolveFlag(flagId, shopId);
    }
    return evidenceMap;
}

function recordCounters(decision) {
    if (decision.mode === 'shadow' && !decision.available) {
        metrics.increment('truth_gate.shadow_would_block');
    }
    if (decision.mode === 'enforce' && !decision.available) {
        metrics.increment('truth_gate.enforce_blocked');
    }
}

/**
 * Structured decision log. Deliberately assembled field-by-field (never by
 * spreading the decision) so no future caller can smuggle shop or customer
 * data into the gate log.
 */
function logDecision(decision) {
    const payload = {
        claimId: decision.claimId,
        surface: decision.surface,
        mode: decision.mode,
        predicate: {
            code_present: decision.predicate.code_present,
            merchant_enabled: decision.predicate.merchant_enabled,
            production_verified: decision.predicate.production_verified,
            deprecated: decision.predicate.deprecated,
            internal_only: decision.predicate.internal_only,
            scope_match: decision.predicate.scope_match,
        },
        available: decision.available,
        rendered: decision.render,
        contractVersion: decision.contractVersion,
        registryHash: decision.registryHash,
    };

    if (decision.wouldBlock) {
        logger.warn('truth_gate.shadow_would_block', payload);
    } else if (decision.mode === 'enforce' && !decision.available) {
        logger.warn('truth_gate.enforce_blocked', payload);
    } else {
        logger.info('truth_gate.decision', payload);
    }
}

/**
 * Evaluate one claim for a surface.
 *
 * @param {string} claimId
 * @param {{surface: string, locale?: 'en'|'bn', shopId?: string|null}} options
 * @returns {Promise<object>} ClaimDecision
 */
async function evaluateClaim(claimId, options = {}) {
    const surface = options.surface;
    const locale = normalizeLocale(options.locale);
    const shopId = options.shopId || null;
    const mode = safeResolveMode(surface);

    metrics.increment('truth_gate.decisions');

    const entry = safeGetClaim(claimId);
    if (!entry || !surface || !SURFACES.includes(surface) || !entry.surfaces.includes(surface)) {
        const decision = lookupFailureDecision({ claimId, surface, locale, mode });
        logDecision(decision);
        return decision;
    }

    let evidenceMap;
    try {
        evidenceMap = await resolveEvidence(entry, shopId);
    } catch (_) {
        const decision = lookupFailureDecision({ claimId, surface, locale, mode });
        logDecision(decision);
        return decision;
    }

    const decision = buildDecision({ entry, claimId, surface, locale, mode, evidenceMap });
    recordCounters(decision);
    logDecision(decision);
    return decision;
}

/**
 * Synchronous backend render decision for email/PDF/collateral pipelines.
 * Same predicate, same logging, same fail-closed rules as evaluateClaim; the
 * caller resolves `textKey` through its own localized template.
 *
 * @param {string} claimId
 * @param {{surface: string, locale?: 'en'|'bn', shopId?: string|null,
 *          format?: 'html'|'text'}} options
 * @returns {object} ClaimDecision plus `format`
 */
function renderClaim(claimId, options = {}) {
    const surface = options.surface;
    const locale = normalizeLocale(options.locale);
    const format = options.format === 'html' ? 'html' : 'text';
    const mode = safeResolveMode(surface);

    metrics.increment('truth_gate.decisions');

    const entry = safeGetClaim(claimId);
    if (!entry || !surface || !SURFACES.includes(surface) || !entry.surfaces.includes(surface)) {
        const decision = lookupFailureDecision({ claimId, surface, locale, mode });
        logDecision(decision);
        return { ...decision, format };
    }

    const evidenceMap = {};
    for (const flagId of entry.requiredEvidence) {
        evidenceMap[flagId] = resolveFlagSync(flagId);
    }

    const decision = buildDecision({ entry, claimId, surface, locale, mode, evidenceMap });
    recordCounters(decision);
    logDecision(decision);
    return { ...decision, format };
}

module.exports = {
    CLAIM_CONTRACT_VERSION,
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    RENDER_VALUES,
    isCustomerAvailable,
    predicateFacets,
    resolveScope,
    resolveFlag,
    resolveFlagSync,
    evaluateClaim,
    renderClaim,
};