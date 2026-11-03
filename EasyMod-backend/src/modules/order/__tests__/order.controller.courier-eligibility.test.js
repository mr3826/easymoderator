jest.mock('../order.service', () => ({ getCourierDestinationEligibility: jest.fn() }));

jest.mock('../../entities', () => ({
    Order: { findOne: jest.fn() },
}));

const orderController = require('../order.controller');
const orderService = require('../order.service');
const { Order } = require('../../entities');

describe('orderController.getCourierEligibility', () => {
    let req;
    let res;
    let next;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            params: { orderId: 'order-1' },
            query: {},
            headers: { 'x-shop-id': 'spoofed-shop' },
            user: { userId: 'user-1', shopId: 'authenticated-shop' },
        };
        res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        next = jest.fn();
        Order.findOne.mockResolvedValue({ id: 'order-1', shop_id: 'authenticated-shop' });
        orderService.getCourierDestinationEligibility.mockResolvedValue({
            provider: 'redx',
            decision: 'SERVICEABLE',
            reason_code: 'AREA_MATCHED',
            source: 'order_destination',
            checked_at: '2026-11-03T00:00:00.000Z',
            ttl_seconds: 300,
        });
    });

    it('scopes the lookup to the authenticated shop, ignoring client-supplied shop headers', async () => {
        await orderController.getCourierEligibility(req, res, next);

        expect(Order.findOne).toHaveBeenCalledWith({
            where: { id: 'order-1', shop_id: 'authenticated-shop' },
        });
        expect(orderService.getCourierDestinationEligibility).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'order-1' }),
            { shopId: 'authenticated-shop', provider: null },
        );
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            data: expect.objectContaining({ decision: 'SERVICEABLE', ttl_seconds: 300 }),
        });
        expect(next).not.toHaveBeenCalled();
    });

    it('passes an explicitly requested provider through', async () => {
        req.query.provider = 'pathao';

        await orderController.getCourierEligibility(req, res, next);

        expect(orderService.getCourierDestinationEligibility).toHaveBeenCalledWith(
            expect.anything(),
            { shopId: 'authenticated-shop', provider: 'pathao' },
        );
    });

    it('returns 404 for an order outside the shop instead of leaking its existence', async () => {
        Order.findOne.mockResolvedValue(null);

        await orderController.getCourierEligibility(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(orderService.getCourierDestinationEligibility).not.toHaveBeenCalled();
    });

    it('rejects a request with no shop context', async () => {
        req.user = { userId: 'user-1' };

        await orderController.getCourierEligibility(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(Order.findOne).not.toHaveBeenCalled();
    });
});