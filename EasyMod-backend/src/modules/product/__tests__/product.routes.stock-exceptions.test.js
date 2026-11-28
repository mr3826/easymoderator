'use strict';

/**
 * Phase 1 C2 route surface: GET /api/product/stock-exceptions must be
 * registered BEFORE /:id (no param capture) and share the product siblings'
 * guard chain (router-level authenticate; the global authenticated rate
 * limiter applies; tenant scoping is the FIRST predicate in the service).
 */

const express = require('express');
const request = require('supertest');
const { globalErrorHandler } = require('../../../utils/AppError');

const mockAuthenticate = jest.fn((req, _res, next) => {
    req.user = { userId: 'user-1', shopId: 'shop-1' };
    next();
});

const mockController = {
    getProducts: jest.fn((_req, res) => res.status(200).json({ success: true, data: [] })),
    extractProducts: jest.fn((_req, res) => res.status(200).json({ success: true })),
    searchProducts: jest.fn((_req, res) => res.status(200).json({ products: [] })),
    detectMentions: jest.fn((_req, res) => res.status(200).json({ success: true })),
    bulkUpdateProducts: jest.fn((_req, res) => res.status(200).json({ success: true })),
    uploadProductImage: jest.fn((_req, res) => res.status(201).json({ success: true })),
    getUpsellsForCart: jest.fn((_req, res) => res.status(200).json({ success: true, data: [] })),
    getProductUpsells: jest.fn((_req, res) => res.status(200).json({ success: true, data: [] })),
    getStockExceptions: jest.fn((_req, res) => res.status(200).json({
        success: true,
        data: {
            outOfStock: 0, lowStock: 0, exceptions: 0,
            scanned: 0, cap: 1000, coverageComplete: true,
            generated_at: '2026-11-24T10:00:00.000Z',
        },
    })),
    getOverview: jest.fn((_req, res) => res.status(200).json({
        success: true,
        data: { total: 4, active: 3, inactive: 1, low_stock: 1, out_of_stock: 2 },
    })),
    getProductById: jest.fn((_req, res) => res.status(200).json({ success: true, data: { id: 'by-id' } })),
    createProductRest: jest.fn((_req, res) => res.status(201).json({ success: true })),
    updateProductById: jest.fn((_req, res) => res.status(200).json({ success: true })),
    deleteProductById: jest.fn((_req, res) => res.status(200).json({ success: true })),
    listProducts: jest.fn((_req, res) => res.status(200).json({ success: true })),
    getProduct: jest.fn((_req, res) => res.status(200).json({ success: true })),
    createProduct: jest.fn((_req, res) => res.status(201).json({ success: true })),
    updateProduct: jest.fn((_req, res) => res.status(200).json({ success: true })),
    deleteProduct: jest.fn((_req, res) => res.status(200).json({ success: true })),
};

jest.mock('../../../middleware/auth.middleware', () => ({ authenticate: mockAuthenticate }));
jest.mock('../product.controller', () => mockController);
jest.mock('../product.validator', () => ({
    getProducts: {},
    getProductById: {},
    createProduct: {},
    updateProduct: {},
    deleteProduct: {},
    aiExtract: {},
    legacyGet: {},
    legacyUpdate: {},
    legacyDelete: {},
}));
jest.mock('../../helpers', () => ({ validate: () => (_req, _res, next) => next() }));

describe('product.routes — stock-exceptions registration', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/product', require('../product.routes'));
        app.use(globalErrorHandler);
    });

    it('serves /stock-exceptions via the C2 handler BEFORE /:id (Phase 1 C2)', async () => {
        const res = await request(app).get('/api/product/stock-exceptions');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            outOfStock: 0, lowStock: 0, exceptions: 0,
            scanned: 0, cap: 1000, coverageComplete: true,
            generated_at: '2026-11-24T10:00:00.000Z',
        });
        expect(mockController.getStockExceptions).toHaveBeenCalledTimes(1);
        expect(mockController.getProductById).not.toHaveBeenCalled();
        expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('a real UUID id still routes to getProductById (no regression on /:id)', async () => {
        const res = await request(app).get('/api/product/550e8400-e29b-41d4-a716-446655440000');

        expect(res.status).toBe(200);
        expect(mockController.getProductById).toHaveBeenCalledTimes(1);
        expect(mockController.getStockExceptions).not.toHaveBeenCalled();
    });

    it('serves /overview through its handler BEFORE /:id under the router auth guard', async () => {
        const res = await request(app).get('/api/product/overview');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ total: 4, active: 3, inactive: 1, low_stock: 1, out_of_stock: 2 });
        expect(mockController.getOverview).toHaveBeenCalledTimes(1);
        expect(mockController.getProductById).not.toHaveBeenCalled();
        expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('propagates handler 5xx — the client maps failure to null, never to zero counts', async () => {
        mockController.getStockExceptions.mockImplementationOnce((_req, _res, next) => {
            next(new Error('db down'));
        });

        const res = await request(app).get('/api/product/stock-exceptions');

        expect(res.status).toBeGreaterThanOrEqual(500);
    });
});
