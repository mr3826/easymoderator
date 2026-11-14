'use strict';

const mockOrder = { findOne: jest.fn(), update: jest.fn() };
const mockCourierDispatch = {
    findOrCreate: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
};
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
    // Billing standing gate (ADR-0011 C5) counts unpaid recurring invoices
    // inside the booking claim; these suites are about dispatch, not billing.
    Invoice: { count: jest.fn().mockResolvedValue(0) },
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
        query: jest.fn(),
        getDialect: jest.fn(),
    },
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
const merchantNotificationService = require('../../notification/merchant-notification.service');
const { sequelize } = require('../../../utils/database/database-setup');

const makeOrder = () => {
    const order = {
        id: 'order-1',
        shop_id: 'shop-1',
        order_number: 'ORD-REAL-0007',
        order_status: 'confirmed',
        fulfillment_status: 'unfulfilled',
        payment_method: 'COD',
        payment_status: 'unpaid',
        customer_name: 'Rahim',
        customer_phone: '01711111111',
        delivery_address: {
            street_address: 'Road 1',
            upazila: 'Dhanmondi',
            district: 'Dhaka',
        },
        // These provider-specific ids were confirmed through the directory.
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
        items: [{ name: 'Red Saree', quantity: 2 }],
        update: jest.fn(async function update(values) {
            Object.assign(this, values);
        }),
    };
    return order;
};

