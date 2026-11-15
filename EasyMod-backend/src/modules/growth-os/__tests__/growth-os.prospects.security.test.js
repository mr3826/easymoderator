'use strict';

const express = require('express');
const request = require('supertest');

const FOUNDER_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTIVE_ID = '22222222-2222-4222-8222-222222222222';
const MARKETER_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_PROSPECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROSPECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_PROSPECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHOP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MARKETING_PROSPECT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const roleHolder = {
  user: null,
  growthRole: null,
};

const mockConfig = {
  growthOsEnabled: true,
  env: 'test',
};

const mockCacheRedis = {
  status: 'ready',
  _isMemoryFallback: false,
};

const mockCacheService = {
  getStrict: jest.fn(async () => null),
  setStrict: jest.fn(async () => true),
};

const mockGrowthRepository = {
  findActiveRoleForUser: jest.fn(async () => (
    roleHolder.growthRole ? { role: roleHolder.growthRole } : null
  )),
  findSafeUserProfile: jest.fn(async (id) => ({
    id,
    full_name: 'Growth Test User',
  })),
};

const mockProspectRows = {};
const mockProspectRepository = {
  listProspects: jest.fn(),
  findProspectById: jest.fn(),
  listProspectEvents: jest.fn(),
};

const mockRoleService = {
  grantRole: jest.fn(),
  revokeRole: jest.fn(),
};

jest.mock('../../../config/config', () => mockConfig);
jest.mock('../../../config/redis', () => ({
  cacheRedis: mockCacheRedis,
  rateLimitRedis: null,
}));
jest.mock('../../../middleware/auth.middleware', () => ({
  authenticate: (...args) => {
    const middleware = (req, _res, next) => {
      if (!roleHolder.user) {
        const error = new Error('No token provided. Please authenticate.');
        error.status = 401;
        return next(error);
      }
      req.user = { ...roleHolder.user };
      return next();
    };
    return args.length === 1 ? middleware : middleware(...args);
  },
}));
jest.mock('../../../utils/cache.service', () => mockCacheService);
jest.mock('../growth-os.repository', () => mockGrowthRepository);
jest.mock('../growth-os.prospect.repository', () => mockProspectRepository);
jest.mock('../growth-os.roles.service', () => mockRoleService);
jest.mock('../growth-os.users.service', () => ({
  listGrowthUsers: jest.fn(async () => []),
  createGrowthUser: jest.fn(),
  setGrowthUserStatus: jest.fn(),
  changeGrowthUserRole: jest.fn(),
  revokeGrowthUserAccess: jest.fn(),
  resetGrowthUserPassword: jest.fn(),
  revokeGrowthUserSessions: jest.fn(),
}));

const prospectService = require('../growth-os.prospect.service');
const growthOsRoutes = require('../growth-os.routes');

