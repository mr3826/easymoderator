'use strict';

jest.mock('../../delivery/delivery.service', () => ({
    resolveAiDefaultProvider: jest.fn(),
    createDeliveryOrder: jest.fn(),
}));

jest.mock('../../invoice/chat-invoice.service', () => ({
    issueInvoiceForOrder: jest.fn().mockResolvedValue({ issued: true }),
}));

jest.mock('../../webhook/webhook.service', () => ({
    sendToCustomer: jest.fn().mockResolvedValue({ sent: true }),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const deliveryService = require('../../delivery/delivery.service');
const paymentWebhookRoutes = require('../payment-webhook.routes');
const orderService = require('../../order/order.service');
const {
    Tenant,
    Shop,
    Customer,
    Order,
    PaymentTransaction,
    CourierDispatch,
    DeliveryTracking,
} = require('../../entities');

const WEBHOOK_SECRET = 'integration-bkash-webhook-secret';

const app = express();
app.use(express.json({
    verify: (req, _res, buffer) => { req.rawBody = buffer; },
}));
app.use('/api/webhooks', paymentWebhookRoutes);

const sign = (body) => crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

const postWebhook = (body) => {
    const rawBody = JSON.stringify(body);
    return request(app)
        .post('/api/webhooks/bkash/payment-status')
        .set('Content-Type', 'application/json')
        .set('x-bkash-signature', sign(rawBody))
        .send(rawBody);
};

describe('real bKash webhook courier claim boundary', () => {
    let tenant;
    let shop;
    let customer;
    let order;
    let payment;

    beforeAll(async () => {
        process.env.BKASH_WEBHOOK_SECRET = WEBHOOK_SECRET;
        tenant = await Tenant.create({ name: `bKash race ${Date.now()}` });
        shop = await Shop.create({
            unique_code: `BK-${Date.now()}-${Math.floor(Math.random() * 10000)}`.slice(0, 20),
            tenant_id: tenant.id,
            shop_name: 'bKash Race Shop',
            name: 'bKash Race Shop',
        });
        customer = await Customer.create({
            shop_id: shop.id,
            name: 'bKash Race Buyer',
            channel_type: 'manual',
            channel_user_id: `bkash-race-${Date.now()}`,
            phone: '01711111111',
        });
    });

    beforeEach(async () => {
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'pathao',
            pickup: { provider_store_id: 'sandbox-store-1' },
        });
        deliveryService.createDeliveryOrder.mockResolvedValue({
            provider: 'pathao',
            consignment_id: 'CN-BKASH-RACE',
            tracking_code: 'TRK-BKASH-RACE',
            status: 'pending',
        });
        order = await Order.create({
            shop_id: shop.id,
            customer_id: customer.id,
            order_number: `ORD-BK-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            customer_name: 'bKash Race Buyer',
            customer_phone: '01711111111',
            delivery_address: {
                street_address: 'Road 1',
                upazila: 'Dhanmondi',
                district: 'Dhaka',
            },
            // This provider-specific selection was confirmed through Pathao's
            // directory before the payment webhook attempts courier booking.
            delivery_location: JSON.stringify({
                provider_destination: {
                    pathao: {
                        area_id: 11, area_name: 'Dhanmondi',
                        zone_id: 22, zone_name: 'Dhanmondi',
                        city_id: 33, city_name: 'Dhaka',
                        district: 'Dhaka',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'user-1',
                    },
                },
            }),
            total: 1250,
            items: [{ name: 'bKash Race Item', quantity: 1 }],
            order_status: 'placed',
            fulfillment_status: 'unfulfilled',
            // The customer chose bKash at checkout; the webhook verifies the
            // payment. A bookable order must carry its payment method.
            payment_method: 'bkash',
            payment_status: 'pending',
        });
        payment = await PaymentTransaction.create({
            order_id: order.id,
            shop_id: shop.id,
            payment_method: 'bkash',
            payment_gateway: 'bkash',
            transaction_id: `PAY-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            amount: '1250.00',
            status: 'pending',
        });
    });

    afterEach(async () => {
        if (!order || !payment) return;
        await DeliveryTracking.destroy({ where: { order_id: order.id } });
        await CourierDispatch.destroy({ where: { order_id: order.id } });
        await PaymentTransaction.destroy({ where: { id: payment.id } });
        await Order.destroy({ where: { id: order.id } });
        jest.clearAllMocks();
    });

    afterAll(async () => {
        await Customer.destroy({ where: { id: customer.id } });
        await Shop.destroy({ where: { id: shop.id } });
        await Tenant.destroy({ where: { id: tenant.id } });
    });

    test('claims one real webhook callback and blocks the concurrent replay before booking', async () => {
        let providerStarted;
        let releaseProvider;
        const providerReady = new Promise(resolve => { providerStarted = resolve; });
        const providerResult = new Promise(resolve => { releaseProvider = resolve; });
        deliveryService.createDeliveryOrder.mockImplementation(async () => {
            providerStarted();
            return providerResult;
        });

        const body = {
            paymentID: payment.transaction_id,
            transactionStatus: 'Completed',
            trxID: `TRX-${payment.id}`,
            merchantInvoiceNumber: order.order_number,
            amount: '1250.00',
        };

        // Supertest starts a request when its thenable is consumed. Convert it
        // immediately so the first callback is genuinely in flight before the
        // replay is issued.
        const firstResponsePromise = postWebhook(body).then(response => response);
        await providerReady;
        const competingBookingPromise = orderService.bookForOrder(
            await Order.findByPk(order.id),
            { shopId: shop.id, mutationAuthority: { kind: 'test' } },
        );
        const secondResponse = await postWebhook(body);
        const competingBooking = await competingBookingPromise;

        expect(secondResponse.status).toBe(202);
        expect(secondResponse.body).toEqual({ success: true, pending: true });
        expect(competingBooking).toMatchObject({
            blocked: true,
            reason: 'existing_courier_dispatch_claim',
        });

        releaseProvider({
            provider: 'pathao',
            consignment_id: 'CN-BKASH-RACE',
            tracking_code: 'TRK-BKASH-RACE',
            status: 'pending',
        });
        const firstResponse = await firstResponsePromise;

        expect(firstResponse.status).toBe(200);
        expect(firstResponse.body).toEqual({ success: true });
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);

        const dispatches = await CourierDispatch.findAll({ where: { shop_id: shop.id, order_id: order.id } });
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject({
            status: 'COMMITTED',
            consignment_id: 'CN-BKASH-RACE',
            tracking_code: 'TRK-BKASH-RACE',
        });

        await order.reload();
        expect(order.delivery_consignment_id).toBe('CN-BKASH-RACE');
        expect(order.delivery_tracking_code).toBe('TRK-BKASH-RACE');
        await payment.reload();
        expect(payment.status).toBe('paid');
    });

    test('does not let a stale claim transition downgrade a committed webhook booking', async () => {
        await orderService.bookForOrder(order, {
            shopId: shop.id,
            mutationAuthority: { kind: 'test' },
        });
        const committed = await CourierDispatch.findOne({ where: { shop_id: shop.id, order_id: order.id } });

        const transition = await orderService.transitionCourierDispatchRecord(
            committed,
            { status: 'INDETERMINATE', error: 'stale webhook loser' },
            {
                ownerToken: committed.dispatch_owner_token,
                expectedStatus: 'PENDING',
            },
        );

        expect(transition.updated).toBe(false);
        await committed.reload();
        expect(committed.status).toBe('COMMITTED');
    });
});
