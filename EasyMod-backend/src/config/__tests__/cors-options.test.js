'use strict';

const cors = require('cors');
const express = require('express');
const request = require('supertest');

const { buildCorsOptions } = require('../cors-options');
const { globalErrorHandler } = require('../../utils/AppError');

const config = {
    corsOrigins: ['https://app.easymod.tech'],
    origins: {
        app: 'https://app.easymod.tech',
        marketing: 'https://easymod.tech',
    },
};

function checkOrigin(options, origin) {
    return new Promise((resolve) => options.origin(origin, (error, allowed) => resolve({ error, allowed })));
}

describe('domain-split CORS options', () => {
    test('allows the app with credentials on protected routes', async () => {
        const options = buildCorsOptions({ path: '/api/orders' }, config);
        expect(options.credentials).toBe(true);
        await expect(checkOrigin(options, 'https://app.easymod.tech')).resolves.toMatchObject({ allowed: true });
    });

    test('allows marketing without credentials only on explicit public routes', async () => {
        const publicOptions = buildCorsOptions({ path: '/api/public/live-stats' }, config);
        expect(publicOptions.credentials).toBe(false);
        await expect(checkOrigin(publicOptions, 'https://easymod.tech')).resolves.toMatchObject({ allowed: true });

        const planOptions = buildCorsOptions({ path: '/api/subscription/plans' }, config);
        expect(planOptions.credentials).toBe(false);
        await expect(checkOrigin(planOptions, 'https://easymod.tech')).resolves.toMatchObject({ allowed: true });

        const addonOptions = buildCorsOptions({ path: '/api/public/addons' }, config);
        expect(addonOptions.credentials).toBe(false);
        await expect(checkOrigin(addonOptions, 'https://easymod.tech')).resolves.toMatchObject({ allowed: true });

        const protectedOptions = buildCorsOptions({ path: '/api/orders' }, config);
        const result = await checkOrigin(protectedOptions, 'https://easymod.tech');
        expect(result.error).toMatchObject({ status: 403, code: 'CORS_ORIGIN_DENIED' });
    });

    test('rejects hostile origins on both public and protected routes', async () => {
        for (const path of ['/api/partner/apply', '/api/orders']) {
            const result = await checkOrigin(buildCorsOptions({ path }, config), 'https://attacker.example');
            expect(result.error).toBeInstanceOf(Error);
        }
    });

    // A denied origin used to surface as a 500: globalErrorHandler falls back to
    // `err.status || 500` for a bare Error, so the refusal was indistinguishable
    // from a crash in logs and alerting. Pin the status the handler will read.
    test('denial carries a 403 so it logs as a client error, not a server fault', async () => {
        for (const path of ['/api/partner/apply', '/api/orders']) {
            const { error } = await checkOrigin(buildCorsOptions({ path }, config), 'https://attacker.example');
            expect(error.status).toBe(403);
            expect(error.code).toBe('CORS_ORIGIN_DENIED');
        }
    });
});

// The unit tests above only inspect the callback argument. What actually
// regressed in production was the wire response: `cors` forwards the origin
// error to next(err), and globalErrorHandler decides the status. Mount the same
// two middlewares app.js does and assert on the real response.
describe('denied origins on the wire', () => {
    const buildApp = () => {
        const app = express();
        app.use(cors((req, callback) => callback(null, buildCorsOptions(req, config))));
        app.get('/api/orders', (req, res) => res.json({ reached: true }));
        app.post('/api/orders', (req, res) => res.json({ reached: true }));
        app.use(globalErrorHandler);
        return app;
    };

    test('rejects a hostile origin with 403 and no ACAO header', async () => {
        const response = await request(buildApp()).get('/api/orders').set('Origin', 'https://attacker.example');
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ success: false, code: 'CORS_ORIGIN_DENIED' });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('rejects the marketing origin on a protected route without running the handler', async () => {
        const response = await request(buildApp()).get('/api/orders').set('Origin', 'https://easymod.tech');
        expect(response.status).toBe(403);
        expect(response.body.reached).toBeUndefined();
    });

    test('denies a cross-origin preflight with 403 instead of 500', async () => {
        const response = await request(buildApp())
            .options('/api/orders')
            .set('Origin', 'https://attacker.example')
            .set('Access-Control-Request-Method', 'POST');
        expect(response.status).toBe(403);
    });

    test('still serves the merchant app with credentials', async () => {
        const response = await request(buildApp()).get('/api/orders').set('Origin', 'https://app.easymod.tech');
        expect(response.status).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe('https://app.easymod.tech');
        expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
});
