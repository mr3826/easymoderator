'use strict';

/**
 * Self-MFS PAYMENT CLAIM service — contract §3.2 (A4), the only money path that
 * is FULLY functional today (R-13):
 *
 *   customer sends money to a displayed wallet number
 *     → claim collected (TrxID + optional sender number — NEVER an OTP, a
 *       screenshot is never required and never auto-confirms)
 *     → TrxIDLog ledger insert FIRST
 *     → PaymentTransaction row `payment_claimed` pending merchant judgment
 *     → merchant notified through the fixed sendPaymentConfirmationRequest
 *       (expires_at now real: 24 h) and approves/rejects via the EXISTING
 *       owner endpoints — every settlement guard stays byte-for-byte.
 *
 * Honesty rules enforced here:
 *  - The amount is always SERVER-recomputed, and self-MFS claims collect the
 *    FULL order total (2026-11-26 ruling, F1/BLOCK): an advance (partial)
 *    claim number must never settle an order as fully paid, and nothing
 *    enforces a "remainder on delivery" for self-MFS — so the claim amount IS
 *    the order total. The shop's advance policy stays recorded in the claim
 *    snapshot with the machine field amount_basis='full' that every surface
 *    (chatbot copy, merchant UI) renders against. A customer-supplied figure
 *    is never the claim amount.
 *  - A displayed-vs-server amount mismatch is RECORDED and SURFACED to the
 *    merchant (gateway_response + notification), never auto-accepted and
 *    never auto-rejected (D-7/R tolerance rule).
 *  - `payment_account_id` is stamped from the account the customer was SHOWN
 *    (§3.5 / §6 "no silent number switching"). Even if the merchant edits
 *    accounts afterwards, the stamped account + number ride on the claim.
 *  - Nothing here contacts a provider. No gateway link is ever initiated
 *    (advance percentage/fixed never auto-initiate — D-7; gateway automation
 *    is inert by default — R-12). `payment_claimed` is NOT a verification:
 *    only merchant approval (`handleOwnerResponse`) settles, per §0 invariants.
 *
 * Nagad/Rocket: same flow, same ceiling — their wallet-number payments ARE
 * exactly this flow (§1.1, §9).
 */

const taxonomy = require('./payment-taxonomy');
const { normalizePhone, validatePhone } = require('../../utils/validators/phone.validator');

const {
    CLAIM_STATUS,
    SELF_MFS_ACCOUNT_TYPES,
    GATEWAY_ACCOUNT_TYPE,
    normalizeProvider,
    providerLabelSafe,
    providerFromCredentials,
    normalizeAccountType,
} = taxonomy;

// TrxID reality per self-mfs-handler (8-10 alphanumeric chars) widened to the
// contract range (§3.2-2): ^[A-Z0-9]{6,16}$ after uppercasing + whitespace strip.
const TRXID_PATTERN = /^[A-Z0-9]{6,16}$/;

// Amount tolerance mirrors the merchant-side review helper's family
// (self-mfs-handler.service.js:267-280): ≥5 ৳ or 5% of the expected amount.
const amountTolerance = (expected) => Math.max(5, Math.ceil((Number(expected) || 0) * 0.05));

// OwnerNotification lifetime required by the §3.3 fix / D-10 ratified defect
// correction: 24 h. F3/D-4 (2026-11-26): past expires_at the row is SURFACED
// as 'expired' — approve/reject REMAIN functional (owner judgment outranks the
// SLA); there is no 410 dead end, and expired claims are never auto-failed.
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

// Optional screenshot: a URL string only — supporting evidence for the
// merchant's review, never OCR'd or auto-confirmed here (§0 invariant).
const SCREENSHOT_URL_MAX = 2048;

