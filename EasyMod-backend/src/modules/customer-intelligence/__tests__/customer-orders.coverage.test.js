'use strict';

jest.mock('../../entities', () => ({
    Order: { findAll: jest.fn() },
}));

const { Order } = require('../../entities');
const { loadOrdersForCustomersWithCoverage } = require('../customer-orders');

describe('customer order summary coverage', () => {
    beforeEach(() => jest.clearAllMocks());

    it('marks capped per-customer summaries partial using an exact grouped total', async () => {
        Order.findAll
            .mockResolvedValueOnce([
                { id: 'order-1', customer_id: 'customer-1', customer_phone: '01700000000', order_status: 'delivered' },
            ])
            .mockResolvedValueOnce([
                { customer_id: 'customer-1', customer_phone: '01700000000', order_count: '600' },
            ]);

        const summaries = await loadOrdersForCustomersWithCoverage('shop-1', [
            { id: 'customer-1', phone: '01700000000' },
        ], { limit: 1 });

        expect(summaries.get('customer-1')).toMatchObject({
            orders: [{ id: 'order-1', link: 'CUSTOMER' }],
            order_coverage: { scanned: 1, total: 600, cap: 1, complete: false },
        });
        expect(Order.findAll).toHaveBeenCalledTimes(2);
        expect(Order.findAll.mock.calls[1][0]).toMatchObject({
            group: ['customer_id', 'customer_phone'],
            raw: true,
        });
    });

    it('marks complete history when all direct and phone-linked orders were scanned', async () => {
        Order.findAll
            .mockResolvedValueOnce([
                { id: 'order-1', customer_id: 'customer-1', customer_phone: null, order_status: 'delivered' },
                { id: 'order-2', customer_id: null, customer_phone: '01700000000', order_status: 'delivered' },
            ])
            .mockResolvedValueOnce([
                { customer_id: 'customer-1', customer_phone: null, order_count: '1' },
                { customer_id: null, customer_phone: '01700000000', order_count: '1' },
            ]);

        const summaries = await loadOrdersForCustomersWithCoverage('shop-1', [
            { id: 'customer-1', phone: '01700000000' },
        ], { limit: 10 });

        expect(summaries.get('customer-1').order_coverage).toEqual({
            scanned: 2,
            total: 2,
            cap: 10,
            complete: true,
        });
    });
});
