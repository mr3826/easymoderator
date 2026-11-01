'use strict';

jest.mock('../../middleware/auth.middleware', () => ({ authenticate: (_req, _res, next) => next() }));
jest.mock('../../middleware/shop-access.middleware', () => ({ verifyShopAccess: (_req, _res, next) => next() }));
jest.mock('../../middleware/shop-permission.middleware', () => ({ requireOwner: (_req, _res, next) => next() }));
jest.mock('../helpers', () => ({ validate: () => (_req, _res, next) => next() }));

const routes = require('./storefront.routes');

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
});
