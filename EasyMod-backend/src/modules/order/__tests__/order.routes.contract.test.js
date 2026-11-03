const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: 'user-1', shopId: 'shop-1' };
        next();
    }
}));

jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: (_req, _res, next) => next(),
}));

jest.mock('../../helpers', () => ({
    validate: () => (_req, _res, next) => next()
}));

jest.mock('../order.controller', () => {
    const handler = (name) => jest.fn((req, res) => {
        res.status(200).json({ success: true, handler: name, params: req.params });
    });

    return {
        listOrders: handler('listOrders'),
        getOrder: handler('getOrder'),
        createOrder: handler('createOrder'),
        updateOrder: handler('updateOrder'),
        deleteOrder: handler('deleteOrder'),
        createDraftOrder: handler('createDraftOrder'),
        confirmOrder: handler('confirmOrder'),
        bulkCreateOrders: handler('bulkCreateOrders'),
        getReturnRequests: handler('getReturnRequests'),
        getOrders: handler('getOrders'),
        getOrdersByCustomer: handler('getOrdersByCustomer'),
        getOrderById: handler('getOrderById'),
        createOrderRest: handler('createOrderRest'),
        updateOrderById: handler('updateOrderById'),
        cancelOrder: handler('cancelOrder'),
        createReturnRequest: handler('createReturnRequest'),
        getCourierEligibility: handler('getCourierEligibility'),
        bookCourier: handler('bookCourier'),
        initiateReturn: handler('initiateReturn'),
        updateReturnStatus: handler('updateReturnStatus'),
        deleteOrderById: handler('deleteOrderById')
    };
});

const orderController = require('../order.controller');
const orderRoutes = require('../order.routes');

const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/order', orderRoutes);
    return app;
};

describe('order route contracts', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = buildApp();
    });

    it('keeps the legacy POST /api/order/confirm endpoint', async () => {
        await request(app)
            .post('/api/order/confirm')
            .send({ orderId: 'order-1' })
            .expect(200);

        expect(orderController.confirmOrder).toHaveBeenCalledTimes(1);
    });

    it('routes frontend RESTful order confirmation to the confirm handler', async () => {
        await request(app)
            .post('/api/order/order-1/confirm')
            .send()
            .expect(200);

        expect(orderController.confirmOrder).toHaveBeenCalledTimes(1);
        expect(orderController.confirmOrder.mock.calls[0][0].params).toEqual({ orderId: 'order-1' });
    });

    it('routes the frontend cancel alias to the cancel handler', async () => {
        await request(app)
            .post('/api/order/order-1/cancel')
            .send({ reason: 'customer_request' })
            .expect(200);

        expect(orderController.cancelOrder).toHaveBeenCalledTimes(1);
        expect(orderController.cancelOrder.mock.calls[0][0].params).toEqual({ orderId: 'order-1' });
    });

    it('routes the frontend courier alias to the courier handler', async () => {
        await request(app)
            .post('/api/order/order-1/courier')
            .send({ provider: 'pathao' })
            .expect(200);

        expect(orderController.bookCourier).toHaveBeenCalledTimes(1);
        expect(orderController.bookCourier.mock.calls[0][0].params).toEqual({ orderId: 'order-1' });
    });

    it('routes the courier eligibility pre-check to its own handler', async () => {
        await request(app)
            .get('/api/order/order-1/courier/eligibility?provider=redx')
            .expect(200);

        expect(orderController.getCourierEligibility).toHaveBeenCalledTimes(1);
        expect(orderController.getCourierEligibility.mock.calls[0][0].params).toEqual({ orderId: 'order-1' });
        // The pre-check must never be answered by the booking handler.
        expect(orderController.bookCourier).not.toHaveBeenCalled();
    });
});
