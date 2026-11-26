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
};
