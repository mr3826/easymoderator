const { User, Shop, UserShop, Tenant, PasswordResetToken } = require('../entities');
const { Op } = require('sequelize');
const { hashPassword, comparePassword } = require('../../utils/password.util');
const { generateAccessToken, generateRefreshToken } = require('../../utils/jwt.util');
const { sequelize } = require('../../utils/database/database-setup');
const { AppError } = require('../../utils/AppError');
const { getRedisClient } = require('../../utils/redis-client');
const config = require('../../config/config');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const emailService = require('../../utils/email.service');
const { passwordResetEmail } = require('../../utils/email-templates/password-reset');
const cacheService = require('../../utils/cache.service');
const { getOrigins, joinOrigin } = require('../../config/origins');
const { getTemporaryPasswordState } = require('./temporary-password');
const { invalidateUserSessions } = require('./session-invalidation.service');
const { findActiveMembership } = require('../../utils/active-membership');

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const getTemporaryPasswordAuthData = (user) => {
    const state = getTemporaryPasswordState(user);
    if (state.expired) {
        throw new AppError(
            'Temporary password has expired. Request a new one.',
            401,
            'AUTH_TEMPORARY_PASSWORD_EXPIRED',
        );
    }
    if (!state.required) return null;

    return {
        requiresPasswordChange: true,
        temporaryPasswordExpiresAt: state.expiresAt.toISOString(),
    };
};

// ── Token blacklist (Redis) ────────────────────────────────────────────

const TOKEN_BLACKLIST_PREFIX = 'token_blacklist:';

/**
 * Blacklist a JWT so it can no longer be used.
 * TTL is set to the token's remaining lifetime.
 */
const blacklistToken = async (token, decoded) => {
    const redis = getRedisClient();
    if (!redis) return; // graceful no-op if Redis unavailable in dev

    const now = Math.floor(Date.now() / 1000);
    const ttl = decoded.exp ? Math.max(300, decoded.exp - now) : 300;
    await redis.setex(`${TOKEN_BLACKLIST_PREFIX}${token}`, ttl, '1');
};

/**
 * Check whether a token has been blacklisted.
 */
const isTokenBlacklisted = async (token) => {
    const redis = getRedisClient();
    if (!redis) return false;

    const result = await redis.get(`${TOKEN_BLACKLIST_PREFIX}${token}`);
    return result === '1';
};

// ── Account lockout (Redis) ────────────────────────────────────────────

const LOGIN_ATTEMPTS_PREFIX = 'login_attempts:';
const LOGIN_LOCKOUT_PREFIX = 'login_lockout:';

/**
 * Check if an account is currently locked out.
 */
const checkAccountLockout = async (email) => {
    const redis = getRedisClient();
    if (!redis) return; // no lockout enforcement without Redis

    const locked = await redis.get(`${LOGIN_LOCKOUT_PREFIX}${email}`);
    if (locked) {
        const ttl = await redis.ttl(`${LOGIN_LOCKOUT_PREFIX}${email}`);
        throw new AppError(
            `Account temporarily locked due to too many failed login attempts. Try again in ${Math.ceil(ttl / 60)} minute(s).`,
            429
        );
    }
};

const LOGIN_LOCKOUT_COUNT_PREFIX = 'login_lockout_count:';
const MAX_LOCKOUT_MINUTES = 240; // 4-hour ceiling

/**
 * Record a failed login attempt. Locks the account after maxLoginAttempts
 * with exponential backoff: 15m → 30m → 60m → 120m → 240m (cap).
 */
