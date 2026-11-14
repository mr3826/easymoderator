'use strict';

const args = new Set(process.argv.slice(2));
const { assertDisposableDatabase } = require('../../tests/helpers/disposable-database');
assertDisposableDatabase(process.env.DATABASE_URL, 'the Growth OS browser E2E seed');

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { sequelize } = require('../utils/database/database-setup');
const {
  AuditLog,
  GrowthOsFollowup,
  GrowthOsNote,
  GrowthOsProspect,
  GrowthOsProspectEvent,
  GrowthOsUserRole,
  Shop,
  Tenant,
  User,
  UserShop,
} = require('../modules/entities');
const { hashPassword } = require('../utils/password.util');
const { generateTotpSecret, enableTotp, hotp } = require('../modules/auth/totp.service');
const { normalizeIdentity } = require('../modules/growth-os/growth-os.prospect.identity');

const repoRoot = path.resolve(__dirname, '../../..');
const fixturePath = path.join(repoRoot, 'EasyMod-growth', 'tests', 'e2e', '.fixtures.json');
const password = 'GrowthE2E-Password-2026!';
const privateMarker = 'growth-e2e-private-marker';
const privateTimelineReason = 'growth-e2e-private-timeline-reason';
const tenantName = 'Growth OS browser E2E tenant';
const shopCode = 'GROWTH-E2E-01';

// Canonical two-role model: SUPER_ADMIN and GROWTH_USER. MFA is optional shared
// authentication and is not a Growth OS access precondition. The legacy FOUNDER
// row stays seeded (TOTP on) so the alias mapping proves canonical role
// resolution, and the super/legacy fixtures keep TOTP enrolled so the optional
// sign-in path stays covered. staleSession exists only to prove token-version
// rejection, which the auth layer enforces before Growth authorization.
const userDefinitions = {
  super: {
    email: 'growth-e2e-super@example.test',
    full_name: 'Growth E2E Super Admin',
    phone: '01700000101',
    role: 'SUPER_ADMIN',
    shopRole: 'owner',
    totp: true,
  },
  growth: {
    email: 'growth-e2e-growth@example.test',
    full_name: 'Growth E2E Growth User',
    phone: '01700000102',
    role: 'GROWTH_USER',
    shopRole: 'staff',
  },
  legacy: {
    email: 'growth-e2e-legacy@example.test',
    full_name: 'Growth E2E Legacy Founder',
    phone: '01700000103',
    role: 'FOUNDER',
    shopRole: 'admin',
    totp: true,
  },
  staleSession: {
    email: 'growth-e2e-stale@example.test',
    full_name: 'Growth E2E Stale Session',
    phone: '01700000104',
    role: 'GROWTH_USER',
    shopRole: 'staff',
  },
  merchant: {
    email: 'growth-e2e-merchant@example.test',
    full_name: 'Growth E2E Merchant',
    phone: '01700000105',
    role: null,
    shopRole: 'staff',
  },
};

