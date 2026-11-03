/**
 * Worklist counters and the delivery_bucket list filter.
 *
 * The counter chips and the filtered list must describe the same set of
 * orders, so these tests assert the wiring, not just the numbers: same
 * predicate module, tenant scope always applied, and search + bucket composing
 * without one silently replacing the other.
 */

const { Op, literal } = require('sequelize');

const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

jest.mock('../../entities', () => ({
    Order: { findOne: jest.fn(), findAll: jest.fn(), findAndCountAll: jest.fn(), create: jest.fn() },
    OrderItem: { findAll: jest.fn(), create: jest.fn() },
    Product: { findAll: jest.fn(), findOne: jest.fn(), decrement: jest.fn(), increment: jest.fn() },
    ProductVariant: { findAll: jest.fn() },
    Customer: { findOne: jest.fn() },
    UserShop: { findOne: jest.fn() },
    OrderReturn: { create: jest.fn() },
    CourierDispatch: { findOne: jest.fn(), findOrCreate: jest.fn(), update: jest.fn() },
    AuditLog: { create: jest.fn() },
    PaymentConfig: { findOne: jest.fn() },
}));

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (cb) => cb({ commit: jest.fn(), rollback: jest.fn() })),
        query: jest.fn(),
        getDialect: jest.fn(() => 'postgres'),
    },
}));

jest.mock('../../subscription/subscription.service', () => ({ checkOrderLimit: jest.fn(), trackUsage: jest.fn() }));
jest.mock('../../rto-shield/rto-shield.service', () => ({ checkPhone: jest.fn() }));
jest.mock('../../rto-shield/rto-network-settings', () => ({ getNetworkSettings: jest.fn().mockResolvedValue({ contribute: true, enforce: true }) }));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: jest.fn(() => mockLogger) }));
jest.mock('../../product/stock-status-guard.service', () => ({ invalidate: jest.fn() }));
jest.mock('../../delivery/delivery.service', () => ({
    getTracking: jest.fn(),
    syncStatus: jest.fn(),
    createConsignment: jest.fn(),
    getActiveProvider: jest.fn(),
    createOrder: jest.fn(),
}));

const { Order, UserShop } = require('../../entities');
const orderService = require('../order.service');
const { BUCKET_KEYS, buildBucketSql } = require('../order-worklist.buckets');

const SHOP_ID = 'shop-1';
const USER_ID = 'user-1';

describe('orders worklist counts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        UserShop.findOne.mockResolvedValue({ id: 'user-shop-1', is_active: true });
    });

    it('returns total plus every bucket, zero-filled when the aggregate returns null', async () => {
        Order.findOne.mockResolvedValue({ total: '12', to_confirm: '3', to_pack: null, booked: '2' });

        const counts = await orderService.getOrderWorklistCounts(USER_ID, SHOP_ID);

        expect(counts.total).toBe(12);
        expect(counts.to_confirm).toBe(3);
        expect(counts.to_pack).toBe(0);
        expect(counts.booked).toBe(2);
        for (const key of BUCKET_KEYS) {
            expect(typeof counts[key]).toBe('number');
        }
    });

    it('counts no orders as zeros rather than NaN', async () => {
        Order.findOne.mockResolvedValue(null);

        const counts = await orderService.getOrderWorklistCounts(USER_ID, SHOP_ID);

        expect(counts.total).toBe(0);
        expect(Object.values(counts).every((value) => value === 0)).toBe(true);
    });

    it('is tenant-scoped by the authenticated shop', async () => {
        Order.findOne.mockResolvedValue({ total: 0 });

        await orderService.getOrderWorklistCounts(USER_ID, SHOP_ID);

        expect(Order.findOne).toHaveBeenCalledTimes(1);
        const options = Order.findOne.mock.calls[0][0];
        expect(options.where).toEqual({ shop_id: SHOP_ID });
        expect(options.raw).toBe(true);
    });

    it('uses the same bucket SQL as the list filter module', async () => {
        Order.findOne.mockResolvedValue({ total: 0 });

        await orderService.getOrderWorklistCounts(USER_ID, SHOP_ID);

        const options = Order.findOne.mock.calls[0][0];
        const sql = options.attributes
            .filter(([, alias]) => alias !== 'total')
            .map(([expression]) => expression.val)
            .join(' ');
        for (const key of BUCKET_KEYS) {
            expect(sql).toContain(buildBucketSql(key));
        }
    });

    it('refuses a caller without access to the shop', async () => {
        UserShop.findOne.mockResolvedValue(null);

        await expect(orderService.getOrderWorklistCounts(USER_ID, SHOP_ID)).rejects.toMatchObject({ status: 403 });
        expect(Order.findOne).not.toHaveBeenCalled();
    });
});

describe('listOrders delivery_bucket filter', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        UserShop.findOne.mockResolvedValue({ id: 'user-shop-1', is_active: true });
        Order.findAll.mockResolvedValue([]);
    });

    const whereOf = () => Order.findAll.mock.calls[0][0].where;

    it('ANDs the bucket predicate with the tenant scope', async () => {
        await orderService.listOrders(USER_ID, SHOP_ID, { delivery_bucket: 'booked' });

        const where = whereOf();
        expect(where.shop_id).toBe(SHOP_ID);
        expect(where[Op.and]).toEqual([{ delivery_status: { [Op.in]: ['booked'] } }]);
    });

    it('keeps search and bucket together instead of one overwriting the other', async () => {
        // Both want their own predicate; a naive merge would lose the search
        // OR and quietly return the whole bucket.
        await orderService.listOrders(USER_ID, SHOP_ID, { delivery_bucket: 'booked', search: 'ORD-1' });

        const where = whereOf();
        expect(where[Op.or]).toBeDefined();
        expect(where[Op.and]).toEqual([{ delivery_status: { [Op.in]: ['booked'] } }]);
    });

    it('leaves the query untouched when no bucket is requested', async () => {
        await orderService.listOrders(USER_ID, SHOP_ID, {});

        expect(whereOf()[Op.and]).toBeUndefined();
    });
});