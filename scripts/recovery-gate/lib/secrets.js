'use strict';

// Secret handling is intentionally presence-only. Callers must never log the
// returned values or serialize process.env into evidence.
const SECRET_NAMES = Object.freeze([
  'SPACES_ACCESS_KEY_ID',
  'SPACES_SECRET_ACCESS_KEY',
  'SPACES_ENDPOINT',
  'BACKUP_BUCKET',
  'BACKUP_ENCRYPTION_KEY',
  'RECOVERY_DATABASE_URL',
  'RECOVERY_DB_PASSWORD',
  'OCI_AUDIT_PRIVATE_KEY',
]);

function secretStatus(env = process.env) {
  const result = {};
  for (const name of SECRET_NAMES) {
    result[name] = Boolean(env[name]);
  }

  // DO_API_TOKEN is deliberately not used. It is reported only as a policy
  // warning so a caller can see that the compatibility variable was ignored.
  result.DO_API_TOKEN_IGNORED = Boolean(env.DO_API_TOKEN);
  return result;
}

function requiredSpacesSecretsPresent(env = process.env) {
  return [
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
    'SPACES_ENDPOINT',
    'BACKUP_BUCKET',
    'BACKUP_ENCRYPTION_KEY',
  ].every((name) => Boolean(env[name]));
}

function recoveryTargetIsExplicitlyIsolated(env = process.env) {
  return env.RECOVERY_TARGET === 'isolated'
    && Boolean(env.RECOVERY_DATABASE_URL)
    && Boolean(env.RECOVERY_DB_PASSWORD);
}

module.exports = {
  SECRET_NAMES,
  secretStatus,
  requiredSpacesSecretsPresent,
  recoveryTargetIsExplicitlyIsolated,
};
