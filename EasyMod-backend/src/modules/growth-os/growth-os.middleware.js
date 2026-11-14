'use strict';

const { AppError } = require('../../utils/AppError');
const config = require('../../config/config');
const { cacheRedis } = require('../../config/redis');
const cacheService = require('../../utils/cache.service');
const repository = require('./growth-os.repository');
const {
  getPermissionsForRole,
  hasPermission,
  resolveCanonicalRole,
} = require('./growth-os.permissions');

const ROLE_CACHE_TTL_SECONDS = 60;
const REDIS_PROBE_TIMEOUT_MS = 1000;

async function assertGrowthOsRuntimeReady() {
  // Growth authorization may not silently fall back to a process-local cache
  // in a deployed environment. A stale allow on one instance could survive a
  // role revocation on another instance while Redis is unavailable.
  if (config.env === 'development') return;
  if (!cacheRedis || cacheRedis._isMemoryFallback === true) {
    throw new AppError(
      'Growth OS authorization cache is temporarily unavailable.',
      503,
      'GROWTH_OS_REDIS_UNAVAILABLE',
    );
  }

  if (cacheRedis.status !== 'ready') {
    let timeoutId;
    try {
      if (typeof cacheRedis.ping !== 'function') throw new Error('Redis probe unavailable');
      const probe = Promise.resolve().then(() => cacheRedis.ping());
      const timeout = new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Redis probe timed out')), REDIS_PROBE_TIMEOUT_MS);
        timeoutId.unref?.();
      });
      await Promise.race([probe, timeout]);
    } catch (_error) {
      throw new AppError(
        'Growth OS authorization cache is temporarily unavailable.',
        503,
        'GROWTH_OS_REDIS_UNAVAILABLE',
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  if (cacheRedis.status !== 'ready') {
    throw new AppError(
      'Growth OS authorization cache is temporarily unavailable.',
      503,
      'GROWTH_OS_REDIS_UNAVAILABLE',
    );
  }
}

async function resolveGrowthOsAccess(userId) {
  if (!userId) return null;

  await assertGrowthOsRuntimeReady();

  const cacheKey = `growth-os:user:${userId}:role`;
  const readRoleCache = config.env === 'development' ? cacheService.get : cacheService.getStrict;
  const writeRoleCache = config.env === 'development' ? cacheService.set : cacheService.setStrict;
  const cached = await readRoleCache.call(cacheService, cacheKey);
  if (cached !== null && cached !== undefined) {
    return cached === 'NONE' ? null : buildAccess(cached);
  }

  const roleRecord = await repository.findActiveRoleForUser(userId);
  const role = roleRecord?.role || null;
  await writeRoleCache.call(cacheService, cacheKey, role || 'NONE', ROLE_CACHE_TTL_SECONDS);

  return role ? buildAccess(role) : null;
}

function buildAccess(rawRole) {
  const canonical = resolveCanonicalRole(rawRole);
  if (!canonical) return null;
  return {
    role: canonical,
    rawRole,
    permissions: getPermissionsForRole(rawRole),
  };
}

function getInitialBootstrapState(user) {
  if (user?.bootstrapOperator !== true) return null;
  // A seeded bootstrap operator has no role yet; the only observable state at
  // this layer is that the audited role grant is pending. MFA is not a Growth
  // OS precondition.
  return 'pending';
}

function requireGrowthOsAccess(requiredPermission = 'growth_os.session.read') {
  return async (req, _res, next) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError('Authentication required.', 401, 'AUTH_REQUIRED');
      }

      if (!config.growthOsEnabled) {
        throw new AppError('Growth OS is temporarily unavailable.', 503, 'GROWTH_OS_DISABLED');
      }

      const access = await resolveGrowthOsAccess(userId);
      const permissionRole = access?.rawRole || access?.role;
      const hasRequiredPermission = typeof requiredPermission === 'function'
        ? requiredPermission(access)
        : (Array.isArray(requiredPermission) ? requiredPermission : [requiredPermission])
          .some((permission) => hasPermission(permissionRole, permission));
      if (!access || !hasRequiredPermission) {
        if (!access) {
          // Rotation is enforced one layer below: the temporary session can
          // reach nothing but /auth/change-password, and bootstrapRole
          // refuses un-rotated targets. The only observable bootstrap state at
          // this layer is that the audited role grant is still pending.
          const bootstrapState = getInitialBootstrapState(req.user);
          if (bootstrapState === 'pending') {
            throw new AppError(
              'The initial Growth OS administrator is ready for the audited role grant.',
              403,
              'GROWTH_OS_BOOTSTRAP_PENDING',
            );
          }
        }
        throw new AppError('Forbidden: Growth OS access required.', 403, 'GROWTH_OS_FORBIDDEN');
      }

      // Internal Growth identities are global and must never carry a merchant
      // shop session. Merchant context is authorized by the merchant stack,
      // not by Growth OS role permissions.
      if (req.user.shopId) {
        throw new AppError(
          'Growth OS requests cannot carry merchant shop context.',
          403,
          'GROWTH_OS_MERCHANT_CONTEXT_FORBIDDEN',
        );
      }

      // Growth roles are global internal roles. Authorization is the active
      // role plus the endpoint permission; the server-issued MFA assertion is
      // not required (Founder decision, 2026-11-15). Merchant/frontend claims
      // are never accepted here.
      req.growthOs = access;
      next();
    } catch (err) {
      next(err instanceof AppError
        ? err
        : new AppError(
          'Growth OS authorization service is temporarily unavailable.',
          503,
          'GROWTH_OS_AUTHZ_UNAVAILABLE',
        ));
    }
  };
}

module.exports = {
  resolveGrowthOsAccess,
  requireGrowthOsAccess,
};