function normalizeTrxId(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Validate + normalize a customer-entered TrxID (§3.2-2).
 * Strips a leading "TrxID:" label, uppercases, removes spaces. Guard: a
 * space-separated answer with no digit anywhere ("i forgot it" →
 * "IFORGOTIT") is PROSE, not an ID — a real TrxID is either one token or a
 * digit-bearing fragment. This prevents silently minting claims from sentences.
 */
function validateTrxIdInput(raw) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return { valid: false, normalized: '' };
    // NOTE: bare "id" is deliberately NOT a stripped label — real TrxIDs can
    // start with the letters I-D.
    const stripped = trimmed
        .replace(/^(trx(?:\.?\s*_?\s*id)?|transaction\s*id|txn\s*id)\s*[:\-]?\s+/i, '');
    const normalized = stripped.trim().toUpperCase().replace(/\s+/g, '');
    if (!TRXID_PATTERN.test(normalized)) return { valid: false, normalized: '' };
    if (/\s/.test(stripped.trim()) && !/[0-9]/.test(normalized)) return { valid: false, normalized: '' };
    return { valid: true, normalized };
}

function safeScreenshotUrl(raw) {
    if (typeof raw !== 'string') return null;
    const url = raw.trim();
    if (!url || url.length > SCREENSHOT_URL_MAX) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
    } catch (_) {
        return null;
    }
}

function normalizeSenderPhone(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const normalized = normalizePhone(raw.trim());
    return normalized && validatePhone(normalized, 'BD_MOBILE_STRICT') ? normalized : null;
}

// ── customer reply (§3.2-3) — no "paid", no "confirmed", no status change ────
// bn-first house style: one language per reply, chosen by the caller.
const claimReply = {
    // Deliberately avoids the P0-2 forbidden strings ("Payment confirmed",
    // "পেমেন্ট নিশ্চিত") — receipt of DETAILS only, judgment belongs to the merchant.
    bn: (trxId) => `✅ পেমেন্ট তথ্য পেয়েছি (TrxID ${trxId})। দোকান মালিক নিশ্চিত করবেন।`,
    en: (trxId) => `We've received your payment details (TrxID ${trxId}). The shop owner will confirm shortly.`,
};

// Same message family as the merchant-side duplicate reply
// (self-mfs-handler.service.js:255-265).
const duplicateReply = {
    bn: (trxId) => `এই TrxID (${trxId}) আগেই ব্যবহার হয়েছে। নতুন payment করুন বা দোকানকে জানান।`,
    en: (trxId) => `This TrxID (${trxId}) was already used. Please pay with a new transaction or contact the shop.`,
};

// B1 (A9-R3 money-integrity, 2026-11-26): a DIFFERENT TrxID for an order that
// already has a claim awaiting merchant judgment is an ORDER-level duplicate —
// honest reply names the real state (a claim is under review), never the
// "TrxID was already used" text (which would be a lie here).
const pendingClaimReply = {
    bn: 'এই অর্ডারের payment দাবি ইতিমধ্যে দোকান মালিকের পর্যালোচনার অপেক্ষায় আছে। আলাদা payment পাঠানোর আগে অপেক্ষা করুন বা দোকানকে জানান।',
    en: 'A payment claim for this order is already awaiting the shop owner\'s review. Please wait for their confirmation before sending another payment, or contact the shop.',
};

// ── entity access (lazy + direct module paths) ───────────────────────────────
// Lazy so the chatbot machine can import this service before any DB surface
// exists, and so existing mocked-entity tests keep resolving what they mock.
const models = () => ({
    PaymentConfig: require('./payment-config.entity'),
    TrxIDLog: require('./trx-id-log.entity'),
    PaymentTransaction: require('../billing/payment-transaction.entity'),
    Order: require('../order/order.entity'),
});

/**
 * Accept canonical tokens AND customer-shaped words (bkash/বিকাশ/নগদ/রকেট…)
 * as a provider hint, mapping through the taxonomy keyword set (§6).
 */
function canonicalizeProviderHint(raw) {
    const direct = normalizeProvider(raw);
    if (direct) return direct;
    const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!token) return null;
    for (const provider of taxonomy.PROVIDERS_WITH_WALLETS) {
        const kws = taxonomy.PROVIDER_KEYWORDS[provider] || [];
        if (kws.some(kw => token.includes(kw))) return provider;
    }
    return null;
}

