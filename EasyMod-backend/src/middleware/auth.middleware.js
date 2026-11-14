const config = require('../config/config');
const { AppError } = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt.util');
const { isTokenBlacklisted } = require('../modules/auth/auth.service');
const { User } = require('../modules/entities');
const cacheService = require('../utils/cache.service');
const { isTemporaryPasswordExpired } = require('../modules/auth/temporary-password');
// ADR M-004: native tokens carry a `sid` claim referencing a user_sessions
// row, looked up below only when that claim is present.
const Session = require('../modules/auth/session.entity');
const { findActiveMembership } = require('../utils/active-membership');

const NATIVE_AUTH_PATH = '/api/auth/native';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// The complete read surface the mobile app uses: its own Home APIs plus the
// shop-scoped order/conversation detail reads behind deep links. A native
// token is refused everywhere else, so a compromised or modified client
// cannot use it to walk the rest of the web API.
const NATIVE_READ_ROUTES = [
    /^\/api\/mobile(?:\/|$)/,
    // ADR-0011 commercial claim reads: /contract, /claims and /billing-lines are
    // GET-only and already shop-scoped by verifyShopAccess, so the mobile app
    // can evaluate the same truth-gated claims as the web surface. Mutations
    // still hit the read-only check above (these routes expose none).
    /^\/api\/commercial(?:\/|$)/,
    new RegExp(`^/api/order/${UUID}$`, 'i'),
    new RegExp(`^/api/conversation/${UUID}$`, 'i'),
];

