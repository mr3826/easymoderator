'use strict';

const express = require('express');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { getShadowUsage } = require('./ai-reply-shadow-ledger.service');

const router = express.Router();

router.use(authenticate, verifyShopAccess);

router.get('/usage', async (req, res, next) => {
    try {
        const data = await getShadowUsage(req.user.shopId);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
