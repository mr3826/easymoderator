'use strict';

jest.mock('../../middleware/auth.middleware', () => ({ authenticate: (_req, _res, next) => next() }));
jest.mock('../../middleware/shop-access.middleware', () => ({ verifyShopAccess: (_req, _res, next) => next() }));
jest.mock('../../middleware/shop-permission.middleware', () => ({ requireOwner: (_req, _res, next) => next() }));
jest.mock('../helpers', () => ({ validate: () => (_req, _res, next) => next() }));

const express = require('express');
const request = require('supertest');
const routes = require('./storefront.routes');
const service = require('./storefront.service');

describe('Storefront route contract', () => {
    test('exports merchant management and public storefront endpoints', () => {
        expect(routes.routeContract).toEqual([
            'GET /manage',
            'POST /manage',
            'PATCH /manage',
            'PUT /manage/settings',
            'PUT /manage/products',
            'POST /manage/publish',
            'POST /manage/unpublish',
            'GET /public/:slug',
            'GET /public/:slug/products',
            'POST /public/:slug/checkout',
        ]);
    });

    test('allows root route registration to inject the shared fail-closed gate', () => {
        const assertStorefrontEnabled = jest.fn().mockResolvedValue(true);
        const router = routes.createStorefrontRouter({ assertStorefrontEnabled });

        expect(router.stack.some((layer) => layer.route?.path === '/manage')).toBe(true);
        expect(assertStorefrontEnabled).not.toHaveBeenCalled();
    });

    test('fails closed with 404 (not 500) on unknown public slug through real rate limiters', async () => {
        const spy = jest.spyOn(service, 'getPublicStorefrontRecord').mockResolvedValueOnce(null);
        const app = express();
        app.use('/api/storefront', routes);
        app.use((err, _req, res, _next) => {
            res.status(err.status || err.statusCode || 500).json({ success: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
        });

        try {
            const res = await request(app).get('/api/storefront/public/nonexistent-r0-probe');
            expect(res.status).toBe(404);
            expect(res.body.code).toBe('STOREFRONT_NOT_FOUND');
        } finally {
            spy.mockRestore();
        }
    });
});
