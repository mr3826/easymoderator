'use strict';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockInactiveRole = {
  id: 'role-1',
  user_id: TARGET_ID,
  role: 'GROWTH_USER',
  is_active: false,
  revoked_at: null,
  update: jest.fn(),
};

jest.mock('../../entities', () => ({
  User: { findByPk: jest.fn() },
  UserShop: { findOne: jest.fn() },
  GrowthOsUserRole: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  AuditLog: { create: jest.fn() },
}));

jest.mock('../../../utils/database/database-setup', () => ({
  sequelize: {
    transaction: jest.fn(async (callback) => callback(mockTransaction)),
  },
}));

jest.mock('../../../utils/cache.service', () => ({
  delete: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../auth/session-invalidation.service', () => ({
  invalidateUserSessions: jest.fn().mockResolvedValue(1),
}));

const { User, UserShop, GrowthOsUserRole } = require('../../entities');
const roles = require('../growth-os.roles.service');

describe('Growth OS role and merchant membership boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL;
    User.findByPk.mockResolvedValue({ id: TARGET_ID });
    UserShop.findOne.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL;
  });

  it('rejects role changes when the actor has no active Super Admin role', async () => {
    GrowthOsUserRole.findOne.mockResolvedValueOnce(null);

    await expect(roles.setActiveStatus({
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
      active: true,
      reason: 'Unauthorized role change',
    })).rejects.toMatchObject({
      status: 403,
      code: 'GROWTH_OS_ROLE_ACTOR_FORBIDDEN',
    });
  });

  it('does not reactivate a Growth role while an active merchant membership exists', async () => {
    GrowthOsUserRole.findOne
      .mockResolvedValueOnce({ id: 'actor-role', role: 'SUPER_ADMIN' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockInactiveRole);
    UserShop.findOne.mockResolvedValueOnce({ id: 'membership-1', is_active: true });

    await expect(roles.setActiveStatus({
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
      active: true,
      reason: 'Boundary regression',
    })).rejects.toMatchObject({
      status: 409,
      code: 'GROWTH_OS_MERCHANT_ROLE_CONFLICT',
    });

    expect(mockInactiveRole.update).not.toHaveBeenCalled();
  });

  it('allows the configured one-time bootstrap actor to establish the first Super Admin', async () => {
    process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL = 'bootstrap@example.com';
    const bootstrapTarget = {
      id: ACTOR_ID,
      email: 'bootstrap@example.com',
      full_name: 'Bootstrap Operator',
      is_active: true,
      must_change_password: false,
      settings: { internal_growth_bootstrap: true, totp_enabled: true },
      update: jest.fn(),
    };
    const roleRecord = {
      id: 'role-bootstrap',
      user_id: ACTOR_ID,
      role: 'SUPER_ADMIN',
      granted_at: new Date(),
      revoked_at: null,
    };
    User.findByPk
      .mockResolvedValueOnce({ id: ACTOR_ID, email: 'bootstrap@example.com' })
      .mockResolvedValueOnce(bootstrapTarget);
    GrowthOsUserRole.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    GrowthOsUserRole.create.mockResolvedValue(roleRecord);

    await expect(roles.bootstrapRole({
      actorUserId: ACTOR_ID,
      targetUserId: ACTOR_ID,
      role: 'SUPER_ADMIN',
      reason: 'Initial Growth OS bootstrap',
    })).resolves.toMatchObject({ role: 'SUPER_ADMIN', userId: ACTOR_ID });

    expect(GrowthOsUserRole.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: ACTOR_ID,
      role: 'SUPER_ADMIN',
      granted_by: ACTOR_ID,
    }), expect.objectContaining({ transaction: mockTransaction }));
    expect(bootstrapTarget.update).toHaveBeenCalledWith(
      { settings: { internal_growth_bootstrap: false, totp_enabled: true } },
      { transaction: mockTransaction },
    );
  });

  it('refuses first Super Admin bootstrap before password rotation', async () => {
    process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL = 'bootstrap@example.com';
    User.findByPk
      .mockResolvedValueOnce({ id: ACTOR_ID, email: 'bootstrap@example.com' })
      .mockResolvedValueOnce({
        id: ACTOR_ID,
        is_active: true,
        must_change_password: true,
        settings: { internal_growth_bootstrap: true, totp_enabled: false },
      });
    GrowthOsUserRole.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(roles.bootstrapRole({
      actorUserId: ACTOR_ID,
      targetUserId: ACTOR_ID,
      role: 'SUPER_ADMIN',
      reason: 'Initial Growth OS bootstrap',
    })).rejects.toMatchObject({
      status: 409,
      code: 'GROWTH_OS_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED',
    });
    expect(GrowthOsUserRole.create).not.toHaveBeenCalled();
  });

  it('bootstraps the first Super Admin when password rotation is complete without TOTP enrollment', async () => {
    // Regression proof for the 2026-11-15 lockout fix: a rotated, seeded
    // operator must be grantable even when settings.totp_enabled is absent.
    process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL = 'bootstrap@example.com';
    const bootstrapTarget = {
      id: ACTOR_ID,
      email: 'bootstrap@example.com',
      full_name: 'Bootstrap Operator',
      is_active: true,
      must_change_password: false,
      settings: { internal_growth_bootstrap: true },
      update: jest.fn(),
    };
    const roleRecord = {
      id: 'role-bootstrap',
      user_id: ACTOR_ID,
      role: 'SUPER_ADMIN',
      granted_at: new Date(),
      revoked_at: null,
    };
    User.findByPk
      .mockResolvedValueOnce({ id: ACTOR_ID, email: 'bootstrap@example.com' })
      .mockResolvedValueOnce(bootstrapTarget);
    GrowthOsUserRole.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    GrowthOsUserRole.create.mockResolvedValue(roleRecord);

    await expect(roles.bootstrapRole({
      actorUserId: ACTOR_ID,
      targetUserId: ACTOR_ID,
      role: 'SUPER_ADMIN',
      reason: 'Initial Growth OS bootstrap',
    })).resolves.toMatchObject({ role: 'SUPER_ADMIN', userId: ACTOR_ID });

    expect(GrowthOsUserRole.create).toHaveBeenCalledWith(expect.objectContaining({
      user_id: ACTOR_ID,
      role: 'SUPER_ADMIN',
      granted_by: ACTOR_ID,
    }), expect.objectContaining({ transaction: mockTransaction }));
    expect(bootstrapTarget.update).toHaveBeenCalledWith(
      { settings: { internal_growth_bootstrap: false } },
      { transaction: mockTransaction },
    );
  });

  it('refuses first Super Admin bootstrap for an unmarked shop-less account', async () => {
    process.env.GROWTH_BOOTSTRAP_ACTOR_EMAIL = 'bootstrap@example.com';
    User.findByPk
      .mockResolvedValueOnce({ id: ACTOR_ID, email: 'bootstrap@example.com' })
      .mockResolvedValueOnce({
        id: ACTOR_ID,
        is_active: true,
        must_change_password: false,
        settings: { totp_enabled: true },
      });
    GrowthOsUserRole.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(roles.bootstrapRole({
      actorUserId: ACTOR_ID,
      targetUserId: ACTOR_ID,
      role: 'SUPER_ADMIN',
      reason: 'Initial Growth OS bootstrap',
    })).rejects.toMatchObject({
      status: 409,
      code: 'GROWTH_OS_BOOTSTRAP_TARGET_NOT_SEEDED',
    });
    expect(GrowthOsUserRole.create).not.toHaveBeenCalled();
  });
});
