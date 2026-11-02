/**
 * Courier Delivery Webhook Routes
 * Public endpoints called by courier providers when delivery status changes.
 * Must be mounted before express.json() so raw body is available for HMAC validation.
 */

const express = require('express');
const crypto = require('crypto');
const { DeliveryTracking, DeliveryIntegration, Order } = require('../entities');
const deliveryTrackingService = require('../delivery/delivery-tracking.service');
const { createLogger } = require('../../utils/structured-logger');

const router = express.Router();
const logger = createLogger();
const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'COURIER_WEBHOOK_ERROR';
};
const parseJsonWithRawBody = express.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    }
});

function timingSafeStringEqual(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    const receivedBuffer = Buffer.from(received, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return receivedBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Resolve the shop's delivery credentials for a given provider using the tracking record.
 * Returns null if consignment not found.
 */
async function resolveShopCredentials(provider, consignmentId) {
    let tracking = await DeliveryTracking.findOne({
        where: { tracking_number: consignmentId, provider },
        include: [{
            model: Order,
            as: 'order',
            attributes: ['id', 'shop_id', 'delivery_consignment_id'],
            required: true,
        }],
    });
    if (!tracking && typeof Order.findOne === 'function') {
        const order = await Order.findOne({
            where: { delivery_consignment_id: consignmentId },
            attributes: ['id', 'shop_id', 'delivery_consignment_id'],
        });
        if (order) {
            tracking = await DeliveryTracking.findOne({
                where: { order_id: order.id, provider },
                include: [{
                    model: Order,
                    as: 'order',
                    attributes: ['id', 'shop_id', 'delivery_consignment_id'],
                    required: true,
                }],
            });
        }
    }
    if (!tracking) return null;

    const integration = await DeliveryIntegration.findOne({
        where: { shop_id: tracking.order.shop_id, provider, is_active: true, is_connected: true }
    });
    return integration ? { tracking, credentials: integration.credentials } : { tracking, credentials: null };
}

/**
 * Validate Steadfast webhook.
 * Steadfast signs requests with HMAC-SHA256 of the raw body using the shop's secret_key.
 * Header: X-Steadfast-Signature
 */
async function validateSteadfastSignature(req, res, next) {
    try {
        const signature = req.headers['x-steadfast-signature'];
        const consignmentId = req.body?.consignment_id || req.body?.order?.consignment_id;

        if (!consignmentId) {
            return res.status(400).json({ error: 'Missing consignment_id in payload' });
        }

        const resolved = await resolveShopCredentials('steadfast', consignmentId);
        if (!resolved) {
            logger.warn('Steadfast webhook: tracking record not found', { consignmentId });
            return res.status(404).json({ error: 'Order not found' });
        }

        if (!resolved.credentials?.secret_key) {
            logger.error('Steadfast webhook rejected: active integration has no verification secret');
            return res.status(503).json({ error: 'Webhook verification unavailable' });
        }
        const expected = crypto
            .createHmac('sha256', resolved.credentials.secret_key)
            .update(req.rawBody || Buffer.from(''))
            .digest('hex');
        if (!timingSafeStringEqual(signature, expected)) {
            logger.warn('Steadfast webhook: missing or invalid signature', { consignmentId });
            return res.status(401).json({ error: 'Invalid signature' });
        }

        req.resolvedTracking = resolved.tracking;
        next();
    } catch (err) {
        logger.error('Steadfast webhook validation error', { errorCode: safeErrorCode(err) });
        res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * Validate RedX webhook.
 * RedX sends a query-string token. It is deliberately separate from the API
 * credential used for outbound parcel calls.
 */
async function validateRedxSignature(req, res, next) {
    try {
        const token = typeof req.query?.token === 'string' ? req.query.token : null;
        const webhookSecret = process.env.REDX_WEBHOOK_SECRET;
        const consignmentId = req.body?.tracking_number
            || req.body?.parcel?.tracking_number;

        if (!consignmentId) {
            return res.status(400).json({ error: 'Missing tracking_number in payload' });
        }

        if (!webhookSecret) {
            logger.error('RedX webhook rejected: REDX_WEBHOOK_SECRET is not configured');
            return res.status(503).json({ error: 'Webhook verification unavailable' });
        }
        if (webhookSecret && !timingSafeStringEqual(token, webhookSecret)) {
            logger.warn('RedX webhook: missing or invalid query token', { consignmentId });
            return res.status(401).json({ error: 'Invalid webhook token' });
        }

        const resolved = await resolveShopCredentials('redx', consignmentId);
        if (!resolved) {
            logger.warn('RedX webhook: tracking record not found', { consignmentId });
            return res.status(404).json({ error: 'Order not found' });
        }

        req.resolvedTracking = resolved.tracking;
        next();
    } catch (err) {
        logger.error('RedX webhook validation error', { errorCode: safeErrorCode(err) });
        res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * Validate Pathao webhook.
 * Pathao signs with HMAC-SHA256 of raw body using client_secret.
 * Header: X-Pathao-Signature
 */
async function validatePathaoSignature(req, res, next) {
    try {
        const signature = req.headers['x-pathao-signature'];
        const consignmentId = req.body?.consignment_id;

        if (!consignmentId) {
            return res.status(400).json({ error: 'Missing consignment_id in payload' });
        }

        const resolved = await resolveShopCredentials('pathao', consignmentId);
        if (!resolved) {
            logger.warn('Pathao webhook: tracking record not found', { consignmentId });
            return res.status(404).json({ error: 'Order not found' });
        }

        if (!resolved.credentials?.client_secret) {
            logger.error('Pathao webhook rejected: active integration has no verification secret');
            return res.status(503).json({ error: 'Webhook verification unavailable' });
        }
        const expected = crypto
            .createHmac('sha256', resolved.credentials.client_secret)
            .update(req.rawBody || Buffer.from(''))
            .digest('hex');
        if (!timingSafeStringEqual(signature, expected)) {
            logger.warn('Pathao webhook: missing or invalid signature', { consignmentId });
            return res.status(401).json({ error: 'Invalid signature' });
        }

        req.resolvedTracking = resolved.tracking;
        next();
    } catch (err) {
        logger.error('Pathao webhook validation error', { errorCode: safeErrorCode(err) });
        res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * Extract a normalised {trackingNumber, status, location} from courier-specific payload shapes.
 */
function extractStatusData(provider, body) {
    if (provider === 'steadfast') {
        return {
            trackingNumber: body.consignment_id || body.order?.consignment_id,
            status: body.delivery_status || body.status,
            location: body.location
        };
    }
    if (provider === 'redx') {
        return {
            trackingNumber: body.tracking_number || body.parcel?.tracking_number,
            status: body.status
                || body.parcel?.status
                || body.delivery_status
                || body.parcel_status
                || body.parcel?.delivery_status
                || body.parcel?.parcel_status,
            location: body.location
        };
    }
    if (provider === 'pathao') {
        return {
            trackingNumber: body.consignment_id,
            status: body.order_status,
            location: body.location
        };
    }
    return { trackingNumber: null, status: null, location: null };
}

function makeHandler(provider) {
    return async (req, res) => {
        try {
            const { trackingNumber, status, location } = extractStatusData(provider, req.body);

            if (!trackingNumber || !status) {
                logger.warn(`${provider} webhook: missing tracking number or status`);
                return res.status(400).json({ error: 'Invalid payload' });
            }

            logger.info(`${provider} delivery webhook`, { trackingNumber, status });

            const result = await deliveryTrackingService.handleDeliveryWebhook(
                provider, trackingNumber, { status, location }
            );

            res.json({ received: true, ...result });
        } catch (err) {
            logger.error(`${provider} webhook handler error`, { errorCode: safeErrorCode(err) });
            res.status(500).json({ error: 'Internal error' });
        }
    };
}

router.post('/steadfast', parseJsonWithRawBody, validateSteadfastSignature, makeHandler('steadfast'));
router.post('/redx',      parseJsonWithRawBody, validateRedxSignature,      makeHandler('redx'));
router.post('/pathao',    parseJsonWithRawBody, validatePathaoSignature,     makeHandler('pathao'));

module.exports = router;
module.exports._private = {
    timingSafeStringEqual,
    safeErrorCode,
    validatePathaoSignature,
    validateRedxSignature,
    validateSteadfastSignature,
};
