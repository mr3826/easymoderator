/**
 * Order Tracking Notification Service (B2)
 * Sends shipping/tracking info to customers when order status changes to 'shipped'.
 */

const { createLogger } = require('../../utils/structured-logger');

const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'TRACKING_NOTIFICATION_FAILED';
};

/**
 * Format a Bengali tracking notification message.
 * @param {object} order - Sequelize Order instance or plain object
 * @param {object} options - { trackingNumber, estimatedDate, courier }
 * @returns {string}
 */
const formatTrackingMessage = (order, options = {}) => {
    const { trackingNumber, estimatedDate, courier } = options;
    const orderId = order.order_number || order.id;
    const tracking = trackingNumber || order.delivery_tracking_code || 'N/A';
    const estimated = estimatedDate || null;

    let message = `আপনার অর্ডার #${orderId} শিপ করা হয়েছে। ট্র্যাকিং নম্বর: ${tracking}.`;
    if (courier) {
        message += ` কুরিয়ার: ${courier}.`;
    }
    if (estimated) {
        message += ` আনুমানিক ডেলিভারি: ${estimated}.`;
    }
    return message;
};

/**
 * Try to send a message via the shop's active Facebook/Messenger channel.
 * Falls back to logging if no channel is configured or sending fails.
 *
 * @param {object} order - Order instance
 * @param {string} shopId
 * @param {string} message - Formatted message text
 * @param {object} logger
 */
const trySendViaChannel = async (order, shopId, message, logger) => {
    try {
        // The order carries a customer_id (the Customer table PK), NOT a PSID.
        // sendToCustomer resolves the customer's channel_user_id (PSID/IGSID) and
        // platform, then sends via the live provider. (The old code looked up an
        // undefined `Channel` model and read a nonexistent `customer.external_id`,
        // so this notification silently never sent.)
        if (!order.customer_id) {
            logger.info('No customer linked to order; tracking message content was not logged', { orderId: order.id });
            return { sent: false, reason: 'no_customer' };
        }

        const webhookService = require('../webhook/webhook.service');
        const result = await webhookService.sendToCustomer({ shopId, customerId: order.customer_id, message });

        if (result.sent) {
            logger.info('Tracking notification sent via channel', {
                shopId,
                orderId: order.id,
                channelType: result.channelType
            });
            return { sent: true, channelType: result.channelType };
        }

        logger.info('Tracking notification not delivered — logging only', {
            shopId,
            orderId: order.id,
            reason: result.reason
        });
        return { sent: false, reason: result.reason };
    } catch (err) {
        // Non-fatal: log and fall back
        logger.warn('Failed to send tracking notification via channel, falling back to log', {
            errorCode: safeErrorCode(err),
            orderId: order.id
        });
        return { sent: false, reason: 'send_error', error: err.message };
    }
};

/**
 * Send tracking notification when order is shipped.
 *
 * Accepts two calling conventions:
 *   sendTrackingNotification(order, shopId, options)        — called from order.service.js status hook
 *   sendTrackingNotification(orderId, shopId, options)      — called from order.controller.js POST /:id/send-tracking
 *
 * @param {object|string} orderOrId - Order instance or order ID string
 * @param {string} shopId
 * @param {object} options - { trackingNumber, courier, estimatedDelivery }
 */
const sendTrackingNotification = async (orderOrId, shopId, options = {}) => {
    const logger = createLogger(null, shopId);

    let order = orderOrId;

    // If a string/number ID was passed, load the order
    if (typeof orderOrId === 'string' || typeof orderOrId === 'number') {
        const { Order } = require('../entities');
        order = await Order.findOne({ where: { id: orderOrId, shop_id: shopId } });
        if (!order) {
            const { AppError } = require('../../utils/AppError');
            throw new AppError('Order not found', 404);
        }
    }

    const { trackingNumber, courier, estimatedDelivery } = options;
    const message = formatTrackingMessage(order, {
        trackingNumber,
        courier,
        estimatedDate: estimatedDelivery
    });

    const result = await trySendViaChannel(order, shopId, message, logger);

    return {
        orderId: order.id,
        orderNumber: order.order_number,
        message,
        ...result
    };
};

module.exports = {
    sendTrackingNotification,
    formatTrackingMessage
};
