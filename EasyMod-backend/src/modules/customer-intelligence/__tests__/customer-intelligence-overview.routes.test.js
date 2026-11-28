'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: 'user-a', shopId: 'shop-a' };
        next();
    },
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: jest.fn((_req, _res, next) => next()),
}));
jest.mock('../../helpers', () => ({ validate: () => (_req, _res, next) => next() }));
jest.mock('../customer-intelligence.validator', () => ({
    listCustomers: {}, customerParams: {}, listOpportunities: {}, summary: {},
    contactedOpportunity: {}, dismissOpportunity: {},
}));
jest.mock('../../pilot-features/pilot-features.service', () => ({ getPilotFeatures: jest.fn() }));
jest.mock('../customer-intelligence-overview.service', () => ({ getOverview: jest.fn() }));
jest.mock('../customer-360.service', () => ({ listCustomers: jest.fn(), getCustomerDetail: jest.fn() }));
jest.mock('../opportunity.service', () => ({
    listOpportunities: jest.fn(), summary: jest.fn(), serializeOpportunity: jest.fn(),
    markContacted: jest.fn(), dismiss: jest.fn(),
}));
jest.mock('../../audit/audit.service', () => ({ logOperation: jest.fn() }));

const { getPilotFeatures } = require('../../pilot-features/pilot-features.service');
const overviewService = require('../customer-intelligence-overview.service');
const { verifyShopAccess } = require('../../../middleware/shop-access.middleware');

describe('GET /api/customer-intelligence/overview gate and tenant scope', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        getPilotFeatures.mockResolvedValue({ customerIntelligence: true });
        overviewService.getOverview.mockResolvedValue({ total_records: 5, open_opportunities: 1 });
        app = express();
        app.use('/api/customer-intelligence', require('../customer-intelligence.routes'));
        app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, message: error.message }));
    });

    it('runs auth and shop access, then scopes overview to the verified shop', async () => {
        const response = await request(app).get('/api/customer-intelligence/overview');

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ total_records: 5, open_opportunities: 1 });
        expect(verifyShopAccess).toHaveBeenCalledTimes(1);
        expect(getPilotFeatures).toHaveBeenCalledWith('shop-a');
        expect(overviewService.getOverview).toHaveBeenCalledWith('shop-a');
    });

    it('keeps the overview behind requireCustomerIntelligence', async () => {
        getPilotFeatures.mockResolvedValue({ customerIntelligence: false });

        const response = await request(app).get('/api/customer-intelligence/overview');

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('FEATURE_DISABLED');
        expect(overviewService.getOverview).not.toHaveBeenCalled();
    });

    it('propagates overview failures as server errors instead of fabricated counts', async () => {
        overviewService.getOverview.mockRejectedValue(new Error('overview database failed'));

        const response = await request(app).get('/api/customer-intelligence/overview');

        expect(response.status).toBe(500);
        expect(response.body.message).toBe('overview database failed');
    });
});
