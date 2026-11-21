'use strict';

/**
 * WP-09 wiring: GET /api/admin/shops/:shopId/confidence-rollup
 *
 * Router-level security tests. The REAL requirePlatformAdmin guard runs
 * (auth/entities/cache mocked, like admin.authz.test.js); the rollup service
 * is mocked here so these tests pin the wiring contract — authorization,
 * tenant scoping, window validation, aggregate-only shape. The SQL-level
 * READ ONLY proof lives in admin-confidence-rollup.readonly.test.js.
 */

process.env.NODE_ENV = 'test';

const platformRoleHolder = { value: null };
const mockRollup = jest.fn();
const mockAuditService = { logOperation: jest.fn(async () => {}) };

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const SHOP_B = '22222222-2222-4222-8222-222222222222';

const mockModels = {
    Shop: { findByPk: jest.fn() },
    Subscription: { findOne: jest.fn(), count: jest.fn() },
    MetaChannel: { findAll: jest.fn(), count: jest.fn() },
    MetaUserIdentity: { count: jest.fn(), max: jest.fn() },
    Conversation: { name: 'Conversation' },
    Message: { findAll: jest.fn(), count: jest.fn() },
    Order: { findAll: jest.fn(), count: jest.fn() },
    CourierDispatch: { findAll: jest.fn() },
    AuditLog: { findAndCountAll: jest.fn() },
    User: { findByPk: jest.fn(async () => ({ platform_role: platformRoleHolder.value })) },
    Invoice: {},
};

// Fixed authenticated user; the platform role is varied via the entities mock.
jest.mock('src/middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => { req.user = { userId: 'admin-1' }; next(); },
    checkSubscriptionStatus: (_req, _res, next) => next(),
}));

// Force a cache miss so the REAL guard resolves the role from the mocked DB.
jest.mock('src/utils/cache.service', () => ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => {}),
    deleteForShop: jest.fn(async () => {}),
}));

jest.mock('src/modules/entities', () => mockModels);
jest.mock('src/modules/audit/audit.service', () => mockAuditService);
jest.mock('src/modules/ai/reply-confidence-rollup.service', () => ({
    getReplyConfidenceRollup: (...args) => mockRollup(...args),
}));
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock('src/modules/payment/payment-processing-reconciliation.service', () => ({}));
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({
    ORDER_CONFIDENCE_MODES: ['off', 'shadow', 'enforce'],
}));
jest.mock('src/modules/shop/shop.service', () => ({}));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({}));
jest.mock('src/modules/subscription/subscription.service', () => ({}));
jest.mock('src/modules/subscription/partner.service', () => ({}));

const express = require('express');
const request = require('supertest');
const adminRoutes = require('../admin.routes');

function buildApp() {
    const app = express();
    app.use('/api/admin', adminRoutes);
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        res.status(err.status || err.statusCode || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    });
    return app;
}

// Exactly what the operator-only rollup service returns: counts, histograms,
// and (since WP-03) the additive observation aggregates — identity/denominator
// fields only, still zero PII.
const rollupFixture = () => ({
    hours: 24, turns: 4, truncated: false,
    missing: 1, suggestion: 1, delivered: 2, unscored: 1,
    wouldHold: 1, wouldHoldCovered: 2, wouldHoldUnknown: 2,
    scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 1, threeQuartersOrAbove: 2 },
    reasons: { RAG_TIMEOUT: 1 },
    retrieval: { TIMEOUT: 1, UNKNOWN: 1, NOT_REQUESTED: 1 },
    retrievalCovered: 2, retrievalUnknown: 2, computeP95Ms: 7,
    conversations: 2, firstEligibleObservedAt: '2026-11-19T08:00:00.000Z',
    scored: 2, eligible: 2, ineligible: 2,
});

beforeEach(() => {
    jest.clearAllMocks();
    platformRoleHolder.value = 'SUPPORT_ADMIN';
    mockModels.Shop.findByPk.mockImplementation(async (id) => ({ id }));
    mockRollup.mockImplementation(async (_shopId, hours) => ({ ...rollupFixture(), hours }));
});

