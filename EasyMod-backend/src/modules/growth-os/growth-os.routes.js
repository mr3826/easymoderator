'use strict';

const express = require('express');
const { ipKeyGenerator, rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { authenticate } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const { AppError } = require('../../utils/AppError');
const config = require('../../config/config');
const { requireGrowthOsAccess } = require('./growth-os.middleware');
const { hasProspectReadAccess } = require('./growth-os.prospect.scope');
const ctrl = require('./growth-os.controller');
const roleCtrl = require('./growth-os.roles.controller');
const prospectCtrl = require('./growth-os.prospect.controller');
const prospectValidator = require('./growth-os.prospect.validator');
const workspaceCtrl = require('./growth-os.workspace.controller');
const usersCtrl = require('./growth-os.users.controller');
const adminCtrl = require('./growth-os.admin.controller');
const workValidator = require('./growth-os.work.validator');

const router = express.Router();
const growthAuthenticate = typeof authenticate.withOptions === 'function'
  ? authenticate.withOptions({ requireShopMembership: false })
  : authenticate;

const prospectMutationPermissions = [
  'growth_os.prospects.manage_all',
  'growth_os.prospects.update_assigned',
];

// B6 (A9-R3, 2026-11-26): F-7's global validate.middleware change re-tagged
// boundary-shape 400s from the AppError default 'INTERNAL_ERROR' to
// 'VALIDATION_ERROR' — which silently made these re-taggers dead for their
// intended path and changed the DOCUMENTED wire contract
// (docs/growth-os/EXECUTION_STATE.md: GROWTH_OS_{PROSPECT,WORK}_INVALID_INPUT
// for validator-shape rejections). Both codes are matched now, so the edge
// keeps its stable codes regardless of the middleware's generic label.
function validateProspect(schema) {
  const middleware = validate(schema);
  return (req, res, next) => middleware(req, res, (error) => {
    if (error instanceof AppError && (error.code === 'INTERNAL_ERROR' || error.code === 'VALIDATION_ERROR')) {
      error.code = 'GROWTH_OS_PROSPECT_INVALID_INPUT';
      error.status = 400;
    }
    next(error);
  });
}

function validateWork(schema) {
  const middleware = validate(schema);
  return (req, res, next) => middleware(req, res, (error) => {
    if (error instanceof AppError && (error.code === 'INTERNAL_ERROR' || error.code === 'VALIDATION_ERROR')) {
      error.code = 'GROWTH_OS_WORK_INVALID_INPUT';
      error.status = 400;
    }
    next(error);
  });
}

function buildRateLimitStore(prefix) {
  try {
    const { rateLimitRedis } = require('../../config/redis');
    if (rateLimitRedis && rateLimitRedis._isMemoryFallback !== true
      && typeof rateLimitRedis.call === 'function') {
      return new RedisStore({
        prefix,
        sendCommand: (...args) => rateLimitRedis.call(...args),
      });
    }
  } catch (_error) {
    // Express's unit-process MemoryStore is the safe fallback.
  }
  return undefined;
}

function requireDistributedRateLimit(req, res, next) {
  if (config.env === 'development' || config.env === 'test') return next();
  try {
    const { rateLimitRedis } = require('../../config/redis');
    if (rateLimitRedis && rateLimitRedis._isMemoryFallback !== true
      && rateLimitRedis.status === 'ready') return next();
  } catch (_error) {
    // Fall through to the fail-closed response below.
  }
  return next(new AppError(
    'Growth OS rate limiting is temporarily unavailable.',
    503,
    'GROWTH_OS_RATE_LIMIT_UNAVAILABLE',
  ));
}

function growthRateLimitKey(req) {
  if (req.user?.userId) return `user:${req.user.userId}`;
  return `ip:${ipKeyGenerator(req.ip || '0.0.0.0', 56)}`;
}

const prospectLookupRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('rl:growth-os:prospects:'),
  keyGenerator: growthRateLimitKey,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many Growth OS prospect lookups. Please try again later.',
  },
});

