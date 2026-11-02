'use strict';

process.env.NODE_ENV = 'test';
process.env.MOBILE_API_ENABLED = 'true';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../../../utils/database/database-setup');
const { generateAccessToken } = require('../../../utils/jwt.util');
const { User, Tenant, Shop, UserShop, Product, Order, OrderItem } = require('../../entities');
const AuditLog = require('../../audit/audit-log.entity');
const app = require('../../../app');

describe('manual order creation idempotency on real PostgreSQL', () => {
    let tenant;
    let shop;
    let user;
    let product;
    let token;
    const orderIds = [];
    let idempotencyKey;

    beforeAll(async () => {
        const suffix = uuidv4();
        tenant = await Tenant.create({ name: `Order Idempotency Tenant ${suffix}` });
        shop = await Shop.create({
            unique_code: `OI-${suffix}`.slice(0, 20),
            tenant_id: tenant.id,
            shop_name: `Order Idempotency Shop ${suffix}`,
            name: `Order Idempotency Shop ${suffix}`,
        });
        user = await User.create({
            email: `order-idempotency-${suffix}@example.test`,
            password: 'integration-only',
            full_name: 'Order Idempotency Merchant',
            settings: {},
        });
        await UserShop.create({ user_id: user.id, shop_id: shop.id, role: 'owner', is_active: true });
        product = await Product.create({
            shop_id: shop.id,
            name: 'Tracked idempotency fixture',
            sku: `OI-${suffix}`.slice(0, 32),
            price: 100,
            quantity: 10,
            track_quantity: true,
            low_stock_threshold: 2,
            allow_backorder: false,
            is_active: true,
        });
        idempotencyKey = `manual-order-${suffix}`;
        token = generateAccessToken({
            userId: user.id,
            email: user.email,
            shopId: shop.id,
            tokenVersion: user.token_version,
            mfaVerified: false,
        });
    }, 30000);

    afterAll(async () => {
        if (orderIds.length > 0) {
            await OrderItem.destroy({ where: { order_id: orderIds }, force: true });
            await Order.destroy({ where: { id: orderIds }, force: true });
        }
        if (shop?.id) {
            await AuditLog.destroy({ where: { shop_id: shop.id, action: 'funnel:first_order_captured' } });
            await sequelize.query('DELETE FROM order_sequences WHERE shop_id = :shopId', {
                replacements: { shopId: shop.id },
            });
        }
        if (product?.id) await Product.destroy({ where: { id: product.id }, force: true });
        if (user?.id) await UserShop.destroy({ where: { user_id: user.id } });
        if (user?.id) await User.destroy({ where: { id: user.id }, force: true });
        if (shop?.id) await Shop.destroy({ where: { id: shop.id }, force: true });
        if (tenant?.id) await Tenant.destroy({ where: { id: tenant.id }, force: true });
    }, 30000);

    test('concurrent identical REST creates return one committed order and reserve stock once', async () => {
        const payload = {
            customer_name: 'Synthetic order idempotency customer',
            customer_phone: '01700000000',
            channel: 'manual',
            payment_status: 'pending',
            delivery_address: 'Synthetic address, Dhaka',
            items: [{ product_id: product.id, quantity: 2 }],
        };
        const create = () => request(app)
            .post('/api/order')
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', idempotencyKey)
            .send(payload);

        const [first, replay] = await Promise.all([create(), create()]);
        expect([first.status, replay.status]).toEqual([201, 201]);
        expect(first.body.data.id).toBe(replay.body.data.id);
        expect(first.body.data.order_status).toBe('draft');
        orderIds.push(first.body.data.id);

        const storedOrders = await Order.findAll({ where: { shop_id: shop.id, idempotency_key: idempotencyKey } });
        const storedItems = await OrderItem.findAll({ where: { order_id: first.body.data.id } });
        const refreshedProduct = await Product.findByPk(product.id);
        expect(storedOrders).toHaveLength(1);
        expect(storedItems).toHaveLength(1);
        expect(Number(refreshedProduct.quantity)).toBe(8);

        const tracking = await request(app)
            .get(`/api/mobile/orders/${first.body.data.id}/tracking`)
            .set('Authorization', `Bearer ${token}`);
        expect(tracking.status).toBe(200);
        expect(tracking.body.data.current_status).toBe('not_booked');
        expect(tracking.body.data.status_history).toEqual([]);

        const bypassCancellation = await request(app)
            .patch(`/api/order/${first.body.data.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ order_status: 'cancelled' });
        expect(bypassCancellation.status).toBe(409);
        expect(bypassCancellation.body.code).toBe('ORDER_CANCELLATION_PATH_REQUIRED');
        expect(Number((await Product.findByPk(product.id)).quantity)).toBe(8);

        const cancellation = await request(app)
            .post(`/api/order/${first.body.data.id}/cancel`)
            .set('Authorization', `Bearer ${token}`)
            .send({ reason: 'test cancellation' });
        expect(cancellation.status).toBe(200);
        expect(cancellation.body.data.order_status).toBe('cancelled');
        expect(Number((await Product.findByPk(product.id)).quantity)).toBe(10);

        const retryAfterCancellation = await create();
        expect(retryAfterCancellation.status).toBe(201);
        expect(retryAfterCancellation.body.data.id).toBe(first.body.data.id);
        expect(retryAfterCancellation.body.data.order_status).toBe('cancelled');
        expect(await Order.count({ where: { shop_id: shop.id, idempotency_key: idempotencyKey } })).toBe(1);
        expect(Number((await Product.findByPk(product.id)).quantity)).toBe(10);

        const forgedMobileStatus = await request(app)
            .post('/api/mobile/orders/manual')
            .set('Authorization', `Bearer ${token}`)
            .send({
                customer_name: 'Synthetic status fixture',
                customer_phone: '01700000000',
                items: [{ product_id: product.id, quantity: 1 }],
                order_status: 'delivered',
                payment_status: 'paid',
                fulfillment_status: 'delivered',
            });
        expect(forgedMobileStatus.status).toBe(400);
        expect(await Order.count({ where: { shop_id: shop.id } })).toBe(1);
        expect(Number((await Product.findByPk(product.id)).quantity)).toBe(10);
    }, 30000);
});
