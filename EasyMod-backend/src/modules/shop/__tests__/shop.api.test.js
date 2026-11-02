/**
 * Shop API — Integration Tests
 * Tests /shop/list, /shop/create, /shop/update, /shop/delete, /shop/business-info
 */

'use strict';

// ── In-memory Redis ───────────────────────────────────────────────────────────
const redisStore = {};
jest.mock('../../../config/redis', () => ({
    cacheRedis: null,
    sessionRedis: null,
    rateLimitRedis: null,
    legacyRedis: null,
}));

jest.mock('../../auth/session-invalidation.service', () => ({
    invalidateUserSessions: jest.fn().mockResolvedValue(1),
}));

jest.mock('../../../utils/redis-client', () => ({
    get: jest.fn(async (k) => redisStore[k] ?? null),
    set: jest.fn(async (k, v) => { redisStore[k] = v; }),
    del: jest.fn(async (k) => { delete redisStore[k]; }),
    setex: jest.fn(async (k, _ttl, v) => { redisStore[k] = v; }),
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

// ── Entity mocks ──────────────────────────────────────────────────────────────
const mockShopInstance = {
    id: 'dddddddd-4444-4444-8444-dddddddddddd',
    shop_name: 'My BD Shop',
    name: 'My BD Shop',
    unique_code: 'SHOP1',
    settings: { businessInfo: { shopName: 'My BD Shop' } },
    toJSON: function () { return { id: this.id, shop_name: this.shop_name, name: this.name, unique_code: this.unique_code, settings: this.settings }; },
    update: jest.fn().mockResolvedValue(true),
};

const mockUserShop = {
    user_id: 'user-1',
    shop_id: 'dddddddd-4444-4444-8444-dddddddddddd',
    role: 'owner',
    is_active: true,
    shop: mockShopInstance,
    toJSON: () => ({ user_id: 'user-1', shop_id: 'dddddddd-4444-4444-8444-dddddddddddd', role: 'owner' }),
};

jest.mock('../../entities', () => ({
    User: { findByPk: jest.fn(), update: jest.fn() },
    Shop: {
        findByPk: jest.fn(),
        create: jest.fn(),
        destroy: jest.fn(),
        findAll: jest.fn(),
        // Locked settings writes run through Shop.sequelize.transaction so the
        // consent-preserving merge re-reads the row under the same lock.
        sequelize: {
            transaction: jest.fn(async (cb) => {
                const t = { commit: jest.fn(), rollback: jest.fn() };
                if (typeof cb === 'function') return cb(t);
                return t;
            }),
        },
    },
    UserShop: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        destroy: jest.fn(),
    },
    DeliveryIntegration: {
        findAll: jest.fn(),
    },
    MetaChannel: {
        findAll: jest.fn(),
    },
    PolicyDecision: {
        findAll: jest.fn(),
    },
    Subscription: { create: jest.fn() },
    Tenant: { findByPk: jest.fn() },
    GrowthOsUserRole: { findOne: jest.fn() },
}));

// `define` is not optional: entity modules reached through the router call it
// at IMPORT time (knowledge-gap.entity.js is the one this suite pulls in), so a
// stub without it throws before the first request is ever made.
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        define: jest.fn(() => ({
            findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])),
            findAndCountAll: jest.fn(() => Promise.resolve({ rows: [], count: 0 })),
            create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn(),
            belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn(),
            addScope: jest.fn(), scope: jest.fn(function () { return this; })
        })),
        transaction: jest.fn(async (cb) => {
            const t = { commit: jest.fn(), rollback: jest.fn() };
            if (typeof cb === 'function') return cb(t);
            return t;
        }),
        authenticate: jest.fn(() => Promise.resolve()),
        sync: jest.fn(() => Promise.resolve()),
        literal: jest.fn((s) => s),
        query: jest.fn(() => Promise.resolve([[]])),
        getDialect: jest.fn(() => 'postgres')
    }
}));

