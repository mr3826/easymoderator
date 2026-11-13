'use strict';

const fs = require('node:fs');

const [auditPath, sourceMapPath] = process.argv.slice(2);

if (!auditPath || !sourceMapPath) {
    console.error('Usage: node scripts/mobile-audit-policy.js <audit-json> <android-source-map>');
    process.exit(2);
}

const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
const allowedBuildAdvisories = new Map([
    [1240992, {
        packageName: 'braces',
        url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    }],
    [1240912, {
        packageName: 'node-forge',
        url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    }],
    [1241202, {
        packageName: 'sprintf-js',
        url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c',
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
const bundleSources = sourceMap.sources || [];

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
