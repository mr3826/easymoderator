const request = require('supertest');

// ── Env vars ───────────────────────────────────────────────────────────────
process.env.NODE_ENV           = 'test';
process.env.JWT_ACCESS_SECRET  = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

// ── Mock Redis config (prevents real ioredis connections) ────────────────
jest.mock('src/config/redis', () => ({
    sessionRedis: null, cacheRedis: null, rateLimitRedis: null, legacyRedis: null,
    closeAllRedis: jest.fn(), checkRedisAvailability: jest.fn(() => ({}))
}));
jest.mock('src/jobs/message-queue', () => ({
    messageQueue: {
        on: jest.fn(),
        add: jest.fn().mockResolvedValue({ id: 'job-1' }),
        getJob: jest.fn().mockResolvedValue(null),
        getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
        getWaitingCount: jest.fn().mockResolvedValue(0),
        getActiveCount: jest.fn().mockResolvedValue(0),
        getFailedCount: jest.fn().mockResolvedValue(0),
        getDelayedCount: jest.fn().mockResolvedValue(0),
        close: jest.fn().mockResolvedValue(undefined),
    },
    connection: {},
    drainChannelJobs: jest.fn().mockResolvedValue({ removed: 0 }),
}));

// ── Mock Redis ─────────────────────────────────────────────────────────────
const redisStore = {};
const mockRedis = {
    get:    jest.fn((k)         => Promise.resolve(redisStore[k] || null)),
    set:    jest.fn((k, v)      => { redisStore[k] = v; return Promise.resolve('OK'); }),
    setex:  jest.fn((k, ttl, v) => { redisStore[k] = v; return Promise.resolve('OK'); }),
    del:    jest.fn((k)         => { delete redisStore[k]; return Promise.resolve(1); }),
    incr:   jest.fn((k)         => { redisStore[k] = (parseInt(redisStore[k], 10) || 0) + 1; return Promise.resolve(redisStore[k]); }),
    expire: jest.fn(()          => Promise.resolve(1)),
    ttl:    jest.fn(()          => Promise.resolve(900)),
    status: 'ready'
};
jest.mock('src/utils/redis-client', () => ({
    getRedisClient:   () => mockRedis,
    isRedisAvailable: () => true,
    closeRedis:       jest.fn()
}));

// ── Mock Sequelize ─────────────────────────────────────────────────────────
const mockModel = {
    findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])),
    create: jest.fn(), update: jest.fn(), destroy: jest.fn(),
    belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn(),
    addScope: jest.fn(), scope: jest.fn(function() { return this; }),
};
const mockTransaction = {
    LOCK: { UPDATE: 'UPDATE' },
    commit: jest.fn(),
    rollback: jest.fn(),
    afterCommit: jest.fn((callback) => callback()),
};
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        define:       jest.fn(() => ({ ...mockModel })),
        transaction:  jest.fn((callback) => typeof callback === 'function'
            ? Promise.resolve(callback(mockTransaction))
            : Promise.resolve(mockTransaction)),
        authenticate: jest.fn(() => Promise.resolve()),
        sync:         jest.fn(() => Promise.resolve()),
    },
    Op: {}
}));

// ── Mock entities ─────────────────────────────────────────────────────────
const mockShop = {
    id: 'shop-1',
    shop_name: 'Test Shop',
    settings: { ai: { automation_mode: 'DRAFT', confidence_threshold: 60 } },
    update: jest.fn(function(data) {
        Object.assign(this, data);
        return Promise.resolve(this);
    }),
    toJSON: function() { return { ...this, update: undefined, toJSON: undefined }; }
};
const mockUserShop = { user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'owner', shop: mockShop };

