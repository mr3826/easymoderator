'use strict';

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})), transaction: jest.fn() },
}));
jest.mock('../order.service', () => ({
    createOrderInternal: jest.fn(),
    bookForOrder: jest.fn(),
}));
jest.mock('../../product/product-search.service', () => ({ checkStock: jest.fn() }));
jest.mock('../../payment/self-mfs-handler.service', () => ({ verifyPaymentScreenshot: jest.fn() }));
jest.mock('../../shop/shop-bd-settings', () => ({ getBdSettings: jest.fn(), hasSelfMfs: jest.fn() }));
jest.mock('../../customer/customer.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../shop/shop.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../payment/payment-config.entity', () => ({ findAll: jest.fn() }));
jest.mock('../../delivery/delivery.service', () => ({
    createDeliveryOrder: jest.fn(),
    getActiveProvider: jest.fn(),
}));
jest.mock('../../delivery/delivery-tracking.service', () => ({
    createTrackingRecord: jest.fn(async () => ({ id: 'tracking-1' })),
}));
jest.mock('../../ai/action-gate', () => ({
    verifyAuthorization: jest.fn(() => true),
}));
jest.mock('../../notification/merchant-notification.service', () => ({
    notifyShop: jest.fn(async () => ({ queued: true })),
}));
jest.mock('../../notification/notification-events', () => ({
    NOTIFICATION_EVENTS: { COURIER_BOOKING_FAILED: 'courier_booking_failed' },
}));

const OrderSessionService = require('../order-session-standalone.service');
const orderService = require('../order.service');
const deliveryService = require('../../delivery/delivery.service');
const deliveryTrackingService = require('../../delivery/delivery-tracking.service');
const merchantNotificationService = require('../../notification/merchant-notification.service');

const SHOP = 'shop-1';
const order = {
    id: 'order-1',
    order_number: 'ORD-SHOP-000001',
    total: 1250,
    items: [{ name: 'Red Saree', quantity: 1 }],
    update: jest.fn(async function update(values) {
        Object.assign(this, values);
    }),
};
const stepData = {
    name: 'Rahim',
    phone: '01711111111',
    address: 'Mirpur, Dhaka',
    notes: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    orderService.bookForOrder.mockRejectedValue(new Error('provider timeout'));
    deliveryService.getActiveProvider.mockResolvedValue({
        provider: 'steadfast',
        instance: { getOrderStatusByInvoice: jest.fn() },
    });
    jest.spyOn(global, 'setTimeout').mockImplementation((callback) => {
        callback();
        return 0;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('courier dispatch reconciliation', () => {
    test('stops after an ambiguous provider result and leaves reconciliation to an operator', async () => {
        const getOrderStatusByInvoice = jest.fn().mockResolvedValue({
            invoice: order.order_number,
            consignment_id: 'CN-1',
            tracking_code: 'TRK-1',
            delivery_status: 'pending',
        });
        deliveryService.getActiveProvider.mockResolvedValue({
            provider: 'steadfast',
            instance: { getOrderStatusByInvoice },
        });
        deliveryService.createDeliveryOrder.mockRejectedValueOnce(new Error('provider timeout'));

        const result = await OrderSessionService.dispatchParcelWithRetry(order, stepData, SHOP, {
            authorization: { actionType: 'BOOK_COURIER', shopId: SHOP },
        });

        expect(orderService.bookForOrder).toHaveBeenCalledTimes(1);
        expect(getOrderStatusByInvoice).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(deliveryTrackingService.createTrackingRecord).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    test('never treats a provider 404 as permission to bypass the local claim', async () => {
        const getOrderStatusByInvoice = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
            .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
        deliveryService.getActiveProvider.mockResolvedValue({
            provider: 'steadfast',
            instance: { getOrderStatusByInvoice },
        });
        const result = await OrderSessionService.dispatchParcelWithRetry(order, stepData, SHOP, {
            authorization: { actionType: 'BOOK_COURIER', shopId: SHOP },
        });

        expect(orderService.bookForOrder).toHaveBeenCalledTimes(1);
        expect(getOrderStatusByInvoice).not.toHaveBeenCalled();
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    test('does not dispatch through the legacy path when canonical booking is unavailable', async () => {
        deliveryService.getActiveProvider.mockResolvedValue({
            provider: 'pathao',
            instance: {},
        });
        deliveryService.createDeliveryOrder.mockRejectedValueOnce(new Error('pathao timeout'));

        const result = await OrderSessionService.dispatchParcelWithRetry(order, stepData, SHOP, {
            authorization: { actionType: 'BOOK_COURIER', shopId: SHOP },
        });

        expect(result).toBeNull();
        expect(orderService.bookForOrder).toHaveBeenCalledTimes(1);
        expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
        expect(order.update).not.toHaveBeenCalled();
        expect(merchantNotificationService.notifyShop).not.toHaveBeenCalled();
    });

    test('logs only the order identifier and safe code when courier booking throws', async () => {
        const sensitiveError = Object.assign(
            new Error('Provider response includes Rahim, 01711111111, Mirpur and private request payload'),
            { code: 'UPSTREAM_TIMEOUT' },
        );
        orderService.bookForOrder.mockRejectedValueOnce(sensitiveError);
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

        await OrderSessionService.dispatchParcelWithRetry(order, stepData, SHOP, {
            authorization: { actionType: 'BOOK_COURIER', shopId: SHOP },
        });

        expect(errorLog).toHaveBeenCalledWith('[AutoParcel] Courier dispatch stopped', {
            orderId: 'order-1',
            errorCode: 'UPSTREAM_TIMEOUT',
        });
        const logs = JSON.stringify(errorLog.mock.calls);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur');
        expect(logs).not.toContain('private request payload');
    });
});
