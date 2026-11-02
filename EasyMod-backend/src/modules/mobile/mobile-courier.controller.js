'use strict';

const crypto = require('crypto');
const asyncHandler = require('../../utils/async-middleware-handler');
const { AppError, sendSuccess } = require('../../utils/AppError');
const orderService = require('../order/order.service');
const { Op } = require('sequelize');
const {
    normalizeCourierProvider,
    normalizeTrackingId,
    resolveCourierTrackingIdentity,
    trackingUnavailableMessage,
} = require('../delivery/tracking-identity');

let AuditLog = null;
let Order = null;
let DeliveryTracking = null;
try {
    const entities = require('../entities');
    AuditLog = entities.AuditLog;
    Order = entities.Order;
    DeliveryTracking = entities.DeliveryTracking;
} catch (_) {}

let redisClient = null;
try {
    const { getRedisClient } = require('../../utils/redis-client');
    redisClient = getRedisClient();
} catch (_) {}

const MAX_PAGE_SIZE = 50;
const NO_COURIER_BOOKING_STATUSES = new Set(['not_booked', 'courier_setup_required', 'confidence_hold']);
const safeErrorCode = (error, fallback) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : fallback;
};
const PROBLEM_STATUSES = [
    'cancelled',
    'returned',
    'failed_delivery',
    'failed',
    'damaged',
    'lost',
    'hold',
    'delayed',
    'courier_setup_required',
    'dispatch_indeterminate',
];

function positiveInteger(value, fallback, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, maximum);
}

const isCodPaymentMethod = (method) => {
    const normalized = String(method || '').toLowerCase().replace(/[\s_-]/g, '');
    return normalized === 'cod' || normalized === 'cashondelivery';
};

const expectedCodAmount = (order) => {
    if (!order.payment_method) return null;
    if (!isCodPaymentMethod(order.payment_method)) return 0;
    const status = String(order.payment_status || '').toLowerCase();
    if (['paid', 'refunded'].includes(status)) return 0;
    if (!['pending', 'unpaid'].includes(status)) return null;
    const total = Number(order.total);
    return Number.isFinite(total) && total >= 0 ? total : null;
};

function orderIdFrom(req) {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId || orderId.length > 100) {
        throw new AppError('Order ID is required', 400, 'VALIDATION_ERROR');
    }
    return orderId;
}

/**
 * POST /api/mobile/orders/:orderId/book-courier
 * Books courier for an order using orderService.bookForOrder with Redis idempotency lock.
 */
