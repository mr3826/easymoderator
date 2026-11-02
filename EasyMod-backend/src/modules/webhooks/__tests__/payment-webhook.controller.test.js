'use strict';

const mockPaymentTransaction = {
    findOne: jest.fn(),
    update: jest.fn(),
};
const mockOrder = { findOne: jest.fn() };
const mockOrderSession = { findOne: jest.fn() };
const mockCourierDispatch = { findOne: jest.fn() };
const mockDeliveryTracking = { findOne: jest.fn() };
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockDatabase = {
    transaction: jest.fn(async (callback) => callback(mockTransaction)),
};
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../entities', () => ({
    PaymentTransaction: mockPaymentTransaction,
    Order: mockOrder,
    OrderSession: mockOrderSession,
    CourierDispatch: mockCourierDispatch,
    DeliveryTracking: mockDeliveryTracking,
}));
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockDatabase }));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: () => mockLogger }));
jest.mock('../../payment/bkash-merchant.service', () => ({}));
jest.mock('../../payment/payment.service', () => ({}));
jest.mock('../../order/order-session-standalone.service', () => ({}));
jest.mock('../../order/order.service', () => ({ bookForOrder: jest.fn() }));
jest.mock('../../invoice/chat-invoice.service', () => ({ issueInvoiceForOrder: jest.fn().mockResolvedValue(undefined) }));

const controller = require('../payment-webhook.controller');

function response() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

