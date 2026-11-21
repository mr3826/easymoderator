'use strict';

/**
 * P0-04…P0-07 — product-card send on REAL PostgreSQL + Redis.
 *
 * conversation.product-card.stock-policy.test.js covers the same rules with
 * Sequelize/Redis mocked; this file closes the WP-01 gap by running the real
 * route with:
 *   - the real authenticate + verifyShopAccess chain (JWT shopId only),
 *   - real Product / Conversation / Message / ShopPilotFeatures rows,
 *   - the REAL stock-status guard against real Redis (cache key semantics and
 *     the invalidate-before-read fence),
 *   - the REAL policy engine (24h window from verified inbound evidence),
 *   - the REAL provider wire build — only the Graph HTTP transport (axios) is
 *     captured. A green suite here is contract evidence, NOT a real Meta
 *     delivery (see scripts/p0-acceptance-matrix.js classifications).
 *
 * P0-06 note: the defined card path HOLDS — sendProductCard invalidates the
 * stock cache before reading, so a merchant edit is reflected immediately.
 * The separate product-API edit path (product.service does not invalidate the
 * guard; AI-chat enrichWithStock can serve a stale label for up to
 * STOCK_CACHE_TTL_SECONDS=300s) is register item 5 — deferred, nonblocking,
 * deliberately NOT asserted here as PASS.
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'ic-app-id';
process.env.META_APP_SECRET = 'ic-app-secret';
// Product images are tenant-scoped HTTPS URLs; the card only attaches them
// when they parse as https (isHttpsUrl), so the fixture origin matters.
process.env.PUBLIC_ASSET_URL = 'https://assets.integration.test.invalid';

jest.mock('axios', () => ({
    get: jest.fn(async () => ({ data: { data: [] } })),
    post: jest.fn(),
    delete: jest.fn(),
}));

const crypto = require('crypto');

const express = require('express');
const request = require('supertest');
const axios = require('axios');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    User, UserShop, ShopPilotFeatures, Customer, Message, Product,
} = require('../../entities');
const { Conversation } = require('../conversation.entity');
const convRoutes = require('../conversation.routes');
const { globalErrorHandler } = require('../../../utils/AppError');
const { generateAccessToken } = require('../../../utils/jwt.util');
const stockGuard = require('../../product/stock-status-guard.service');

const {
    IDS, EXPECTED, syncSchema, truncateAll, seed,
} = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();

const app = express();
app.use(express.json());
app.use('/api/conversation', convRoutes);
app.use(globalErrorHandler);

const tokenFor = (user, shopId) => generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId,
    tokenVersion: user.token_version || 0,
    mfaVerified: true,
});
const auth = (user, shopId) => ({ Authorization: `Bearer ${tokenFor(user, shopId)}` });

async function makeMember(shopId, role, label) {
    const suffix = uuid().slice(0, 8);
    const user = await User.create({
        email: `pc-${label}-${suffix}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: user.id, shop_id: shopId, role, is_active: true });
    return user;
}

let ownerA;
let staffA;
let ownerB;

/** A live Messenger thread inside the 24h window, pinned to channel A. */
async function makeThread({ withinWindow = true } = {}) {
    const customer = await Customer.create({
        shop_id: IDS.shopA,
        name: 'IC Card Customer',
        channel_type: 'messenger',
        channel_user_id: `psid-ic-${uuid().slice(0, 8)}`,
        meta_channel_id: IDS.channelA,
        messaging_consent: {
            facebook: {
                opted_in: true,
                last_inbound_at: new Date(
                    Date.now() - (withinWindow ? 60_000 : 25 * 60 * 60 * 1000),
                ).toISOString(),
            },
        },
    });
    const conversation = await Conversation.create({
        shop_id: IDS.shopA,
        customer_id: customer.id,
        channel: 'messenger',
        meta_channel_id: IDS.channelA,
        role: 'user',
        status: 'active',
        hitl: false,
        message: 'black panjabi?',
        metadata: {},
    });
    return { customer, conversation };
}

async function enableChoices(shopId = IDS.shopA, value = true) {
    const existing = await ShopPilotFeatures.findByPk(shopId);
    if (existing) {
        await existing.update({ interaction_choices: value });
    } else {
        await ShopPilotFeatures.create({ shop_id: shopId, interaction_choices: value });
    }
}

