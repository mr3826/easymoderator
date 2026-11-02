/**
 * SelfMfsHandler
 *
 * OCR SCREENSHOT ANALYSIS HELPER for BD F-commerce self-MFS review:
 *   Customer screenshot → Gemini Vision extracts TrxID, amount, phones →
 *   heuristic fraud checks (duplicate TrxID, amount, receiver, MFS type) →
 *   TrxIDLog record + descriptive reason.
 *
 * TRUTH POLICY (Pilot+ P0-2): a pass result is heuristic OCR EVIDENCE ONLY.
 * It is not payment verification and must never be surfaced to a customer as
 * confirmation. Only merchant confirmation (payment.service) or a signature-
 * and-verify gateway webhook may set payment_status='paid'. The checkout
 * step machine no longer calls this service (order-session-standalone P0-2);
 * callers must keep that invariant.
 */

const llmService = require('../ai/llm.service');
const { TrxIDLog } = require('../entities');
const { Op, Sequelize } = require('sequelize');
const { safeFetchMedia } = require('../../utils/safe-media-fetch');
const { normalizePhone } = require('../../utils/validators/phone.validator');

const safeErrorCode = (error, fallback) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : fallback;
};

// ---------------------------------------------------------------------------
// Sprint 4: Advanced fraud scoring
// ---------------------------------------------------------------------------

/**
 * Compute a fraud risk score (0.0 = clean, 1.0 = high risk) for a TrxID.
 * Checks:
 *   1. Velocity — same sender_phone used more than 3x in last 24h for this shop
 *   2. Amount anomaly — zero or negative amount
 *   3. TrxID entropy — too short or all-numeric (many fakes are 4-digit)
 *   4. OCR confidence — CLIP confidence below 0.5 is suspect
 *
 * @param {{ trxId, amount, sender_phone, confidence }} ocrData
 * @param {string} shopId
 * @returns {Promise<{ score: number, flags: string[] }>}
 */
const computeFraudScore = async ({ trxId, amount, sender_phone, confidence }, shopId) => {
    const flags = [];
    let score = 0.0;

    // Check 1: TrxID format (genuine bKash/Nagad TrxIDs are 8-10 alphanumeric chars)
    if (trxId) {
        if (trxId.length < 6) { flags.push('trxid_too_short'); score += 0.35; }
        else if (/^\d+$/.test(trxId)) { flags.push('trxid_all_numeric'); score += 0.2; }
    }

    // Check 2: Amount sanity
    if (!amount || amount <= 0) { flags.push('zero_amount'); score += 0.4; }

    // Check 3: OCR confidence
    if (confidence !== undefined && confidence < 0.5) { flags.push('low_ocr_confidence'); score += 0.15; }

    // Check 4: Sender velocity — same phone submitting many payments in 24h
    // Threshold is 10 (not 3) to allow onboarding testing and high-volume legitimate use.
    // Skip check entirely if sender_phone matches the shop owner's own MFS number
    // (owners test their own flow during setup — blocking them is a bad experience).
    if (sender_phone) {
        try {
            const { Shop } = require('../entities');
            const shop = await Shop.findByPk(shopId, { attributes: ['settings'] });
            const ownerMfsNumber = shop?.settings?.bd?.mfs_number
                ? normalizePhone(shop.settings.bd.mfs_number)
                : null;
            const normalizedSender = normalizePhone(sender_phone);

            const isOwn = ownerMfsNumber && normalizedSender && ownerMfsNumber === normalizedSender;
            if (!isOwn) {
                const recentCount = await TrxIDLog.count({
                    where: {
                        shop_id: shopId,
                        sender_phone,
                        created_at: { [Op.gte]: new Date(Date.now() - 86400000) }
                    }
                });
                if (recentCount >= 10) { flags.push('velocity_exceeded'); score += 0.3; }
            }
        } catch (_) { /* non-fatal */ }
    }

    return { score: Math.min(score, 1.0), flags };
};

const FRAUD_SCORE_BLOCK_THRESHOLD = parseFloat(process.env.MFS_FRAUD_BLOCK_THRESHOLD || '0.7');

// ---------------------------------------------------------------------------
// Gemini Vision prompt — extract payment fields from screenshot
// ---------------------------------------------------------------------------
const MFS_OCR_PROMPT = `You are analyzing a Bangladeshi mobile banking transaction screenshot (bKash, Nagad, or Rocket).
Extract ONLY these fields and return a JSON object (no markdown):
{
  "trx_id": "transaction ID string (e.g. ABC123XYZ)",
  "amount": 550.00,
  "sender_phone": "01XXXXXXXXX or null",
  "receiver_phone": "01XXXXXXXXX or null",
  "mfs_type": "bkash" | "nagad" | "rocket" | "unknown",
  "status": "Successful" | "Failed" | "Pending" | "unknown",
  "confidence": 0.0-1.0
}
If any field cannot be determined, set it to null.
IMPORTANT: Only return fields you can clearly read from the image. Do not guess.`;

