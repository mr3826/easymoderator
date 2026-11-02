/**
 * Delivery Tracking Service
 * Handles automated delivery status updates and customer notifications
 * Cost-optimized with webhook-first approach and smart polling
 */

const { DeliveryTracking, Order, Shop } = require('../entities');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const deliveryService = require('./delivery.service');
const { COURIER_REGISTRY, normalizeStatus: normalizeRegistryStatus } = require('./providers/provider.registry');
const RtoShieldService = require('../rto-shield/rto-shield.service');

const FINAL_DELIVERY_STATUSES = new Set([
    'delivered', 'returned', 'partial_returned',
]);
const SAFE_LOG_STATUSES = new Set([
    'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered',
    'partial_delivered', 'failed_delivery', 'returned', 'partial_returned', 'cancelled', 'unknown',
]);
const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code : '';
    return /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/.test(code) ? code : 'DELIVERY_TRACKING_ERROR';
};
const safeLogProvider = (provider) => {
    const normalized = String(provider || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(COURIER_REGISTRY, normalized) ? normalized : 'unknown';
};
const safeLogStatus = (status) => SAFE_LOG_STATUSES.has(status) ? status : 'unknown';
const safeTrackingId = (id) => (
    typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null
);
const isReturnedStatus = (status) => ['returned', 'partial_returned'].includes(status);
const isFinalDeliveryStatus = (status) => FINAL_DELIVERY_STATUSES.has(status);

class DeliveryTrackingService {
    constructor() {
        this.logger = createLogger();
        this.statusMessages = {
            'picked_up': {
                bn: 'আপনার অর্ডার পিক আপ হয়েছে 📦',
                en: 'Your order has been picked up 📦'
            },
            'in_transit': {
                bn: 'আপনার পণ্য রাস্তায় 🚚',
                en: 'Your package is on the way 🚚'
            },
            'out_for_delivery': {
                bn: 'আজ ডেলিভারি হবে 🏠',
                en: 'Out for delivery today 🏠'
            },
            'delivered': {
                bn: 'পণ্য সফলভাবে ডেলিভারি হয়েছে ✅',
                en: 'Package successfully delivered ✅'
            },
            'partial_delivered': {
                bn: 'অর্ডারের কিছু পণ্য ডেলিভারি হয়েছে ✅',
                en: 'Part of your order has been delivered ✅'
            },
            'failed_delivery': {
                bn: 'ডেলিভারি ব্যর্থ, আবার চেষ্টা করা হবে',
                en: 'Delivery failed, will retry'
            },
            'cancelled': {
                bn: 'ডেলিভারি বাতিল করা হয়েছে',
                en: 'Delivery cancelled'
            },
            'returned': {
                bn: 'পণ্য ফেরত পাঠানো হয়েছে',
                en: 'Package returned'
            },
            'partial_returned': {
                bn: 'অর্ডারের কিছু পণ্য ফেরত পাঠানো হয়েছে',
                en: 'Part of your order has been returned'
            }
        };
    }

    /**
     * Create delivery tracking record
     */
    async createTrackingRecord(order, deliveryResult) {
        try {
            const trackingNumber = deliveryResult.tracking_code || deliveryResult.consignment_id;
            const tracking = await DeliveryTracking.create({
                order_id: order.id,
                provider: deliveryResult.provider,
                tracking_number: trackingNumber,
                current_status: 'booked',
                status_history: [{
                    status: 'booked',
                    timestamp: new Date().toISOString(),
                    location: 'Processing center'
                }],
                estimated_delivery: deliveryResult.estimated_delivery,
                // Booking is not a webhook receipt. Leaving this null allows
                // the polling worker to pick up providers that do not callback.
                webhook_received_at: null
            });

            // Update order with delivery info
            await order.update({
                delivery_provider: deliveryResult.provider,
                delivery_consignment_id: deliveryResult.consignment_id,
                delivery_tracking_code: trackingNumber,
                delivery_status: 'booked',
                delivery_dispatched_at: new Date()
            });

            this.logger.info('Delivery tracking created', {
                trackingId: safeTrackingId(tracking.id),
                orderId: order.id,
                provider: safeLogProvider(deliveryResult.provider),
            });

            return tracking;

        } catch (error) {
            this.logger.error('Failed to create delivery tracking', {
                orderId: order.id,
                errorCode: safeErrorCode(error),
            });
            throw new AppError('Failed to create delivery tracking', 500);
        }
    }

    /**
     * Handle delivery status webhook
     */
    async handleDeliveryWebhook(provider, trackingNumber, statusData) {
        let trackingId = null;
        try {
            const normalizedStatus = this.normalizeStatus(provider, statusData?.status);
            this.logger.info('Delivery webhook received', {
                provider: safeLogProvider(provider),
                status: safeLogStatus(normalizedStatus),
            });

            // Find tracking record
            const tracking = await DeliveryTracking.findOne({
                where: { tracking_number: trackingNumber, provider },
                include: [{
                    model: Order,
                    as: 'order',
                    required: true,
                    include: [{
                        model: Shop,
                        as: 'shop'
                    }]
                }]
            });

            if (!tracking) {
                this.logger.warn('Tracking record not found', { provider: safeLogProvider(provider) });
                return { success: false, error: 'Tracking record not found' };
            }
            trackingId = safeTrackingId(tracking.id);
            
            // Cheap replay path; the same checks are repeated under a row lock
            // below so two different terminal callbacks cannot both win.
            if (normalizedStatus === tracking.current_status) {
                await tracking.update({ webhook_received_at: new Date() });
                return { success: true, message: 'No status change' };
            }
            if (isFinalDeliveryStatus(tracking.current_status)
                || (tracking.current_status === 'cancelled' && !isFinalDeliveryStatus(normalizedStatus))) {
                this.logger.warn('Ignored courier status regression after final outcome or cancellation', {
                    trackingId,
                    provider: safeLogProvider(provider),
                    currentStatus: safeLogStatus(tracking.current_status),
                    attemptedStatus: safeLogStatus(normalizedStatus),
                });
                return { success: true, message: 'Terminal status preserved', ignored: true };
            }

            const database = DeliveryTracking.sequelize || tracking.sequelize || Order.sequelize;
            let statusChanged = false;
            let terminalStatusPreserved = false;
            let previousStatus = tracking.current_status;
            let terminalOutcome = null;
const applyStatus = async (transaction = null) => {
                if (transaction) {
                    // Serialize concurrent callbacks on the delivery_tracking row
                    // itself. reload({ lock }) is unusable here: Sequelize re-applies
                    // the eager Order→Shop includes from the webhook lookup, and
                    // PostgreSQL refuses FOR UPDATE on the nullable side of an outer
                    // join (0A000). A single-table lock row-scoped to this tracking
                    // record provides the same serialization without the join.
                    const locked = await DeliveryTracking.findOne({
                        where: { id: tracking.id },
                        transaction,
                        lock: transaction.LOCK?.UPDATE,
                    });
                    if (!locked) {
                        throw new AppError('Delivery tracking record disappeared before the status update', 409, 'DELIVERY_TRACKING_NOT_FOUND');
                    }
                    tracking.set(locked.get({ plain: true }));
                }
                previousStatus = tracking.current_status;
                if (normalizedStatus === previousStatus) {
                    if (transaction) await tracking.update({ webhook_received_at: new Date() }, { transaction });
                    else await tracking.update({ webhook_received_at: new Date() });
                    return;
                }
                if (isFinalDeliveryStatus(previousStatus)
                    || (previousStatus === 'cancelled' && !isFinalDeliveryStatus(normalizedStatus))) {
                    terminalStatusPreserved = true;
                    return;
                }

                const now = new Date();
                const statusHistory = [
                    ...(tracking.status_history || []),
                    {
                        status: normalizedStatus,
                        timestamp: now.toISOString(),
                        location: statusData.location || 'Unknown',
                        agent: statusData.delivery_agent
                    },
                ];
                const trackingUpdates = {
                    previous_status: previousStatus,
                    current_status: normalizedStatus,
                    status_history: statusHistory,
                    location_info: statusData.location,
                    delivery_agent_info: statusData.delivery_agent,
                    webhook_received_at: now,
                    last_api_check: now
                };
                const orderUpdates = { delivery_status: normalizedStatus };

                if (normalizedStatus === 'delivered') {
                    Object.assign(orderUpdates, {
                        fulfillment_status: 'delivered',
                        order_status: 'delivered',
                        delivered_at: now
                    });
                    terminalOutcome = 'delivered';
                } else if (normalizedStatus === 'partial_delivered') {
                    Object.assign(orderUpdates, {
                        fulfillment_status: 'partially_fulfilled',
                        order_status: 'processing',
                    });
                } else if (isReturnedStatus(normalizedStatus)) {
                    Object.assign(orderUpdates, {
                        fulfillment_status: 'cancelled',
                        order_status: 'cancelled'
                    });
                    terminalOutcome = 'returned';
                } else if (normalizedStatus === 'cancelled') {
                    Object.assign(orderUpdates, {
                        fulfillment_status: 'cancelled',
                        order_status: 'cancelled'
                    });
                }

                if (transaction) {
                    await tracking.update(trackingUpdates, { transaction });
                    await tracking.order.update(orderUpdates, { transaction });
                } else {
                    await tracking.update(trackingUpdates);
                    await tracking.order.update(orderUpdates);
                }
                if (terminalOutcome === 'delivered' || isReturnedStatus(normalizedStatus)) {
                    const args = [
                        tracking.order.customer_phone,
                        tracking.order.shop_id,
                        isReturnedStatus(normalizedStatus),
                    ];
                    if (transaction) await RtoShieldService.trackDeliveryOutcome(...args, { transaction });
                    else await RtoShieldService.trackDeliveryOutcome(...args);
                }
                statusChanged = true;
            };

            // A row lock serializes different terminal callbacks. Only the
            // transaction that moves a non-terminal row to its final outcome
            // performs the downstream outcome and RTO-stat writes.
            if (database && typeof database.transaction === 'function') {
                await database.transaction(async (transaction) => applyStatus(transaction));
            } else {
                await applyStatus();
            }

            if (!statusChanged) {
                if (terminalStatusPreserved) {
                    this.logger.warn('Ignored courier status regression after final outcome or cancellation', {
                        trackingId,
                        provider: safeLogProvider(provider),
                        currentStatus: safeLogStatus(previousStatus),
                        attemptedStatus: safeLogStatus(normalizedStatus),
                    });
                    return { success: true, message: 'Terminal status preserved', ignored: true };
                }
                return { success: true, message: 'No status change' };
            }

            if (terminalOutcome) {
                // RTO Shield v2 ground truth: first terminal outcome wins
                // (conditional on outcome IS NULL), so a replayed or late
                // webhook cannot rewrite it. Never throws.
                await require('../order-confidence/order-confidence.service').recordOutcome(tracking.order);
            }

            if (terminalOutcome === 'delivered') {
                await this.handleSuccessfulDelivery(tracking);
            } else if (terminalOutcome === 'returned') {
                await this.handleFailedDelivery(tracking);
            } else if (normalizedStatus === 'failed_delivery') {
                // This is a failed attempt that can be retried, not final RTO.
                await this.handleFailedDelivery(tracking);
            }

            // Send customer notification
            await this.sendCustomerNotification(tracking, normalizedStatus);

            this.logger.info('Delivery status updated', {
                trackingId,
                provider: safeLogProvider(provider),
                oldStatus: safeLogStatus(previousStatus),
                newStatus: safeLogStatus(normalizedStatus),
            });

            return { success: true, tracking };

        } catch (error) {
            this.logger.error('Failed to handle delivery webhook', {
                provider: safeLogProvider(provider),
                trackingId,
                errorCode: safeErrorCode(error),
            });
            // Diagnostics stay limited to the error CLASS name. Messages can
            // carry credentials or shipment data, so they are never logged;
            // the class alone identifies Sequelize constraint violations,
            // TypeErrors, and AppErrors without leaking any payload. sqlState/
            // constraint/table are PostgreSQL schema metadata identifiers only
            // — never row values.
            const pg = error?.original ?? error;
            this.logger.warn('Delivery webhook failure classified', {
                trackingId,
                errorName: String(error?.name || 'Error').slice(0, 60),
                sqlState: /^[0-9A-Z]{5}$/.test(String(pg?.sqlState || '')) ? pg.sqlState : undefined,
                constraint: /^[A-Za-z0-9_]{1,63}$/.test(String(pg?.constraint || '')) ? pg.constraint : undefined,
                column: /^[A-Za-z0-9_]{1,63}$/.test(String(pg?.column || '')) ? pg.column : undefined,
                table: /^[A-Za-z0-9_]{1,63}$/.test(String(pg?.table || '')) ? pg.table : undefined,
            });
            throw new AppError('Failed to handle delivery webhook', 500);
        }
    }

    /**
     * Poll delivery status for orders without recent webhooks
     */
    async pollDeliveryStatus() {
        try {
            // Find orders that need status polling
            const trackings = await DeliveryTracking.findAll({
                where: {
                    [require('sequelize').Op.or]: [
                        { webhook_received_at: null },
                        { 
                            webhook_received_at: {
                                [require('sequelize').Op.lt]: new Date(Date.now() - 30 * 60 * 1000) // 30 minutes ago
                            }
                        }
                    ],
                    current_status: {
                        [require('sequelize').Op.notIn]: [...FINAL_DELIVERY_STATUSES]
                    }
                },
                include: [{
                    model: Order,
                    as: 'order',
                    required: true,
                }],
                limit: 50 // Process in batches
            });

            this.logger.info('Polling delivery status', { count: trackings.length });

            for (const tracking of trackings) {
                try {
                    await this.pollSingleTracking(tracking);
                } catch (error) {
                    this.logger.error('Failed to poll tracking', {
                        trackingId: safeTrackingId(tracking.id),
                        errorCode: safeErrorCode(error),
                    });
                }
            }

        } catch (error) {
            this.logger.error('Failed to poll delivery status', { errorCode: safeErrorCode(error) });
        }
    }

    /**
     * Poll single tracking status
     */
    async pollSingleTracking(tracking) {
        try {
            const statusData = await deliveryService.getDeliveryStatus(
                tracking.order.shop_id,
                tracking.provider,
                tracking.tracking_number
            );

            if (statusData.status !== tracking.current_status) {
                await this.handleDeliveryWebhook(tracking.provider, tracking.tracking_number, {
                    status: statusData.status,
                    location: statusData.location
                });
            }

            // Update last API check time
            await tracking.update({
                last_api_check: new Date()
            });

        } catch (error) {
            this.logger.warn('Failed to poll tracking status', {
                trackingId: safeTrackingId(tracking.id),
                errorCode: safeErrorCode(error),
            });
        }
    }

    /**
     * Normalize delivery status
     */
    normalizeStatus(provider, rawStatus) {
        const raw = String(rawStatus ?? '').trim();
        if (!raw) return 'unknown';
        if (typeof deliveryService.normalizeDeliveryStatus === 'function') {
            return deliveryService.normalizeDeliveryStatus(provider, raw);
        }
        const providerEntry = COURIER_REGISTRY[String(provider || '').toLowerCase()];
        if (providerEntry && typeof normalizeRegistryStatus === 'function') {
            return normalizeRegistryStatus(raw, providerEntry.statusMap);
        }
        return raw;
    }

    /**
     * Send customer notification about delivery status
     */
    async sendCustomerNotification(tracking, status) {
        try {
            const message = this.statusMessages[status];
            if (!message) {
                this.logger.warn('No message template for status', { status: safeLogStatus(status) });
                return;
            }

            const webhookService = require('../webhook/webhook.service');

            // Build notification message
            const notificationMessage = `${message.bn}\n\n📦 অর্ডার: #${tracking.order.order_number}\n🚚 কুরিয়ার: ${tracking.provider}\n📱 ট্র্যাকিং: ${tracking.tracking_number}\n\n---\n\n${message.en}\n\n📦 Order: #${tracking.order.order_number}\n🚚 Courier: ${tracking.provider}\n📱 Tracking: ${tracking.tracking_number}`;

            // Send to the customer via their PSID (resolved from the order's customer).
            // The old code looked up an undefined `Channel` model and passed a phone
            // number as the Meta recipient, so this notification silently never sent.
            const result = await webhookService.sendToCustomer({
                shopId: tracking.order.shop_id,
                customerId: tracking.order.customer_id,
                message: notificationMessage,
            });

            if (result.sent) {
                await tracking.update({ customer_notified: true });
                this.logger.info('Customer notified about delivery status', {
                    trackingId: safeTrackingId(tracking.id),
                    status: safeLogStatus(status),
                });
            } else {
                this.logger.info('Delivery notification not delivered', {
                    trackingId: safeTrackingId(tracking.id),
                    status: safeLogStatus(status),
                    reasonCode: 'DELIVERY_NOTIFICATION_NOT_SENT',
                });
            }

        } catch (error) {
            this.logger.error('Failed to send customer notification', {
                trackingId: safeTrackingId(tracking.id),
                status: safeLogStatus(status),
                errorCode: safeErrorCode(error),
            });
        }
    }

    /**
     * Handle successful delivery
     */
    async handleSuccessfulDelivery(tracking) {
        try {
            // Send delivery completion notification to the customer via their PSID.
            const webhookService = require('../webhook/webhook.service');
            const isPartialDelivery = tracking.current_status === 'partial_delivered';
            const completionMessage = isPartialDelivery
                ? `✅ অর্ডারের কিছু পণ্য ডেলিভারি হয়েছে।\n\nআপনার অর্ডার #${tracking.order.order_number}-এর আংশিক ডেলিভারি সম্পন্ন হয়েছে।\n\n---\n\n✅ Partial Delivery Completed.\n\nPart of your order #${tracking.order.order_number} has been delivered.`
                : `✅ ডেলিভারি সম্পন্ন হয়েছে!\n\nআপনার অর্ডার #${tracking.order.order_number} সফলভাবে ডেলিভারি হয়েছে।\n\nপণ্য পেয়ে থাকলে আমাদের জানান।\n\nধন্যবাদ!\n\n---\n\n✅ Delivery Completed!\n\nYour order #${tracking.order.order_number} has been successfully delivered.\n\nPlease let us know once you've received the package.\n\nThank you!`;

            await webhookService.sendToCustomer({
                shopId: tracking.order.shop_id,
                customerId: tracking.order.customer_id,
                message: completionMessage,
            });

            // Update actual delivery time
            await tracking.update({
                actual_delivery: new Date()
            });

            this.logger.info('Delivery completion processed', {
                trackingId: safeTrackingId(tracking.id),
                orderId: tracking.order.id,
            });

        } catch (error) {
            this.logger.error('Failed to handle successful delivery', {
                trackingId: safeTrackingId(tracking.id),
                errorCode: safeErrorCode(error),
            });
        }
    }

    /**
     * Handle failed delivery
     */
    async handleFailedDelivery(tracking) {
        try {
            // Send failure notification to shop owner
            const ownerNotificationService = require('../notification/owner-notification.service');
            
            await ownerNotificationService.sendPaymentConfirmationRequest(
                tracking.order.shop_id,
                {
                    id: tracking.order.id,
                    order_number: tracking.order.order_number,
                    customer_name: tracking.order.customer_name,
                    customer_phone: tracking.order.customer_phone,
                    total: tracking.order.total
                },
                {
                    type: 'delivery_failure',
                    message: `Delivery failed for order #${tracking.order.order_number}`,
                    trackingInfo: {
                        provider: tracking.provider,
                        trackingNumber: tracking.tracking_number,
                        status: tracking.current_status
                    }
                }
            );

            this.logger.info('Delivery failure processed', {
                trackingId: safeTrackingId(tracking.id),
                orderId: tracking.order.id
            });

        } catch (error) {
            this.logger.error('Failed to handle delivery failure', {
                trackingId: safeTrackingId(tracking.id),
                errorCode: safeErrorCode(error),
            });
        }
    }

    /**
     * Get tracking by order ID
     */
    async getTrackingByOrderId(orderId, shopId) {
        const tracking = await DeliveryTracking.findOne({
            where: { order_id: orderId },
            include: [{
                model: Order,
                as: 'order',
                attributes: ['order_number', 'customer_name', 'customer_phone', 'total'],
                where: { shop_id: shopId },
                required: true,
            }]
        });

        if (!tracking) {
            throw new AppError('Tracking not found', 404);
        }

        return tracking;
    }

    /**
     * Get tracking history
     */
    async getTrackingHistory(trackingId, shopId) {
        const tracking = await DeliveryTracking.findOne({
            where: { id: trackingId },
            include: [{
                model: Order,
                as: 'order',
                attributes: ['id'],
                where: { shop_id: shopId },
                required: true,
            }],
        });

        if (!tracking) {
            throw new AppError('Tracking not found', 404);
        }

        return {
            currentStatus: tracking.current_status,
            trackingNumber: tracking.tracking_number,
            provider: tracking.provider,
            estimatedDelivery: tracking.estimated_delivery,
            actualDelivery: tracking.actual_delivery,
            statusHistory: tracking.status_history || [],
            locationInfo: tracking.location_info,
            deliveryAgentInfo: tracking.delivery_agent_info
        };
    }
}

module.exports = new DeliveryTrackingService();
