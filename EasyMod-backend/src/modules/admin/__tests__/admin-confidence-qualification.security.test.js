'use strict';

/**
 * WP-03 wiring: GET /api/admin/shops/:shopId/confidence-qualification
 *
 * Same discipline as admin-confidence-rollup.security.test.js: the REAL
 * requirePlatformAdmin guard runs (auth/entities mocked), the rollup service
 * is stubbed, and the PURE evaluator is REAL — so these tests pin the wiring
 * contract: authorization, tenant scoping, fixed 168h window, the
 * authorization proxy, aggregate-only/zero-PII envelope, and the never-pass
 * rules (zero observations → OBSERVATION_PENDING; failed read →
 * INSUFFICIENT_EVIDENCE, surfaced as a verdict, not a fabricated pass).
 * SQL-level READ ONLY/2s proofs stay with the rollup suites.
 */

process.env.NODE_ENV = 'test';

const platformRoleHolder = { value: null };
const mockRollup = jest.fn();
const mockAuditService = { logOperation: jest.fn(async () => {}) };

const SHOP_A = '11111111-1111-4111-8111-111111111111';

const ENROLLED_PILOT_ROW = {
    shop_id: SHOP_A,
    customer_intelligence: true,
    interaction_choices: false,
    action_queue: false,
    knowledge_suggestions: false,
    ads_studio: false,
    storefront: false,
    ai_reply_shadow_meter: false,
    order_confidence_mode: 'off',
};

const mockModels = {
    Shop: { findByPk: jest.fn() },
    ShopPilotFeatures: { findByPk: jest.fn() },
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

jest.mock('src/middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => { req.user = { userId: 'admin-1' }; next(); },
    checkSubscriptionStatus: (_req, _res, next) => next(),
}));
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
            success: false, code: err.code || 'INTERNAL_ERROR', message: err.message,
        });
    });
    return app;
}

// A rollup exactly as the real service returns it, wide window included.
const rollupFixture = (over = {}) => ({
    hours: 168, turns: 0, truncated: false,
    missing: 0, suggestion: 0, delivered: 0, unscored: 0,
    wouldHold: 0, wouldHoldCovered: 0, wouldHoldUnknown: 0,
    scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 0, threeQuartersOrAbove: 0 },
    reasons: {}, retrieval: {}, retrievalCovered: 0, retrievalUnknown: 0, computeP95Ms: null,
    conversations: 0, firstEligibleObservedAt: null,
    scored: 0, eligible: 0, ineligible: 0,
    ...over,
});

const HOUR_MS = 60 * 60 * 1000;
const passingRollup = () => rollupFixture({
    turns: 40, missing: 6, suggestion: 18, delivered: 22, unscored: 0,
    conversations: 4,
    firstEligibleObservedAt: new Date(Date.now() - 90 * HOUR_MS).toISOString(),
    scored: 40, eligible: 40, ineligible: 6,
});

const activeShop = { id: SHOP_A, is_active: true, ai_emergency_stop: false };

beforeEach(() => {
    jest.clearAllMocks();
    platformRoleHolder.value = 'SUPPORT_ADMIN';
    mockModels.Shop.findByPk.mockResolvedValue({ ...activeShop });
    mockModels.ShopPilotFeatures.findByPk.mockResolvedValue({ ...ENROLLED_PILOT_ROW });
    mockRollup.mockResolvedValue(rollupFixture());
});

