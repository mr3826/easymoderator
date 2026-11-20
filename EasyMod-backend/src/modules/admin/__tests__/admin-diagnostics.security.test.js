'use strict';

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const mockAuthState = {
    role: 'SUPPORT_ADMIN',
    denyAdmin: false,
};

const mockShop = {
    id: '11111111-1111-4111-8111-111111111111',
    is_active: true,
    settings: {
        ai: { automation_mode: 'DRAFT' },
        ai_emergency_stop: { active: false },
    },
};

const mockModels = {
    Shop: { findByPk: jest.fn() },
    Subscription: { findOne: jest.fn() },
    MetaChannel: { findAll: jest.fn(), count: jest.fn() },
    MetaUserIdentity: { count: jest.fn(), max: jest.fn() },
    Conversation: { name: 'Conversation' },
    Message: { findAll: jest.fn(), count: jest.fn() },
    Order: { findAll: jest.fn(), count: jest.fn() },
    CourierDispatch: { findAll: jest.fn() },
    AuditLog: { findAndCountAll: jest.fn() },
    User: {},
    Invoice: {},
};

const mockReceiptModel = {
    findAll: jest.fn(),
};

jest.mock('src/middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: 'admin-1', role: mockAuthState.role };
        next();
    },
}));

jest.mock('src/middleware/platform-admin.middleware', () => ({
    PLATFORM_ROLES: { SUPPORT_ADMIN: 'SUPPORT_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
    requirePlatformAdmin: () => (_req, _res, next) => {
        if (mockAuthState.denyAdmin) {
            const err = new Error('Forbidden');
            err.status = 403;
            err.code = 'FORBIDDEN';
            return next(err);
        }
        return next();
    },
}));

jest.mock('src/modules/entities', () => mockModels);
jest.mock('src/modules/integration/meta-webhook-receipt.entity', () => mockReceiptModel);
jest.mock('src/utils/cache.service', () => ({
    get: jest.fn(),
    set: jest.fn(),
    deleteForShop: jest.fn(),
}));
jest.mock('src/modules/audit/audit.service', () => ({ logOperation: jest.fn() }));
jest.mock('src/modules/payment/payment-processing-reconciliation.service', () => ({}));
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({
    ORDER_CONFIDENCE_MODES: ['off', 'shadow', 'enforce'],
}));
jest.mock('src/modules/shop/shop.service', () => ({}));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({}));
jest.mock('src/modules/subscription/subscription.service', () => ({}));
jest.mock('src/modules/subscription/partner.service', () => ({}));

const adminRoutes = require('../admin.routes');