/**
 * Fix 13: Preprocess screenshot before OCR.
 * Downloads the image and returns it as a base64 data URL so Gemini receives
 * the full pixel data directly — avoids CDN auth expiry (Meta URLs short-lived)
 * and ensures the image is accessible regardless of origin access controls.
 * Fails closed if the download fails or the image exceeds 5 MB.
 *
 * @param {string} imageUrl
 * @returns {Promise<string|null>} — base64 data URL, or null on safe-fetch failure
 */
const preprocessImage = async (imageUrl) => {
    try {
        const { buffer, mimeType } = await safeFetchMedia(imageUrl, {
            maxBytes: 5 * 1024 * 1024,
            timeoutMs: 8000,
        });
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (err) {
        console.warn('[SelfMfsHandler] Image download for preprocessing failed; rejecting screenshot', {
            errorCode: safeErrorCode(err, 'PAYMENT_SCREEN_DOWNLOAD_FAILED'),
        });
        return null;
    }
};

/**
 * OCR a payment screenshot using Gemini Vision.
 *
 * @param {string} imageUrl — publicly accessible URL of the screenshot
 * @returns {Promise<{trx_id, amount, sender_phone, receiver_phone, mfs_type, status, confidence}|null>}
 */
const ocrScreenshot = async (imageUrl) => {
    // Fix 13: download + base64-encode before sending to Gemini
    const imageContent = await preprocessImage(imageUrl);
    if (!imageContent) return null;

    try {
        const { text: rawJson } = await llmService.chat({
            systemPrompt: MFS_OCR_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', url: imageContent },
                        { type: 'text', text: 'Extract payment details from this screenshot.' }
                    ]
                }
            ],
            preferredProvider: 'gemini',
            maxTokens: 300
        });

        const json = rawJson.replace(/```(?:json)?/g, '').trim();
        return JSON.parse(json);
    } catch (err) {
        console.error('[SelfMfsHandler] OCR failed', {
            errorCode: safeErrorCode(err, 'PAYMENT_SCREEN_OCR_FAILED'),
        });
        return null;
    }
};

// normalizePhone imported from shared validator (replaces local copy)

/**
 * Check for duplicate TrxID within a shop.
 * Returns the existing log entry if found, null otherwise.
 *
 * @param {string} shopId
 * @param {string} trxId
 */
const findDuplicateTrx = async (shopId, trxId) => {
    if (!trxId) return null;
    return TrxIDLog.findOne({
        where: { shop_id: shopId, trx_id: trxId.toUpperCase() }
    });
};

/**
 * Main verification entrypoint.
 *
 * @param {object} params
 * @param {string} params.shopId
 * @param {string} params.orderId       — current order being checked out
 * @param {string} params.imageUrl      — screenshot URL from customer
 * @param {number} params.expectedAmount — order total; must match OCR amount
 * @param {string} params.expectedReceiver — shop's MFS number (from bdSettings.mfs_number)
 * @param {string} params.mfsType       — 'bkash' | 'nagad' | 'rocket'
 *
 * @returns {Promise<{
 *   verified: boolean,
 *   reason: string|null,          — human-readable failure reason (Banglish/Bengali)
 *   trxId: string|null,
 *   amount: number|null,
 *   ocrData: object|null
 * }>}
 */
const verifyPaymentScreenshot = async ({
    shopId,
    orderId,
    imageUrl,
    expectedAmount,
    expectedReceiver,
    mfsType
}) => {
    const numericExpectedAmount = Number(expectedAmount);
    const normalizedExpectedReceiver = normalizePhone(expectedReceiver);
    const normalizedMfsType = typeof mfsType === 'string' ? mfsType.toLowerCase() : null;
    if (!Number.isFinite(numericExpectedAmount) || numericExpectedAmount <= 0
        || !normalizedExpectedReceiver
        || !['bkash', 'nagad', 'rocket'].includes(normalizedMfsType)) {
        return {
            verified: false,
            reason: 'Payment verification requires the order amount, receiver number, and MFS type.',
            trxId: null,
            amount: null,
            ocrData: null,
        };
    }

    // Step 1: OCR
    const ocr = await ocrScreenshot(imageUrl);

    if (!ocr || !ocr.trx_id) {
        return {
            verified: false,
            reason: 'Screenshot থেকে Transaction ID পড়া যাচ্ছে না। Clear screenshot পাঠান।',
            trxId: null,
            amount: null,
            ocrData: ocr
        };
    }

    const trxId = ocr.trx_id.toUpperCase().replace(/\s/g, '');

    // Step 2: Status check
    if (ocr.status && !['Successful', 'unknown'].includes(ocr.status)) {
        return {
            verified: false,
            reason: `Transaction status "${ocr.status}" — Successful transaction এর screenshot পাঠান।`,
            trxId,
            amount: ocr.amount,
            ocrData: ocr
        };
    }

    // Step 3: Duplicate TrxID fraud check
    const duplicate = await findDuplicateTrx(shopId, trxId);
    if (duplicate) {
        return {
            verified: false,
            reason: `এই TrxID (${trxId}) আগেই ব্যবহার হয়েছে। নতুন payment করুন।`,
            trxId,
            amount: ocr.amount,
            ocrData: ocr
        };
    }

    // Step 4: Amount match — 5% tolerance (covers Nagad/Rocket service charges)
    // Minimum tolerance of 5 BDT handles small-amount orders and OCR rounding.
    const ocrAmount = Number(ocr.amount);
    if (!Number.isFinite(ocrAmount) || ocrAmount <= 0) {
        return {
            verified: false,
            reason: 'Screenshot-এ একটি valid payment amount পাওয়া যায়নি।',
            trxId,
            amount: ocr.amount ?? null,
            ocrData: ocr
        };
    }
    {
        const tolerance = Math.max(5, Math.ceil(numericExpectedAmount * 0.05));
        const diff = Math.abs(ocrAmount - numericExpectedAmount);
        if (diff > tolerance) {
            return {
                verified: false,
                reason: `Amount মিলছে না। Order total ৳${numericExpectedAmount}, কিন্তু screenshot-এ ৳${ocr.amount} দেখা যাচ্ছে। (Service charge সহ পাঠান।)`,
                trxId,
                amount: ocr.amount,
                ocrData: ocr
            };
        }
    }

    // Step 5: Receiver phone match
    const normalizedActualReceiver = normalizePhone(ocr.receiver_phone);
    if (!normalizedActualReceiver || normalizedExpectedReceiver !== normalizedActualReceiver) {
            return {
                verified: false,
                reason: `Receiver number মিলছে না। ${mfsType === 'nagad' ? 'নগদ' : 'বিকাশ'} নম্বর ${expectedReceiver}-এ পাঠান।`,
                trxId,
                amount: ocr.amount,
                ocrData: ocr
            };
    }

    // Step 6: MFS type match
    if (ocr.mfs_type !== normalizedMfsType) {
        return {
            verified: false,
            reason: `${ocr.mfs_type} screenshot পাঠিয়েছেন, কিন্তু payment হওয়ার কথা ${mfsType}-এ।`,
            trxId,
            amount: ocr.amount,
            ocrData: ocr
        };
    }

    // Sprint 4: Advanced fraud scoring — run after basic checks pass
    const fraud = await computeFraudScore(
        { trxId, amount: ocr.amount, sender_phone: ocr.sender_phone, confidence: ocr.confidence },
        shopId
    );
    if (fraud.score >= FRAUD_SCORE_BLOCK_THRESHOLD) {
        console.warn(`[SelfMfsHandler] Fraud blocked TrxID=${trxId} score=${fraud.score} flags=${fraud.flags}`);
        return {
            verified: false,
            reason: `Payment যাচাই করা যাচ্ছে না। আমাদের টিম review করবে। (ref: ${trxId})`,
            trxId,
            amount: ocr.amount,
            ocrData: ocr,
            fraudFlags: fraud.flags
        };
    }

    // All checks passed — record TrxID
    try {
        await TrxIDLog.create({
            shop_id: shopId,
            order_id: orderId,
            trx_id: trxId,
            mfs_type: normalizedMfsType,
            amount: ocrAmount,
            sender_phone: normalizePhone(ocr.sender_phone),
            receiver_phone: normalizePhone(ocr.receiver_phone),
            ocr_raw: JSON.stringify(ocr),
            verified_at: new Date()
        });
    } catch (dbErr) {
        // Unique constraint violation = race-condition duplicate
        if (dbErr.name === 'SequelizeUniqueConstraintError') {
            return {
                verified: false,
                reason: `এই TrxID (${trxId}) আগেই ব্যবহার হয়েছে।`,
                trxId,
                amount: ocr.amount,
                ocrData: ocr
            };
        }
        // Other DB errors — fail closed. An audit-write failure must not
        // silently pass payment verification (e.g. connection drop, timeout).
        console.error('[SelfMfsHandler] TrxIDLog write failed, failing closed:', dbErr);
        return {
            verified: false,
            reason: `Payment verify করা সম্ভব হয়নি, technical সমস্যা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন অথবা support-এ যোগাযোগ করুন। (ref: ${trxId})`,
            trxId,
            amount: ocr.amount,
            ocrData: ocr
        };
    }

    return {
        verified: true,
        reason: null,
        trxId,
        amount: ocrAmount,
        ocrData: ocr
    };
};

module.exports = {
    verifyPaymentScreenshot,
    ocrScreenshot,
    computeFraudScore,
    _private: { preprocessImage },
};
