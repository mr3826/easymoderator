'use strict';

/**
 * bKash Tokenized Checkout v2 — official merchant-gateway client (A3).
 *
 * Implements the documented v2 contract per Payment Data Contract §4 (facts from
 * the orchestrator docs sweep, treated as authoritative inputs; nothing here was
 * re-verified against the network, and NOTHING in this module may be presented
 * as live-provider-verified — R-12/R-15). Provider interactions ship exercised
 * ONLY by official-doc-shaped contract mocks (see __tests__/bkash-*.test.js).
 *
 *   POST {base}/v2/tokenized-checkout/auth/grant-token
 *        headers: username, password; body: app_key, app_secret
 *        → id_token (1h), refresh_token (30d)          ≤2 grant+refresh / hour
 *   POST {base}/v2/tokenized-checkout/create/payment   (amount = taka BigDecimal
 *        string, currency 'BDT', merchantInvoiceNumber, callbackURL →
 *        paymentId, bkashURL, signature)
 *   POST {base}/v2/tokenized-checkout/execute/payment  {paymentId} — EXACTLY
 *        ONCE per paymentId; failed/timeout NEVER re-executed → Query instead
 *   POST {base}/v2/tokenized-checkout/query/payment    {paymentId} → the ONLY
 *        settlement-relevant provider evidence (transactionStatus +
 *        verificationStatus + merchantInvoice echo)
 *   POST {base}/v2/tokenized-checkout/general/search-transaction  {trxId}
 *        — reconciliation cross-check only, never settles
 *   POST {base}/v2/tokenized-checkout/refund/payment/transaction  paymentId +
 *        trxId + refundAmount, 60-day window (§4.5)
 *
 * Bases: production `https://tokenized.pay.bka.sh`, sandbox
 * `https://tokenized.sandbox.bka.sh` (§2.2). The production-config gate
 * (BKASH_ENABLED=true requires BKASH_SANDBOX=false, production-config
 * .validator.js:204) stays authoritative — this module never relaxes it.
 *
 * Safety posture:
 *  - Money movement ONLY through accounts passing taxonomy.isAutomatable
 *    (bkash + merchant_gateway + live_certified + is_enabled + complete
 *    credentials + BKASH_ENABLED=true). In this inert environment that is
 *    always false ⇒ zero network calls, pinned by test (§8.1).
 *  - The sandbox create→query handshake (D-3) is the only movement-shaped call
 *    reachable below live_certified, and it is SANDBOX-ENVIRONMENT ONLY — never
 *    on production credentials (§2.2).
 *  - Token store is Redis-backed (cache.service) keyed `account:{id}:token`
 *    with a rolling ≤2/hour grant+refresh budget (§2.1) — the per-process Map
 *    of base-merchant.service is NOT used here.
 *  - Logging is error-CODE-only (bkash-merchant.service.js:14-23 pattern
 *    migrated per §8.1): no PII, no amounts, no secrets.
 *  - Status comparison goes through taxonomy.isSettledStatus — case-insensitive
 *    against the canonical set, killing the 'Completed' vs 'COMPLETED' class
 *    (§4.1). Every provider body (webhook OR execute response) is an
 *    evidence-TRIGGER; settlement always rides on a server-side Query (§4.2).
 */

const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { PaymentConfig, PaymentTransaction, Order, Shop } = require('../entities');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const cache = require('../../utils/cache.service');
const { getOrigins, joinOrigin } = require('../../config/origins');
const taxonomy = require('./payment-taxonomy');

const { isAutomatable, isSettledStatus, canonicalStatus } = taxonomy;

// ── redaction helpers (v1 bkash-merchant pattern, migrated per §8.1) ─────────
const safeErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'BKASH_V2_ERROR';
};
const safeCorrelationId = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
);
const safeProviderStatus = (value) => canonicalStatus(value) || 'unknown';

// ── constants (docs-sweep facts; exact scheme re-pinned at live integration) ──
const BASES = Object.freeze({
    production: 'https://tokenized.pay.bka.sh',
    sandbox: 'https://tokenized.sandbox.bka.sh',
});
const API_ROOT = '/v2/tokenized-checkout';
const GRANT_WINDOW_MS = 60 * 60 * 1000;   // 2 grant+refresh per rolling hour
const GRANT_BUDGET_MAX = 2;
const TOKEN_CACHE_TTL_SECONDS = 3500;      // id_token lives 1h; expire early
const REFUND_WINDOW_DAYS = 60;
const PROVIDER_TIMEOUT_MS = 15000;

const logger = createLogger('Merchant-bKash-V2');