const recordFailedLogin = async (email) => {
    const redis = getRedisClient();
    if (!redis) return;

    const key = `${LOGIN_ATTEMPTS_PREFIX}${email}`;
    const attempts = await redis.incr(key);

    // Set expiry on first attempt
    if (attempts === 1) {
        await redis.expire(key, config.loginLockoutMinutes * 60);
    }

    if (attempts >= config.maxLoginAttempts) {
        // Read how many times this account has been locked before
        const countKey = `${LOGIN_LOCKOUT_COUNT_PREFIX}${email}`;
        const lockCount = parseInt(await redis.get(countKey) || '0', 10);

        // Exponential backoff: base * 2^lockCount, capped at MAX_LOCKOUT_MINUTES
        const lockSeconds = Math.min(
            config.loginLockoutMinutes * Math.pow(2, lockCount),
            MAX_LOCKOUT_MINUTES
        ) * 60;

        await redis.setex(`${LOGIN_LOCKOUT_PREFIX}${email}`, lockSeconds, '1');
        await redis.setex(countKey, lockSeconds * 2, String(lockCount + 1));
        await redis.del(key);
    }
};

/**
 * Clear failed login attempts on successful login.
 */
const clearFailedLogins = async (email) => {
    const redis = getRedisClient();
    if (!redis) return;

    await redis.del(`${LOGIN_ATTEMPTS_PREFIX}${email}`);
    await redis.del(`${LOGIN_LOCKOUT_PREFIX}${email}`);
};

// ── Existing auth logic ────────────────────────────────────────────────

/**
 * Generate unique 5-6 character shop code — P2-10: crypto.randomBytes (not Math.random)
 */
const generateUniqueShopCode = async () => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    let code;
    let isUnique = false;

    while (!isUnique) {
        const length = crypto.randomBytes(1)[0] % 2 === 0 ? 5 : 6;
        const bytes = crypto.randomBytes(length);
        code = '';
        for (let i = 0; i < length; i++) {
            code += characters.charAt(bytes[i] % characters.length);
        }

        const existingShop = await Shop.findOne({ where: { unique_code: code } });
        if (!existingShop) {
            isUnique = true;
        }
    }

    return code;
};

/**
 * Create user with first shop
 */
