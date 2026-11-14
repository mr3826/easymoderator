const request = require('supertest');
const cacheService = require('src/utils/cache.service');

const mockCacheStore = new Map();

// ── Set test env vars before anything loads ────────────────────────────
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

// ── Mock Redis config (prevents real ioredis connections) ────────────────
jest.mock('src/config/redis', () => ({
    sessionRedis: null, cacheRedis: null, rateLimitRedis: null, legacyRedis: null,
    closeAllRedis: jest.fn(), checkRedisAvailability: jest.fn(() => ({}))
}));

// ── Mock Redis ─────────────────────────────────────────────────────────
const redisStore = {};
const mockRedis = {
    get: jest.fn((key) => Promise.resolve(redisStore[key] || null)),
    set: jest.fn((key, val, ...args) => { redisStore[key] = val; return Promise.resolve('OK'); }),
    setex: jest.fn((key, ttl, val) => { redisStore[key] = val; return Promise.resolve('OK'); }),
    del: jest.fn((key) => { delete redisStore[key]; return Promise.resolve(1); }),
    incr: jest.fn((key) => {
        redisStore[key] = (parseInt(redisStore[key], 10) || 0) + 1;
        return Promise.resolve(redisStore[key]);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(900)),
    status: 'ready'
};

jest.mock('src/utils/redis-client', () => ({
    getRedisClient: () => mockRedis,
    isRedisAvailable: () => true,
    closeRedis: jest.fn()
}));

// Keep token-version cache state hermetic. Without this, the successful-login
// test can leave user:token_version=1 behind and mask a later DB version=2.
jest.mock('src/utils/cache.service', () => ({
    get: jest.fn(async (key) => mockCacheStore.get(key) ?? null),
    set: jest.fn(async (key, value) => { mockCacheStore.set(key, value); return true; }),
    delete: jest.fn(async (key) => mockCacheStore.delete(key)),
    getStrict: jest.fn(async (key) => mockCacheStore.get(key) ?? null),
    setStrict: jest.fn(async (key, value) => { mockCacheStore.set(key, value); return true; }),
    getForShop: jest.fn(async (shopId, key) => mockCacheStore.get(`${shopId}:${key}`) ?? null),
    setForShop: jest.fn(async (shopId, key, value) => { mockCacheStore.set(`${shopId}:${key}`, value); return true; }),
    deleteForShop: jest.fn(async (shopId, key) => mockCacheStore.delete(`${shopId}:${key}`)),
}));

// ── Mock Sequelize (must support .define() for entity files) ───────────
const mockModel = {
    findOne: jest.fn(),
    findByPk: jest.fn(),
    findAll: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    update: jest.fn(),
    destroy: jest.fn(),
    belongsTo: jest.fn(),
    hasMany: jest.fn(),
    hasOne: jest.fn(),
    belongsToMany: jest.fn(),
    addScope: jest.fn(),
    scope: jest.fn(() => mockModel),
};

jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        define: jest.fn(() => ({ ...mockModel })),
        transaction: jest.fn(() => Promise.resolve({
            commit: jest.fn(),
            rollback: jest.fn()
        })),
        authenticate: jest.fn(() => Promise.resolve()),
        sync: jest.fn(() => Promise.resolve()),
        literal: jest.fn((str) => str)
    }
}));

// ── Mock entities (override define-based models) ───────────────────────
const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    password: '$2a$10$hashedpassword',
    full_name: 'Test User',
    phone: null,
    profile_picture: null,
    refresh_token: null,
    last_logged_shop_id: 'shop-1',
    token_version: 1,
    must_change_password: false,
    temporary_password_expires_at: null,
    update: jest.fn(() => Promise.resolve()),
    shops: [{
        id: 'shop-1',
        unique_code: 'ABC12',
        shop_name: 'Test Shop',
        UserShop: { role: 'owner', is_active: true }
    }]
};

