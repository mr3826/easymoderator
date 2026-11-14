'use strict';

/**
 * Explicit, reasoned allowlists. ADR-0002 discipline: each entry names what it
 * permits and why; none is a bare "everything" wildcard. Seeds are NOT
 * allowlisted for the token scan — Phase 2 must rewrite their price copy.
 */

const normalize = (file) => String(file).split('\\').join('/');

const CONTRACT_MODULE = 'EasyMod-backend/src/modules/commercial/commercial.contract.js';
const SCANNER_FIXTURES = 'scripts/verify-claims/__tests__/fixtures/';

const isTestPath = (p) => (
    /(^|\/)__tests__\//.test(p)
    || /(^|\/)tests\//.test(p)
    || /(^|\/)test\//.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
);

/**
 * Reason a file is exempt from the forbidden-token scan, or null.
 *
 * Only four exemptions exist:
 *   1. the frozen contract module itself (it defines the tokens);
 *   2. test files (fixtures assert retired copy is caught);
 *   3. this scanner's own fixtures (deliberate retired tokens);
 *   4. historical Markdown records OUTSIDE the four product modules — handled
 *      by header in token-scan.js, never by path alone.
 */
function tokenScanAllowReason(file) {
    const p = normalize(file);
    if (p === CONTRACT_MODULE) return 'contract-module: the frozen definition of the retired tokens';
    if (/(^|\/)subscription\.legacy-plans\.js$/.test(p)) {
        return 'legacy-plan-catalog: archived CODES and numeric terms only, for historical invoices/top-ups; never rendered';
    }
    if (p.startsWith(SCANNER_FIXTURES)) return 'scanner-fixture: deliberate retired copy for self-tests';
    if (isTestPath(p)) return 'test-file: assertions and fixtures are not rendered';
    return null;
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
    SCANNER_FIXTURES,
    isTestPath,
    tokenScanAllowReason,
    RETIRED_CODE_COMPAT,
    retiredCodeAllowReason,
};