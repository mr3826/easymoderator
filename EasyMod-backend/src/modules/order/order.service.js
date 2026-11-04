const { Order, OrderItem, Product, ProductVariant, Customer, UserShop, OrderReturn, CourierDispatch, AuditLog, PaymentConfig } = require('../entities');
const courierDispatchClaims = require('../delivery/courier-dispatch-claim.service');
const { AppError, sanitizeErrorMessage } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { Op, literal } = require('sequelize');
const deliveryService = require('../delivery/delivery.service');
const subscriptionService = require('../subscription/subscription.service');
const { createLogger } = require('../../utils/structured-logger');
const { invalidate: invalidateStock } = require('../product/stock-status-guard.service');
const { findOrderByIdempotencyKey } = require('./order-idempotency.service');
const { isRuntimeFlagEnabled } = require('../../config/ai-runtime-flags');
const { normalizeCourierProvider, normalizeTrackingId, trackingUnavailableMessage } = require('../delivery/tracking-identity');
const { BUCKET_KEYS, buildBucketWhere, buildBucketSql } = require('./order-worklist.buckets');

/**
 * Constants for order processing
 */
const DEFAULT_COD_MAX_AMOUNT = 50000; // BDT
const DEFAULT_CURRENCY = 'BDT';
const ORDER_NUMBER_PAD_LENGTH = 6;
const SHOP_PREFIX_LENGTH = 8;
const RTO_RISK_THRESHOLD = 70;

// State values recognized by post-create consistency handling. Pending remains
// a supported create state; terminal client-supplied values are rejected before
// persistence but stay recognized for server-authoritative lifecycle writes.
const ORDER_STATES = ['draft', 'pending', 'confirmed', 'processing', 'completed', 'placed', 'paid', 'fulfilled', 'cancelled', 'refunded'];
const PAYMENT_STATES = ['pending', 'paid', 'unpaid', 'refunded', 'partially_paid'];
const COD_PAYMENT_METHODS = new Set(['cod', 'cash', 'cash_on_delivery']);
const NON_BOOKABLE_ORDER_STATES = new Set([
    'completed', 'delivered', 'shipped', 'cancelled', 'fulfilled', 'returned', 'refunded', 'partial_returned',
]);
const ORDER_STATUS_TRANSITIONS = {
    draft: ['confirmed'],
    // Pending is the primary create state (storefront, inbox, manual orders);
    // merchant confirmation must remain available.
    pending: ['confirmed'],
    confirmed: ['processing', 'completed'],
    processing: ['completed'],
};
const COURIER_MUTATION_FIELDS = new Set([
    'order_status', 'fulfillment_status', 'payment_status', 'payment_method',
    'customer_name', 'customer_phone', 'delivery_address', 'items', 'quantity',
    'subtotal', 'discount', 'tax', 'delivery_fee', 'total', 'note', 'notes',
]);

const COURIER_SETUP_REQUIRED_STATUS = 'courier_setup_required';
const DISPATCH_INDETERMINATE_STATUS = 'dispatch_indeterminate';
// RTO Shield v2: courier booking paused until the order is verified/approved.
const CONFIDENCE_HOLD_STATUS = 'confidence_hold';
const DISPATCH_NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Verify user has access to shop
 */
const verifyShopAccess = async (userId, shopId, transaction = null) => {
    const userShop = await UserShop.findOne({
        where: {
            user_id: userId,
            shop_id: shopId,
            is_active: true
        },
        ...(transaction ? { transaction } : {}),
    });

    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }
    return userShop;
};

/**
 * Generate next order number (ORD-001, ORD-002...) — P2-4: race-free via sequence table
 * Uses order_sequences table with atomic UPDATE/INSERT + RETURNING (Postgres) or transaction (SQLite).
 */
const generateOrderNumber = async (shopId, transaction = null) => {
    const dialect = sequelize.getDialect();
    const q = transaction ? (sql, opts) => sequelize.query(sql, { ...opts, transaction }) : (sql, opts) => sequelize.query(sql, opts);

    if (dialect === 'postgres') {
        const [rows] = await q(
            `INSERT INTO order_sequences (shop_id, next_number)
             VALUES (:shopId, 1)
             ON CONFLICT (shop_id) DO UPDATE SET next_number = order_sequences.next_number + 1
             RETURNING next_number`,
            { replacements: { shopId } }
        );
        const nextNumber = rows && rows[0] ? rows[0].next_number : 1;
        const shopPrefix = String(shopId).replace(/-/g, '').slice(0, 8).toUpperCase();
        return `ORD-${shopPrefix}-${nextNumber.toString().padStart(6, '0')}`;
    }

    // SQLite: transaction + SELECT then UPDATE
    const t = transaction || await sequelize.transaction();
    try {
        const [existing] = await sequelize.query(
            'SELECT next_number FROM order_sequences WHERE shop_id = ?',
            { replacements: [shopId], transaction: t }
        );
        let nextNumber = 1;
        if (existing && existing.length > 0) {
            nextNumber = existing[0].next_number + 1;
            await sequelize.query(
                'UPDATE order_sequences SET next_number = ? WHERE shop_id = ?',
                { replacements: [nextNumber, shopId], transaction: t }
            );
        } else {
            await sequelize.query(
                'INSERT INTO order_sequences (shop_id, next_number) VALUES (?, 1)',
                { replacements: [shopId], transaction: t }
            );
        }
        if (!transaction) await t.commit();
        const shopPrefix = String(shopId).replace(/-/g, '').slice(0, 8).toUpperCase();
        return `ORD-${shopPrefix}-${nextNumber.toString().padStart(6, '0')}`;
    } catch (err) {
        if (!transaction) await t.rollback();
        throw err;
    }
};

/**
 * Create a new order
 * CRITICAL: Tracks usage for billing on successful creation
 */
/**
 * Check if order is COD (Cash on Delivery)
 */
const isCodOrder = (paymentStatus, paymentMethod) => {
    return isCodPaymentMethod(paymentMethod)
        && ['unpaid', 'pending', 'partially_paid', null, undefined].includes(paymentStatus);
};

const isCodPaymentMethod = (paymentMethod) => COD_PAYMENT_METHODS.has(
    String(paymentMethod || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
);

const hasCodPaymentMethodHistory = (order) => {
    let metadata = order?.metadata || {};
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
    }
    return Array.isArray(metadata.audit_log) && metadata.audit_log.some((entry) => {
        const change = entry?.changes?.payment_method;
        return change && [change.from, change.to].some(isCodPaymentMethod);
    });
};

const normalizeOrderStatus = (status) => String(status || '').trim().toLowerCase();

/**
 * Run RTO Shield check for COD orders
 */
const runRtoShieldCheck = async (customerPhone, shopId) => {
    if (!customerPhone) return { blocked: false };

    const RtoShieldService = require('../rto-shield/rto-shield.service');
    const { getNetworkSettings } = require('../rto-shield/rto-network-settings');

    // Honor the shop's network participation: opted-out shops are scored on their own list only.
    let enforceNetwork = false;
    try {
        enforceNetwork = (await getNetworkSettings(shopId)).enforce === true;
    } catch (_) { /* Do not consume a shared signal when consent settings are unavailable. */ }

    const result = await RtoShieldService.checkPhone(customerPhone, shopId, {
        trustedContext: true,
        enforceNetwork,
    });
    // A phone signal is review evidence, never an order-create auto-decline.
    return {
        blocked: false,
        tier: result.tier,
        requiresVerification: result.tier === 'verify'
            || (result.flagged && Number(result.risk_score) >= RTO_RISK_THRESHOLD),
    };
};

/**
 * Validate order items and calculate totals
 */
const validateItemsAndCalculateTotals = async (
    items,
    shopId,
    transaction,
    { requireVariantSelection = false, requireActiveProducts = false, allowBackorder = true } = {},
) => {
    const itemIds = [...new Set(items.map((item) => item.product_id))].sort();
    const productQuery = {
        where: { id: { [Op.in]: itemIds }, shop_id: shopId },
        order: [['id', 'ASC']],
        transaction
    };
    if (transaction?.LOCK?.UPDATE) productQuery.lock = transaction.LOCK.UPDATE;
    const products = await Product.findAll(productQuery);
    const productMap = new Map(products.map((p) => [p.id, p]));
    const shouldLoadVariants = requireVariantSelection || items.some((item) => item.variant_id);
    let activeVariantsById = new Map();
    const activeVariantsByProduct = new Map();
    if (shouldLoadVariants) {
        if (typeof ProductVariant?.findAll !== 'function') {
            throw new AppError('Product variants are unavailable', 503, 'VARIANT_CATALOG_UNAVAILABLE');
        }
        const variantQuery = {
            where: { product_id: { [Op.in]: itemIds }, is_active: true },
            order: [['product_id', 'ASC'], ['id', 'ASC']],
            transaction,
        };
        if (transaction?.LOCK?.UPDATE) variantQuery.lock = transaction.LOCK.UPDATE;
        const variants = await ProductVariant.findAll(variantQuery);
        activeVariantsById = new Map(variants.map((variant) => [variant.id, variant]));
        for (const variant of variants) {
            if (!activeVariantsByProduct.has(variant.product_id)) activeVariantsByProduct.set(variant.product_id, []);
            activeVariantsByProduct.get(variant.product_id).push(variant);
        }
    }

    const requestedQuantityByInventoryItem = new Map();
    for (const item of items) {
        const inventoryId = item.variant_id || item.product_id;
        requestedQuantityByInventoryItem.set(inventoryId,
            (requestedQuantityByInventoryItem.get(inventoryId) || 0) + Number(item.quantity));
    }

    let subtotal = 0;
    const validItems = [];

    for (const item of items) {
        const product = productMap.get(item.product_id);
        if (!product) {
            throw new AppError(`Product not found: ${item.product_id}`, 404);
        }
        if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) {
            throw new AppError('Item quantity must be a positive integer', 400, 'INVALID_ORDER_QUANTITY');
        }
        if (requireActiveProducts && (product.is_active === false || product.in_stock === false)) {
            throw new AppError(`Product is not available: ${product.name}`, 409, 'PRODUCT_UNAVAILABLE');
        }

        const activeVariants = activeVariantsByProduct.get(product.id) || [];
        let variant = null;
        if (item.variant_id) {
            variant = activeVariantsById.get(item.variant_id);
            if (!variant || variant.product_id !== product.id) {
                throw new AppError('Selected product variant is not available', 400, 'INVALID_PRODUCT_VARIANT');
            }
        } else if (requireVariantSelection && activeVariants.length > 0) {
            throw new AppError('Select a product variant before checkout', 400, 'PRODUCT_VARIANT_REQUIRED');
        }
        if (requireVariantSelection && activeVariants.length === 0 && item.variant_id) {
            throw new AppError('Selected product variant is not available', 400, 'INVALID_PRODUCT_VARIANT');
        }

        const inventoryItem = variant || product;
        const inventoryId = variant?.id || product.id;
        const requiresStockCheck = product.track_quantity && (!allowBackorder || !product.allow_backorder);
        const availableQuantity = Number(inventoryItem.quantity);
        const insufficientStock = requiresStockCheck && (
            !Number.isInteger(availableQuantity)
            || availableQuantity < requestedQuantityByInventoryItem.get(inventoryId)
        );
        if (insufficientStock) {
            throw new AppError(`Insufficient stock for product: ${product.name}`, 409, 'INSUFFICIENT_STOCK');
        }

        // Use current server-side variant or product pricing; request prices are ignored.
        const unitPrice = Number(variant?.price ?? product.price);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            throw new AppError(`Catalog price is invalid for product: ${product.name}`, 409, 'CATALOG_PRICE_INVALID');
        }
        const itemTotal = unitPrice * item.quantity;
        subtotal += itemTotal;

        validItems.push({
            product_id: product.id,
            variant_id: variant?.id || null,
            quantity: item.quantity,
            price: unitPrice,
            total: itemTotal,
            productInstance: product,
            variantInstance: variant,
        });
    }

    return { validItems, subtotal };
};

/**
 * Calculate order totals from subtotal and adjustments
 */
const calculateOrderTotals = (subtotal, discount = 0, tax = 0, deliveryFee = 0) => ({
    subtotal,
    discount: parseFloat(discount || 0),
    tax: parseFloat(tax || 0),
    deliveryFee: parseFloat(deliveryFee || 0),
    total: subtotal - parseFloat(discount || 0) + parseFloat(tax || 0) + parseFloat(deliveryFee || 0)
});

/**
 * Validate COD order doesn't exceed max amount
 */
const validateCodOrderAmount = (total, currency = DEFAULT_CURRENCY) => {
    const codMax = parseInt(process.env.COD_ORDER_MAX_VALUE || String(DEFAULT_COD_MAX_AMOUNT), 10);

    if (total > codMax) {
        throw new AppError(
            `COD orders cannot exceed ${currency} ${codMax.toLocaleString()}. Please use an online payment method for large orders.`,
            422
        );
    }
};

/**
 * Create order items and deduct stock atomically
 */
const createOrderItemsAndDeductStock = async (orderId, validItems, shopId, transaction) => {
    for (const item of validItems) {
        await OrderItem.create({
            order_id: orderId,
            product_id: item.product_id,
            variant_id: item.variant_id,
            quantity: item.quantity,
            price: item.price,
            total: item.total
        }, { transaction });

        // Atomic stock deduction
        if (item.productInstance.track_quantity) {
            const inventoryInstance = item.variantInstance || item.productInstance;
            await inventoryInstance.decrement('quantity', {
                by: item.quantity,
                transaction
            });
            // Invalidate Redis stock cache after commit (fire-and-forget with retry)
            invalidateStockWithRetry(shopId, item.product_id);
        }
    }
};

/**
 * Invalidate stock cache with basic retry logic
 */
const invalidateStockWithRetry = async (shopId, productId, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await invalidateStock(shopId, productId);
            return;
        } catch (err) {
            if (attempt === maxRetries) {
                console.error(`Failed to invalidate stock cache after ${maxRetries} attempts`, err);
                return;
            }
            // Exponential backoff: 100ms, 200ms, 400ms
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
        }
    }
};

