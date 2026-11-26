'use strict';

/**
 * Payment VERIFICATION service — the ladder (§2), the rate-limited credential
 * check (§2.1), the D-3 sandbox handshake (§2.2) and the recorded, never
 * self-declared, live certification (§2.3), plus the owner-only v2 refund
 * (§4.5). This is A3's file, landed under the exact dispatch contract A5
 * defined: payment.routes.js → payment.controller.js →
 * payment-accounts.service.js delegate() → ./payment-verification.service.
 *
 * Ladder rules enforced here (imported from payment-taxonomy — never local
 * arrays):
 *  - Nagad/Rocket and bKash self|business wallets: maxVerificationLevel is
 *    configured_unverified and the service makes ZERO provider calls for them
 *    (§2, R-12). The response carries the exact honest notice; a check of a
 *    wallet number is format validation, not verification.
 *  - bKash merchant_gateway:
 *      grant success  → CREDENTIALS_VALID evidence record ONLY; the ladder is
 *        never raised above configured_unverified by a grant, and the response
 *        never says "connected"/"verified live" (§2.1). Copy:
 *        "bKash accepted your app credentials (one of 2 hourly checks used)."
 *      sandbox create→query handshake (sandbox env only, §2.2) → sets
 *        sandbox_verified with D-3 copy "sandbox checkout handshake verified;
 *        no settlement implied".
 *      production credentials are NEVER create/query-tested (§2.2).
 *  - live_certified is ONLY ever set by an explicit owner certify-live action
 *    with non-empty recorded evidence, gated on the account's EXPLICIT
 *    production posture (config.environment === 'production', F-2/A9-R2 —
 *    NOT on a sandbox handshake, which §2.2 forbids on production creds),
 *    with an append-only payment_account_verifications row AND an AuditLog
 *    entry (§2.3). No code path in this service self-declares it.
 *  - Cooldown (§2.1): an explicit credentials check (credentials_check or
 *    sandbox_create_query) younger than 30 minutes returns the cached verdict
 *    with zero provider traffic; the ≤2 grant+refresh rolling-hour budget lives
 *    in bkash-tokenized.service (429 CREDENTIAL_CHECK_RATE_LIMITED before any
 *    HTTP).
 *
 * Every provider interaction in this module ships exercised ONLY by
 * official-doc-shaped contract mocks (R-12); with BKASH_ENABLED=false (the
 * shipped default) the gateway branches return honest format/disabled verdicts
 * or 503s and make zero network calls.
 */

const { PaymentConfig, PaymentTransaction, UserShop, AuditLog } = require('../entities');
const { AppError } = require('../../utils/AppError');
const taxonomy = require('./payment-taxonomy');
const accountsService = require('./payment-accounts.service');
const tokenized = require('./bkash-tokenized.service');

const {
    normalizeProvider,
    accountTypeFromCredentials,
    providerFromCredentials,
    maxVerificationLevel,
    canReachLevel,
    credentialsComplete,
    isAutomatable,
    WALLET_ONLY_VERIFICATION_NOTICE,
    SANDBOX_NO_SETTLEMENT_COPY,
    GATEWAY_ACCOUNT_TYPE,
} = taxonomy;

const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // §2.1
const CHECK_METHODS = ['credentials_check', 'sandbox_create_query'];
// BD wallet-number format (same shape the legacy validator admits).
const BD_NUMBER_RE = /^01[3-9]\d{8}$/;

const gatewayClient = tokenized.client;

const isAppError = (err) => err instanceof AppError;

function requireAccount(accountId, shopId) {
    return PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
}

/** Membership + explicit owner role for ladder writes (§2.3 owner-only). */
async function requireOwner(userId, shopId) {
    const userShop = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true },
    });
    if (!userShop) throw new AppError('You do not have access to this shop', 403);
    const role = String(userShop.role || '').toLowerCase();
    if (role && role !== 'owner') {
        throw new AppError('Only the shop owner can act on payment verification', 403, 'OWNER_ONLY');
    }
    return userShop;
}

