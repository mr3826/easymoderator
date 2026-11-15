'use strict';

const { Op } = require('sequelize');
const { validate: isUuid } = require('uuid');
const cacheService = require('../../utils/cache.service');
const { AppError } = require('../../utils/AppError');
const {
  GROWTH_OS_CANONICAL_ROLES,
  LEGACY_GROWTH_OS_ROLES,
  isGrantableGrowthOsRole,
} = require('./growth-os.permissions');
const { invalidateUserSessions } = require('../auth/session-invalidation.service');
const { redactSecretiveValues } = require('./growth-os.audit-sanitizer');

const SUPER_ADMIN_ROLE_VALUES = Object.freeze([
  GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN,
  LEGACY_GROWTH_OS_ROLES.FOUNDER,
]);

const ROLE_CACHE_TTL_SECONDS = 60;
const MAX_REASON_LENGTH = 200;

function assertUuid(value, fieldName) {
  if (!isUuid(String(value || ''))) {
    throw new AppError(`${fieldName} must be a valid user id.`, 400, 'GROWTH_OS_INVALID_USER_ID');
  }
}

function assertNotSelfLockout(actorUserId, targetUserId) {
  if (actorUserId === targetUserId) {
    throw new AppError(
      'A Super Admin cannot lock out their own Growth OS account.',
      403,
      'GROWTH_OS_SELF_LOCKOUT_FORBIDDEN',
    );
  }
}

function normalizeReason(reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized || normalized.length > MAX_REASON_LENGTH) {
    throw new AppError(
      `reason is required and must be ${MAX_REASON_LENGTH} characters or fewer.`,
      400,
      'GROWTH_OS_INVALID_REASON',
    );
  }
  return redactSecretiveValues(normalized);
}

function roleCacheKey(userId) {
  return `growth-os:user:${userId}:role`;
}

async function assertNoActiveMerchantMembership(targetUserId, transaction) {
  const { UserShop } = require('../entities');
  const activeMembership = await UserShop.findOne({
    attributes: ['id'],
    where: { user_id: targetUserId, is_active: true },
    transaction,
  });
  if (activeMembership) {
    throw new AppError(
      'The target user has an active merchant membership. Use an internal account without an active merchant membership for Growth OS access.',
      409,
      'GROWTH_OS_MERCHANT_ROLE_CONFLICT',
    );
  }
}

function assertBootstrapTargetReady(target) {
  if (target.is_active === false) {
    throw new AppError(
      'The initial Growth OS administrator account is inactive.',
      409,
      'GROWTH_OS_BOOTSTRAP_TARGET_INACTIVE',
    );
  }
  if (target.settings?.internal_growth_bootstrap !== true) {
    throw new AppError(
      'The target account was not created by the protected initial-admin seed.',
      409,
      'GROWTH_OS_BOOTSTRAP_TARGET_NOT_SEEDED',
    );
  }
  if (target.must_change_password !== false) {
    throw new AppError(
      'The initial Growth OS administrator must complete password rotation first.',
      409,
      'GROWTH_OS_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED',
    );
  }
}

async function invalidateRoleCache(userId, transaction) {
  try {
    const deleted = await cacheService.delete(roleCacheKey(userId));
    if (deleted !== true) {
      throw new Error('role cache deletion was not confirmed');
    }
  } catch (_error) {
    // The cache is part of the authorization decision. Roll the role change
    // back when it cannot be invalidated, so a stale allow cannot survive a
    // successful mutation.
    throw new AppError(
      'Growth OS authorization cache is temporarily unavailable.',
      503,
      'GROWTH_OS_AUTHZ_CACHE_UNAVAILABLE',
      { transaction: Boolean(transaction) },
    );
  }
}

async function writeAudit({ actorUserId, roleRecord, oldValues, newValues, reason, action, ipAddress, userAgent }, transaction) {
  try {
    // Keep database/model loading lazy. The Growth authorization unit suite
    // exercises denial paths without requiring a local SQLite native binding.
    const { AuditLog } = require('../entities');
    await AuditLog.create({
      user_id: actorUserId,
      shop_id: null,
      action,
      resource_type: 'GROWTH_OS_ROLE',
      resource_id: roleRecord.id,
      old_values: redactSecretiveValues(oldValues),
      new_values: redactSecretiveValues(newValues),
      metadata: {
        source: 'growth_os_role_admin',
        reason: redactSecretiveValues(reason),
        target_user_id: roleRecord.user_id,
      },
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
    }, { transaction });
  } catch (_error) {
    throw new AppError(
      'Growth OS audit service is temporarily unavailable.',
      503,
      'GROWTH_OS_AUDIT_UNAVAILABLE',
    );
  }
}

