'use strict';

/**
 * Commercial HTTP controller — HTTP-only. All predicate, evidence and query
 * logic lives in claim-gate.service / commercial-query.service.
 *
 * Tenant rule: shopId comes from req.shop.id (populated by JWT auth +
 * verifyShopAccess) and never from the query string, body or headers.
 */

const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    contractHash,
} = require('./commercial.contract');
const {
    CLAIM_IDS,
    CLAIM_REGISTRY,
    SURFACES,
    registryHash,
} = require('./claim.registry');
const claimGate = require('./claim-gate.service');
const commercialQuery = require('./commercial-query.service');
const { AppError } = require('../../utils/AppError');

const DEFAULT_LOCALE = 'bn';
const LOCALES = Object.freeze(['en', 'bn']);

function requireShopId(req) {
    const shopId = req.shop?.id;
    if (!shopId) {
        throw new AppError('Shop context is required', 403, 'SHOP_CONTEXT_REQUIRED');
    }
    return shopId;
}

function normalizeLocale(value) {
    return LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/** Merchant-visible claim descriptors. Internal-only claims never leave. */
function merchantClaimDescriptors() {
    return CLAIM_IDS
        .map((id) => CLAIM_REGISTRY[id])
        .filter((entry) => entry && entry.internalOnly !== true)
        .map((entry) => ({
            id: entry.id,
            verifiedScope: entry.verifiedScope,
            surfaces: [...entry.surfaces],
            i18nKey: { ...entry.i18nKey },
            fallbackI18nKey: entry.fallbackI18nKey ? { ...entry.fallbackI18nKey } : null,
        }));
}

/**
 * GET /api/commercial/contract
 * The frozen contract, its hashes, and the merchant claim allowlist.
 */
async function getContract(req, res, next) {
    try {
        requireShopId(req);
        res.json({
            success: true,
            data: {
                contractVersion: COMMERCIAL_CONTRACT_VERSION,
                contractHash,
                registryHash,
                contract: COMMERCIAL_CONTRACT,
                claims: merchantClaimDescriptors(),
            },
        });
    } catch (error) {
        next(error);
    }
}

/**
 * GET /api/commercial/claims?surface=<id>&locale=<en|bn>
 * Server-evaluates every claim registered to the surface for this shop. This
 * is the request path where shadow would-block decisions are counted/logged.
 */
async function getClaims(req, res, next) {
    try {
        const shopId = requireShopId(req);
        const surface = req.query?.surface;
        if (typeof surface !== 'string' || !SURFACES.includes(surface)) {
            throw new AppError('Unknown claim surface', 400, 'UNKNOWN_CLAIM_SURFACE');
        }
        const locale = normalizeLocale(req.query?.locale);

        const claimIds = CLAIM_IDS.filter((id) => {
            const entry = CLAIM_REGISTRY[id];
            return entry && entry.surfaces.includes(surface);
        });

        const decisions = [];
        for (const claimId of claimIds) {
            // Sequential on purpose: per-shop evidence reads share a DB pool and
            // the shadow log stays ordered with the evaluation.
            // eslint-disable-next-line no-await-in-loop
            decisions.push(await claimGate.evaluateClaim(claimId, { surface, locale, shopId }));
        }

        res.json({
            success: true,
            data: {
                surface,
                locale,
                contractVersion: COMMERCIAL_CONTRACT_VERSION,
                registryHash,
                decisions,
            },
        });
    } catch (error) {
        next(error);
    }
}

/**
 * GET /api/commercial/billing-lines?invoiceId=<uuid>
 * Tenant-scoped billing lines. A foreign invoice is a 403, never an empty read.
 */
async function getBillingLines(req, res, next) {
    try {
        const shopId = requireShopId(req);
        const invoiceId = req.query?.invoiceId;
        const lines = await commercialQuery.listBillingLines({ shopId, invoiceId });
        res.json({
            success: true,
            data: {
                invoiceId,
                contractVersion: COMMERCIAL_CONTRACT_VERSION,
                lines,
            },
        });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    merchantClaimDescriptors,
    getContract,
    getClaims,
    getBillingLines,
};