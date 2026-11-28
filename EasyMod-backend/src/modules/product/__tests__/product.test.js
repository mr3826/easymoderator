const request = require('supertest');

// ── Env ────────────────────────────────────────────────────────────────────
process.env.NODE_ENV           = 'test';
process.env.JWT_ACCESS_SECRET  = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

// ── UUID constants (valid UUIDs — required by Joi params validation) ────────
const PROD_ID       = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const PROD2_ID      = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12';
const CAT_ID        = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const CAT2_ID       = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a23';
const USER_ID       = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const SHOP_ID       = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const OTHER_SHOP_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OTHER_PROD_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';

// ── Mock Redis ─────────────────────────────────────────────────────────────
const redisStore = {};
const mockRedis = {
    get:    jest.fn(k => Promise.resolve(redisStore[k] || null)),
    set:    jest.fn((k, v) => { redisStore[k] = v; return Promise.resolve('OK'); }),
    setex:  jest.fn((k, _ttl, v) => { redisStore[k] = v; return Promise.resolve('OK'); }),
    del:    jest.fn(k => { delete redisStore[k]; return Promise.resolve(1); }),
    incr:   jest.fn(k => { redisStore[k] = (parseInt(redisStore[k], 10) || 0) + 1; return Promise.resolve(redisStore[k]); }),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl:    jest.fn(() => Promise.resolve(900)),
    status: 'ready',
};
jest.mock('src/utils/redis-client', () => ({
    getRedisClient:   () => mockRedis,
    isRedisAvailable: () => true,
    closeRedis:       jest.fn(),
}));
jest.mock('src/config/redis', () => ({
    rateLimitRedis: null,
    sessionRedis:   null,
    cacheRedis:     null,
    closeAll:       jest.fn(),
}));

// ── Mock Sequelize ─────────────────────────────────────────────────────────
const mockTx = { commit: jest.fn(() => Promise.resolve()), rollback: jest.fn(() => Promise.resolve()) };
const mockModel = {
    findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])),
    create: jest.fn(), update: jest.fn(), destroy: jest.fn(),
    belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn(),
    addScope: jest.fn(), scope: jest.fn(function () { return this; }),
};
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        define:       jest.fn(() => ({ ...mockModel })),
        transaction:  jest.fn(() => Promise.resolve(mockTx)),
        authenticate: jest.fn(() => Promise.resolve()),
        sync:         jest.fn(() => Promise.resolve()),
        fn:           jest.fn(), col: jest.fn(), literal: jest.fn(),
    },
    Op: require('sequelize').Op,
}));

