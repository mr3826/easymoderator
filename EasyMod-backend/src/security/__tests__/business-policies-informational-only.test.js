'use strict';

/**
 * BUSINESS POLICIES ARE INFORMATIONAL ONLY (A0 contract, hard rule).
 *
 * settings.policies (returns/exchange/refunds/warranty) is merchant-stated
 * text that projects into the knowledge layer (business-info index text +
 * system prompt). It must NEVER be read by order-cancel/refund/exchange/
 * warranty enforcement code — zero automation coupling. This source scan is
 * the drift alarm: if someone wires policies into an enforcement module,
 * this test fails before review does.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../..');

const ENFORCEMENT_FILES = [
    'modules/order/order.service.js',
    'modules/order/order.controller.js',
    'modules/order/order.validator.js',
    'modules/order/order.routes.js',
    'modules/order/order.entity.js',
    'modules/order/order-item.entity.js',
    'modules/order/order-return.entity.js',
    'modules/order/return.service.js',
    'modules/order/order-session.controller.js',
    'modules/order/order-session.routes.js',
    'modules/order-confidence/order-confidence.rules.js',
    'modules/payment/payment-processing.service.js',
    'modules/payment/refund.service.js',
    'jobs/message-worker.js',
];

// The ONLY non-test production surfaces allowed to touch business policies.
const POLICY_AWARE_ALLOWLIST = [
    'modules/shop/shop.service.js',
    'modules/shop/shop.controller.js',
    'modules/shop/shop.routes.js',
    'modules/shop/shop.validator.js',
    'modules/shop/shop-settings.validator.js',
    'modules/knowledge/knowledge.service.js',
    'modules/knowledge/index-source.contract.js',
];

describe('business policies are informational only (source scan)', () => {
    test.each(ENFORCEMENT_FILES)(
        'order/refund enforcement surface %s contains no business-policies reference',
        (rel) => {
            const abs = path.join(SRC, rel);
            if (!fs.existsSync(abs)) return; // module removed — nothing to leak into
            const source = fs.readFileSync(abs, 'utf8');
            expect(source).not.toMatch(/settings\.policies/i);
            expect(source).not.toMatch(/businessPolicies|business-policies/i);
            expect(source).not.toMatch(/\bpolicies\b/i);
        },
    );

    test('no production file outside the knowledge/shop allowlist reads the business-policies writers', () => {
        const offenders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
                    walk(abs);
                    continue;
                }
                if (!entry.name.endsWith('.js')) continue;
                const source = fs.readFileSync(abs, 'utf8');
                if (!/updateShopBusinessPolicies|getShopBusinessPolicies/.test(source)) continue;
                const rel = path.relative(SRC, abs).split(path.sep).join('/');
                if (!POLICY_AWARE_ALLOWLIST.includes(rel)) offenders.push(rel);
            }
        };
        walk(SRC);
        expect(offenders).toEqual([]);
    });

    test('the policies writer is a settings write only — no order engine symbols appear in it', () => {
        const service = fs.readFileSync(path.join(SRC, 'modules/shop/shop.service.js'), 'utf8');
        const start = service.indexOf('const updateShopBusinessPolicies');
        expect(start).toBeGreaterThan(-1);
        const rest = service.slice(start);
        const body = rest.slice(0, rest.indexOf('\nconst ', 10) > 0 ? rest.indexOf('\nconst ', 10) : rest.length);
        expect(body).not.toMatch(/cancelOrder|dispatchOrder|order\.update|Order\.create|refundService/i);
        // The informational-only contract comment is present on both sides
        // (no second, machine-readable policy engine was smuggled in).
        const validator = fs.readFileSync(path.join(SRC, 'modules/shop/shop.validator.js'), 'utf8');
        expect(validator).toMatch(/INFORMATIONAL ONLY/);
        const knowledge = fs.readFileSync(path.join(SRC, 'modules/knowledge/knowledge.service.js'), 'utf8');
        expect(knowledge).toMatch(/POLICIES ARE INFORMATIONAL ONLY/);
    });
});
