'use strict';

const fs = require('node:fs');

const [auditPath, sourceMapPath] = process.argv.slice(2);

if (!auditPath || !sourceMapPath) {
    console.error('Usage: node scripts/mobile-audit-policy.js <audit-json> <android-source-map>');
    process.exit(2);
}

const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));

// Fail closed when npm audit itself failed: an error payload carries only
// message/error, and iterating zero advisories must never read as a pass.
if (!audit.metadata || !audit.vulnerabilities) {
    console.error('::error::npm audit output has no metadata/vulnerabilities — the audit did not complete; refusing to pass.');
    process.exit(1);
}

// Reviewed 2026-11-15: the shell-quote (critical), node-forge, decode-uri-component,
// zod, glob and minimatch advisories were remediated with real version fixes in
// package.json (overrides + expo ~57.0.33, whose @expo/cli dropped zod entirely).
// The former braces/sprintf-js entries were stale (those advisories no longer
// appear in npm audit) and are removed. deepmerge is the only remaining advisory:
// no patched release exists (4.3.1 is latest), it is dev-only (jest-config), and
// npm's proposed remediation is a jest downgrade to 25.1.0, which is rejected.
// The bundle check below still proves it is absent from the shipped Android JS
// bundle.
// Note: query-string stays at 7.1.3 (CJS) because 8/9 are default-export-only
// ESM and break expo-router 57's __importStar usage. decode-uri-component 0.5.x
// is ESM-only, so query-string 7's parse() — reached only for URLs carrying a
// query string, which the app's deep links do not — retains a pre-existing
// interop limitation to resolve at the SDK 58 upgrade.
const allowedBuildAdvisories = new Map([
    [1243505, {
        packageName: 'deepmerge',
        url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4',
        remediations: [{ name: 'jest', version: '25.1.0', isSemVerMajor: true }],
    }],
]);

const advisories = new Map();
for (const vulnerability of Object.values(audit.vulnerabilities || {})) {
    for (const via of vulnerability.via || []) {
        if (typeof via !== 'object' || via.source === undefined) continue;
        advisories.set(via.source, via);
    }
}

const failures = [];
// Metro emits absolute paths; on Windows those use backslashes, so normalize
// before matching or the bundle-absence proof would silently match nothing.
const bundleSources = (sourceMap.sources || []).map((source) => String(source).replace(/\\/g, '/'));
if (bundleSources.length === 0) {
    failures.push('the Android source map has no sources — bundle absence cannot be proven');
}

if ((audit.metadata?.vulnerabilities?.critical || 0) > 0) {
    failures.push('critical vulnerabilities are present');
}

for (const advisory of advisories.values()) {
    const allowed = allowedBuildAdvisories.get(advisory.source);
    if (!allowed) {
        failures.push(`unreviewed advisory ${advisory.source}: ${advisory.title || 'unknown'}`);
        continue;
    }

    if (advisory.name !== allowed.packageName || advisory.url !== allowed.url) {
        failures.push(`advisory ${advisory.source} changed identity or URL`);
    }

    const fix = audit.vulnerabilities?.[allowed.packageName]?.fixAvailable;
    const remediationReviewed = allowed.remediations.some((remediation) => fix
        && fix.name === remediation.name
        && fix.version === remediation.version
        && fix.isSemVerMajor === remediation.isSemVerMajor);
    if (!remediationReviewed) {
        failures.push(`advisory ${advisory.source} now has a remediation requiring fresh review`);
    }

    const bundled = bundleSources.some((source) => source.includes(`/node_modules/${allowed.packageName}/`));
    if (bundled) {
        failures.push(`${allowed.packageName} is present in the Android application bundle`);
    }

    console.log(`Accepted build-only advisory ${advisory.source} (${allowed.packageName}); not present in Android bundle.`);
}

if (advisories.size === 0 && (audit.metadata?.vulnerabilities?.high || 0) > 0) {
    failures.push('high vulnerabilities exist but no advisory records were available for review');
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
}

console.log('Mobile dependency audit policy passed: all high findings are reviewed, build-only, and absent from the shipped bundle.');
