'use strict';

/**
 * RTO Shield v2 wiring inside the canonical booking boundary (ADR-0007).
 * The gate itself is exercised against real PostgreSQL in
 * order-confidence/__tests__/order-confidence.integration.test.js; this file
 * pins how bookForOrder reacts to each gate result.
 */

const mockOrder = { findOne: jest.fn(), update: jest.fn().mockResolvedValue([1]) };
const mockCourierDispatch = { findOrCreate: jest.fn(), update: jest.fn(), findOne: jest.fn() };

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: {},
    Product: {},
    Customer: {},
    UserShop: {},
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
jest.mock('../order-session-standalone.service', () => ({ persistDeliveryResult: jest.fn() }));
jest.mock('../../notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));
jest.mock('../../order-confidence/order-confidence.service', () => ({
    checkBookingGate: jest.fn(),
}));

const orderService = require('../order.service');
const deliveryService = require('../../delivery/delivery.service');
const merchantNotificationService = require('../../notification/merchant-notification.service');
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
    // These Pathao ids are recorded by the directory-confirmation flow.
    delivery_location: {
        provider_destination: {
            pathao: {
                area_id: 11,
                area_name: 'Dhanmondi',
                zone_id: 22,
                zone_name: 'Dhanmondi',
                city_id: 33,
                city_name: 'Dhaka',
                district: 'Dhaka',
                source: 'merchant_confirmed',
                confirmed_at: '2026-11-04T00:00:00.000Z',
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

const HELD = {
    allowed: false,
    mode: 'enforce',
    decision: 'VERIFY',
    reasons: [{ code: 'ADDRESS_TOO_SHORT', severity: 'VERIFY' }],
    decisionVersion: 3,
};

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
});

describe('bookForOrder × Order Confidence gate', () => {
    test.each([
        ['completed order', { order_status: 'completed' }],
        ['delivered order', { order_status: 'delivered' }],
        ['shipped order', { order_status: 'shipped' }],
        ['cancelled order', { order_status: 'cancelled' }],
        ['fully fulfilled order', { fulfillment_status: 'fulfilled' }],
        ['delivered courier state', { delivery_status: 'delivered' }],
    ])('rejects a direct booking attempt for a %s before confidence or provider mutation', async (_label, state) => {
        const terminal = makeOrder(state);

        await expect(orderService.bookForOrder(terminal, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        })).rejects.toMatchObject({ status: 409, code: 'ORDER_NOT_BOOKABLE' });

        expect(orderConfidence.checkBookingGate).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('rejects a terminal persisted order after loading the locked snapshot', async () => {
        mockOrder.findOne.mockResolvedValue(makeOrder({ order_status: 'completed' }));

        await expect(orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        })).rejects.toMatchObject({ status: 409, code: 'ORDER_NOT_BOOKABLE' });

        expect(orderConfidence.checkBookingGate).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('a held order never creates a dispatch claim and never reaches the provider', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue(HELD);

        const result = await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });

        expect(result).toEqual(expect.objectContaining({
            blocked: true,
            status: 'confidence_hold',
            decision: 'VERIFY',
            reasons: ['ADDRESS_TOO_SHORT'],
            decision_version: 3,
        }));
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        // Operational marker only — order_status / fulfillment_status untouched.
        expect(mockOrder.update).toHaveBeenCalledWith(
            { delivery_status: 'confidence_hold' },
            { where: expect.objectContaining({ id: 'order-1', shop_id: 'shop-1', delivery_consignment_id: null }) },
        );
        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            'shop-1',
            'order_review_required',
            expect.objectContaining({ orderId: 'order-1', decision: 'VERIFY', reasonCodes: ['ADDRESS_TOO_SHORT'] }),
            expect.objectContaining({ dedupeKey: 'order-1:confidence_hold' }),
        );
    });

    test('the gate runs before the claim and receives the trigger', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'enforce', decision: 'READY' });

        const result = await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', trigger: 'MANUAL', mutationAuthority: { kind: 'test' },
        });

        expect(orderConfidence.checkBookingGate).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'order-1' }), 'shop-1', { trigger: 'MANUAL' },
        );
        expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledTimes(1);
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        expect(result).toEqual(expect.objectContaining({ tracking_code: 'TRK-1' }));
        const gateOrder = orderConfidence.checkBookingGate.mock.invocationCallOrder[0];
        const claimOrder = mockCourierDispatch.findOrCreate.mock.invocationCallOrder[0];
        expect(gateOrder).toBeLessThan(claimOrder);
    });

    test('keeps processing orders eligible for courier booking', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        const processingOrder = makeOrder({ order_status: 'processing' });
        mockOrder.findOne.mockResolvedValue(processingOrder);

        await orderService.bookForOrder(processingOrder, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });

        expect(orderConfidence.checkBookingGate).toHaveBeenCalledWith(
            expect.objectContaining({ order_status: 'processing' }),
            'shop-1',
            { trigger: 'AUTO' },
        );
        expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledTimes(1);
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });

    test('provider payload is built from the locked order snapshot', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'enforce' });
        mockOrder.findOne.mockResolvedValue(makeOrder({ customer_name: 'Locked snapshot name' }));

        await orderService.bookForOrder(makeOrder({ customer_name: 'Initial name' }), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });

        expect(orderConfidence.checkBookingGate).toHaveBeenCalledWith(
            expect.objectContaining({ customer_name: 'Locked snapshot name' }),
            'shop-1',
            { trigger: 'AUTO' },
        );
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledWith('shop-1', expect.objectContaining({
            customer_name: 'Locked snapshot name',
            cod_amount: 1250,
            amount_to_collect: 1250,
        }), 'pathao');
    });

    test('automatic callers default to trigger AUTO', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        expect(orderConfidence.checkBookingGate).toHaveBeenCalledWith(expect.anything(), 'shop-1', { trigger: 'AUTO' });
    });

    test('a held order with a COMMITTED claim still reconciles the real parcel (no new provider call)', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue(HELD);
        const committed = { id: 'd-1', status: 'COMMITTED', provider: 'pathao', consignment_id: 'CN-9', tracking_code: 'TRK-9' };
        mockCourierDispatch.findOne.mockResolvedValue(committed);
        mockCourierDispatch.findOrCreate.mockResolvedValue([committed, false]);

        const result = await orderService.bookForOrder(makeOrder(), { shopId: 'shop-1' });

        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ tracking_code: 'TRK-9', provider: 'pathao' }));
        expect(mockOrder.update).not.toHaveBeenCalledWith({ delivery_status: 'confidence_hold' }, expect.anything());
    });

    test.each([
        ['missing tracking reference', { consignment_id: null, tracking_code: null }, {}],
        ['blank tracking reference', { consignment_id: '  ', tracking_code: '\t ' }, {
            delivery_consignment_id: ' ', delivery_tracking_code: '\t ',
        }],
    ])('does not replay a committed dispatch with a %s', async (_label, claimIdentity, orderIdentity) => {
        mockCourierDispatch.findOne.mockResolvedValue({
            id: 'd-missing-tracking',
            status: 'COMMITTED',
            provider: 'pathao',
            ...claimIdentity,
        });

        const result = await orderService.bookForOrder(makeOrder(orderIdentity), {
            shopId: 'shop-1',
            provider: 'steadfast',
        });

        expect(result).toEqual(expect.objectContaining({
            blocked: true,
            status: 'tracking_unavailable',
            code: 'COURIER_TRACKING_UNAVAILABLE',
            provider: 'pathao',
        }));
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('does not replace an invalid committed provider with the order or request provider', async () => {
        mockCourierDispatch.findOne.mockResolvedValue({
            id: 'd-invalid-provider',
            status: 'COMMITTED',
            provider: 'unregistered-courier',
            consignment_id: 'CN-9',
            tracking_code: 'TRK-9',
        });

        const result = await orderService.bookForOrder(makeOrder({ delivery_provider: 'pathao' }), {
            shopId: 'shop-1',
            provider: 'steadfast',
        });

        expect(result).toEqual(expect.objectContaining({
            blocked: true,
            status: 'tracking_unavailable',
            code: 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE',
            provider: null,
        }));
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test('does not call a provider or create another claim when an existing claim is unresolved', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        mockCourierDispatch.findOrCreate.mockResolvedValue([{
            id: 'd-existing',
            status: 'PENDING',
            provider: 'pathao',
        }, false]);

        const result = await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1',
            provider: 'steadfast',
            mutationAuthority: { kind: 'test' },
        });

        expect(result).toEqual(expect.objectContaining({
            blocked: true,
            status: 'dispatch_indeterminate',
            reason: 'existing_courier_dispatch_claim',
        }));
        expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledTimes(1);
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test.each(['completed', 'delivered'])(
        'a committed dispatch remains recoverable after the order becomes %s',
        async (order_status) => {
            orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });

            await orderService.bookForOrder(makeOrder(), {
                shopId: 'shop-1', mutationAuthority: { kind: 'test' },
            });
            expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);

            const committed = {
                id: 'd-1',
                status: 'COMMITTED',
                provider: 'pathao',
                consignment_id: 'CN-9',
                tracking_code: 'TRK-9',
            };
            mockCourierDispatch.findOne.mockResolvedValue(committed);

            const result = await orderService.bookForOrder(makeOrder({
                order_status,
                fulfillment_status: 'fulfilled',
                delivery_status: 'delivered',
            }), { shopId: 'shop-1', mutationAuthority: { kind: 'test' } });

            expect(result).toEqual(expect.objectContaining({
                tracking_code: 'TRK-9',
                consignment_id: 'CN-9',
                provider: 'pathao',
            }));
            expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledTimes(1);
            expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        },
    );

    test('a terminal order without a committed claim returns 409 before provider mutation', async () => {
        mockCourierDispatch.findOne.mockResolvedValue(null);
        const terminal = makeOrder({ order_status: 'completed' });

        await expect(orderService.bookForOrder(terminal, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        })).rejects.toMatchObject({ status: 409, code: 'ORDER_NOT_BOOKABLE' });

        expect(mockCourierDispatch.findOne).toHaveBeenCalledWith({
            where: { shop_id: 'shop-1', order_id: 'order-1' },
        });
        expect(deliveryService.resolveAiDefaultProvider).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test.each([
        ['confidence mode off', { allowed: true, mode: 'off' }],
        ['verified in enforce mode', { allowed: true, mode: 'enforce', decision: 'READY' }],
    ])('a Draft order cannot reach courier booking with %s', async (_label, decision) => {
        orderConfidence.checkBookingGate.mockResolvedValue(decision);
        const draft = makeOrder({ order_status: 'draft' });
        mockOrder.findOne.mockResolvedValueOnce(draft);

        await expect(orderService.bookForOrder(draft, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        }))
            .rejects.toMatchObject({ status: 409, code: 'DRAFT_ORDER_NOT_BOOKABLE' });

        // IC-V1 reconciliation: the gate runs AFTER Order-Confidence (not before,
        // as in v6's original branch) so a confidence-HELD draft keeps answering
        // with the richer ORDER_CONFIDENCE_HOLD contract (order-confidence
        // integration suite pins that). The merchant-visible guarantee is
        // unchanged: a draft can never book a courier.
        expect(orderConfidence.checkBookingGate).toHaveBeenCalledWith(
            draft, 'shop-1', { trigger: 'AUTO' },
        );
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(draft.order_status).toBe('draft');
    });

    test('rechecks persisted order status under a row lock before courier claim', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        mockOrder.findOne
            .mockResolvedValueOnce(makeOrder())
            .mockResolvedValueOnce(makeOrder({ order_status: 'draft' }));

        await expect(orderService.bookForOrder(makeOrder({ order_status: 'confirmed' }), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        }))
            .rejects.toMatchObject({ status: 409, code: 'ORDER_CHANGED_BEFORE_COURIER_CLAIM' });

        expect(mockOrder.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'order-1', shop_id: 'shop-1' },
            lock: 'UPDATE',
        }));
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    test.each([
        ['payment method', { payment_method: 'bkash' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['payment status', { payment_status: 'paid' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['total', { total: '1500.00' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['delivery address', { delivery_address: 'House 99, Road 1, Uttara, Dhaka' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['processing status', { order_status: 'processing' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['draft status', { order_status: 'draft' }, 'ORDER_CHANGED_BEFORE_COURIER_CLAIM'],
        ['cancelled status', { order_status: 'cancelled' }, 'ORDER_NOT_BOOKABLE'],
        ['refunded status', { order_status: 'refunded' }, 'ORDER_NOT_BOOKABLE'],
    ])('returns a conflict when the %s changes after review and before claim', async (_label, changes, code) => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'enforce' });
        mockOrder.findOne
            .mockResolvedValueOnce(makeOrder())
            .mockResolvedValueOnce(makeOrder(changes));

        await expect(orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' }, throwOnError: false,
        })).rejects.toMatchObject({
            status: 409,
            code,
        });

        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    // Destination race: an area-only correction between review and claim does
    // not touch the confidence fingerprint, so the claim proceeds — but the
    // provider payload is rebuilt from the locked row, so the stale area id can
    // never reach the courier. Only the refreshed destination books.
    test('books the refreshed destination when only the confirmed area changes before claim', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'enforce' });
        const refreshed = makeOrder();
        refreshed.delivery_location.provider_destination.pathao = {
            ...refreshed.delivery_location.provider_destination.pathao,
            area_id: 12,
            area_name: 'Mohakhali',
            confirmed_at: '2026-11-05T00:00:00.000Z',
        };
        mockOrder.findOne
            .mockResolvedValueOnce(makeOrder())
            .mockResolvedValueOnce(refreshed);

        await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });

        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
        const payload = deliveryService.createDeliveryOrder.mock.calls[0][1];
        expect(payload).toMatchObject({
            recipient_area: 12,
            recipient_zone: 22,
            recipient_city: 33,
        });
        expect(payload).not.toMatchObject({ recipient_area: 11 });
    });

    test('returns a conflict when the confidence gate reports a stale snapshot', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({
            allowed: false,
            mode: 'enforce',
            snapshotStale: true,
            reasons: [{ code: 'ORDER_CHANGED', severity: 'VERIFY' }],
        });

        await expect(orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        })).rejects.toMatchObject({ status: 409, code: 'ORDER_CHANGED_BEFORE_COURIER_CLAIM' });

        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    // IC-V1 review F1: an unconfigured shop must never see the draft mutated or
    // notified by a booking attempt — DRAFT_ORDER_NOT_BOOKABLE answers BEFORE
    // any COURIER_SETUP_REQUIRED marking.
    test('a Draft in a shop without courier setup is rejected without marking or notifying', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({ blocked: true });
        const draft = makeOrder({ order_status: 'draft' });

        await expect(orderService.bookForOrder(draft, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        }))
            .rejects.toMatchObject({ status: 409, code: 'DRAFT_ORDER_NOT_BOOKABLE' });

        expect(draft.update).not.toHaveBeenCalled();
        expect(merchantNotificationService.notifyShop).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    // IC-V1 review F2: a legacy draft whose dispatch already COMMITTED must
    // remain reconcilable (the parcel was really booked).
    test('a Draft with a COMMITTED dispatch still reconciles its real parcel', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({ allowed: true, mode: 'off' });
        mockCourierDispatch.findOne.mockResolvedValue({
            id: 'd-old', status: 'COMMITTED', provider: 'pathao',
            consignment_id: 'CN-OLD', tracking_code: 'TRK-OLD',
        });
        const draft = makeOrder({ order_status: 'draft' });

        const result = await orderService.bookForOrder(draft, { shopId: 'shop-1' });

        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(draft.update).not.toHaveBeenCalled();
        expect(result).toBeTruthy();
    });

    test('an already-booked order returns its parcel without consulting the gate', async () => {
        const result = await orderService.bookForOrder(
            makeOrder({ delivery_consignment_id: 'CN-OLD', delivery_tracking_code: 'TRK-OLD', delivery_provider: 'pathao' }),
            { shopId: 'shop-1' },
        );
        expect(orderConfidence.checkBookingGate).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ tracking_code: 'TRK-OLD' }));
    });

    test('an engine failure in enforce mode holds and is reported as such', async () => {
        orderConfidence.checkBookingGate.mockResolvedValue({
            allowed: false, mode: 'enforce', engineFailure: true, decision: null,
            reasons: [{ code: 'ENGINE_UNAVAILABLE', severity: 'VERIFY' }],
        });
        const result = await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        expect(result).toEqual(expect.objectContaining({ status: 'confidence_hold', engine_failure: true }));
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });
});
