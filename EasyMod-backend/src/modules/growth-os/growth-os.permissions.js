'use strict';

// Canonical two-role model for Growth OS internal users.
//
// SUPER_ADMIN  — full Growth Workspace + Admin Control Plane + growth-user
//                management.
// GROWTH_USER  — full Growth Workspace (prospects, follow-ups, notes,
//                sources, analytics) + limited read-only merchant insight.
//
// Legacy role strings remain part of the physical enum because historical rows
// still carry them; they are compatibility-only and never grantable. Their
// permission maps remain separate below until an explicit audited migration
// changes their scope. ROLE_ALIASES is for display/session compatibility only
// and must never select a legacy row's permissions.

const GROWTH_OS_CANONICAL_ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  GROWTH_USER: 'GROWTH_USER',
});

const LEGACY_GROWTH_OS_ROLES = Object.freeze({
  FOUNDER: 'FOUNDER',
  GROWTH_MANAGER: 'GROWTH_MANAGER',
  BUSINESS_EXECUTIVE: 'BUSINESS_EXECUTIVE',
  MARKETER: 'MARKETER',
  CUSTOMER_SUCCESS: 'CUSTOMER_SUCCESS',
  READ_ONLY_ANALYST: 'READ_ONLY_ANALYST',
});

const GROWTH_OS_ROLES = Object.freeze({
  ...GROWTH_OS_CANONICAL_ROLES,
  ...LEGACY_GROWTH_OS_ROLES,
});

// These aliases preserve the canonical role shown in sessions and admin
// displays. They are not authorization aliases; raw legacy roles keep their
// historical least-privilege permissions until an audited migration runs.
const ROLE_ALIASES = Object.freeze({
  [LEGACY_GROWTH_OS_ROLES.FOUNDER]: GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN,
  [LEGACY_GROWTH_OS_ROLES.GROWTH_MANAGER]: GROWTH_OS_CANONICAL_ROLES.GROWTH_USER,
  [LEGACY_GROWTH_OS_ROLES.BUSINESS_EXECUTIVE]: GROWTH_OS_CANONICAL_ROLES.GROWTH_USER,
  [LEGACY_GROWTH_OS_ROLES.MARKETER]: GROWTH_OS_CANONICAL_ROLES.GROWTH_USER,
  [LEGACY_GROWTH_OS_ROLES.CUSTOMER_SUCCESS]: GROWTH_OS_CANONICAL_ROLES.GROWTH_USER,
  [LEGACY_GROWTH_OS_ROLES.READ_ONLY_ANALYST]: GROWTH_OS_CANONICAL_ROLES.GROWTH_USER,
});

const GROWTH_WORKSPACE_PERMISSIONS = Object.freeze([
  'growth_os.session.read',
  'growth_os.home.read',
  'growth_os.prospects.read_all',
  'growth_os.prospects.manage_all',
  'growth_os.prospects.read_assigned',
  'growth_os.prospects.update_assigned',
  'growth_os.prospects.read_source_scope',
  'growth_os.reports.read_all',
  'growth_os.reports.read_source_scope',
  'growth_os.followups.manage',
  'growth_os.notes.manage',
  'growth_os.search.read',
  'growth_os.merchants.read_insight',
]);

const ADMIN_PERMISSIONS = Object.freeze([
  'growth_os.roles.manage',
  'growth_os.admin.merchants.read',
  'growth_os.admin.merchants.mutate',
  'growth_os.admin.users.read',
  'growth_os.admin.users.manage',
  'growth_os.admin.operations.read',
  'growth_os.admin.audit.read',
]);

