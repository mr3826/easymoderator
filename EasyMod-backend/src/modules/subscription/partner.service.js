'use strict';

/**
 * Partner Service — RETIRED (ADR-0011).
 *
 * The tiered Partner programme (apply → approve → per-band billing) is
 * superseded by the single delivered-order model. Qualification thresholds and
 * plan switching are gone. The application table is preserved for historical
 * reads; new applications and approvals are refused with HTTP 410 Gone.
 *
 * The month-end charge itself no longer lives here: invoice-generation now
 * aggregates `billing_lines` (see modules/commercial/delivered-order-billing).
 */

const { PartnerApplication, Order } = require('../entities');
const { Op } = require('sequelize');
const { AppError } = require('../../utils/AppError');

const RETIRED_CODE = 'PARTNER_PROGRAMME_RETIRED';
const EXPLANATION = 'The Partner programme is retired. All shops are billed per delivered order.';

/**
 * Historical read: delivered orders in the rolling window. Kept because audit
 * exports and old application rows still reference it. No qualification rule
 * is applied anywhere.
 */
const countRecentDeliveredOrders = async (shopId, days = 30) => {
    if (!shopId) return 0;
    const windowDays = Number.isFinite(Number(days)) ? Math.max(0, Number(days)) : 30;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    return Order.count({
        where: {
            shop_id: shopId,
            order_status: 'delivered',
            delivered_at: { [Op.gte]: since }
        }
    });
};

/** Retired: partner applications are no longer accepted. */
const applyForPartner = async () => {
    throw new AppError(EXPLANATION, 410, RETIRED_CODE);
};

/** Retired: no shop is ever switched to a Partner plan. */
const approvePartner = async () => {
    throw new AppError(EXPLANATION, 410, RETIRED_CODE);
};

/** Historical read (admin): list preserved applications, newest first. */
const listApplications = async ({ status } = {}) => {
    const where = {};
    if (status) where.status = status;
    return PartnerApplication.findAll({ where, order: [['created_at', 'DESC']] });
};

module.exports = {
    applyForPartner,
    approvePartner,
    listApplications,
    countRecentDeliveredOrders,
    RETIRED_CODE,
};