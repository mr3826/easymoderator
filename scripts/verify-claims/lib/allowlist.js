'use strict';

/**
 * Explicit, reasoned allowlists. ADR-0002 discipline: each entry names what it
 * permits and why; none is a bare "everything" wildcard. Seeds are not blanket
 * allowlisted — only the Growth OS staff seed paths are exempt from the
 * `name.growth` token, while retired price copy in any seed stays flagged.
 */

const normalize = (file) => String(file).split('\\').join('/');

const CONTRACT_MODULE = 'EasyMod-backend/src/modules/commercial/commercial.contract.js';
const SCANNER_ROOT = 'scripts/verify-claims/';
const SCANNER_FIXTURES = 'scripts/verify-claims/__tests__/fixtures/';

const isTestPath = (p) => (
    /(^|\/)__tests__\//.test(p)
    || /(^|\/)tests\//.test(p)
    || /(^|\/)test\//.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
);

/**
 * Immutable applied schema history. Migrations are the recorded terms that were
 * actually applied, including retired plan names and prices; editing one would
 * rewrite history and break already-migrated databases. They are never
 * rendered to a merchant, so the forbidden-token scan exempts the whole file.
 * `archive/` at the repository root holds the same kind of retired record.
 *
 * Explicit and reasoned (ADR-0002): no bare wildcard, and this does NOT cover
 * `modules/` or merchant-facing copy.
 */
const HISTORICAL_RECORD_PATHS = Object.freeze([
    {
        pattern: /^EasyMod-backend\/src\/database\/migrations\//,
        reason: 'historical-migration: immutable applied schema history; never edited or rendered',
    },
    {
        pattern: /^archive\//,
        reason: 'historical-archive: retired records preserved for audit; never rendered',
    },
]);

/**
 * Per-token PATH exclusions. Unlike a file-level allowlist these suppress only
 * the named token on the named path, so the rest of the token set still scans
 * those files (a retired price in the Growth app is still flagged).
 *
 * The only entry is `name.growth`, whose `\bGrowth\b` source also matches the
 * internal "Growth OS" product/role identifiers. Growth OS is an internal
 * console (claim-registry mode `off`), not the retired GROWTH plan. Merchant
 * "Growth" plan copy in the frontend/backend is deliberately NOT excluded.
 */
const TOKEN_PATH_EXCLUSIONS = Object.freeze([
    {
        tokenId: 'name.growth',
        pattern: /^EasyMod-growth\//,
        reason: 'internal Growth OS app: product name, not the retired GROWTH plan',
    },
    {
        tokenId: 'name.growth',
        pattern: /(^|\/)growth-os\//,
        reason: 'internal Growth OS namespace (modules/growth-os, docs, tests)',
    },
    {
        tokenId: 'name.growth',
        pattern: /^scripts\/run-growth-[^/]*\.js$/,
        reason: 'internal Growth OS e2e/image runner scripts',
    },
    {
        tokenId: 'name.growth',
        pattern: /^EasyMod-backend\/src\/scripts\/seed-growth[^/]*\.js$/,
        reason: 'Growth OS staff seed script (internal identities, not plan copy)',
    },
    {
        tokenId: 'name.growth',
        pattern: /^EasyMod-backend\/src\/scripts\/seed-initial-growth-admin\.js$/,
        reason: 'Growth OS staff seed script (internal identities, not plan copy)',
    },
]);

/**
 * Per-token LINE exclusions for internal product/component identifiers that
 * contain the word "Growth" with a word boundary (e.g. "Growth Users",
 * `GrowthShell`, `GrowthUsersPage`). These are role/component names, never a
 * merchant-facing plan claim.
 */
const TOKEN_LINE_EXCLUSIONS = Object.freeze([
    {
        tokenId: 'name.growth',
        pattern: /\bGrowth(?:[\s_-]*Users?|Shell|UsersPage)\b/i,
        reason: 'internal Growth OS component/role identifier',
    },
    {
        tokenId: 'name.growth',
        pattern: /\bGrowth\s+(?:frontend|health|suites?)\b/i,
        reason: 'internal Growth OS deploy/health/test-suite reference in ops scripts',
    },
]);

