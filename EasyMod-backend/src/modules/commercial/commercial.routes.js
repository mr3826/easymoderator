'use strict';

/**
 * Authenticated commercial API (ADR-0011). Every route is JWT-authenticated and
 * shop-scoped by verifyShopAccess; the controller reads req.shop.id only.
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const commercialController = require('./commercial.controller');

router.use(authenticate);
router.use(verifyShopAccess);

router.get('/contract', commercialController.getContract);
router.get('/claims', commercialController.getClaims);
router.get('/billing-lines', commercialController.getBillingLines);

module.exports = router;