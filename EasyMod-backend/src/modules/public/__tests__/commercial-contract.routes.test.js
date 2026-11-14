'use strict';

/**
 * UNIT lane — the public contract is the sole unauthenticated price/term
 * authority. It must publish the frozen contract, the registry hash, only
 * merchant-visible claim descriptors, and server-evaluated public decisions.
 *
 * B9 regression: the app is mounted at the path routes.js actually declares,
 * read from source. When routes.js regressed to `router.use('/public', ...)`
 * the endpoint became /api/public/commercial-contract 404; this test fails
 * against the real mount string instead of a hand-copied one.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const router = require('../commercial-contract.routes');
const {
    COMMERCIAL_CONTRACT_VERSION,
    contractHash,
} = require('../../commercial/commercial.contract');
const { CLAIM_IDS, registryHash } = require('../../commercial/claim.registry');

const ROUTES_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'routes.js'), 'utf8');
const MOUNT = /router\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"]\.\/public\/commercial-contract\.routes['"]\s*\)\s*\)/
    .exec(ROUTES_SOURCE);

const mountPath = MOUNT ? MOUNT[1] : null;

const app = express();
if (mountPath) app.use(`/api${mountPath}`, router);

describe('GET /api/public/commercial-contract (real routes.js mount)', () => {
    it('mounts the public contract router at the path routes.js declares', () => {
        expect(mountPath).toBe('/public/commercial-contract');
        expect(ROUTES_SOURCE).not.toMatch(/router\.use\(\s*['"]\/public['"]\s*,\s*require\(\s*['"]\.\/public\/commercial-contract\.routes['"]/);
    });

    it('serves the frozen contract without authentication', async () => {
        const response = await request(app).get('/api/public/commercial-contract');

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toMatchObject({
            contract_version: COMMERCIAL_CONTRACT_VERSION,
            contract_hash: contractHash,
            registry_hash: registryHash,
            model: 'DELIVERED_ORDER',
            currency: 'BDT',
            unit_price_minor: 1000,
            unit_price_bdt: 10,
            subscription_fee_bdt: 0,
            setup_fee_bdt: 0,
            monthly_minimum_bdt: 0,
            conversation_entitlement: null,
            due_days: 7,
        });
        expect(response.body.data.on_overdue).toMatchObject({
            blockCourierBooking: true,
            pauseAutomatedAi: true,
            keepInboxReadable: true,
            keepHistoryReadable: true,
            deleteData: false,
        });
    });

    it('is not still mounted at the retired /api/public path', async () => {
        const response = await request(app).get('/api/public/');
        expect(response.status).toBe(404);
    });

    it('publishes only merchant-visible claims with verified scope', async () => {
        const response = await request(app).get('/api/public/commercial-contract');
        const claims = response.body.data.claims;

        expect(Array.isArray(claims)).toBe(true);
        expect(claims.length).toBe(CLAIM_IDS.length - 1); // ai.reply_shadow_meter is internal
        expect(claims.some((claim) => claim.id === 'ai.reply_shadow_meter')).toBe(false);
        for (const claim of claims) {
            expect(typeof claim.id).toBe('string');
            expect(typeof claim.verified_scope).toBe('string');
            expect(claim.i18n_key.en).toContain('claims.');
        }
    });
});

describe('GET /api/public/commercial-contract — anonymous public decisions', () => {
    const decisionFor = (decisions, claimId, surface) => decisions.find(
        (decision) => decision.claimId === claimId && (!surface || decision.surface === surface),
    );

    it('B6: evaluates contract claims as available for anonymous visitors', async () => {
        const response = await request(app).get('/api/public/commercial-contract');
        const decisions = response.body.data.decisions;

        expect(Array.isArray(decisions)).toBe(true);
        const billing = decisionFor(decisions, 'billing.delivered_order');

        expect(billing).toBeDefined();
        expect(billing.available).toBe(true);
        expect(billing.render).toBe('claim');
        expect(billing.textKey).toBe('claims.billing.delivered_order.bn');
        expect(billing.interpolation.unitPrice).toBe('৳10.00');
        expect(billing.interpolation.unitPriceBn).toBe('৳১০.০০');
    });

    it('B6: courier booking renders the truthful fallback when unverified', async () => {
        const response = await request(app).get('/api/public/commercial-contract');
        const courier = decisionFor(response.body.data.decisions, 'courier.pathao.booking_live');

        expect(courier).toBeDefined();
        expect(courier.available).toBe(false);
        expect(courier.render).toBe('fallback');
        expect(courier.textKey).toBe('claims.courier.pathao.booking_live.fallback.bn');
    });

    it('B6: merchant-dependent claims are unavailable anonymously (fail closed)', async () => {
        const response = await request(app).get('/api/public/commercial-contract');
        const addon = decisionFor(response.body.data.decisions, 'addons.ads_studio.pilot');

        expect(addon).toBeDefined();
        expect(addon.available).toBe(false);
        expect(addon.render).toBe('fallback');
        expect(addon.predicate.merchant_enabled).toBe(false);
    });

    it('B6: never publishes an internal-only decision', async () => {
        const response = await request(app).get('/api/public/commercial-contract');
        expect(decisionFor(response.body.data.decisions, 'ai.reply_shadow_meter')).toBeUndefined();
    });

    it('B6: honours an explicit surface and locale for a marketing page', async () => {
        const response = await request(app)
            .get('/api/public/commercial-contract')
            .query({ surface: 'landing', locale: 'en' });

        expect(response.status).toBe(200);
        const billing = decisionFor(response.body.data.decisions, 'billing.delivered_order', 'landing');
        expect(billing).toBeDefined();
        expect(billing.locale).toBe('en');
        expect(billing.textKey).toBe('claims.billing.delivered_order.en');
        for (const decision of response.body.data.decisions) {
            expect(decision.surface).toBe('landing');
        }
    });

    it('B6: rejects an internal surface', async () => {
        const response = await request(app)
            .get('/api/public/commercial-contract')
            .query({ surface: 'admin' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('UNKNOWN_CLAIM_SURFACE');
    });
});