'use strict';

/**
 * Billing failure / payment reminder email template.
 *
 * ADR-0011: the only merchant billing model is the delivered-order contract, so
 * the copy, currency and overdue policy are derived from
 * `modules/commercial/commercial.contract.js`. The overdue-policy paragraph is
 * additionally gated by the claim registry (`billing.overdue_policy` on the
 * `email` surface) so a surface that cannot prove the policy renders nothing
 * rather than a promise.
 *
 * @param {Object} shop    - Shop object with name, email
 * @param {Object} invoice - Invoice with id/invoice_number, amount (BDT), due_date, payment_link
 * @param {{locale?: 'en'|'bn'}} [options]
 * @returns {{ subject: string, html: string, text: string }}
 */

const {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
  formatBdt,
  formatBdtBn,
  describeContract,
} = require('../../modules/commercial/commercial.contract');
const claimGate = require('../../modules/commercial/claim-gate.service');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const overduePolicySentence = (locale) => {
  const overdue = COMMERCIAL_CONTRACT.onOverdue;
  const blocksWork = overdue.blockCourierBooking && overdue.pauseAutomatedAi;
  if (locale === 'en') {
    return blocksWork
      ? 'Overdue billing blocks new courier bookings and pauses automated AI replies. Your inbox and history stay readable, and nothing is deleted.'
      : 'Your inbox and history stay readable, and nothing is deleted.';
  }
  return blocksWork
    ? 'বিল বকেয়া থাকলে নতুন কুরিয়ার বুকিং এবং স্বয়ংক্রিয় AI উত্তর বন্ধ থাকবে। আপনার ইনবক্স ও ইতিহাস পড়া যাবে, কোনো ডেটা মুছে ফেলা হবে না।'
    : 'আপনার ইনবক্স ও ইতিহাস পড়া যাবে, কোনো ডেটা মুছে ফেলা হবে না।';
};

function billingFailureEmail(shop, invoice, { locale = 'bn' } = {}) {
  const bn = locale !== 'en';
  const format = bn ? formatBdtBn : formatBdt;
  const amountMinor = Math.round((Number(invoice.amount) || 0) * 100);
  const amountDisplay = format(amountMinor);
  const invoiceRef = invoice.invoice_number || invoice.id || '—';
  const dueDate = invoice.due_date
    ? new Date(invoice.due_date).toLocaleDateString(bn ? 'bn-BD' : 'en-BD')
    : (bn ? 'অবিলম্বে' : 'Immediately');
  const contractDescription = describeContract(bn ? 'bn' : 'en');

  const overdueDecision = claimGate.renderClaim('billing.overdue_policy', {
    surface: 'email',
    locale: bn ? 'bn' : 'en',
    format: 'html',
  });
  const showOverduePolicy = overdueDecision.render !== 'none';

  const subject = bn
    ? 'বিল পেমেন্ট ব্যর্থ হয়েছে — অ্যাকশন প্রয়োজন | EasyModerator'
    : 'Billing payment failed — action needed | EasyModerator';

  const html = `<!DOCTYPE html>
<html lang="${bn ? 'bn' : 'en'}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
        <tr>
          <td style="background:#dc2626;padding:24px 32px;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">EasyModerator ⚠️</h1>
            <p style="margin:4px 0 0;color:#fecaca;font-size:13px;">${bn ? 'বিল পেমেন্ট ব্যর্থ হয়েছে' : 'Billing payment failed'}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <h2 style="margin:0 0 12px;color:#111;font-size:17px;">
              ${escapeHtml(shop?.name || (bn ? 'প্রিয় ব্যবহারকারী' : 'Hello'))}, ${bn ? 'আপনার ডেলিভারি-ভিত্তিক বিলের পেমেন্ট সম্পন্ন হয়নি' : 'your delivered-order invoice could not be paid'}
            </h2>
            <p style="color:#555;font-size:13px;line-height:1.6;">
              ${escapeHtml(contractDescription)}
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#fef2f2;border-radius:8px;padding:16px;border:1px solid #fecaca;">
              <tr>
                <td style="color:#991b1b;font-size:13px;padding:4px 0;">${bn ? 'ইনভয়েস নম্বর' : 'Invoice number'}</td>
                <td style="color:#991b1b;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(invoiceRef)}</td>
              </tr>
              <tr>
                <td style="color:#991b1b;font-size:13px;padding:4px 0;">${bn ? 'বকেয়া পরিমাণ' : 'Amount due'}</td>
                <td style="color:#dc2626;font-size:16px;font-weight:800;text-align:right;">${escapeHtml(amountDisplay)}</td>
              </tr>
              <tr>
                <td style="color:#991b1b;font-size:13px;padding:4px 0;">${bn ? 'শেষ তারিখ' : 'Due date'}</td>
                <td style="color:#991b1b;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(dueDate)}</td>
              </tr>
            </table>

            ${invoice.payment_link ? `
            <div style="text-align:center;margin:24px 0;">
              <a href="${escapeHtml(invoice.payment_link)}"
                 style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;
                        padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
                ${bn ? 'এখনই পেমেন্ট করুন' : 'Pay now'}
              </a>
            </div>` : ''}

            ${showOverduePolicy ? `<p style="color:#888;font-size:12px;line-height:1.6;margin-top:20px;">
              ${escapeHtml(overduePolicySentence(bn ? 'bn' : 'en'))}
            </p>` : ''}
            <p style="color:#888;font-size:12px;line-height:1.6;">
              ${bn ? 'সাহায্যের জন্য' : 'For help'} <a href="mailto:support@easymod.tech" style="color:#dc2626;">support@easymod.tech</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e4e4e7;">
            <p style="margin:0;color:#aaa;font-size:11px;text-align:center;">
              © 2026 EasyModerator — Messenger sales and order automation<br>
              Commercial contract v${escapeHtml(COMMERCIAL_CONTRACT_VERSION)}
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `${subject}\n\n${bn ? 'ইনভয়েস' : 'Invoice'}: ${invoiceRef}\n${bn ? 'বকেয়া' : 'Due'}: ${amountDisplay}\n${bn ? 'শেষ তারিখ' : 'Due date'}: ${dueDate}\n${contractDescription}\n${invoice.payment_link ? `${bn ? 'পেমেন্ট লিংক' : 'Payment link'}: ${invoice.payment_link}` : ''}\n\n${bn ? 'সাহায্যের জন্য' : 'Support'}: support@easymod.tech\nCommercial contract v${COMMERCIAL_CONTRACT_VERSION}`;

  return { subject, html, text };
}

module.exports = { billingFailureEmail };