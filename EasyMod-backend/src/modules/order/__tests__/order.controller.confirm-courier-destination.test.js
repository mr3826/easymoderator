jest.mock('../order.service', () => ({ confirmCourierDestination: jest.fn() }));

const orderController = require('../order.controller');
const orderService = require('../order.service');

describe('orderController.confirmCourierDestination', () => {
    let req;
    let res;
    let next;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            params: { orderId: 'order-1' },
            body: { provider: 'redx', area_id: 1, area_name: 'Mirpur' },
            headers: { 'x-shop-id': 'spoofed-shop' },
            user: { userId: 'user-1', shopId: 'authenticated-shop' },
        };
        res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        next = jest.fn();
        orderService.confirmCourierDestination.mockResolvedValue({
            order: { id: 'order-1' },
            destination: { provider: 'redx', decision: 'SERVICEABLE', enforced: false },
        });
    });

    it('scopes the confirmation to the authenticated shop, never a client-supplied one', async () => {
        await orderController.confirmCourierDestination(req, res, next);

        expect(orderService.confirmCourierDestination).toHaveBeenCalledWith(
            'order-1',
            'user-1',
            'authenticated-shop',
            { provider: 'redx', area_id: 1, area_name: 'Mirpur' },
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            data: expect.objectContaining({
                destination: expect.objectContaining({ decision: 'SERVICEABLE' }),
            }),
        });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects a request with no shop context before touching the order', async () => {
        req.user = { userId: 'user-1' };

        await orderController.confirmCourierDestination(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(orderService.confirmCourierDestination).not.toHaveBeenCalled();
    });

    it('hands service errors to the error middleware with their status and code intact', async () => {
        const error = Object.assign(new Error('not in directory'), {
            status: 409,
            code: 'COURIER_DESTINATION_INVALID_SELECTION',
        });
        orderService.confirmCourierDestination.mockRejectedValue(error);

        await orderController.confirmCourierDestination(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
        expect(res.json).not.toHaveBeenCalled();
    });
});