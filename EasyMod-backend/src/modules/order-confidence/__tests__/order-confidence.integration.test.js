'use strict';

/**
 * RTO Shield v2 / Order Confidence against REAL PostgreSQL.
 *
 * Stubbed boundaries only: the external courier provider (a controllable,
 * disposable fixture — no real parcel is ever booked) and the merchant
 * notification transport (asserted, not sent). The booking boundary
 * (orderService.bookForOrder), the courier_dispatch claim, the gate, the
 * order_confidence CAS writes, audit_logs, the Express app, auth and RBAC
 * are all real.
 */

jest.mock('../../delivery/delivery.service', () => {
    const actual = jest.requireActual('../../delivery/delivery.service');
    return {
        ...actual,
        resolveAiDefaultProvider: jest.fn(),
        createDeliveryOrder: jest.fn(),
    };
});
jest.mock('../../notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createFixtures } = require('../../../../tests/helpers/pilot-intelligence.fixtures');
const deliveryService = require('../../delivery/delivery.service');
const merchantNotificationService = require('../../notification/merchant-notification.service');
const orderService = require('../../order/order.service');
const orderConfidenceService = require('../order-confidence.service');
const deliveryTrackingService = require('../../delivery/delivery-tracking.service');
const RtoShieldService = require('../../rto-shield/rto-shield.service');
const { OrderConfidence, CourierDispatch, Order, AuditLog } = require('../../entities');

const app = require('../../../app');

const fx = createFixtures('Order Confidence IT');
let bookingSeq = 0;

const providerBooks = () => {
    deliveryService.createDeliveryOrder.mockImplementation(async () => {
        bookingSeq += 1;
        return { provider: 'pathao', consignment_id: `CN-${bookingSeq}`, tracking_code: `TRK-${bookingSeq}-${uuidv4().slice(0, 6)}`, status: 'pending' };
    });
};

const reload = (order) => Order.findByPk(order.id);
const confidenceRow = (order) => OrderConfidence.findOne({ where: { order_id: order.id } });
const dispatchRows = (order) => CourierDispatch.findAll({ where: { order_id: order.id } });
const auth = (user, shop) => ({ Authorization: `Bearer ${fx.tokenFor(user, shop.id)}` });
const bookForTest = (order, options = {}) => orderService.bookForOrder(order, {
    shopId: order.shop_id,
    ...options,
    mutationAuthority: { kind: 'test' },
});

beforeEach(() => {
    jest.clearAllMocks();
    deliveryService.resolveAiDefaultProvider.mockResolvedValue({ blocked: false, provider: 'pathao', pickup: null });
    providerBooks();
});

afterAll(async () => {
    await fx.cleanup();
});

describe('READY orders', () => {
    test('a READY order books exactly once under concurrent booking requests', async () => {
        const shop = await fx.makeShop();
        const order = await fx.makeOrder(shop, { customer_phone: '01710000001' });
        let releaseProvider;
        const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
        deliveryService.createDeliveryOrder.mockImplementation(async () => {
            await providerGate;
            return { provider: 'pathao', consignment_id: 'CN-RACE', tracking_code: 'TRK-RACE', status: 'pending' };
        });

        const attempts = Array.from({ length: 5 }, () => bookForTest(order));
        await new Promise((resolve) => setTimeout(resolve, 300));
        releaseProvider();
        const results = await Promise.all(attempts);

        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        const reconciledResults = results.filter((r) => r?.tracking_code);
        expect(reconciledResults.length).toBeGreaterThan(0);
        expect(reconciledResults.every((r) => (
            r.consignment_id === 'CN-RACE' && r.tracking_code === 'TRK-RACE'
        ))).toBe(true);
        expect(results.every((r) => r?.blocked === true || r?.tracking_code === 'TRK-RACE')).toBe(true);
        const dispatches = await dispatchRows(order);
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
            status: 'COMMITTED',
            consignment_id: 'CN-RACE',
            tracking_code: 'TRK-RACE',
        });
        const row = await confidenceRow(order);
        expect(row.decision).toBe('READY');
        expect(row.released_decision).toMatchObject({ decision: 'READY' });
        expect((await reload(order)).delivery_tracking_code).toBe('TRK-RACE');
    });

    test('evidence changing under the same decision does not invalidate a merchant review in progress', async () => {
        const shop = await fx.makeShop();
        const phone = '01710000017';
        await fx.makeOrder(shop, {
            customer_phone: phone, order_status: 'cancelled', delivery_status: 'returned', delivery_consignment_id: `R-${uuidv4()}`,
        });
        const order = await fx.makeOrder(shop, { customer_phone: phone });
        await bookForTest(order);
        const before = await confidenceRow(order);
        expect(before.decision).toBe('VERIFY');
        expect(before.reasons.map((r) => r.code)).toContain('PRIOR_RETURN');

        // A delivery lands for the same phone: evidence moves (1 returned vs 1
        // delivered), the decision and its reasons do not.
        await fx.makeOrder(shop, { customer_phone: phone, delivery_status: 'delivered', delivered_at: new Date(), delivery_tracking_code: `D-${uuidv4()}` });
        await orderConfidenceService.getDecision(shop.id, order.id);
        const after = await confidenceRow(order);
        expect(after.version).toBe(before.version);
        expect(after.reasons.find((r) => r.code === 'PRIOR_RETURN').evidence).toMatchObject({ returned: 1, delivered: 1 });
    });

    test('concurrent evaluations of one order converge on a single row without errors', async () => {
        const shop = await fx.makeShop();
        const order = await fx.makeOrder(shop, { customer_phone: '01710000002' });
        const results = await Promise.all(Array.from({ length: 8 }, () => orderConfidenceService.evaluateAndPersist(
            order, shop.id, { mode: 'enforce', config: {} },
        )));
        expect(results.every((r) => r.row && r.row.order_id === order.id)).toBe(true);
        expect(await OrderConfidence.count({ where: { order_id: order.id } })).toBe(1);
        expect((await confidenceRow(order)).version).toBe(1);
    });
});

