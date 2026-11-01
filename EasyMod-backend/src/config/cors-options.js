'use strict';

const { AppError } = require('../utils/AppError');

const PUBLIC_CROSS_ORIGIN_PATHS = new Set([
    '/api/public/live-stats',
    '/api/subscription/plans',
    '/api/public/addons',
    '/api/analytics/funnel',
    '/api/partner/apply',
]);

function buildCorsOptions(req, config) {
    const isPublicSurface = PUBLIC_CROSS_ORIGIN_PATHS.has(req.path);
    const routeOrigins = isPublicSurface
        ? [config.origins.marketing, config.origins.app]
        : (config.corsOrigins || []);

    return {
        origin(origin, callback) {
            if (!origin || routeOrigins.includes(origin)) return callback(null, true);
            // A denied origin is a policy decision, not a server fault. A bare
            // Error reached globalErrorHandler as a 500, so every stale
            // apex-origin tab and every drive-by scanner booked a server error
            // in Sentry and logged at error level. 403 keeps the same refusal
            // (cors still emits no ACAO, and the route never runs) while
            // logging as a client error.
            return callback(new AppError('Not allowed by CORS', 403, 'CORS_ORIGIN_DENIED'));
        },
        credentials: !isPublicSurface,
    };
}

module.exports = { buildCorsOptions, PUBLIC_CROSS_ORIGIN_PATHS };