/**
 * Reason a file is exempt from the forbidden-token scan, or null.
 *
 * Exemptions, each explicit and reasoned (ADR-0002):
 *   1. the frozen contract module itself (it defines the tokens);
 *   2. the archived legacy plan catalog (codes/numbers only, never rendered);
 *   3. immutable applied migrations and root `archive/` (historical record);
 *   4. test files (fixtures assert retired copy is caught);
 *   5. this scanner's own fixtures (deliberate retired tokens);
 *   6. historical Markdown records OUTSIDE the four product modules — handled
 *      by header in token-scan.js, never by path alone.
 *
 * NOTE: Growth OS product paths are NOT exempt here. They use the narrower,
 * token-specific `TOKEN_PATH_EXCLUSIONS` above so only `name.growth` is
 * suppressed and any other retired copy there is still caught.
 */
function tokenScanAllowReason(file) {
    const p = normalize(file);
    if (p === CONTRACT_MODULE) return 'contract-module: the frozen definition of the retired tokens';
    if (/(^|\/)subscription\.legacy-plans\.js$/.test(p)) {
        return 'legacy-plan-catalog: archived CODES and numeric terms only, for historical invoices/top-ups; never rendered';
    }
    const historical = HISTORICAL_RECORD_PATHS.find((entry) => entry.pattern.test(p));
    if (historical) return historical.reason;
    if (p.startsWith(SCANNER_FIXTURES)) return 'scanner-fixture: deliberate retired copy for self-tests';
    if (p.startsWith(SCANNER_ROOT)) {
        return 'scanner-implementation: names the retired tokens and internal identifiers it detects (self-reference)';
    }
    if (isTestPath(p)) return 'test-file: assertions and fixtures are not rendered';
    return null;
}

/** RegExp path exclusions that apply only to `tokenId`. */
function tokenPathExclusions(tokenId) {
    return TOKEN_PATH_EXCLUSIONS
        .filter((entry) => entry.tokenId === tokenId)
        .map((entry) => entry.pattern);
}

/** RegExp line exclusions that apply only to `tokenId`. */
function tokenLineExclusions(tokenId) {
    return TOKEN_LINE_EXCLUSIONS
        .filter((entry) => entry.tokenId === tokenId)
        .map((entry) => entry.pattern);
}

/**
 * Compatibility paths for the RETIRED-IDENTIFIER rule.
 *
 * The retired SHURU / GROWTH / PARTNER plan codes are data-plane identifiers in
 * the legacy subscription subsystem. Until Phase 3 removes that subsystem these
 * readers must keep translating historical rows, so the rule allows those paths
 * — and fails any NEW path that reintroduces an uppercase retired plan code.
 * Each entry is explicit and reasoned (ADR-0002).
 */