describe('bKash payment webhook replay protection', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockOrder.findOne.mockResolvedValue({
            id: 'order-1', order_number: 'ORDER-1', shop_id: 'shop-1',
        });
        mockOrderSession.findOne.mockResolvedValue(null);
        mockCourierDispatch.findOne.mockResolvedValue(null);
        mockDeliveryTracking.findOne.mockResolvedValue(null);
    });

    afterEach(() => jest.restoreAllMocks());

    test('does not repeat fulfillment for an already-paid callback', async () => {
        const payment = {
            id: 'payment-1',
            order_id: 'order-1',
            shop_id: 'shop-1',
            status: 'paid',
            update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
                trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1',
                amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ success: true, duplicate: true });
        expect(mockPaymentTransaction.update).not.toHaveBeenCalled();
        expect(fulfillment).not.toHaveBeenCalled();
    });

    test('atomically claims a pending callback before fulfillment', async () => {
        const payment = {
            id: 'payment-1',
            order_id: 'order-1',
            shop_id: 'shop-1',
            amount: '100.00',
            status: 'pending',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        jest.spyOn(controller, 'processSuccessfulPayment').mockResolvedValue(undefined);
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
                trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1',
                amount: '100.00',
            },
        }, res);

        expect(mockPaymentTransaction.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'processing' }),
            expect.objectContaining({ where: expect.objectContaining({ id: 'payment-1' }) }),
        );
        expect(controller.processSuccessfulPayment).toHaveBeenCalledTimes(1);
        expect(controller.processSuccessfulPayment).toHaveBeenCalledWith(payment, expect.objectContaining({
            gatewayResponse: expect.any(Object),
        }));
        expect(payment.update).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('rejects a completed callback whose amount differs from the transaction', async () => {
        const payment = {
            id: 'payment-1',
            order_id: 'order-1',
            shop_id: 'shop-1',
            amount: '100.00',
            status: 'pending',
            update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
                trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1',
                amount: '99.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Payment amount mismatch' });
        expect(mockPaymentTransaction.update).not.toHaveBeenCalled();
        expect(fulfillment).not.toHaveBeenCalled();
    });

    test('losing the atomic claim does not run fulfillment', async () => {
        const payment = {
            id: 'payment-1',
            order_id: 'order-1',
            shop_id: 'shop-1',
            amount: '100.00',
            status: 'pending',
            update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([0]);
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
                trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1',
                amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith({ success: true, pending: true });
        expect(fulfillment).not.toHaveBeenCalled();
    });

    test('rejects a completed callback with a different merchant invoice', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue({
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
        });
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Completed', trxID: 'trx-1',
                merchantInvoiceNumber: 'OTHER-ORDER', amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(mockPaymentTransaction.update).not.toHaveBeenCalled();
    });

    test('returns a failed fulfillment claim to pending for webhook retry', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        jest.spyOn(controller, 'processSuccessfulPayment').mockRejectedValueOnce(new Error('fulfillment failed'));
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Completed', trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(mockPaymentTransaction.update).toHaveBeenLastCalledWith(
            { status: 'pending', gateway_response: expect.any(Object) },
            { where: { id: 'payment-1', status: 'processing' } },
        );
        expect(payment.update).not.toHaveBeenCalled();
    });

    test('a processing callback remains pending and cannot repeat fulfillment', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue({
            id: 'payment-1',
            status: 'processing',
            updated_at: new Date(Date.now() - 60 * 60 * 1000),
            update: jest.fn(),
        });
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
                trxID: 'trx-1',
                amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith({ success: true, pending: true });
        expect(mockPaymentTransaction.update).not.toHaveBeenCalled();
        expect(fulfillment).not.toHaveBeenCalled();
    });

    test('rejects an invalid completed transition', async () => {
        mockPaymentTransaction.findOne.mockResolvedValue({
            id: 'payment-1',
            status: 'rejected',
            update: jest.fn(),
        });
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1',
                transactionStatus: 'Completed',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid payment state transition' });
    });

    test('records a late verified non-COD payment without reopening or rebooking a claimed order', async () => {
        const { bookForOrder } = require('../../order/order.service');
        const order = {
            id: 'order-1',
            shop_id: 'shop-1',
            order_status: 'processing',
            payment_status: 'pending',
            payment_method: 'bkash',
            delivery_status: 'booked',
            metadata: { preserved: true },
            update: jest.fn(async function update(values) { Object.assign(this, values); }),
        };
        const payment = {
            id: 'payment-1',
            shop_id: 'shop-1',
            order_id: 'order-1',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockOrder.findOne.mockResolvedValue(order);
        mockCourierDispatch.findOne.mockResolvedValue({ id: 'dispatch-1', status: 'COMMITTED' });
        jest.spyOn(controller, 'sendPaymentConfirmationToCustomer').mockResolvedValue(undefined);

        await controller.processSuccessfulPayment(payment, { order, gateway: 'bkash', transactionId: 'trx-1' });

        const orderUpdate = order.update.mock.calls[0][0];
        expect(orderUpdate).toEqual(expect.objectContaining({
            payment_status: 'paid',
            payment_method_id: null,
            metadata: expect.objectContaining({
                preserved: true,
                payment_reconciliation: expect.objectContaining({
                    required: true,
                    code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM',
                }),
            }),
        }));
        expect(orderUpdate).not.toHaveProperty('order_status');
        expect(order.order_status).toBe('processing');
        // Terminal receipt status is committed only after fulfillment has
        // been attempted, so a concurrent replay is deduped to 202 while the
        // provider call is still in flight (see courier-race integration).
        expect(payment.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' }));
        expect(bookForOrder).not.toHaveBeenCalled();
        expect(mockOrderSession.findOne).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith('Verified payment requires courier reconciliation', expect.objectContaining({
            eventCode: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM',
            orderId: 'order-1',
            paymentTransactionId: 'payment-1',
        }));
    });

    test('marks an existing COD collection claim for merchant recovery without implying its amount changed', async () => {
        const { bookForOrder } = require('../../order/order.service');
        const order = {
            id: 'order-1', shop_id: 'shop-1', order_status: 'shipped', payment_method: 'cod',
            delivery_status: 'booked', metadata: {}, update: jest.fn(async function update(values) { Object.assign(this, values); }),
        };
        const payment = {
            id: 'payment-2', shop_id: 'shop-1', order_id: 'order-1',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockOrder.findOne.mockResolvedValue(order);
        mockCourierDispatch.findOne.mockResolvedValue({ id: 'dispatch-2', status: 'COMMITTED' });
        jest.spyOn(controller, 'sendPaymentConfirmationToCustomer').mockResolvedValue(undefined);

        await controller.processSuccessfulPayment(payment, { order, gateway: 'bkash', transactionId: 'trx-2' });

        expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
            payment_status: 'paid',
            metadata: expect.objectContaining({
                payment_reconciliation: expect.objectContaining({
                    required: true,
                    code: 'COD_COURIER_COLLECTION_REVIEW_REQUIRED',
                }),
            }),
        }), { transaction: mockTransaction });
        expect(order.order_status).toBe('shipped');
        expect(bookForOrder).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith('Verified payment requires courier reconciliation', expect.objectContaining({
            eventCode: 'COD_COURIER_COLLECTION_REVIEW_REQUIRED',
        }));
    });

    test('preserves an existing reconciliation requirement and never reopens or rebooks that order', async () => {
        const { bookForOrder } = require('../../order/order.service');
        const detectedAt = '2026-11-01T12:00:00.000Z';
        const reconciliation = {
            required: true,
            code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM',
            detected_at: detectedAt,
        };
        const order = {
            id: 'order-1',
            shop_id: 'shop-1',
            order_status: 'pending',
            payment_status: 'pending',
            payment_method: 'bkash',
            delivery_status: null,
            metadata: { payment_reconciliation: reconciliation },
            update: jest.fn(async function update(values) { Object.assign(this, values); }),
        };
        const payment = {
            id: 'payment-4',
            shop_id: 'shop-1',
            order_id: 'order-1',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockOrder.findOne.mockResolvedValue(order);
        jest.spyOn(controller, 'sendPaymentConfirmationToCustomer').mockResolvedValue(undefined);

        await controller.processSuccessfulPayment(payment, { order, gateway: 'bkash', transactionId: 'trx-4' });

        const orderUpdate = order.update.mock.calls[0][0];
        expect(orderUpdate).toEqual(expect.objectContaining({
            payment_status: 'paid',
            metadata: { payment_reconciliation: reconciliation },
        }));
        expect(orderUpdate).not.toHaveProperty('order_status');
        expect(orderUpdate).not.toHaveProperty('delivery_status');
        expect(orderUpdate).not.toHaveProperty('delivery_tracking_code');
        expect(orderUpdate).not.toHaveProperty('delivery_dispatched_at');
        expect(order.order_status).toBe('pending');
        expect(mockOrderSession.findOne).not.toHaveBeenCalled();
        expect(bookForOrder).not.toHaveBeenCalled();
        expect(controller.sendPaymentConfirmationToCustomer).toHaveBeenCalledWith(order, expect.objectContaining({
            reconciliationRequired: true,
        }));
    });

    test('confirms and books only when the verified payment has no prior courier state', async () => {
        const { bookForOrder } = require('../../order/order.service');
        const order = {
            id: 'order-1', shop_id: 'shop-1', order_status: 'pending', payment_method: 'bkash',
            payment_method_id: 'config-1', delivery_status: null, update: jest.fn(async function update(values) { Object.assign(this, values); }),
        };
        const payment = {
            id: 'payment-3', shop_id: 'shop-1', order_id: 'order-1',
            update: jest.fn().mockResolvedValue(undefined),
        };
        bookForOrder.mockRejectedValueOnce(Object.assign(
            new Error('Provider response contains Rahim 01711111111, Mirpur and raw request data'),
            { code: 'UPSTREAM_TIMEOUT' },
        ));
        mockOrder.findOne.mockResolvedValue(order);
        jest.spyOn(controller, 'sendPaymentConfirmationToCustomer').mockResolvedValue(undefined);

        await controller.processSuccessfulPayment(payment, { order, gateway: 'bkash', transactionId: 'trx-3' });

        expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
            payment_status: 'paid',
            order_status: 'confirmed',
        }), { transaction: mockTransaction });
        expect(bookForOrder).toHaveBeenCalledTimes(1);
        // Terminal receipt status is committed only after fulfillment has
        // been attempted, so a concurrent replay is deduped to 202 while the
        // provider call is still in flight (see courier-race integration).
        expect(payment.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' }));
        expect(mockLogger.warn).toHaveBeenCalledWith('Payment-confirmed order was not courier-booked', {
            orderId: 'order-1',
            errorCode: 'UPSTREAM_TIMEOUT',
        });
        const logs = JSON.stringify([...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur');
        expect(logs).not.toContain('raw request data');
    });
});
