'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkLanding } = require('../lib/landing-check');

const LANDING_REL = 'EasyMod-frontend/src/app/components/landing/LandingV7.tsx';
const PUB_EN = 'EasyMod-frontend/src/i18n/locales/public/en.json';
const PUB_BN = 'EasyMod-frontend/src/i18n/locales/public/bn.json';

function makeRoot(landingSource) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-check-'));
    const landing = path.join(root, LANDING_REL);
    fs.mkdirSync(path.dirname(landing), { recursive: true });
    fs.writeFileSync(landing, landingSource, 'utf8');
    for (const rel of [PUB_EN, PUB_BN]) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify({ landingV7: {}, claims: {} }), 'utf8');
    }
    return root;
}

const run = (source) => checkLanding({ root: makeRoot(source), files: [LANDING_REL] });

test('clean contract-derived landing passes', () => {
    const report = run('<Claim id="price.unit" surface="landing" />\n<p>{money}</p>');
    assert.deepEqual(report.violations, []);
    assert.equal(report.referencedClaims.includes('price.unit'), true);
});

test('B11 — a hardcoded price fails the check', () => {
    const report = run('<p>৳10 per order</p>');
    assert.ok(report.violations.some((v) => /literal price/.test(v.reason)));
});

test('a third-party brand token fails the check', () => {
    const report = run('<p>Book through Pathao</p>');
    assert.ok(report.violations.some((v) => v.id === 'brand.pathao'));
});

test('an unregistered literal <Claim id> fails the check', () => {
    const report = run('<Claim id="nope.nope" surface="landing" />');
    assert.ok(report.violations.some((v) => /unregistered <Claim/.test(v.reason)));
});

test('an unregistered claim-id constant used dynamically fails the check', () => {
    const report = run('const x = { id: "ghost.claim", titleKey: "t" };\n<Claim id={x.id} surface="landing" />');
    assert.ok(report.violations.some((v) => /unregistered claim id constant/.test(v.reason)));
});

test('a FORBIDDEN_TOKEN (retired subscription copy) fails the check', () => {
    const report = run('<p>৳999 / month</p>');
    assert.ok(report.violations.some((v) => v.tokenId));
});