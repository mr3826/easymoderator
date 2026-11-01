'use strict';

const { AppError } = require('../../utils/AppError');
const adsStudioService = require('./ads-studio.service');

function context(req) {
    const shopId = req.user?.shopId;
    const userId = req.user?.userId;
    const membershipShopId = req.activeMembership?.shop_id;
    if (!shopId || !userId || !membershipShopId || String(membershipShopId) !== String(shopId)) {
        throw new AppError('An authenticated shop membership is required', 403, 'SHOP_ACCESS_REQUIRED');
    }
    return { shopId, userId };
}

function respond(handler, status = 200) {
    return async (req, res, next) => {
        try {
            const result = await handler(req, context(req));
            return res.status(status).json({ success: true, data: result });
        } catch (error) {
            return next(error);
        }
    };
}

const listReports = respond((_req, { shopId }) => adsStudioService.listReports(shopId));
const importReport = respond((req, { shopId, userId }) => adsStudioService.importManualReport(shopId, userId, req.body), 201);
const getReport = respond((req, { shopId }) => adsStudioService.getReport(shopId, req.params.reportId));
const listDrafts = respond((_req, { shopId }) => adsStudioService.listDrafts(shopId));
const createDraft = respond((req, { shopId, userId }) => adsStudioService.createDraft(shopId, userId, req.body), 201);
const updateDraft = respond((req, { shopId }) => adsStudioService.updateDraft(shopId, req.params.draftId, req.body));
const approveDraft = respond((req, { shopId, userId }) => adsStudioService.approveDraft(shopId, userId, req.params.draftId));

module.exports = { listReports, importReport, getReport, listDrafts, createDraft, updateDraft, approveDraft };