describe('canonical courier booking', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockOrder.findOne.mockResolvedValue(makeOrder());
        mockOrder.update.mockResolvedValue([1]);
        mockUserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'staff' });
        mockAuditLog.create.mockResolvedValue({ id: 'audit-1' });
        sequelize.transaction.mockImplementation(async (callback) => {
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, rollback: jest.fn(), commit: jest.fn() };
            try {
                return typeof callback === 'function' ? await callback(transaction) : transaction;
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
        });
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: false,
            provider: 'pathao',
            pickup: { provider_store_id: 'store-1' },
        });
        deliveryService.createDeliveryOrder.mockResolvedValue({
            provider: 'pathao',
            consignment_id: 'CN-1',
            tracking_code: 'TRK-1',
            status: 'pending',
        });
        sessionService.persistDeliveryResult.mockResolvedValue(undefined);
        mockCourierDispatch.findOrCreate.mockResolvedValue([{
            status: 'PENDING',
            update: jest.fn().mockResolvedValue(undefined),
        }, true]);
    });

    it('claims the actual provider and persists the canonical order payload', async () => {
        const order = makeOrder();

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            trigger: 'MANUAL',
            mutationAuthority: { kind: 'human', userId: 'user-1' },
        });

        expect(deliveryService.resolveAiDefaultProvider).toHaveBeenCalledWith('shop-1');
        expect(mockCourierDispatch.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
            // Scoped to (shop_id, order_id) only — one active dispatch claim
            // per order, regardless of provider. Provider is stored data now,
            // not part of the claim's identity (see
            // courier-dispatch-claim.service.js).
            where: { shop_id: 'shop-1', order_id: 'order-1' },
            defaults: expect.objectContaining({ provider: 'pathao', status: 'PENDING' }),
        }));
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledWith(
            'shop-1',
            expect.objectContaining({
                order_number: 'ORD-REAL-0007',
                customer_name: 'Rahim',
                customer_phone: '01711111111',
                delivery_address: 'Road 1, Dhanmondi, Dhaka',
                total: 1250,
                item_quantity: 2,
                store_id: 'store-1',
                pickup_store_id: 'store-1',
            }),
            'pathao'
        );
        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).not.toHaveProperty('delivery_area');
        expect(deliveryService.createDeliveryOrder.mock.calls[0][1]).not.toHaveProperty('delivery_area_id');
        expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'COURIER_BOOKING_AUTHORIZED',
            user_id: 'user-1',
            shop_id: 'shop-1',
            resource_id: order.id,
            metadata: expect.objectContaining({ authority_type: 'human', source: 'merchant_ui' }),
        }));
        expect(sessionService.persistDeliveryResult).toHaveBeenCalledWith(expect.objectContaining({ id: order.id }), expect.objectContaining({
            provider: 'pathao',
            tracking_code: 'TRK-1',
        }));
        expect(result).toEqual(expect.objectContaining({ tracking_code: 'TRK-1' }));
        expect(order.order_status).toBe('confirmed');
        expect(order.fulfillment_status).toBe('unfulfilled');
    });

    it('replays the persisted order provider when a tracking ID exists despite a different requested provider', async () => {
        const order = makeOrder();
        Object.assign(order, {
            delivery_provider: 'pathao',
            delivery_consignment_id: 'CN-EXISTING',
            delivery_tracking_code: 'TRK-EXISTING',
        });
        mockCourierDispatch.findOne.mockResolvedValueOnce({
            status: 'COMMITTED',
            provider: null,
            consignment_id: 'CN-EXISTING',
            tracking_code: 'TRK-EXISTING',
        });

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            provider: 'steadfast',
        });

        expect(result).toMatchObject({
            provider: 'pathao',
            consignment_id: 'CN-EXISTING',
            tracking_code: 'TRK-EXISTING',
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
    });

    it('blocks a tracked replay without a persisted provider instead of echoing the requested provider', async () => {
        const order = makeOrder();
        Object.assign(order, {
            delivery_provider: null,
            delivery_consignment_id: 'CN-UNKNOWN-PROVIDER',
            delivery_tracking_code: 'TRK-UNKNOWN-PROVIDER',
        });
        mockCourierDispatch.findOne.mockResolvedValueOnce({
            status: 'COMMITTED',
            provider: null,
            consignment_id: 'CN-UNKNOWN-PROVIDER',
            tracking_code: 'TRK-UNKNOWN-PROVIDER',
        });

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            provider: 'steadfast',
        });

        expect(result).toEqual(expect.objectContaining({
            blocked: true,
            status: 'tracking_unavailable',
            code: 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE',
            provider: null,
        }));
        expect(result).not.toMatchObject({ provider: 'steadfast' });
        expect(result).not.toMatchObject({ provider: 'pathao' });

        expect(deliveryService.resolveAiDefaultProvider).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
    });

    it('rejects an untrusted production courier mutation without provider or dispatch side effects', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const order = makeOrder();
        try {
            await expect(orderService.bookForOrder(order, { shopId: 'shop-1' }))
                .rejects.toMatchObject({ status: 403, code: 'COURIER_AUTHORITY_REQUIRED' });
            expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
            expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('rejects a human courier mutation without an active shop membership', async () => {
        const order = makeOrder();
        mockUserShop.findOne.mockResolvedValue(null);

        await expect(orderService.bookForOrder(order, {
            shopId: 'shop-1',
            trigger: 'MANUAL',
            mutationAuthority: { kind: 'human', userId: 'user-foreign' },
        })).rejects.toMatchObject({ status: 403 });

        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    it('rejects a courier booking request scoped to another shop', async () => {
        const order = makeOrder();

        await expect(orderService.bookForOrder(order, { shopId: 'shop-foreign' }))
            .rejects.toMatchObject({ status: 403, code: 'TENANT_MISMATCH' });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
    });

    it('does not honor skipClaim when another caller owns a pending claim', async () => {
        const order = makeOrder();
        mockCourierDispatch.findOrCreate.mockResolvedValueOnce([{
            id: 'dispatch-existing',
            status: 'PENDING',
            provider: 'pathao',
            dispatch_owner_token: 'other-owner',
        }, false]);

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            provider: 'steadfast',
            skipClaim: true,
            mutationAuthority: { kind: 'test' },
        });

        expect(result).toMatchObject({
            blocked: true,
            provider: 'pathao',
            reason: 'existing_courier_dispatch_claim',
        });
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
    });

    it('marks setup required without claiming or calling a provider when readiness blocks booking', async () => {
        const order = makeOrder();
        mockOrder.findOne.mockResolvedValue(order);
        deliveryService.resolveAiDefaultProvider.mockResolvedValue({
            blocked: true,
            provider: 'pathao',
            reason: 'COURIER_SETUP_REQUIRED',
            missing: ['pickup_location_configured'],
        });

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            requireAiDefault: true,
            mutationAuthority: { kind: 'test' },
        });

        expect(result).toMatchObject({
            blocked: true,
            status: 'courier_setup_required',
            provider: 'pathao',
            missing: ['pickup_location_configured'],
        });
        expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(order.update).toHaveBeenCalledWith(
            { delivery_status: 'courier_setup_required' },
            { transaction: expect.anything() },
        );
        expect(order.order_status).toBe('confirmed');
        expect(order.fulfillment_status).toBe('unfulfilled');
        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            'shop-1',
            'courier_setup_required',
            expect.objectContaining({ status: 'courier_setup_required' }),
            expect.objectContaining({ dedupeKey: 'order-1:courier_setup_required' })
        );
    });

    it('marks a definite provider validation rejection failed instead of indeterminate', async () => {
        const order = makeOrder();
        const dispatchRecord = {
            status: 'PENDING',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockCourierDispatch.findOrCreate.mockResolvedValueOnce([dispatchRecord, true]);
        deliveryService.createDeliveryOrder.mockRejectedValueOnce(Object.assign(
            new Error('Invalid pickup address'),
            { status: 400, statusCode: 400 },
        ));

        const result = await orderService.bookForOrder(order, {
            shopId: 'shop-1',
            throwOnError: false,
            mutationAuthority: { kind: 'test' },
        });

        expect(result).toMatchObject({
            failed: true,
            status: 'dispatch_failed',
            provider: 'pathao',
        });
        expect(dispatchRecord.update).toHaveBeenCalledWith({
            status: 'FAILED',
            error: 'Invalid pickup address',
        });
        expect(order.update).not.toHaveBeenCalledWith({ delivery_status: 'dispatch_indeterminate' });
    });

    it('reopens a definitively rejected dispatch for one deliberate retry', async () => {
        const order = makeOrder();
        const row = { id: 'dispatch-retry', status: 'PENDING' };
        mockCourierDispatch.findOrCreate.mockImplementation(async ({ defaults }) => {
            if (!row.dispatch_owner_token) {
                Object.assign(row, defaults);
                return [row, true];
            }
            return [row, false];
        });
        mockCourierDispatch.update.mockImplementation(async (values, { where }) => {
            const matches = row.id === where.id
                && row.status === where.status
                && (!where.dispatch_owner_token || row.dispatch_owner_token === where.dispatch_owner_token);
            if (!matches) return [0];
            Object.assign(row, values);
            return [1];
        });
        deliveryService.createDeliveryOrder
            .mockRejectedValueOnce(Object.assign(new Error('Invalid pickup address'), { status: 400 }))
            .mockResolvedValueOnce({
                provider: 'pathao',
                consignment_id: 'CN-RETRY',
                tracking_code: 'TRK-RETRY',
                status: 'pending',
            });

        await expect(orderService.bookForOrder(order, {
            shopId: 'shop-1', throwOnError: false, mutationAuthority: { kind: 'test' },
        })).resolves.toMatchObject({ failed: true, status: 'dispatch_failed' });
        expect(row.status).toBe('FAILED');

        await expect(orderService.bookForOrder(order, {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        })).resolves.toMatchObject({ tracking_code: 'TRK-RETRY' });

        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(2);
        expect(row).toMatchObject({ status: 'COMMITTED', consignment_id: 'CN-RETRY' });
    });

    it('keeps an ambiguous provider timeout indeterminate and never retries it automatically', async () => {
        const order = makeOrder();
        let row = null;
        mockCourierDispatch.findOrCreate.mockImplementation(async ({ defaults }) => {
            if (!row) {
                row = { id: 'dispatch-timeout', ...defaults };
                return [row, true];
            }
            return [row, false];
        });
        mockCourierDispatch.update.mockImplementation(async (values, { where }) => {
            const matches = row
                && row.status === where.status
                && row.dispatch_owner_token === where.dispatch_owner_token;
            if (!matches) return [0];
            Object.assign(row, values);
            return [1];
        });
        mockCourierDispatch.findOne.mockImplementation(async () => row);
        deliveryService.createDeliveryOrder.mockRejectedValueOnce(new Error('request timed out'));

        await expect(orderService.bookForOrder(order, {
            shopId: 'shop-1', throwOnError: false, mutationAuthority: { kind: 'test' },
        })).resolves.toMatchObject({ failed: true, status: 'dispatch_indeterminate' });
        expect(row.status).toBe('INDETERMINATE');

        const retry = await orderService.bookForOrder(order, {
            shopId: 'shop-1', throwOnError: false, mutationAuthority: { kind: 'test' },
        });

        expect(retry).toMatchObject({ blocked: true, reason: 'existing_courier_dispatch_claim' });
        expect(deliveryService.createDeliveryOrder).toHaveBeenCalledTimes(1);
    });

    it('does not let a pending-claim loser overwrite the committed winner', async () => {
        let row = null;
        let providerStarted;
        let releaseProvider;
        const providerReady = new Promise(resolve => { providerStarted = resolve; });
        const providerResult = new Promise(resolve => { releaseProvider = resolve; });

        mockCourierDispatch.findOrCreate.mockImplementation(async ({ defaults }) => {
            if (!row) {
                row = { id: 'dispatch-1', ...defaults };
                return [row, true];
            }
            return [row, false];
        });
        mockCourierDispatch.update.mockImplementation(async (values, { where }) => {
            const matches = row
                && row.status === where.status
                && row.dispatch_owner_token === where.dispatch_owner_token;
            if (!matches) return [0];
            Object.assign(row, values);
            return [1];
        });
        mockCourierDispatch.findOne.mockImplementation(async () => row);
        deliveryService.createDeliveryOrder.mockImplementation(async () => {
            providerStarted();
            return providerResult;
        });

        const winnerPromise = orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        await providerReady;

        const loserResult = await orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        expect(loserResult).toMatchObject({
            blocked: true,
            reason: 'existing_courier_dispatch_claim',
        });
        expect(mockCourierDispatch.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ status: 'INDETERMINATE' }),
            expect.anything(),
        );

        releaseProvider({
            provider: 'pathao',
            consignment_id: 'CN-RACE-1',
            tracking_code: 'TRK-RACE-1',
            status: 'pending',
        });
        await winnerPromise;

        expect(row).toMatchObject({
            status: 'COMMITTED',
            consignment_id: 'CN-RACE-1',
            tracking_code: 'TRK-RACE-1',
        });
    });

    it('keeps a committed winner when a stale loser resumes afterward', async () => {
        let row = null;
        let providerStarted;
        let releaseProvider;
        let existingObserved;
        let releaseExisting;
        const providerReady = new Promise(resolve => { providerStarted = resolve; });
        const providerResult = new Promise(resolve => { releaseProvider = resolve; });
        const loserObserved = new Promise(resolve => { existingObserved = resolve; });
        const loserResume = new Promise(resolve => { releaseExisting = resolve; });

        mockCourierDispatch.findOrCreate.mockImplementation(async ({ defaults }) => {
            if (!row) {
                row = { id: 'dispatch-2', ...defaults };
                return [row, true];
            }
            existingObserved();
            await loserResume;
            return [row, false];
        });
        mockCourierDispatch.update.mockImplementation(async (values, { where }) => {
            const matches = row
                && row.status === where.status
                && row.dispatch_owner_token === where.dispatch_owner_token;
            if (!matches) return [0];
            Object.assign(row, values);
            return [1];
        });
        mockCourierDispatch.findOne.mockImplementation(async () => row);
        deliveryService.createDeliveryOrder.mockImplementation(async () => {
            providerStarted();
            return providerResult;
        });

        const winnerPromise = orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        await providerReady;
        const loserPromise = orderService.bookForOrder(makeOrder(), {
            shopId: 'shop-1', mutationAuthority: { kind: 'test' },
        });
        await loserObserved;

        releaseProvider({
            provider: 'pathao',
            consignment_id: 'CN-RACE-2',
            tracking_code: 'TRK-RACE-2',
            status: 'pending',
        });
        await winnerPromise;
        releaseExisting();

        await expect(loserPromise).resolves.toMatchObject({
            provider: 'pathao',
            tracking_code: 'TRK-RACE-2',
        });
        expect(row).toMatchObject({
            status: 'COMMITTED',
            consignment_id: 'CN-RACE-2',
            tracking_code: 'TRK-RACE-2',
        });
    });
});
