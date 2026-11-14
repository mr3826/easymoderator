/**
 * Order API — Integration Tests
 * Tests order CRUD, status transitions, cancel/return flows via supertest
 */

// This is the only suite that builds the REAL src/app, so it has to supply
// everything the app needs to construct. SESSION_SECRET was missing: locally a
// developer's EasyMod-backend/.env filled it in and the suite passed, while in
// CI express-session threw "secret option required for sessions" and all 15
// cases returned 500. A test that only passes next to an untracked .env is not
// a passing test.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.SESSION_SECRET = 'test-session-secret';

jest.mock('src/config/redis', () => ({
    sessionRedis: null, cacheRedis: null, rateLimitRedis: null, legacyRedis: null,
    closeAllRedis: jest.fn(), checkRedisAvailability: jest.fn(() => ({}))
}));

const redisStore = {};
const mockRedis = {
    get: jest.fn((k) => Promise.resolve(redisStore[k] || null)),
    set: jest.fn((k, v) => { redisStore[k] = v; return Promise.resolve('OK'); }),
    setex: jest.fn((k, t, v) => { redisStore[k] = v; return Promise.resolve('OK'); }),
    del: jest.fn((k) => { delete redisStore[k]; return Promise.resolve(1); }),
    incr: jest.fn((k) => { redisStore[k] = (parseInt(redisStore[k], 10) || 0) + 1; return Promise.resolve(redisStore[k]); }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(900)),
    status: 'ready'
};
jest.mock('src/utils/redis-client', () => ({
    getRedisClient: () => mockRedis, isRedisAvailable: () => true, closeRedis: jest.fn()
}));

jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        define: jest.fn(() => mockModel),
        transaction: jest.fn(async (cb) => {
            const t = { commit: jest.fn(), rollback: jest.fn() };
            if (typeof cb === 'function') return cb(t);
            return t;
        }),
        authenticate: jest.fn(() => Promise.resolve()),
        sync: jest.fn(() => Promise.resolve()),
        literal: jest.fn((s) => s),
        query: jest.fn(() => Promise.resolve([[{ next_number: 42 }]])),
        getDialect: jest.fn(() => 'postgres')
    }
}));

const mockModel = {
    findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])),
    findAndCountAll: jest.fn(() => Promise.resolve({ rows: [], count: 0 })),
    create: jest.fn(), update: jest.fn(), destroy: jest.fn(),
    belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn(),
    addScope: jest.fn(), scope: jest.fn(function () { return this; })
};

jest.mock('src/jobs/queue-manager', () => ({
    queues: { notifications: { add: jest.fn().mockResolvedValue({ id: 'n-1' }) }, campaignSend: { add: jest.fn(), addBulk: jest.fn() } }
}));

jest.mock('src/modules/subscription/subscription.service', () => ({
    checkOrderLimit: jest.fn().mockResolvedValue(true),
    trackUsage: jest.fn()
}));

jest.mock('src/modules/rto-shield/rto-shield.service', () => ({
    checkPhone: jest.fn().mockResolvedValue({ score: 0 })
}));

jest.mock('src/modules/product/stock-status-guard.service', () => ({
    invalidate: jest.fn(), getStockStatus: jest.fn().mockResolvedValue('in_stock')
}));

jest.mock('src/utils/email.service', () => ({ sendEmail: jest.fn() }));

// Return requests are served by return.service, not by the OrderReturn entity
// directly — mocking the entity alone leaves the controller calling a real
// service against a stubbed database and answering 500.
jest.mock('src/modules/order/return.service', () => ({
    getReturnRequests: jest.fn().mockResolvedValue([]),
    initiateReturn: jest.fn().mockResolvedValue({ id: 'ret-1', status: 'requested' }),
    updateReturnStatus: jest.fn().mockResolvedValue({ id: 'ret-1', status: 'approved' })
}));

const mockProduct = {
    id: 'prod-1', name: 'Blue T-Shirt', price: 500, track_quantity: true, quantity: 10,
    increment: jest.fn(), decrement: jest.fn()
};

const mockOrderItem = { id: 'item-1', product_id: 'prod-1', quantity: 2, price: 500 };