// business-info is served from the knowledge service, which is a separate
// module the entity mocks do not cover.
jest.mock('../../knowledge/knowledge.service', () => ({
    getKnowledge: jest.fn().mockResolvedValue({ businessInfo: { shopName: 'My BD Shop' } }),
    updateKnowledge: jest.fn().mockResolvedValue(true),
}));

jest.mock('../shop-defaults', () => ({
    DEFAULT_AI_SETTINGS: { primary_provider: 'gemini', fallback_provider: 'openai' }
}));

jest.mock('../shop-settings.validator', () => ({
    validateAISettings: jest.fn().mockReturnValue({ valid: true }),
    validateSettings: jest.fn().mockReturnValue({ valid: true }),
    sanitizeSettings: jest.fn((s) => s),
    mergeAndSanitizeSettings: jest.fn((current, patch) => (
        jest.requireActual('../shop-settings.validator').mergeAndSanitizeSettings(current, patch)
    )),
    mergeSettingsPreservingRtoConsent: jest.fn((current, patch) => (
        jest.requireActual('../shop-settings.validator').mergeSettingsPreservingRtoConsent(current, patch)
    )),
    stripAutomationModeFromShopUpdate: jest.fn((updateData) => (
        jest.requireActual('../shop-settings.validator').stripAutomationModeFromShopUpdate(updateData)
    )),
}));

// ── JWT auth ──────────────────────────────────────────────────────────────────
jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ')) {
            return _res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        // The real middleware sets req.user, and every controller reads
        // req.user.userId / req.user.shopId. Setting the flat req.userId that
        // an older middleware exposed makes each handler throw on undefined.
        req.user = { userId: 'user-1', shopId: 'dddddddd-4444-4444-8444-dddddddddddd' };
        next();
    }
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');

// auth.middleware requires userId + tokenVersion: the token-version revocation
// check (added with password-reset invalidation) rejects the older { id } shape
// with 401 before the route is ever reached.
const validToken = jwt.sign(
    { userId: 'user-1', shopId: 'dddddddd-4444-4444-8444-dddddddddddd', tokenVersion: 0 },
    'test-access-secret',
    { expiresIn: '1h' },
);
const authHeader = `Bearer ${validToken}`;

let app;
beforeAll(() => {
    app = express();
    app.use(express.json());
    const shopRoutes = require('src/modules/shop/shop.routes');
    app.use('/shop', shopRoutes);
});

beforeEach(() => {
    jest.clearAllMocks();
    const { Shop, User, UserShop } = require('../../entities');
    User.findByPk.mockResolvedValue({ id: 'user-1' });
    User.update.mockResolvedValue([1]);
    Shop.findByPk.mockResolvedValue({ ...mockShopInstance, update: jest.fn().mockResolvedValue(true) });
    Shop.create.mockResolvedValue({ ...mockShopInstance, toJSON: mockShopInstance.toJSON });
    Shop.destroy.mockResolvedValue(1);
    UserShop.findOne.mockResolvedValue({ ...mockUserShop });
    UserShop.findAll.mockResolvedValue([{ ...mockUserShop }]);
    UserShop.create.mockResolvedValue({ id: 'us-1' });
    const { DeliveryIntegration } = require('../../entities');
    DeliveryIntegration.findAll.mockResolvedValue([]);
    const { GrowthOsUserRole } = require('../../entities');
    GrowthOsUserRole.findOne.mockResolvedValue(null);
    const { MetaChannel, PolicyDecision } = require('../../entities');
    MetaChannel.findAll.mockResolvedValue([]);
    PolicyDecision.findAll.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /shop/list', () => {
    it('returns 200 with shops for authenticated user', async () => {
        const res = await request(app)
            .get('/shop/list')
            .set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 401 without auth token', async () => {
        const res = await request(app).get('/shop/list');
        expect(res.status).toBe(401);
    });

    it('returns empty array when user has no shops', async () => {
        const { UserShop } = require('../../entities');
        // getShopsByUserId delegates to getMyShop, which reads UserShop.findOne.
        // Stubbing findAll left the default findOne in place and returned a shop.
        UserShop.findOne.mockResolvedValueOnce(null);
        const res = await request(app)
            .get('/shop/list')
            .set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });
});

