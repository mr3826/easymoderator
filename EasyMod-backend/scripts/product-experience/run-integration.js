'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { terminateProcessTree } = require('./terminate-process-tree');

const SCRIPT_ROOT = __dirname;
const BACKEND_ROOT = path.resolve(SCRIPT_ROOT, '../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const ARTIFACT_ROOT = path.resolve(process.env.LAB_ARTIFACT_ROOT
    || path.join(REPO_ROOT, 'docs', 'ai', 'product-experience-v1-3', 'artifacts'));
const REPORT_ROOT = path.join(ARTIFACT_ROOT, 'integration');
const EGRESS_FENCE = path.join(SCRIPT_ROOT, 'no-egress.js');
const COMPOSE_FILE = path.join(SCRIPT_ROOT, 'lab-integration.compose.yml');
const TESTS = [
    'src/modules/integration/__tests__/meta-webhook-durability.integration.test.js',
    'src/jobs/__tests__/message-worker.action-gate.integration.test.js',
    'src/jobs/__tests__/message-worker.recovery.integration.test.js',
];
const META_E2E_TEST = 'tests/meta-e2e/meta-e2e.test.js';

const hashBackendSourceTree = engineRoot => {
    const sourceRoot = path.join(engineRoot, 'src');
    const files = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(filename);
            else if (entry.isFile() && !entry.name.startsWith('intent-router.lab-baseline-')) files.push(filename);
        }
    };
    visit(sourceRoot);
    const relative = filename => path.relative(sourceRoot, filename).replace(/\\/g, '/');
    files.sort((left, right) => {
        const a = relative(left);
        const b = relative(right);
        return a < b ? -1 : a > b ? 1 : 0;
    });
    const digest = crypto.createHash('sha256');
    for (const filename of files) digest.update(relative(filename), 'utf8').update('\0').update(fs.readFileSync(filename)).update('\0');
    return digest.digest('hex');
};

const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(error => error ? reject(error) : resolve(port));
    });
});

