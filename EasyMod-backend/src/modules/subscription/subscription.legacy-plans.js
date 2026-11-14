'use strict';

/**
 * Retired commercial catalog — HISTORICAL REFERENCE ONLY.
 *
 * ADR-0011 supersedes the 2026-11-01 SHURU / GROWTH / PARTNER ledger. Nothing
 * here may be rendered or offered to a merchant: display names and public
 * prices were deliberately removed. Only the stable CODES and NUMERIC values
 * survive, because historical invoices and already-created top-up transactions
 * must still resolve at the rate and quantity that were actually sold.
 *
 * Consumers:
 *  - return.service: legacy progressive Partner rate for pre-cutover invoices.
 *  - topup.service: resolves a historical pack that already has a payment.
 *
 * Do not import this module from any merchant-facing surface.
 */

/** Retired Partner flat per-delivered-order bands (BDT). */
const PARTNER_ORDER_TIERS = Object.freeze([
    { minOrders: 300, maxOrders: 999, rateBdt: 15 },
    { minOrders: 1000, maxOrders: 2999, rateBdt: 12 },
    { minOrders: 3000, maxOrders: null, rateBdt: 10 },
]);

/**
 * Retired conversation top-up packs. Codes and numeric terms only; the public
 * catalog is gone and top-up purchase is retired to HTTP 410.
 */
const TOPUP_PACKS = Object.freeze({
    PACK_100: Object.freeze({ code: 'PACK_100', conversations: 100, priceBdt: 250 }),
    PACK_300: Object.freeze({ code: 'PACK_300', conversations: 300, priceBdt: 500 }),
    PACK_700: Object.freeze({ code: 'PACK_700', conversations: 700, priceBdt: 1000 }),
});

/** Older still-active codes kept resolvable for in-flight transactions. */
const LEGACY_TOPUP_PACKS = Object.freeze({
    TOPUP_100: Object.freeze({ code: 'TOPUP_100', conversations: 100, priceBdt: 150 }),
    TOPUP_250: Object.freeze({ code: 'TOPUP_250', conversations: 250, priceBdt: 350 }),
    TOPUP_500: Object.freeze({ code: 'TOPUP_500', conversations: 500, priceBdt: 650 }),
    TOPUP_1000: Object.freeze({ code: 'TOPUP_1000', conversations: 1000, priceBdt: 1200 }),
});

/** Historical plan codes. Normalized to MERCHANT by subscription.plans. */
const LEGACY_PLAN_CODES = Object.freeze(['SHURU', 'GROWTH', 'PARTNER']);

const calculatePartnerCharge = (deliveredOrders) => {
    const delivered = Math.max(0, Number(deliveredOrders) || 0);
    const tier = PARTNER_ORDER_TIERS.find(({ minOrders, maxOrders }) => (
        delivered >= minOrders && (maxOrders === null || delivered <= maxOrders)
    ));
    return tier ? delivered * tier.rateBdt : 0;
};

const getPartnerOrderTier = (deliveredOrders) => {
    const delivered = Math.max(0, Number(deliveredOrders) || 0);
    return PARTNER_ORDER_TIERS.find(({ minOrders, maxOrders }) => (
        delivered >= minOrders && (maxOrders === null || delivered <= maxOrders)
    )) || null;
};

const getTopupPack = (packCode) => TOPUP_PACKS[packCode] || LEGACY_TOPUP_PACKS[packCode] || null;

module.exports = {
    PARTNER_ORDER_TIERS,
    TOPUP_PACKS,
    LEGACY_TOPUP_PACKS,
    LEGACY_PLAN_CODES,
    calculatePartnerCharge,
    getPartnerOrderTier,
    getTopupPack,
};