function safeRole(roleRecord) {
  return {
    id: roleRecord.id,
    userId: roleRecord.user_id,
    role: roleRecord.role,
    grantedAt: roleRecord.granted_at,
    revokedAt: roleRecord.revoked_at || null,
  };
}

async function assertAuthorizedActor(actorUserId, transaction) {
  const { GrowthOsUserRole } = require('../entities');
  const actorRole = await GrowthOsUserRole.findOne({
    attributes: ['id', 'role'],
    where: {
      user_id: actorUserId,
      role: { [Op.in]: SUPER_ADMIN_ROLE_VALUES },
      is_active: true,
      revoked_at: { [Op.is]: null },
    },
    transaction,
    lock: transaction.LOCK?.UPDATE,
  });
  if (!actorRole) {
    throw new AppError(
      'An active Growth OS Super Admin is required to change roles.',
      403,
      'GROWTH_OS_ROLE_ACTOR_FORBIDDEN',
    );
  }
}

async function assertBootstrapActor(actorUserId, transaction) {
  const configuredEmail = String(process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL || '').trim().toLowerCase();
  if (!configuredEmail) {
    throw new AppError(
      'Growth OS bootstrap actor is not configured.',
      503,
      'GROWTH_OS_BOOTSTRAP_NOT_CONFIGURED',
    );
  }

  const { GrowthOsUserRole, User } = require('../entities');
  const { sequelize: db } = require('../../utils/database/database-setup');
  if (db.getDialect?.() === 'postgres' && typeof db.query === 'function') {
    await db.query(
      'SELECT pg_advisory_xact_lock(hashtext(:lockKey))',
      { replacements: { lockKey: 'easymod:growth-os:first-super-admin' }, transaction },
    );
  }
  const actor = await User.findByPk(actorUserId, {
    attributes: ['id', 'email'],
    transaction,
    lock: transaction.LOCK?.UPDATE,
  });
  if (!actor || String(actor.email || '').trim().toLowerCase() !== configuredEmail) {
    throw new AppError(
      'The configured Growth OS bootstrap actor could not be verified.',
      403,
      'GROWTH_OS_BOOTSTRAP_ACTOR_FORBIDDEN',
    );
  }

  const activeSuperAdmin = await GrowthOsUserRole.findOne({
    attributes: ['id'],
    where: {
      role: { [Op.in]: SUPER_ADMIN_ROLE_VALUES },
      is_active: true,
      revoked_at: { [Op.is]: null },
    },
    transaction,
    lock: transaction.LOCK?.UPDATE,
  });
  if (activeSuperAdmin) {
    throw new AppError(
      'Growth OS already has an active Super Admin; use the in-app role controls.',
      409,
      'GROWTH_OS_BOOTSTRAP_COMPLETE',
    );
  }
}