/**
 * Enforce state consistency on order
 */
const enforceStateConsistency = async (order) => {
    let needsSave = false;

    if (!PAYMENT_STATES.includes(order.payment_status)) {
        order.payment_status = 'pending';
        needsSave = true;
    }

    if (!ORDER_STATES.includes(order.order_status)) {
        order.order_status = 'draft';
        needsSave = true;
    }

    if (needsSave) {
        await order.save();
    }
};

/**
 * Track order usage after successful creation
 */
const trackOrderUsage = async (order, shopId, requestId, logger) => {
    try {
        const usageResult = await subscriptionService.trackUsage(
            shopId,
            'orders',
            1,
            requestId
        );
        order.usage_transaction_id = usageResult.transactionId;
        await order.save();
    } catch (usageErr) {
        logger.error('Failed to track usage', usageErr);
    }
};

const restoreOrderInventory = async (orderId, shopId, transaction) => {
    const items = await OrderItem.findAll({ where: { order_id: orderId }, transaction });
    const quantityByProduct = new Map();
    const quantityByVariant = new Map();
    for (const item of items) {
        const quantity = Number(item.quantity);
        if (!item.product_id || !Number.isFinite(quantity) || quantity <= 0) continue;
        if (item.variant_id) {
            quantityByVariant.set(item.variant_id, (quantityByVariant.get(item.variant_id) || 0) + quantity);
        } else {
            quantityByProduct.set(item.product_id, (quantityByProduct.get(item.product_id) || 0) + quantity);
        }
    }

    const productIds = [...new Set([
        ...quantityByProduct.keys(),
        ...items.filter((item) => item.variant_id).map((item) => item.product_id),
    ])].sort();
    if (productIds.length === 0) return;
    const productQuery = {
        where: { id: { [Op.in]: productIds }, shop_id: shopId },
        order: [['id', 'ASC']],
        transaction,
    };
    if (transaction?.LOCK?.UPDATE) productQuery.lock = transaction.LOCK.UPDATE;
    const products = await Product.findAll(productQuery);
    const productsById = new Map(products.map((product) => [product.id, product]));

    if (quantityByVariant.size > 0) {
        const variantQuery = {
            where: { id: { [Op.in]: [...quantityByVariant.keys()].sort() } },
            order: [['id', 'ASC']],
            transaction,
        };
        if (transaction?.LOCK?.UPDATE) variantQuery.lock = transaction.LOCK.UPDATE;
        const variants = await ProductVariant.findAll(variantQuery);
        const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
        for (const [variantId, quantity] of quantityByVariant) {
            const variant = variantsById.get(variantId);
            const product = variant && productsById.get(variant.product_id);
            if (!product?.track_quantity) continue;
            await variant.increment('quantity', { by: quantity, transaction });
            invalidateStockWithRetry(shopId, product.id);
        }
    }

    for (const productId of productIds) {
        const product = productsById.get(productId);
        const quantity = quantityByProduct.get(productId) || 0;
        if (!product?.track_quantity || quantity <= 0) continue;
        await product.increment('quantity', {
            by: quantity,
            transaction,
        });
        invalidateStockWithRetry(shopId, productId);
    }
};

const acquireOrderIdempotencyLock = async (shopId, requestId, transaction) => {
    if (!requestId || sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
        'SELECT pg_advisory_xact_lock(hashtext(:key))',
        {
            replacements: { key: `order:${shopId}:${requestId}` },
            transaction,
        },
    );
};

const acquireStorefrontCustomerLock = async (shopId, phone, transaction) => {
    if (!phone || sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
        'SELECT pg_advisory_xact_lock(hashtext(:key))',
        { replacements: { key: `storefront-customer:${shopId}:${phone}` }, transaction },
    );
};

const returnIdempotentReplay = (order, payloadHash) => {
    if (!payloadHash) return order;
    let metadata = order?.metadata || {};
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
    }
    if (metadata?.storefront?.idempotency_payload_hash !== payloadHash) {
        throw new AppError('Idempotency key was already used with a different checkout payload', 409, 'IDEMPOTENCY_KEY_REUSED');
    }
    return order;
};

const findOrCreateStorefrontCustomer = async (shopId, orderData, transaction) => {
    await acquireStorefrontCustomerLock(shopId, orderData.customer_phone, transaction);
    const query = {
        where: { shop_id: shopId, phone: orderData.customer_phone },
        transaction,
    };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const existing = await Customer.findOne(query);
    if (existing) return existing;
    return Customer.create({
        shop_id: shopId,
        name: orderData.customer_name,
        phone: orderData.customer_phone,
        channel_type: 'webchat',
        channel_user_id: `storefront:${orderData.customer_phone}`,
        metadata: { source: 'storefront' },
    }, { transaction });
};

/**
 * Core order creation logic — shared by createOrder (user-auth) and createOrderInternal (chatbot/automated).
 * Refactored for clarity, testability, and maintainability.
 */
const _createOrderCore = async (shopId, orderData, logger, requestId = null, {
    payloadHash = null,
    validateSelection = null,
    createStorefrontCustomer = false,
    strictIdempotencyRead = false,
} = {}) => {
    const requestedFulfillmentStatus = orderData?.fulfillment_status;
    if (requestedFulfillmentStatus !== undefined
        && requestedFulfillmentStatus !== null
        && String(requestedFulfillmentStatus).trim().toLowerCase() !== 'unfulfilled') {
        throw new AppError(
            'Fulfillment status is server-authoritative and cannot be set during order creation.',
            409,
            'FULFILLMENT_STATUS_SERVER_AUTHORITY',
        );
    }
    if (NON_BOOKABLE_ORDER_STATES.has(normalizeOrderStatus(orderData?.order_status))) {
        throw new AppError(
            'Terminal order statuses cannot be set during order creation.',
            400,
            'ORDER_STATUS_SERVER_AUTHORITY',
        );
    }
    const paymentMethodIdAliases = [orderData?.paymentMethodId, orderData?.payment_method_id]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim().toLowerCase());
    if (paymentMethodIdAliases.length > 1
        && paymentMethodIdAliases.some((value) => value !== paymentMethodIdAliases[0])) {
        throw new AppError(
            'Payment method ID aliases must refer to the same configured payment method.',
            400,
            'PAYMENT_METHOD_ID_CONFLICT',
        );
    }
    const paymentMethodId = paymentMethodIdAliases.find(Boolean) || null;
    let configuredPaymentMethod = null;
    if (paymentMethodId) {
        if (typeof PaymentConfig?.findOne !== 'function') {
            throw new AppError('The selected payment method cannot be verified for this shop.', 409, 'PAYMENT_METHOD_CONFIGURATION_REQUIRED');
        }
        const paymentConfig = await PaymentConfig.findOne({
            where: { id: paymentMethodId, shop_id: shopId },
            attributes: ['gateway'],
        });
        configuredPaymentMethod = String(paymentConfig?.gateway || '').trim();
        if (!configuredPaymentMethod) {
            throw new AppError('The selected payment method is not configured for this shop.', 400, 'PAYMENT_METHOD_NOT_AVAILABLE');
        }
        if (orderData?.payment_method
            && isCodPaymentMethod(orderData.payment_method) !== isCodPaymentMethod(configuredPaymentMethod)) {
            throw new AppError('The payment method does not match the selected shop configuration.', 400, 'PAYMENT_METHOD_CONFIGURATION_MISMATCH');
        }
    }
    const resolvedPaymentMethod = configuredPaymentMethod || orderData?.payment_method || null;
    const creatingPaidOrder = String(orderData?.payment_status || '').trim().toLowerCase() === 'paid';
    if (creatingPaidOrder
        && isCodPaymentMethod(resolvedPaymentMethod)) {
        throw new AppError(
            'COD orders cannot be created as paid. Use the owner-confirmed COD settlement action after full delivery.',
            409,
            'COD_SETTLEMENT_PATH_REQUIRED',
        );
    }

    const findExistingOrder = (transaction = null) => strictIdempotencyRead
        ? Order.findOne({ where: { shop_id: shopId, idempotency_key: requestId }, transaction })
        : findOrderByIdempotencyKey(shopId, requestId, transaction ? { transaction } : {});

    // A replay must return its committed order even if the shop's current usage
    // limit or RTO policy changed after the original request.
    if (requestId) {
        const existingOrder = await findExistingOrder();
        if (existingOrder) return returnIdempotentReplay(existingOrder, payloadHash);
    }

    // USAGE_LIMIT_EXCEEDED check BEFORE creating the DB transaction
    await subscriptionService.checkOrderLimit(shopId);

    // RTO Shield: check phone blacklist for COD orders before opening transaction
    const codOrder = isCodOrder(orderData.payment_status, resolvedPaymentMethod);
    if (codOrder) {
        const rtoCheck = await runRtoShieldCheck(orderData.customer_phone, shopId);
        if (rtoCheck.requiresVerification) {
            // Preserve the signal for review. The booking-confidence gate remains
            // the server-side control before any courier mutation.
            logger.warn('RTO Shield: COD booking review required', {
                decision: 'manual_review_required',
                riskTier: rtoCheck.tier || 'high',
            });
        }
    }

    const transaction = await sequelize.transaction();

    try {
        if (requestId) {
            await acquireOrderIdempotencyLock(shopId, requestId, transaction);
            const existingOrder = await findExistingOrder(transaction);
            if (existingOrder) {
                await transaction.commit();
                return returnIdempotentReplay(existingOrder, payloadHash);
            }
        }

        if (typeof validateSelection === 'function') {
            await validateSelection({ transaction, items: orderData.items });
        }

        // 1. Validate items and calculate subtotal
        const { validItems, subtotal } = await validateItemsAndCalculateTotals(
            orderData.items,
            shopId,
            transaction,
            {
                requireVariantSelection: createStorefrontCustomer,
                requireActiveProducts: createStorefrontCustomer,
                allowBackorder: !createStorefrontCustomer,
            },
        );

        // 2. Calculate order totals
        const totals = calculateOrderTotals(
            subtotal,
            orderData.discount,
            orderData.tax,
            orderData.delivery_fee
        );

        // 3. Validate COD order amount
        if (codOrder) {
            validateCodOrderAmount(totals.total);
        }

        // 4. Generate Order Number
        const orderNumber = await generateOrderNumber(shopId, transaction);

        // Denormalized line-item snapshot for the order's JSON `items` column.
        // The order-detail dialog, the order invoice, and the auto-courier dispatch
        // all read order.items — NOT the order_items association — so without this
        // snapshot they show an empty item list even though the order_items rows and
        // the computed total are correct. (This was the "manual order created but
        // items/info missing" bug: items=[] on the order row.) Both the manual and
        // the chatbot/automated paths flow through here, so one place fixes both.
        // Key aliases: `productName` (FE dialog), `product_name`/`name` (courier + invoice).
        const itemsSnapshot = validItems.map((vi) => {
            const productName = vi.productInstance?.name || null;
            return {
                product_id: vi.product_id,
                variant_id: vi.variant_id,
                variant_name: vi.variantInstance
                    ? `${vi.variantInstance.option_name}: ${vi.variantInstance.option_value}`
                    : null,
                productName,
                product_name: productName,
                name: productName,
                quantity: vi.quantity,
                price: vi.price,
                total: vi.total,
            };
        });

        // 5. Verify customer_id belongs to this shop if provided (Tech Debt #7)
        if (orderData.customer_id) {
            const customerRecord = await Customer.findOne({
                where: { id: orderData.customer_id, shop_id: shopId },
                transaction,
            });
            if (!customerRecord) {
                throw new AppError('Customer does not belong to this shop', 400);
            }
        }

        const storefrontCustomer = createStorefrontCustomer
            ? await findOrCreateStorefrontCustomer(shopId, orderData, transaction)
            : null;

        // 6. Create Order
        const order = await Order.create({
            shop_id: shopId,
            customer_id: storefrontCustomer?.id || orderData.customer_id,
            customer_name: orderData.customer_name,
            customer_phone: orderData.customer_phone || null,
            order_number: orderNumber,
            channel: orderData.channel || 'manual',
            order_status: orderData.order_status || 'draft',
            payment_status: orderData.payment_status || 'pending',
            fulfillment_status: requestedFulfillmentStatus == null
                ? 'unfulfilled'
                : String(requestedFulfillmentStatus).trim().toLowerCase(),
            items: itemsSnapshot,
            subtotal: totals.subtotal,
            discount: totals.discount,
            tax: totals.tax,
            delivery_fee: totals.deliveryFee,
            total: totals.total,
            delivery_address: orderData.delivery_address || null,
            delivery_zone: orderData.delivery_zone || null,
            payment_method: resolvedPaymentMethod,
            payment_method_id: paymentMethodId || null,
            note: orderData.note,
            idempotency_key: requestId || null,
            ...(orderData.metadata !== undefined ? { metadata: orderData.metadata } : {}),
        }, { transaction });

        // 6. Create Order Items and update stock atomically
        await createOrderItemsAndDeductStock(order.id, validItems, shopId, transaction);

        // 7. Final usage limit check before commit (defense in depth)
        await subscriptionService.checkOrderLimit(shopId);

        await transaction.commit();

        // 8. Track usage after successful commit
        await trackOrderUsage(order, shopId, requestId, logger);
        try {
            require('../analytics/funnel-events.service')
                .recordInternalFunnelEvent({
                    event: 'first_order_captured',
                    shopId,
                    onceKey: shopId,
                    oncePerEntity: true,
                    metadata: {
                        order_id: order.id,
                        channel: order.channel || null,
                        order_status: order.order_status,
                    },
                })
                .catch(() => {});
        } catch (_) { /* funnel logging must never affect committed orders */ }

        // Pilot intelligence: convert this customer's open Sales Opportunity now
        // rather than at the next sweep. Returns 0 for shops without the pilot
        // flag and never throws — a failure is counted and the sweep converts it.
        await require('../customer-intelligence/opportunity.service').convertForOrder(order);

        // 9. Enforce state consistency
        await enforceStateConsistency(order);

        // 10. Push notification to shop owner (fire-and-forget — never blocks order creation)
        if (process.env.NODE_ENV !== 'test') {
            setImmediate(() => {
                try {
                    const merchantNotificationService = require('../notification/merchant-notification.service');
                    const { NOTIFICATION_EVENTS } = require('../notification/notification-events');
                    merchantNotificationService.notifyShop(
                        shopId,
                        NOTIFICATION_EVENTS.NEW_ORDER,
                        {
                            orderId: order.id,
                            orderNumber: order.order_number,
                            total: order.total,
                            customerName: order.customer_name,
                            channel: order.channel
                        },
                        { dedupeKey: order.id }
                    ).catch(() => {});
                } catch (_) { /* notification failure must never affect order */ }
            });
        }

        return order;
    } catch (err) {
        try { await transaction.rollback(); } catch (_) { /* already committed */ }
        if (payloadHash && requestId && err.name === 'SequelizeUniqueConstraintError') {
            const racedOrder = await findExistingOrder();
            if (racedOrder) return returnIdempotentReplay(racedOrder, payloadHash);
        }
        throw err;
    }
};