const resolveExternalServicePorts = (env = process.env) => {
    if (env.LAB_EXTERNAL_SERVICES !== 'true') return null;
    if (!String(env.LAB_POSTGRES_PORT ?? '') || !String(env.LAB_REDIS_PORT ?? '')) {
        throw new Error('LAB_EXTERNAL_SERVICES requires both LAB_POSTGRES_PORT and LAB_REDIS_PORT.');
    }
    const parsePort = name => {
        const raw = String(env[name] ?? '');
        if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer TCP port.`);
        const port = Number(raw);
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
            throw new Error(`${name} must be between 1024 and 65535.`);
        }
        return port;
    };
    const postgresPort = parsePort('LAB_POSTGRES_PORT');
    const redisPort = parsePort('LAB_REDIS_PORT');
    if (postgresPort === redisPort) throw new Error('LAB_POSTGRES_PORT and LAB_REDIS_PORT must be distinct.');
    return { postgresPort, redisPort };
};

const ipv4Range = (cidr) => {
    const match = String(cidr || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (!match) return null;
    const prefix = Number(match[2]);
    const octets = match[1].split('.').map(Number);
    if (prefix < 0 || prefix > 32 || octets.some(octet => octet < 0 || octet > 255)) return null;
    const address = octets.reduce((value, octet) => value * 256 + octet, 0);
    const size = 2 ** (32 - prefix);
    const start = Math.floor(address / size) * size;
    return { start, end: start + size - 1 };
};

const rangesOverlap = (left, right) => left.start <= right.end && right.start <= left.end;

const netmaskPrefix = (netmask) => String(netmask || '').split('.').reduce((total, octet) => {
    const value = Number(octet);
    return total + (Number.isInteger(value) && value >= 0 && value <= 255
        ? value.toString(2).replace(/0/g, '').length
        : 0);
}, 0);

const waitForLoopbackPort = async (port, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const accepting = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.setTimeout(1000);
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('timeout', () => { socket.destroy(); resolve(false); });
            socket.once('error', () => resolve(false));
        });
        if (accepting) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
};

const selectInternalSubnet = async (dockerEnv) => {
    const listed = await run('docker', ['network', 'ls', '--quiet', '--no-trunc'], { cwd: SCRIPT_ROOT, env: dockerEnv, timeoutMs: 30000 });
    if (listed.code !== 0) throw new Error('Could not inspect local Docker networks to reserve a non-overlapping lab subnet.');
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    const inspected = ids.length
        ? await run('docker', ['network', 'inspect', ...ids], { cwd: SCRIPT_ROOT, env: dockerEnv, timeoutMs: 30000 })
        : { code: 0, stdout: '[]' };
    if (inspected.code !== 0) throw new Error('Could not read local Docker subnet allocations for the lab.');
    const dockerRanges = JSON.parse(inspected.stdout).flatMap(network => (network.IPAM?.Config || [])
        .map(config => ipv4Range(config.Subnet)).filter(Boolean));
    const hostRanges = Object.values(os.networkInterfaces()).flatMap(items => (items || [])
        .filter(item => item.family === 'IPv4' && item.address && item.netmask)
        .map(item => ipv4Range(`${item.address}/${netmaskPrefix(item.netmask)}`)).filter(Boolean));
    const used = [...dockerRanges, ...hostRanges];
    for (let third = 255; third >= 0; third -= 1) {
        for (let fourth = 240; fourth >= 0; fourth -= 16) {
            const subnet = `10.254.${third}.${fourth}/28`;
            const range = ipv4Range(subnet);
            if (!used.some(existing => rangesOverlap(range, existing))) return subnet;
        }
    }
    throw new Error('No free /28 subnet was found in the reserved 10.254.0.0/16 lab range.');
};

const run = (command, args, { cwd, env, timeoutMs = 240000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutCleanup = null;
    let settled = false;
    let killWatchdog = null;
    const finish = (code, signal = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killWatchdog);
        resolve({ code: code ?? 1, signal, timedOut, timeoutCleanup, stdout, stderr });
    };
    const timer = setTimeout(() => {
        timedOut = true;
        timeoutCleanup = terminateProcessTree(child);
        killWatchdog = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(child.exitCode ?? 1, child.signalCode || null);
        }, 5000);
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killWatchdog);
        reject(error);
    });
    child.once('close', (code, signal) => finish(code, signal || null));
});

const redact = (value) => String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[redacted]')
    .replace(/redis:\/\/[^\s"']+/gi, 'redis://[redacted]')
    .replace(/(?:\+?880\s*)?0?(1[3-9]\d{8})\b/g, '[contact redacted]')
    .replace(/\b\d{12,20}\b/g, '[identifier redacted]')
    .replace(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi, '[email redacted]')
    .replace(/(TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]');

const minimalWindowsEnv = () => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_HOST: process.env.DOCKER_HOST,
    LAB_ARTIFACT_ROOT: ARTIFACT_ROOT,
});

const integrationEnv = (postgresPort, redisPort, egressAttemptsPath) => ({
    ...minimalWindowsEnv(),
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://lab:lab-local-only@127.0.0.1:${postgresPort}/easymod_product_lab_test`,
    DB_SSL: 'false',
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    REDIS_SESSION_DB: '10',
    REDIS_CACHE_DB: '11',
    REDIS_RATELIMIT_DB: '12',
    REDIS_QUEUE_DB: '13',
    REDIS_LEGACY_DB: '14',
    REDIS_SSE_DB: '15',
    GROWTH_OS_ENABLED: 'true',
    CHANNEL_ENCRYPTION_KEY: 'a'.repeat(64),
    PAYMENT_ENCRYPTION_KEY: 'b'.repeat(64),
    DELIVERY_ENCRYPTION_KEY: 'c'.repeat(64),
    JWT_ACCESS_SECRET: 'product-lab-jwt-access-secret-at-least-32',
    JWT_REFRESH_SECRET: 'product-lab-jwt-refresh-secret-at-least-32',
    SESSION_SECRET: 'product-lab-session-secret-at-least-32-chars',
    AI_ACTION_GATE_SECRET: 'product-lab-action-gate-secret-at-least-32-chars',
    SLACK_ALERT_WEBHOOK_URL: '',
    SENTRY_DSN: '',
    QDRANT_URL: '',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    META_ACCESS_TOKEN: '',
    FACEBOOK_ACCESS_TOKEN: '',
    NODE_OPTIONS: `--require=${EGRESS_FENCE}`,
    LAB_EGRESS_ATTEMPTS_PATH: egressAttemptsPath,
});