async function latestCheckRecord(accountId, shopId) {
    const records = await accountsService.readVerificationRecords(accountId, shopId);
    return (records || []).find((r) => CHECK_METHODS.includes(r.method)) || null;
}

// ── verify-credentials (the ONLY grant-bearing settings action, §2.1) ─────────
async function verifyPaymentAccount(shopId, userId, accountId) {
    await accountsService._private.verifyShopAccess(userId, shopId);
    const account = await requireAccount(accountId, shopId);
    if (!account) throw new AppError('Payment account not found', 404);

    const provider = normalizeProvider(account.provider)
        || providerFromCredentials(account.credentials, account.gateway);
    const accountType = account.account_type
        || accountTypeFromCredentials(account.credentials, provider);
    const currentLevel = account.verification_level || 'unverified';
    const ceiling = maxVerificationLevel(provider, accountType);

    if (provider === 'cod') {
        throw new AppError('COD accounts have no provider credentials to check', 400, 'NOTHING_TO_VERIFY');
    }

    // ── wallets: Nagad/Rocket and bKash self|business — ZERO provider contact ──
    if (provider !== 'bkash' || accountType !== GATEWAY_ACCOUNT_TYPE) {
        const walletOnly = taxonomy.WALLET_ONLY_PROVIDERS.includes(provider);
        if (walletOnly) {
            // §2 exact copy + no API calls, ever, for these providers.
            return {
                status: 'verification_unavailable',
                automated: false,
                provider_contact: false,
                verification_level: currentLevel,
                max_level: ceiling,
                message: WALLET_ONLY_VERIFICATION_NOTICE.en,
                provider_notice: WALLET_ONLY_VERIFICATION_NOTICE,
            };
        }
        // bKash self/business wallet: format validation only (§7 row 1).
        const number = String(account.credentials?.mfs_number || account.credentials?.phone || '').replace(/[\s-]/g, '');
        const formatOk = BD_NUMBER_RE.test(number);
        return {
            status: formatOk ? 'format_validated' : 'format_invalid',
            automated: false,
            provider_contact: false,
            verification_level: currentLevel,
            max_level: ceiling,
            message: formatOk
                ? 'Number format validated — not a provider check'
                : 'Wallet number does not match the expected BD format — nothing was sent to the provider.',
        };
    }

    // ── bKash merchant_gateway ────────────────────────────────────────────────
    if (!credentialsComplete(account)) {
        throw new AppError(
            'bKash merchant_gateway credentials require app_key, app_secret and username',
            400, 'GATEWAY_CREDENTIALS_INCOMPLETE',
        );
    }
    if (!canReachLevel(provider, accountType, 'sandbox_verified') && !canReachLevel(provider, accountType, 'live_certified')) {
        throw new AppError('This account kind cannot reach provider verification', 409, 'LADDER_CEILING');
    }

    // 30-min cooldown → cached verdict, zero network (§2.1).
    const last = await latestCheckRecord(accountId, shopId);
    if (last && last.created_at && (Date.now() - new Date(last.created_at).getTime()) < CHECK_COOLDOWN_MS) {
        const ageMs = Date.now() - new Date(last.created_at).getTime();
        return {
            status: 'cached_verdict',
            cached: true,
            verdict: last.evidence?.outcome || last.method,
            method: last.method,
            provider_contact: false,
            cooldown_remaining_seconds: Math.ceil((CHECK_COOLDOWN_MS - ageMs) / 1000),
            verification_level: currentLevel,
            message: 'A credentials check ran within the last 30 minutes — returning its recorded verdict. No new provider contact was made.',
        };
    }

    const environment = tokenized.resolveEnvironment(account);
    const levelAtCheck = currentLevel;
    const flagOn = String(process.env.BKASH_ENABLED) === 'true';
    if (!flagOn) {
        // R-12: in this deployment the flag is false by default; a provider
        // check must not happen and must not be implied.
        return {
            status: 'automation_disabled',
            provider_contact: false,
            verification_level: currentLevel,
            environment,
            message: 'Provider credential checks are disabled in this deployment (BKASH_ENABLED is not "true"); credentials were validated locally only.',
        };
    }

    try {
        if (environment === 'sandbox') {
            // D-3: grant → create → query, invoice echo; NO production creds,
            // NO PaymentTransaction row, NO settlement claim.
            const handshake = await gatewayClient.sandboxCreateQueryHandshake(account);
            const ok = handshake.grantOk && handshake.createOk && handshake.queryOk && handshake.invoiceEcho;
            if (ok) {
                const promoted = await accountsService.writeLadderLevel(accountId, 'sandbox_verified');
                await accountsService.appendVerificationRecord({
                    paymentAccountId: accountId,
                    level: 'sandbox_verified',
                    method: 'sandbox_create_query',
                    performedByUserId: userId,
                    providerEnvironment: 'sandbox',
                    evidence: {
                        outcome: 'sandbox_handshake_ok',
                        settlement: false,
                        no_settlement_implied: true,
                        copy: SANDBOX_NO_SETTLEMENT_COPY.en,
                        invoice_echo: true,
                        payment_id: handshake.paymentId,
                    },
                });
                return {
                    status: 'sandbox_verified',
                    provider_contact: true,
                    verification_level: 'sandbox_verified',
                    account: promoted,
                    // D-3 mandated copy (§2.2):
                    message: 'sandbox checkout handshake verified; no settlement implied',
                };
            }
            await accountsService.appendVerificationRecord({
                paymentAccountId: accountId,
                level: currentLevel,
                method: 'credentials_check',
                performedByUserId: userId,
                providerEnvironment: 'sandbox',
                evidence: {
                    outcome: 'sandbox_handshake_incomplete',
                    create_ok: handshake.createOk,
                    query_ok: handshake.queryOk,
                    invoice_echo: handshake.invoiceEcho,
                    settlement: false,
                },
            });
            return {
                status: 'sandbox_handshake_incomplete',
                provider_contact: true,
                verification_level: currentLevel,
                message: 'bKash granted the token but the sandbox create→query handshake did not complete; the ladder was not raised.',
            };
        }

        // production: grant only — create/query on production credentials is
        // never part of a credential check (§2.2).
        await gatewayClient.grantToken(account, { force: true });
        const fresh = await PaymentConfig.findByPk(accountId);
        const level = fresh?.verification_level || currentLevel;
        // The record attests the CURRENT level — a grant never raises the
        // ladder above configured_unverified (§2.1), so the ledger stays honest.
        await accountsService.appendVerificationRecord({
            paymentAccountId: accountId,
            level,
            method: 'credentials_check',
            performedByUserId: userId,
            providerEnvironment: 'production',
            evidence: {
                outcome: 'credentials_valid',
                ladder_note: 'Grant success never raises the ladder above configured_unverified (§2.1).',
                settlement: false,
            },
        });
        if (level === 'unverified') {
            await accountsService.writeLadderLevel(accountId, 'configured_unverified');
        }
        return {
            status: 'credentials_valid',
            provider_contact: true,
            verification_level: level === 'unverified' ? 'configured_unverified' : level,
            message: 'bKash accepted your app credentials (one of 2 hourly checks used).',
        };
    } catch (error) {
        // Budget refusal is not a provider verdict — propagate for 429.
        if (isAppError(error) && error.code === 'CREDENTIAL_CHECK_RATE_LIMITED') throw error;
        // F-3 (A9-R2): fail-closed rate-limit-state outage is OUR unavailability,
        // not a provider verdict — propagate the honest 503, never a 502.
        if (isAppError(error) && error.code === 'GRANT_BUDGET_UNAVAILABLE') throw error;
        // Sandbox-only guard / kind gates propagate as-is (409/400).
        if (isAppError(error) && ['SANDBOX_ONLY_OPERATION', 'GATEWAY_DISABLED', 'GATEWAY_CREDENTIALS_INCOMPLETE', 'CREDENTIAL_CHECK_UNSUPPORTED'].includes(error.code)) {
            throw error;
        }
        const httpStatus = typeof error?.grantHttpStatus === 'number' ? error.grantHttpStatus : error?.response?.status;
        if (httpStatus === 401 || httpStatus === 403) {
            await accountsService.appendVerificationRecord({
                paymentAccountId: accountId,
                level: levelAtCheck,
                method: 'credentials_check',
                performedByUserId: userId,
                providerEnvironment: environment,
                evidence: { outcome: 'credentials_invalid', http_status: httpStatus, settlement: false },
            });
            return {
                status: 'credentials_invalid',
                provider_contact: true,
                verification_level: levelAtCheck,
                message: 'bKash rejected the stored app credentials (app_key/app_secret/username/password). No ladder change was made.',
            };
        }
        throw new AppError('bKash provider unreachable — no verdict was recorded', 502, 'PROVIDER_UNREACHABLE');
    }
}

