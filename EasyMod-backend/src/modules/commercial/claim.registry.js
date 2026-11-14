'use strict';

/**
 * Claim registry — the frozen, versioned list of every merchant-facing claim
 * the platform is permitted to render, where it may render, and which evidence
 * flag proves it. A surface in `enforce` mode may render a claim ONLY when all
 * of its required evidence resolves true; otherwise it renders the entry's
 * truthful fallback. Unknown claims are never renderable.
 *
 * Pure module: node:crypto plus the frozen contract helpers. No DB, no network.
 *
 * Founder decisions 2026-11-14 (ADR-0011): the delivered-order model replaces
 * the retired subscription/band pricing entirely, so every price claim here is
 * backed by `contract`. Courier and AI claims stay unavailable until their
 * evidence flags are raised by a later phase with real verification.
 */

const crypto = require('crypto');
const {
    canonicalJson,
    deepFreeze,
    COMMERCIAL_CONTRACT_VERSION,
} = require('./commercial.contract');
const {
    assertManifestCovers,
    SUPPORTED_PROVIDERS,
    SUPPORTED_ADDONS,
} = require('./evidence-authorities');

const CLAIM_REGISTRY_VERSION = COMMERCIAL_CONTRACT_VERSION;

const SURFACES = Object.freeze([
    'pricing',
    'subscription',
    'signup',
    'landing',
    'email',
    'usage-banner',
    'mobile',
    'collateral',
    'growth-os',
    'admin',
    'invoice',
]);

/** Internal surfaces never gate merchant traffic; they are off by default. */
const INTERNAL_SURFACES = Object.freeze(['growth-os', 'admin']);
const MERCHANT_SURFACES = Object.freeze(SURFACES.filter((s) => !INTERNAL_SURFACES.includes(s)));

const SURFACE_MODES = deepFreeze(Object.fromEntries(
    SURFACES.map((surface) => [surface, INTERNAL_SURFACES.includes(surface) ? 'off' : 'enforce']),
));

const GATE_MODES = Object.freeze(['off', 'shadow', 'enforce']);

/**
 * Resolve the effective gate mode for a surface.
 *
 * CLAIM_GATE_MODE exists for emergencies: it can put a merchant surface into
 * `shadow` globally without a deploy. It can never take a merchant surface
 * `off` — claims on money-facing surfaces must stay checked, so an `off`
 * override is clamped to `shadow` rather than silently disabling the gate.
 * Internal surfaces keep their `off` baseline unless an operator opts in.
 */
const resolveMode = (surface, envOverride) => {
    if (!SURFACES.includes(surface)) {
        throw new TypeError(`Unknown claim surface: ${String(surface)}`);
    }
    const baseline = SURFACE_MODES[surface];
    const raw = envOverride == null ? '' : String(envOverride).trim().toLowerCase();
    if (raw === '') return baseline;
    if (!GATE_MODES.includes(raw)) {
        throw new TypeError(`Unsupported claim gate mode: ${String(envOverride)}`);
    }
    if (baseline === 'off') return raw;
    if (raw === 'off') return 'shadow';
    return raw;
};

const i18nKeys = (id) => Object.freeze({
    en: `claims.${id}.en`,
    bn: `claims.${id}.bn`,
});

const fallbackKeys = (id) => Object.freeze({
    en: `claims.${id}.fallback.en`,
    bn: `claims.${id}.fallback.bn`,
});

const claim = ({
    id,
    surfaces,
    requiredEvidence,
    claimedProviders = null,
    // Which per-provider capability facet proves scope: production_verified by
    // default; courier.payout scopes on settlement_present so a non-payout
    // provider is not counted as a coverage gap.
    scopeEvidenceFacet = null,
    fallback = false,
    verifiedScope,
    internalOnly = false,
}) => Object.freeze({
    id,
    surfaces: Object.freeze([...surfaces]),
    requiredEvidence: Object.freeze([...requiredEvidence]),
    claimedProviders: claimedProviders ? Object.freeze([...claimedProviders]) : null,
    scopeEvidenceFacet,
    i18nKey: i18nKeys(id),
    fallbackI18nKey: fallback ? fallbackKeys(id) : null,
    verifiedScope,
    deprecated: false,
    internalOnly,
});