const createUserWithShop = async (userData) => {
    if (!Object.prototype.hasOwnProperty.call(userData, 'accepted_terms') || userData.accepted_terms !== true) {
        throw new AppError('You must accept the terms and conditions', 400);
    }

    const transaction = await sequelize.transaction();

    try {
        const { email, password, full_name, phone, shop_name } = userData;

        // Check if user already exists
        const existingUser = await User.findOne({ where: { email } });
        if (existingUser) {
            throw new AppError('User with this email already exists', 400);
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const user = await User.create({
            email,
            password: hashedPassword,
            full_name,
            phone
        }, { transaction });

        const tenantName = shop_name || full_name || email.split('@')[0] || 'Default Tenant';

        // Create tenant
        const tenant = await Tenant.create({
            name: tenantName
        }, { transaction });

        // Generate unique shop code
        const shopCode = await generateUniqueShopCode();

        const resolvedShopName = shop_name || full_name || 'My Shop';

        // Create shop
        const shop = await Shop.create({
            unique_code: shopCode,
            tenant_id: tenant.id,
            name: resolvedShopName,
            shop_name: resolvedShopName
        }, { transaction });

        // Create UserShop relationship with owner role
        await UserShop.create({
            user_id: user.id,
            shop_id: shop.id,
            role: 'owner',
            is_active: true
        }, { transaction });

        // Materialize the free entitlement with the account so the first
        // inbound conversation is metered instead of relying on a later lazy
        // read that could race or fail independently of signup.
        const { createDefaultSubscription } = require('../subscription/subscription.service');
        await createDefaultSubscription(shop.id, { transaction, emitEvent: false });

        await transaction.commit();

        // Set the first shop as last logged shop
        await user.update({ last_logged_shop_id: shop.id });

        // Generate tokens with shopId and token_version included
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            shopId: shop.id,
            tokenVersion: user.token_version,
            mfaVerified: false,
        });
        const refreshToken = generateRefreshToken({
            userId: user.id,
            tokenVersion: user.token_version,
            mfaVerified: false,
        });

        // Hash and save refresh token using SHA-256 (not bcrypt - too expensive for high-entropy tokens)
        const hashedRefreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await user.update({ refresh_token: hashedRefreshToken });

        // Return user data without password
        const userResponse = {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            phone: user.phone,
            profile_picture: user.profile_picture
        };

        const currentShop = {
            id: shop.id,
            unique_code: shop.unique_code,
            shop_name: shop.shop_name,
            role: 'owner'
        };

        try {
            require('../analytics/funnel-events.service')
                .recordInternalFunnelEvent({
                    event: 'signup_completed',
                    userId: user.id,
                    shopId: shop.id,
                    onceKey: user.id,
                    metadata: { source: 'backend_signup' },
                })
                .catch(() => {});
            require('../analytics/crm-leads.service')
                .recordCrmLead({
                    source: 'signup',
                    userId: user.id,
                    shopId: shop.id,
                    resourceId: user.id,
                    leadSource: 'self_signup',
                    status: 'signup_completed',
                    nextAction: 'Day 1/3/7/12 founder activation follow-up sequence',
                    activationStage: 'signup_completed',
                    metadata: { shop_name: resolvedShopName },
                })
                .catch(() => {});
        } catch (_) { /* lead/funnel logging must never block signup */ }

        return {
            user: userResponse,
            currentShop,
            allShops: [currentShop],
            accessToken,
            refreshToken
        };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

/**
 * True when the user currently holds an active Growth OS internal role.
 * Used solely to allow shop-less sign-in/refresh for internal staff accounts.
 * This is NOT an authorization decision: Growth OS API requests are still
 * authorized per-request by the strict Growth OS middleware. Failing any
 * lookup returns an unavailable state and never grants a session.
 */
const getActiveGrowthOsRole = async (userId) => {
    if (!userId) return false;
    try {
        const { GrowthOsUserRole } = require('../entities');
        return await GrowthOsUserRole.findOne({
            attributes: ['id'],
            where: {
                user_id: userId,
                is_active: true,
                revoked_at: { [Op.is]: null },
            },
        });
    } catch (_error) {
        return undefined;
    }
};

// The one-time seed account must be able to complete password rotation and MFA
// enrollment before it receives its first Growth OS role. This marker is set
// only by the protected seed workflow and cleared transactionally by the
// canonical first-role grant. It is not a Growth OS authorization decision.
const isInitialGrowthBootstrapUser = (user) => user?.settings?.internal_growth_bootstrap === true;

const hasActiveGrowthOsRole = async (userId) => Boolean(await getActiveGrowthOsRole(userId));

/**
 * Verify credentials (lockout + password + Growth OS role lookup + temporary
 * password state + TOTP gate) and resolve which shop a successful login lands
 * in. Extracted out of authenticateUser so a second caller (native auth, ADR
 * M-004) reuses the exact same password/lockout/2FA logic without inheriting
 * authenticateUser's token issuance and single web refresh-token slot.
 *
 * authenticateUser below calls it and then does exactly what it always did
 * with the result, so its external behaviour is unchanged.
 *
 * Returns either { requires2fa: true, tempToken, ...temporaryPasswordAuthData }
 * or { user, loggedShopId, isGrowthOsUser, temporaryPasswordAuthData }.
 */
const resolveAuthenticatedUser = async (email, password) => {
    // Check if account is locked
    await checkAccountLockout(email);

    // Find user
    const user = await User.findOne({
        where: { email },
        include: [{
            model: Shop,
            as: 'shops',
            through: {
                attributes: ['role', 'is_active'],
                where: { is_active: true }
            },
            where: { is_active: true },
            required: false,
        }]
    });

    if (!user) {
        await recordFailedLogin(email);
        throw new AppError('Invalid email or password', 401);
    }

    // Compare password
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
        await recordFailedLogin(email);
        throw new AppError('Invalid email or password', 401);
    }

    // Successful login — clear any failed attempt counters
    await clearFailedLogins(email);

    const activeGrowthOsRole = await getActiveGrowthOsRole(user.id);
    if (activeGrowthOsRole === undefined) {
        throw new AppError('Unable to verify internal access role. Please retry.', 503, 'AUTH_ROLE_LOOKUP_UNAVAILABLE');
    }
    const isGrowthOsUser = Boolean(activeGrowthOsRole);
    const temporaryPasswordAuthData = getTemporaryPasswordAuthData(user);

    // Determine which shop to log into. Users with no active shop membership
    // may only obtain a session when they hold an active Growth OS internal
    // role; the token then carries a null shopId, which every shop-scoped
    // merchant route rejects on scope. Everyone else keeps the historical
    // 403 behaviour unchanged.
    // This boundary runs BEFORE the 2FA challenge: an account that can never
    // obtain a session (e.g. a suspended operator whose role was revoked)
    // must not receive a fresh temp token merely for knowing the password.
    if (!isGrowthOsUser
        && !isInitialGrowthBootstrapUser(user)
        && (!user.shops || user.shops.length === 0)) {
        const hasMembership = await UserShop.findOne({
            attributes: ['id'],
            where: { user_id: user.id },
        });
        if (hasMembership) {
            await recordFailedLogin(email);
            throw new AppError('Invalid email or password', 401);
        }
    }

    if (!isGrowthOsUser
        && !isInitialGrowthBootstrapUser(user)
        && (!user.shops || user.shops.length === 0)) {
        throw new AppError('User has no associated shops', 403);
    }

    // 2FA check — if enabled, return a short-lived temp token instead of full JWT
    if (user.settings?.totp_enabled) {
        const { saveTempToken } = require('./totp.service');
        const tempToken = crypto.randomBytes(32).toString('hex');
        await saveTempToken(user.id, tempToken, user.token_version);
        return {
            requires2fa: true,
            tempToken,
            ...(temporaryPasswordAuthData || {}),
        };
    }

    // If user has last_logged_shop_id and it's still accessible, use it
    let loggedShopId = null;
    if (!isGrowthOsUser && user.shops && user.shops.length > 0) {
        if (user.last_logged_shop_id) {
            const hasAccessToLastShop = user.shops.some(shop => shop.id === user.last_logged_shop_id);
            if (hasAccessToLastShop) {
                loggedShopId = user.last_logged_shop_id;
            }
        }

        // Otherwise, use the first shop (or first owner shop if available)
        if (!loggedShopId) {
            const ownerShop = user.shops.find(shop => shop.UserShop.role === 'owner');
            loggedShopId = ownerShop ? ownerShop.id : user.shops[0].id;
        }

        // Update last logged shop
        await user.update({ last_logged_shop_id: loggedShopId });
    }

    return { user, loggedShopId, isGrowthOsUser, temporaryPasswordAuthData };
};