describe('qualification endpoint — authorization (real requirePlatformAdmin)', () => {
    test('403 for a merchant (no platform_role) before any shop or rollup read', async () => {
        platformRoleHolder.value = null;
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(403);
        expect(mockModels.Shop.findByPk).not.toHaveBeenCalled();
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('403 for an unrecognized platform role', async () => {
        platformRoleHolder.value = 'MERCHANT';
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(403);
    });

    test.each(['SUPPORT_ADMIN', 'SUPER_ADMIN'])('200 for %s', async (role) => {
        platformRoleHolder.value = role;
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('qualification endpoint — validation, scoping, fixed window', () => {
    test('400 for a malformed shop id, before any query', async () => {
        const res = await request(buildApp()).get('/api/admin/shops/not-a-uuid/confidence-qualification');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(mockModels.Shop.findByPk).not.toHaveBeenCalled();
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('404 for an unknown shop, without invoking the rollup', async () => {
        mockModels.Shop.findByPk.mockResolvedValueOnce(null);
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SHOP_NOT_FOUND');
        expect(mockRollup).not.toHaveBeenCalled();
    });

    test('always reads the contract window (168h) scoped to the path shop', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(mockModels.Shop.findByPk).toHaveBeenCalledWith(
            SHOP_A, { attributes: ['id', 'is_active', 'ai_emergency_stop'] },
        );
        expect(mockRollup).toHaveBeenCalledTimes(1);
        expect(mockRollup).toHaveBeenCalledWith(SHOP_A, 168);
        expect(res.body.data.shopId).toBe(SHOP_A);
        expect(res.body.data.windowHours).toBe(168);
    });
});

describe('qualification endpoint — verdict wiring through the real evaluator', () => {
    test('zero observations → OBSERVATION_PENDING, never QUALIFIED', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.data.verdict).toBe('OBSERVATION_PENDING');
        expect(res.body.data.denominators).toMatchObject({ scored: 0, conversations: 0 });
        expect(res.body.data.firstEligibleObservedAt).toBeNull();
    });

    test('complete evidence + authorized shop → QUALIFIED', async () => {
        mockRollup.mockResolvedValue(passingRollup());
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.data.verdict).toBe('QUALIFIED');
        expect(res.body.data.criteria.authorizedShop.met).toBe(true);
        expect(res.body.data.criteria.shadowToLiveIsolation.value).toBe(0);
    });

    test.each([
        ['suspended shop', { ...activeShop, is_active: false }, passingRollup()],
        ['emergency-stopped shop', { ...activeShop, ai_emergency_stop: true }, passingRollup()],
        ['un-enrolled pilot row', activeShop, passingRollup()],
    ])('%s → authorizedShop fails closed to INSUFFICIENT_EVIDENCE despite full counts', async (_label, shop, rollup) => {
        mockModels.Shop.findByPk.mockResolvedValue({ ...shop });
        if (_label === 'un-enrolled pilot row') {
            mockModels.ShopPilotFeatures.findByPk.mockResolvedValue(null);
        }
        mockRollup.mockResolvedValue(rollup);
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.data.verdict).toBe('INSUFFICIENT_EVIDENCE');
        expect(res.body.data.criteria.authorizedShop.met).toBe(false);
    });

    test('a failing rollup read (e.g. statement timeout) surfaces INSUFFICIENT_EVIDENCE, not a pass and not a 500', async () => {
        mockRollup.mockRejectedValue(new Error('statement timeout'));
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.data.verdict).toBe('INSUFFICIENT_EVIDENCE');
        expect(res.body.data.rollupAvailable).toBe(false);
    });

    test('pilot-features lookup failure is treated as unauthorized, not as a crash', async () => {
        mockModels.ShopPilotFeatures.findByPk.mockRejectedValue(new Error('boom'));
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(res.body.data.verdict).toBe('INSUFFICIENT_EVIDENCE');
        expect(res.body.data.criteria.authorizedShop.met).toBe(false);
    });
});

describe('qualification endpoint — aggregate-only, zero PII, no writes', () => {
    test('response is exactly the shop envelope plus the evaluator verdict', async () => {
        mockRollup.mockResolvedValue(passingRollup());
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual([
            'contractStatus', 'contractVersion', 'criteria', 'denominators',
            'evaluatedAt', 'firstEligibleObservedAt', 'generatedAt', 'rollupAvailable',
            'shadowToLiveViolationSource', 'shopId', 'verdict', 'windowHours',
        ].sort());
        expect(new Date(res.body.data.generatedAt).toISOString()).toBe(res.body.data.generatedAt);
        expect(new Date(res.body.data.evaluatedAt).toISOString()).toBe(res.body.data.evaluatedAt);
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toMatch(/psid|token_ct|access_token|customer_name|customer_phone|email|page_access|"content"|ai_suggestion|sender_id/i);
    });

    test('performs no writes: no audit rows, no direct queries, reads only', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_A}/confidence-qualification`);
        expect(res.status).toBe(200);
        expect(mockAuditService.logOperation).not.toHaveBeenCalled();
        expect(mockModels.Message.findAll).not.toHaveBeenCalled();
        expect(mockModels.Order.findAll).not.toHaveBeenCalled();
        const { sequelize } = require('src/utils/database/database-setup');
        expect(sequelize.transaction).not.toHaveBeenCalled();
        expect(sequelize.query).not.toHaveBeenCalled();
    });
});
