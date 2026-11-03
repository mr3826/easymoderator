const orderService = require('./order.service');
const returnService = require('./return.service');
const { validationResult } = require('express-validator');
const { AppError } = require('../../utils/AppError');
const {
    normalizeCourierProvider,
    normalizeTrackingId,
    resolveCourierTrackingIdentity,
    trackingUnavailableMessage,
} = require('../delivery/tracking-identity');

const getIdempotencyKey = (req) => {
    const value = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
    if (value === undefined) return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
        throw new AppError('Idempotency-Key must contain 1-128 safe characters', 400);
    }
    return value;
};

/**
 * Create a new order (legacy)
 */
const createOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const idempotencyKey = getIdempotencyKey(req);
        const order = idempotencyKey
            ? await orderService.createOrder(req.user.userId, shopId, req.body, idempotencyKey)
            : await orderService.createOrder(req.user.userId, shopId, req.body);

        res.status(201).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update an order (legacy)
 */
const updateOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const order_id = req.body.order_id || req.body.id || req.query.order_id || req.query.id;
        if (!order_id) {
            throw new AppError('Order ID is required', 400);
        }
        const updateData = { ...req.body };
        delete updateData.order_id;
        delete updateData.id;
        const order = await orderService.updateOrder(
            order_id,
            req.user.userId,
            shopId,
            updateData
        );

        res.status(200).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get a single order (legacy)
 */
const getOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const orderId = req.query.order_id || req.query.id;
        if (!orderId) {
            throw new AppError('Order ID is required', 400);
        }
        const order = await orderService.getOrderById(
            orderId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * List orders with filters (legacy)
 */
const listOrders = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        // Extract filters
        const filters = req.query; // Already validated
        const orders = await orderService.listOrders(
            req.user.userId,
            shopId,
            filters
        );

        res.status(200).json({
            success: true,
            data: orders
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete an order (legacy)
 */
const deleteOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const orderId = req.body.order_id || req.body.id || req.query.order_id || req.query.id;
        if (!orderId) {
            throw new AppError('Order ID is required', 400);
        }
        const result = await orderService.deleteOrder(
            orderId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Create a draft order
 */
const createDraftOrder = async (req, res, next) => {
    // Same as createOrder for now, since createOrder creates drafts
    return createOrder(req, res, next);
};

/**
 * Confirm a draft order
 */
const confirmOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const orderId = req.params.orderId || req.params.id || req.body.orderId;
        if (!orderId) {
            throw new AppError('Order ID is required', 400);
        }

        const order = await orderService.confirmOrder(
            orderId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get orders with pagination and filters
 */
const getOrders = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const options = req.query; // Already validated
        const result = await orderService.listOrders(req.user.userId, shopId, options);

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get order by ID
 */
const getOrderById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params; // Already validated
        const order = await orderService.getOrderById(id, req.user.userId, shopId);

        res.status(200).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Get orders by customer
 */
const getOrdersByCustomer = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { customerId } = req.params;
        const orders = await orderService.getOrdersByCustomer(
            req.user.userId,
            shopId,
            customerId,
            req.query
        );

        res.status(200).json({
            orders: orders.map(order => ({
                order_id: order.id,
                status: order.order_status,
                total: order.total,
                created_at: order.created_at
            })),
            total: orders.length
        });
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Cancel order
 */
const cancelOrder = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { orderId } = req.params;
        const { reason, customer_id } = req.body;

        const order = await orderService.cancelOrder(
            req.user.userId,
            shopId,
            orderId,
            reason,
            customer_id
        );

        res.status(200).json({
            success: true,
            data: order,
            order_id: order.id,
            status: order.order_status,
            refund_status: 'pending',
            updated_at: order.updated_at
        });
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Create return request
 */
const createReturnRequest = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { orderId } = req.params;
        const request = await orderService.createReturnRequest(
            req.user.userId,
            shopId,
            orderId,
            req.body
        );

        res.status(201).json({
            return_request_id: request.id,
            status: request.status,
            created_at: request.created_at
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Create order
 */
const createOrderRest = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const idempotencyKey = getIdempotencyKey(req);
        const order = idempotencyKey
            ? await orderService.createOrder(req.user.userId, shopId, req.body, idempotencyKey)
            : await orderService.createOrder(req.user.userId, shopId, req.body);

        res.status(201).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Update order by ID
 * Only orders in 'pending' or 'draft' status can be edited.
 * Edits to 'processing', 'shipped', or 'delivered' orders are rejected with 409.
 * All changes are recorded in the order metadata audit_log.
 */
const updateOrderById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params; // Already validated
        const order = await orderService.updateOrder(
            id,
            req.user.userId,
            shopId,
            req.body // Already validated
        );

        res.status(200).json({
            success: true,
            data: order
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Delete order by ID
 */
const deleteOrderById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params; // Already validated
        const result = await orderService.deleteOrder(
            id,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Feature: Send tracking notification to customer
 * POST /orders/:id/send-tracking
 */
const sendTrackingNotification = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params;
        const { trackingNumber, courier, estimatedDelivery } = req.body;

        if (!trackingNumber || !courier) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'trackingNumber and courier are required'
                }
            });
        }

        const orderTrackingService = require('./order-tracking.service');
        const result = await orderTrackingService.sendTrackingNotification(id, shopId, {
            trackingNumber,
            courier,
            estimatedDelivery: estimatedDelivery || null
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Bug #7: Bulk order import.
 * POST /orders/bulk
 * Body: { orders: [ { customer_name, customer_phone, delivery_address, items: [...], ... } ] }
 * Returns per-row results so the frontend can show which rows succeeded and which failed.
 */
const bulkCreateOrders = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' }
            });
        }

        const { orders } = req.body;
        if (!Array.isArray(orders) || orders.length === 0) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'orders must be a non-empty array' }
            });
        }

        if (orders.length > 500) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Maximum 500 orders per bulk import' }
            });
        }

        const results = await Promise.allSettled(
            orders.map((orderData, index) =>
                orderService.createOrder(req.user.userId, shopId, orderData)
                    .then(order => ({ index: index + 1, success: true, order_id: order.id, order_number: order.order_number }))
                    .catch(err => ({ index: index + 1, success: false, error: err.message }))
            )
        );

        const settled = results.map(r => r.value);
        const succeeded = settled.filter(r => r.success).length;
        const failed    = settled.filter(r => !r.success).length;

        res.status(207).json({
            success: true,
            summary: { total: orders.length, succeeded, failed },
            results: settled
        });
    } catch (error) {
        next(error);
    }
};

