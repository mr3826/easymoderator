const {
    Order,
    OrderItem,
    Product,
    UserShop,
    Invoice,
    PartnerBillingAdjustment,
} = require('../entities');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { Op } = require('sequelize');
const { invalidate: invalidateStock } = require('../product/stock-status-guard.service');
const deliveredOrderBilling = require('../commercial/delivered-order-billing.service');

/**
 * Verify user has access to the shop
 */
const verifyShopAccess = async (userId, shopId) => {
    const userShop = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true }
    });
    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }
    return userShop;
};

const parseMetadata = (value) => {
    if (!value) return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return {}; }
    }
    return value;
};

const getInvoicePeriod = (invoice) => {
    let start = invoice.billing_period_start ? new Date(invoice.billing_period_start) : null;
    let end = invoice.billing_period_end ? new Date(invoice.billing_period_end) : null;
    if (!start || Number.isNaN(start.getTime())) {
        const label = String(invoice.billing_period || '');
        const numeric = label.match(/^(\d{4})-(\d{1,2})$/);
        const named = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
        let year;
        let month;
        if (numeric) {
            year = Number(numeric[1]);
            month = Number(numeric[2]) - 1;
        } else if (named) {
            year = Number(named[2]);
            month = new Date(`${named[1]} 1, ${year}`).getMonth();
        }
        if (Number.isInteger(year) && month >= 0 && month <= 11) {
            start = new Date(Date.UTC(year, month, 1));
        }
    }
    if (!start || Number.isNaN(start.getTime())) {
        const createdAt = invoice.created_at || invoice.paid_at;
        if (createdAt) {
            const anchor = new Date(createdAt);
            if (!Number.isNaN(anchor.getTime())) {
                start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
            }
        }
    }
    if (start && (!end || Number.isNaN(end.getTime()))) {
        end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
    }
    return start && end ? { start, end } : null;
};

const isPartnerInvoice = (invoice) => {
    if (invoice.invoice_type === 'partner_per_order' || invoice.invoice_type === 'delivered_order') return true;
    const metadata = parseMetadata(invoice.metadata);
    if (String(metadata.model || '').toUpperCase() === 'DELIVERED_ORDER') return true;
    return [metadata.plan_code, metadata.planCode, metadata.plan_name, metadata.planName, metadata.billing_model]
        .some(value => String(value || '').toUpperCase().includes('PARTNER')
            || String(value || '').toLowerCase() === 'per_order');
};

const calculateLegacyPartnerCharge = (deliveredOrders) => {
    let remaining = Math.max(0, Number(deliveredOrders) || 0);
    let total = 0;
    let previousMax = 0;
    for (const tier of [{ upTo: 500, rateBdt: 15 }, { upTo: 1000, rateBdt: 12 }, { upTo: null, rateBdt: 10 }]) {
        if (remaining <= 0) break;
        const bracketSize = tier.upTo === null ? remaining : tier.upTo - previousMax;
        const ordersInBracket = Math.min(remaining, bracketSize);
        total += ordersInBracket * tier.rateBdt;
        remaining -= ordersInBracket;
        if (tier.upTo !== null) previousMax = tier.upTo;
    }
    return total;
};

/**
 * Find the invoice that already charged this order's delivery.
 *
 * `invoiceIdHint` short-circuits the search when the billing line itself names
 * the invoice (ADR-0011): the line is the authoritative link, and re-deriving
 * it from dates could miss a boundary.
 */
