const subscriptionService = require('./subscription.service');
const { validationResult } = require('express-validator');
const { AppError } = require('../../utils/AppError');
const { Shop } = require('../entities');
const commercialQuery = require('../commercial/commercial-query.service');
const {
    COMMERCIAL_CONTRACT_VERSION,
    formatBdt,
} = require('../commercial/commercial.contract');
const { InvoiceType } = require('./subscription.plans');

/**
 * Invoice money columns are legacy DECIMAL BDT; billing lines are integer
 * poisha. Both are rendered through the contract formatter so the invoice
 * never invents a price format.
 */
const bdtFromDecimal = (value) => formatBdt(Math.round((Number(value) || 0) * 100));

const parseInvoiceMetadata = (value) => {
    if (!value) return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value) || {}; } catch (_) { return {}; }
    }
    return typeof value === 'object' ? value : {};
};

/**
 * Billing lines for a delivered-order invoice. The invoice has already been
 * tenant-checked by getInvoiceById, so a query failure degrades to the invoice
 * metadata derivation instead of failing the printable document.
 */
const loadBillingLines = async (shopId, invoice) => {
    try {
        return await commercialQuery.listBillingLines({ shopId, invoiceId: invoice.id });
    } catch (_) {
        return [];
    }
};

const normalizeInvoiceLine = (line) => ({
    orderId: line.orderId ?? line.order_id ?? null,
    kind: String(line.lineKind ?? line.kind ?? line.line_kind ?? '').toLowerCase(),
    outcome: String(line.outcome || '').toUpperCase(),
    amountMinor: Number(line.amountMinor ?? line.amount_minor ?? 0) || 0,
});

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Get subscription details
 */
const getSubscription = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const data = await subscriptionService.getSubscription(shopId, req.user.userId);

        res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update subscription plan
 */