/**
 * Create order — requires authenticated user (verifies shop access).
 */
const createOrder = async (userId, shopId, orderData, requestId = null) => {
    const logger = createLogger(requestId, shopId, userId);
    await verifyShopAccess(userId, shopId);
    return _createOrderCore(shopId, orderData, logger, requestId);
};

/**
 * Create order from internal/automated flows (chatbot, webhooks) — bypasses user auth.
 * All other guards (subscription limit, RTO Shield, stock, COD cap) still apply.
 */
const createOrderInternal = async (shopId, orderData, requestId = null, authorizationContext = null) => {
    if (authorizationContext?.authorization) {
        const { verifyAuthorization } = require('../ai/action-gate');
        const authorized = verifyAuthorization(authorizationContext.authorization, {
            actionType: 'CREATE_ORDER',
            shopId,
            idempotencyKey: requestId || orderData?.idempotency_key,
            evidenceSnapshotHash: authorizationContext.evidenceSnapshotHash,
        });
        if (!authorized) throw new AppError('Valid CREATE_ORDER authorization is required', 403, 'CREATE_ORDER_UNAUTHORIZED');
    } else if (process.env.NODE_ENV !== 'test') {
        throw new AppError('Internal order creation requires a verified CREATE_ORDER authorization', 403, 'CREATE_ORDER_UNAUTHORIZED');
    }

    const logger = createLogger(requestId, shopId, null);
    try {
        const order = await _createOrderCore(shopId, orderData, logger, requestId);
        try {
            await recordAgentActionOutcome(authorizationContext, {
                success: true,
                state: 'ORDER_CREATED',
                resourceId: order?.id || null,
            }, {
                success: false,
                state: 'NOT_ATTEMPTED',
                code: 'CUSTOMER_CONFIRMATION_PENDING',
            });
        } catch (outcomeError) {
            // IC-V1 review F3: the order is committed — stock is deducted and
            // the merchant notified. A lost result audit must not turn a
            // created order into a 503 that callers retry as a new mutation;
            // the replayed confirmed turn re-enters createOrderInternal and
            // re-records the outcome. Mirror the courier committed-but-
            // unaudited treatment (see bookForOrder's catch).
            if (!authorizationContext?.authorization) throw outcomeError;
            logger.warn('Order created but its Action Gate result audit failed', {
                code: outcomeError.code || 'ACTION_GATE_RESULT_AUDIT_FAILED',
                orderId: order?.id || null,
            });
            if (order) order.result_unaudited = true;
        }
        return order;
    } catch (error) {
        if (authorizationContext?.authorization
            && error.code !== 'CREATE_ORDER_RESULT_AUDIT_FAILED'
            && error.code !== 'ACTION_GATE_RESULT_AUDIT_FAILED') {
            try {
                await recordAgentActionOutcome(authorizationContext, {
                    success: false,
                    state: 'ORDER_CREATE_FAILED',
                    code: error.code || 'ORDER_CREATE_FAILED',
                }, {
                    success: false,
                    state: 'NOT_ATTEMPTED',
                    code: 'ORDER_CREATE_FAILED',
                });
            } catch (outcomeError) {
                // Never mask the original failure behind a failed outcome audit.
                logger.error('Failed to record CREATE_ORDER failure outcome', {
                    code: outcomeError.code || 'ACTION_GATE_RESULT_AUDIT_FAILED',
                    original_code: error.code || null,
                });
            }
        }
        throw error;
    }
};

const createStorefrontCodOrder = async (shopId, orderData, requestId, {
    payloadHash,
    validateSelection,
} = {}) => {
    if (!shopId || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestId)) {
        throw new AppError('A valid storefront idempotency key is required', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) {
        throw new AppError('A valid checkout payload hash is required', 400, 'CHECKOUT_HASH_REQUIRED');
    }
    if (typeof validateSelection !== 'function') {
        throw new AppError('Storefront product selection validation is required', 500, 'STOREFRONT_VALIDATION_UNAVAILABLE');
    }
    const logger = createLogger(requestId, shopId, null);
    return _createOrderCore(shopId, {
        ...orderData,
        customer_id: null,
        channel: 'storefront',
        order_status: 'confirmed',
        payment_status: 'unpaid',
        fulfillment_status: 'unfulfilled',
        payment_method: 'COD',
        discount: 0,
        tax: 0,
    }, logger, requestId, {
        payloadHash,
        validateSelection,
        createStorefrontCustomer: true,
        strictIdempotencyRead: true,
    });
};

/**
 * Update an order
 * Only allowed when order_status is 'pending' or 'draft'.
 * Records an audit log entry of what changed.
 */
const updateOrder = async (orderId, userId, shopId, updateData) => {
    await verifyShopAccess(userId, shopId);

    if (normalizeOrderStatus(updateData.order_status) === 'cancelled') {
        throw new AppError(
            'Use the order cancellation endpoint so lifecycle, courier state, inventory, and history are checked together.',
            409,
            'ORDER_CANCELLATION_PATH_REQUIRED',
        );
    }

    const updateResult = await sequelize.transaction(async (transaction) => {
        const query = { where: { id: orderId, shop_id: shopId }, transaction };
        if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
        const order = await Order.findOne(query);
        if (!order) throw new AppError('Order not found', 404);

        const paymentStateIsBeingChanged = updateData.payment_status !== undefined
            || updateData.payment_method !== undefined;
        const resultingPaymentStatus = String((updateData.payment_status ?? order.payment_status) || '').trim().toLowerCase();
        const resultingPaymentMethod = updateData.payment_method ?? order.payment_method;
        let configuredPaymentMethod = null;
        if (paymentStateIsBeingChanged && resultingPaymentStatus === 'paid' && order.payment_method_id) {
            if (typeof PaymentConfig?.findOne !== 'function') {
                throw new AppError('The existing payment method cannot be verified for this shop.', 409, 'PAYMENT_METHOD_CONFIGURATION_REQUIRED');
            }
            const paymentConfig = await PaymentConfig.findOne({
                where: { id: order.payment_method_id, shop_id: shopId },
                attributes: ['gateway'],
                transaction,
            });
            configuredPaymentMethod = String(paymentConfig?.gateway || '').trim();
            if (!configuredPaymentMethod) {
                throw new AppError('The existing payment method is no longer verifiable for this shop.', 409, 'PAYMENT_METHOD_CONFIGURATION_REQUIRED');
            }
        }
        if (paymentStateIsBeingChanged
            && resultingPaymentStatus === 'paid'
            && (isCodPaymentMethod(order.payment_method)
                || isCodPaymentMethod(resultingPaymentMethod)
                || isCodPaymentMethod(configuredPaymentMethod)
                || hasCodPaymentMethodHistory(order))) {
            throw new AppError(
                'COD settlement must use the owner-confirmed COD payment action after full delivery.',
                409,
                'COD_SETTLEMENT_PATH_REQUIRED',
            );
        }

        const currentOrderStatus = normalizeOrderStatus(order.order_status);
        const requestedOrderStatus = updateData.order_status === undefined
            ? undefined
            : normalizeOrderStatus(updateData.order_status);
        const isOrderStatusChange = requestedOrderStatus !== undefined
            && requestedOrderStatus !== currentOrderStatus;
        if (isOrderStatusChange
            && !(ORDER_STATUS_TRANSITIONS[currentOrderStatus] || []).includes(requestedOrderStatus)) {
            throw new AppError(
                `Cannot move order from '${order.order_status}' to '${updateData.order_status}'.`,
                409,
                'ORDER_STATUS_TRANSITION_INVALID',
            );
        }

        const requestedFulfillmentStatus = updateData.fulfillment_status === undefined
            ? undefined
            : String(updateData.fulfillment_status || '').trim().toLowerCase();
        if (requestedFulfillmentStatus === 'partially_fulfilled') {
            throw new AppError(
                'Partial fulfillment can only be recorded from authoritative item-level delivery evidence.',
                409,
                'PARTIAL_FULFILLMENT_EVIDENCE_REQUIRED',
            );
        }
        if (requestedFulfillmentStatus === 'cancelled') {
            throw new AppError(
                'Fulfillment cancellation must use the dedicated order cancellation path.',
                409,
                'FULFILLMENT_STATUS_SERVER_AUTHORITY',
            );
        }
        if (requestedFulfillmentStatus !== undefined
            && !['unfulfilled', 'fulfilled'].includes(requestedFulfillmentStatus)) {
            throw new AppError(
                'Fulfillment status is server-authoritative.',
                409,
                'FULFILLMENT_STATUS_SERVER_AUTHORITY',
            );
        }
        const currentFulfillmentStatus = String(order.fulfillment_status || '').trim().toLowerCase();
        if (requestedFulfillmentStatus === 'unfulfilled' && currentFulfillmentStatus !== 'unfulfilled') {
            throw new AppError(
                'Fulfillment status cannot regress to unfulfilled after delivery has started.',
                409,
                'FULFILLMENT_STATUS_TRANSITION_INVALID',
            );
        }

        const completesOrder = isOrderStatusChange && requestedOrderStatus === 'completed';
        const requiresFullDeliveryEvidence = completesOrder || requestedFulfillmentStatus === 'fulfilled';
        const hasFullDeliveryEvidence = requiresFullDeliveryEvidence
            ? await hasAuthoritativeFullDelivery(order, orderId, transaction)
            : false;
        if (completesOrder && !hasFullDeliveryEvidence) {
            throw new AppError(
                'An order can only be completed after authoritative full-delivery evidence.',
                409,
                'ORDER_COMPLETION_REQUIRES_DELIVERY',
            );
        }
        if (requestedFulfillmentStatus === 'fulfilled' && !hasFullDeliveryEvidence) {
            throw new AppError(
                'Fulfillment cannot be marked complete without authoritative full-delivery evidence.',
                409,
                'FULFILLMENT_REQUIRES_DELIVERY',
            );
        }

        const changedCourierFields = getChangedCourierFields(order, updateData);
        const guardedCourierFields = changedCourierFields.filter((field) => (
            !(field === 'fulfillment_status' && requestedFulfillmentStatus === 'fulfilled')
        ));
        if (requestedFulfillmentStatus === 'fulfilled' && !completesOrder) {
            await ensureNoUnresolvedCourierDispatch(orderId, shopId, transaction);
        }
        if (completesOrder) {
            await ensureNoUnresolvedCourierDispatch(orderId, shopId, transaction);
            const otherChangedCourierFields = guardedCourierFields.filter((field) => field !== 'order_status');
            if (otherChangedCourierFields.length) {
                await ensureCourierFieldsEditable(order, orderId, shopId, transaction, otherChangedCourierFields);
            }
        } else if (guardedCourierFields.length) {
            await ensureCourierFieldsEditable(order, orderId, shopId, transaction, guardedCourierFields);
        }

        const NON_EDITABLE_STATUSES = ['shipped', 'delivered', 'completed', 'fulfilled', 'returned', 'refunded', 'cancelled'];
        if (NON_EDITABLE_STATUSES.includes(String(order.order_status || '').trim().toLowerCase())) {
            throw new AppError(
                `Cannot edit order with status '${order.order_status}'. Only orders not yet shipped can be edited.`,
                409
            );
        }
        if (updateData.payment_method !== undefined
            && (typeof updateData.payment_method !== 'string' || !updateData.payment_method.trim())) {
            throw new AppError('A verified payment method is required', 400, 'PAYMENT_METHOD_REQUIRED');
        }
        const allowedUpdates = [
            'order_status', 'payment_status', 'fulfillment_status', 'note',
            'quantity', 'notes', 'delivery_address', 'customer_phone', 'customer_name', 'payment_method'
        ];
        const updates = {};
        const auditChanges = {};
        for (const key of allowedUpdates) {
            if (updateData[key] === undefined) continue;
            const oldValue = order[key];
            const newValue = updateData[key];
            if (oldValue !== newValue) auditChanges[key] = { from: oldValue, to: newValue };
            updates[key] = newValue;
        }

        if (Object.keys(updates).length === 0) return { order, auditChanges };

        // The order row lock serializes this metadata read-modify-write so
        // concurrent corrections cannot replace one another's audit entries.
        const existingMeta = order.metadata || {};
        const auditLog = Array.isArray(existingMeta.audit_log) ? existingMeta.audit_log : [];
        updates.metadata = {
            ...existingMeta,
            audit_log: [...auditLog, {
                changed_by: userId,
                changed_at: new Date().toISOString(),
                changes: auditChanges,
            }],
        };

        await order.update(updates, { transaction });
        return { order, auditChanges };
    });

    if (updateResult.auditChanges.order_status && updateResult.auditChanges.order_status.to === 'shipped') {
        const orderTrackingService = require('./order-tracking.service');
        const trackingNumber = updateData.tracking_number || null;
        orderTrackingService.sendTrackingNotification(updateResult.order, shopId, { trackingNumber }).catch(err => {
            console.warn('Tracking notification failed', {
                orderId,
                errorCode: safeErrorCode(err, 'TRACKING_NOTIFICATION_FAILED'),
            });
        });
    }

    return getOrderById(orderId, userId, shopId);
};