const RETIRED_CODE_COMPAT = Object.freeze([
    { pattern: /^scripts\/verify-claims\//, reason: 'scanner implementation defines the retired codes it detects (self-reference)' },
    { pattern: /^EasyMod-backend\/src\/modules\/subscription\//, reason: 'legacy subscription subsystem (retired model data plane)' },
    { pattern: /^EasyMod-backend\/src\/modules\/growth-os\//, reason: 'growth-os reader of historical plan rows' },
    { pattern: /^EasyMod-growth\//, reason: 'Growth OS app reads historical plan rows' },
    { pattern: /(^|\/)migrations\//, reason: 'historical migration data; never rewritten' },
    { pattern: /subscription\.plans\.js$/, reason: 'legacy plan catalog (compat export)' },
    { pattern: /subscription\.legacy-plans\.js$/, reason: 'legacy plan catalog (compat export)' },
    { pattern: /^EasyMod-backend\/src\/database\/seed\.js$/, reason: 'dev seed creates a legacy subscription row' },
    { pattern: /^EasyMod-backend\/src\/scripts\/seed-[^/]+\.js$/, reason: 'seed script builds legacy fixtures' },
    { pattern: /^EasyMod-backend\/scripts\/[^/]*seed[^/]*\.js$/, reason: 'seed/ops script builds legacy fixtures' },
    { pattern: /^EasyMod-backend\/scripts\/[^/]+\/[^/]*seed[^/]*\.js$/, reason: 'seed/ops script builds legacy fixtures' },
    { pattern: /^EasyMod-backend\/src\/scripts\/approve-partner\.js$/, reason: 'ops CLI flips a historical PARTNER row' },
    { pattern: /^EasyMod-backend\/scripts\/pilotplus-seed-lab\.js$/, reason: 'seed lab builds legacy fixtures' },
    { pattern: /^EasyMod-backend\/scripts\/ai-cost\/ai-cost-report\.js$/, reason: 'cost report labels historical plans' },
    { pattern: /^EasyMod-backend\/src\/jobs\/invoice-generator\.js$/, reason: 'legacy invoice reconciler reads retired plan codes' },
    { pattern: /^EasyMod-backend\/src\/jobs\/failed-payment-reconciler\.js$/, reason: 'legacy payment reconciler reads retired plan codes' },
    { pattern: /^EasyMod-backend\/src\/modules\/admin\/admin\.service\.js$/, reason: 'admin stats count historical plan rows' },
    { pattern: /^EasyMod-backend\/src\/modules\/order\/return\.service\.js$/, reason: 'legacy partner detection on historical rows' },
    { pattern: /^EasyMod-backend\/src\/modules\/shop\/shop\.controller\.js$/, reason: 'legacy plan-code normalisation for historical rows' },
    { pattern: /^EasyMod-backend\/src\/modules\/public\/subscription-plans\.routes\.js$/, reason: 'legacy public catalog route (retired, awaiting removal)' },
    { pattern: /^EasyMod-backend\/openapi\.yaml$/, reason: 'API documentation of historical plan codes' },
    { pattern: /^EasyMod-backend\/README\.md$/, reason: 'backend documentation of historical plan codes' },
    { pattern: /^EasyMod-frontend\/src\/api\/domains\/publicSubscription\.ts$/, reason: 'legacy public subscription API adapter' },
    { pattern: /^EasyMod-frontend\/src\/api\/types\/subscription\.ts$/, reason: 'legacy subscription type union' },
    { pattern: /^EasyMod-frontend\/src\/app\/components\/LandingPage\.tsx$/, reason: 'legacy landing funnel (superseded in Phase 2)' },
    { pattern: /^EasyMod-frontend\/src\/app\/components\/LandingPageV5Sections\.tsx$/, reason: 'legacy landing funnel (superseded in Phase 2)' },
    { pattern: /^EasyMod-frontend\/src\/app\/components\/Pricing\.tsx$/, reason: 'legacy pricing page (superseded in Phase 2)' },
    { pattern: /^EasyMod-frontend\/src\/app\/components\/Subscription\.tsx$/, reason: 'legacy subscription page (superseded in Phase 2)' },
    { pattern: /^EasyMod-frontend\/src\/app\/lib\/subscriptionPlans\.ts$/, reason: 'legacy plan catalog adapter' },
    { pattern: /^EasyMod-frontend\/src\/i18n\//, reason: 'locale copy for the legacy funnel (superseded in Phase 2)' },
]);

function retiredCodeAllowReason(file) {
    const p = normalize(file);
    if (p === CONTRACT_MODULE) return 'contract-module: documents the uppercase codes it retires';
    if (isTestPath(p)) return 'test-file: assertions are not rendered';
    for (const entry of RETIRED_CODE_COMPAT) {
        if (entry.pattern.test(p)) return entry.reason;
    }
    return null;
}

module.exports = {
    CONTRACT_MODULE,
    SCANNER_ROOT,
    SCANNER_FIXTURES,
    HISTORICAL_RECORD_PATHS,
    TOKEN_PATH_EXCLUSIONS,
    TOKEN_LINE_EXCLUSIONS,
    isTestPath,
    tokenScanAllowReason,
    tokenPathExclusions,
    tokenLineExclusions,
    RETIRED_CODE_COMPAT,
    retiredCodeAllowReason,
};