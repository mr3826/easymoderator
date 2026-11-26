/**
 * Owner Notification Service
 * Handles multi-channel notifications to shop owners for payment confirmations
 * Supports Facebook Messenger, Email, and Dashboard notifications.
 * WhatsApp removed from product scope 2026-05-20.
 */

const {
    AuditLog,
    CourierDispatch,
    DeliveryTracking,
    Order,
    OwnerNotification,
    PaymentConfig,
    PaymentTransaction,
    Shop,
    User,
    UserShop,
} = require('../entities');
const { sequelize } = require('../../utils/database/database-setup');
const { AppError } = require('../../utils/AppError');
const { sendEmail } = require('../../utils/email.service');
const { createLogger } = require('../../utils/structured-logger');
const { _private: { normalizeGateway } } = require('../payment/payment.service');
const paymentTaxonomy = require('../payment/payment-taxonomy');

// §3.2-4 / D-10: the self-MFS claim state `payment_claimed` joins the
// approvable set. It comes from the single canonical source (payment-taxonomy),
// never a local array. Terminal states (paid/verified/failed/rejected) stay
// rejected here — the existing guards remain byte-for-byte.
const OWNER_APPROVABLE_TRANSACTION_STATUSES = paymentTaxonomy.APPROVABLE_STATUSES;

// §3.3 / D-10 ratified defect correction: payment confirmations expire. The
// column existed (owner-notification.entity.js:55-59) and handleOwnerResponse
// already honored it (→ 410), but nothing ever SET it — the guard was dead.
const PAYMENT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_ORDER_STATUSES = new Set([
    'completed', 'delivered', 'shipped', 'fulfilled', 'cancelled', 'refunded', 'returned', 'partial_returned',
]);
const COD_PAYMENT_METHODS = new Set(['cod', 'cash', 'cash_on_delivery']);

