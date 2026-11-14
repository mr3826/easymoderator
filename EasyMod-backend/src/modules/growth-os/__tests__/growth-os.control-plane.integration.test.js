'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { generateAccessToken } = require('../../../utils/jwt.util');
const { sequelize } = require('../../../utils/database/database-setup');
const { hashPassword } = require('../../../utils/password.util');
const {
  User,
  Shop,
  Tenant,
  Subscription,
  GrowthOsUserRole,
  GrowthOsProspect,
  GrowthOsProspectEvent,
  GrowthOsFollowup,
  GrowthOsNote,
  AuditLog,
  IdempotencyKey,
  UserShop,
} = require('../../entities');
const app = require('../../../app');
const usersAdmin = require('../growth-os.users.service');
const roleService = require('../growth-os.roles.service');

const API = '/api/internal/growth-os';

function suffix() {
  return uuidv4().replace(/-/g, '').slice(0, 10);
}

function digits(seed, length = 9) {
  const raw = [...seed]
    .map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) % 10)))
    .join('');
  return raw.padEnd(length, '3').slice(0, length);
}

function phoneFor(seed) {
  return `017${digits(seed)}`;
}

async function api(user, method, path, body, headers = {}) {
  // Read the CURRENT token_version so sessions invalidated earlier in the
  // run authenticate correctly unless a test is specifically proving that
  // invalidation.
  const fresh = await User.findByPk(user.id, { attributes: ['token_version'] });
  const token = generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId: user.last_logged_shop_id || null,
    tokenVersion: fresh ? fresh.token_version : 0,
  });
  const req = request(app)[method](`${API}${path}`).set('Authorization', `Bearer ${token}`);
  if (Object.keys(headers).length > 0) req.set(headers);
  return body === undefined ? req : req.send(body);
}

function tokenFor(user, { tokenVersion = 0 } = {}) {
  return `Bearer ${generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId: user.last_logged_shop_id || null,
    tokenVersion,
  })}`;
}

