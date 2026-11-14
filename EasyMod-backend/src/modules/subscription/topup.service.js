'use strict';

/**
 * Top-Up Service
 *
 * Handles conversation pack top-up purchases via BKash.
 * Flow:
 *   1. initiate()  — create pending transaction, start BKash payment
 *   2. complete()  — verify BKash payment, add conversations to subscription, generate invoice
 *      Failed gateway verification clears only the failed checkout binding so a
 *      new idempotent attempt can be started safely.
 */

const { sequelize } = require('../../utils/database/database-setup');
const { Subscription } = require('../entities');
const BangladeshPaymentService = require('../payment/bangladesh-payment.service');
const invoiceService = require('./invoice.service');
const { getTopupPack, TOPUP_PACKS } = require('./subscription.plans');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const crypto = require('crypto');

const logger = createLogger('TopupService');
const bdPayment = new BangladeshPaymentService();
const CHECKOUT_LEASE_MS = 10 * 60 * 1000;

const timestampSql = () => (sequelize.getDialect?.() === 'sqlite' ? 'CURRENT_TIMESTAMP' : 'NOW()');

const normalizeAmountToMinorUnits = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};

const affectedRows = (result) => {
    if (typeof result?.[0] === 'number') return result[0];
    const metadata = result?.[1];
    if (typeof metadata === 'number') return metadata;
    return Number(metadata?.rowCount ?? metadata?.changes ?? 0);
};