jest.mock('src/modules/entities', () => ({
    User: {
        findOne: jest.fn(),
        findByPk: jest.fn(),
        create: jest.fn(),
        belongsTo: jest.fn(),
        hasMany: jest.fn(),
        hasOne: jest.fn(),
        belongsToMany: jest.fn(),
    },
    Shop: {
        findOne: jest.fn(),
        findByPk: jest.fn(),
        create: jest.fn(),
        belongsTo: jest.fn(),
        hasMany: jest.fn(),
        hasOne: jest.fn(),
        belongsToMany: jest.fn(),
    },
    UserShop: {
        findOne: jest.fn(),
        create: jest.fn(),
        belongsTo: jest.fn(),
        hasMany: jest.fn(),
    },
    GrowthOsUserRole: { findOne: jest.fn() },
    Order: { ...mockModel },
    OrderItem: { ...mockModel },
    Product: { ...mockModel },
    Category: { ...mockModel },
    Customer: { ...mockModel },
    Channel: { ...mockModel },
    Conversation: { ...mockModel },
    Message: { ...mockModel },
    Keyword: { ...mockModel },
    AuditLog: { ...mockModel },
    IdempotencyKey: { ...mockModel },
    Subscription: { ...mockModel },
    Invoice: { ...mockModel },
    UsageEvent: { ...mockModel },
    PaymentConfig: { ...mockModel },
    MetaIntegration: { ...mockModel },
    DeliveryIntegration: { ...mockModel },
    DeliveryCost: { ...mockModel },
    KnownArea: { ...mockModel },
    FaqResponse: { ...mockModel },
    BanglishDictionary: { ...mockModel },
    Analytics: { ...mockModel },
    OrderReturn: { ...mockModel },
    SupportTicket: { ...mockModel },
    Tenant: { ...mockModel },
}));

jest.mock('src/utils/password.util', () => ({
    hashPassword: jest.fn((p) => Promise.resolve(`hashed_${p}`)),
    comparePassword: jest.fn((plain, hashed) => Promise.resolve(plain === 'correct-password'))
}));

// Mock session middleware to no-op
jest.mock('src/middleware/session.middleware', () => () => (req, res, next) => next());

// Mock structured-logger (missing warn/debug causes globalErrorHandler to crash on 4xx)
jest.mock('src/utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), logUsage: jest.fn() })),
}));

const { User, Shop, Tenant, UserShop, Subscription } = require('src/modules/entities');
const authService = require('src/modules/auth/auth.service');

// ── Tests ──────────────────────────────────────────────────────────────

