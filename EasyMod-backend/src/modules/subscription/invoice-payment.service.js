'use strict';

/**
 * Invoice Payment Service
 *
 * Settle an outstanding subscription invoice (monthly renewal, proration, or an
 * add-on) with bKash. Mirrors the top-up flow but pays an existing Invoice row
 * instead of crediting conversations:
 *   1. initiateInvoicePayment()  — start bKash checkout for a specific pending invoice
 *   2. initiateRenewalPayment()  — ensure a renewal invoice exists, then start checkout
 *   3. completeInvoicePayment()  — execute the bKash payment, mark the invoice paid,
 *                                  and (re)activate the subscription's AI if recurring
 *
 * Historical subscription invoices (pre-ADR-0011) are settled here with a 3-day
 * due window; paying one resumes the legacy subscription's AI. New merchant
 * billing uses the delivered-order contract and its monthly invoices instead.
 * The bKash paymentID and checkout URL are persisted against the tenant-scoped
 * invoice so a cancelled or failed browser attempt can be resumed safely.
 */

const { Subscription, Invoice, Shop } = require('../entities');
const crypto = require('crypto');
const { sequelize } = require('../../utils/database/database-setup');
const BangladeshPaymentService = require('../payment/bangladesh-payment.service');
const subscriptionService = require('./subscription.service');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const { Op } = require('sequelize');

const logger = createLogger('InvoicePaymentService');
const bdPayment = new BangladeshPaymentService();

// Invoice.status ENUM is ('pending','paid','cancelled','overdue') — these two are payable.
const PAYABLE_STATUSES = ['pending', 'overdue'];
const CHECKOUT_LEASE_MS = 10 * 60 * 1000;
const { RECURRING_INVOICE_TYPES } = require('./subscription.plans');

const timestampSql = () => (sequelize.getDialect?.() === 'sqlite' ? 'CURRENT_TIMESTAMP' : 'NOW()');

const normalizeAmountToMinorUnits = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};

const releaseInvoiceCheckoutLease = async (invoiceId, shopId, leaseId) => {
    await sequelize.query(
        `UPDATE invoices
            SET checkout_lease_id=NULL, checkout_lease_expires_at=NULL
          WHERE id=:invoiceId AND shop_id=:shopId AND checkout_lease_id=:leaseId`,
        { replacements: { invoiceId, shopId, leaseId } },
    ).catch(() => {});
};

const affectedRows = (result) => {
    if (typeof result?.[0] === 'number') return result[0];
    const metadata = result?.[1];
    if (typeof metadata === 'number') return metadata;
    return Number(metadata?.rowCount ?? metadata?.changes ?? 0);
};

const recordFunnelEventSafe = (event, values) => {
    try {
        return require('../analytics/funnel-events.service')
            .recordInternalFunnelEvent({ event, ...values })
            .catch(() => {});
    } catch (_) {
        return Promise.resolve();
    }
};

/**
 * Load an invoice that belongs to the shop and is in a payable state.
 */
const loadPayableInvoice = async (shopId, invoiceId) => {
    const invoice = await Invoice.findOne({ where: { id: invoiceId, shop_id: shopId } });
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'paid') throw new AppError('Invoice is already paid', 409);
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
        throw new AppError(`Invoice cannot be paid (status: ${invoice.status})`, 400);
    }
    return invoice;
};

/**
 * Start a bKash checkout for a specific outstanding invoice.
 *
 * @param {string} shopId
 * @param {string} invoiceId
 * @param {{ phone?: string, name?: string, callbackUrl: string }} customerInfo
 * @returns {{ invoice_id, invoice_number, amount, bkash_url, payment_id }}
 */
