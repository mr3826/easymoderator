const { doubleCsrf } = require('csrf-csrf');
const crypto = require('crypto');
const config = require('../config/config');
const { DEVELOPMENT_DEFAULTS } = require('../config/origins');
const { AppError } = require('../utils/AppError');

/**
 * Cookie-issuing authentication endpoints cannot use the double-submit token
 * before a browser session exists. In production-like environments, bind those
 * requests to the configured application origins instead. Browsers include
 * Origin on cross-origin and same-origin POST requests, so a missing or sibling
 * origin must fail closed.
 */
const AUTH_ORIGIN_ENVIRONMENTS = new Set(['production', 'staging']);
const DEVELOPMENT_ORIGINS = [DEVELOPMENT_DEFAULTS.app, DEVELOPMENT_DEFAULTS.growth];

function parseOrigin(value) {
    if (typeof value !== 'string' || !value.trim()) return null;

    try {
        const parsed = new URL(value.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)
            || parsed.username
            || parsed.password
            || parsed.pathname !== '/'
            || parsed.search
            || parsed.hash) {
            return null;
        }
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function parseConfiguredOrigins(value) {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        return { valid: true, origins: new Set() };
    }

    const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : null;
    if (!values) return { valid: false, origins: new Set() };

    const origins = new Set();
    for (const candidate of values) {
        const parsed = parseOrigin(candidate);
        if (!parsed) return { valid: false, origins: new Set() };
        origins.add(parsed);
    }
    return { valid: true, origins };
}

function getConfiguredOrigin(value, environmentNames) {
    if (value !== undefined) return value;
    return environmentNames.map((name) => process.env[name]).find(Boolean);
}

function isTrustedAuthOrigin(
    origin,
    environment = config.env,
    appOrigin,
    growthOrigin,
    corsOrigins,
) {
    const normalizedEnvironment = String(environment || '').trim().toLowerCase();

    // Test requests are disposable and the application already disables CSRF
    // validation for them. Keep this bypass isolated from deployed environments.
    if (normalizedEnvironment === 'test') return true;

    const parsedRequestOrigin = parseOrigin(origin);
    if (!parsedRequestOrigin) return false;

    // Explicit origins are used by pure callers/tests as an isolated policy.
    // The request middleware passes no explicit origins and therefore uses the
    // deployed CORS configuration. This prevents a developer .env allowlist
    // from contaminating a caller that supplied the production app/Growth OS
    // origins directly.
    const configuredCorsOrigins = corsOrigins === undefined
        ? ((appOrigin !== undefined || growthOrigin !== undefined)
            ? []
            : (process.env.CORS_ORIGINS ?? config.corsOrigins))
        : corsOrigins;
    const parsedCorsOrigins = parseConfiguredOrigins(configuredCorsOrigins);
    if (!parsedCorsOrigins.valid) return false;

    const allowedOrigins = parsedCorsOrigins.origins;
    const configuredApplicationOrigin = getConfiguredOrigin(appOrigin, ['APP_URL', 'FRONTEND_URL']);
    const configuredGrowthOrigin = getConfiguredOrigin(growthOrigin, ['GROWTH_FRONTEND_URL', 'GROWTH_URL']);
    for (const candidate of [configuredApplicationOrigin, configuredGrowthOrigin]) {
        if (candidate === undefined || candidate === null || candidate === '') continue;
        const parsed = parseOrigin(candidate);
        if (!parsed) return false;
        allowedOrigins.add(parsed);
    }

    if (AUTH_ORIGIN_ENVIRONMENTS.has(normalizedEnvironment)) {
        return allowedOrigins.has(parsedRequestOrigin);
    }

    if (normalizedEnvironment === 'development') {
        // Development has no wildcard bypass. Keep the existing local frontend
        // workflow working while requiring an exact configured/local origin.
        for (const candidate of DEVELOPMENT_ORIGINS) allowedOrigins.add(candidate);
    }

    // Unknown environments are treated like production rather than inheriting
    // a permissive non-production default.
    return allowedOrigins.has(parsedRequestOrigin);
}

/**
 * ADR M-004: native auth endpoints that use only body credentials (signin, the
 * 2FA step, refresh, and logout with a refresh_token). These carry no
 * Authorization header yet, so they cannot be covered by the Bearer-based
 * exemption below; they are exempted by exact path instead, and — per the
 * ADR's Consequences section — WITHOUT the isTrustedAuthOrigin check, since a
 * client with no cookie jar has no Origin-spoofing surface to protect
 * against in the first place.
 */
