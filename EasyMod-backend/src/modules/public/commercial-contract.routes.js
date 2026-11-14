'use strict';

/**
 * Public commercial contract (ADR-0011). Unauthenticated by design: the
 * marketing origin cannot hold a merchant session, and the price/term authority
 * must have exactly one server source.
 *
 * The contract payload also carries server-evaluated PUBLIC claim decisions.
 * Anonymous visitors previously saw zero capability claims because
 * ClaimProvider only queried the authenticated /api/commercial/claims endpoint;
 * E2E mocks hid the gap. Decisions are evaluated with the shop context absent,
 * so contract/platform claims are truthful while merchant-dependent claims
 * (add-on pilots, per-shop AI settings) fail closed to their fallback. Internal
 * claims never leave the registry.
 *
 * snake_case is the public-catalog convention (see .easymod/standards/
 * api-contract-rules.md); the nested decision objects reuse the frozen
 * camelCase service shape verbatim.
 */

const express = require('express');
const { publicContractPayload } = require('../commercial/commercial.contract');
const {
    CLAIM_IDS,
    CLAIM_REGISTRY,
    SURFACES,
    MERCHANT_SURFACES,
    INTERNAL_SURFACES,
    registryHash,
} = require('../commercial/claim.registry');
const claimGate = require('../commercial/claim-gate.service');

const router = express.Router();

/**
 * Marketing surfaces an anonymous visitor can actually render. Claims are
 * evaluated on the surfaces they declare; a claim that only lives on, say,
 * `invoice` is not advertising that surface publicly.
 */
const PUBLIC_DECISION_SURFACES = Object.freeze([
    'pricing',
    'landing',
    'subscription',
    'signup',
    'collateral',
]);

const DEFAULT_LOCALE = 'bn';
const LOCALES = Object.freeze(['en', 'bn']);

const normalizeLocale = (value) => (LOCALES.includes(value) ? value : DEFAULT_LOCALE);

const publicClaimDescriptors = () => CLAIM_IDS
    .map((id) => CLAIM_REGISTRY[id])
    .filter((entry) => entry && entry.internalOnly !== true)
    .map((entry) => ({
        id: entry.id,
        verified_scope: entry.verifiedScope,
        surfaces: [...entry.surfaces],
        i18n_key: { ...entry.i18nKey },
        fallback_i18n_key: entry.fallbackI18nKey ? { ...entry.fallbackI18nKey } : null,
    }));

/** Surfaces to evaluate a claim on for an anonymous caller. */
const decisionSurfacesFor = (entry, requestedSurface) => {
    if (requestedSurface) {
        return entry.surfaces.includes(requestedSurface) ? [requestedSurface] : [];
    }
    const preferred = entry.surfaces.filter((surface) => PUBLIC_DECISION_SURFACES.includes(surface));
    if (preferred.length > 0) return preferred;
    const merchantSurface = entry.surfaces.find((surface) => MERCHANT_SURFACES.includes(surface));
    return merchantSurface ? [merchantSurface] : [];
};

/**
 * Evaluate every merchant-visible claim with no shop context. Sequential on
 * purpose: the evidence plumbing shares module state and decision order should
 * stay deterministic.
 */
async function publicClaimDecisions({ locale, requestedSurface }) {
    const decisions = [];
    for (const claimId of CLAIM_IDS) {
        const entry = CLAIM_REGISTRY[claimId];
        if (!entry || entry.internalOnly === true) continue;
        for (const surface of decisionSurfacesFor(entry, requestedSurface)) {
            // eslint-disable-next-line no-await-in-loop
            decisions.push(await claimGate.evaluateClaim(claimId, { surface, locale, shopId: null }));
        }
    }
    return decisions;
}

router.get('/', async (req, res, next) => {
    try {
        const requestedSurface = req.query?.surface;
        if (requestedSurface !== undefined) {
            if (typeof requestedSurface !== 'string'
                || !SURFACES.includes(requestedSurface)
                || INTERNAL_SURFACES.includes(requestedSurface)) {
                res.status(400).json({
                    success: false,
                    error: { message: 'Unknown claim surface', code: 'UNKNOWN_CLAIM_SURFACE' },
                });
                return;
            }
        }
        const locale = normalizeLocale(req.query?.locale);

        res.json({
            success: true,
            data: {
                ...publicContractPayload(),
                registry_hash: registryHash,
                claims: publicClaimDescriptors(),
                decisions: await publicClaimDecisions({
                    locale,
                    requestedSurface: requestedSurface || null,
                }),
            },
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;