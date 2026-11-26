const express = require('express');
const paymentController = require('./payment.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner, requireOwnerOrAdmin } = require('../../middleware/shop-permission.middleware');
const {
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
} = require('./payment.validator');
const validate = require('../../middleware/validate.middleware');

const router = express.Router();

// D-9 (contract §7 row 10, ratified with the dead-surface deletion): the old
// `paymentCallbackAuth` middleware array built HMAC/IP/POST-only guards that
// were applied to NO route — dead security theater. There are still no
// payment-callback routes here: inbound bKash confirmation is served by
// /api/webhooks/bkash/payment-status (webhook.middleware transport gate + the
// mandatory server-side Query evidence chain, §4.2). The unused middleware
// module (src/middleware/payment-callback-auth.middleware.js) and its test
// were removed together with this array; if a future callback ever lands on
// THIS router, wire real guards to a real route in the same PR.

// Payment configuration routes (require authentication)
router.get('/config', authenticate, paymentController.getPaymentConfigs);
router.post('/config', authenticate, verifyShopAccess, requireOwner, validate(savePaymentConfigValidator), paymentController.savePaymentConfig);
router.post('/config/test', authenticate, verifyShopAccess, requireOwner, validate(savePaymentConfigValidator), paymentController.testPaymentConnection);
router.delete('/config/:gateway', authenticate, verifyShopAccess, requireOwner, paymentController.deletePaymentConfig);

// COD payment confirmation (requires authentication)
router.post('/cod/confirm', authenticate, verifyShopAccess, requireOwnerOrAdmin, validate(confirmCodPaymentValidator), paymentController.confirmCodPayment);

// ── Canonical multi-account API (A5) ──────────────────────────────────────────
// One row = one account keyed (shop, provider, account_type). The legacy /config
// routes above keep working for the §1.4 compat window; these are the redesign
// surface the Payment Methods tab uses. Owner-only for writes (requireOwner).
router.get('/accounts', authenticate, verifyShopAccess, paymentController.getPaymentAccounts);
router.post('/accounts', authenticate, verifyShopAccess, requireOwner, validate(savePaymentAccountValidator), paymentController.savePaymentAccount);
router.get('/accounts/:accountId', authenticate, verifyShopAccess, validate({ params: accountIdParamValidator }), paymentController.getPaymentAccount);
router.patch('/accounts/:accountId', authenticate, verifyShopAccess, requireOwner, validate({ params: accountIdParamValidator, body: updatePaymentAccountValidator }), paymentController.updatePaymentAccount);
router.delete('/accounts/:accountId', authenticate, verifyShopAccess, requireOwner, validate({ params: accountIdParamValidator }), paymentController.deletePaymentAccount);

// Preference — DB truth, owner write, exactly one per shop (D-8; replaces the
// old platform_priority['bkash','cod'] PUT-shape which is now display-order only).
router.put('/accounts/:accountId/preferred', authenticate, verifyShopAccess, requireOwner, validate({ params: accountIdParamValidator, body: preferredValidator }), paymentController.setPreferredAccount);

// Verification ladder actions dispatch to the A3 ladder service (routes hold no
// logic). verify-credentials is the ONLY grant-bearing action (§2.1); nothing
// else here touches a provider. certify-live records owner evidence only (§2.3).
router.post('/accounts/:accountId/verify-credentials', authenticate, verifyShopAccess, requireOwner, validate({ params: accountIdParamValidator, body: verifyCredentialsValidator }), paymentController.verifyPaymentAccountCredentials);
router.post('/accounts/:accountId/certify-live', authenticate, verifyShopAccess, requireOwner, validate({ params: accountIdParamValidator, body: certifyLiveValidator }), paymentController.certifyLiveAccount);

// ── Policies API (A5, §5.2) — one write pair for the Payment Policies tab ──────
// Registered here (mounted at /api/payment) per contract §8.3 KNOWN_PATHS. PUT is
// the R-14 canonical write; PATCH is accepted as an alias for the same handler so
// the §5.2 draft path/method both resolve without introducing dual authority.
router.get('/policy', authenticate, verifyShopAccess, paymentController.getPaymentPolicy);
router.put('/policy', authenticate, verifyShopAccess, requireOwner, validate({ body: paymentPolicyBodyValidator }), paymentController.updatePaymentPolicy);
router.patch('/policy', authenticate, verifyShopAccess, requireOwner, validate({ body: paymentPolicyBodyValidator }), paymentController.updatePaymentPolicy);

// ── Transaction actions (dispatch to A3 gateway service, §4.5) ─────────────────
router.post('/transactions/:id/refund', authenticate, verifyShopAccess, requireOwner, validate({ params: transactionIdParamValidator, body: refundValidator }), paymentController.refundPaymentTransaction);

// ── Self-MFS claim (dispatch to A4, §3.2) — created during checkout, not a settings UI ──
router.post('/claims', authenticate, verifyShopAccess, paymentController.createSelfMfsClaim);


module.exports = router;
