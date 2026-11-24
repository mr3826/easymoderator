'use strict';

/**
 * Phase 1 D4 web audit instrumentation: order confirm/cancel write
 * mobile-matched AuditLog vocabulary (ORDER_CONFIRMED / ORDER_CANCELLED on
 * resource 'order') BEST-EFFORT ({required:false}). The pinned contract:
 * an audit failure NEVER changes the operation outcome or response, and a
 * failed operation writes no audit row.
 */

jest.mock('../../audit/audit.service', () => ({
    logOperation: jest.fn().mockResolvedValue(undefined),
}));

const orderController = require('../order.controller');
const orderService = require('../order.service');
const AuditService = require('../../audit/audit.service');

jest.mock('../order.service', () => ({
    confirmOrder: jest.fn(),
    cancelOrder: jest.fn(),
}));
jest.mock('../return.service', () => ({}));
jest.mock('../../delivery/delivery.service', () => ({}));

const makeReq = ({ params = {}, body = {}, shopId = 'shop-1' } = {}) => ({
    user: { userId: 'user-1', shopId },
    params,
    body,
});

const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
});

describe('web order confirm/cancel audit instrumentation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AuditService.logOperation.mockResolvedValue(undefined);
    });

    it('confirm writes ORDER_CONFIRMED with mobile-matched vocabulary, required:false', async () => {
        const order = { id: 'order-1', order_number: 'ORD-042', order_status: 'confirmed' };
        orderService.confirmOrder.mockResolvedValue(order);
        const req = makeReq({ params: { orderId: 'order-1' } });
        const res = makeRes();
        const next = jest.fn();

        await orderController.confirmOrder(req, res, next);

        expect(AuditService.logOperation).toHaveBeenCalledTimes(1);
        const [{ userId, shopId, action, resourceType, resourceId, metadata }, options] = AuditService.logOperation.mock.calls[0];
        expect({ userId, shopId, action, resourceType, resourceId }).toEqual({
            userId: 'user-1',
            shopId: 'shop-1',
            action: 'ORDER_CONFIRMED',
            resourceType: 'order',
            resourceId: 'order-1',
        });
        expect(metadata).toEqual(expect.objectContaining({ source: 'WEB', order_number: 'ORD-042' }));
        expect(options).toEqual({ required: false });

        // Response contract is byte-identical to the pre-instrumentation one.
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ success: true, data: order });
        expect(next).not.toHaveBeenCalled();
    });

    it('cancel writes ORDER_CANCELLED and keeps the reason in metadata', async () => {
        const order = { id: 'order-2', order_number: 'ORD-043', order_status: 'cancelled', updated_at: '2026-11-24T10:00:00Z' };
        orderService.cancelOrder.mockResolvedValue(order);
        const req = makeReq({ params: { orderId: 'order-2' }, body: { reason: 'customer changed mind' } });
        const res = makeRes();
        const next = jest.fn();

        await orderController.cancelOrder(req, res, next);

        const [{ action, resourceType, resourceId, metadata }] = AuditService.logOperation.mock.calls[0];
        expect({ action, resourceType, resourceId }).toEqual({
            action: 'ORDER_CANCELLED',
            resourceType: 'order',
            resourceId: 'order-2',
        });
        expect(metadata).toEqual(expect.objectContaining({ source: 'WEB', reason: 'customer changed mind' }));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, order_id: 'order-2' }));
    });

    it.each([
        ['rejected', () => AuditService.logOperation.mockRejectedValueOnce(new Error('audit db down'))],
        ['thrown synchronously', () => AuditService.logOperation.mockImplementationOnce(() => { throw new Error('audit module exploded'); })],
        ['returning a non-promise (undefined)', () => AuditService.logOperation.mockReturnValueOnce(undefined)],
    ])('audit %s NEVER changes the operation outcome', (_label, arm) => {
        arm();
        const order = { id: 'order-3', order_number: 'ORD-044', order_status: 'confirmed' };
        orderService.confirmOrder.mockResolvedValue(order);
        const req = makeReq({ params: { orderId: 'order-3' } });
        const res = makeRes();
        const next = jest.fn();

        return orderController.confirmOrder(req, res, next).then(() => {
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ success: true, data: order });
            expect(next).not.toHaveBeenCalled();
        });
    });

    it('a FAILED operation writes no audit row', async () => {
        orderService.confirmOrder.mockRejectedValue(new Error('already cancelled'));
        const req = makeReq({ params: { orderId: 'order-4' } });
        const res = makeRes();
        const next = jest.fn();

        await orderController.confirmOrder(req, res, next);

        expect(AuditService.logOperation).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('no shop scope → 400 and no audit row', async () => {
        const req = makeReq({ params: { orderId: 'order-5' }, shopId: null });
        const res = makeRes();
        const next = jest.fn();

        await orderController.confirmOrder(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(AuditService.logOperation).not.toHaveBeenCalled();
        expect(orderService.confirmOrder).not.toHaveBeenCalled();
    });
});