/** poisha-safe taka → official BigDecimal string ("1.00", "2400.00"). */
function toTakaString(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const minor = Math.round(n * 100);
    if (minor <= 0) return null;
    return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

function normalizeAmountToMinorUnits(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function resolveEnvironment(account) {
    const fromConfig = String(account?.config?.environment || '').toLowerCase();
    if (fromConfig === 'sandbox' || fromConfig === 'production') return fromConfig;
    return String(process.env.BKASH_ENVIRONMENT || '').toLowerCase() === 'production'
        ? 'production' : 'sandbox';
}

/** The v2 create/query handshake is a documented SANDBOX product; it must
 *  NEVER run on production credentials (§2.2). */
function assertSandboxOnly(account, purpose) {
    if (resolveEnvironment(account) !== 'sandbox') {
        throw new AppError(
            `${purpose} is only permitted on sandbox credentials — production verification is certification-based (§2.2)`,
            409, 'SANDBOX_ONLY_OPERATION',
        );
    }
}

class BkashTokenizedService {
    constructor({ enabledGate = () => String(process.env.BKASH_ENABLED) === 'true' } = {}) {
        this.isEnabledGate = enabledGate;
    }

    // ── single fail-closed choke for every money-movement call (§2.3/§4) ──────
    assertMoneyMovementAllowed(account) {
        if (!account) {
            throw new AppError('bKash payment account not found', 404, 'PAYMENT_ACCOUNT_NOT_FOUND');
        }
        if (!this.isEnabledGate()) {
            throw new AppError('bKash payments are not available', 503, 'GATEWAY_DISABLED');
        }
        if (!isAutomatable(account)) {
            throw new AppError(
                'bKash automated checkout is not active for this account (needs live_certified + complete credentials + BKASH_ENABLED)',
                503, 'GATEWAY_AUTOMATION_DISABLED',
            );
        }
        return true;
    }

    /** Credential-check choke: weaker than money movement (a credential check
     *  exists precisely to run BEFORE live_certified) but never on incomplete
     *  credentials, and never while the deployment flag is off (R-12). */
    assertCredentialCheckAllowed(account) {
        if (!account) {
            throw new AppError('Payment account not found', 404, 'PAYMENT_ACCOUNT_NOT_FOUND');
        }
        if (account.provider !== 'bkash' || account.account_type !== taxonomy.GATEWAY_ACCOUNT_TYPE) {
            throw new AppError(
                'Provider credential checks exist only for bKash merchant_gateway accounts',
                400, 'CREDENTIAL_CHECK_UNSUPPORTED',
            );
        }
        if (!taxonomy.credentialsComplete(account)) {
            throw new AppError('bKash credentials are incomplete', 400, 'GATEWAY_CREDENTIALS_INCOMPLETE');
        }
        if (!this.isEnabledGate()) {
            throw new AppError(
                'Provider checks are disabled in this deployment (BKASH_ENABLED is not "true")',
                503, 'GATEWAY_DISABLED',
            );
        }
        return true;
    }

    baseUrlFor(account) {
        return BASES[resolveEnvironment(account)];
    }

    // ── token store (Redis-backed; §2.1 — NOT the base-merchant Map) ──────────
    tokenCacheKey(account) {
        return `account:${account.id}:token`;
    }

    grantBudgetKey(account) {
        return `account:${account.id}:grant-budget`;
    }

    /** Rolling ≤2 grant+refresh/hour per account (one merchant app per account
     *  row: unique (shop, bkash, merchant_gateway)). Throws 429 BEFORE any HTTP
     *  when the budget is spent (§2.1). Returns the 1-based slot used. */
    async consumeGrantSlot(account) {
        const now = Date.now();
        const key = this.grantBudgetKey(account);
        const raw = await cache.getForShop(account.shop_id, key).catch(() => null);
        const recent = Array.isArray(raw)
            ? raw.filter((t) => Number.isFinite(t) && now - t < GRANT_WINDOW_MS)
            : [];
        if (recent.length >= GRANT_BUDGET_MAX) {
            throw new AppError(
                'bKash allows at most 2 credential grants per hour per app. Please retry later.',
                429, 'CREDENTIAL_CHECK_RATE_LIMITED',
            );
        }
        recent.push(now);
        await cache.setForShop(account.shop_id, key, recent, Math.ceil(GRANT_WINDOW_MS / 1000));
        return recent.length;
    }

    async getCachedToken(account) {
        const raw = await cache.getForShop(account.shop_id, this.tokenCacheKey(account)).catch(() => null);
        if (raw && raw.id_token && Number(raw.expiresAt) > Date.now() + 10_000) return raw;
        return null;
    }

    async storeToken(account, { id_token, refresh_token }) {
        await cache.setForShop(account.shop_id, this.tokenCacheKey(account), {
            id_token,
            refresh_token: refresh_token || null,
            // Only a fingerprint of the app_key — never the secret itself.
            key_fp: crypto.createHash('sha256').update(String(account.credentials?.app_key || '')).digest('hex').slice(0, 12),
            expiresAt: Date.now() + TOKEN_CACHE_TTL_SECONDS * 1000,
        }, TOKEN_CACHE_TTL_SECONDS);
    }

    async clearTokenCache(account) {
        await cache.deleteForShop(account.shop_id, this.tokenCacheKey(account)).catch(() => {});
        await cache.deleteForShop(account.shop_id, this.grantBudgetKey(account)).catch(() => {});
    }

    /** POST /auth/grant-token — grant-bearing: consumes the hourly slot.
     *  force=true (explicit owner credential check / D-3 handshake) ignores any
     *  cached token: a check must be FRESH to mean anything. */
    async grantToken(account, { force = false } = {}) {
        if (!force) {
            const cached = await this.getCachedToken(account);
            if (cached) return cached.id_token;
        }
        const slot = await this.consumeGrantSlot(account);
        const creds = account.credentials || {};
        try {
            const response = await axios.post(
                `${this.baseUrlFor(account)}${API_ROOT}/auth/grant-token`,
                { app_key: creds.app_key, app_secret: creds.app_secret },
                {
                    headers: {
                        username: creds.username,
                        password: creds.password,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    timeout: PROVIDER_TIMEOUT_MS,
                },
            );
            const { id_token: idToken, refresh_token: refreshToken } = response.data || {};
            if (!idToken) {
                throw Object.assign(
                    new AppError('bKash grant returned no token', 502, 'GRANT_EMPTY'),
                    { grantHttpStatus: response.status || null },
                );
            }
            await this.storeToken(account, { id_token: idToken, refresh_token: refreshToken });
            logger.info('bKash v2 grant succeeded', {
                shopId: account.shop_id, accountId: account.id, slot,
            });
            return idToken;
        } catch (error) {
            logger.error('bKash v2 grant failed', {
                shopId: account.shop_id,
                accountId: account.id,
                errorCode: safeErrorCode(error),
                httpStatus: error?.response?.status || null,
            });
            // The slot stays spent: the provider already counted the attempt.
            if (error instanceof AppError) {
                if (!Object.prototype.hasOwnProperty.call(error, 'grantHttpStatus')) {
                    error.grantHttpStatus = error.response?.status || null;
                }
                throw error;
            }
            throw Object.assign(error, {
                bkashGrantFailed: true,
                grantHttpStatus: error?.response?.status || null,
            });
        }
    }

    /** Documented refresh grant — also counts against the hourly budget (§4-1). */
    async refreshToken(account) {
        const cached = await this.getCachedToken(account);
        if (!cached?.refresh_token) return this.grantToken(account, { force: true });
        const slot = await this.consumeGrantSlot(account);
        const creds = account.credentials || {};
        try {
            const response = await axios.post(
                `${this.baseUrlFor(account)}${API_ROOT}/auth/refresh-token`,
                { refresh_id: cached.refresh_token },
                {
                    headers: {
                        username: creds.username,
                        password: creds.password,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    timeout: PROVIDER_TIMEOUT_MS,
                },
            );
            const { id_token: idToken, refresh_token: refreshToken } = response.data || {};
            if (!idToken) throw new AppError('bKash refresh returned no token', 502, 'GRANT_EMPTY');
            await this.storeToken(account, { id_token: idToken, refresh_token: refreshToken });
            logger.info('bKash v2 refresh succeeded', {
                shopId: account.shop_id, accountId: account.id, slot,
            });
            return idToken;
        } catch (error) {
            logger.error('bKash v2 refresh failed', {
                shopId: account.shop_id, accountId: account.id, errorCode: safeErrorCode(error),
            });
            if (error instanceof AppError) throw error;
            throw Object.assign(error, { bkashGrantFailed: true });
        }
    }

    /** Authenticated v2 call with ONE transparent refresh-and-retry on token
     *  rejection (401/403). A write whose outcome is UNKNOWN (execute) is never
     *  blindly retried — callers route those to Query (§4.3). */
    async _authorizedCall(account, segment, body, { allowRefresh = true } = {}) {
        const send = async (token) => axios.post(
            `${this.baseUrlFor(account)}${API_ROOT}${segment}`,
            body,
            {
                headers: {
                    Authorization: token,
                    XAPPKEY: account.credentials?.app_key,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                timeout: PROVIDER_TIMEOUT_MS,
            },
        );
        let token = await this.grantToken(account);
        try {
            const response = await send(token);
            return response.data || {};
        } catch (error) {
            const status = error?.response?.status;
            if (allowRefresh && (status === 401 || status === 403)) {
                await this.clearTokenCache(account);
                token = await this.refreshToken(account);
                const retry = await send(token);
                return retry.data || {};
            }
            throw error;
        }
    }

    // ── documented v2 endpoints (money-gated public surface) ──────────────────
    async createPayment(account, opts = {}) {
        this.assertMoneyMovementAllowed(account);
        return this._createPayment(account, opts);
    }

    async _createPayment(account, { amount, merchantInvoiceNumber, callbackURL, payerReference }) {
        const amountStr = toTakaString(amount);
        if (!amountStr || !merchantInvoiceNumber) {
            throw new AppError('A valid taka amount and merchantInvoiceNumber are required', 400);
        }
        try {
            const data = await this._authorizedCall(account, '/create/payment', {
                amount: amountStr,
                currency: 'BDT',
                merchantInvoiceNumber,
                callbackURL: callbackURL || joinOrigin(getOrigins().api, '/api/webhooks/bkash/payment-status'),
                ...(payerReference ? { payerReference } : {}),
            });
            if (!data.paymentId || !data.bkashURL) {
                throw new AppError('Unexpected bKash create response shape', 502, 'CREATE_SHAPE');
            }
            logger.info('bKash v2 payment created', {
                shopId: account.shop_id,
                accountId: account.id,
                paymentId: safeCorrelationId(data.paymentId),
                hasSignature: Boolean(data.signature),
            });
            return data;
        } catch (error) {
            logger.error('bKash v2 create failed', {
                shopId: account.shop_id, errorCode: safeErrorCode(error),
            });
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to create bKash payment', 502, 'BKASH_CREATE_FAILED');
        }
    }

    /** Raw single execute call. The execute-ONCE discipline lives in
     *  executeOnceGatewayPayment — this must never be reached twice for one
     *  paymentId. */
    async executePaymentOnce(account, { paymentId }) {
        this.assertMoneyMovementAllowed(account);
        return this._authorizedCall(account, '/execute/payment', { paymentId });
    }

    /** THE settlement-relevant provider evidence (§4-5). */
    async queryPayment(account, { paymentId }) {
        this.assertMoneyMovementAllowed(account);
        return this._queryPayment(account, { paymentId });
    }

    async _queryPayment(account, { paymentId }) {
        try {
            return await this._authorizedCall(account, '/query/payment', { paymentId });
        } catch (error) {
            logger.error('bKash v2 query failed', {
                shopId: account.shop_id,
                paymentId: safeCorrelationId(paymentId),
                errorCode: safeErrorCode(error),
            });
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to query bKash payment', 502, 'BKASH_QUERY_FAILED');
        }
    }

    /** Reconciliation cross-check ONLY — never settles (§4-5). */
    async searchTransaction(account, { trxId }) {
        this.assertMoneyMovementAllowed(account);
        return this._authorizedCall(account, '/general/search-transaction', { trxID: trxId });
    }

    async refundPayment(account, { paymentId, trxId, refundAmount, reason }) {
        this.assertMoneyMovementAllowed(account);
        const amountStr = toTakaString(refundAmount);
        if (!paymentId || !trxId || !amountStr) {
            throw new AppError('paymentId, trxId and a valid refundAmount are required', 400);
        }
        try {
            const data = await this._authorizedCall(account, '/refund/payment/transaction', {
                paymentId,
                trxId,
                amount: amountStr,
                refundAmount: amountStr,
                reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 100) : 'Merchant refund',
            });
            logger.info('bKash v2 refund submitted', {
                shopId: account.shop_id,
                paymentId: safeCorrelationId(paymentId),
                hasRefundId: Boolean(data.refundTrxID || data.refundID || data.refundId),
            });
            return data;
        } catch (error) {
            logger.error('bKash v2 refund failed', {
                shopId: account.shop_id,
                paymentId: safeCorrelationId(paymentId),
                errorCode: safeErrorCode(error),
            });
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to refund bKash payment', 502, 'BKASH_REFUND_FAILED');
        }
    }

    /**
     * D-3 sandbox rung (§2.2): grant → create → query on SANDBOX credentials
     * only, asserting the paymentId/bkashURL/signature shape and the invoice
     * echo. NO PaymentTransaction is created (it is not a settlement attempt)
     * and NO production credential is ever touched. "sandbox checkout handshake
     * verified; no settlement implied."
     */
    async sandboxCreateQueryHandshake(account) {
        this.assertCredentialCheckAllowed(account);
        assertSandboxOnly(account, 'The sandbox create→query handshake');
        const invoice = `SANDBOX-${String(account.id).slice(0, 8)}`;
        // Fresh grant, counted against the budget (§2.1) — a handshake must not
        // ride a stale token.
        await this.grantToken(account, { force: true });
        const created = await this._createPayment(account, {
            amount: '1.00',
            merchantInvoiceNumber: invoice,
        });
        const queried = await this._queryPayment(account, { paymentId: created.paymentId });
        const invoiceEcho = String(queried?.merchantInvoice || '') === invoice;
        return {
            grantOk: true,
            createOk: Boolean(created.paymentId && created.bkashURL && created.signature),
            queryOk: Boolean(queried && queried.transactionStatus !== undefined),
            invoiceEcho,
            paymentId: created.paymentId,
            settlement: false, // by definition (§2.2, D-3)
        };
    }

    /** Normalized settlement verdict from a Query result (§4.2 strictness). */
    evaluateQueryEvidence(queryResult, { expectedOrderNumber, expectedAmountMinor }) {
        const settled = isSettledStatus(queryResult?.transactionStatus);
        const verificationOk = (() => {
            const v = String(queryResult?.verificationStatus || '').trim().toUpperCase();
            // contract-mock note: the docs sweep lists verificationStatus on the
            // query response; the exact pass token is re-pinned at live
            // integration. Only an explicit verified/success counts as pass.
            return v === 'VERIFIED' || v === 'SUCCESS' || v === 'TRUE';
        })();
        const invoiceOk = Boolean(
            expectedOrderNumber
            && String(queryResult?.merchantInvoice || '') === String(expectedOrderNumber),
        );
        const amountOk = (() => {
            const minor = normalizeAmountToMinorUnits(queryResult?.amount);
            return minor !== null && expectedAmountMinor !== null && minor === expectedAmountMinor;
        })();
        return { settled, verificationOk, invoiceOk, amountOk, confirmed: settled && verificationOk && invoiceOk && amountOk };
    }
}
BkashTokenizedService.API_ROOT = API_ROOT;
BkashTokenizedService.BASES = BASES;
BkashTokenizedService.REFUND_WINDOW_DAYS = REFUND_WINDOW_DAYS;
BkashTokenizedService.GRANT_BUDGET_MAX = GRANT_BUDGET_MAX;
BkashTokenizedService.GRANT_WINDOW_MS = GRANT_WINDOW_MS;
BkashTokenizedService.normalizeAmountToMinorUnits = normalizeAmountToMinorUnits;
BkashTokenizedService.toTakaString = toTakaString;
BkashTokenizedService.resolveEnvironment = resolveEnvironment;
BkashTokenizedService.safeErrorCode = safeErrorCode;

// ── module-level flows (used by routes / webhook / chatbot roles) ────────────

const client = new BkashTokenizedService();

async function loadGatewayAccount(accountId, shopId) {
    if (!accountId) return null;
    const where = { id: accountId };
    if (shopId) where.shop_id = shopId;
    return PaymentConfig.findOne({ where });
}

/**
 * §4 create leg of the gateway path. Hard rules enforced here:
 *  - account must pass isAutomatable (§2.3) — inert ⇒ 503, zero HTTP (R-12);
 *  - D-7: percentage/fixed/delivery_charge advance policies NEVER trigger a
 *    gateway link (gateway = full order amount only);
 *  - §4.4: an order with an active attempt (initiated|processing|payment_claimed)
 *    blocks re-initiation → 409 PAYMENT_IN_PROGRESS (service-level guard; the
 *    partial unique index recommendation from §4.4 is not in A5's migrations —
 *    reported as an open question).
 */
async function initiateGatewayPayment(shopId, userId, { orderId, paymentAccountId } = {}) {
    if (!orderId) throw new AppError('orderId is required', 400);
    const order = await Order.findOne({ where: { id: orderId, shop_id: shopId } });
    if (!order) throw new AppError('Order not found', 404);
    if (!['pending', 'unpaid', 'placed', 'draft'].includes(String(order.payment_status || 'pending'))) {
        throw new AppError('This order is already paid', 409, 'ORDER_ALREADY_PAID');
    }

    const shop = await Shop.findByPk(shopId);
    const advancePolicy = String(shop?.settings?.payments?.advance_policy || 'none');
    if (!['none', 'full'].includes(advancePolicy)) {
        throw new AppError(
            'Gateway links cover the full order only; advance rules (percentage/fixed/delivery) route through the merchant-confirmed wallet flow (D-7)',
            409, 'GATEWAY_POLICY_PARTIAL_UNSUPPORTED',
        );
    }

    const active = await PaymentTransaction.findOne({
        where: { order_id: order.id, status: { [Op.in]: [...taxonomy.ACTIVE_ATTEMPT_STATUSES] } },
    });
    if (active) {
        throw new AppError('A payment attempt is already in progress for this order', 409, 'PAYMENT_IN_PROGRESS');
    }

    let account = null;
    if (paymentAccountId) {
        account = await loadGatewayAccount(paymentAccountId, shopId);
        if (!account) throw new AppError('Payment account not found', 404, 'PAYMENT_ACCOUNT_NOT_FOUND');
    } else {
        account = await PaymentConfig.findOne({
            where: {
                shop_id: shopId,
                provider: 'bkash',
                account_type: taxonomy.GATEWAY_ACCOUNT_TYPE,
                is_enabled: true,
            },
            order: [['is_preferred', 'DESC']],
        });
        if (!account) {
            throw new AppError('No enabled bKash merchant gateway account', 404, 'GATEWAY_ACCOUNT_NOT_FOUND');
        }
    }
    client.assertMoneyMovementAllowed(account); // inert ⇒ throws 503 BEFORE HTTP

    const amountStr = toTakaString(order.total);
    if (!amountStr) throw new AppError('Order total is not a valid amount', 500, 'ORDER_AMOUNT_INVALID');

    const created = await client.createPayment(account, {
        amount: amountStr,
        merchantInvoiceNumber: order.order_number,
        payerReference: order.customer_phone || 'N/A',
    });

    await PaymentTransaction.create({
        order_id: order.id,
        shop_id: shopId,
        payment_account_id: account.id,
        payment_method: 'bkash',
        payment_gateway: 'bkash',
        transaction_id: created.paymentId,
        amount: amountStr,
        status: 'initiated',
        // never store raw signatures/secrets in the gateway_response (§4-2)
        gateway_response: { source: 'tokenized_v2_create', createSignature: Boolean(created.signature) },
    });

    // Attribution (§3.5/§6): the order carries the exact account used.
    if (!order.payment_method_id && typeof order.update === 'function') {
        await order.update({ payment_method_id: account.id }).catch(() => {});
    }

    logger.info('bKash v2 gateway attempt created', {
        shopId, orderId: order.id, accountId: account.id, userId,
        paymentId: safeCorrelationId(created.paymentId),
    });

    return {
        success: true,
        payment_id: created.paymentId,
        payment_url: created.bkashURL,
        amount: amountStr,
        currency: 'BDT',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
}

/**
 * §4 execute leg — the customer browser-return is a TRIGGER, never evidence.
 * Execute-once: a prior attempt marker sends this straight to Query. Timeout/
 * failure NEVER re-executes (§4.3). Settlement always requires a server-side
 * Query confirm (§4.2).
 */
async function executeOnceGatewayPayment(shopId, { paymentId, trigger = 'browser_return' } = {}) {
    if (!paymentId) throw new AppError('paymentId is required', 400);
    const txn = await PaymentTransaction.findOne({ where: { transaction_id: paymentId, shop_id: shopId } });
    if (!txn) throw new AppError('Payment transaction not found', 404);

    if (['paid', 'verified'].includes(txn.status)) {
        return { success: true, already_settled: true, status: txn.status };
    }

    const account = await loadGatewayAccount(txn.payment_account_id, shopId);
    client.assertMoneyMovementAllowed(account);

    const gr = txn.gateway_response && typeof txn.gateway_response === 'object' ? txn.gateway_response : {};
    if (gr.executeAttempted === true) {
        // Execute happened once already — reconcile, never re-execute (§4.3).
        return reconcileAttemptByQuery(shopId, txn, account);
    }

    // Atomic single-shot claim initiated → processing (+ executeAttempted).
    const [claimed] = await PaymentTransaction.update(
        {
            status: 'processing',
            gateway_response: {
                ...gr,
                executeAttempted: true,
                executeAttemptedAt: new Date().toISOString(),
                executeTrigger: String(trigger).slice(0, 40),
            },
        },
        { where: { id: txn.id, status: 'initiated' } },
    );
    if (claimed !== 1) {
        return {
            success: true,
            deferred: true,
            status: 'processing',
            message: 'Another confirmation is already running for this payment.',
        };
    }
    if (typeof txn.reload === 'function') await txn.reload();

    try {
        const exec = await client.executePaymentOnce(account, { paymentId });
        // Even a 'Completed' execute response is NOT settlement evidence —
        // the Query verdict is (§4.2). Reconcile once with the result in hand.
        if (isSettledStatus(exec?.transactionStatus) || exec?.trxId || exec?.trxID) {
            const trxId = exec?.trxId || exec?.trxID || null;
            return settleFromQuery(shopId, txn, account, {
                ...(exec || {}),
                // mark for guards: if execute lacked query fields, re-query
                __fromExecute: true,
                __trxFromExecute: trxId,
            });
        }
        const canonical = canonicalStatus(exec?.transactionStatus);
        if (canonical === 'failed') {
            await PaymentTransaction.update(
                {
                    status: 'failed',
                    gateway_response: { ...gr, source: 'tokenized_v2_execute', transactionStatus: safeProviderStatus(exec?.transactionStatus) },
                },
                { where: { id: txn.id, status: { [Op.notIn]: ['paid', 'verified'] } } },
            );
            return { success: false, status: 'failed', message: 'The provider reports the payment failed. You may try again.' };
        }
        return { success: false, deferred: true, status: txn.status, message: 'Payment still processing — do not pay again.' };
    } catch (error) {
        // Unknown outcome: NEVER re-execute. Defer to Query reconciliation.
        logger.warn('bKash v2 execute failed; deferring to Query', {
            shopId, paymentId: safeCorrelationId(paymentId), errorCode: safeErrorCode(error),
        });
        return {
            success: false,
            deferred: true,
            status: txn.status,
            message: 'Provider confirmation is pending; reconciliation will verify via Query.',
            errorCode: safeErrorCode(error),
        };
    }
}

/**
 * Server-side Query + strict guards; settles ONLY on Query confirmation.
 * Reuses the webhook claim machinery for fulfillment (§4.2).
 */
async function confirmAndSettle(shopId, txn, account, executeHint = null) {
    const query = await client.queryPayment(account, { paymentId: txn.transaction_id });
    return settleFromQuery(shopId, txn, account, { __query: query, ...(executeHint || {}) });
}

async function settleFromQuery(shopId, txn, account, providerResult = {}) {
    let query = providerResult.__query;
    if (!query) {
        query = await client.queryPayment(account, { paymentId: txn.transaction_id });
    }
    const order = await Order.findOne({ where: { id: txn.order_id, shop_id: txn.shop_id } });
    if (!order) throw new AppError('Payment order could not be verified', 409, 'PAYMENT_ORDER_NOT_FOUND');

    const expectedMinor = normalizeAmountToMinorUnits(txn.amount);
    const verdict = client.evaluateQueryEvidence(query, {
        expectedOrderNumber: order.order_number,
        expectedAmountMinor: expectedMinor,
    });
    if (!verdict.confirmed) {
        return { confirmed: false, status: txn.status, verdict, message: 'Provider Query did not confirm settlement; deferred.' };
    }
    const trxId = query.trxID || query.trxId || providerResult.__trxFromExecute || null;
    if (!trxId) {
        return { confirmed: false, status: txn.status, verdict, message: 'Provider Query did not return a transaction id.' };
    }

    // Settlement reuses the webhook claim machinery (§4.2) — lazy-required to
    // avoid a module cycle (the controller requires this service).
    const paymentWebhookController = require('../webhooks/payment-webhook.controller');
    await paymentWebhookController.processSuccessfulPayment(txn, {
        gateway: 'bkash',
        transactionId: trxId,
        amount: query.amount ?? txn.amount,
        order,
        paymentConfigId: account.id,
        gatewayResponse: {
            source: 'tokenized_v2_query',
            transactionStatus: safeProviderStatus(query.transactionStatus),
            verificationStatus: String(query.verificationStatus || '').slice(0, 24) || null,
        },
        mutationAuthority: {
            kind: 'system',
            source: 'payment_execute_query',
            signatureVerified: false,
            eventId: String(txn.transaction_id),
        },
    });
    return { confirmed: true, status: 'paid', trxId, verdict };
}

/**
 * Bounded Query-reconciliation for one attempt (§4.3): NEVER executes.
 *  Completed → settle (Query-confirmed)   Failed/Cancelled → failed
 *  Initiated/Pending → mark nothing; customer is told not to pay again.
 */
async function reconcileAttemptByQuery(shopId, txn, account) {
    const resolvedAccount = account || await loadGatewayAccount(txn.payment_account_id, shopId);
    let query;
    try {
        query = await client.queryPayment(resolvedAccount, { paymentId: txn.transaction_id });
    } catch (error) {
        return {
            confirmed: false,
            status: txn.status,
            deferred: true,
            message: 'Provider unreachable; reconciliation will retry via Query.',
            errorCode: safeErrorCode(error),
        };
    }
    if (isSettledStatus(query?.transactionStatus)) {
        const settled = await settleFromQuery(shopId, txn, resolvedAccount, { __query: query });
        if (settled.confirmed) return settled;
        return settled;
    }
    const canonical = canonicalStatus(query?.transactionStatus);
    if (canonical === 'failed') {
        await PaymentTransaction.update(
            {
                status: 'failed',
                gateway_response: {
                    ...(txn.gateway_response || {}),
                    source: 'tokenized_v2_query',
                    transactionStatus: safeProviderStatus(query?.transactionStatus),
                },
            },
            { where: { id: txn.id, status: { [Op.notIn]: ['paid', 'verified'] } } },
        );
        return { confirmed: false, status: 'failed', message: 'Provider reports the payment failed; the customer may try again.' };
    }
    return { confirmed: false, status: txn.status, deferred: true, message: 'Payment still processing — do not pay again.' };
}

/**
 * The webhook confirmation seam (§4.2): the controller loads the transaction,
 * claims it, then asks HERE for the authoritative provider evidence. An inert
 * or unaccounted attempt reports {available:false} — the callback body alone
 * NEVER settles, and no status transition happens from body claims.
 */
async function querySettlementEvidence(paymentTransaction) {
    if (!paymentTransaction?.payment_account_id) {
        return { available: false, reason: 'no_payment_account' };
    }
    const account = await loadGatewayAccount(paymentTransaction.payment_account_id, paymentTransaction.shop_id);
    if (!account) return { available: false, reason: 'account_missing' };
    if (!client.isEnabledGate()) return { available: false, reason: 'gateway_disabled' };
    if (!isAutomatable(account)) return { available: false, reason: 'automation_inert' };
    try {
        const query = await client.queryPayment(account, { paymentId: paymentTransaction.transaction_id });
        return { available: true, account, query };
    } catch (error) {
        return { available: false, reason: 'provider_unreachable', errorCode: safeErrorCode(error) };
    }
}

/**
 * Single evaluation seam for the webhook/controller confirmation path:
 * canonical verdict + provider trxId from a Query result, compared against
 * server-side expectations (§4.2 strictness: invoice echo, amount minor-units,
 * verificationStatus pass, settled status — case-insensitive per §4.1).
 */
function evaluateSettlement(queryResult, { expectedOrderNumber, expectedAmountMinor } = {}) {
    const verdict = client.evaluateQueryEvidence(queryResult || {}, { expectedOrderNumber, expectedAmountMinor });
    return {
        ...verdict,
        trxId: queryResult?.trxID || queryResult?.trxId || null,
        canonical: canonicalStatus(queryResult?.transactionStatus),
        providerStatus: safeProviderStatus(queryResult?.transactionStatus),
    };
}

/**
 * §4.3 bounded retry cadence. The scheduler (src/jobs/gateway-attempt-reconciler.job.js)
 * sweeps every minute, but each ROW gets provider traffic only on its own rung
 * of this ladder, tracked in `gateway_response.reconcile` — attempt N+1 is due
 * `RECONCILE_LADDER_MINUTES[N]` minutes after attempt N. After 4 attempts the
 * row goes quiet for automatic traffic (the read-only admin report
 * `payment-processing-reconciliation.service.js` remains the manual path,
 * §4.3 "manual path stays"). NEVER executes — every rung is a Query (§4.4).
 */
const RECONCILE_LADDER_MINUTES = Object.freeze([1, 5, 15, 30]);

function reconcileLedger(txn) {
    const gr = txn.gateway_response && typeof txn.gateway_response === 'object' ? txn.gateway_response : {};
    const r = gr.reconcile && typeof gr.reconcile === 'object' ? gr.reconcile : {};
    const attempts = Number.isInteger(r.attempts) && r.attempts > 0 ? r.attempts : 0;
    const nextDue = r.next_due_at ? new Date(r.next_due_at) : null;
    return { gr, attempts, nextDue };
}

/**
 * §4.3 scheduled sweep entrypoint: Query-reconcile stale initiated/processing
 * gateway rows, each row attempt-gated by the ladder above. Never executes,
 * never re-presents a link.
 */
async function reconcileStaleGatewayAttempts({ olderThanMinutes = 15, limit = 50, now = new Date() } = {}) {
    const cutoff = new Date(now.getTime() - olderThanMinutes * 60 * 1000);
    const rows = await PaymentTransaction.findAll({
        where: {
            payment_gateway: 'bkash',
            payment_account_id: { [Op.ne]: null },
            status: { [Op.in]: ['initiated', 'processing'] },
            updated_at: { [Op.lt]: cutoff },
        },
        order: [['updated_at', 'ASC']],
        limit: Math.max(1, Math.min(Number(limit) || 50, 200)),
    });
    const results = [];
    for (const row of rows) {
        const { gr, attempts, nextDue } = reconcileLedger(row);
        if (attempts >= RECONCILE_LADDER_MINUTES.length) {
            results.push({ paymentId: row.id, confirmed: false, status: row.status, reconcile: 'exhausted' });
            continue;
        }
        if (nextDue && now.getTime() < nextDue.getTime()) {
            results.push({ paymentId: row.id, confirmed: false, status: row.status, reconcile: 'not_due' });
            continue;
        }
        try {
            const outcome = await reconcileAttemptByQuery(row.shop_id, row);
            // A settle or provider-side fail already moved the row (the service
            // wrote its own update) — only DEFERRED/unconfirmed passes consume
            // a ladder rung and get the bookkeeping stamp.
            const stillPending = outcome?.confirmed !== true && outcome?.status === row.status;
            if (stillPending) {
                const nextAttempts = attempts + 1;
                const waitMin = RECONCILE_LADDER_MINUTES[
                    Math.min(nextAttempts, RECONCILE_LADDER_MINUTES.length - 1)
                ];
                await row.update({
                    gateway_response: {
                        ...gr,
                        reconcile: {
                            attempts: nextAttempts,
                            last_attempt_at: now.toISOString(),
                            next_due_at: new Date(now.getTime() + waitMin * 60 * 1000).toISOString(),
                            exhausted: nextAttempts >= RECONCILE_LADDER_MINUTES.length,
                        },
                    },
                });
            }
            results.push({ paymentId: row.id, ...outcome });
        } catch (error) {
            logger.warn('bKash reconciliation attempt failed', {
                shopId: row.shop_id, paymentId: row.id, errorCode: safeErrorCode(error),
            });
            // A throwing pass STILL consumes its rung — otherwise a row whose
            // settle path is permanently broken (e.g. vanished order) would be
            // queried every minute forever, which §4.3 forbids ("bounded").
            const nextAttempts = attempts + 1;
            const waitMin = RECONCILE_LADDER_MINUTES[
                Math.min(nextAttempts, RECONCILE_LADDER_MINUTES.length - 1)
            ];
            try {
                await row.update({
                    gateway_response: {
                        ...gr,
                        reconcile: {
                            attempts: nextAttempts,
                            last_attempt_at: now.toISOString(),
                            next_due_at: new Date(now.getTime() + waitMin * 60 * 1000).toISOString(),
                            exhausted: nextAttempts >= RECONCILE_LADDER_MINUTES.length,
                            last_error_code: safeErrorCode(error),
                        },
                    },
                });
            } catch (_) { /* best-effort bookkeeping; next sweep re-derives */ }
            results.push({ paymentId: row.id, confirmed: false, status: row.status });
        }
    }
    return { scanned: rows.length, results };
}

module.exports = {
    BkashTokenizedService,
    client,
    initiateGatewayPayment,
    executeOnceGatewayPayment,
    confirmAndSettle,
    settleFromQuery,
    reconcileAttemptByQuery,
    reconcileStaleGatewayAttempts,
    RECONCILE_LADDER_MINUTES,
    querySettlementEvidence,
    evaluateSettlement,
    resolveEnvironment,
    assertSandboxOnly,
    toTakaString,
    normalizeAmountToMinorUnits,
    REFUND_WINDOW_DAYS,
};