const findPartnerInvoiceForOrder = async (shopId, order, transaction, invoiceIdHint = null) => {
    if (invoiceIdHint && typeof Invoice.findByPk === 'function') {
        const hinted = await Invoice.findByPk(invoiceIdHint, {
            transaction,
            ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        if (hinted && String(hinted.shop_id) === String(shopId)) return hinted;
    }

    const where = {
        shop_id: shopId,
        status: { [Op.in]: ['pending', 'overdue', 'paid'] },
        invoice_type: {
            [Op.in]: ['partner_per_order', 'delivered_order', 'monthly_subscription', 'yearly_subscription'],
        },
    };
    let invoices = [];
    if (typeof Invoice.findAll === 'function') {
        invoices = await Invoice.findAll({
            where,
            order: [['billing_period_end', 'DESC']],
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
    } else if (typeof Invoice.findOne === 'function') {
        const invoice = await Invoice.findOne({
            where: {
                ...where,
                invoice_type: 'partner_per_order',
                billing_period_start: { [Op.lte]: order.delivered_at || order.updated_at },
                billing_period_end: { [Op.gt]: order.delivered_at || order.updated_at },
            },
            order: [['paid_at', 'DESC']],
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
        if (invoice) invoices = [invoice];
    }

    const deliveryDate = new Date(order.delivered_at || order.updated_at);
    return invoices
        .filter(isPartnerInvoice)
        .find((invoice) => {
            const period = getInvoicePeriod(invoice);
            return !period || (deliveryDate >= period.start && deliveryDate < period.end);
        }) || null;
};

const getPartnerRate = async (invoice, shopId, transaction) => {
    const metadata = parseMetadata(invoice.metadata);

    // ADR-0011 invoices record the contract unit price in poisha. It is the
    // exact price charged, so it wins over any legacy derivation.
    const unitPriceMinor = Number(metadata.unit_price_minor ?? metadata.unitPriceMinor);
    if (Number.isFinite(unitPriceMinor) && unitPriceMinor > 0) {
        return unitPriceMinor / 100;
    }

    const explicitRate = Number(
        metadata.rate_bdt
        ?? metadata.rateBdt
        ?? metadata.rate_per_order
        ?? metadata.partner_rate_bdt
        ?? metadata.partnerRateBdt,
    ) || 0;

    let deliveredOrders = Number(
        metadata.delivered_orders
        ?? metadata.deliveredOrders
        ?? metadata.partner_orders
        ?? metadata.partnerOrders
        ?? metadata.orders_count
        ?? metadata.orderCount,
    ) || 0;
    const period = getInvoicePeriod(invoice);
    if (!deliveredOrders && period && typeof Order.count === 'function') {
        deliveredOrders = await Order.count({
            where: {
                shop_id: shopId,
                order_status: 'delivered',
                delivered_at: { [Op.gte]: period.start, [Op.lt]: period.end },
            },
            transaction,
        });
    }
    if (explicitRate > 0) return explicitRate;

    const historicalAggregate = Number(
        metadata.gross_partner_charge
        ?? metadata.grossPartnerCharge
        ?? metadata.partner_charge
        ?? metadata.partnerCharge
        ?? metadata.total_charge
        ?? metadata.charge_bdt
        ?? (invoice.invoice_type === 'partner_per_order' ? invoice.amount : 0),
    ) || 0;
    if (historicalAggregate > 0 && deliveredOrders > 0) {
        // Preserve the effective rate actually charged by legacy progressive
        // invoices instead of applying today's flat band to an old return.
        return historicalAggregate / deliveredOrders;
    }
    if (deliveredOrders > 0) {
        return calculateLegacyPartnerCharge(deliveredOrders) / deliveredOrders;
    }
    const { getPartnerOrderTier } = require('../subscription/subscription.legacy-plans');
    return getPartnerOrderTier(deliveredOrders)?.rateBdt || 0;
};

/**
 * Initiate a return request on a delivered order.
 * Verifies the order belongs to the shop, is 'delivered', and stores return metadata.
 * Returns the generated return reference.
 */
const initiateReturn = async (shopId, orderId, customerId, reason) => {
    let order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
    if (!order) {
        throw new AppError('Order not found', 404);
    }

    if (order.order_status !== 'delivered') {
        throw new AppError(
            `Return can only be initiated for delivered orders. Current status: '${order.order_status}'`,
            400
        );
    }

    let existingMeta = order.metadata || {};
    if (typeof existingMeta === 'string') {
        try { existingMeta = JSON.parse(existingMeta); } catch (_) { existingMeta = {}; }
    }
    if (existingMeta.returnRequested) {
        throw new AppError('A return request already exists for this order', 409);
    }

    const returnRef = `RET-${Date.now()}`;

    await order.update({
        metadata: {
            ...existingMeta,
            returnRequested: true,
            returnReason: reason || null,
            returnRef,
            returnStatus: 'pending',
            returnRequestedAt: new Date(),
            returnCustomerId: customerId || null
        }
    });

    return { returnRef, orderId: order.id, orderNumber: order.order_number };
};

/**
 * Update the return status on an order.
 * status: 'approved' | 'rejected' | 'refunded'
 */
const updateReturnStatus = async (shopId, orderId, status) => {
    const VALID_STATUSES = ['approved', 'rejected', 'refunded'];
    if (!VALID_STATUSES.includes(status)) {
        throw new AppError(`Invalid return status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }

    let order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
    if (!order) {
        throw new AppError('Order not found', 404);
    }

    let existingMeta = order.metadata || {};
    if (typeof existingMeta === 'string') {
        try { existingMeta = JSON.parse(existingMeta); } catch (_) { existingMeta = {}; }
    }
    if (!existingMeta.returnRequested) {
        throw new AppError('No return request found for this order', 404);
    }

    await sequelize.transaction(async (transaction) => {
        const lockedOrder = typeof Order.findOne === 'function'
            ? await Order.findOne({
                where: { id: orderId, shop_id: shopId },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            })
            : order;
        if (!lockedOrder) throw new AppError('Order not found', 404);
        order = lockedOrder;

        let lockedMeta = order.metadata || {};
        if (typeof lockedMeta === 'string') {
            try { lockedMeta = JSON.parse(lockedMeta); } catch (_) { lockedMeta = {}; }
        }
        if (!lockedMeta.returnRequested) {
            throw new AppError('No return request found for this order', 404);
        }
        if (['approved', 'refunded'].includes(lockedMeta.returnStatus)) {
            if (lockedMeta.returnStatus === status) return;
            throw new AppError('Return status is already finalized', 409);
        }

        const updatedMeta = {
            ...lockedMeta,
            returnStatus: status,
            returnStatusUpdatedAt: new Date()
        };

        // ADR-0011 reversal rule. The billing line is the financial truth:
        //   - before invoicing: convert it in place to an explicit BDT 0 line;
        //   - after invoicing: leave the invoice alone and use the credit path
        //     below (unpaid -> reduce in place, paid -> pending credit).
        const isReversal = status === 'approved' || status === 'refunded';
        let billingLine = null;
        if (isReversal && deliveredOrderBilling
            && typeof deliveredOrderBilling.findLineForOrder === 'function') {
            billingLine = await deliveredOrderBilling.findLineForOrder({ shopId, orderId }, transaction);
        }
        const hasBillableLine = Boolean(billingLine) && billingLine.line_kind === 'billable';

        if (isReversal && hasBillableLine && !billingLine.invoice_id) {
            const reversal = await deliveredOrderBilling.reverseLineForReturn({ shopId, orderId }, transaction);
            if (reversal.reversed) {
                updatedMeta.partnerBillingReversalAt = updatedMeta.returnStatusUpdatedAt;
            }
        } else if (isReversal
            && (!billingLine || hasBillableLine)
            && (order.delivered_at || order.updated_at)
            && !lockedMeta.partnerBillingAdjustmentId
            && Invoice && typeof Invoice.findOne === 'function'
            && PartnerBillingAdjustment && typeof PartnerBillingAdjustment.create === 'function') {
            // A settled invoice is immutable. Record one credit ledger row
            // instead; the next delivered-order invoice nets it against new
            // deliveries.
            const settledInvoice = await findPartnerInvoiceForOrder(
                shopId,
                order,
                transaction,
                hasBillableLine ? billingLine.invoice_id : null,
            );
            const existingAdjustment = PartnerBillingAdjustment && typeof PartnerBillingAdjustment.findOne === 'function'
                ? await PartnerBillingAdjustment.findOne({
                    where: { shop_id: shopId, order_id: orderId },
                    transaction,
                })
                : null;
            if (settledInvoice && !existingAdjustment) {
                const metadata = parseMetadata(settledInvoice.metadata);
                const rateBdt = await getPartnerRate(settledInvoice, shopId, transaction);
                if (rateBdt > 0) {
                    const adjustment = await PartnerBillingAdjustment.create({
                        shop_id: shopId,
                        order_id: orderId,
                        amount_bdt: rateBdt,
                        reason: 'return_reversal'
                    }, { transaction });
                    updatedMeta.partnerBillingAdjustmentId = adjustment.id;
                    updatedMeta.partnerBillingAdjustmentAmountBdt = rateBdt;

                    if (settledInvoice.status !== 'paid') {
                        const updatedInvoiceMetadata = {
                            ...metadata,
                            adjustment_credit: (Number(metadata.adjustment_credit) || 0) + rateBdt,
                            computed_total: Math.max(0, Number(settledInvoice.amount) - rateBdt),
                        };
                        const nextAmount = Math.max(0, Number(settledInvoice.amount) - rateBdt);
                        await settledInvoice.update({
                            amount: nextAmount,
                            extra_usage_amount: Math.max(0, Number(settledInvoice.extra_usage_amount || 0) - rateBdt),
                            metadata: updatedInvoiceMetadata,
                            ...(nextAmount === 0 ? {
                                status: 'cancelled',
                                payment_id: null,
                                bkash_url: null,
                                notes: 'Cancelled after Partner return reversal reduced the balance to zero',
                            } : {}),
                        }, { transaction });
                        await adjustment.update({
                            status: 'applied',
                            invoice_id: settledInvoice.id,
                            applied_at: new Date(),
                        }, { transaction });
                    }
                }
            }
        }
        if (status === 'approved' || status === 'refunded') {
            updatedMeta.partnerBillingReversalAt = updatedMeta.returnStatusUpdatedAt;
        }

        await order.update({ metadata: updatedMeta }, { transaction });

        // Restore inventory when return is approved
        if (status === 'approved') {
            const items = await OrderItem.findAll({ where: { order_id: orderId }, transaction });
            for (const item of items) {
                const product = await Product.findOne({ where: { id: item.product_id, shop_id: shopId }, transaction });
                if (product?.track_quantity) {
                    await product.increment('quantity', { by: item.quantity, transaction });
                    // Fire-and-forget cache invalidation after transaction commits
                    setImmediate(() => invalidateStock(shopId, item.product_id).catch(() => {}));
                }
            }
        }
    });

    return {
        orderId: order.id,
        orderNumber: order.order_number,
        returnRef: existingMeta.returnRef,
        returnStatus: status
    };
};

/**
 * List orders that have a return request (returnRequested: true in metadata).
 * Filters are passed through and optionally support returnStatus.
 */
const getReturnRequests = async (shopId, filters = {}) => {
    const dialect = require('../../utils/database/database-setup').sequelize.getDialect();

    const orders = await Order.findAll({
        where: { shop_id: shopId },
        order: [['created_at', 'DESC']]
    });

    // Filter in-memory since JSON querying varies by DB dialect
    let returnOrders = orders.filter(o => {
        const meta = o.metadata || {};
        return meta.returnRequested === true;
    });

    if (filters.returnStatus) {
        returnOrders = returnOrders.filter(o => {
            const meta = o.metadata || {};
            return meta.returnStatus === filters.returnStatus;
        });
    }

    return returnOrders.map(o => {
        const meta = o.metadata || {};
        return {
            orderId: o.id,
            orderNumber: o.order_number,
            customerName: o.customer_name,
            customerPhone: o.customer_phone,
            orderStatus: o.order_status,
            total: o.total,
            returnRef: meta.returnRef,
            returnReason: meta.returnReason,
            returnStatus: meta.returnStatus,
            returnRequestedAt: meta.returnRequestedAt
        };
    });
};

module.exports = {
    initiateReturn,
    updateReturnStatus,
    getReturnRequests
};
