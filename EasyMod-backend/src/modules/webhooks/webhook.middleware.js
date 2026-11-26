/**
 * Webhook Middleware
 * Authenticates inbound payment callbacks at the TRANSPORT layer.
 *
 * HONESTY NOTE (Payment Data Contract §4.2, §7 row 9, D-9):
 * The previous version of this file claimed the `x-bkash-signature` HMAC was
 * bKash's official signature scheme ("B1/B17") — the docs sweep found NO such
 * browser-redirect HMAC in Tokenized Checkout v2. That claim was invented and
 * has been removed. What remains here is deliberately weaker than a provider
 * signature and honestly labeled:
 *
 *   - This is a DEPLOYMENT SHARED-SECRET GATE. If BKASH_WEBHOOK_SECRET is
 *     provisioned, a caller must demonstrate knowledge of it with an
 *     HMAC-SHA256 of the raw body. It keeps unauthenticated junk off the
 *     handler; it proves nothing about settlement.
 *   - The onboarding-specific provider verification scheme (certificate /
 *     subscribe-style IPN, per the official docs sweep) cannot be pinned from
 *     the artifacts this environment holds. Per §4.2 the honest fallback then
 *     is: the webhook NEVER settles anything from body claims — every status
 *     transition is confirmed by a server-side v2 Query inside
 *     payment-webhook.controller.js (`querySettlementEvidence`). A body status
 *     is an evidence-TRIGGER only.
 *   - With no secret configured the gate fails closed (503) — the endpoint is
 *     effectively disabled until a deployment provisions it, which matches the
 *     R-12 inert posture: confirmation then rides entirely on the customer
 *     return Execute+Query path and scheduled Query reconciliation (§4.3).
 */

const crypto = require('crypto');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger();

/**
 * bKash callback transport gate.
 * Verifies the deployment shared secret over the RAW request body (Buffer,
 * captured upstream as req.rawBody). Sets req.webhookSignatureVerified=true
 * only on a constant-time match.
 */
const validateBkashSignature = async (req, res, next) => {
    try {
        const secret = process.env.BKASH_WEBHOOK_SECRET;
        if (!secret) {
            logger.error('bKash webhook: BKASH_WEBHOOK_SECRET is not configured');
            return res.status(503).json({ error: 'Webhook secret not configured' });
        }

        const signature = req.headers['x-bkash-signature'];
        if (!signature) {
            logger.warn('bKash webhook: missing x-bkash-signature header');
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        // Use raw body buffer if captured by express raw-verify, otherwise fall back
        const bodyBuffer = req.rawBody instanceof Buffer
            ? req.rawBody
            : Buffer.from(JSON.stringify(req.body));

        const expectedHex = crypto
            .createHmac('sha256', secret)
            .update(bodyBuffer)
            .digest('hex');

        const expectedBuf = Buffer.from(expectedHex);
        const receivedBuf = Buffer.from(String(signature));

        // Constant-time comparison to prevent timing attacks
        const signaturesMatch =
            expectedBuf.length === receivedBuf.length &&
            crypto.timingSafeEqual(expectedBuf, receivedBuf);

        if (!signaturesMatch) {
            logger.warn('bKash webhook: signature mismatch');
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        req.webhookSignatureVerified = true;
        req.webhookSignatureSource = 'bkash';
        req.webhookEventId = String(req.body?.paymentID || req.body?.paymentId || req.body?.trxID || req.body?.merchantInvoiceNumber || '');
        logger.info('bKash webhook transport gate passed (not settlement evidence; controller still requires a server-side Query)');
        next();

    } catch (error) {
        logger.error('bKash webhook validation failed', { error: error.message });
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }
};

/**
 * Generic webhook signature validator
 * Routes specific validators based on gateway
 */
const validateWebhookSignature = (gateway) => {
    const validators = {
        'bkash': validateBkashSignature
    };

    const validator = validators[gateway];
    if (!validator) {
        return (req, res, next) => {
            logger.error(`Webhook rejected: no validator registered for gateway "${gateway}"`);
            return res.status(401).json({ error: 'Unknown payment gateway' });
        };
    }

    return validator;
};

module.exports = {
    validateWebhookSignature,
    validateBkashSignature
};