const PERMISSIONS_BY_ROLE = Object.freeze({
  [GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN]: Object.freeze([
    ...GROWTH_WORKSPACE_PERMISSIONS,
    ...ADMIN_PERMISSIONS,
  ]),
  [GROWTH_OS_CANONICAL_ROLES.GROWTH_USER]: Object.freeze([
    ...GROWTH_WORKSPACE_PERMISSIONS,
  ]),
  // Compatibility-only legacy maps. Do not widen these maps by changing an
  // alias; use an explicit audited migration to change historical scope.
  [LEGACY_GROWTH_OS_ROLES.FOUNDER]: Object.freeze([
    'growth_os.session.read',
    'growth_os.roles.manage',
    'growth_os.prospects.read_all',
    'growth_os.prospects.manage_all',
    'growth_os.reports.read_all',
  ]),
  [LEGACY_GROWTH_OS_ROLES.GROWTH_MANAGER]: Object.freeze([
    'growth_os.session.read',
    'growth_os.prospects.read_all',
    'growth_os.prospects.manage_all',
  ]),
  [LEGACY_GROWTH_OS_ROLES.BUSINESS_EXECUTIVE]: Object.freeze([
    'growth_os.session.read',
    'growth_os.prospects.read_assigned',
    'growth_os.prospects.update_assigned',
  ]),
  [LEGACY_GROWTH_OS_ROLES.MARKETER]: Object.freeze([
    'growth_os.session.read',
    'growth_os.prospects.read_source_scope',
    'growth_os.reports.read_source_scope',
  ]),
  [LEGACY_GROWTH_OS_ROLES.CUSTOMER_SUCCESS]: Object.freeze([
    'growth_os.session.read',
  ]),
  [LEGACY_GROWTH_OS_ROLES.READ_ONLY_ANALYST]: Object.freeze([
    'growth_os.session.read',
  ]),
});

const ROLE_PRIORITY = Object.freeze({
  [GROWTH_OS_CANONICAL_ROLES.SUPER_ADMIN]: 100,
  [LEGACY_GROWTH_OS_ROLES.FOUNDER]: 100,
  [LEGACY_GROWTH_OS_ROLES.GROWTH_MANAGER]: 80,
  [GROWTH_OS_CANONICAL_ROLES.GROWTH_USER]: 50,
  [LEGACY_GROWTH_OS_ROLES.BUSINESS_EXECUTIVE]: 50,
  [LEGACY_GROWTH_OS_ROLES.MARKETER]: 45,
  [LEGACY_GROWTH_OS_ROLES.CUSTOMER_SUCCESS]: 45,
  [LEGACY_GROWTH_OS_ROLES.READ_ONLY_ANALYST]: 10,
});

function isGrowthOsRole(role) {
  return Object.prototype.hasOwnProperty.call(GROWTH_OS_ROLES, role);
}

function isGrantableGrowthOsRole(role) {
  return Object.prototype.hasOwnProperty.call(GROWTH_OS_CANONICAL_ROLES, role);
}

function resolveCanonicalRole(role) {
  if (!isGrowthOsRole(role)) return null;
  return ROLE_ALIASES[role] || role;
}

function isLegacyGrowthOsRole(role) {
  return Object.prototype.hasOwnProperty.call(LEGACY_GROWTH_OS_ROLES, role);
}

function getRolePriority(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_PRIORITY, role)
    ? ROLE_PRIORITY[role]
    : 0;
}

function getPermissionsForRole(rawRole) {
  if (!isGrowthOsRole(rawRole)) return [];
  return [...PERMISSIONS_BY_ROLE[rawRole]];
}

function isEligibleGrowthAssigneeRole(rawRole) {
  const permissions = getPermissionsForRole(rawRole);
  return permissions.includes('growth_os.prospects.manage_all')
    || (permissions.includes('growth_os.prospects.read_assigned')
      && permissions.includes('growth_os.prospects.update_assigned'));
}

function getEligibleGrowthAssigneeRoles() {
  return Object.keys(PERMISSIONS_BY_ROLE).filter(isEligibleGrowthAssigneeRole);
}

function hasPermission(role, permission) {
  return getPermissionsForRole(role).includes(permission);
}

module.exports = {
  GROWTH_OS_ROLES,
  GROWTH_OS_CANONICAL_ROLES,
  LEGACY_GROWTH_OS_ROLES,
  ROLE_ALIASES,
  PERMISSIONS_BY_ROLE,
  isGrowthOsRole,
  isGrantableGrowthOsRole,
  isLegacyGrowthOsRole,
  resolveCanonicalRole,
  getRolePriority,
  getPermissionsForRole,
  isEligibleGrowthAssigneeRole,
  getEligibleGrowthAssigneeRoles,
  hasPermission,
};