const courierBooking = (provider) => claim({
    id: `courier.${provider}.booking_live`,
    surfaces: ['pricing', 'landing', 'subscription', 'collateral'],
    requiredEvidence: [`courier.${provider}.code_present`, `courier.${provider}.production_verified`],
    fallback: true,
    verifiedScope: `courier:${provider}`,
});

const courierIntegration = (provider) => claim({
    id: `courier.${provider}.integration_status`,
    surfaces: ['subscription', 'pricing', 'landing'],
    requiredEvidence: [`courier.${provider}.code_present`],
    verifiedScope: `courier:${provider}`,
});

const courierSettlement = (provider) => claim({
    id: `courier.cod_settlement.${provider}`,
    surfaces: ['subscription', 'pricing'],
    requiredEvidence: [`courier.${provider}.settlement_present`],
    fallback: true,
    verifiedScope: `courier:${provider}`,
});

const addonPilot = (code, id) => claim({
    id,
    surfaces: ['pricing', 'subscription'],
    requiredEvidence: ['platform.addons.code_present', `addons.${code}.merchant_enabled`],
    fallback: true,
    verifiedScope: `per-shop:${code}`,
});

const CLAIM_REGISTRY = deepFreeze({
    'billing.delivered_order': claim({
        id: 'billing.delivered_order',
        surfaces: ['pricing', 'subscription', 'signup', 'landing', 'collateral', 'invoice', 'email'],
        requiredEvidence: ['contract'],
        verifiedScope: 'global',
    }),
    'billing.overdue_policy': claim({
        id: 'billing.overdue_policy',
        surfaces: ['subscription', 'email', 'usage-banner', 'invoice'],
        requiredEvidence: ['contract'],
        verifiedScope: 'global',
    }),

    'courier.pathao.booking_live': courierBooking('pathao'),
    'courier.steadfast.booking_live': courierBooking('steadfast'),
    'courier.redx.booking_live': courierBooking('redx'),
    'courier.pathao.integration_status': courierIntegration('pathao'),
    'courier.steadfast.integration_status': courierIntegration('steadfast'),
    'courier.redx.integration_status': courierIntegration('redx'),

    'courier.all_providers': claim({
        id: 'courier.all_providers',
        surfaces: ['pricing', 'landing', 'collateral'],
        requiredEvidence: [
            'courier.pathao.production_verified',
            'courier.steadfast.production_verified',
            'courier.redx.production_verified',
        ],
        claimedProviders: ['pathao', 'steadfast', 'redx'],
        fallback: true,
        verifiedScope: 'courier:all (scope_match N=3, verified 0 of 3)',
    }),

    'courier.cod_settlement.pathao': courierSettlement('pathao'),
    'courier.cod_settlement.steadfast': courierSettlement('steadfast'),
    'courier.cod_settlement.redx': courierSettlement('redx'),

    'voice.transcription': claim({
        id: 'voice.transcription',
        surfaces: ['pricing', 'subscription', 'landing'],
        requiredEvidence: [
            'platform.voice.transcription.code_present',
            'platform.voice.transcription.production_verified',
        ],
        fallback: true,
        verifiedScope: 'global (mock-only)',
    }),
    'voice.auto_reply': claim({
        id: 'voice.auto_reply',
        surfaces: ['pricing', 'landing'],
        // Code absence alone is not enough: a "live-verified" sentence must
        // also require production verification. Both are false today, so the
        // claim renders its truthful fallback.
        requiredEvidence: [
            'platform.voice.auto_reply.code_present',
            'platform.voice.auto_reply.production_verified',
        ],
        fallback: true,
        verifiedScope: 'global (code absent, never production-verified)',
    }),

    'ai.auto_reply': claim({
        id: 'ai.auto_reply',
        surfaces: ['pricing', 'landing', 'subscription'],
        requiredEvidence: [
            'platform.ai.auto_reply.code_present',
            'ai.auto_reply.merchant_enabled',
            'platform.ai.auto_reply.production_verified',
        ],
        fallback: true,
        verifiedScope: 'global (AUTO never proven live)',
    }),
    'ai.draft_reply': claim({
        id: 'ai.draft_reply',
        surfaces: ['pricing', 'landing', 'subscription'],
        requiredEvidence: [
            'platform.ai.draft_reply.code_present',
            'platform.ai.draft_reply.production_verified',
        ],
        // The DRAFT pipeline has never run a live production lifecycle; it is
        // test-verified only. Until that changes the claim renders the
        // truthful fallback rather than the availability sentence.
        fallback: true,
        verifiedScope: 'global (test-verified; production verification pending)',
    }),

    'addons.ads_studio.pilot': addonPilot('ads_studio', 'addons.ads_studio.pilot'),
    'addons.storefront.pilot': addonPilot('storefront', 'addons.storefront.pilot'),

    'ai.reply_shadow_meter': claim({
        id: 'ai.reply_shadow_meter',
        surfaces: ['growth-os', 'admin'],
        requiredEvidence: ['contract'],
        verifiedScope: 'internal',
        internalOnly: true,
    }),

    // ---- Landing-page claims (contract-derived marketing surface) ----------
    // Prices derive from the contract; capabilities fail closed to a truthful
    // fallback because production has never run the commercial lifecycle. None
    // of these names a third party: the landing copy uses counts, never brand
    // names, so courier.payout interpolates providerCount rather than
    // {{providers}}.
    'price.unit': claim({
        id: 'price.unit',
        surfaces: ['landing', 'pricing', 'signup', 'collateral'],
        requiredEvidence: ['contract'],
        verifiedScope: 'global',
    }),
    'price.zero': claim({
        id: 'price.zero',
        surfaces: ['landing', 'pricing', 'collateral'],
        requiredEvidence: ['contract.zero_on_return'],
        fallback: true,
        verifiedScope: 'global (zero-rated on RETURNED and CANCELLED)',
    }),
    'price.nosub': claim({
        id: 'price.nosub',
        surfaces: ['landing', 'pricing', 'signup', 'collateral'],
        requiredEvidence: ['contract.no_subscription'],
        fallback: true,
        verifiedScope: 'global (no subscription/setup/monthly minimum)',
    }),
    'courier.booking': claim({
        id: 'courier.booking',
        surfaces: ['landing', 'pricing', 'collateral'],
        requiredEvidence: [
            'courier.pathao.production_verified',
            'courier.steadfast.production_verified',
            'courier.redx.production_verified',
        ],
        claimedProviders: ['pathao', 'steadfast', 'redx'],
        scopeEvidenceFacet: 'production_verified',
        fallback: true,
        verifiedScope: 'courier:booking (production_verified 0 of 3; ceiling IMPLEMENTED_NOT_LIVE_VERIFIED)',
    }),
    'courier.payout': claim({
        id: 'courier.payout',
        surfaces: ['landing', 'pricing', 'collateral'],
        requiredEvidence: [
            'courier.pathao.settlement_present',
            'courier.steadfast.settlement_present',
            'courier.redx.settlement_present',
        ],
        claimedProviders: ['pathao', 'steadfast', 'redx'],
        scopeEvidenceFacet: 'settlement_present',
        fallback: true,
        verifiedScope: 'courier:payout (settlement_present 1 of 3; implemented-not-live-verified)',
    }),
    'rto.verify': claim({
        id: 'rto.verify',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.rto.code_present', 'platform.rto.production_verified'],
        fallback: true,
        verifiedScope: 'global (implemented; production verification pending)',
    }),
    'voice.transcribe': claim({
        id: 'voice.transcribe',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: [
            'platform.voice.transcription.code_present',
            'platform.voice.transcription.production_verified',
        ],
        fallback: true,
        verifiedScope: 'global (manual preview only; auto pipeline unwired)',
    }),
    'ai.notrain': claim({
        id: 'ai.notrain',
        surfaces: ['landing', 'pricing', 'signup'],
        requiredEvidence: ['platform.ai.no_training_policy'],
        fallback: true,
        verifiedScope: 'policy (published privacy policy; no runtime audit receipt)',
    }),
    'order.fromchat': claim({
        id: 'order.fromchat',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.order_from_chat.code_present', 'platform.order_from_chat.production_verified'],
        fallback: true,
        verifiedScope: 'global (implemented; no production order ever)',
    }),
    'customer.ledger': claim({
        id: 'customer.ledger',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.customer_ledger.code_present', 'platform.customer_ledger.production_verified'],
        fallback: true,
        verifiedScope: 'global (computed timeline read model, not a financial ledger)',
    }),
    'knowledge.gaps': claim({
        id: 'knowledge.gaps',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.knowledge_gaps.code_present', 'platform.knowledge_gaps.production_verified'],
        fallback: true,
        verifiedScope: 'global (implemented; no live traffic)',
    }),
    'queue.priority': claim({
        id: 'queue.priority',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.queue_priority.code_present', 'platform.queue_priority.production_verified'],
        fallback: true,
        verifiedScope: 'global (deterministic bucket ordering, not AI ranking)',
    }),
    'handoff.human': claim({
        id: 'handoff.human',
        surfaces: ['landing', 'pricing'],
        requiredEvidence: ['platform.human_handoff.code_present', 'platform.human_handoff.production_verified'],
        fallback: true,
        verifiedScope: 'global (implemented; no live conversation)',
    }),
});