// ── certify-live: recorded, never self-declared (§2.3, A9-R2 ruling) ─────────
//
// F-2(a) (A9-R2, 2026-11-26): the old "sandbox_verified is a prerequisite"
// rule contradicted §2.2 — the sandbox create→query handshake may NEVER run
// on production credentials, yet live_certified describes a PRODUCTION
// posture. A production-only merchant (no sandbox app issued) could therefore
// never certify, while the ladder silently gated automation. New contract:
//  (i)   account.config.environment MUST be EXPLICITLY recorded 'production'
//        (unset/legacy or sandbox rows are refused with an honest 400 — the
//        certification attests production posture, so the posture must be
//        written down, not guessed from env fallbacks);
//  (ii)  owner role + >=3-char evidence — unchanged;
//  (iii) any non-archived rung is certifiable FROM the production posture
//        (unverified / configured_unverified / sandbox_verified all qualify);
//        an already live_certified row is refused idempotently, and unknown/
//        archived rungs are refused loudly.
// The recorded providerEnvironment is the ACTUAL resolved environment of the
// account — never a hardcode — asserted equal to the explicit config value
// before anything is written.
const CERTIFIABLE_RUNGS = ['unverified', 'configured_unverified', 'sandbox_verified'];

async function certifyLiveAccount(shopId, userId, accountId, evidence) {
    await requireOwner(userId, shopId);
    const account = await requireAccount(accountId, shopId);
    if (!account) throw new AppError('Payment account not found', 404);

    const provider = normalizeProvider(account.provider)
        || providerFromCredentials(account.credentials, account.gateway);
    const accountType = account.account_type
        || accountTypeFromCredentials(account.credentials, provider);

    if (!canReachLevel(provider, accountType, 'live_certified')) {
        // self/business wallets and Nagad/Rocket can never reach this rung (§2).
        throw new AppError(
            WALLET_ONLY_PROVIDERS_MSG(provider),
            409, 'LADDER_CEILING',
        );
    }

    // (i) EXPLICIT production posture required (F-2(a)): no resolveEnvironment
    // env-var fallback may mint a certification — the row itself must say so.
    const explicitEnvironment = String(account?.config?.environment ?? '').trim().toLowerCase();
    if (explicitEnvironment !== 'production') {
        throw new AppError(
            explicitEnvironment === 'sandbox'
                ? 'This account is recorded as a SANDBOX environment — live certification describes production posture. Switch the account to production (this demotes the ladder) and certify with production evidence.'
                : 'The account environment is not explicitly recorded as "production" (legacy rows must be re-saved with config.environment="production" before they can be live-certified). Nothing was recorded.',
            400, 'PROVIDER_ENVIRONMENT_NOT_PRODUCTION',
        );
    }
    // Honest ledger guard: the recorded environment must be the ACTUAL resolved
    // one, not a hardcode — refuse to write a self-inconsistent attestation.
    const resolvedEnvironment = tokenized.resolveEnvironment(account);
    if (resolvedEnvironment !== explicitEnvironment) {
        throw new AppError(
            'Account environment mismatch between config and resolution — certification aborted, nothing was recorded',
            500, 'PROVIDER_ENVIRONMENT_MISMATCH',
        );
    }

    // (iii) rung gate: certifiable FROM any non-archived rung; the old
    // sandbox_verified prerequisite is REMOVED (see header).
    const levelBefore = account.verification_level || 'unverified';
    if (levelBefore === 'live_certified') {
        throw new AppError(
            'This account is already live-certified — submit a new certification only after a credential/environment change demotes it.',
            409, 'ALREADY_LIVE_CERTIFIED',
        );
    }
    if (!CERTIFIABLE_RUNGS.includes(levelBefore)) {
        throw new AppError(
            `Verification level "${levelBefore}" is not certifiable`,
            409, 'LADDER_STATE_NOT_CERTIFIABLE',
        );
    }

    const evidenceText = typeof evidence === 'string' ? evidence.trim() : '';
    if (evidenceText.length < 3 || evidenceText.length > 500) {
        throw new AppError('A non-empty live-certification evidence reference (3–500 chars) is required', 400, 'INVALID_EVIDENCE');
    }

    await accountsService.writeLadderLevel(accountId, 'live_certified');
    await accountsService.appendVerificationRecord({
        paymentAccountId: accountId,
        level: 'live_certified',
        method: 'certify_live',
        performedByUserId: userId,
        // NOT a hardcode — resolved + asserted equal to config above (F-2(a)).
        providerEnvironment: resolvedEnvironment,
        evidence: {
            evidence: evidenceText,
            source: 'owner_recorded',
            self_declared: false,
            note: 'live_certified is a recorded provider/owner act; the app never declares it (§2.3, R-12, A9-R2: prerequisite is EXPLICIT production posture, not a sandbox handshake).',
        },
    });
    await AuditLog.create({
        user_id: userId,
        shop_id: shopId,
        action: 'payment_account_live_certified',
        resource_type: 'payment_account',
        resource_id: accountId,
        metadata: {
            evidence: evidenceText,
            level_before: levelBefore,
            provider_environment: resolvedEnvironment,
        },
        idempotency_key: `payment-live-cert:${accountId}:${new Date().toISOString()}`,
    });

    const serialized = accountsService.serializeAccount(account);
    return {
        success: true,
        verification_level: 'live_certified',
        account: { ...serialized, verification_level: 'live_certified' },
        message: 'Live certification recorded against owner evidence and audit. Automated checkout additionally remains gated on BKASH_ENABLED.',
    };
}

