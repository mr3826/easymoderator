'use strict';

/**
 * bookForOrder × billing standing (ADR-0011 C5).
 *
 * An overdue merchant may not start a NEW courier booking. The gate runs after
 * the already-booked/committed early returns, so a parcel that is really booked
 * still reconciles — nothing is deleted, history stays readable.
 */

const mockOrder = { findOne: jest.fn(), update: jest.fn().mockResolvedValue([1]) };
const mockCourierDispatch = { findOrCreate: jest.fn(), update: jest.fn(), findOne: jest.fn() };
const mockInvoice = { count: jest.fn() };

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: {},
    Product: {},
    Customer: {},
    UserShop: {},
    OrderReturn: {},
    CourierDispatch: mockCourierDispatch,
    Invoice: mockInvoice,
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn(), query: jest.fn(), getDialect: jest.fn() },
}));
jest.mock('../../delivery/delivery.service', () => ({
    resolveAiDefaultProvider: jest.fn(),
    createDeliveryOrder: jest.fn(),
}));
jest.mock('../order-session-standalone.service', () => ({ persistDeliveryResult: jest.fn() }));
jest.mock('../../notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));
jest.mock('../../notification/notification-events', () => ({
    NOTIFICATION_EVENTS: {
        COURIER_SETUP_REQUIRED: 'courier_setup_required',
        COURIER_BOOKING_FAILED: 'courier_booking_failed',
    },
}));
jest.mock('../../order-confidence/order-confidence.service', () => ({
    checkBookingGate: jest.fn(),
}));

const orderService = require('../order.service');
const deliveryService = require('../../delivery/delivery.service');
const orderConfidence = require('../../order-confidence/order-confidence.service');
const { sequelize } = require('../../../utils/database/database-setup');

const makeOrder = (overrides = {}) => ({
    id: 'order-1',
    shop_id: 'shop-1',
    order_number: 'ORD-1',
    order_status: 'confirmed',
    customer_name: 'Rahim',
    customer_phone: '01711111111',
    delivery_address: 'House 12, Road 5, Dhanmondi, Dhaka',
    delivery_location: {
        provider_destination: {
            pathao: {
                area_id: 11, area_name: 'Dhanmondi', zone_id: 22, zone_name: 'Dhanmondi',
                city_id: 33, city_name: 'Dhaka', district: 'Dhaka',
                source: 'merchant_confirmed', confirmed_at: '2026-11-04T00:00:00.000Z',
                confirmed_by: 'user-1',
            },
        },
    },
    total: '1250.00',
    payment_method: 'COD',
    payment_status: 'unpaid',
    items: [{ name: 'Red Saree', quantity: 1 }],
    update: jest.fn(async function update(values) { Object.assign(this, values); }),
    ...overrides,
});

const OPTIONS = { shopId: 'shop-1', mutationAuthority: { kind: 'test' } };

beforeEach(() => {
    jest.clearAllMocks();
    sequelize.transaction.mockImplementation(async (callback) => {
        const transaction = { LOCK: { UPDATE: 'UPDATE' }, rollback: jest.fn(), commit: jest.fn() };
        try {
            return typeof callback === 'function' ? await callback(transaction) : transaction;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    });
    mockOrder.findOne.mockResolvedValue(makeOrder());
    deliveryService.resolveAiDefaultProvider.mockResolvedValue({ blocked: false, provider: 'pathao', pickup: null });
    deliveryService.createDeliveryOrder.mockResolvedValue({
        provider: 'pathao', consignment_id: 'CN-1', tracking_code: 'TRK-1', status: 'pending',
    });
    mockCourierDispatch.findOne.mockResolvedValue(null);
    mockCourierDispatch.findOrCreate.mockResolvedValue([{ id: 'd-1', status: 'PENDING' }, true]);
    mockCourierDispatch.update.mockResolvedValue([1]);
    orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
    mockInvoice.count.mockResolvedValue(0);
});

describe('bookForOrder × billing standing', () => {
    it('refuses a new booking with 402 when a recurring invoice is past due', async () => {
        mockInvoice.count.mockResolvedValue(1);

        await expect(orderService.bookForOrder(makeOrder(), OPTIONS)).rejects.toMatchObject({
            status: 402,
            code: 'BILLING_OVERDUE_BOOKING_BLOCKED',
        });

        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    it('checks billing inside the claim, before the dispatch row exists', async () => {
        mockInvoice.count.mockResolvedValue(0);

        await orderService.bookForOrder(makeOrder(), OPTIONS);

        expect(mockInvoice.count).toHaveBeenCalledTimes(1);
        expect(mockInvoice.count.mock.calls[0][0].where.shop_id).toBe('shop-1');
        expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledTimes(1);
        expect(mockInvoice.count.mock.invocationCallOrder[0])
            .toBeLessThan(mockCourierDispatch.findOrCreate.mock.invocationCallOrder[0]);
    });

    it('always reconciles an already-booked parcel, even with an overdue bill', async () => {
        // Already carries a courier reference: the outer early return fires
        // before any billing check, so a committed parcel is never stranded.
        const booked = makeOrder({
            delivery_provider: 'pathao',
            delivery_consignment_id: 'CN-OLD',
            delivery_tracking_code: 'TRK-OLD',
        });

        const result = await orderService.bookForOrder(booked, OPTIONS);

        expect(result).toEqual(expect.objectContaining({
            provider: 'pathao',
            consignment_id: 'CN-OLD',
            tracking_code: 'TRK-OLD',
        }));
        expect(mockInvoice.count).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
    });
});