/**
 * Platform facts. Each value carries the document that evidences it and when it
 * was last checked, so a claim cannot assert a platform capability on memory
 * alone. Booleans here are observations, not feature flags.
 */
const platformEvidence = (value, evidence, lastVerifiedAt = '2026-11-14') => Object.freeze({
    value,
    evidence,
    lastVerifiedAt,
});

const PLATFORM_EVIDENCE = deepFreeze({
    'platform.voice.transcription.code_present': platformEvidence(
        true,
        'docs/operational-gate-closure-v1/ai-runtime-and-model-lifecycle.md',
    ),
    'platform.voice.transcription.production_verified': platformEvidence(
        false,
        'docs/operational-gate-closure-v1/ai-runtime-and-model-lifecycle.md',
    ),
    'platform.voice.auto_reply.code_present': platformEvidence(
        false,
        'docs/ai/AI_ASSISTANT_INTENT_CAPABILITY_BOUNDARY_AUDIT.md',
    ),
    'platform.voice.auto_reply.production_verified': platformEvidence(
        false,
        'docs/ai/AI_ASSISTANT_INTENT_CAPABILITY_BOUNDARY_AUDIT.md',
    ),
    'platform.ai.auto_reply.code_present': platformEvidence(
        true,
        'docs/adr/0003-business-ai-reply-mode-source-of-truth.md',
    ),
    'platform.ai.auto_reply.production_verified': platformEvidence(
        false,
        'docs/meta-app-review-submission.md',
    ),
    'platform.ai.draft_reply.code_present': platformEvidence(
        true,
        'docs/adr/0003-business-ai-reply-mode-source-of-truth.md',
    ),
    'platform.ai.draft_reply.production_verified': platformEvidence(
        // Fail closed: the DRAFT pipeline is covered by tests/meta-e2e, but no
        // live production draft lifecycle has ever run. The BILLING_OPERATIONS
        // receipt cited here previously was a delivered AUTO send, not a draft
        // verification, so it cannot evidence this flag.
        false,
        'tests/meta-e2e (DRAFT pipeline test coverage) + docs/adr/0003-business-ai-reply-mode-source-of-truth.md (no live production draft verification recorded)',
        '2026-11-14',
    ),
    'platform.addons.code_present': platformEvidence(
        true,
        'docs/pilot-plus-v1/06-implementation-and-migrations.md',
    ),

    // Published-policy commitment (not a runtime lifecycle capability): the
    // privacy policy states no merchant/conversation data trains AI models and
    // no provider may train on it.
    'platform.ai.no_training_policy': platformEvidence(
        true,
        'EasyMod-frontend/src/app/components/PrivacyPolicy.tsx and docs/pilot-deployment-rehearsal-v1/09-provider-cost-privacy-decision.md (published policy: no user or conversation data trains AI models; no provider permitted to train)',
    ),

    // Landing capability evidence. code_present=true where the code ships;
    // production_verified=false for every capability because production has
    // never run a commercial lifecycle. A claim with production_verified=false
    // renders its truthful fallback, never an availability sentence. Every
    // pointer below is a full repo-root path so check (d) resolves it.
    'platform.rto.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/rto-shield/rto-shield.service.js and EasyMod-backend/src/modules/delivery/delivery-tracking.service.js (runs inside the delivery status transaction)',
    ),
    'platform.rto.production_verified': platformEvidence(
        false,
        'docs/adr/0011-delivered-order-commercial-contract.md (no live production outcome ever fed RTO)',
    ),
    'platform.order_from_chat.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/conversation/ai-chatbot.controller.js and EasyMod-backend/src/modules/order/order-session-standalone.service.js',
    ),
    'platform.order_from_chat.production_verified': platformEvidence(
        false,
        'docs/launch/PRODUCTION_TRUTH.md (no production order ever created)',
    ),
    'platform.customer_ledger.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/customer-intelligence/customer-360.service.js (computed 360 timeline read model, ADR-0005; not a financial ledger)',
    ),
    'platform.customer_ledger.production_verified': platformEvidence(
        false,
        'docs/launch/PRODUCTION_TRUTH.md (tested on seeded data only; no live production commercial traffic)',
    ),
    'platform.knowledge_gaps.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/knowledge/knowledge-gap-capture.service.js and EasyMod-backend/src/modules/conversation/ai-chatbot.controller.js',
    ),
    'platform.knowledge_gaps.production_verified': platformEvidence(
        false,
        'docs/launch/PRODUCTION_TRUTH.md (never run on live production traffic)',
    ),
    'platform.queue_priority.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/inbox/action-reasons.js and EasyMod-backend/src/modules/inbox/inbox-actions.service.js (deterministic risk-bucket ordering, not AI ranking)',
    ),
    'platform.queue_priority.production_verified': platformEvidence(
        false,
        'docs/launch/PRODUCTION_TRUTH.md (no live production conversation ever queued)',
    ),
    'platform.human_handoff.code_present': platformEvidence(
        true,
        'EasyMod-backend/src/modules/conversation/human-handoff.service.js and EasyMod-backend/src/modules/conversation/conversation.controller.js (manual reply is the default mode)',
    ),
    'platform.human_handoff.production_verified': platformEvidence(
        false,
        'docs/launch/PRODUCTION_TRUTH.md (never exercised by a live production conversation)',
    ),
});