function WALLET_ONLY_PROVIDERS_MSG(provider) {
    if (taxonomy.WALLET_ONLY_PROVIDERS.includes(provider)) return WALLET_ONLY_VERIFICATION_NOTICE.en;
    return 'This account kind cannot be live-certified; only bKash merchant_gateway accounts can (§2, §2.3).';
}

// ── refund (owner-only, §4.5) ────────────────────────────────────────────────
async function refundPaymentTransaction(shopId, userId, transactionId, payload = {}) {
    await requireOwner(userId, shopId);
    const txn = await PaymentTransaction.findOne({ where: { id: transactionId, shop_id: shopId } });
    if (!txn) throw new AppError('Payment transaction not found', 404);
    if (!['paid', 'verified'].includes(txn.status)) {
        throw new AppError('Only a confirmed payment can be refunded through the gateway', 409, 'NOT_REFUNDABLE');
    }
    // F-6 (A9-R2, 2026-11-26): double-submit guard. The refund record lives
    // inside gateway_response.refund; once a SUCCESSFUL entry is there, a
    // second submission must be refused BEFORE any provider call — otherwise
    // a double-click / retry issues a second v2 refund against the same
    // payment (the row stays 'paid', so the status guard alone never stops it).
    const gr = txn.gateway_response && typeof txn.gateway_response === 'object' ? txn.gateway_response : {};
    const priorRefund = gr.refund && typeof gr.refund === 'object' ? gr.refund : null;
    if (priorRefund) {
        const priorStatus = String(priorRefund.status || '').trim().toLowerCase();
        const alreadyRecorded = priorRefund.refund_id != null
            || ['refunded', 'success', 'successful', 'completed'].includes(priorStatus);
        if (alreadyRecorded) {
            throw new AppError(
                'A refund has already been recorded for this payment — the provider was not contacted again.',
                409, 'REFUND_ALREADY_RECORDED',
            );
        }
    }
    if (txn.payment_gateway !== 'bkash' || !txn.payment_account_id) {
        // Self-MFS claims settle by merchant judgment, not by API — refunds
        // there are manual wallet transfers and are never pretended here.
        throw new AppError(
            'This payment was not captured through the bKash merchant gateway. Refund it manually from your wallet and keep the record in your books.',
            409, 'REFUND_NOT_SUPPORTED',
        );
    }

    const basis = txn.verified_at || txn.updated_at || txn.created_at;
    if (basis && (Date.now() - new Date(basis).getTime()) > tokenized.REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        throw new AppError('bKash refunds are only available within 60 days of settlement', 409, 'REFUND_WINDOW_EXPIRED');
    }

    const account = await PaymentConfig.findOne({ where: { id: txn.payment_account_id, shop_id: shopId } });
    if (!account) throw new AppError('Payment account not found', 404, 'PAYMENT_ACCOUNT_NOT_FOUND');
    if (!isAutomatable(account)) {
        // Honest inert state (R-12): never simulate a refund.
        throw new AppError(
            'Gateway refunds require a live_certified bKash merchant account with the gateway enabled — nothing was sent to the provider.',
            503, 'GATEWAY_AUTOMATION_DISABLED',
        );
    }

    // (gr already loaded above for the F-6 double-submit guard)
    const trxId = gr.trxID || gr.trxId || null;
    if (!trxId) {
        throw new AppError(
            'The provider transaction id is missing from this record; refund it through bKash merchant support instead.',
            409, 'REFUND_EVIDENCE_MISSING',
        );
    }

    const result = await gatewayClient.refundPayment(account, {
        paymentId: txn.transaction_id,
        trxId,
        refundAmount: txn.amount,
        reason: payload?.reason,
    });
    const refundId = result?.refundTrxID || result?.refundID || result?.refundId || null;
    await txn.update({
        gateway_response: {
            ...gr,
            refund: {
                refund_id: refundId,
                amount: txn.amount,
                status: 'refunded',
                submitted_at: new Date().toISOString(),
                source: 'tokenized_v2_refund',
            },
        },
    });
    await AuditLog.create({
        user_id: userId,
        shop_id: shopId,
        action: 'payment_transaction_refund',
        resource_type: 'payment_transaction',
        resource_id: txn.id,
        metadata: { order_id: txn.order_id, refund_id: refundId, amount: txn.amount },
        idempotency_key: `payment-refund:${txn.id}:${refundId || 'submitted'}`,
    });
    return {
        success: true,
        refund_id: refundId,
        message: 'Refund submitted to bKash. Provider completion is tracked via Query — the record shows your submission, not a provider-declared success.',
    };
}

module.exports = {
    verifyPaymentAccount,
    certifyLiveAccount,
    refundPaymentTransaction,
    _private: { requireOwner, latestCheckRecord, CHECK_COOLDOWN_MS, BD_NUMBER_RE },
};
