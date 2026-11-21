'use strict';

/**
 * WP-09 wiring, SQL-level proof: the admin confidence-rollup route runs the
 * REAL reply-confidence-rollup.service against a mocked sequelize, so these
 * tests pin the read-only transaction contract end-to-end through HTTP:
 * READ ONLY transaction, 2s statement timeout, tenant-scoped bind parameters,
 * and SELECT-only SQL. No Postgres, no Redis.
 */

process.env.NODE_ENV = 'test';

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (callback) => callback({ id: 'mock-transaction' }));
const mockAuditService = { logOperation: jest.fn(async () => {}) };

const SHOP_ID = '33333333-3333-4333-8333-333333333333';

const mockModels = {
    Shop: { findByPk: jest.fn(async (id) => ({ id })) },
    Subscription: {}, MetaChannel: {}, MetaUserIdentity: {},
    Conversation: { name: 'Conversation' }, Message: {}, Order: {},
    CourierDispatch: {}, AuditLog: {},
    User: { findByPk: jest.fn(async () => ({ platform_role: 'SUPPORT_ADMIN' })) },
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
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        query: (...args) => mockQuery(...args),
        transaction: (...args) => mockTransaction(...args),
    },
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

beforeEach(() => {
    jest.clearAllMocks();
    mockModels.Shop.findByPk.mockImplementation(async (id) => ({ id }));
    mockQuery.mockImplementation(async (sql) => {
        if (/^\s*SELECT/i.test(sql)) return [[], {}];
        return [[], {}];
    });
});

test('runs the rollup inside a READ ONLY transaction with a 2s statement timeout', async () => {
    const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_ID}/confidence-rollup?hours=48`);

    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
    expect(mockQuery.mock.calls[1][0]).toBe("SET LOCAL statement_timeout = '2s'");
    // Every statement runs inside the same transaction.
    for (const call of mockQuery.mock.calls) {
        expect(call[1]).toMatchObject({ transaction: { id: 'mock-transaction' } });
    }
});

test('binds exactly the path shopId and the validated window into the SELECT', async () => {
    const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_ID}/confidence-rollup?hours=48`);

    expect(res.status).toBe(200);
    const [sql, options] = mockQuery.mock.calls[2];
    expect(sql).toMatch(/FROM conversation_turns/);
    expect(sql).toMatch(/t\.shop_id = \$shopId/);
    expect(sql).toMatch(/LIMIT 5001/);
    expect(options.bind).toEqual({ shopId: SHOP_ID, hours: 48 });
    expect(res.body.data.shopId).toBe(SHOP_ID);
    expect(res.body.data.hours).toBe(48);
});

test('issues no INSERT/UPDATE/DELETE/DDL and writes no audit rows', async () => {
    const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_ID}/confidence-rollup`);

    expect(res.status).toBe(200);
    for (const [sql] of mockQuery.mock.calls) {
        expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
    }
    expect(mockQuery.mock.calls[2][0]).toMatch(/^\s*SELECT/i);
    expect(mockAuditService.logOperation).not.toHaveBeenCalled();
});

test('returns a zeroed aggregate report for a shop with no scored turns', async () => {
    const res = await request(buildApp()).get(`/api/admin/shops/${SHOP_ID}/confidence-rollup`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
        shopId: SHOP_ID, hours: 24, turns: 0, truncated: false,
        missing: 0, suggestion: 0, delivered: 0, unscored: 0,
        wouldHold: 0, wouldHoldCovered: 0, wouldHoldUnknown: 0,
        reasons: {}, retrieval: {}, retrievalCovered: 0, retrievalUnknown: 0,
        computeP95Ms: null,
    });
});
