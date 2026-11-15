'use strict';

/**
 * Self-tests for check (h) — static apex landing contract parity (ADR-0014).
 * Fixture trees only: no DB, no network, no git.
 *
 * Run: node --test scripts/verify-claims/__tests__/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkStaticLanding, STATIC_LANDING, expectedPriceStrings } = require('../lib/static-landing-check');

function makeRoot(pageContent) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-landing-check-'));
    if (pageContent !== null) {
        const abs = path.join(root, STATIC_LANDING);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, pageContent, 'utf8');
    }
    return root;
}

const run = (content) => {
    const root = makeRoot(content);
    try {
        return checkStaticLanding({ root });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
};

test('a page carrying the contract-derived prices passes', () => {
    const { unitBn, zeroBn } = expectedPriceStrings();
    const report = run(`<h1>ডেলিভারি হলে ${unitBn}</h1><p>না হলে ${zeroBn}</p>`);
    assert.deepEqual(report.violations, []);
    assert.equal(report.scannedFiles, 1);
});

test('a missing static landing fails the check', () => {
    const report = run(null);
    assert.equal(report.scannedFiles, 0);
    assert.ok(report.violations.some((v) => /missing or unreadable/.test(v.reason)));
});

test('a page with a stale unit price fails until deliberately updated', () => {
    const { zeroBn } = expectedPriceStrings();
    const report = run(`<h1>ডেলিভারি হলে ৳৯৯</h1><p>না হলে ${zeroBn}</p>`);
    assert.ok(report.violations.some((v) => /contract unit price/.test(v.reason)));
});

test('a page without the zero-rated mark fails', () => {
    const { unitBn } = expectedPriceStrings();
    const report = run(`<h1>ডেলিভারি হলে ${unitBn}</h1>`);
    assert.ok(report.violations.some((v) => /zero-rated mark/.test(v.reason)));
});

test('expected strings are derived from the frozen contract, not hardcoded', () => {
    const { COMMERCIAL_CONTRACT, toBengaliNumerals } = require('../../../EasyMod-backend/src/modules/commercial/commercial.contract');
    const { unitBn, zeroBn } = expectedPriceStrings();
    assert.equal(unitBn, `৳${toBengaliNumerals(COMMERCIAL_CONTRACT.unitPriceMinor / 100)}`);
    assert.equal(zeroBn, `৳${toBengaliNumerals(0)}`);
});
