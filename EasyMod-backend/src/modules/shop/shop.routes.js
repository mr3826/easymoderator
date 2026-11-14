const express = require('express');
const Joi = require('joi');
const shopController = require('./shop.controller');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner } = require('../../middleware/shop-permission.middleware');
const {
    shopCreateValidator,
    shopUpdateValidator,
    shopGetValidator,
    addUserValidator,
    removeUserValidator,
    updateRoleValidator,
    shopBusinessInfoValidator
} = require('./shop.validator');

const router = express.Router();

// Optional operator note for the emergency stop (audited, never customer-facing).
const emergencyStopBody = Joi.object({
    reason: Joi.string().trim().max(500).allow('', null).messages({
        'string.max': 'reason must be at most 500 characters',
    }),
}).unknown(false).default({});
const recoveryAuthenticate = typeof authenticate.withOptions === 'function'
  ? authenticate.withOptions({ requireShopMembership: false })
  : authenticate;

// GET /shop/list - Get all shops for user
router.get('/list', recoveryAuthenticate, shopController.getUserShops);

// POST /shop/create - Create new shop
router.post('/create', recoveryAuthenticate, shopCreateValidator, shopController.createShop);

// All remaining shop routes require active membership for the token's shop.
router.use(authenticate);

// GET /shop/me - Get current shop context (RESTful alias for /shop/get)
router.get('/me', shopController.getShop);

// POST /shop/update - Update shop
router.post('/update', verifyShopAccess, requireOwner, shopUpdateValidator, shopController.updateShop);

// POST /shop/delete - Delete shop
router.post('/delete', shopGetValidator, shopController.deleteShop);

// POST /shop/add-user - Add user to shop
router.post('/add-user', addUserValidator, shopController.addUserToShop);

// POST /shop/remove-user - Remove user from shop
router.post('/remove-user', removeUserValidator, shopController.removeUserFromShop);

// POST /shop/update-role - Update user role
router.post('/update-role', updateRoleValidator, shopController.updateUserRole);

// GET /shop/business-info - Get business info for current shop
router.get('/business-info', shopController.getBusinessInfo);

// PUT /shop/business-info - Update business info for current shop
router.put('/business-info', verifyShopAccess, requireOwner, shopBusinessInfoValidator, shopController.updateBusinessInfo);

// GET /shop/onboarding/status - Server-computed first-launch checklist
router.get('/onboarding/status', shopController.getOnboardingStatus);

// POST /shop/onboarding/complete - Complete only after required checklist passes
router.post('/onboarding/complete', verifyShopAccess, requireOwner, shopController.completeOnboarding);

// GET /shop/llm-config - Get LLM model configuration for this shop
router.get('/llm-config', shopController.getLLMConfig);

// PUT /shop/llm-config - Update LLM model configuration
router.put('/llm-config', verifyShopAccess, requireOwner, shopController.updateLLMConfig);

// GET /shop/ai-settings - Get AI behaviour settings
router.get('/ai-settings', shopController.getAISettings);

// PUT /shop/ai-settings - Update AI behaviour settings
router.put('/ai-settings', verifyShopAccess, requireOwner, shopController.updateAISettings);

// POST /shop/ai/emergency-stop - Business-wide, bypass-proof AI stop (OWNER)
router.post('/ai/emergency-stop', verifyShopAccess, requireOwner, validate({ body: emergencyStopBody }), shopController.engageAiEmergencyStop);

// POST /shop/ai/emergency-resume - Source-aware resume; mode stays MANUAL (OWNER)
router.post('/ai/emergency-resume', verifyShopAccess, requireOwner, shopController.resumeAiEmergencyStop);

// GET /shop/ai-settings/intent-thresholds - Get per-intent confidence thresholds
router.get('/ai-settings/intent-thresholds', shopController.getIntentThresholds);

// PUT /shop/ai-settings/intent-thresholds - Update per-intent confidence thresholds
router.put('/ai-settings/intent-thresholds', verifyShopAccess, requireOwner, shopController.updateIntentThresholds);

// GET /shop/settings/ai-defaults - Return canonical AI defaults for the current launch scope.
router.get('/settings/ai-defaults', shopController.getAiDefaults);

// POST /shop/branding-preset - Apply a named branding preset (FRIENDLY | PROFESSIONAL | FUN)
router.post('/branding-preset', verifyShopAccess, requireOwner, shopController.applyBrandingPreset);

// GET /shop/bd-settings - Get BD-specific settings (MFS, Google Sheets)
router.get('/bd-settings', shopController.getBdSettings);

// PUT /shop/bd-settings - Update BD-specific settings
router.put('/bd-settings', verifyShopAccess, requireOwner, shopController.updateBdSettings);

// GET /shop/agents - List team members for the current shop (used by inbox assignment)
router.get('/agents', shopController.getShopAgents);

// GET /shop/platform-priority - Get payment/delivery platform priority order
router.get('/platform-priority', shopController.getPlatformPriority);

// PUT /shop/platform-priority - Update payment/delivery platform priority order
router.put('/platform-priority', verifyShopAccess, requireOwner, shopController.updatePlatformPriority);

// GET /shop/ai-diagnostics - Debug auto-reply: queue stats, channel settings, recent policy denials
router.get('/ai-diagnostics', shopController.getAIDiagnostics);

module.exports = router;
