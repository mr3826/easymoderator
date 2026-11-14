'use strict';

/**
 * Public commercial contract (ADR-0011). Unauthenticated by design: the
 * marketing origin cannot hold a merchant session, and the price/term authority
 * must have exactly one server source.
 *
 * snake_case is the public-catalog convention (see .easymod/standards/
 * api-contract-rules.md); the nested `on_overdue` object reuses the frozen
 * camelCase shape verbatim.
 */

const express = require('express');
const { publicContractPayload } = require('../commercial/commercial.contract');
const {
    CLAIM_IDS,
    CLAIM_REGISTRY,
    registryHash,
} = require('../commercial/claim.registry');

const router = express.Router();

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

router.get('/', (_req, res) => {
    res.json({
        success: true,
        data: {
            ...publicContractPayload(),
            registry_hash: registryHash,
            claims: publicClaimDescriptors(),
        },
    });
});

module.exports = router;