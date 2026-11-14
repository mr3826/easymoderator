'use strict';

/**
 * Invoice Service
 *
 * Re-renders HISTORICAL top-up purchase receipts only. ADR-0011 retired the
 * subscription renewal PDF (there is no subscription fee) and the top-up
 * programme itself (purchase is HTTP 410); an already-sold top-up still
 * resolves so a merchant can download the receipt they were given.
 *
 * Uses pdfkit (npm package). If pdfkit is not installed the caller receives
 * null and handles it gracefully.
 */

const path = require('path');
const fs = require('fs');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger('InvoiceService');

// Production mounts the persistent backend_uploads volume at /app/uploads.
const INVOICE_DIR = path.join(__dirname, '../../../uploads/invoices');

// Ensure invoice directory exists
if (!fs.existsSync(INVOICE_DIR)) {
    fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

/**
 * Generate a top-up invoice PDF.
 * Returns the file URL path or a data URI if storage is unavailable.
 */
const generateTopupInvoice = async ({
    topupId,
    invoiceNumber,
    shopId,
    packCode,
    conversations,
    amountBdt,
    bkashTrxId,
    shopName
}) => {
    const filename = `invoice-${invoiceNumber}.pdf`;
    const filePath = path.join(INVOICE_DIR, filename);
    const fileUrl = `/invoices/${filename}`;

    try {
        // Attempt PDF generation with pdfkit
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header
        doc.fontSize(24).font('Helvetica-Bold').text('EasyModerator', { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Invoice', { align: 'center' });
        doc.moveDown(2);

        // Invoice details
        doc.fontSize(12).font('Helvetica-Bold').text('Invoice Details');
        doc.font('Helvetica');
        doc.text(`Invoice Number: ${invoiceNumber}`);
        doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`);
        doc.text(`Shop: ${shopName}`);
        doc.moveDown();

        // Item
        doc.font('Helvetica-Bold').text('Description');
        doc.font('Helvetica').text(`Conversation Top-Up — ${packCode}: +${conversations} conversations`);
        doc.moveDown();

        // Payment
        doc.font('Helvetica-Bold').text('Payment');
        doc.font('Helvetica').text(`Amount: BDT ${parseFloat(amountBdt).toFixed(2)}`);
        doc.text(`Payment Method: bKash`);
        if (bkashTrxId) doc.text(`Transaction ID: ${bkashTrxId}`);
        doc.text(`Status: Paid`);
        doc.moveDown(2);

        doc.fontSize(10).fillColor('#888888')
            .text('Thank you for using EasyModerator.', { align: 'center' });

        doc.end();

        await new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
        });

        logger.info('Top-up invoice generated', { invoiceNumber, filePath });
        return fileUrl;

    } catch (err) {
        // pdfkit not available or error — return null (caller handles gracefully)
        logger.warn('PDF generation failed, returning null', { err: err.message });
        return null;
    }
};

module.exports = { generateTopupInvoice };
