'use strict';

/**
 * Commercial read queries for the authenticated merchant API.
 *
 * Billing lines are created by the Phase-3 billing engine, so the entity is
 * resolved defensively: the unit lane must be able to load this module and the
 * controller before the table/model exists. A missing model is a typed 503,
 * never a crash at require time.
 *
 * Tenant rule: every read is scoped by the JWT-derived shopId. A line or
 * invoice belonging to another shop is a 403, never an empty 200 (that would
 * leak existence) and never a cross-tenant read.
 */

const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger('CommercialQuery');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeRequire(resolve) {
    try {
        return resolve() || null;
    } catch (_) {
        return null;
    }
}

/** BillingLine model, once Agent B's billing engine lands it. */
function getBillingLineModel() {
    const fromRegistry = safeRequire(() => require('../entities').BillingLine);
    if (fromRegistry) return fromRegistry;
    // Same-directory entity module is the Phase-3 home; keep the fallback for
    // fixtures that stub the entities registry.
    return safeRequire(() => require('./billing-line.entity'));
}

/** Any invoice model that can prove invoice ownership. */
function getInvoiceModel() {
    return safeRequire(() => {
        const entities = require('../entities');
        return entities.BillingInvoice
            || entities.Invoice
            || entities.OrderInvoice
            || null;
    });
}

const asIsoString = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

/**
 * Service-boundary mapping. Money is integer poisha plus ISO currency
 * (AGENT_CONTRACTS §1); identifiers are opaque strings; camelCase only.
 */
function toBillingLine(row) {
    const amountMinor = Number(firstDefined(row.amount_minor, row.amountMinor, 0));
    const unitPriceMinor = Number(firstDefined(row.unit_price_minor, row.unitPriceMinor, 0));
    return {
        id: row.id,
        invoiceId: row.invoice_id ?? row.invoiceId ?? null,
        orderId: row.order_id ?? row.orderId ?? null,
        lineKind: row.line_kind ?? row.lineKind ?? null,
        outcome: row.outcome ?? null,
        unitPriceMinor: Number.isFinite(unitPriceMinor) ? Math.trunc(unitPriceMinor) : 0,
        amountMinor: Number.isFinite(amountMinor) ? Math.trunc(amountMinor) : 0,
        currency: row.currency || 'BDT',
        contractVersion: row.contract_version ?? row.contractVersion ?? null,
        createdAt: asIsoString(row.created_at ?? row.createdAt),
    };
}

/**
 * List the billing lines of one invoice for the authenticated shop.
 *
 * @param {{shopId: string, invoiceId: string}} params
 * @returns {Promise<Array<object>>} camelCase billing lines
 */
async function listBillingLines({ shopId, invoiceId } = {}) {
    if (!shopId) {
        throw new AppError('Shop context is required', 400, 'SHOP_CONTEXT_REQUIRED');
    }
    if (typeof invoiceId !== 'string' || !UUID_RE.test(invoiceId)) {
        throw new AppError('invoiceId must be a UUID', 400, 'INVALID_INVOICE_ID');
    }

    const BillingLine = getBillingLineModel();
    if (!BillingLine || typeof BillingLine.findAll !== 'function') {
        throw new AppError(
            'Billing lines are not available yet',
            503,
            'BILLING_LINES_UNAVAILABLE',
        );
    }

    const rows = await BillingLine.findAll({ where: { invoice_id: invoiceId } });

    if (!Array.isArray(rows) || rows.length === 0) {
        // No lines at all: prove ownership through the invoice before answering
        // with an empty list, so a foreign invoice id is indistinguishable from
        // inaccessible rather than merely empty.
        const Invoice = getInvoiceModel();
        if (Invoice && typeof Invoice.findByPk === 'function') {
            let invoice = null;
            try {
                invoice = await Invoice.findByPk(invoiceId);
            } catch (error) {
                logger.warn('Commercial invoice ownership lookup failed', { error: error.message });
            }
            if (invoice) {
                const invoiceShopId = invoice.shop_id ?? invoice.shopId ?? null;
                if (invoiceShopId && String(invoiceShopId) !== String(shopId)) {
                    throw new AppError(
                        'Invoice does not belong to this shop',
                        403,
                        'INVOICE_FORBIDDEN',
                    );
                }
            }
        }
        return [];
    }

    const foreign = rows.find((row) => {
        const rowShopId = row.shop_id ?? row.shopId ?? null;
        return rowShopId && String(rowShopId) !== String(shopId);
    });
    if (foreign) {
        throw new AppError('Invoice does not belong to this shop', 403, 'INVOICE_FORBIDDEN');
    }

    return rows.map(toBillingLine);
}

module.exports = {
    UUID_RE,
    toBillingLine,
    listBillingLines,
};