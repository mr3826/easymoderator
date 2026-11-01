'use strict';

const adminService = require('./admin.service');
const AuditService = require('../audit/audit.service');
const { AppError } = require('../../utils/AppError');

const ok = (res, data) => res.json({ success: true, data });

function auditCtx(req) {
  return { ipAddress: req.ip, userAgent: req.get('user-agent') || null };
}

// ── Reads ──────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res, next) => {
  try { ok(res, await adminService.getDashboard()); } catch (e) { next(e); }
};
exports.getMetaIdentityReadiness = async (req, res, next) => {
  try { ok(res, await adminService.getMetaIdentityReadiness()); } catch (e) { next(e); }
};
exports.getStalePaymentProcessing = async (req, res, next) => {
  try {
    const reconciliationService = require('../payment/payment-processing-reconciliation.service');
    ok(res, await reconciliationService.getStalePaymentProcessingReport({
      olderThanMinutes: req.query.olderThanMinutes,
      limit: req.query.limit,
    }));
  } catch (e) { next(e); }
};
exports.listShops = async (req, res, next) => {
  try { ok(res, await adminService.listShops(req.query)); } catch (e) { next(e); }
};
exports.getShopOverview = async (req, res, next) => {
  try { ok(res, await adminService.getShopOverview(req.params.shopId)); } catch (e) { next(e); }
};
exports.getShopChannels = async (req, res, next) => {
  try { ok(res, await adminService.getShopChannels(req.params.shopId)); } catch (e) { next(e); }
};
exports.getShopBilling = async (req, res, next) => {
  try { ok(res, await adminService.getShopBilling(req.params.shopId)); } catch (e) { next(e); }
};
exports.getAuditLogs = async (req, res, next) => {
  try { ok(res, await adminService.getAuditLogs(req.query)); } catch (e) { next(e); }
};