const inspectExternalServices = async (postgresPort, redisPort) => {
    const { Client } = require('pg');
    const Redis = require('ioredis');
    const postgresClient = new Client({
        connectionString: `postgres://lab:lab-local-only@127.0.0.1:${postgresPort}/easymod_product_lab_test`,
        ssl: false,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
    });
    let postgres;
    try {
        await postgresClient.connect();
        const result = await postgresClient.query(`
            SELECT current_database() AS database,
                   current_user AS role,
                   current_setting('server_version') AS version,
                   (SELECT count(*)::int
                    FROM pg_catalog.pg_class AS cls
                    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace
                    WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
                      AND cls.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS user_object_count
        `);
        postgres = result.rows[0];
        if (postgres.database !== 'easymod_product_lab_test' || postgres.role !== 'lab') {
            throw new Error('External PostgreSQL must expose the isolated product-lab database and role.');
        }
        if (Number(postgres.user_object_count) !== 0) {
            throw new Error('External product-lab PostgreSQL database must have no user tables, views, or sequences before migrations.');
        }
    } finally {
        await postgresClient.end().catch(() => {});
    }

    const redisClient = new Redis({
        host: '127.0.0.1',
        port: redisPort,
        lazyConnect: true,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        enableOfflineQueue: false,
    });
    let redis;
    const checkedDatabases = [];
    try {
        await redisClient.connect();
        const serverInfo = await redisClient.info('server');
        const version = serverInfo.match(/^redis_version:([^\r\n]+)/m)?.[1];
        if (!version) throw new Error('External Redis did not return its server version.');
        const requiredDatabases = [0, 1, 2, 3, 10, 11, 12, 13, 14, 15, 20, 21, 22];
        for (const database of requiredDatabases) {
            await redisClient.select(database);
            const keyCount = await redisClient.dbsize();
            if (keyCount !== 0) throw new Error(`External Redis database ${database} must be empty before integration.`);
            checkedDatabases.push(database);
        }
        redis = { version, checkedDatabases };
    } finally {
        if (redisClient.status === 'ready') await redisClient.quit().catch(() => redisClient.disconnect());
        else redisClient.disconnect();
    }
    return {
        postgres: {
            version: postgres.version,
            database: postgres.database,
            role: postgres.role,
            userObjectCountBeforeMigrations: Number(postgres.user_object_count),
        },
        redis,
    };
};

const parseJestSummary = (output) => {
    const suites = output.match(/Test Suites:\s+([^\r\n]+)/)?.[1] || 'unavailable';
    const tests = output.match(/Tests:\s+([^\r\n]+)/)?.[1] || 'unavailable';
    const duration = output.match(/Time:\s+([^\r\n]+)/)?.[1] || 'unavailable';
    return { suites, tests, duration };
};

