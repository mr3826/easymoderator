'use strict';

jest.mock('../../entities', () => ({
    Customer: { count: jest.fn() },
    CustomerOpportunity: { count: jest.fn() },
    Order: { findAll: jest.fn(), count: jest.fn() },
}));

jest.mock('../opportunity.service', () => ({ LIVE_STATUSES: ['OPEN', 'ACTIONED'] }));

const { Op } = require('sequelize');
const { Customer, CustomerOpportunity, Order } = require('../../entities');
const { getOverview, ORDER_SCAN_CAP, DEFINITIONS } = require('../customer-intelligence-overview.service');

describe('customer intelligence overview read model', () => {
    const shopId = 'shop-a';

    beforeEach(() => {
        jest.clearAllMocks();
        Customer.count.mockResolvedValue(8);
        CustomerOpportunity.count.mockResolvedValue(2);
        Order.findAll.mockResolvedValue([]);
        Order.count.mockResolvedValue(0);
    });

    it('classifies one bounded, exact-customer order projection and returns definitions', async () => {
        Order.findAll.mockResolvedValue([
            { customer_id: 'repeat', order_status: 'delivered', delivery_status: 'delivered', delivered_at: '2026-10-01T00:00:00.000Z' },
            { customer_id: 'repeat', order_status: 'delivered', delivery_status: 'delivered', delivered_at: '2026-11-01T00:00:00.000Z' },
            { customer_id: 'new', order_status: 'delivered', delivery_status: 'delivered', delivered_at: '2026-11-20T00:00:00.000Z' },
            { customer_id: 'old', order_status: 'delivered', delivery_status: 'delivered', delivered_at: '2026-09-01T00:00:00.000Z' },
            { customer_id: 'confirmed', order_status: 'confirmed', delivery_status: null },
            { customer_id: 'cancelled', order_status: 'cancelled', delivery_status: null },
        ]);
        Order.count.mockResolvedValue(6);

        const result = await getOverview(shopId, { now: new Date('2026-11-27T00:00:00.000Z') });

        expect(result).toEqual({
            total_records: 8,
            open_opportunities: 2,
            buyers: 3,
            repeat_buyers: 1,
            new_buyers: 1,
            scanned_orders: 6,
            total_linked_orders: 6,
            order_scan_cap: ORDER_SCAN_CAP,
            coverage_complete: true,
            definitions: DEFINITIONS,
        });
        expect(Customer.count).toHaveBeenCalledWith({ where: { shop_id: shopId } });
        expect(CustomerOpportunity.count).toHaveBeenCalledWith({
            where: { shop_id: shopId, status: { [Op.in]: ['OPEN', 'ACTIONED'] } },
        });

        const [projection] = Order.findAll.mock.calls[0];
        expect(projection.where).toEqual({ shop_id: shopId, customer_id: { [Op.ne]: null } });
        expect(projection.attributes).toEqual(['customer_id', 'order_status', 'delivery_status', 'delivered_at']);
        expect(projection.limit).toBe(ORDER_SCAN_CAP);
        expect(projection.include[0]).toMatchObject({
            as: 'customer',
            attributes: [],
            where: { shop_id: shopId },
            required: true,
        });
        expect(Order.findAll).toHaveBeenCalledTimes(1);
    });

    it('does not report new buyers when a delivered order lacks a reliable delivery timestamp', async () => {
        Order.findAll.mockResolvedValue([
            { customer_id: 'undated', order_status: 'delivered', delivery_status: 'delivered' },
        ]);
        Order.count.mockResolvedValue(1);

        const result = await getOverview(shopId, { now: new Date('2026-11-27T00:00:00.000Z') });

        expect(result).toMatchObject({
            coverage_complete: true,
            buyers: 1,
            new_buyers: null,
        });
    });

    it('marks buyer segments partial when the bounded scan does not cover all linked orders', async () => {
        Order.findAll.mockResolvedValue([
            { customer_id: 'buyer-1', order_status: 'delivered', delivery_status: 'delivered', delivered_at: '2026-11-20T00:00:00.000Z' },
        ]);
        Order.count.mockResolvedValue(9);

        const result = await getOverview(shopId);

        expect(result).toMatchObject({
            scanned_orders: 1,
            total_linked_orders: 9,
            order_scan_cap: ORDER_SCAN_CAP,
            coverage_complete: false,
            buyers: 1,
            new_buyers: null,
        });
    });

    it('propagates aggregate or order-projection failures rather than returning synthetic zeros', async () => {
        Order.findAll.mockRejectedValueOnce(new Error('orders unavailable'));
        await expect(getOverview(shopId)).rejects.toThrow('orders unavailable');

        Customer.count.mockRejectedValueOnce(new Error('customers unavailable'));
        await expect(getOverview(shopId)).rejects.toThrow('customers unavailable');
    });

    it('requires a tenant before any aggregate is queried', async () => {
        await expect(getOverview(null)).rejects.toThrow(/tenant scope/);
        expect(Customer.count).not.toHaveBeenCalled();
        expect(CustomerOpportunity.count).not.toHaveBeenCalled();
        expect(Order.findAll).not.toHaveBeenCalled();
    });
});
