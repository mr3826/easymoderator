'use strict';

/**
 * Device E2E runner (Maestro) for the EasyMod merchant app.
 *
 *   node e2e/run-maestro.js --start-backend --apk <path.apk> [--flows smoke,logout]
 *
 * With --start-backend it migrates and seeds a disposable local Postgres/Redis
 * (refusing anything that is not local and test/e2e-named), starts the backend
 * with the disposable E2E controls enabled for this run only (random control
 * token), installs the APK, then runs every flow in FLOW_PLAN in order with a
 * fixture reset before each one. Each flow writes its own JUnit report; the run
 * fails if any flow fails. Nothing is skipped silently.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const scriptDirectory = path.dirname(path.resolve(process.argv[1]));
const mobileRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const backendRoot = path.join(repositoryRoot, 'EasyMod-backend');
const suitePath = path.join(scriptDirectory, 'flows');
const artifactRoot = path.join(scriptDirectory, 'artifacts');
const junitRoot = path.join(artifactRoot, 'junit');
const logcatPath = path.join(artifactRoot, 'adb-logcat.log');
const summaryJsonPath = path.join(artifactRoot, 'e2e-summary.json');
const summaryTextPath = path.join(artifactRoot, 'e2e-summary.txt');

const APP_ID = 'tech.easymod.merchant.dev';
const APP_SCHEME = process.env.E2E_APP_SCHEME || 'easymodmerchantdev';
const DEFAULT_EMAIL = 'mobile-dev@easymod.test';
const DEFAULT_PASSWORD = 'MobileDev123!';
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4000';
const BACKEND_POLL_INTERVAL_MS = 250;
const BACKEND_TIMEOUT_MS = 120000;
const METRO_PORT = 8081;
const METRO_POLL_INTERVAL_MS = 250;
const METRO_TIMEOUT_MS = 300000;
const METRO_BUNDLE_TIMEOUT_MS = 900000;
const SHUTDOWN_TIMEOUT_MS = 5000;

// Deterministic ids from EasyMod-backend/scripts/seed-mobile-dev.js
// (uuidv5 of `mobile-dev-seed-v1:<scope>`); asserted end to end by
// mobile-e2e-fixtures.integration.test.js.
const SEED = {
  secondOwnerEmail: 'mobile-dev-b@easymod.test',
  shopACustomerId: '56962817-240b-515a-8c02-e3f6268c7be6', // customer:draft-risky
  shopAOrderId: 'efc22718-691a-5966-8ac9-9f025c36da8b', // order:draft-large
  shopAConversationId: '9cf21b45-d24d-53ce-8559-a20a5dc877bf', // conversation:needs-reply
  shopAProductId: '1594cc1f-d329-55dc-8033-7bf979411da8', // product:low-stock-a
  shopBProductId: '4c432011-9187-5b43-bb46-3dbe5526308c', // product:shop-b-low-stock
};

/**
 * Every flow runs, in this order. `reset: false` keeps the previous flow's
 * backend state (the reinstall check needs the session the previous flow made);
 * `beforeFlow` runs a device step between flows.
 */
const FLOW_PLAN = [
  { name: 'state-preflight', file: 'wave25-state-preflight.yaml', device: false },
  { name: 'smoke', file: 'smoke.yaml' },
  { name: 'navigation', file: 'wave25-navigation.yaml' },
  { name: 'refresh', file: 'wave25-refresh.yaml' },
  { name: 'empty-home', file: 'empty-home.yaml' },
  { name: 'api-error', file: 'api-error.yaml' },
  { name: 'offline-reconnect', file: 'wave25-offline-reconnect.yaml' },
  { name: 'session-expiry', file: 'session-expiry.yaml' },
  { name: 'session-revocation', file: 'wave25-session-recovery.yaml' },
  { name: 'logout', file: 'logout.yaml' },
  { name: 'two-factor', file: 'two-factor.yaml' },
  { name: 'deep-link-stale', file: 'wave25-stale-entity.yaml' },
  { name: 'deep-link-cold-launch', file: 'deeplink-cold-launch.yaml' },
  { name: 'customer-quick-view', file: 'customer-quick-view.yaml' },
  { name: 'daily-operational-summary', file: 'daily-operational-summary.yaml' },
  { name: 'inbox-reply', file: 'inbox-reply-flow.yaml' },
  { name: 'order-confirm', file: 'order-confirm-flow.yaml' },
  { name: 'product-stock-stepper', file: 'product-stock-stepper.yaml' },
  { name: 'courier-booking', file: 'courier-booking-flow.yaml' },
  { name: 'reinstall-keeps-session', file: 'reinstall-keeps-session.yaml', reset: false, beforeFlow: 'reinstall' },
  { name: 'shop-isolation', file: 'shop-isolation.yaml' },
];

