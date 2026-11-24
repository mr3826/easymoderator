'use strict';

/**
 * A6 W3 — Phase 1 nav/dashboard read models on REAL PostgreSQL + Redis.
 *
 * Two-tenant contract evidence for C1/C2/C3 (docs 05 §1–§4):
 *  - cross-shop token → 403/404, NEVER an empty 200 faking "no data";
 *  - D4 audit allowlist excludes rogue admin:/growth_os:/job:/auth noise and
 *    keeps real merchant actions with resource_id + user keys;
 *  - capped-scan honesty (201 open conversations → scanned 200,
 *    coverageComplete false);
 *  - PII-free HTTP payloads (no customer_name/customer_phone/old_values/
 *    new_values/metadata/ip_address/user_agent anywhere in the responses);
 *  - queue == GET /api/order/counts parity on the SAME fixtures (D3);
 *  - membership revocation takes effect immediately on the new routes.
 *
 * Same fixtures/pattern as commercial-tenant-scope.integration.test.js.
 */

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    Tenant, Shop, User, UserShop, Order, Product, ProductVariant, Message,
} = require('../../entities');
const { Conversation } = require('../../conversation/conversation.entity');
const { AuditLog } = require('../../entities');
const convRoutes = require('../../conversation/conversation.routes');
const productRoutes = require('../../product/product.routes');
const orderRoutes = require('../../order/order.routes');
const dashboardRoutes = require('../dashboard.routes');
const { globalErrorHandler } = require('../../../utils/AppError');
const { generateAccessToken } = require('../../../utils/jwt.util');
const { syncSchema, truncateAll } = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();
const GENERATED = new Date('2026-11-24T10:00:00.000Z');

const app = express();
app.use(express.json());
app.use('/api/conversation', convRoutes);
app.use('/api/product', productRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use(globalErrorHandler);

async function makeTenantShopUser(label, role = 'owner') {
    const suffix = uuid().slice(0, 8);
    const tenant = await Tenant.create({ name: `${label}-${suffix}` });
    const shop = await Shop.create({
        tenant_id: tenant.id,
        unique_code: `N1-${suffix}`.slice(0, 20),
        shop_name: `${label} shop`,
        name: `${label} shop`,
    });
    const user = await User.create({
        email: `n1-${suffix}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} owner`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: user.id, shop_id: shop.id, role, is_active: true });
    return { tenant, shop, user };
}

const tokenFor = (user, shopId) => generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId,
    tokenVersion: user.token_version || 0,
    mfaVerified: true,
});
const auth = (user, shopId) => ({ Authorization: `Bearer ${tokenFor(user, shopId)}` });

async function makeConversation(shopId, { status = 'active', hitl = false, updatedAt } = {}) {
    return Conversation.create({
        shop_id: shopId,
        channel: 'messenger',
        role: 'user',
        status,
        hitl,
        message: 'price?',
        metadata: {},
        updated_at: updatedAt || GENERATED,
        created_at: updatedAt || GENERATED,
    });
}

async function makeMessage(conversationId, sender, opts = {}) {
    const { at = GENERATED } = opts;
    return Message.create({
        conversation_id: conversationId,
        sender,
        content: sender === 'customer' ? 'What is the price?' : '৳1200 ভাই',
        message_type: 'text',
        // A business reply only closes the workflow when it is provider-
        // confirmed: SENT without a provider_message_id normalizes to HELD.
        ...(sender === 'business'
            ? { delivery_state: 'SENT', provider_message_id: `pmid-${uuid().slice(0, 6)}` }
            : {}),
        created_at: at,
        updated_at: at,
    });
}

