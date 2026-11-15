'use strict';

/**
 * Check (h) — static apex landing contract parity (ADR-0014).
 *
 * The apex landing at easymod.tech "/" is a founder-approved static HTML page
 * (EasyMod-frontend/public/landing-zero.html) served through a Caddy internal
 * rewrite. Because it is static, it cannot fetch the commercial contract at
 * runtime the way LandingV7 does. This check anchors it to the frozen contract
 * at gate time instead: the page must carry the contract-derived Bengali unit
 * price (৳১০ today) and the zero-rated ৳০ mark. If the contract price ever
 * changes, the gate fails until the page is deliberately updated — the
 * ADR-0011 anti-drift intent applied to a static surface.
 *
 * Retired FORBIDDEN_TOKENS are already enforced on this file by check (a):
 * public/ lives under EasyMod-frontend/, inside the token-scan scope.
 */

const { COMMERCIAL_CONTRACT, toBengaliNumerals } = require('../../../EasyMod-backend/src/modules/commercial/commercial.contract');
const { readText } = require('./repo');

const STATIC_LANDING = 'EasyMod-frontend/public/landing-zero.html';

/** Whole-BDT Bengali displays derived from the frozen contract. */
function expectedPriceStrings() {
    const unitBn = `৳${toBengaliNumerals(COMMERCIAL_CONTRACT.unitPriceMinor / 100)}`;
    const zeroBn = `৳${toBengaliNumerals(0)}`;
    return { unitBn, zeroBn };
}

function checkStaticLanding({ root }) {
    const violations = [];
    const expected = expectedPriceStrings();
    const text = readText(root, STATIC_LANDING);
    if (!text) {
        violations.push({
            file: STATIC_LANDING,
            reason: 'static apex landing is missing or unreadable (the Caddy apex rewrite serves this file)',
        });
        return { violations, scannedFiles: 0, expected };
    }
    if (!text.includes(expected.unitBn)) {
        violations.push({
            file: STATIC_LANDING,
            reason: `static landing does not carry the contract unit price "${expected.unitBn}" (unitPriceMinor=${COMMERCIAL_CONTRACT.unitPriceMinor}); update the page deliberately alongside the contract change`,
        });
    }
    if (!text.includes(expected.zeroBn)) {
        violations.push({
            file: STATIC_LANDING,
            reason: `static landing does not carry the zero-rated mark "${expected.zeroBn}"`,
        });
    }
    return { violations, scannedFiles: 1, expected };
}

module.exports = { checkStaticLanding, STATIC_LANDING, expectedPriceStrings };