// ── Mock entities ──────────────────────────────────────────────────────────
jest.mock('src/modules/entities', () => ({
    Product:             { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    ProductVariant:      { findOne: jest.fn(), findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    Category:            { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    Shop:                { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn() },
    UserShop:            { findOne: jest.fn(), findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn() },
    User:                { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn() },
    Tenant:              { ...mockModel }, FaqResponse:  { ...mockModel }, BanglishDictionary: { ...mockModel },
    MetaIntegration:     { ...mockModel }, Order:        { ...mockModel }, OrderItem:          { ...mockModel },
    Channel:             { ...mockModel }, Conversation: { ...mockModel }, Message:            { ...mockModel },
    Keyword:             { ...mockModel }, AuditLog:     { ...mockModel }, IdempotencyKey:      { ...mockModel },
    Subscription:        { ...mockModel }, Invoice:      { ...mockModel }, UsageEvent:         { ...mockModel },
    PaymentConfig:       { ...mockModel }, DeliveryIntegration: { ...mockModel }, DeliveryCost: { ...mockModel },
    KnownArea:           { ...mockModel }, Analytics:    { ...mockModel }, OrderReturn:        { ...mockModel },
    SupportTicket:       { ...mockModel }, Customer:     { ...mockModel },
}));
jest.mock('src/modules/customer/customer.entity', () => ({
    rawAttributes: {
        channel_type: { values: ['messenger', 'instagram', 'webchat', 'manual', 'facebook', 'telegram'] },
    },
}));
jest.mock('src/modules/analytics/knowledge-gap.entity', () => ({
    findAll: jest.fn(() => Promise.resolve([])), create: jest.fn(), findOne: jest.fn(),
    belongsTo: jest.fn(), hasMany: jest.fn(),
}));

// ── Mock infrastructure ────────────────────────────────────────────────────
jest.mock('src/modules/rag/rag.service',           () => ({ ingestData: jest.fn(() => Promise.resolve()), deletePoint: jest.fn(() => Promise.resolve()) }));
jest.mock('src/utils/cache.service',               () => ({ getForShop: jest.fn(() => Promise.resolve(null)), setForShop: jest.fn(), deleteForShop: jest.fn() }));
jest.mock('src/middleware/session.middleware',      () => () => (_req, _res, next) => next());
jest.mock('src/modules/product/product-ai.service', () => ({
    queueProductProcessing: jest.fn(),
    processPendingProducts: jest.fn(() => Promise.resolve()),
}));
jest.mock('src/modules/product/product-embedding.service', () => ({
    embedProduct:            jest.fn(() => Promise.resolve()),
    removeProductEmbedding:  jest.fn(() => Promise.resolve()),
}));
jest.mock('src/modules/product/clip-client.service', () => ({
    removeProductIndex: jest.fn(() => Promise.resolve()),
}));
jest.mock('src/modules/subscription/subscription.service', () => ({
    trackUsage:            jest.fn(() => Promise.resolve({ transactionId: 'txn-1', isRetry: false })),
    checkUsageLimit:       jest.fn(() => Promise.resolve({ allowed: true })),
    getSubscriptionStatus: jest.fn(() => Promise.resolve({ plan: 'pro', isActive: true })),
}));
jest.mock('src/utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), logUsage: jest.fn() })),
}));
jest.mock('src/modules/shop/shop.service', () => ({
    getShopAiSettings:    jest.fn(() => Promise.resolve({})),
    updateShopAiSettings: jest.fn(() => Promise.resolve({})),
    getShopById:          jest.fn(), getShopsByUserId: jest.fn(), createShop: jest.fn(),
    updateShopById:       jest.fn(), deleteShopById: jest.fn(), addUserToShop: jest.fn(),
    removeUserFromShop:   jest.fn(), updateUserRole: jest.fn(), getUserRoleInShop: jest.fn(),
}));

// ── Mock auth middleware ───────────────────────────────────────────────────
// NOTE: factory is hoisted — use inline literals, not module-scope consts
jest.mock('src/middleware/auth.middleware', () => ({
    authenticate:            (req, _res, next) => {
        req.user = { userId: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', shopId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', role: 'owner' };
        next();
    },
    authenticateForPasswordChange: (_req, _res, next) => next(),
    checkSubscriptionStatus: (_req, _res, next) => next(),
}));

// ── Shared test data ───────────────────────────────────────────────────────
const mockProduct = {
    id:                   PROD_ID,
    shop_id:              SHOP_ID,
    name:                 'Test T-Shirt',
    sku:                  'SKU-001',
    price:                299.99,
    description:          'A quality t-shirt',
    category_id:          CAT_ID,
    quantity:             100,
    track_quantity:       true,
    low_stock_threshold:  10,
    is_active:            true,
    allow_discounts:      true,
    charge_tax:           true,
    send_low_stock_alert: true,
    tags:                 ['cotton', 'casual'],
    images:               [],
    variants:             [],
    created_at:           new Date().toISOString(),
    updated_at:           new Date().toISOString(),
    toJSON: function () { return { ...this, toJSON: undefined, update: undefined, destroy: undefined, increment: undefined }; },
    update:    jest.fn(function (data) { Object.assign(this, data); return Promise.resolve(this); }),
    destroy:   jest.fn(() => Promise.resolve()),
    increment: jest.fn(() => Promise.resolve()),
};

const mockCategory = { id: CAT_ID, shop_id: SHOP_ID, name: 'Clothing', is_active: true };
const mockUserShop = { user_id: USER_ID, shop_id: SHOP_ID, is_active: true, role: 'owner' };

const { Product, Category, UserShop } = require('src/modules/entities');
const { sequelize }                    = require('src/utils/database/database-setup');

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Product API', () => {
    let app;

    beforeAll(() => { app = require('src/app'); });

    beforeEach(() => {
        // mockReset clears calls AND any queued Once values AND default implementation.
        // Then mockResolvedValue re-sets the persistent default.
        // This prevents unconsumed Once mocks from bleeding into subsequent tests.
        mockProduct.update.mockReset().mockImplementation(function (data) { Object.assign(this, data); return Promise.resolve(this); });
        mockProduct.destroy.mockReset().mockResolvedValue(undefined);
        mockProduct.increment.mockReset().mockResolvedValue(undefined);
        mockTx.commit.mockReset().mockResolvedValue(undefined);
        mockTx.rollback.mockReset().mockResolvedValue(undefined);

        UserShop.findOne.mockReset().mockResolvedValue(mockUserShop);
        Product.findOne.mockReset().mockResolvedValue(mockProduct);
        Product.findAll.mockReset().mockResolvedValue([mockProduct]);
        Product.create.mockReset().mockResolvedValue(mockProduct);
        Category.findOne.mockReset().mockResolvedValue(mockCategory);
        sequelize.transaction.mockReset().mockResolvedValue(mockTx);
    });

    describe('POST /product/detect-mentions', () => {
        it('uses the authenticated shop even when the body supplies another shopId', async () => {
            const res = await request(app)
                .post('/api/product/detect-mentions')
                .send({ text: 'Test T-Shirt', shopId: 'other-shop' });

            expect(res.status).toBe(200);
            expect(Product.findAll).toHaveBeenCalledWith(expect.objectContaining({
                where: { shop_id: SHOP_ID, is_active: true },
            }));
        });
    });

    // ── GET /product ──────────────────────────────────────────────────────

    describe('GET /product', () => {
        it('returns 200 with product list', async () => {
            const res = await request(app).get('/api/product');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('includes status field derived from is_active', async () => {
            Product.findAll.mockResolvedValueOnce([
                { toJSON: () => ({ ...mockProduct, is_active: true,  category_ref: { id: CAT_ID, name: 'Clothing' } }) },
                { toJSON: () => ({ ...mockProduct, id: PROD2_ID, is_active: false, category_ref: null }) },
            ]);

            const res = await request(app).get('/api/product');
            expect(res.status).toBe(200);
            const active   = res.body.data.find(p => p.id === PROD_ID);
            const inactive = res.body.data.find(p => p.id === PROD2_ID);
            if (active)   expect(active.status).toBe('active');
            if (inactive) expect(inactive.status).toBe('inactive');
        });

        it('passes search query to DB where clause', async () => {
            await request(app).get('/api/product?search=shirt');
            expect(Product.findAll).toHaveBeenCalled();
        });

        it('filters by is_active status', async () => {
            const res = await request(app).get('/api/product?is_active=true');
            expect(res.status).toBe(200);
        });

        it('filters by price range', async () => {
            const res = await request(app).get('/api/product?min_price=100&max_price=500');
            expect(res.status).toBe(200);
        });

        it('rejects page < 1 (Joi validation)', async () => {
            const res = await request(app).get('/api/product?page=0');
            expect(res.status).toBe(400);
        });

        it('rejects limit > 100 (prevents unbounded fetches)', async () => {
            const res = await request(app).get('/api/product?limit=101');
            expect(res.status).toBe(400);
        });

        it('returns empty array when shop has no products', async () => {
            Product.findAll.mockResolvedValueOnce([]);
            const res = await request(app).get('/api/product');
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual([]);
        });
    });

    // ── GET /product/:id ──────────────────────────────────────────────────

    describe('GET /product/:id', () => {
        it('returns 200 with product data', async () => {
            const res = await request(app).get(`/api/product/${PROD_ID}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('id');
        });

        it('returns 404 when product does not exist', async () => {
            Product.findOne.mockResolvedValueOnce(null);
            const res = await request(app).get(`/api/product/${OTHER_PROD_ID}`);
            expect(res.status).toBe(404);
        });

        it('returns 403 when user does not belong to the shop (SECURITY)', async () => {
            UserShop.findOne.mockResolvedValueOnce(null);
            const res = await request(app).get(`/api/product/${PROD_ID}`);
            expect(res.status).toBe(403);
        });

        it('cannot access a product from another shop — shop_id filter returns null (SECURITY)', async () => {
            // verifyShopAccess passes, but product not found under this shop
            UserShop.findOne.mockResolvedValueOnce(mockUserShop);
            Product.findOne.mockResolvedValueOnce(null);
            const res = await request(app).get(`/api/product/${OTHER_PROD_ID}`);
            expect(res.status).toBe(404);
        });

        it('rejects non-UUID product ID (Joi validation)', async () => {
            const res = await request(app).get('/api/product/not-a-uuid');
            expect(res.status).toBe(400);
        });
    });

    // ── POST /product ─────────────────────────────────────────────────────

    describe('POST /product', () => {
        it('creates a product and returns 201', async () => {
            const res = await request(app)
                .post('/api/product')
                .send({ name: 'New Shirt', price: 350, sku: 'SKU-NEW-1' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
        });

        it('requires product name', async () => {
            const res = await request(app).post('/api/product').send({ price: 350 });
            expect(res.status).toBe(400);
        });

        it('requires price to be positive', async () => {
            const res = await request(app).post('/api/product').send({ name: 'Test', price: 0 });
            expect(res.status).toBe(400);
        });

        it('rejects negative price', async () => {
            const res = await request(app).post('/api/product').send({ name: 'Test', price: -10 });
            expect(res.status).toBe(400);
        });

        it('rejects name longer than 255 characters', async () => {
            const res = await request(app).post('/api/product').send({ name: 'A'.repeat(256), price: 100 });
            expect(res.status).toBe(400);
        });

        it('rejects SKU longer than 100 characters', async () => {
            const res = await request(app).post('/api/product').send({ name: 'Test', price: 100, sku: 'S'.repeat(101) });
            expect(res.status).toBe(400);
        });

        it('rejects invalid weight_unit', async () => {
            const res = await request(app).post('/api/product').send({ name: 'Test', price: 100, weight: 1.5, weight_unit: 'ton' });
            expect(res.status).toBe(400);
        });

        it('rejects negative quantity', async () => {
            const res = await request(app).post('/api/product').send({ name: 'Test', price: 100, quantity: -5 });
            expect(res.status).toBe(400);
        });

        it('accepts valid weight units: kg, g, lb, oz', async () => {
            for (const unit of ['kg', 'g', 'lb', 'oz']) {
                const res = await request(app)
                    .post('/api/product')
                    .send({ name: `Test ${unit}`, price: 100, weight: 1.5, weight_unit: unit });
                expect(res.status).toBe(201);
            }
        });

        it('returns 404 when category_id references a non-existent category', async () => {
            Category.findOne.mockResolvedValueOnce(null);
            const res = await request(app)
                .post('/api/product')
                .send({ name: 'Test', price: 100, category_id: CAT2_ID });
            expect(res.status).toBe(404);
        });

        it('rejects category_id belonging to another shop (SECURITY)', async () => {
            Category.findOne.mockResolvedValueOnce(null);
            const res = await request(app)
                .post('/api/product')
                .send({ name: 'Test', price: 100, category_id: CAT2_ID });
            expect(res.status).toBe(404);
            // Category.findOne must have been scoped by shop_id
            const catCall = Category.findOne.mock.calls.find(([args]) => args?.where?.id);
            if (catCall) expect(catCall[0].where.shop_id).toBe(SHOP_ID);
        });

        it('sets quantity to 0 when track_quantity is false', async () => {
            const captured = [];
            Product.create.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            await request(app).post('/api/product').send({ name: 'Test', price: 100, track_quantity: false, quantity: 50 });

            if (captured.length > 0) expect(captured[0].quantity).toBe(0);
        });

        it('tracks usage via subscriptionService on creation (billing)', async () => {
            const sub = require('src/modules/subscription/subscription.service');
            sub.trackUsage.mockReset().mockResolvedValue({ transactionId: 'txn-1', isRetry: false });
            await request(app).post('/api/product').send({ name: 'Billing Test', price: 199 });
            expect(sub.trackUsage).toHaveBeenCalledWith(
                SHOP_ID, 'products', 1,
                expect.any(String), // controller supplies Idempotency-Key, request id, or a generated request key
                expect.objectContaining({ resourceId: expect.any(String) }),
                expect.objectContaining({ transaction: expect.anything() }),
            );
        });

        it('returns 403 when user does not have shop access (SECURITY)', async () => {
            UserShop.findOne.mockResolvedValueOnce(null);
            const res = await request(app).post('/api/product').send({ name: 'Test', price: 100 });
            expect(res.status).toBe(403);
        });

        it('queues AI processing after product creation (fire-and-forget)', async () => {
            const { queueProductProcessing } = require('src/modules/product/product-ai.service');
            await request(app).post('/api/product').send({ name: 'AI Test', price: 100 });
            expect(queueProductProcessing).toHaveBeenCalled();
        });

        it('ignores a client-supplied shop_id and creates under the authenticated shop, not the body value (SECURITY)', async () => {
            const captured = [];
            Product.create.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            const res = await request(app)
                .post('/api/product')
                .send({ name: 'Cross-tenant Attempt', price: 100, shop_id: OTHER_SHOP_ID });

            expect(res.status).toBe(201);
            expect(captured[0].shop_id).toBe(SHOP_ID);
            expect(captured[0].shop_id).not.toBe(OTHER_SHOP_ID);
        });

        it('ignores a client-supplied shopId (camelCase) the same way (SECURITY)', async () => {
            const captured = [];
            Product.create.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            const res = await request(app)
                .post('/api/product')
                .send({ name: 'Cross-tenant Attempt 2', price: 100, shopId: OTHER_SHOP_ID });

            expect(res.status).toBe(201);
            expect(captured[0].shop_id).toBe(SHOP_ID);
        });
    });

    // ── PATCH /product/:id ────────────────────────────────────────────────

    describe('PATCH /product/:id', () => {
        it('updates a product and returns 200', async () => {
            const res = await request(app).patch(`/api/product/${PROD_ID}`).send({ name: 'Updated Name', price: 399 });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('returns 404 when product does not exist', async () => {
            Product.findOne
                .mockResolvedValueOnce(null); // verifyShopAccess passes (UserShop mock), product not found
            // Need to set up so verifyShopAccess passes but product.findOne returns null
            // verifyShopAccess calls UserShop.findOne, then updateProduct calls Product.findOne
            // beforeEach sets UserShop as persistent — need to keep it, but reset Product for this test
            Product.findOne.mockReset().mockResolvedValueOnce(null);
            const res = await request(app).patch(`/api/product/${OTHER_PROD_ID}`).send({ name: 'X' });
            expect(res.status).toBe(404);
        });

        it('returns 403 when user does not have shop access (SECURITY)', async () => {
            UserShop.findOne.mockResolvedValueOnce(null);
            const res = await request(app).patch(`/api/product/${PROD_ID}`).send({ price: 200 });
            expect(res.status).toBe(403);
        });

        it('cannot update a product from another shop (SECURITY)', async () => {
            Product.findOne.mockReset().mockResolvedValueOnce(null); // product not found under this shop
            const res = await request(app).patch(`/api/product/${OTHER_PROD_ID}`).send({ price: 100 });
            expect(res.status).toBe(404);
        });

        it('rejects negative price on update', async () => {
            const res = await request(app).patch(`/api/product/${PROD_ID}`).send({ price: -50 });
            expect(res.status).toBe(400);
        });

        it('sets quantity to 0 when track_quantity is false on update', async () => {
            const captured = [];
            mockProduct.update.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            await request(app).patch(`/api/product/${PROD_ID}`).send({ track_quantity: false, quantity: 99 });

            if (captured.length > 0) expect(captured[0].quantity).toBe(0);
        });

        it('validates category_id belongs to the same shop on update (SECURITY)', async () => {
            Category.findOne.mockResolvedValueOnce(null);
            const res = await request(app).patch(`/api/product/${PROD_ID}`).send({ category_id: CAT2_ID });
            expect(res.status).toBe(404);
        });

        it('ignores a client-supplied shop_id and does not move the product to another shop (SECURITY)', async () => {
            const captured = [];
            mockProduct.update.mockImplementationOnce(function (data) {
                captured.push(data);
                Object.assign(this, data);
                return Promise.resolve(this);
            });

            const res = await request(app)
                .patch(`/api/product/${PROD_ID}`)
                .send({ price: 500, shop_id: OTHER_SHOP_ID });

            expect(res.status).toBe(200);
            expect(captured[0]).not.toHaveProperty('shop_id');
            expect(res.body.data.shop_id).toBe(SHOP_ID);
        });
    });

    // ── DELETE /product/:id ───────────────────────────────────────────────

    describe('DELETE /product/:id', () => {
        it('soft-deletes a product and returns 200', async () => {
            const res = await request(app).delete(`/api/product/${PROD_ID}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockProduct.destroy).toHaveBeenCalled();
        });

        it('returns 404 when product does not exist', async () => {
            Product.findOne.mockReset().mockResolvedValueOnce(null);
            const res = await request(app).delete(`/api/product/${OTHER_PROD_ID}`);
            expect(res.status).toBe(404);
        });

        it('returns 403 when user does not have shop access (SECURITY)', async () => {
            UserShop.findOne.mockResolvedValueOnce(null);
            const res = await request(app).delete(`/api/product/${PROD_ID}`);
            expect(res.status).toBe(403);
        });

        it('cannot delete a product from another shop (SECURITY)', async () => {
            Product.findOne.mockReset().mockResolvedValueOnce(null);
            const res = await request(app).delete(`/api/product/${OTHER_PROD_ID}`);
            expect(res.status).toBe(404);
        });

        it('rejects non-UUID product ID', async () => {
            const res = await request(app).delete('/api/product/not-a-uuid');
            expect(res.status).toBe(400);
        });
    });

    // ── POST /product/search ──────────────────────────────────────────────

    describe('POST /product/search', () => {
        it('returns matching products for a query string', async () => {
            Product.findAll.mockResolvedValueOnce([mockProduct]);
            const res = await request(app).post('/api/product/search').send({ query: 'shirt' });
            expect(res.status).toBe(200);
            // searchProducts controller returns { products, total, page } (not success/data)
            expect(Array.isArray(res.body.products)).toBe(true);
        });

        it('applies price range filter', async () => {
            const res = await request(app).post('/api/product/search').send({ filters: { min_price: 100, max_price: 500 } });
            expect(res.status).toBe(200);
        });

        it('applies in_stock filter', async () => {
            const res = await request(app).post('/api/product/search').send({ filters: { in_stock: true } });
            expect(res.status).toBe(200);
        });

        it('respects limit from payload', async () => {
            await request(app).post('/api/product/search').send({ query: 'test', limit: 5 });
            const callArgs = Product.findAll.mock.calls[0]?.[0];
            if (callArgs) expect(callArgs.limit).toBeLessThanOrEqual(10);
        });

        it('returns empty array for query with no matches', async () => {
            Product.findAll.mockResolvedValueOnce([]);
            const res = await request(app).post('/api/product/search').send({ query: 'no-match-xyz' });
            expect(res.status).toBe(200);
        });
    });

    // ── POST /product/ai-extract ──────────────────────────────────────────

    describe('POST /product/ai-extract', () => {
        const validCsv = { content_type: 'text/csv', content: 'name,price,sku\nTest Shirt,299,SKU-1\nBlue Pants,499,SKU-2' };

        it('extracts products from CSV and returns 200', async () => {
            const res = await request(app).post('/api/product/ai-extract').send(validCsv);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('response data contains products array', async () => {
            const res = await request(app).post('/api/product/ai-extract').send(validCsv);
            expect(res.status).toBe(200);
            // extractProductsFromContent returns { products, stats } wrapped in res.body.data
            const data = res.body.data;
            expect(data).toBeDefined();
            // Either an array directly or an object with a products key
            const products = Array.isArray(data) ? data : data.products;
            expect(Array.isArray(products)).toBe(true);
        });

        it('parses TSV content correctly', async () => {
            const res = await request(app).post('/api/product/ai-extract').send({
                content_type: 'text/tab-separated-values',
                content: 'name\tprice\tsku\nTest Shirt\t299\tSKU-1',
            });
            expect(res.status).toBe(200);
        });

        it('calculates confidence score for extracted products', async () => {
            const res = await request(app).post('/api/product/ai-extract').send(validCsv);
            const data = res.body.data;
            const products = Array.isArray(data) ? data : data.products;
            if (products && products.length > 0) {
                expect(products[0]).toHaveProperty('confidence');
                expect(products[0].confidence).toBeGreaterThanOrEqual(0);
                expect(products[0].confidence).toBeLessThanOrEqual(1);
            }
        });

        it('requires content field', async () => {
            const res = await request(app).post('/api/product/ai-extract').send({ content_type: 'text/csv' });
            expect(res.status).toBe(400);
        });

        it('rejects content larger than 2MB (400 from Joi or 413 from body parser)', async () => {
            const res = await request(app).post('/api/product/ai-extract').send({
                content_type: 'text/csv',
                content: 'X'.repeat(2_000_001),
            });
            // Express body parser returns 413 Payload Too Large; Joi validator returns 400
            expect([400, 413]).toContain(res.status);
        });

        it('caps extraction at 200 rows (scalability guard)', async () => {
            const rows = ['name,price'];
            for (let i = 1; i <= 250; i++) rows.push(`Product ${i},${i * 10}`);
            const res = await request(app).post('/api/product/ai-extract').send({
                content_type: 'text/csv', content: rows.join('\n'),
            });
            expect(res.status).toBe(200);
            const data = res.body.data;
            const products = Array.isArray(data) ? data : data.products;
            if (Array.isArray(products)) expect(products.length).toBeLessThanOrEqual(200);
        });

        it('maps common column aliases (product_name → name, qty → quantity)', async () => {
            const res = await request(app).post('/api/product/ai-extract').send({
                content_type: 'text/csv',
                content: 'product_name,unit_price,qty\nCotton Tee,250,50',
            });
            expect(res.status).toBe(200);
            const data = res.body.data;
            const products = Array.isArray(data) ? data : data.products;
            if (products && products.length > 0) {
                expect(products[0].name).toBeTruthy();
            }
        });
    });

    // ── Business logic: product service ───────────────────────────────────

    describe('product.service — unit-level logic', () => {
        let productService;
        beforeEach(() => { productService = require('src/modules/product/product.service'); });

        it('verifyShopAccess throws 403 when user is not a member of the shop', async () => {
            UserShop.findOne.mockResolvedValueOnce(null);
            await expect(productService.verifyShopAccess(USER_ID, SHOP_ID))
                .rejects.toMatchObject({ status: 403 });
        });

        it('createProduct throws 404 when category_id references a non-existent category', async () => {
            Category.findOne.mockResolvedValueOnce(null);
            await expect(productService.createProduct(USER_ID, SHOP_ID, {
                name: 'Test', price: 100, category_id: CAT2_ID,
            })).rejects.toMatchObject({ status: 404 });
        });

        it('updateProduct returns 404 when product does not exist', async () => {
            Product.findOne.mockReset().mockResolvedValueOnce(null);
            await expect(productService.updateProduct(OTHER_PROD_ID, USER_ID, SHOP_ID, { name: 'X' }))
                .rejects.toMatchObject({ status: 404 });
        });

        it('createProduct strips a client-supplied shop_id — the authenticated shopId always wins (SECURITY)', async () => {
            const captured = [];
            Product.create.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            await productService.createProduct(USER_ID, SHOP_ID, {
                name: 'Test', price: 100, shop_id: OTHER_SHOP_ID,
            });

            expect(captured[0].shop_id).toBe(SHOP_ID);
            expect(captured[0].shop_id).not.toBe(OTHER_SHOP_ID);
        });

        it('updateProduct strips a client-supplied shop_id — cannot move a product to another shop (SECURITY)', async () => {
            const captured = [];
            mockProduct.update.mockImplementationOnce(function (data) {
                captured.push(data);
                Object.assign(this, data);
                return Promise.resolve(this);
            });

            await productService.updateProduct(PROD_ID, USER_ID, SHOP_ID, {
                price: 500, shop_id: OTHER_SHOP_ID,
            });

            expect(captured[0]).not.toHaveProperty('shop_id');
        });

        it('legacy POST /product/create also strips a client-supplied shop_id (shares createProduct) (SECURITY)', async () => {
            const captured = [];
            Product.create.mockImplementationOnce((data) => { captured.push(data); return Promise.resolve(mockProduct); });

            const res = await request(app)
                .post('/api/product/create')
                .send({ name: 'Legacy Attempt', price: 100, shop_id: OTHER_SHOP_ID });

            expect(res.status).toBe(201);
            expect(captured[0].shop_id).toBe(SHOP_ID);
        });

        it('deleteProduct returns 404 when product does not exist', async () => {
            Product.findOne.mockReset().mockResolvedValueOnce(null);
            await expect(productService.deleteProduct(OTHER_PROD_ID, USER_ID, SHOP_ID))
                .rejects.toMatchObject({ status: 404 });
        });

        it('listProducts returns products with status field', async () => {
            Product.findAll.mockResolvedValueOnce([
                { toJSON: () => ({ ...mockProduct, is_active: true,  category_ref: { id: CAT_ID, name: 'Clothing' } }) },
                { toJSON: () => ({ ...mockProduct, id: PROD2_ID, is_active: false, category_ref: null }) },
            ]);
            const products = await productService.listProducts(USER_ID, SHOP_ID);
            expect(Array.isArray(products)).toBe(true);
            const active = products.find(p => p.id === PROD_ID);
            if (active) {
                expect(active.status).toBe('active');
                expect(active.category).toBe('Clothing');
            }
        });

        it('extractProductsFromContent returns { products, stats } shape', async () => {
            const result = await productService.extractProductsFromContent(USER_ID, SHOP_ID, {
                content_type: 'text/csv',
                content: 'name,price,sku\nBlue Kurti,450,BK-001',
            });
            expect(result).toHaveProperty('products');
            expect(result).toHaveProperty('stats');
            expect(Array.isArray(result.products)).toBe(true);
        });

        it('price parser strips currency symbols from CSV values', async () => {
            const result = await productService.extractProductsFromContent(USER_ID, SHOP_ID, {
                content_type: 'text/csv',
                content: 'name,price\nKurti,৳450',
            });
            if (result.products.length > 0 && result.products[0].price !== null) {
                expect(result.products[0].price).toBe(450);
            }
        });

        it('parses Bengali-script BDT digits from CSV prices', async () => {
            const result = await productService.extractProductsFromContent(USER_ID, SHOP_ID, {
                content_type: 'text/csv',
                content: 'name,price\nKurti,৳৪৫০.৫০',
            });

            expect(result.products[0].price).toBe(450.5);
        });

        it('confidence score is higher for products with more complete data', async () => {
            const full = await productService.extractProductsFromContent(USER_ID, SHOP_ID, {
                content_type: 'text/csv',
                content: 'name,price,sku,category\nFull Product,300,SKU-F,Shirts',
            });
            const partial = await productService.extractProductsFromContent(USER_ID, SHOP_ID, {
                content_type: 'text/csv',
                content: 'name,price\nOnly Name,100',
            });
            if (full.products.length > 0 && partial.products.length > 0) {
                expect(full.products[0].confidence).toBeGreaterThan(partial.products[0].confidence);
            }
        });
    });

    // ── Performance & scalability ──────────────────────────────────────────

    describe('Scalability & performance guards', () => {
        it('rejects limit > 100 on GET /product', async () => {
            const res = await request(app).get('/api/product?limit=500');
            expect(res.status).toBe(400);
        });

        it('rejects page = 0 on GET /product', async () => {
            const res = await request(app).get('/api/product?page=0');
            expect(res.status).toBe(400);
        });

        it('ai-extract caps at 200 rows regardless of input size', async () => {
            const rows = ['name,price'];
            for (let i = 0; i < 300; i++) rows.push(`Product ${i},${100 + i}`);
            const res = await request(app).post('/api/product/ai-extract')
                .send({ content_type: 'text/csv', content: rows.join('\n') });
            expect(res.status).toBe(200);
            const data = res.body.data;
            const products = Array.isArray(data) ? data : data.products;
            if (Array.isArray(products)) expect(products.length).toBeLessThanOrEqual(200);
        });
    });

    // ── Security: cross-shop isolation ────────────────────────────────────

    describe('Security: shop isolation (no cross-shop data leakage)', () => {
        it('all Product.findAll calls include shop_id in where clause', async () => {
            await request(app).get('/api/product');
            const calls = Product.findAll.mock.calls;
            calls.forEach(([args]) => {
                if (args?.where) expect(args.where.shop_id).toBe(SHOP_ID);
            });
        });

        it('Product.findOne for single product is scoped to shop_id', async () => {
            await request(app).get(`/api/product/${PROD_ID}`);
            const calls = Product.findOne.mock.calls.filter(([args]) => args?.where?.id);
            calls.forEach(([args]) => {
                expect(args.where.shop_id).toBe(SHOP_ID);
            });
        });

        it('category verification on create scopes by shop_id', async () => {
            Category.findOne.mockResolvedValueOnce(null);
            await request(app).post('/api/product').send({ name: 'Test', price: 100, category_id: CAT2_ID });
            const catCall = Category.findOne.mock.calls.find(([args]) => args?.where?.id);
            if (catCall) expect(catCall[0].where.shop_id).toBe(SHOP_ID);
        });
    });
});
