'use strict';

/**
 * Booking-time destination resolution (launch audit 2026-11-03).
 *
 * The registry no longer invents a destination from integration pickup
 * metadata, so whatever the provider receives must have been resolved from the
 * ORDER. These tests drive the real courier-destination service against a fake
 * provider instance — only the network edge is faked.
 */

const mockOrder = { findOne: jest.fn(), update: jest.fn() };
const mockCourierDispatch = { findOrCreate: jest.fn(), update: jest.fn(), findOne: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockAuditLog = { create: jest.fn() };

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: {},
    Product: {},
    Customer: {},
    UserShop: mockUserShop,
    AuditLog: mockAuditLog,
    OrderReturn: {},
    CourierDispatch: mockCourierDispatch,
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn(), query: jest.fn(), getDialect: jest.fn() },
}));
jest.mock('../../delivery/delivery.service', () => ({
    resolveAiDefaultProvider: jest.fn(),
    createDeliveryOrder: jest.fn(),
}));
jest.mock('../order-session-standalone.service', () => ({
    persistDeliveryResult: jest.fn(),
}));
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
    checkBookingGate: jest.fn().mockResolvedValue({ allowed: true, mode: 'off' }),
}));

const orderService = require('../order.service');
const deliveryService = require('../../delivery/delivery.service');
const sessionService = require('../order-session-standalone.service');
const destinationService = require('../../delivery/courier-destination.service');
const pilotMetrics = require('../../pilot-features/pilot-metrics');
const { sequelize } = require('../../../utils/database/database-setup');

const AREAS = [
    { id: 1, name: 'Mirpur', district_name: 'Dhaka' },
    { id: 2, name: 'Gulshan', district_name: 'Dhaka' },
];

const makeOrder = (overrides = {}) => ({
    id: 'order-1',
    shop_id: 'shop-1',
    order_number: 'ORD-DEST-0001',
    order_status: 'confirmed',
    fulfillment_status: 'unfulfilled',
    payment_method: 'COD',
    payment_status: 'unpaid',
    customer_name: 'Rahim',
    customer_phone: '01711111111',
    delivery_address: {
        street_address: 'Road 1',
        area: 'Mirpur',
        upazila: 'Mirpur',
        district: 'Dhaka',
    },
    total: '1250.00',
    items: [{ name: 'Red Saree', quantity: 2 }],
    update: jest.fn(async function update(values) { Object.assign(this, values); }),
    ...overrides,
});

const book = (order = makeOrder(), extra = {}) => orderService.bookForOrder(order, {
    shopId: 'shop-1',
    trigger: 'MANUAL',
    mutationAuthority: { kind: 'human', userId: 'user-1' },
    ...extra,
});

