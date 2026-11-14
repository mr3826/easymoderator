'use strict';

/**
 * Delivered-order billing service — the write and aggregation engine behind
 * ADR-0011. It records one terminal commercial outcome per order as a
 * `billing_lines` row and computes the monthly invoice from those rows.
 *
 * Design invariants:
 *  - One terminal outcome per order: DELIVERED is billable at the contract
 *    unit price; RETURNED/CANCELLED are explicit BDT 0 ("zero-rated") lines.
 *  - Idempotent by a deterministic sha256 key derived from
 *    (shop, order, line_kind), backed by a unique index. Replayed webhooks and
 *    catch-up runs never double-charge.
 *  - Reversal before invoicing mutates the billable row in place; reversal
 *    after invoicing is left to return.service's credit ledger (this service
 *    reports `reason: 'invoiced'` and never rewrites a settled document).
 *  - The cutover instant comes from DB state (`commercial_cutover_events`,
 *    written by migration 20261114_003). It is never hardcoded.
 *
 * Money is integer poisha. The legacy `invoices` columns are DECIMAL BDT, so
 * only the final persistence step converts (`minorToBdt`).
 */

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
} = require('./commercial.contract');
const { BillingLine, Order } = require('../entities');

const logger = createLogger('DeliveredOrderBilling');

const LINE_KIND = Object.freeze({ BILLABLE: 'billable', ZERO_RATED: 'zero_rated' });
const OUTCOME = Object.freeze({ DELIVERED: 'DELIVERED', RETURNED: 'RETURNED', CANCELLED: 'CANCELLED' });
const LINE_SOURCES = Object.freeze([
    'courier_webhook',
    'invoice_catchup',
    'ui_cancel',
    'return_approval',
    'migration_backfill',
]);

/** The state table migration 20261114_003 populates. Read-only here. */
const CUTOVER_STATE_TABLE = 'commercial_cutover_events';

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

/** Deterministic idempotency key for one order's terminal line kind. */
const billingIdempotencyKey = (shopId, orderId, lineKind) => (
    sha256Hex(`DELIVERED_ORDER_BILLING|${shopId}|${orderId}|${lineKind}`)
);

/** Normalize any timestamp-ish value to a `YYYY-MM-DD` UTC date string. */
const toDateOnly = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const toInt = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
};

/** Integer poisha -> legacy DECIMAL BDT value for the invoices table. */
const minorToBdt = (minor) => Number((toInt(minor) / 100).toFixed(2));

/** The frozen pricing rule: DELIVERED is billable; every other terminal outcome is BDT 0. */
const pricingForOutcome = (outcome) => {
    const normalized = String(outcome || '').toUpperCase();
    if (normalized === OUTCOME.DELIVERED) {
        return {
            lineKind: LINE_KIND.BILLABLE,
            outcome: OUTCOME.DELIVERED,
            unitPriceMinor: COMMERCIAL_CONTRACT.unitPriceMinor,
            amountMinor: COMMERCIAL_CONTRACT.unitPriceMinor,
        };
    }
    if (normalized === OUTCOME.RETURNED || normalized === OUTCOME.CANCELLED) {
        return {
            lineKind: LINE_KIND.ZERO_RATED,
            outcome: normalized,
            // The contracted unit price is kept for display; amount is 0 because
            // the outcome is explicitly zero-rated.
            unitPriceMinor: COMMERCIAL_CONTRACT.unitPriceMinor,
            amountMinor: 0,
        };
    }
    throw new AppError(
        `Unsupported billing outcome '${normalized}'. Expected DELIVERED, RETURNED or CANCELLED.`,
        400,
        'BILLING_OUTCOME_UNSUPPORTED',
    );
};

const parseMetadata = (value) => {
    if (!value) return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value) || {}; } catch (_) { return {}; }
    }
    return typeof value === 'object' ? value : {};
};

const requireTenant = (shopId, orderId) => {
    if (!shopId || !orderId) {
        throw new AppError('Billing requires shopId and orderId', 400, 'BILLING_TENANT_REQUIRED');
    }
};

/**
 * Find the recorded line for an order. The first recorded row is returned so a
 * caller sees the billable financial truth when both a billable and a later
 * zero-rated row exist (they normally do not — reversals mutate in place).
 */
const findLineForOrder = async ({ shopId, orderId } = {}, transaction = null) => {
    requireTenant(shopId, orderId);
    return BillingLine.findOne({
        where: { shop_id: shopId, order_id: orderId },
        order: [['created_at', 'ASC']],
        ...(transaction ? { transaction } : {}),
    });
};

