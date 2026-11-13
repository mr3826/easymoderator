'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { secretStatus } = require('../lib/secrets');

function trackedFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function run({ repoRoot, env = process.env } = {}) {
  const secrets = secretStatus(env);
  const files = trackedFiles(repoRoot);
  const suspicious = [];
  for (const relative of files) {
    if (/node_modules|coverage|test-results|\.lock$|\.db$/.test(relative)) continue;
    const full = path.join(repoRoot, relative);
    if (!fs.existsSync(full) || fs.statSync(full).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/process\.env\.DO_API_TOKEN/.test(text)) suspicious.push({ file: relative, issue: 'DO_API_TOKEN_REFERENCE' });
    if (/console\.(log|error|warn)\([^\n]*(?:SPACES_SECRET_ACCESS_KEY|BACKUP_ENCRYPTION_KEY|OCI_AUDIT_PRIVATE_KEY)/i.test(text)) {
      suspicious.push({ file: relative, issue: 'SECRET_NAME_LOGGING' });
    }
  }
  return {
    agent: 'Security & Secrets Agent',
    doApiToken: 'IGNORED_BY_POLICY',
    spacesSecretPresence: {
      SPACES_ACCESS_KEY_ID: secrets.SPACES_ACCESS_KEY_ID,
      SPACES_SECRET_ACCESS_KEY: secrets.SPACES_SECRET_ACCESS_KEY,
      SPACES_ENDPOINT: secrets.SPACES_ENDPOINT,
      BACKUP_BUCKET: secrets.BACKUP_BUCKET,
      BACKUP_ENCRYPTION_KEY: secrets.BACKUP_ENCRYPTION_KEY,
      OCI_AUDIT_PRIVATE_KEY: secrets.OCI_AUDIT_PRIVATE_KEY,
    },
    suspicious,
    status: suspicious.length === 0 ? 'PASS_FOR_SECRET_SCAN' : 'FAIL',
    evidence: 'Only boolean presence and redacted source findings are returned; secret values are never serialized.',
  };
}

module.exports = { run };