// ── Mutations (audited) ──────────────────────────────────────────────────────
exports.setShopStatus = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { status } = req.body;
    const { sequelize } = require('../../utils/database/database-setup');
    const after = await sequelize.transaction(async (transaction) => {
      const { before, after: next } = await adminService.setShopStatus(shopId, status, { transaction });
      await AuditService.logOperation({
        userId: req.user.userId, shopId,
        action: status === 'suspended' ? 'admin:suspend_shop' : 'admin:reactivate_shop',
        resourceType: 'SUBSCRIPTION', resourceId: shopId,
        oldValues: before, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, after);
  } catch (e) { next(e); }
};

exports.addCredits = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey) throw new AppError('Idempotency-Key header is required for credit grants.', 400, 'ADMIN_IDEMPOTENCY_REQUIRED');
    const { sequelize } = require('../../utils/database/database-setup');
    const after = await sequelize.transaction(async (transaction) => {
      const { before, after: next } = await adminService.addCredits(shopId, req.body.amount, req.body.reason, {
        idempotencyKey,
        actorUserId: req.user.userId,
        transaction,
      });
      await AuditService.logOperation({
        userId: req.user.userId, shopId, action: 'admin:add_credits',
        resourceType: 'SUBSCRIPTION', resourceId: shopId,
        oldValues: before, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, after);
  } catch (e) { next(e); }
};

exports.changePlan = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { sequelize } = require('../../utils/database/database-setup');
    const after = await sequelize.transaction(async (transaction) => {
      const { before, after: next } = await adminService.changePlan(
        shopId,
        req.user.userId,
        req.body,
        { transaction },
      );
      await AuditService.logOperation({
        userId: req.user.userId, shopId, action: 'admin:change_plan',
        resourceType: 'SUBSCRIPTION', resourceId: shopId,
        oldValues: before, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, after);
  } catch (e) { next(e); }
};

exports.markChannelReconnect = async (req, res, next) => {
  try {
    const { shopId, channelId } = req.params;
    const { sequelize } = require('../../utils/database/database-setup');
    const after = await sequelize.transaction(async (transaction) => {
      const { before, after: next } = await adminService.markChannelReconnect(shopId, channelId, { transaction });
      await AuditService.logOperation({
        userId: req.user.userId, shopId, action: 'admin:mark_reconnect',
        resourceType: 'META_CHANNEL', resourceId: channelId,
        oldValues: before, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, after);
  } catch (e) { next(e); }
};

exports.emergencyDisableAi = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { sequelize } = require('../../utils/database/database-setup');
    const after = await sequelize.transaction(async (transaction) => {
      const { before, after: next } = await adminService.emergencyDisableAi(
        shopId,
        req.user.userId,
        { transaction },
      );
      await AuditService.logOperation({
        userId: req.user.userId, shopId, action: 'admin:emergency_ai_off',
        resourceType: 'SHOP', resourceId: shopId,
        oldValues: before, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, after);
  } catch (e) { next(e); }
};

// ── Pilot features (Customer 360 / Sales Opportunities / Order Confidence) ──
// Platform-controlled per-shop flags (ADR-0009). Never writable by merchants.
const Joi = require('joi');
const pilotFeatures = require('../pilot-features/pilot-features.service');

const shopIdSchema = Joi.string().guid({ version: ['uuidv4', 'uuidv5', 'uuidv1'] }).required();
    const pilotPatchSchema = Joi.object({
        customer_intelligence: Joi.boolean(),
        // Pilot+ V1 flags (platform-controlled; default off).
        interaction_choices: Joi.boolean(),
        action_queue: Joi.boolean(),
        knowledge_suggestions: Joi.boolean(),
        ads_studio: Joi.boolean(),
        storefront: Joi.boolean(),
        ai_reply_shadow_meter: Joi.boolean(),
        order_confidence_mode: Joi.string().valid(...pilotFeatures.ORDER_CONFIDENCE_MODES),
  order_confidence_config: Joi.object({
    high_value_cod_threshold: Joi.number().integer().min(0).max(1000000),
    address_min_length: Joi.number().integer().min(0).max(100),
  }),
}).min(1);

const validShopId = (value) => {
  const { error } = shopIdSchema.validate(value);
  if (error) throw new AppError('Invalid shop id', 400, 'VALIDATION_ERROR');
  return value;
};

exports.getPilotFeatures = async (req, res, next) => {
  try { ok(res, await pilotFeatures.getForAdmin(validShopId(req.params.shopId))); } catch (e) { next(e); }
};

exports.setPilotFeatures = async (req, res, next) => {
  try {
    const shopId = validShopId(req.params.shopId);
    const { error, value } = pilotPatchSchema.validate(req.body || {});
    if (error) throw new AppError(error.message, 400, 'VALIDATION_ERROR');
    const { sequelize } = require('../../utils/database/database-setup');
    const current = await sequelize.transaction(async (transaction) => {
      const { previous, current: next } = await pilotFeatures.setPilotFeatures(
        shopId, value, req.user.userId, { transaction },
      );
      await AuditService.logOperation({
        userId: req.user.userId, shopId, action: 'admin:pilot_features_update',
        resourceType: 'SHOP', resourceId: shopId,
        oldValues: previous, newValues: next, ...auditCtx(req),
      }, { transaction, required: true });
      return next;
    });
    ok(res, current);
  } catch (e) { next(e); }
};

exports.disableAllPilotFeatures = async (req, res, next) => {
  try {
    const { sequelize } = require('../../utils/database/database-setup');
    const result = await sequelize.transaction(async (transaction) => {
      const outcome = await pilotFeatures.disableAll(req.user.userId, { transaction });
      await AuditService.logOperation({
        userId: req.user.userId, shopId: null, action: 'admin:pilot_features_disable_all',
        resourceType: 'OPS', resourceId: 'pilot_features',
        oldValues: null, newValues: outcome, ...auditCtx(req),
      }, { transaction, required: true });
      return outcome;
    });
    ok(res, result);
  } catch (e) { next(e); }
};

// ── Ops alerting self-test (finding F-06) ────────────────────────────────────
// Fires a deliberate, PII-free alert so an operator can confirm a real human
// receives it. Reports which sinks are configured and whether each accepted the
// event. Configuration alone does NOT close launch gate 8 — a person must still
// confirm receipt on a device they watch.
exports.sendTestAlert = async (req, res, next) => {
  try {
    await AuditService.logOperation({
      userId: req.user.userId, shopId: null, action: 'admin:ops_test_alert',
      resourceType: 'OPS', resourceId: null,
      oldValues: null, newValues: { status: 'requested' }, ...auditCtx(req),
    }, { required: true });
    const { sendTestAlert } = require('../../utils/ops-alert');
    const result = await sendTestAlert({ actorLabel: `admin:${req.user.userId}` });
    ok(res, {
      ...result,
      note: result.anySinkConfigured
        ? 'Alert dispatched. Confirm a human received it before treating alerting as verified.'
        : 'No alert sink is configured (SENTRY_DSN / SLACK_ALERT_WEBHOOK_URL). Alerting reaches no one.',
    });
  } catch (e) { next(e); }
};