const NATIVE_ANONYMOUS_AUTH_PATHS = new Set([
    '/api/auth/native/signin',
    '/api/auth/native/2fa/verify',
    '/api/auth/native/refresh',
    '/api/auth/native/logout',
]);

const isNativeAuthPath = (path) => typeof path === 'string'
    && (path === '/api/auth/native' || path.startsWith('/api/auth/native/'));

/**
 * True when the request carries none of the cookies a browser session would
 * ever attach automatically (session cookie, access_token, refresh_token —
 * in fact, checked here as "no cookies at all", which is a strict superset
 * of that list and therefore never under-protects). CSRF's threat model
 * requires an ambient credential a cross-site request can ride; a request
 * with zero cookies has none, regardless of what other headers it carries.
 */
const hasNoCookies = (req) => {
    const cookies = req.cookies;
    return !cookies || Object.keys(cookies).length === 0;
};

/**
 * ADR M-004 decision, restated precisely: CSRF is skipped for a request only
 * when it carries `Authorization: Bearer`, it carries NO cookies of any kind,
 * and MOBILE_API_ENABLED is on — a request that also carries a cookie is
 * deliberately NOT exempted and still runs the normal check below, even if it
 * also has a Bearer header. Native's own body-credential endpoints (signin,
 * 2fa/verify, refresh, logout) are exempted by exact path instead, under the
 * exact same "no cookies at all" guard, since they may have no Bearer token.
 *
 * Exported as a pure, request-shape function (mirrors isTrustedAuthOrigin)
 * so the hybrid Bearer+cookie case the ADR calls out as most likely to
 * regress silently can be asserted directly, without needing a live session/
 * CSRF-secret stack — see csrf-middleware.test.js.
 */
const isNativeCsrfExempt = (
    req,
    mobileApiEnabled = config.mobileApiEnabled,
) => {
    if (!mobileApiEnabled) return false;
    if (!hasNoCookies(req)) return false;

    if (NATIVE_ANONYMOUS_AUTH_PATHS.has(req.path)) return true;

    const authHeader = req.get ? req.get('Authorization') : req.headers?.authorization;
    return typeof authHeader === 'string' && authHeader.startsWith('Bearer ');
};

// The library's default cookie name starts with `__Host-`, which browsers
// reject unless the cookie is Secure. Local HTTP development deliberately
// uses secure=false, so use a host-only development name there. Deployed
// environments keep the library default and its production security contract.
const getCsrfCookieName = (environment = config.env) => (
    String(environment || '').trim().toLowerCase() === 'development'
        ? 'easymod.csrf-token'
        : undefined
);

// Enhanced CSRF configuration with better error handling
const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => config.csrfSecret,
    cookieName: getCsrfCookieName(config.env),
    getSessionIdentifier: (req) => {
        // Prefer express-session ID (stable across requests in the same session)
        if (req.sessionID) return req.sessionID;
        if (req.session?.id) return req.session.id;

        // No session available: generate a random ID and persist it in the session.
        // This replaces the previous IP-based fallback which was vulnerable to:
        //   (a) X-Forwarded-For spoofing, and
        //   (b) CSRF token sharing on shared networks (NAT / proxies).
        if (req.session) {
            if (!req.session._csrfSessionId) {
                req.session._csrfSessionId = crypto.randomUUID();
                // Non-blocking save — if it fails the token will still work for this
                // request but the session won't be persisted (acceptable for anonymous).
                req.session.save((err) => {
                    if (err) console.error('[csrf] session save error:', err.message);
                });
            }
            return req.session._csrfSessionId;
        }

        // Hard fallback: every call gets a fresh UUID, meaning no CSRF protection for
        // truly session-less requests.  Auth-required endpoints are protected by JWT,
        // so this path only applies to unauthenticated state-changing endpoints, which
        // should not exist (they are either public or auth-gated).
        return crypto.randomUUID();
    },
    cookieOptions: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: config.env === 'production'
    }
});