// ── wallet account resolution (§3.2-1, §6) ───────────────────────────────────
/**
 * The ONE account whose number may be displayed to a customer: an enabled
 * wallet (self|business) row with a readable number, preferred first, honoring
 * the provider when the customer named one. merchant_gateway rows are EXCLUDED
 * (their payments are §4 gateway attempts — invisible in the chatbot below
 * live_certified, and automation is inert here per R-12) — as is cod.
 *
 * Legacy drift rows (no provider column) are classified from their encrypted
 * credentials via providerFromCredentials — never assumed bkash (§1.2).
 *
 * @returns {Promise<{account_id, provider, number, account_type}|null>}
 */
async function resolvePaymentWallet(shopId, { provider = null } = {}) {
    const wanted = canonicalizeProviderHint(provider);
    if (provider != null && !wanted) return null; // explicit non-provider token (cod) → no wallet
    const PaymentConfig = models().PaymentConfig;
    if (!PaymentConfig || typeof PaymentConfig.findAll !== 'function') return null;

    let rows;
    try {
        rows = await PaymentConfig.findAll({
            where: { shop_id: shopId, is_enabled: true },
            attributes: ['id', 'gateway', 'provider', 'account_type', 'is_preferred', 'credentials'],
        });
    } catch (_) {
        return null; // honest degradation: no wallet surfaced, never a guessed number
    }
    if (!Array.isArray(rows)) return null;

    const wallets = [];
    for (const row of rows) {
        const providerOfRow = row.provider || providerFromCredentials(row.credentials, row.gateway);
        if (!providerOfRow || providerOfRow === 'cod') continue;
        const accountType = row.account_type
            || normalizeAccountType(row.credentials?.mfs_mode, providerOfRow)
            || 'self';
        if (accountType === GATEWAY_ACCOUNT_TYPE) continue; // gateway is §4, not §3 (§6 eligibility)
        if (!SELF_MFS_ACCOUNT_TYPES.includes(accountType) && row.account_type != null) continue;
        const number = row.credentials?.mfs_number || row.credentials?.phone || null;
        if (!number) continue;
        if (wanted && providerOfRow !== wanted) continue;
        wallets.push({
            account_id: row.id,
            provider: providerOfRow,
            account_type: accountType,
            number: String(number),
            is_preferred: Boolean(row.is_preferred),
        });
    }
    if (!wallets.length) return null;

    // §6: explicit provider choice honored; within a provider (or generic
    // choice) the DB-truth preferred account first, then deterministic order.
    wallets.sort((a, b) => (
        (Number(b.is_preferred) - Number(a.is_preferred))
        || String(a.provider).localeCompare(String(b.provider))
        || String(a.account_id).localeCompare(String(b.account_id))
    ));
    return wallets[0];
}

// ── amount authority (§5.2 #1 — server-side, never customer-supplied) ────────
/**
 * What the customer must send NOW for this order — the SERVER-side claim
 * amount. RULING 2026-11-26 (F1/BLOCK): a self-MFS claim collects the FULL
 * order total, NEVER the policy advance number — merchant approval settles the
 * order as fully paid, so a partial claim amount would fabricate settlement of
 * the unpaid remainder, and nothing in the self-MFS path enforces a
 * "remaining X on delivery". (The gateway posture is unchanged: percentage/
 * fixed policies still NEVER auto-initiate a gateway link — D-7 ratified.)
 *
 * The policy is still computed (via payment-policy.computeAdvance, which
 * REFERENCES the zone delivery charge and never recomputes a fee, §5.2) and
 * recorded in the snapshot, together with the machine field
 * amount_basis='full' that chatbot and merchant surfaces render honest copy
 * against (copy keys themselves are frontend-owned).
 *
 * @returns {Promise<{amount: number, partial: false, amount_basis: 'full',
 *          policy_advance: boolean, snapshot: object}>}
 */