const bookCourier = asyncHandler(async (req, res) => {
    const orderId = orderIdFrom(req);
    const shopId = req.shop.id;
    const userId = req.user.userId || req.user.id;
    const provider = req.body?.provider ? String(req.body.provider).trim().toLowerCase() : null;
    const idempotencyKey = String(req.headers?.['x-idempotency-key'] || req.body?.idempotencyKey || '').trim();
    let idempotencyReplay = false;

    if (!Order) {
        throw new AppError('Order database entity unavailable', 500, 'INTERNAL_ERROR');
    }

    const order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
    if (!order) {
        throw new AppError('Order not found', 404, 'NOT_FOUND');
    }

    // Check Redis idempotency lock
    if (idempotencyKey && redisClient) {
        const lockKey = `mobile:courier:book:${shopId}:${orderId}:${idempotencyKey}`;
        const acquired = await redisClient.set(lockKey, '1', 'NX', 'EX', 60).catch(() => null);
        idempotencyReplay = !acquired && Boolean(order.delivery_consignment_id || order.delivery_tracking_code);
    }

    const overrides = {
        recipient_name: req.body?.recipient_name,
        recipient_phone: req.body?.recipient_phone,
        recipient_address: req.body?.recipient_address,
        item_weight: req.body?.item_weight ?? req.body?.weight_kg,
        item_description: req.body?.item_description,
        delivery_type: req.body?.delivery_type,
        item_type: req.body?.item_type,
        note: req.body?.note,
    };

    const result = await orderService.bookForOrder(order, {
        shopId,
        trigger: 'MANUAL',
        mutationAuthority: { kind: 'human', userId: req.user?.userId || req.user?.id },
        provider: provider || null,
        requireAiDefault: !provider,
        overrides,
    });

    if (result?.blocked && result.status === 'courier_setup_required') {
        return res.status(409).json({
            success: false,
            error: {
                code: 'COURIER_SETUP_REQUIRED',
                message: 'Courier setup is required before booking this order',
                missing: result.missing || [],
                provider: result.provider || null,
            },
        });
    }

    if (result?.blocked && result.status === 'confidence_hold') {
        return res.status(409).json({
            success: false,
            error: {
                code: result.engine_failure ? 'ORDER_CONFIDENCE_UNAVAILABLE' : 'ORDER_CONFIDENCE_HOLD',
                message: result.engine_failure
                    ? 'Order checks are temporarily unavailable. Try again shortly.'
                    : 'This order needs verification before a courier can be booked',
                decision: result.decision,
                reasons: result.reasons || [],
                decision_version: result.decision_version,
            },
        });
    }

    if (result?.blocked && result.status === 'tracking_unavailable') {
        const code = result.code === 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE'
            ? result.code
            : 'COURIER_TRACKING_UNAVAILABLE';
        return res.status(409).json({
            success: false,
            error: {
                code,
                message: trackingUnavailableMessage(code),
                provider: normalizeCourierProvider(result.provider),
            },
        });
    }

    if (result?.blocked) {
        return res.status(409).json({
            success: false,
            error: {
                code: 'COURIER_DISPATCH_INDETERMINATE',
                message: 'Do not book again until the existing courier dispatch has been reconciled.',
                provider: normalizeCourierProvider(result.provider),
            },
        });
    }

    if (result?.failed) {
        return res.status(502).json({
            success: false,
            error: {
                code: 'COURIER_BOOKING_FAILED',
                message: result.reason || 'Courier booking failed',
            },
        });
    }

    const trackingIdentity = resolveCourierTrackingIdentity(
        result?.provider,
        result?.tracking_code,
        result?.consignment_id,
    );
    if (!trackingIdentity) {
        const code = normalizeCourierProvider(result?.provider)
            ? 'COURIER_TRACKING_UNAVAILABLE'
            : 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE';
        return res.status(409).json({
            success: false,
            error: { code, message: trackingUnavailableMessage(code) },
        });
    }

    const bookingData = {
        tracking_id: trackingIdentity.trackingNumber,
        consignment_id: normalizeTrackingId(result.consignment_id),
        provider: trackingIdentity.provider,
        booked_at: idempotencyReplay
            ? order.delivery_dispatched_at || new Date().toISOString()
            : new Date().toISOString(),
        status: result.status || order.delivery_status || 'booked',
        ...(idempotencyReplay ? { idempotencyReplay: true } : {}),
    };

    if (!idempotencyReplay && AuditLog && typeof AuditLog.create === 'function') {
        const auditHash = crypto.createHash('sha256')
            .update(['COURIER_BOOKED', shopId, orderId, userId, idempotencyKey || Date.now()].join('|'))
            .digest('hex');
        await AuditLog.create({
            user_id: userId,
            shop_id: shopId,
            action: 'COURIER_BOOKED',
            resource_type: 'order',
            resource_id: orderId,
            idempotency_key: auditHash,
            metadata: {
                source: 'MOBILE',
                provider: bookingData.provider,
                tracking_id: bookingData.tracking_id,
                consignment_id: bookingData.consignment_id,
            },
        }).catch((err) => console.warn('Mobile courier booking audit log failed', {
            orderId,
            errorCode: safeErrorCode(err, 'COURIER_BOOKING_AUDIT_FAILED'),
        }));
    }

    sendSuccess(res, bookingData);
});

/**
 * GET /api/mobile/courier/problems
 * Returns parcels experiencing delivery problems or stuck states.
 */
const getProblemParcels = asyncHandler(async (req, res) => {
    const shopId = req.shop.id;
    const page = positiveInteger(req.query.page, 1, 1000);
    const limit = positiveInteger(req.query.limit, 25, MAX_PAGE_SIZE);

    if (!Order) {
        throw new AppError('Order database entity unavailable', 500, 'INTERNAL_ERROR');
    }

    const where = { shop_id: shopId };
    if (req.query.status) {
        where.delivery_status = String(req.query.status).trim();
    } else {
        where.delivery_status = { [Op.in]: PROBLEM_STATUSES };
    }
    if (req.query.provider) {
        where.delivery_provider = String(req.query.provider).trim().toLowerCase();
    }

    const { count, rows } = await Order.findAndCountAll({
        where,
        attributes: [
            'id',
            'order_number',
            'customer_name',
            'customer_phone',
            'total',
            'payment_method',
            'payment_status',
            'delivery_provider',
            'delivery_consignment_id',
            'delivery_tracking_code',
            'delivery_status',
            'order_status',
            'delivery_address',
            'delivery_notes',
            'created_at',
            'updated_at',
        ],
        order: [['updated_at', 'DESC']],
        limit,
        offset: (page - 1) * limit,
    });

    const parcels = rows.map((row) => ({
        order_id: row.id,
        order_number: row.order_number,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        total_amount: Number(row.total) || 0,
        cod_amount: expectedCodAmount(row),
        delivery_provider: row.delivery_provider,
        consignment_id: row.delivery_consignment_id,
        tracking_code: row.delivery_tracking_code,
        delivery_status: row.delivery_status,
        order_status: row.order_status,
        delivery_address: row.delivery_address,
        problem_reason: row.delivery_notes || `Status: ${row.delivery_status}`,
        updated_at: row.updated_at,
    }));

    sendSuccess(res, {
        parcels,
        pagination: {
            page,
            limit,
            total: count,
            hasNextPage: page * limit < count,
        },
    });
});