const assertClaimRegistry = () => {
    for (const [flagId, fact] of Object.entries(PLATFORM_EVIDENCE)) {
        if (typeof fact.value !== 'boolean') {
            throw new Error(`claim registry: platform evidence ${flagId} must be boolean`);
        }
        if (typeof fact.evidence !== 'string' || fact.evidence.trim() === '') {
            throw new Error(`claim registry: platform evidence ${flagId} has no evidence pointer`);
        }
        if (fact.lastVerifiedAt !== null && typeof fact.lastVerifiedAt !== 'string') {
            throw new Error(`claim registry: platform evidence ${flagId} lastVerifiedAt must be a string or null`);
        }
    }

    const ids = Object.keys(CLAIM_REGISTRY);
    if (new Set(ids).size !== ids.length) {
        throw new Error('claim registry: duplicate claim ids');
    }

    for (const [key, entry] of Object.entries(CLAIM_REGISTRY)) {
        if (entry.id !== key) {
            throw new Error(`claim registry: entry id ${entry.id} does not match key ${key}`);
        }
        if (entry.surfaces.length === 0) {
            throw new Error(`claim registry: ${key} declares no surfaces`);
        }
        if (new Set(entry.surfaces).size !== entry.surfaces.length) {
            throw new Error(`claim registry: ${key} repeats a surface`);
        }
        for (const surface of entry.surfaces) {
            if (!SURFACES.includes(surface)) {
                throw new Error(`claim registry: ${key} names unknown surface ${surface}`);
            }
        }
        if (entry.requiredEvidence.length === 0) {
            throw new Error(`claim registry: ${key} declares no required evidence`);
        }
        assertManifestCovers(entry.requiredEvidence);

        if (entry.internalOnly && entry.surfaces.some((s) => !INTERNAL_SURFACES.includes(s))) {
            throw new Error(`claim registry: internal-only claim ${key} targets a merchant surface`);
        }
        if (!entry.internalOnly && entry.surfaces.every((s) => INTERNAL_SURFACES.includes(s))) {
            throw new Error(`claim registry: ${key} renders only on internal surfaces and must be internalOnly`);
        }
        if (entry.claimedProviders) {
            for (const provider of entry.claimedProviders) {
                if (!SUPPORTED_PROVIDERS.includes(provider)) {
                    throw new Error(`claim registry: ${key} claims unknown provider ${provider}`);
                }
            }
        }
        for (const plugin of SUPPORTED_ADDONS) {
            if (key.startsWith(`addons.${plugin}.`)) {
                const expected = `addons.${plugin}.merchant_enabled`;
                if (!entry.requiredEvidence.includes(expected)) {
                    throw new Error(`claim registry: ${key} must require ${expected}`);
                }
            }
        }
        for (const [locale, text] of Object.entries(entry.i18nKey)) {
            if (typeof text !== 'string' || text.trim() === '') {
                throw new Error(`claim registry: ${key} i18nKey.${locale} is empty`);
            }
        }
        if (entry.fallbackI18nKey) {
            for (const [locale, text] of Object.entries(entry.fallbackI18nKey)) {
                if (typeof text !== 'string' || text.trim() === '') {
                    throw new Error(`claim registry: ${key} fallbackI18nKey.${locale} is empty`);
                }
            }
        }
        if (entry.deprecated !== false) {
            throw new Error(`claim registry: ${key} is deprecated; remove it instead of shipping it`);
        }
    }
};

assertClaimRegistry();

const registryHash = `sha256:${crypto.createHash('sha256')
    .update(canonicalJson({ version: CLAIM_REGISTRY_VERSION, registry: CLAIM_REGISTRY }), 'utf8')
    .digest('hex')}`;

const CLAIM_IDS = Object.freeze(Object.keys(CLAIM_REGISTRY));

const getClaim = (claimId) => CLAIM_REGISTRY[claimId] || null;

module.exports = {
    CLAIM_REGISTRY_VERSION,
    CLAIM_REGISTRY,
    CLAIM_IDS,
    SURFACES,
    SURFACE_MODES,
    MERCHANT_SURFACES,
    INTERNAL_SURFACES,
    GATE_MODES,
    PLATFORM_EVIDENCE,
    registryHash,
    resolveMode,
    getClaim,
};