/**
 * Get single order by ID
 */
const getOrderById = async (orderId, userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId },
        include: [
            {
                model: Customer,
                as: 'customer',
                attributes: ['id', 'name', 'phone'],
                where: { shop_id: shopId },
                required: false,
            },
            {
                model: OrderItem,
                as: 'order_items',
                include: [{
                    model: Product,
                    as: 'product',
                    attributes: ['id', 'name', 'image_url', 'price'],
                    where: { shop_id: shopId },
                    required: false,
                }]
            }
        ]
    });

    if (!order) {
        throw new AppError('Order not found', 404);
    }

    return order;
};

/**
 * List orders with filters
 */
const listOrders = async (userId, shopId, filters = {}) => {
    await verifyShopAccess(userId, shopId);
    const dialect = sequelize.getDialect();
    const likeOp = dialect === 'postgres' ? Op.iLike : Op.like;

    const whereClause = {
        shop_id: shopId
    };

    // MW-V1: authoritative customer association filter (id, never name); always
    // intersected with the shop scope above.
    if (filters.customer_id) {
        whereClause.customer_id = filters.customer_id;
    }

    // Date Range Filter
    if (filters.start_date || filters.end_date) {
        whereClause.created_at = {};
        if (filters.start_date) {
            whereClause.created_at[Op.gte] = filters.start_date;
        }
        if (filters.end_date) {
            whereClause.created_at[Op.lte] = filters.end_date;
        }
    }

    // Status Filters
    if (filters.payment_status) {
        whereClause.payment_status = filters.payment_status;
    }
    if (filters.fulfillment_status) {
        whereClause.fulfillment_status = filters.fulfillment_status;
    }
    if (filters.order_status) {
        whereClause.order_status = filters.order_status;
    }
    // Worklist bucket. AND-ed rather than merged so it can never overwrite the
    // search filter's Op.or below, and so the shop scope always survives.
    if (filters.delivery_bucket) {
        whereClause[Op.and] = [
            ...(whereClause[Op.and] || []),
            buildBucketWhere(filters.delivery_bucket),
        ];
    }

    // Search Filter (Order Number OR Customer Name OR Customer Phone)
    const includeOptions = [
        {
            model: Customer,
            as: 'customer',
            attributes: ['id', 'name', 'phone'],
            where: { shop_id: shopId },
            required: false,
        },
        {
            model: OrderItem,
            as: 'order_items',
            attributes: ['id', 'quantity', 'total'] // Light include for list
        }
    ];

    if (filters.search) {
        const search = String(filters.search).trim();
        whereClause[Op.or] = [
            { order_number: { [likeOp]: `%${search}%` } },
            { '$customer.name$': { [likeOp]: `%${search}%` } },
            { '$customer.phone$': { [likeOp]: `%${search}%` } }
        ];
    }

    const page = Math.max(1, Number(filters.page || 1));
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 20)));
    const offset = (page - 1) * limit;

    const orders = await Order.findAll({
        where: whereClause,
        include: includeOptions,
        order: [['created_at', 'DESC']],
        limit,
        offset,
        distinct: true
    });

    return orders;
};

/**
 * Worklist chip counts: one tenant-scoped aggregate.
 *
 * The predicates come from order-worklist.buckets.js — the same module the
 * list filter uses — so a chip can never count rows the filtered list cannot
 * return. `total` is every order in the shop, matching the unfiltered list;
 * bucket values are the same status vocabulary, and anything outside it is
 * counted only in `total`.
 */
const getOrderWorklistCounts = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const attributes = [
        [literal('COUNT(*)'), 'total'],
        ...BUCKET_KEYS.map((key) => [
            literal(`SUM(CASE WHEN ${buildBucketSql(key)} THEN 1 ELSE 0 END)`),
            key,
        ]),
    ];

    const row = await Order.findOne({
        where: { shop_id: shopId },
        attributes,
        raw: true,
    });

    const counts = { total: Number(row?.total || 0) };
    for (const key of BUCKET_KEYS) counts[key] = Number(row?.[key] || 0);
    return counts;
};

/**
 * Delete order
 */
const deleteOrder = async (orderId, userId, shopId) => {
    await verifyShopAccess(userId, shopId);
    throw new AppError(
        'Hard deletion of orders is unsupported. Use the order cancellation endpoint to preserve inventory and delivery history.',
        410,
        'ORDER_HARD_DELETE_UNSUPPORTED',
    );
};

/**
 * Confirm a draft order (draft -> confirmed)
 */
const confirmOrder = async (orderId, userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId }
    });

    if (!order) {
        throw new AppError('Order not found', 404);
    }

    if (order.order_status !== 'draft') {
        throw new AppError(`Cannot confirm order with status: ${order.order_status}`, 400);
    }


    // Update status to confirmed
    await order.update({ order_status: 'confirmed' });

    // --- INVOICE CREATION LOGIC ---
    // Create invoice for this order (simple, not subscription-based)
    const { Invoice } = require('../entities');
    const { sendEmail } = require('../../utils/email.service');
    let invoice = null;
    try {
        // Generate invoice number: INV-YYYYMM-ORDERID
        const now = new Date();
        const yearMonth = now.toISOString().substring(0, 7).replace('-', '');
        const invoiceNumber = `INV-${yearMonth}-${order.order_number}`;
        invoice = await Invoice.create({
            shop_id: shopId,
            invoice_number: invoiceNumber,
            amount: order.total,
            status: 'pending',
            billing_period: yearMonth,
            invoice_type: 'Order',
            due_date: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            notes: `Order invoice for ${order.customer_name || 'Customer'}`,
            metadata: {
                orderId: order.id,
                orderNumber: order.order_number,
                customerName: order.customer_name,
                customerPhone: order.customer_phone,
                items: order.items,
                subtotal: order.subtotal,
                tax: order.tax,
                delivery_fee: order.delivery_fee,
                total: order.total
            }
        });
    } catch (err) {
        console.error('Invoice creation failed', {
            orderId: order.id,
            errorCode: safeErrorCode(err, 'INVOICE_CREATION_FAILED'),
        });
    }

    // --- EMAIL LOGIC ---
    try {
        const { orderConfirmationEmail } = require('../../utils/email-templates/order-confirmation');
        let customerEmail = null;
        let customerObj = null;
        if (order.customer_id) {
            customerObj = await Customer.findOne({ where: { id: order.customer_id, shop_id: order.shop_id } });
            if (customerObj?.email) customerEmail = customerObj.email;
        }
        if (!customerEmail && order.customer_email) customerEmail = order.customer_email;

        if (customerEmail) {
            const { subject, html, text } = orderConfirmationEmail(order, customerObj || { name: order.customer_name, phone: order.customer_phone });
            await sendEmail({ to: customerEmail, subject, html, text });
        }
    } catch (err) {
        console.error('Order confirmation email failed', {
            orderId: order.id,
            errorCode: safeErrorCode(err, 'ORDER_CONFIRMATION_EMAIL_FAILED'),
        });
    }
    // Return order (with invoice info if needed)

    // Dispatch through the same canonical path used by manual and AI flows.
    // Courier setup is operational state: it must never undo a confirmed order.
    try {
        await bookForOrder(order, {
            shopId,
            trigger: 'MANUAL',
            mutationAuthority: { kind: 'human', userId },
            requireAiDefault: true,
            throwOnError: false,
            stepData: {
                name: order.customer_name,
                phone: order.customer_phone,
                address: order.delivery_address,
                notes: order.note || order.notes || null,
            },
        });
    } catch (deliveryError) {
        // Log error but don't fail order confirmation
        console.error('Delivery dispatch failed', {
            orderId: order.id,
            errorCode: safeErrorCode(deliveryError, 'DELIVERY_DISPATCH_FAILED'),
        });
        // Order is still confirmed, just without delivery tracking
    }

    return await getOrderById(order.id, userId, shopId);
};

/**
 * Finalize a confirmed order (confirmed -> finalized)
 * This would be called after payment is processed
 */
const finalizeOrder = async (orderId, userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId }
    });

    if (!order) {
        throw new AppError('Order not found', 404);
    }

    if (order.order_status !== 'confirmed') {
        throw new AppError(`Cannot finalize order with status: ${order.order_status}`, 400);
    }

    // Update status to finalized
    await order.update({ order_status: 'finalized' });

    return await getOrderById(order.id, userId, shopId);
};

/**
 * V2: Get orders by customer
 */
const getOrdersByCustomer = async (userId, shopId, customerId, options = {}) => {
    await verifyShopAccess(userId, shopId);

    const whereClause = {
        shop_id: shopId,
        customer_id: customerId
    };

    if (options.status && options.status !== 'all') {
        whereClause.order_status = options.status;
    }

    const limit = Number(options.limit || 5);

    const orders = await Order.findAll({
        where: whereClause,
        order: [['created_at', 'DESC']],
        limit
    });

    return orders;
};

/**
 * V2: Cancel order
 */
const cancelOrderInTransaction = async (userId, shopId, orderId, reason, transaction, customerId) => {
    if (!transaction) {
        throw new AppError('Order cancellation requires an active transaction.', 500, 'ORDER_CANCELLATION_TRANSACTION_REQUIRED');
    }
    await verifyShopAccess(userId, shopId, transaction);

    const query = { where: { id: orderId, shop_id: shopId }, transaction };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const order = await Order.findOne(query);
    if (!order) throw new AppError('Order not found', 404);
    if (customerId && String(order.customer_id) !== String(customerId)) {
        throw new AppError('Customer verification failed', 403);
    }
    if (order.order_status === 'cancelled') throw new AppError('Order is already cancelled', 400);
    const orderStatus = String(order.order_status || '').trim().toLowerCase();
    const fulfillmentStatus = String(order.fulfillment_status || '').trim().toLowerCase();
    if (fulfillmentStatus === 'partially_fulfilled') {
        throw new AppError(
            'Cannot cancel a partially fulfilled order without item-level inventory quantities.',
            409,
            'PARTIAL_FULFILLMENT_INVENTORY_UNKNOWN',
        );
    }
    if (['shipped', 'delivered', 'completed', 'fulfilled', 'returned', 'refunded'].includes(orderStatus)
        || ['fulfilled', 'delivered', 'completed', 'returned', 'cancelled'].includes(fulfillmentStatus)) {
        throw new AppError(`Cannot cancel order with status '${order.order_status}'`, 409);
    }
    if (fulfillmentStatus !== 'unfulfilled') {
        throw new AppError(
            'Inventory can only be restored when the order is explicitly unfulfilled.',
            409,
            'CANCELLATION_REQUIRES_UNFULFILLED_ORDER',
        );
    }
    await ensureNoCourierActivityForCancellation(order, orderId, shopId, transaction);

    await order.update(
        { order_status: 'cancelled', note: reason ? `Cancelled: ${reason}` : order.note },
        { transaction }
    );
    await restoreOrderInventory(orderId, shopId, transaction);
    return order;
};

const cancelOrder = async (userId, shopId, orderId, reason, customerId) => {
    return sequelize.transaction((transaction) => cancelOrderInTransaction(
        userId, shopId, orderId, reason, transaction, customerId,
    ));
};

/**
 * V2: Create return request
 */
const createReturnRequest = async (userId, shopId, orderId, payload) => {
    await verifyShopAccess(userId, shopId);

    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId }
    });

    if (!order) {
        throw new AppError('Order not found', 404);
    }

    const request = await OrderReturn.create({
        order_id: orderId,
        customer_id: payload.customer_id,
        reason: payload.reason || null,
        items: payload.items || [],
        description: payload.description || null,
        status: 'pending_approval'
    });

    return request;
};

const tryRequire = (modulePath) => {
    try {
        return require(modulePath);
    } catch (_) {
        return null;
    }
};

const getCourierDispatchModel = () => {
    if (CourierDispatch && typeof CourierDispatch.findOrCreate === 'function') {
        return CourierDispatch;
    }

    const entities = tryRequire('../entities');
    if (entities?.CourierDispatch && typeof entities.CourierDispatch.findOrCreate === 'function') {
        return entities.CourierDispatch;
    }

    return null;
};

const ensureNoActiveCourierDispatch = async (orderId, shopId, transaction) => {
    const model = getCourierDispatchModel();
    if (!model || typeof model.findOne !== 'function') {
        throw new AppError('Courier dispatch state is unavailable', 503, 'COURIER_DISPATCH_CHECK_UNAVAILABLE');
    }
    const query = {
        where: {
            shop_id: shopId,
            order_id: orderId,
            status: { [Op.in]: ['PENDING', 'INDETERMINATE', 'COMMITTED'] },
        },
        transaction,
    };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const activeDispatch = await model.findOne(query);
    if (activeDispatch) {
        throw new AppError(
            'Courier dispatch is active or committed. Refresh the order and reconcile courier state before changing order details.',
            409,
            'COURIER_DISPATCH_ACTIVE',
        );
    }
};

const ensureNoUnresolvedCourierDispatch = async (orderId, shopId, transaction) => {
    const model = getCourierDispatchModel();
    if (!model || typeof model.findOne !== 'function') {
        throw new AppError('Courier dispatch state is unavailable', 503, 'COURIER_DISPATCH_CHECK_UNAVAILABLE');
    }
    const query = {
        where: {
            shop_id: shopId,
            order_id: orderId,
            status: { [Op.in]: ['PENDING', 'INDETERMINATE'] },
        },
        transaction,
    };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    if (await model.findOne(query)) {
        throw new AppError(
            'Order completion is blocked while courier dispatch remains unresolved.',
            409,
            'COURIER_DISPATCH_RECONCILIATION_REQUIRED',
        );
    }
};