// The backend under test gets synthetic secrets only. Nothing from the caller's
// shell is inherited except what a Node process needs to start, so Meta,
// payment, courier, AI and telemetry credentials can never reach this server.
const INHERITED_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'windir',
  'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TZ', 'CI',
];

const SYNTHETIC_BACKEND_ENV = {
  APP_SECRET: 'mobile-e2e-app-secret-at-least-32-chars',
  AI_ACTION_GATE_SECRET: 'mobile-e2e-action-gate-secret-at-least-32-chars',
  CHANNEL_ENCRYPTION_KEY: 'a'.repeat(64),
  CSRF_SECRET: 'mobile-e2e-csrf-secret-at-least-32-chars',
  DELIVERY_ENCRYPTION_KEY: 'c'.repeat(64),
  JWT_ACCESS_SECRET: 'mobile-e2e-jwt-access-secret-at-least-32-chars',
  JWT_REFRESH_SECRET: 'mobile-e2e-jwt-refresh-secret-at-least-32-chars',
  META_APP_ID: 'mobile-e2e-app-id',
  META_APP_SECRET: 'mobile-e2e-meta-app-secret-at-least-32-chars',
  META_WEBHOOK_VERIFY_TOKEN: 'mobile-e2e-verify-token',
  PAYMENT_CALLBACK_HMAC_SECRET: 'mobile-e2e-payment-secret-at-least-32-chars',
  PAYMENT_ENCRYPTION_KEY: 'b'.repeat(64),
  REDIS_CACHE_DB: '11',
  REDIS_LEGACY_DB: '14',
  REDIS_PASSWORD: '',
  REDIS_PORT: '6379',
  REDIS_QUEUE_DB: '13',
  REDIS_RATELIMIT_DB: '12',
  REDIS_SESSION_DB: '10',
  REDIS_SSE_DB: '15',
  REDIS_HOST: '127.0.0.1',
  SESSION_SECRET: 'mobile-e2e-session-secret-at-least-32-chars',
};

let activeChild = null;
let backendChild = null;
let metroChild = null;
let interruptRequested = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptRequested = true;
    if (activeChild) activeChild.kill(signal);
    if (backendChild) backendChild.kill(signal);
    if (metroChild) metroChild.kill(signal);
  });
}

