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

// ── contract-mock seam for the v2 client (§4.2 / R-12) ──────────────────────
// These fixtures are derived from the OFFICIAL bKash Tokenized v2 docs sweep
// (contract §4: query → transactionStatus + verificationStatus + merchantInvoice)
// and are labeled contract-mock: NOTHING here is, or may be presented as,
// live-provider-verified.
const mockQuerySettlementEvidence = jest.fn();
const mockEvaluateSettlement = jest.fn();
const completedQuery = (over = {}) => ({
    // contract-mock: official query/payment response shape
    paymentID: 'gateway-payment-1',
    transactionStatus: 'Completed',
    verificationStatus: 'VERIFIED',
    merchantInvoice: 'ORDER-1',
    amount: '100.00',
    trxID: 'trx-from-query-9',
    ...over,
});
// faithful re-implementation of the §4.2 guards so a broken guard fails:
const realEvaluate = (query, { expectedOrderNumber, expectedAmountMinor }) => {
    const settled = String(query?.transactionStatus || '').toUpperCase() === 'COMPLETED';
    const verificationOk = String(query?.verificationStatus || '').toUpperCase() === 'VERIFIED';
    const invoiceOk = Boolean(expectedOrderNumber) && String(query?.merchantInvoice || '') === String(expectedOrderNumber);
    const amountMinor = query?.amount != null ? Math.round(Number(query.amount) * 100) : null;
    const amountOk = amountMinor !== null && expectedAmountMinor !== null
        && BigInt(amountMinor) === BigInt(expectedAmountMinor);
    return {
        settled, verificationOk, invoiceOk, amountOk,
        confirmed: settled && verificationOk && invoiceOk && amountOk,
        trxId: query?.trxID || query?.trxId || null,
        canonical: settled ? 'paid' : String(query?.transactionStatus || '').toLowerCase(),
        providerStatus: String(query?.transactionStatus || '').toLowerCase() || 'unknown',
    };
};

