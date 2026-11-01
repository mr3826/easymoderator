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
    test('publishes the three founder package names and non-billable support targets without changing current conversation contracts', async () => {
        const response = await request(appFor(planRoutes)).get('/');

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(3);
        expect(response.body.data.map(({ code, public_name }) => [code, public_name])).toEqual([
            ['SHURU', 'Get Your Moderator'],
            ['GROWTH', 'Moderator Plus'],
            ['PARTNER', 'Partnership'],
        ]);
        expect(response.body.data.every((plan) => (
            typeof plan.description === 'string'
            && typeof plan.description_bn === 'string'
            && !/\b(100|500|999)\b/.test(plan.description)
            && !/\b(100|500|999)\b/.test(plan.description_bn)
        ))).toBe(true);
        expect(response.body.data[0]).toMatchObject({
            conversations_limit: 100,
            support_reply_allowance: {
                amount: 300,
                unit: 'provider_accepted_ai_reply',
                period: 'utc_calendar_month',
                status: 'shadow_only',
                billable: false,
                enforced: false,
            },
        });
        expect(response.body.data[1]).toMatchObject({
            conversations_limit: 500,
            price_bdt_monthly: 999,
            can_purchase_topups: true,
            topup_packs: [
                { code: 'PACK_100', conversations: 100, priceBdt: 250 },
                { code: 'PACK_300', conversations: 300, priceBdt: 500 },
                { code: 'PACK_700', conversations: 700, priceBdt: 1000 },
            ],
            support_reply_allowance: {
                amount: 3000,
                unit: 'provider_accepted_ai_reply',
                period: 'utc_calendar_month',
                status: 'shadow_only',
                billable: false,
                enforced: false,
            },
        });
        expect(response.body.data[2]).toMatchObject({
            billing_model: 'per_order',
            support_reply_allowance: null,
            partner_order_tiers: [
                { minOrders: 300, maxOrders: 999, rateBdt: 15 },
                { minOrders: 1000, maxOrders: 2999, rateBdt: 12 },
                { minOrders: 3000, maxOrders: null, rateBdt: 10 },
            ],
        });
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
