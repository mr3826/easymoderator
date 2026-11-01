'use strict';

const express = require('express');
const { AppError } = require('../../utils/AppError');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { MAX_CSV_BYTES, schemas, validate } = require('./ads-studio.validator');
const controller = require('./ads-studio.controller');

const router = express.Router();

async function requireAdsStudioEnabled(req, _res, next) {
    const shopId = req.user?.shopId;
    if (!shopId || !req.activeMembership || String(req.activeMembership.shop_id) !== String(shopId)) {
        return next(new AppError('An authenticated shop membership is required', 403, 'SHOP_ACCESS_REQUIRED'));
    }

    let features;
    try {
        const pilotFeatures = require('../pilot-features/pilot-features.service');
        if (typeof pilotFeatures.getPilotFeaturesStrict !== 'function') throw new Error('Pilot feature gate unavailable');
        features = await pilotFeatures.getPilotFeaturesStrict(shopId);
    } catch (_) {
        return next(new AppError('Ads Studio eligibility is temporarily unavailable', 503, 'ADS_STUDIO_GATE_UNAVAILABLE'));
    }
    if (features?.adsStudio !== true) {
        return next(new AppError('Ads Studio is not enabled for this shop', 409, 'FEATURE_DISABLED'));
    }

    try {
        const addons = require('../shop-addons/shop-addons.service');
        if (typeof addons.assertAddonEnabled !== 'function') throw new Error('Shop add-on gate unavailable');
        const enabled = await addons.assertAddonEnabled(shopId, 'ADS_STUDIO');
        if (enabled === false) return next(new AppError('Ads Studio add-on is not enabled for this shop', 409, 'ADDON_DISABLED'));
        return next();
    } catch (error) {
        if (error instanceof AppError || (Number.isInteger(error?.status) && error.status < 500)) return next(error);
        return next(new AppError('Ads Studio add-on status is temporarily unavailable', 503, 'ADS_STUDIO_GATE_UNAVAILABLE'));
    }
}

router.use(authenticate);
router.use(verifyShopAccess);
router.use(requireAdsStudioEnabled);

router.get('/reports', validate(schemas.listReports), controller.listReports);
router.post(
    '/reports/import',
    express.text({ type: ['text/csv', 'text/plain'], limit: MAX_CSV_BYTES }),
    validate(schemas.importReport),
    controller.importReport,
);
router.get('/reports/:reportId', validate(schemas.getReport), controller.getReport);

router.get('/drafts', validate(schemas.listDrafts), controller.listDrafts);
router.post('/drafts', validate(schemas.createDraft), controller.createDraft);
router.patch('/drafts/:draftId', validate(schemas.updateDraft), controller.updateDraft);
router.post('/drafts/:draftId/approve', validate(schemas.approveDraft), controller.approveDraft);

module.exports = router;
