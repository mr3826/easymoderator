'use strict';

/**
 * Check (g) — landing contract-derivation.
 *
 * The merchant landing page is a contract-derived surface. This check fails the
 * build when the LIVE landing source or the copy it renders contains:
 *   (i)   a literal price (৳/BDT + number, or N/month),
 *   (ii)  a retired FORBIDDEN_TOKEN,
 *   (iii) an unregistered/undeclared <Claim id>,
 *   (iv)  a third-party brand token from the maintained blocklist.
 *
 * Scan set is the live landing only (LandingPage.tsx + landing/*), not the dead
 * pre-rebuild V5/V6 section files that are no longer rendered, plus the landing
 * copy it actually renders: the landingV7.* subtree and the claims.<id> copy of
 * every claim the landing references, in the public bundles.
 */

const fs = require('fs');
const path = require('path');
const { readText } = require('./repo');
const { compileTokens } = require('./token-scan');
const { BRAND_BLOCKLIST } = require('./landing-blocklist');

const LIVE_LANDING = /^EasyMod-frontend\/src\/app\/components\/(?:LandingPage\.tsx|landing\/(?!__tests__\/).+\.(?:tsx|css))$/;
const PUBLIC_BUNDLES = [
    'EasyMod-frontend/src/i18n/locales/public/en.json',
    'EasyMod-frontend/src/i18n/locales/public/bn.json',
];

const PRICE_PATTERN = /(?:৳|BDT\s*)\s*[0-9০-৯]|\b[0-9০-৯][0-9০-৯,.]*\s*\/\s*(?:month|mo|মাস)/gi;
const CLAIM_TAG = /<Claim\b[^>]*\bid=["']([^"']+)["'][^>]*>/g;
// Claim ids can also be supplied dynamically: `<Claim id={id}/>` where the id
// comes from a `{ id: "order.fromchat" }` constant. Capture those dotted id
// literals too so a mapped-but-unregistered id still fails the build.
const CLAIM_ID_CONST = /\bid:\s*["']([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["']/g;
const SURFACE_ATTR = /surface=["']([^"']+)["']/;

const compileBrands = () => BRAND_BLOCKLIST.map((b) => ({
    id: b.id,
    reason: b.reason,
    regex: new RegExp(b.source, b.flags.includes('g') ? b.flags : `${b.flags}g`),
}));

const snippet = (line) => line.trim().replace(/\s+/g, ' ').slice(0, 160);

const loadRegistry = () => {
    const registry = require('../../../EasyMod-backend/src/modules/commercial/claim.registry');
    return registry.CLAIM_REGISTRY;
};

const readJson = (root, rel) => {
    const text = readText(root, rel);
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
};

const resolveDotted = (obj, dotted) => dotted.split('.').reduce(
    (acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined),
    obj,
);

const collectStrings = (node, out) => {
    if (typeof node === 'string') { out.push(node); return; }
    if (node && typeof node === 'object') Object.values(node).forEach((v) => collectStrings(v, out));
};

function scanTextAgainst(text, file, brands, tokens, violations) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        PRICE_PATTERN.lastIndex = 0;
        const price = PRICE_PATTERN.exec(line);
        if (price) {
            violations.push({ file, line: i + 1, reason: `literal price in landing source: "${price[0]}" (${snippet(line)})` });
        }
        for (const token of tokens) {
            token.regex.lastIndex = 0;
            let match;
            while ((match = token.regex.exec(line)) !== null) {
                violations.push({ file, line: i + 1, tokenId: token.id, match: match[0] });
                if (match.index === token.regex.lastIndex) token.regex.lastIndex += 1;
            }
        }
        for (const b of brands) {
            b.regex.lastIndex = 0;
            let match;
            while ((match = b.regex.exec(line)) !== null) {
                violations.push({ file, line: i + 1, id: b.id, reason: `${b.reason}: "${match[0]}"` });
                if (match.index === b.regex.lastIndex) b.regex.lastIndex += 1;
            }
        }
    }
}

function checkLanding({ root, files }) {
    const violations = [];
    const registry = loadRegistry();
    const brands = compileBrands();
    const tokens = compileTokens();

    const liveFiles = files.filter((file) => LIVE_LANDING.test(file));
    const referencedIds = new Set();

    // 1. Live landing source: prices, tokens, brands, unregistered claims.
    for (const file of liveFiles) {
        const text = readText(root, file);
        if (!text) continue;
        scanTextAgainst(text, file, brands, tokens, violations);
        let m;
        CLAIM_TAG.lastIndex = 0;
        while ((m = CLAIM_TAG.exec(text)) !== null) {
            const id = m[1];
            referencedIds.add(id);
            const entry = registry[id];
            if (!entry) {
                violations.push({ file, id: `claim.${id}`, reason: `unregistered <Claim id="${id}">` });
                continue;
            }
            const surfaceMatch = SURFACE_ATTR.exec(m[0]);
            const surface = surfaceMatch ? surfaceMatch[1] : 'landing';
            if (!entry.surfaces.includes(surface)) {
                violations.push({ file, id: `claim.${id}`, reason: `<Claim id="${id}"> declares surface "${surface}" not in registry` });
            }
        }
        // Dynamic claim-id constants used as `<Claim id={id}/>`.
        let c;
        CLAIM_ID_CONST.lastIndex = 0;
        while ((c = CLAIM_ID_CONST.exec(text)) !== null) {
            const id = c[1];
            referencedIds.add(id);
            if (!registry[id]) {
                violations.push({ file, id: `claim.${id}`, reason: `unregistered claim id constant "${id}"` });
            }
        }
    }

    // 2. Landing copy it renders: landingV7.* + referenced claims.* strings.
    for (const rel of PUBLIC_BUNDLES) {
        const json = readJson(root, rel);
        if (!json) continue;

        const landingStrings = [];
        collectStrings(json.landingV7, landingStrings);
        for (const id of referencedIds) {
            const entry = registry[id];
            if (!entry) continue;
            for (const key of [entry.i18nKey.en, entry.i18nKey.bn,
                entry.fallbackI18nKey && entry.fallbackI18nKey.en,
                entry.fallbackI18nKey && entry.fallbackI18nKey.bn]) {
                if (!key) continue;
                const value = resolveDotted(json, key);
                if (typeof value === 'string') landingStrings.push(value);
            }
        }
        scanTextAgainst(landingStrings.join('\n'), rel, brands, tokens, violations);
    }

    // 3. The scanner must find a live landing to guard; a rename that hides the
    // page from the scan is itself suspicious.
    if (liveFiles.length === 0) {
        violations.push({ file: 'EasyMod-frontend/src/app/components/landing', reason: 'no live landing source matched the scan set' });
    }

    return {
        violations,
        scannedFiles: liveFiles.length,
        referencedClaims: [...referencedIds],
    };
}

module.exports = { checkLanding, LIVE_LANDING, PRICE_PATTERN };