/**
 * GET /api/mobile/orders/:orderId/tracking
 * Returns the timeline and current tracking info for an order.
 */
const getDeliveryTracking = asyncHandler(async (req, res) => {
    const orderId = orderIdFrom(req);
    const shopId = req.shop.id;

    if (!Order) {
        throw new AppError('Order database entity unavailable', 500, 'INTERNAL_ERROR');
    }

    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId },
        attributes: [
            'id',
            'order_number',
            'customer_name',
            'customer_phone',
            'total',
            'payment_method',
            'payment_status',
            'delivery_provider',
            'delivery_consignment_id',
            'delivery_tracking_code',
            'delivery_status',
            'order_status',
            'delivery_address',
            'created_at',
            'updated_at',
        ],
    });

    if (!order) {
        throw new AppError('Order not found', 404, 'NOT_FOUND');
    }

    if (!DeliveryTracking || typeof DeliveryTracking.findOne !== 'function') {
        throw new AppError(
            'Courier tracking is temporarily unavailable. Try again shortly.',
            503,
            'COURIER_TRACKING_READ_UNAVAILABLE',
        );
    }

    let tracking;
    try {
        tracking = await DeliveryTracking.findOne({
            where: { order_id: order.id },
            order: [['created_at', 'DESC']],
        });
    } catch (_) {
        throw new AppError(
            'Courier tracking is temporarily unavailable. Try again shortly.',
            503,
            'COURIER_TRACKING_READ_UNAVAILABLE',
        );
    }

    let trackingIdentity = null;
    if (tracking) {
        trackingIdentity = resolveCourierTrackingIdentity(tracking.provider, tracking.tracking_number);
        if (!trackingIdentity) {
            throw new AppError(
                'Courier tracking details are unavailable. Do not book again; reconcile with the provider.',
                503,
                'COURIER_TRACKING_UNAVAILABLE',
            );
        }
    } else {
        const hasPersistedTrackingFields = [
            order.delivery_provider,
            order.delivery_tracking_code,
            order.delivery_consignment_id,
        ].some((value) => typeof value === 'string' && value.trim());
        if (hasPersistedTrackingFields) {
            trackingIdentity = resolveCourierTrackingIdentity(
                order.delivery_provider,
                order.delivery_tracking_code,
                order.delivery_consignment_id,
            );
            if (!trackingIdentity) {
                throw new AppError(
                    'Courier tracking details are unavailable. Do not book again; reconcile with the provider.',
                    503,
                    'COURIER_TRACKING_UNAVAILABLE',
                );
            }
        } else if (order.delivery_status
            && !NO_COURIER_BOOKING_STATUSES.has(String(order.delivery_status).trim().toLowerCase())) {
            throw new AppError(
                'Courier tracking details are unavailable. Do not book again; reconcile with the provider.',
                503,
                'COURIER_TRACKING_UNAVAILABLE',
            );
        }
    }

    const history = Array.isArray(tracking?.status_history) ? tracking.status_history : [];

    sendSuccess(res, {
        order_id: order.id,
        order_number: order.order_number,
        provider: trackingIdentity?.provider || null,
        tracking_number: trackingIdentity?.trackingNumber || null,
        consignment_id: normalizeTrackingId(order.delivery_consignment_id),
        current_status: tracking?.current_status || order.delivery_status || (trackingIdentity ? 'booked' : 'not_booked'),
        estimated_delivery: tracking?.estimated_delivery || null,
        actual_delivery: tracking?.actual_delivery || null,
        location_info: tracking?.location_info || null,
        delivery_agent_info: tracking?.delivery_agent_info || null,
        status_history: history,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        delivery_address: order.delivery_address,
        total_amount: Number(order.total) || 0,
        cod_amount: expectedCodAmount(order),
        cod_derived_note: 'Expected COD is shown only from the recorded payment method and pending payment state; reconciled cash requires provider settlement.',
    });
});

module.exports = {
    bookCourier,
    getProblemParcels,
    getDeliveryTracking,
};
