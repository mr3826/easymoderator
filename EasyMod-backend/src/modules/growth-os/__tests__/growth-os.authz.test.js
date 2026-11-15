'use strict';

const roleHolder = {
  user: null,
  growthRole: null,
  frontendGuardClaim: null,
};

const mockConfig = {
  growthOsEnabled: true,
  env: 'test',
};

const mockCacheRedis = {
  status: 'ready',
  _isMemoryFallback: false,
};

jest.mock('../../../config/config', () => mockConfig);

jest.mock('../../../config/redis', () => ({ cacheRedis: mockCacheRedis }));

jest.mock('../../../middleware/auth.middleware', () => ({
  authenticate: (...args) => {
    const middleware = (req, _res, next) => {
      if (!roleHolder.user) {
        const err = new Error('No token provided. Please authenticate.');
        err.status = 401;
        return next(err);
      }
      req.user = roleHolder.user;
      if (roleHolder.frontendGuardClaim) {
        req.headers['x-frontend-guard-claim'] = roleHolder.frontendGuardClaim;
      }
      return next();
    };
    return args.length === 1 ? middleware : middleware(...args);
  },
}));

jest.mock('../../../utils/cache.service', () => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => {}),
  getStrict: jest.fn(async () => null),
  setStrict: jest.fn(async () => true),
  delete: jest.fn(async () => true),
}));

jest.mock('../growth-os.roles.service', () => ({
  grantRole: jest.fn(async () => ({ id: 'role-1', userId: 'target-1', role: 'GROWTH_USER' })),
  revokeRole: jest.fn(async () => ({ id: 'role-1', userId: 'target-1', role: 'GROWTH_USER' })),
}));