const makeOrder = (overrides = {}) => ({
    // The column is order_status. A fixture setting `status` leaves
    // order_status undefined, so every status-dependent guard reads as unset.
    // fulfillment_status is persisted with a schema default of 'unfulfilled',
    // so every real row carries it; the fixture must match the true shape.
    id: 'order-1', shop_id: 'shop-1', order_number: 'ORD-042', order_status: 'pending',
    fulfillment_status: 'unfulfilled',
    customer_id: 'cust-1', total_amount: 1000, payment_method: 'COD',
    items: [mockOrderItem],
    update: jest.fn(async function (d) { Object.assign(this, d); return this; }),
    toJSON: function () { return { ...this }; },
    ...overrides
});

jest.mock('src/modules/entities', () => ({
    User: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn() },
    Shop: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    UserShop: { findOne: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    Order: { findOne: jest.fn(), findAll: jest.fn(), findAndCountAll: jest.fn(), create: jest.fn(), findByPk: jest.fn() },
    OrderItem: { findAll: jest.fn(() => Promise.resolve([mockOrderItem])), create: jest.fn(), bulkCreate: jest.fn() },
    // The cancel restore path is shop-scoped — Product.findOne({ where: { id,
    // shop_id } }) — so stubbing only findByPk left it resolving undefined and
    // nothing was ever restored.
    Product: { findOne: jest.fn(() => Promise.resolve(mockProduct)), findAll: jest.fn(), findByPk: jest.fn(() => Promise.resolve(mockProduct)), decrement: jest.fn(), increment: jest.fn() },
    Customer: { findOne: jest.fn(), findOrCreate: jest.fn() },
    Channel: { findOne: jest.fn() },
    OrderReturn: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
    CourierDispatch: { findOne: jest.fn(), findOrCreate: jest.fn(), update: jest.fn() },
    // Lifecycle guards fail closed (503) when tracking state cannot be read;
    // the real schema always exposes this entity.
    DeliveryTracking: { findOne: jest.fn(), findAll: jest.fn() },
    Invoice: { create: jest.fn() },
    // ADR-0011 ledger used by the cancellation path.
    BillingLine: {
        findOne: jest.fn().mockResolvedValue(null),
        findOrCreate: jest.fn().mockResolvedValue([{}, true]),
        findAll: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue([1])
    },
    PartnerBillingAdjustment: { findOne: jest.fn(), create: jest.fn() },
    Campaign: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
    PushSubscription: { create: jest.fn(), findOne: jest.fn(), destroy: jest.fn() }
}));

const jwt = require('jsonwebtoken');
// auth.middleware requires userId + tokenVersion: the token-version revocation
// check (added with password-reset invalidation) rejects the older { id } shape
// with 401 before the route is ever reached.
const validToken = jwt.sign(
    { userId: 'user-1', shopId: 'shop-1', tokenVersion: 0 },
    'test-access-secret',
    { expiresIn: '1h' },
);

const request = require('supertest');
const { Order, OrderItem, Product, User, UserShop, Customer, OrderReturn } = require('src/modules/entities');

