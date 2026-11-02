jest.mock('../order.service', () => ({ bookForOrder: jest.fn() }));

jest.mock('../../entities', () => ({
    Order: { findOne: jest.fn() },
}));

const orderController = require('../order.controller');
const orderService = require('../order.service');
const { Order } = require('../../entities');

describe('orderController.bookCourier', () => {
    let req;
    let res;
    let next;
    let order;

    beforeEach(() => {
        jest.clearAllMocks();
        order = {
            id: 'order-1',
            customer_name: 'Launch Buyer',
            customer_phone: '01700000000',
            delivery_address: {
                street_address: 'Road 1',
                upazila: 'Dhanmondi',
                district: 'Dhaka'
            },
            total: 1200,
            update: jest.fn().mockResolvedValue(undefined)
        };
        req = {
            params: { orderId: 'order-1' },
            headers: { 'x-shop-id': 'spoofed-shop' },
            user: { userId: 'user-1', shopId: 'authenticated-shop' },
            body: { provider: 'pathao' }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        next = jest.fn();
        Order.findOne.mockResolvedValue(order);
        orderService.bookForOrder.mockResolvedValue({
            provider: 'pathao',
            consignment_id: 'CN-1',
            tracking_code: 'TRK-1'
        });
    });

    it('uses authenticated shop context instead of client-controlled x-shop-id', async () => {
        await orderController.bookCourier(req, res, next);

        expect(Order.findOne).toHaveBeenCalledWith({
            where: { id: 'order-1', shop_id: 'authenticated-shop' }
        });
        expect(orderService.bookForOrder).toHaveBeenCalledWith(order, expect.objectContaining({
            shopId: 'authenticated-shop',
            provider: 'pathao',
            trigger: 'MANUAL',
            mutationAuthority: { kind: 'human', userId: 'user-1' },
        }));
        expect(next).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true
        }));
    });

    it('returns the provider resolved by booking instead of the caller-selected provider', async () => {
        req.body.provider = 'steadfast';
        orderService.bookForOrder.mockResolvedValue({
            provider: 'pathao',
            consignment_id: 'CN-1',
            tracking_code: 'TRK-1',
        });

        await orderController.bookCourier(req, res, next);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ provider: 'pathao' }),
        }));
    });

    it('maps a blocked committed-dispatch replay with no tracking identity to a 409 failure', async () => {
        orderService.bookForOrder.mockResolvedValue({
            blocked: true,
            status: 'tracking_unavailable',
            code: 'COURIER_TRACKING_UNAVAILABLE',
            provider: 'pathao',
        });

        await orderController.bookCourier(req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: expect.objectContaining({
                code: 'COURIER_TRACKING_UNAVAILABLE',
                message: expect.stringContaining('Do not book again'),
                provider: 'pathao',
            }),
        }));
        expect(next).not.toHaveBeenCalled();
    });

    it('maps a blocked committed-dispatch replay with no persisted provider to 409 without echoing a provider', async () => {
        orderService.bookForOrder.mockResolvedValue({
            blocked: true,
            status: 'tracking_unavailable',
            code: 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE',
            provider: null,
        });

        await orderController.bookCourier(req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: expect.objectContaining({
                code: 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE',
                provider: null,
            }),
        }));
        expect(next).not.toHaveBeenCalled();
    });

    it('does not report success when the booking result has no tracking identity', async () => {
        orderService.bookForOrder.mockResolvedValue({
            provider: 'pathao',
            consignment_id: '  ',
            tracking_code: null,
        });

        await orderController.bookCourier(req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: expect.objectContaining({
                code: 'COURIER_TRACKING_UNAVAILABLE',
                message: expect.stringContaining('Do not book again'),
            }),
        }));
        expect(next).not.toHaveBeenCalled();
    });
});
