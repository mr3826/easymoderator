'use strict';

const express = require('express');
const request = require('supertest');

const SHOP_ONE = '11111111-1111-4111-8111-111111111111';
const SHOP_TWO = '22222222-2222-4222-8222-222222222222';
const mockGapCreate = jest.fn();
const mockAuditCreate = jest.fn();
let mockRequiredGrowthPermission = null;
const mockRequireGrowthOsAccess = jest.fn((requiredPermission) => (req, res, next) => {
    mockRequiredGrowthPermission = requiredPermission;
    if (requiredPermission !== 'growth_os.reports.read_all'
        || req.get('x-growth-permission') !== requiredPermission) {
        return res.status(403).json({ success: false, error: { code: 'GROWTH_OS_FORBIDDEN' } });
    }
    req.growthOs = { role: 'FOUNDER', permissions: [requiredPermission] };
    return next();
});
const mockTransaction = { id: 'security-test-transaction' };
const mockSequelize = {
    query: jest.fn(),
    transaction: jest.fn(async (callback) => callback(mockTransaction)),
};

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (...args) => {
        const middleware = (req, res, next) => {
            if (req.get('authorization') !== 'Bearer merchant-shop-one') {
                return res.status(401).json({ error: 'Authentication required' });
            }
            req.user = { userId: 'user-1', shopId: SHOP_ONE };
            return next();
        };
        return args.length === 1 ? middleware : middleware(...args);
    },
}));
jest.mock('../knowledge-gap.entity', () => ({ create: mockGapCreate }));
jest.mock('../../entities', () => ({ AuditLog: { create: mockAuditCreate } }));
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockSequelize }));
jest.mock('../analytics-enhanced.service', () => ({
    getTopUnansweredQuestions: jest.fn(),
    getPeakHours: jest.fn(),
    getIntentBreakdown: jest.fn(),
    getConfidenceDistribution: jest.fn(),
}));
jest.mock('../growth-metrics.service', () => ({ getGrowthMetrics: jest.fn() }));
jest.mock('../../growth-os/growth-os.middleware', () => ({
    requireGrowthOsAccess: mockRequireGrowthOsAccess,
}));
jest.mock('../funnel-events.service', () => ({
    ALLOWED_FUNNEL_EVENTS: new Set(),
    PUBLIC_FUNNEL_EVENTS: new Set(),
    recordFunnelEvent: jest.fn(),
}));

const router = require('../analytics.routes');
const growthMetrics = require('../growth-metrics.service');

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api/analytics', router);
    return instance;
}

describe('knowledge-gap route tenant perimeter', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGapCreate.mockResolvedValue({ id: 'gap-1' });
        mockAuditCreate.mockResolvedValue({});
    });

    test('rejects anonymous and cross-shop writes before persistence', async () => {
        await request(app())
            .post('/api/analytics/knowledge-gap')
            .send({ question: 'Unknown item?', platform: 'messenger' })
            .expect(401);

        await request(app())
            .post('/api/analytics/knowledge-gap')
            .set('authorization', 'Bearer merchant-shop-one')
            .send({
                question: 'Cross-shop question',
                platform: 'messenger',
                shop_id: SHOP_TWO,
            })
            .expect(403);

        expect(mockGapCreate).not.toHaveBeenCalled();
        expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    test('writes the token shop and audit event in one transaction', async () => {
        await request(app())
            .post('/api/analytics/knowledge-gap')
            .set('authorization', 'Bearer merchant-shop-one')
            .send({ question: 'Do you stock this?', platform: 'messenger' })
            .expect(200);

        expect(mockGapCreate).toHaveBeenCalledWith(
            expect.objectContaining({ shop_id: SHOP_ONE }),
            { transaction: mockTransaction },
        );
        expect(mockAuditCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                shop_id: SHOP_ONE,
                action: 'knowledge_gap_created',
            }),
            { transaction: mockTransaction },
        );
    });
});

describe('growth analytics authorization', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        growthMetrics.getGrowthMetrics.mockResolvedValue({ totals: {}, shops: [] });
    });

    test('requires the full cross-shop Growth reports permission', async () => {
        await request(app())
            .get('/api/analytics/growth')
            .set('authorization', 'Bearer merchant-shop-one')
            .expect(403);

        expect(mockRequiredGrowthPermission).toBe('growth_os.reports.read_all');
        expect(growthMetrics.getGrowthMetrics).not.toHaveBeenCalled();
    });

    test('returns metrics after the Growth reports permission guard passes', async () => {
        await request(app())
            .get('/api/analytics/growth')
            .set('authorization', 'Bearer merchant-shop-one')
            .set('x-growth-permission', 'growth_os.reports.read_all')
            .expect(200);

        expect(growthMetrics.getGrowthMetrics).toHaveBeenCalledTimes(1);
    });

    test('returns a sanitized unavailable response when Growth metrics fail', async () => {
        growthMetrics.getGrowthMetrics.mockRejectedValueOnce(new Error('database connection details'));

        const response = await request(app())
            .get('/api/analytics/growth')
            .set('authorization', 'Bearer merchant-shop-one')
            .set('x-growth-permission', 'growth_os.reports.read_all')
            .expect(503);

        expect(response.body).toEqual({
            success: false,
            error: {
                code: 'GROWTH_METRICS_ERROR',
                message: 'Growth OS metrics are temporarily unavailable.',
            },
        });
        expect(JSON.stringify(response.body)).not.toContain('database connection details');
    });

    test('does not turn analytics query failures into zero-valued success data', async () => {
        mockSequelize.query.mockRejectedValueOnce(new Error('analytics database details'));

        const response = await request(app())
            .get('/api/analytics')
            .set('authorization', 'Bearer merchant-shop-one')
            .expect(503);

        expect(response.body).toEqual({
            success: false,
            error: {
                code: 'ANALYTICS_ERROR',
                message: 'Analytics are temporarily unavailable.',
            },
        });
        expect(JSON.stringify(response.body)).not.toContain('analytics database details');
    });
});
