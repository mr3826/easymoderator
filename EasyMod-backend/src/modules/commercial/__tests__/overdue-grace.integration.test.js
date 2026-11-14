'use strict';

/**
 * A7 — overdue-billing grace period (ADR-0011 C5) on real PostgreSQL.
 *
 * Founder-approved policy: an overdue delivered-order invoice blocks NEW
 * courier bookings (402 BILLING_OVERDUE_BOOKING_BLOCKED) and pauses automated
 * AI replies (isAiActive === false). The manual inbox and history stay
 * readable, and NOTHING is deleted. Paying the invoice restores both.
 */

const crypto = require('crypto');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    Tenant,
    Shop,
    ShopPilotFeatures,
    Subscription,
    Invoice,
    Order,
    BillingLine,
    Conversation,
} = require('../../entities');
const orderService = require('../../order/order.service');
const { assertBookingAllowed } = require('../billing-standing.service');
const { isAiActive } = require('../../subscription/subscription.access');
const { syncSchema, truncateAll } = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();
const OCT_START = new Date(Date.UTC(2026, 9, 1));
const NOV_START = new Date(Date.UTC(2026, 10, 1));

async function makeShop(label) {
    const suffix = uuid().slice(0, 8);
    const tenant = await Tenant.create({ name: `${label}-${suffix}` });
    const shop = await Shop.create({
        tenant_id: tenant.id,
        unique_code: `GR-${suffix}`.slice(0, 20),
        shop_name: `${label} shop`,
        name: `${label} shop`,
    });
    // Keep Order Confidence out of this scenario: the billing gate is the
    // subject, not courier risk scoring.
    await ShopPilotFeatures.create({ shop_id: shop.id, order_confidence_mode: 'off' });
    return shop;
}

async function makeSubscription(shop, overrides = {}) {
    return Subscription.create({
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
        ...overrides,
    });
}

async function makeBookableOrder(shop) {
    return Order.create({
        shop_id: shop.id,
        order_number: `ORD-${uuid()}`,
        order_status: 'confirmed',
        fulfillment_status: 'unfulfilled',
        delivered_at: null,
        customer_name: 'Grace Fixture',
        customer_phone: '01711111111',
        delivery_address: 'House 7, Road 2, Dhanmondi, Dhaka',
        payment_method: 'bkash',
        payment_status: 'paid',
        total: 500,
    });
}

async function makeOverdueInvoice(shop, subscription) {
    return Invoice.create({
        subscription_id: subscription.id,
        shop_id: shop.id,
        invoice_number: `INV-${uuid().slice(0, 8).toUpperCase()}`,
        invoice_type: 'delivered_order',
        amount: 100,
        base_amount: 0,
        extra_usage_amount: 100,
        billing_period: '2026-10',
        billing_period_start: OCT_START,
        billing_period_end: NOV_START,
        status: 'overdue',
        due_date: new Date(Date.now() - 24 * 60 * 60 * 1000),
        metadata: { contractVersion: '1.0.0' },
    });
}

const bookingOptions = (shop) => ({
    shopId: shop.id,
    trigger: 'MANUAL',
    mutationAuthority: { kind: 'test' },
    resolvedProvider: { provider: 'pathao', blocked: false, pickup: null },
});

describe('A7 overdue grace on PostgreSQL', () => {
    beforeAll(async () => {
        await syncSchema();
    });

    beforeEach(async () => {
        await truncateAll();
    });

    afterAll(async () => {
        await sequelize.close();
    });

    it('blocks booking and pauses AI while keeping inbox/history readable and deleting nothing', async () => {
        const shop = await makeShop('A7');
        const subscription = await makeSubscription(shop, { status: 'suspended' });
        const invoice = await makeOverdueInvoice(shop, subscription);
        const order = await makeBookableOrder(shop);
        const conversation = await Conversation.create({
            shop_id: shop.id,
            channel: 'messenger',
            status: 'active',
            role: 'user',
            message: 'hello',
        });

        const countsBefore = {
            subscriptions: await Subscription.count(),
            invoices: await Invoice.count(),
            orders: await Order.count(),
            billingLines: await BillingLine.count(),
            conversations: await Conversation.count(),
        };

        await expect(orderService.bookForOrder(order, bookingOptions(shop)))
            .rejects.toMatchObject({
                status: 402,
                code: 'BILLING_OVERDUE_BOOKING_BLOCKED',
            });

        // Automated replies are paused by the suspended subscription status
        // (the failed-payment reconciler is what sets it; this test pins the
        // access predicate C5 depends on).
        expect(isAiActive(subscription)).toBe(false);

        // Manual inbox and invoice history remain readable.
        const readableConversation = await Conversation.findOne({ where: { id: conversation.id, shop_id: shop.id } });
        expect(readableConversation).not.toBeNull();
        const history = await Invoice.findAll({ where: { shop_id: shop.id } });
        expect(history.map((row) => row.id)).toContain(invoice.id);

        // The block is a refusal, not a cleanup: every row is still present.
        expect({
            subscriptions: await Subscription.count(),
            invoices: await Invoice.count(),
            orders: await Order.count(),
            billingLines: await BillingLine.count(),
            conversations: await Conversation.count(),
        }).toEqual(countsBefore);

        // Paying the invoice restores both halves of the policy.
        await invoice.update({ status: 'paid', paid_at: new Date() });
        await subscription.update({ status: 'active' });
        await subscription.reload();

        await expect(assertBookingAllowed(shop.id)).resolves.toBe(true);
        expect(isAiActive(subscription)).toBe(true);
    });
});