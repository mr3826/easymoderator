const express = require('express');
const router = express.Router();
const deliveryController = require('./delivery.controller');
const { deliveryValidators } = require('./delivery.validator');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner } = require('../../middleware/shop-permission.middleware');
const validate = require('../../middleware/validate.middleware');

// All delivery routes require authentication
router.use(authenticate);
router.use(verifyShopAccess);

// Pickup locations are shop-scoped records. Reads are available to shop
// members; creating, editing, deleting, and selecting a default require owner
// access just like provider configuration.
router.get('/pickup', deliveryController.listPickupLocations);
router.get('/pickup-locations', deliveryController.listPickupLocations);
router.get('/pickup/:locationId', deliveryController.getPickupLocation);
router.get('/pickup-locations/:locationId', deliveryController.getPickupLocation);
router.post('/pickup', requireOwner, deliveryController.createPickupLocation);
router.post('/pickup-locations', requireOwner, deliveryController.createPickupLocation);
router.patch('/pickup/:locationId', requireOwner, deliveryController.updatePickupLocation);
router.patch('/pickup-locations/:locationId', requireOwner, deliveryController.updatePickupLocation);
router.put('/pickup/:locationId', requireOwner, deliveryController.updatePickupLocation);
router.put('/pickup-locations/:locationId', requireOwner, deliveryController.updatePickupLocation);
router.put('/pickup-locations', requireOwner, deliveryController.updatePickupLocation);
router.delete('/pickup/:locationId', requireOwner, deliveryController.deletePickupLocation);
router.delete('/pickup-locations/:locationId', requireOwner, deliveryController.deletePickupLocation);
router.post('/pickup/:locationId/default', requireOwner, deliveryController.setDefaultPickupLocation);
router.post('/pickup-locations/:locationId/default', requireOwner, deliveryController.setDefaultPickupLocation);
router.put('/pickup/:locationId/default', requireOwner, deliveryController.setDefaultPickupLocation);
router.put('/pickup-locations/:locationId/default', requireOwner, deliveryController.setDefaultPickupLocation);

// Provider activation/default aliases. The legacy /toggle endpoint below is
// retained for the existing merchant client.
router.get('/readiness', deliveryController.getProviderReadiness);
router.get('/:provider/readiness', deliveryController.getProviderReadiness);
router.get('/ai-default', deliveryController.getAiDefaultProvider);
router.post('/ai-default', requireOwner, deliveryController.setAiDefaultProvider);
router.put('/ai-default', requireOwner, deliveryController.setAiDefaultProvider);
router.delete('/ai-default', requireOwner, deliveryController.clearAiDefaultProvider);
router.post('/:provider/activate', requireOwner, deliveryController.activateProvider);
router.post('/:provider/deactivate', requireOwner, deliveryController.deactivateProvider);
router.post('/:provider/ai-default', requireOwner, deliveryController.setAiDefaultProvider);
router.put('/:provider/ai-default', requireOwner, deliveryController.setAiDefaultProvider);
router.delete('/:provider/ai-default', requireOwner, deliveryController.clearAiDefaultProvider);
router.post('/activate', requireOwner, deliveryController.activateProvider);
router.post('/deactivate', requireOwner, deliveryController.deactivateProvider);
router.post('/:provider/pickup', requireOwner, deliveryController.setPickupConfiguration);
router.put('/:provider/pickup', requireOwner, deliveryController.setPickupConfiguration);
router.post('/:provider/pickup/sync', requireOwner, deliveryController.syncProviderPickup);

// Pathao's city -> zone -> area lookup is read-only but still bound to the
// authenticated shop's connected integration.
router.get('/:provider/cities', deliveryController.getProviderCities);
router.get('/:provider/cities/:cityId/zones', deliveryController.getProviderZones);
router.get('/:provider/zones/:zoneId/areas', deliveryController.getProviderAreas);
router.get('/:provider/areas', deliveryController.getProviderAreas);

/**
 * GET /shop/delivery/settings
 * Get delivery provider settings for the shop
 */
router.get(
    '/settings',
    deliveryController.getSettings
);

/**
 * PUT /shop/delivery/settings
 * Update delivery settings for the shop
 */
router.put(
    '/settings',
    requireOwner,
    validate(deliveryValidators.updateSettings),
    deliveryController.updateSettings
);

/**
 * POST /shop/delivery/connect
 * Connect a delivery provider
 */
router.post(
    '/connect',
    requireOwner,
    validate(deliveryValidators.connectProvider),
    deliveryController.connectProvider
);

/**
 * POST /shop/delivery/disconnect
 * Disconnect a delivery provider
 */
router.post(
    '/disconnect',
    requireOwner,
    validate(deliveryValidators.disconnectProvider),
    deliveryController.disconnectProvider
);

/**
 * POST /shop/delivery/toggle
 * Toggle provider active status
 */
router.post(
    '/toggle',
    requireOwner,
    validate(deliveryValidators.toggleProvider),
    deliveryController.toggleProvider
);

/**
 * POST /shop/delivery/test
 * Test provider connection
 */
router.post(
    '/test',
    requireOwner,
    validate(deliveryValidators.disconnectProvider), // Reuse same validation (just needs provider)
    deliveryController.testConnection
);

/**
 * GET /shop/delivery/:provider/stores
 * Get stores for a provider (Pathao only)
 */
router.get(
    '/:provider/stores',
    requireOwner,
    deliveryController.getProviderStores
);

router.post(
    '/:provider/stores/sync',
    requireOwner,
    deliveryController.getProviderStores
);

router.get(
    '/:provider/stores/sync',
    requireOwner,
    deliveryController.getProviderStores
);

/**
 * PUT /shop/delivery/:provider/metadata
 * Update provider metadata
 */
router.put(
    '/:provider/metadata',
    requireOwner,
    validate(deliveryValidators.updateMetadata),
    deliveryController.updateMetadata
);

module.exports = router;
