const { body, param } = require('express-validator');

const shopCreateValidator = [
    body('shop_name')
        .trim()
        .notEmpty().withMessage('Shop name is required')
        .isLength({ min: 2, max: 100 }).withMessage('Shop name must be 2–100 characters'),
    body('phone')
        .optional()
        .trim()
        .matches(/^01[3-9]\d{8}$/).withMessage('Phone must be a valid Bangladeshi mobile number (e.g. 01712345678)'),
    body('address')
        .optional()
        .trim()
        .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
    body('shop_type')
        .optional()
        .isIn(['retail', 'wholesale', 'f-commerce', 'service', 'other'])
        .withMessage('shop_type must be one of: retail, wholesale, f-commerce, service, other')
];

const shopUpdateValidator = [
    body('shopId')
        .notEmpty()
        .withMessage('Shop ID is required')
        .isUUID()
        .withMessage('Invalid shop ID'),
    body('shop_name')
        .optional()
        .trim(),
    body('address')
        .optional()
        .trim(),
    body('phone')
        .optional()
        .trim(),
    body('opening_hours')
        .optional()
        .trim(),
    body('delivery_areas')
        .optional()
        .trim(),
    body('payment_methods')
        .optional()
        .trim(),
    body('logo')
        .optional()
        .trim(),
    body('banner_image')
        .optional()
        .trim(),
    body('shop_images')
        .optional()
        .isArray()
        .withMessage('Shop images must be an array')
];

const shopGetValidator = [
    body('shopId')
        .notEmpty()
        .withMessage('Shop ID is required')
        .isUUID()
        .withMessage('Invalid shop ID')
];

const addUserValidator = [
    body('shopId')
        .notEmpty()
        .withMessage('Shop ID is required')
        .isUUID()
        .withMessage('Invalid shop ID'),
    body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
    body('role')
        .isIn(['admin', 'staff'])
        .withMessage('Role must be either admin or staff')
];

const removeUserValidator = [
    body('shopId')
        .notEmpty()
        .withMessage('Shop ID is required')
        .isUUID()
        .withMessage('Invalid shop ID'),
    body('userId')
        .notEmpty()
        .withMessage('User ID is required')
        .isUUID()
        .withMessage('Invalid user ID')
];

const updateRoleValidator = [
    body('shopId')
        .notEmpty()
        .withMessage('Shop ID is required')
        .isUUID()
        .withMessage('Invalid shop ID'),
    body('userId')
        .notEmpty()
        .withMessage('User ID is required')
        .isUUID()
        .withMessage('Invalid user ID'),
    body('role')
        .isIn(['admin', 'staff'])
        .withMessage('Role must be either admin or staff')
];

const shopBusinessInfoValidator = [
    body('shopName')
        .optional()
        .trim(),
    // nameEn is DISPLAY metadata — shopName remains THE authoritative identity
    // (single-shop-name sync contract unchanged; nameEn never flows to
    // shops.shop_name).
    body('nameEn')
        .optional()
        .trim()
        .isLength({ max: 120 })
        .withMessage('English shop name must not exceed 120 characters'),
    body('tagline')
        .optional()
        .trim()
        .isLength({ max: 160 })
        .withMessage('Tagline must not exceed 160 characters'),
    // Customer-facing contact address ONLY: never login identity, never
    // credentials, zero auth coupling. RFC-lite shape + 254-char cap.
    body('email')
        .optional({ checkFalsy: false })
        .trim()
        .if((value) => typeof value === 'string' && value.trim() !== '')
        .matches(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/)
        .withMessage('email must be a valid email address')
        .bail()
        .if((value) => typeof value === 'string')
        .isLength({ max: 254 })
        .withMessage('email must not exceed 254 characters'),
    body('city')
        .optional()
        .trim()
        .isLength({ max: 60 })
        .withMessage('City must not exceed 60 characters'),
    body('address')
        .optional()
        .trim(),
    body('phone')
        .optional()
        .trim(),
    body('openingHours')
        .optional()
        .trim(),
    body('additionalInfo')
        .optional()
        .trim()
        .isLength({ max: 3000 })
        .withMessage('Additional info must not exceed 3000 characters'),
    body('deliveryAreas')
        .optional()
        .isArray()
        .withMessage('Delivery areas must be an array'),
    body('deliveryAreas.*')
        .optional()
        .isString()
        .trim(),
    body('paymentMethods')
        .optional()
        .isArray()
        .withMessage('Payment methods must be an array'),
    body('paymentMethods.*')
        .optional()
        .isString()
        .trim()
];

// ── Business policies (20261126_001 redesign) ─────────────────────────────────
// INFORMATIONAL ONLY: this validator (and the writers behind it) never change
// order-cancel/refund/exchange/warranty enforcement — zero automation coupling
// (pinned by src/security/__tests__/business-policies-informational-only.test.js).
// The shape rules are the SINGLE source of truth in shop-settings.validator
// (POLICY_KINDS / POLICY_STANCES / validateBusinessPoliciesBody); this chain
// only wires them to the request. Required LAZILY so module-mock permutations
// of shop-settings.validator (locked-down controller tests) cannot break
// validator construction at import time.

const businessPoliciesValidator = [
    body().custom((value) => require('./shop-settings.validator').validateBusinessPoliciesBody(value)),
];

module.exports = {
    shopCreateValidator,
    shopUpdateValidator,
    shopGetValidator,
    addUserValidator,
    removeUserValidator,
    updateRoleValidator,
    shopBusinessInfoValidator,
    businessPoliciesValidator,
};