const ensureNoCourierActivityForCancellation = async (order, orderId, shopId, transaction) => {
    await ensureNoActiveCourierDispatch(orderId, shopId, transaction);

    const deliveryStatus = String(order.delivery_status || '').trim().toLowerCase();
    if (order.delivery_tracking_code || order.delivery_consignment_id || order.delivery_dispatched_at || order.delivered_at
        || (deliveryStatus && !['unfulfilled', 'not_booked'].includes(deliveryStatus))) {
        throw new AppError(
            'Courier tracking has started. Reconcile courier state before cancelling this order.',
            409,
            'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        );
    }

    const { DeliveryTracking } = require('../entities');
    if (!DeliveryTracking || typeof DeliveryTracking.findOne !== 'function') {
        throw new AppError('Courier tracking state is unavailable', 503, 'COURIER_TRACKING_CHECK_UNAVAILABLE');
    }
    const query = { where: { order_id: orderId }, transaction };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    if (await DeliveryTracking.findOne(query)) {
        throw new AppError(
            'Courier tracking has started. Reconcile courier state before cancelling this order.',
            409,
            'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        );
    }
};

const hasAuthoritativeFullDelivery = async (order, orderId, transaction) => {
    const { DeliveryTracking } = require('../entities');
    if (!DeliveryTracking || typeof DeliveryTracking.findOne !== 'function') {
        throw new AppError('Courier tracking state is unavailable', 503, 'COURIER_TRACKING_CHECK_UNAVAILABLE');
    }
    const query = { where: { order_id: orderId }, transaction };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const tracking = await DeliveryTracking.findOne(query);
    const deliveryStatuses = [order.delivery_status, tracking?.current_status]
        .map((status) => String(status || '').trim().toLowerCase())
        .filter(Boolean);
    if (deliveryStatuses.length) return deliveryStatuses.every((status) => status === 'delivered');
    return Boolean(order.delivered_at);
};

const assertCourierOrderBookable = (order) => {
    const states = [order?.order_status, order?.fulfillment_status, order?.delivery_status]
        .map((state) => String(state || '').trim().toLowerCase());
    if (states.some((state) => NON_BOOKABLE_ORDER_STATES.has(state)) || order?.delivered_at) {
        throw new AppError(
            'Cannot book a courier for a completed, delivered, shipped, cancelled, or fulfilled order.',
            409,
            'ORDER_NOT_BOOKABLE',
        );
    }
};

const valuesEqual = (left, right) => {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
};

const getChangedCourierFields = (order, updateData) => Object.keys(updateData || {}).filter((field) => (
    COURIER_MUTATION_FIELDS.has(field)
    && updateData[field] !== undefined
    && !valuesEqual(order[field], updateData[field])
));

const ensureCourierFieldsEditable = async (order, orderId, shopId, transaction, changedFields) => {
    await ensureNoActiveCourierDispatch(orderId, shopId, transaction);

    const changedPaymentField = changedFields.find((field) => (
        field === 'payment_method' || field === 'payment_status'
    ));
    if (changedPaymentField) {
        await ensureNoCourierTracking(order, orderId, transaction, changedPaymentField);
        return;
    }

    const deliveryStatus = String(order.delivery_status || '').trim().toLowerCase();
    if (order.delivery_tracking_code || order.delivery_consignment_id || order.delivery_dispatched_at
        || (deliveryStatus && !['unfulfilled', 'not_booked'].includes(deliveryStatus))) {
        throw new AppError(
            'Courier tracking has started. Refresh the order and reconcile courier state before changing order details.',
            409,
            'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        );
    }

    const { DeliveryTracking } = require('../entities');
    if (!DeliveryTracking || typeof DeliveryTracking.findOne !== 'function') {
        throw new AppError('Courier tracking state is unavailable', 503, 'COURIER_TRACKING_CHECK_UNAVAILABLE');
    }
    const tracking = await DeliveryTracking.findOne({ where: { order_id: orderId }, transaction });
    if (tracking) {
        throw new AppError(
            'Courier tracking has started. Refresh the order and reconcile courier state before changing order details.',
            409,
            'ORDER_LOCKED_AFTER_COURIER_DISPATCH',
        );
    }
};

const ensureNoCourierTracking = async (order, orderId, transaction, paymentField = 'payment_method') => {
    const deliveryStatus = String(order.delivery_status || '').trim().toLowerCase();
    const label = paymentField === 'payment_status' ? 'Payment status' : 'Payment method';
    const code = paymentField === 'payment_status'
        ? 'PAYMENT_STATUS_LOCKED_AFTER_DISPATCH'
        : 'PAYMENT_METHOD_LOCKED_AFTER_DISPATCH';
    if (order.delivery_tracking_code || order.delivery_consignment_id) {
        throw new AppError(
            `${label} cannot be changed after courier booking`,
            409,
            code
        );
    }
    if (deliveryStatus && !['unfulfilled', 'not_booked'].includes(deliveryStatus)) {
        throw new AppError(
            `${label} cannot be changed after courier tracking starts`,
            409,
            code
        );
    }
    const { DeliveryTracking } = require('../entities');
    if (!DeliveryTracking || typeof DeliveryTracking.findOne !== 'function') {
        throw new AppError('Courier tracking state is unavailable', 503, 'COURIER_TRACKING_CHECK_UNAVAILABLE');
    }
    const query = { where: { order_id: orderId }, transaction };
    const tracking = await DeliveryTracking.findOne(query);
    if (tracking) {
        throw new AppError(
            `${label} cannot be changed after courier tracking exists`,
            409,
            code
        );
    }
};

const getCourierReadinessService = () => {
    const readiness = tryRequire('../delivery/courier-readiness.service');
    if (!readiness) return null;
    if (typeof readiness.evaluateReadiness === 'function') return readiness;
    if (typeof readiness.getReadiness === 'function') {
        return { ...readiness, evaluateReadiness: readiness.getReadiness };
    }
    return null;
};

const asSafeReason = (value, fallback) => {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return sanitizeErrorMessage(value.trim()).slice(0, 500);
};

const safeErrorCode = (error, fallback = 'ORDER_OPERATION_FAILED') => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : fallback;
};

const isDefinitiveProviderRejection = (error) => {
    const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
    return Number.isInteger(status)
        && status >= 400
        && status < 500
        && ![408, 409, 429].includes(status);
};

const blockedCourierResolution = (reason, missing = [], extra = {}) => ({
    blocked: true,
    reason: asSafeReason(reason, 'COURIER_SETUP_REQUIRED'),
    missing: Array.isArray(missing) ? missing.filter(item => typeof item === 'string').slice(0, 20) : [],
    ...extra,
});

/**
 * Resolve the courier that is allowed to receive an order.
 *
 * New installations use deliveryService.resolveAiDefaultProvider(), which is
 * the authoritative no-fallback resolver. The getActiveProvider branch is
 * retained only for older test/installation shapes that do not yet expose the
 * readiness service; it never runs once the new resolver is available.
 */
const resolveCourierProvider = async (shopId, { provider = null, requireAiDefault = false } = {}) => {
    const preferredProvider = provider && provider !== 'active' ? String(provider) : null;

    if (!preferredProvider && typeof deliveryService.resolveAiDefaultProvider === 'function') {
        try {
            const resolved = await deliveryService.resolveAiDefaultProvider(shopId);
            if (!resolved || resolved.blocked || !resolved.provider || resolved.provider === 'active') {
                return blockedCourierResolution(
                    resolved?.reason || resolved?.reasonCode || 'AI_DEFAULT_NOT_CONFIGURED',
                    resolved?.missing,
                    { provider: resolved?.provider || null, readiness: resolved?.readiness || null }
                );
            }

            const readiness = resolved.readiness;
            if (readiness && readiness.ready !== true && readiness.status !== 'ACTIVE') {
                return blockedCourierResolution(
                    readiness.error || readiness.reason || readiness.status,
                    readiness.missing,
                    { provider: resolved.provider, readiness }
                );
            }

            return {
                blocked: false,
                provider: String(resolved.provider),
                instance: resolved.instance || null,
                pickup: resolved.pickup || null,
                readiness: readiness || null,
                source: 'ai_default',
            };
        } catch (error) {
            return blockedCourierResolution(
                error?.code || 'COURIER_READINESS_UNAVAILABLE',
                [],
                { provider: null }
            );
        }
    }

    if (preferredProvider) {
        const readinessService = getCourierReadinessService();
        if (readinessService && typeof deliveryService.getProviderInstance === 'function') {
            try {
                const readiness = await readinessService.evaluateReadiness(shopId, preferredProvider);
                if (!readiness || (readiness.ready !== true && readiness.status !== 'ACTIVE')) {
                    return blockedCourierResolution(
                        readiness?.error || readiness?.reason || readiness?.status || 'COURIER_SETUP_REQUIRED',
                        readiness?.missing,
                        { provider: preferredProvider, readiness: readiness || null }
                    );
                }
            } catch (error) {
                return blockedCourierResolution(
                    error?.code || 'COURIER_READINESS_UNAVAILABLE',
                    [],
                    { provider: preferredProvider }
                );
            }
        }

        try {
            const instance = typeof deliveryService.getProviderInstance === 'function'
                ? await deliveryService.getProviderInstance(shopId, preferredProvider)
                : null;
            return {
                blocked: false,
                provider: preferredProvider,
                instance,
                pickup: null,
                source: 'explicit',
            };
        } catch (error) {
            return blockedCourierResolution(
                error?.code || 'COURIER_NOT_CONFIGURED',
                [],
                { provider: preferredProvider }
            );
        }
    }

    // Once the readiness module exists, an absent AI default must not silently
    // fall back to the most recently edited active integration.
    if (requireAiDefault && getCourierReadinessService()) {
        return blockedCourierResolution('AI_DEFAULT_NOT_CONFIGURED', ['ai_default_courier']);
    }

    if (typeof deliveryService.getActiveProvider !== 'function') {
        return blockedCourierResolution('AI_DEFAULT_NOT_CONFIGURED', ['ai_default_courier']);
    }

    try {
        const active = await deliveryService.getActiveProvider(shopId);
        if (!active?.provider || active.provider === 'active') {
            return blockedCourierResolution('AI_DEFAULT_NOT_CONFIGURED', ['ai_default_courier']);
        }
        return {
            blocked: false,
            provider: String(active.provider),
            instance: active.instance || null,
            pickup: active.pickup || null,
            source: 'legacy_active_provider',
        };
    } catch (error) {
        return blockedCourierResolution(error?.code || 'COURIER_PROVIDER_UNAVAILABLE');
    }
};

const getCourierDestinationService = () => tryRequire('../delivery/courier-destination.service');

/**
 * Kill switch for destination resolution, NOT a rollout gate.
 *
 * Resolution is the P0 fix for mis-addressed RedX parcels: the registry no
 * longer falls back to pickup metadata, so an order's destination ids can only
 * come from here. Defaulting it off in production would reintroduce "no
 * destination at all", so it stays on unless an operator explicitly sets
 * `COURIER_DESTINATION_RESOLUTION_ENABLED=false`.
 */
const destinationResolutionEnabled = () => process.env.COURIER_DESTINATION_RESOLUTION_ENABLED !== 'false';

/**
 * Blocking on a provider rejection is opt-in, and only `'true'` opts in.
 * Deliberately NOT isRuntimeFlagEnabled(): that helper treats "unset" as
 * enabled outside production, which would silently turn enforcement on in
 * every dev and test environment. Shadow mode is the default everywhere.
 *
 * This is the POLICY switch — "do we refuse to ship to an area the provider
 * does not list?". It is NOT a validity switch, and it must never be read as
 * one: a payload that cannot be addressed is malformed and is blocked by
 * missingBookableDestination() regardless of this flag.
 */
const serviceabilityEnforced = () => process.env.COURIER_SERVICEABILITY_ENFORCE === 'true';

/**
 * Destination keys each provider's adapter needs before a parcel can be
 * addressed. Derived from the registry normalizers (provider.registry.js):
 * RedX sends `delivery_area_id`, Pathao sends city/zone/area ids, Steadfast
 * books by text address and needs none.
 *
 * Absence of one of these is a MALFORMED payload, not an unverified one.
 * Sending it can only end in a provider rejection (or, for Pathao, a parcel
 * filed against an arbitrary default area), so the booking is stopped before
 * the network call — see the D5-1 decision of 2026-11-04.
 */
const REQUIRED_DESTINATION_FIELDS = Object.freeze({
    redx: Object.freeze(['delivery_area_id']),
    pathao: Object.freeze(['recipient_city', 'recipient_zone', 'recipient_area']),
});

const missingBookableDestination = (provider, orderData) => {
    const required = REQUIRED_DESTINATION_FIELDS[normalizeCourierProvider(provider)];
    if (!required) return [];
    return required.filter((key) => !String(orderData?.[key] ?? '').trim());
};

/**
 * Resolve the ORDER's destination against the provider directory.
 *
 * Runs after the PENDING dispatch claim (so a failed booking still goes through
 * the claim's FAILED/reopen recovery) and before the provider call. Nothing
 * here can throw: a lookup problem degrades to CHECK_UNAVAILABLE and the
 * booking continues exactly as it did before this feature existed.
 */
const resolveBookingDestination = async ({ shopId, provider, order, providerInstance }) => {
    const destinationService = getCourierDestinationService();
    if (!destinationService || !destinationResolutionEnabled()) return null;
    try {
        return await destinationService.resolveDestination({
            shopId,
            provider,
            order,
            providerInstance: providerInstance || null,
        });
    } catch (_) {
        return null;
    }
};

/**
 * Attach the ORDER's destination ids to the booking payload.
 *
 * The ids copied here come from `resolution.destination`, which is extracted
 * from the order itself — never from integration or pickup metadata. That is
 * the defect #238 removed and this function must not reintroduce it.
 *
 * A directory-confirmed match wins. A definitive NOT_SERVICEABLE means the
 * directory was readable and did not contain the order's address, so the
 * order's own ids are contradicted and are left off (the booking then fails
 * the payload-validity check, which is the honest outcome). An unverified
 * verdict (UNCERTAIN / CHECK_UNAVAILABLE) does not contradict anything, so the
 * order's own ids are kept: refusing them would turn a temporary directory
 * outage into an unrelated booking outage.
 */
const applyBookingDestination = (orderData, provider, resolution) => {
    if (!orderData || !resolution || resolution.decision === 'NOT_SERVICEABLE') return orderData;
    const destinationService = getCourierDestinationService();
    if (typeof destinationService?.applyDestinationToOrderData !== 'function') return orderData;
    return destinationService.applyDestinationToOrderData(orderData, provider, resolution);
};

const ELIGIBILITY_TTL_SECONDS = 300;

/**
 * Read-only destination eligibility for one order and courier.
 *
 * Returns the same decision vocabulary the booking path acts on, so the
 * merchant UI can warn before a booking is attempted. It never throws for a
 * provider problem: "we could not check" is its own honest answer
 * (CHECK_UNAVAILABLE), never a silent SERVICEABLE.
 */
const getCourierDestinationEligibility = async (order, { shopId, provider = null } = {}) => {
    const requestedProvider = provider ? String(provider) : null;
    // `enforced` is what lets a caller tell an advisory verdict from a blocking
    // one without re-implementing the server's policy. A NOT_SERVICEABLE answer
    // is a refusal only when this is true; with it false the server still
    // refuses malformed payloads, which is a different question.
    const unavailable = (reasonCode, resolvedProvider = requestedProvider) => ({
        provider: resolvedProvider,
        decision: 'CHECK_UNAVAILABLE',
        reason_code: reasonCode,
        source: 'order_destination',
        checked_at: new Date().toISOString(),
        ttl_seconds: ELIGIBILITY_TTL_SECONDS,
        enforced: serviceabilityEnforced(),
    });

    const destinationService = getCourierDestinationService();
    if (!destinationService || !destinationResolutionEnabled()) {
        return unavailable('DESTINATION_RESOLUTION_DISABLED');
    }

    const resolution = await resolveCourierProvider(shopId, { provider: requestedProvider });
    if (resolution.blocked) {
        return unavailable(resolution.reason || 'COURIER_SETUP_REQUIRED', resolution.provider || requestedProvider);
    }

    try {
        const verdict = await destinationService.resolveDestination({
            shopId,
            provider: resolution.provider,
            order,
            providerInstance: resolution.instance || null,
        });
        return { ...verdict, enforced: serviceabilityEnforced() };
    } catch (_) {
        return unavailable('LOOKUP_FAILED', resolution.provider);
    }
};

const normalizeCourierAddress = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
        const normalized = value.trim();
        if (normalized.startsWith('{')) {
            try { return normalizeCourierAddress(JSON.parse(normalized)); } catch (_) { /* plain text */ }
        }
        return normalized;
    }
    if (typeof value !== 'object') return String(value).trim();

    if (typeof value.full_address === 'string' && value.full_address.trim()) {
        return value.full_address.trim();
    }

    const orderedFields = [
        'street_address', 'address', 'road', 'house', 'area', 'upazila',
        'thana', 'district', 'city', 'postal_code'
    ];
    const parts = orderedFields
        .map(key => value[key])
        .filter(part => part !== null && part !== undefined && String(part).trim())
        .map(part => String(part).trim());
    return parts.join(', ');
};