// The confirmation message interpolates customer-controlled text (TrxID,
// message, screenshot URL). Escape once at the HTML boundary — the text/plain
// body stays verbatim for the merchant.
const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isCodPaymentMethod = (paymentMethod) => COD_PAYMENT_METHODS.has(
    String(paymentMethod || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
);

const canonicalPaymentGateway = (gateway) => {
    if (typeof gateway !== 'string' || !gateway.trim()) return null;
    const normalized = normalizeGateway(gateway.trim());
    if (typeof normalized !== 'string' || !normalized.trim()) return null;
    const canonical = normalized.trim().toLowerCase();
    return isCodPaymentMethod(canonical) ? 'cod' : canonical;
};

const resolveApprovalPaymentGateway = async (order, shopId, transaction) => {
    const paymentMethodAlias = String(order.payment_method || '').trim();
    const aliasGateway = paymentMethodAlias ? canonicalPaymentGateway(paymentMethodAlias) : null;
    if (!order.payment_method_id) return aliasGateway;
    if (!PaymentConfig || typeof PaymentConfig.findOne !== 'function') {
        throw new AppError(
            'The order payment method cannot be verified for this shop.',
            503,
            'PAYMENT_METHOD_CONFIGURATION_UNAVAILABLE',
        );
    }

    let paymentConfig;
    try {
        const query = {
            where: { id: order.payment_method_id, shop_id: shopId, is_enabled: true },
            attributes: ['id', 'gateway', 'is_enabled'],
            transaction,
        };
        if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
        paymentConfig = await PaymentConfig.findOne(query);
    } catch (_) {
        throw new AppError(
            'The order payment method cannot be verified for this shop.',
            503,
            'PAYMENT_METHOD_CONFIGURATION_UNAVAILABLE',
        );
    }

    const configuredGateway = canonicalPaymentGateway(paymentConfig?.gateway);
    if (!paymentConfig || paymentConfig.is_enabled !== true || !configuredGateway) {
        throw new AppError(
            'The order payment method is not available for this shop.',
            409,
            'PAYMENT_METHOD_NOT_AVAILABLE',
        );
    }
    if (paymentMethodAlias && (!aliasGateway || aliasGateway !== configuredGateway)) {
        throw new AppError(
            'The order payment method does not match its shop configuration.',
            409,
            'PAYMENT_METHOD_CONFIGURATION_MISMATCH',
        );
    }
    return configuredGateway;
};

class OwnerNotificationService {
    constructor() {
        this.logger = createLogger();
    }

    /**
     * Send payment confirmation request to shop owner
     * Uses all available channels for maximum reach.
     *
     * §3.3 fixes (A4): the row now carries a real expires_at (24 h — the
     * handleOwnerResponse 410 guard is no longer dead), stays non-dismissible
     * (notification.routes.js /read pin), and keeps the merchant's evidence
     * context additive: claim amount, amount kind and the wallet number the
     * customer was shown (from the stamped payment_account_id, §6 — the approve
     * detail reads these, no silent number switching).
     *
     * @returns the created OwnerNotification row (reference) alongside the
     *          channel summary — §3.3 "returns the created row".
     */
    async sendPaymentConfirmationRequest(shopId, orderData, paymentInfo = {}) {
        try {
            // Get shop owner information
            const shopOwner = await this.getShopOwner(shopId);
            if (!shopOwner) {
                throw new AppError('Shop owner not found', 404);
            }

            // Create notification record
            const notification = await this.createNotification({
                shopId,
                type: 'payment_confirmation',
                customerMessage: paymentInfo.customerMessage,
                customerData: {
                    orderId: orderData.id,
                    orderNumber: orderData.order_number,
                    customerName: orderData.customer_name,
                    customerPhone: orderData.customer_phone,
                    amount: orderData.total,
                    paymentMethod: paymentInfo.paymentMethod,
                    transactionId: paymentInfo.transactionId,
                    screenshotUrl: paymentInfo.screenshotUrl,
                    // additive merchant-evidence fields (self-MFS claim flow §3.2):
                    ...(paymentInfo.claim_amount !== undefined && paymentInfo.claim_amount !== null
                        ? { claimAmount: paymentInfo.claim_amount, amountKind: paymentInfo.amount_kind || 'full' }
                        : {}),
                    ...(paymentInfo.amount_mismatch ? { amountMismatch: paymentInfo.amount_mismatch } : {}),
                    ...(paymentInfo.wallet_number ? { walletNumber: paymentInfo.wallet_number } : {}),
                },
                status: 'pending',
                expiresAt: new Date(Date.now() + PAYMENT_CONFIRMATION_TTL_MS),
            });

            // Prepare notification content
            const notificationContent = this.formatPaymentConfirmationMessage(
                orderData, 
                paymentInfo, 
                notification.id
            );

            // Send via all available channels. The dashboard leg is served by
            // the OwnerNotification row itself (§3.3 honesty fix) — pass it in.
            const results = await Promise.allSettled([
                this.sendViaFacebook(shopId, shopOwner, notificationContent),
                this.sendViaEmail(shopOwner, notificationContent),
                this.createDashboardNotification(shopId, notificationContent, notification)
            ]);

            // Log results
            const successfulChannels = results
                .map((result, index) => {
                    const channels = ['facebook', 'email', 'dashboard'];
                    return result.status === 'fulfilled' ? channels[index] : null;
                })
                .filter(Boolean);

            this.logger.info('Payment confirmation request sent', {
                shopId,
                orderId: orderData.id,
                notificationId: notification.id,
                successfulChannels
            });

            return {
                success: true,
                notificationId: notification.id,
                channelsUsed: successfulChannels,
                expiresAt: notification.expires_at || null,
                row: notification, // §3.3: the caller can read the created row back
                message: 'Payment confirmation request sent to shop owner'
            };

        } catch (error) {
            this.logger.error('Failed to send payment confirmation request', {
                shopId,
                orderId: orderData.id,
                error: error.message
            });
            throw new AppError('Failed to send payment confirmation request', 500);
        }
    }

    /**
     * Handle owner's response to payment confirmation
     */
    async handleOwnerResponse(notificationId, response, ownerInfo) {
        if (!['approve', 'reject'].includes(response)) {
            throw new AppError('Invalid payment confirmation action', 400);
        }
        let completedNotification;
        try {
            await sequelize.transaction(async (transaction) => {
                const notification = await OwnerNotification.findByPk(notificationId, {
                    transaction,
                    lock: transaction.LOCK.UPDATE,
                });
                if (!notification) throw new AppError('Notification not found', 404);
                if (notification.type !== 'payment_confirmation') {
                    throw new AppError('Notification is not a payment confirmation', 400);
                }
                if (notification.status !== 'pending') {
                    throw new AppError('Payment confirmation has already been completed', 409);
                }
                if (notification.expires_at && notification.expires_at <= new Date()) {
                    throw new AppError('Payment confirmation has expired', 410);
                }

                const orderId = notification.customer_data?.orderId;
                const transactionId = notification.customer_data?.transactionId;
                const order = await Order.findOne({
                    where: { id: orderId, shop_id: notification.shop_id },
                    transaction,
                    lock: transaction.LOCK.UPDATE,
                });
                if (!order) throw new AppError('Order not found for this shop', 404);
                const orderStatus = String(order.order_status || '').trim().toLowerCase();
                const fulfillmentStatus = String(order.fulfillment_status || '').trim().toLowerCase();
                const deliveryStatus = String(order.delivery_status || '').trim().toLowerCase();
                if (TERMINAL_ORDER_STATUSES.has(orderStatus)
                    || TERMINAL_ORDER_STATUSES.has(fulfillmentStatus)
                    || TERMINAL_ORDER_STATUSES.has(deliveryStatus)
                    || order.delivered_at) {
                    throw new AppError(
                        'Payment confirmation cannot change an order that is already terminal.',
                        409,
                        'ORDER_LIFECYCLE_TERMINAL',
                    );
                }
                if (response === 'approve') {
                    const paymentGateway = await resolveApprovalPaymentGateway(
                        order,
                        notification.shop_id,
                        transaction,
                    );
                    if (isCodPaymentMethod(paymentGateway)) {
                        throw new AppError(
                            'COD settlement must use the owner-confirmed COD payment action after full delivery.',
                            409,
                            'COD_SETTLEMENT_PATH_REQUIRED',
                        );
                    }
                }
                const courierDispatch = CourierDispatch && typeof CourierDispatch.findOne === 'function'
                    ? await CourierDispatch.findOne({
                        where: { order_id: order.id, shop_id: notification.shop_id },
                        transaction,
                        lock: transaction.LOCK.UPDATE,
                    })
                    : null;
                const deliveryTracking = DeliveryTracking && typeof DeliveryTracking.findOne === 'function'
                    ? await DeliveryTracking.findOne({
                        where: { order_id: order.id },
                        transaction,
                        lock: transaction.LOCK.UPDATE,
                    })
                    : null;
                if (courierDispatch || deliveryTracking || order.delivery_consignment_id
                    || order.delivery_tracking_code || order.delivery_dispatched_at) {
                    throw new AppError(
                        'Payment confirmation cannot change order lifecycle after a courier claim. Reconcile payment and courier state through merchant recovery.',
                        409,
                        'COURIER_DISPATCH_RECONCILIATION_REQUIRED',
                    );
                }
                const paymentTransaction = await PaymentTransaction.findOne({
                    where: {
                        order_id: order.id,
                        shop_id: notification.shop_id,
                        transaction_id: transactionId,
                    },
                    transaction,
                    lock: transaction.LOCK.UPDATE,
                });
                if (!paymentTransaction) throw new AppError('Payment transaction not found', 404);
                // §3.2-4: the claim state `payment_claimed` is now part of the
                // approvable set (single source: payment-taxonomy). The rest of
                // this guard chain — terminal order, COD-path, courier-claim and
                // expiry checks above — stays byte-for-byte: settlement evidence
                // remains the merchant's own action on a matched claim.
                if (!OWNER_APPROVABLE_TRANSACTION_STATUSES.includes(paymentTransaction.status)) {
                    throw new AppError('Payment transaction is not awaiting owner confirmation', 409);
                }

                if (response === 'approve') {
                    await order.update({
                        payment_status: 'paid',
                        paid_at: new Date(),
                        order_status: 'confirmed',
                    }, { transaction });
                    await paymentTransaction.update({
                        status: 'verified',
                        verified_at: new Date(),
                    }, { transaction });
                } else {
                    const { cancelOrderInTransaction } = require('../order/order.service');
                    const cancelledOrder = await cancelOrderInTransaction(
                        ownerInfo.userId,
                        notification.shop_id,
                        order.id,
                        'Payment confirmation rejected',
                        transaction,
                    );
                    await cancelledOrder.update({ payment_status: 'failed' }, { transaction });
                    await paymentTransaction.update({ status: 'rejected' }, { transaction });
                }
                await notification.update({
                    owner_response: response,
                    status: 'completed',
                    responded_at: new Date(),
                    owner_info: {
                        user_id: ownerInfo.userId,
                        source: 'authenticated_dashboard',
                    },
                }, { transaction });
                await AuditLog.create({
                    user_id: ownerInfo.userId,
                    shop_id: notification.shop_id,
                    action: `owner_payment_${response}`,
                    resource_type: 'payment_transaction',
                    resource_id: paymentTransaction.id,
                    metadata: {
                        notification_id: notification.id,
                        order_id: order.id,
                    },
                    idempotency_key: `owner-payment:${notification.id}:${response}`,
                }, { transaction });
                completedNotification = notification;
            });

            await this.sendCustomerResponse(completedNotification, response);
            this.logger.info('Owner payment confirmation processed', {
                notificationId,
                response,
                orderId: completedNotification.customer_data.orderId,
            });
            return {
                success: true,
                message: `Payment ${response}d successfully`,
                orderId: completedNotification.customer_data.orderId,
            };
        } catch (error) {
            this.logger.error('Failed to handle owner response', {
                notificationId,
                response,
                error: error.message
            });
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to handle owner response', 500);
        }
    }

    /**
     * Get shop owner information
     */
    async getShopOwner(shopId) {
        const userShop = await UserShop.findOne({
            where: {
                shop_id: shopId,
                role: 'owner',
                is_active: true
            },
            include: [{
                model: User,
                as: 'user',
                attributes: ['id', 'name', 'email', 'phone']
            }]
        });

        return userShop?.user || null;
    }

    /**
     * Create notification record
     */
    async createNotification(data) {
        return await OwnerNotification.create({
            shop_id: data.shopId,
            type: data.type,
            customer_message: data.customerMessage,
            customer_data: data.customerData,
            status: data.status,
            // §3.3 fix: payment confirmations carry a real 24 h expiry so the
            // handleOwnerResponse 410 guard actually applies (D-10 defect pin).
            ...(data.expiresAt ? { expires_at: data.expiresAt } : {}),
            created_at: new Date()
        });
    }

    /**
     * Format payment confirmation message
     *
     * §3.3 crash fix (A4): the delivery-failure misfire used to call this
     * without a paymentMethod and the raw `.toUpperCase()` threw — swallowed
     * only by the caller's try/catch. The label is now null-safe and taken
     * through the payment taxonomy when a raw provider token arrives; a
     * screenshot (when present) is labelled SUPPORTING evidence only, never a
     * confirmation (§0 invariant — OCR/TrxID alone never auto-confirm).
     */
    formatPaymentConfirmationMessage(orderData, paymentInfo = {}, notificationId) {
        const methodLabel = String(
            paymentInfo.paymentMethod
            || paymentTaxonomy.providerLabelSafe(paymentInfo.provider),
        ).toUpperCase();
        const customerMessage = typeof paymentInfo.customerMessage === 'string'
            ? paymentInfo.customerMessage
            : '';
        const claimAmount = Number(paymentInfo.claim_amount);
        const hasClaim = Number.isFinite(claimAmount) && claimAmount > 0;
        const amountLine = hasClaim
            ? `• Claimed payment: ৳${claimAmount}${paymentInfo.amount_kind === 'advance' ? ` (advance — remaining ৳${Math.max((Number(orderData.total) || 0) - claimAmount, 0)})` : ''}`
            : null;
        const mismatchLine = paymentInfo.amount_mismatch
            ? `• ⚠️ AMOUNT MISMATCH — displayed ৳${paymentInfo.amount_mismatch.displayed_amount}, server computed ৳${paymentInfo.amount_mismatch.server_amount}; review before deciding`
            : null;
        const walletLine = paymentInfo.wallet_number
            ? `• Number shown to customer: ${paymentInfo.wallet_number}`
            : null;

        return `💰 পেমেন্ট নিশ্চিতকরণ প্রয়োজন!

📋 অর্ডার তথ্য:
• অর্ডার নম্বর: #${orderData.order_number}
• কাস্টমার: ${orderData.customer_name}
• ফোন: ${orderData.customer_phone}
• পরিমাণ: ৳${orderData.total}${Number.isFinite(claimAmount) && claimAmount > 0 && claimAmount !== Number(orderData.total) ? ` (দাবিকৃত: ৳${claimAmount})` : ''}
• পেমেন্ট পদ্ধতি: ${methodLabel}${paymentInfo.wallet_number ? ` • যে নম্বরে পাঠানো হয়েছে: ${paymentInfo.wallet_number}` : ''}${paymentInfo.amount_mismatch ? `
• ⚠️ পরিমাণ মিলছে না (দেখানো ৳${paymentInfo.amount_mismatch.displayed_amount}, সার্ভার ৳${paymentInfo.amount_mismatch.server_amount}) — যাচাই করে সিদ্ধান্ত নিন` : ''}

💳 পেমেন্ট তথ্য:
• ট্রানজেকশন ID: ${paymentInfo.transactionId}
${customerMessage ? `• কাস্টমার বার্তা: "${customerMessage}"\n` : ''}${paymentInfo.screenshotUrl ? `• স্ক্রিনশট (শুধু সহায়ক প্রমাণ — নিজে মিলিয়ে নিন): ${paymentInfo.screenshotUrl}\n` : ''}
🔘 সিদ্ধান্ত নিন:
নিরাপদ EasyModerator ড্যাশবোর্ড খুলে অনুমোদন বা বাতিল করুন। সময়সীমা: ২৪ ঘণ্টা।

---

💰 Payment Confirmation Required!

📋 Order Details:
• Order Number: #${orderData.order_number}
• Customer: ${orderData.customer_name}
• Phone: ${orderData.customer_phone}
• Amount: ৳${orderData.total}${amountLine ? `\n${amountLine}` : ''}
• Payment Method: ${methodLabel}${walletLine ? ` • ${walletLine}` : ''}${mismatchLine ? `\n${mismatchLine}` : ''}

💳 Payment Info:
• Transaction ID: ${paymentInfo.transactionId}
${customerMessage ? `• Customer Message: "${customerMessage}"\n` : ''}${paymentInfo.screenshotUrl ? `• Screenshot (SUPPORTING EVIDENCE ONLY — verify yourself): ${paymentInfo.screenshotUrl}\n` : ''}
🔘 Make Decision:
Open the authenticated EasyModerator dashboard to approve or reject. Expires within 24 hours.

Reference: ${notificationId}`;
    }

    /**
     * Send notification via Facebook Messenger
     */
    async sendViaFacebook(shopId, owner, message) {
        // Delivering an owner (merchant) notification over Messenger would require
        // the owner's Meta PSID — which we do not have; `owner` is a merchant User,
        // not a Meta customer, and `owner.phone` is a phone number the Graph API
        // does not accept as a recipient. Owners are reliably reached via email and
        // web push (see sendViaEmail / push), so this channel is intentionally a
        // no-op rather than an undeliverable send. (Previously this looked up an
        // undefined `Channel` model and threw on every call.)
        return { success: false, reason: 'fb_owner_unsupported' };
    }

    /**
     * Send notification via Email
     */
    async sendViaEmail(owner, message) {
        try {
            if (!owner.email) {
                return { success: false, reason: 'no_email' };
            }

            const subject = '🔔 Payment Confirmation Required - EasyModerator';
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 10px;">
                        <h2 style="color: #333; margin-bottom: 20px;">💰 Payment Confirmation Required</h2>
                        <div style="background-color: white; padding: 20px; border-radius: 8px; white-space: pre-wrap;">${escapeHtml(message)}</div>
                        <p style="margin-top: 20px; font-size: 12px; color: #666;">
                            Open the authenticated EasyModerator dashboard to approve or reject the payment.
                        </p>
                    </div>
                </div>
            `;

            await sendEmail({
                to: owner.email,
                subject,
                text: message,
                html
            });

            return { success: true, channel: 'email' };

        } catch (error) {
            this.logger.warn('Email notification failed', {
                email: owner.email,
                error: error.message
            });
            return { success: false, reason: 'send_error', error: error.message };
        }
    }

    /**
     * "Dashboard" leg of a payment confirmation — §3.3 honesty fix (A4).
     *
     * This method creates nothing; until now it logged "Dashboard notification
     * created" and reported success anyway — misleading. The dashboard surface
     * IS the OwnerNotification row created above (read by the merchant app at
     * GET /api/notifications/in-app; notification.routes.js keeps
     * payment_confirmation rows non-dismissible). So this leg reports exactly
     * that truth instead of inventing a second channel.
     */
    async createDashboardNotification(shopId, message, notificationRow = null) {
        try {
            this.logger.info('Dashboard surface served by OwnerNotification row', {
                shopId,
                notificationId: notificationRow?.id || null,
                // The row — not this call — is the dashboard notification.
                mode: 'owner_notification_row',
            });

            return {
                success: Boolean(notificationRow),
                channel: 'dashboard',
                mode: 'owner_notification_row',
                queued: Boolean(notificationRow),
                detail: notificationRow
                    ? 'Merchant sees this in the dashboard inbox via /api/notifications/in-app'
                    : 'No OwnerNotification row — nothing queued',
            };
        } catch (error) {
            this.logger.warn('Dashboard notification leg failed', {
                shopId,
                error: error.message
            });
            return { success: false, reason: 'no_row', error: error.message };
        }
    }

    /**
     * Send response back to customer
     */
    async sendCustomerResponse(notification, response) {
        try {
            const customerMessage = response === 'approve' 
                ? `✅ আপনার পেমেন্ট নিশ্চিত হয়েছে! অর্ডার #${notification.customer_data.orderNumber} নিশ্চিত করা হয়েছে। ডেলিভারি প্রক্রিয়া শুরু হবে।\n\n✅ Your payment has been confirmed! Order #${notification.customer_data.orderNumber} is confirmed. Delivery process will start.`
                : `❌ আপনার পেমেন্ট নিশ্চিত করা হয়নি। অনুগ্রহ করে আবার চেষ্টা করুন বা দোকানের সাথে যোগাযোগ করুন।\n\n❌ Your payment could not be confirmed. Please try again or contact the shop.`;

            // Resolve the order's customer and send to their PSID. (The old code
            // looked up an undefined `Channel` model and passed a phone number as
            // the Meta recipient, so this confirmation silently never reached the
            // customer.)
            const orderId = notification.customer_data?.orderId;
            if (!orderId) {
                this.logger.info('No orderId on notification — cannot send customer response', {
                    notificationId: notification.id
                });
                return;
            }
            const { Order } = require('../entities');
            const order = await Order.findOne({ where: { id: orderId, shop_id: notification.shop_id } });
            if (!order || !order.customer_id) {
                this.logger.info('No customer linked to order — skipping customer response', {
                    notificationId: notification.id
                });
                return;
            }
            const webhookService = require('../webhook/webhook.service');
            await webhookService.sendToCustomer({
                shopId: notification.shop_id,
                customerId: order.customer_id,
                message: customerMessage,
            });

        } catch (error) {
            this.logger.warn('Failed to send customer response', {
                notificationId: notification.id,
                response,
                error: error.message
            });
        }
    }

    /**
     * Get pending notifications for shop
     */
    async getPendingNotifications(shopId, limit = 10) {
        return await OwnerNotification.findAll({
            where: {
                shop_id: shopId,
                status: 'pending'
            },
            order: [['created_at', 'DESC']],
            limit
        });
    }

    /**
     * Get notification by ID
     */
    async getNotificationById(notificationId, shopId) {
        const notification = await OwnerNotification.findOne({
            where: {
                id: notificationId,
                shop_id: shopId
            }
        });

        if (!notification) {
            throw new AppError('Notification not found', 404);
        }

        return notification;
    }
}

module.exports = new OwnerNotificationService();
