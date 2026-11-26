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
// column existed (owner-notification.entity.js:55-59) but nothing ever SET it.
// F3/D-4 (2026-11-26 RATIFIED): expiry is a SURFACE, never a dead end — past
// expires_at the row/list status is honestly marked 'expired' (the missing
// writer, idempotent + append-only-safe) and approve/reject REMAIN functional:
// the merchant's judgment outranks the SLA. The blanket 410 is removed.
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
     * expiry SURFACE is no longer dead: past it, the row/list reads 'expired'
     * and handleOwnerResponse keeps approve/reject functional, F3/D-4), stays
     * non-dismissible (notification.routes.js /read pin), and keeps the
     * merchant's evidence context additive: claim amount, amount kind/basis
     * (the F1 machine field the merchant UI renders copy against) and the
     * wallet number the customer was shown (from the stamped
     * payment_account_id, §6 — the approve detail reads these, no silent
     * number switching).
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
                        ? {
                            claimAmount: paymentInfo.claim_amount,
                            amountKind: paymentInfo.amount_kind || 'full',
                            // F1 machine field (copy keys are FE-owned): 'full'
                            // = this claim settles the ENTIRE order total.
                            ...(paymentInfo.amount_basis
                                ? { amountBasis: paymentInfo.amount_basis } : {}),
                            ...(paymentInfo.policy_advance !== undefined
                                ? { policyAdvance: Boolean(paymentInfo.policy_advance) } : {}),
                        }
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
        let duplicateRejectOnSettledOrder = false;
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
                // F3/D-4 (2026-11-26): 'expired' is a surfaced state, not a
                // dead end — owner judgment outranks the SLA, so both
                // 'pending' and 'expired' rows remain actionable. Anything
                // else (completed) stays 409-rejected: no double settlement.
                if (!['pending', 'expired'].includes(notification.status)) {
                    throw new AppError('Payment confirmation has already been completed', 409);
                }
                const pastExpiry = Boolean(
                    notification.expires_at && new Date(notification.expires_at) <= new Date(),
                );
                if (pastExpiry && notification.status === 'pending') {
                    // Missing writer, done here idempotently (pending →
                    // expired only; completed rows are never rewritten).
                    await notification.update({ status: 'expired' }, { transaction });
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
                    // B1(b) (A9-R3 money-integrity, 2026-11-26): an order whose
                    // payment is ALREADY settled can never be re-settled by
                    // approving a second claim — the txn-status guard below
                    // only looks at THIS notification's row, so a different
                    // still-`payment_claimed` row for the same order would
                    // otherwise re-fire paid/paid_at/confirmed, mint a second
                    // verified transaction and send the customer a SECOND
                    // "payment confirmed" message. Guard sits on the LOCKED
                    // order row, before any write in this transaction.
                    const orderPaymentState = String(order.payment_status || '').trim().toLowerCase();
                    if (orderPaymentState === 'paid') {
                        throw new AppError(
                            'This order is already settled as paid — approving another claim would double-settle it. '
                            + 'Reject this claim or reconcile the duplicate payment with the customer.',
                            409,
                            'ALREADY_SETTLED',
                        );
                    }
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
                // this guard chain — terminal order, COD-path and courier-claim
                // checks above — stays byte-for-byte: settlement evidence
                // remains the merchant's own action on a matched claim.
                if (!OWNER_APPROVABLE_TRANSACTION_STATUSES.includes(paymentTransaction.status)) {
                    throw new AppError('Payment transaction is not awaiting owner confirmation', 409);
                }

                if (response === 'approve') {
                    // F1/BLOCK (2026-11-26 ruling): approve settles the order as
                    // FULLY paid, so a claim below the order total must never
                    // settle it. New self-MFS claims always mint the full-total
                    // amount, but LEGACY rows may already hold partial advance
                    // numbers — refuse with a machine-readable 409 and change
                    // NOTHING (order stays pending, txn stays unverified; the
                    // merchant reconciles via re-collect / reject).
                    const orderTotal = Number(order.total);
                    const claimedAmount = Number(paymentTransaction.amount);
                    if (Number.isFinite(orderTotal) && Number.isFinite(claimedAmount)
                        && claimedAmount < orderTotal) {
                        throw new AppError(
                            'Claimed payment is below the order total — approving would settle a partial payment as fully paid. '
                            + 'Collect the remaining amount first (a new claim) or reject.',
                            409,
                            'CLAIM_AMOUNT_BELOW_ORDER_TOTAL',
                        );
                    }
                    await order.update({
                        payment_status: 'paid',
                        paid_at: new Date(),
                        order_status: 'confirmed',
                    }, { transaction });
                    await paymentTransaction.update({
                        status: 'verified',
                        verified_at: new Date(),
                    }, { transaction });
                } else if (String(order.payment_status || '').trim().toLowerCase() === 'paid') {
                    // F-1 (A9 release-remediation, 2026-11-27): REJECTING a stale/duplicate
                    // claim on an ALREADY-SETTLED order is claim-row cleanup, NEVER a
                    // lifecycle rollback. The old path called cancelOrderInTransaction —
                    // which guards only terminal ORDER status, not payment state, and the
                    // approve path leaves a paid order 'confirmed' — so the settled order
                    // was cancelled, payment flipped paid→failed, an ADR-0011 CANCELLED
                    // invoice line was written, inventory restored, and (below) the
                    // customer was told "payment could not be confirmed" WHILE the first
                    // claim's money stood: a direct breach of the founder invariant "never
                    // ask a customer to pay again while the original transaction remains
                    // unresolved". Mark ONLY this duplicate claim rejected; the order, its
                    // payment and the other verified transaction stay untouched.
                    await paymentTransaction.update({ status: 'rejected' }, { transaction });
                    duplicateRejectOnSettledOrder = true;
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
                        // D-4 honesty: an expired row the owner still judged is
                        // recorded as acted-after-expiry (surface, never hide).
                        ...(pastExpiry ? { acted_after_expiry: true } : {}),
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
                        ...(pastExpiry ? { expired_on_action: true } : {}),
                        // F-1 pin: the destructive-path refusal is itself auditable.
                        ...(duplicateRejectOnSettledOrder ? { duplicate_on_settled: true } : {}),
                    },
                    idempotency_key: `owner-payment:${notification.id}:${response}`,
                }, { transaction });
                completedNotification = notification;
            });

            if (duplicateRejectOnSettledOrder) {
                // F-1: the order REMAINS settled as paid — a "payment could not be
                // confirmed" message here would ask about re-payment while the
                // original transaction stands. No customer message; honest merchant
                // receipt instead.
                this.logger.info('Duplicate claim rejected on settled order — no cancellation, no customer message', {
                    notificationId,
                    orderId: completedNotification.customer_data.orderId,
                });
                return {
                    success: true,
                    duplicate_reject: true,
                    message: 'Duplicate claim rejected — the order remains settled as paid. No order or payment change was made.',
                    orderId: completedNotification.customer_data.orderId,
                };
            }
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
            // SURFACE is honest (D-10 defect pin; F3/D-4: expiry marks the row
            // 'expired' — it does NOT block the owner's judgment).
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
     * F3/D-4 (2026-11-26): the missing EXPIRY WRITER. Past expires_at a pending
     * payment confirmation is honestly marked 'expired' (the column's documented
     * third state) — on read-list AND on owner action (handleOwnerResponse).
     * Idempotent (only 'pending' rows past their expiry are touched, never
     * 'completed'/'expired' ones) and append-only-safe (status progression
     * only; no evidence rewrite; the payment row is NOT auto-failed — D-4
     * RATIFIED: surface expired + retain merchant judgment). Best-effort on
     * the read path: a marking failure must never break a list read; the next
     * read retries.
     *
     * @param {Array} notifications loaded OwnerNotification rows/objects
     * @returns the rows detected past expiry (marked or not)
     */
    async markExpiredOnRead(notifications = []) {
        const now = Date.now();
        const expiredRows = [];
        for (const row of notifications) {
            if (!row || row.status !== 'pending' || !row.expires_at) continue;
            if (new Date(row.expires_at).getTime() > now) continue;
            expiredRows.push(row);
            try {
                await row.update({ status: 'expired' });
            } catch (_) {
                this.logger.warn('Owner notification expiry marking failed (will retry on next read)', {
                    notificationId: row.id,
                });
            }
        }
        return expiredRows;
    }

    /**
     * Merchant dashboard read-list (GET /api/notifications/in-app surface).
     * Same rows as before — plus the F3 expiry writer, so the list never shows
     * a past-expiry payment confirmation as still-'pending'.
     */
    async listShopNotifications(shopId, { limit = 20 } = {}) {
        const rows = await OwnerNotification.findAll({
            where: { shop_id: shopId },
            order: [['created_at', 'DESC']],
            limit,
        });
        await this.markExpiredOnRead(rows);
        return rows;
    }

    /**
     * Get pending notifications for shop. F3/D-4: past-expiry rows are marked
     * 'expired' and leave the PENDING set — they stay visible (and actionable)
     * in the full in-app list as 'expired'.
     */
    async getPendingNotifications(shopId, limit = 10) {
        const rows = await OwnerNotification.findAll({
            where: {
                shop_id: shopId,
                status: 'pending'
            },
            order: [['created_at', 'DESC']],
            limit
        });
        const expired = await this.markExpiredOnRead(rows);
        const expiredIds = new Set(expired.map((row) => row && row.id));
        return rows.filter((row) => !expiredIds.has(row && row.id));
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
