/**
 * Order Cancel / Return — Inventory Sync Tests (CRITICAL BUG FIX COVERAGE)
 * Verifies that cancelling an order or approving a return restores product quantities.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (cb) => {
            if (typeof cb === 'function') return cb(mockTransaction);
            return mockTransaction;
        }),
        query: jest.fn().mockResolvedValue([[{ next_number: 1 }]]),
        getDialect: jest.fn().mockReturnValue('postgres'),
        literal: jest.fn((s) => s),
        define: jest.fn().mockReturnValue({ findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn() })
    }
}));

const mockProduct = {
    id: 'prod-1',
    name: 'Test Product',
    track_quantity: true,
    quantity: 8,
    increment: jest.fn().mockResolvedValue(true),
    decrement: jest.fn().mockResolvedValue(true)
};

const mockOrderItems = [
    { id: 'item-1', product_id: 'prod-1', quantity: 2, price: 500, getProduct: jest.fn().mockResolvedValue(mockProduct) },
    { id: 'item-2', product_id: 'prod-2', quantity: 1, price: 300, getProduct: jest.fn().mockResolvedValue({ ...mockProduct, id: 'prod-2', track_quantity: false }) }
];

const makeOrder = (overrides = {}) => ({
    id: 'order-1',
    shop_id: 'shop-1',
    order_status: 'confirmed',
    fulfillment_status: 'unfulfilled',
    order_number: 'ORD-001',
    customer_id: 'cust-1',
    total_amount: 1000,
    items: mockOrderItems,
    update: jest.fn(async (data) => Object.assign(order, data)),
    ...overrides
});

let order;

const makeReturn = (overrides = {}) => ({
    id: 'ret-1',
    order_id: 'order-1',
    shop_id: 'shop-1',
    status: 'pending',
    items: [{ product_id: 'prod-1', quantity: 2 }],
    update: jest.fn().mockResolvedValue(true),
    ...overrides
});

jest.mock('../../entities', () => ({
    Order: {
        findOne: jest.fn(),
        findByPk: jest.fn(),
        findAll: jest.fn(),
        findAndCountAll: jest.fn(),
        create: jest.fn()
    },
    OrderItem: {
        findAll: jest.fn(),
        create: jest.fn(),
        bulkCreate: jest.fn()
    },
    Product: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        findByPk: jest.fn(),
        decrement: jest.fn().mockResolvedValue(true),
        increment: jest.fn().mockResolvedValue(true)
    },
    Customer: { findOne: jest.fn() },
    UserShop: { findOne: jest.fn() },
    Channel: { findOne: jest.fn() },
    OrderReturn: {
        findOne: jest.fn(),
        create: jest.fn(),
        findAll: jest.fn()
    },
    CourierDispatch: { findOne: jest.fn(), findOrCreate: jest.fn(), update: jest.fn() },
    DeliveryTracking: { findOne: jest.fn() },
    Invoice: { create: jest.fn(), findOne: jest.fn() },
    Subscription: { findOne: jest.fn() },
    PartnerBillingAdjustment: { create: jest.fn(), findOne: jest.fn() }
}));

// AppError is NOT mocked. The stub this replaced set `statusCode`, while the
// real class sets `status` — assertions written against the stub passed while
// the same assertion against production behaviour would fail.
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
}));

jest.mock('../../subscription/subscription.service', () => ({
    checkOrderLimit: jest.fn().mockResolvedValue(true),
    trackUsage: jest.fn()
}));

jest.mock('../../rto-shield/rto-shield.service', () => ({
    checkPhone: jest.fn().mockResolvedValue({ score: 0 })
}));

jest.mock('../../product/stock-status-guard.service', () => ({
    invalidate: jest.fn().mockResolvedValue(true),
    getStockStatus: jest.fn().mockResolvedValue('in_stock')
}));

jest.mock('../../../utils/email.service', () => ({
    sendEmail: jest.fn().mockResolvedValue(true)
}));

jest.mock('../../../jobs/queue-manager', () => ({
    queues: { notifications: { add: jest.fn().mockResolvedValue({ id: 'notif-1' }) } }
}));

// ── Require after mocks ───────────────────────────────────────────────────────

const orderService = require('../order.service');
const returnService = require('../return.service');
const {
    Order, OrderItem, Product, UserShop, OrderReturn, Invoice, Subscription, PartnerBillingAdjustment, CourierDispatch, DeliveryTracking
} = require('../../entities');
const { AppError } = require('../../../utils/AppError');
const stockGuard = require('../../product/stock-status-guard.service');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Order Cancel → Inventory Sync', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        order = makeOrder();
        Order.findOne.mockResolvedValue(order);
        UserShop.findOne.mockResolvedValue({ id: 'us-1', is_active: true });
        CourierDispatch.findOne.mockResolvedValue(null);
        DeliveryTracking.findOne.mockResolvedValue(null);
        PartnerBillingAdjustment.findOne.mockResolvedValue(null);
        OrderItem.findAll.mockResolvedValue(mockOrderItems);
        Product.findAll.mockResolvedValue([
            mockProduct,
            { ...mockProduct, id: 'prod-2', track_quantity: false },
        ]);
    });

    // The service restores through the INSTANCE returned by Product.findOne
    // (`product.increment('quantity', { by })`), never the model-level
    // Product.increment the previous assertions watched — which is why they
    // reported "0 calls" against code that does restore stock.
    it('restores stock for tracked items when order is cancelled', async () => {
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        expect(mockProduct.increment).toHaveBeenCalledWith(
            'quantity',
            expect.objectContaining({ by: 2 })
        );
        expect(Product.findAll).toHaveBeenCalledWith(expect.objectContaining({
            order: [['id', 'ASC']],
            lock: 'UPDATE',
            transaction: mockTransaction,
        }));
    });

    it('locks the shop-scoped order row before cancellation and inventory restoration', async () => {
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        expect(Order.findOne).toHaveBeenCalledWith({
            where: { id: 'order-1', shop_id: 'shop-1' },
            transaction: mockTransaction,
            lock: 'UPDATE',
        });
    });

    it('does not cancel or restore stock while a courier dispatch is active', async () => {
        CourierDispatch.findOne.mockResolvedValue({ id: 'dispatch-1', status: 'PENDING' });

        await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
            .rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });

        expect(order.update).not.toHaveBeenCalled();
        expect(Product.findAll).not.toHaveBeenCalled();
    });

    it('does NOT restore stock for non-tracked items', async () => {
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        // Only prod-1 is tracked; prod-2 (track_quantity: false) must be skipped.
        expect(mockProduct.increment).toHaveBeenCalledTimes(1);
    });

    it('updates order status to cancelled', async () => {
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({ order_status: 'cancelled' }),
            expect.anything()
        );
    });

    it('calls stock invalidate cache after restoring inventory', async () => {
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        expect(stockGuard.invalidate).toHaveBeenCalled();
    });

    it('throws 404 when order not found', async () => {
        Order.findOne.mockResolvedValue(null);
        await expect(
            orderService.cancelOrder('user-1', 'shop-1', 'nonexistent')
        ).rejects.toMatchObject({ status: 404 });
    });

    it('rejects a repeated cancel request without restoring stock again', async () => {
        Order.findOne.mockResolvedValue(makeOrder({ order_status: 'cancelled' }));
        await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1')).rejects.toMatchObject({ status: 400 });
        expect(mockProduct.increment).not.toHaveBeenCalled();
    });

    it.each([
        ['fulfilled order status', { order_status: 'fulfilled' }],
        ['completed order status', { order_status: 'completed' }],
        ['delivered fulfillment status', { fulfillment_status: 'delivered' }],
        ['fulfilled fulfillment status', { fulfillment_status: 'fulfilled' }],
    ])('does not restore stock for %s', async (_label, overrides) => {
        order = makeOrder(overrides);
        Order.findOne.mockResolvedValue(order);

        await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
            .rejects.toMatchObject({ status: 409 });

        expect(order.update).not.toHaveBeenCalled();
        expect(OrderItem.findAll).not.toHaveBeenCalled();
        expect(Product.findAll).not.toHaveBeenCalled();
        expect(mockProduct.increment).not.toHaveBeenCalled();
    });

    it('does not cancel or restore full stock for a partially fulfilled order', async () => {
        order = makeOrder({
            fulfillment_status: 'partially_fulfilled',
            delivery_status: 'partial_delivered',
        });
        Order.findOne.mockResolvedValue(order);

        await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
            .rejects.toMatchObject({ status: 409, code: 'PARTIAL_FULFILLMENT_INVENTORY_UNKNOWN' });

        expect(order.update).not.toHaveBeenCalled();
        expect(OrderItem.findAll).not.toHaveBeenCalled();
        expect(Product.findAll).not.toHaveBeenCalled();
        expect(mockProduct.increment).not.toHaveBeenCalled();
    });

    it('does not cancel or restore stock when a delivered timestamp exists', async () => {
        order = makeOrder({ delivered_at: new Date() });
        Order.findOne.mockResolvedValue(order);

        await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
            .rejects.toMatchObject({ status: 409, code: 'ORDER_LOCKED_AFTER_COURIER_DISPATCH' });

        expect(order.update).not.toHaveBeenCalled();
        expect(OrderItem.findAll).not.toHaveBeenCalled();
        expect(Product.findAll).not.toHaveBeenCalled();
    });

    it('does not increment stock when order has no items', async () => {
        OrderItem.findAll.mockResolvedValue([]);
        await orderService.cancelOrder('user-1', 'shop-1', 'order-1');
        expect(mockProduct.increment).not.toHaveBeenCalled();
    });
});

describe('Return Approval → Inventory Sync', () => {
    let mockReturn;

    beforeEach(() => {
        jest.clearAllMocks();
        mockReturn = makeReturn();
        OrderReturn.findOne.mockResolvedValue(mockReturn);
        order = makeOrder({ metadata: { returnRequested: true, returnRef: 'RET-001' } });
        Order.findOne.mockResolvedValue(order);
        OrderItem.findAll.mockResolvedValue(mockOrderItems);
        UserShop.findOne.mockResolvedValue({ id: 'us-1', is_active: true });
        // Keyed by id: a blanket mockResolvedValue(mockProduct) hands the
        // TRACKED product back for prod-2 as well, so the "skips untracked
        // items" case can never fail. Keyed off `where.id` because
        // return.service.js:96 also looks up shop-scoped, via findOne.
        Product.findOne.mockImplementation(({ where } = {}) => (
            where?.id === 'prod-1'
                ? Promise.resolve(mockProduct)
                : Promise.resolve({ ...mockProduct, id: where?.id, track_quantity: false })
        ));
    });

    // updateReturnStatus(shopId, orderId, status) — three args, in that order.
    // The suite called it as (returnId, status, userId, shopId), so `status`
    // received 'user-1' and every case died on "Invalid return status" before
    // reaching the inventory logic it was written to cover.
    //
    // A return also lives on order.metadata.returnRequested; there is no
    // OrderReturn row in this path.

    it('restores stock for returned items when status is approved', async () => {
        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');
        expect(mockProduct.increment).toHaveBeenCalledWith(
            'quantity',
            expect.objectContaining({ by: 2 })
        );
    });

    it('does NOT restore stock when status is rejected', async () => {
        await returnService.updateReturnStatus('shop-1', 'order-1', 'rejected');
        expect(mockProduct.increment).not.toHaveBeenCalled();
    });

    it('records the approved return status on the order', async () => {
        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');
        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ returnStatus: 'approved' })
            }),
            expect.anything()
        );
    });

    it('rejects a status outside the allowed set', async () => {
        await expect(
            returnService.updateReturnStatus('shop-1', 'order-1', 'whatever')
        ).rejects.toMatchObject({ status: 400 });
    });

    it('throws 404 when the order is not found', async () => {
        Order.findOne.mockResolvedValue(null);
        await expect(
            returnService.updateReturnStatus('shop-1', 'nonexistent', 'approved')
        ).rejects.toMatchObject({ status: 404 });
    });

    it('throws 404 when the order has no return request', async () => {
        Order.findOne.mockResolvedValue(makeOrder({ metadata: {} }));
        await expect(
            returnService.updateReturnStatus('shop-1', 'order-1', 'approved')
        ).rejects.toMatchObject({ status: 404 });
    });

    it('does not restore stock for items the order does not track', async () => {
        // prod-2 has track_quantity: false and must be skipped.
        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');
        expect(mockProduct.increment).toHaveBeenCalledTimes(1);
    });

    it('records a Partner billing credit instead of rewriting a settled invoice', async () => {
        order = makeOrder({
            order_status: 'delivered',
            delivered_at: new Date('2026-08-12T10:00:00.000Z'),
            metadata: { returnRequested: true, returnRef: 'RET-001' },
        });
        Order.findOne.mockResolvedValue(order);
        Invoice.findOne.mockResolvedValue({
            id: 'invoice-1',
            invoice_type: 'partner_per_order',
            status: 'paid',
            metadata: { delivered_orders: 600, rate_bdt: 15 },
        });
        Subscription.findOne.mockResolvedValue({ billing_model: 'per_order' });
        PartnerBillingAdjustment.create.mockResolvedValue({ id: 'adjustment-1' });

        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');

        expect(PartnerBillingAdjustment.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: 'shop-1',
            order_id: 'order-1',
            amount_bdt: 15,
            reason: 'return_reversal',
        }), expect.objectContaining({ transaction: mockTransaction }));
        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ partnerBillingAdjustmentId: 'adjustment-1' }),
            }),
            expect.anything(),
        );
    });

    it('uses the historical aggregate rate for a legacy progressive Partner invoice', async () => {
        order = makeOrder({
            order_status: 'delivered',
            delivered_at: new Date('2026-08-12T10:00:00.000Z'),
            metadata: { returnRequested: true, returnRef: 'RET-002' },
        });
        Order.findOne.mockResolvedValue(order);
        Invoice.findOne.mockResolvedValue({
            id: 'invoice-legacy',
            invoice_type: 'partner_per_order',
            status: 'paid',
            amount: 8700,
            metadata: { delivered_orders: 600, partnerCharge: 8700 },
        });
        PartnerBillingAdjustment.create.mockResolvedValue({ id: 'adjustment-legacy' });

        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');

        expect(PartnerBillingAdjustment.create).toHaveBeenCalledWith(expect.objectContaining({
            amount_bdt: 14.5,
        }), expect.anything());
    });

    it('cancels a pending Partner invoice when a return reduces it to zero', async () => {
        order = makeOrder({
            order_status: 'delivered',
            delivered_at: new Date('2026-08-12T10:00:00.000Z'),
            metadata: { returnRequested: true, returnRef: 'RET-003' },
        });
        Order.findOne.mockResolvedValue(order);
        const invoice = {
            id: 'invoice-zero',
            invoice_type: 'partner_per_order',
            status: 'pending',
            amount: 15,
            extra_usage_amount: 15,
            metadata: { delivered_orders: 300, rate_bdt: 15 },
            update: jest.fn().mockResolvedValue(undefined),
        };
        Invoice.findOne.mockResolvedValue(invoice);
        PartnerBillingAdjustment.create.mockResolvedValue({
            id: 'adjustment-zero', update: jest.fn().mockResolvedValue(undefined),
        });

        await returnService.updateReturnStatus('shop-1', 'order-1', 'approved');

        expect(invoice.update).toHaveBeenCalledWith(expect.objectContaining({
            amount: 0,
            status: 'cancelled',
            payment_id: null,
        }), expect.anything());
    });
});