/**
 * Record one terminal outcome. Idempotent: a replay returns the existing row.
 *
 * @param {{shopId:string, orderId:string, outcome:'DELIVERED'|'RETURNED'|'CANCELLED',
 *          provider?:string|null, occurredAt?:Date|string, source?:string}} payload
 * @param {object|null} transaction
 * @returns {Promise<{line: object, created: boolean}>}
 */
const recordOutcomeLine = async (payload = {}, transaction = null) => {
    const { shopId, orderId, outcome, provider = null, occurredAt, source = 'courier_webhook' } = payload;
    requireTenant(shopId, orderId);

    if (!LINE_SOURCES.includes(source)) {
        throw new AppError(`Unknown billing line source '${source}'`, 400, 'BILLING_SOURCE_UNSUPPORTED');
    }
    const pricing = pricingForOutcome(outcome);
    const occurred = toDateOnly(occurredAt || new Date());
    if (!occurred) {
        throw new AppError('Billing line requires a valid occurredAt', 400, 'BILLING_OCCURRED_AT_INVALID');
    }

    const idempotencyKey = billingIdempotencyKey(shopId, orderId, pricing.lineKind);
    const values = {
        shop_id: shopId,
        order_id: orderId,
        subscription_id: null,
        line_kind: pricing.lineKind,
        outcome: pricing.outcome,
        unit_price_minor: pricing.unitPriceMinor,
        amount_minor: pricing.amountMinor,
        currency: COMMERCIAL_CONTRACT.currency,
        contract_version: COMMERCIAL_CONTRACT_VERSION,
        idempotency_key: idempotencyKey,
        source,
        provider: provider ? String(provider).slice(0, 32) : null,
        occurred_at: occurred,
        invoice_id: null,
        metadata: {},
    };

    // First terminal outcome wins. If the order already carries a different
    // kind, reconcile instead of writing a second financial truth.
    const existingAnyKind = await BillingLine.findOne({
        where: { shop_id: shopId, order_id: orderId },
        order: [['created_at', 'ASC']],
        ...(transaction ? { transaction } : {}),
    });
    if (existingAnyKind) {
        if (existingAnyKind.line_kind === pricing.lineKind) {
            return { line: existingAnyKind, created: false };
        }
        if (existingAnyKind.line_kind === LINE_KIND.BILLABLE
            && pricing.lineKind === LINE_KIND.ZERO_RATED
            && existingAnyKind.invoice_id === null) {
            // A return/cancel arrived for a not-yet-invoiced billable row.
            const reversal = await reverseLineForReturn({ shopId, orderId }, transaction);
            if (reversal.reversed && reversal.line) {
                return { line: reversal.line, created: false, reversed: true };
            }
        }
        return { line: existingAnyKind, created: false };
    }

    try {
        const [line, created] = await BillingLine.findOrCreate({
            where: { idempotency_key: idempotencyKey },
            defaults: values,
            ...(transaction ? { transaction } : {}),
        });
        if (created) {
            logger.info('Billing line recorded', {
                lineKind: pricing.lineKind,
                outcome: pricing.outcome,
                source,
            });
        }
        return { line, created };
    } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
            const existing = await BillingLine.findOne({
                where: { shop_id: shopId, order_id: orderId, line_kind: pricing.lineKind },
                ...(transaction ? { transaction } : {}),
            });
            if (existing) return { line: existing, created: false };
        }
        throw error;
    }
};

/**
 * Reverse a delivered order before it has been invoiced.
 *
 * Pre-invoice: convert the billable row in place to an explicit zero-rated
 * RETURNED line (ADR-0011). Post-invoice: never rewrite a settled document —
 * report `reason: 'invoiced'` so the caller uses return.service's credit path.
 *
 * @returns {Promise<{reversed:boolean, reason?:string, line?:object, invoiceId?:string|null}>}
 */