describe('A6 phase-1 nav/dashboard read models on PostgreSQL', () => {
    let shopA;
    let shopB;
    let userA;
    let userB;

    // Generous hook timeout: syncSchema({force}) is cheap on the CI service
    // container but was measured >60s on a loaded Windows host under the
    // default 60s (local trap, mirrors other files' single-suite cost when
    // several integration files share one runInBand process).
    beforeAll(async () => {
        await syncSchema();
    }, 180_000);

    beforeEach(async () => {
        await truncateAll();
        ({ shop: shopA, user: userA } = await makeTenantShopUser('N1-A'));
        ({ shop: shopB, user: userB } = await makeTenantShopUser('N1-B'));
    });

    afterAll(async () => {
        await sequelize.close();
    });

    describe('C1 GET /api/conversation/needs-reply-count', () => {
        it('counts only genuinely unanswered open conversations, tenant-scoped', async () => {
            // A: needs reply (unanswered customer message) + answered + closed.
            const needA = await makeConversation(shopA.id);
            await makeMessage(needA.id, 'customer');
            const answered = await makeConversation(shopA.id);
            await makeMessage(answered.id, 'customer', { at: new Date('2026-11-24T08:00:00Z') });
            await makeMessage(answered.id, 'business', { at: new Date('2026-11-24T09:00:00Z') });
            const closed = await makeConversation(shopA.id, { status: 'closed' });
            await makeMessage(closed.id, 'customer');
            // B: its own needs-reply conversation — must never enter A's count.
            const needB = await makeConversation(shopB.id);
            await makeMessage(needB.id, 'customer');

            const resA = await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userA, shopA.id))
                .expect(200);
            expect(resA.body.success).toBe(true);
            expect(resA.body.data).toMatchObject({
                count: 1, scanned: 2, cap: 200, coverageComplete: true,
            });
            expect(typeof resA.body.data.generated_at).toBe('string');

            const resB = await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userB, shopB.id))
                .expect(200);
            expect(resB.body.data.count).toBe(1);
            expect(resB.body.data.scanned).toBe(1);
        });

        it('201 open conversations → scanned 200 (cap), coverageComplete false, count honest lower bound', async () => {
            const rows = [];
            for (let i = 0; i < 201; i += 1) {
                rows.push({
                    id: uuid(),
                    shop_id: shopA.id,
                    channel: 'messenger',
                    role: 'user',
                    status: 'active',
                    hitl: false,
                    message: `bulk ${i}`,
                    metadata: {},
                    // Distinct updated_at so the DESC/LIMIT truncation is deterministic.
                    created_at: new Date(GENERATED.getTime() - i * 1000),
                    updated_at: new Date(GENERATED.getTime() - i * 1000),
                });
            }
            await Conversation.bulkCreate(rows);
            // Only the 100 most recent get an unanswered customer message.
            const withReplyNeed = await Conversation.findAll({
                where: { shop_id: shopA.id },
                order: [['updated_at', 'DESC']],
                limit: 100,
            });
            for (const conversation of withReplyNeed) {
                await makeMessage(conversation.id, 'customer');
            }

            const res = await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userA, shopA.id))
                .expect(200);
            expect(res.body.data.scanned).toBe(200);
            expect(res.body.data.cap).toBe(200);
            expect(res.body.data.coverageComplete).toBe(false);
            // Exact count over the scanned window — the client renders N+ because
            // coverage is incomplete, never presents 100 as exhaustive.
            expect(res.body.data.count).toBe(100);
        });

        it('a shop-B token claiming shop A is rejected (403) — never an empty 200', async () => {
            const needB = await makeConversation(shopB.id);
            await makeMessage(needB.id, 'customer');

            const forged = await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userB, shopA.id))
                .expect(403);
            expect(forged.body).not.toMatchObject({ data: { count: 0 } });

            // B's own request still sees ONLY B's data.
            const own = await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userB, shopB.id))
                .expect(200);
            expect(own.body.data.count).toBe(1);
        });
    });

    describe('C2 GET /api/product/stock-exceptions', () => {
        async function makeProduct(shopId, fields, variants = []) {
            const product = await Product.create({
                shop_id: shopId,
                name: `P-${uuid().slice(0, 6)}`,
                price: 500,
                is_active: true,
                track_quantity: true,
                low_stock_threshold: 5,
                ...fields,
            });
            for (const variant of variants) {
                await ProductVariant.create({
                    product_id: product.id,
                    shop_id: shopId,
                    sku: `V-${uuid().slice(0, 6)}`,
                    option_value: `V-${uuid().slice(0, 6)}`,
                    is_active: true,
                    ...variant,
                });
            }
            return product;
        }

        it('D2 predicate: variants are the ordering authority; out/low disjoint; totals tenant-scoped', async () => {
            await makeProduct(shopA.id, { quantity: 12 });                       // ok
            await makeProduct(shopA.id, { quantity: 3 });                        // low
            await makeProduct(shopA.id, { quantity: 0 });                        // out
            await makeProduct(shopA.id, { quantity: 0 }, [{ quantity: 7 }]);     // variants win → ok
            await makeProduct(shopA.id, { quantity: 50 }, [{ quantity: 0 }]);    // variants win → out
            await makeProduct(shopA.id, { quantity: 0 }, [{ quantity: 2, is_active: false }]); // inactive ignored → parent 0 → out
            await makeProduct(shopA.id, { quantity: 4, track_quantity: false }); // untracked → excluded entirely
            await makeProduct(shopB.id, { quantity: 1 });                        // B's low — never in A

            const res = await request(app)
                .get('/api/product/stock-exceptions')
                .set(auth(userA, shopA.id))
                .expect(200);
            expect(res.body.data).toMatchObject({
                outOfStock: 3, lowStock: 1, exceptions: 4,
                scanned: 6, cap: 1000, coverageComplete: true,
            });

            const resB = await request(app)
                .get('/api/product/stock-exceptions')
                .set(auth(userB, shopB.id))
                .expect(200);
            expect(resB.body.data).toMatchObject({ exceptions: 1, scanned: 1 });
        });

        it('a shop-B token claiming shop A is rejected on stock-exceptions too', async () => {
            await request(app)
                .get('/api/product/stock-exceptions')
                .set(auth(userB, shopA.id))
                .expect(403);
        });
    });

    describe('C3 GET /api/dashboard/queue', () => {
        async function makeOrder(shopId, fields) {
            return Order.create({
                shop_id: shopId,
                order_number: `ORD-${uuid()}`,
                total: 1000,
                customer_name: 'Confidential Buyer',
                customer_phone: '01799999999',
                order_status: 'confirmed',
                // Column default is 'pending' — pin it so only the fixture's
                // first order claims the pending-payment count.
                payment_status: 'paid',
                ...fields,
            });
        }

        it('ready_to_dispatch === counts.to_pack and at_risk ⊆ counts.needs_action on the same fixtures', async () => {
            await makeOrder(shopA.id, { order_status: 'confirmed', delivery_status: null, payment_status: 'pending' });   // to_pack + payment
            await makeOrder(shopA.id, { order_status: 'processing', delivery_status: 'unfulfilled' });                    // to_pack
            await makeOrder(shopA.id, { delivery_status: 'failed_delivery' });                                            // needs_action
            await makeOrder(shopA.id, { delivery_status: 'confidence_hold' });                                            // needs_action
            await makeOrder(shopA.id, { delivery_status: 'delivered' });                                                  // neither
            const bOrder = await makeOrder(shopB.id, { delivery_status: 'dispatch_indeterminate' });                     // B only

            const [countsRes, queueRes] = await Promise.all([
                request(app).get('/api/order/counts').set(auth(userA, shopA.id)).expect(200),
                request(app).get('/api/dashboard/queue').set(auth(userA, shopA.id)).expect(200),
            ]);
            const counts = countsRes.body.data;
            const queue = queueRes.body.data;

            expect(queue.predicate_version).toBe('worklist-v1');
            expect(queue.ready_to_dispatch_count).toBe(counts.to_pack);
            expect(queue.ready_to_dispatch_count).toBe(2);
            expect(queue.pending_payment_count).toBe(1);
            expect(queue.at_risk_orders.length).toBeLessThanOrEqual(counts.needs_action);
            expect(queue.at_risk_orders.length).toBe(2);
            // B's exception never appears in A's sample (tenant scope first).
            const aSampleIds = queue.at_risk_orders.map((o) => o.id);
            expect(aSampleIds).not.toContain(bOrder.id);
        });

        it('PII-free projections over HTTP: queue + recentActivity never serialize customer/order/audit internals', async () => {
            const failing = await Order.create({
                shop_id: shopA.id,
                updated_at: GENERATED,
                order_number: `ORD-${uuid()}`,
                total: 1000,
                order_status: 'confirmed',
                delivery_status: 'failed_delivery',
                delivery_tracking_code: 'TRK-SEC-1',
                customer_name: 'Confidential Buyer',
                customer_phone: '01799999999',
            });
            await AuditLog.create({
                shop_id: shopA.id,
                user_id: userA.id,
                action: 'ORDER_CONFIRMED',
                resource_type: 'order',
                resource_id: failing.id,
                created_at: GENERATED,
                metadata: { leak: 'audit-metadata-should-never-ship' },
                old_values: { leak: 'old-values-should-never-ship' },
                new_values: { leak: 'new-values-should-never-ship' },
                ip_address: '203.0.113.9',
                user_agent: 'integration-probe-agent',
            });

            const res = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userA, shopA.id))
                .expect(200);
            const raw = JSON.stringify(res.body);
            // Customer PII vocabulary must not exist anywhere in the response.
            expect(raw).not.toContain('Confidential Buyer');
            expect(raw).not.toContain('01799999999');
            expect(raw).not.toContain('customer_name');
            expect(raw).not.toContain('customer_phone');
            // Audit internals must not exist either.
            expect(raw).not.toContain('old_values');
            expect(raw).not.toContain('new_values');
            expect(raw).not.toContain('audit-metadata-should-never-ship');
            expect(raw).not.toContain('203.0.113.9');
            expect(raw).not.toContain('integration-probe-agent');
            // Positive control: the ORDER row IS present, PII-free, with keys.
            const atRisk = res.body.data.at_risk_orders;
            expect(atRisk).toHaveLength(1);
            // KNOWN DEFECT (routed to A5, DE-5): getTodayQueue selects the
            // attribute 'updated_at', but the Order model's timestamp key is
            // 'updatedAt' (underscored:true only renames COLUMNS) — so the
            // projection currently ships updatedAt:null instead of an ISO.
            // Pinned as-is (truthfully); flip to expect.any(String) when fixed.
            expect(atRisk[0]).toEqual({
                id: failing.id,
                orderNumber: failing.order_number,
                status: 'confirmed',
                tracking_id: 'TRK-SEC-1',
                updatedAt: null,
            });
            const activity = res.body.data.commerce_signals.recentActivity;
            expect(activity).toEqual([{
                id: expect.any(String),
                action: 'ORDER_CONFIRMED',
                resourceType: 'order',
                occurredAt: GENERATED.toISOString(),
                resource_id: failing.id,
                user: { id: userA.id, full_name: 'N1-A owner' },
            }]);
        });

        it('recentActivity excludes rogue admin:/growth_os:/job:/auth noise (incl. casing) from A and leaks nothing to B', async () => {
            await AuditLog.create({ shop_id: shopA.id, user_id: userA.id, action: 'ORDER_CREATED', resource_type: 'order', resource_id: 'x-1', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'ORDER_CONFIRMED', resource_type: 'ORDER', resource_id: 'x-2', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'admin:feature.flag.override', resource_type: 'order', resource_id: 'rogue-1', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'growth_os.prospect.view', resource_type: 'order', resource_id: 'x-4', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'job:cleanup.stale-sessions', resource_type: 'order', resource_id: 'x-5', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'auth_login', resource_type: 'user', resource_id: 'x-6', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopA.id, action: 'ADMIN:DASHBOARD_VISIT', resource_type: 'admin', resource_id: 'x-7', created_at: GENERATED });
            await AuditLog.create({ shop_id: shopB.id, user_id: userB.id, action: 'ORDER_CREATED', resource_type: 'order', resource_id: 'b-1', created_at: GENERATED });
            // 7 A-rows, only 2 merchant-real; a 7-row real feed would cap at 6 —
            // rogue noise must cap the VISIBLE list, not pad it.

            const res = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userA, shopA.id))
                .expect(200);
            const actions = res.body.data.commerce_signals.recentActivity.map((item) => item.action);
            expect(actions.sort()).toEqual(['ORDER_CONFIRMED', 'ORDER_CREATED']);
            const raw = JSON.stringify(res.body.data.commerce_signals.recentActivity);
            expect(raw).not.toContain('admin:');
            expect(raw).not.toContain('growth_os');
            expect(raw).not.toContain('job:');
            expect(raw).not.toContain('auth');

            const resB = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userB, shopB.id))
                .expect(200);
            const activityB = resB.body.data.commerce_signals.recentActivity;
            expect(activityB).toHaveLength(1);
            expect(activityB[0].action).toBe('ORDER_CREATED');
        });

        it('system rows (user_id NULL) project user:null — the client renders "System", nothing is inferred', async () => {
            await AuditLog.create({ shop_id: shopA.id, user_id: null, action: 'ORDER_CREATED', resource_type: 'order', resource_id: 'sys-1', created_at: GENERATED });
            const res = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userA, shopA.id))
                .expect(200);
            expect(res.body.data.commerce_signals.recentActivity).toEqual([{
                id: expect.any(String),
                action: 'ORDER_CREATED',
                resourceType: 'order',
                occurredAt: GENERATED.toISOString(),
                resource_id: 'sys-1',
                user: null,
            }]);
        });

        it('queue drops deprecated unread_count and answers 403 (not empty 200) to a forged cross-shop token', async () => {
            const raw = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userB, shopA.id));
            expect([403, 401]).toContain(raw.status);
            expect(raw.body.data).toBeUndefined();

            const own = await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userA, shopA.id))
                .expect(200);
            expect(own.body.data).not.toHaveProperty('unread_count');
        });
    });

    describe('membership revocation immediacy (new routes)', () => {
        it('deactivating UserShop revokes needs-reply-count, stock-exceptions and queue on the NEXT request', async () => {
            await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userA, shopA.id))
                .expect(200);
            const membership = await UserShop.findOne({ where: { user_id: userA.id, shop_id: shopA.id } });
            await membership.update({ is_active: false });

            await request(app)
                .get('/api/conversation/needs-reply-count')
                .set(auth(userA, shopA.id))
                .expect(403);
            await request(app)
                .get('/api/product/stock-exceptions')
                .set(auth(userA, shopA.id))
                .expect(403);
            await request(app)
                .get('/api/dashboard/queue')
                .set(auth(userA, shopA.id))
                .expect(403);
        });
    });
});