function makeProspect(overrides = {}) {
  return {
    id: PROSPECT_ID,
    business_name: 'North Star Retail',
    contact_name: 'Owner Name',
    contact_phone: '01700000000',
    contact_email: 'owner@example.test',
    page_url: 'https://facebook.com/north-star',
    niche: 'retail',
    notes: 'Private working note',
    normalized_business_name: 'north star retail',
    normalized_phone: '+8801700000000',
    normalized_email: 'owner@example.test',
    normalized_page: 'facebook.com/north-star',
    source: 'partner_form',
    source_detail: 'security-fixture',
    source_reference: null,
    source_recorded_at: new Date('2026-08-20T00:00:00.000Z'),
    status: 'qualified',
    status_changed_at: new Date('2026-08-20T00:00:00.000Z'),
    disqualified_reason: null,
    owner_user_id: EXECUTIVE_ID,
    assigned_at: new Date('2026-08-20T00:00:00.000Z'),
    assigned_by: FOUNDER_ID,
    linked_shop_id: null,
    linked_user_id: null,
    linked_at: null,
    merged_into_id: null,
    merged_at: null,
    created_by: FOUNDER_ID,
    metadata: {},
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    updated_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/internal/growth-os', growthOsRoutes);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  });
  return app;
}

function setIdentity({ id, role, mfaVerified = true }) {
  roleHolder.user = {
    userId: id,
    email: `${id}@example.test`,
    shopId: null,
    mfaVerified,
  };
  roleHolder.growthRole = role;
}

function mockMutationServices() {
  jest.spyOn(prospectService, 'create').mockResolvedValue({
    data: prospectService.toApiProspect(makeProspect(), { redacted: false }),
    created: true,
  });
  for (const method of ['update', 'assign', 'transition', 'link', 'merge']) {
    jest.spyOn(prospectService, method).mockResolvedValue(
      prospectService.toApiProspect(makeProspect(), { redacted: false }),
    );
  }
  jest.spyOn(prospectService, 'linkageSuggestions').mockResolvedValue([{
    userId: EXECUTIVE_ID,
    shopId: SHOP_ID,
    shopName: 'North Star Shop',
    matchedFields: ['contactEmail'],
  }]);
  jest.spyOn(prospectService, 'checkDuplicates').mockResolvedValue({
    matches: [{
      prospectId: PROSPECT_ID,
      businessName: 'North Star Retail',
      status: 'qualified',
      matchedFields: ['contactEmail'],
    }],
  });
}

describe('Growth OS prospect route security', () => {
  let app;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockConfig.growthOsEnabled = true;
    mockConfig.env = 'test';
    mockCacheRedis.status = 'ready';
    mockCacheRedis._isMemoryFallback = false;
    roleHolder.user = null;
    roleHolder.growthRole = null;

    for (const key of Object.keys(mockProspectRows)) delete mockProspectRows[key];
    mockProspectRows[PROSPECT_ID] = makeProspect();
    mockProspectRows[FOREIGN_PROSPECT_ID] = makeProspect({
      id: FOREIGN_PROSPECT_ID,
      business_name: 'Foreign Prospect',
      normalized_business_name: 'foreign prospect',
      source: 'manual_entry',
      owner_user_id: null,
    });
    mockProspectRows[TARGET_PROSPECT_ID] = makeProspect({
      id: TARGET_PROSPECT_ID,
      business_name: 'Target Prospect',
      normalized_business_name: 'target prospect',
      owner_user_id: null,
    });
    mockProspectRows[MARKETING_PROSPECT_ID] = makeProspect({
      id: MARKETING_PROSPECT_ID,
      source: 'event',
      business_name: 'Marketing Prospect',
      normalized_business_name: 'marketing prospect',
      owner_user_id: null,
    });
    mockProspectRepository.listProspects.mockImplementation(async ({ scope }) => {
      const ownerId = scope?.where?.owner_user_id;
      const rows = Object.values(mockProspectRows).filter((row) => (
        (!ownerId || row.owner_user_id === ownerId)
        && (scope?.kind !== 'source' || ['self_signup', 'partner_form', 'referral_mention', 'inbound_message', 'event'].includes(row.source))
      ));
      return { rows, count: rows.length };
    });
    mockProspectRepository.findProspectById.mockImplementation(async (id, { scope } = {}) => {
      const row = mockProspectRows[id];
      const ownerId = scope?.where?.owner_user_id;
      if (!row
        || (ownerId && row.owner_user_id !== ownerId)
        || (scope?.kind === 'source' && !['self_signup', 'partner_form', 'referral_mention', 'inbound_message', 'event'].includes(row.source))) return null;
      return row;
    });
    mockProspectRepository.listProspectEvents.mockResolvedValue([]);
    mockMutationServices();
    app = buildApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 401 for an unauthenticated prospect request', async () => {
    const response = await request(app).get('/api/internal/growth-os/prospects');

    expect(response.status).toBe(401);
    expect(mockProspectRepository.listProspects).not.toHaveBeenCalled();
  });

  it('denies an ordinary merchant without an explicit Growth role', async () => {
    setIdentity({ id: 'merchant-1', role: null, mfaVerified: false });

    const response = await request(app)
      .get('/api/internal/growth-os/prospects')
      .set('X-Frontend-Guard-Claim', 'allowed');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('GROWTH_OS_FORBIDDEN');
    expect(mockProspectRepository.listProspects).not.toHaveBeenCalled();
  });

  it('applies the prospect permission matrix to canonical and legacy Growth roles', async () => {
    const roles = [
      'SUPER_ADMIN',
      'GROWTH_USER',
      'FOUNDER',
      'GROWTH_MANAGER',
      'BUSINESS_EXECUTIVE',
      'MARKETER',
      'CUSTOMER_SUCCESS',
      'READ_ONLY_ANALYST',
    ];
    const readRoles = new Set([
      'SUPER_ADMIN',
      'GROWTH_USER',
      'FOUNDER',
      'GROWTH_MANAGER',
      'BUSINESS_EXECUTIVE',
      'MARKETER',
    ]);
    const updateRoles = new Set([
      'SUPER_ADMIN',
      'GROWTH_USER',
      'FOUNDER',
      'GROWTH_MANAGER',
      'BUSINESS_EXECUTIVE',
    ]);
    const manageRoles = new Set([
      'SUPER_ADMIN',
      'GROWTH_USER',
      'FOUNDER',
      'GROWTH_MANAGER',
    ]);

    for (const role of roles) {
      setIdentity({ id: `${role.toLowerCase()}-1`, role });
      const listResponse = await request(app).get('/api/internal/growth-os/prospects');
      const duplicateResponse = await request(app)
        .post('/api/internal/growth-os/prospects/duplicate-check')
        .send({ contactEmail: 'owner@example.test' });
      const updateResponse = await request(app)
        .patch(`/api/internal/growth-os/prospects/${PROSPECT_ID}`)
        .send({ businessName: 'Updated name' });
      const statusResponse = await request(app)
        .post(`/api/internal/growth-os/prospects/${PROSPECT_ID}/status`)
        .send({ status: 'contacted' });
      const manageResponse = await request(app)
        .post('/api/internal/growth-os/prospects')
        .send({
          businessName: 'Created name',
          contactPhone: '01700000001',
          source: 'manual_entry',
        });
      const assignResponse = await request(app)
        .post(`/api/internal/growth-os/prospects/${PROSPECT_ID}/assign`)
        .send({ ownerUserId: null, reason: 'Role matrix probe' });
      const linkResponse = await request(app)
        .post(`/api/internal/growth-os/prospects/${PROSPECT_ID}/link`)
        .send({ shopId: SHOP_ID, reason: 'Role matrix probe' });
      const mergeResponse = await request(app)
        .post(`/api/internal/growth-os/prospects/${PROSPECT_ID}/merge`)
        .send({ targetProspectId: TARGET_PROSPECT_ID, reason: 'Role matrix probe' });
      const suggestionsResponse = await request(app)
        .get(`/api/internal/growth-os/prospects/${PROSPECT_ID}/linkage-suggestions`);

      expect(listResponse.status).toBe(readRoles.has(role) ? 200 : 403);
      expect(duplicateResponse.status).toBe(readRoles.has(role) ? 200 : 403);
      expect(updateResponse.status).toBe(updateRoles.has(role) ? 200 : 403);
      expect(statusResponse.status).toBe(updateRoles.has(role) ? 200 : 403);
      expect(manageResponse.status).toBe(manageRoles.has(role) ? 201 : 403);
      expect(assignResponse.status).toBe(manageRoles.has(role) ? 200 : 403);
      expect(linkResponse.status).toBe(manageRoles.has(role) ? 200 : 403);
      expect(mergeResponse.status).toBe(manageRoles.has(role) ? 200 : 403);
      expect(suggestionsResponse.status).toBe(manageRoles.has(role) ? 200 : 403);
    }
  });

  it('gives canonical GROWTH_USER full unredacted prospect visibility', async () => {
    setIdentity({ id: 'growth-user-1', role: 'GROWTH_USER' });

    const response = await request(app).get('/api/internal/growth-os/prospects');
    const item = response.body.data.items.find((prospect) => prospect.id === PROSPECT_ID);

    expect(response.status).toBe(200);
    expect(item).toMatchObject({
      businessName: 'North Star Retail',
      contactName: 'Owner Name',
      contactEmail: 'owner@example.test',
      notes: 'Private working note',
    });
    expect(item.redacted).toBeUndefined();
  });

  it('redacts marketer contact fields while retaining the safe prospect shape', async () => {
    setIdentity({ id: MARKETER_ID, role: 'MARKETER' });

    const response = await request(app).get('/api/internal/growth-os/prospects');
    const item = response.body.data.items.find((prospect) => prospect.id === PROSPECT_ID);

    expect(response.status).toBe(200);
    expect(item).toMatchObject({
      businessName: 'North Star Retail',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      pageUrl: null,
      disqualifiedReason: null,
      ownerUserId: null,
      assignedBy: null,
      linkedShopId: null,
      linkedUserId: null,
      createdBy: null,
      redacted: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('owner@example.test');
    expect(JSON.stringify(response.body)).not.toContain('01700000000');
    expect(JSON.stringify(response.body)).not.toContain('facebook.com/north-star');
  });

  it('returns linkage suggestions only through the manage_all route', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });

    const response = await request(app)
      .get(`/api/internal/growth-os/prospects/${PROSPECT_ID}/linkage-suggestions`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([expect.objectContaining({
      shopId: SHOP_ID,
      matchedFields: ['contactEmail'],
    })]);
    expect(prospectService.linkageSuggestions).toHaveBeenCalledWith(expect.objectContaining({
      prospectId: PROSPECT_ID,
    }));
  });

  it('restricts marketer reads to marketing-attributable sources', async () => {
    setIdentity({ id: MARKETER_ID, role: 'MARKETER' });

    const list = await request(app).get('/api/internal/growth-os/prospects');
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([PROSPECT_ID, MARKETING_PROSPECT_ID]),
    );
    expect(list.body.data.items.map((item) => item.id)).not.toContain(FOREIGN_PROSPECT_ID);

    const manual = makeProspect({ source: 'manual_entry' });
    mockProspectRows[PROSPECT_ID] = manual;
    const detail = await request(app).get(`/api/internal/growth-os/prospects/${PROSPECT_ID}`);
    expect(detail.status).toBe(404);
  });

  it('denies an executive IDOR lookup outside the assigned scope', async () => {
    setIdentity({ id: EXECUTIVE_ID, role: 'BUSINESS_EXECUTIVE' });

    const response = await request(app)
      .get(`/api/internal/growth-os/prospects/${FOREIGN_PROSPECT_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('GROWTH_OS_PROSPECT_NOT_FOUND');
    expect(mockProspectRepository.findProspectById).toHaveBeenCalledWith(
      FOREIGN_PROSPECT_ID,
      expect.objectContaining({
        scope: expect.objectContaining({
          kind: 'assigned',
          where: { owner_user_id: EXECUTIVE_ID },
        }),
      }),
    );
  });

  it('keeps new admin routes canonical SUPER_ADMIN-only while legacy FOUNDER retains roles.manage', async () => {
    setIdentity({ id: 'canonical-super-admin-1', role: 'SUPER_ADMIN' });

    const canonicalAdmin = await request(app).get('/api/internal/growth-os/admin/users');
    expect(canonicalAdmin.status).toBe(200);

    const querySearch = await request(app).get('/api/internal/growth-os/admin/users?search=owner%40example.com');
    expect(querySearch.status).toBe(400);

    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });
    const legacyRoleGrant = await request(app)
      .post('/api/internal/growth-os/roles')
      .send({ userId: FOREIGN_PROSPECT_ID, role: 'GROWTH_USER', reason: 'legacy role-management access' });
    expect(legacyRoleGrant.status).toBe(201);
    expect(mockRoleService.grantRole).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: FOUNDER_ID,
      targetUserId: FOREIGN_PROSPECT_ID,
      role: 'GROWTH_USER',
    }));

    const legacyAdmin = await request(app).get('/api/internal/growth-os/admin/users');
    expect(legacyAdmin.status).toBe(403);
  });

  it('grants prospect access to a broad Growth role without the MFA claim', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER', mfaVerified: false });

    const response = await request(app).get('/api/internal/growth-os/prospects');

    expect(response.status).toBe(200);
    expect(mockProspectRepository.listProspects).toHaveBeenCalled();
  });

  it('rejects malformed prospect input at the HTTP boundary', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });

    const noChannel = await request(app)
      .post('/api/internal/growth-os/prospects')
      .send({ businessName: 'No channel', source: 'manual_entry' });
    const longBusinessName = await request(app)
      .post('/api/internal/growth-os/prospects')
      .send({ businessName: 'x'.repeat(256), contactEmail: 'owner@example.test', source: 'manual_entry' });
    const arrayMetadata = await request(app)
      .post('/api/internal/growth-os/prospects')
      .send({ businessName: 'Array metadata', contactEmail: 'array@example.test', source: 'manual_entry', metadata: [] });
    const malformedId = await request(app)
      .get('/api/internal/growth-os/prospects/not-a-uuid');

    expect(noChannel.status).toBe(400);
    expect(longBusinessName.status).toBe(400);
    expect(arrayMetadata.status).toBe(400);
    expect(malformedId.status).toBe(400);
    expect(prospectService.create).not.toHaveBeenCalled();
  });

  it('ignores a forged frontend guard claim when the backend role is absent', async () => {
    setIdentity({ id: 'merchant-2', role: null, mfaVerified: false });

    const response = await request(app)
      .get('/api/internal/growth-os/prospects')
      .set('X-Frontend-Guard-Claim', 'growth-authorized');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('GROWTH_OS_FORBIDDEN');
  });

  it('short-circuits disabled Growth before cache or database access', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });
    mockConfig.growthOsEnabled = false;

    const response = await request(app).get('/api/internal/growth-os/prospects');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('GROWTH_OS_DISABLED');
    expect(mockCacheService.getStrict).not.toHaveBeenCalled();
    expect(mockGrowthRepository.findActiveRoleForUser).not.toHaveBeenCalled();
    expect(mockProspectRepository.listProspects).not.toHaveBeenCalled();
  });

  it('maps a prospect database failure to a sanitized 503', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });
    mockProspectRepository.listProspects.mockRejectedValueOnce(
      new Error('postgresql://growth:secret@database.internal/growth'),
    );

    const response = await request(app).get('/api/internal/growth-os/prospects');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'GROWTH_OS_PROSPECT_UNAVAILABLE',
      message: 'Growth OS prospect service is temporarily unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain('database.internal');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('does not expose superseded prospect route methods', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });

    const oldRoutes = [
      ['post', `/api/internal/growth-os/prospects/${PROSPECT_ID}/status-transition`],
      ['post', `/api/internal/growth-os/prospects/${PROSPECT_ID}/convert-to-lead`],
      ['post', `/api/internal/growth-os/prospects/${PROSPECT_ID}/link-shop`],
    ];

    for (const [method, path] of oldRoutes) {
      const response = await request(app)[method](path).send({ reason: 'old route probe' });
      expect(response.status).toBe(404);
    }
    expect(prospectService.transition).not.toHaveBeenCalledWith(expect.anything());
    expect(prospectService.link).not.toHaveBeenCalledWith(expect.anything());
  });

  it('rate-limits repeated duplicate-check lookups', async () => {
    setIdentity({ id: FOUNDER_ID, role: 'FOUNDER' });
    const responses = await Promise.all(Array.from({ length: 121 }, () => request(app)
      .post('/api/internal/growth-os/prospects/duplicate-check')
      .set('X-Forwarded-For', '198.51.100.99')
      .send({ contactEmail: 'owner@example.test' })));

    expect(responses.some((response) => response.status === 429)).toBe(true);
  });

  it('keeps the duplicate-check quota user-keyed across rotating client IPs', async () => {
    setIdentity({ id: MARKETER_ID, role: 'MARKETER' });
    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => request(app)
      .post('/api/internal/growth-os/prospects/duplicate-check')
      .set('X-Forwarded-For', `203.0.113.${(index % 2) + 1}`)
      .send({ contactEmail: 'owner@example.test' })));

    expect(responses.some((response) => response.status === 429)).toBe(true);
  });
});
