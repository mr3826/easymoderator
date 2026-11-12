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
const mockDeliveryTracking = { findOne: jest.fn() };

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: {},
    Product: {},
    Customer: {},
    UserShop: mockUserShop,
    AuditLog: mockAuditLog,
    OrderReturn: {},
    CourierDispatch: mockCourierDispatch,
    DeliveryTracking: mockDeliveryTracking,
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn(), query: jest.fn(), getDialect: jest.fn() },
}));
jest.mock('../../delivery/delivery.service', () => ({
    resolveAiDefaultProvider: jest.fn(),
    createDeliveryOrder: jest.fn(),
    getProviderInstance: jest.fn(),
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
jest.mock('../../delivery/courier-readiness.service', () => ({
    evaluateReadiness: jest.fn().mockResolvedValue({ ready: true, status: 'ACTIVE' }),
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
        deliveryService.getProviderInstance.mockResolvedValue({ getAreas });
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

    test('a NOT_SERVICEABLE destination is refused in shadow mode with the contradiction as its reason', async () => {
        getAreas.mockResolvedValue([{ id: 9, name: 'Atlantis', district_name: 'Dhaka' }]);

        // Review R-1: the area WAS recorded and the directory contradicted it.
        // Saying "no delivery area recorded" would send the merchant looking
        // for a field they already filled in.
        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_CONTRADICTED',
        });

        // Payload validity is not shadowed: no unaddressable parcel is sent.
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(pilotMetrics.snapshot().counters['courier.serviceability.not_serviceable_shadow']).toBe(1);
        expect(pilotMetrics.snapshot().counters['courier.serviceability.not_serviceable_contradicted']).toBe(1);
        expect(pilotMetrics.snapshot().counters['courier.serviceability.destination_payload_invalid']).toBe(0);
        expect(dispatchRecord.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'FAILED' }),
        );
    });

    test('a contradicted destination reaches throwOnError:false callers as the specific 409', async () => {
        // The payment webhook and auto-dispatch-on-confirm pass throwOnError:false.
        // The "directory says no" signal must arrive as COURIER_DESTINATION_CONTRADICTED,
        // not a generic {failed:true} with no code (QA-1 / Ops review).
        getAreas.mockResolvedValue([{ id: 9, name: 'Atlantis', district_name: 'Dhaka' }]);

        await expect(book(makeOrder(), { throwOnError: false })).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_CONTRADICTED',
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('an ambiguous directory match never guesses an id at booking time', async () => {
        getAreas.mockResolvedValue([
            { id: 1, name: 'Mirpur', district_name: 'Dhaka' },
            { id: 2, name: 'Mirpur', district_name: 'Dhaka' },
        ]);

        await expect(book()).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_PAYLOAD_INVALID',
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('shadow mode may use a previously server-confirmed id despite a later directory miss', async () => {
        getAreas.mockResolvedValue([{ area_id: 9, area_name: 'Atlantis', district_name: 'Dhaka' }]);
        const order = makeOrder({
            delivery_location: JSON.stringify({
                provider_destination: {
                    redx: {
                        area_id: 77,
                        area_name: 'Mirpur',
                        district: 'Dhaka',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'user-1',
                    },
                },
            }),
        });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(book(order)).resolves.toMatchObject({ tracking_code: 'TRK-1' });

        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({ delivery_area_id: 77 });
        expect(pilotMetrics.snapshot().counters['courier.serviceability.not_serviceable_shadow']).toBe(1);
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

    test('a server-confirmed provider selection still books when the directory is unavailable', async () => {
        // Confirmation is a server-authored, provider-specific decision. The
        // stored ID remains usable during a later directory outage.
        getAreas.mockRejectedValue(new Error('timeout'));

        const order = makeOrder({
            delivery_location: {
                provider_destination: {
                    redx: {
                        area_id: 77,
                        area_name: 'Mirpur',
                        district: 'Dhaka',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'user-1',
                    },
                },
            },
        });
        // bookForOrder re-reads the order under the claim lock, so the fixture
        // has to be the one the lookup returns.
        mockOrder.findOne.mockResolvedValue(order);

        const result = await book(order);

        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({ delivery_area_id: 77 });
        expect(result).toMatchObject({ tracking_code: 'TRK-1' });
    });

    test('refuses unnamespaced order ids when the directory is unavailable', async () => {
        getAreas.mockRejectedValue(new Error('timeout'));
        const order = makeOrder({
            delivery_location: { area_id: 77, area_name: 'Mirpur', district: 'Dhaka' },
        });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(book(order)).rejects.toMatchObject({
            status: 409,
            code: 'COURIER_DESTINATION_PAYLOAD_INVALID',
        });

        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(dispatchRecord.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
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
        const order = makeOrder({
            delivery_location: { area_id: 77, area_name: 'Mirpur', district: 'Dhaka' },
        });
        mockOrder.findOne.mockResolvedValue(order);

        await expect(book(order)).rejects.toMatchObject({
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

    test('an order that records only its upazila is bookable through the directory', async () => {
        // Every first-party intake form (manual, storefront) records district
        // + upazila. The BD administrative list calls a Dhaka thana an
        // "upazila"; the courier directories call the same place an area.
        // Without this mapping a merchant could create an order and never be
        // able to book it (review R-2).
        const order = makeOrder({
            delivery_address: {
                street_address: 'Road 1',
                upazila: 'Mirpur',
                district: 'Dhaka',
            },
        });
        mockOrder.findOne.mockResolvedValue(order);

        await book(order);

        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({
            delivery_area: 'Mirpur',
            delivery_area_id: 1,
        });
    });

    test('a merchant-confirmed area still books when destination resolution is switched off', async () => {
        // The kill switch disables directory interrogation, not the order's
        // own recorded and confirmed destination (review R-3).
        process.env.COURIER_DESTINATION_RESOLUTION_ENABLED = 'false';
        const order = makeOrder({
            delivery_location: JSON.stringify({
                provider_destination: {
                    redx: {
                        area_id: 77,
                        area_name: 'Mirpur',
                        district: 'Dhaka',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'user-1',
                    },
                },
            }),
        });
        mockOrder.findOne.mockResolvedValue(order);

        await book(order);

        expect(getAreas).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({
            delivery_area_id: 77,
        });
    });

    test('a selection confirmed for one courier is never reused for another', async () => {
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
        const order = makeOrder({
            delivery_location: JSON.stringify({
                provider_destination: {
                    redx: {
                        area_id: 77,
                        area_name: 'Atlantis',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'user-1',
                    },
                },
            }),
        });
        mockOrder.findOne.mockResolvedValue(order);

        // Pathao resolves from the order's own text (Mirpur), not from the
        // RedX area id, and never sends a RedX id in a Pathao field.
        await book(order);

        const payload = deliveryService.createDeliveryOrder.mock.calls[0][1];
        expect(payload).toMatchObject({ recipient_city: 11, recipient_zone: 22, recipient_area: 33 });
        expect(payload).not.toHaveProperty('delivery_area_id');
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

describe('confirming a courier destination', () => {
    let getAreas;
    let order;
    let dispatchRecord;

    const confirm = (selection = { provider: 'redx', area_id: 1, area_name: 'Mirpur' }) =>
        orderService.confirmCourierDestination('order-1', 'user-1', 'shop-1', selection);

    beforeEach(() => {
        jest.clearAllMocks();
        destinationService.clearCache();
        pilotMetrics.reset();
        delete process.env.COURIER_SERVICEABILITY_ENFORCE;
        delete process.env.COURIER_DESTINATION_RESOLUTION_ENABLED;

        getAreas = jest.fn().mockResolvedValue(AREAS);
        order = makeOrder({ delivery_location: null, metadata: {} });

        mockOrder.findOne.mockResolvedValue(order);
        mockUserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'staff' });
        mockCourierDispatch.findOne.mockResolvedValue(null);
        dispatchRecord = { id: 'dispatch-confirmation-test', status: 'PENDING', update: jest.fn() };
        mockCourierDispatch.findOrCreate.mockResolvedValue([dispatchRecord, true]);
        mockCourierDispatch.update.mockResolvedValue([1]);
        mockDeliveryTracking.findOne.mockResolvedValue(null);
        mockAuditLog.create.mockResolvedValue({ id: 'audit-1' });
        sequelize.transaction.mockImplementation(async (callback) => {
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, rollback: jest.fn(), commit: jest.fn() };
            return callback(transaction);
        });
        deliveryService.getProviderInstance.mockResolvedValue({ getAreas });
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
    });

    test('stores a directory-confirmed selection against the courier that will carry it', async () => {
        const result = await confirm();

        expect(result.destination).toMatchObject({ provider: 'redx', decision: 'SERVICEABLE' });

        const update = order.update.mock.calls[0][0];
        const stored = JSON.parse(update.delivery_location);
        expect(stored.provider_destination.redx).toMatchObject({
            area_id: 1,
            area_name: 'Mirpur',
            source: 'merchant_confirmed',
            confirmed_by: 'user-1',
        });
        expect(update.delivery_area).toBe('Mirpur');
        expect(update.metadata.audit_log).toHaveLength(1);
        expect(update.metadata.audit_log[0]).toMatchObject({
            changed_by: 'user-1',
            changes: { delivery_destination: { from: null } },
        });
        expect(pilotMetrics.snapshot().counters['courier.destination.confirmed']).toBe(1);
    });

    test('a chatbot free-text order becomes bookable after merchant confirmation', async () => {
        const chatOrder = makeOrder({
            delivery_address: null,
            delivery_location: JSON.stringify({
                full_address: 'House 4, Road 12, Mirpur 10, Dhaka',
                source: 'chat',
            }),
        });
        mockOrder.findOne.mockResolvedValue(chatOrder);
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'redx',
            pickup: { provider_store_id: 'store-1' },
            instance: { getAreas },
        });
        await confirm();
        const result = await book(chatOrder);

        expect(result).toMatchObject({ tracking_code: 'TRK-1' });
        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({
            delivery_area_id: 1,
            delivery_area: 'Mirpur',
        });
        const stored = JSON.parse(chatOrder.delivery_location);
        expect(stored.full_address).toBe('House 4, Road 12, Mirpur 10, Dhaka');
        expect(stored.provider_destination.redx).toMatchObject({
            source: 'merchant_confirmed',
            confirmed_by: 'user-1',
        });
    });

    test('invalidates an old confirmation when the address changes and books against the corrected area', async () => {
        order.delivery_area = 'Mirpur';
        order.delivery_address = {
            street_address: 'House 4, Road 12',
            area: 'Mirpur',
            upazila: 'Mirpur',
            district: 'Dhaka',
        };
        order.delivery_location = JSON.stringify({
            full_address: 'House 4, Road 12, Mirpur, Dhaka',
            area_id: 1,
            area_name: 'Mirpur',
            zone_id: 4,
            city_id: 3,
            district: 'Dhaka',
            provider_destination: {
                redx: {
                    area_id: 1,
                    area_name: 'Mirpur',
                    district: 'Dhaka',
                    source: 'merchant_confirmed',
                    confirmed_at: '2026-11-04T00:00:00.000Z',
                    confirmed_by: 'user-1',
                },
            },
        });
        getAreas.mockResolvedValue([
            { area_id: 1, area_name: 'Mirpur', district_name: 'Dhaka' },
            { area_id: 9, area_name: 'Dhanmondi', district_name: 'Dhaka' },
        ]);

        expect(destinationService.extractDestinationFromOrder(order, { provider: 'redx' }))
            .toMatchObject({ area_id: 1, area_name: 'Mirpur', provider_confirmed: true });

        await orderService.updateOrder('order-1', 'user-1', 'shop-1', {
            delivery_address: {
                street_address: 'House 7, Road 2',
                area: 'Dhanmondi',
                upazila: 'Dhanmondi',
                district: 'Dhaka',
                area_id: 1,
                zone_id: 4,
                city_id: 3,
                provider_destination: { redx: { area_id: 1, area_name: 'Mirpur' } },
            },
        });

        const stored = JSON.parse(order.delivery_location);
        expect(stored.provider_destination).toBeUndefined();
        expect(stored).not.toHaveProperty('area_id');
        expect(stored).not.toHaveProperty('area_name');
        expect(stored).not.toHaveProperty('zone_id');
        expect(stored).not.toHaveProperty('city_id');
        expect(stored.full_address).toContain('Dhanmondi');
        expect(order.delivery_area).toBe('Dhanmondi');
        expect(order.delivery_address).not.toHaveProperty('area_id');
        expect(order.delivery_address).not.toHaveProperty('provider_destination');
        expect(order.metadata.audit_log.at(-1).changes.courier_destinations_invalidated).toMatchObject({
            providers: ['redx'],
            legacy_fields: expect.arrayContaining([
                'area_id', 'area_name', 'zone_id', 'city_id',
                'delivery_address.area_id', 'delivery_address.zone_id', 'delivery_address.city_id',
                'delivery_address.provider_destination',
            ]),
            reason: 'delivery_destination_changed',
        });

        await expect(book(order)).resolves.toMatchObject({ tracking_code: 'TRK-1' });

        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).toMatchObject({
            delivery_area_id: 9,
            delivery_area: 'Dhanmondi',
        });
    });

    test('strips courier ids smuggled in a JSON-string delivery_address', async () => {
        // The entity getter JSON-parses a string address back into an object on
        // read, so the id-strip must cover the string form too (Security P2-3).
        order.delivery_area = 'Mirpur';
        order.delivery_address = { street_address: 'House 4, Road 12', area: 'Mirpur', district: 'Dhaka' };
        order.delivery_location = JSON.stringify({
            full_address: 'House 4, Road 12, Mirpur, Dhaka',
            provider_destination: {
                redx: { area_id: 1, area_name: 'Mirpur', district: 'Dhaka', source: 'merchant_confirmed', confirmed_at: '2026-11-04T00:00:00.000Z', confirmed_by: 'user-1' },
            },
        });

        await orderService.updateOrder('order-1', 'user-1', 'shop-1', {
            delivery_address: JSON.stringify({
                street_address: 'House 9, Road 3', area: 'Gulshan', district: 'Dhaka',
                area_id: 999, zone_id: 888, city_id: 777, provider_destination: { redx: { area_id: 999 } },
            }),
        });

        const storedAddress = typeof order.delivery_address === 'string'
            ? JSON.parse(order.delivery_address) : order.delivery_address;
        expect(storedAddress.area).toBe('Gulshan');
        expect(storedAddress).not.toHaveProperty('area_id');
        expect(storedAddress).not.toHaveProperty('zone_id');
        expect(storedAddress).not.toHaveProperty('city_id');
        expect(storedAddress).not.toHaveProperty('provider_destination');
    });

    test('a byte-identical address resubmission keeps the merchant confirmation', async () => {
        // delivery_address reads back as a parsed object; reference inequality
        // used to flag a no-op resubmission as a change and wipe the confirmation
        // (QA-2). Deep equality must treat it as unchanged.
        const address = { street_address: 'House 4, Road 12', area: 'Mirpur', upazila: 'Mirpur', district: 'Dhaka' };
        order.delivery_area = 'Mirpur';
        order.delivery_address = { ...address };
        order.delivery_location = JSON.stringify({
            full_address: 'House 4, Road 12, Mirpur, Dhaka',
            provider_destination: {
                redx: { area_id: 1, area_name: 'Mirpur', district: 'Dhaka', source: 'merchant_confirmed', confirmed_at: '2026-11-04T00:00:00.000Z', confirmed_by: 'user-1' },
            },
        });

        await orderService.updateOrder('order-1', 'user-1', 'shop-1', { delivery_address: { ...address } });

        const stored = JSON.parse(order.delivery_location);
        expect(stored.provider_destination.redx).toMatchObject({ area_id: 1, source: 'merchant_confirmed', confirmed_by: 'user-1' });
        expect(order.delivery_area).toBe('Mirpur');
    });

    test('keeps the address text and any other courier\'s confirmed selection intact', async () => {
        order.delivery_location = JSON.stringify({
            full_address: 'Road 1, Mirpur, Dhaka',
            provider_destination: {
                pathao: { area_id: 33, area_name: 'Mirpur', source: 'merchant_confirmed', confirmed_at: '2026-11-04T00:00:00.000Z', confirmed_by: 'user-1' },
            },
        });

        await confirm();

        const stored = JSON.parse(order.update.mock.calls[0][0].delivery_location);
        expect(stored.full_address).toBe('Road 1, Mirpur, Dhaka');
        expect(stored.provider_destination.pathao).toMatchObject({ area_id: 33, source: 'merchant_confirmed', confirmed_by: 'user-1' });
        expect(stored.provider_destination.redx).toMatchObject({ area_id: 1 });
    });

    test('refuses an area that is not in that courier\'s directory', async () => {
        // Confirming an id the courier does not publish would move the defect
        // downstream: the parcel would be refused by the provider instead of
        // by us, with a worse message.
        await expect(confirm({ provider: 'redx', area_id: 999, area_name: 'Atlantis' }))
            .rejects.toMatchObject({ status: 409, code: 'COURIER_DESTINATION_INVALID_SELECTION' });

        expect(order.update).not.toHaveBeenCalled();
        expect(pilotMetrics.snapshot().counters['courier.destination.confirmation_rejected']).toBe(1);
        expect(pilotMetrics.snapshot().counters['courier.destination.confirmed']).toBe(0);
    });

    test('refuses while a dispatch is active so the stored destination cannot diverge from the parcel', async () => {
        mockCourierDispatch.findOne.mockResolvedValue({ id: 'dispatch-1', status: 'COMMITTED' });

        await expect(confirm()).rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });

        expect(deliveryService.getProviderInstance).not.toHaveBeenCalled();
        expect(order.update).not.toHaveBeenCalled();
    });

    test('allows correction after courier setup is fixed when no dispatch or tracking exists', async () => {
        order.delivery_status = 'courier_setup_required';

        await expect(confirm()).resolves.toMatchObject({
            destination: { provider: 'redx', decision: 'SERVICEABLE' },
        });

        expect(order.update).toHaveBeenCalled();
    });

    test('keeps structured area text in sync when only delivery_area is corrected', async () => {
        order.delivery_area = 'Mirpur';
        order.delivery_address = {
            street_address: 'Road 1',
            area: 'Mirpur',
            upazila: 'Mirpur',
            district: 'Dhaka',
        };
        order.delivery_location = JSON.stringify({ full_address: 'Road 1, Mirpur, Dhaka', area_id: 1, area_name: 'Mirpur' });

        await orderService.updateOrder('order-1', 'user-1', 'shop-1', { delivery_area: 'Dhanmondi' });

        expect(order.delivery_area).toBe('Dhanmondi');
        expect(order.delivery_address).toMatchObject({ area: 'Dhanmondi', upazila: 'Mirpur' });
        expect(JSON.parse(order.delivery_location)).not.toHaveProperty('area_id');
    });

    test.each([
        [{ delivery_tracking_code: 'TRK-LEGACY' }],
        [{ delivery_consignment_id: 'CN-LEGACY' }],
        [{ delivery_dispatched_at: '2026-11-03T10:00:00.000Z' }],
        [{ delivery_status: 'in_transit' }],
    ])('refuses correction when legacy order tracking already exists (%o)', async (legacyTracking) => {
        Object.assign(order, legacyTracking);

        await expect(confirm()).rejects.toMatchObject({
            status: 409,
            code: 'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        });

        expect(deliveryService.getProviderInstance).not.toHaveBeenCalled();
        expect(order.update).not.toHaveBeenCalled();
    });

    test('refuses correction when a legacy delivery-tracking row exists', async () => {
        mockDeliveryTracking.findOne.mockResolvedValue({ id: 'tracking-1', order_id: 'order-1' });

        await expect(confirm()).rejects.toMatchObject({
            status: 409,
            code: 'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        });

        expect(mockDeliveryTracking.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { order_id: 'order-1' },
            transaction: expect.any(Object),
            lock: 'UPDATE',
        }));
        expect(deliveryService.getProviderInstance).not.toHaveBeenCalled();
        expect(order.update).not.toHaveBeenCalled();
    });

    test('reports a courier that is not connected instead of storing a selection', async () => {
        require('../../delivery/courier-readiness.service').evaluateReadiness.mockResolvedValueOnce({
            ready: false,
            status: 'NOT_CONNECTED',
        });

        await expect(confirm()).rejects.toMatchObject({ status: 409, code: 'NOT_CONNECTED' });

        expect(order.update).not.toHaveBeenCalled();
    });

    test('reports an unreachable directory as temporarily unavailable, not as a bad selection', async () => {
        getAreas.mockRejectedValue(new Error('timeout'));

        await expect(confirm()).rejects.toMatchObject({ status: 503, code: 'COURIER_DIRECTORY_UNAVAILABLE' });

        expect(order.update).not.toHaveBeenCalled();
    });

    test('requires the courier directory keys before it looks anything up', async () => {
        await expect(confirm({ provider: 'pathao', area_name: 'Mirpur' }))
            .rejects.toMatchObject({ status: 400, code: 'COURIER_DESTINATION_SELECTION_INCOMPLETE' });

        expect(sequelize.transaction).not.toHaveBeenCalled();
    });

    test('does not make confirmation-time directory calls when destination resolution is disabled', async () => {
        process.env.COURIER_DESTINATION_RESOLUTION_ENABLED = 'false';

        await expect(confirm()).rejects.toMatchObject({
            status: 503,
            code: 'COURIER_DESTINATION_RESOLUTION_DISABLED',
        });

        expect(sequelize.transaction).not.toHaveBeenCalled();
        expect(deliveryService.getProviderInstance).not.toHaveBeenCalled();
        expect(getAreas).not.toHaveBeenCalled();
        expect(mockOrder.findOne).not.toHaveBeenCalled();
    });

    test('refuses a caller who does not belong to the shop', async () => {
        mockUserShop.findOne.mockResolvedValue(null);

        await expect(confirm()).rejects.toMatchObject({ status: 403 });

        expect(mockOrder.findOne).not.toHaveBeenCalled();
    });

    test('reports an order outside the shop as not found, and never reads another shop\'s row', async () => {
        mockOrder.findOne.mockResolvedValue(null);

        await expect(confirm()).rejects.toMatchObject({ status: 404 });

        expect(mockOrder.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'order-1', shop_id: 'shop-1' },
        }));
        expect(order.update).not.toHaveBeenCalled();
    });
});