function buildApp() {
    const app = express();
    app.use('/api/admin', adminRoutes);
    app.use((err, _req, res, _next) => {
        res.status(err.status || err.statusCode || 500).json({
            success: false,
            code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    });
    return app;
}

describe('Admin shop diagnostics (WP-05 / R4)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthState.denyAdmin = false;
        mockAuthState.role = 'SUPPORT_ADMIN';
        mockModels.Shop.findByPk.mockResolvedValue(mockShop);
        mockModels.MetaChannel.findAll.mockResolvedValue([
            { id: 'ch-1', status: 'CONNECTED', token_expires_at: '2099-01-01T00:00:00.000Z' },
            { id: 'ch-2', status: 'TOKEN_EXPIRED', token_expires_at: '2020-01-01T00:00:00.000Z' },
        ]);
        mockReceiptModel.findAll
            .mockResolvedValueOnce([
                { status: 'PROCESSED', count: '12' },
                { status: 'RETRY_PENDING', count: '2' },
            ])
            .mockResolvedValueOnce([
                { event_type: 'message', count: '14' },
            ]);
        mockModels.Message.findAll.mockResolvedValue([
            { delivery_state: 'SENT', count: '9' },
            { delivery_state: 'HELD', count: '3' },
        ]);
        mockModels.Order.findAll.mockResolvedValue([
            { order_status: 'confirmed', count: '5' },
        ]);
        mockModels.CourierDispatch.findAll.mockResolvedValue([
            { status: 'BOOKED', count: '4' },
        ]);
    });

    test('denies non-admin callers before querying shop data', async () => {
        mockAuthState.denyAdmin = true;
        const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

        expect(res.status).toBe(403);
        expect(mockModels.Shop.findByPk).not.toHaveBeenCalled();
    });

    test('rejects invalid window query with 400 and returns 404 for unknown shop', async () => {
        const app = buildApp();
        const badWindow = await request(app).get(`/api/admin/shops/${mockShop.id}/diagnostics?window=90d`);
        expect(badWindow.status).toBe(400);
        expect(badWindow.body.code).toBe('INVALID_DIAGNOSTICS_WINDOW');

        mockModels.Shop.findByPk.mockResolvedValueOnce(null);
        const missing = await request(app).get(`/api/admin/shops/${mockShop.id}/diagnostics?window=7d`);
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('SHOP_NOT_FOUND');
    });

    test('returns aggregate counts only with zero PII, PSIDs, tokens, or raw messages', async () => {
        const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics?window=24h`);

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            shopId: mockShop.id,
            isActive: true,
            window: '24h',
            ai: {
                automationMode: 'DRAFT',
                emergencyStopActive: false,
            },
            channels: {
                total: 2,
                connected: 1,
                needsReconnect: 1,
                tokenExpired: 1,
                byStatus: { CONNECTED: 1, TOKEN_EXPIRED: 1 },
            },
            webhooks: {
                total: 14,
                byStatus: { PROCESSED: 12, RETRY_PENDING: 2 },
                byEventType: { message: 14 },
            },
            outboundAiMessages: {
                total: 12,
                byDeliveryState: { SENT: 9, HELD: 3 },
            },
            orders: {
                total: 5,
                byStatus: { confirmed: 5 },
            },
            courierDispatches: {
                total: 4,
                byStatus: { BOOKED: 4 },
            },
        });

        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toMatch(/psid|token_ct|access_token|customer_name|customer_phone|email|page_access/i);
    });

    // WP-05 regression: diagnostics must reflect the authoritative
    // shops.ai_emergency_stop column, not the legacy settings-JSON blob.
    describe('emergency stop state (WP-05)', () => {
        // Model Sequelize's attribute projection: a findByPk with `attributes`
        // returns ONLY those columns, so a query that omits ai_emergency_stop
        // cannot see the flag — exactly how the original defect behaved.
        const mockShopRowWithProjection = (row) => {
            mockModels.Shop.findByPk.mockImplementation(async (_id, options = {}) => {
                const attrs = options?.attributes;
                if (!Array.isArray(attrs)) return { ...row };
                return Object.fromEntries(
                    attrs.filter((key) => key in row).map((key) => [key, row[key]]),
                );
            });
        };

        test('reports emergencyStopActive=true when the authoritative column is true', async () => {
            mockShopRowWithProjection({
                ...mockShop,
                ai_emergency_stop: true,
                settings: { ai: { automation_mode: 'MANUAL' } },
            });

            const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

            expect(res.status).toBe(200);
            expect(res.body.data.ai).toHaveProperty('emergencyStopActive');
            expect(res.body.data.ai.emergencyStopActive).toBe(true);
            expect(res.body.data.ai.automationMode).toBe('MANUAL');
        });

        test('reports emergencyStopActive=false when the authoritative column is false', async () => {
            mockShopRowWithProjection({
                ...mockShop,
                ai_emergency_stop: false,
            });

            const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

            expect(res.status).toBe(200);
            expect(res.body.data.ai.emergencyStopActive).toBe(false);
        });

        test('selects the authoritative ai_emergency_stop column for the requested shop only', async () => {
            await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

            expect(mockModels.Shop.findByPk).toHaveBeenCalledWith(
                mockShop.id,
                expect.objectContaining({
                    attributes: expect.arrayContaining(['ai_emergency_stop']),
                }),
            );
        });

        test('column=false overrides a stale settings-JSON stop blob claiming active=true', async () => {
            mockShopRowWithProjection({
                ...mockShop,
                ai_emergency_stop: false,
                settings: {
                    ai: { automation_mode: 'AUTO' },
                    ai_emergency_stop: { active: true },
                },
            });

            const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

            expect(res.status).toBe(200);
            expect(res.body.data.ai.emergencyStopActive).toBe(false);
        });

        test('column=true overrides a settings-JSON stop blob claiming active=false', async () => {
            mockShopRowWithProjection({
                ...mockShop,
                ai_emergency_stop: true,
                settings: {
                    ai: { automation_mode: 'MANUAL' },
                    ai_emergency_stop: { active: false },
                },
            });

            const res = await request(buildApp()).get(`/api/admin/shops/${mockShop.id}/diagnostics`);

            expect(res.status).toBe(200);
            expect(res.body.data.ai.emergencyStopActive).toBe(true);
        });
    });
});