beforeAll(async () => {
    await syncSchema();
    await truncateAll();
    await seed();
    ownerA = await makeMember(IDS.shopA, 'owner', 'ownerA');
    staffA = await makeMember(IDS.shopA, 'staff', 'staffA');
    ownerB = await makeMember(IDS.shopB, 'owner', 'ownerB');
}, 120000);

beforeEach(async () => {
    jest.clearAllMocks();
    await enableChoices(IDS.shopA, true);
    // Scenarios deliberately mutate the shared fixture product (OOS, qty edits);
    // restore the seeded truth before every test so file order cannot matter.
    await Product.update(
        { quantity: 10, in_stock: true, track_quantity: true },
        { where: { id: IDS.knownProduct } },
    );
    // Deterministic guard state per scenario: never inherit a previous test's
    // cached stock row (TTL would otherwise be 300s).
    await stockGuard.invalidateShop(IDS.shopA);
});

afterAll(async () => {
    await truncateAll().catch(() => {});
    await sequelize.close();
});

describe('P0-04 — the card the merchant sends is the row the database holds', () => {
    test('a product-card send reaches the Graph wire with DB price + stock label', async () => {
        const { customer, conversation } = await makeThread();
        axios.post.mockResolvedValueOnce({ data: { message_id: 'mid.card.ic.1' } });

        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct, quick_replies: ['Order now', 'Check sizes'] });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.delivery_state).toBe('SENT');
        expect(res.body.data.provider_message_id).toBe('mid.card.ic.1');

        expect(axios.post).toHaveBeenCalledTimes(1);
        const [url, body] = axios.post.mock.calls[0];
        expect(String(url)).toContain('/me/messages');
        expect(body.recipient).toEqual({ id: customer.channel_user_id });
        expect(body.messaging_type).toBe('RESPONSE');
        expect(body.message.attachment).toEqual({
            type: 'template',
            payload: {
                template_type: 'generic',
                elements: [{
                    title: EXPECTED.knownProductName,
                    subtitle: `৳${EXPECTED.knownProductPrice} · In stock (10)`,
                    image_url: EXPECTED.knownProductImage,
                }],
            },
        });
        expect(body.message.quick_replies).toEqual([
            { title: 'Order now', content_type: 'text', payload: `product:${IDS.knownProduct}:q:0` },
            { title: 'Check sizes', content_type: 'text', payload: `product:${IDS.knownProduct}:q:1` },
        ]);

        // Persisted provenance: the message row carries the same card facts.
        const stored = await Message.findOne({
            where: { conversation_id: conversation.id, sender: 'business' },
        });
        expect(stored).not.toBeNull();
        expect(stored.metadata.product_card).toMatchObject({
            product_id: IDS.knownProduct,
            subtitle: `৳${EXPECTED.knownProductPrice} · In stock (10)`,
        });
    });

    test('untracked quantity renders "Available", never a fabricated count', async () => {
        const product = await Product.create({
            shop_id: IDS.shopA,
            name: 'EM IC Untracked Kurta',
            category: 'kurta',
            price: 999,
            quantity: 0,
            track_quantity: false,
            in_stock: true,
            is_active: true,
            tags: [],
            images: [],
            variants: [],
        });
        const { conversation } = await makeThread();
        axios.post.mockResolvedValueOnce({ data: { message_id: 'mid.card.ic.untracked' } });

        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: product.id });

        expect(res.status).toBe(201);
        const [, body] = axios.post.mock.calls[0];
        expect(body.message.attachment.payload.elements[0].subtitle).toBe('৳999 · Available');
    });

    test('a client-sent price is rejected by the validator (price comes from the row)', async () => {
        const { conversation } = await makeThread();
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct, price: 1 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('the feature flag (default-off, platform-controlled) gates the route at 409', async () => {
        await enableChoices(IDS.shopA, false);
        const { conversation } = await makeThread();
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FEATURE_DISABLED');
        expect(axios.post).not.toHaveBeenCalled();
    });
});