const releaseTopupCheckoutLease = async (topupId, shopId, leaseId) => {
    await sequelize.query(
        `UPDATE topup_transactions
            SET checkout_lease_id=NULL, checkout_lease_expires_at=NULL
          WHERE id=:id AND shop_id=:shopId AND checkout_lease_id=:leaseId`,
        { replacements: { id: topupId, shopId, leaseId } },
    ).catch(() => {});
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
 * List legacy top-up products (historical catalog; purchasing is retired).
 */
const getTopupPacks = () => Object.values(TOPUP_PACKS);

/**
 * Initiate a top-up payment.
 * Creates a topup_transaction record (status=pending) and starts BKash checkout.
 *
 * @param {string} shopId
 * @param {string} packCode  - legacy catalog code
 * @param {{ phone: string, name: string, callbackUrl: string }} customerInfo
 * @returns {{ topupId, bkashUrl, paymentId, pack }}
 */
const initiateTopup = async (shopId, packCode, { phone, name, callbackUrl, idempotencyKey }) => {
    const pack = TOPUP_PACKS[packCode];
    if (!pack) throw new AppError(`Invalid top-up code: ${packCode}`, 400);

    const subscription = await Subscription.findOne({
        where: { shop_id: shopId },
        attributes: ['plan_code']
    });
    if (!subscription || String(subscription.plan_code || '').toUpperCase() !== 'GROWTH') {
        throw new AppError('Top-up purchases are retired; billing is per delivered order', 403);
    }

    if (!phone) throw new AppError('phone is required for BKash payment', 400);
    const normalizedIdempotencyKey = String(idempotencyKey || '').trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 128) {
        throw new AppError('Idempotency-Key is required for BKash payment', 400);
    }

    const [existing] = await sequelize.query(
        `SELECT * FROM topup_transactions
          WHERE shop_id=:shopId AND idempotency_key=:idempotencyKey
          LIMIT 1`,
        {
            replacements: { shopId, idempotencyKey: normalizedIdempotencyKey },
            type: sequelize.QueryTypes.SELECT,
        },
    );

    let topupId = existing?.id;
    let invoiceNumber = existing?.invoice_number;
    const leaseId = crypto.randomUUID();
    const leaseNow = new Date();
    const leaseExpiresAt = new Date(leaseNow.getTime() + CHECKOUT_LEASE_MS);
    if (existing?.status === 'completed') {
        return {
            topup_id: existing.id,
            already_completed: true,
            invoice_number: existing.invoice_number,
        };
    }
    if (existing?.status === 'pending' && existing.bkash_payment_id && existing.bkash_url) {
        return {
            topup_id: existing.id,
            bkash_url: existing.bkash_url,
            payment_id: existing.bkash_payment_id,
            pack: getTopupPack(existing.pack_code) || pack,
            invoice_number: existing.invoice_number,
        };
    }
    if (existing?.status === 'pending' && existing.bkash_payment_id) {
        throw new AppError('A bKash checkout is already in progress for this top-up', 409, 'PAYMENT_IN_PROGRESS');
    }
    if (existing && existing.status !== 'pending') {
        throw new AppError('This Idempotency-Key was already used for a failed top-up', 409, 'IDEMPOTENCY_KEY_REUSED');
    }

    if (existing?.status === 'pending') {
        const existingLeaseExpiry = existing.checkout_lease_expires_at
            ? new Date(existing.checkout_lease_expires_at)
            : null;
        if (existingLeaseExpiry && existingLeaseExpiry > leaseNow) {
            throw new AppError('A bKash checkout is already being started for this top-up', 409, 'PAYMENT_IN_PROGRESS');
        }
        const leaseResult = await sequelize.query(
            `UPDATE topup_transactions
                SET checkout_lease_id=:leaseId, checkout_lease_expires_at=:leaseExpiresAt
              WHERE id=:id AND shop_id=:shopId AND idempotency_key=:idempotencyKey
                AND status='pending' AND bkash_payment_id IS NULL
                AND (checkout_lease_id IS NULL OR checkout_lease_expires_at < :leaseNow)`,
            {
                replacements: {
                    id: topupId,
                    shopId,
                    idempotencyKey: normalizedIdempotencyKey,
                    leaseId,
                    leaseExpiresAt,
                    leaseNow,
                },
            },
        );
        if (affectedRows(leaseResult) !== 1) {
            throw new AppError('A bKash checkout is already being started for this top-up', 409, 'PAYMENT_IN_PROGRESS');
        }
    } else if (!topupId) {
        topupId = crypto.randomUUID();
        invoiceNumber = `TU-${new Date().toISOString().substring(0, 7).replace('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        // Reserve the idempotency key before contacting bKash.
        try {
            await sequelize.query(
                `INSERT INTO topup_transactions
                 (id, shop_id, pack_code, pack_conversations, amount_bdt, status, invoice_number, idempotency_key, checkout_lease_id, checkout_lease_expires_at, created_at)
                  VALUES (:id, :shopId, :packCode, :packConversations, :amountBdt, 'pending', :invoiceNumber, :idempotencyKey, :leaseId, :leaseExpiresAt, ${timestampSql()})`,
                {
                    replacements: {
                        id: topupId,
                        shopId,
                        packCode,
                        packConversations: pack.conversations,
                        amountBdt: pack.priceBdt,
                        invoiceNumber,
                        idempotencyKey: normalizedIdempotencyKey,
                        leaseId,
                        leaseExpiresAt,
                    }
                }
            );
        } catch (error) {
            if (error?.name === 'SequelizeUniqueConstraintError') {
                throw new AppError('This Idempotency-Key is already being processed', 409, 'IDEMPOTENCY_KEY_IN_PROGRESS');
            }
            throw error;
        }
    }

    // Start BKash payment only while this request owns the checkout lease.
    let bkashResult;
    try {
        bkashResult = await bdPayment.initializeBkashPayment({
            order_id: invoiceNumber,
            amount: pack.priceBdt,
            customer_name: name || 'Shop Owner',
            customer_phone: phone,
            callback_url: callbackUrl,
            shop_id: shopId
        });
    } catch (error) {
        await releaseTopupCheckoutLease(topupId, shopId, leaseId);
        throw error;
    }

    if (!bkashResult.success) {
        await sequelize.query(
            `UPDATE topup_transactions
                SET status='failed', checkout_lease_id=NULL, checkout_lease_expires_at=NULL
              WHERE id=:id AND shop_id=:shopId AND checkout_lease_id=:leaseId`,
            { replacements: { id: topupId, shopId, leaseId } }
        );
        throw new AppError('BKash payment initiation failed', 502);
    }
    if (!bkashResult.payment_id || !bkashResult.bkash_url) {
        await sequelize.query(
            `UPDATE topup_transactions
                SET status='failed', checkout_lease_id=NULL, checkout_lease_expires_at=NULL
              WHERE id=:id AND shop_id=:shopId AND status='pending' AND checkout_lease_id=:leaseId`,
            { replacements: { id: topupId, shopId, leaseId } },
        );
        throw new AppError('BKash payment initiation returned an incomplete checkout', 502);
    }

    // Bind the gateway payment to this one pending transaction. A concurrent
    // checkout cannot overwrite an existing binding, and the unique index on
    // the gateway id prevents reuse across two top-ups.
    let bindResult;
    try {
        bindResult = await sequelize.query(
            `UPDATE topup_transactions
                SET bkash_payment_id=:paymentId, bkash_url=:bkashUrl,
                    checkout_lease_id=NULL, checkout_lease_expires_at=NULL
              WHERE id=:id AND shop_id=:shopId AND status='pending'
                AND bkash_payment_id IS NULL AND checkout_lease_id=:leaseId`,
            { replacements: { paymentId: bkashResult.payment_id, bkashUrl: bkashResult.bkash_url, id: topupId, shopId, leaseId } }
        );
    } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
            throw new AppError('This bKash payment is already bound to another top-up', 409, 'PAYMENT_ID_REUSED');
        }
        throw error;
    }
    if (affectedRows(bindResult) !== 1) {
        throw new AppError('A bKash checkout is already in progress for this top-up', 409, 'PAYMENT_IN_PROGRESS');
    }

    logger.info('Top-up initiated', { topupId, packCode, shopId, bkashPaymentId: bkashResult.payment_id });

    return {
        topup_id: topupId,
        bkash_url: bkashResult.bkash_url,
        payment_id: bkashResult.payment_id,
        pack,
        invoice_number: invoiceNumber
    };
};

/**
 * Complete a top-up after BKash callback.
 * Verifies payment, credits conversations, generates invoice PDF.
 *
 * @param {string} shopId
 * @param {string} topupId
 * @param {string} bkashPaymentId
 * @returns {{ success, conversations_added, invoice_url }}
 */
const completeTopup = async (shopId, topupId, bkashPaymentId) => {
    const [rows] = await sequelize.query(
        `SELECT * FROM topup_transactions WHERE id=:id AND shop_id=:shopId`,
        { replacements: { id: topupId, shopId }, type: sequelize.QueryTypes.SELECT }
    );

    if (!rows) throw new AppError('Top-up transaction not found', 404);
    if (rows.status === 'completed') {
        return { success: true, already_completed: true, invoice_url: rows.invoice_pdf_url };
    }
    if (rows.status === 'failed') throw new AppError('Top-up payment was already marked failed', 400);
    if (!bkashPaymentId || rows.bkash_payment_id !== bkashPaymentId) {
        throw new AppError('Payment is not bound to this top-up transaction', 403);
    }

    // Verify BKash payment
    const verification = await bdPayment.verifyBkashPayment(bkashPaymentId);

    if (!verification.success || verification.status !== 'completed') {
        if (verification.status === 'failed') {
            await sequelize.query(
                `UPDATE topup_transactions
                    SET bkash_payment_id=NULL, bkash_url=NULL
                  WHERE id=:id AND shop_id=:shopId AND status='pending' AND bkash_payment_id=:paymentId`,
                { replacements: { id: topupId, shopId, paymentId: bkashPaymentId } },
            );
        }
        throw new AppError('BKash payment verification failed', 402);
    }

    const expectedAmount = normalizeAmountToMinorUnits(rows.amount_bdt);
    const providerAmount = normalizeAmountToMinorUnits(verification.amount);
    if (expectedAmount === null || providerAmount === null || expectedAmount !== providerAmount) {
        throw new AppError('Payment amount mismatch', 400);
    }
    if (verification.merchant_invoice
        && String(verification.merchant_invoice) !== String(rows.invoice_number)) {
        throw new AppError('Payment invoice mismatch', 400);
    }
    if (!verification.merchant_invoice || !verification.transaction_id
        || String(verification.currency || '').toUpperCase() !== 'BDT') {
        throw new AppError('Payment verification identity is incomplete', 400);
    }

    const trxId = verification.transaction_id;
    const pack = getTopupPack(rows.pack_code);
    const conversationsToAdd = rows.pack_conversations || pack?.conversations || 0;

    if (!(Number(conversationsToAdd) > 0)) {
        throw new AppError('Top-up credit amount is not valid', 400);
    }

    // Claim and credit in one database transaction. Gateway verification happens
    // before the claim, so a failed/aborted verification leaves the row pending
    // and retryable. The conditional update is the concurrency arbiter.
    try {
        await sequelize.transaction(async (transaction) => {
            const completeResult = await sequelize.query(
                `UPDATE topup_transactions
                    SET status='completed', bkash_trx_id=:trxId,
                        checkout_lease_id=NULL, checkout_lease_expires_at=NULL,
                        completed_at=${timestampSql()}
                  WHERE id=:id AND shop_id=:shopId AND status='pending' AND bkash_payment_id=:paymentId`,
                { replacements: { trxId, id: topupId, shopId, paymentId: bkashPaymentId }, transaction }
            );
            if (affectedRows(completeResult) !== 1) {
                const duplicate = new AppError('Top-up transaction was already handled', 409);
                duplicate.code = 'TOPUP_ALREADY_HANDLED';
                throw duplicate;
            }

            const creditResult = await sequelize.query(
                `UPDATE subscriptions
                    SET topup_balance = COALESCE(topup_balance, 0) + :add,
                        updated_at=${timestampSql()}
                  WHERE shop_id=:shopId`,
                { replacements: { add: conversationsToAdd, shopId }, transaction }
            );
            if (affectedRows(creditResult) !== 1) {
                throw new AppError('Subscription not found', 404);
            }

        });
    } catch (error) {
        if (error?.code === 'TOPUP_ALREADY_HANDLED') {
            return { success: true, already_completed: true, invoice_url: rows.invoice_pdf_url };
        }
        if (error?.name === 'SequelizeUniqueConstraintError') {
            throw new AppError('This bKash transaction is already bound to another top-up', 409, 'PAYMENT_ID_REUSED');
        }
        throw error;
    }

    // Generate invoice PDF
    let invoiceUrl = null;
    try {
        const sub = await Subscription.findOne({ where: { shop_id: shopId } });
        invoiceUrl = await invoiceService.generateTopupInvoice({
            topupId,
            invoiceNumber: rows.invoice_number,
            shopId,
            packCode: rows.pack_code,
            conversations: conversationsToAdd,
            amountBdt: rows.amount_bdt,
            bkashTrxId: trxId,
            shopName: sub?.shop_name || 'Unknown Shop'
        });
    } catch (invErr) {
        logger.error('Invoice generation failed (non-fatal)', { err: invErr.message });
    }

    await sequelize.query(
        `UPDATE topup_transactions SET invoice_pdf_url=:invoiceUrl WHERE id=:id AND shop_id=:shopId`,
        { replacements: { invoiceUrl, id: topupId, shopId } }
    ).catch((error) => logger.warn('Top-up invoice URL update failed (non-fatal)', { error: error.message }));

    recordFunnelEventSafe('topup_purchased', {
        shopId,
        metadata: { pack_code: rows.pack_code, conversations: conversationsToAdd },
        onceKey: `topup_purchased:${topupId}`,
    });

    logger.info('Top-up completed', { topupId, shopId, conversationsToAdd, trxId });

    return { success: true, conversations_added: conversationsToAdd, invoice_url: invoiceUrl };
};

/**
 * Get top-up history for a shop.
 */
const getTopupHistory = async (shopId, limit = 20, offset = 0) => {
    const rows = await sequelize.query(
        `SELECT id, pack_code, pack_conversations, amount_bdt, bkash_trx_id, status,
                invoice_number, invoice_pdf_url, created_at, completed_at
         FROM topup_transactions
         WHERE shop_id=:shopId
         ORDER BY created_at DESC
         LIMIT :limit OFFSET :offset`,
        { replacements: { shopId, limit, offset }, type: sequelize.QueryTypes.SELECT }
    );
    return rows;
};

module.exports = { getTopupPacks, initiateTopup, completeTopup, getTopupHistory };
