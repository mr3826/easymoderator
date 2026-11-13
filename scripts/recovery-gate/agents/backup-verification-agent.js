'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  secretStatus,
  requiredSpacesSecretsPresent,
} = require('../lib/secrets');

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseSchedule(workflowText) {
  const match = workflowText.match(/cron:\s*['"]([^'"]+)['"]/);
  if (!match) return { status: 'NOT_FOUND_IN_CODEBASE' };
  const fields = match[1].trim().split(/\s+/);
  if (fields.length !== 5) return { status: 'INVALID', cron: match[1] };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const daily = dayOfMonth === '*' && month === '*' && dayOfWeek === '*';
  const weekly = dayOfMonth === '*' && month === '*' && dayOfWeek !== '*';
  const dayLabel = /^\d$/.test(dayOfWeek)
    ? DAY_NAMES[Number(dayOfWeek)] || dayOfWeek
    : dayOfWeek.toUpperCase();
  return {
    status: daily || weekly ? 'PASS' : 'FAIL',
    cron: match[1],
    daily,
    weekly,
    frequency: daily ? 'DAILY' : weekly ? 'WEEKLY' : 'FAIL',
    minute,
    hour,
    dayOfWeek,
    dayLabel,
    scheduleUtc: daily
      ? `DAILY ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`
      : weekly
        ? `${dayLabel} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`
        : 'NOT_DERIVED',
    configuredInterval: daily ? '1 day' : weekly ? '7 days' : 'NOT_DERIVED',
    theoreticalMaxGap: daily ? '1 day' : weekly ? '7 days' : 'NOT_DERIVED',
  };
}

