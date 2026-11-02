'use strict';

const mockOrder = { findOne: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockDeliveryTracking = { findOne: jest.fn() };
const mockCourierDispatch = { findOne: jest.fn() };
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockDatabase = {
    transaction: jest.fn(async (callback) => callback(mockTransaction)),
};
const mockConfirmCodPayment = jest.fn((req, res) => res.status(204).end());

jest.mock('../../entities', () => ({
    Order: mockOrder,
    UserShop: mockUserShop,
    DeliveryTracking: mockDeliveryTracking,
    CourierDispatch: mockCourierDispatch,
    PaymentConfig: {},
}));
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockDatabase }));
jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: 'user-1', shopId: 'shop-1' };
        req.userRole = req.headers['x-test-role'] || 'staff';
        next();
    },
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: (_req, _res, next) => next(),
}));
jest.mock('../../../middleware/validate.middleware', () => () => (_req, _res, next) => next());
jest.mock('../payment.controller', () => ({
    getPaymentConfigs: jest.fn(),
    savePaymentConfig: jest.fn(),
    testPaymentConnection: jest.fn(),
    deletePaymentConfig: jest.fn(),
    confirmCodPayment: mockConfirmCodPayment,
}));

const { confirmCodPayment } = require('../payment.service');
const express = require('express');
const request = require('supertest');
const paymentRoutes = require('../payment.routes');

function makeOrder(overrides = {}) {
    return {
        id: 'order-1',
        shop_id: 'shop-1',
        order_status: 'delivered',
        delivery_status: 'delivered',
        payment_status: 'pending',
        payment_method: 'cod',
        update: jest.fn(async function update(values, options) {
            Object.assign(this, values);
            this.lastUpdateOptions = options;
            return this;
        }),
        ...overrides,
    };
}

describe('manual COD settlement guards', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUserShop.findOne.mockResolvedValue({ role: 'owner' });
        mockDeliveryTracking.findOne.mockResolvedValue(null);
        mockCourierDispatch.findOne.mockResolvedValue(null);
    });

    test.each(['owner', 'admin'])('allows %s to confirm COD only after full delivery', async (role) => {
        const order = makeOrder({ order_status: 'processing', delivery_status: null });
        mockUserShop.findOne.mockResolvedValue({ role });
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue({ current_status: 'delivered' });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1')).resolves.toBe(order);

        expect(mockOrder.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'order-1', shop_id: 'shop-1' },
            lock: 'UPDATE',
        }));
        expect(order.update).toHaveBeenCalledWith({ payment_status: 'paid', paid_at: expect.any(Date) }, { transaction: mockTransaction });
        expect(order.order_status).toBe('processing');
    });

    test('allows an owner to settle an unpaid COD order after full delivery', async () => {
        const order = makeOrder({ payment_status: 'unpaid', delivery_status: 'delivered' });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1')).resolves.toBe(order);

        expect(order.update).toHaveBeenCalledWith(
            { payment_status: 'paid', paid_at: expect.any(Date) },
            { transaction: mockTransaction },
        );
    });

    test.each(['staff', 'viewer'])('rejects %s before reading or mutating the order', async (role) => {
        mockUserShop.findOne.mockResolvedValue({ role });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 403, code: 'COD_SETTLEMENT_FORBIDDEN' });
        expect(mockOrder.findOne).not.toHaveBeenCalled();
    });

    test('requires payment_method=cod', async () => {
        const order = makeOrder({ payment_method: 'bkash' });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_PAYMENT_METHOD_REQUIRED' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test.each(['not_delivered', 'in_transit'])('requires delivered outcome when current status is %s', async (status) => {
        const order = makeOrder({ order_status: 'confirmed', delivery_status: status });
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue({ current_status: status });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_DELIVERY' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test.each(['paid', 'partially_paid', 'failed'])('rejects COD settlement from payment status %s', async (status) => {
        const order = makeOrder({ payment_status: status });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_PAYMENT_NOT_PENDING' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test.each([
        ['order delivery status', makeOrder({ delivery_status: 'partial_delivered' }), null],
        ['tracking status', makeOrder({ delivery_status: null }), { current_status: 'partial_delivered' }],
    ])('does not settle partial delivery from %s without an authoritative amount', async (_source, order, tracking) => {
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_DELIVERY' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test('rejects conflicting delivery status sources even when one says delivered', async () => {
        const order = makeOrder({ delivery_status: 'delivered' });
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue({ current_status: 'in_transit' });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_DELIVERY' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test('does not treat order_status=delivered alone as authoritative delivery evidence', async () => {
        const order = makeOrder({ order_status: 'delivered', delivery_status: null });
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue(null);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_DELIVERY' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test('blocks settlement while payment reconciliation is required', async () => {
        const order = makeOrder({ metadata: { payment_reconciliation: { required: true } } });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_RECONCILIATION' });
        expect(mockCourierDispatch.findOne).not.toHaveBeenCalled();
        expect(order.update).not.toHaveBeenCalled();
    });

    test.each(['PENDING', 'INDETERMINATE'])('blocks settlement during %s courier dispatch', async (status) => {
        const order = makeOrder();
        mockOrder.findOne.mockResolvedValue(order);
        mockCourierDispatch.findOne.mockResolvedValue({ status });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_RECONCILIATION' });
        expect(order.update).not.toHaveBeenCalled();
    });

    test('does not settle COD when a return or cancellation conflicts with delivered state', async () => {
        const order = makeOrder({ order_status: 'delivered', delivery_status: 'delivered' });
        mockOrder.findOne.mockResolvedValue(order);
        mockDeliveryTracking.findOne.mockResolvedValue({ current_status: 'partial_returned' });

        await expect(confirmCodPayment('order-1', 'user-1', 'shop-1'))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_REQUIRES_DELIVERY' });
        expect(order.update).not.toHaveBeenCalled();
    });
});

describe('COD confirmation route authorization', () => {
    const app = express();
    app.use('/payment', paymentRoutes);

    beforeEach(() => {
        mockConfirmCodPayment.mockClear();
    });

    test.each(['staff', 'viewer'])('rejects %s before invoking the COD confirmation controller', async (role) => {
        const response = await request(app)
            .post('/payment/cod/confirm')
            .set('x-test-role', role)
            .send({ orderId: 'order-1' });

        expect(response.status).toBe(403);
        expect(mockConfirmCodPayment).not.toHaveBeenCalled();
    });

    test.each(['owner', 'admin'])('allows %s through the COD confirmation route', async (role) => {
        const response = await request(app)
            .post('/payment/cod/confirm')
            .set('x-test-role', role)
            .send({ orderId: 'order-1' });

        expect(response.status).toBe(204);
        expect(mockConfirmCodPayment).toHaveBeenCalledTimes(1);
    });
});