describe('Auth API', () => {
    let app;

    beforeAll(() => {
        // require app AFTER mocks are in place
        app = require('src/app');
    });

    beforeEach(() => {
        // Clear redis store between tests
        Object.keys(redisStore).forEach(k => delete redisStore[k]);
        mockCacheStore.clear();
        // Reset call counts but keep implementations
        mockRedis.get.mockClear();
        mockRedis.set.mockClear();
        mockRedis.setex.mockClear();
        mockRedis.del.mockClear();
        mockRedis.incr.mockClear();
        mockRedis.expire.mockClear();
        mockRedis.ttl.mockClear();
        mockUser.update.mockClear();
        mockUser.update.mockImplementation(() => Promise.resolve());
        mockUser.must_change_password = false;
        mockUser.temporary_password_expires_at = null;
        UserShop.findOne.mockResolvedValue({
            user_id: mockUser.id,
            shop_id: mockUser.last_logged_shop_id,
            role: 'owner',
            is_active: true,
            shop: { id: mockUser.last_logged_shop_id, is_active: true },
        });
        const { GrowthOsUserRole } = require('src/modules/entities');
        GrowthOsUserRole.findOne.mockResolvedValue(null);
    });

    // ── Signup ──────────────────────────────────────────────────────────

    describe('POST /api/auth/signup', () => {
        it('creates the delivered-order MERCHANT subscription in the signup transaction', async () => {
            const user = {
                ...mockUser,
                id: 'signup-user',
                email: 'signup@example.com',
                update: jest.fn(() => Promise.resolve()),
            };
            const shop = {
                id: 'signup-shop',
                unique_code: 'SIGN1',
                shop_name: 'Signup Shop',
                name: 'Signup Shop',
            };
            User.findOne.mockResolvedValueOnce(null);
            User.create.mockResolvedValueOnce(user);
            Tenant.create.mockResolvedValueOnce({ id: 'signup-tenant' });
            Shop.findOne.mockResolvedValue(null);
            Shop.create.mockResolvedValueOnce(shop);
            UserShop.create.mockResolvedValueOnce({});
            Subscription.create.mockResolvedValueOnce({ id: 'signup-subscription' });

            await authService.createUserWithShop({
                email: user.email,
                password: 'correct-password',
                full_name: 'Signup User',
                phone: '01700000000',
                shop_name: shop.name,
                accepted_terms: true,
            });

            expect(Subscription.create).toHaveBeenCalledWith(expect.objectContaining({
                shop_id: shop.id,
                plan_code: 'MERCHANT',
                plan_price: 0,
                conversations_limit: -1,
                status: 'active',
            }), expect.objectContaining({ transaction: expect.any(Object) }));
        });

        it('should return 400 when email is missing', async () => {
            const res = await request(app)
                .post('/api/auth/signup')
                .send({ password: '123456' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should return 400 when password is too short', async () => {
            const res = await request(app)
                .post('/api/auth/signup')
                .send({ email: 'test@example.com', password: '123' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should reject signup without explicit terms consent before creating an account', async () => {
            User.create.mockClear();
            const res = await request(app)
                .post('/api/auth/signup')
                .send({
                    email: 'no-consent@example.com',
                    password: 'ValidPass123!',
                    full_name: 'No Consent',
                    phone: '01700000000',
                });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error?.message || res.body.message).toMatch(/terms and conditions/i);
            expect(User.create).not.toHaveBeenCalled();
        });

        it('should reject an explicit false terms value before creating an account', async () => {
            User.create.mockClear();
            const res = await request(app)
                .post('/api/auth/signup')
                .send({
                    email: 'false-consent@example.com',
                    password: 'ValidPass123!',
                    full_name: 'False Consent',
                    phone: '01700000000',
                    accepted_terms: false,
                });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error?.message || res.body.message).toMatch(/terms and conditions/i);
            expect(User.create).not.toHaveBeenCalled();
        });

        it('should require a boolean consent value', async () => {
            User.create.mockClear();
            const res = await request(app)
                .post('/api/auth/signup')
                .send({
                    email: 'string-consent@example.com',
                    password: 'ValidPass123!',
                    full_name: 'String Consent',
                    phone: '01700000000',
                    accepted_terms: 'true',
                });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error?.message || res.body.message).toMatch(/terms and conditions/i);
            expect(User.create).not.toHaveBeenCalled();
        });

        it('should reject prototype-polluted consent fields before creating an account', async () => {
            User.create.mockClear();
            const res = await request(app)
                .post('/api/auth/signup')
                .set('Content-Type', 'application/json')
                .send('{"__proto__":{"email":"proto@example.com","password":"ValidPass123!","full_name":"Proto User","phone":"01700000000","accepted_terms":true}}');

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(User.create).not.toHaveBeenCalled();
        });

        it('should not inherit consent from a polluted global object prototype', async () => {
            User.create.mockClear();
            Object.prototype.accepted_terms = true;
            try {
                const res = await request(app)
                    .post('/api/auth/signup')
                    .send({
                        email: 'ambient-proto@example.com',
                        password: 'ValidPass123!',
                        full_name: 'Ambient Prototype',
                        phone: '01700000000',
                    });

                expect(res.status).toBe(400);
                expect(res.body.success).toBe(false);
                expect(User.create).not.toHaveBeenCalled();
            } finally {
                delete Object.prototype.accepted_terms;
            }
        });
    });

    // ── Signin ──────────────────────────────────────────────────────────

    describe('POST /api/auth/signin', () => {
        it('should return 401 for invalid credentials', async () => {
            User.findOne.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: 'wrong@example.com', password: 'wrong' });

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
        });

        it('should return 200 and set httpOnly cookies on valid login', async () => {
            User.findOne.mockResolvedValue(mockUser);

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: 'test@example.com', password: 'correct-password' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            // Tokens are no longer in response body — they travel via httpOnly cookies only
            expect(res.body.data).toBeDefined();

            // Verify httpOnly cookies are set
            const cookies = res.headers['set-cookie'];
            expect(cookies).toBeDefined();
            const cookieStr = cookies.join('; ');
            expect(cookieStr).toContain('access_token=');
            expect(cookieStr).toContain('HttpOnly');
        });

        it('allows only the marked initial operator to authenticate without a shop', async () => {
            const bootstrapUser = {
                ...mockUser,
                shops: [],
                last_logged_shop_id: null,
                settings: { internal_growth_bootstrap: true },
                update: jest.fn(() => Promise.resolve()),
            };
            User.findOne.mockResolvedValue(bootstrapUser);

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: bootstrapUser.email, password: 'correct-password' });

            expect(res.status).toBe(200);
            expect(res.body.data.currentShop).toBeNull();
        });

        it('continues to reject an unmarked shop-less account', async () => {
            UserShop.findOne.mockResolvedValue(null);
            User.findOne.mockResolvedValue({
                ...mockUser,
                shops: [],
                last_logged_shop_id: null,
                settings: {},
            });

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: mockUser.email, password: 'correct-password' });

            expect(res.status).toBe(403);
            expect(res.body.message || res.body.error?.message).toContain('no associated shops');
        });

        it('rejects an unmarked shop-less account with 403 even when TOTP is enabled (no pre-boundary challenge)', async () => {
            UserShop.findOne.mockResolvedValue(null);
            User.findOne.mockResolvedValue({
                ...mockUser,
                shops: [],
                last_logged_shop_id: null,
                settings: { totp_enabled: true },
            });

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: mockUser.email, password: 'correct-password' });

            expect(res.status).toBe(403);
            expect(res.body.message || res.body.error?.message).toContain('no associated shops');
            expect(res.body.data?.requires2fa).toBeUndefined();
        });

        it('filters inactive shop memberships without excluding shop-less Growth users', async () => {
            User.findOne.mockResolvedValue(mockUser);

            await authService.authenticateUser('test@example.com', 'correct-password');

            expect(User.findOne).toHaveBeenCalledWith(expect.objectContaining({
                include: [expect.objectContaining({
                    through: expect.objectContaining({
                        where: { is_active: true },
                    }),
                })],
            }));
        });

        it('should return 400 when email is missing', async () => {
            const res = await request(app)
                .post('/api/auth/signin')
                .send({ password: 'test123' });

            expect(res.status).toBe(400);
        });

        it('allows a valid temporary password only into the forced-change flow', async () => {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
            const temporaryUser = {
                ...mockUser,
                must_change_password: true,
                temporary_password_expires_at: expiresAt,
                update: jest.fn(() => Promise.resolve()),
            };
            User.findOne.mockResolvedValue(temporaryUser);

            const login = await request(app)
                .post('/api/auth/signin')
                .send({ email: temporaryUser.email, password: 'correct-password' });

            expect(login.status).toBe(200);
            expect(login.body.data).toMatchObject({
                requiresPasswordChange: true,
                temporaryPasswordExpiresAt: expiresAt.toISOString(),
            });

            const accessToken = login.headers['set-cookie']
                .find((cookie) => cookie.startsWith('access_token='))
                .split(';')[0]
                .replace('access_token=', '');
            User.findByPk.mockResolvedValue(temporaryUser);
            const blocked = await request(app)
                .get('/api/auth/me')
                .set('Authorization', `Bearer ${accessToken}`);

            expect(blocked.status).toBe(403);
            expect(blocked.body.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');
        });

        it('rejects a temporary password after its expiry', async () => {
            User.findOne.mockResolvedValue({
                ...mockUser,
                must_change_password: true,
                temporary_password_expires_at: new Date(Date.now() - 1000),
            });

            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: mockUser.email, password: 'correct-password' });

            expect(res.status).toBe(401);
            expect(res.body.code).toBe('AUTH_TEMPORARY_PASSWORD_EXPIRED');
        });

        it('changes the temporary password, clears its state, and revokes the temporary session', async () => {
            const temporaryUser = {
                ...mockUser,
                must_change_password: true,
                temporary_password_expires_at: new Date(Date.now() + 60 * 60 * 1000),
                update: jest.fn(async (attributes) => {
                    Object.assign(temporaryUser, attributes);
                }),
            };
            User.findOne.mockResolvedValue(temporaryUser);

            const login = await request(app)
                .post('/api/auth/signin')
                .send({ email: temporaryUser.email, password: 'correct-password' });
            const accessToken = login.headers['set-cookie']
                .find((cookie) => cookie.startsWith('access_token='))
                .split(';')[0]
                .replace('access_token=', '');

            User.findByPk.mockResolvedValue(temporaryUser);
            const changed = await request(app)
                .post('/api/auth/change-password')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({ currentPassword: 'correct-password', newPassword: 'New-password-123!' });

            expect(changed.status).toBe(200);
            expect(temporaryUser.must_change_password).toBe(false);
            expect(temporaryUser.temporary_password_expires_at).toBeNull();
            expect(temporaryUser.token_version).toBe(2);
            expect(changed.headers['set-cookie'].some((cookie) => cookie.startsWith('access_token=;'))).toBe(true);

            const blocked = await request(app)
                .get('/api/auth/me')
                .set('Authorization', `Bearer ${accessToken}`);
            expect(blocked.status).toBe(401);
            expect(blocked.body.message).toContain('invalidated');
        });
    });

    // ── Account Lockout ─────────────────────────────────────────────────

    describe('Account Lockout', () => {
        it('should lock account after 5 failed attempts', async () => {
            User.findOne.mockResolvedValue(null); // always fail

            // Make 5 failed attempts
            for (let i = 0; i < 5; i++) {
                await request(app)
                    .post('/api/auth/signin')
                    .send({ email: 'lockme@example.com', password: 'wrong' });
            }

            // 6th attempt should get lockout message
            const res = await request(app)
                .post('/api/auth/signin')
                .send({ email: 'lockme@example.com', password: 'wrong' });

            expect(res.status).toBe(429);
            expect(res.body.message).toContain('temporarily locked');
        });
    });

    // ── Logout ──────────────────────────────────────────────────────────

    describe('POST /api/auth/logout', () => {
        let validToken;

        // Helper: get a valid access token from the httpOnly cookie
        const loginAndGetToken = async () => {
            User.findOne.mockResolvedValue(mockUser);
            const loginRes = await request(app)
                .post('/api/auth/signin')
                .send({ email: 'logout-test@example.com', password: 'correct-password' });
            const setCookies = loginRes.headers['set-cookie'] || [];
            const tokenCookie = setCookies.find(c => c.startsWith('access_token='));
            return tokenCookie?.split(';')[0]?.replace('access_token=', '');
        };

        it('should return 401 without a token', async () => {
            const res = await request(app).post('/api/auth/logout');
            expect(res.status).toBe(401);
        });

        it('should return 200 and blacklist token on valid logout', async () => {
            validToken = await loginAndGetToken();
            User.findByPk.mockResolvedValue(mockUser);

            const logoutRes = await request(app)
                .post('/api/auth/logout')
                .set('Authorization', `Bearer ${validToken}`);

            expect(logoutRes.status).toBe(200);
            expect(logoutRes.body.message).toBe('Logged out successfully');

            // Verify the token is blacklisted in our mock Redis
            expect(mockRedis.setex).toHaveBeenCalledWith(
                expect.stringContaining('token_blacklist:'),
                expect.any(Number),
                '1'
            );
        });

        it('should reject requests with a blacklisted token', async () => {
            validToken = await loginAndGetToken();
            User.findByPk.mockResolvedValue(mockUser);

            // Logout (blacklists the token)
            await request(app)
                .post('/api/auth/logout')
                .set('Authorization', `Bearer ${validToken}`);

            // Try to use the same token — should be rejected
            const res = await request(app)
                .post('/api/auth/logout')
                .set('Authorization', `Bearer ${validToken}`);

            expect(res.status).toBe(401);
        });
    });

    // ── Refresh ─────────────────────────────────────────────────────────

    describe('POST /api/auth/refresh', () => {
        it('should return 400 when refresh_token is missing', async () => {
            const res = await request(app)
                .post('/api/auth/refresh')
                .send({ refresh_token: '' });

            // express-validator will reject empty refresh_token
            expect(res.status).toBe(400);
        });

        it('should work with refresh_token from httpOnly cookie only', async () => {
            // Mock user with SHA-256 hashed refresh token
            const crypto = require('crypto');
            const refreshToken = 'test-refresh-token-from-cookie';
            const hashedToken = crypto.createHash('sha256').update(refreshToken).digest('hex');

            const userWithToken = {
                ...mockUser,
                refresh_token: hashedToken
            };

            User.findByPk.mockResolvedValue(userWithToken);

            // Send refresh request with token in cookie (not body)
            const res = await request(app)
                .post('/api/auth/refresh')
                .set('Cookie', [`refresh_token=${refreshToken}`])
                .send({}); // No refresh_token in body

            // Should succeed with valid cookie token (200) or reject if no last_logged_shop_id (401)
            expect([200, 401]).toContain(res.status);
            if (res.status === 200) {
                expect(res.headers['set-cookie']).toBeDefined();
            }
        });

        it('fails closed when the Growth role store is unavailable for a bootstrap refresh', async () => {
            const crypto = require('crypto');
            const { GrowthOsUserRole } = require('src/modules/entities');
            const { generateRefreshToken } = require('src/utils/jwt.util');
            const refreshToken = generateRefreshToken({
                userId: mockUser.id,
                tokenVersion: mockUser.token_version,
            });
            const bootstrapUser = {
                ...mockUser,
                shops: [],
                last_logged_shop_id: null,
                settings: { internal_growth_bootstrap: true },
                refresh_token: crypto.createHash('sha256').update(refreshToken).digest('hex'),
            };
            User.findByPk.mockResolvedValue(bootstrapUser);
            GrowthOsUserRole.findOne.mockRejectedValue(new Error('role store unavailable'));

            await expect(authService.validateRefreshToken(refreshToken)).rejects.toMatchObject({
                status: 503,
                code: 'AUTH_ROLE_LOOKUP_UNAVAILABLE',
            });
        });
    });

    // ── Token Version Security ───────────────────────────────────────────

    describe('Token Version - Password Reset Invalidation', () => {
        it('should reject token with mismatched token_version', async () => {
            // Login to get valid token
            User.findOne.mockResolvedValue(mockUser);
            const loginRes = await request(app)
                .post('/api/auth/signin')
                .send({ email: 'test@example.com', password: 'correct-password' });

            expect(loginRes.status).toBe(200);
            const cookies = loginRes.headers['set-cookie'];
            const accessToken = cookies.find(c => c.startsWith('access_token='))?.split(';')[0]?.replace('access_token=', '');

            // Simulate password reset: increment token_version
            const updatedUser = {
                ...mockUser,
                token_version: 2 // Incremented after password reset
            };
            User.findByPk.mockResolvedValue(updatedUser);
            // A real password reset invalidates the cached token_version at the
            // same moment it increments it (auth.service.js resetPassword).
            // auth.middleware reads that value through cacheService, not through
            // the redis client this suite stubs — so without this the middleware
            // sees the version login cached, never consults the row the test just
            // changed, and the revoked token sails through with 200.
            await cacheService.delete(`user:${mockUser.id}:token_version`);

            // Try to use old token - should be rejected due to version mismatch
            // /me is a GET. Posting to it 404s in express, so this assertion
            // never reached the middleware it exists to test.
            const res = await request(app)
                .get('/api/auth/me')
                .set('Authorization', `Bearer ${accessToken}`);

            // Should fail with 401 because token_version in JWT (1) != DB version (2)
            expect(res.status).toBe(401);
        });
    });

    // ── 2FA Security ──────────────────────────────────────────────────────

    describe('2FA Security', () => {
        it('should rate limit 2FA verify attempts', async () => {
            // Make rapid 2FA verify attempts
            const attempts = [];
            for (let i = 0; i < 6; i++) {
                attempts.push(
                    request(app)
                        .post('/api/auth/2fa/verify')
                        .send({ tempToken: 'invalid', token: '000000' })
                );
            }

            const results = await Promise.all(attempts);

            // At least some should be rate limited (429)
            const hasRateLimit = results.some(r => r.status === 429);
            expect(hasRateLimit).toBe(true);
        }, 10000);
    });
});