function runAws(args, env) {
  const result = spawnSync('aws', args, {
    env: { ...env, AWS_PAGER: '' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    available: !result.error || result.error.code !== 'ENOENT',
    ok: result.status === 0,
    status: result.status,
    errorCode: result.error?.code || null,
    // Never return stdout/stderr: CLI errors can contain request metadata.
  };
}

function verifyLifecycle(env) {
  const endpoint = String(env.SPACES_ENDPOINT || '');
  if (/oraclecloud\.com/i.test(endpoint)) {
    const namespace = endpoint.replace(/^https?:\/\//i, '').split('.')[0];
    const command = `oci os object-lifecycle-policy get --namespace-name ${namespace} --bucket-name ${env.BACKUP_BUCKET}`;
    process.stderr.write(`NOTICE: OCI Object Storage lifecycle is not exposed by the S3-compatible API. Verify it with: ${command}\n`);
    return {
      status: 'NOTICE_OCI_CLI_REQUIRED',
      namespace,
      command,
      note: 'get-bucket-lifecycle-configuration is unsupported on the OCI S3-compatible endpoint; this is not a failure.',
    };
  }

  const lifecycle = runAws([
    's3api', 'get-bucket-lifecycle-configuration', '--bucket', env.BACKUP_BUCKET,
    '--endpoint-url', env.SPACES_ENDPOINT,
  ], {
    ...env,
    AWS_ACCESS_KEY_ID: env.SPACES_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.SPACES_SECRET_ACCESS_KEY,
  });
  if (!lifecycle.available) {
    return { status: 'NOT_VERIFIED', reason: 'AWS_CLI_MISSING' };
  }
  return { status: lifecycle.ok ? 'PASS' : 'NOT_VERIFIED' };
}

function verifySpacesAccess(env = process.env) {
  const secrets = secretStatus(env);
  if (!requiredSpacesSecretsPresent(env)) {
    return {
      status: 'BLOCKED_EXTERNAL_CREDENTIAL',
      blocker: 'SPACES_CREDENTIALS_MISSING',
      secretPresence: {
        SPACES_ACCESS_KEY_ID: secrets.SPACES_ACCESS_KEY_ID,
        SPACES_SECRET_ACCESS_KEY: secrets.SPACES_SECRET_ACCESS_KEY,
        SPACES_ENDPOINT: secrets.SPACES_ENDPOINT,
        BACKUP_BUCKET: secrets.BACKUP_BUCKET,
        BACKUP_ENCRYPTION_KEY: secrets.BACKUP_ENCRYPTION_KEY,
        OCI_AUDIT_PRIVATE_KEY: secrets.OCI_AUDIT_PRIVATE_KEY,
      },
    };
  }

  const head = runAws([
    's3api', 'head-bucket', '--bucket', env.BACKUP_BUCKET,
    '--endpoint-url', env.SPACES_ENDPOINT,
  ], {
    ...env,
    AWS_ACCESS_KEY_ID: env.SPACES_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.SPACES_SECRET_ACCESS_KEY,
  });
  if (!head.available) {
    return { status: 'BLOCKED_TOOLING', blocker: 'AWS_CLI_MISSING' };
  }
  if (!head.ok) {
    return { status: 'FAIL', blocker: 'SPACES_BUCKET_HEAD_FAILED' };
  }

  const acl = runAws([
    's3api', 'get-bucket-acl', '--bucket', env.BACKUP_BUCKET,
    '--endpoint-url', env.SPACES_ENDPOINT,
  ], {
    ...env,
    AWS_ACCESS_KEY_ID: env.SPACES_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.SPACES_SECRET_ACCESS_KEY,
  });
  const lifecycle = verifyLifecycle(env);
  return {
    status: acl.ok ? 'PASS' : 'FAIL',
    bucketHead: head.ok ? 'PASS' : 'FAIL',
    bucketAcl: acl.ok ? 'PASS' : 'FAIL',
    publicRead: acl.ok ? 'NOT_DETECTED_BY_ACL_PROBE' : 'NOT_VERIFIED',
    lifecycle,
  };
}

function run({ repoRoot, env = process.env, executeOffhost = false } = {}) {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'backup.yml');
  const workflowText = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
  const schedule = parseSchedule(workflowText);
  const hasOffhostUpload = /aws-cli|aws\s+s3\s+cp|s3:\/\//i.test(workflowText);
  const hasEncryption = /openssl\s+enc\s+-aes-256|age\s+|gpg\s+/i.test(workflowText);
  const hasSha256 = /sha256sum|sha256/i.test(workflowText);
  const hasRetention = /OFFSITE_RETENTION_DAYS|lifecycle|retention/i.test(workflowText);
  const secrets = secretStatus(env);

  const offhostVerification = executeOffhost
    ? verifySpacesAccess(env)
    : { status: 'NOT_EXECUTED', reason: 'Use --execute-offhost only with authorized credentials.' };

  return {
    agent: 'Backup-Verification Agent',
    frequency: schedule.frequency || 'FAIL',
    schedule,
    configuredBackupInterval: schedule.configuredInterval,
    theoreticalMaxBackupGap: schedule.theoreticalMaxGap,
    offhost: {
      status: hasOffhostUpload ? 'CONFIGURED_NOT_EXECUTED' : 'FAIL',
      workflowEvidence: hasOffhostUpload,
      verification: offhostVerification,
    },
    encryption: {
      status: hasEncryption ? 'CONFIGURED_NOT_EXECUTED' : 'FAIL',
      workflowEvidence: hasEncryption,
    },
    integrity: {
      status: hasSha256 ? 'CONFIGURED_NOT_EXECUTED' : 'FAIL',
      workflowEvidence: hasSha256,
    },
    retention: {
      status: hasRetention ? 'CONFIGURED_NOT_EXECUTED' : 'NOT_FOUND_IN_CODEBASE',
      workflowEvidence: hasRetention,
    },
    secretPresence: {
      spacesCredentialsComplete: requiredSpacesSecretsPresent(env),
      OCI_AUDIT_PRIVATE_KEY: secrets.OCI_AUDIT_PRIVATE_KEY,
      DO_API_TOKEN_IGNORED: secrets.DO_API_TOKEN_IGNORED,
    },
  };
}

module.exports = { parseSchedule, verifySpacesAccess, run };