const reverseLineForReturn = async ({ shopId, orderId } = {}, transaction = null) => {
    requireTenant(shopId, orderId);
    const line = await BillingLine.findOne({
        where: { shop_id: shopId, order_id: orderId, line_kind: LINE_KIND.BILLABLE },
        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
    });
    if (!line) return { reversed: false, reason: 'no_billable_line' };
    if (line.invoice_id) return { reversed: false, reason: 'invoiced', invoiceId: line.invoice_id };

    const metadata = {
        ...parseMetadata(line.metadata),
        reversedFrom: LINE_KIND.BILLABLE,
        reversedAt: new Date().toISOString(),
        originalSource: line.source,
    };
    const [affected] = await BillingLine.update({
        line_kind: LINE_KIND.ZERO_RATED,
        outcome: OUTCOME.RETURNED,
        amount_minor: 0,
        source: 'return_approval',
        metadata,
    }, {
        where: { id: line.id, shop_id: shopId, line_kind: LINE_KIND.BILLABLE },
        ...(transaction ? { transaction } : {}),
    });

    if (!affected) {
        const current = await BillingLine.findOne({
            where: { id: line.id },
            ...(transaction ? { transaction } : {}),
        });
        if (current?.invoice_id) {
            return { reversed: false, reason: 'invoiced', invoiceId: current.invoice_id };
        }
        return { reversed: false, reason: 'not_reversible' };
    }

    line.line_kind = LINE_KIND.ZERO_RATED;
    line.outcome = OUTCOME.RETURNED;
    line.amount_minor = 0;
    line.source = 'return_approval';
    line.metadata = metadata;
    logger.info('Billing line reversed before invoicing', { lineKind: LINE_KIND.ZERO_RATED });
    return { reversed: true, line, invoiceId: null };
};

/**
 * Backfill billing lines for orders that reached a terminal state while the
 * webhook line was missing (dropped callback, deploy gap).
 *
 * Never runs without a cutover instant: reconstructing history before the
 * recorded commercial start would invent charges that never existed.
 *
 * @param {{shopId:string, periodStart:Date|string, periodEnd:Date|string, cutoverAt:Date|string|null}} payload
 */
const catchUpLines = async ({ shopId, periodStart, periodEnd, cutoverAt } = {}, transaction = null) => {
    const result = { considered: 0, created: 0, skipped: 0 };
    if (!shopId) return result;

    const cutoverDate = cutoverAt ? new Date(cutoverAt) : null;
    const start = periodStart ? new Date(periodStart) : null;
    const end = periodEnd ? new Date(periodEnd) : null;
    if (!cutoverDate || Number.isNaN(cutoverDate.getTime())
        || !start || Number.isNaN(start.getTime())
        || !end || Number.isNaN(end.getTime())) {
        return result;
    }

    const from = new Date(Math.max(start.getTime(), cutoverDate.getTime()));
    const to = end;
    if (from.getTime() >= to.getTime()) return result;

    const attributes = ['id', 'order_status', 'delivered_at', 'updated_at', 'metadata'];
    const baseWhere = { shop_id: shopId };

    const deliveredOrders = await Order.findAll({
        where: {
            ...baseWhere,
            order_status: 'delivered',
            delivered_at: { [Op.gte]: from, [Op.lt]: to },
        },
        attributes,
        ...(transaction ? { transaction } : {}),
    });
    const cancelledOrders = await Order.findAll({
        where: {
            ...baseWhere,
            order_status: 'cancelled',
            [Op.or]: [
                { delivered_at: { [Op.gte]: from, [Op.lt]: to } },
                { delivered_at: null, updated_at: { [Op.gte]: from, [Op.lt]: to } },
            ],
        },
        attributes,
        ...(transaction ? { transaction } : {}),
    });

    const candidates = [
        ...deliveredOrders.map((order) => ({ order, outcome: null })),
        ...cancelledOrders.map((order) => ({ order, outcome: null })),
    ];
    result.considered = candidates.length;
    if (!candidates.length) return result;

    const orderIds = candidates.map(({ order }) => order.id);
    const existing = await BillingLine.findAll({
        where: { shop_id: shopId, order_id: { [Op.in]: orderIds } },
        attributes: ['order_id'],
        ...(transaction ? { transaction } : {}),
    });
    const recorded = new Set(existing.map((line) => String(line.order_id)));

    for (const candidate of candidates) {
        const { order } = candidate;
        if (recorded.has(String(order.id))) {
            result.skipped++;
            continue;
        }
        const metadata = parseMetadata(order.metadata);
        let outcome;
        if (order.order_status === 'delivered') {
            outcome = ['approved', 'refunded'].includes(metadata.returnStatus)
                ? OUTCOME.RETURNED
                : OUTCOME.DELIVERED;
        } else {
            // A cancelled order that carries a delivered_at was delivered and
            // later returned; one without it was cancelled before delivery.
            outcome = order.delivered_at ? OUTCOME.RETURNED : OUTCOME.CANCELLED;
        }
        const occurredAt = order.delivered_at || order.updated_at || new Date();
        const written = await recordOutcomeLine({
            shopId,
            orderId: order.id,
            outcome,
            provider: null,
            occurredAt,
            source: 'invoice_catchup',
        }, transaction);
        if (written.created) result.created++;
        else result.skipped++;
        recorded.add(String(order.id));
    }

    return result;
};

/**
 * All un-invoiced lines for a shop in [periodStart, periodEnd), optionally
 * floored at the cutover instant.
 */