const summarizeJestReport = (reportPath) => {
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const failedSuites = (report.testResults || []).filter(result => result.status === 'failed');
        return {
            passedSuites: report.numPassedTestSuites ?? null,
            failedSuites: report.numFailedTestSuites ?? null,
            passedTests: report.numPassedTests ?? null,
            failedTests: report.numFailedTests ?? null,
            passedTestTitles: (report.testResults || []).flatMap(result => (result.assertionResults || [])
                .filter(assertion => assertion.status === 'passed')
                .map(assertion => assertion.fullName || assertion.title || 'unnamed assertion')),
            failedSuiteDiagnostics: failedSuites.map(result => {
                const messages = [result.message, ...(result.assertionResults || []).flatMap(assertion => assertion.failureMessages || [])]
                    .filter(Boolean).join('\n');
                const errorType = messages.match(/\b(Sequelize[A-Za-z]+Error|[A-Za-z_$][\w$]*(?:Error|Exception))\b/)?.[1] || 'UNCLASSIFIED';
                const kinds = [];
                if (/Jest did not exit|open handles/i.test(messages)) kinds.push('OPEN_HANDLE');
                if (/afterAll|afterEach|beforeAll|beforeEach/i.test(messages)) kinds.push('LIFECYCLE_HOOK');
                if (/worker process/i.test(messages)) kinds.push('JEST_WORKER');
                if (/Test suite failed to run/i.test(messages)) kinds.push('SUITE_SETUP');
                if (/AssertionError|expect\(|Received:/i.test(messages)) kinds.push('ASSERTION');
                if (kinds.length === 0) kinds.push('UNCLASSIFIED_SUITE_FAILURE');

                const locations = [];
                const framePattern = /\(([^\r\n]*?\.(?:js|cjs|mjs|ts)):(\d+):(\d+)\)/g;
                for (const match of messages.matchAll(framePattern)) {
                    const absolutePath = path.resolve(match[1]);
                    const relativePath = path.relative(BACKEND_ROOT, absolutePath);
                    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
                        locations.push(`${relativePath.replace(/\\/g, '/')}:${match[2]}:${match[3]}`);
                    }
                    if (locations.length >= 8) break;
                }
                const failedAssertions = (result.assertionResults || [])
                    .filter(assertion => assertion.status === 'failed')
                    .map(assertion => {
                        const failureText = (assertion.failureMessages || []).join('\n');
                        const scalar = (value) => {
                            const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
                            return /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|SEND|SAFE_FALLBACK|BLOCKED|AVAILABLE|UNAVAILABLE|NOT_FOUND|ANSWERABLE|NOT_ANSWERABLE|VERIFIED|OPENAI|GEMINI(?:-LITE|-PRO)?|AUTO|DRAFT|MANUAL|HELD)$/i.test(normalized)
                                ? normalized.slice(0, 64)
                                : null;
                        };
                        const expected = failureText.match(/^\s*Expected:\s*(.+)$/m)?.[1]
                            || failureText.match(/^\s*Expected substring:\s*(.+)$/m)?.[1];
                        const received = failureText.match(/^\s*Received:\s*(.+)$/m)?.[1];
                        const callCounts = failureText.match(/Expected number of calls:\s*(\d+)[\s\S]*?Received number of calls:\s*(\d+)/);
                        const testTitle = assertion.fullName || assertion.title || 'unnamed assertion';
                        return {
                            caseId: crypto.createHash('sha256').update(testTitle).digest('hex').slice(0, 16),
                            location: assertion.location || null,
                            expected: scalar(expected),
                            received: scalar(received),
                            expectedCalls: callCounts ? Number(callCounts[1]) : null,
                            receivedCalls: callCounts ? Number(callCounts[2]) : null,
                            failureMessage: redact(failureText).slice(0, 1800),
                            assertionKind: /Expected substring:/.test(failureText) ? 'MISSING_SUBSTRING' : 'VALUE_MISMATCH',
                        };
                    });
                return {
                    suite: path.relative(BACKEND_ROOT, result.name).replace(/\\/g, '/'),
                    errorType,
                    kinds,
                    locations,
                    failedAssertions,
                    sanitizedFailureExcerpt: redact(messages).slice(0, 1800),
                };
            }),
        };
    } catch (_) {
        return null;
    }
};

