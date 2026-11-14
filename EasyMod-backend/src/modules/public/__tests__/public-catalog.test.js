'use strict';

const express = require('express');
const request = require('supertest');
const planRoutes = require('../subscription-plans.routes');
const addonRoutes = require('../../shop-addons/public-addon-catalog.routes');

function appFor(router) {
    const app = express();
    app.use(router);
    return app;
}

describe('public commercial catalogs', () => {
    test('retires the subscription catalog in favour of the delivered-order contract', async () => {
        const response = await request(appFor(planRoutes)).get('/');

        // ADR-0011 C1: the plan catalog is superseded in full. The endpoint must
        // not answer with plans; it points old clients at the one price authority.
        expect(response.status).toBe(410);
        expect(response.body).toMatchObject({
            success: false,
            code: 'CATALOG_RETIRED',
            successor: '/api/public/commercial-contract',
        });
        expect(response.body.data).toBeUndefined();
    });

    test('publishes exactly two separately priced-unset optional pilot add-ons and their operational limits', async () => {
        const response = await request(appFor(addonRoutes)).get('/');

        expect(response.status).toBe(200);
        expect(response.body.data.map(({ code }) => code)).toEqual(['ADS_STUDIO', 'STOREFRONT']);
        expect(response.body.data.every(({ price_bdt_monthly, billing_terms, availability }) => (
            price_bdt_monthly === null && billing_terms === 'not_activated' && availability === 'pilot_approval_required'
        ))).toBe(true);
        expect(response.body.data[0].limits).toContain('Draft approval does not publish campaigns or change spend.');
        expect(response.body.data[1].limits).toContain('COD only; no online payment verification or courier automation is claimed.');
    });
});