const prospectLookupLimiter = (req, res, next) => requireDistributedRateLimit(
  req,
  res,
  (error) => (error ? next(error) : prospectLookupRateLimit(req, res, next)),
);

const growthReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('rl:growth-os:reads:'),
  keyGenerator: growthRateLimitKey,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many Growth OS reads. Please try again later.',
  },
});

const growthReadLimiter = (req, res, next) => requireDistributedRateLimit(
  req,
  res,
  (error) => (error ? next(error) : growthReadRateLimit(req, res, next)),
);

// All Growth OS/admin mutations are keyed to the authenticated user (with an
// IPv6-safe IP fallback for defensive direct middleware use), closing audit
// finding SEC-03 without allowing address rotation to bypass a user quota.
const growthMutationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('rl:growth-os:mutations:'),
  keyGenerator: growthRateLimitKey,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many Growth OS mutations. Please slow down.',
  },
});

const growthMutationLimiter = (req, res, next) => requireDistributedRateLimit(
  req,
  res,
  (error) => (error ? next(error) : growthMutationRateLimit(req, res, next)),
);

router.use(growthAuthenticate, requireGrowthOsAccess());
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/session', ctrl.getSession);
router.post('/roles', growthMutationLimiter, requireGrowthOsAccess('growth_os.roles.manage'), roleCtrl.grantRole);
router.delete('/roles/:userId', growthMutationLimiter, requireGrowthOsAccess('growth_os.roles.manage'), roleCtrl.revokeRole);

router.get(
  '/prospect-owners',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.eligibleAssignees),
  prospectCtrl.listEligibleAssignees,
);

router.get(
  '/prospects',
  growthReadLimiter,
  requireGrowthOsAccess(hasProspectReadAccess),
  validateProspect(prospectValidator.listProspects),
  prospectCtrl.listProspects,
);

router.post(
  '/prospects',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.createProspect),
  prospectCtrl.createProspect,
);

router.post(
  '/prospects/duplicate-check',
  prospectLookupLimiter,
  requireGrowthOsAccess(hasProspectReadAccess),
  validateProspect(prospectValidator.duplicateCheck),
  prospectCtrl.checkDuplicates,
);

router.get(
  '/prospects/:id',
  growthReadLimiter,
  requireGrowthOsAccess(hasProspectReadAccess),
  validateProspect(prospectValidator.idParams),
  prospectCtrl.getProspect,
);

router.patch(
  '/prospects/:id',
  growthMutationLimiter,
  requireGrowthOsAccess(prospectMutationPermissions),
  validateProspect(prospectValidator.updateProspect),
  prospectCtrl.updateProspect,
);

router.post(
  '/prospects/:id/status',
  growthMutationLimiter,
  requireGrowthOsAccess(prospectMutationPermissions),
  validateProspect(prospectValidator.transitionProspect),
  prospectCtrl.transitionProspect,
);

router.post(
  '/prospects/:id/assign',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.assignProspect),
  prospectCtrl.assignProspect,
);

router.post(
  '/prospects/:id/link',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.linkProspect),
  prospectCtrl.linkProspect,
);

router.get(
  '/prospects/:id/linkage-suggestions',
  prospectLookupLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.linkageSuggestions),
  prospectCtrl.linkageSuggestions,
);

router.post(
  '/prospects/:id/merge',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.prospects.manage_all'),
  validateProspect(prospectValidator.mergeProspect),
  prospectCtrl.mergeProspect,
);

// ── Growth workspace read models ────────────────────────────────────────────

router.get(
  '/home',
  growthReadLimiter,
  requireGrowthOsAccess(hasProspectReadAccess),
  workspaceCtrl.home,
);

router.get(
  '/analytics/growth',
  growthReadLimiter,
  requireGrowthOsAccess(['growth_os.reports.read_all', 'growth_os.reports.read_source_scope']),
  validateWork(workValidator.workspace.analytics),
  workspaceCtrl.analytics,
);

router.post(
  '/search',
  prospectLookupLimiter,
  requireGrowthOsAccess('growth_os.search.read'),
  validateWork({ body: workValidator.workspace.search.query }),
  workspaceCtrl.search,
);