const ensureComposeBoundary = async (project, postgresPort, redisPort, networkSubnet, dockerEnv) => {
    const config = await run('docker-compose', ['-p', project, '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
        cwd: SCRIPT_ROOT,
        env: { ...dockerEnv, LAB_POSTGRES_PORT: String(postgresPort), LAB_REDIS_PORT: String(redisPort), LAB_NETWORK_SUBNET: networkSubnet },
        timeoutMs: 30000,
    });
    if (config.code !== 0) throw new Error(`Docker Compose configuration validation failed (${config.code}). ${redact(config.stderr).slice(0, 300)}`);
    const model = JSON.parse(config.stdout);
    const serviceNames = Object.keys(model.services || {}).sort();
    if (serviceNames.join(',') !== 'postgres,redis') throw new Error('Test Lab Compose services do not match the fixed allowlist.');
    const serviceNetwork = model.networks?.default || {};
    if (serviceNetwork.driver !== 'bridge' || serviceNetwork.internal === true) throw new Error('Test Lab services must use the dedicated host-published bridge required for loopback database access.');
    if (String(serviceNetwork.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade']) !== 'false') {
        throw new Error('Test Lab bridge must disable Docker IP masquerading.');
    }
    if (model.networks?.default?.ipam?.config?.[0]?.subnet !== networkSubnet) throw new Error('Test Lab Compose network did not use the reserved subnet.');
    const expectedPorts = { postgres: { host: String(postgresPort), target: 5432 }, redis: { host: String(redisPort), target: 6379 } };
    for (const [serviceName, service] of Object.entries(model.services)) {
        if (service.volumes?.length) throw new Error('Test Lab Compose cannot mount a persistent volume.');
        for (const port of service.ports || []) {
            if (port.host_ip !== '127.0.0.1') throw new Error('Test Lab services must publish only to loopback.');
            if (port.published !== expectedPorts[serviceName]?.host || port.target !== expectedPorts[serviceName]?.target) {
                throw new Error('Test Lab service port mapping does not match its reserved loopback port.');
            }
        }
        if (service.ports?.length !== 1) throw new Error('Each Test Lab service must publish exactly one loopback port.');
    }
};

const main = async () => {
    const externalServices = resolveExternalServicePorts(process.env);
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    const runId = crypto.randomUUID();
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const candidateBackendSourceSha256 = hashBackendSourceTree(BACKEND_ROOT);
    const runnerSourceSha256 = require('./lab-server').getSourceProvenance().runnerSourceSha256;
    const sourceBranch = process.env.LAB_SOURCE_BRANCH
        || execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
        || 'detached';
    const project = `easymod-product-lab-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const postgresPort = externalServices?.postgresPort ?? await freePort();
    let redisPort = externalServices?.redisPort ?? await freePort();
    while (!externalServices && redisPort === postgresPort) redisPort = await freePort();
    const dockerEnv = minimalWindowsEnv();
    const networkSubnet = externalServices ? null : await selectInternalSubnet(dockerEnv);
    const egressAttemptsPath = path.join(REPORT_ROOT, `${runId}.egress-attempts.txt`);
    fs.writeFileSync(egressAttemptsPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const env = integrationEnv(postgresPort, redisPort, egressAttemptsPath);
    const startedAt = new Date().toISOString();
    const timeline = [];
    let composeStarted = false;
    let failure = null;
    let migration = null;
    let jest = null;
    let metaE2eJest = null;
    let backendRegression = null;
    let jestStructured = null;
    let metaE2eJestStructured = null;
    let backendRegressionStructured = null;
    let metaE2eDeliveryDiagnostics = [];
    let externalServiceInfo = null;
    let cleanup = null;
    const temporaryJestReports = [];
    const metaE2eDiagnosticsPath = path.join(os.tmpdir(), `${runId}-meta-e2e-diagnostics.json`);
    temporaryJestReports.push(metaE2eDiagnosticsPath);
    env.META_E2E_DIAGNOSTICS_PATH = metaE2eDiagnosticsPath;

    try {
        if (!externalServices) {
            await ensureComposeBoundary(project, postgresPort, redisPort, networkSubnet, dockerEnv);
            composeStarted = true;
            const up = await run('docker-compose', ['-p', project, '-f', COMPOSE_FILE, 'up', '-d', '--wait', '--wait-timeout', '120'], {
                cwd: SCRIPT_ROOT,
                env: { ...dockerEnv, LAB_POSTGRES_PORT: String(postgresPort), LAB_REDIS_PORT: String(redisPort), LAB_NETWORK_SUBNET: networkSubnet },
                timeoutMs: 180000,
            });
            timeline.push({ stage: 'compose_up', exitCode: up.code, timedOut: up.timedOut, timeoutCleanup: up.timeoutCleanup });
            if (up.code !== 0) throw new Error(`Disposable PostgreSQL and Redis services did not become healthy (${up.code}). ${redact(up.stderr).slice(0, 300)}`);
        }

        const postgresLoopbackReady = await waitForLoopbackPort(postgresPort);
        const redisLoopbackReady = await waitForLoopbackPort(redisPort);
        if (!postgresLoopbackReady || !redisLoopbackReady) throw new Error('Both services must accept TCP connections through their reserved loopback ports.');
        if (externalServices) {
            const readinessStart = Date.now();
            externalServiceInfo = await inspectExternalServices(postgresPort, redisPort);
            timeline.push({
                stage: 'external_services_ready',
                exitCode: 0,
                durationMs: Date.now() - readinessStart,
                provider: 'user-provisioned-wsl-loopback',
                postgres: externalServiceInfo.postgres,
                redis: externalServiceInfo.redis,
            });
        }

        const nodeExe = process.execPath;
        const migrationStart = Date.now();
        migration = await run(nodeExe, ['src/database/migrate.js', 'up'], { cwd: BACKEND_ROOT, env, timeoutMs: 240000 });
        timeline.push({ stage: 'migrations', exitCode: migration.code, durationMs: Date.now() - migrationStart, timedOut: migration.timedOut, timeoutCleanup: migration.timeoutCleanup });
        if (migration.code !== 0) throw new Error('Disposable database migrations failed.');

        const jestStart = Date.now();
        const jestPath = path.join(BACKEND_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
        const integrationReportPath = path.join(os.tmpdir(), `${runId}-integration-jest.json`);
        temporaryJestReports.push(integrationReportPath);
        jest = await run(nodeExe, [jestPath, '--config', path.join(BACKEND_ROOT, 'jest.integration.config.js'), '--runInBand', '--forceExit', '--json', `--outputFile=${integrationReportPath}`, '--runTestsByPath', ...TESTS], {
            cwd: BACKEND_ROOT,
            env,
            timeoutMs: 480000,
        });
        jestStructured = summarizeJestReport(integrationReportPath);
        timeline.push({ stage: 'integration_jest', exitCode: jest.code, durationMs: Date.now() - jestStart, timedOut: jest.timedOut, timeoutCleanup: jest.timeoutCleanup });
        if (jest.code !== 0) throw new Error('Selected real PostgreSQL/Redis integration suites failed.');

        const metaE2eStart = Date.now();
        const metaE2eReportPath = path.join(os.tmpdir(), `${runId}-webhook-e2e-jest.json`);
        temporaryJestReports.push(metaE2eReportPath);
        metaE2eJest = await run(nodeExe, [jestPath, '--config', path.join(BACKEND_ROOT, 'jest.meta-e2e.config.js'), '--runInBand', '--forceExit', '--json', `--outputFile=${metaE2eReportPath}`, '--runTestsByPath', META_E2E_TEST], {
            cwd: BACKEND_ROOT,
            env,
            timeoutMs: 600000,
        });
        metaE2eJestStructured = summarizeJestReport(metaE2eReportPath);
        try {
            const diagnostics = JSON.parse(fs.readFileSync(metaE2eDiagnosticsPath, 'utf8'));
            if (Array.isArray(diagnostics)) metaE2eDeliveryDiagnostics = diagnostics;
        } catch (_) { }
        timeline.push({ stage: 'webhook_pipeline_e2e_jest', exitCode: metaE2eJest.code, durationMs: Date.now() - metaE2eStart, timedOut: metaE2eJest.timedOut, timeoutCleanup: metaE2eJest.timeoutCleanup });
        if (metaE2eJest.code !== 0) throw new Error('The real webhook-to-worker-to-outbound Meta-shaped suite failed.');

        // Run every normal backend Jest suite while these disposable services
        // are available. Keep this broad regression separate from the real
        // Postgres scenarios above: unit suites receive a fresh in-memory
        // SQLite database and isolated Redis logical databases. Provider keys
        // remain absent and the same egress fence stays active.
        const backendRegressionStart = Date.now();
        const backendRegressionReportPath = path.join(os.tmpdir(), `${runId}-backend-regression-jest.json`);
        temporaryJestReports.push(backendRegressionReportPath);
        const backendRegressionEnv = {
            ...env,
            DATABASE_URL: 'sqlite::memory:',
            REDIS_SESSION_DB: '20',
            REDIS_CACHE_DB: '21',
            REDIS_RATELIMIT_DB: '22',
            // Auth's production-config test uses only the app origin. Keep the
            // Growth OS switch disabled for this independent unit-suite pass;
            // the real integration phase above opts into Growth OS explicitly.
            GROWTH_OS_ENABLED: 'false',
        };
        backendRegression = await run(nodeExe, [
            jestPath,
            '--config', path.join(BACKEND_ROOT, 'jest.config.js'),
            '--runInBand', '--forceExit', '--detectOpenHandles', '--coverage=false',
            '--json', `--outputFile=${backendRegressionReportPath}`,
        ], {
            cwd: BACKEND_ROOT,
            env: backendRegressionEnv,
            timeoutMs: 900000,
        });
        const backendReport = summarizeJestReport(backendRegressionReportPath);
        backendRegressionStructured = backendReport ? {
            passedSuites: backendReport.passedSuites,
            failedSuites: backendReport.failedSuites,
            passedTests: backendReport.passedTests,
            failedTests: backendReport.failedTests,
            failedSuiteDiagnostics: backendReport.failedSuiteDiagnostics,
        } : null;
        timeline.push({ stage: 'full_backend_regression_jest', exitCode: backendRegression.code, durationMs: Date.now() - backendRegressionStart, timedOut: backendRegression.timedOut, timeoutCleanup: backendRegression.timeoutCleanup });
        if (backendRegression.code !== 0) throw new Error('The full backend Jest regression suite failed.');
    } catch (error) {
        failure = error.message;
    } finally {
        if (composeStarted) {
            cleanup = await run('docker-compose', ['-p', project, '-f', COMPOSE_FILE, 'down', '--remove-orphans'], {
                cwd: SCRIPT_ROOT,
                env: { ...dockerEnv, LAB_POSTGRES_PORT: String(postgresPort), LAB_REDIS_PORT: String(redisPort), LAB_NETWORK_SUBNET: networkSubnet },
                timeoutMs: 90000,
            });
            timeline.push({ stage: 'compose_down', exitCode: cleanup.code, timedOut: cleanup.timedOut, timeoutCleanup: cleanup.timeoutCleanup, scope: project });
            if (cleanup.code !== 0 && !failure) failure = 'Disposable Compose cleanup failed for the isolated project.';
        }
        for (const reportPath of temporaryJestReports) {
            try { fs.unlinkSync(reportPath); } catch (_) { }
        }
    }

    let blockedEgressAttempts = null;
    try {
        blockedEgressAttempts = fs.readFileSync(egressAttemptsPath, 'utf8').split(/\r?\n/).filter(Boolean).length;
        if (blockedEgressAttempts > 0 && !failure) failure = `Integration tests attempted ${blockedEgressAttempts} blocked non-loopback network operation(s).`;
    } catch (_) {
        if (!failure) failure = 'Integration egress-attempt counter could not be read.';
    } finally {
        try { fs.unlinkSync(egressAttemptsPath); } catch (_) { }
    }

    const status = failure ? 'FAIL' : 'PASS';
    const serviceRecords = externalServices ? [
        {
            name: 'postgres',
            provisioning: 'external-loopback',
            version: externalServiceInfo?.postgres.version || null,
            database: externalServiceInfo?.postgres.database || null,
            role: externalServiceInfo?.postgres.role || null,
            host: '127.0.0.1',
            port: postgresPort,
            storage: 'caller-owned-user-temporary-cluster',
            health: externalServiceInfo ? 'protocol-query' : 'NOT_RUN',
        },
        {
            name: 'redis',
            provisioning: 'external-loopback',
            version: externalServiceInfo?.redis.version || null,
            host: '127.0.0.1',
            port: redisPort,
            storage: 'caller-owned-ephemeral-process',
            health: externalServiceInfo ? 'protocol-query' : 'NOT_RUN',
        },
    ] : [
        { name: 'postgres', image: 'postgres:16-alpine', host: '127.0.0.1', port: postgresPort, storage: 'tmpfs', health: 'compose-healthcheck' },
        { name: 'redis', image: 'redis:7-alpine', host: '127.0.0.1', port: redisPort, storage: 'tmpfs', health: 'compose-healthcheck' },
    ];
    const receipt = {
        schemaVersion: 1,
        runId,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        runtime: { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch },
        branch: sourceBranch,
        sourceRevision,
        candidateBackendSourceSha256,
        runnerSourceSha256,
        composeProject: externalServices ? null : project,
        serviceMode: externalServices
            ? { provider: 'user-provisioned-wsl-loopback', lifecycleOwner: 'caller', clientConnectionHost: '127.0.0.1' }
            : { provider: 'docker-compose', lifecycleOwner: 'integration-runner' },
        serviceNetwork: externalServices
            ? { driver: 'external-loopback', internal: 'listener-binding-not-verified', ipMasquerading: 'not-applicable', subnet: null, overlapChecked: false }
            : { driver: 'bridge', internal: false, ipMasquerading: false, subnet: networkSubnet, overlapChecked: true },
        services: serviceRecords,
        externalServiceReadiness: externalServices ? externalServiceInfo : null,
        migrations: migration ? { exitCode: migration.code, durationMs: timeline.find(item => item.stage === 'migrations')?.durationMs } : { status: 'NOT_RUN' },
        testPaths: {
            selectedIntegration: TESTS,
            webhookPipelineE2E: META_E2E_TEST,
            backendRegression: 'jest.config.js (all discovered non-integration, non-quarantined backend suites)',
        },
        jest: {
            status: failure ? 'FAIL' : 'PASS',
            selectedIntegration: jest ? {
                exitCode: jest.code,
                timedOut: jest.timedOut,
                ...parseJestSummary(`${jest.stdout}\n${jest.stderr}`),
                structured: jestStructured,
            } : { status: 'NOT_RUN' },
            webhookPipelineE2E: metaE2eJest ? {
                exitCode: metaE2eJest.code,
                timedOut: metaE2eJest.timedOut,
                ...parseJestSummary(`${metaE2eJest.stdout}\n${metaE2eJest.stderr}`),
                structured: metaE2eJestStructured,
                deliveryDiagnostics: metaE2eDeliveryDiagnostics,
            } : { status: 'NOT_RUN' },
            backendRegression: backendRegression ? {
                exitCode: backendRegression.code,
                timedOut: backendRegression.timedOut,
                ...parseJestSummary(`${backendRegression.stdout}\n${backendRegression.stderr}`),
                structured: backendRegressionStructured,
            } : { status: 'NOT_RUN' },
        },
        egress: { mode: externalServices
            ? 'Integration clients connect to user-managed WSL services through 127.0.0.1; host Node guard allows loopback IPs/localhost, blocks DNS resolver APIs and custom lookup/agent/dispatcher paths, and blocks non-loopback TCP/UDP/HTTP/fetch'
            : 'Docker bridge uses a reserved non-overlapping subnet with IP masquerading disabled; service ports publish only on 127.0.0.1; host Node guard allows loopback IPs/localhost, blocks DNS resolver APIs and custom lookup/agent/dispatcher paths, and blocks non-loopback TCP/UDP/HTTP/fetch',
        guard: 'PASS', blockedNonLoopbackAttempts: blockedEgressAttempts, externalProvidersConfigured: false },
        timeline,
        failure: failure ? redact(failure) : null,
        cleanup: externalServices
            ? { status: 'CALLER_OWNED_NOT_STOPPED_BY_RUNNER', callerMustStopServices: true, persistentVolumesMounted: false }
            : cleanup ? { exitCode: cleanup.code, projectScoped: true, persistentVolumesMounted: false } : { status: composeStarted ? 'NOT_RUN' : 'NOT_NEEDED' },
    };
    const receiptPath = path.join(REPORT_ROOT, `${runId}.json`);
    const logPath = path.join(REPORT_ROOT, `${runId}.log`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const log = [
        `Run ${runId} · ${status}`,
        `Service provider: ${receipt.serviceMode.provider}`,
        externalServices
            ? `Services: PostgreSQL ${externalServiceInfo?.postgres.version || 'NOT_READY'} on ${postgresPort}, Redis ${externalServiceInfo?.redis.version || 'NOT_READY'} on ${redisPort} (127.0.0.1 only, caller-owned temporary processes)`
            : `Compose project: ${project}\nServices: PostgreSQL ${postgresPort}, Redis ${redisPort} (127.0.0.1 only, tmpfs)`,
        `Migrations: ${receipt.migrations.exitCode ?? receipt.migrations.status}`,
        `Selected integration Jest: ${receipt.jest.selectedIntegration.tests || receipt.jest.selectedIntegration.status}; suites=${receipt.jest.selectedIntegration.suites || 'not run'}; duration=${receipt.jest.selectedIntegration.duration || 'not run'}`,
        `Webhook pipeline Jest: ${receipt.jest.webhookPipelineE2E.tests || receipt.jest.webhookPipelineE2E.status}; suites=${receipt.jest.webhookPipelineE2E.suites || 'not run'}; duration=${receipt.jest.webhookPipelineE2E.duration || 'not run'}`,
        `Full backend Jest: ${receipt.jest.backendRegression.tests || receipt.jest.backendRegression.status}; suites=${receipt.jest.backendRegression.suites || 'not run'}; duration=${receipt.jest.backendRegression.duration || 'not run'}`,
        `Egress fence: ${receipt.egress.mode}`,
        `Cleanup: ${receipt.cleanup.exitCode ?? receipt.cleanup.status}`,
        failure ? `Failure: ${redact(failure)}` : 'Failure: none',
    ].join('\n') + '\n';
    fs.writeFileSync(logPath, log, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ status, runId, receiptPath, logPath, jest: receipt.jest, failure: receipt.failure }) + '\n');
    if (failure) process.exitCode = 1;
};

if (require.main === module) main().catch(error => {
    process.stderr.write(`${redact(error.message)}\n`);
    process.exitCode = 1;
});

module.exports = { resolveExternalServicePorts, run, main };