async function computeClaimAmount(shopId, { orderTotal, deliveryCharge }) {
    const total = Number(orderTotal) || 0;
    let policy = { advance_policy: 'none', advance_value: null };
    let computed;
    try {
        const policyService = require('./payment-policy.service');
        policy = await policyService.getPaymentPolicy(shopId, null);
        computed = policyService.computeAdvance({
            policy: policy.advance_policy,
            value: policy.advance_value,
            orderTotal: total,
            deliveryCharge,
        });
    } catch (_) {
        // Policy unreadable (test env / settings drift): fall back to full
        // total rather than inventing a partial amount.
        computed = { policy: 'none', advance_amount: 0, remainder: total, note: 'policy_unreadable_full_total' };
    }
    const policyAdvance = ['delivery_charge', 'percentage', 'fixed'].includes(computed.policy)
        && Number(computed.advance_amount) > 0;
    return {
        amount: total,                   // F1 ruling: claims collect the full total
        partial: false,                  // no self-MFS partial collection exists
        amount_basis: 'full',            // machine field surfaces render against
        policy_advance: policyAdvance,   // the shop's policy wanted an advance (display truth only)
        snapshot: {
            policy: computed.policy,
            value: Number.isInteger(policy.advance_value) ? policy.advance_value : null,
            advance_amount: computed.advance_amount,
            remainder: computed.remainder,
            amount_basis: 'full',
            snapshot_at: new Date().toISOString(),
            ...(computed.note ? { note: computed.note } : {}),
        },
    };
}

// ── claim materialization (§3.2-3) — shared by API + chatbot paths ───────────
function isUniqueViolation(err) {
    return Boolean(err && (
        err.name === 'SequelizeUniqueConstraintError'
        || /unique|duplicate/i.test(String(err.message || ''))
    ));
}

// F-1(b) (A9-remediation, 2026-11-27): distinguish WHICH unique fired. PG puts
// the index name in both the message ("duplicate key value violates unique
// constraint \"idx_...\"") and sequelize's err.parent.constraint; tests and
// drivers without a parent object are matched via the message too.
const PENDING_CLAIM_INDEX = 'idx_payment_txn_one_pending_claim_per_order';
function isPendingClaimViolation(err) {
    if (!err) return false;
    return String(err?.parent?.constraint || '') === PENDING_CLAIM_INDEX
        || String(err?.message || '').includes(PENDING_CLAIM_INDEX);
}

/**
 * @param {object} args
 * @param {string} args.shopId            — tenant authority for every read
 * @param {string} args.orderId
 * @param {string} args.trxIdRaw
 * @param {string} [args.senderPhoneRaw]  — optional; never an OTP
 * @param {string} [args.screenshotUrl]   — optional SUPPORTING evidence only
 * @param {string} [args.customerMessage]
 * @param {object|null} [args.account]    — the STAMPED wallet shown to the customer
 *                                          (§6 no silent number switching)
 * @param {string|null} [args.provider]   — provider hint used ONLY when no stamped
 *                                          account exists (API path)
 * @param {number|null} [args.displayedAmount] — server-displayed amount at prompt time
 * @param {string|null} [args.sessionId]
 */