const requestPath = (req) => (req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`).split('?')[0];

const isNativeAuthRoute = (req) => {
    const path = requestPath(req);
    return path === NATIVE_AUTH_PATH || path.startsWith(`${NATIVE_AUTH_PATH}/`);
};

const isNativePushRoute = (req) => {
    const path = requestPath(req);
    return path === '/api/notifications/subscriptions' || path.startsWith('/api/notifications/subscriptions/');
};

const isNativeReadRoute = (req) => {
    const path = requestPath(req);
    return NATIVE_READ_ROUTES.some((route) => route.test(path));
};

const NATIVE_INBOX_WRITE_ROUTES = [
    new RegExp(`^/api/mobile/inbox/conversations/[^/]+/reply$`, 'i'),
    new RegExp(`^/api/mobile/inbox/conversations/[^/]+/ai-mode$`, 'i'),
];

const isNativeInboxWriteRoute = (req) => {
    const path = requestPath(req);
    return NATIVE_INBOX_WRITE_ROUTES.some((route) => route.test(path));
};

const NATIVE_ORDER_WRITE_ROUTES = [
    new RegExp(`^/api/mobile/orders/[^/]+/confirm$`, 'i'),
    new RegExp(`^/api/mobile/orders/[^/]+/cancel$`, 'i'),
    new RegExp(`^/api/mobile/orders/manual$`, 'i'),
    new RegExp(`^/api/mobile/orders/draft$`, 'i'),
];

const isNativeOrderWriteRoute = (req) => {
    const path = requestPath(req);
    return NATIVE_ORDER_WRITE_ROUTES.some((route) => route.test(path));
};

const NATIVE_COURIER_WRITE_ROUTES = [
    new RegExp(`^/api/mobile/orders/[^/]+/book-courier$`, 'i'),
];

const isNativeCourierWriteRoute = (req) => {
    const path = requestPath(req);
    return NATIVE_COURIER_WRITE_ROUTES.some((route) => route.test(path));
};

const NATIVE_PRODUCT_WRITE_ROUTES = [
    new RegExp(`^/api/mobile/products/[^/]+/quick-update$`, 'i'),
    new RegExp(`^/api/mobile/products/photo-draft$`, 'i'),
];

const isNativeProductWriteRoute = (req) => {
    const path = requestPath(req);
    return NATIVE_PRODUCT_WRITE_ROUTES.some((route) => route.test(path));
};

const hasUnexpiredSession = (session) => {
    const expiresAt = new Date(session?.expires_at).getTime();
    return Boolean(session?.is_active) && Number.isFinite(expiresAt) && expiresAt > Date.now();
};

/**
 * Authentication middleware
 * Checks Bearer header first, then falls back to httpOnly cookie.
 * Also verifies the token has not been blacklisted (logout revocation).
 */
const authenticateRequest = async (
    req,
    res,
    next,
    { allowPasswordChange = false, requireShopMembership = true } = {},
) => {
    try {
        // 1. Extract token — prefer Authorization header, fall back to cookie
        let token = null;
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (req.cookies?.access_token) {
            token = req.cookies.access_token;
        }

        if (!token) {
            throw new AppError('No token provided. Please authenticate.', 401);
        }

        // 2. Verify JWT signature + expiry. Keep malformed/expired credentials
        // distinct from failures in the revocation stores below.
        let decoded;
        try {
            decoded = verifyAccessToken(token);
        } catch (_error) {
            throw new AppError('Invalid or expired token. Please login again.', 401);
        }

        // 3. Check if the token has been revoked (logout)
        const blacklisted = await isTokenBlacklisted(token);
        if (blacklisted) {
            throw new AppError('Token has been revoked. Please login again.', 401);
        }

        // 4. Verify token_version to invalidate tokens after password reset.
        // Cache the DB value for 60 s per user to avoid a SELECT on every request.
        // The cache is invalidated immediately when token_version is incremented
        // (see auth.service.js resetPassword).
        if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion < 0) {
            throw new AppError('Token is missing required revocation state. Please login again.', 401);
        }
        const tvCacheKey = `user:${decoded.userId}:token_version`;
        let dbTokenVersion = await cacheService.get(tvCacheKey);
        if (dbTokenVersion === null) {
            const user = await User.findByPk(decoded.userId, {
                attributes: ['token_version']
            });
            if (!user) {
                throw new AppError('Token has been invalidated. Please login again.', 401);
            }
            dbTokenVersion = user.token_version;
            await cacheService.set(tvCacheKey, dbTokenVersion, 60);
        }
        if (dbTokenVersion !== decoded.tokenVersion) {
            throw new AppError('Token has been invalidated. Please login again.', 401);
        }

        // 4b. ADR M-004: additive branch, only reached for tokens carrying a
        // `sid` claim (native-issued tokens). Every web-issued token has no
        // `sid` claim and skips this block entirely — proven by
        // auth-token-version.security.test.js and native-sid-revocation.test.js.
        let shopMembershipVerified = false;
        let activeMembership = null;
        if (decoded.sid) {
            // ADR M-010 rollback: with MOBILE_API_ENABLED off, the native
            // sign-in/refresh routes 404 and so must every native token already
            // issued — including on the order/conversation detail reads, which
            // live outside the flag-gated routers. Web tokens carry no sid.
            if (!config.mobileApiEnabled) {
                throw new AppError('Mobile access is not available. Please login again.', 401, 'NATIVE_API_DISABLED');
            }
            const session = await Session.findByPk(decoded.sid, {
                attributes: ['id', 'user_id', 'shop_id', 'is_active', 'expires_at'],
            });
            if (!hasUnexpiredSession(session)) {
                throw new AppError('Session has been revoked. Please login again.', 401);
            }

            // The access token must still describe its session: same user, and
            // the shop the session is currently bound to. switch-shop moves the
            // session and issues a new token, so an older token for the previous
            // shop stops working immediately instead of at its 15-minute expiry.
            if (session.user_id !== decoded.userId || (session.shop_id || null) !== (decoded.shopId || null)) {
                throw new AppError('Session has been revoked. Please login again.', 401);
            }

            // Native tokens are read-only everywhere except their dedicated
            // auth/session routes and permitted mobile write routes when enabled.
            // Web tokens have no sid and retain all existing mutation privileges.
            const isPermittedInboxWrite = Boolean(config.mobileInboxWritesEnabled)
                && req.method === 'POST'
                && isNativeInboxWriteRoute(req);
            const isPermittedOrderWrite = Boolean(config.mobileOrderMutationsEnabled)
                && req.method === 'POST'
                && isNativeOrderWriteRoute(req);
            const isPermittedCourierWrite = Boolean(config.mobileCourierActionsEnabled)
                && req.method === 'POST'
                && isNativeCourierWriteRoute(req);
            const isPermittedProductWrite = Boolean(config.mobileProductMutationsEnabled)
                && (req.method === 'PATCH' || req.method === 'POST')
                && isNativeProductWriteRoute(req);

            if (!isNativeAuthRoute(req) && !isNativePushRoute(req) && !isPermittedInboxWrite && !isPermittedOrderWrite && !isPermittedCourierWrite && !isPermittedProductWrite) {
                if (!SAFE_METHODS.has(req.method || 'GET')) {
                    throw new AppError('Native API access is read-only during the mobile pilot.', 403, 'NATIVE_READ_ONLY');
                }
                if (!isNativeReadRoute(req)) {
                    throw new AppError('This API is not available to the mobile app.', 403, 'NATIVE_ROUTE_NOT_ALLOWED');
                }
            }

            // A removed staff member loses mobile access on their next request,
            // not when the access token expires. 401 (not the web 403 below)
            // sends the client through refresh, which fails on the same
            // membership check and signs the device out.
            if (decoded.shopId) {
                const membership = await findActiveMembership(decoded.userId, decoded.shopId);
                if (!membership) {
                    throw new AppError(
                        'Shop membership is no longer active. Please login again.',
                        401,
                        'NATIVE_SHOP_ACCESS_REVOKED',
                    );
                }
                activeMembership = membership;
                shopMembershipVerified = true;
            }
        }

        // A signed shop claim is not proof of a current merchant membership.
        // Re-check the active relationship so a deactivated user cannot keep
        // reading shop-scoped analytics until the JWT expires. A native token's
        // membership was already checked above with the same query.
        if (decoded.shopId && requireShopMembership !== false && !shopMembershipVerified) {
            activeMembership = await findActiveMembership(decoded.userId, decoded.shopId);
            if (!activeMembership) {
                throw new AppError('Shop access is not authorized for this account.', 403, 'GROWTH_OS_FORBIDDEN');
            }
        }

        const passwordChangeRequired = decoded.passwordChangeRequired === true;
        if (passwordChangeRequired) {
            if (isTemporaryPasswordExpired(decoded.temporaryPasswordExpiresAt)) {
                throw new AppError(
                    'Temporary password has expired. Request a new one.',
                    401,
                    'AUTH_TEMPORARY_PASSWORD_EXPIRED',
                );
            }
            if (!allowPasswordChange) {
                throw new AppError(
                    'Password change required before continuing.',
                    403,
                    'AUTH_PASSWORD_CHANGE_REQUIRED',
                );
            }
        } else if (allowPasswordChange) {
            throw new AppError(
                'Password change session is required.',
                401,
                'AUTH_PASSWORD_CHANGE_SESSION_REQUIRED',
            );
        }

        // 5. Attach user data to request
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            shopId: decoded.shopId,
            exp: decoded.exp, // needed for logout/blacklist TTL
            // This claim is issued only after the TOTP login step. A signed
            // token without it is intentionally not sufficient for privileged
            // Growth OS roles.
            mfaVerified: decoded.mfaVerified === true,
            bootstrapOperator: decoded.bootstrapOperator === true,
            passwordChangeRequired,
            temporaryPasswordExpiresAt: decoded.temporaryPasswordExpiresAt || null,
            // ADR M-004: present only for native-issued tokens; undefined for
            // every web token, exactly like decoded.sid itself.
            sid: decoded.sid || undefined,
            role: activeMembership?.role,
        };
        req.activeMembership = activeMembership;
        req.shop = activeMembership?.shop;
        req.userRole = activeMembership?.role;

        next();
    } catch (error) {
        if (error instanceof AppError) {
            next(error);
        } else {
            next(new AppError('Authentication service is temporarily unavailable. Please retry.', 503, 'AUTH_SERVICE_UNAVAILABLE'));
        }
    }
};

// Bare `authenticate` remains an Express middleware. Passing one options object
// returns an explicitly configured middleware for recovery/global identities.
function authenticate(optionsOrReq, res, next) {
    if (arguments.length <= 1) {
        return (req, response, callback) => authenticateRequest(
            req,
            response,
            callback,
            optionsOrReq || {},
        );
    }
    return authenticateRequest(optionsOrReq, res, next);
}

authenticate.withOptions = (options = {}) => (req, res, next) => authenticateRequest(
    req,
    res,
    next,
    options,
);

const authenticateForPasswordChange = (req, res, next) => authenticateRequest(
    req,
    res,
    next,
    { allowPasswordChange: true },
);

/**
 * Block API access for suspended shops.
 * Caches subscription status for 60 seconds to avoid a DB hit on every request.
 * Fails closed on DB/cache errors so an unavailable authorization store cannot
 * silently restore access to a suspended shop.
 */
const checkSubscriptionStatus = async (req, res, next) => {
    try {
        const shopId = req.user?.shopId;
        if (!shopId) return next();

        const cacheKey = 'subscription:status';
        let status = await cacheService.getForShop(shopId, cacheKey);

        if (status === null) {
            // Lazy-require to avoid circular dependency at module load time
            const { Subscription } = require('../modules/entities');
            const subscription = await Subscription.findOne({
                where: { shop_id: shopId },
                attributes: ['status']
            });
            status = subscription?.status || 'active';
            await cacheService.setForShop(shopId, cacheKey, status, 60);
        }

        if (status === 'suspended') {
            return next(new AppError(
                'Your subscription is suspended due to an unpaid invoice. Please visit Billing to resolve.',
                402
            ));
        }

        next();
    } catch (err) {
        // Authorization state is security-sensitive. Return a temporary failure
        // and let the caller retry instead of treating an unavailable store as
        // proof that the shop is active.
        next(new AppError('Subscription status is temporarily unavailable. Please retry.', 503));
    }
};

module.exports = { authenticate, authenticateForPasswordChange, checkSubscriptionStatus };
