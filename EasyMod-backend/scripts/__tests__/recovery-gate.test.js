'use strict';

const path = require('path');
const {
  normalizeEvents,
  safeEvaluate,
  runAdversarialSuite,
} = require('../../../scripts/recovery-gate/agents/fraud-shield-agent');
const { parseSchedule } = require('../../../scripts/recovery-gate/agents/backup-verification-agent');
const { buildReport, renderReport } = require('../../../scripts/recovery-gate');
const DatabaseRestore = require('../restore-database');
const MediaRestore = require('../restore-media');

describe('recovery gate', () => {
  test('parses a weekly schedule and derives a seven-day interval', () => {
    const result = parseSchedule("- cron: '0 2 * * 1'");
    expect(result.status).toBe('PASS');
    expect(result.frequency).toBe('WEEKLY');
    expect(result.scheduleUtc).toBe('MON 02:00 UTC');
    expect(result.configuredInterval).toBe('7 days');
  });

  test('parses the daily application backup schedule and derives a one-day interval', () => {
    const result = parseSchedule("- cron: '0 2 * * *'");
    expect(result.status).toBe('PASS');
    expect(result.frequency).toBe('DAILY');
    expect(result.scheduleUtc).toBe('DAILY 02:00 UTC');
    expect(result.configuredInterval).toBe('1 day');
    expect(result.theoreticalMaxGap).toBe('1 day');
  });

  test('normalizes, deduplicates, and orders events deterministically', () => {
    const events = normalizeEvents([
      { id: 'b', timestamp: '2026-08-14T04:00:02Z' },
      { id: 'a', timestamp: '2026-08-14T04:00:01+00:00' },
      { id: 'a', timestamp: '2026-08-14T04:00:03Z' },
    ]);
    expect(events.map((event) => event.id)).toEqual(['a', 'b']);
  });

  test('contains detector failures instead of throwing into the application path', () => {
    const result = safeEvaluate([{ id: 'evt', timestamp: '2026-08-14T04:00:00Z' }], () => {
      throw new Error('simulated_detector_failure');
    });
    expect(result).toEqual(expect.objectContaining({
      processingResult: 'error',
      error: 'simulated_detector_failure',
    }));
  });

  test('passes the local adversarial adapter suite', () => {
    const result = runAdversarialSuite();
    expect(result.passed).toBe(result.total);
  });

  test('keeps live enforcement independent of the optional external detector', () => {
    const report = buildReport({ repoRoot: path.resolve(__dirname, '../../..'), probeDocker: false });
    expect(report.fraudDetectorDecision).toBe('PASS_FOR_LIVE_MODE');
    expect(report.fraudDetectorDbAdapter).toBe('NOT_REQUIRED_EXTERNAL_DETECTOR_NOT_INTEGRATED');
    expect(report.fraudShadowMode).toBe('INTENTIONALLY_DISABLED');
  });

  test('keeps production cutover disabled and reports missing live evidence honestly', () => {
    const report = buildReport({ repoRoot: path.resolve(__dirname, '../../..'), probeDocker: false });
    expect(report.productionDeployEnabled).toBe(false);
    expect(report.productionSwitched).toBe('NO');
    expect(report.observedRpo).toBe('NOT_MEASURED');
    expect(report.observedRto).toBe('NOT_MEASURED');
    expect(renderReport(report)).toContain('PRODUCTION_DEPLOY_ENABLED=false');
  });

  test('pauses off-host execution explicitly when off-site credentials are missing', () => {
    // The DO_TOKEN probe was retired with the 2026-11-13 OCI cutover; the
    // fail-closed contract now hangs on the off-site object-storage credentials
    // themselves (names kept from the Spaces era, values point at OCI).
    const names = [
      'DO_TOKEN',
      'SPACES_ACCESS_KEY_ID',
      'SPACES_SECRET_ACCESS_KEY',
      'SPACES_ENDPOINT',
      'BACKUP_BUCKET',
      'BACKUP_ENCRYPTION_KEY',
    ];
    const saved = {};
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      const report = buildReport({ repoRoot: path.resolve(__dirname, '../../..'), probeDocker: false, executeOffhost: true });
      const verification = report.agents.backup.offhost.verification;
      expect(verification.status).toBe('BLOCKED_EXTERNAL_CREDENTIAL');
      expect(verification.blocker).toBe('SPACES_CREDENTIALS_MISSING');
      expect(report.finalStatus).toBe('RECOVERY_GATE_BLOCKED');
      expect(renderReport(report)).toContain('BLOCKED_EXTERNAL_CREDENTIAL');
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test('restore tooling is isolated-only and has no undefined shell verifier', async () => {
    const restoreSource = require('fs').readFileSync(path.join(__dirname, '..', 'restore-database.js'), 'utf8');
    expect(restoreSource).not.toMatch(/execSync/);
    const restore = new DatabaseRestore();
    restore.backupDir = require('os').tmpdir();
    require('fs').writeFileSync(path.join(restore.backupDir, 'recovery-gate-test.dump'), 'test');
    await expect(restore.restoreDatabase('recovery-gate-test.dump')).rejects.toThrow('RECOVERY_TARGET=isolated is required');
    require('fs').rmSync(path.join(restore.backupDir, 'recovery-gate-test.dump'), { force: true });
  });

  test('media restore rejects production targets and unsafe archive entries', () => {
    const media = new MediaRestore({ backupDir: require('os').tmpdir() });
    expect(() => media.assertIsolatedTarget()).toThrow('RECOVERY_TARGET=isolated is required');
    expect(() => media.assertSafeEntries(['safe/file.jpg', '../escape.txt'])).toThrow('unsafe path');
  });
});