const initiateInvoicePayment = async (shopId, invoiceId, { phone, name, callbackUrl }) => {
    if (!callbackUrl) throw new AppError('callback_url is required', 400);

    const invoice = await loadPayableInvoice(shopId, invoiceId);
    if (invoice.payment_id) {
        if (invoice.bkash_url) {
            return {
                invoice_id: invoice.id,
                invoice_number: invoice.invoice_number,
                amount: parseFloat(invoice.amount),
                bkash_url: invoice.bkash_url,
                payment_id: invoice.payment_id,
            };
        }
        throw new AppError('A bKash checkout is already in progress for this invoice', 409, 'PAYMENT_IN_PROGRESS');
    }
    const amount = parseFloat(invoice.amount);
    if (!(amount > 0)) throw new AppError('Invoice amount is not payable', 400);

    const leaseId = crypto.randomUUID();
    const leaseNow = new Date();
    const leaseExpiresAt = new Date(leaseNow.getTime() + CHECKOUT_LEASE_MS);
    const leaseResult = await sequelize.query(
        `UPDATE invoices
            SET checkout_lease_id=:leaseId, checkout_lease_expires_at=:leaseExpiresAt
          WHERE id=:invoiceId AND shop_id=:shopId
            AND status IN ('pending', 'overdue') AND payment_id IS NULL
            AND (checkout_lease_id IS NULL OR checkout_lease_expires_at < :leaseNow)`,
        { replacements: { leaseId, leaseExpiresAt, leaseNow, invoiceId, shopId } },
    );
    if (affectedRows(leaseResult) !== 1) {
        const current = await Invoice.findOne({ where: { id: invoiceId, shop_id: shopId } });
        if (current?.payment_id && current.bkash_url) {
            return {
                invoice_id: current.id,
                invoice_number: current.invoice_number,
                amount: parseFloat(current.amount),
                bkash_url: current.bkash_url,
                payment_id: current.payment_id,
            };
        }
        throw new AppError('A bKash checkout is already in progress for this invoice', 409, 'PAYMENT_IN_PROGRESS');
    }

    try {
        const shop = await Shop.findByPk(shopId);
        const bkashResult = await bdPayment.initializeBkashPayment({
            order_id: invoice.invoice_number,
            amount,
            customer_name: name || shop?.name || 'Shop Owner',
            customer_phone: phone || shop?.phone || '01000000000',
            callback_url: callbackUrl,
            shop_id: shopId
        });

        if (!bkashResult.success) {
            throw new AppError('bKash payment initiation failed', 502);
        }
        if (!bkashResult.payment_id || !bkashResult.bkash_url) {
            throw new AppError('bKash payment initiation returned an incomplete checkout', 502);
        }

        // Bind the gateway payment ID to this exact invoice. Completion must not
        // trust an arbitrary payment ID supplied by the browser, and the lease
        // prevents concurrent requests from creating multiple gateway payments.
        const bindResult = await sequelize.query(
            `UPDATE invoices
                SET payment_id=:paymentId, bkash_url=:bkashUrl,
                    checkout_lease_id=NULL, checkout_lease_expires_at=NULL
              WHERE id=:invoiceId AND shop_id=:shopId
                AND status IN ('pending', 'overdue') AND payment_id IS NULL
                AND checkout_lease_id=:leaseId`,
            {
                replacements: {
                    paymentId: bkashResult.payment_id,
                    bkashUrl: bkashResult.bkash_url,
                    invoiceId,
                    shopId,
                    leaseId,
                },
            },
        );
        if (affectedRows(bindResult) !== 1) {
            throw new AppError('A bKash checkout is already in progress for this invoice', 409, 'PAYMENT_IN_PROGRESS');
        }

        logger.info('Invoice payment initiated', {
            shopId, invoiceId, invoiceNumber: invoice.invoice_number, bkashPaymentId: bkashResult.payment_id
        });

        return {
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            amount,
            bkash_url: bkashResult.bkash_url,
            payment_id: bkashResult.payment_id
        };
    } catch (error) {
        await releaseInvoiceCheckoutLease(invoiceId, shopId, leaseId);
        if (error?.name === 'SequelizeUniqueConstraintError') {
            throw new AppError('This bKash payment is already bound to another invoice', 409, 'PAYMENT_ID_REUSED');
        }
        throw error;
    }
};

/**
 * Ensure a renewal invoice exists for the shop, then start a bKash checkout.
 * Used by the primary "Renew with bKash" CTA when no invoice was generated by the
 * daily billing job yet.
 *
 * @param {string} shopId
 * @param {string} userId
 * @param {{ phone?: string, name?: string, callbackUrl: string }} customerInfo
 */
const initiateRenewalPayment = async (shopId, userId, customerInfo) => {
    const invoice = await subscriptionService.ensureRenewalInvoice(
        shopId,
        userId,
        customerInfo?.plan_code || null,
    );
    return initiateInvoicePayment(shopId, invoice.id, customerInfo);
};

/**
 * Execute the bKash payment and settle the invoice.
 * On success marks the invoice paid; recurring invoices also (re)activate the AI.
 *
 * @param {string} shopId
 * @param {string} invoiceId
 * @param {string} bkashPaymentId - paymentID returned by bKash (round-tripped from FE)
 * @returns {{ success, invoice_id, status, transaction_id, subscription_status }}
 */
