'use strict';

/**
 * Billing standing — the overdue-booking gate (ADR-0011 C5).
 *
 * The founder-approved overdue policy blocks *new* courier bookings and pauses
 * automated AI replies; the manual inbox and history stay readable and nothing
 * is ever deleted. This service is the booking half of that policy.
 *
 * Why invoice-based instead of subscription-based: an invoice becomes overdue
 * at its `due_date` (issue + contract `dueDays`). The failed-payment reconciler
 * suspends the subscription on its own schedule (daily run), so a gate that
 * waited for `status = 'suspended'` would keep accepting bookings for up to a
 * day after the bill lapsed. Reading the invoice directly makes the block
 * immediate and independent of reconciler timing.
 *
 * Tenant scoping is non-negotiable: every query filters by `shop_id`.
 * Fail closed: if standing cannot be proven healthy, the booking is refused.
 *
 * No PII is logged. Money is integer poisha only through the contract
 * formatters; this module defines no price of its own.
 */

const { Op } = require('sequelize');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    describeContract,
} = require('./commercial.contract');
const { RECURRING_INVOICE_TYPES } = require('../subscription/subscription.plans');
const { getOrigins, joinOrigin } = require('../../config/origins');

const logger = createLogger('BillingStanding');

/** Invoice states that represent an unpaid, still-collectable balance. */
const OVERDUE_STATUSES = Object.freeze(['pending', 'overdue']);

/** Merchant billing surface; the page that can settle an overdue invoice. */
const BILLING_PATH = '/subscription';
const OVERDUE_CLAIM_ID = 'billing.overdue_policy';

/**
 * Policy sentence derived from the frozen contract's `onOverdue` flags. A
 * contract change rewrites this copy without editing a merchant-facing string
 * here. It mirrors `claims.billing.overdue_policy.en`, which `assertBookingAllowed`
 * renders through the claim gate at throw time.
 */
const buildOverduePolicySentence = () => {
    const overdue = COMMERCIAL_CONTRACT.onOverdue;
    const paused = [];
    if (overdue.blockCourierBooking) paused.push('new courier bookings');
    if (overdue.pauseAutomatedAi) paused.push('automated AI replies');

    const parts = [];
    if (paused.length) {
        const verb = paused.length > 1 ? 'are' : 'is';
        parts.push(`${paused.join(' and ')} ${verb} paused until payment.`);
    } else {
        parts.push('This account has an overdue bill.');
    }

    if (overdue.keepInboxReadable && overdue.keepHistoryReadable) {
        parts.push('Your manual inbox and full history remain available.');
    } else {
        if (overdue.keepInboxReadable) parts.push('Your manual inbox remains readable.');
        if (overdue.keepHistoryReadable) parts.push('Your full history remains readable.');
    }
    if (overdue.deleteData === false) parts.push('No data is deleted.');
    const sentence = parts.join(' ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

const billingPayUrl = () => joinOrigin(getOrigins().app, BILLING_PATH);

/**
 * Does the shop carry at least one unpaid recurring invoice past its due date?
 *
 * Uses `Invoice.count` with `LIMIT`-free existence semantics (count is portable
 * across SQLite/Postgres and avoids dialect-specific `findOne` ordering). A
 * zero- or negative-amount invoice is never "overdue" — the reconciler cancels
 * those instead of dunning them.
 *
 * @param {string} shopId
 * @param {{now?: Date, transaction?: object|null}} [options]
 * @returns {Promise<boolean>}
 */
const hasOverdueBalance = async (shopId, options = {}) => {
    const { now = new Date(), transaction = null } = options;
    if (!shopId) {
        throw new AppError('Billing standing requires a shop', 400, 'BILLING_TENANT_REQUIRED');
    }

    // Lazy require so a minimal test harness that stubs `entities` without the
    // Invoice model fails closed with a clear error instead of a TypeError.
    const { Invoice } = require('../entities');
    if (!Invoice || typeof Invoice.count !== 'function') {
        throw new AppError('Billing standing model is unavailable', 503, 'BILLING_STANDING_UNAVAILABLE');
    }

    const overdueCount = await Invoice.count({
        where: {
            shop_id: shopId,
            invoice_type: { [Op.in]: [...RECURRING_INVOICE_TYPES] },
            status: { [Op.in]: [...OVERDUE_STATUSES] },
            due_date: { [Op.lt]: now },
            amount: { [Op.gt]: 0 },
        },
        ...(transaction ? { transaction } : {}),
    });

    return Number(overdueCount) > 0;
};

/**
 * Throws when the shop may not start a NEW courier booking.
 *
 * Callers run this INSIDE the booking claim transaction, after the
 * already-booked / committed-reconcile early returns. A parcel that is already
 * COMMITTED always reconciles (nothing deleted); only a fresh claim is refused.
 *
 * @param {string} shopId
 * @param {{now?: Date, transaction?: object|null}} [options]
 * @returns {Promise<true>}
 * @throws {AppError} 402 BILLING_OVERDUE_BOOKING_BLOCKED when a recurring
 *         invoice is past due; 503 BILLING_STANDING_UNAVAILABLE when standing
 *         cannot be evaluated (fail closed).
 */
const assertBookingAllowed = async (shopId, options = {}) => {
    const { now = new Date(), transaction = null } = options;

    let overdue;
    try {
        overdue = await hasOverdueBalance(shopId, { now, transaction });
    } catch (error) {
        if (error instanceof AppError) throw error;
        // Fail closed: an unreadable billing state is not a licence to book.
        logger.error('Billing standing check failed — blocking booking (fail closed)', {
            errorName: String(error?.name || 'Error'),
        });
        throw new AppError(
            'Billing standing could not be verified, so courier booking is blocked.',
            503,
            'BILLING_STANDING_UNAVAILABLE',
        );
    }

    if (!overdue) return true;

    const payUrl = billingPayUrl();

    // Render the frozen overdue-policy claim so the response carries the same
    // truth the merchant surfaces render. The claim's required evidence is the
    // contract itself, so a failure here is a gate bug, not merchant data; the
    // booking is still blocked.
    let claimTextKey = 'claims.billing.overdue_policy.en';
    try {
        const { renderClaim } = require('./claim-gate.service');
        const decision = renderClaim(OVERDUE_CLAIM_ID, { surface: 'invoice', locale: 'en' });
        claimTextKey = decision?.textKey || claimTextKey;
    } catch (error) {
        logger.warn('Overdue policy claim could not be rendered', {
            errorName: String(error?.name || 'Error'),
        });
    }

    throw new AppError(
        `${buildOverduePolicySentence()} ${describeContract('en')} Pay now: ${payUrl}`,
        402,
        'BILLING_OVERDUE_BOOKING_BLOCKED',
        {
            payUrl,
            claimId: OVERDUE_CLAIM_ID,
            claimTextKey,
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            dueDays: COMMERCIAL_CONTRACT.dueDays,
        },
    );
};

module.exports = {
    OVERDUE_STATUSES,
    OVERDUE_CLAIM_ID,
    BILLING_PATH,
    buildOverduePolicySentence,
    billingPayUrl,
    hasOverdueBalance,
    assertBookingAllowed,
};