function parseArgs(argv) {
  const options = { install: false, preflight: false, startBackend: false, apkPath: null, flows: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--install') {
      options.install = true;
    } else if (argument === '--preflight') {
      options.preflight = true;
    } else if (argument === '--start-backend') {
      options.startBackend = true;
    } else if (argument === '--apk') {
      options.install = true;
      options.apkPath = argv[index + 1];
      index += 1;
      if (!options.apkPath) throw new Error('--apk requires a path');
    } else if (argument === '--flows') {
      options.flows = String(argv[index + 1] || '').split(',').map((name) => name.trim()).filter(Boolean);
      index += 1;
      if (options.flows.length === 0) throw new Error('--flows requires a comma-separated list');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function selectFlows(options) {
  if (options.preflight) return FLOW_PLAN.filter((flow) => flow.name === 'state-preflight');
  if (!options.flows) return FLOW_PLAN;
  const unknown = options.flows.filter((name) => !FLOW_PLAN.some((flow) => flow.name === name));
  if (unknown.length > 0) throw new Error(`Unknown flow(s): ${unknown.join(', ')}`);
  return FLOW_PLAN.filter((flow) => options.flows.includes(flow.name));
}

function resolveApkPath(rawPath) {
  const candidates = rawPath
    ? [path.resolve(process.cwd(), rawPath)]
    : [
        path.join(mobileRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
        path.join(mobileRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      ];
  const candidate = candidates.find((filePath) => fs.existsSync(filePath));
  if (!candidate) {
    throw new Error(`Development-variant APK was not found at ${candidates.join(' or ')}.`);
  }
  return candidate;
}

function assertFlowContract() {
  for (const flow of FLOW_PLAN) {
    const flowFile = path.join(suitePath, flow.file);
    if (!fs.existsSync(flowFile)) throw new Error(`Maestro flow is missing: ${flow.file}`);
    const source = fs.readFileSync(flowFile, 'utf8');
    if (!source.startsWith(`appId: ${APP_ID}`)) {
      throw new Error(`Maestro flow ${flow.file} must target ${APP_ID}.`);
    }
  }
  for (const name of fs.readdirSync(suitePath).filter((entry) => entry.endsWith('.yaml'))) {
    if (!FLOW_PLAN.some((flow) => flow.file === name)) {
      throw new Error(`Maestro flow ${name} is not scheduled in FLOW_PLAN; unscheduled flows are not allowed.`);
    }
  }
  const supportFiles = [
    path.join(scriptDirectory, 'support', 'restore-online.yaml'),
    path.join(scriptDirectory, 'support', 'sign-in.yaml'),
    path.join(scriptDirectory, 'scripts', 'fixture-control.js'),
    path.join(scriptDirectory, 'scripts', 'revoke-all-sessions.js'),
    path.join(scriptDirectory, 'scripts', 'assert-wave25-state-capabilities.js'),
  ];
  const missing = supportFiles.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) throw new Error(`E2E support files are missing: ${missing.join(', ')}`);
  for (const directory of [suitePath, path.join(scriptDirectory, 'support')]) {
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.yaml'))) {
      if (/^\s*-\s*wait\s*:/m.test(fs.readFileSync(path.join(directory, name), 'utf8'))) {
        throw new Error(`Maestro flow ${name} contains an arbitrary wait; use a condition-based wait instead.`);
      }
    }
  }
}

function runCommand(command, args, options = {}) {
  const { cwd = repositoryRoot, env = process.env, stdio = 'inherit' } = options;
  const useShell = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(command);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio, windowsHide: true, shell: useShell });
    activeChild = child;
    child.once('error', (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = null;
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function resetAppNavigation(adb) {
  if (await runCommand(adb, ['shell', 'am', 'force-stop', APP_ID]) !== 0) {
    throw new Error('Android app force-stop failed.');
  }

  const rootUrl = `${APP_SCHEME}:///`;
  if (await runCommand(adb, [
    'shell', 'am', 'start', '-W',
    '-a', 'android.intent.action.VIEW',
    '-d', rootUrl,
    '-p', APP_ID,
  ]) !== 0) {
    throw new Error(`Android app root navigation failed for ${rootUrl}.`);
  }
}

function captureCommand(command, args) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd: mobileRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('error', () => resolve(''));
    child.once('close', () => resolve(output.trim()));
  });
}

async function assertDeviceTools() {
  const adb = process.env.ADB_BIN || 'adb';
  const maestro = process.env.MAESTRO_BIN || 'maestro';
  try {
    if ((await runCommand(adb, ['version'], { stdio: 'ignore' })) !== 0) throw new Error('adb is unavailable');
  } catch (error) {
    throw new Error(`Android SDK adb is required for mobile E2E (${error.message}).`);
  }
  try {
    if ((await runCommand(maestro, ['--version'], { stdio: 'inherit' })) !== 0) {
      throw new Error('Maestro exited unsuccessfully');
    }
  } catch (error) {
    throw new Error(`Maestro CLI is required for mobile E2E (${error.message}).`);
  }
  if ((await runCommand(adb, ['get-state'], { stdio: 'ignore' })) !== 0) {
    throw new Error('No Android device/emulator is connected and ready (adb get-state failed).');
  }
  return { adb, maestro };
}

