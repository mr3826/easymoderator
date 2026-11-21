'use strict';

const config = require('../../config/config');
const {
    isTrustedAuthOrigin,
    isNativeCsrfExempt,
    csrfProtectionMiddleware,
    getCsrfCookieName,
} = require('../csrf-middleware');

const originalCorsOrigins = process.env.CORS_ORIGINS;

beforeAll(() => {
    // This contract passes application and Growth origins explicitly. Keep a
    // developer .env CORS list from changing the meaning of the rejection cases.
    delete process.env.CORS_ORIGINS;
});

afterAll(() => {
    if (originalCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = originalCorsOrigins;
});

describe('CSRF cookie name by environment', () => {
    test('uses an HTTP-compatible host-only cookie name in local development', () => {
        expect(getCsrfCookieName('development')).toBe('easymod.csrf-token');
    });

    test('leaves the deployed __Host cookie default unchanged', () => {
        expect(getCsrfCookieName('production')).toBeUndefined();
        expect(getCsrfCookieName('staging')).toBeUndefined();
        expect(getCsrfCookieName('test')).toBeUndefined();
    });
});

describe('authentication origin binding', () => {
    const appOrigin = 'https://app.easymod.tech';
    const growthOrigin = 'https://growth.easymod.tech';

    test('accepts the exact merchant app origin in production', () => {
        expect(isTrustedAuthOrigin(appOrigin, 'production', appOrigin)).toBe(true);
    });

    test.each([
        undefined,
        'https://easymod.tech',
        'https://evil.easymod.tech',
        'https://app.easymod.tech.evil.example',
    ])('rejects an untrusted or missing production origin: %s', (origin) => {
        expect(isTrustedAuthOrigin(origin, 'production', appOrigin, growthOrigin)).toBe(false);
    });

    test('accepts the exact Growth OS origin in production', () => {
        expect(isTrustedAuthOrigin(growthOrigin, 'production', appOrigin, growthOrigin)).toBe(true);
    });

    test('does not accept a sibling or lookalike Growth origin', () => {
        expect(isTrustedAuthOrigin('https://growth.easymod.tech.evil.example', 'production', appOrigin, growthOrigin)).toBe(false);
    });

    test('does not constrain local and test environments', () => {
        expect(isTrustedAuthOrigin(undefined, 'test', appOrigin)).toBe(true);
        expect(isTrustedAuthOrigin('http://localhost:5173', 'development', appOrigin)).toBe(true);
    });
});

describe('ADR M-004: native mobile CSRF exemption (isNativeCsrfExempt)', () => {
    const bearerReq = (overrides = {}) => ({
        path: '/api/auth/native/logout',
        cookies: {},
        get: (name) => (name === 'Authorization' ? 'Bearer valid.jwt.token' : undefined),
        ...overrides,
    });

    test('exempts a Bearer request with no cookies when MOBILE_API_ENABLED is on', () => {
        expect(isNativeCsrfExempt(bearerReq(), true)).toBe(true);
    });

    test('does NOT exempt a Bearer + no-cookie request when MOBILE_API_ENABLED is off', () => {
        expect(isNativeCsrfExempt(bearerReq(), false)).toBe(false);
    });

    // ADR M-004, Consequences: "a request carrying both a valid
    // Authorization: Bearer header and a valid access_token/session cookie
    // must still be CSRF-checked exactly as today — the exemption is defined
    // by 'no cookies present'". This is the single case most likely to
    // regress silently if the condition is ever simplified to "has a Bearer
    // header" during a later refactor.
    test('REQUIRED: a Bearer header combined with an access_token cookie is still CSRF-checked', () => {
        const req = bearerReq({ cookies: { access_token: 'stolen-or-ambient-cookie' } });
        expect(isNativeCsrfExempt(req, true)).toBe(false);
    });

    test('REQUIRED: a Bearer header combined with a session cookie is still CSRF-checked', () => {
        const req = bearerReq({ cookies: { 'commerce_ai.sid': 's:abcdef' } });
        expect(isNativeCsrfExempt(req, true)).toBe(false);
    });

    test('a Bearer header combined with any other cookie is still CSRF-checked (no cookies at all, strictly)', () => {
        const req = bearerReq({ cookies: { unrelated_cookie: '1' } });
        expect(isNativeCsrfExempt(req, true)).toBe(false);
    });

    test('exempts the native signin path even with no Bearer header yet (pre-credential flow)', () => {
        const req = { path: '/api/auth/native/signin', cookies: {}, get: () => undefined };
        expect(isNativeCsrfExempt(req, true)).toBe(true);
    });

    test('exempts the native 2fa/verify and refresh paths with no Bearer header', () => {
        for (const path of ['/api/auth/native/2fa/verify', '/api/auth/native/refresh']) {
            const req = { path, cookies: {}, get: () => undefined };
            expect(isNativeCsrfExempt(req, true)).toBe(true);
        }
    });

    test('exempts the native logout path with no Bearer header when refresh_token is the credential', () => {
        const req = { path: '/api/auth/native/logout', cookies: {}, get: () => undefined };
        expect(isNativeCsrfExempt(req, true)).toBe(true);
    });

    test('does NOT exempt a native anonymous path when a cookie is present', () => {
        const req = { path: '/api/auth/native/signin', cookies: { 'commerce_ai.sid': 'x' }, get: () => undefined };
        expect(isNativeCsrfExempt(req, true)).toBe(false);
    });

    test('does NOT exempt a non-native path with no Bearer header at all', () => {
        const req = { path: '/api/order', cookies: {}, get: () => undefined };
        expect(isNativeCsrfExempt(req, true)).toBe(false);
    });

    test('DOES exempt any other Bearer-authenticated path once the flag is on (forward-compatible with future /api/mobile/* routes per ADR M-010)', () => {
        const req = {
            path: '/api/mobile/orders',
            cookies: {},
            get: (name) => (name === 'Authorization' ? 'Bearer x' : undefined),
        };
        expect(isNativeCsrfExempt(req, true)).toBe(true);
    });

    test('lets a production-like flag-off native POST reach the native route 404 gate instead of CSRF', () => {
        const previousEnabled = config.mobileApiEnabled;
        const previousEnvironment = config.env;
        const next = jest.fn();

        config.mobileApiEnabled = false;
        config.env = 'production';
        try {
            csrfProtectionMiddleware({
                method: 'POST',
                path: '/api/auth/native/signin',
                cookies: {},
                get: () => undefined,
            }, {}, next);
        } finally {
            config.mobileApiEnabled = previousEnabled;
            config.env = previousEnvironment;
        }

        expect(next).toHaveBeenCalledWith();
    });
});

describe('WP-02: Meta interaction probe route is CSRF-guarded (global chain, not skip-listed)', () => {
    const PROBE_PATH = '/api/channels/meta/55555555-5555-4555-8555-555555555555/probe-interaction-fields';
    const previousEnvironment = config.env;
    const previousSecret = config.csrfSecret;

    afterAll(() => {
        config.env = previousEnvironment;
        config.csrfSecret = previousSecret;
    });

    // A Bearer request that ALSO carries ambient cookies — the exact shape the
    // merchant SPA sends (JWT + session cookie). Per ADR M-004 a cookie-bearing
    // request is never native-exempt, so the double-submit check must run.
    const postReq = (path) => ({
        method: 'POST',
        path,
        cookies: { access_token: 'ambient-session-cookie' },
        get: (name) => (name === 'Authorization' ? 'Bearer merchant-jwt' : undefined),
        headers: { authorization: 'Bearer merchant-jwt' },
        ip: '127.0.0.1',
    });
    const fakeRes = () => ({ cookie: jest.fn(), header: jest.fn(), locals: {} });

    test('a cookie-bearing POST to the probe path without a CSRF token is rejected by the CSRF layer', () => {
        config.env = 'production';
        config.csrfSecret = 'contract-only-csrf-secret-not-a-real-one';
        const next = jest.fn();

        csrfProtectionMiddleware(postReq(PROBE_PATH), fakeRes(), next);

        expect(next).toHaveBeenCalledTimes(1);
        const error = next.mock.calls[0][0];
        expect(error).toBeInstanceOf(Error);
        expect([400, 403]).toContain(error.status);
    });

    test('provider webhook callbacks remain the deliberately skip-listed family', () => {
        config.env = 'production';
        const next = jest.fn();

        csrfProtectionMiddleware(postReq('/api/webhooks/meta'), fakeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    test('safe methods never consume CSRF checks', () => {
        config.env = 'production';
        const next = jest.fn();

        csrfProtectionMiddleware(
            { method: 'GET', path: PROBE_PATH, cookies: {}, get: () => undefined, headers: {} },
            fakeRes(),
            next,
        );

        expect(next).toHaveBeenCalledWith();
    });
});
