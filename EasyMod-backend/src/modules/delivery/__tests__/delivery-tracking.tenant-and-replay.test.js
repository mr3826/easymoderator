'use strict';

const mockDeliveryTracking = {
    findOne: jest.fn(),
};
const mockOrder = {};
const mockShop = {};
const mockRtoShield = { trackDeliveryOutcome: jest.fn().mockResolvedValue(undefined) };
const mockOrderConfidence = { recordOutcome: jest.fn().mockResolvedValue({ recorded: true }) };
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../entities', () => ({
    DeliveryTracking: mockDeliveryTracking,
    Order: mockOrder,
    Shop: mockShop,
}));
jest.mock('../delivery.service', () => ({ getDeliveryStatus: jest.fn() }));
jest.mock('../../rto-shield/rto-shield.service', () => ({
    ...mockRtoShield,
}));
jest.mock('../../order-confidence/order-confidence.service', () => ({ ...mockOrderConfidence }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => mockLogger,
}));

const service = require('../delivery-tracking.service');
const { OUTCOMES, classifyOrderOutcome, summarizeOrders } = require('../../customer-intelligence/order-outcome');

describe('delivery tracking tenant and replay safeguards', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete mockDeliveryTracking.sequelize;
    });

    test('a stale courier callback cannot regress a terminal delivery state', async () => {
        const tracking = {
            id: 'tracking-1',
            current_status: 'delivered',
            order: { shop_id: 'shop-1', update: jest.fn() },
            update: jest.fn(),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        const result = await service.handleDeliveryWebhook('pathao', 'CN-1', {
            status: 'IN_TRANSIT',
        });

        expect(result).toMatchObject({
            success: true,
            ignored: true,
            message: 'Terminal status preserved',
        });
        expect(tracking.update).not.toHaveBeenCalled();
        expect(tracking.order.update).not.toHaveBeenCalled();
    });

    test('delivery webhook failures log safe codes instead of raw error or tracking data', async () => {
        const error = new Error('Authorization: Bearer private-token');
        error.code = 'DB_QUERY_FAILED';
        mockDeliveryTracking.findOne.mockRejectedValue(error);

        await expect(service.handleDeliveryWebhook('pathao', 'PRIVATE-TRACKING-NUMBER', {
            status: 'DELIVERED',
        })).rejects.toMatchObject({ status: 500 });

        expect(mockLogger.error).toHaveBeenCalledWith('Failed to handle delivery webhook', {
            provider: 'pathao',
            trackingId: null,
            errorCode: 'DB_QUERY_FAILED',
        });
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('private-token');
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('PRIVATE-TRACKING-NUMBER');
    });

    test('webhook failure logs a safe tracking record ID and stable error code only', async () => {
        const tracking = {
            id: 'tracking-safe_2',
            current_status: 'in_transit',
            order: { update: jest.fn().mockRejectedValue(Object.assign(
                new Error('private phone 01712345678 and credential secret'),
                { code: 'ORDER_WRITE_FAILED' },
            )) },
            update: jest.fn(),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await expect(service.handleDeliveryWebhook('pathao', 'PRIVATE-TRACKING-NUMBER', {
            status: 'DELIVERED',
        })).rejects.toMatchObject({ status: 500 });

        expect(mockLogger.error).toHaveBeenCalledWith('Failed to handle delivery webhook', {
            provider: 'pathao',
            trackingId: 'tracking-safe_2',
            errorCode: 'ORDER_WRITE_FAILED',
        });
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('01712345678');
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('credential secret');
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('PRIVATE-TRACKING-NUMBER');
    });

    test('delivery success logs omit provider tracking and recipient data', async () => {
        const tracking = {
            id: 'tracking-safe_3',
            current_status: 'booked',
            status_history: [],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01711111111',
                update: jest.fn(),
            },
            update: jest.fn(),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);
        jest.spyOn(service, 'sendCustomerNotification').mockResolvedValue(undefined);

        await service.handleDeliveryWebhook('pathao', 'PRIVATE-TRACKING-NUMBER', {
            status: 'IN_TRANSIT',
            location: 'Rahim 01711111111, Mirpur address',
            delivery_agent: { name: 'Rahim', phone: '01711111111' },
        });

        const logs = JSON.stringify([
            mockLogger.info.mock.calls,
            mockLogger.warn.mock.calls,
            mockLogger.error.mock.calls,
        ]);
        expect(logs).not.toContain('PRIVATE-TRACKING-NUMBER');
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur address');
        expect(logs).not.toContain('Rahim');
        expect(mockLogger.info).toHaveBeenCalledWith('Delivery status updated', expect.objectContaining({
            trackingId: 'tracking-safe_3',
            newStatus: 'in_transit',
        }));
    });

    test('appends a changed status to status_history without a reference error', async () => {
        const tracking = {
            id: 'tracking-2',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                update: jest.fn(),
            },
            update: jest.fn(),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        const result = await service.handleDeliveryWebhook('pathao', 'CN-2', {
            status: 'DELIVERED',
            location: 'Dhaka',
        });

        expect(result.success).toBe(true);
        expect(tracking.update).toHaveBeenCalledWith(expect.objectContaining({
            status_history: [
                { status: 'booked' },
                expect.objectContaining({ status: 'delivered', location: 'Dhaka' }),
            ],
        }));
        expect(tracking.order.update).toHaveBeenCalledWith(expect.objectContaining({
            order_status: 'delivered',
            delivered_at: expect.any(Date),
        }));
        const deliveredOrder = { delivery_status: 'delivered', order_status: 'delivered', delivered_at: new Date() };
        expect(classifyOrderOutcome(deliveredOrder)).toBe(OUTCOMES.DELIVERED);
        expect(summarizeOrders([{ ...deliveredOrder, total: 1250 }])).toMatchObject({
            delivered_orders: 1,
            delivered_value: 1250,
        });
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledWith('01700000000', 'shop-1', false);
    });

    test('a failed delivery attempt is not final RTO; a retry and duplicate final callback count once', async () => {
        const tracking = {
            id: 'tracking-attempt',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }, { status: 'in_transit' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            update: jest.fn(async (values) => Object.assign(tracking, values)),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await service.handleDeliveryWebhook('pathao', 'CN-ATTEMPT', { status: 'FAILED_DELIVERY' });
        expect(tracking.order.update).toHaveBeenLastCalledWith({ delivery_status: 'failed_delivery' });
        expect(mockOrderConfidence.recordOutcome).not.toHaveBeenCalled();
        expect(mockRtoShield.trackDeliveryOutcome).not.toHaveBeenCalled();

        await service.handleDeliveryWebhook('pathao', 'CN-ATTEMPT', { status: 'IN_TRANSIT' });
        await service.handleDeliveryWebhook('pathao', 'CN-ATTEMPT', { status: 'RETURNED' });
        await service.handleDeliveryWebhook('pathao', 'CN-ATTEMPT', { status: 'RETURNED' });

        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledWith('01700000000', 'shop-1', true);
    });

    test('courier cancellation remains a cancellation without finalizing outcome or RTO evidence', async () => {
        const tracking = {
            id: 'tracking-cancelled',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }, { status: 'in_transit' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                delivery_tracking_code: 'CN-CANCELLED',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            update: jest.fn(async (values) => Object.assign(tracking, values)),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await service.handleDeliveryWebhook('pathao', 'CN-CANCELLED', { status: 'CANCELLED' });

        expect(tracking.order.update).toHaveBeenCalledWith(expect.objectContaining({
            delivery_status: 'cancelled',
            order_status: 'cancelled',
        }));
        expect(classifyOrderOutcome(tracking.order)).toBe(OUTCOMES.CANCELLED);
        expect(summarizeOrders([tracking.order])).toMatchObject({ returned_orders: 0, cancelled_orders: 1 });
        expect(tracking.current_status).toBe('cancelled');
        expect(mockOrderConfidence.recordOutcome).not.toHaveBeenCalled();
        expect(mockRtoShield.trackDeliveryOutcome).not.toHaveBeenCalled();
    });

    test('a final partial return after cancellation records returned outcome and RTO evidence', async () => {
        const tracking = {
            id: 'tracking-cancel-then-return',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }, { status: 'in_transit' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                payment_status: 'pending',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            update: jest.fn(async (values) => Object.assign(tracking, values)),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await service.handleDeliveryWebhook('pathao', 'CN-CANCEL-RETURN', { status: 'CANCELLED' });
        expect(mockOrderConfidence.recordOutcome).not.toHaveBeenCalled();
        expect(mockRtoShield.trackDeliveryOutcome).not.toHaveBeenCalled();

        await service.handleDeliveryWebhook('redx', 'CN-CANCEL-RETURN', { status: 'partial-returned' });

        expect(tracking.current_status).toBe('partial_returned');
        expect(tracking.previous_status).toBe('cancelled');
        expect(tracking.status_history.at(-1)).toEqual(expect.objectContaining({ status: 'partial_returned' }));
        expect(tracking.order.delivery_status).toBe('partial_returned');
        expect(classifyOrderOutcome(tracking.order)).toBe(OUTCOMES.RETURNED);
        expect(summarizeOrders([tracking.order])).toMatchObject({ returned_orders: 1, cancelled_orders: 0 });
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledWith('01700000000', 'shop-1', true);
        expect(tracking.order.payment_status).toBe('pending');
    });

    test('an authoritative partial return is counted as returned ground truth and RTO', async () => {
        const tracking = {
            id: 'tracking-partial-return',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }, { status: 'in_transit' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                payment_status: 'pending',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            update: jest.fn(async (values) => Object.assign(tracking, values)),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await service.handleDeliveryWebhook('redx', 'CN-PARTIAL-RETURN', { status: 'partial-returned' });

        expect(tracking.current_status).toBe('partial_returned');
        expect(tracking.order.delivery_status).toBe('partial_returned');
        expect(classifyOrderOutcome(tracking.order)).toBe(OUTCOMES.RETURNED);
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledWith('01700000000', 'shop-1', true);
        expect(tracking.order.payment_status).toBe('pending');
    });

    test('partial delivery stays in progress and a later partial return becomes the sole RTO outcome', async () => {
        const tracking = {
            id: 'tracking-partial-delivery',
            current_status: 'in_transit',
            status_history: [{ status: 'booked' }, { status: 'in_transit' }],
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                payment_status: 'pending',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            update: jest.fn(async (values) => Object.assign(tracking, values)),
        };
        mockDeliveryTracking.findOne.mockResolvedValue(tracking);

        await service.handleDeliveryWebhook('redx', 'CN-PARTIAL-DELIVERY', { status: 'partial-delivered' });

        expect(tracking.current_status).toBe('partial_delivered');
        expect(tracking.status_history.at(-1)).toEqual(expect.objectContaining({ status: 'partial_delivered' }));
        expect(tracking.order).toEqual(expect.objectContaining({
            delivery_status: 'partial_delivered',
            fulfillment_status: 'partially_fulfilled',
            order_status: 'processing',
            payment_status: 'pending',
        }));
        expect(tracking.order).not.toHaveProperty('delivered_at');
        expect(classifyOrderOutcome(tracking.order)).toBe(OUTCOMES.IN_PROGRESS);
        expect(summarizeOrders([{ ...tracking.order, total: 1250 }])).toMatchObject({
            delivered_orders: 0,
            returned_orders: 0,
            in_progress_orders: 1,
            delivered_value: 0,
        });
        expect(mockOrderConfidence.recordOutcome).not.toHaveBeenCalled();
        expect(mockRtoShield.trackDeliveryOutcome).not.toHaveBeenCalled();

        await service.handleDeliveryWebhook('redx', 'CN-PARTIAL-DELIVERY', { status: 'partial-returned' });

        expect(tracking.current_status).toBe('partial_returned');
        expect(tracking.previous_status).toBe('partial_delivered');
        expect(tracking.order).toEqual(expect.objectContaining({
            delivery_status: 'partial_returned',
            fulfillment_status: 'cancelled',
            order_status: 'cancelled',
            payment_status: 'pending',
        }));
        expect(classifyOrderOutcome(tracking.order)).toBe(OUTCOMES.RETURNED);
        expect(summarizeOrders([{ ...tracking.order, total: 1250 }])).toMatchObject({
            delivered_orders: 0,
            returned_orders: 1,
            cancelled_orders: 0,
            delivered_value: 0,
        });
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledWith(tracking.order);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledWith('01700000000', 'shop-1', true);

        await service.handleDeliveryWebhook('redx', 'CN-PARTIAL-DELIVERY', { status: 'partial-returned' });
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(1);
        expect(tracking.order.payment_status).toBe('pending');
    });

    test('rolls back a terminal return when local RTO accounting fails so a webhook retry can record it', async () => {
        let persistedStatus = 'in_transit';
        let persistedHistory = [{ status: 'booked' }, { status: 'in_transit' }];
        const persistedOrder = { delivery_status: 'in_transit', order_status: 'confirmed' };
        const tracking = {
            id: 'tracking-rto-retry',
            current_status: persistedStatus,
            status_history: persistedHistory,
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                update: jest.fn(async (values) => {
                    Object.assign(tracking.order, values);
                    Object.assign(persistedOrder, values);
                }),
            },
            set(values) { Object.assign(this, values); },
            reload: jest.fn(async () => {
                tracking.current_status = persistedStatus;
                tracking.status_history = persistedHistory;
                Object.assign(tracking.order, persistedOrder);
                return tracking;
            }),
            update: jest.fn(async (values) => {
                Object.assign(tracking, values);
                if (values.current_status) persistedStatus = values.current_status;
                if (values.status_history) persistedHistory = values.status_history;
            }),
        };
// The service locks the tracking row with a single-table FOR UPDATE
        // inside the transaction, then applies the locked snapshot. The fake
        // therefore returns the plain webhook row outside transactions and a
        // persisted-state snapshot when a transaction is passed.
        mockDeliveryTracking.findOne.mockImplementation(async (options = {}) => (
            options.transaction
                ? {
                    get: () => ({
                        current_status: persistedStatus,
                        status_history: persistedHistory,
                    }),
                }
                : tracking
        ));
        mockDeliveryTracking.sequelize = {
            transaction: async (callback) => {
                const snapshot = {
                    status: persistedStatus,
                    history: persistedHistory,
                    order: { ...persistedOrder },
                };
                try {
                    return await callback({ LOCK: { UPDATE: 'UPDATE' } });
                } catch (error) {
                    persistedStatus = snapshot.status;
                    persistedHistory = snapshot.history;
                    Object.assign(persistedOrder, snapshot.order);
                    Object.assign(tracking, { current_status: persistedStatus, status_history: persistedHistory });
                    Object.assign(tracking.order, persistedOrder);
                    throw error;
                }
            },
        };
        mockRtoShield.trackDeliveryOutcome
            .mockRejectedValueOnce(new Error('stats write failed'))
            .mockResolvedValueOnce(undefined);

        await expect(service.handleDeliveryWebhook('pathao', 'CN-RTO-RETRY', { status: 'RETURNED' }))
            .rejects.toMatchObject({ status: 500 });
        expect(persistedStatus).toBe('in_transit');
        expect(mockOrderConfidence.recordOutcome).not.toHaveBeenCalled();

        await service.handleDeliveryWebhook('pathao', 'CN-RTO-RETRY', { status: 'RETURNED' });
        expect(persistedStatus).toBe('returned');
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(2);
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
    });

    test('different terminal callbacks racing on one tracking row record only the locked winner', async () => {
        let persistedStatus = 'in_transit';
        let persistedHistory = [{ status: 'booked' }, { status: 'in_transit' }];
        let transactionTail = Promise.resolve();
        const tracking = {
            id: 'tracking-race',
            current_status: persistedStatus,
            status_history: persistedHistory,
            order: {
                shop_id: 'shop-1',
                customer_phone: '01700000000',
                update: jest.fn(async (values) => Object.assign(tracking.order, values)),
            },
            set(values) { Object.assign(this, values); },
            reload: jest.fn(async () => {
                tracking.current_status = persistedStatus;
                tracking.status_history = persistedHistory;
                return tracking;
            }),
            update: jest.fn(async (values) => {
                Object.assign(tracking, values);
                if (values.current_status) persistedStatus = values.current_status;
                if (values.status_history) persistedHistory = values.status_history;
            }),
        };
        mockDeliveryTracking.sequelize = {
            transaction: async (callback) => {
                const previous = transactionTail;
                let release;
                transactionTail = new Promise((resolve) => { release = resolve; });
                await previous;
                try {
                    return await callback({ LOCK: { UPDATE: 'UPDATE' } });
                } finally {
                    release();
                }
            },
        };
// Single-table FOR UPDATE snapshot inside the serialized transaction;
        // the plain webhook row outside it (see the rollback test above).
        mockDeliveryTracking.findOne.mockImplementation(async (options = {}) => (
            options.transaction
                ? {
                    get: () => ({
                        current_status: persistedStatus,
                        status_history: persistedHistory,
                    }),
                }
                : tracking
        ));

        const results = await Promise.all([
            service.handleDeliveryWebhook('pathao', 'CN-RACE', { status: 'RETURNED' }),
            service.handleDeliveryWebhook('pathao', 'CN-RACE', { status: 'DELIVERED' }),
        ]);

        expect(results.filter((result) => result.ignored)).toHaveLength(1);
        expect(mockOrderConfidence.recordOutcome).toHaveBeenCalledTimes(1);
        expect(mockRtoShield.trackDeliveryOutcome).toHaveBeenCalledTimes(1);
        const outcomeCall = mockRtoShield.trackDeliveryOutcome.mock.calls[0];
        expect(outcomeCall.slice(0, 3)).toEqual([
            '01700000000',
            'shop-1',
            persistedStatus === 'returned',
        ]);
        expect(outcomeCall[3]).toEqual({ transaction: expect.any(Object) });
    });

    test('order tracking lookup binds the tenant through the real Order foreign key', async () => {
        mockDeliveryTracking.findOne.mockResolvedValue({ id: 'tracking-1' });

        await service.getTrackingByOrderId('order-1', 'shop-1');

        expect(mockDeliveryTracking.findOne).toHaveBeenCalledWith({
            where: { order_id: 'order-1' },
            include: [{
                model: mockOrder,
                as: 'order',
                attributes: ['order_number', 'customer_name', 'customer_phone', 'total'],
                where: { shop_id: 'shop-1' },
                required: true,
            }],
        });
    });

    test('tracking-history lookup cannot select a tracking row from another shop', async () => {
        mockDeliveryTracking.findOne.mockResolvedValue({
            current_status: 'in_transit',
            tracking_number: 'CN-1',
            provider: 'pathao',
        });

        await service.getTrackingHistory('tracking-1', 'shop-1');

        expect(mockDeliveryTracking.findOne).toHaveBeenCalledWith({
            where: { id: 'tracking-1' },
            include: [{
                model: mockOrder,
                as: 'order',
                attributes: ['id'],
                where: { shop_id: 'shop-1' },
                required: true,
            }],
        });
    });
});