// Emulator images sometimes leave another app's "isn't responding" or "has
// stopped" dialog on screen. In CI, a Pixel Launcher ANR on API 34 covered the
// login screen for every flow of a run. On an emulator only, ask the system not
// to show error dialogs and close any that are up before each flow. A physical
// phone's settings are never touched, and a crash of this app still fails its
// flow, because the app is then not on screen.
async function isEmulator(adb) {
  const kernelQemu = await captureCommand(adb, ['shell', 'getprop', 'ro.kernel.qemu']);
  const bootQemu = await captureCommand(adb, ['shell', 'getprop', 'ro.boot.qemu']);
  return kernelQemu === '1' || bootQemu === '1';
}

async function closeSystemDialogs(adb) {
  await runCommand(adb, ['shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS'], {
    stdio: 'ignore',
  });
}

function localApiConfig() {
  const raw = process.env.E2E_API_BASE_URL || DEFAULT_API_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('E2E_API_BASE_URL must be a valid local http:// URL.');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('E2E_API_BASE_URL must target localhost or 127.0.0.1 over http://.');
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('E2E_API_BASE_URL must include a valid TCP port.');
  }
  return { baseUrl: raw.replace(/\/$/, ''), port };
}

function assertDisposableDatabase(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid postgres:// URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('E2E_DATABASE_URL must use postgres:// or postgresql://.');
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('E2E_DATABASE_URL must target localhost or 127.0.0.1.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/(e2e|test)/i.test(databaseName) || /production/i.test(databaseName)) {
    throw new Error('E2E_DATABASE_URL database name must contain "e2e" or "test" and never "production".');
  }
}

function assertDisposableRedis(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('E2E_REDIS_URL must be a valid redis:// URL.');
  }
  if (parsed.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('E2E_REDIS_URL must target localhost or 127.0.0.1 over redis://.');
  }
}

function backendEnvironment(password, apiPort, controlToken) {
  const databaseUrl = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL;
  const redisUrl = process.env.E2E_REDIS_URL || process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('Starting the E2E backend requires E2E_DATABASE_URL and E2E_REDIS_URL.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The mobile E2E backend refuses NODE_ENV=production.');
  }
  assertDisposableDatabase(databaseUrl);
  assertDisposableRedis(redisUrl);

  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    ...SYNTHETIC_BACKEND_ENV,
    API_URL: `http://127.0.0.1:${apiPort}`,
    BASE_URL: `http://127.0.0.1:${apiPort}`,
    CORS_ORIGINS: `http://127.0.0.1:${apiPort},http://localhost:${apiPort}`,
    DATABASE_URL: databaseUrl,
    DB_SSL: 'false',
    FRONTEND_URL: `http://127.0.0.1:${apiPort}`,
    GROWTH_OS_ENABLED: 'false',
    MOBILE_API_ENABLED: 'true',
    MOBILE_DEV_SEED_PASSWORD: password,
    MOBILE_E2E_FIXTURES_ENABLED: 'true',
    MOBILE_E2E_FIXTURES_TOKEN: controlToken,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    PUBLIC_ASSET_URL: `http://127.0.0.1:${apiPort}`,
    REDIS_URL: redisUrl,
    RUN_MIGRATIONS_ON_STARTUP: 'false',
    START_EMBEDDED_WORKERS: 'false',
  };
}