const updatePlan = async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new AppError(errors.array()[0].msg, 400);
        }

        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const subscription = await subscriptionService.updatePlan(
            shopId,
            req.user.userId,
            req.body
        );

        res.status(200).json({
            success: true,
            message: 'Subscription plan updated successfully',
            data: subscription
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get invoices
 */
const getInvoices = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const invoices = await subscriptionService.getInvoices(shopId, req.user.userId);

        res.status(200).json({
            success: true,
            data: invoices
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get invoice by ID
 */
const getInvoiceById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const { invoiceId } = req.params;

        const invoice = await subscriptionService.getInvoiceById(
            invoiceId,
            shopId,
            req.user.userId
        );

        res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Check rate limit
 */
const checkRateLimit = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const { customer_id } = req.body;
        if (!customer_id) {
            throw new AppError('customer_id is required', 400);
        }

        const result = await subscriptionService.checkRateLimit(shopId, req.user.userId, customer_id);

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Increment rate limit counter
 */
const incrementRateLimit = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            throw new AppError('No shop selected. Please login again.', 400);
        }

        const { customer_id } = req.body;
        if (!customer_id) {
            throw new AppError('customer_id is required', 400);
        }

        const result = await subscriptionService.incrementRateLimit(shopId, req.user.userId, customer_id);

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

/**
 * Return an HTML invoice page suitable for browser printing / Save-as-PDF.
 * No external PDF library required — the browser handles rendering.
 */
const getInvoicePdf = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) throw new AppError('No shop selected.', 400);

        const { invoiceId } = req.params;
        const invoice = await subscriptionService.getInvoiceById(invoiceId, shopId, userId);
        const shop = await Shop.findOne({ where: { id: shopId }, attributes: ['name', 'email'] });

        const invoiceDate = new Date(invoice.created_at).toLocaleDateString('en-BD', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        const dueDate = invoice.due_date
            ? new Date(invoice.due_date).toLocaleDateString('en-BD', { day: 'numeric', month: 'long', year: 'numeric' })
            : '—';
        const paidDate = invoice.paid_at
            ? new Date(invoice.paid_at).toLocaleDateString('en-BD', { day: 'numeric', month: 'long', year: 'numeric' })
            : null;

        const statusColor = invoice.status === 'paid' ? '#15803d' : invoice.status === 'pending' ? '#b45309' : '#dc2626';
        const invoiceMetadata = parseInvoiceMetadata(invoice.metadata);
        const isDeliveredOrder = invoice.invoice_type === InvoiceType.DELIVERED_ORDER;

        // Historical pre-cutover Partner invoice: keep its recorded derivation
        // visible (the numbers were actually sold under the retired bands), but
        // label it as historical so it can never read as current pricing.
        const hasPartnerDerivation = invoice.invoice_type === 'partner_per_order'
            || invoiceMetadata.delivered_orders !== undefined;
        const partnerDerivation = hasPartnerDerivation ? `
  <div style="margin-bottom:24px;padding:16px;border:1px solid #e5e7eb;border-radius:8px">
    <div class="label">Historical Partner delivery calculation</div>
    <div class="value">Delivered orders: ${escapeHtml(invoiceMetadata.delivered_orders ?? invoiceMetadata.deliveredOrders ?? 0)}</div>
    <div class="value">Historical rate tier: ${escapeHtml(invoiceMetadata.rate_band ?? '—')}</div>
    <div class="value">Recorded rate: ৳${escapeHtml(invoiceMetadata.rate_bdt ?? invoiceMetadata.partnerRateBdt ?? 0)} per delivered order</div>
    ${Number(invoiceMetadata.adjustment_credit || 0) > 0 ? `<div class="value">Return credits: -৳${escapeHtml(invoiceMetadata.adjustment_credit)}</div>` : ''}
     <div class="value" style="font-weight:600">Recorded Partner fee: ৳${escapeHtml(invoiceMetadata.computed_total ?? invoiceMetadata.partnerCharge ?? 0)}</div>
   </div>` : '';
        const usageChargeLabel = hasPartnerDerivation ? 'Historical delivered-order charges' : 'Usage charges';

        // ADR-0011: a delivered-order invoice is a line-item document. Render
        // every terminal outcome explicitly, including BDT 0 RETURNED/CANCELLED
        // lines, then the reversal credit and the net total.
        const billingLines = isDeliveredOrder
            ? (await loadBillingLines(shopId, invoice)).map(normalizeInvoiceLine)
            : [];
        const metadataLines = Array.isArray(invoiceMetadata.lines)
            ? invoiceMetadata.lines.map(normalizeInvoiceLine)
            : [];
        const invoiceLines = billingLines.length ? billingLines : metadataLines;
        const creditMinor = Math.max(0, Number(invoiceMetadata.creditMinor) || 0);
        const lineRows = invoiceLines.map((line) => {
            const outcome = line.outcome || 'UNRECORDED';
            const amount = line.kind === 'zero_rated' || line.amountMinor === 0
                ? `${formatBdt(0)} (zero-rated)`
                : formatBdt(line.amountMinor);
            const orderRef = line.orderId ? String(line.orderId).slice(0, 8) : '—';
            return `
      <tr>
        <td>${escapeHtml(outcome)} order</td>
        <td style="color:#6b7280">${escapeHtml(orderRef)}</td>
        <td style="text-align:right">${escapeHtml(amount)}</td>
      </tr>`;
        }).join('');
        const creditRow = creditMinor > 0 ? `
      <tr>
        <td>Reversal credit</td>
        <td style="color:#6b7280">Settled-invoice adjustment</td>
        <td style="text-align:right">-${formatBdt(creditMinor)}</td>
      </tr>` : '';
        const invoiceContractVersion = invoiceMetadata.contractVersion || COMMERCIAL_CONTRACT_VERSION;
        const contractFooter = (isDeliveredOrder || invoiceMetadata.contractVersion)
            ? `Commercial contract v${escapeHtml(invoiceContractVersion)}`
            : 'Historical invoice — terms recorded at issue';
        const totalDisplay = isDeliveredOrder && Number.isFinite(Number(invoiceMetadata.netMinor))
            ? formatBdt(Number(invoiceMetadata.netMinor))
            : bdtFromDecimal(invoice.amount);

        const invoiceTable = isDeliveredOrder ? `
  <table>
    <thead>
      <tr>
        <th>Order outcome</th>
        <th>Order</th>
        <th style="text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows || `
      <tr class="amount-row">
        <td>No terminal outcomes in this period</td>
        <td style="color:#6b7280">${escapeHtml(invoice.billing_period || '—')}</td>
        <td style="text-align:right">${formatBdt(0)}</td>
      </tr>`}
      ${creditRow}
      <tr class="total-row">
        <td colspan="2">Total Due</td>
        <td style="text-align:right">${totalDisplay}</td>
      </tr>
    </tbody>
  </table>` : `
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th>Period</th>
        <th style="text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr class="amount-row">
        <td>${escapeHtml(invoice.invoice_type || 'Invoice')}</td>
        <td style="color:#6b7280">${escapeHtml(invoice.billing_period || '—')}</td>
        <td style="text-align:right">${bdtFromDecimal(invoice.base_amount || invoice.amount)}</td>
      </tr>
      ${parseFloat(invoice.extra_usage_amount || 0) > 0 ? `
      <tr><td>${usageChargeLabel}</td><td></td><td style="text-align:right">${bdtFromDecimal(invoice.extra_usage_amount)}</td></tr>` : ''}
      ${parseFloat(invoice.addon_amount || 0) > 0 ? `
      <tr><td>Add-ons</td><td></td><td style="text-align:right">${bdtFromDecimal(invoice.addon_amount)}</td></tr>` : ''}
      <tr class="total-row">
        <td colspan="2">Total Due</td>
        <td style="text-align:right">${totalDisplay}</td>
      </tr>
    </tbody>
  </table>`;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Invoice ${invoice.invoice_number}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; background: #fff; padding: 40px; max-width: 720px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
    .brand { font-size: 22px; font-weight: 700; color: #2563eb; }
    .brand span { font-size: 12px; display: block; color: #6b7280; font-weight: 400; margin-top: 2px; }
    .invoice-meta { text-align: right; }
    .invoice-meta h1 { font-size: 28px; font-weight: 800; color: #111827; }
    .status-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: white; background: ${statusColor}; margin-top: 6px; text-transform: uppercase; }
    .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .value { font-size: 14px; color: #111827; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; }
    td { padding: 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
    .amount-row td { font-weight: 600; }
    .total-row { background: #f9fafb; }
    .total-row td { font-size: 16px; font-weight: 700; padding: 16px 12px; }
    .footer { font-size: 12px; color: #9ca3af; margin-top: 40px; text-align: center; }
    @media print { body { padding: 20px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">EasyModerator<span>Messenger Sales Assistant</span></div>
    <div class="invoice-meta">
       <h1>INVOICE</h1>
       <div style="font-size:14px;color:#6b7280;margin-top:4px">${escapeHtml(invoice.invoice_number)}</div>
       <div class="status-badge">${escapeHtml(invoice.status)}</div>
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="label">Billed To</div>
       <div class="value" style="font-weight:600">${escapeHtml(shop?.name || 'Shop')}</div>
       ${shop?.email ? `<div class="value" style="color:#6b7280">${escapeHtml(shop.email)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div class="label">Invoice Date</div>
      <div class="value">${invoiceDate}</div>
      <div class="label" style="margin-top:12px">Due Date</div>
      <div class="value">${dueDate}</div>
      ${paidDate ? `<div class="label" style="margin-top:12px">Paid On</div><div class="value" style="color:#15803d;font-weight:600">${paidDate}</div>` : ''}
    </div>
  </div>

  <hr class="divider">

  ${invoiceTable}

  ${partnerDerivation}
  ${invoice.notes ? `<div style="font-size:13px;color:#6b7280;margin-bottom:24px"><strong>Notes:</strong> ${escapeHtml(invoice.notes)}</div>` : ''}

  <hr class="divider">
  <div class="footer">EasyModerator &bull; easymod.tech &bull; This is a computer-generated invoice.<br>${contractFooter}</div>

  <script>
    // Auto-open print dialog when opened in a new tab
    window.onload = function() { window.print(); };
  </script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoice_number}.html"`);
        res.send(html);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getSubscription,
    updatePlan,
    getInvoices,
    getInvoiceById,
    checkRateLimit,
    incrementRateLimit,
    getInvoicePdf
};