const completeInvoicePayment = async (shopId, invoiceId, bkashPaymentId) => {
    const invoice = await Invoice.findOne({ where: { id: invoiceId, shop_id: shopId } });
    if (!invoice) throw new AppError('Invoice not found', 404);

    if (invoice.status === 'paid') {
        return { success: true, already_paid: true, invoice_id: invoice.id, status: 'paid' };
    }

    if (!bkashPaymentId) throw new AppError('payment_id is required', 400);
    if (invoice.payment_id !== bkashPaymentId) {
        throw new AppError('Payment is not bound to this invoice', 403);
    }
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
        throw new AppError(`Invoice cannot be paid (status: ${invoice.status})`, 400);
    }

    const verification = await bdPayment.verifyBkashPayment(bkashPaymentId);

    if (!verification.success || verification.status !== 'completed') {
        if (verification.status === 'failed' && typeof Invoice.update === 'function') {
            await Invoice.update(
                { payment_id: null, bkash_url: null },
                { where: { id: invoiceId, shop_id: shopId, status: { [Op.in]: PAYABLE_STATUSES }, payment_id: bkashPaymentId } },
            );
        }
        // Leave the invoice payable so the owner can retry (status ENUM has no 'failed').
        recordFunnelEventSafe('renewal_failed', {
            shopId,
            metadata: { invoice_type: invoice.invoice_type || 'unknown', reason: verification.status || 'failed' },
        });
        throw new AppError(verification.message || 'bKash payment verification failed', 402);
    }

    const expectedAmount = normalizeAmountToMinorUnits(invoice.amount);
    const providerAmount = normalizeAmountToMinorUnits(verification.amount);
    if (expectedAmount === null || providerAmount === null || expectedAmount !== providerAmount) {
        recordFunnelEventSafe('renewal_failed', {
            shopId,
            metadata: { invoice_type: invoice.invoice_type || 'unknown', reason: 'amount_mismatch' },
        });
        throw new AppError('Payment amount mismatch', 400);
    }
    if (!verification.merchant_invoice || verification.merchant_invoice !== invoice.invoice_number) {
        recordFunnelEventSafe('renewal_failed', {
            shopId,
            metadata: { invoice_type: invoice.invoice_type || 'unknown', reason: 'invoice_mismatch' },
        });
        throw new AppError('Payment invoice mismatch', 400);
    }
    if (!verification.transaction_id || String(verification.currency || '').toUpperCase() !== 'BDT') {
        recordFunnelEventSafe('renewal_failed', {
            shopId,
            metadata: { invoice_type: invoice.invoice_type || 'unknown', reason: 'gateway_identity_missing' },
        });
        throw new AppError('Payment verification identity is incomplete', 400);
    }

    // Claim and activate in one transaction. If subscription activation fails,
    // the invoice claim rolls back and the same bound payment can be retried.
    let subscriptionStatus = null;
    let claimWon = false;
    let settlementInvoice = invoice;
    await sequelize.transaction(async (transaction) => {
        settlementInvoice = await Invoice.findOne({
            where: { id: invoiceId, shop_id: shopId },
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
        if (!settlementInvoice) throw new AppError('Invoice not found', 404);
        if (settlementInvoice.status === 'paid') return;
        if (!PAYABLE_STATUSES.includes(settlementInvoice.status)) {
            throw new AppError(`Invoice cannot be paid (status: ${settlementInvoice.status})`, 400);
        }
        if (settlementInvoice.payment_id !== bkashPaymentId) {
            throw new AppError('Payment is not bound to this invoice', 403);
        }
        const currentAmount = normalizeAmountToMinorUnits(settlementInvoice.amount);
        if (currentAmount === null || currentAmount !== expectedAmount) {
            throw new AppError('Invoice amount changed; restart payment', 409, 'INVOICE_AMOUNT_CHANGED');
        }

        let activationSubscription = null;
        let activationMetadata = {};
        if (RECURRING_INVOICE_TYPES.includes(settlementInvoice.invoice_type)) {
            activationSubscription = await Subscription.findOne({
                where: { id: settlementInvoice.subscription_id, shop_id: shopId },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!activationSubscription) throw new AppError('Subscription not found for invoice', 409, 'SUBSCRIPTION_INVOICE_MISMATCH');
            activationMetadata = settlementInvoice.metadata || {};
            if (typeof activationMetadata === 'string') {
                try { activationMetadata = JSON.parse(activationMetadata); } catch (_) { activationMetadata = {}; }
            }
            const invoicePlanCode = activationMetadata.plan_code || activationMetadata.planCode;
            if (invoicePlanCode
                && String(invoicePlanCode).toUpperCase() !== String(activationSubscription.plan_code || '').toUpperCase()) {
                throw new AppError('Invoice no longer matches the current subscription plan', 409, 'STALE_PLAN_INVOICE');
            }
        }

        const claimResult = await sequelize.query(
            `UPDATE invoices
                SET status='paid', paid_at=${timestampSql()}, payment_method='bkash',
                    transaction_id=:transactionId,
                    checkout_lease_id=NULL, checkout_lease_expires_at=NULL
              WHERE id=:invoiceId AND shop_id=:shopId
                AND status IN ('pending', 'overdue') AND payment_id=:paymentId`,
            {
                replacements: {
                    invoiceId,
                    shopId,
                    paymentId: bkashPaymentId,
                    transactionId: verification.transaction_id || null
                },
                transaction,
            }
        );
        if (affectedRows(claimResult) !== 1) {
            const current = await Invoice.findOne({
                where: { id: invoiceId, shop_id: shopId },
                transaction,
            });
            if (current?.status === 'paid') {
                settlementInvoice = current;
                return;
            }
            throw new AppError('Invoice settlement is already being handled', 409, 'PAYMENT_SETTLEMENT_RACE');
        }
        claimWon = true;

        // Recurring (monthly / partner) invoice → (re)activate the AI. One-off invoices
        // (proration, add-ons) just settle; they never gate AI.
        if (activationSubscription) {
            const preservesPartnerPeriod = settlementInvoice.invoice_type === 'partner_per_order'
                || String(activationSubscription.plan_code || '').toUpperCase() === 'PARTNER'
                || String(activationMetadata.billing_model || '').toLowerCase() === 'per_order';
            await subscriptionService.activateFromPaidInvoice(activationSubscription, {
                targetPlanCode: activationMetadata.target_plan_code || null,
                targetBillingCycle: activationMetadata.target_billing_cycle || null,
                preservePeriod: preservesPartnerPeriod,
                billingPeriodEnd: settlementInvoice.billing_period_end || null,
                transaction,
            });
            subscriptionStatus = activationSubscription.status;
        }
    });

    if (!claimWon) {
        return { success: true, already_paid: true, invoice_id: invoice.id, status: 'paid' };
    }
    if (RECURRING_INVOICE_TYPES.includes(settlementInvoice.invoice_type)) {
        await require('../../utils/cache.service').clearForShop(shopId).catch(() => {});
        recordFunnelEventSafe('renewal_succeeded', {
            shopId,
            metadata: { invoice_type: settlementInvoice.invoice_type },
            onceKey: `renewal_succeeded:${settlementInvoice.id}`,
        });
    }

    logger.info('Invoice payment completed', {
        shopId, invoiceId, trxId: verification.transaction_id, subscriptionStatus
    });

    return {
        success: true,
        invoice_id: settlementInvoice.id,
        status: 'paid',
        transaction_id: verification.transaction_id,
        subscription_status: subscriptionStatus
    };
};

/**
 * Release a browser checkout that the customer cancelled before verification.
 * The payment ID must match the tenant-scoped invoice binding so a stale or
 * forged callback cannot clear another checkout.
 */
const cancelInvoicePayment = async (shopId, invoiceId, bkashPaymentId) => {
    if (!bkashPaymentId) throw new AppError('payment_id is required', 400);

    const invoice = await Invoice.findOne({ where: { id: invoiceId, shop_id: shopId } });
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'paid') {
        return { success: true, already_paid: true, invoice_id: invoice.id, status: 'paid' };
    }
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
        throw new AppError(`Invoice cannot be cancelled (status: ${invoice.status})`, 400);
    }
    if (!invoice.payment_id) {
        return { success: true, already_released: true, invoice_id: invoice.id, status: invoice.status };
    }
    if (invoice.payment_id !== bkashPaymentId) {
        throw new AppError('Payment is not bound to this invoice', 403);
    }

    const [updated] = await Invoice.update(
        {
            payment_id: null,
            bkash_url: null,
            checkout_lease_id: null,
            checkout_lease_expires_at: null,
        },
        {
            where: {
                id: invoiceId,
                shop_id: shopId,
                status: { [Op.in]: PAYABLE_STATUSES },
                payment_id: bkashPaymentId,
            },
        },
    );

    if (Number(updated) !== 1) {
        const current = await Invoice.findOne({ where: { id: invoiceId, shop_id: shopId } });
        if (current?.status === 'paid') {
            return { success: true, already_paid: true, invoice_id: current.id, status: 'paid' };
        }
        if (current && !current.payment_id) {
            return { success: true, already_released: true, invoice_id: current.id, status: current.status };
        }
        throw new AppError('Invoice payment cancellation is already being handled', 409, 'PAYMENT_SETTLEMENT_RACE');
    }

    logger.info('Invoice payment checkout released', { shopId, invoiceId });
    return { success: true, invoice_id: invoice.id, status: invoice.status, payment_id: null };
};

module.exports = {
    initiateInvoicePayment,
    initiateRenewalPayment,
    completeInvoicePayment,
    cancelInvoicePayment,
};
