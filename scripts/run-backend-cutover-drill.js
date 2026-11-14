'use strict';

/**
 * Disposable-stack wrapper for the commercial-model cutover drill (A9).
 *
 * Starts PostgreSQL 16 + Redis 7 on auto-selected ports with a database name
 * that contains `_test`, runs EasyMod-backend/scripts/cutover-drill.js against
 * it, and always tears the stack down with `down --volumes`.
 *
 * The drill owns the migration sequence (pre-cutover head -> seed -> up ->
 * engine -> down x3 -> re-up), so this wrapper only provisions infrastructure
 * and forwards its exit code. Nothing here can reach a real catalog: the
 * database name is generated with `_test` and the drill re-asserts the
 * disposable-database guard before writing.
 */

const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const composeFile = path.join(repoRoot, 'docker-compose.test.yml');
const drillScript = path.join(repoRoot, 'EasyMod-backend', 'scripts', 'cutover-drill.js');
const projectName = `easymod-cutover-drill-${process.pid}`;

const findFreePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(String(port)));
    });
});

const postgresUser = process.env.TEST_POSTGRES_USER || 'e2e';
const postgresPassword = process.env.TEST_POSTGRES_PASSWORD || 'e2e';
const postgresDatabase = process.env.TEST_POSTGRES_DB || `easymod_cutover_${process.pid}_test`;

let composeEnv;
let activeChild = null;
let interruptRequested = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        interruptRequested = true;
        if (activeChild) activeChild.kill();
    });
}

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const options = { cwd: repoRoot, env, stdio: 'inherit', windowsHide: true };
        // Fixed, script-owned arguments only; the shell is used solely to run
        // the Windows npm wrapper.
        if (process.platform === 'win32' && command.endsWith('.cmd')) options.shell = true;
        const child = spawn(command, args, options);
        activeChild = child;
        child.on('error', (error) => {
            if (activeChild === child) activeChild = null;
            reject(error);
        });
        child.on('close', (code, signal) => {
            if (activeChild === child) activeChild = null;
            resolve(signal ? 1 : (code ?? 1));
        });
    });
}

const composeArgs = (...args) => ['compose', '-p', projectName, '-f', composeFile, ...args];

async function main() {
    let exitCode = 1;
    let servicesStarted = false;

    try {
        const postgresPort = process.env.TEST_POSTGRES_PORT || await findFreePort();
        const redisPort = process.env.TEST_REDIS_PORT || await findFreePort();
        composeEnv = {
            ...process.env,
            TEST_POSTGRES_PORT: postgresPort,
            TEST_REDIS_PORT: redisPort,
            TEST_POSTGRES_USER: postgresUser,
            TEST_POSTGRES_PASSWORD: postgresPassword,
            TEST_POSTGRES_DB: postgresDatabase,
        };
        const drillEnv = {
            ...composeEnv,
            NODE_ENV: 'test',
            DB_SSL: 'false',
            DATABASE_URL: `postgres://${postgresUser}:${postgresPassword}@127.0.0.1:${postgresPort}/${postgresDatabase}`,
            REDIS_URL: `redis://127.0.0.1:${redisPort}`,
            REDIS_SESSION_DB: '10',
            REDIS_CACHE_DB: '11',
            REDIS_RATELIMIT_DB: '12',
            REDIS_QUEUE_DB: '13',
            REDIS_LEGACY_DB: '14',
            REDIS_SSE_DB: '15',
        };

        if (await run('docker', composeArgs('version'), composeEnv) !== 0) {
            throw new Error('Docker Compose is required for the cutover drill.');
        }

        servicesStarted = true;
        if (await run('docker', composeArgs('up', '-d', '--wait'), composeEnv) !== 0) {
            throw new Error('Disposable PostgreSQL/Redis services failed to become healthy.');
        }
        if (interruptRequested) {
            exitCode = 130;
            return;
        }

        exitCode = await run(process.execPath, [drillScript, ...process.argv.slice(2)], drillEnv);
    } catch (error) {
        console.error(`Cutover drill setup failed: ${error.message}`);
    } finally {
        if (servicesStarted) {
            const downCode = await run(
                'docker',
                composeArgs('down', '--volumes', '--remove-orphans'),
                composeEnv,
            );
            if (exitCode === 0 && downCode !== 0) exitCode = downCode;
        }
    }

    process.exitCode = exitCode;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});