/**
 * Authenticate user (with lockout check)
 */
const authenticateUser = async (email, password) => {
    const resolved = await resolveAuthenticatedUser(email, password);
    if (resolved.requires2fa) {
        return resolved;
    }
    const { user, loggedShopId, temporaryPasswordAuthData } = resolved;

    // Generate tokens with shopId and token_version included
    const accessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
        shopId: loggedShopId,
        tokenVersion: user.token_version,
        mfaVerified: false,
        bootstrapOperator: isInitialGrowthBootstrapUser(user),
        ...(temporaryPasswordAuthData
            ? {
                passwordChangeRequired: true,
                temporaryPasswordExpiresAt: temporaryPasswordAuthData.temporaryPasswordExpiresAt,
            }
            : {}),
    });
    const refreshToken = generateRefreshToken({
        userId: user.id,
        tokenVersion: user.token_version,
        mfaVerified: false,
        bootstrapOperator: isInitialGrowthBootstrapUser(user),
        ...(temporaryPasswordAuthData
            ? {
                passwordChangeRequired: true,
                temporaryPasswordExpiresAt: temporaryPasswordAuthData.temporaryPasswordExpiresAt,
            }
            : {}),
    });

    // Hash and save refresh token using SHA-256 (not bcrypt)
    const hashedRefreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await user.update({ refresh_token: hashedRefreshToken });

    // Get the logged shop details
    const loggedShop = loggedShopId
        ? user.shops.find(shop => shop.id === loggedShopId)
        : null;

    // Return user data without password
    const userResponse = {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        profile_picture: user.profile_picture
    };

    const currentShop = loggedShop
        ? {
            id: loggedShop.id,
            unique_code: loggedShop.unique_code,
            shop_name: loggedShop.shop_name,
            role: loggedShop.UserShop.role
        }
        : null;

    return {
        user: userResponse,
        currentShop,
        allShops: user.shops.map(shop => ({
            id: shop.id,
            unique_code: shop.unique_code,
            shop_name: shop.shop_name,
            role: shop.UserShop.role
        })),
        accessToken,
        refreshToken,
        ...(temporaryPasswordAuthData || {}),
    };
};