async function grantRole({ actorUserId, targetUserId, role, reason, ipAddress, userAgent, bootstrap = false }) {
  assertUuid(actorUserId, 'actorUserId');
  assertUuid(targetUserId, 'targetUserId');
  if (!isGrantableGrowthOsRole(role)) {
    throw new AppError(
      'role must be SUPER_ADMIN or GROWTH_USER.',
      400,
      'GROWTH_OS_INVALID_ROLE',
    );
  }
  if (!bootstrap && role === GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN && targetUserId === actorUserId) {
    throw new AppError(
      'A Super Admin cannot grant SUPER_ADMIN to themselves.',
      403,
      'GROWTH_OS_SELF_ESCALATION_FORBIDDEN',
    );
  }
  const normalizedReason = normalizeReason(reason);
  const { sequelize } = require('../../utils/database/database-setup');
  const { GrowthOsUserRole, User } = require('../entities');

  return sequelize.transaction(async (transaction) => {
    if (bootstrap) await assertBootstrapActor(actorUserId, transaction);
    else await assertAuthorizedActor(actorUserId, transaction);

    const target = await User.findByPk(targetUserId, {
      attributes: ['id', 'email', 'full_name', 'is_active', 'must_change_password', 'settings'],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!target) {
      throw new AppError('Growth OS role target was not found.', 404, 'GROWTH_OS_ROLE_TARGET_NOT_FOUND');
    }

    await assertNoActiveMerchantMembership(targetUserId, transaction);
    if (bootstrap) assertBootstrapTargetReady(target);

    const existing = await GrowthOsUserRole.findOne({
      where: {
        user_id: targetUserId,
        is_active: true,
        revoked_at: { [Op.is]: null },
      },
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (existing) {
      throw new AppError('The target user already has an active Growth OS role.', 409, 'GROWTH_OS_ROLE_ALREADY_ASSIGNED');
    }

    const roleRecord = await GrowthOsUserRole.create({
      user_id: targetUserId,
      role,
      is_active: true,
      granted_by: actorUserId,
      granted_at: new Date(),
      revoked_by: null,
      revoked_at: null,
      metadata: { source: 'growth_os_role_admin' },
    }, { transaction });

    if (bootstrap) {
      await target.update({
        settings: {
          ...(target.settings && typeof target.settings === 'object' ? target.settings : {}),
          internal_growth_bootstrap: false,
        },
      }, { transaction });
    }

    await writeAudit({
      actorUserId,
      roleRecord,
      oldValues: null,
      newValues: { user_id: targetUserId, role },
      reason: normalizedReason,
      action: 'growth_os:role_granted',
      ipAddress,
      userAgent,
    }, transaction);
    await invalidateInternalSessions(targetUserId, transaction);
    await invalidateRoleCache(targetUserId, transaction);

    return safeRole(roleRecord);
  });
}

async function invalidateInternalSessions(userId, transaction) {
  await invalidateUserSessions(userId, { transaction });
}

async function revokeRole({ actorUserId, targetUserId, reason, ipAddress, userAgent }) {
  assertUuid(actorUserId, 'actorUserId');
  assertUuid(targetUserId, 'targetUserId');
  const normalizedReason = normalizeReason(reason);
  const { sequelize } = require('../../utils/database/database-setup');
  const { GrowthOsUserRole } = require('../entities');

  const result = await sequelize.transaction(async (transaction) => {
    await assertAuthorizedActor(actorUserId, transaction);

    const roleRecord = await GrowthOsUserRole.findOne({
      where: {
        user_id: targetUserId,
        revoked_at: { [Op.is]: null },
      },
      transaction,
      order: [['is_active', 'DESC'], ['granted_at', 'DESC']],
      lock: transaction.LOCK?.UPDATE,
    });
    if (!roleRecord) {
      throw new AppError('The target user has no active Growth OS role.', 404, 'GROWTH_OS_ROLE_NOT_FOUND');
    }

    if (roleRecord.is_active && SUPER_ADMIN_ROLE_VALUES.includes(roleRecord.role)) {
      // PostgreSQL rejects FOR UPDATE on aggregate queries. Lock the active
      // Super Admin (including legacy Founder) rows first, then count the
      // locked result inside this transaction so concurrent revocations
      // cannot remove the last Super Admin or self-lock the console.
      const activeSuperAdmins = await GrowthOsUserRole.findAll({
        attributes: ['id', 'user_id'],
        where: {
          role: { [Op.in]: SUPER_ADMIN_ROLE_VALUES },
          is_active: true,
          revoked_at: { [Op.is]: null },
        },
        transaction,
        lock: transaction.LOCK?.UPDATE,
      });
      assertNotSelfLockout(actorUserId, targetUserId);
      if (activeSuperAdmins.length <= 1) {
        throw new AppError(
          'The last active Growth OS Super Admin cannot be revoked.',
          409,
          'GROWTH_OS_LAST_SUPER_ADMIN',
        );
      }
    }

    const oldValues = { user_id: targetUserId, role: roleRecord.role };
    await roleRecord.update({
      is_active: false,
      revoked_by: actorUserId,
      revoked_at: new Date(),
    }, { transaction });

    await writeAudit({
      actorUserId,
      roleRecord,
      oldValues,
      newValues: { user_id: targetUserId, role: roleRecord.role, is_active: false },
      reason: normalizedReason,
      action: 'growth_os:role_revoked',
      ipAddress,
      userAgent,
    }, transaction);
    await invalidateInternalSessions(targetUserId, transaction);
    await invalidateRoleCache(targetUserId, transaction);

    return safeRole(roleRecord);
  });

  return result;
}

// Temporarily suspend (active -> inactive) or re-activate (inactive ->
// active) the most recent non-revoked role row. This is distinct from
// revoke, which is terminal. The last-Super-Admin and self-lockout guards
// apply to suspension too.
async function setActiveStatus({ actorUserId, targetUserId, active, reason, ipAddress, userAgent }) {
  assertUuid(actorUserId, 'actorUserId');
  assertUuid(targetUserId, 'targetUserId');
  const normalizedReason = normalizeReason(reason);
  const { sequelize } = require('../../utils/database/database-setup');
  const { GrowthOsUserRole, User } = require('../entities');

  const result = await sequelize.transaction(async (transaction) => {
    await assertAuthorizedActor(actorUserId, transaction);

    const target = await User.findByPk(targetUserId, {
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!target) {
      throw new AppError('Growth OS role target was not found.', 404, 'GROWTH_OS_ROLE_TARGET_NOT_FOUND');
    }

    const activeRow = await GrowthOsUserRole.findOne({
      where: {
        user_id: targetUserId,
        is_active: true,
        revoked_at: { [Op.is]: null },
      },
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    const inactiveRow = activeRow ? null : await GrowthOsUserRole.findOne({
      where: {
        user_id: targetUserId,
        revoked_at: { [Op.is]: null },
      },
      transaction,
      order: [['granted_at', 'DESC']],
      lock: transaction.LOCK?.UPDATE,
    });

    if (active && !activeRow) {
      if (!inactiveRow) {
        throw new AppError(
          'The target user has no unrevoked Growth OS role to activate.',
          404,
          'GROWTH_OS_ROLE_NOT_FOUND',
        );
      }
      const otherActive = await GrowthOsUserRole.findOne({
        attributes: ['id'],
        where: {
          user_id: targetUserId,
          is_active: true,
          revoked_at: { [Op.is]: null },
        },
        transaction,
      });
      if (otherActive) {
        throw new AppError(
          'The target user already has an active Growth OS role.',
          409,
          'GROWTH_OS_ROLE_ALREADY_ASSIGNED',
        );
      }
      await assertNoActiveMerchantMembership(targetUserId, transaction);
      await inactiveRow.update({ is_active: true }, { transaction });
      await writeAudit({
        actorUserId,
        roleRecord: inactiveRow,
        oldValues: { user_id: targetUserId, is_active: false },
        newValues: { user_id: targetUserId, is_active: true },
        reason: normalizedReason,
        action: 'growth_os:role_activated',
        ipAddress,
        userAgent,
      }, transaction);
      await invalidateRoleCache(targetUserId, transaction);
      return safeRole(inactiveRow);
    }

    if (!active) {
      if (!activeRow) {
        throw new AppError(
          'The target user does not have an active Growth OS role.',
          404,
          'GROWTH_OS_ROLE_NOT_FOUND',
        );
      }
      if (SUPER_ADMIN_ROLE_VALUES.includes(activeRow.role)) {
        const activeSuperAdmins = await GrowthOsUserRole.findAll({
          attributes: ['id'],
          where: {
            role: { [Op.in]: SUPER_ADMIN_ROLE_VALUES },
            is_active: true,
            revoked_at: { [Op.is]: null },
          },
          transaction,
          lock: transaction.LOCK?.UPDATE,
        });
        assertNotSelfLockout(actorUserId, targetUserId);
        if (activeSuperAdmins.length <= 1) {
          throw new AppError(
            'The last active Growth OS Super Admin cannot be suspended.',
            409,
            'GROWTH_OS_LAST_SUPER_ADMIN',
          );
        }
      }
      await activeRow.update({ is_active: false }, { transaction });
      await writeAudit({
        actorUserId,
        roleRecord: activeRow,
        oldValues: { user_id: targetUserId, is_active: true },
        newValues: { user_id: targetUserId, is_active: false },
        reason: normalizedReason,
        action: 'growth_os:role_suspended',
        ipAddress,
        userAgent,
      }, transaction);
      await invalidateInternalSessions(targetUserId, transaction);
      await invalidateRoleCache(targetUserId, transaction);
      return safeRole(activeRow);
    }

    // Requested status matches the current status; nothing to do.
    throw new AppError(
      'The requested Growth OS status already matches.',
      409,
      'GROWTH_OS_ROLE_ALREADY_ASSIGNED',
    );
  });

  return result;
}

// Atomically replace the active role (SUPER_ADMIN <-> GROWTH_USER) while
// keeping one audit trail entry per side of the change.
async function changeRole({ actorUserId, targetUserId, role, reason, ipAddress, userAgent }) {
  assertUuid(actorUserId, 'actorUserId');
  assertUuid(targetUserId, 'targetUserId');
  if (!isGrantableGrowthOsRole(role)) {
    throw new AppError('role must be SUPER_ADMIN or GROWTH_USER.', 400, 'GROWTH_OS_INVALID_ROLE');
  }
  if (role === GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN && targetUserId === actorUserId) {
    throw new AppError(
      'A Super Admin cannot escalate their own role.',
      403,
      'GROWTH_OS_SELF_ESCALATION_FORBIDDEN',
    );
  }
  const normalizedReason = normalizeReason(reason);
  const { sequelize } = require('../../utils/database/database-setup');
  const { GrowthOsUserRole, User } = require('../entities');

  return sequelize.transaction(async (transaction) => {
    await assertAuthorizedActor(actorUserId, transaction);

    const target = await User.findByPk(targetUserId, {
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!target) {
      throw new AppError('Growth OS role target was not found.', 404, 'GROWTH_OS_ROLE_TARGET_NOT_FOUND');
    }

    const activeRow = await GrowthOsUserRole.findOne({
      where: {
        user_id: targetUserId,
        is_active: true,
        revoked_at: { [Op.is]: null },
      },
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    if (!activeRow) {
      throw new AppError(
        'The target user must already have one active Growth OS role.',
        404,
        'GROWTH_OS_ROLE_NOT_FOUND',
      );
    }
    await assertNoActiveMerchantMembership(targetUserId, transaction);

    if (activeRow.role === role) {
      throw new AppError(
        'The target user already holds that Growth OS role.',
        409,
        'GROWTH_OS_ROLE_ALREADY_ASSIGNED',
      );
    }

    if (SUPER_ADMIN_ROLE_VALUES.includes(activeRow.role)) {
      const activeSuperAdmins = await GrowthOsUserRole.findAll({
        attributes: ['id'],
        where: {
          role: { [Op.in]: SUPER_ADMIN_ROLE_VALUES },
          is_active: true,
          revoked_at: { [Op.is]: null },
        },
        transaction,
        lock: transaction.LOCK?.UPDATE,
      });
      assertNotSelfLockout(actorUserId, targetUserId);
      if (activeSuperAdmins.length <= 1) {
        throw new AppError(
          'The last active Growth OS Super Admin cannot be demoted.',
          409,
          'GROWTH_OS_LAST_SUPER_ADMIN',
        );
      }
    }

    await activeRow.update({
      is_active: false,
      revoked_by: actorUserId,
      revoked_at: new Date(),
    }, { transaction });

    const nextRow = await GrowthOsUserRole.create({
      user_id: targetUserId,
      role,
      is_active: true,
      granted_by: actorUserId,
      granted_at: new Date(),
      revoked_by: null,
      revoked_at: null,
      metadata: { source: 'growth_os_user_admin', replaced_role: activeRow.role },
    }, { transaction });

    await writeAudit({
      actorUserId,
      roleRecord: activeRow,
      oldValues: { user_id: targetUserId, role: activeRow.role },
      newValues: { user_id: targetUserId, role },
      reason: normalizedReason,
      action: 'growth_os:role_changed',
      ipAddress,
      userAgent,
    }, transaction);
    await invalidateInternalSessions(targetUserId, transaction);
    await invalidateRoleCache(targetUserId, transaction);

    return safeRole(nextRow);
  });
}

async function bootstrapRole({ role, ...args }) {
  if (role !== GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN) {
    throw new AppError(
      'Bootstrap can only establish the first SUPER_ADMIN role.',
      400,
      'GROWTH_OS_INVALID_BOOTSTRAP_ROLE',
    );
  }
  return grantRole({ ...args, role, bootstrap: true });
}

module.exports = {
  grantRole,
  bootstrapRole,
  revokeRole,
  setActiveStatus,
  changeRole,
  isSuperAdminRoleValue: (role) => SUPER_ADMIN_ROLE_VALUES.includes(role),
  SUPER_ADMIN_ROLE_VALUES,
  ROLE_CACHE_TTL_SECONDS,
};