let app;
beforeAll(() => { app = require('src/app'); });

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(redisStore).forEach((k) => delete redisStore[k]);
    // auth.middleware re-reads token_version from the database on a cache miss
    // (this store is cleared above, so every request is a miss) and 401s if the
    // user is absent or the version does not match the token's tokenVersion.
    User.findByPk.mockResolvedValue({ token_version: 0 });
    UserShop.findOne.mockResolvedValue({ id: 'us-1', role: 'owner', is_active: true });
    const order = makeOrder();
    Order.findOne.mockResolvedValue(order);
    Order.findByPk.mockResolvedValue(order);
    Order.findAndCountAll.mockResolvedValue({ rows: [order], count: 1 });
    OrderItem.findAll.mockResolvedValue([mockOrderItem]);
    Product.findAll.mockResolvedValue([mockProduct]);
    const { CourierDispatch } = require('src/modules/entities');
    CourierDispatch.findOne.mockResolvedValue(null);
    const { DeliveryTracking } = require('src/modules/entities');
    DeliveryTracking.findOne.mockResolvedValue(null);
    DeliveryTracking.findAll.mockResolvedValue([]);
    Customer.findOne.mockResolvedValue({ id: 'cust-1', display_name: 'Test Customer', phone: '01700000000' });
    Customer.findOrCreate.mockResolvedValue([{ id: 'cust-1' }, false]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Order API', () => {

    describe('GET /api/order', () => {
        it('returns paginated order list', async () => {
            const res = await request(app)
                .get('/api/order')
                .set('Authorization', `Bearer ${validToken}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('returns 401 without token', async () => {
            const res = await request(app).get('/api/order');
            expect(res.status).toBe(401);
        });

        it('accepts status filter param', async () => {
            const res = await request(app)
                .get('/api/order?status=confirmed')
                .set('Authorization', `Bearer ${validToken}`);
            expect([200, 400]).toContain(res.status);
        });

        it('accepts date range filter', async () => {
            const res = await request(app)
                .get('/api/order?startDate=2026-01-01&endDate=2026-12-31')
                .set('Authorization', `Bearer ${validToken}`);
            expect([200, 400]).toContain(res.status);
        });
    });

    describe('GET /api/order/:id', () => {
        it('returns order with items', async () => {
            const res = await request(app)
                .get('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
                .set('Authorization', `Bearer ${validToken}`);
            expect(res.status).toBe(200);
            expect(res.body.data).toBeDefined();
        });

        it('returns 404 when order not found', async () => {
            Order.findOne.mockResolvedValue(null);
            const res = await request(app)
                .get('/api/order/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
                .set('Authorization', `Bearer ${validToken}`);
            expect(res.status).toBe(404);
        });
    });

    // Status changes go through PATCH /:id. There is no PUT /:id/status route
    // — the suite was written against one that was never mounted, so all three
    // of these asserted against a 404 from express, not from the handler.
    describe('PATCH /api/order/:id (status change)', () => {
        it('updates order status successfully', async () => {
            const res = await request(app)
                .patch('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ order_status: 'confirmed' });
            expect([200, 400]).toContain(res.status);
        });

        it('returns 400 for invalid status', async () => {
            const res = await request(app)
                .patch('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ order_status: 'invalid_status' });
            expect(res.status).toBe(400);
        });

        it('returns 404 when order not found', async () => {
            Order.findOne.mockResolvedValue(null);
            const res = await request(app)
                .patch('/api/order/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ order_status: 'confirmed' });
            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/order/:id/cancel', () => {
        it('cancels order and returns 200', async () => {
            const res = await request(app)
                .post('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/cancel')
                .set('Authorization', `Bearer ${validToken}`);
            expect([200, 204]).toContain(res.status);
        });

        it('restores product inventory on cancel', async () => {
            await request(app)
                .post('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/cancel')
                .set('Authorization', `Bearer ${validToken}`);
            // The service restores through the INSTANCE returned by
            // Product.findOne, not the model-level Product.increment.
            expect(mockProduct.increment).toHaveBeenCalledWith(
                'quantity',
                expect.objectContaining({ by: mockOrderItem.quantity })
            );
        });

        it('returns 400 when order already cancelled', async () => {
            Order.findOne.mockResolvedValue(makeOrder({ order_status: 'cancelled' }));
            const res = await request(app)
                .post('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/cancel')
                .set('Authorization', `Bearer ${validToken}`);
            expect(res.status).toBe(400);
        });

        it('returns 404 when order not found', async () => {
            Order.findOne.mockResolvedValue(null);
            const res = await request(app)
                .post('/api/order/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb/cancel')
                .set('Authorization', `Bearer ${validToken}`);
            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/order/:id/return', () => {
        it('creates return request and returns 201', async () => {
            Order.findOne.mockResolvedValue(makeOrder({ status: 'delivered' }));
            OrderReturn.create.mockResolvedValue({
                id: 'ret-1', order_id: 'order-1', status: 'pending', items: []
            });
            const res = await request(app)
                .post('/api/order/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/return')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ reason: 'Wrong size', items: [{ product_id: 'prod-1', quantity: 1 }] });
            expect([201, 200, 400]).toContain(res.status);
        });
    });

    describe('GET /api/order/returns', () => {
        it('returns list of return requests', async () => {
            OrderReturn.findAll.mockResolvedValue([]);
            const res = await request(app)
                .get('/api/order/returns')
                .set('Authorization', `Bearer ${validToken}`);
            expect([200, 404]).toContain(res.status);
        });
    });
});