// CSRF token endpoint — session ID is already stable (saveUninitialized: true),
// so no explicit session.save() is needed before generating the token.
const csrfTokenHandler = (req, res, next) => {
    try {
        if (!req.session) {
            return next(new AppError('Session not initialized', 500));
        }
        const csrfToken = generateCsrfToken(req, res);
        res.status(200).json({ csrfToken });
    } catch (error) {
        console.error('CSRF token generation error:', error);
        next(new AppError('Failed to generate CSRF token', 500));
    }
};

// Enhanced CSRF protection middleware with better error handling
const csrfProtectionMiddleware = (req, res, next) => {
    // Skip CSRF for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // These routes are intentionally anonymous and never read or mutate an
    // authenticated user's state. Keep this list exact so no authenticated
    // analytics or partner-admin route inherits the exemption.
    const publicWritePaths = new Set([
        '/api/analytics/funnel',
        '/api/partner/apply',
    ]);
    if (publicWritePaths.has(req.path)) {
        return next();
    }

    // Disabled native routes must reach their own indistinguishable 404 gate.
    // Do not make a production request reveal CSRF state before that gate runs.
    if (!config.mobileApiEnabled && isNativeAuthPath(req.path)) {
        return next();
    }

    // ADR M-004: mobile native auth (body/header token transport, zero
    // cookies). See isNativeCsrfExempt above for the exact condition — a
    // request that also carries any cookie is NOT exempted and falls through
    // to the normal check below, even with a Bearer header present.
    if (isNativeCsrfExempt(req)) {
        return next();
    }

    // Web anonymous authentication flows do not act on an existing
    // authenticated account. Keep this list exact; native logout is handled
    // by the no-cookie body-token exemption above.
    const anonymousAuthPaths = new Set([
        '/api/auth/signup',
        '/api/auth/signin',
        '/api/auth/refresh',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
        '/api/auth/2fa/verify',
    ]);
    if (anonymousAuthPaths.has(req.path)) {
        if (!isTrustedAuthOrigin(req.get('Origin'))) {
            return next(new AppError('Authentication requests must originate from an approved EasyModerator application.', 403));
        }
        return next();
    }

    // Skip CSRF for provider callbacks and auth endpoints.
    const skipPaths = [
        '/webhooks',
        '/api/webhooks',
        '/health',
        '/csrf',
        '/api/csrf'
    ];

    const path = req.path;
    if (skipPaths.some(skipPath => path.startsWith(skipPath))) {
        return next();
    }

    // Skip CSRF in test environment
    if (config.env === 'test') {
        return next();
    }

    // Apply CSRF protection with enhanced error handling
    doubleCsrfProtection(req, res, (err) => {
        if (err) {
            // Enhanced error logging
            const errorInfo = {
                method: req.method,
                path: req.path,
                ip: req.ip,
                userAgent: req.get('User-Agent'),
                sessionId: req.sessionID,
                timestamp: new Date().toISOString(),
                error: err.message
            };

            if (config.env === 'development') {
                console.warn('❌ CSRF Error:', errorInfo);
            } else {
                // In production, log structured error for monitoring
                console.error('CSRF Validation Failed', JSON.stringify(errorInfo));
            }

            // Return appropriate error response
            if (err.message.includes('invalid csrf token')) {
                return next(new AppError('Invalid CSRF token. Please refresh the page and try again.', 403));
            } else if (err.message.includes('csrf token missing')) {
                return next(new AppError('CSRF token required. Please include the token in your request.', 400));
            } else {
                return next(new AppError('CSRF validation failed. Please try again.', 403));
            }
        }
        next();
    });
};

// CSRF debugging endpoint (development only)
const csrfDebugHandler = (req, res, next) => {
    if (config.env !== 'development') {
        return next(new AppError('Debug endpoint not available in production', 404));
    }

    try {
        const debugInfo = {
            sessionId: req.sessionID,
            sessionExists: !!req.session,
            csrfInit: req.session?.csrfInit,
            cookies: req.cookies,
            headers: {
                'x-csrf-token': req.get('x-csrf-token'),
                'cookie': req.get('cookie')
            },
            config: {
                env: config.env,
                secureCookies: config.env === 'production'
            }
        };

        res.json(debugInfo);
    } catch (error) {
        next(new AppError('Debug information unavailable', 500));
    }
};

module.exports = {
    csrfTokenHandler,
    csrfProtectionMiddleware,
    csrfDebugHandler,
    getCsrfCookieName,
    isTrustedAuthOrigin,
    isNativeCsrfExempt,
};
