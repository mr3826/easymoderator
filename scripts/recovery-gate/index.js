'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: runBackup } = require('./agents/backup-verification-agent');
const { run: runRestore } = require('./agents/restore-rehearsal-agent');
const { run: runFraud } = require('./agents/fraud-shield-agent');
const { run: runObservability } = require('./agents/observability-agent');
const { run: runSecurity } = require('./agents/security-secrets-agent');
const { EvidenceRecorder, utcNow } = require('./lib/evidence');

const repoRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    executeOffhost: argv.includes('--execute-offhost'),
    executeRestore: argv.includes('--execute-restore'),
    probeDocker: !argv.includes('--no-docker-probe'),
    writeEvidence: argv.includes('--write-evidence'),
    evidenceDir: argv.find((value) => value.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length),
  };
}

function buildReport(options = {}) {
  const evidence = new EvidenceRecorder();
  evidence.record('Recovery-Orchestrator Agent', 'start', { productionDeployEnabled: false, productionSwitched: 'NO' });
  const backup = runBackup({ repoRoot, executeOffhost: options.executeOffhost });
  evidence.record('Backup-Verification Agent', 'completed', { status: backup.offhost.status });
  const restore = runRestore({ repoRoot, executeRestore: options.executeRestore, probeDocker: options.probeDocker });
  evidence.record('Restore-Rehearsal Agent', 'completed', { status: restore.rehearsal.status });
  const fraud = runFraud({ repoRoot });
  evidence.record('Fraud-Shield Agent', 'completed', { decision: fraud.decision });
  const observability = runObservability();
  evidence.record('Observability Agent', 'completed', { reproducibility: observability.reproducibility });
  const security = runSecurity({ repoRoot });
  evidence.record('Security & Secrets Agent', 'completed', { status: security.status });

  const hardBlockers = [];
  if (backup.schedule.status !== 'PASS') hardBlockers.push('Configured application/off-host backup schedule is invalid or missing.');
  if (backup.offhost.verification.status !== 'PASS') hardBlockers.push(`Off-host backup verification is ${backup.offhost.verification.status}.`);
  if (restore.tooling.undefinedExecSync === 'FAIL') hardBlockers.push('Restore verifier has an undefined execSync defect.');
  if (restore.rehearsal.status !== 'PASS') hardBlockers.push('No successful isolated restore rehearsal evidence exists.');
  if (fraud.decision !== 'PASS_FOR_LIVE_MODE') hardBlockers.push(`Fraud enforcement decision is ${fraud.decision}; local enforcement paths or adversarial checks remain incomplete.`);
  if (security.status !== 'PASS_FOR_SECRET_SCAN') hardBlockers.push('Secret scan found unsafe source handling.');

  const report = {
    finalStatus: hardBlockers.length === 0 ? 'READY_FOR_CONTROLLED_CUTOVER' : 'RECOVERY_GATE_BLOCKED',
    generatedAtUtc: utcNow(),
    backupFrequency: backup.frequency,
    backupSchedule: backup.schedule.scheduleUtc,
    configuredBackupInterval: backup.configuredBackupInterval,
    theoreticalMaxBackupGap: backup.theoreticalMaxBackupGap,
    observedRpoDb: restore.observedRpo.db,
    observedRpoMedia: restore.observedRpo.media,
    observedRpo: restore.observedRpo.observed,
    observedRto: restore.observedRto,
    rtoPhases: Object.fromEntries(observability.rtoPhases.map((key) => [key, 'NOT_MEASURED'])),
    postRestoreDbIntegrity: 'NOT_MEASURED',
    postRestoreMediaIntegrity: 'NOT_MEASURED',
    qdrantRegeneration: 'NOT_MEASURED',
    redisRecovery: 'START_EMPTY_REQUIRED_NOT_MEASURED',
    fraudDetectorVersion: fraud.detectorVersion,
    fraudDetectorDecision: fraud.decision,
    fraudDetectorDbAdapter: fraud.dbAdapter,
    fraudShadowMode: fraud.shadowMode,
    fraudDetectorShadowSmoke: `${fraud.adversarialSuite.passed}/${fraud.adversarialSuite.total}_ADAPTER_CHECKS`,
    fraudDetectorHardeningRequired: fraud.decision !== 'PASS_FOR_LIVE_MODE',
    productionDeployEnabled: false,
    productionSwitched: 'NO',
    agents: { backup, restore, fraud, observability, security },
    hardBlockers,
    nextSafeAction: [
      'Configure authorized Spaces credentials without placing values in the repository.',
      'Run the daily backup from the approved non-production/production operations context and retain redacted object/checksum evidence.',
      'Restore into a separately named isolated PostgreSQL/media target and capture real RPO/RTO timestamps.',
      'Keep the local fraud/RTO enforcement paths tenant-scoped and rerun the adversarial security suite after any change.',
    ],
    evidence: evidence.snapshot(),
  };
  return report;
}