describe('VERIFY orders', () => {
    test('automatic booking is held without a claim or provider call, and verification releases it', async () => {
        const shop = await fx.makeShop();
        const staff = await fx.makeMember(shop, 'staff');
        const order = await fx.makeOrder(shop, { customer_phone: '01710000003', delivery_address: 'Mirpur 10' });

        const held = await bookForTest(order);
        expect(held).toMatchObject({ blocked: true, status: 'confidence_hold', decision: 'VERIFY', reasons: ['ADDRESS_TOO_SHORT'] });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(await dispatchRows(order)).toHaveLength(0);
        expect((await reload(order)).delivery_status).toBe('confidence_hold');
        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            shop.id, 'order_review_required', expect.objectContaining({ orderId: order.id }), expect.anything(),
        );
        const row = await confidenceRow(order);
        expect(row).toMatchObject({ last_gate_result: 'HELD', held_count: 1 });

        // The merchant sees the decision, including why and what to do.
        const view = await request(app).get(`/api/order-confidence/orders/${order.id}`).set(auth(staff, shop));
        expect(view.status).toBe(200);
        expect(view.body.data).toMatchObject({
            decision: 'VERIFY', effective_state: 'VERIFY', required_action: 'VERIFY', bookable: true,
        });

        // A stale decision_version is refused (another change happened since review).
        const stale = await request(app)
            .post(`/api/order-confidence/orders/${order.id}/verify`)
            .set(auth(staff, shop))
            .send({ decision_version: view.body.data.decision_version - 1 || 999, method: 'PHONE_CALL' });
        expect(stale.status).toBe(409);
        expect(stale.body.error.code).toBe('DECISION_CHANGED');

        const verified = await request(app)
            .post(`/api/order-confidence/orders/${order.id}/verify`)
            .set(auth(staff, shop))
            .send({ decision_version: view.body.data.decision_version, method: 'PHONE_CALL', note: 'Confirmed house number' });
        expect(verified.status).toBe(200);
        expect(verified.body.data).toMatchObject({ effective_state: 'READY', resolution: { type: 'VERIFIED', applies: true } });
        expect((await reload(order)).delivery_status).toBeNull();

        const audit = await AuditLog.findOne({ where: { shop_id: shop.id, action: 'ORDER_CONFIDENCE_VERIFIED', resource_id: order.id } });
        expect(audit).toBeTruthy();
        expect(audit.user_id).toBe(staff.id);
        expect(audit.new_values).toMatchObject({ resolution: 'VERIFIED', method: 'PHONE_CALL', note: 'Confirmed house number' });

        const booked = await bookForTest(await reload(order));
        expect(booked.tracking_code).toBeTruthy();
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        expect((await confidenceRow(order)).released_decision).toMatchObject({ decision: 'VERIFY', resolution: 'VERIFIED' });
    });

    test('the manual book-courier route answers 409 ORDER_CONFIDENCE_HOLD for a held order', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const order = await fx.makeOrder(shop, { customer_phone: '01710000004', order_status: 'draft' });
        const response = await request(app)
            .post(`/api/order/${order.id}/book-courier`)
            .set(auth(owner, shop))
            .send({});
        expect(response.status).toBe(409);
        expect(response.body.error).toMatchObject({ code: 'ORDER_CONFIDENCE_HOLD', decision: 'VERIFY' });
        expect(response.body.error.reasons).toContain('ORDER_NOT_CONFIRMED');
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });
});

