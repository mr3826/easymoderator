'use strict';

/**
 * UNIT lane — the public contract is the sole unauthenticated price/term
 * authority. It must publish the frozen contract, the registry hash, and only
 * merchant-visible claim descriptors.
 */

const express = require('express');
const request = require('supertest');
const router = require('../commercial-contract.routes');
const {
    COMMERCIAL_CONTRACT_VERSION,
    contractHash,
} = require('../../commercial/commercial.contract');
const { CLAIM_IDS, registryHash } = require('../../commercial/claim.registry');

const app = express();
app.use('/api/public/commercial-contract', router);

describe('GET /api/public/commercial-contract', () => {
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