describe('POST /shop/create', () => {
    // One shop per user: createShop 409s when UserShop.findOne already resolves
    // one, which the shared beforeEach sets up for every other test here.
    beforeEach(() => {
        const { UserShop } = require('../../entities');
        UserShop.findOne.mockResolvedValue(null);
    });

    it('creates a shop and returns 200', async () => {
        const res = await request(app)
            .post('/shop/create')
            .set('Authorization', authHeader)
            .send({ shop_name: 'New BD Shop' });

        // 201 Created — the route was changed to answer with the REST-correct
        // status for a create.
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
    });

    it('returns 401 without auth token', async () => {
        const res = await request(app)
            .post('/shop/create')
            .send({ shop_name: 'Unauthorized Shop' });

        expect(res.status).toBe(401);
    });

    it('calls Shop.create with provided shop_name', async () => {
        const { Shop } = require('../../entities');
        await request(app)
            .post('/shop/create')
            .set('Authorization', authHeader)
            .send({ shop_name: 'Fashion Store BD' });

        expect(Shop.create).toHaveBeenCalledWith(
            expect.objectContaining({ shop_name: 'Fashion Store BD' }),
            expect.anything()
        );
    });
});

describe('POST /shop/update', () => {
    it('updates shop and returns 200', async () => {
        const shopWithUpdate = { ...mockShopInstance, update: jest.fn().mockResolvedValue(true) };
        const { Shop } = require('../../entities');
        Shop.findByPk.mockResolvedValueOnce(shopWithUpdate);

        const res = await request(app)
            .post('/shop/update')
            .set('Authorization', authHeader)
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd', shop_name: 'Updated Shop' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 403 when the authenticated user has no active membership', async () => {
        const { UserShop } = require('../../entities');
        UserShop.findOne.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/shop/update')
            .set('Authorization', authHeader)
            .send({ shopId: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', shop_name: 'X' });

        expect(res.status).toBe(403);
    });

    it.each(['admin', 'staff'])('returns 403 for active non-owner %s before the controller', async (role) => {
        const { UserShop, Shop } = require('../../entities');
        UserShop.findOne.mockResolvedValueOnce({ ...mockUserShop, role, is_active: true });
        Shop.findByPk.mockClear();

        const res = await request(app)
            .post('/shop/update')
            .set('Authorization', authHeader)
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd', shop_name: 'X' });

        expect(res.status).toBe(403);
        expect(Shop.findByPk).not.toHaveBeenCalled();
    });

    it('returns 401 without auth token', async () => {
        const res = await request(app)
            .post('/shop/update')
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd', shop_name: 'X' });

        expect(res.status).toBe(401);
    });

    it('strips settings.ai.automation_mode so the general update cannot change reply mode', async () => {
        const shopWithSettings = {
            ...mockShopInstance,
            settings: { ai: { automation_mode: 'DRAFT' } },
            update: jest.fn().mockResolvedValue(true),
        };
        const { Shop } = require('../../entities');
        Shop.findByPk.mockResolvedValueOnce(shopWithSettings);

        const res = await request(app)
            .post('/shop/update')
            .set('Authorization', authHeader)
            .send({
                shopId: 'dddddddd-4444-4444-8444-dddddddddddd',
                settings: { ai: { automation_mode: 'AUTO' } },
            });

        expect(res.status).toBe(200);
        expect(shopWithSettings.update).toHaveBeenCalledWith(expect.objectContaining({
            settings: expect.objectContaining({
                ai: { automation_mode: 'DRAFT' },
            }),
        }), expect.anything());
    });
});

describe('POST /shop/delete', () => {
    it('deletes shop when user is owner and returns 200', async () => {
        const res = await request(app)
            .post('/shop/delete')
            .set('Authorization', authHeader)
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 403 when user is not owner', async () => {
        const { UserShop } = require('../../entities');
        UserShop.findOne.mockResolvedValueOnce(null); // owner check fails

        const res = await request(app)
            .post('/shop/delete')
            .set('Authorization', authHeader)
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd' });

        expect(res.status).toBe(403);
    });

    it('returns 401 without auth token', async () => {
        const res = await request(app)
            .post('/shop/delete')
            .send({ shopId: 'dddddddd-4444-4444-8444-dddddddddddd' });

        expect(res.status).toBe(401);
    });
});

describe('GET /shop/business-info', () => {
    it('returns 200 with business info for authenticated user', async () => {
        const res = await request(app)
            .get('/shop/business-info')
            .set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 401 without auth token', async () => {
        const res = await request(app).get('/shop/business-info');
        expect(res.status).toBe(401);
    });
});

describe('PUT /shop/platform-priority', () => {
    it('accepts delivery providers that are active and connected for the shop', async () => {
        const { DeliveryIntegration } = require('../../entities');
        DeliveryIntegration.findAll.mockResolvedValueOnce([{ provider: 'pathao' }]);

        const res = await request(app)
            .put('/shop/platform-priority')
            .set('Authorization', authHeader)
            .send({ payment: ['unregistered-payment'], delivery: ['pathao'] });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ payment: ['unregistered-payment'], delivery: ['pathao'] });
        expect(DeliveryIntegration.findAll).toHaveBeenCalledWith({
            where: {
                shop_id: 'dddddddd-4444-4444-8444-dddddddddddd',
                is_active: true,
                is_connected: true
            },
            attributes: ['provider'],
            transaction: expect.anything()
        });
    });

    it('rejects delivery providers that are not active and connected for the shop', async () => {
        const { DeliveryIntegration, Shop } = require('../../entities');
        const shop = { ...mockShopInstance, update: jest.fn().mockResolvedValue(true) };
        Shop.findByPk.mockResolvedValueOnce(shop);
        DeliveryIntegration.findAll.mockResolvedValueOnce([]);

        const res = await request(app)
            .put('/shop/platform-priority')
            .set('Authorization', authHeader)
            .send({ payment: ['unregistered-payment'], delivery: ['steadfast'] });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            message: 'Delivery priority provider is not active and connected: steadfast'
        });
        expect(shop.update).not.toHaveBeenCalled();
    });

    it('preserves payment priority behavior when delivery priority is empty', async () => {
        const { DeliveryIntegration } = require('../../entities');

        const res = await request(app)
            .put('/shop/platform-priority')
            .set('Authorization', authHeader)
            .send({ payment: ['unregistered-payment'], delivery: [] });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ payment: ['unregistered-payment'], delivery: [] });
        expect(DeliveryIntegration.findAll).not.toHaveBeenCalled();
    });
});