describe('MANUAL_REVIEW orders', () => {
    async function repeatedReturnsOrder(shop, phone) {
        for (let i = 0; i < 2; i += 1) {
            await fx.makeOrder(shop, {
                customer_phone: phone, order_status: 'cancelled', delivery_status: 'returned',
                delivery_consignment_id: `OLD-${uuidv4()}`,
            });
        }
        return fx.makeOrder(shop, { customer_phone: phone });
    }

    test('needs owner/admin approval: staff get 403, verify is refused, approval is audited and releases booking', async () => {
        const shop = await fx.makeShop();
        const staff = await fx.makeMember(shop, 'staff');
        const owner = await fx.makeMember(shop, 'owner');
        const order = await repeatedReturnsOrder(shop, '01710000005');

        expect(await bookForTest(order))
            .toMatchObject({ status: 'confidence_hold', decision: 'MANUAL_REVIEW', reasons: expect.arrayContaining(['REPEATED_RETURNS']) });
        const { body: { data: decision } } = await request(app)
            .get(`/api/order-confidence/orders/${order.id}`).set(auth(owner, shop));
        expect(decision).toMatchObject({ decision: 'MANUAL_REVIEW', required_action: 'APPROVE' });

        const staffApprove = await request(app)
            .post(`/api/order-confidence/orders/${order.id}/approve`)
            .set(auth(staff, shop))
            .send({ decision_version: decision.decision_version, note: 'Looks fine to me' });
        expect(staffApprove.status).toBe(403);

        const staffVerify = await request(app)
            .post(`/api/order-confidence/orders/${order.id}/verify`)
            .set(auth(staff, shop))
            .send({ decision_version: decision.decision_version, method: 'CHAT' });
        expect(staffVerify.status).toBe(409);
        expect(staffVerify.body.error.code).toBe('APPROVAL_REQUIRED');

        expect(await bookForTest(order)).toMatchObject({ status: 'confidence_hold' });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();

        const approved = await request(app)
            .post(`/api/order-confidence/orders/${order.id}/approve`)
            .set(auth(owner, shop))
            .send({ decision_version: (await confidenceRow(order)).version, note: 'Known customer, called and confirmed' });
        expect(approved.status).toBe(200);
        expect(approved.body.data.resolution).toMatchObject({ type: 'APPROVED', level: 'MANUAL_REVIEW', resolved_by: owner.id });

        const audit = await AuditLog.findOne({ where: { shop_id: shop.id, action: 'ORDER_CONFIDENCE_APPROVED', resource_id: order.id } });
        expect(audit.user_id).toBe(owner.id);
        expect(audit.old_values).toMatchObject({ decision: 'MANUAL_REVIEW' });
        expect(audit.new_values).toMatchObject({ resolution: 'APPROVED', note: 'Known customer, called and confirmed' });
        expect(audit.new_values.fingerprint).toMatch(/^[0-9a-f]{64}$/);

        expect((await bookForTest(await reload(order))).tracking_code).toBeTruthy();
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });

    test('two concurrent approvals of the same decision version: exactly one wins', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const admin = await fx.makeMember(shop, 'admin');
        const order = await repeatedReturnsOrder(shop, '01710000006');
        await bookForTest(order);
        const version = (await confidenceRow(order)).version;

        const [a, b] = await Promise.all([
            request(app).post(`/api/order-confidence/orders/${order.id}/approve`).set(auth(owner, shop))
                .send({ decision_version: version, note: 'owner approves' }),
            request(app).post(`/api/order-confidence/orders/${order.id}/approve`).set(auth(admin, shop))
                .send({ decision_version: version, note: 'admin approves' }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect(await AuditLog.count({ where: { shop_id: shop.id, action: 'ORDER_CONFIDENCE_APPROVED', resource_id: order.id } })).toBe(1);
    });

    test('a material edit after approval voids it and the order is held again', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const order = await repeatedReturnsOrder(shop, '01710000007');
        await bookForTest(order);
        await request(app).post(`/api/order-confidence/orders/${order.id}/approve`).set(auth(owner, shop))
            .send({ decision_version: (await confidenceRow(order)).version, note: 'approved before edit' })
            .expect(200);

        await orderService.updateOrder(order.id, owner.id, shop.id, { delivery_address: 'House 99, Road 1, Uttara, Dhaka' });

        const held = await bookForTest(await reload(order));
        expect(held).toMatchObject({ status: 'confidence_hold', decision: 'MANUAL_REVIEW' });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        const row = await confidenceRow(order);
        expect(row.resolution).toBe('APPROVED');
        expect(row.resolution_fingerprint).not.toBe(row.input_fingerprint);
        expect(row.history.map((h) => h.event)).toContain('RESOLUTION_STALE');
        const view = await request(app).get(`/api/order-confidence/orders/${order.id}`).set(auth(owner, shop));
        expect(view.body.data.resolution).toMatchObject({ applies: false, stale: true });
    });

    test('an order cancelled after approval is never booked and cannot be re-approved', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const order = await repeatedReturnsOrder(shop, '01710000008');
        await bookForTest(order);
        await request(app).post(`/api/order-confidence/orders/${order.id}/approve`).set(auth(owner, shop))
            .send({ decision_version: (await confidenceRow(order)).version, note: 'approved then cancelled' })
            .expect(200);
        await orderService.cancelOrder(owner.id, shop.id, order.id, 'customer changed mind');

        // A cancelled order is not bookable: assertCourierOrderBookable throws
        // ORDER_NOT_BOOKABLE (the same code this test asserts for re-approval
        // below). It is not a structured confidence hold — the gate produces no
        // ORDER_CANCELLED reason.
        await expect(bookForTest(await reload(order)))
            .rejects.toMatchObject({ status: 409, code: 'ORDER_NOT_BOOKABLE' });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        // Re-review through the API first (exactly what the client must do):
        // cancellation changes the order fingerprint, so the persisted decision
        // is re-evaluated and now carries the ORDER_CANCELLED block.
        const refreshed = await request(app).get(`/api/order-confidence/orders/${order.id}`).set(auth(owner, shop));
        expect(refreshed.status).toBe(200);
        expect(refreshed.body.data.reasons.map((reason) => reason.code)).toContain('ORDER_CANCELLED');
        expect(refreshed.body.data.bookable).toBe(false);
        // With the current decision version in hand, the approve endpoint still
        // refuses — the lifecycle block, not just a stale-version conflict.
        const again = await request(app).post(`/api/order-confidence/orders/${order.id}/approve`).set(auth(owner, shop))
            .send({ decision_version: refreshed.body.data.decision_version, note: 'try again' });
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('ORDER_NOT_BOOKABLE');
    });
});

