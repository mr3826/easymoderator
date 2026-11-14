'use strict';

/**
 * A8 — commercial tenant scope on real PostgreSQL.
 *
 * The JWT's shop claim is not a tenant selector by itself: membership is
 * re-verified on every request (verifyShopAccess), the controller reads
 * `req.shop.id` only, and the billing-lines query proves invoice ownership.
 * A shop-B principal can never read shop-A claims/billing lines, and an
 * X-Shop-ID header cannot widen scope.
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    Tenant,
    Shop,
    User,
    UserShop,
    Subscription,
    Invoice,
    Order,
    BillingLine,
} = require('../../entities');
const commercialRoutes = require('../commercial.routes');
const billing = require('../delivered-order-billing.service');
const { generateAccessToken } = require('../../../utils/jwt.util');
const { syncSchema, truncateAll } = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();
const OCT_START = new Date(Date.UTC(2026, 9, 1));
const NOV_START = new Date(Date.UTC(2026, 10, 1));

const app = express();
app.use(express.json());
app.use('/api/commercial', commercialRoutes);
// Mirror the production error contract closely enough to assert status/code.
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(error?.status || 500).json({
        success: false,
        code: error?.code || 'INTERNAL_ERROR',
    });
});

async function makeTenantShopUser(label, role = 'owner') {
    const suffix = uuid().slice(0, 8);
    const tenant = await Tenant.create({ name: `${label}-${suffix}` });
    const shop = await Shop.create({
        tenant_id: tenant.id,
        unique_code: `TS-${suffix}`.slice(0, 20),
        shop_name: `${label} shop`,
        name: `${label} shop`,
    });
    const user = await User.create({
        email: `ts-${suffix}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: user.id, shop_id: shop.id, role, is_active: true });
    return { tenant, shop, user };
}

async function makeInvoiceWithLine(shop, label) {
    const subscription = await Subscription.create({
        shop_id: shop.id,
        status: 'active',
        plan_code: 'MERCHANT',
        plan_name: 'EasyModerator',
        plan_price: 0,
        billing_cycle: 'per_order',
        billing_model: 'per_order',
        per_order_charge_bdt: 10.0,
        conversations_limit: -1,
        orders_limit: -1,
        current_period_start: OCT_START,
        current_period_end: NOV_START,
        next_billing_date: NOV_START,
    });
    const invoice = await Invoice.create({
        subscription_id: subscription.id,
        shop_id: shop.id,
        invoice_number: `INV-${label}-${uuid().slice(0, 6).toUpperCase()}`,
        invoice_type: 'delivered_order',
        amount: 10,
        base_amount: 0,
        extra_usage_amount: 10,
        billing_period: '2026-10',
        billing_period_start: OCT_START,
        billing_period_end: NOV_START,
        status: 'pending',
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        metadata: { contractVersion: '1.0.0' },
    });
    const order = await Order.create({
        shop_id: shop.id,
        order_number: `ORD-${uuid()}`,
        order_status: 'delivered',
        delivered_at: new Date('2026-10-05T10:00:00.000Z'),
        customer_name: 'Tenant Fixture',
        customer_phone: '01711111111',
        total: 100,
    });
    await BillingLine.create({
        shop_id: shop.id,
        order_id: order.id,
        line_kind: 'billable',
        outcome: 'DELIVERED',
        unit_price_minor: 1000,
        amount_minor: 1000,
        currency: 'BDT',
        contract_version: '1.0.0',
        idempotency_key: billing.billingIdempotencyKey(shop.id, order.id, 'billable'),
        occurred_at: '2026-10-05',
        invoice_id: invoice.id,
        metadata: {},
    });
    return { subscription, invoice, order };
}

const tokenFor = (user, shopId) => generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId,
    tokenVersion: user.token_version || 0,
    mfaVerified: true,
});

describe('A8 commercial tenant scope on PostgreSQL', () => {
    let shopA;
    let shopB;
    let userA;
    let userB;
    let invoiceA;
    let invoiceB;

    beforeAll(async () => {
        await syncSchema();
    });

    beforeEach(async () => {
        await truncateAll();
        ({ shop: shopA, user: userA } = await makeTenantShopUser('A8-A'));
        ({ shop: shopB, user: userB } = await makeTenantShopUser('A8-B'));
        ({ invoice: invoiceA } = await makeInvoiceWithLine(shopA, 'A'));
        ({ invoice: invoiceB } = await makeInvoiceWithLine(shopB, 'B'));
    });

    afterAll(async () => {
        await sequelize.close();
    });

    it('rejects a token whose shop claim the user is not a member of (403 on all three surfaces)', async () => {
        // Shop-B user, token claiming shop A. Membership re-check fails before
        // any controller code runs.
        const forged = tokenFor(userB, shopA.id);

        await request(app).get('/api/commercial/contract')
            .set('Authorization', `Bearer ${forged}`)
            .expect(403);
        await request(app).get('/api/commercial/claims?surface=invoice&locale=en')
            .set('Authorization', `Bearer ${forged}`)
            .expect(403);
        await request(app).get(`/api/commercial/billing-lines?invoiceId=${invoiceA.id}`)
            .set('Authorization', `Bearer ${forged}`)
            .expect(403);
    });

    it('shop-B JWT cannot read a shop-A invoice\'s billing lines (403 INVOICE_FORBIDDEN)', async () => {
        const tokenB = tokenFor(userB, shopB.id);

        const response = await request(app)
            .get(`/api/commercial/billing-lines?invoiceId=${invoiceA.id}`)
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(403);
        expect(response.body.code).toBe('INVOICE_FORBIDDEN');

        // Positive control: the same principal reads its OWN invoice.
        const own = await request(app)
            .get(`/api/commercial/billing-lines?invoiceId=${invoiceB.id}`)
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(200);
        expect(own.body.data.lines).toHaveLength(1);
        expect(own.body.data.lines[0].invoiceId).toBe(invoiceB.id);
    });

    it('X-Shop-ID cannot widen tenant scope and shop-B still cannot read shop-A', async () => {
        const tokenB = tokenFor(userB, shopB.id);

        // JWT-only tenant selection: a spoofed header is ignored.
        await request(app)
            .get('/api/commercial/contract')
            .set('Authorization', `Bearer ${tokenB}`)
            .set('X-Shop-ID', shopA.id)
            .expect(200);

        const response = await request(app)
            .get(`/api/commercial/billing-lines?invoiceId=${invoiceA.id}`)
            .set('Authorization', `Bearer ${tokenB}`)
            .set('X-Shop-ID', shopA.id)
            .expect(403);
        expect(response.body.code).toBe('INVOICE_FORBIDDEN');
    });
});