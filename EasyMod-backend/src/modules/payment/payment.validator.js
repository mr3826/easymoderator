const Joi = require('joi');
const {
    PROVIDERS,
    ACCOUNT_TYPES,
    ADVANCE_POLICIES,
} = require('./payment-taxonomy');

/**
 * Validator for COD payment confirmation
 */
const confirmCodPaymentValidator = Joi.object({
    orderId: Joi.string()
        .uuid()
        .required()
        .messages({
            'string.guid': 'Order ID must be a valid UUID',
            'any.required': 'Order ID is required',
            'string.empty': 'Order ID is required'
        })
});

/**
 * Validator for saving payment configuration
 */
const savePaymentConfigValidator = Joi.object({
    gateway: Joi.string()
        .valid('cod', 'self-mfs', 'bkash', 'nagad', 'rocket')
        .required()
        .messages({
            'any.only': 'Invalid payment gateway',
            'any.required': 'Gateway is required',
            'string.empty': 'Gateway is required'
        }),
    is_enabled: Joi.boolean()
        .optional()
        .messages({
            'boolean.base': 'is_enabled must be a boolean'
        }),
    credentials: Joi.object()
        .optional()
        .messages({
            'object.base': 'Credentials must be an object'
        }),
    config: Joi.object()
        .optional()
        .messages({
            'object.base': 'Config must be an object'
        })
});

/**
 * Canonical account create/update (multi-account, D-1/D-8). Deep credential
 * validation is owned by the service (kind-aware); this guards the shape.
 */
const savePaymentAccountValidator = Joi.object({
    provider: Joi.string().valid(...PROVIDERS).required()
        .messages({ 'any.only': 'provider must be one of: ' + PROVIDERS.join(', ') }),
    account_type: Joi.string().valid(...ACCOUNT_TYPES).required()
        .messages({ 'any.only': 'account_type must be one of: ' + ACCOUNT_TYPES.join(', ') }),
    is_enabled: Joi.boolean().optional(),
    credentials: Joi.object().allow(null).optional(),
    config: Joi.object().optional(),
});

const updatePaymentAccountValidator = Joi.object({
    is_enabled: Joi.boolean().optional(),
    credentials: Joi.object().allow(null).optional(),
    config: Joi.object().optional(),
});

const accountIdParamValidator = Joi.object({
    accountId: Joi.string().uuid().required().messages({ 'string.guid': 'accountId must be a UUID' }),
});

const verifyCredentialsValidator = Joi.object({}); // account-scoped, no body

// Owner-only live_certification (§2.3) — requires a non-empty evidence reference.
const certifyLiveValidator = Joi.object({
    evidence: Joi.string().trim().min(3).max(500).required()
        .messages({
            'string.empty': 'A live-certification evidence reference is required',
            'any.required': 'A live-certification evidence reference is required',
            'string.min': 'evidence must be at least 3 characters',
            'string.max': 'evidence must be at most 500 characters',
        }),
    provider_environment: Joi.string().valid('production').optional(),
});

// Preference is a pure path action (§6 / D-8): PUT /accounts/:id/preferred.
const preferredValidator = Joi.object({});

/**
 * Payment policy body (§5.2). Kept PERMISSIVE at the boundary (unknown → passthrough)
 * so both the canonical keys and the legacy FE aliases (advancePaymentRule /
 * advancePercentage / advanceFixed / paymentMessage) reach the service, which is
 * the authority on cross-field rules and returns the 400s the FE now surfaces.
 */
const paymentPolicyBodyValidator = Joi.object({
    advance_policy: Joi.string().valid(...ADVANCE_POLICIES).optional(),
    advance_value: Joi.number().integer().allow(null).optional(),
    payment_message: Joi.string().max(500).allow('').allow(null).optional(),
    // legacy aliases (mapped by the service):
    advancePaymentRule: Joi.string().allow(null).optional(),
    advancePercentage: Joi.number().integer().allow(null).optional(),
    advanceFixed: Joi.number().integer().allow(null).optional(),
    paymentMessage: Joi.string().allow('').allow(null).optional(),
}).unknown(true);

const transactionIdParamValidator = Joi.object({
    id: Joi.string().uuid().required().messages({ 'string.guid': 'transaction id must be a UUID' }),
});

/**
 * F-7 (A9-R2, 2026-11-26): POST /api/payment/claims edge validation.
 * Previously the route had NO body validator, so a malformed orderId reached
 * the service raw and a non-UUID string could surface as a 500 from the DB
 * driver instead of an honest 400. This is EDGE-SHAPE ONLY — every business
 * rule (normalization, prose-guard, tenant check, server amount authority,
 * duplicate race handling) STAYS in payment-claim.service (defense in depth,
 * not migration; the chatbot path calls performClaim directly and relies on
 * those service guards alone).
 *
 * Field names accept both the API-canonical camelCase and the snake_case the
 * service tolerates (§3.2 payload). The trx-id pattern mirrors the service's
 * TRXID_PATTERN (^[A-Z0-9]{6,16}$) applied to real-world uppercase TrxIDs;
 * the service remains the authority that normalizes and re-validates.
 */
const CLAIM_TRXID_PATTERN = /^[A-Z0-9]{6,16}$/;
const createSelfMfsClaimValidator = Joi.object({
    orderId: Joi.string().uuid(),
    order_id: Joi.string().uuid(),
    trxId: Joi.string().trim().pattern(CLAIM_TRXID_PATTERN),
    trx_id: Joi.string().trim().pattern(CLAIM_TRXID_PATTERN),
    // optional sender — never an OTP; kept a plain string, phone semantics
    // belong to the service (normalizeSenderPhone).
    senderPhone: Joi.string().trim().max(20).allow('', null),
    sender_phone: Joi.string().trim().max(20).allow('', null),
    sender_number: Joi.string().trim().max(20).allow('', null),
    screenshotUrl: Joi.string().uri().max(2048).allow('', null),
    screenshot_url: Joi.string().uri().max(2048).allow('', null),
    customerMessage: Joi.string().trim().max(500).allow('', null),
    customer_message: Joi.string().trim().max(500).allow('', null),
    message: Joi.string().trim().max(500).allow('', null),
    provider: Joi.string().trim().max(40).allow('', null),
    provider_hint: Joi.string().trim().max(40).allow('', null),
})
    .or('orderId', 'order_id')
    .or('trxId', 'trx_id')
    .messages({
        'object.or': 'Both an order id (orderId) and a transaction id (trxId) are required',
        'object.base': 'Claim payload must be an object',
    });

const refundValidator = Joi.object({
    reason: Joi.string().trim().max(500).allow('', null).optional(),
});

module.exports = {
    confirmCodPaymentValidator,
    savePaymentConfigValidator,
    savePaymentAccountValidator,
    updatePaymentAccountValidator,
    accountIdParamValidator,
    verifyCredentialsValidator,
    certifyLiveValidator,
    preferredValidator,
    paymentPolicyBodyValidator,
    transactionIdParamValidator,
    refundValidator,
    createSelfMfsClaimValidator,
};