/**
 * D3: Initiate a return request for a delivered order
 * POST /orders/:orderId/return
 * Body: { customerId?, reason }
 */
const initiateReturn = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' }
            });
        }

        const { orderId } = req.params;
        const { customerId, reason } = req.body;

        const result = await returnService.initiateReturn(shopId, orderId, customerId, reason);
        res.status(201).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

/**
 * D3: Update return status for an order
 * PATCH /orders/:orderId/return/status
 * Body: { status }
 */
const updateReturnStatus = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' }
            });
        }

        const { orderId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'status is required' }
            });
        }

        const result = await returnService.updateReturnStatus(shopId, orderId, status);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

/**
 * D3: List all return requests for the shop
 * GET /orders/returns
 */
const getReturnRequests = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' }
            });
        }

        const filters = req.query;
        const returns = await returnService.getReturnRequests(shopId, filters);
        res.status(200).json({ success: true, data: returns });
    } catch (error) {
        next(error);
    }
};

/**
 * Read-only pre-flight for the booking modal.
 *
 * Answers "can this courier reach this order's address?" without booking
 * anything. UNCERTAIN and CHECK_UNAVAILABLE are valid answers: the UI shows
 * them honestly instead of pretending the destination is verified.
 */
const getCourierEligibility = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        const shopId = req.user?.shopId;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Shop ID required' } });
        }

        const { Order } = require('../entities');
        const order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
        if (!order) {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
        }

        const eligibility = await orderService.getCourierDestinationEligibility(order, {
            shopId,
            provider: req.query.provider || null,
        });

        res.status(200).json({ success: true, data: eligibility });
    } catch (error) {
        next(error);
    }
};

const bookCourier = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        const shopId = req.user?.shopId;
        const {
            provider,
            recipient_name,
            recipient_phone,
            recipient_address,
            weight_kg,
            item_weight,
            item_description,
            delivery_type,
            item_type,
            note,
        } = req.body;

        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Shop ID required' } });
        }

        const { Order } = require('../entities');
        const order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
        if (!order) {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
        }

        const result = await orderService.bookForOrder(order, {
            shopId,
            provider: provider || null,
            requireAiDefault: !provider,
            trigger: 'MANUAL',
            mutationAuthority: { kind: 'human', userId: req.user?.userId || req.user?.id },
            overrides: {
                // These fields remain accepted for the legacy endpoint, but the
                // canonical helper prefers persisted order values over them.
                recipient_name,
                recipient_phone,
                recipient_address,
                item_weight: item_weight ?? weight_kg,
                item_description,
                delivery_type,
                item_type,
                note,
            },
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

        // RTO Shield v2: the order must be verified (or approved by an
        // owner/admin) before a parcel is booked. Enforced server-side in
        // bookForOrder; this only reports it.
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

        res.json({
            success: true,
            data: {
                tracking_id: trackingIdentity.trackingNumber,
                consignment_id: normalizeTrackingId(result.consignment_id),
                provider: trackingIdentity.provider,
                booked_at: new Date().toISOString(),
            }
        });
    } catch (error) {
        // IC-V1 (review F2): the service throws structured AppErrors (409
        // DRAFT_ORDER_NOT_BOOKABLE, 403 TENANT_MISMATCH, 400 VALIDATION_ERROR)
        // that must reach merchants with their declared code/status; unstructured
        // failures keep the historical COURIER_BOOKING_FAILED wrap untouched.
        const declared = Number(error.statusCode || error.status);
        if (Number.isInteger(declared) && declared >= 400 && declared < 500) {
            return res.status(declared).json({
                success: false,
                error: {
                    code: error.code || 'COURIER_BOOKING_REJECTED',
                    message: error.message,
                    ...(Array.isArray(error.details?.reasons) ? { reasons: error.details.reasons } : {}),
                },
            });
        }
        const statusCode = error.message?.includes('No active delivery') ? 400 : 500;
        res.status(statusCode).json({
            success: false,
            error: { code: 'COURIER_BOOKING_FAILED', message: error.message }
        });
    }
};

module.exports = {
    // RESTful methods
    getOrders,
    getOrderById,
    getOrdersByCustomer,
    cancelOrder,
    createReturnRequest,
    createOrderRest,
    updateOrderById,
    deleteOrderById,
    bulkCreateOrders,
    // Return automation (D3)
    initiateReturn,
    updateReturnStatus,
    getReturnRequests,
    // Legacy methods (for backward compatibility)
    createOrder,
    updateOrder,
    getOrder,
    listOrders,
    deleteOrder,
    createDraftOrder,
    confirmOrder,
    getCourierEligibility,
    bookCourier
};