/**
 * Complete the forced change for a temporary invite/reset password. The
 * authenticated temporary session is the only caller allowed to reach this
 * route; changing the password also invalidates every existing session.
 */
const changeTemporaryPassword = async (userId, currentPassword, newPassword) => {
    const t = await sequelize.transaction();
    try {
        const user = await User.findByPk(userId, {
            transaction: t,
            lock: t.LOCK?.UPDATE,
        });
        if (!user) {
            throw new AppError('Password change session is no longer valid.', 401, 'AUTH_PASSWORD_CHANGE_SESSION_INVALID');
        }

        const temporaryPasswordAuthData = getTemporaryPasswordAuthData(user);
        if (!temporaryPasswordAuthData) {
            throw new AppError(
                'Password change is not required for this account.',
                400,
                'AUTH_PASSWORD_CHANGE_NOT_REQUIRED',
            );
        }

        if (!(await comparePassword(currentPassword, user.password))) {
            throw new AppError('Current password is incorrect.', 401, 'AUTH_INVALID_CURRENT_PASSWORD');
        }
        if (await comparePassword(newPassword, user.password)) {
            throw new AppError('Choose a password different from the temporary password.', 400, 'AUTH_PASSWORD_MUST_DIFFER');
        }

        await user.update({
            password: await hashPassword(newPassword),
            must_change_password: false,
            temporary_password_expires_at: null,
        }, { transaction: t });

        await invalidateUserSessions(userId, { transaction: t });
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    return { success: true };
};

/**
 * Request a password reset email.
 * Generates a cryptographically random one-time token, stores its SHA-256 hash
 * in the database, and emails the raw token in a reset link.
 */
const requestPasswordReset = async (email) => {
    const user = await User.findOne({ where: { email } });
    if (!user) {
        // Simulate email-send latency to prevent timing-based email enumeration
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        return { sent: false };
    }

    // Invalidate any existing unused tokens for this user
    await PasswordResetToken.destroy({
        where: { user_id: user.id, used_at: null },
    });

    // Generate one-time token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

    await PasswordResetToken.create({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
    });

    const resetUrl = joinOrigin(
        getOrigins().app,
        `/reset-password?token=${encodeURIComponent(rawToken)}`,
    );

    const { subject, html, text } = passwordResetEmail(resetUrl);
    await emailService.sendEmail({ to: user.email, subject, html, text });

    return { sent: true };
};

/**
 * Reset password using a one-time token.
 * Looks up by SHA-256 hash, verifies it is unused and not expired,
 * then atomically marks the token used and updates the password.
 */
const resetPassword = async (rawToken, newPassword) => {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const hashedPassword = await hashPassword(newPassword);

    let resetUserId;
    const t = await sequelize.transaction();
    try {
        const record = await PasswordResetToken.findOne({
            where: {
                token_hash: tokenHash,
                used_at: null,
                expires_at: { [Op.gt]: new Date() },
            },
            transaction: t,
        });

        if (!record) {
            throw new AppError('Invalid or expired reset token', 400);
        }
        resetUserId = record.user_id;

        // The conditional UPDATE is the one-time claim. Two concurrent
        // requests may both read the unused row, but only one can change it
        // while used_at is still NULL; the other receives zero affected rows.
        const [claimedCount] = await PasswordResetToken.update(
            { used_at: new Date() },
            {
                where: {
                    id: record.id,
                    token_hash: tokenHash,
                    used_at: null,
                    expires_at: { [Op.gt]: new Date() },
                },
                transaction: t,
            },
        );
        if (claimedCount !== 1) {
            throw new AppError('Invalid or expired reset token', 400);
        }

        const user = await User.findByPk(record.user_id, { transaction: t });
        if (!user) {
            throw new AppError('Invalid or expired reset token', 400);
        }

        // Update password and increment token_version in the same transaction
        // as the one-time claim. Incrementing token_version invalidates all
        // existing access tokens.
        await user.update({
            password: hashedPassword,
            refresh_token: null,
            token_version: sequelize.literal('token_version + 1'),
            must_change_password: false,
            temporary_password_expires_at: null,
        }, { transaction: t });
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }

    // Invalidate the token_version cache entry so the next request hits the DB
    // and picks up the new version immediately, rather than serving a stale hit
    // that would allow the old token to pass for up to 60 more seconds.
    await cacheService.delete(`user:${resetUserId}:token_version`);

    return { success: true };
};

/**
 * Validate refresh token and generate new access token
 */
const clearStaleShopSession = async (user) => {
    await sequelize.transaction(async (transaction) => {
        await invalidateUserSessions(user.id, { transaction });
        await user.update({ last_logged_shop_id: null }, { transaction });
    });
};

const validateRefreshToken = async (refreshToken) => {
    const { verifyRefreshToken } = require('../../utils/jwt.util');

    try {
        // Verify refresh token
        const decoded = verifyRefreshToken(refreshToken);

        // Find user
        const user = await User.findByPk(decoded.userId);
        if (!user || !user.refresh_token) {
            throw new AppError('Invalid refresh token', 401);
        }

        // Reject if token was issued before a password reset (tokenVersion mismatch)
        if (decoded.tokenVersion !== user.token_version) {
            throw new AppError('Invalid refresh token', 401);
        }

        // A temporary session may only be used to complete the forced change;
        // it must never be extended through the refresh-token path.
        if (getTemporaryPasswordState(user).required) {
            throw new AppError('Invalid refresh token', 401);
        }

        // Compare refresh token with stored hash using SHA-256 (not bcrypt - too expensive)
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        if (tokenHash !== user.refresh_token) {
            throw new AppError('Invalid refresh token', 401);
        }

        const selectedShopId = user.last_logged_shop_id || null;

        // Refresh tokens can outlive a UserShop deactivation. Merchant data
        // requires an active membership; an internal Growth OS role is not a
        // substitute for merchant scope. Clean stale context and credentials
        // atomically before rejecting the refresh.
        if (selectedShopId) {
            const activeMembership = await findActiveMembership(user.id, selectedShopId);

            if (!activeMembership) {
                await clearStaleShopSession(user);
                throw new AppError('Invalid refresh token', 401);
            }
        } else {
            const activeGrowthOsRole = await getActiveGrowthOsRole(user.id);
            if (activeGrowthOsRole === undefined) {
                throw new AppError('Unable to verify internal access role. Please retry.', 503, 'AUTH_ROLE_LOOKUP_UNAVAILABLE');
            }
            if (!activeGrowthOsRole && !isInitialGrowthBootstrapUser(user)) {
                throw new AppError('No active shop session found. Please login again.', 401);
            }
        }

        // Rotate the refresh token so a stolen token cannot be replayed after
        // a successful refresh.
        const nextRefreshToken = generateRefreshToken({
            userId: user.id,
            tokenVersion: user.token_version,
            mfaVerified: decoded.mfaVerified === true,
        });
        const nextRefreshTokenHash = crypto
            .createHash('sha256')
            .update(nextRefreshToken)
            .digest('hex');
        await user.update({ refresh_token: nextRefreshTokenHash });

        // Generate new access token with shopId and token_version
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            shopId: selectedShopId,
            tokenVersion: user.token_version,
            mfaVerified: decoded.mfaVerified === true,
            bootstrapOperator: isInitialGrowthBootstrapUser(user),
        });

        return {
            accessToken,
            refreshToken: nextRefreshToken,
            userId: user.id,
            shopId: user.last_logged_shop_id,
        };
    } catch (error) {
        if (error?.code === 'AUTH_ROLE_LOOKUP_UNAVAILABLE') throw error;
        throw new AppError('Invalid or expired refresh token', 401);
    }
};

