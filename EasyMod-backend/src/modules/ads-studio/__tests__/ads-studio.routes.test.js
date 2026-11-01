'use strict';

const mockGetPilotFeatures = jest.fn();
const mockAssertAddonEnabled = jest.fn();
const mockListReports = jest.fn();
const mockImportManualReport = jest.fn();

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        if (req.headers.authorization !== 'Bearer valid') {
            return next(Object.assign(new Error('Authentication required'), { status: 401, code: 'UNAUTHORIZED' }));
        }
        req.user = { userId: 'user-a', shopId: req.headers['x-shop-id'] || 'shop-a' };
        return next();
    },
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: (req, _res, next) => {
        if (req.headers['x-membership'] === 'denied') {
            return next(Object.assign(new Error('Shop membership is not active'), { status: 403, code: 'FORBIDDEN' }));
        }
        req.activeMembership = { shop_id: req.user.shopId, role: 'owner' };
        return next();
    },
}));
jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: mockGetPilotFeatures,
    getPilotFeaturesStrict: mockGetPilotFeatures,
}));
jest.mock('../../shop-addons/shop-addons.service', () => ({ assertAddonEnabled: mockAssertAddonEnabled }), { virtual: true });
jest.mock('../ads-studio.service', () => ({
    listReports: mockListReports,
    importManualReport: mockImportManualReport,
    getReport: jest.fn(),
    listDrafts: jest.fn(),
    createDraft: jest.fn(),
    updateDraft: jest.fn(),
    approveDraft: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const routes = require('../ads-studio.routes');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ads-studio', routes);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetPilotFeatures.mockResolvedValue({ adsStudio: true });
    mockAssertAddonEnabled.mockResolvedValue(undefined);
    mockListReports.mockResolvedValue([]);
});

describe('Ads Studio route gates', () => {
    test('rejects unauthenticated requests before feature or add-on lookup', async () => {
        const response = await request(buildApp()).get('/api/ads-studio/reports');
        expect(response.status).toBe(401);
        expect(mockGetPilotFeatures).not.toHaveBeenCalled();
        expect(mockAssertAddonEnabled).not.toHaveBeenCalled();
    });

    test('rejects users without active shop membership before feature lookup', async () => {
        const response = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid')
            .set('x-membership', 'denied');
        expect(response.status).toBe(403);
        expect(mockGetPilotFeatures).not.toHaveBeenCalled();
    });

    test('denies the platform-disabled path without calling the add-on or data service', async () => {
        mockGetPilotFeatures.mockResolvedValue({ adsStudio: false });
        const response = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid');
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('FEATURE_DISABLED');
        expect(mockAssertAddonEnabled).not.toHaveBeenCalled();
        expect(mockListReports).not.toHaveBeenCalled();
    });

    test('fails closed when platform eligibility lookup is unavailable', async () => {
        mockGetPilotFeatures.mockRejectedValue(new Error('feature store down'));
        const response = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid');
        expect(response.status).toBe(503);
        expect(mockAssertAddonEnabled).not.toHaveBeenCalled();
        expect(mockListReports).not.toHaveBeenCalled();
    });

    test('fails closed when merchant add-on lookup is unavailable or disabled', async () => {
        mockAssertAddonEnabled.mockRejectedValueOnce(Object.assign(new Error('addon store down'), {
            status: 503, code: 'ADDON_GATE_UNAVAILABLE',
        }));
        const unavailable = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid');
        expect(unavailable.status).toBe(503);
        expect(mockListReports).not.toHaveBeenCalled();

        mockAssertAddonEnabled.mockRejectedValueOnce(Object.assign(new Error('add-on not available'), {
            status: 404, code: 'ADDON_NOT_AVAILABLE',
        }));
        const disabled = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid');
        expect(disabled.status).toBe(404);
        expect(disabled.body.code).toBe('ADDON_NOT_AVAILABLE');
        expect(mockListReports).not.toHaveBeenCalled();
    });

    test('passes shop identity to both gates and serves a report list only when both pass', async () => {
        const response = await request(buildApp())
            .get('/api/ads-studio/reports')
            .set('Authorization', 'Bearer valid')
            .set('x-shop-id', 'shop-b');
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
        expect(mockGetPilotFeatures).toHaveBeenCalledWith('shop-b');
        expect(mockAssertAddonEnabled).toHaveBeenCalledWith('shop-b', 'ADS_STUDIO');
        expect(mockListReports).toHaveBeenCalledWith('shop-b');
    });

    test('rejects JSON in place of a raw CSV upload', async () => {
        const response = await request(buildApp())
            .post('/api/ads-studio/reports/import')
            .set('Authorization', 'Bearer valid')
            .send({ csv: 'Campaign name' });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(mockImportManualReport).not.toHaveBeenCalled();
    });
});