describe('booking destination resolution', () => {
    let getAreas;
    let dispatchRecord;

    beforeEach(() => {
        jest.clearAllMocks();
        destinationService.clearCache();
        pilotMetrics.reset();
        delete process.env.COURIER_SERVICEABILITY_ENFORCE;
        delete process.env.COURIER_DESTINATION_RESOLUTION_ENABLED;

        getAreas = jest.fn().mockResolvedValue(AREAS);
        dispatchRecord = { status: 'PENDING', update: jest.fn().mockResolvedValue(undefined) };

        mockOrder.findOne.mockResolvedValue(makeOrder());
        mockUserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'staff' });
        mockAuditLog.create.mockResolvedValue({ id: 'audit-1' });
        mockOrder.update.mockResolvedValue([1]);
        sequelize.transaction.mockImplementation(async (callback) => {
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, rollback: jest.fn(), commit: jest.fn() };
            return callback(transaction);
        });
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'redx',
            pickup: { provider_store_id: 'store-1' },
            instance: { getAreas },
        });
        deliveryService.createDeliveryOrder.mockResolvedValue({
            provider: 'redx',
            consignment_id: 'CN-1',
            tracking_code: 'TRK-1',
            status: 'pending',
        });
        sessionService.persistDeliveryResult.mockResolvedValue(undefined);
        mockCourierDispatch.findOrCreate.mockResolvedValue([dispatchRecord, true]);
    });

    test('sends the order directory match to the provider, not the pickup area', async () => {
        const result = await book();
        const payload = deliveryService.createDeliveryOrder.mock.calls[0][1];

        expect(getAreas).toHaveBeenCalledWith({ district: 'Dhaka' });
        expect(payload).toMatchObject({
            delivery_area: 'Mirpur',
            delivery_area_id: 1,
            pickup_store_id: 'store-1',
        });
        expect(result).toMatchObject({ tracking_code: 'TRK-1' });
    });

    test('a NOT_SERVICEABLE destination leaves the payload unaddressable and is refused in shadow mode', async () => {
        getAreas.mockResolvedValue([{ id: 9, name: 'Atlantis', district_name: 'Dhaka' }]);

        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_PAYLOAD_INVALID',
        });

        // Payload validity is not shadowed: no unaddressable parcel is sent.
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(pilotMetrics.snapshot().counters['courier.serviceability.not_serviceable_shadow']).toBe(1);
        expect(pilotMetrics.snapshot().counters['courier.serviceability.destination_payload_invalid']).toBe(1);
        expect(dispatchRecord.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'FAILED' }),
        );
    });

    test('COURIER_SERVICEABILITY_ENFORCE turns NOT_SERVICEABLE into a 409 without a provider call', async () => {
        process.env.COURIER_SERVICEABILITY_ENFORCE = 'true';
        getAreas.mockResolvedValue([{ id: 9, name: 'Atlantis', district_name: 'Dhaka' }]);

        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_NOT_SERVICEABLE',
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(dispatchRecord.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'FAILED' }),
        );
    });

    test('an order that carries its own area ids still books when the directory is unavailable', async () => {
        // The ids are the order's own; an unreachable directory neither
        // confirms nor contradicts them, so a temporary lookup outage must not
        // become a booking outage.
        getAreas.mockRejectedValue(new Error('timeout'));

        const order = makeOrder({
            delivery_location: { area_id: 77, area_name: 'Mirpur', district: 'Dhaka' },
        });
        // bookForOrder re-reads the order under the claim lock, so the fixture
        // has to be the one the lookup returns.
        mockOrder.findOne.mockResolvedValue(order);

        const result = await book(order);

        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({ delivery_area_id: 77 });
        expect(result).toMatchObject({ tracking_code: 'TRK-1' });
    });

    test('a directory lookup failure cannot produce an addressable payload, so it refuses instead of sending one', async () => {
        getAreas.mockRejectedValue(new Error('timeout'));

        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_PAYLOAD_INVALID',
        });

        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(pilotMetrics.snapshot().counters['courier.serviceability.not_serviceable_shadow']).toBe(0);
        expect(pilotMetrics.snapshot().counters['courier.serviceability.destination_payload_invalid']).toBe(1);
    });

    test('the resolution kill switch skips the directory and the unaddressable payload is refused', async () => {
        process.env.COURIER_DESTINATION_RESOLUTION_ENABLED = 'false';

        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_PAYLOAD_INVALID',
        });

        expect(getAreas).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('a provider without a destination directory is honest, not blocking', async () => {
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'steadfast',
            pickup: { provider_store_id: 'store-1' },
            instance: { getAreas },
        });

        await book();

        expect(getAreas).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).not.toHaveProperty('delivery_area');
    });

    test('a Pathao match carries city, zone and area ids', async () => {
        const pathaoInstance = {
            getCities: jest.fn().mockResolvedValue([{ city_id: 11, city_name: 'Dhaka' }]),
            getZones: jest.fn().mockResolvedValue([{ zone_id: 22, zone_name: 'Mirpur' }]),
            getAreas: jest.fn().mockResolvedValue([{ area_id: 33, area_name: 'Mirpur' }]),
        };
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'pathao',
            pickup: { provider_store_id: 'store-1' },
            instance: pathaoInstance,
        });

        await book(makeOrder({ delivery_address: { area: 'Mirpur', upazila: 'Mirpur', district: 'Dhaka' } }));

        const payload = deliveryService.createDeliveryOrder.mock.calls[0][1];
        expect(payload).toMatchObject({ recipient_city: 11, recipient_zone: 22, recipient_area: 33 });
    });

    test('a Pathao city miss is an unaddressable payload, refused before the provider call', async () => {
        const pathaoInstance = {
            getCities: jest.fn().mockResolvedValue([{ city_id: 11, city_name: 'Dhaka' }]),
            getZones: jest.fn().mockResolvedValue([]),
            getAreas: jest.fn().mockResolvedValue([]),
        };
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'pathao',
            pickup: { provider_store_id: 'store-1' },
            instance: pathaoInstance,
        });

        await expect(book(makeOrder({ delivery_address: { area: 'Atlantis', upazila: 'Mirpur', district: 'Dhaka' } })))
            .rejects.toMatchObject({ status: 409, code: 'COURIER_DESTINATION_PAYLOAD_INVALID' });

        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });
});

describe('courier destination eligibility', () => {
    let getAreas;

    beforeEach(() => {
        jest.clearAllMocks();
        destinationService.clearCache();
        delete process.env.COURIER_DESTINATION_RESOLUTION_ENABLED;
        delete process.env.COURIER_SERVICEABILITY_ENFORCE;
        getAreas = jest.fn().mockResolvedValue(AREAS);
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'redx',
            pickup: { provider_store_id: 'store-1' },
            instance: { getAreas },
        });
    });

    test('every verdict carries the enforcement policy so the UI can tell advisory from blocking', async () => {
        const shadow = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });
        expect(shadow).toMatchObject({ decision: 'SERVICEABLE', enforced: false });

        process.env.COURIER_SERVICEABILITY_ENFORCE = 'true';
        const enforced = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });
        expect(enforced).toMatchObject({ decision: 'SERVICEABLE', enforced: true });
    });

    test('an unavailable answer still reports the enforcement policy', async () => {
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: true,
            reason: 'AI_DEFAULT_NOT_CONFIGURED',
            provider: null,
        });

        const result = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });

        expect(result).toMatchObject({ decision: 'CHECK_UNAVAILABLE', enforced: false });
    });

    test('reports a directory-confirmed destination without booking anything', async () => {
        const result = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });

        expect(result).toMatchObject({
            provider: 'redx',
            decision: 'SERVICEABLE',
            reason_code: 'AREA_MATCHED',
            source: 'order_destination',
            ttl_seconds: 300,
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('an unconfigured courier is CHECK_UNAVAILABLE, not a fake verdict', async () => {
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: true,
            reason: 'AI_DEFAULT_NOT_CONFIGURED',
            provider: null,
        });

        const result = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });

        expect(result).toMatchObject({
            decision: 'CHECK_UNAVAILABLE',
            reason_code: 'AI_DEFAULT_NOT_CONFIGURED',
        });
        expect(getAreas).not.toHaveBeenCalled();
    });

    test('a provider with no directory answers UNCERTAIN', async () => {
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'steadfast',
            pickup: { provider_store_id: 'store-1' },
            instance: {},
        });

        const result = await orderService.getCourierDestinationEligibility(makeOrder(), { shopId: 'shop-1' });

        expect(result).toMatchObject({
            decision: 'UNCERTAIN',
            reason_code: 'PROVIDER_HAS_NO_DIRECTORY',
        });
    });
});