async function waitForBackend(baseUrl) {
  const deadline = Date.now() + BACKEND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (backendChild && backendChild.exitCode !== null) {
      throw new Error(`E2E backend exited before health check (code ${backendChild.exitCode}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.service === 'easymod-backend' && body.status === 'ok') return;
      }
    } catch {
      // The next poll is the condition-based wait; startup can still be in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_INTERVAL_MS));
  }
  throw new Error(`E2E backend did not become healthy within ${BACKEND_TIMEOUT_MS / 1000} seconds.`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
  });
}

async function waitForMetro() {
  const deadline = Date.now() + METRO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (metroChild && metroChild.exitCode !== null) {
      throw new Error(`Metro exited before becoming ready (code ${metroChild.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${METRO_PORT}/status`);
      if (response.ok) return;
    } catch {
      // Metro can take a few seconds to initialise its HTTP server.
    }
    await new Promise((resolve) => setTimeout(resolve, METRO_POLL_INTERVAL_MS));
  }
  throw new Error(`Metro did not become healthy within ${METRO_TIMEOUT_MS / 1000} seconds.`);
}

/** Only a debug APK needs Metro; a release-mode APK embeds its bundle. */
async function startMetro() {
  const expoCli = path.join(mobileRoot, 'node_modules', 'expo', 'bin', 'cli');
  if (!fs.existsSync(expoCli)) throw new Error(`Expo CLI is missing at ${expoCli}.`);

  metroChild = spawn(process.execPath, [expoCli, 'start', '--host=lan', `--port=${METRO_PORT}`], {
    cwd: mobileRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
  });
  metroChild.once('error', (error) => console.error(`E2E Metro process error: ${error.message}`));
  await waitForMetro();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METRO_BUNDLE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `http://127.0.0.1:${METRO_PORT}/node_modules/expo-router/entry.bundle?platform=android&dev=true&hot=false&lazy=false&minify=false`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`Metro bundle prewarm returned HTTP ${response.status}.`);
    await response.arrayBuffer();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Metro Android bundle did not finish within ${METRO_BUNDLE_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runSeedCommand(environment, remove = false) {
  const args = ['scripts/seed-mobile-dev.js'];
  if (remove) args.push('--remove');
  return runCommand(process.execPath, args, { cwd: backendRoot, env: environment, stdio: 'inherit' });
}

async function startBackend(environment, apiConfig) {
  const migrationCode = await runCommand(process.execPath, ['src/database/migrate.js', 'up'], {
    cwd: backendRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (migrationCode !== 0) throw new Error('E2E database migrations failed.');

  if ((await runSeedCommand(environment, true)) !== 0) throw new Error('E2E mobile fixture reset failed.');
  if ((await runSeedCommand(environment)) !== 0) throw new Error('E2E mobile fixture seeding failed.');

  backendChild = spawn(process.execPath, ['server.js'], {
    cwd: backendRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: environment,
  });
  backendChild.once('error', (error) => console.error(`E2E backend process error: ${error.message}`));
  await waitForBackend(apiConfig.baseUrl);
}

async function fixtureControl(baseUrl, controlToken, action) {
  const response = await fetch(`${baseUrl}/api/mobile/e2e/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mobile-E2E-Control': controlToken },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new Error(`E2E fixture control "${action}" returned HTTP ${response.status}.`);
  return (await response.json()).data;
}

async function runFlow(maestro, flow, flowEnv) {
  const flowArtifacts = path.join(artifactRoot, 'flows', flow.name);
  fs.mkdirSync(flowArtifacts, { recursive: true });
  fs.mkdirSync(junitRoot, { recursive: true });
  const args = [
    'test',
    '--no-ansi',
    '--format=junit',
    `--output=${path.join(junitRoot, `${flow.name}.xml`)}`,
    `--test-output-dir=${flowArtifacts}`,
    `--debug-output=${path.join(flowArtifacts, 'debug-output')}`,
    '--flatten-debug-output',
    ...Object.entries(flowEnv).map(([key, value]) => `--env=${key}=${value}`),
    path.join(suitePath, flow.file),
  ];
  return runCommand(maestro, args, { cwd: mobileRoot, stdio: 'inherit' });
}

function redactDeviceLogs(value) {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:access|refresh|temp)[_-]?token|password|secret|X-Mobile-E2E-Control)(\s*[:=]\s*)[^,\s}]+/gi, '$1$2[REDACTED]');
}

async function captureDeviceLog(adb) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  // Keep the newest 4 MB: the dump starts at emulator boot, so keeping the oldest lost every flow.
  const maxBytes = 4 * 1024 * 1024;
  await new Promise((resolve) => {
    let output = '';
    const append = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 2 * maxBytes) output = output.slice(-maxBytes);
    };
    const child = spawn(adb, ['logcat', '-d', '-v', 'threadtime', '-b', 'main,crash'], {
      cwd: mobileRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      fs.writeFileSync(logcatPath, `adb logcat unavailable: ${error.message}\n`, 'utf8');
      resolve();
    });
    child.once('close', (code) => {
      if (code !== 0 && !output) output = `adb logcat exited with code ${code}.\n`;
      fs.writeFileSync(logcatPath, redactDeviceLogs(output.slice(-maxBytes)), 'utf8');
      resolve();
    });
  });
}

async function describeRun(adb, apkPath) {
  const packageInfo = await captureCommand(adb, ['shell', 'dumpsys', 'package', APP_ID]);
  const field = (name) => (packageInfo.match(new RegExp(`${name}=(\\S+)`)) || [])[1] || 'unknown';
  return {
    appId: APP_ID,
    apk: apkPath ? path.basename(apkPath) : null,
    apkSha256: apkPath ? crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex') : null,
    versionCode: field('versionCode'),
    versionName: field('versionName'),
    deviceSdk: await captureCommand(adb, ['shell', 'getprop', 'ro.build.version.sdk']),
    deviceAbi: await captureCommand(adb, ['shell', 'getprop', 'ro.product.cpu.abi']),
    deviceModel: await captureCommand(adb, ['shell', 'getprop', 'ro.product.model']),
    sourceSha: process.env.GITHUB_SHA || process.env.GIT_SHA || 'unknown',
  };
}

function writeSummary(identity, results) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(summaryJsonPath, JSON.stringify({ identity, results }, null, 2), 'utf8');
  const lines = [
    `APP=${identity.appId} VERSION=${identity.versionName} (${identity.versionCode}) APK_SHA256=${identity.apkSha256}`,
    `DEVICE=${identity.deviceModel} SDK=${identity.deviceSdk} ABI=${identity.deviceAbi} SOURCE_SHA=${identity.sourceSha}`,
    'FLOW | RESULT | SECONDS',
    ...results.map((result) => `${result.name} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.seconds}`),
  ];
  fs.writeFileSync(summaryTextPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\n${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertFlowContract();
  const flows = selectFlows(options);

  const email = process.env.E2E_EMAIL || DEFAULT_EMAIL;
  const password = process.env.E2E_PASSWORD || DEFAULT_PASSWORD;
  if (email !== DEFAULT_EMAIL) throw new Error(`E2E_EMAIL must be ${DEFAULT_EMAIL} (the seeded owner).`);
  const apiConfig = localApiConfig();
  const controlToken = crypto.randomBytes(32).toString('hex');
  let deviceTools = null;
  let apkPath = null;
  let backendEnvironmentForChild = null;
  let emulator = false;
  let previousHideErrorDialogs = null;
  const results = [];
  let exitCode = 1;

  try {
    deviceTools = await assertDeviceTools();
    emulator = await isEmulator(deviceTools.adb);
    if (emulator) {
      previousHideErrorDialogs = await captureCommand(deviceTools.adb, ['shell', 'settings', 'get', 'global', 'hide_error_dialogs']);
      await runCommand(deviceTools.adb, ['shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'], { stdio: 'ignore' });
    }
    apkPath = options.install ? resolveApkPath(options.apkPath) : null;
    if (options.startBackend) {
      backendEnvironmentForChild = backendEnvironment(password, apiConfig.port, controlToken);
      await startBackend(backendEnvironmentForChild, apiConfig);
    }

    // Physical devices reach the host backend through adb reverse; the CI
    // emulator build uses 10.0.2.2 instead so airplane mode really cuts it off.
    for (const port of [apiConfig.port, METRO_PORT]) {
      if ((await runCommand(deviceTools.adb, ['reverse', `tcp:${port}`, `tcp:${port}`])) !== 0) {
        throw new Error(`adb reverse tcp:${port} failed.`);
      }
    }

    if (apkPath) {
      if ((await runCommand(deviceTools.adb, ['install', '-r', apkPath])) !== 0) {
        throw new Error('APK installation failed.');
      }
      if ((await runCommand(deviceTools.adb, ['shell', 'pm', 'clear', APP_ID])) !== 0) {
        throw new Error('Android app state clear failed.');
      }
      if (apkPath.includes(`${path.sep}debug${path.sep}`)) await startMetro();
    }

    const flowEnv = {
      E2E_API_BASE_URL: apiConfig.baseUrl,
      E2E_CONTROL_TOKEN: controlToken,
      E2E_EMAIL: email,
      E2E_PASSWORD: password,
      E2E_SECOND_EMAIL: SEED.secondOwnerEmail,
      E2E_SHOP_A_CUSTOMER_ID: SEED.shopACustomerId,
      E2E_SHOP_A_ORDER_ID: SEED.shopAOrderId,
      E2E_SHOP_A_CONVERSATION_ID: SEED.shopAConversationId,
      E2E_SHOP_A_PRODUCT_ID: SEED.shopAProductId,
      E2E_SHOP_B_PRODUCT_ID: SEED.shopBProductId,
    };

    for (const flow of flows) {
      if (interruptRequested) break;
      const startedAt = Date.now();
      let passed = false;
      try {
        if (options.startBackend && flow.reset !== false) {
          await fixtureControl(apiConfig.baseUrl, controlToken, 'reset');
        }
        if (flow.beforeFlow === 'reinstall') {
          if (!apkPath) throw new Error('reinstall-keeps-session needs --apk.');
          if ((await runCommand(deviceTools.adb, ['install', '-r', apkPath])) !== 0) {
            throw new Error('APK reinstall over the signed-in app failed.');
          }
        }
        // Maestro launchApp can restore the previous navigation stack. Re-open
        // the app's root URL between flows so every scenario starts from
        // AuthProvider's Home route without clearing SecureStore or invalidating
        // the reinstall-session flow.
        await resetAppNavigation(deviceTools.adb);
        if (emulator) await closeSystemDialogs(deviceTools.adb);
        console.log(`\n=== FLOW ${flow.name} (${flow.file}) ===`);
        passed = (await runFlow(deviceTools.maestro, flow, flowEnv)) === 0;
      } catch (error) {
        console.error(`FLOW ${flow.name} could not run: ${error.message}`);
      }
      results.push({ name: flow.name, file: flow.file, passed, seconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    exitCode = results.length === flows.length && results.every((result) => result.passed) ? 0 : 1;
  } finally {
    try {
      await stopChild(metroChild);
      metroChild = null;
      await stopChild(backendChild);
      backendChild = null;
      if (backendEnvironmentForChild) {
        const removeCode = await runSeedCommand(backendEnvironmentForChild, true);
        if (exitCode === 0 && removeCode !== 0) exitCode = removeCode;
      }
    } finally {
      const adb = deviceTools?.adb || process.env.ADB_BIN || 'adb';
      try {
        writeSummary(await describeRun(adb, apkPath), results);
      } catch (error) {
        console.error(`E2E summary failed: ${error.message}`);
      }
      try {
        await captureDeviceLog(adb);
      } catch (error) {
        console.error(`E2E log capture failed: ${error.message}`);
      }
      if (emulator) {
        // Leave a developer's emulator as it was.
        const restore = !previousHideErrorDialogs || previousHideErrorDialogs === 'null'
          ? ['shell', 'settings', 'delete', 'global', 'hide_error_dialogs']
          : ['shell', 'settings', 'put', 'global', 'hide_error_dialogs', previousHideErrorDialogs];
        await runCommand(adb, restore, { stdio: 'ignore' }).catch(() => {});
      }
    }
  }

  console[exitCode === 0 ? 'log' : 'error'](
    `MOBILE_E2E=${exitCode === 0 ? 'PASS' : 'FAILED'} framework=maestro appId=${APP_ID} flows=${results.length}/${flows.length}`,
  );
  return interruptRequested ? 130 : exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`MOBILE_E2E=BLOCKED_OR_FAILED ${error.message}`);
    process.exitCode = interruptRequested ? 130 : 1;
  });