describe('GET /shop/ai-diagnostics', () => {
    it('returns channel health without exposing deprecated Page AI fields', async () => {
        const { MetaChannel, PolicyDecision } = require('../../entities');
        const channel = {
            id: 'channel-1',
            display_name: 'Sales Page',
            platform: 'facebook',
            meta_asset_id: 'page-1',
            status: 'CONNECTED',
            webhook_subscribed_fields: ['messages'],
            webhook_last_verified_at: '2026-09-02T00:00:00.000Z',
            getDataValue: jest.fn().mockReturnValue('encrypted-page-token'),
        };
        MetaChannel.findAll.mockResolvedValueOnce([channel]);
        PolicyDecision.findAll.mockResolvedValueOnce([]);

        const res = await request(app)
            .get('/shop/ai-diagnostics')
            .set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.data.channels).toEqual([{
            channel_id: 'channel-1',
            display_name: 'Sales Page',
            platform: 'facebook',
            meta_asset_id: 'page-1',
            status: 'CONNECTED',
            token_present: true,
            webhook_subscribed_fields: ['messages'],
            webhook_last_verified_at: '2026-09-02T00:00:00.000Z',
        }]);
        expect(res.body.data.channels[0]).not.toHaveProperty('automation_mode');
        expect(res.body.data.channels[0]).not.toHaveProperty('ai_auto_reply');
    });
});

describe('GET /shop/me', () => {
    it('returns 200 with current shop info', async () => {
        const res = await request(app)
            .get('/shop/me')
            .set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