describe('provider failure and retries', () => {
    test('a provider timeout leaves an INDETERMINATE claim and a retry never books a second parcel', async () => {
        const shop = await fx.makeShop();
        const order = await fx.makeOrder(shop, { customer_phone: '01710000009' });
        deliveryService.createDeliveryOrder.mockRejectedValueOnce(Object.assign(new Error('socket timeout'), { code: 'ECONNRESET' }));

        await expect(bookForTest(order)).rejects.toThrow('socket timeout');
        const [claim] = await dispatchRows(order);
        expect(claim.status).toBe('INDETERMINATE');

        const retry = await bookForTest(await reload(order));
        expect(retry).toMatchObject({ blocked: true, reason: 'existing_courier_dispatch_claim' });
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        expect(await dispatchRows(order)).toHaveLength(1);
    });

    test('after a successful booking, later order updates never cause a second booking', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const order = await fx.makeOrder(shop, { customer_phone: '01710000010' });
        const first = await bookForTest(order);
        // The note ships in the courier payload, so it is a courier-relevant
        // field: post-dispatch edits are refused fail-closed, never applied
        // silently, and never trigger a second booking.
        await expect(orderService.updateOrder(order.id, owner.id, shop.id, { note: 'late note after booking' }))
            .rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });
        const again = await bookForTest(await reload(order));
        expect(again.tracking_code).toBe(first.tracking_code);
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });
});

