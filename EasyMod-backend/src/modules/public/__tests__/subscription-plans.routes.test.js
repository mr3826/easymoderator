'use strict';

/**
 * UNIT lane — the retired catalog must answer with an explicit 410 and a
 * successor pointer, never a plan list. The plan catalog was superseded in full
 * by the delivered-order contract (ADR-0011).
 */

const express = require('express');
const request = require('supertest');
const router = require('../subscription-plans.routes');

const app = express();
app.use('/api/subscription/plans', router);

describe('retired public subscription plans endpoint', () => {
    it('answers 410 Gone with the commercial contract successor', async () => {
        const response = await request(app).get('/api/subscription/plans');

        expect(response.status).toBe(410);
        expect(response.body).toEqual({
            success: false,
            code: 'CATALOG_RETIRED',
            message: 'The subscription catalog has been retired.',
            successor: '/api/public/commercial-contract',
        });
        expect(response.body.data).toBeUndefined();
    });
});