const numericOr = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const orderItemsForCourier = (order) => {
    if (Array.isArray(order?.items)) return order.items;
    if (typeof order?.items === 'string') {
        try {
            const parsed = JSON.parse(order.items);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
};

/**
 * Build the one internal order shape consumed by every courier adapter.
 * Provider-specific aliases are kept only at this boundary for old callers;
 * the registry consumes the canonical fields.
 */
const buildCourierOrderData = (order, { stepData = {}, overrides = {}, pickup = null } = {}) => {
    const stepValues = stepData && typeof stepData === 'object' ? stepData : {};
    const overrideValues = overrides && typeof overrides === 'object' ? overrides : {};
    const orderNumber = order?.order_number || String(order?.id || 'ORDER').slice(0, 8).toUpperCase();
    const customerName = order?.customer_name || stepValues.name || overrideValues.customer_name || overrideValues.recipient_name || 'Customer';
    const rawPhone = order?.customer_phone || stepValues.phone || overrideValues.customer_phone || overrideValues.recipient_phone || '';
    const customerPhone = (() => {
        const formatter = tryRequire('../delivery/bd-phone-validator.service')?.formatForCourier;
        return typeof formatter === 'function' ? formatter(rawPhone) : rawPhone;
    })();
    const address = normalizeCourierAddress(
        order?.delivery_address || stepValues.address || overrideValues.delivery_address || overrideValues.recipient_address
    );
    const total = numericOr(order?.total, 0);
    const paymentMethod = String(order?.payment_method || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const paymentStatus = String(order?.payment_status || '').trim().toLowerCase();
    const isCod = COD_PAYMENT_METHODS.has(paymentMethod);
    if (isCod && paymentStatus === 'partially_paid') {
        throw new AppError(
            'COD balance is unavailable for this partially paid order. Verify the amount due before courier booking.',
            409,
            'COD_DUE_AMOUNT_UNKNOWN'
        );
    }
    if (!paymentMethod && paymentStatus !== 'paid') {
        throw new AppError(
            'Payment method is not recorded. Verify the payment method before courier booking.',
            409,
            'PAYMENT_METHOD_REQUIRED'
        );
    }
    if (isCod && paymentStatus !== 'paid' && paymentStatus !== 'pending' && paymentStatus !== 'unpaid') {
        throw new AppError(
            'COD collection is unavailable until the payment status is verified.',
            409,
            'PAYMENT_STATUS_REQUIRED'
        );
    }
    // Only an explicitly recorded COD method asks the courier to collect money.
    const collectionAmount = isCod && ['pending', 'unpaid'].includes(paymentStatus) ? total : 0;
    const items = orderItemsForCourier(order);
    const itemQuantity = items.reduce((sum, item) => {
        const quantity = Number(item?.quantity);
        return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1);
    }, 0) || 1;
    const itemDescription = items
        .map(item => item?.name || item?.product_name || item?.productName)
        .filter(Boolean)
        .join(', ') || overrideValues.item_description || `Order ${orderNumber}`;
    const itemWeight = numericOr(
        overrideValues.item_weight ?? overrideValues.weight_kg ?? stepValues.item_weight,
        0.5
    );
    const deliveryType = overrideValues.delivery_type ?? stepValues.delivery_type ?? 48;
    const orderData = {
        id: order?.id,
        order_number: orderNumber,
        customer_name: customerName,
        customer_phone: customerPhone,
        delivery_address: address,
        total,
        note: order?.note || order?.notes || stepValues.notes || overrideValues.note || '',
        item_quantity: itemQuantity,
        item_weight: itemWeight,
        item_description: itemDescription,
        delivery_type: deliveryType,
        item_type: overrideValues.item_type ?? stepValues.item_type ?? 2,

        // Legacy aliases are harmless to the registry and keep old direct
        // consumers from receiving undefined recipient fields.
        recipient_name: customerName,
        recipient_phone: customerPhone,
        recipient_address: address,
        cod_amount: collectionAmount,
        amount_to_collect: collectionAmount,
        weight: itemWeight,
    };

    const pickupData = pickup && typeof pickup === 'object' ? pickup : {};
    const storeId = pickupData.provider_store_id
        || pickupData.providerStoreId
        || pickupData.store_id
        || pickupData.storeId;
    if (storeId !== undefined && storeId !== null && String(storeId).trim()) {
        orderData.store_id = storeId;
        orderData.pickup_store_id = storeId;
    }

    return orderData;
};

const getCourierNotificationEvent = (eventName) => {
    const notificationEvents = tryRequire('../notification/notification-events');
    return notificationEvents?.NOTIFICATION_EVENTS?.[eventName] || eventName.toLowerCase();
};

const notifyCourierEvent = async (shopId, eventName, payload, dedupeKey) => {
    try {
        const notificationService = tryRequire('../notification/merchant-notification.service');
        if (typeof notificationService?.notifyShop !== 'function') return null;
        return await notificationService.notifyShop(
            shopId,
            getCourierNotificationEvent(eventName),
            payload,
            {
                dedupeKey,
                dedupeTtlSeconds: DISPATCH_NOTIFICATION_TTL_SECONDS,
            }
        );
    } catch (_) {
        return null;
    }
};

const markCourierSetupRequired = async (order, shopId, resolution = {}) => {
    const reason = asSafeReason(
        resolution.reason || resolution.reasonCode,
        'COURIER_SETUP_REQUIRED'
    );
    const missing = Array.isArray(resolution.missing)
        ? resolution.missing.filter(item => typeof item === 'string').slice(0, 20)
        : [];
    const payload = {
        orderId: order?.id || null,
        orderNumber: order?.order_number || null,
        provider: resolution.provider || null,
        reason,
        reasonCode: reason,
        missing,
        status: COURIER_SETUP_REQUIRED_STATUS,
    };

    const marker = await sequelize.transaction(async (transaction) => {
        const query = { where: { id: order?.id, shop_id: shopId }, transaction };
        if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
        const latestOrder = await Order.findOne(query);
        if (!latestOrder) throw new AppError('Order not found', 404);
        if (latestOrder.order_status === 'draft') {
            throw new AppError('Draft orders must be confirmed before courier booking', 409, 'DRAFT_ORDER_NOT_BOOKABLE');
        }
        if (latestOrder.delivery_consignment_id || latestOrder.delivery_tracking_code) {
            return { booked: true, marked: false, order: latestOrder };
        }
        await ensureNoActiveCourierDispatch(latestOrder.id, shopId, transaction);
        if (latestOrder.delivery_status === COURIER_SETUP_REQUIRED_STATUS) {
            return { booked: false, marked: false, order: latestOrder };
        }
        await latestOrder.update({ delivery_status: COURIER_SETUP_REQUIRED_STATUS }, { transaction });
        return { booked: false, marked: true, order: latestOrder };
    });

    if (marker.booked) {
        const committed = await findCommittedDispatch(marker.order, shopId);
        return synthesizeCommittedCourierResult(marker.order, committed);
    }
    if (marker.marked) {
        payload.orderNumber = marker.order.order_number || payload.orderNumber;
        await notifyCourierEvent(
            shopId,
            'COURIER_SETUP_REQUIRED',
            payload,
            `${marker.order.id || marker.order.order_number || 'order'}:courier_setup_required`
        );
    }

    return {
        blocked: true,
        status: COURIER_SETUP_REQUIRED_STATUS,
        ...payload,
    };
};

// Lazy: order-confidence reads order.service's own dependencies (entities).
const orderConfidenceService = () => require('../order-confidence/order-confidence.service');

const findCommittedDispatch = async (order, shopId) => {
    try {
        const model = getCourierDispatchModel();
        if (!model || typeof model.findOne !== 'function') return null;
        const record = await model.findOne({ where: { shop_id: shopId, order_id: order.id } });
        return String(record?.status || '').toUpperCase() === 'COMMITTED' ? record : null;
    } catch (_) {
        return null;
    }
};

/**
 * Pause courier booking for an order that Order Confidence did not clear.
 * Operational marker only — order_status and fulfillment_status are never
 * changed, and the merchant is told what to do next.
 */
const markConfidenceHold = async (order, shopId, gate = {}) => {
    // Actionable reasons only; INFO context (e.g. delivery history) is not why it is held.
    const reasonCodes = (gate.reasons || [])
        .filter(reason => reason && reason.severity !== 'INFO')
        .map(reason => reason.code)
        .filter(Boolean)
        .slice(0, 12);
    if (order?.id && typeof Order?.update === 'function') {
        try {
            await Order.update(
                { delivery_status: CONFIDENCE_HOLD_STATUS },
                {
                    where: {
                        id: order.id,
                        shop_id: shopId,
                        delivery_consignment_id: null,
                        delivery_tracking_code: null,
                    },
                },
            );
        } catch (_) {
            // Best-effort marker; the hold itself is enforced by the gate.
        }
    }
    await notifyCourierEvent(
        shopId,
        'ORDER_REVIEW_REQUIRED',
        {
            orderId: order?.id || null,
            orderNumber: order?.order_number || null,
            decision: gate.decision || null,
            reasonCodes,
            status: CONFIDENCE_HOLD_STATUS,
        },
        `${order?.id || order?.order_number || 'order'}:${CONFIDENCE_HOLD_STATUS}`
    );
    return {
        blocked: true,
        status: CONFIDENCE_HOLD_STATUS,
        decision: gate.decision || null,
        reasons: reasonCodes,
        decision_version: gate.decisionVersion ?? null,
        engine_failure: gate.engineFailure === true,
        mode: gate.mode || null,
    };
};

const transitionCourierDispatchRecord = async (record, values, options = {}) => courierDispatchClaims.transitionCourierDispatch(
    record,
    values,
    {
        model: options.model || getCourierDispatchModel(),
        ownerToken: options.ownerToken,
        expectedStatus: options.expectedStatus,
    },
);

const markCourierDispatchIndeterminate = async (order, shopId, provider, record, reason, ownerToken) => {
    const safeReason = asSafeReason(reason, 'courier_dispatch_indeterminate');
    let claimTransition;
    try {
        claimTransition = await transitionCourierDispatchRecord(
            record,
            { status: 'INDETERMINATE', error: safeReason },
            { ownerToken, expectedStatus: 'PENDING' },
        );
    } catch (_) {
        return false;
    }
    if (!claimTransition.updated) return false;

    try {
        if (typeof Order?.update === 'function' && order?.id) {
            await Order.update(
                { delivery_status: DISPATCH_INDETERMINATE_STATUS },
                {
                    where: {
                        id: order.id,
                        shop_id: shopId,
                        delivery_consignment_id: null,
                        delivery_tracking_code: null,
                    },
                },
            );
        } else if (typeof order?.update === 'function') {
            await order.update({ delivery_status: DISPATCH_INDETERMINATE_STATUS });
        }
    } catch (_) {
        // Operational status is best effort and must not mask the provider error.
    }

    await notifyCourierEvent(
        shopId,
        'COURIER_BOOKING_FAILED',
        {
            orderId: order?.id || null,
            orderNumber: order?.order_number || null,
            provider: provider || null,
            reason: safeReason,
            error: safeReason,
            status: DISPATCH_INDETERMINATE_STATUS,
        },
        `${order?.id || order?.order_number || 'order'}:dispatch_indeterminate`
    );
    return true;
};

const markCourierDispatchFailed = async (record, reason, ownerToken) => {
    try {
        return await transitionCourierDispatchRecord(
            record,
            {
                status: 'FAILED',
                error: asSafeReason(reason, 'courier_booking_failed'),
            },
            { ownerToken, expectedStatus: 'PENDING' },
        );
    } catch (_) {
        return { updated: false, record };
    }
};

const claimCourierDispatchRecord = async (order, shopId, provider, transaction = null) => {
    const model = getCourierDispatchModel();
    if (!model) return { state: 'unavailable', provider, record: null };

    const { deriveBookCourierIdempotencyKey } = require('../ai/contracts/action.contract');
    const idempotencyKey = deriveBookCourierIdempotencyKey({
        shopId,
        orderId: order.id,
        provider,
    });
    return courierDispatchClaims.claimCourierDispatch({
        model,
        shopId,
        orderId: order.id,
        provider,
        idempotencyKey,
        transaction,
    });
};

const resolveCommittedCourierProvider = (order, record) => {
    const claimProvider = record?.provider;
    const providerValue = claimProvider === undefined
        || claimProvider === null
        || (typeof claimProvider === 'string' && !claimProvider.trim())
        ? order?.delivery_provider
        : claimProvider;
    return normalizeCourierProvider(providerValue);
};

const committedTrackingUnavailable = (code, provider = null) => ({
    blocked: true,
    status: 'tracking_unavailable',
    code,
    reason: code,
    message: trackingUnavailableMessage(code),
    provider,
});

const synthesizeCommittedCourierResult = (order, record) => {
    const provider = resolveCommittedCourierProvider(order, record);
    if (!provider) {
        return committedTrackingUnavailable('COURIER_DISPATCH_PROVIDER_UNAVAILABLE');
    }

    const consignmentId = normalizeTrackingId(record?.consignment_id, order?.delivery_consignment_id);
    const trackingCode = normalizeTrackingId(
        record?.tracking_code,
        order?.delivery_tracking_code,
        consignmentId,
    );
    if (!trackingCode) {
        return committedTrackingUnavailable('COURIER_TRACKING_UNAVAILABLE', provider);
    }

    return {
        provider,
        consignment_id: consignmentId,
        tracking_code: trackingCode,
        status: order?.delivery_status || 'booked',
        invoice: order?.order_number || null,
    };
};

const persistDeliveryResult = async (order, deliveryResult) => {
    const trackingNumber = deliveryResult?.tracking_code || deliveryResult?.consignment_id;
    if (!trackingNumber) throw new Error('Courier returned no tracking reference');

    const normalizedResult = {
        ...deliveryResult,
        provider: deliveryResult.provider || order?.delivery_provider,
        consignment_id: deliveryResult.consignment_id || trackingNumber,
        tracking_code: trackingNumber,
        status: deliveryResult.status || 'booked',
    };
    if (!normalizedResult.provider) throw new Error('Courier returned no provider');

    const sessionService = tryRequire('./order-session-standalone.service');
    if (typeof sessionService?.persistDeliveryResult === 'function') {
        return sessionService.persistDeliveryResult(order, normalizedResult);
    }

    if (typeof order?.update === 'function') {
        await order.update({
            delivery_provider: normalizedResult.provider,
            delivery_consignment_id: normalizedResult.consignment_id,
            delivery_tracking_code: normalizedResult.tracking_code,
            delivery_status: normalizedResult.status,
            delivery_dispatched_at: order.delivery_dispatched_at || new Date(),
        });
    }
    return normalizedResult;
};

const normalizeBookForOrderArguments = (orderOrShopId, orderOrOptions, maybeOptions) => {
    if (typeof orderOrShopId === 'string') {
        return {
            shopId: orderOrShopId,
            order: orderOrOptions,
            options: typeof maybeOptions === 'string' ? { provider: maybeOptions } : (maybeOptions || {}),
        };
    }
    if (typeof orderOrOptions === 'string' && maybeOptions && typeof maybeOptions === 'object') {
        return { shopId: orderOrOptions, order: orderOrShopId, options: maybeOptions };
    }
    if (orderOrShopId?.order?.id) {
        const { order, ...envelopeOptions } = orderOrShopId;
        return {
            shopId: envelopeOptions.shopId || order.shop_id,
            order,
            options: { ...envelopeOptions, ...(orderOrOptions || {}) },
        };
    }
    return {
        shopId: orderOrOptions?.shopId || maybeOptions?.shopId || orderOrShopId?.shop_id,
        order: orderOrShopId,
        options: typeof orderOrOptions === 'string' ? { provider: orderOrOptions } : (orderOrOptions || {}),
    };
};

const assertCourierMutationAuthority = async (options, shopId, orderId, provider) => {
    const actionAuthorization = options.authorization || options.actionAuthorization;
    if (options.requireAuthorization || actionAuthorization) {
        if (!actionAuthorization) {
            throw new AppError('Valid BOOK_COURIER authorization is required', 403, 'BOOK_COURIER_UNAUTHORIZED');
        }
        const { verifyAuthorization } = require('../ai/action-gate');
        const { deriveBookCourierIdempotencyKey } = require('../ai/contracts/action.contract');
        const idempotencyKey = options.idempotencyKey || deriveBookCourierIdempotencyKey({
            shopId,
            orderId,
            provider: provider || options.provider || 'active',
        });
        if (!verifyAuthorization(actionAuthorization, {
            actionType: 'BOOK_COURIER',
            shopId,
            idempotencyKey,
            evidenceSnapshotHash: options.evidenceSnapshotHash,
        })) {
            throw new AppError('Valid BOOK_COURIER authorization is required', 403, 'BOOK_COURIER_UNAUTHORIZED');
        }
        return 'domain_agent';
    }

    const authority = options.mutationAuthority;
    if (authority?.kind === 'human') {
        if (!authority.userId) throw new AppError('A user identity is required for manual courier booking', 403, 'COURIER_AUTHORITY_REQUIRED');
        const membership = await verifyShopAccess(authority.userId, shopId);
        if (!['owner', 'admin', 'staff'].includes(membership.role)) {
            throw new AppError('This shop role cannot book couriers', 403, 'COURIER_ROLE_NOT_ALLOWED');
        }
        return 'human';
    }

    if (authority?.kind === 'system') {
        const systemEventIsVerified = authority.source === 'payment_webhook'
            && authority.signatureVerified === true
            && typeof authority.eventId === 'string'
            && authority.eventId.length > 0;
        if (!systemEventIsVerified) {
            throw new AppError('A verified payment webhook is required for system courier booking', 403, 'COURIER_SYSTEM_AUTHORITY_REQUIRED');
        }
        return 'system';
    }

    if (authority?.kind === 'test' && process.env.NODE_ENV === 'test') return 'test';
    throw new AppError('Courier booking requires a verified authorization context', 403, 'COURIER_AUTHORITY_REQUIRED');
};

const recordCourierMutationAuthority = async (authority, shopId, orderId, provider) => {
    if (authority?.kind !== 'human' && authority?.kind !== 'system') return;
    if (!AuditLog || typeof AuditLog.create !== 'function') {
        throw new AppError('Courier booking authority audit is unavailable', 503, 'COURIER_AUTHORITY_AUDIT_UNAVAILABLE');
    }
    await AuditLog.create({
        user_id: authority.kind === 'human' ? authority.userId : null,
        shop_id: shopId,
        action: 'COURIER_BOOKING_AUTHORIZED',
        resource_type: 'order',
        resource_id: orderId,
        idempotency_key: null,
        metadata: {
            authority_type: authority.kind,
            source: authority.kind === 'system' ? authority.source : 'merchant_ui',
            event_id: authority.kind === 'system' ? authority.eventId : null,
            provider: provider || null,
        },
    });
};

const recordAgentActionOutcome = async (options, mutationResult, outboundResult) => {
    if (!options) return;
    const authorization = options.authorization || options.actionAuthorization;
    if (!authorization) return;
    const { recordActionGateOutcome } = require('../ai/action-gate');
    const result = await recordActionGateOutcome({ authorization, mutationResult, outboundResult });
    if (!result?.recorded) {
        throw new AppError('Action Gate result audit could not be persisted', 503, 'ACTION_GATE_RESULT_AUDIT_FAILED');
    }
};

// Keep order_status separate from a merchant decision fingerprint, but bind
// it into the reviewed booking snapshot so any intervening state change aborts.
const courierBookingFingerprint = (order, confidenceRules) => JSON.stringify([
    confidenceRules.fingerprint(order),
    String(order?.order_status || '').trim().toLowerCase(),
]);

/**
 * Canonical courier booking entry point for all order paths.
 *
 * The helper deliberately keeps merchant/settlement order state separate from
 * delivery state: a missing courier setup or an ambiguous provider response
 * never changes order_status or fulfillment_status.
 */
const bookForOrder = async (orderOrShopId, orderOrOptions, maybeOptions) => {
    const { shopId, order, options: rawOptions } = normalizeBookForOrderArguments(
        orderOrShopId,
        orderOrOptions,
        maybeOptions
    );
    const options = rawOptions || {};

    if (!order?.id || !shopId) {
        throw new AppError('Order and shop are required for courier booking', 400, 'VALIDATION_ERROR');
    }
    if (order.shop_id && String(order.shop_id) !== String(shopId)) {
        throw new AppError('Order does not belong to the selected shop', 403, 'TENANT_MISMATCH');
    }

    const committedBeforeWork = await findCommittedDispatch(order, shopId);
    if (order.delivery_consignment_id || order.delivery_tracking_code) {
        return synthesizeCommittedCourierResult(order, committedBeforeWork);
    }

    if (committedBeforeWork) {
        require('../pilot-features/pilot-metrics').increment('order_confidence.committed_reconcile_allowed', shopId);
        return synthesizeCommittedCourierResult(order, committedBeforeWork);
    }

    assertCourierOrderBookable(order);

    // V6 contract port (IC-V1), reconciled for review findings F1/F2:
    // a DRAFT is under merchant review — no booking path may mutate or notify it
    // (COURIER_SETUP_REQUIRED marking included). The guard throws BEFORE any
    // side-effecting branch; the only exception is a draft whose dispatch row is
    // already COMMITTED (parcel really booked before this rule existed), which
    // must remain reconcilable. Confidence-HELD drafts still answer with the
    // richer ORDER_CONFIDENCE_HOLD contract (checked earlier in this flow).
    const draftBookingGuard = async (candidateOrder = order) => {
        if (String(candidateOrder.order_status || '').trim().toLowerCase() !== 'draft') return null;
        const committed = await findCommittedDispatch(candidateOrder, shopId);
        if (committed) {
            require('../pilot-features/pilot-metrics').increment('order_confidence.committed_reconcile_allowed', shopId);
            return synthesizeCommittedCourierResult(candidateOrder, committed);
        }
        throw new AppError('Draft orders must be confirmed before courier booking', 409, 'DRAFT_ORDER_NOT_BOOKABLE');
    };

    let nonAgentAuthorityAudited = false;
    const verifyMutationAuthority = async (providerName) => {
        const authorityType = await assertCourierMutationAuthority(options, shopId, order.id, providerName);
        if (!nonAgentAuthorityAudited && (authorityType === 'human' || authorityType === 'system')) {
            await recordCourierMutationAuthority(options.mutationAuthority, shopId, order.id, providerName);
            nonAgentAuthorityAudited = true;
        }
    };

    await verifyMutationAuthority(options.provider || order.delivery_provider || 'active');

    if (options.mutationAuthority?.kind === 'system' && !isRuntimeFlagEnabled('AI_COURIER_BOOKING_ENABLED')) {
        await verifyMutationAuthority(options.provider || order.delivery_provider || 'active');
        const committed = await findCommittedDispatch(order, shopId);
        if (committed) return synthesizeCommittedCourierResult(order, committed);
        const draftReconcile = await draftBookingGuard();
        if (draftReconcile) return draftReconcile;
        return { blocked: true, status: 'automation_disabled', reason: 'AI_COURIER_BOOKING_DISABLED' };
    }

    const provider = options.provider && options.provider !== 'active' ? String(options.provider) : null;
    const resolution = options.resolvedProvider || await resolveCourierProvider(shopId, {
        provider,
        requireAiDefault: options.requireAiDefault !== false && !provider,
    });
    if (!resolution || resolution.blocked || !resolution.provider || resolution.provider === 'active') {
        const draftReconcile = await draftBookingGuard();
        if (draftReconcile) return draftReconcile;
        await verifyMutationAuthority(resolution?.provider || provider);
        const setupResult = await markCourierSetupRequired(order, shopId, resolution || blockedCourierResolution('AI_DEFAULT_NOT_CONFIGURED'));
        await recordAgentActionOutcome(options, {
            success: false,
            state: 'COURIER_SETUP_REQUIRED',
            code: resolution?.reason || 'AI_DEFAULT_NOT_CONFIGURED',
            resourceId: order.id,
        }, { success: false, state: 'NOT_ATTEMPTED' });
        return setupResult;
    }

    // RTO Shield v2 / Order Confidence (ADR-0007). Runs before the durable
    // claim so a held order never creates a PENDING dispatch row and never
    // reaches the provider. It does not replace the claim: idempotency and
    // provider-timeout handling below are unchanged. An order that already
    // has a COMMITTED claim is always allowed through so reconciliation of a
    // parcel that was really booked cannot be blocked by a later decision.
    const orderConfidenceRules = require('../order-confidence/order-confidence.rules');
    const gateOrder = await sequelize.transaction(async (transaction) => {
        const query = { where: { id: order.id, shop_id: shopId }, transaction };
        if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
        const latestOrder = await Order.findOne(query);
        if (!latestOrder) throw new AppError('Order not found', 404);
        assertCourierOrderBookable(latestOrder);
        return latestOrder;
    });
    // Order Confidence intentionally omits order_status so confirmation does
    // not invalidate an approval. Courier booking binds that status separately.
    const evaluatedFingerprint = courierBookingFingerprint(gateOrder, orderConfidenceRules);
    const evaluatedTotal = Number(gateOrder.total);
    const confidenceGate = await orderConfidenceService().checkBookingGate(gateOrder, shopId, {
        trigger: options.trigger || 'AUTO',
    });
    if (confidenceGate.snapshotStale) {
        throw new AppError(
            'Order details changed during courier review. Refresh the order before booking.',
            409,
            'ORDER_CHANGED_BEFORE_COURIER_CLAIM'
        );
    }
    if (!confidenceGate.allowed) {
        const committedDispatch = await findCommittedDispatch(gateOrder, shopId);
        if (!committedDispatch) {
            await verifyMutationAuthority(resolution.provider);
            const held = await markConfidenceHold(gateOrder, shopId, confidenceGate);
            await recordAgentActionOutcome(options, {
                success: false,
                state: 'CONFIDENCE_HOLD',
                code: confidenceGate.decision || 'ORDER_CONFIDENCE_HOLD',
                resourceId: order.id,
            }, { success: false, state: 'NOT_ATTEMPTED' });
            return held;
        }
        require('../pilot-features/pilot-metrics').increment('order_confidence.committed_reconcile_allowed', shopId);
    }

    // V6 contract port (IC-V1): runs AFTER the already-booked return and AFTER the
    // Order-Confidence gate (held drafts keep the ORDER_CONFIDENCE_HOLD contract);
    // throws unless the draft has a COMMITTED dispatch to reconcile (then returns it).
    const draftReconcile = await draftBookingGuard(gateOrder);
    if (draftReconcile) return draftReconcile;
    await verifyMutationAuthority(resolution.provider);

    let dispatchRecord = null;
    let dispatchOwnerToken = null;
    let providerCallStarted = false;
    let providerCallCompleted = false;
    let dispatchCommitted = false;
    let bookingOrder = gateOrder;
    let orderData = null;
    try {
        const claim = await sequelize.transaction(async (transaction) => {
            const query = { where: { id: order.id, shop_id: shopId }, transaction };
            if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
            const latestOrder = await Order.findOne(query);
            if (!latestOrder) throw new AppError('Order not found', 404);
            assertCourierOrderBookable(latestOrder);
            if (latestOrder.delivery_consignment_id || latestOrder.delivery_tracking_code) {
                const committed = await findCommittedDispatch(latestOrder, shopId);
                return {
                    state: 'already_booked',
                    order: latestOrder,
                    result: synthesizeCommittedCourierResult(latestOrder, committed),
                };
            }
            const latestTotal = Number(latestOrder.total);
            if (courierBookingFingerprint(latestOrder, orderConfidenceRules) !== evaluatedFingerprint
                || !Number.isFinite(evaluatedTotal)
                || latestTotal !== evaluatedTotal) {
                throw new AppError(
                    'Order details changed during courier review. Refresh the order before booking.',
                    409,
                    'ORDER_CHANGED_BEFORE_COURIER_CLAIM'
                );
            }
            const draftResult = await draftBookingGuard(latestOrder);
            if (draftResult) return { state: 'draft_reconcile', order: latestOrder, result: draftResult };
            const latestOrderData = buildCourierOrderData(latestOrder, {
                stepData: options.stepData,
                overrides: options.overrides,
                pickup: resolution.pickup,
            });
            const missingOrderData = [
                ['customer_name', latestOrderData.customer_name],
                ['customer_phone', latestOrderData.customer_phone],
                ['delivery_address', latestOrderData.delivery_address],
            ].filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
            if (missingOrderData.length) {
                return { state: 'setup_required', order: latestOrder, missingOrderData };
            }
            return {
                ...(await claimCourierDispatchRecord(latestOrder, shopId, resolution.provider, transaction)),
                order: latestOrder,
                orderData: latestOrderData,
            };
        });
        bookingOrder = claim.order || order;
        if (claim.state === 'setup_required') {
            const setupResult = await markCourierSetupRequired(bookingOrder, shopId, {
                provider: resolution.provider,
                reason: 'COURIER_ORDER_DATA_INCOMPLETE',
                missing: claim.missingOrderData,
            });
            await recordAgentActionOutcome(options, {
                success: false,
                state: 'COURIER_SETUP_REQUIRED',
                code: 'COURIER_ORDER_DATA_INCOMPLETE',
                resourceId: bookingOrder.id,
            }, { success: false, state: 'NOT_ATTEMPTED' });
            return setupResult;
        }
        if (claim.state === 'already_booked' || claim.state === 'draft_reconcile') {
            const trackingUnavailable = Boolean(claim.result?.blocked);
            await recordAgentActionOutcome(options, {
                success: !trackingUnavailable,
                state: trackingUnavailable ? 'TRACKING_UNAVAILABLE' : 'RECONCILED',
                ...(trackingUnavailable ? { code: claim.result.code } : {}),
                resourceId: bookingOrder.id,
            }, { success: false, state: 'NOT_ATTEMPTED' });
            return claim.result;
        }
        dispatchRecord = claim.record;
        dispatchOwnerToken = claim.ownerToken || null;
        orderData = claim.orderData;
        if (claim.state === 'unavailable') {
            const claimError = new Error('Courier dispatch claim service is unavailable');
            claimError.code = 'COURIER_DISPATCH_CLAIM_UNAVAILABLE';
            throw claimError;
        }
        if (claim.state === 'committed') {
            // The claim is now scoped to (shop_id, order_id) only, so this
            // branch can be reached by a request for a DIFFERENT provider than
            // the one that actually committed. Report the record's own
            // provider — the courier that really booked the parcel — not the
            // just-attempted resolution.provider, or persistDeliveryResult
            // below would overwrite order.delivery_provider with a courier
            // that never touched this order.
            const committedResult = synthesizeCommittedCourierResult(bookingOrder, dispatchRecord);
            if (committedResult.blocked) {
                await recordAgentActionOutcome(options, {
                    success: false,
                    state: 'TRACKING_UNAVAILABLE',
                    code: committedResult.code,
                    resourceId: bookingOrder.id,
                }, { success: false, state: 'NOT_ATTEMPTED' });
                return committedResult;
            }
            await persistDeliveryResult(bookingOrder, committedResult);
            await recordAgentActionOutcome(options, {
                success: true,
                state: 'COURIER_BOOKED',
                resourceId: bookingOrder.id,
            }, { success: false, state: 'NOT_ATTEMPTED' });
            return committedResult;
        }
        if (claim.state === 'existing') {
            const existingClaim = {
                blocked: true,
                status: DISPATCH_INDETERMINATE_STATUS,
                provider: normalizeCourierProvider(dispatchRecord?.provider),
                reason: 'existing_courier_dispatch_claim',
            };
            await recordAgentActionOutcome(options, {
                success: false,
                state: 'DISPATCH_INDETERMINATE',
                code: 'existing_courier_dispatch_claim',
                resourceId: bookingOrder.id,
            }, { success: false, state: 'UNKNOWN' });
            return existingClaim;
        }

        if (!dispatchOwnerToken) {
            const claimError = new Error('Courier dispatch claim owner is missing');
            claimError.code = 'COURIER_DISPATCH_OWNER_MISSING';
            throw claimError;
        }

        const destination = await resolveBookingDestination({
            shopId,
            provider: resolution.provider,
            order: bookingOrder,
            providerInstance: resolution.instance || null,
        });
        applyBookingDestination(orderData, resolution.provider, destination);
        if (destination?.decision === 'NOT_SERVICEABLE' && serviceabilityEnforced()) {
            try {
                require('../pilot-features/pilot-metrics')
                    .increment('courier.serviceability.not_serviceable_blocked');
            } catch (_) { /* metrics are best effort */ }

            await markCourierDispatchFailed(
                dispatchRecord,
                'Destination is not serviceable by the selected courier',
                dispatchOwnerToken,
            );
            throw new AppError(
                'The selected courier cannot deliver to this order\'s destination. Choose another courier.',
                409,
                'COURIER_DESTINATION_NOT_SERVICEABLE',
            );
        }
        if (destination?.decision === 'NOT_SERVICEABLE') {
            // Shadow mode records the policy verdict and lets the booking go on
            // — but only if the payload itself is still addressable, which the
            // validity check below decides.
            try {
                require('../pilot-features/pilot-metrics')
                    .increment('courier.serviceability.not_serviceable_shadow');
            } catch (_) { /* metrics are best effort */ }
        }

        const missingDestination = missingBookableDestination(resolution.provider, orderData);
        if (missingDestination.length) {
            // Payload validity is never shadowed. Without these ids the parcel
            // cannot be addressed, so the provider call could not succeed;
            // failing here keeps the merchant's error honest and the PENDING
            // claim recoverable, and it does not reintroduce the pickup-area
            // fallback that #238 removed.
            try {
                require('../pilot-features/pilot-metrics')
                    .increment('courier.serviceability.destination_payload_invalid');
            } catch (_) { /* metrics are best effort */ }

            await markCourierDispatchFailed(
                dispatchRecord,
                'Courier payload has no deliverable destination',
                dispatchOwnerToken,
            );
            throw new AppError(
                'This order has no delivery area that the selected courier can use. Record the delivery area on the order, or choose another courier.',
                409,
                'COURIER_DESTINATION_PAYLOAD_INVALID',
            );
        }

        if (typeof deliveryService.createDeliveryOrder !== 'function') {
            throw new Error('Courier booking service is unavailable');
        }

        providerCallStarted = true;
        const rawResult = await deliveryService.createDeliveryOrder(
            shopId,
            orderData,
            resolution.provider
        );
        providerCallCompleted = true;
        const result = {
            ...rawResult,
            provider: rawResult?.provider || resolution.provider,
        };
        await persistDeliveryResult(bookingOrder, result);

        const committed = await transitionCourierDispatchRecord(
            dispatchRecord,
            {
                status: 'COMMITTED',
                consignment_id: result.consignment_id || result.tracking_code || null,
                tracking_code: result.tracking_code || result.consignment_id || null,
                error: null,
            },
            { ownerToken: dispatchOwnerToken, expectedStatus: 'PENDING' },
        );
        if (!committed.updated) {
            const latest = await getCourierDispatchModel()?.findOne?.({
                where: { shop_id: shopId, order_id: order.id, provider: resolution.provider },
            });
            if (String(latest?.status || '').toUpperCase() === 'COMMITTED'
                && (latest.consignment_id || latest.tracking_code) === (result.consignment_id || result.tracking_code)) {
                return result;
            }
            const claimError = new Error('Courier dispatch claim was lost after provider booking');
            claimError.code = 'COURIER_CLAIM_LOST_AFTER_PROVIDER';
            throw claimError;
        }
        dispatchCommitted = true;
        await recordAgentActionOutcome(options, {
            success: true,
            state: 'COURIER_BOOKED',
            resourceId: bookingOrder.id,
        }, { success: false, state: 'NOT_ATTEMPTED' });
        return result;
    } catch (error) {
        if (error.code === 'ACTION_GATE_RESULT_AUDIT_FAILED' && dispatchCommitted) {
            return {
                blocked: true,
                status: 'action_audit_unavailable',
                provider: resolution.provider,
                tracking_code: bookingOrder.delivery_tracking_code || dispatchRecord?.tracking_code || null,
                reason: 'Courier booking completed, but its Action Gate result could not be audited',
            };
        }
        const definitiveProviderRejection = providerCallStarted
            && !providerCallCompleted
            && isDefinitiveProviderRejection(error);
        if (definitiveProviderRejection) {
            await markCourierDispatchFailed(dispatchRecord, error.message, dispatchOwnerToken);
        } else if (providerCallStarted) {
            await markCourierDispatchIndeterminate(
                bookingOrder,
                shopId,
                resolution.provider,
                dispatchRecord,
                error.message,
                dispatchOwnerToken,
            );
        }
        if (error.code !== 'ACTION_GATE_RESULT_AUDIT_FAILED') {
            try {
                await recordAgentActionOutcome(options, {
                    success: false,
                    state: providerCallStarted && !definitiveProviderRejection ? 'DISPATCH_INDETERMINATE' : 'DISPATCH_FAILED',
                    code: error.code || 'COURIER_BOOKING_FAILED',
                    resourceId: bookingOrder.id,
                }, {
                    success: false,
                    state: providerCallStarted && !definitiveProviderRejection ? 'UNKNOWN' : 'NOT_SENT',
                    code: error.code || 'COURIER_BOOKING_FAILED',
                });
            } catch (outcomeError) {
                if (error.code !== 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE') throw outcomeError;
            }
        }
        if (!providerCallStarted
            && [
                'ORDER_CHANGED_BEFORE_COURIER_CLAIM',
                'ORDER_NOT_BOOKABLE',
                'COD_DUE_AMOUNT_UNKNOWN',
                'PAYMENT_METHOD_REQUIRED',
                'PAYMENT_STATUS_REQUIRED',
                'COURIER_DISPATCH_PROVIDER_UNAVAILABLE',
                'COURIER_DESTINATION_NOT_SERVICEABLE',
                'COURIER_DESTINATION_PAYLOAD_INVALID',
            ].includes(error.code)) {
            throw error;
        }
        if (options.throwOnError === false) {
            return {
                failed: true,
                status: providerCallStarted && !definitiveProviderRejection
                    ? DISPATCH_INDETERMINATE_STATUS
                    : 'dispatch_failed',
                provider: resolution.provider,
                reason: asSafeReason(error.message, 'COURIER_BOOKING_FAILED'),
            };
        }
        throw error;
    }
};

module.exports = {
    createOrder,
    createOrderInternal,
    createStorefrontCodOrder,
    updateOrder,
    getOrderById,
    listOrders,
    getOrderWorklistCounts,
    deleteOrder,
    confirmOrder,
    finalizeOrder,
    getOrdersByCustomer,
    cancelOrder,
    cancelOrderInTransaction,
    createReturnRequest,
    bookForOrder,
    claimCourierDispatchRecord,
    transitionCourierDispatchRecord,
    markCourierDispatchIndeterminate,
    resolveCourierProvider,
    getCourierDestinationEligibility,
    markCourierSetupRequired,
    buildCourierOrderData
};