jest.mock('../../entities', () => ({
    PaymentTransaction: mockPaymentTransaction,
    Order: mockOrder,
    OrderSession: mockOrderSession,
    CourierDispatch: mockCourierDispatch,
    DeliveryTracking: mockDeliveryTracking,
}));
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockDatabase }));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: () => mockLogger }));
jest.mock('../../payment/bkash-tokenized.service', () => ({
    querySettlementEvidence: (...args) => mockQuerySettlementEvidence(...args),
    evaluateSettlement: (...args) => mockEvaluateSettlement(...args),
}));
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
        // default: the provider Query confirms settlement
        mockQuerySettlementEvidence.mockResolvedValue({ available: true, query: completedQuery() });
        mockEvaluateSettlement.mockImplementation(realEvaluate);
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
        expect(mockQuerySettlementEvidence).not.toHaveBeenCalled();
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

    // ── §4.2 required new tests: server-side Query before settle ─────────────
    test('confirmation performs a server-side Query BEFORE any fulfillment (§4.2)', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        const callOrder = [];
        mockQuerySettlementEvidence.mockImplementation(async (txn) => {
            callOrder.push('query');
            return { available: true, query: completedQuery({ trxID: 'TRX-FROM-QUERY', amount: '100.00' }) };
        });
        jest.spyOn(controller, 'processSuccessfulPayment').mockImplementation(async () => { callOrder.push('settle'); });
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'COMPLETED', trxID: 'trx-body-1',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(callOrder).toEqual(['query', 'settle']);
        // The settled transaction id is the QUERY's, never the body's (§4.2):
        expect(controller.processSuccessfulPayment).toHaveBeenCalledWith(payment, expect.objectContaining({
            transactionId: 'TRX-FROM-QUERY',
        }));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('a completed body claim alone NEVER settles when no Query is available (R-12)', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            gateway_response: {}, update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        mockQuerySettlementEvidence.mockResolvedValue({ available: false, reason: 'automation_inert' });
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Completed', trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(fulfillment).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true, pending: true, verification: 'query_unavailable', reason: 'automation_inert',
        }));
        // claim released back to pending for reconciliation (§4.2 error path):
        expect(mockPaymentTransaction.update).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'pending' }),
            { where: { id: 'payment-1', status: 'processing' } },
        );
    });

    test('a Query that is not confirmed releases the claim instead of settling', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            gateway_response: {}, update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        mockQuerySettlementEvidence.mockResolvedValue({
            available: true,
            query: completedQuery({ transactionStatus: 'Pending', verificationStatus: null, trxID: null }),
        });
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Completed', trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(fulfillment).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ verification: 'query_unconfirmed' }));
        expect(mockPaymentTransaction.update).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'pending' }),
            { where: { id: 'payment-1', status: 'processing' } },
        );
    });

    test('a Query whose invoice echo mismatches does not settle even when Completed', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            gateway_response: {}, update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        mockQuerySettlementEvidence.mockResolvedValue({ available: true, query: completedQuery({ merchantInvoice: 'SOMETHING-ELSE' }) });
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');

        const res = response();
        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Completed', trxID: 'trx-1',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(fulfillment).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(202);
    });

    test('a failure callback flips to failed ONLY when the provider Query says so', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            gateway_response: {}, update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockPaymentTransaction.update.mockResolvedValue([1]);
        mockQuerySettlementEvidence.mockResolvedValue({
            available: true,
            query: completedQuery({ transactionStatus: 'Failed', verificationStatus: null, merchantInvoice: 'ORDER-1', trxID: null }),
        });
        const fulfillment = jest.spyOn(controller, 'processSuccessfulPayment');
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Failed',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(fulfillment).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', verified_by: 'server_query' }));
        expect(mockPaymentTransaction.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed' }),
            expect.objectContaining({ where: expect.objectContaining({ id: 'payment-1' }) }),
        );
    });

    test('a failure callback defers (no failed write) while the Query is unavailable', async () => {
        const payment = {
            id: 'payment-1', order_id: 'order-1', shop_id: 'shop-1', amount: '100.00', status: 'pending',
            gateway_response: {}, update: jest.fn(),
        };
        mockPaymentTransaction.findOne.mockResolvedValue(payment);
        mockQuerySettlementEvidence.mockResolvedValue({ available: false, reason: 'gateway_disabled' });
        const res = response();

        await controller.handleBkashWebhook({
            body: {
                paymentID: 'gateway-payment-1', transactionStatus: 'Cancelled',
                merchantInvoiceNumber: 'ORDER-1', amount: '100.00',
            },
        }, res);

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ verification: 'query_unavailable' }));
        expect(mockPaymentTransaction.update).not.toHaveBeenCalled();
    });

    test('rejects a callback without a payment id', async () => {
        const res = response();
        await controller.handleBkashWebhook({ body: { transactionStatus: 'Completed' } }, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(mockPaymentTransaction.findOne).not.toHaveBeenCalled();
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

    // DC-2 lock (A7, 2026-11-23): webhook processing must not touch order
    // sessions AT ALL. The removed payment-webhook block looked up an ACTIVE
    // OrderSession only to call OrderSessionService.autoConfirmOrder — a
    // method no provider in this repo defines, so the block was a silent
    // typeof-guarded no-op whose only effect was a pointless DB read. This
    // test makes any reintroduction fail loudly: a session is deliberately
    // findable (findOne resolves an ACTIVE row), so if the webhook queries or
    // mutates it again — even through a new auto-confirm helper — these
    // assertions catch it. Session completion/expiry stays owned by the 24h
    // expires_at TTL in order-session-standalone.service.js.
    test('a verified payment performs no order-session lookup or mutation (DC-2 lock)', async () => {
        const { bookForOrder } = require('../../order/order.service');
        const activeSession = {
            id: 'session-1',
            status: 'ACTIVE',
            update: jest.fn(),
            save: jest.fn(),
        };
        const order = {
            id: 'order-1', shop_id: 'shop-1', customer_id: 'customer-1',
            order_status: 'pending', payment_method: 'bkash',
            delivery_status: null, update: jest.fn(async function update(values) { Object.assign(this, values); }),
        };
        const payment = {
            id: 'payment-5', shop_id: 'shop-1', order_id: 'order-1',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockOrder.findOne.mockResolvedValue(order);
        mockOrderSession.findOne.mockResolvedValue(activeSession);
        bookForOrder.mockResolvedValueOnce({ booked: true });
        jest.spyOn(controller, 'sendPaymentConfirmationToCustomer').mockResolvedValue(undefined);

        await controller.processSuccessfulPayment(payment, { order, gateway: 'bkash', transactionId: 'trx-5' });

        // The clean payment path still confirmed and booked the order — the
        // webhook works — but never consulted or mutated the session.
        expect(order.update).toHaveBeenCalledWith(expect.objectContaining({
            payment_status: 'paid',
            order_status: 'confirmed',
        }), { transaction: mockTransaction });
        expect(bookForOrder).toHaveBeenCalledTimes(1);
        expect(mockOrderSession.findOne).not.toHaveBeenCalled();
        expect(activeSession.update).not.toHaveBeenCalled();
        expect(activeSession.save).not.toHaveBeenCalled();
    });
});