jest.mock('../../entities', () => ({
  GrowthOsUserRole: {
    findAll: jest.fn(async () => (
      roleHolder.growthRole
        ? [{ role: roleHolder.growthRole, user_id: roleHolder.user?.userId, id: 'role-1', granted_at: new Date() }]
        : []
    )),
    findOne: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  AuditLog: { create: jest.fn() },
  User: {
    findByPk: jest.fn(async (id) => ({
      id,
      full_name: id === 'founder-1' ? 'Founder User' : 'Executive User',
      email: `${id}@easymod.tech`,
    })),
  },
}));

const express = require('express');
const request = require('supertest');
const growthOsRoutes = require('../growth-os.routes');
const growthRoleService = require('../growth-os.roles.service');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/growth-os', growthOsRoutes);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

describe('Growth OS session authorization', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    mockConfig.growthOsEnabled = true;
    mockConfig.env = 'test';
    mockCacheRedis.status = 'ready';
    mockCacheRedis._isMemoryFallback = false;
    roleHolder.user = null;
    roleHolder.growthRole = null;
    roleHolder.frontendGuardClaim = null;
  });

  it('denies unauthenticated requests', async () => {
    const res = await request(app).get('/api/internal/growth-os/session');
    expect(res.status).toBe(401);
  });

  it('fails closed without consulting the authorization store when Growth OS is disabled', async () => {
    const cacheService = require('../../../utils/cache.service');
    const { GrowthOsUserRole } = require('../../entities');
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech' };
    roleHolder.growthRole = 'FOUNDER';
    mockConfig.growthOsEnabled = false;

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GROWTH_OS_DISABLED');
    expect(cacheService.getStrict).not.toHaveBeenCalled();
    expect(GrowthOsUserRole.findAll).not.toHaveBeenCalled();
  });

  it('denies a merchant user with no explicit Growth OS role', async () => {
    roleHolder.user = { userId: 'merchant-owner-1', email: 'owner@example.com', shopId: 'shop-1' };
    const res = await request(app).get('/api/internal/growth-os/session');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GROWTH_OS_FORBIDDEN');
  });

  it('denies an internal/platform user without explicit Growth OS access', async () => {
    roleHolder.user = { userId: 'platform-admin-1', email: 'admin@easymod.tech' };
    const res = await request(app).get('/api/internal/growth-os/session');
    expect(res.status).toBe(403);
  });

  it('reports the pending role-grant boundary for the marked seed identity without an MFA step', async () => {
    roleHolder.user = {
      userId: 'bootstrap-1',
      email: 'growth-admin@easymod.tech',
      bootstrapOperator: true,
      mfaVerified: false,
    };

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GROWTH_OS_BOOTSTRAP_PENDING');
  });

  it('does not grant Growth access until the audited role grant completes', async () => {
    roleHolder.user = {
      userId: 'bootstrap-1',
      email: 'growth-admin@easymod.tech',
      bootstrapOperator: true,
      mfaVerified: true,
    };

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GROWTH_OS_BOOTSTRAP_PENDING');
  });

  it('returns a controlled 503 when the authorization store is unavailable', async () => {
    const { GrowthOsUserRole } = require('../../entities');
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech' };
    GrowthOsUserRole.findAll.mockRejectedValueOnce(new Error('database connection details'));

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'GROWTH_OS_AUTHZ_UNAVAILABLE',
      message: 'Growth OS authorization service is temporarily unavailable.',
    });
    expect(res.body.message).not.toContain('database connection details');
  });

  it('fails closed when the deployed Growth OS Redis authorization cache is unavailable', async () => {
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech' };
    mockConfig.env = 'production';
    mockCacheRedis.status = 'end';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'GROWTH_OS_REDIS_UNAVAILABLE',
      message: 'Growth OS authorization cache is temporarily unavailable.',
    });
    expect(require('../../../utils/cache.service').getStrict).not.toHaveBeenCalled();
  });

  it('does not turn an authorization-cache read failure into a database allow', async () => {
    const cacheService = require('../../../utils/cache.service');
    const { GrowthOsUserRole } = require('../../entities');
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech', mfaVerified: true };
    cacheService.getStrict.mockRejectedValueOnce(new Error('redis connection lost'));

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'GROWTH_OS_AUTHZ_UNAVAILABLE',
      message: 'Growth OS authorization service is temporarily unavailable.',
    });
    expect(GrowthOsUserRole.findAll).not.toHaveBeenCalled();
  });

  it('resolves a legacy founder to canonical SUPER_ADMIN with safe session fields', async () => {
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech', mfaVerified: true };
    roleHolder.growthRole = 'FOUNDER';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      internalUserId: 'founder-1',
      displayName: 'Founder User',
      role: 'SUPER_ADMIN',
      legacyRole: 'FOUNDER',
    });
    expect(res.body.data.permissions).toContain('growth_os.roles.manage');
    expect(res.body.data.permissions).toContain('growth_os.prospects.read_all');
    expect(res.body.data.permissions).toContain('growth_os.prospects.manage_all');
    expect(res.body.data.permissions).toContain('growth_os.reports.read_all');
    expect(res.body.data.permissions).not.toContain('growth_os.admin.users.manage');
    expect(res.body.data.permissions).not.toContain('growth_os.followups.manage');
    expect(res.body.data).not.toHaveProperty('token');
    expect(res.body.data).not.toHaveProperty('password');
  });

  it('resolves a legacy executive to canonical GROWTH_USER without admin permissions', async () => {
    roleHolder.user = { userId: 'executive-1', email: 'exec@easymod.tech', mfaVerified: true };
    roleHolder.growthRole = 'BUSINESS_EXECUTIVE';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('GROWTH_USER');
    expect(res.body.data.legacyRole).toBe('BUSINESS_EXECUTIVE');
    expect(res.body.data.permissions).toContain('growth_os.prospects.read_assigned');
    expect(res.body.data.permissions).toContain('growth_os.prospects.update_assigned');
    expect(res.body.data.permissions).not.toContain('growth_os.prospects.read_all');
    expect(res.body.data.permissions).not.toContain('growth_os.prospects.manage_all');
    expect(res.body.data.permissions).not.toContain('growth_os.followups.manage');
    expect(res.body.data.permissions).not.toContain('growth_os.roles.manage');
    expect(res.body.data.permissions).not.toContain('growth_os.admin.users.manage');
    expect(res.body.data.permissions).not.toContain('growth_os.admin.merchants.mutate');
  });

  it('grants the canonical GROWTH_USER role access without an MFA claim', async () => {
    // The claim is omitted entirely: a password-only session with an active
    // Growth role must be authorized.
    roleHolder.user = { userId: 'growth-1', email: 'growth@easymod.tech' };
    roleHolder.growthRole = 'GROWTH_USER';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('GROWTH_USER');
    expect(res.body.data.permissions).toContain('growth_os.prospects.read_all');
  });

  it('grants a canonical GROWTH_USER full workspace without admin or user-management access', async () => {
    roleHolder.user = { userId: 'growth-1', email: 'growth@easymod.tech', mfaVerified: true };
    roleHolder.growthRole = 'GROWTH_USER';

    const session = await request(app).get('/api/internal/growth-os/session');
    expect(session.status).toBe(200);
    expect(session.body.data.permissions).toEqual(expect.arrayContaining([
      'growth_os.home.read',
      'growth_os.prospects.read_all',
      'growth_os.prospects.manage_all',
      'growth_os.followups.manage',
      'growth_os.notes.manage',
      'growth_os.search.read',
    ]));
    expect(session.body.data.permissions).toContain('growth_os.merchants.read_insight');
    expect(session.body.data.permissions).not.toContain('growth_os.roles.manage');
    expect(session.body.data.permissions).not.toContain('growth_os.admin.merchants.read');

    const adminUsers = await request(app).get('/api/internal/growth-os/admin/users');
    expect(adminUsers.status).toBe(403);
    const adminGrantRole = await request(app)
      .post('/api/internal/growth-os/admin/users')
      .send({ email: 'new@easymod.tech', fullName: 'Nope', role: 'SUPER_ADMIN', reason: 'x' });
    expect(adminGrantRole.status).toBe(403);
    expect(growthRoleService.grantRole).not.toHaveBeenCalled();
  });

  it('rejects a Growth request that carries merchant shop context', async () => {
    roleHolder.user = {
      userId: 'growth-merchant-mix-1',
      email: 'growth-mixed@easymod.tech',
      shopId: 'shop-1',
      mfaVerified: false,
    };
    roleHolder.growthRole = 'GROWTH_USER';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GROWTH_OS_MERCHANT_CONTEXT_FORBIDDEN');
  });

  it('grants legacy scoped roles that alias into canonical members without an MFA claim', async () => {
    roleHolder.user = { userId: 'executive-2', email: 'exec2@easymod.tech', mfaVerified: false };
    roleHolder.growthRole = 'BUSINESS_EXECUTIVE';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('GROWTH_USER');
  });

  it('grants the canonical SUPER_ADMIN role without an MFA claim', async () => {
    roleHolder.user = { userId: 'sa-1', email: 'sa@easymod.tech', mfaVerified: false };
    roleHolder.growthRole = 'SUPER_ADMIN';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('SUPER_ADMIN');
  });

  it('grants privileged Growth roles without an MFA claim', async () => {
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech', mfaVerified: false };
    roleHolder.growthRole = 'FOUNDER';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('SUPER_ADMIN');
  });

  it('does not trust a frontend route guard claim without backend access', async () => {
    roleHolder.user = { userId: 'merchant-owner-1', email: 'owner@example.com', shopId: 'shop-1' };
    roleHolder.frontendGuardClaim = 'allowed';

    const res = await request(app).get('/api/internal/growth-os/session');

    expect(res.status).toBe(403);
  });

  it('protects direct privileged role APIs with the same backend guard', async () => {
    roleHolder.user = { userId: 'founder-1', email: 'founder@easymod.tech', mfaVerified: true };
    roleHolder.growthRole = 'FOUNDER';

    const res = await request(app)
      .post('/api/internal/growth-os/roles')
      .send({ userId: 'target-1', role: 'GROWTH_USER', reason: 'Access review' });

    expect(res.status).toBe(201);
    expect(growthRoleService.grantRole).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'founder-1',
      targetUserId: 'target-1',
      role: 'GROWTH_USER',
      reason: 'Access review',
    }));
  });

  it('denies a merchant direct privileged role API call', async () => {
    roleHolder.user = { userId: 'merchant-owner-1', email: 'owner@example.com', mfaVerified: false };

    const res = await request(app)
      .post('/api/internal/growth-os/roles')
      .send({ userId: 'target-1', role: 'FOUNDER', reason: 'forged' });

    expect(res.status).toBe(403);
    expect(growthRoleService.grantRole).not.toHaveBeenCalled();
  });

  it('protects the POST Growth user search endpoint with the read permission', async () => {
    roleHolder.user = { userId: 'merchant-owner-1', email: 'owner@example.com', mfaVerified: false };

    const res = await request(app)
      .post('/api/internal/growth-os/admin/users/search')
      .send({ search: 'owner@example.com' });

    expect(res.status).toBe(403);
  });
});