describe('outcome feedback', () => {
    test('a delivered outcome is recorded once even when the courier webhook is replayed concurrently', async () => {
        const shop = await fx.makeShop();
        const order = await fx.makeOrder(shop, { customer_phone: '01710000011' });
        const booked = await bookForTest(order);

        await Promise.all([
            deliveryTrackingService.handleDeliveryWebhook('pathao', booked.tracking_code, { status: 'delivered' }),
            deliveryTrackingService.handleDeliveryWebhook('pathao', booked.tracking_code, { status: 'delivered' }),
        ]);
        await deliveryTrackingService.handleDeliveryWebhook('pathao', booked.tracking_code, { status: 'returned' });

        const row = await confidenceRow(order);
        expect(row.outcome).toBe('DELIVERED');
        expect(row.outcome_at).toBeTruthy();
        expect(row.released_decision).toMatchObject({ decision: 'READY' });
    });
});

describe('modes and tenancy', () => {
    test('shadow mode never blocks, but records what it would have held', async () => {
        const shop = await fx.makeShop({ orderConfidenceMode: 'shadow' });
        const order = await fx.makeOrder(shop, { customer_phone: '01710000012', delivery_address: 'Mirpur' });
        const result = await bookForTest(order);
        expect(result.tracking_code).toBeTruthy();
        const row = await confidenceRow(order);
        expect(row).toMatchObject({ decision: 'VERIFY', last_gate_result: 'SHADOW_WOULD_HOLD', mode: 'shadow' });
    });

    test('mode off writes nothing and books exactly as before', async () => {
        const shop = await fx.makeShop({ orderConfidenceMode: 'off' });
        const order = await fx.makeOrder(shop, { customer_phone: '01710000013', delivery_address: 'Mirpur' });
        expect((await bookForTest(order)).tracking_code).toBeTruthy();
        expect(await confidenceRow(order)).toBeNull();
    });

    test('mode off still holds a BLOCK COD phone signal for owner/admin review before courier mutation', async () => {
        const shop = await fx.makeShop({ orderConfidenceMode: 'off' });
        const owner = await fx.makeMember(shop, 'owner');
        const phone = '01710000018';
        await RtoShieldService.addToBlacklist({
            phone, shop_id: shop.id, risk_score: 90, reason: 'test fixture high-risk signal',
        });
        const order = await fx.makeOrder(shop, {
            customer_phone: phone,
            order_status: 'confirmed',
            payment_method: 'COD',
            payment_status: 'unpaid',
            delivery_address: 'House 10, Road 4, Mirpur, Dhaka',
        });

        const held = await bookForTest(order);
        expect(held).toMatchObject({
            blocked: true,
            status: 'confidence_hold',
            decision: 'MANUAL_REVIEW',
            reasons: expect.arrayContaining(['RTO_SHIELD_BLOCK']),
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect((await reload(order)).order_status).toBe('confirmed');
        const row = await confidenceRow(order);
        expect(row.mode).toBe('enforce');

        const viewed = await request(app).get(`/api/order-confidence/orders/${order.id}`).set(auth(owner, shop));
        expect(viewed.status).toBe(200);
        expect(viewed.body.data).toMatchObject({ decision: 'MANUAL_REVIEW', required_action: 'APPROVE', mode: 'enforce' });
        const approved = await request(app).post(`/api/order-confidence/orders/${order.id}/approve`)
            .set(auth(owner, shop))
            .send({ decision_version: viewed.body.data.decision_version, note: 'Reviewed source history' });
        expect(approved.status).toBe(200);
        expect((await bookForTest(await reload(order))).tracking_code).toBeTruthy();
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });

    test('shadow mode still requires human verification for a VERIFY COD phone signal', async () => {
        const shop = await fx.makeShop({ orderConfidenceMode: 'shadow' });
        const staff = await fx.makeMember(shop, 'staff');
        const phone = '01710000019';
        await RtoShieldService.addToBlacklist({
            phone, shop_id: shop.id, risk_score: 55, reason: 'test fixture verification signal',
        });
        const order = await fx.makeOrder(shop, {
            customer_phone: phone,
            order_status: 'confirmed',
            payment_method: 'COD',
            payment_status: 'unpaid',
            delivery_address: 'House 10, Road 4, Mirpur, Dhaka',
        });

        const held = await bookForTest(order);
        expect(held).toMatchObject({
            blocked: true,
            status: 'confidence_hold',
            decision: 'VERIFY',
            reasons: expect.arrayContaining(['RTO_SHIELD_VERIFY']),
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        const viewed = await request(app).get(`/api/order-confidence/orders/${order.id}`).set(auth(staff, shop));
        expect(viewed.status).toBe(200);
        expect(viewed.body.data.mode).toBe('enforce');
        const verified = await request(app).post(`/api/order-confidence/orders/${order.id}/verify`)
            .set(auth(staff, shop))
            .send({ decision_version: viewed.body.data.decision_version, method: 'PHONE_CALL' });
        expect(verified.status).toBe(200);
        expect((await bookForTest(await reload(order))).tracking_code).toBeTruthy();
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });

    test('another shop cannot read, verify or approve an order', async () => {
        const shopA = await fx.makeShop();
        const shopB = await fx.makeShop();
        const ownerB = await fx.makeMember(shopB, 'owner');
        const orderA = await fx.makeOrder(shopA, { customer_phone: '01710000014', delivery_address: 'Mirpur' });
        await bookForTest(orderA, { shopId: shopA.id });

        const read = await request(app).get(`/api/order-confidence/orders/${orderA.id}`).set(auth(ownerB, shopB));
        expect(read.status).toBe(404);
        const approve = await request(app).post(`/api/order-confidence/orders/${orderA.id}/approve`).set(auth(ownerB, shopB))
            .send({ decision_version: 1, note: 'cross tenant attempt' });
        expect(approve.status).toBe(404);
        expect((await confidenceRow(orderA)).resolution).toBeNull();
    });

    test('unauthenticated and malformed requests are refused before any work', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        expect((await request(app).get(`/api/order-confidence/orders/${uuidv4()}`)).status).toBe(401);
        expect((await request(app).get('/api/order-confidence/orders/not-a-uuid').set(auth(owner, shop))).status).toBe(400);
        const extra = await request(app).post(`/api/order-confidence/orders/${uuidv4()}/verify`).set(auth(owner, shop))
            .send({ decision_version: 1, method: 'PHONE_CALL', resolution_level: 'MANUAL_REVIEW' });
        expect(extra.status).toBe(400);
    });

    test('summary is owner/admin only and reports decisions and outcomes', async () => {
        const shop = await fx.makeShop();
        const owner = await fx.makeMember(shop, 'owner');
        const staff = await fx.makeMember(shop, 'staff');
        await bookForTest(await fx.makeOrder(shop, { customer_phone: '01710000015' }));
        await bookForTest(await fx.makeOrder(shop, { customer_phone: '01710000016', delivery_address: 'Mirpur' }));
        expect((await request(app).get('/api/order-confidence/summary').set(auth(staff, shop))).status).toBe(403);
        const { body } = await request(app).get('/api/order-confidence/summary').set(auth(owner, shop));
        expect(body.data).toMatchObject({ evaluated_orders: 2, by_decision: { READY: 1, VERIFY: 1 }, held_orders: 1 });
    });
});