describe('P0-05 — an out-of-stock product can never be carded as available', () => {
    test('in_stock=false with positive quantity is refused 409 BEFORE any message exists', async () => {
        const product = await Product.findByPk(IDS.knownProduct);
        await product.update({ in_stock: false }); // quantity stays 10 — the mobile quick-update shape
        const { conversation } = await makeThread();

        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
        expect(axios.post).not.toHaveBeenCalled();
        // No transcript side effect: nothing was created to deliver later.
        expect(await Message.count({ where: { conversation_id: conversation.id } })).toBe(0);
    });

    test('quantity exhaustion (track_quantity + quantity 0) is refused the same way', async () => {
        const product = await Product.findByPk(IDS.knownProduct);
        await product.update({ quantity: 0, in_stock: true });
        const { conversation } = await makeThread();

        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('OUT_OF_STOCK');
    });
});

describe('P0-06 — a stock edit is reflected on the very next card (invalidate-before-read)', () => {
    test('a warmed stale cache cannot resurrect the old quantity', async () => {
        const product = await Product.findByPk(IDS.knownProduct);
        // Warm the guard cache with the CURRENT truth, exactly like an AI-chat
        // turn or earlier card read would.
        const warm = await stockGuard.getStock(product.id, IDS.shopA);
        expect(warm).toMatchObject({ quantity: 10, in_stock: true, cached: false });
        const cachedAgain = await stockGuard.getStock(product.id, IDS.shopA);
        expect(cachedAgain.cached).toBe(true); // the stale value IS live in Redis now

        // Merchant edits stock (quantity 3) — then immediately sends the card.
        await product.update({ quantity: 3 });

        const { conversation } = await makeThread();
        axios.post.mockResolvedValueOnce({ data: { message_id: 'mid.card.ic.edited' } });
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });

        expect(res.status).toBe(201);
        const [, body] = axios.post.mock.calls[0];
        expect(body.message.attachment.payload.elements[0].subtitle).toBe('৳1847 · In stock (3)');
        expect(JSON.stringify(body)).not.toContain('In stock (10)');

        // The guard cache now holds the fresh value for the next reader.
        const after = await stockGuard.getStock(product.id, IDS.shopA);
        expect(after).toMatchObject({ quantity: 3, cached: true });
    });
});

describe('P0-07 — cross-shop product ids are not a read primitive', () => {
    test("shop A probing a shop B product gets 404 with zero name/price leakage", async () => {
        const { conversation } = await makeThread();
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.shopBProduct });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
        const wire = JSON.stringify(res.body);
        expect(wire).not.toContain(EXPECTED.shopBProductName);
        expect(wire).not.toContain('750');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a shop B principal cannot card into a shop A conversation', async () => {
        const { conversation } = await makeThread();
        await enableChoices(IDS.shopB, true);
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerB, IDS.shopB))
            .send({ product_id: IDS.knownProduct });
        // verifyShopAccess passes on B membership; the conversation-scoped
        // service read then refuses — never a cross-shop write.
        expect([403, 404]).toContain(res.status);
        expect(await Message.count({ where: { conversation_id: conversation.id } })).toBe(0);
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('staff (any active role) may send the card; JWT shopId is the only selector', async () => {
        const { conversation } = await makeThread();
        axios.post.mockResolvedValueOnce({ data: { message_id: 'mid.card.ic.staff' } });
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(staffA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });
        expect(res.status).toBe(201);
        expect(res.body.data.provider_message_id).toBe('mid.card.ic.staff');
    });

    test('an X-Shop-ID header cannot widen scope', async () => {
        const { conversation } = await makeThread();
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerB, IDS.shopB))
            .set('X-Shop-ID', IDS.shopA)
            .send({ product_id: IDS.knownProduct });
        expect([403, 404]).toContain(res.status);
    });
});

describe('the 24h window is enforced by the real policy engine before the wire', () => {
    test('outside the window the card is saved but never sent', async () => {
        const { conversation } = await makeThread({ withinWindow: false });
        const res = await request(app)
            .post(`/api/conversation/${conversation.id}/product-card`)
            .set(auth(ownerA, IDS.shopA))
            .send({ product_id: IDS.knownProduct });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('POLICY_BLOCKED');
        expect(res.body.data.delivery_state).not.toBe('SENT');
        expect(axios.post).not.toHaveBeenCalled();
    });
});
