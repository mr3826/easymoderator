'use strict';

/**
 * D-5 (A0-ratified): a delivery failure is NOT a payment confirmation.
 * The old handleFailedDelivery called ownerNotificationService
 * .sendPaymentConfirmationRequest with a `delivery_failure` payload — creating
 * a payment_confirmation row AND crashing the formatter on the missing
 * paymentMethod. It must now emit the registered ORDER_REVIEW_REQUIRED event
 * through the merchant-notification path (dashboard row + queued channels).
 */
process.env.NODE_ENV = 'test';

const mockNotifyShop = jest.fn().mockResolvedValue({ queued: true, inAppNotificationId: 'in-1' });
const mockPaymentConfirmation = jest.fn();

jest.mock('../../entities', () => ({
    DeliveryTracking: { findOne: jest.fn() },
    Order: {},
    Shop: {},
}));
jest.mock('../delivery.service', () => ({ getDeliveryStatus: jest.fn() }));
jest.mock('../../rto-shield/rto-shield.service', () => ({ trackDeliveryOutcome: jest.fn() }));
jest.mock('../../notification/merchant-notification.service', () => ({ notifyShop: mockNotifyShop }));
jest.mock('../../notification/owner-notification.service', () => ({
    sendPaymentConfirmationRequest: mockPaymentConfirmation,
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const service = require('../delivery-tracking.service');
const { NOTIFICATION_EVENTS } = require('../../notification/notification-events');

const failedTracking = () => ({
    id: 'trk-1',
    provider: 'pathao',
    tracking_number: 'CN-FAILED-1',
    current_status: 'failed_delivery',
    order: {
        id: 'order-1',
        shop_id: 'shop-1',
        order_number: '100001',
        customer_name: 'A',
        customer_phone: '018',
        total: 500,
    },
});

beforeEach(() => jest.clearAllMocks());

describe('D-5: delivery failure surfaces as ORDER_REVIEW_REQUIRED', () => {
    test('emits the registered order-review event, never a payment confirmation', async () => {
        await service.handleFailedDelivery(failedTracking());

        expect(mockPaymentConfirmation).not.toHaveBeenCalled();
        expect(mockNotifyShop).toHaveBeenCalledTimes(1);
        const [shopId, eventType, payload, options] = mockNotifyShop.mock.calls[0];
        expect(shopId).toBe('shop-1');
        expect(eventType).toBe(NOTIFICATION_EVENTS.ORDER_REVIEW_REQUIRED);
        expect(eventType).toBe('order_review_required');
        expect(payload).toMatchObject({
            orderId: 'order-1',
            orderNumber: '100001',
            reasonCode: 'DELIVERY_FAILED',
            provider: 'pathao',
            trackingNumber: 'CN-FAILED-1',
        });
        expect(options.dedupeKey).toContain('order-1');
        expect(options.dedupeKey).toContain('delivery-failed');
    });

    test('ORDER_REVIEW_REQUIRED is the registered vocabulary (no new event invented)', () => {
        expect(NOTIFICATION_EVENTS.ORDER_REVIEW_REQUIRED).toBe('order_review_required');
        // the payment-confirmation vocabulary is registered for the claim flow
        // (§3.2), while delivery failure uses order review (D-5):
        expect(NOTIFICATION_EVENTS.PAYMENT_CONFIRMATION).toBe('payment_confirmation');
    });

    test('a notification failure never breaks the delivery-status flow', async () => {
        mockNotifyShop.mockRejectedValueOnce(new Error('queue down'));
        await expect(service.handleFailedDelivery(failedTracking())).resolves.toBeUndefined();
    });
});
