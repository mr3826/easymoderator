'use strict';

/**
 * Self-tests for the claims scanner. Every case builds a throwaway fixture tree
 * (no DB, no network, no git) and asserts the CLI's exit code, so the failure
 * modes the Phase-1 gate relies on are themselves tested.
 *
 * Run: node --test scripts/verify-claims/__tests__/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INDEX = path.resolve(__dirname, '..', 'index.js');

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-claims-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return root;
}

function run(root, only) {
    return spawnSync(
        process.execPath,
        [INDEX, '--scan-root', root, '--only', only],
        { encoding: 'utf8' },
    );
}

function withTree(files, fn) {
    const root = makeTree(files);
    try {
        return fn(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('(i) a deliberate forbidden token outside the allowlist fails with exit 1', () => {
    withTree({
        'EasyMod-backend/src/pricing/copy.js': "module.exports = { headline: 'Only ৳999 / month' };\n",
    }, (root) => {
        const result = run(root, 'tokens');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /FAIL \(a\) forbidden-token scan/);
        assert.match(result.stdout, /price\.bdt999/);
        assert.match(result.stdout, /EasyMod-backend\/src\/pricing\/copy\.js:1/);
    });
});

test('(ii) an unregistered claim id fails with exit 1', () => {
    withTree({
        'EasyMod-frontend/src/App.tsx': 'export const A = () => <Claim id="billing.not_registered" surface="pricing" />;\n',
    }, (root) => {
        const result = run(root, 'registry');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /unregistered claim id/);
        assert.match(result.stdout, /billing\.not_registered/);
    });
});

test('(iii) an unresolvable evidence flag fails with exit 1', () => {
    const registry = [
        "'use strict';",
        'module.exports = {',
        '  CLAIM_REGISTRY: {',
        "    'broken.claim': {",
        "      id: 'broken.claim',",
        "      surfaces: ['pricing'],",
        "      requiredEvidence: ['does.not.exist'],",
        '    },',
        '  },',
        '};',
        '',
    ].join('\n');
    withTree({
        'EasyMod-backend/src/modules/commercial/claim.registry.js': registry,
    }, (root) => {
        const result = run(root, 'evidence');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /does\.not\.exist/);
        assert.match(result.stdout, /no EVIDENCE_AUTHORITIES entry/);
    });
});

test('(iv) a drifted snapshot fails with exit 1', () => {
    withTree({
        'EasyMod-backend/src/modules/commercial/__snapshots__/commercial.snapshot.json': `${JSON.stringify({
            contractVersion: '0.0.0',
            contractHash: 'sha256:deadbeef',
            registryHash: 'sha256:deadbeef',
            forbiddenTokenIds: [],
            publicContract: {},
        }, null, 2)}\n`,
    }, (root) => {
        const result = run(root, 'snapshot');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /contractVersion drift/);
        assert.match(result.stdout, /publicContract drift/);
    });
});

test('(v) Growth OS product names and GROWTH_USER roles are not flagged', () => {
    withTree({
        'EasyMod-backend/src/internal/roles.js': [
            "// Growth OS dashboard roles",
            "const role = 'GROWTH_USER';",
            "const env = 'GROWTH_OS_ROOT';",
            "const route = 'growth-os/workspace';",
            '',
        ].join('\n'),
    }, (root) => {
        const result = run(root, 'tokens');
        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /PASS \(a\) forbidden-token scan/);
    });
});

test('(vi) the new ৳10 / ৳১০ price is not flagged', () => {
    withTree({
        'EasyMod-frontend/src/shared/pricing.ts': [
            "export const EN = '৳10.00 per delivered order';",
            "export const BN = '৳১০.০০ প্রতি ডেলিভারি করা অর্ডার';",
            '',
        ].join('\n'),
    }, (root) => {
        const result = run(root, 'tokens');
        assert.equal(result.status, 0, result.stdout);
    });
});

test('(vii) retired ৳999 / ৳১৫ / ৳১২ prices are flagged', () => {
    withTree({
        'EasyMod-frontend/src/shared/legacy-pricing.ts': [
            "export const A = '৳999 / month';",
            "export const B = '৳১৫ per order';",
            "export const C = '৳১২ per order';",
            '',
        ].join('\n'),
    }, (root) => {
        const result = run(root, 'tokens');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /price\.bdt999/);
        assert.match(result.stdout, /band\.retired_rate_15/);
        assert.match(result.stdout, /band\.retired_rate_12/);
    });
});

test('(b) an uppercase retired plan code in a new path fails', () => {
    withTree({
        'EasyMod-backend/src/modules/commercial/billing.js': "const code = 'GROWTH';\n",
    }, (root) => {
        const result = run(root, 'retired');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /GROWTH \(retired plan code\)/);
    });
});

test('(b) an uppercase retired plan code in a compatibility path is allowed', () => {
    withTree({
        'EasyMod-backend/src/modules/subscription/subscription.service.js': "const code = 'SHURU';\n",
    }, (root) => {
        const result = run(root, 'retired');
        assert.equal(result.status, 0, result.stdout);
    });
});

test('(c) a claim used on a surface its entry does not declare fails', () => {
    withTree({
        'EasyMod-frontend/src/App.tsx': 'export const A = () => <Claim id="ai.reply_shadow_meter" surface="pricing" />;\n',
    }, (root) => {
        const result = run(root, 'registry');
        assert.equal(result.status, 1);
        assert.match(result.stdout, /is not declared on the entry/);
    });
});

test('build:collateral renders the frozen terms', () => {
    const { renderOnePager } = require('../../build-collateral');
    const text = renderOnePager();
    assert.match(text, /৳10\.00 per provider-confirmed delivered order/);
    assert.match(text, /৳১০\.০০/);
    assert.match(text, /RETURNED, CANCELLED, DRAFT, CONFIRMED, BOOKED, IN_TRANSIT, FAILED/);
    assert.match(text, /Monthly postpaid\. Invoice due within 7 days\./);
    assert.match(text, /Live-verified for booking: 0 of 3 providers\./);
    assert.match(text, /contractVersion|v1\.0\.0/);
    assert.match(text, /registry `sha256:[0-9a-f]{64}`/);
});