function renderReport(report) {
  const lines = [
    'FINAL_STATUS', report.finalStatus, '',
    'OFFHOST_BACKUP', report.agents.backup.offhost.verification.status, '',
    'BACKUP_FREQUENCY', report.backupFrequency,
    'BACKUP_SCHEDULE', report.backupSchedule,
    'CONFIGURED_BACKUP_INTERVAL', report.configuredBackupInterval,
    'THEORETICAL_MAX_BACKUP_GAP', report.theoreticalMaxBackupGap,
    'OBSERVED_RPO_DB', report.observedRpoDb,
    'OBSERVED_RPO_MEDIA', report.observedRpoMedia,
    'OBSERVED_RPO', report.observedRpo,
    'OBSERVED_RTO', report.observedRto,
    'POST_RESTORE_DB_INTEGRITY', report.postRestoreDbIntegrity,
    'POST_RESTORE_MEDIA_INTEGRITY', report.postRestoreMediaIntegrity,
    'QDRANT_REGENERATION', report.qdrantRegeneration,
    'REDIS_RECOVERY', report.redisRecovery,
    'FRAUD_DETECTOR_VERSION', report.fraudDetectorVersion,
    'FRAUD_ENFORCEMENT_MODE', report.agents.fraud.enforcementMode,
    'FRAUD_DETECTOR_DECISION', report.fraudDetectorDecision,
    'FRAUD_DETECTOR_DB_ADAPTER', report.fraudDetectorDbAdapter,
    'FRAUD_SHADOW_MODE', report.fraudShadowMode,
    'FRAUD_DETECTOR_SHADOW_SMOKE', report.fraudDetectorShadowSmoke,
    'FRAUD_DETECTOR_HARDENING_REQUIRED', String(report.fraudDetectorHardeningRequired),
    'PRODUCTION_DEPLOY_ENABLED=false',
    'PRODUCTION_SWITCHED=NO', '',
    'HARD_BLOCKERS', ...report.hardBlockers.map((item) => `- ${item}`), '',
    'NEXT_SAFE_ACTION', ...report.nextSafeAction.map((item) => `- ${item}`), '',
  ];
  return lines.join('\n');
}

function writeEvidence(report, options) {
  const base = options.evidenceDir || path.join(os.tmpdir(), 'easymod-recovery-gate', report.generatedAtUtc.replace(/[:.]/g, '-'));
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'recovery-gate-report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(base, 'recovery-gate-report.txt'), `${renderReport(report)}\n`, { encoding: 'utf8', flag: 'wx' });
  return base;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = buildReport(options);
  const evidenceDir = options.writeEvidence ? writeEvidence(report, options) : null;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, evidenceDir }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
    if (evidenceDir) process.stdout.write(`EVIDENCE_DIR=${evidenceDir}\n`);
  }
  return report;
}

if (require.main === module) {
  const report = main();
  process.exitCode = report.finalStatus === 'READY_FOR_CONTROLLED_CUTOVER' ? 0 : 1;
}

module.exports = { parseArgs, buildReport, renderReport, writeEvidence };
