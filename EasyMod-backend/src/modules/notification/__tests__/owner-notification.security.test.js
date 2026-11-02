'use strict';

const mockModels = {
    AuditLog: { create: jest.fn() },
    CourierDispatch: { findOne: jest.fn() },
    DeliveryTracking: { findOne: jest.fn() },
    Order: { findOne: jest.fn() },
    OwnerNotification: { findByPk: jest.fn() },
    PaymentConfig: { findOne: jest.fn() },
    PaymentTransaction: { findOne: jest.fn() },
    Shop: {},
    User: {},
    UserShop: {},
};
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockSequelize = {
    transaction: jest.fn(async (callback) => callback(mockTransaction)),
};
const mockCancelOrderInTransaction = jest.fn();

jest.mock('../../entities', () => mockModels);
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockSequelize }));
jest.mock('../../../utils/email.service', () => ({ sendEmail: jest.fn() }));
jest.mock('../../order/order.service', () => ({ cancelOrderInTransaction: mockCancelOrderInTransaction }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const service = require('../owner-notification.service');

function fixtures(overrides = {}) {
    const notification = {
        id: 'notification-1',
        shop_id: 'shop-1',
        type: 'payment_confirmation',
        status: 'pending',
        expires_at: new Date(Date.now() + 60_000),
        customer_data: {
            orderId: 'order-1',
            orderNumber: 'ORD-1',
            transactionId: 'trx-1',
        },
        update: jest.fn(),
        ...overrides.notification,
    };
    const order = {
        id: 'order-1',
        shop_id: 'shop-1',
        customer_id: null,
        update: jest.fn(),
        ...overrides.order,
    };
    const payment = {
        id: 'payment-1',
        status: 'pending',
        update: jest.fn(),
        ...overrides.payment,
    };
    mockModels.OwnerNotification.findByPk.mockResolvedValue(notification);
    mockModels.CourierDispatch.findOne.mockResolvedValue(null);
    mockModels.DeliveryTracking.findOne.mockResolvedValue(null);
    mockModels.Order.findOne.mockResolvedValue(order);
    mockModels.PaymentTransaction.findOne.mockResolvedValue(payment);
    mockModels.AuditLog.create.mockResolvedValue({});
    mockCancelOrderInTransaction.mockResolvedValue(order);
    return { notification, order, payment };
}

describe('authenticated owner payment confirmation state machine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(service, 'sendCustomerResponse').mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('approves one pending shop-scoped payment and appends an audit event', async () => {
        const { notification, order, payment } = fixtures();

        await expect(service.handleOwnerResponse(
            notification.id,
            'approve',
            { userId: 'owner-1' },
        )).resolves.toMatchObject({ success: true, orderId: order.id });

        expect(mockModels.Order.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: order.id, shop_id: notification.shop_id },
        }));
        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({ payment_status: 'paid', order_status: 'confirmed' }),
            { transaction: mockTransaction },
        );
        expect(payment.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'verified' }),
            { transaction: mockTransaction },
        );
        expect(mockModels.AuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'owner_payment_approve',
                shop_id: notification.shop_id,
                user_id: 'owner-1',
            }),
            { transaction: mockTransaction },
        );
    });

    test('rejects one pending payment without approving it', async () => {
        const { notification, order, payment } = fixtures();

        await service.handleOwnerResponse(notification.id, 'reject', { userId: 'owner-1' });

        expect(mockCancelOrderInTransaction).toHaveBeenCalledWith(
            'owner-1',
            notification.shop_id,
            order.id,
            'Payment confirmation rejected',
            mockTransaction,
        );
        expect(order.update).toHaveBeenCalledWith(
            { payment_status: 'failed' },
            { transaction: mockTransaction },
        );
        expect(payment.update).toHaveBeenCalledWith(
            { status: 'rejected' },
            { transaction: mockTransaction },
        );
    });

    test.each(['approve', 'reject'])(
        'does not let owner %s reopen or cancel an order after a courier claim',
        async (action) => {
            const { notification, order, payment } = fixtures();
            mockModels.CourierDispatch.findOne.mockResolvedValue({ status: 'COMMITTED' });

            await expect(service.handleOwnerResponse(
                notification.id,
                action,
                { userId: 'owner-1' },
            )).rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_RECONCILIATION_REQUIRED' });

            expect(order.update).not.toHaveBeenCalled();
            expect(payment.update).not.toHaveBeenCalled();
            expect(notification.update).not.toHaveBeenCalled();
            expect(mockModels.AuditLog.create).not.toHaveBeenCalled();
        },
    );

    test.each(
        [
            ['completed order status', { order_status: 'completed' }],
            ['delivered order status', { order_status: 'delivered' }],
            ['shipped order status', { order_status: 'shipped' }],
            ['fulfilled order status', { order_status: 'fulfilled' }],
            ['cancelled order status', { order_status: 'cancelled' }],
            ['refunded order status', { order_status: 'refunded' }],
            ['returned order status', { order_status: 'returned' }],
            ['completed fulfillment status', { fulfillment_status: 'completed' }],
            ['delivered fulfillment status', { fulfillment_status: 'delivered' }],
            ['fulfilled fulfillment status', { fulfillment_status: 'fulfilled' }],
            ['cancelled fulfillment status', { fulfillment_status: 'cancelled' }],
            ['refunded fulfillment status', { fulfillment_status: 'refunded' }],
            ['returned fulfillment status', { fulfillment_status: 'returned' }],
            ['delivered tracking status', { delivery_status: 'delivered' }],
            ['cancelled tracking status', { delivery_status: 'cancelled' }],
            ['returned tracking status', { delivery_status: 'returned' }],
            ['delivered timestamp', { delivered_at: new Date() }],
        ].flatMap(([label, orderState]) => ['approve', 'reject'].map((action) => [action, label, orderState])),
    )(
        'does not let owner %s change an order with terminal %s without courier rows',
        async (action, _label, orderState) => {
            const { notification, order, payment } = fixtures({ order: orderState });

            await expect(service.handleOwnerResponse(notification.id, action, { userId: 'owner-1' }))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_LIFECYCLE_TERMINAL' });

            expect(mockModels.CourierDispatch.findOne).not.toHaveBeenCalled();
            expect(mockModels.DeliveryTracking.findOne).not.toHaveBeenCalled();
            expect(order.update).not.toHaveBeenCalled();
            expect(payment.update).not.toHaveBeenCalled();
            expect(mockCancelOrderInTransaction).not.toHaveBeenCalled();
            expect(notification.update).not.toHaveBeenCalled();
            expect(mockModels.AuditLog.create).not.toHaveBeenCalled();
        },
    );

    test('does not use payment confirmation approval to settle a COD order', async () => {
        const { notification, order, payment } = fixtures({ order: { payment_method: 'cash_on_delivery' } });

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(mockCancelOrderInTransaction).not.toHaveBeenCalled();
    });

    test('resolves an ID-only COD payment method before owner approval', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method_id: 'cod-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockResolvedValue({ id: 'cod-config-1', gateway: 'cod', is_enabled: true });

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

        expect(mockModels.PaymentConfig.findOne).toHaveBeenCalledWith({
            where: { id: 'cod-config-1', shop_id: notification.shop_id, is_enabled: true },
            attributes: ['id', 'gateway', 'is_enabled'],
            transaction: mockTransaction,
            lock: mockTransaction.LOCK.UPDATE,
        });
        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(notification.update).not.toHaveBeenCalled();
    });

    test('fails closed when the payment method alias conflicts with the shop-scoped config', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method: 'bkash', payment_method_id: 'cod-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockResolvedValue({ id: 'cod-config-1', gateway: 'cod', is_enabled: true });

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409, code: 'PAYMENT_METHOD_CONFIGURATION_MISMATCH' });

        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(notification.update).not.toHaveBeenCalled();
        expect(mockModels.AuditLog.create).not.toHaveBeenCalled();
    });

    test('allows owner approval for an ID-resolved non-COD gateway', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method: 'bkash', payment_method_id: 'online-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockResolvedValue({ id: 'online-config-1', gateway: 'self-mfs', is_enabled: true });

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .resolves.toMatchObject({ success: true, orderId: order.id });

        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({ payment_status: 'paid', order_status: 'confirmed' }),
            { transaction: mockTransaction },
        );
        expect(payment.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'verified' }),
            { transaction: mockTransaction },
        );
    });

    test('fails closed when the payment method ID is not available to the notification shop', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method_id: 'foreign-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockResolvedValue(null);

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_AVAILABLE' });

        expect(mockModels.PaymentConfig.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'foreign-config-1', shop_id: notification.shop_id, is_enabled: true },
        }));
        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(notification.update).not.toHaveBeenCalled();
        expect(mockModels.AuditLog.create).not.toHaveBeenCalled();
    });

    test('fails closed when the shop payment method is disabled', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method: 'bkash', payment_method_id: 'disabled-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockResolvedValue({
            id: 'disabled-config-1',
            gateway: 'bkash',
            is_enabled: false,
        });

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_AVAILABLE' });

        expect(mockModels.PaymentConfig.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'disabled-config-1', shop_id: notification.shop_id, is_enabled: true },
        }));
        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(notification.update).not.toHaveBeenCalled();
        expect(mockModels.AuditLog.create).not.toHaveBeenCalled();
    });

    test('fails closed when payment method configuration cannot be read', async () => {
        const { notification, order, payment } = fixtures({
            order: { payment_method_id: 'online-config-1' },
        });
        mockModels.PaymentConfig.findOne.mockRejectedValue(new Error('database unavailable'));

        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 503, code: 'PAYMENT_METHOD_CONFIGURATION_UNAVAILABLE' });

        expect(order.update).not.toHaveBeenCalled();
        expect(payment.update).not.toHaveBeenCalled();
        expect(notification.update).not.toHaveBeenCalled();
    });

    test.each([
        ['replayed completion', { notification: { status: 'completed' } }, 409],
        ['expired action', { notification: { expires_at: new Date(Date.now() - 60_000) } }, 410],
        ['completed payment transition', { payment: { status: 'paid' } }, 409],
    ])('rejects %s', async (_label, overrides, status) => {
        const { notification } = fixtures(overrides);

        await expect(service.handleOwnerResponse(
            notification.id,
            'approve',
            { userId: 'owner-1' },
        )).rejects.toMatchObject({ status });
    });

    test('rejects a forged action before reading tenant data', async () => {
        await expect(service.handleOwnerResponse(
            'notification-1',
            'refund',
            { userId: 'owner-1' },
        )).rejects.toMatchObject({ status: 400 });
        expect(mockModels.OwnerNotification.findByPk).not.toHaveBeenCalled();
    });
});