jest.mock('src/modules/entities', () => ({
    Shop:    { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn() },
    UserShop:{ findOne: jest.fn(), findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    User:    { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn() },
    Tenant:  { ...mockModel },
    FaqResponse: { ...mockModel }, BanglishDictionary: { ...mockModel }, MetaIntegration: { ...mockModel },
    Order: { ...mockModel }, OrderItem: { ...mockModel }, Product: { ...mockModel },
    Category: { ...mockModel }, Customer: { ...mockModel }, Channel: { ...mockModel },
    Conversation: { ...mockModel }, Message: { ...mockModel }, Keyword: { ...mockModel },
    AuditLog: { ...mockModel }, IdempotencyKey: { ...mockModel }, Subscription: { ...mockModel },
    Invoice: { ...mockModel }, UsageEvent: { ...mockModel }, PaymentConfig: { ...mockModel },
    DeliveryIntegration: { ...mockModel }, DeliveryCost: { ...mockModel }, KnownArea: { ...mockModel },
    Analytics: { ...mockModel }, OrderReturn: { ...mockModel }, SupportTicket: { ...mockModel },
}));
jest.mock('src/modules/analytics/knowledge-gap.entity', () => ({
    findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), findOne: jest.fn(),
    belongsTo: jest.fn(), hasMany: jest.fn(),
}));
jest.mock('src/modules/rag/rag.service',  () => ({ ingestData: jest.fn(() => Promise.resolve()) }));
jest.mock('src/utils/cache.service',      () => ({ getForShop: jest.fn(() => Promise.resolve(null)), setForShop: jest.fn(), deleteForShop: jest.fn() }));
jest.mock('src/modules/audit/audit.service', () => ({ logOperation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/middleware/session.middleware', () => () => (req, res, next) => next());
jest.mock('src/utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), logUsage: jest.fn() })),
}));

// ── Inject authenticated user ──────────────────────────────────────────────
jest.mock('src/middleware/auth.middleware', () => ({
    authenticate:            (req, res, next) => { req.user = { userId: 'user-1', shopId: 'shop-1', role: 'owner' }; next(); },
    authenticateForPasswordChange: (req, res, next) => next(),
    checkSubscriptionStatus: (req, res, next) => next(),
}));

const { Shop, UserShop, Subscription } = require('src/modules/entities');
const auditService = require('src/modules/audit/audit.service');
const sseManager = require('src/utils/sse-manager');

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Shop AI Settings API', () => {
    let app;

    beforeAll(() => {
        app = require('src/app');
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockShop.update.mockClear();
        mockShop.settings = { ai: { automation_mode: 'DRAFT', confidence_threshold: 60 } };

        Shop.findByPk.mockResolvedValue(mockShop);
        UserShop.findOne.mockResolvedValue({ ...mockUserShop, shop: { ...mockShop, toJSON: () => ({ id: 'shop-1' }) } });
        Subscription.findOne.mockResolvedValue({ plan_code: 'GROWTH' });
    });

    // ── GET /shop/ai-settings ─────────────────────────────────────────────

    describe('GET /shop/ai-settings', () => {
        it('returns 200 with ai settings', async () => {
            const res = await request(app).get('/api/shop/ai-settings');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('automation_mode');
        });

        it('returns settings with defaults for unset fields', async () => {
            mockShop.settings = {}; // no ai key
            Shop.findByPk.mockResolvedValue(mockShop);

            const res = await request(app).get('/api/shop/ai-settings');

            expect(res.status).toBe(200);
            const data = res.body.data;
            expect(data.automation_mode).toBe('MANUAL');
            expect(data.auto_reply_enabled).toBe(false);
            expect(data.confidence_threshold).toBe(75);
            expect(data.required_fields).toHaveProperty('customer_name');
        });

        it('merges stored values over defaults', async () => {
            mockShop.settings = { ai: { automation_mode: 'AUTO', confidence_threshold: 85 } };
            Shop.findByPk.mockResolvedValue(mockShop);

            const res = await request(app).get('/api/shop/ai-settings');

            expect(res.body.data.automation_mode).toBe('AUTO');
            expect(res.body.data.confidence_threshold).toBe(85);
            expect(res.body.plan_capabilities.allowed_automation_modes).toEqual(['AUTO', 'DRAFT', 'MANUAL']);
        });
    });

    // ── PUT /shop/ai-settings ─────────────────────────────────────────────

    describe('PUT /shop/ai-settings', () => {
        it('accepts canonical modes and normalizes legacy aliases', async () => {
            for (const mode of ['DRAFT', 'AUTO', 'MANUAL', 'AI_SUGGEST_ONLY', 'AI_ACTIVE', 'HUMAN_ACTIVE']) {
                const res = await request(app)
                    .put('/api/shop/ai-settings')
                    .send({ automation_mode: mode });
                expect(res.status).toBe(200);
                expect(['AUTO', 'DRAFT', 'MANUAL']).toContain(res.body.data.automation_mode);
            }
        });

        it('records and broadcasts a normalized mode change', async () => {
            mockShop.settings = { ai: { automation_mode: 'DRAFT' } };
            Shop.findByPk.mockResolvedValue(mockShop);

            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ automation_mode: 'AI_ACTIVE' });

            expect(res.status).toBe(200);
            expect(res.body.data.automation_mode).toBe('AUTO');
            expect(mockShop.settings.ai.automation_mode).toBe('AUTO');
            expect(auditService.logOperation).toHaveBeenCalledWith(expect.objectContaining({
                userId: 'user-1',
                shopId: 'shop-1',
                action: 'AI_REPLY_MODE_CHANGED',
                oldValues: { automation_mode: 'DRAFT' },
                newValues: { automation_mode: 'AUTO' },
                metadata: {
                    shop_id: 'shop-1',
                    old_mode: 'DRAFT',
                    new_mode: 'AUTO',
                    actor_id: 'user-1',
                },
            }), { transaction: mockTransaction });
            expect(sseManager.emit).toHaveBeenCalledWith(
                'shop-1',
                'ai_reply_mode_changed',
                { mode: 'AUTO' },
            );
        });

        it('does not emit a mode-change event for a normalized no-op', async () => {
            mockShop.settings = { ai: { automation_mode: 'AI_ACTIVE' } };
            Shop.findByPk.mockResolvedValue(mockShop);

            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ automation_mode: 'AUTO' });

            expect(res.status).toBe(200);
            expect(res.body.data.automation_mode).toBe('AUTO');
            expect(auditService.logOperation).not.toHaveBeenCalled();
            expect(sseManager.emit).not.toHaveBeenCalled();
        });

        it('rejects invalid automation_mode', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ automation_mode: 'ROGUE' });

            expect(res.status).toBe(400);
        });

        it('accepts confidence_threshold between 0 and 100', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ confidence_threshold: 75 });

            expect(res.status).toBe(200);
        });

        it('rejects confidence_threshold above 100', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ confidence_threshold: 101 });

            expect(res.status).toBe(400);
        });

        it('rejects negative confidence_threshold', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ confidence_threshold: -1 });

            expect(res.status).toBe(400);
        });

        it('accepts valid primary_language values', async () => {
            for (const lang of ['mixed', 'en', 'bn']) {
                const res = await request(app)
                    .put('/api/shop/ai-settings')
                    .send({ primary_language: lang });
                expect(res.status).toBe(200);
            }
        });

        it('rejects unknown primary_language', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ primary_language: 'fr' });
            expect(res.status).toBe(400);
        });

        it('rejects invalid notification_channel in handoff_settings', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ handoff_settings: { notification_channel: 'webhook' } });
            expect(res.status).toBe(400);
        });

        it('accepts valid notification_channel', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ handoff_settings: { notification_channel: 'telegram', cooldown_minutes: 30 } });
            expect(res.status).toBe(200);
        });

        it('derives auto_reply_enabled from automation_mode', async () => {
            const draftRes = await request(app)
                .put('/api/shop/ai-settings')
                .send({ automation_mode: 'DRAFT', auto_reply_enabled: true });
            expect(draftRes.status).toBe(200);
            expect(mockShop.settings.ai.auto_reply_enabled).toBe(false);

            const autoRes = await request(app)
                .put('/api/shop/ai-settings')
                .send({ automation_mode: 'AUTO', auto_reply_enabled: false });
            expect(autoRes.status).toBe(200);
            expect(mockShop.settings.ai.auto_reply_enabled).toBe(true);
        });

        it('persists greeting and closing settings', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({
                    greeting: { enabled: true, custom_text: 'Welcome to Test Shop' },
                    closing: { enabled: false, custom_text: 'Thanks' },
                });

            expect(res.status).toBe(200);
            expect(mockShop.settings.ai.greeting).toEqual({ enabled: true, custom_text: 'Welcome to Test Shop' });
            expect(mockShop.settings.ai.closing).toEqual({ enabled: false, custom_text: 'Thanks' });
        });

        it('returns saved AI settings after a reload-style GET', async () => {
            const save = await request(app)
                .put('/api/shop/ai-settings')
                .send({
                    automation_mode: 'AUTO',
                    confidence_threshold: 85,
                    primary_language: 'en',
                });

            expect(save.status).toBe(200);

            const reload = await request(app).get('/api/shop/ai-settings');
            expect(reload.status).toBe(200);
            expect(reload.body.data).toEqual(expect.objectContaining({
                automation_mode: 'AUTO',
                confidence_threshold: 85,
                primary_language: 'en',
                auto_reply_enabled: true,
            }));
        });

        it('converts auto_reply_enabled to boolean', async () => {
            const res = await request(app)
                .put('/api/shop/ai-settings')
                .send({ auto_reply_enabled: 'true' }); // string input
            expect(res.status).toBe(200);
        });
    });

    // ── updateShopAiSettings service — deep-merge ─────────────────────────

    describe('updateShopAiSettings service (deep-merge)', () => {
        it('deep-merges required_fields without overwriting other keys', async () => {
            const shopService = require('src/modules/shop/shop.service');
            const shopWithSettings = {
                ...mockShop,
                settings: {
                    ai: {
                        required_fields: { customer_name: true, mobile_number: true, delivery_address: true, payment_method: true, email_address: false, special_instructions: false }
                    }
                },
                update: jest.fn(() => Promise.resolve())
            };
            Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

            await shopService.updateShopAiSettings('shop-1', 'user-1', {
                required_fields: { email_address: true }
            });

            const updateCall = shopWithSettings.update.mock.calls[0][0];
            const saved = updateCall.settings.ai.required_fields;

            // email_address was updated
            expect(saved.email_address).toBe(true);
            // Other required fields must be preserved
            expect(saved.customer_name).toBe(true);
            expect(saved.mobile_number).toBe(true);
            expect(saved.delivery_address).toBe(true);
        });

        it('deep-merges handoff_settings without overwriting other keys', async () => {
            const shopService = require('src/modules/shop/shop.service');
            const shopWithSettings = {
                ...mockShop,
                settings: {
                    ai: {
                        handoff_settings: { trigger_keywords: ['complain'], notification_channel: 'in_app', cooldown_minutes: 30 }
                    }
                },
                update: jest.fn(() => Promise.resolve())
            };
            Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

            await shopService.updateShopAiSettings('shop-1', 'user-1', {
                handoff_settings: { cooldown_minutes: 60 }
            });

            const updateCall = shopWithSettings.update.mock.calls[0][0];
            const saved = updateCall.settings.ai.handoff_settings;

            expect(saved.cooldown_minutes).toBe(60);          // updated
            expect(saved.trigger_keywords).toEqual(['complain']); // preserved
            expect(saved.notification_channel).toBe('in_app'); // preserved
        });

        it('does not touch other settings keys when updating ai', async () => {
            const shopService = require('src/modules/shop/shop.service');
            const shopWithSettings = {
                ...mockShop,
                settings: {
                    businessInfo: { shopName: 'My Shop' },
                    ai: { automation_mode: 'DRAFT' }
                },
                update: jest.fn(() => Promise.resolve())
            };
            Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

            await shopService.updateShopAiSettings('shop-1', 'user-1', { automation_mode: 'AUTO' });

            const updateCall = shopWithSettings.update.mock.calls[0][0];
            // businessInfo must be preserved at the top level
            expect(updateCall.settings.businessInfo).toEqual({ shopName: 'My Shop' });
        });

        it('preserves persisted settings domains that are not in the AI payload', async () => {
            const shopWithSettings = {
                ...mockShop,
                settings: {
                    ai: { automation_mode: 'DRAFT' },
                    onboarding_completed: true,
                    onboarding_completed_at: '2026-08-01T00:00:00.000Z',
                    onboarding_status_snapshot: { can_complete: true },
                    payment_platform_priority: ['bkash', 'cod'],
                    delivery_platform_priority: ['pathao', 'steadfast'],
                    legacy_domain_setting: { keep: true },
                },
                update: jest.fn(() => Promise.resolve()),
            };
            Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

            const shopService = require('src/modules/shop/shop.service');
            await shopService.updateShopAiSettings('shop-1', 'user-1', {
                confidence_threshold: 80,
            });

            const saved = shopWithSettings.update.mock.calls[0][0].settings;
            expect(saved).toEqual(expect.objectContaining({
                onboarding_completed: true,
                onboarding_completed_at: '2026-08-01T00:00:00.000Z',
                onboarding_status_snapshot: { can_complete: true },
                payment_platform_priority: ['bkash', 'cod'],
                delivery_platform_priority: ['pathao', 'steadfast'],
                legacy_domain_setting: { keep: true },
            }));
        });

        it('deep-merges partial greeting and closing updates', async () => {
            const shopWithSettings = {
                ...mockShop,
                settings: {
                    ai: {
                        greeting: { enabled: true, custom_text: 'Welcome', tone: 'warm' },
                        closing: { enabled: true, custom_text: 'Thanks', include_socials: true },
                    },
                },
                update: jest.fn(() => Promise.resolve()),
            };
            Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

            const shopService = require('src/modules/shop/shop.service');
            await shopService.updateShopAiSettings('shop-1', 'user-1', {
                greeting: { custom_text: 'Hello' },
                closing: { enabled: false },
            });

            const saved = shopWithSettings.update.mock.calls[0][0].settings.ai;
            expect(saved.greeting).toEqual({ enabled: true, custom_text: 'Hello', tone: 'warm' });
            expect(saved.closing).toEqual({ enabled: false, custom_text: 'Thanks', include_socials: true });
        });
    });

    describe('PUT /shop/llm-config', () => {
        it('merges the LLM patch into fresh settings and preserves concurrent RTO consent', async () => {
            const latestSettings = {
                rto_network: { contribute: false, enforce: true, updated_at: '2026-10-31T10:00:00.000Z' },
                ai: { automation_mode: 'AUTO', llm_model: 'old-model', retained_flag: 'fresh' },
                merchant_preferences: { locale: 'bn', currency: 'BDT' },
            };
            const staleSettings = {
                rto_network: { contribute: true, enforce: false, updated_at: '2026-10-01T10:00:00.000Z' },
                ai: { automation_mode: 'DRAFT', stale_flag: 'must-not-return' },
            };
            mockShop.settings = latestSettings;
            Shop.findByPk.mockResolvedValue(mockShop);
            UserShop.findOne.mockResolvedValue({
                ...mockUserShop,
                shop: {
                    settings: staleSettings,
                    toJSON: () => ({ id: 'shop-1', settings: staleSettings }),
                },
            });

            const res = await request(app)
                .put('/api/shop/llm-config')
                .send({ model: 'gpt-4o-mini', temperature: 0.4 });

            expect(res.status).toBe(200);
            const saved = mockShop.update.mock.calls[0][0].settings;
            expect(saved).toEqual(expect.objectContaining({
                rto_network: latestSettings.rto_network,
                merchant_preferences: latestSettings.merchant_preferences,
                ai: expect.objectContaining({
                    automation_mode: 'AUTO',
                    llm_model: 'gpt-4o-mini',
                    llm_temperature: 0.4,
                    retained_flag: 'fresh',
                }),
            }));
            expect(saved.ai).not.toHaveProperty('stale_flag');
        });
    });
});