const prospectDefinitions = [
  {
    key: 'northStar',
    source: 'manual_entry',
    sourceReference: 'growth-e2e:north-star',
    businessName: 'North Star Retail',
    contactName: 'Growth E2E Merchant',
    contactPhone: userDefinitions.merchant.phone,
    contactEmail: userDefinitions.merchant.email,
    pageUrl: 'https://facebook.com/growth-e2e-north-star',
    niche: 'retail',
    notes: 'North Star private notes',
    metadata: { privateMarker, fixture: true },
    status: 'new',
    owner: 'super',
  },
  {
    key: 'assignedGrowthStudio',
    source: 'self_signup',
    sourceReference: 'growth-e2e:assigned-growth-studio',
    businessName: 'Assigned Growth Studio',
    contactName: 'Growth Team Contact',
    contactPhone: '01700000201',
    contactEmail: 'growth-e2e-assigned-studio@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-assigned-studio',
    niche: 'services',
    notes: 'Assigned Growth user notes',
    metadata: { fixture: true },
    status: 'qualified',
    owner: 'growth',
  },
  {
    key: 'campaignBakery',
    source: 'partner_form',
    sourceReference: 'growth-e2e:campaign-bakery',
    businessName: 'Cedar Campaign Bakery',
    contactName: 'Campaign Contact',
    contactPhone: '01700000202',
    contactEmail: 'growth-e2e-campaign@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-cedar',
    niche: 'food',
    notes: privateMarker,
    metadata: { privateMarker, campaign: 'cedar' },
    status: 'contacted',
    owner: 'growth',
    timelineReason: privateTimelineReason,
  },
  {
    key: 'manualPrivate',
    source: 'manual_entry',
    sourceReference: 'growth-e2e:manual-private',
    businessName: 'Manual Ledger Services',
    contactName: 'Manual Contact',
    contactPhone: '01700000203',
    contactEmail: 'growth-e2e-manual@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-manual',
    niche: 'services',
    notes: 'Manual-only notes',
    metadata: { fixture: true },
    status: 'disqualified',
    disqualifiedReason: 'No response during qualification',
    owner: 'super',
  },
  {
    key: 'eventUnreachable',
    source: 'event',
    sourceReference: 'growth-e2e:event-unreachable',
    businessName: 'Event Unreachable Shop',
    contactName: 'Event Contact',
    contactPhone: '01700000204',
    contactEmail: 'growth-e2e-event@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-event',
    niche: 'retail',
    notes: 'Event follow-up notes',
    metadata: { fixture: true },
    status: 'unreachable',
    owner: 'growth',
  },
  {
    key: 'converted',
    source: 'other',
    sourceReference: 'growth-e2e:converted',
    businessName: 'Converted E2E Shop',
    contactName: 'Converted Contact',
    contactPhone: '01700000205',
    contactEmail: 'growth-e2e-converted@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-converted',
    niche: 'retail',
    notes: 'Converted fixture notes',
    metadata: { fixture: true },
    status: 'converted',
    owner: 'super',
    linkedShop: true,
  },
  {
    key: 'mergeSource',
    source: 'other',
    sourceReference: 'growth-e2e:merge-source',
    businessName: 'Merge Source Prospect',
    contactName: 'Merge Source Contact',
    contactPhone: '01700000206',
    contactEmail: 'growth-e2e-merge-source@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-merge-source',
    niche: 'retail',
    notes: 'Source record to tombstone',
    metadata: { fixture: true },
    status: 'contacted',
    owner: 'super',
  },
  {
    key: 'mergeTarget',
    source: 'other',
    sourceReference: 'growth-e2e:merge-target',
    businessName: 'Merge Target Prospect',
    contactName: 'Merge Target Contact',
    contactPhone: '01700000207',
    contactEmail: 'growth-e2e-merge-target@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-merge-target',
    niche: 'retail',
    notes: 'Target record remains active',
    metadata: { fixture: true },
    status: 'new',
    owner: 'super',
  },
  {
    key: 'followUpStudio',
    source: 'manual_entry',
    sourceReference: 'growth-e2e:followup-studio',
    businessName: 'Follow-up Studio',
    contactName: 'Studio Contact',
    contactPhone: '01700000210',
    contactEmail: 'growth-e2e-followup-studio@example.test',
    pageUrl: 'https://facebook.com/growth-e2e-followup-studio',
    niche: 'services',
    notes: 'Qualified studio carried by the seeded follow-up queue',
    metadata: { fixture: true },
    status: 'qualified',
    owner: 'super',
  },
];

async function ensureTenant() {
  const [tenant] = await Tenant.findOrCreate({
    where: { name: tenantName },
    defaults: { name: tenantName, is_active: true, settings: { fixture: 'growth-e2e' } },
  });
  await tenant.update({ is_active: true, settings: { fixture: 'growth-e2e' } });

  const [shop] = await Shop.findOrCreate({
    where: { unique_code: shopCode },
    defaults: {
      unique_code: shopCode,
      tenant_id: tenant.id,
      shop_name: 'Growth OS browser E2E shop',
      name: 'Growth OS browser E2E shop',
      is_active: true,
      timezone: 'Asia/Dhaka',
      settings: { fixture: 'growth-e2e' },
    },
  });
  await shop.update({
    tenant_id: tenant.id,
    shop_name: 'Growth OS browser E2E shop',
    name: 'Growth OS browser E2E shop',
    is_active: true,
    // Activation is deliberately left unset: entering onboarding must wait
    // for activation instead of auto-converting, so the browser E2E can
    // assert the full onboarding -> converted UI path.
    settings: { fixture: 'growth-e2e' },
  });
  return { tenant, shop };
}