describe('admin confidence rollup — authorization (real requirePlatformAdmin)', () => {
    test('403 for a merchant (no platform_role) before any shop or rollup query', async () => {
        platformRoleHolder.value = null;
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(403);
        expect(mockModels.Shop.findByPk).not.toHaveBeenCalled();
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('403 for an unrecognized platform role', async () => {
        platformRoleHolder.value = 'MERCHANT';
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(403);
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('200 for SUPPORT_ADMIN (read-level, same as diagnostics)', async () => {
        platformRoleHolder.value = 'SUPPORT_ADMIN';
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('200 for SUPER_ADMIN', async () => {
        platformRoleHolder.value = 'SUPER_ADMIN';
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(200);
    });
});

describe('admin confidence rollup — tenant scoping', () => {
    test('rollup receives exactly the shopId from the path', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(200);
        expect(mockModels.Shop.findByPk).toHaveBeenCalledWith(SHOP_A, { attributes: ['id'] });
        expect(mockRollup).toHaveBeenCalledTimes(1);
        expect(mockRollup).toHaveBeenCalledWith(SHOP_A, 24);
        expect(res.body.data.shopId).toBe(SHOP_A);
    });

    test('a different shop in the path scopes the rollup to that shop only', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_B}/confidence-rollup?hours=48`);
        expect(res.status).toBe(200);
        expect(mockRollup).toHaveBeenCalledTimes(1);
        expect(mockRollup).toHaveBeenCalledWith(SHOP_B, 48);
        expect(res.body.data.shopId).toBe(SHOP_B);
    });

    test('404 for an unknown shop, without invoking the rollup', async () => {
        mockModels.Shop.findByPk.mockResolvedValueOnce(null);
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SHOP_NOT_FOUND');
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('400 for a malformed shop id, before any query', async () => {
        const res = await request(buildApp()).get('/api/admin/shops/not-a-uuid/confidence-rollup');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(mockModels.Shop.findByPk).not.toHaveBeenCalled();
        expect(mockRollup).not.toHaveBeenCalled();
    });
});

describe('admin confidence rollup — window validation (1-168 hours)', () => {
    test.each(['0', '169', '-5', 'abc', '2.5', '1e2', '9999', '24h'])(
        'rejects hours=%s with 400 and never invokes the rollup', async (hours) => {
            const res = await request(buildApp())
                .get(`/api/admin/shops/${SHOP_A}/confidence-rollup?hours=${encodeURIComponent(hours)}`);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_CONFIDENCE_WINDOW');
            expect(mockRollup).not.toHaveBeenCalled();
        });

    test.each([['1', 1], ['168', 168], ['48', 48]])('accepts hours=%s', async (raw, expected) => {
        const res = await request(buildApp())
            .get(`/api/admin/shops/${SHOP_A}/confidence-rollup?hours=${raw}`);
        expect(res.status).toBe(200);
        expect(mockRollup).toHaveBeenCalledWith(SHOP_A, expected);
        expect(res.body.data.hours).toBe(expected);
    });

    test('defaults to 24 hours when the parameter is absent or empty', async () => {
        const app = buildApp();
        const absent = await request(app).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        const empty = await request(app).get(`/api/admin/shops/${SHOP_A}/confidence-rollup?hours=`);
        expect(absent.status).toBe(200);
        expect(empty.status).toBe(200);
        expect(mockRollup).toHaveBeenNthCalledWith(1, SHOP_A, 24);
        expect(mockRollup).toHaveBeenNthCalledWith(2, SHOP_A, 24);
    });
});

describe('admin confidence rollup — aggregate-only, zero PII, read-only wiring', () => {
    test('response carries only the rollup aggregates plus shopId/generatedAt', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual([
            'computeP95Ms', 'delivered', 'generatedAt', 'hours', 'missing',
            'reasons', 'retrieval', 'retrievalCovered', 'retrievalUnknown',
            'scoreBuckets', 'shopId', 'suggestion', 'truncated', 'turns',
            'unscored', 'wouldHold', 'wouldHoldCovered', 'wouldHoldUnknown',
            // WP-03 additive observation aggregates (counts/ISO only, zero PII):
            'conversations', 'firstEligibleObservedAt', 'scored', 'eligible', 'ineligible',
        ].sort());
        expect(res.body.data).toMatchObject({
            shopId: SHOP_A, turns: 4, wouldHold: 1, wouldHoldCovered: 2,
            wouldHoldUnknown: 2, reasons: { RAG_TIMEOUT: 1 }, computeP95Ms: 7,
        });
        expect(new Date(res.body.data.generatedAt).toISOString()).toBe(res.body.data.generatedAt);

        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toMatch(/psid|token_ct|access_token|customer_name|customer_phone|email|page_access|"content"|ai_suggestion|sender_id/i);
    });

    test('performs no writes: no audit rows, no mutation queries, reads only', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(200);
        expect(mockAuditService.logOperation).not.toHaveBeenCalled();
        // The only data accesses are the shop existence read and the rollup.
        expect(mockModels.Message.findAll).not.toHaveBeenCalled();
        expect(mockModels.Order.findAll).not.toHaveBeenCalled();
        const { sequelize } = require('src/utils/database/database-setup');
        expect(sequelize.transaction).not.toHaveBeenCalled();
        expect(sequelize.query).not.toHaveBeenCalled();
    });

    test('surfaces a rollup failure as 500, not a fabricated empty report', async () => {
        mockRollup.mockRejectedValueOnce(new Error('statement timeout'));
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-rollup`);
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
    });
});