async function performClaim({
    shopId,
    orderId,
    trxIdRaw,
    senderPhoneRaw = null,
    screenshotUrl = null,
    customerMessage = null,
    account = null,
    provider = null,
    displayedAmount = null,
    sessionId = null,
}) {
    const { PaymentConfig, TrxIDLog, PaymentTransaction, Order } = models();
    if (!TrxIDLog || typeof TrxIDLog.create !== 'function'
        || !PaymentTransaction || typeof PaymentTransaction.create !== 'function') {
        const { AppError } = require('../../utils/AppError');
        throw new AppError('Payment claim storage is unavailable', 503, 'PAYMENT_CLAIM_STORAGE_UNAVAILABLE');
    }

    // 1. TrxID format is service-enforced regardless of caller.
    const { valid: trxValid, normalized: trxId } = validateTrxIdInput(trxIdRaw);
    if (!trxValid) {
        const { AppError } = require('../../utils/AppError');
        throw new AppError('Transaction ID format is not valid (6-16 letters/digits)', 400, 'TRXID_FORMAT_INVALID');
    }
    const senderPhone = normalizeSenderPhone(senderPhoneRaw);
    const screenshot = safeScreenshotUrl(screenshotUrl);
    const message = typeof customerMessage === 'string' ? customerMessage.trim().slice(0, 500) : null;

    // 2. Tenant + settlement-state re-validation (§3.2-3): the order must belong
    //    to this shop and must still be awaiting payment.
    if (!Order || typeof Order.findOne !== 'function') {
        const { AppError } = require('../../utils/AppError');
        throw new AppError('Order context is unavailable', 503, 'ORDER_CONTEXT_UNAVAILABLE');
    }
    const order = await Order.findOne({
        where: { id: orderId, shop_id: shopId },
        attributes: ['id', 'order_number', 'customer_name', 'customer_phone', 'total', 'delivery_fee', 'payment_status'],
    });
    if (!order) {
        const { AppError } = require('../../utils/AppError');
        throw new AppError('Order not found for this shop', 404, 'ORDER_NOT_FOUND');
    }
    const paymentState = String(order.payment_status || '').trim().toLowerCase();
    if (!['pending', 'unpaid'].includes(paymentState)) {
        const { AppError } = require('../../utils/AppError');
        throw new AppError('This order is no longer awaiting payment', 409, 'PAYMENT_ALREADY_SETTLED');
    }

    // 3. The stamped account (§6) stays authoritative; fall back to a fresh
    //    resolution only when the caller had none. A stale/deleted stamped
    //    account is RECORDED (merchant judgment, not automatic rejection).
    let accountStale = false;
    let wallet = account && account.account_id && account.number ? { ...account } : null;
    if (wallet && PaymentConfig && typeof PaymentConfig.findByPk === 'function') {
        try {
            const fresh = await PaymentConfig.findByPk(wallet.account_id);
            const freshNumber = fresh?.credentials?.mfs_number || fresh?.credentials?.phone || null;
            accountStale = !fresh || !fresh.is_enabled || (freshNumber && String(freshNumber) !== String(wallet.number));
        } catch (_) {
            accountStale = true;
        }
    }
    if (!wallet) {
        wallet = await resolvePaymentWallet(shopId, {
            provider: account?.provider || provider,
        });
        if (!wallet) {
            const { AppError } = require('../../utils/AppError');
            throw new AppError(
                'No enabled wallet account with a number is configured for this shop',
                400, 'PAYMENT_ACCOUNT_NOT_CONFIGURED',
            );
        }
    }

    // 4. Server-side amount authority + tolerance (§3.2-3, D-7). F1/BLOCK
    //    ruling: expectedAmount is the FULL order total — an advance-policy
    //    shop still shows its policy via the snapshot with amount_basis='full'.
    const {
        amount: expectedAmount,
        policy_advance: policyAdvance,
        snapshot,
    } = await computeClaimAmount(shopId, {
        orderTotal: order.total,
        deliveryCharge: order.delivery_fee,
    });
    const displayed = Number(displayedAmount);
    let amountMismatch = null;
    if (Number.isFinite(displayed) && displayed > 0
        && Math.abs(displayed - expectedAmount) > amountTolerance(expectedAmount)) {
        amountMismatch = {
            displayed_amount: displayed,
            server_amount: expectedAmount,
            tolerance: amountTolerance(expectedAmount),
        };
    }

    // 5. Duplicate check BEFORE insert (ledger + transaction), then race-safe
    //    inserts relying on the DB uniques (§3.2-3; 20261127_001/002).
    const duplicateExisting = async () => {
        if (typeof TrxIDLog.findOne === 'function') {
            const hit = await TrxIDLog.findOne({ where: { shop_id: shopId, trx_id: trxId } });
            if (hit) return 'trx_id_log';
        }
        if (typeof PaymentTransaction.findOne === 'function') {
            const hit = await PaymentTransaction.findOne({ where: { shop_id: shopId, transaction_id: trxId } });
            if (hit) return 'payment_transaction';
        }
        return null;
    };
    const existingDup = await duplicateExisting();
    if (existingDup) {
        return { created: false, duplicate: true, reason: existingDup, trxId, duplicateReply: { bn: duplicateReply.bn(trxId), en: duplicateReply.en(trxId) } };
    }

    // 5b. B1 (A9-R3 money-integrity, 2026-11-26): ORDER-level dedupe BEFORE
    //     any insert. The 002 fold-in comment claims multiple payment_claimed
    //     rows per order are "policed at the claim service" — without this
    //     check that was false: two claims with DIFFERENT TrxIDs for one
    //     pending order coexist, and a later approve of the stale second row
    //     re-settles + double-messages the customer (the owner-side
    //     ALREADY_SETTLED guard in owner-notification closes the settlement
    //     half; this closes the honest-duplicate half at the entry). A row
    //     already awaiting review (`payment_claimed`) OR already settled
    //     through this path (`verified`) for the same (shop, order) answers
    //     with the honest "a claim is already awaiting review" duplicate —
    //     no second ledger row, no second txn row, no second notification.
    // F-1(b) (A9-remediation, 2026-11-27): the read-then-insert window below is
    //     now CLOSED at the DB by migration 20261127_003's partial unique
    //     idx_payment_txn_one_pending_claim_per_order (one `payment_claimed`
    //     row per order — rejected/verified history stays free, honoring D-4).
    //     This service check stays as the honest pre-entry answer; concurrent
    //     racers collide on the index and map back to the SAME pendingClaim
    //     reply via the insert-failure paths below.
    const OPEN_CLAIM_STATUSES = [CLAIM_STATUS, 'verified'];
    const findOpenClaim = async () => {
        if (typeof PaymentTransaction.findOne !== 'function') return null;
        const hit = await PaymentTransaction.findOne({
            where: { shop_id: shopId, order_id: order.id, status: OPEN_CLAIM_STATUSES },
        });
        // Defensive: the WHERE already filters; re-check on the row so a
        // mock/partial row without a status can never be mistaken for an
        // open claim (race-detection callers rely on the same shape).
        return hit && OPEN_CLAIM_STATUSES.includes(String(hit.status)) ? hit : null;
    };
    const pendingClaimResult = () => ({
        created: false,
        duplicate: true,
        pendingClaim: true,
        reason: 'claim_already_awaiting_review',
        trxId,
        duplicateReply: { bn: pendingClaimReply.bn, en: pendingClaimReply.en },
    });
    if (await findOpenClaim()) return pendingClaimResult();

    const gatewayResponse = {
        source: 'self_mfs_claim',
        sender_phone: senderPhone,
        ...(screenshot ? { screenshot_url: screenshot, screenshot_evidence: 'supporting_only' } : {}),
        wallet_number: wallet.number,
        // F1 ruling: the claim collects the full total; an advance-policy shop
        // still rides its snapshot for honest merchant review, with the
        // amount_basis='full' machine field inside it.
        ...(policyAdvance ? { payment_policy: snapshot, amount_kind: 'full' } : {}),
        ...(amountMismatch ? { amount_mismatch: amountMismatch } : {}),
        ...(accountStale ? { account_stale: true } : {}),
        ...(sessionId ? { order_session_id: sessionId } : {}),
    };

    // TrxIDLog FIRST — audit ledger; nothing is "verified" here.
    //
    // F-9 (A9-R2, 2026-11-26): the ledger + PaymentTransaction writes are now
    // ATOMIC. Previously they were two independent inserts: when the txn
    // insert failed (DB error, or a legacy duplicate on (shop, transaction_id)
    // that the pre-check raced past), the LEDGER ROW STAYED — permanently
    // BURNING a legitimate TrxID: every honest retry hit the ledger-duplicate
    // reply while no claim row ever existed. Now: one sequelize transaction
    // when the driver supports it (both inserts commit or neither does);
    // otherwise a compensating delete of the ledger row on any txn-write
    // failure, so a failed claim never poisons the customer's TrxID.
    const ledgerPayload = {
        shop_id: shopId,
        order_id: order.id,
        trx_id: trxId,
        mfs_type: wallet.provider,
        amount: expectedAmount,
        sender_phone: senderPhone,
        receiver_phone: wallet.number,
        ocr_raw: null,
        verified_at: null,
    };
    const txnPayload = {
        order_id: order.id,
        shop_id: shopId,
        payment_method: wallet.provider,
        payment_gateway: null,
        transaction_id: trxId,
        amount: expectedAmount,
        status: CLAIM_STATUS,
        payment_account_id: wallet.account_id || null,
        gateway_response: gatewayResponse,
    };
    const duplicateResult = (reason) => ({
        created: false, duplicate: true, reason, trxId,
        duplicateReply: { bn: duplicateReply.bn(trxId), en: duplicateReply.en(trxId) },
    });

    const driver = (TrxIDLog.sequelize && typeof TrxIDLog.sequelize.transaction === 'function')
        ? TrxIDLog.sequelize
        : (PaymentTransaction.sequelize && typeof PaymentTransaction.sequelize.transaction === 'function'
            ? PaymentTransaction.sequelize
            : null);

    let transaction = null;
    if (driver) {
        // Atomic path: a failed txn insert rolls the ledger insert back WITH IT
        // (no burned TrxID, no orphan audit row).
        try {
            transaction = await driver.transaction(async (t) => {
                await TrxIDLog.create(ledgerPayload, { transaction: t });
                return PaymentTransaction.create(txnPayload, { transaction: t });
            });
        } catch (err) {
            if (isUniqueViolation(err)) {
                // Race with a concurrent claim: one of the two rows already
                // exists — the duplicate reply stays honest, and the rollback
                // guarantees WE left no new ledger row behind.
                // F-1(b): a hit on the pending-claim unique is NOT "TrxID
                // already used" — the customer's TrxID is fresh, the ORDER
                // already carries a claim awaiting review. Constraint-name
                // match first, then the live open-claim read, then the legacy
                // trx-shape answers.
                if (isPendingClaimViolation(err)) return pendingClaimResult();
                const byTrx = await duplicateExisting();
                if (byTrx) return duplicateResult(byTrx);
                if (await findOpenClaim()) return pendingClaimResult();
                return duplicateResult('trx_id_log');
            }
            const { AppError } = require('../../utils/AppError');
            throw new AppError('Payment claim could not be recorded. Please try again.', 500, 'PAYMENT_CLAIM_WRITE_FAILED');
        }
    } else {
        // Degraded surface (mocks / driver without transactions): keep the
        // ledger-first order, add the compensating delete (F-9).
        let ledger;
        try {
            ledger = await TrxIDLog.create(ledgerPayload);
        } catch (err) {
            if (isUniqueViolation(err)) {
                return duplicateResult('trx_id_log');
            }
            // Fail CLOSED exactly like the merchant-side helper: no audit ledger
            // row means no claim, no notification, no pending transaction.
            const { AppError } = require('../../utils/AppError');
            throw new AppError('Payment claim could not be recorded. Please try again.', 500, 'PAYMENT_CLAIM_AUDIT_WRITE_FAILED');
        }
        const releaseLedgerRow = async () => {
            try {
                if (ledger && typeof ledger.destroy === 'function') await ledger.destroy();
                else if (typeof TrxIDLog.destroy === 'function') {
                    await TrxIDLog.destroy({ where: { shop_id: shopId, trx_id: trxId } });
                }
            } catch (cleanupErr) {
                // Loud: the only remaining failure mode for a burned TrxID.
                console.error('[PaymentClaim] compensating ledger delete FAILED — TrxID needs manual cleanup', {
                    orderId: order.id, shopId, errorCode: String(cleanupErr?.code || 'LEDGER_COMPENSATION_FAILED'),
                });
            }
        };
        try {
            transaction = await PaymentTransaction.create(txnPayload);
        } catch (err) {
            await releaseLedgerRow();
            if (isUniqueViolation(err)) {
                // F-1(b): pending-claim unique → the order is already awaiting
                // review; the customer's fresh TrxID was NOT burned (compensated
                // above) and they are not told it was "already used".
                if (isPendingClaimViolation(err)) return pendingClaimResult();
                return duplicateResult('payment_transaction');
            }
            const { AppError } = require('../../utils/AppError');
            throw new AppError('Payment claim could not be recorded. Please try again.', 500, 'PAYMENT_CLAIM_WRITE_FAILED');
        }
    }

    // 6. Merchant notification through the FIXED sendPaymentConfirmationRequest
    //    (§3.2-3 + §3.3): expires_at (24 h) now actually set, paymentMethod is
    //    taxonomy-safe, claim amount + mismatch surfaced for merchant judgment.
    let notificationQueued = false;
    try {
        const ownerNotification = require('../notification/owner-notification.service');
        const result = await ownerNotification.sendPaymentConfirmationRequest(shopId, {
            id: order.id,
            order_number: order.order_number,
            customer_name: order.customer_name,
            customer_phone: order.customer_phone,
            total: order.total,
        }, {
            paymentMethod: providerLabelSafe(wallet.provider),
            transactionId: trxId,
            screenshotUrl: screenshot,
            customerMessage: message,
            claim_amount: expectedAmount,
            // F1 ruling: a self-MFS claim is a FULL-total claim — the merchant
            // approving it settles the whole order. amount_basis is the machine
            // field the merchant UI renders copy against.
            amount_kind: 'full',
            amount_basis: 'full',
            policy_advance: policyAdvance,
            amount_mismatch: amountMismatch,
            wallet_number: wallet.number,
        });
        notificationQueued = Boolean(result && result.success);
    } catch (notifyErr) {
        // The claim row exists — merchant still sees it in reconciliation
        // surfaces; the customer reply stays honest about receipt of details.
        console.error('[PaymentClaim] owner notification failed', {
            orderId: order.id,
            shopId,
            errorCode: String(notifyErr?.code || notifyErr?.status || 'NOTIFY_FAILED'),
        });
    }

    return {
        created: true,
        duplicate: false,
        status: CLAIM_STATUS,
        trxId,
        transactionId: transaction.id,
        amount: expectedAmount,
        amountKind: 'full',   // F1 ruling: claims collect the full total
        amountBasis: 'full',
        policyAdvance,
        provider: wallet.provider,
        paymentAccountId: wallet.account_id || null,
        accountStale,
        amountMismatch,
        notificationQueued,
        reply: { bn: claimReply.bn(trxId), en: claimReply.en(trxId) },
        duplicateReply: { bn: duplicateReply.bn(trxId), en: duplicateReply.en(trxId) },
    };
}