async function ensureUser(definition, passwordHash, shop) {
  const [user] = await User.findOrCreate({
    where: { email: definition.email },
    defaults: {
      email: definition.email,
      password: passwordHash,
      full_name: definition.full_name,
      phone: definition.phone,
      token_version: 0,
      settings: {},
      last_logged_shop_id: definition.role ? null : shop.id,
    },
  });
  await user.update({
    password: passwordHash,
    full_name: definition.full_name,
    phone: definition.phone,
    token_version: 0,
    refresh_token: null,
    settings: {},
    last_logged_shop_id: definition.role ? null : shop.id,
  });

  if (definition.role) {
    // Growth identities are global internal accounts and must not retain an
    // active merchant session or membership from a previous disposable seed.
    await UserShop.update(
      { is_active: false },
      { where: { user_id: user.id, is_active: true } },
    );
    return user;
  }

  const [membership] = await UserShop.findOrCreate({
    where: { user_id: user.id, shop_id: shop.id },
    defaults: { user_id: user.id, shop_id: shop.id, role: definition.shopRole, is_active: true },
  });
  await membership.update({ role: definition.shopRole, is_active: true });
  return user;
}

async function setGrowthRole(user, role, grantActorId) {
  await GrowthOsUserRole.destroy({ where: { user_id: user.id } });
  if (!role) return;
  await GrowthOsUserRole.create({
    user_id: user.id,
    role,
    is_active: true,
    granted_by: grantActorId,
    metadata: { source: 'growth-e2e-fixture' },
  });
}

async function enableTotpFor(user) {
  const { secret } = await generateTotpSecret(user.id);
  await enableTotp(user.id, hotp(secret, Math.floor(Date.now() / 1000 / 30)));
  return secret;
}

async function resetProspectFixtures() {
  const where = {
    [Op.or]: prospectDefinitions.map(({ source, sourceReference }) => ({
      source,
      source_reference: sourceReference,
    })),
  };
  const existing = await GrowthOsProspect.findAll({ where, attributes: ['id'] });
  const ids = existing.map((record) => record.id);
  if (ids.length === 0) return;

  await GrowthOsFollowup.destroy({ where: { prospect_id: { [Op.in]: ids } } });
  await GrowthOsNote.destroy({
    where: { target_type: 'prospect', target_id: { [Op.in]: ids } },
  });
  await GrowthOsProspectEvent.destroy({ where: { prospect_id: { [Op.in]: ids } } });
  await AuditLog.destroy({
    where: {
      resource_type: 'growth_os_prospect',
      resource_id: { [Op.in]: ids },
    },
  });
  await GrowthOsProspect.destroy({ where: { id: { [Op.in]: ids } } });
}

async function createProspectFixture(definition, users, shop) {
  const identity = normalizeIdentity({
    business_name: definition.businessName,
    contact_phone: definition.contactPhone,
    contact_email: definition.contactEmail,
    page_url: definition.pageUrl,
  });
  const ownerUserId = definition.owner ? users[definition.owner].id : null;
  const now = new Date();
  const prospect = await GrowthOsProspect.create({
    business_name: definition.businessName,
    contact_name: definition.contactName,
    contact_phone: definition.contactPhone,
    contact_email: definition.contactEmail,
    page_url: definition.pageUrl,
    niche: definition.niche,
    notes: definition.notes,
    ...identity,
    source: definition.source,
    source_detail: 'growth-e2e-fixture',
    source_reference: definition.sourceReference,
    source_recorded_at: now,
    status: definition.status,
    status_changed_at: now,
    disqualified_reason: definition.disqualifiedReason || null,
    owner_user_id: ownerUserId,
    assigned_at: ownerUserId ? now : null,
    assigned_by: ownerUserId ? users.super.id : null,
    linked_shop_id: definition.linkedShop ? shop.id : null,
    linked_user_id: null,
    linked_at: definition.linkedShop ? now : null,
    created_by: users.super.id,
    metadata: definition.metadata,
  });

  await GrowthOsProspectEvent.create({
    prospect_id: prospect.id,
    event_type: 'created',
    actor_user_id: users.super.id,
    reason: definition.timelineReason || 'growth-e2e fixture bootstrap',
    changed_fields: ['business_name', 'source', 'status'],
    metadata: definition.timelineReason ? { privateMarker } : { fixture: true },
  });
  await AuditLog.create({
    user_id: users.super.id,
    shop_id: null,
    action: 'growth_os:prospect_created',
    resource_type: 'growth_os_prospect',
    resource_id: prospect.id,
    old_values: null,
    new_values: prospect.toJSON(),
    metadata: { source: 'growth-e2e-fixture' },
    ip_address: '127.0.0.1',
    user_agent: 'growth-e2e-seed',
  });
  return prospect;
}

