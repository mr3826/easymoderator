const express = require('express');
const rateLimit = require('express-rate-limit');
const paymentController = require('./payment.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner, requireOwnerOrAdmin } = require('../../middleware/shop-permission.middleware');
const {
    paymentGatewayIpAllowlist,
    paymentCallbackHmacVerify,
    paymentCallbackPostOnly
} = require('../../middleware/payment-callback-auth.middleware');
const {
    confirmCodPaymentValidator,
    savePaymentConfigValidator
} = require('./payment.validator');
const validate = require('../../middleware/validate.middleware');

const router = express.Router();

const paymentCallbackRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many callback requests, please retry later.'
    }
});

// Payment callback middleware: IP allowlist + POST only (applied to all callback routes)
const paymentCallbackAuth = [
    paymentCallbackRateLimiter,
    paymentCallbackPostOnly,
    paymentGatewayIpAllowlist,
    paymentCallbackHmacVerify
];

// Payment configuration routes (require authentication)
router.get('/config', authenticate, paymentController.getPaymentConfigs);
router.post('/config', authenticate, verifyShopAccess, requireOwner, validate(savePaymentConfigValidator), paymentController.savePaymentConfig);
router.post('/config/test', authenticate, verifyShopAccess, requireOwner, validate(savePaymentConfigValidator), paymentController.testPaymentConnection);
router.delete('/config/:gateway', authenticate, verifyShopAccess, requireOwner, paymentController.deletePaymentConfig);

// COD payment confirmation (requires authentication)
router.post('/cod/confirm', authenticate, verifyShopAccess, requireOwnerOrAdmin, validate(confirmCodPaymentValidator), paymentController.confirmCodPayment);


module.exports = router;
