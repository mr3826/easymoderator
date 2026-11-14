'use strict';

/**
 * Top-Up Controller
 *
 * ADR-0011 retired conversation top-ups: there is no subscription and no
 * conversation entitlement. Purchase/checkout endpoints return 410 Gone so old
 * clients get an explicit refusal. Top-up history remains readable because it
 * is a historical financial record.
 *
 * Endpoints:
 *   GET  /subscription/topup/packs       — 410 (retired catalog)
 *   POST /subscription/topup/initiate    — 410 (purchase retired)
 *   POST /subscription/topup/complete    — 410 (checkout retired)
 *   GET  /subscription/topup/history     — paginated historical read
 */

const topupService = require('./topup.service');

const GONE_BODY = {
    success: false,
    code: 'TOPUP_PROGRAMME_RETIRED',
    message: 'Conversation top-ups are retired. All shops are billed per delivered order.',
};

const getPacks = (req, res) => res.status(410).json(GONE_BODY);

const initiateTopup = (req, res) => res.status(410).json(GONE_BODY);

const completeTopup = (req, res) => res.status(410).json(GONE_BODY);

const getHistory = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = parseInt(req.query.offset, 10) || 0;
        const data = await topupService.getTopupHistory(shopId, limit, offset);
        res.json({ success: true, data });
    } catch (err) { next(err); }
};

module.exports = { getPacks, initiateTopup, completeTopup, getHistory };