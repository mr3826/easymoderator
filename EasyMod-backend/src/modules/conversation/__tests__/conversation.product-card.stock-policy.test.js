'use strict';

/**
 * WP-02 — product cards must honor the authoritative stock-availability policy.
 *
 * PR #278 P2 finding: sendProductCard only rejected tracked products with
 * quantity <= 0, so an active product with an explicit in_stock=false (mobile
 * quick-update writes in_stock independently of quantity) still produced a
 * card advertising "Available" / "In stock (N)".
 *
 * The card path now delegates the decision to stock-status-guard.service
 * (getStock), the same predicate the chatbot uses:
 *   in_stock !== false && (track_quantity ? quantity > 0 : true)
 *
 * These tests exercise the REAL guard against mocked DB/Redis (repo unit
 * convention, mirrors r3-messenger-ux.test.js) through the actual HTTP route,
 * so policy gates, tenant scoping, card shape and delivery are all preserved.
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'meta-app-test';
process.env.META_APP_SECRET = 'meta-app-secret-test';
process.env.META_GRAPH_API_VERSION = 'v21.0';

const express = require('express');
const request = require('supertest');
const { globalErrorHandler } = require('../../../utils/AppError');

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = '33333333-3333-4333-8333-333333333333';
const PROD_ID = '44444444-4444-4444-8444-444444444444';
const CHAN_ID = '55555555-5555-4555-8555-555555555555';
const CUST_ID = '66666666-6666-4666-8666-666666666666';
const MISSING_PROD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CROSS_TENANT_PROD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mockState = {
    shopId: SHOP_ID,
    userId: USER_ID,
    interactionChoices: true,
    products: new Map(),
    conversations: new Map(),
    messages: new Map(),
    customers: new Map(),
    metaChannels: new Map(),
    policyDecision: { allow: true, reason: 'WITHIN_24H_WINDOW' },
    axiosGet: jest.fn(),
    axiosPost: jest.fn(),
    providerInstance: null,
};

jest.mock('axios', () => ({
    get: (...args) => mockState.axiosGet(...args),
    post: (...args) => mockState.axiosPost(...args),
    delete: jest.fn(),
}));

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: mockState.userId, shopId: mockState.shopId, role: 'owner' };
        next();
    },
    checkSubscriptionStatus: (_req, _res, next) => next(),
}));

jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: (_req, _res, next) => next(),
}));

jest.mock('../../audit/idempotency.middleware', () => ({
    idempotencyMiddleware: (_req, _res, next) => next(),
}));

jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: jest.fn(async () => ({ interactionChoices: mockState.interactionChoices })),
    isInteractionChoicesEnabled: jest.fn(async () => mockState.interactionChoices === true),
    isCustomerIntelligenceEnabled: jest.fn(async () => false),
}));

jest.mock('../../policy/policy.engine', () => ({
    evaluateOutbound: jest.fn(async () => ({ ...mockState.policyDecision })),
}));

jest.mock('../../policy/rules/rateLimit.rule', () => ({
    reserveSendSlot: jest.fn(async () => ({ allowed: true })),
    releaseSendSlot: jest.fn(async () => {}),
}));

jest.mock('../../shop/ai-reply-mode', () => ({
    AI_REPLY_MODES: { MANUAL: 'MANUAL', DRAFT: 'DRAFT', AUTO: 'AUTO' },
    getEffectiveAiReplyMode: jest.fn(async () => 'MANUAL'),
    normalizeAiReplyMode: jest.fn((m) => m || 'MANUAL'),
}));

jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
}));

// In-memory Redis double: get/setex/del behave like a real store so cache
// staleness and invalidation ordering are exercised faithfully.
const redisStore = new Map();
const mockCacheRedis = {
    get: jest.fn(async (key) => (redisStore.has(key) ? redisStore.get(key) : null)),
    set: jest.fn(async () => 'OK'),
    setex: jest.fn(async (key, _ttl, value) => { redisStore.set(key, String(value)); return 'OK'; }),
    del: jest.fn(async (...keys) => {
        let removed = 0;
        for (const key of keys) if (redisStore.delete(key)) removed += 1;
        return removed;
    }),
};
jest.mock('../../../config/redis', () => ({ cacheRedis: mockCacheRedis }));

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        getDialect: () => 'sqlite',
        query: jest.fn(async () => []),
        define: jest.fn(() => ({
            belongsTo: jest.fn(),
            hasMany: jest.fn(),
            hasOne: jest.fn(),
        })),
        transaction: jest.fn(async (fn) => fn(mockTransaction)),
    },
}));

jest.mock('../../audit/audit.service', () => ({ logAction: jest.fn(async () => {}) }));
jest.mock('../../conversation/conversation-lock.service', () => ({
    acquireForDelivery: jest.fn(async () => ({ success: true, lockId: 'lock-1' })),
    releaseLock: jest.fn(async () => {}),
}));

const mockCustomerModel = {
    findOne: jest.fn(async ({ where }) => {
        for (const c of mockState.customers.values()) {
            if (where.id && c.id !== where.id) continue;
            if (where.shop_id && c.shop_id !== where.shop_id) continue;
            return c;
        }
        return null;
    }),
    update: jest.fn(async () => [0]),
};

const mockConversationModel = {
    findOne: jest.fn(async ({ where }) => {
        for (const conv of mockState.conversations.values()) {
            if (where.id && conv.id !== where.id) continue;
            if (where.shop_id && conv.shop_id !== where.shop_id) continue;
            return conv;
        }
        return null;
    }),
    update: jest.fn(async (patch, { where }) => {
        let count = 0;
        for (const conv of mockState.conversations.values()) {
            if (where.id && conv.id !== where.id) continue;
            if (where.shop_id && conv.shop_id !== where.shop_id) continue;
            Object.assign(conv, patch);
            count += 1;
        }
        return [count];
    }),
};

const mockMessageModel = {
    findOne: jest.fn(async ({ where }) => {
        if (where.id && mockState.messages.has(where.id)) {
            const msg = mockState.messages.get(where.id);
            if (!where.conversation_id || msg.conversation_id === where.conversation_id) {
                return msg;
            }
        }
        return null;
    }),
    create: jest.fn(async (row) => {
        const created = {
            id: `msg-${mockState.messages.size + 1}`,
            created_at: new Date().toISOString(),
            ...row,
            update: jest.fn(async (patch) => Object.assign(created, patch)),
            toJSON() { return { ...this }; },
        };
        mockState.messages.set(created.id, created);
        return created;
    }),
    update: jest.fn(async (patch, { where }) => {
        let count = 0;
        for (const msg of mockState.messages.values()) {
            if (where.id && msg.id !== where.id) continue;
            if (where.conversation_id && msg.conversation_id !== where.conversation_id) continue;
            Object.assign(msg, patch);
            count += 1;
        }
        return [count];
    }),
    count: jest.fn(async () => mockState.messages.size),
};

const mockProductModel = {
    findOne: jest.fn(async ({ where }) => {
        const p = mockState.products.get(where.id);
        if (!p) return null;
        if (where.shop_id && p.shop_id !== where.shop_id) return null;
        if (where.is_active !== undefined && p.is_active !== where.is_active) return null;
        return p;
    }),
};

jest.mock('../../entities', () => ({
    Conversation: mockConversationModel,
    Customer: mockCustomerModel,
    Message: mockMessageModel,
    Product: mockProductModel,
    AuditLog: { create: jest.fn(async () => ({})) },
    InboxDeliveryOutbox: { update: jest.fn(async () => [0]) },
    MetaChannel: { findByPk: jest.fn(async (id) => mockState.metaChannels.get(id) || null) },
}));

jest.mock('../../conversation/conversation.entity', () => ({
    Conversation: mockConversationModel,
    Message: mockMessageModel,
}));

jest.mock('../../channel-providers/meta-channel.entity', () => ({
    findByPk: jest.fn(async (id) => mockState.metaChannels.get(id) || null),
}));

jest.mock('../../channel-providers/meta-channel.service', () => ({
    findConnectedById: jest.fn(async (id, { shopId }) => {
        const ch = mockState.metaChannels.get(id);
        if (!ch || ch.shop_id !== shopId || ch.status !== 'CONNECTED') return null;
        return ch;
    }),
    findUniqueConnectedByShopAndPlatform: jest.fn(async (shopId, platform) => {
        for (const ch of mockState.metaChannels.values()) {
            if (ch.shop_id === shopId && ch.platform === platform && ch.status === 'CONNECTED') return ch;
        }
        return null;
    }),
    confirmWebhookActive: jest.fn(async () => {}),
    getSettings: jest.fn(async () => ({
        confidence_threshold_send: '0.80',
        confidence_threshold_suggest: '0.50',
        business_hours: null,
        allow_order_creation: true,
        purpose_label: null,
    })),
}));

jest.mock('../../channel-providers/provider.registry', () => ({
    getProvider: jest.fn((platform) => {
        if (platform === 'facebook' || platform === 'messenger') return mockState.providerInstance;
        throw new Error(`Unsupported platform ${platform}`);
    }),
}));

jest.mock('../../conversation/conversation.service', () => ({
    mapMessage: jest.fn((msg) => ({ ...msg })),
    createMessage: jest.fn(async (conversationId, shopId, messageData) => {
        const conv = mockState.conversations.get(conversationId);
        if (!conv || conv.shop_id !== shopId) {
            throw new Error('Conversation not found');
        }
        const created = await mockMessageModel.create({
            conversation_id: conversationId,
            content: messageData.content,
            sender: 'business',
            metadata: messageData.metadata || {},
            delivery_state: 'SEND_PENDING',
            provider_message_id: null,
            send_idempotency_key: messageData.send_idempotency_key || null,
        });
        return { ...created, idempotency_replay: false };
    }),
    holdPendingAiCandidates: jest.fn(async () => 0),
}));

const MetaMessengerProvider = require('../../channel-providers/providers/MetaMessengerProvider');
mockState.providerInstance = new MetaMessengerProvider();

const convRoutes = require('../conversation.routes');
const conversationService = require('../../conversation/conversation.service');
const stockGuard = require('../../product/stock-status-guard.service');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/conversation', convRoutes);
    app.use(globalErrorHandler);
    return app;
}

const stockCacheKey = (productId, shopId = SHOP_ID) => `stock:${shopId}:${productId}`;

function seedProduct(overrides = {}) {
    const product = {
        id: PROD_ID,
        shop_id: SHOP_ID,
        name: 'Jamdani Saree',
        price: 2500,
        is_active: true,
        track_quantity: true,
        quantity: 7,
        in_stock: true,
        images: ['https://cdn.example.com/jamdani.jpg'],
        ...overrides,
    };
    mockState.products.set(product.id, product);
    return product;
}

describe('WP-02 product-card stock availability (authoritative guard policy)', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        mockState.axiosGet.mockReset();
        mockState.axiosPost.mockReset();
        mockState.interactionChoices = true;
        mockState.products.clear();
        mockState.conversations.clear();
        mockState.messages.clear();
        mockState.customers.clear();
        mockState.metaChannels.clear();
        redisStore.clear();
        mockState.policyDecision = { allow: true, reason: 'WITHIN_24H_WINDOW' };

        mockState.metaChannels.set(CHAN_ID, {
            id: CHAN_ID,
            shop_id: SHOP_ID,
            platform: 'facebook',
            meta_asset_id: 'page-123',
            page_access_token_ct: 'test-page-token',
            status: 'CONNECTED',
        });

        const customer = {
            id: CUST_ID,
            shop_id: SHOP_ID,
            channel_type: 'messenger',
            channel_user_id: 'psid-customer-1',
            meta_channel_id: CHAN_ID,
            name: 'Nadia',
            metadata: {},
            update: jest.fn(async (patch) => Object.assign(customer, patch)),
        };
        mockState.customers.set(CUST_ID, customer);

        const conversation = {
            id: CONV_ID,
            shop_id: SHOP_ID,
            customer_id: CUST_ID,
            channel: 'messenger',
            meta_channel_id: CHAN_ID,
            status: 'active',
            hitl: false,
            metadata: {},
            customer,
            update: jest.fn(async (patch) => Object.assign(conversation, patch)),
        };
        mockState.conversations.set(CONV_ID, conversation);

        seedProduct();
        app = buildApp();
    });

    const sendCard = (productId = PROD_ID, body = {}) => request(app)
        .post(`/api/conversation/${CONV_ID}/product-card`)
        .send({ product_id: productId, ...body });

    const wireBody = () => mockState.axiosPost.mock.calls[0][1];

    const expectNoStockClaimSent = () => {
        expect(conversationService.createMessage).not.toHaveBeenCalled();
        expect(mockState.axiosPost).not.toHaveBeenCalled();
    };

    it('1) active + available tracked product sends the same card shape with a truthful "In stock" label', async () => {
        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.card-1' },
        });
        const res = await sendCard(PROD_ID, { quick_replies: ['Order now', 'Check sizes'] });
        expect(res.status).toBe(201);
        expect(res.body.data.delivery_state).toBe('SENT');
        expect(res.body.data.provider_message_id).toBe('mid.card-1');

        expect(mockState.axiosPost).toHaveBeenCalledTimes(1);
        const body = wireBody();
        expect(body.message.attachment.payload.template_type).toBe('generic');
        expect(body.message.attachment.payload.elements[0]).toEqual({
            title: 'Jamdani Saree',
            subtitle: '৳2500 · In stock (7)',
            image_url: 'https://cdn.example.com/jamdani.jpg',
        });
        expect(body.message.quick_replies).toHaveLength(2);
        expect(body.message.quick_replies[0].title).toBe('Order now');
    });

    it('2) explicit in_stock=false with tracking DISABLED never sends an "Available" claim', async () => {
        seedProduct({ in_stock: false, track_quantity: false, quantity: 0 });
        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
        expectNoStockClaimSent();
    });

    it('3) explicit in_stock=false with POSITIVE tracked quantity never sends an "In stock" claim', async () => {
        seedProduct({ in_stock: false, track_quantity: true, quantity: 12 });
        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
        expectNoStockClaimSent();
    });

    it('4) track_quantity enabled with quantity=0 is unavailable even when in_stock=true', async () => {
        seedProduct({ in_stock: true, track_quantity: true, quantity: 0 });
        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
        expectNoStockClaimSent();
    });

    it('5) tracking disabled follows in_stock/is_active: available label only when the flag allows it', async () => {
        seedProduct({ track_quantity: false, quantity: 0, in_stock: true });
        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.card-2' },
        });
        const res = await sendCard();
        expect(res.status).toBe(201);
        expect(wireBody().message.attachment.payload.elements[0].subtitle).toBe('৳2500 · Available');

        // Legacy rows without an explicit in_stock value keep the guard's
        // `in_stock !== false` semantics (available).
        mockState.messages.clear();
        seedProduct({ track_quantity: false, quantity: 0, in_stock: undefined });
        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.card-3' },
        });
        const legacyRes = await sendCard();
        expect(legacyRes.status).toBe(201);
        expect(mockState.axiosPost.mock.calls[1][1].message.attachment.payload.elements[0].subtitle)
            .toBe('৳2500 · Available');
    });

    it('6) variant-level unavailability never produces a variant availability claim, and cannot override product-level in_stock=false', async () => {
        // Card contract is product-level (no variant_id in the request schema);
        // the card must not advertise any specific variant as available.
        seedProduct({
            variants: [
                { option_name: 'Size', option_value: 'Red / XL', quantity: 0, is_active: false },
            ],
        });
        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.card-4' },
        });
        const res = await sendCard();
        expect(res.status).toBe(201);
        const body = wireBody();
        expect(body.message.attachment.payload.elements[0].subtitle).toBe('৳2500 · In stock (7)');
        expect(JSON.stringify(body)).not.toContain('Red / XL');

        // A variant with positive stock cannot resurrect a product the
        // merchant explicitly marked out of stock.
        mockState.messages.clear();
        seedProduct({
            in_stock: false,
            variants: [
                { option_name: 'Size', option_value: 'Blue / M', quantity: 50, is_active: true },
            ],
        });
        const oosRes = await sendCard();
        expect(oosRes.status).toBe(409);
        expect(oosRes.body.error.code).toBe('OUT_OF_STOCK');
        expect(mockState.axiosPost).toHaveBeenCalledTimes(1); // only the first send
    });

    it('7) inactive product keeps the existing 404 rejection — no card, no claim', async () => {
        seedProduct({ is_active: false });
        const res = await sendCard();
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
        expectNoStockClaimSent();
    });

    it('8) missing/deleted product keeps the existing safe 404 behavior', async () => {
        const res = await sendCard(MISSING_PROD_ID);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
        expectNoStockClaimSent();
    });

    it('9) cross-tenant product ID is rejected without leaking the other shop\'s product', async () => {
        mockState.products.set(CROSS_TENANT_PROD_ID, {
            id: CROSS_TENANT_PROD_ID,
            shop_id: OTHER_SHOP_ID,
            name: 'Other Shop Secret Item',
            price: 999,
            is_active: true,
            track_quantity: false,
            in_stock: true,
        });
        const res = await sendCard(CROSS_TENANT_PROD_ID);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
        expect(JSON.stringify(res.body)).not.toContain('Other Shop Secret Item');
        expectNoStockClaimSent();
    });

    it('10) a stale in-stock cache entry cannot resurrect an "Available" claim after a merchant stock update', async () => {
        // Cache says available; the live row (mobile quick-update) says false.
        redisStore.set(stockCacheKey(PROD_ID), JSON.stringify({ quantity: 5, in_stock: true }));
        seedProduct({ in_stock: false, track_quantity: true, quantity: 5 });

        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
        expect(mockCacheRedis.del).toHaveBeenCalledWith(stockCacheKey(PROD_ID));
        expectNoStockClaimSent();
    });

    it('11) a stale out-of-stock cache entry does not block a product that is live-available again', async () => {
        redisStore.set(stockCacheKey(PROD_ID), JSON.stringify({ quantity: 0, in_stock: false }));
        seedProduct({ in_stock: true, track_quantity: true, quantity: 7 });
        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.card-5' },
        });
        const res = await sendCard();
        expect(res.status).toBe(201);
        expect(wireBody().message.attachment.payload.elements[0].subtitle).toBe('৳2500 · In stock (7)');
    });

    it('12) feature gate is preserved: interaction_choices OFF rejects before any stock lookup', async () => {
        mockState.interactionChoices = false;
        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FEATURE_DISABLED');
        expect(mockProductModel.findOne).not.toHaveBeenCalled();
        expectNoStockClaimSent();
    });

    it('13) delivery policy gate is preserved: outside the 24h window no provider call is made', async () => {
        mockState.policyDecision = { allow: false, reason: 'outside_24h_window' };
        const res = await sendCard();
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('POLICY_BLOCKED');
        expect(mockState.axiosPost).not.toHaveBeenCalled();
        expect(res.body.data.delivery_state).not.toBe('SENT');
    });
});

describe('stock-status guard predicate (authoritative policy, direct)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockState.products.clear();
        redisStore.clear();
    });

    const seed = (fields) => {
        mockState.products.set(PROD_ID, { id: PROD_ID, shop_id: SHOP_ID, ...fields });
    };

    it('treats explicit in_stock=false as unavailable regardless of tracking or quantity', async () => {
        seed({ in_stock: false, track_quantity: true, quantity: 12 });
        await expect(stockGuard.getStock(PROD_ID, SHOP_ID)).resolves.toMatchObject({ in_stock: false });
        redisStore.clear();
        seed({ in_stock: false, track_quantity: false, quantity: 99 });
        await expect(stockGuard.getStock(PROD_ID, SHOP_ID)).resolves.toEqual({
            quantity: null, in_stock: false, cached: false,
        });
    });

    it('tracked products require quantity > 0; untracked products report null quantity', async () => {
        seed({ in_stock: true, track_quantity: true, quantity: 0 });
        await expect(stockGuard.getStock(PROD_ID, SHOP_ID)).resolves.toMatchObject({ in_stock: false });
        redisStore.clear();
        seed({ in_stock: true, track_quantity: true, quantity: 7 });
        await expect(stockGuard.getStock(PROD_ID, SHOP_ID)).resolves.toEqual({
            quantity: 7, in_stock: true, cached: false,
        });
        redisStore.clear();
        seed({ in_stock: true, track_quantity: false, quantity: 0 });
        await expect(stockGuard.getStock(PROD_ID, SHOP_ID)).resolves.toEqual({
            quantity: null, in_stock: true, cached: false,
        });
    });

    it('missing product and cross-tenant lookups fail closed', async () => {
        await expect(stockGuard.getStock(MISSING_PROD_ID, SHOP_ID)).resolves.toEqual({
            quantity: 0, in_stock: false, cached: false,
        });
        seed({ in_stock: true, track_quantity: false });
        await expect(stockGuard.getStock(PROD_ID, OTHER_SHOP_ID)).resolves.toEqual({
            quantity: 0, in_stock: false, cached: false,
        });
    });
});