/**
 * Get auth context for current user
 */
const getAuthContext = async (userId, shopIdFromToken) => {
    const user = await User.findOne({
        where: { id: userId },
        include: [{
            model: Shop,
            as: 'shops',
            through: {
                attributes: ['role', 'is_active'],
                where: { is_active: true }
            },
            where: { is_active: true },
            required: false,
        }]
    });

    if (!user) throw new AppError('User has no associated shops', 403);

    const userResponse = {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        profile_picture: user.profile_picture,
        // EasyModerator operator role (null for normal merchants). Read by the
        // frontend PlatformAdminRoute guard to gate the /admin section.
        platform_role: user.platform_role || null
    };

    // Internal Growth users intentionally have no merchant shop membership.
    // Preserve the legacy auth shape while returning a null shop context.
    const activeGrowthOsRole = await getActiveGrowthOsRole(user.id);
    if (activeGrowthOsRole === undefined) {
        throw new AppError('Unable to verify internal access role. Please retry.', 503, 'AUTH_ROLE_LOOKUP_UNAVAILABLE');
    }
    if (activeGrowthOsRole) {
        return { user: userResponse, currentShop: null, allShops: [] };
    }
    if (!user.shops || user.shops.length === 0) {
        if (isInitialGrowthBootstrapUser(user)) {
            return { user: userResponse, currentShop: null, allShops: [] };
        }
        throw new AppError('User has no associated shops', 403);
    }

    let resolvedShopId = shopIdFromToken || user.last_logged_shop_id;
    if (resolvedShopId && !user.shops.some(shop => shop.id === resolvedShopId)) {
        resolvedShopId = null;
    }

    if (!resolvedShopId) {
        const ownerShop = user.shops.find(shop => shop.UserShop.role === 'owner');
        resolvedShopId = ownerShop ? ownerShop.id : user.shops[0].id;
    }

    const currentShop = user.shops.find(shop => shop.id === resolvedShopId) || user.shops[0];

    return {
        user: userResponse,
        currentShop: {
            id: currentShop.id,
            unique_code: currentShop.unique_code,
            shop_name: currentShop.shop_name,
            role: currentShop.UserShop.role
        },
        allShops: user.shops.map(shop => ({
            id: shop.id,
            unique_code: shop.unique_code,
            shop_name: shop.shop_name,
            role: shop.UserShop.role
        }))
    };
};

/**
 * Logout — blacklist the access token and clear the stored refresh token
 */
const logoutUser = async (accessToken, decoded) => {
    // Blacklist the access token so it cannot be reused
    await blacklistToken(accessToken, decoded);

    // Clear the stored refresh token for this user
    const user = await User.findByPk(decoded.userId);
    if (user) {
        await user.update({ refresh_token: null });
    }
};

module.exports = {
    createUserWithShop,
    authenticateUser,
    changeTemporaryPassword,
    getTemporaryPasswordAuthData,
    requestPasswordReset,
    resetPassword,
    validateRefreshToken,
    getAuthContext,
    logoutUser,
    isTokenBlacklisted,
    generateUniqueShopCode,
    hasActiveGrowthOsRole,
    getActiveGrowthOsRole,
    isInitialGrowthBootstrapUser,
    invalidateUserSessions,
    // ADR M-004: reused (not duplicated) by the native auth module.
    resolveAuthenticatedUser,
    blacklistToken,
};
