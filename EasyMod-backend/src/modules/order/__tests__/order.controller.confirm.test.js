const orderController = require('../order.controller');
const orderService = require('../order.service');

jest.mock('../order.service', () => ({
    confirmOrder: jest.fn(),
    cancelOrder: jest.fn()
}));

jest.mock('../return.service', () => ({}));
jest.mock('../../delivery/delivery.service', () => ({}));
// Phase 1 D4 instrumentation: keep this suite hermetic (no real audit entity).
// The instrumentation's own contract lives in order.controller.web-audit.test.js.
jest.mock('../../audit/audit.service', () => ({
    logOperation: jest.fn().mockResolvedValue(undefined),
}));

const makeReq = ({ params = {}, body = {}, shopId = 'shop-1' } = {}) => ({
    user: {
        userId: 'user-1',
        shopId
    },
    params,
    body
});

const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
});

describe('orderController.confirmOrder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('confirms an order from the RESTful orderId route param', async () => {
        const req = makeReq({ params: { orderId: 'order-1' } });
        const res = makeRes();
        const next = jest.fn();
        const order = { id: 'order-1', order_status: 'confirmed' };

        orderService.confirmOrder.mockResolvedValue(order);

        await orderController.confirmOrder(req, res, next);

        expect(orderService.confirmOrder).toHaveBeenCalledWith('order-1', 'user-1', 'shop-1');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ success: true, data: order });
        expect(next).not.toHaveBeenCalled();
    });

    it('preserves the legacy body orderId confirm contract', async () => {
        const req = makeReq({ body: { orderId: 'order-2' } });
        const res = makeRes();
        const next = jest.fn();
        const order = { id: 'order-2', order_status: 'confirmed' };

        orderService.confirmOrder.mockResolvedValue(order);

        await orderController.confirmOrder(req, res, next);

        expect(orderService.confirmOrder).toHaveBeenCalledWith('order-2', 'user-1', 'shop-1');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ success: true, data: order });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects confirm requests without an order id', async () => {
        const req = makeReq();
        const res = makeRes();
        const next = jest.fn();

        await orderController.confirmOrder(req, res, next);

        expect(orderService.confirmOrder).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Order ID is required',
            status: 400
        }));
    });
});

describe('orderController.cancelOrder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns the standard API envelope while preserving legacy cancel fields', async () => {
        const req = makeReq({
            params: { orderId: 'order-3' },
            body: { reason: 'customer_request' }
        });
        const res = makeRes();
        const next = jest.fn();
        const order = {
            id: 'order-3',
            order_status: 'cancelled',
            updated_at: '2026-07-04T00:00:00.000Z'
        };

        orderService.cancelOrder.mockResolvedValue(order);

        await orderController.cancelOrder(req, res, next);

        expect(orderService.cancelOrder).toHaveBeenCalledWith(
            'user-1',
            'shop-1',
            'order-3',
            'customer_request',
            undefined
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            data: order,
            order_id: 'order-3',
            status: 'cancelled',
            refund_status: 'pending',
            updated_at: '2026-07-04T00:00:00.000Z'
        });
        expect(next).not.toHaveBeenCalled();
    });
});