const aggregateUninvoicedLines = async ({ shopId, periodStart, periodEnd, cutoverAt } = {}, transaction = null) => {
    if (!shopId) return [];
    const start = periodStart ? new Date(periodStart) : null;
    const end = periodEnd ? new Date(periodEnd) : null;
    if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) return [];

    const lower = cutoverAt ? new Date(Math.max(start.getTime(), new Date(cutoverAt).getTime())) : start;
    const occurredAt = { [Op.gte]: toDateOnly(lower), [Op.lt]: toDateOnly(end) };

    return BillingLine.findAll({
        where: {
            shop_id: shopId,
            invoice_id: null,
            occurred_at: occurredAt,
        },
        order: [['occurred_at', 'ASC'], ['created_at', 'ASC']],
        ...(transaction ? { transaction } : {}),
    });
};

const normalizeLineForInvoice = (line) => ({
    orderId: line.order_id ?? line.orderId ?? null,
    kind: String(line.line_kind ?? line.lineKind ?? '').toLowerCase(),
    outcome: String(line.outcome ?? '').toUpperCase(),
    amountMinor: toInt(line.amount_minor ?? line.amountMinor),
    occurredAt: toDateOnly(line.occurred_at ?? line.occurredAt),
});

/**
 * PURE invoice derivation from billing lines. No DB, no clock.
 *
 * @param {Array<object>} lines billing line rows (sequelize or plain)
 * @param {number} creditsMinor pending credit already expressed in poisha
 * @returns {{grossMinor:number, creditMinor:number, netMinor:number,
 *            deliveredCount:number, zeroRatedCount:number,
 *            lines:Array<{orderId:string,kind:string,outcome:string,
 *                         amountMinor:number,occurredAt:string|null}>}}
 */
const computeInvoiceFromLines = (lines = [], creditsMinor = 0) => {
    const normalized = (Array.isArray(lines) ? lines : []).map(normalizeLineForInvoice);
    let grossMinor = 0;
    let deliveredCount = 0;
    let zeroRatedCount = 0;

    for (const line of normalized) {
        grossMinor += line.amountMinor;
        if (line.kind === LINE_KIND.BILLABLE) deliveredCount++;
        else zeroRatedCount++;
    }

    const creditMinor = Math.max(0, toInt(creditsMinor));
    return {
        grossMinor,
        creditMinor,
        netMinor: Math.max(0, grossMinor - creditMinor),
        deliveredCount,
        zeroRatedCount,
        lines: normalized,
    };
};

// ── Cutover state ────────────────────────────────────────────────────────────
// `undefined` means "read the DB"; `null`/Date is an explicit test override.
let cutoverOverride;

const normalizeCutover = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The persisted commercial cutover instant.
 *
 * Reads the newest `cutover_at` from `commercial_cutover_events` (created and
 * populated by migration 20261114_003). Returns null when the table or row is
 * absent so callers can fail safe. Pass `{ loader }` to inject in unit tests.
 *
 * @param {{transaction?:object, loader?:Function}} [options]
 * @returns {Promise<Date|null>}
 */
const getCommercialCutoverAt = async ({ transaction = null, loader = null } = {}) => {
    if (typeof loader === 'function') return normalizeCutover(await loader());
    if (cutoverOverride !== undefined) return cutoverOverride;

    try {
        const { sequelize } = require('../../utils/database/database-setup');
        const [rows] = await sequelize.query(
            `SELECT cutover_at FROM ${CUTOVER_STATE_TABLE} ORDER BY cutover_at DESC LIMIT 1`,
            transaction ? { transaction } : {},
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return normalizeCutover(rows[0].cutover_at);
    } catch (error) {
        // Phase 3 migration may not have run yet, or a minimal database lacks
        // the state table. Absence is a valid state, not an error.
        logger.warn('Commercial cutover state unavailable', { errorName: String(error?.name || 'Error') });
        return null;
    }
};

const __setCutoverAtForTests = (value) => {
    cutoverOverride = value === null ? null : normalizeCutover(value);
};

const __resetForTests = () => {
    cutoverOverride = undefined;
};

module.exports = {
    LINE_KIND,
    OUTCOME,
    LINE_SOURCES,
    CUTOVER_STATE_TABLE,
    billingIdempotencyKey,
    toDateOnly,
    minorToBdt,
    pricingForOutcome,
    findLineForOrder,
    recordOutcomeLine,
    reverseLineForReturn,
    catchUpLines,
    aggregateUninvoicedLines,
    computeInvoiceFromLines,
    getCommercialCutoverAt,
    __setCutoverAtForTests,
    __resetForTests,
};