// ── public: chatbot machine path (called right AFTER order creation) ─────────
async function createSelfMfsClaimForOrder(shopId, order, context = {}) {
    return performClaim({
        shopId,
        orderId: order?.id,
        trxIdRaw: context.trxId,
        senderPhoneRaw: context.senderPhone || null,
        screenshotUrl: context.screenshotUrl || null,
        customerMessage: context.customerMessage || null,
        account: context.account
            ? {
                account_id: context.account.account_id || context.account.id || null,
                provider: context.account.provider || context.provider || null,
                number: context.account.number || null,
            }
            : null,
        provider: context.provider || null,
        displayedAmount: context.displayedAmount ?? null,
        sessionId: context.sessionId || null,
    });
}

// ── public: API path — POST /api/payment/claims (A5 delegate target) ─────────
// payload: { orderId, trxId, senderPhone?, screenshotUrl?, customerMessage? } (§3.2)
async function createSelfMfsClaim(shopId, userId, payload = {}) {
    const { AppError } = require('../../utils/AppError');
    if (!shopId) throw new AppError('No shop selected. Please login again.', 400);
    const { orderId, trxId, senderPhone, screenshotUrl, customerMessage } = payload || {};
    if (!orderId) throw new AppError('orderId is required', 400, 'ORDER_ID_REQUIRED');

    // Membership via the A5 helper (same 403 semantics as the account API).
    try {
        const accounts = require('./payment-accounts.service');
        await accounts._private.verifyShopAccess(userId, shopId);
    } catch (err) {
        if (err && err.status === 403) throw err;
        throw new AppError('Payment claim service is unavailable', 503, 'PAYMENT_CLAIM_SERVICE_UNAVAILABLE');
    }

    return performClaim({
        shopId,
        orderId,
        trxIdRaw: trxId,
        senderPhoneRaw: senderPhone ?? payload.sender_phone,
        screenshotUrl: screenshotUrl ?? payload.screenshot_url,
        customerMessage: customerMessage ?? payload.customer_message,
        account: null,
        provider: payload.provider ?? payload.provider_hint ?? null,
        displayedAmount: null,
        sessionId: null,
    });
}

module.exports = {
    TRXID_PATTERN,
    CLAIM_TTL_MS,
    amountTolerance,
    canonicalizeProviderHint,
    normalizeTrxId,
    validateTrxIdInput,
    normalizeSenderPhone,
    safeScreenshotUrl,
    resolvePaymentWallet,
    computeClaimAmount,
    performClaim,
    createSelfMfsClaimForOrder,
    createSelfMfsClaim,
    claimReply,
    duplicateReply,
    pendingClaimReply,
};
