/**
 * Payment Webhook Controller
 * Handles webhook callbacks from bKash.
 * Updates payment status and triggers order confirmation.
 */

const { PaymentTransaction, Order, OrderSession, CourierDispatch, DeliveryTracking } = require('../entities');
const { Op } = require('sequelize');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { createLogger } = require('../../utils/structured-logger');
const bkashService = require('../payment/bkash-merchant.service');
const paymentService = require('../payment/payment.service');
const OrderSessionService = require('../order/order-session-standalone.service');

const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'PAYMENT_WEBHOOK_ERROR';
};
const normalizeSettings = (value) => {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

function normalizeAmountToMinorUnits(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

class PaymentWebhookController {
    constructor() {
        this.logger = createLogger();
    }

    /**
     * Handle bKash payment status webhook
     */
    async handleBkashWebhook(req, res) {
        try {
            const { paymentID, transactionStatus, trxID, merchantInvoiceNumber, amount } = req.body;

            // Find payment transaction
            const paymentTransaction = await PaymentTransaction.findOne({
                where: { transaction_id: paymentID }
            });

            if (!paymentTransaction) {
                return res.status(404).json({ error: 'Payment transaction not found' });
            }

            // If payment successful, update order and trigger fulfillment
            if (transactionStatus === 'Completed') {
                if (['paid', 'verified'].includes(paymentTransaction.status)) {
                    return res.status(200).json({ success: true, duplicate: true });
                }

                if (paymentTransaction.status === 'processing') {
                    return res.status(202).json({ success: true, pending: true });
                }

                const claimableStatuses = ['pending', 'initiated', 'failed'];
                if (!claimableStatuses.includes(paymentTransaction.status)) {
                    return res.status(409).json({ error: 'Invalid payment state transition' });
                }
                if (!paymentTransaction.order_id || !paymentTransaction.shop_id) {
                    return res.status(409).json({ error: 'Payment tenant binding is incomplete' });
                }

                const paymentOrder = await Order.findOne({
                    where: {
                        id: paymentTransaction.order_id,
                        ...(paymentTransaction.shop_id ? { shop_id: paymentTransaction.shop_id } : {}),
                    },
                });
                if (!paymentOrder) {
                    return res.status(409).json({ error: 'Payment order could not be verified' });
                }
                if (!merchantInvoiceNumber || String(merchantInvoiceNumber) !== String(paymentOrder.order_number)) {
                    return res.status(400).json({ error: 'Payment invoice mismatch' });
                }
                if (!trxID) {
                    return res.status(400).json({ error: 'Payment transaction ID is required' });
                }

                const expectedAmount = normalizeAmountToMinorUnits(paymentTransaction.amount);
                const providerAmount = normalizeAmountToMinorUnits(amount);
                if (expectedAmount === null || providerAmount === null || expectedAmount !== providerAmount) {
                    this.logger.warn('bKash webhook amount mismatch', {
                        paymentTransactionId: paymentTransaction.id,
                        errorCode: 'PAYMENT_AMOUNT_MISMATCH',
                    });
                    return res.status(400).json({ error: 'Payment amount mismatch' });
                }

                // Claim the callback atomically. Concurrent/replayed callbacks cannot
                // execute order fulfillment, delivery booking, or notifications twice.
                const [claimed] = await PaymentTransaction.update({
                    status: 'processing',
                    gateway_response: req.body
                }, {
                    where: {
                        id: paymentTransaction.id,
                        status: { [Op.in]: claimableStatuses }
                    }
                });

                if (claimed !== 1) {
                    return res.status(202).json({ success: true, pending: true });
                }

                try {
                    await this.processSuccessfulPayment(paymentTransaction, {
                        gateway: 'bkash',
                        transactionId: trxID,
                        amount,
                        order: paymentOrder,
                        gatewayResponse: req.body,
                        mutationAuthority: {
                            kind: 'system',
                            source: 'payment_webhook',
                            signatureVerified: req.webhookSignatureVerified === true,
                            eventId: req.webhookEventId || String(paymentID || trxID || merchantInvoiceNumber || ''),
                        },
                    });
                } catch (processingError) {
                    // A claimed callback must remain retryable if fulfillment
                    // fails. Order and courier paths are independently idempotent.
                    await PaymentTransaction.update({
                        status: 'pending',
                        gateway_response: req.body,
                    }, {
                        where: { id: paymentTransaction.id, status: 'processing' },
                    });
                    throw processingError;
                }

            } else {
                // A late failure callback must never downgrade a completed payment.
                if (['paid', 'verified', 'processing'].includes(paymentTransaction.status)) {
                    return res.status(200).json({ success: true, duplicate: true });
                }

                if (['pending', 'initiated', 'failed'].includes(paymentTransaction.status)) {
                    if (!paymentTransaction.order_id || !paymentTransaction.shop_id) {
                        return res.status(409).json({ error: 'Payment tenant binding is incomplete' });
                    }
                    const paymentOrder = await Order.findOne({
                        where: { id: paymentTransaction.order_id, shop_id: paymentTransaction.shop_id },
                    });
                    if (!paymentOrder) return res.status(409).json({ error: 'Payment order could not be verified' });
                    if (!merchantInvoiceNumber || String(merchantInvoiceNumber) !== String(paymentOrder.order_number)) {
                        return res.status(400).json({ error: 'Payment invoice mismatch' });
                    }
                }

                await PaymentTransaction.update({
                    status: 'failed',
                    gateway_response: req.body,
                    verified_at: null
                }, {
                    where: {
                        id: paymentTransaction.id,
                        status: { [Op.notIn]: ['paid', 'verified', 'processing'] }
                    }
                });
            }

            res.status(200).json({ success: true });

        } catch (error) {
            this.logger.error('bKash webhook error', { errorCode: safeErrorCode(error) });
            res.status(500).json({ error: 'Webhook processing failed' });
        }
    }

    /**
     * Process successful payment and trigger order fulfillment
     */
    async processSuccessfulPayment(paymentTransaction, paymentInfo) {
        try {
            let order = paymentInfo.order || null;

            if (!order && paymentTransaction) {
                // Find order by payment transaction
                order = await Order.findOne({
                    where: {
                        id: paymentTransaction.order_id,
                        ...(paymentTransaction.shop_id ? { shop_id: paymentTransaction.shop_id } : {}),
                    }
                });
            }

            if (!order) {
                this.logger.error('Order not found for successful payment');
                throw new Error('Order not found for successful payment');
            }
            if (paymentTransaction?.shop_id
                && String(paymentTransaction.shop_id) !== String(order.shop_id)) {
                throw new AppError('Payment and order belong to different shops', 403, 'TENANT_MISMATCH');
            }

            const database = Order.sequelize?.transaction ? Order.sequelize : sequelize;
            const paymentState = await database.transaction(async (transaction) => {
                const orderQuery = {
                    where: { id: order.id, shop_id: order.shop_id },
                    transaction,
                };
                if (transaction?.LOCK?.UPDATE) orderQuery.lock = transaction.LOCK.UPDATE;
                const currentOrder = await Order.findOne(orderQuery);
                if (!currentOrder) throw new AppError('Order not found for successful payment', 404, 'PAYMENT_ORDER_NOT_FOUND');

                const lockOptions = transaction?.LOCK?.UPDATE ? { transaction, lock: transaction.LOCK.UPDATE } : { transaction };
                const dispatch = CourierDispatch && typeof CourierDispatch.findOne === 'function'
                    ? await CourierDispatch.findOne({
                        where: { order_id: currentOrder.id, shop_id: currentOrder.shop_id },
                        ...lockOptions,
                    })
                    : null;
                const tracking = DeliveryTracking && typeof DeliveryTracking.findOne === 'function'
                    ? await DeliveryTracking.findOne({ where: { order_id: currentOrder.id }, ...lockOptions })
                    : null;
                const deliveryStatus = String(currentOrder.delivery_status || '').trim().toLowerCase();
                const providerStateExists = Boolean(
                    dispatch
                    || tracking
                    || currentOrder.delivery_tracking_code
                    || currentOrder.delivery_consignment_id
                    || currentOrder.delivery_dispatched_at
                    || (deliveryStatus && !['unfulfilled', 'not_booked', 'courier_setup_required', 'confidence_hold'].includes(deliveryStatus))
                );
                const lifecycleStatus = String(currentOrder.order_status || '').trim().toLowerCase();
                const terminalLifecycle = ['completed', 'delivered', 'fulfilled', 'cancelled', 'returned', 'refunded']
                    .includes(lifecycleStatus);
                const orderMetadata = normalizeSettings(currentOrder.metadata);
                const existingReconciliation = normalizeSettings(orderMetadata.payment_reconciliation);
                const requiresReconciliation = providerStateExists
                    || terminalLifecycle
                    || existingReconciliation.required === true;
                const paymentMethod = String(currentOrder.payment_method || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
                const reconciliationCode = providerStateExists
                    ? (['cod', 'cash', 'cash_on_delivery'].includes(paymentMethod)
                        ? 'COD_COURIER_COLLECTION_REVIEW_REQUIRED'
                        : 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM')
                    : terminalLifecycle
                        ? 'PAYMENT_VERIFIED_AFTER_TERMINAL_ORDER_STATE'
                        : existingReconciliation.code || null;
                const orderUpdates = {
                    payment_status: 'paid',
                    paid_at: new Date(),
                    // This is a local payment_configs FK, not the gateway transaction ID.
                    payment_method_id: paymentInfo.paymentConfigId || currentOrder.payment_method_id || null,
                };
                if (!requiresReconciliation && ['draft', 'pending', 'placed'].includes(lifecycleStatus)) {
                    orderUpdates.order_status = 'confirmed';
                }
                if (requiresReconciliation) {
                    orderUpdates.metadata = {
                        ...orderMetadata,
                        payment_reconciliation: {
                            ...existingReconciliation,
                            required: true,
                            code: reconciliationCode,
                            detected_at: existingReconciliation.detected_at || new Date().toISOString(),
                        },
                    };
                }
                await currentOrder.update(orderUpdates, { transaction });
                // NOTE: paymentTransaction.status is deliberately NOT set to
                // 'paid' here. The gateway receipt is only terminal once
                // fulfillment has been attempted; committing 'paid' before the
                // courier booking let a concurrent replay observe a terminal
                // status and receive 200 while booking was still in flight.
                return { order: currentOrder, providerStateExists, requiresReconciliation, reconciliationCode };
            });
            order = paymentState.order;

            if (paymentState.reconciliationCode) {
                this.logger.warn('Verified payment requires courier reconciliation', {
                    eventCode: paymentState.reconciliationCode,
                    orderId: order.id,
                    paymentTransactionId: paymentTransaction?.id || null,
                });
            }

            // Check if there's an active order session to complete
            const activeSession = !paymentState.requiresReconciliation && OrderSession && typeof OrderSession.findOne === 'function'
                ? await OrderSession.findOne({
                    where: {
                        shop_id: order.shop_id,
                        customer_id: order.customer_id,
                        status: 'ACTIVE'
                    },
                    order: [['last_activity_at', 'DESC']]
                })
                : null;

            if (activeSession) {
                // Older deployments do not expose a session auto-confirm
                // method. Payment fulfilment must continue without turning that
                // compatibility gap into a failed order/payment webhook.
                if (typeof OrderSessionService.autoConfirmOrder === 'function') {
                    try {
                        await OrderSessionService.autoConfirmOrder(activeSession);
                    } catch (error) {
                        this.logger.warn('Payment order session confirmation deferred', {
                            orderId: order.id,
                            errorCode: safeErrorCode(error),
                        });
                    }
                }
            }

            // Trigger invoice generation. chat-invoice, NOT the legacy
            // invoice.service: that one requires puppeteer at module load, which
            // is absent from the production image — the require alone would throw
            // and abort delivery booking + customer confirmation below.
            const { issueInvoiceForOrder } = require('../invoice/chat-invoice.service');
            await issueInvoiceForOrder(order).catch(err =>
                this.logger.warn('Invoice generation failed (continuing fulfillment)', { errorCode: safeErrorCode(err) }));

            if (!paymentState.requiresReconciliation) {
                const orderService = require('../order/order.service');
                try {
                    const booking = typeof orderService.bookForOrder === 'function'
                        ? await orderService.bookForOrder(order, {
                            shopId: order.shop_id,
                            requireAiDefault: true,
                            throwOnError: false,
                            mutationAuthority: paymentInfo.mutationAuthority,
                            stepData: {
                                name: order.customer_name,
                                phone: order.customer_phone,
                                address: order.delivery_address,
                                notes: order.note || order.notes || null,
                            },
                        })
                        : { failed: true };
                    if (booking?.blocked || booking?.failed) {
                        this.logger.warn('Payment-confirmed order was not courier-booked', {
                            orderId: order.id,
                            errorCode: safeErrorCode({ code: booking.code }),
                        });
                    }
                } catch (error) {
                    this.logger.warn('Payment-confirmed order was not courier-booked', {
                        orderId: order.id,
                        errorCode: safeErrorCode(error),
                    });
                }
            }

            // The gateway receipt becomes terminal only now that fulfillment
            // has been attempted. Until this point the transaction row stays
            // 'processing', so a concurrent replay is deduped to 202 rather
            // than observing a premature 'paid' and returning 200.
            if (typeof paymentTransaction?.update === 'function') {
                await paymentTransaction.update({
                    status: 'paid',
                    verified_at: new Date(),
                    ...(paymentInfo.gatewayResponse ? { gateway_response: paymentInfo.gatewayResponse } : {}),
                });
            }

            // Send confirmation to customer
            await this.sendPaymentConfirmationToCustomer(order, {
                ...paymentInfo,
                reconciliationRequired: paymentState.requiresReconciliation,
            });

            this.logger.info('Verified payment recorded', {
                orderId: order.id,
                paymentTransactionId: paymentTransaction?.id || null,
                reconciliationRequired: paymentState.requiresReconciliation,
            });

        } catch (error) {
            this.logger.error('Failed to process successful payment', {
                orderId: paymentInfo.order?.id || null,
                paymentTransactionId: paymentTransaction?.id || null,
                errorCode: safeErrorCode(error),
            });
            throw error;
        }
    }

    /**
     * Send payment confirmation to customer
     */
    async sendPaymentConfirmationToCustomer(order, paymentInfo) {
        try {
            const webhookService = require('../webhook/webhook.service');
            const fulfillmentNoticeBn = paymentInfo.reconciliationRequired
                ? 'পেমেন্ট ও ডেলিভারি তথ্য আমাদের টিম যাচাই করবে।'
                : 'আপনার অর্ডার নিশ্চিত হয়েছে এবং ডেলিভারি প্রক্রিয়া শুরু হবে।';
            const fulfillmentNoticeEn = paymentInfo.reconciliationRequired
                ? 'Our team will reconcile the payment and delivery records.'
                : 'Your order is confirmed and the delivery process will start.';

            const confirmationMessage = `✅ পেমেন্ট সফলভাবে সম্পন্ন হয়েছে!

📋 অর্ডার নম্বর: #${order.order_number}
💰 পরিমাণ: ৳${order.total}
💳 পেমেন্ট পদ্ধতি: ${paymentInfo.gateway.toUpperCase()}
🔗 ট্রানজেকশন ID: ${paymentInfo.transactionId}

${fulfillmentNoticeBn}

---

✅ Payment completed successfully!

📋 Order Number: #${order.order_number}
💰 Amount: ৳${order.total}
💳 Payment Method: ${paymentInfo.gateway.toUpperCase()}
🔗 Transaction ID: ${paymentInfo.transactionId}

${fulfillmentNoticeEn}`;

            // Resolve the customer's PSID from the order and send via the live
            // provider. (The old code passed `order.customer_id` — the internal
            // Customer UUID — or a phone number as the Meta recipient, neither of
            // which the Graph API accepts, so confirmations silently never sent.)
            if (!order.customer_id) {
                this.logger.warn('No customer linked to order for payment confirmation', { orderId: order.id });
                return;
            }
            const result = await webhookService.sendToCustomer({
                shopId: order.shop_id,
                customerId: order.customer_id,
                message: confirmationMessage,
            });
            if (!result.sent) {
                this.logger.info('Payment confirmation not delivered', {
                    orderId: order.id,
                    errorCode: 'PAYMENT_CONFIRMATION_NOT_DELIVERED',
                });
            }

        } catch (error) {
            this.logger.error('Failed to send payment confirmation', {
                orderId: order?.id || null,
                errorCode: safeErrorCode(error),
            });
        }
    }

    /**
     * Handle owner payment confirmation webhook
     */
    async handleOwnerPaymentConfirmation(req, res) {
        try {
            const { notificationId, action } = req.params;
            const ownerInfo = req.body;

            this.logger.info('Owner payment confirmation', {
                notificationId,
                action,
            });

            const ownerNotificationService = require('../notification/owner-notification.service');
            const result = await ownerNotificationService.handleOwnerResponse(
                notificationId,
                action,
                ownerInfo
            );

            res.status(200).json(result);

        } catch (error) {
            this.logger.error('Owner payment confirmation error', { errorCode: safeErrorCode(error) });
            res.status(500).json({ error: 'Processing failed' });
        }
    }
}

module.exports = new PaymentWebhookController();