async function seedFollowups(users, prospects) {
  const now = Date.now();
  const overdue = await GrowthOsFollowup.create({
    prospect_id: prospects.followUpStudio.id,
    owner_user_id: users.growth.id,
    created_by: users.growth.id,
    due_at: new Date(now - 36 * 60 * 60 * 1000),
    action: 'E2E seeded overdue follow-up',
    note: 'Open yesterday: appears in My Work with an overdue badge',
    status: 'open',
    createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
  });
  const upcoming = await GrowthOsFollowup.create({
    prospect_id: prospects.northStar.id,
    owner_user_id: users.super.id,
    created_by: users.super.id,
    due_at: new Date(now + 3 * 24 * 60 * 60 * 1000),
    action: 'E2E seeded upcoming follow-up',
    note: null,
    status: 'open',
    createdAt: new Date(now - 24 * 60 * 60 * 1000),
    updatedAt: new Date(now - 24 * 60 * 60 * 1000),
  });
  return [overdue, upcoming];
}

async function seedNote(users, prospects) {
  return GrowthOsNote.create({
    target_type: 'prospect',
    target_id: prospects.northStar.id,
    author_user_id: users.super.id,
    body: 'E2E seeded internal note on the North Star prospect',
  });
}

async function logFixtureCounts(users) {
  const userIds = Object.values(users).map((user) => user.id);
  const [userCount, roles, prospects, followups, notes] = await Promise.all([
    User.count({ where: { email: { [Op.in]: Object.values(userDefinitions).map((d) => d.email) } } }),
    GrowthOsUserRole.count({ where: { user_id: { [Op.in]: userIds } } }),
    GrowthOsProspect.count({ where: { source_reference: { [Op.like]: 'growth-e2e:%' } } }),
    GrowthOsFollowup.count({ where: { action: { [Op.like]: 'E2E seeded %' } } }),
    GrowthOsNote.count({ where: { body: { [Op.like]: 'E2E seeded internal note%' } } }),
  ]);
  return { users: userCount, roles, prospects, followups, notes };
}

async function main() {
  const { tenant, shop } = await ensureTenant();
  const passwordHash = await hashPassword(password);
  const users = {};

  for (const [key, definition] of Object.entries(userDefinitions)) {
    users[key] = await ensureUser(definition, passwordHash, shop);
  }
  for (const [key, definition] of Object.entries(userDefinitions)) {
    await setGrowthRole(users[key], definition.role, users.super.id);
  }

  const totpSecrets = {};
  for (const [key, definition] of Object.entries(userDefinitions)) {
    if (definition.totp) {
      totpSecrets[key] = await enableTotpFor(users[key]);
    }
  }

  await resetProspectFixtures();
  const prospects = {};
  for (const definition of prospectDefinitions) {
    prospects[definition.key] = await createProspectFixture(definition, users, shop);
  }
  const followups = await seedFollowups(users, prospects);
  const note = await seedNote(users, prospects);

  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify({
    version: 2,
    password,
    privateMarker,
    privateTimelineReason,
    tenant: { id: tenant.id, name: tenant.name },
    shop: { id: shop.id, name: shop.name, shopName: shop.shop_name, uniqueCode: shop.unique_code },
    emails: Object.fromEntries(Object.entries(userDefinitions).map(([key, definition]) => [
      key,
      definition.email,
    ])),
    totp: {
      superUser: totpSecrets.super,
      legacy: totpSecrets.legacy,
    },
    totpAlgorithm: 'SHA1',
    totpIssuer: 'EasyMod',
    totpPeriod: 30,
    totpDigits: 6,
    users: Object.fromEntries(Object.entries(users).map(([key, user]) => [key, {
      id: user.id,
      email: user.email,
      phone: user.phone,
      password,
      role: userDefinitions[key].role,
      ...(totpSecrets[key] ? { totpSecret: totpSecrets[key] } : {}),
    }])),
    prospects: Object.fromEntries(Object.entries(prospects).map(([key, prospect]) => [key, {
      id: prospect.id,
      businessName: prospect.business_name,
      source: prospect.source,
      status: prospect.status,
    }])),
  }, null, 2)}\n`, 'utf8');

  const counts = await logFixtureCounts(users);
  console.log(`Growth browser E2E fixtures written to ${path.relative(repoRoot, fixturePath)}`);
  console.log(`Seeded ${Object.keys(users).length} users and ${Object.keys(prospects).length} prospects.`);
  console.log(
    'Fixture table counts: '
    + `users=${counts.users} growth_roles=${counts.roles} prospects=${counts.prospects} `
    + `followups=${counts.followups} notes=${counts.notes}`,
  );
  if (args.has('--print')) console.log(JSON.stringify({ fixturePath, users, prospects, followups, note }, null, 2));
}

main()
  .catch((error) => {
    console.error(`Growth browser E2E seed failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => {});
  });
