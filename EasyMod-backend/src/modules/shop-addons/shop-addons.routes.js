'use strict';

const express = require('express');
const Joi = require('joi');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwnerOrAdmin } = require('../../middleware/shop-permission.middleware');
const { validate } = require('../helpers');
const controller = require('./shop-addons.controller');

const router = express.Router();
router.use(authenticate, verifyShopAccess);

router.get('/', controller.getShopAddons);
router.put('/:addonCode', requireOwnerOrAdmin, validate({
    params: Joi.object({ addonCode: Joi.string().valid('ADS_STUDIO', 'STOREFRONT').required() }),
    body: Joi.object({ enabled: Joi.boolean().required() }).required().unknown(false),
}), controller.setShopAddon);

module.exports = router;
