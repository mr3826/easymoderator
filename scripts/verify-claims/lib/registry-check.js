'use strict';

/**
 * Check (c) — claim registry completeness.
 *
 * Every rendered claim must resolve to a CLAIM_REGISTRY id, and a claim may only
 * be used on a surface its registry entry declares. The frontend, Growth OS and
 * mobile apps use `<Claim id="...">`; backend uses `renderClaim('...')` (optionally with a
 * surface argument).
 *
 * Locale keys (`claims.<id>.en|bn` and fallbacks) are reported as warnings
 * until Phase 2 fills them. Under `--strict` a warning is a failure. Registry
 * id resolution is ALWAYS a hard failure.
 */

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, readText, normalize } = require('./repo');

const REGISTRY_REL = 'EasyMod-backend/src/modules/commercial/claim.registry.js';

function loadRegistry(scanRoot) {
    const fixturePath = path.resolve(scanRoot, REGISTRY_REL);
    if (path.resolve(scanRoot) !== path.resolve(REPO_ROOT) && fs.existsSync(fixturePath)) {
        const mod = require(fixturePath);
        return {
            registry: mod.CLAIM_REGISTRY || {},
            source: normalize(path.relative(scanRoot, fixturePath)),
        };
    }
    const mod = require('../../../EasyMod-backend/src/modules/commercial/claim.registry');
    return { registry: mod.CLAIM_REGISTRY, source: 'frozen claim.registry.js' };
}

const ATTR = (attrs, name) => {
    const re = new RegExp(
        `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["']([^"']+)["']\\s*\\})`,
    );
    const match = attrs.match(re);
    return match ? (match[1] ?? match[2] ?? match[3]) : null;
};

function collectClaimTags(text) {
    const usages = [];
    const re = /<Claim\b([^>]*)\/?>/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const id = ATTR(match[1], 'id');
        if (!id) continue;
        usages.push({
            id,
            surface: ATTR(match[1], 'surface') || ATTR(match[1], 'surfaceId'),
            literal: match[0].slice(0, 160),
        });
    }
    return usages;
}

function collectRenderCalls(text) {
    const usages = [];
    const named = /renderClaim\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/g;
    let match;
    while ((match = named.exec(text)) !== null) {
        usages.push({ id: match[1], surface: match[2] || null, literal: match[0].slice(0, 160) });
    }
    const object = /renderClaim\s*\(\s*\{([^}]*)\}/g;
    while ((match = object.exec(text)) !== null) {
        const id = ATTR(match[1], 'id');
        if (!id) continue;
        usages.push({
            id,
            surface: ATTR(match[1], 'surface') || ATTR(match[1], 'surfaceId'),
            literal: match[0].slice(0, 160),
        });
    }
    return usages;
}

function flattenKeys(value, prefix, out) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
        const joined = prefix ? `${prefix}.${key}` : key;
        out.add(joined);
        flattenKeys(child, joined, out);
    }
}

function localeKeySet(file) {
    const text = fs.readFileSync(file, 'utf8');
    const keys = new Set();
    flattenKeys(JSON.parse(text), '', keys);
    return keys;
}

const LOCALE_FILES = Object.freeze([
    'EasyMod-frontend/src/i18n/locales/en.json',
    'EasyMod-frontend/src/i18n/locales/bn.json',
    'EasyMod-mobile/src/i18n/locales/en.json',
    'EasyMod-mobile/src/i18n/locales/bn.json',
]);

function checkRegistry({ root, files }) {
    const { registry, source } = loadRegistry(root);
    const violations = [];
    const warnings = [];
    const usages = [];

    for (const file of files) {
        const p = normalize(file);
        const isFrontendish = p.startsWith('EasyMod-frontend/')
            || p.startsWith('EasyMod-growth/')
            || p.startsWith('EasyMod-mobile/');
        const isBackend = p.startsWith('EasyMod-backend/');
        if (!isFrontendish && !isBackend) continue;
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p)) continue;
        const text = readText(root, file);
        if (text === undefined || text === null) continue;

        const found = isFrontendish ? collectClaimTags(text) : collectRenderCalls(text);
        for (const usage of found) {
            usages.push({ file, ...usage });
            const entry = registry[usage.id];
            if (!entry) {
                violations.push({
                    file,
                    id: usage.id,
                    reason: 'unregistered claim id (not in CLAIM_REGISTRY)',
                });
                continue;
            }
            if (usage.surface && !(Array.isArray(entry.surfaces) && entry.surfaces.includes(usage.surface))) {
                violations.push({
                    file,
                    id: usage.id,
                    reason: `surface "${usage.surface}" is not declared on the entry (allowed: ${(entry.surfaces || []).join(', ')})`,
                });
            }
        }
    }

    // Locale keys. Missing keys are Phase-2 work, not a Phase-1 hard failure.
    const localeSets = [];
    for (const rel of LOCALE_FILES) {
        const abs = path.resolve(root, rel);
        if (!fs.existsSync(abs)) {
            warnings.push({ file: rel, reason: 'locale file absent (Phase 2 fills claims.* keys)' });
            continue;
        }
        try {
            localeSets.push({ file: rel, keys: localeKeySet(abs) });
        } catch (error) {
            violations.push({ file: rel, reason: `locale file is not valid JSON: ${error.message}` });
        }
    }

    const requiredKeys = [];
    for (const entry of Object.values(registry)) {
        if (!entry.i18nKey) continue;
        requiredKeys.push(entry.i18nKey.en, entry.i18nKey.bn);
        if (entry.fallbackI18nKey) requiredKeys.push(entry.fallbackI18nKey.en, entry.fallbackI18nKey.bn);
    }
    for (const locale of localeSets) {
        for (const key of requiredKeys) {
            if (!locale.keys.has(key)) {
                warnings.push({ file: locale.file, reason: `missing i18n key "${key}" (Phase 2 worklist)` });
            }
        }
    }

    return {
        violations,
        warnings,
        usages,
        registrySource: source,
        registrySize: Object.keys(registry).length,
        localeSets: localeSets.map((l) => l.file),
    };
}

module.exports = { checkRegistry, loadRegistry, collectClaimTags, collectRenderCalls, LOCALE_FILES };