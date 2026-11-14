/**
 * meta-channel.routes.js
 *
 * Canonical Meta channel + OAuth router. Mounted at /api/channels/meta.
 *
 * Routes:
 *   POST   /api/channels/meta/oauth/initiate
 *   POST   /api/channels/meta/oauth/callback
 *   POST   /api/channels/meta/oauth/connect-asset
 *   GET    /api/channels/meta
 *   POST   /api/channels/meta/:channelId/disconnect
 *   POST   /api/channels/meta/:channelId/reconnect
 *   POST   /api/channels/meta/:channelId/test-webhook
 *
 * The OAuth sub-routes MUST be declared before the `/:channelId/...` group so
 * Express does not try to interpret "oauth" as a UUID param.
 */

'use strict';

const express = require('express');
const Joi = require('joi');
const oauthController = require('./meta-oauth.controller');
const channelController = require('./meta-channel.controller');
const v = require('./meta-oauth.validator');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner } = require('../../middleware/shop-permission.middleware');

const router = express.Router();

const unsupportedPageSetting = (key) => Joi.any().forbidden().messages({
    'any.unknown': `${key} is not supported for Page settings; configure the business AI reply mode instead`,
});

// ── Business hours (tightened per ADR-0013 §7) ─────────────────────────────
// Day keys mon..sun; HH:MM; optional IANA timezone; both accepted shapes
// (`{day:{open,close}}` and `{day:[{open,close},...]}`); overnight allowed.
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const businessHoursSlot = Joi.object({
    open: Joi.string().pattern(HHMM_PATTERN).required().messages({
        'string.pattern.base': 'business hours must use HH:MM',
    }),
    close: Joi.string().pattern(HHMM_PATTERN).required().messages({
        'string.pattern.base': 'business hours must use HH:MM',
    }),
}).unknown(false);

const businessHoursDay = Joi.alternatives().try(
    businessHoursSlot,
    Joi.array().items(businessHoursSlot).min(1),
);

const timezoneSchema = Joi.string().custom((value, helpers) => {
    try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return value;
    } catch (_) {
        return helpers.error('any.invalid');
    }
}, 'IANA timezone validation').messages({
    'any.invalid': 'timezone must be a valid IANA timezone',
});

const businessHoursSchema = Joi.object({
    mon: businessHoursDay,
    tue: businessHoursDay,
    wed: businessHoursDay,
    thu: businessHoursDay,
    fri: businessHoursDay,
    sat: businessHoursDay,
    sun: businessHoursDay,
    timezone: timezoneSchema,
}).unknown(false).allow(null);

const overridesSchema = Joi.object({
    automation_mode: Joi.string()
        .valid('AUTO', 'DRAFT', 'MANUAL', 'AI_ACTIVE', 'AI_SUGGEST_ONLY', 'HUMAN_ACTIVE')
        .allow(null),
    confidence_threshold: Joi.number().min(0).max(100).allow(null),
    greeting: Joi.object({
        enabled: Joi.boolean(),
        custom_text: Joi.string().max(500).allow(''),
    }).unknown(false).or('enabled', 'custom_text').allow(null),
}).unknown(false).allow(null);

const channelSettingsPatchBody = Joi.object({
    aiAutoReply: unsupportedPageSetting('aiAutoReply'),
    automationMode: unsupportedPageSetting('automationMode'),
    ai_auto_reply: unsupportedPageSetting('ai_auto_reply'),
    automation_mode: unsupportedPageSetting('automation_mode'),
    overrides: overridesSchema,
    confidenceThresholdSend: Joi.number().min(0).max(1).messages({
        'number.base': 'confidenceThresholdSend must be a number',
        'number.min': 'confidenceThresholdSend must be between 0 and 1',
        'number.max': 'confidenceThresholdSend must be between 0 and 1',
    }),
    confidenceThresholdSuggest: Joi.number().min(0).max(1).messages({
        'number.base': 'confidenceThresholdSuggest must be a number',
        'number.min': 'confidenceThresholdSuggest must be between 0 and 1',
        'number.max': 'confidenceThresholdSuggest must be between 0 and 1',
    }),
    businessHours: businessHoursSchema,
    business_hours: businessHoursSchema,
    allowOrderCreation: Joi.boolean().messages({
        'boolean.base': 'allowOrderCreation must be a boolean',
    }),
    allow_order_creation: Joi.boolean().messages({
        'boolean.base': 'allow_order_creation must be a boolean',
    }),
    purposeLabel: Joi.string().trim().max(64).allow('', null).messages({
        'string.max': 'purposeLabel must be at most 64 characters',
    }),
    purpose_label: Joi.string().trim().max(64).allow('', null).messages({
        'string.max': 'purpose_label must be at most 64 characters',
    }),
});

router.use(authenticate);

// Meta channel state is merchant data. A Growth OS role or authenticated JWT alone
// does not authorize it; every route below requires active membership for the
// shop selected by the JWT, never a body or header shop identifier.
router.use(verifyShopAccess);

// ── OAuth (declared first to avoid /:channelId collision) ──────────────────
router.post('/oauth/initiate', validate(v.initiate), oauthController.initiate);
router.post('/oauth/callback', validate(v.callback), oauthController.callback);
router.post('/oauth/connect-asset', validate(v.connectAsset), oauthController.connectAsset);

// ── Channel lifecycle ─────────────────────────────────────────────────────
router.get('/', channelController.list);
router.post(
    '/:channelId/disconnect',
    validate(v.channelIdParam),
    channelController.disconnect
);
router.post(
    '/:channelId/reconnect',
    validate(v.channelIdParam),
    channelController.reconnect
);
router.post(
    '/:channelId/test-webhook',
    validate(v.channelIdParam),
    channelController.testWebhook
);
router.get(
    '/:channelId/settings',
    validate(v.channelIdParam),
    channelController.getSettings
);
router.patch(
    '/:channelId/settings',
    validate(v.channelIdParam),
    requireOwner,
    validate({ body: channelSettingsPatchBody }),
    channelController.updateChannelSettings
);
router.patch(
    '/:channelId/purpose-label',
    validate(v.updatePurposeLabel),
    channelController.updatePurposeLabel
);
router.get(
    '/:channelId/consent-summary',
    validate(v.channelIdParam),
    channelController.consentSummary
);

module.exports = router;