// ── Follow-ups and internal notes ───────────────────────────────────────────

router.get(
  '/followups',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.followups.manage'),
  validateWork(workValidator.followups.list),
  workspaceCtrl.listFollowups,
);

router.post(
  '/followups',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.followups.manage'),
  validateWork(workValidator.followups.create),
  workspaceCtrl.createFollowup,
);

router.patch(
  '/followups/:id',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.followups.manage'),
  validateWork(workValidator.followups.update),
  workspaceCtrl.updateFollowup,
);

router.post(
  '/followups/:id/status',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.followups.manage'),
  validateWork(workValidator.followups.transition),
  workspaceCtrl.transitionFollowup,
);

router.get(
  '/notes',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.notes.manage'),
  validateWork(workValidator.notes.list),
  workspaceCtrl.listNotes,
);

router.post(
  '/notes',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.notes.manage'),
  validateWork(workValidator.notes.create),
  workspaceCtrl.createNote,
);

router.post(
  '/notes/:id/delete',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.notes.manage'),
  validateWork(workValidator.notes.delete),
  workspaceCtrl.deleteNote,
);

// ── Merchant surface: shared read path (view shape chosen server-side) ──────

router.get(
  '/merchants',
  growthReadLimiter,
  requireGrowthOsAccess(['growth_os.admin.merchants.read', 'growth_os.merchants.read_insight']),
  validateWork(workValidator.merchantsAdmin.list),
  adminCtrl.listMerchants,
);

router.get(
  '/merchants/:shopId',
  growthReadLimiter,
  requireGrowthOsAccess(['growth_os.admin.merchants.read', 'growth_os.merchants.read_insight']),
  validateWork(workValidator.merchantsAdmin.shopId),
  adminCtrl.merchantDetail,
);

// ── Admin Control Plane (SUPER_ADMIN permissions, default-deny) ─────────────

router.get(
  '/admin/users',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.admin.users.read'),
  validateWork(workValidator.usersAdmin.list),
  usersCtrl.listGrowthUsers,
);

router.post(
  '/admin/users/search',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.admin.users.read'),
  validateWork(workValidator.usersAdmin.search),
  usersCtrl.listGrowthUsers,
);

router.post(
  '/admin/users',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.create),
  usersCtrl.createGrowthUser,
);

router.post(
  '/admin/users/:userId/status',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.status),
  usersCtrl.setUserStatus,
);

router.post(
  '/admin/users/:userId/role',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.role),
  usersCtrl.changeUserRole,
);

router.post(
  '/admin/users/:userId/revoke-access',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.reasonOnly),
  usersCtrl.revokeUserAccess,
);

router.post(
  '/admin/users/:userId/reset-password',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.reasonOnly),
  usersCtrl.resetUserPassword,
);

router.post(
  '/admin/users/:userId/revoke-sessions',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.users.manage'),
  validateWork(workValidator.usersAdmin.reasonOnly),
  usersCtrl.revokeUserSessions,
);

router.post(
  '/admin/merchants/:shopId/status',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.merchants.mutate'),
  validateWork(workValidator.merchantsAdmin.status),
  adminCtrl.setMerchantStatus,
);

router.post(
  '/admin/merchants/:shopId/grant-credits',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.merchants.mutate'),
  validateWork(workValidator.merchantsAdmin.credits),
  adminCtrl.grantMerchantCredits,
);

router.post(
  '/admin/merchants/:shopId/channels/:channelId/reconnect-request',
  growthMutationLimiter,
  requireGrowthOsAccess('growth_os.admin.merchants.mutate'),
  validateWork(workValidator.merchantsAdmin.channelReconnect),
  adminCtrl.requestChannelReconnect,
);

router.get(
  '/admin/operations',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.admin.operations.read'),
  validateWork(workValidator.merchantsAdmin.operations),
  adminCtrl.operations,
);

router.get(
  '/admin/audit',
  growthReadLimiter,
  requireGrowthOsAccess('growth_os.admin.audit.read'),
  validateWork(workValidator.merchantsAdmin.auditList),
  adminCtrl.auditLogs,
);

module.exports = router;