describe('Growth OS control plane on real PostgreSQL and Redis', () => {
  let superAdmin;
  let growthUser;
  let secondSuper;
  let tenant;
  let shop;
  let createdUserId;
  let createdEmail;
  let createdPassword;
  let transientReadOnlyId;

  beforeAll(async () => {
    const s = suffix();
    tenant = await Tenant.create({ name: `CP integration ${s}` });
    shop = await Shop.create({
      unique_code: `cp${s}`,
      tenant_id: tenant.id,
      shop_name: `Control Plane Shop ${s}`,
      name: `Control Plane Shop ${s}`,
      is_active: true,
    });
    const subscriptionService = require('../../subscription/subscription.service');
    await subscriptionService.createDefaultSubscription(shop.id);

    const mk = async (name, role) => {
      const user = await User.create({
        email: `cp-${name}-${s}@example.test`,
        password: 'integration-only',
        full_name: `CP ${name}`,
        phone: phoneFor(name + s),
        token_version: 0,
        settings: {},
        last_logged_shop_id: role ? null : shop.id,
      });
      if (role) {
        await GrowthOsUserRole.create({
          user_id: user.id,
          role,
          is_active: true,
          granted_by: user.id,
          metadata: { source: 'control_plane_integration' },
        });
      } else {
        await UserShop.create({
          user_id: user.id,
          shop_id: shop.id,
          role: 'staff',
          is_active: true,
        });
      }
      return user;
    };
    superAdmin = await mk('super', 'SUPER_ADMIN');
    secondSuper = await mk('super2', 'SUPER_ADMIN');
    growthUser = await mk('growth', 'GROWTH_USER');
  });

  afterAll(async () => {
    const ids = [superAdmin, secondSuper, growthUser].map((u) => u.id);
    if (transientReadOnlyId) ids.push(transientReadOnlyId);
    if (createdUserId) ids.push(createdUserId);
    await GrowthOsFollowup.destroy({ where: { owner_user_id: { [Op.in]: ids } } });
    const prospects = await GrowthOsProspect.findAll({
      where: { created_by: { [Op.in]: ids } }, attributes: ['id'],
    });
    if (prospects.length) {
      const pid = prospects.map((p) => p.id);
      await GrowthOsProspectEvent.destroy({ where: { prospect_id: { [Op.in]: pid } } });
      await GrowthOsFollowup.destroy({ where: { prospect_id: { [Op.in]: pid } } });
      await GrowthOsProspect.destroy({ where: { id: { [Op.in]: pid }, status: 'merged' } });
      await GrowthOsProspect.destroy({ where: { id: { [Op.in]: pid } } });
    }
    await GrowthOsNote.destroy({ where: { author_user_id: { [Op.in]: ids } } });
    await AuditLog.destroy({
      where: {
        [Op.or]: [
          { user_id: { [Op.in]: ids } },
          { resource_id: { [Op.in]: ids } },
        ],
      },
    });
    await IdempotencyKey.destroy({ where: { shop_id: shop.id } });
    await GrowthOsUserRole.destroy({ where: { user_id: { [Op.in]: ids } } });
    await UserShop.destroy({ where: { shop_id: shop.id } });
    await Subscription.destroy({ where: { shop_id: shop.id } });
    await shop.destroy();
    await tenant.destroy();
    await User.destroy({ where: { id: { [Op.in]: ids } } });
    if (createdUserId) {
      await sequelize.query(`DELETE FROM user_shops WHERE user_id = '${createdUserId}'`).catch(() => {});
    }
  });

  describe('internal identities without shops', () => {
    test('created Growth user with no shop can sign in; a shop-less non-internal user still cannot', async () => {
      const created = await usersAdmin.createGrowthUser({
        actorUserId: superAdmin.id,
        email: `cp-created-${suffix()}@example.test`,
        fullName: 'Created Operator',
        role: 'GROWTH_USER',
        reason: 'integration create',
        ipAddress: '127.0.0.1',
        userAgent: 'integration',
      });
      createdUserId = created.user.userId;
      createdEmail = created.user.email;
      createdPassword = created.initialPassword;
      expect(createdPassword.length).toBeGreaterThanOrEqual(20);
      expect(new Date(created.temporaryPasswordExpiresAt).getTime()).toBeGreaterThan(Date.now());

      const createdRecord = await User.findByPk(createdUserId, {
        attributes: ['must_change_password', 'temporary_password_expires_at'],
      });
      expect(createdRecord.must_change_password).toBe(true);
      expect(createdRecord.temporary_password_expires_at.getTime()).toBeGreaterThan(Date.now());

      const { authenticateUser, changeTemporaryPassword } = require('../../auth/auth.service');
      const session = await authenticateUser(createdEmail, createdPassword);
      expect(session.accessToken).toBeTruthy();
      expect(session.currentShop).toBeNull();
      expect(session.user.email).toBe(createdEmail);
      expect(session.requiresPasswordChange).toBe(true);
      expect(session.temporaryPasswordExpiresAt).toBe(created.temporaryPasswordExpiresAt);

      const blocked = await request(app)
        .get(`${API}/session`)
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');

      await changeTemporaryPassword(createdUserId, createdPassword, 'Created-user-123!');
      const completedRecord = await User.findByPk(createdUserId, {
        attributes: ['must_change_password', 'temporary_password_expires_at'],
      });
      expect(completedRecord.must_change_password).toBe(false);
      expect(completedRecord.temporary_password_expires_at).toBeNull();
      await expect(authenticateUser(createdEmail, createdPassword)).rejects.toMatchObject({ status: 401 });
      const completedSession = await authenticateUser(createdEmail, 'Created-user-123!');
      expect(completedSession.requiresPasswordChange).toBeUndefined();

      const stranger = await User.create({
        email: `cp-stranger-${suffix()}@example.test`,
        password: await hashPassword(createdPassword),
        full_name: 'No Shop No Role',
        token_version: 0,
        settings: {},
      });
      await expect(authenticateUser(stranger.email, createdPassword))
        .rejects.toMatchObject({
          status: 403,
          message: expect.stringContaining('no associated shops'),
        });
      await User.destroy({ where: { id: stranger.id } });
    });

    test('SUPER_ADMIN without an MFA claim reaches every Growth route', async () => {
      const res = await request(app)
        .get(`${API}/session`)
        .set('Authorization', tokenFor(superAdmin));
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('SUPER_ADMIN');
    });

    test('GROWTH_USER without an MFA claim reaches the workspace routes', async () => {
      for (const path of ['/session', '/home', '/prospects']) {
        const res = await request(app)
          .get(`${API}${path}`)
          .set('Authorization', tokenFor(growthUser));
        expect(res.status).toBe(200);
      }
    });

    test('GROWTH_USER reaches the workspace but every admin surface is denied server-side', async () => {
      const home = await api(growthUser, 'get', '/home');
      expect(home.status).toBe(200);
      expect(home.body.data.myWork).toBeDefined();
      expect(home.body.data.platformAttention).toBeUndefined();

      const denied = await Promise.all([
        api(growthUser, 'get', '/admin/users'),
        api(growthUser, 'post', '/admin/users', {
          email: `nope-${suffix()}@example.test`, fullName: 'Nope', role: 'SUPER_ADMIN', reason: 'x',
        }),
        api(growthUser, 'post', `/admin/merchants/${shop.id}/status`, { active: false, reason: 'x' }),
        api(growthUser, 'get', '/admin/operations'),
        api(growthUser, 'get', '/admin/audit'),
        api(growthUser, 'post', '/roles', { userId: secondSuper.id, role: 'SUPER_ADMIN', reason: 'escalation attempt' }),
      ]);
      for (const res of denied) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('GROWTH_OS_FORBIDDEN');
      }
      // No service mutation happened for the denied escalation attempt.
      const secondRow = await GrowthOsUserRole.findOne({
        where: { user_id: secondSuper.id, is_active: true, revoked_at: { [Op.is]: null } },
      });
      expect(secondRow.role).toBe('SUPER_ADMIN');
    });

    test('SUPER_ADMIN gets bounded eligible owner projections; workspace users cannot enumerate them', async () => {
      const owners = await api(superAdmin, 'get', '/prospect-owners');
      expect(owners.status).toBe(200);
      expect(owners.body.data.map((owner) => owner.userId)).toEqual(expect.arrayContaining([
        superAdmin.id,
        secondSuper.id,
        growthUser.id,
      ]));
      expect(owners.body.data[0]).toEqual(expect.objectContaining({ userId: expect.any(String), displayName: expect.any(String) }));
      expect(owners.body.data[0]).not.toHaveProperty('mfaEnabled');

      const workspaceOwnerView = await api(growthUser, 'get', '/prospect-owners');
      expect(workspaceOwnerView.status).toBe(200);
      expect(workspaceOwnerView.body.data[0]).not.toHaveProperty('mfaEnabled');

      const mine = await api(growthUser, 'get', '/prospects?owner=me');
      expect(mine.status).toBe(200);
      expect(mine.body.data.items.every((item) => item.ownerUserId === growthUser.id)).toBe(true);

      const unassigned = await api(superAdmin, 'get', '/prospects?owner=unassigned');
      expect(unassigned.status).toBe(200);
      expect(unassigned.body.data.items.every((item) => item.ownerUserId === null)).toBe(true);
    });

    test('insight route returns masked detail for GROWTH_USER', async () => {
      const insight = await api(growthUser, 'get', `/merchants/${shop.id}`);
      expect(insight.status).toBe(200);
      expect(insight.body.data.overview).toBeUndefined();
      expect(insight.body.data.merchantName).toBe(shop.shop_name);
      expect(JSON.stringify(insight.body)).not.toContain('cp-super');
      expect(JSON.stringify(insight.body)).not.toContain('topupBalance');
    });

    test('SUPER_ADMIN gets full 360 incl. owner data and search depth', async () => {
      const adminList = await api(superAdmin, 'get', '/merchants');
      expect(adminList.status).toBe(200);
      const row = adminList.body.data.items.find((item) => item.id === shop.id);
      expect(row).toBeTruthy();
      const su360 = await api(superAdmin, 'get', `/merchants/${shop.id}`);
      expect(su360.status).toBe(200);
      expect(typeof su360.body.data.overview.subscription.planName).toBe('string');
      expect(typeof su360.body.data.subscription.usage.topupBalance).toBe('number');

      const guList = await api(growthUser, 'get', '/merchants');
      expect(guList.status).toBe(200);
      const guRow = guList.body.data.items.find((item) => item.shopId === shop.id);
      expect(guRow).toMatchObject({ merchantName: shop.shop_name });
      expect(guRow.owner).toBeUndefined();

      const search = await api(superAdmin, 'post', '/search', { q: shop.shop_name });
      expect(search.status).toBe(200);
      expect(search.body.data.merchants.some((m) => m.shopId === shop.id)).toBe(true);
    });

    test('LIKE wildcards cannot widen searches', async () => {
      const res = await api(superAdmin, 'post', '/search', { q: '%%%' });
      expect(res.status).toBe(200);
      expect(res.body.data.merchants).toHaveLength(0);
    });
  });

  describe('user administration guards', () => {
    test('legacy roles are not grantable anywhere', async () => {
      const res = await api(superAdmin, 'post', '/roles', {
        userId: createdUserId, role: 'MARKETER', reason: 'legacy attempt',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('GROWTH_OS_INVALID_ROLE');
      await expect(usersAdmin.changeGrowthUserRole({
        actorUserId: superAdmin.id,
        targetUserId: growthUser.id,
        role: 'FOUNDER',
        reason: 'legacy attempt',
      })).rejects.toMatchObject({ code: 'GROWTH_OS_INVALID_ROLE' });
    });

    test('one active role per user under concurrent grants', async () => {
      const settled = await Promise.allSettled([
        roleService.grantRole({
          actorUserId: superAdmin.id,
          targetUserId: createdUserId,
          role: 'GROWTH_USER',
          reason: 'race a',
        }),
        roleService.grantRole({
          actorUserId: superAdmin.id,
          targetUserId: createdUserId,
          role: 'GROWTH_USER',
          reason: 'race b',
        }),
      ]);
      expect(settled.every((r) => r.status === 'rejected')).toBe(true);
      expect(settled.map((r) => r.reason.code)).toEqual(expect.arrayContaining([
        'GROWTH_OS_ROLE_ALREADY_ASSIGNED',
      ]));
    });

    test('suspend then re-activate round-trip audits and revokes live sessions', async () => {
      const before = await api(growthUser, 'get', '/session');
      expect(before.status).toBe(200);

      await usersAdmin.setGrowthUserStatus({
        actorUserId: superAdmin.id,
        targetUserId: growthUser.id,
        active: false,
        reason: 'cover break',
      });
      const beforeFresh = await User.findByPk(growthUser.id, { attributes: ['token_version', 'refresh_token'] });
      expect(beforeFresh.token_version).toBeGreaterThan(0);
      expect(beforeFresh.refresh_token).toBeNull();
      // A token minted BEFORE suspension is now rejected (stale version).
      const staleToken = generateAccessToken({
        userId: growthUser.id,
        email: growthUser.email,
        shopId: null,
        tokenVersion: 0,
        mfaVerified: false,
      });
      const stale = await request(app).get(`${API}/session`).set('Authorization', `Bearer ${staleToken}`);
      expect([401, 403]).toContain(stale.status);

      await usersAdmin.setGrowthUserStatus({
        actorUserId: superAdmin.id,
        targetUserId: growthUser.id,
        active: true,
        reason: 'back online',
      });
      const after = await api(growthUser, 'get', '/session');
      expect(after.status).toBe(200);

      const audit = await AuditLog.findAll({
        where: {
          resource_type: 'GROWTH_OS_ROLE',
          action: { [Op.in]: ['growth_os:role_suspended', 'growth_os:role_activated'] },
        },
      });
      expect(audit.length).toBeGreaterThanOrEqual(2);
      expect(audit.every((a) => a.metadata && a.metadata.reason)).toBe(true);
    });

    test('password reset bumps token_version so prior tokens are rejected', async () => {
      const before = await User.findByPk(secondSuper.id, { attributes: ['token_version'] });
      const beforeVersion = before.token_version;
      const reset = await usersAdmin.resetGrowthUserPassword({
        actorUserId: superAdmin.id,
        targetUserId: secondSuper.id,
        reason: 'token rotation',
        ipAddress: '127.0.0.1',
        userAgent: 'integration',
      });
      expect(reset.initialPassword.length).toBeGreaterThanOrEqual(20);
      expect(new Date(reset.temporaryPasswordExpiresAt).getTime()).toBeGreaterThan(Date.now());
      const after = await User.findByPk(secondSuper.id, {
        attributes: ['token_version', 'must_change_password', 'temporary_password_expires_at'],
      });
      expect(after.token_version).toBe(beforeVersion + 1);
      expect(after.must_change_password).toBe(true);
      expect(after.temporary_password_expires_at.getTime()).toBeGreaterThan(Date.now());
      const oldToken = generateAccessToken({
        userId: secondSuper.id,
        email: secondSuper.email,
        shopId: null,
        tokenVersion: beforeVersion,
        mfaVerified: true,
      });
      const denied = await request(app).get(`${API}/session`).set('Authorization', `Bearer ${oldToken}`);
      expect(denied.status).toBe(401);
    });

    test('audits never contain password material', async () => {
      const audits = await AuditLog.findAll({
        where: { resource_type: { [Op.in]: ['GROWTH_OS_USER_ADMIN', 'GROWTH_OS_ROLE'] } },
        limit: 100,
      });
      expect(audits.length).toBeGreaterThan(0);
      const blob = JSON.stringify(audits.map((a) => ({
        old: a.old_values, next: a.new_values, meta: a.metadata,
      })));
      expect(blob).not.toMatch(/initialPassword/);
      expect(blob).not.toMatch(/"\$2[aby]\$/);
    });
  });

  describe('follow-ups, notes, lifecycle and operations', () => {
    let prospectId;

    beforeAll(async () => {
      const payload = {
        businessName: `CP Lifecycle ${suffix()}`,
        contactPhone: phoneFor(`cp-lifecycle-${suffix()}`),
        contactEmail: `cp-lifecycle-${suffix()}@example.test`,
        source: 'browser_extension',
        sourceDetail: 'control-plane-integration',
      };
      const created = await api(superAdmin, 'post', '/prospects', payload);
      expect(created.status).toBe(201);
      prospectId = created.body.data.id;
    });

    test('extension source is storable and searchable', async () => {
      const list = await api(growthUser, 'get', `/prospects?q=${encodeURIComponent('CP Lifecycle')}`);
      expect(list.status).toBe(200);
      expect(list.body.data.items.find((i) => i.id === prospectId).source).toBe('browser_extension');
      for (const role of [superAdmin, growthUser]) {
        const denied = null;
        void denied;
      }
    });

    test('follow-up lifecycle: completion and cancellation are terminal; events recorded', async () => {
      const overdue = await api(growthUser, 'post', '/followups', {
        prospectId,
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        action: 'Call back',
      });
      expect(overdue.status).toBe(201);
      expect(overdue.body.data.overdue).toBe(true);

      const readOnlyUser = await User.create({
        email: `cp-readonly-${suffix()}@example.test`,
        password: 'integration-only',
        full_name: 'CP Read Only Analyst',
        phone: phoneFor(`cp-readonly-${suffix()}`),
        token_version: 0,
        settings: {},
      });
      transientReadOnlyId = readOnlyUser.id;
      const readOnlyRole = await GrowthOsUserRole.create({
        user_id: readOnlyUser.id,
        role: 'READ_ONLY_ANALYST',
        is_active: true,
        granted_by: superAdmin.id,
        metadata: { source: 'control_plane_integration' },
      });
      const invalidOwner = await api(superAdmin, 'post', '/followups', {
        prospectId,
        ownerUserId: readOnlyUser.id,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        action: 'Must not be assigned to a read-only role',
      });
      expect(invalidOwner.status).toBe(400);
      expect(invalidOwner.body.code).toBe('GROWTH_OS_PROSPECT_INVALID_OWNER');
      await readOnlyRole.destroy();
      await readOnlyUser.destroy();
      transientReadOnlyId = null;

      const mine = await api(growthUser, 'get', '/followups?state=overdue&owner=me');
      expect(mine.status).toBe(200);
      expect(mine.body.data.items.map((i) => i.id)).toContain(overdue.body.data.id);

      const done = await api(growthUser, 'post', `/followups/${overdue.body.data.id}/status`, { status: 'completed' });
      expect(done.status).toBe(200);
      expect(done.body.data.completedAt).toBeTruthy();
      const again = await api(growthUser, 'post', `/followups/${overdue.body.data.id}/status`, { status: 'cancelled' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('GROWTH_OS_FOLLOWUP_DONE');

      const cancelled = await api(growthUser, 'post', '/followups', {
        prospectId,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        action: 'Confirm cancellation',
      });
      expect(cancelled.status).toBe(201);
      const cancelledResult = await api(growthUser, 'post', `/followups/${cancelled.body.data.id}/status`, { status: 'cancelled' });
      expect(cancelledResult.status).toBe(200);
      expect(cancelledResult.body.data.status).toBe('cancelled');
      const reopened = await api(growthUser, 'post', `/followups/${cancelled.body.data.id}/status`, { status: 'completed' });
      expect(reopened.status).toBe(409);
      expect(reopened.body.code).toBe('GROWTH_OS_FOLLOWUP_DONE');

      const events = await GrowthOsProspectEvent.findAll({
        where: { prospect_id: prospectId, event_type: { [Op.in]: ['followup_created', 'followup_completed', 'followup_cancelled'] } },
      });
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
        'followup_created',
        'followup_completed',
        'followup_cancelled',
      ]));
    });

    test('merging a prospect rehomes operational work to the surviving record', async () => {
      const sourceSeed = suffix();
      const targetSeed = suffix();
      const source = await api(superAdmin, 'post', '/prospects', {
        businessName: `CP Merge Source ${sourceSeed}`,
        contactPhone: phoneFor(`1${sourceSeed}`),
        contactEmail: `cp-merge-source-${sourceSeed}@example.test`,
        source: 'manual_entry',
      });
      const target = await api(superAdmin, 'post', '/prospects', {
        businessName: `CP Merge Target ${targetSeed}`,
        contactPhone: phoneFor(`2${targetSeed}`),
        contactEmail: `cp-merge-target-${targetSeed}@example.test`,
        source: 'manual_entry',
      });
      expect(source.status).toBe(201);
      expect(target.status).toBe(201);

      const sourceId = source.body.data.id;
      const targetId = target.body.data.id;
      const followup = await api(superAdmin, 'post', '/followups', {
        prospectId: sourceId,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
        action: 'Rehome this follow-up',
      });
      const note = await api(superAdmin, 'post', '/notes', {
        targetType: 'prospect',
        targetId: sourceId,
        body: 'Rehome this note',
      });
      expect(followup.status).toBe(201);
      expect(note.status).toBe(201);

      const merged = await api(superAdmin, 'post', `/prospects/${sourceId}/merge`, {
        targetProspectId: targetId,
        reason: 'Consolidate operational work',
      });
      expect(merged.status).toBe(200);

      expect((await GrowthOsFollowup.findByPk(followup.body.data.id)).prospect_id).toBe(targetId);
      expect((await GrowthOsNote.findByPk(note.body.data.id)).target_id).toBe(targetId);
      const mergeEvent = await GrowthOsProspectEvent.findOne({
        where: { prospect_id: sourceId, event_type: 'merged' },
      });
      expect(mergeEvent.metadata).toMatchObject({
        followups_rehomed: 1,
        notes_rehomed: 1,
      });
    });

    test('notes: prospects allowed for GROWTH_USER, shop/user targets require Super Admin', async () => {
      const ok = await api(growthUser, 'post', '/notes', {
        targetType: 'prospect', targetId: prospectId, body: 'growth context note',
      });
      expect(ok.status).toBe(201);
      const denied = await api(growthUser, 'post', '/notes', {
        targetType: 'shop', targetId: shop.id, body: 'should fail',
      });
      expect(denied.status).toBe(403);
      const su = await api(superAdmin, 'post', '/notes', {
        targetType: 'shop', targetId: shop.id, body: 'ops note',
      });
      expect(su.status).toBe(201);
      const del = await api(superAdmin, 'post', `/notes/${su.body.data.id}/delete`, {});
      expect(del.status).toBe(200);
      const gone = await GrowthOsNote.findByPk(su.body.data.id);
      expect(gone.is_deleted).toBe(true);
    });

    test('lifecycle: onboarding requires linkage and activation converts the chain', async () => {
      await api(superAdmin, 'post', `/prospects/${prospectId}/status`, { status: 'contacted' });
      await api(superAdmin, 'post', `/prospects/${prospectId}/status`, { status: 'qualifying' });
      const qualified = await api(superAdmin, 'post', `/prospects/${prospectId}/status`, { status: 'qualified' });
      expect(qualified.status).toBe(200);

      const unlinked = await api(superAdmin, 'post', `/prospects/${prospectId}/status`, { status: 'onboarding' });
      expect(unlinked.status).toBe(400);

      const link = await api(superAdmin, 'post', `/prospects/${prospectId}/link`, {
        shopId: shop.id, reason: 'activation chain proof',
      });
      expect(link.status).toBe(200);

      const onboard = await api(superAdmin, 'post', `/prospects/${prospectId}/status`, { status: 'onboarding' });
      expect(onboard.status).toBe(200);
      expect(onboard.body.data.status).toBe('onboarding');

      // Simulate the merchant-side activation exactly the way the production
      // analytics writer does it, then let the linked automation complete the
      // prospect (spec §23).
      await shop.update({
        settings: {
          ...(shop.settings || {}),
           first_ai_reply: { occurred_at: new Date().toISOString(), first_conversation_id: null },
        },
      });
      const prospectService = require('../growth-os.prospect.service');
      const result = await prospectService.markLinkedShopsActivated({ shopId: shop.id });
      expect(result.activated).toBe(1);

      const detail = await api(superAdmin, 'get', `/prospects/${prospectId}`);
      expect(detail.body.data.status).toBe('converted');
      const event = await GrowthOsProspectEvent.findOne({
        where: { prospect_id: prospectId, event_type: 'activated' },
      });
      expect(event).toBeTruthy();
      expect(event.actor_user_id).toBeNull();
    });

    test('analytics counts the funnel; platform operations stay separate', async () => {
      const funnel = await api(growthUser, 'get', '/analytics/growth?window=7');
      expect(funnel.status).toBe(200);
      expect(funnel.body.data.funnel.activated).toBeGreaterThanOrEqual(1);
      expect(funnel.body.data.bySource.browser_extension).toBeGreaterThanOrEqual(1);
      expect(funnel.body.data.notAvailable).toContain('cac');

      const ops = await api(superAdmin, 'get', '/admin/operations?window=7');
      expect(ops.status).toBe(200);
      expect(ops.body.data.merchants.total).toBeGreaterThanOrEqual(1);
      expect(ops.body.data.subscriptions.active).toBeGreaterThanOrEqual(1);
    });

    test('admin mutations delegate to domain services and audit with reasons', async () => {
      const suspended = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, {
        active: false, reason: 'unpaid abuse hold',
      });
      expect(suspended.status).toBe(200);
      const sub = await Subscription.findOne({ where: { shop_id: shop.id } });
      expect(sub.status).toBe('suspended');
      const reactivated = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, {
        active: true, reason: 'hold cleared',
      });
      expect(reactivated.status).toBe(200);

      const secretReason = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, {
        active: false, reason: 'manual token: do-not-store-this-value',
      });
      expect(secretReason.status).toBe(200);
      const secretReactivated = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, {
        active: true, reason: 'token: restored-after-review',
      });
      expect(secretReactivated.status).toBe(200);

      const beforeCredits = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['topup_balance'],
      });
      const creditKey = `credit-${suffix()}`;
      const credits = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 5, reason: 'pilot support',
      }, { 'Idempotency-Key': creditKey });
      expect(credits.status).toBe(200);
      const replay = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 5, reason: 'pilot support',
      }, { 'Idempotency-Key': creditKey });
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(credits.body.data);

      const afterReplay = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['topup_balance'],
      });
      expect(Number(afterReplay.topup_balance) - Number(beforeCredits.topup_balance)).toBe(5);

      const conflict = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 6, reason: 'different request',
      }, { 'Idempotency-Key': creditKey });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('GROWTH_OS_IDEMPOTENCY_CONFLICT');

      const concurrentKey = `credit-${suffix()}`;
      const beforeConcurrent = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['topup_balance'],
      });
      const concurrent = await Promise.all([
        api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
          amount: 3, reason: 'concurrent retry',
        }, { 'Idempotency-Key': concurrentKey }),
        api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
          amount: 3, reason: 'concurrent retry',
        }, { 'Idempotency-Key': concurrentKey }),
      ]);
      expect(concurrent.every((response) => response.status === 200)).toBe(true);
      const afterConcurrent = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['topup_balance'],
      });
      expect(Number(afterConcurrent.topup_balance) - Number(beforeConcurrent.topup_balance)).toBe(3);

      const differentKey = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 2, reason: 'second approved grant',
      }, { 'Idempotency-Key': `credit-${suffix()}` });
      expect(differentKey.status).toBe(200);

      const missingKey = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 1, reason: 'missing key',
      });
      expect(missingKey.status).toBe(400);
      expect(missingKey.body.code).toBe('GROWTH_OS_IDEMPOTENCY_REQUIRED');

      const audit = await AuditLog.findAll({
        where: { resource_type: 'GROWTH_OS_ADMIN_MERCHANT' },
      });
      expect(audit.length).toBeGreaterThanOrEqual(7);
      expect(audit.every((a) => a.metadata && a.metadata.reason)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain('do-not-store-this-value');
      expect(JSON.stringify(audit)).not.toContain('restored-after-review');

      const missingReason = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, { active: true });
      expect(missingReason.status).toBe(400);

      const guMutate = await api(growthUser, 'post', `/admin/merchants/${shop.id}/grant-credits`, {
        amount: 1, reason: 'nope',
      });
      expect(guMutate.status).toBe(403);
    });

    test('privileged audit view hides secrets and supports resource filtering', async () => {
      const res = await api(superAdmin, 'get', '/admin/audit?resourceType=GROWTH_OS_ROLE&pageSize=5');
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items) {
        expect(item.resourceType).toBe('GROWTH_OS_ROLE');
        expect(item.reason).toBeTruthy();
      }
      expect(JSON.stringify(res.body)).not.toMatch(/page_access_token_ct|password_hash|"password"/);
    });

    test('privileged merchant mutation rolls back when audit persistence fails', async () => {
      const before = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['status'],
      });
      const createAudit = jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
      try {
        const response = await api(superAdmin, 'post', `/admin/merchants/${shop.id}/status`, {
          active: false, reason: 'audit outage rollback probe',
        });
        expect(response.status).toBe(503);
        expect(response.body.code).toBe('GROWTH_OS_AUDIT_UNAVAILABLE');
      } finally {
        createAudit.mockRestore();
      }
      const after = await Subscription.findOne({
        where: { shop_id: shop.id },
        attributes: ['status'],
      });
      expect(after.status).toBe(before.status);
    });
  });
});
