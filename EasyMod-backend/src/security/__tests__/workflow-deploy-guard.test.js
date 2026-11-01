'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const workflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/ci-cd.yml',
);
const workflow = fs.readFileSync(workflowPath, 'utf8');
const workflowDirectory = path.resolve(__dirname, '../../../../.github/workflows');
const releaseWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/release.yml',
);
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
const backupWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
    'utf8',
);
const composePath = path.resolve(__dirname, '../../../../docker-compose.prod.yml');
const compose = fs.readFileSync(composePath, 'utf8');
const growthNginxPath = path.resolve(__dirname, '../../../../EasyMod-growth/nginx.conf');
const growthNginx = fs.readFileSync(growthNginxPath, 'utf8');
const backendDockerfilePath = path.resolve(__dirname, '../../../Dockerfile');
const backendDockerfile = fs.readFileSync(backendDockerfilePath, 'utf8');
const backendDockerignorePath = path.resolve(__dirname, '../../../.dockerignore');
const backendDockerignore = fs.readFileSync(backendDockerignorePath, 'utf8');
const frontendDockerfilePath = path.resolve(__dirname, '../../../../EasyMod-frontend/Dockerfile');
const frontendDockerfile = fs.readFileSync(frontendDockerfilePath, 'utf8');
const workerPath = path.resolve(__dirname, '../../jobs/worker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const databaseSyncPath = path.resolve(__dirname, '../../utils/database/sync.js');
const databaseSyncSource = fs.readFileSync(databaseSyncPath, 'utf8');
const securityWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/security-scan.yml',
);
const securityWorkflow = fs.readFileSync(securityWorkflowPath, 'utf8');
const growthWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/growth-os.yml',
);
const growthWorkflow = fs.readFileSync(growthWorkflowPath, 'utf8');
const grantGrowthRoleWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/grant-growth-role.yml',
);
const grantGrowthRoleWorkflow = fs.readFileSync(grantGrowthRoleWorkflowPath, 'utf8');
const seedInitialGrowthAdminWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/seed-initial-growth-admin.yml',
);
const seedInitialGrowthAdminWorkflow = fs.readFileSync(seedInitialGrowthAdminWorkflowPath, 'utf8');
const growthImporterWorkflowPath = path.resolve(
    __dirname,
    '../../../../.github/workflows/run-growth-importer.yml',
);
const growthImporterWorkflow = fs.readFileSync(growthImporterWorkflowPath, 'utf8');

describe('production workflow branch safety', () => {
    test('keeps the production backend non-root with targeted writable ownership', () => {
        expect(backendDockerfile).toContain('USER node');
        expect(backendDockerfile).toContain('chown node:node /app/uploads');
        expect(backendDockerfile).not.toContain('chown -R node:node /app');
        expect(backendDockerfile).toContain('apk upgrade --no-cache');
        expect(backendDockerfile).toContain('/usr/local/lib/node_modules/npm');
        expect(frontendDockerfile).toContain('FROM nginx:1.29-alpine AS production');
        expect(frontendDockerfile).toContain('apk upgrade --no-cache');
        expect(frontendDockerfile).toContain('ARG VITE_META_APP_ID');
        expect(frontendDockerfile).toContain('VITE_META_APP_ID=$VITE_META_APP_ID');
        expect(backendDockerignore).toContain('coverage');
        expect(backendDockerignore).toContain('.test-uploads');
    });

    test('keeps post-merge release entry separate from pull-request validation', () => {
        expect(workflow).toContain('workflow_call:');
        expect(workflow).not.toMatch(/^ {2}push:/m);
        expect(releaseWorkflow).toContain('branches: [main]');
        expect(releaseWorkflow).not.toMatch(/^ {2}pull_request:/m);
        expect(releaseWorkflow).toContain('uses: ./.github/workflows/ci-cd.yml');
        expect(releaseWorkflow).toContain('secrets: inherit');
    });

    test('build and deploy jobs are restricted to main', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(buildBlock).toContain("github.ref == 'refs/heads/main'");
        expect(deployBlock).toContain("github.event_name == 'workflow_dispatch' || github.event_name == 'workflow_call'");
        expect(deployBlock).toContain("github.ref == 'refs/heads/main'");
    });

    test('routes privileged Growth workflows through the semantic backend and Growth gates', () => {
        expect(workflow).toContain('.github/workflows/grant-growth-role.yml');
        expect(workflow).toContain('.github/workflows/seed-initial-growth-admin.yml');
        const growthCase = workflow.slice(workflow.indexOf('EasyMod-growth/*'), workflow.indexOf('EasyMod-growth/*') + 600);
        expect(growthCase).toContain('.github/workflows/seed-initial-growth-admin.yml');
    });

    test('deploy passes the Action Gate secret to production rendering', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('AI_ACTION_GATE_SECRET: ${{ secrets.AI_ACTION_GATE_SECRET }}');
    });

    test('renders the mobile API switch from the operator variable, off by default, at both production render sites', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const dryRunBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  docker-build-validation:/)?.[1];
        const line = "MOBILE_API_ENABLED: ${{ vars.MOBILE_API_ENABLED || 'false' }}";

        expect(deployBlock).toContain(line);
        expect(dryRunBlock).toContain(line);
        // It is a public switch, never a secret, and nothing else in the
        // workflow may set or override it.
        expect(workflow.match(/MOBILE_API_ENABLED:/g)).toHaveLength(2);
        expect(workflow).not.toMatch(/secrets\.MOBILE_/);
        expect(workflow).not.toMatch(/MOBILE_(PUSH|ORDER_MUTATIONS|COURIER_ACTIONS|AI_DRAFTS)_ENABLED|MOBILE_E2E_FIXTURES/);
    });

    test('keeps Meta discovery canary disabled unless the protected activation variable is explicit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const dryRunBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  docker-build-validation:/)?.[1];
        const enabledLine = "META_DISCOVERY_CANARY_ENABLED: ${{ vars.META_DISCOVERY_CANARY_CONFIRMATION == 'ENABLE-META-DISCOVERY-CANARY' && vars.META_DISCOVERY_CANARY_ENABLED == 'true' && 'true' || 'false' }}";

        expect(workflow).not.toContain('meta_discovery_canary_confirmation:');
        expect(releaseWorkflow).not.toContain('meta_discovery_canary_confirmation:');
        expect(deployBlock).toContain(enabledLine);
        expect(dryRunBlock).toContain(enabledLine);
        expect(workflow.match(/META_DISCOVERY_CANARY_ENABLED:/g)).toHaveLength(2);
        expect(workflow).not.toContain('META_DISCOVERY_CANARY_ENABLED: ${{ vars.META_DISCOVERY_CANARY_ENABLED }}');
    });

    test('validates selected Growth metadata without requiring Node.js on the SSH host', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const growthStart = deployBlock.indexOf('growth_image_source=running');
        const backendValidationStart = deployBlock.indexOf('# Validate the rendered environment with the candidate backend image');
        const growthBlock = deployBlock.slice(growthStart, backendValidationStart);

        expect(growthStart).toBeGreaterThan(-1);
        expect(backendValidationStart).toBeGreaterThan(growthStart);
        expect(growthBlock).toContain('growth_image_source=override');
        expect(growthBlock).toContain('growth_image_source=bootstrap');
        expect(growthBlock).toContain('if [ "$growth_image_source" != "running" ]; then');
        expect(growthBlock).toContain('command -v jq');
        expect(growthBlock).toContain('jq --version');
        expect(growthBlock).toContain("jq -er '.commit | select(type == \"string\" and length > 0)'");
        expect(growthBlock).toContain('Growth image build-info.json is missing or empty');
        expect(growthBlock).toContain('Growth image build-info.json is malformed or has no non-empty commit');
        expect(growthBlock).not.toContain('node -e');
        expect(growthBlock).not.toContain('| node');

        // Simulate the SSH host's available command set for this parser. The
        // Linux CI runner supplies jq, while the restricted PATH deliberately
        // omits Node.js; container-side Node commands are outside this block.
        if (process.platform === 'win32') return;
        const jqLookup = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' });
        const jqPath = jqLookup.stdout.trim();
        expect(jqLookup.status).toBe(0);
        expect(jqPath).not.toBe('');

        const parserBin = fs.mkdtempSync(path.join(os.tmpdir(), 'easymod-jq-'));
        try {
            fs.symlinkSync(jqPath, path.join(parserBin, 'jq'));
            const probe = spawnSync('/bin/sh', ['-c', [
                'set -eu',
                'if command -v node >/dev/null 2>&1; then exit 10; fi',
                'command -v jq >/dev/null 2>&1',
                'jq --version >/dev/null 2>&1',
                'growth_build_info=\'{"commit":"expected"}\'',
                'growth_build_commit=$(printf \'%s\' "$growth_build_info" | jq -er \'.commit | select(type == "string" and length > 0)\')',
                '[ "$growth_build_commit" = expected ]',
            ].join('\n')], {
                encoding: 'utf8',
                env: { ...process.env, PATH: parserBin },
            });
            expect(probe.status).toBe(0);
        } finally {
            fs.rmSync(parserBin, { recursive: true, force: true });
        }
    });

    test('pull requests can run tests but cannot build deployable images', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        expect(buildBlock).toContain("github.event_name != 'pull_request'");
    });

    test('cancels only stale PR validation and scopes package write access to publishing', () => {
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];
        const topLevelPermissions = workflow.match(/\npermissions:\n([\s\S]*?)\n\nenv:/)?.[1];

        expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
        expect(topLevelPermissions).not.toContain('packages:');
        expect(workflow).toContain('permissions:\n      contents: read\n      packages: read');
        expect(topLevelPermissions).not.toContain('packages: write');
        expect(buildBlock).toContain('permissions:\n      contents: read\n      packages: write');
    });

    test('cancels stale security scans only for PRs', () => {
        expect(securityWorkflow).toContain(
            'group: security-scan-${{ github.event.pull_request.number || github.ref }}',
        );
        expect(securityWorkflow).toContain(
            "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
        );
    });

    test('Growth OS reusable workflow keeps publish permissions inside the caller ceiling', () => {
        // This test file is deliberately under `EasyMod-backend/`: the `changes`
        // path filter treats it as a backend change, so a push here guarantees
        // the real GitHub planner + Jest both re-execute. The `startup_failure`
        // regression I shipped at 911e351 and the ceiling fix at 57cbdd9 both
        // passed locally but differed on real run `35560390196` — that class of
        // silent divergence is exactly what this test is here to prevent from
        // repeating against a future reviewer who only trusts actionlint.
        // Final receipt: Actions run `35561961284` at SHA `3e5077d` — 16/16
        // checks pass or correctly skip; this Jest assertion is included in the
        // `Quality fast` job's execution.
        //
        // Regression guard for the reusable-workflow permission-mismatch I
        // actually shipped at a56045e: `growth-os.yml` requests packages.write
        // at its top level (for its `build-and-push` job), so the caller in
        // ci-cd.yml MUST grant that scope. GitHub validates reusable
        // permissions at PLAN time — the `if:` and event filter are irrelevant
        // to the ceiling check. Before my fix the whole CI/CD workflow failed
        // startup and every PR lost its aggregate context.
        //
        // The check intentionally uses a simple substring assertion for the
        // ci-cd.yml caller block: if we can find the caller's permissions
        // granting packages.write (paired with contents.read) after the
        // `uses: ./.github/workflows/growth-os.yml` line, we're consistent.
        const usesLine = workflow.indexOf('uses: ./.github/workflows/growth-os.yml');
        expect(usesLine).toBeGreaterThan(-1);
        const afterUses = workflow.slice(usesLine, usesLine + 500);
        expect(afterUses).toContain('permissions:');
        expect(afterUses).toContain('contents: read');
        expect(afterUses).toContain('packages: write');

        // The reusable workflow keeps its publish capability — that's exactly
        // the top-level permission we mirror from the caller.
        const growthPermissions = growthWorkflow.match(/\npermissions:\n  contents: read\n  packages: write/);
        expect(growthPermissions).not.toBeNull();

        // The `build-and-push` job (the ONLY job that pushes) must be restricted
        // to the default branch even for manual dispatches. Otherwise a maintainer
        // could publish an arbitrary branch's image with package-write authority.
        expect(growthWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event_name == 'push')",
        );

        // Two PR-reachable jobs must narrow their scope below the ceiling so a
        // leaked token from a PR-controlled process cannot write to packages.
        const verifyBlock = growthWorkflow.match(/\n  verify:\n([\s\S]*?)\n  browser-e2e:/)?.[1];
        expect(verifyBlock).toContain('permissions:\n      contents: read');
        expect(verifyBlock).not.toContain('packages: write');
        const browserBlock = growthWorkflow.match(/\n  browser-e2e:\n([\s\S]*?)\n  build-and-push:/)?.[1];
        expect(browserBlock).toContain('permissions:\n      contents: read');
        expect(browserBlock).not.toContain('packages: write');
    });

    test('keeps Growth role bootstrap on the configured production environment', () => {
        expect(grantGrowthRoleWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(grantGrowthRoleWorkflow).toContain('environment: production');
        expect(grantGrowthRoleWorkflow).not.toContain('environment: growth-bootstrap');
    });

    test('caps privileged remote commands with explicit command timeouts, not transport defaults', () => {
        // appleboy `timeout:` is connection-only; the remote command must have
        // its own cap so a committed privileged mutation is never reaped by a
        // hidden default (grant hang) and a long deploy is never cut off.
        expect(grantGrowthRoleWorkflow).toContain('command_timeout: 15m');
        expect(workflow).toContain('command_timeout: 30m');
    });

    test('runs the bootstrap script in the running backend without Compose interpolation', () => {
        expect(grantGrowthRoleWorkflow).toContain("--filter 'label=com.docker.compose.service=backend'");
        expect(grantGrowthRoleWorkflow).toContain('docker exec \\');
        expect(grantGrowthRoleWorkflow).toContain('node src/scripts/grant-growth-role.js');
        expect(grantGrowthRoleWorkflow).not.toContain('docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T');
    });

    test('protects the one-time initial-admin seed behind main, production, concurrency, and a masked secret', () => {
        expect(seedInitialGrowthAdminWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(seedInitialGrowthAdminWorkflow).toContain('environment: production');
        expect(seedInitialGrowthAdminWorkflow).toContain('group: seed-initial-growth-admin');
        expect(seedInitialGrowthAdminWorkflow).toContain('INITIAL_GROWTH_ADMIN_PASSWORD: ${{ secrets.INITIAL_GROWTH_ADMIN_PASSWORD }}');
        expect(seedInitialGrowthAdminWorkflow).toContain('node src/scripts/seed-initial-growth-admin.js');
        expect(seedInitialGrowthAdminWorkflow).toContain('docker exec -i \\');
        expect(seedInitialGrowthAdminWorkflow).toContain("| ssh -i \"$key_file\"");
        expect(seedInitialGrowthAdminWorkflow).not.toContain('envs: TARGET_EMAIL,INITIAL_GROWTH_ADMIN_PASSWORD,GITHUB_ACTOR');
        expect(seedInitialGrowthAdminWorkflow).not.toContain('-e INITIAL_GROWTH_ADMIN_PASSWORD=');
        expect(seedInitialGrowthAdminWorkflow).not.toMatch(/INITIAL_GROWTH_ADMIN_PASSWORD\s*:\s*['"]/);
        expect(seedInitialGrowthAdminWorkflow).not.toContain('echo "${INITIAL_GROWTH_ADMIN_PASSWORD}"');
    });

    test('keeps the canonical grant workflow dependent on the seeded identity and protected actor', () => {
        expect(grantGrowthRoleWorkflow).toContain('GROWTH_BOOTSTRAP_ACTOR_EMAIL');
        expect(grantGrowthRoleWorkflow).toContain('environment: production');
        expect(grantGrowthRoleWorkflow).toContain('node src/scripts/grant-growth-role.js');
        expect(grantGrowthRoleWorkflow).not.toContain('INITIAL_GROWTH_ADMIN_PASSWORD');
    });

    test('runs the platform-admin grant on the running backend without Compose interpolation', () => {
        const platformAdminWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/grant-platform-admin.yml'),
            'utf8',
        );
        expect(platformAdminWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(platformAdminWorkflow).toContain('environment: production');
        expect(platformAdminWorkflow).toContain('group: grant-platform-admin');
        expect(platformAdminWorkflow).toContain('command_timeout: 15m');
        expect(platformAdminWorkflow).toContain('envs: TARGET_EMAIL,TARGET_ROLE,GITHUB_ACTOR');
        expect(platformAdminWorkflow).toContain("--filter 'label=com.docker.compose.service=backend'");
        expect(platformAdminWorkflow).toContain('docker exec \\');
        expect(platformAdminWorkflow).toContain('node src/scripts/grant-platform-admin.js');
        expect(platformAdminWorkflow).not.toContain('docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T');
        expect(workflow).toContain('.github/workflows/grant-platform-admin.yml');
    });

    test('keeps browser and server Sentry configuration boundaries separate', () => {
        expect(workflow).toContain('VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}');
        expect(workflow.match(/VITE_SENTRY_DSN=\$\{\{ vars\.VITE_SENTRY_DSN \}\}/g)).toHaveLength(2);
        expect(workflow).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
        expect(workflow).not.toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN || secrets.VITE_SENTRY_DSN }}');
    });

    test('fails closed instead of deleting Redis persistence during deployment recovery', () => {
        expect(workflow).toContain('refusing automatic volume deletion');
        expect(workflow).not.toContain('reset_redis_volume');
        expect(workflow).not.toContain('RVOL=$(docker volume');
    });

    test('manual deployment probes cannot execute branch-controlled code with production secrets', () => {
        const deploymentConfigBlock = workflow.match(/\n  deployment-config:\n([\s\S]*?)\n  # ── 2d\./)?.[1];

        expect(deploymentConfigBlock).toContain(
            "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'",
        );
        expect(deploymentConfigBlock).toContain(
            "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
        );
    });

    test('every branch validates both production Docker build contexts without publishing', () => {
        const validationBlock = workflow.match(
            /\n  docker-build-validation:\n([\s\S]*?)\n  # ── 3\./,
        )?.[1];

        expect(validationBlock).toContain('Docker build validation (no push)');
        expect(validationBlock).toContain('context: ./EasyMod-backend');
        expect(validationBlock).toContain('context: ./EasyMod-frontend');
        expect(validationBlock.match(/push: false/g)).toHaveLength(2);
        expect(validationBlock.match(/load: true/g)).toHaveLength(2);
        expect(validationBlock).toContain('push: false');
    });

    test('main production path builds each publishable image once', () => {
        const validationBlock = workflow.match(
            /\n  docker-build-validation:\n([\s\S]*?)\n  # ── 3\./,
        )?.[1];
        const buildBlock = workflow.match(/\n  build:\n([\s\S]*?)\n  # ── 4\./)?.[1];

        expect(validationBlock).toContain("github.ref != 'refs/heads/main'");
        expect(buildBlock).not.toContain('docker-build-validation');
        expect(buildBlock.match(/uses: docker\/build-push-action@/g)).toHaveLength(2);
    });

    test('production Compose pins every image by digest', () => {
        expect(compose).not.toMatch(/(^|\n)\s*image:\s*[^\n]*:(latest|dev)(\s|$)/m);
        expect(compose).toContain('image: caddy@sha256:');
        expect(compose).toContain('image: postgres@sha256:');
        expect(compose).toContain('image: redis@sha256:');
        expect(compose).toContain('image: qdrant/qdrant@sha256:');
        expect(workflow).toContain('docker image inspect -f');
        expect(workflow).toContain('config --images');
    });

    test('production Compose keeps the canary API-only and workers do not load OAuth canary code', () => {
        const backendBlock = compose.match(/\r?\n  backend:\r?\n([\s\S]*?)\r?\n  # ── Worker:/)?.[1];
        const workerBlock = compose.match(/\r?\n  worker:\r?\n([\s\S]*?)\r?\n  # ── Frontend:/)?.[1];

        expect(backendBlock).toContain('env_file:');
        expect(workerBlock).toContain('command: ["node", "src/jobs/worker.js"]');
        expect(workerSource).not.toContain('meta-discovery-canary');
    });

    // BUILD_TIME lands in the image as ENV and is read back by /health, /version
    // and Sentry's `dist`. It was github.event.repository.updated_at — the repo's
    // last-metadata-change time, which ran behind the commit it labelled and could
    // repeat across two pushes, collapsing two releases onto one dist marker.
    test('stamps BUILD_TIME from the build itself, not repository metadata', () => {
        expect(workflow).not.toContain('repository.updated_at');
        expect(workflow).toContain('BUILD_TIME=${{ steps.meta.outputs.build_time }}');
        expect(workflow).toMatch(/echo "build_time=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> \$GITHUB_OUTPUT/);
    });

    test('migrates the candidate backend image before replacing running services', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const candidateMigration =
            'run --rm --no-deps -T \\\n                -e RUN_MIGRATIONS_ON_STARTUP=false backend node src/database/migrate.js up';
        const migrationIndex = deployBlock.indexOf(candidateMigration);
        const schemaAuditIndex = deployBlock.indexOf('node scripts/schema-drift-audit.js');
        const replacementIndex = deployBlock.indexOf(
            'up -d --no-build --remove-orphans',
        );

        expect(migrationIndex).toBeGreaterThan(-1);
        expect(schemaAuditIndex).toBeGreaterThan(migrationIndex);
        expect(replacementIndex).toBeGreaterThan(-1);
        expect(schemaAuditIndex).toBeLessThan(replacementIndex);
    });

    test('stamps MIGRATION_START before the candidate migration runs, and proves exactly one repair ledger row before the schema audit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const candidateMigration =
            'run --rm --no-deps -T \\\n                -e RUN_MIGRATIONS_ON_STARTUP=false backend node src/database/migrate.js up';

        const migrationStartIndex = deployBlock.indexOf('echo "MIGRATION_START=$migration_started_at"');
        const migrationIndex = deployBlock.indexOf(candidateMigration);
        const ledgerCheckIndex = deployBlock.indexOf('REPAIR_LEDGER_ENTRY_COUNT=1');
        const schemaAuditIndex = deployBlock.indexOf('node scripts/schema-drift-audit.js');

        expect(migrationStartIndex).toBeGreaterThan(-1);
        expect(migrationIndex).toBeGreaterThan(-1);
        expect(migrationStartIndex).toBeLessThan(migrationIndex);

        expect(deployBlock).toContain(
            "SELECT COUNT(*) FROM public.migrations WHERE name LIKE '\\''20260901_001_reconcile_commercial_entity_drift%'\\''",
        );
        expect(deployBlock).toContain('test "$repair_ledger_rows" = 1');
        expect(ledgerCheckIndex).toBeGreaterThan(migrationIndex);
        expect(ledgerCheckIndex).toBeLessThan(schemaAuditIndex);

        // MIGRATION_START must be stamped even when the migration block is
        // skipped (WIPE path), since Step 17's log bound cannot be conditional.
        expect(deployBlock.match(/echo "MIGRATION_START=\$migration_started_at"/g)).toHaveLength(2);
    });

    test('production image database commands do not depend on removed npm binaries', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('backend node src/database/migrate.js up');
        expect(deployBlock).toContain('backend node scripts/schema-drift-audit.js');
        expect(deployBlock).toContain('backend node src/utils/database/sync.js');
        expect(deployBlock).toContain('backend node src/database/migrate.js seed-as-executed');
        expect(deployBlock).toContain('backend node src/scripts/seed-admin.js');
        expect(deployBlock).toContain('Candidate backend startup preflight failed:');
        expect(deployBlock).toContain('Candidate backend database connection passed');
        expect(deployBlock).toContain('Candidate backend Redis connection passed');
        expect(deployBlock).toContain('preflight_container_name="easymod-backend-preflight-${WORKFLOW_RUN_ID:-unknown}"');
        expect(deployBlock).toContain('timeout --signal=TERM --kill-after=10s 120s');
        expect(deployBlock).toContain('process.exit(exitCode);');
        expect(deployBlock).toContain("closeWithTimeout('database'");
        expect(deployBlock).toContain("closeWithTimeout('Redis'");
        expect(deployBlock).toContain('docker rm -f "$preflight_container_name"');
        expect(deployBlock).not.toMatch(/backend\s+(?:npm|npx)\b/);
        expect(deployBlock).toContain('Rollback Growth health details: {{json .State.Health}}');
        expect(deployBlock).toContain('docker logs --tail 50 easymod-growth-frontend-1');

        // The backup restore drill uses the same lean production image and must
        // keep its isolated forward-migration proof on the direct Node entrypoint.
        expect(backupWorkflow).toContain('&& node src/database/migrate.js up');
        expect(backupWorkflow).not.toContain('&& npm run migrate');
    });

    test('wipe bootstrap applies founder-pilot schema migrations before marking history executed', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const syncIndex = deployBlock.indexOf('backend node src/utils/database/sync.js');
        const seedIndex = deployBlock.indexOf('backend node src/database/migrate.js seed-as-executed');

        expect(syncIndex).toBeGreaterThan(-1);
        expect(seedIndex).toBeGreaterThan(syncIndex);
        expect(databaseSyncSource).toContain('if (sequelize.getDialect() === \'postgres\')');
        expect(databaseSyncSource).toContain('for (const migration of founderPilotSchemaMigrations)');
        for (const migration of [
            '20261101_001_founder_pilot_addons',
            '20261101_002_ai_reply_shadow_ledger',
            '20261101_003_ads_studio_manual_reports',
            '20261101_004_storefront_cod',
        ]) {
            expect(databaseSyncSource).toContain(migration);
        }
    });

    test('starts candidate services before Caddy and diagnoses backend health failures', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const appStartIndex = deployBlock.indexOf('up -d --no-build --remove-orphans backend worker frontend growth-frontend');
        const backendHealthIndex = deployBlock.indexOf('candidate_backend_healthy=false');
        const caddyStartIndex = deployBlock.indexOf('up -d --no-build --remove-orphans caddy');
        const caddyReloadIndex = deployBlock.indexOf('caddy reload --config /etc/caddy/Caddyfile');

        expect(appStartIndex).toBeGreaterThan(-1);
        expect(backendHealthIndex).toBeGreaterThan(appStartIndex);
        expect(caddyStartIndex).toBeGreaterThan(backendHealthIndex);
        expect(caddyReloadIndex).toBeGreaterThan(caddyStartIndex);
        expect(deployBlock).toContain('Candidate backend health details: {{json .State.Health}}');
        expect(deployBlock).toContain('Candidate backend state: status={{.State.Status}} exit={{.State.ExitCode}} restart={{.RestartCount}} oom={{.State.OOMKilled}} error={{.State.Error}}');
        expect(deployBlock).toContain('docker ps -a --filter name=easymod-backend-1 --no-trunc');
        expect(deployBlock).toContain('docker logs --tail 100 easymod-backend-1');
        expect(deployBlock).toContain('docker logs --tail 100 easymod-caddy-1');
    });

    test('the pre-migration schema-drift probe is opt-in per dispatch, not hardcoded', () => {
        expect(workflow).toContain(
            "description: 'One-shot: require the 3 repair columns ABSENT before migrating. Type DRIFT to confirm.'",
        );
        expect(workflow).toMatch(/expect_schema_drift:\n\s+description:/);

        // The literal used to be baked into every dispatch, including ordinary
        // future deploys where the repair columns are already present — that
        // throws PRE_MIGRATION_SCHEMA=FAIL on every deploy after this repair
        // ships. It must only ever be reached through the resolved shell var.
        expect(workflow).not.toMatch(/PROBE_SCHEMA_MODE=pre-migration(?!['"])/);
        expect(workflow.match(/PROBE_SCHEMA_MODE=\$schema_probe_mode/g)).toHaveLength(2);
        expect(workflow.match(/schema_probe_mode='basic'/g)).toHaveLength(2);
        expect(workflow.match(/schema_probe_mode='pre-migration'/g)).toHaveLength(2);
        // Once for each of: the dry-run probe, the candidate probe, and the
        // deploy-via-SSH step that also gates the zero-debt assertion.
        expect(workflow.match(/SCHEMA_DRIFT_MODE: \$\{\{ inputs\.expect_schema_drift == 'DRIFT' \}\}/g)).toHaveLength(3);
    });

    test('the zero-debt initialization assertion is scoped to the one-shot drift repair, not every deploy', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        // threshold_debt is a legacy field the migration deliberately preserves
        // on rerun rather than resetting — so it is legitimately allowed to be
        // nonzero outside the one-shot repair transition. Asserting it is zero
        // unconditionally would hard-fail every future deploy the day any row
        // carries a real value.
        const gateIndex = deployBlock.indexOf('if [ "$SCHEMA_DRIFT_MODE" = "true" ]; then');
        const debtCheckIndex = deployBlock.indexOf('SELECT COUNT(*) FROM public.subscriptions WHERE threshold_debt <> 0');
        const skippedIndex = deployBlock.indexOf("THRESHOLD_DEBT_INITIALIZATION=SKIPPED");

        expect(gateIndex).toBeGreaterThan(-1);
        expect(debtCheckIndex).toBeGreaterThan(gateIndex);
        expect(skippedIndex).toBeGreaterThan(-1);
        expect(deployBlock).toContain(
            'envs: GHCR_BACKEND,GHCR_FRONTEND,GHCR_GROWTH,GROWTH_BOOTSTRAP_DIGEST,GROWTH_IMAGE_OVERRIDE,BACKEND_TAG,FRONTEND_TAG,BACKEND_DIGEST,FRONTEND_DIGEST,DEPLOYED_COMMIT,WORKFLOW_RUN_ID,DEPLOYED_AT,GH_ACTOR,GH_TOKEN,WIPE_DB,SEED_ADMIN,ROLLBACK_STATE_DIR,SCHEMA_DRIFT_MODE',
        );
    });

    test('the candidate-probe digest-pin check uses a real regex, not a shell glob', () => {
        // `case … in *@sha256:[0-9a-fA-F]{64})` is a shell glob, where `{64}` has
        // no repetition meaning (bash only expands `{a,b}`/`{x..y}`) — it can
        // never match a real digest, so the probe fails closed on every run.
        // This job's `if:` only runs on a real deploy_confirmation dispatch, so
        // no prior green CI run ever exercised it. Must use grep -E (or an
        // equivalent real-regex engine) like the other two digest-pin checks in
        // this file do.
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).not.toMatch(/case\s+"\$image_ref"\s+in\s+\*@sha256:\[0-9a-fA-F\]\{64\}\)/);
        expect(deployBlock).toContain("grep -Eq '@sha256:[0-9a-fA-F]{64}");
        // Three real-regex digest-pin checks total: EXISTING_BACKEND_DIGEST
        // format validation, this probe, and assert_immutable_ref(). Each is in
        // a different quoting context (one needs \$ since it is nested inside a
        // local double-quoted ssh argument), so match on the pattern core only.
        expect(workflow.match(/grep -Eq '[^']*\\?\[0-9a-fA-F\]\\?\{64\\?\}[^']*'/g)).toHaveLength(3);
    });

    test('rejects the destructive production wipe path', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('WIPE_DB=WIPE is disabled for production cutover');
        expect(deployBlock.indexOf('WIPE_DB=WIPE is disabled')).toBeLessThan(
            deployBlock.indexOf('if [ "$WIPE_DB" = "WIPE" ]; then', deployBlock.indexOf('WIPE_DB=WIPE is disabled') + 1),
        );
    });

    test('keeps repository-variable mutation outside contributor-controlled jobs', () => {
        expect(workflow).not.toContain('actions: write');
        expect(workflow).toContain('operator-owned repository control');
        expect(workflow).toContain("inputs.deploy_confirmation == format('DEPLOY-{0}', github.sha)");
        expect(workflow).toContain("description: 'One-shot production confirmation. Type DEPLOY-<full main SHA>.'");
    });

    test('derives and fails closed on a pinned fingerprint at every SSH action site', () => {
        const sshWorkflows = fs
            .readdirSync(workflowDirectory)
            .filter((name) => name.endsWith('.yml'))
            .map((name) => ({
                source: fs.readFileSync(path.join(workflowDirectory, name), 'utf8'),
            }))
            .filter(({ source }) => source.includes('uses: appleboy/ssh-action@'));

        let sshActionSites = 0;
        for (const { source } of sshWorkflows) {
            sshActionSites += (source.match(/uses: appleboy\/ssh-action@/g) || []).length;
            expect(source).toContain('fingerprint: ${{ steps.ssh_host.outputs.fingerprint }}');
            expect(source).toContain('id: ssh_host');
            expect(source).toContain('DO_SSH_KNOWN_HOSTS');
            expect(source).toContain("if [ -z \"$key_type\" ] || [ -z \"$key_blob\" ]; then");
            expect(source).toContain("echo '::error::pinned host key is missing for DEPLOY_HOST'");
            expect(source).toContain('exit 1');
            expect(source).not.toContain('DO_SSH_FINGERPRINT');
            expect(source).not.toContain('ssh-keyscan');
        }

        expect(sshActionSites).toBe(9);
    });

    test('requires an immutable image for restore-drill forward migration', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        expect(backupWorkflow).toContain('forward migration image must be the immutable backend digest reference');
        expect(backupWorkflow).toContain('docker pull "$MIGRATION_IMAGE"');
        expect(backupWorkflow).toContain('DEST_PREFIX" = "uploads"');
        expect(backupWorkflow).toContain('tar -tzf "/backup/$(basename "$DECRYPTED")"');
        // Both backup and restore-drill open SSH into production; both must sit
        // behind the production environment gate. A future edit that adds a
        // concurrency block but forgets one env gate must fail closed here.
        const backup = backupWorkflow.replace(/\r\n/g, '\n');
        expect(backup).toMatch(/^ {4}environment: production$/m);
        // Assert that BOTH jobs have their own environment: production line,
        // not just one. The backup job appears before restore-drill in the
        // file; the count must be at least 2 to close the previous gap where
        // only backup had it.
        const environmentMatches = backup.match(/^ {4}environment: production$/gm) || [];
        expect(environmentMatches.length).toBeGreaterThanOrEqual(2);
    });

    test('pins the PostgreSQL helper image inside the isolated restore job', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        const normalizedWorkflow = backupWorkflow.replace(/\r\n/g, '\n');
        const restoreJob = normalizedWorkflow.split('\n  restore-drill:\n')[1] || '';
        const scriptMarker = 'script: |\n';
        const scriptStart = restoreJob.indexOf(scriptMarker);
        expect(scriptStart).toBeGreaterThanOrEqual(0);

        const restoreScript = restoreJob.slice(scriptStart + scriptMarker.length);
        const helperImageDeclaration = restoreScript.indexOf(
            "POSTGRES_HELPER_IMAGE='postgres@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a'",
        );
        const helperImageUse = restoreScript.indexOf('"$POSTGRES_HELPER_IMAGE" sh -c');

        expect(helperImageDeclaration).toBeGreaterThanOrEqual(0);
        expect(helperImageUse).toBeGreaterThan(helperImageDeclaration);
    });

    test('backup validates the configured off-site retention policy', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );

        expect(backupWorkflow).toContain(
            'OFFSITE_RETENTION_DAYS must be a positive integer',
        );
        expect(backupWorkflow).toContain(
            "Rules[?Status==`Enabled` && Expiration.Days != `null`].[Filter.Prefix,Expiration.Days]",
        );
        expect(backupWorkflow).toContain(
            'END { exit (broad || (db && uploads)) ? 0 : 1 }',
        );
        expect(backupWorkflow).toContain(
            'Off-site lifecycle retention policy verified',
        );
    });

    test('rollback verifies restored images and health before returning', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain('verify_rollback() {');
        expect(deployBlock).toContain('rollback health check failed after 100s');
        expect(deployBlock).toContain('rollback || rc=70');
    });

    test('successful cutover proves the running image reports the requested commit', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];
        const healthIndex = deployBlock.indexOf("http://127.0.0.1:3000/health/ready");
        const versionIndex = deployBlock.indexOf("http://127.0.0.1:3000/api/version");

        expect(healthIndex).toBeGreaterThan(-1);
        expect(versionIndex).toBeGreaterThan(healthIndex);
        expect(deployBlock).toContain('docker exec -i -e EXPECTED_COMMIT="$DEPLOYED_COMMIT"');
        expect(deployBlock).toContain('payload.gitSha !== process.env.EXPECTED_COMMIT');
    });

    test('frontend-only cutovers require the SHA that produced the existing backend image', () => {
        const deployBlock = workflow.match(/\n  deploy:\n([\s\S]*)$/)?.[1];

        expect(deployBlock).toContain(
            "inputs.target != 'frontend' || inputs.existing_candidate_sha != ''",
        );
        expect(deployBlock).toContain(
            'DEPLOYED_COMMIT: ${{ inputs.existing_candidate_sha || github.sha }}',
        );
    });
});

// The production mobile proof holds a real test merchant's password, reads the
// signed release and opens a read-only SSH session. Pin that envelope so a later
// edit cannot quietly widen it (docs/deployment/MOBILE_API_ACTIVATION_RUNBOOK.md).
describe('mobile production proof workflow', () => {
    const proof = fs
        .readFileSync(path.join(workflowDirectory, 'mobile-production-proof.yml'), 'utf8')
        .replace(/\r\n/g, '\n');
    const proofSql = fs.readFileSync(
        path.resolve(__dirname, '../../../../scripts/mobile-production-proof/observability.sql'),
        'utf8',
    );
    const code = proof.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

    test('is manual, main-only and bound to the production environment', () => {
        expect(code).toMatch(/^on:\n {2}workflow_dispatch:/m);
        expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
        expect(code).toContain("if: github.ref == 'refs/heads/main'");
        expect(code).toMatch(/^ {4}environment: production$/m);
        expect(code).toContain('cancel-in-progress: false');
    });

    test('is read-only toward the repository and never sees the upload key', () => {
        expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
        expect(code).not.toMatch(/:\s*write\b/);
        expect(code).not.toMatch(/ANDROID_UPLOAD|KEYSTORE/);
        const secrets = [...new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))].sort();
        expect(secrets).toEqual([
            'DEPLOY_HOST',
            'DO_SSH_KNOWN_HOSTS',
            'DO_SSH_PRIVATE_KEY',
            'META_REVIEW_MERCHANT_PASSWORD',
            'SEED_ADMIN_PASSWORD',
        ]);
        expect(code).not.toMatch(/toJSON\(\s*secrets\s*\)|\$\{\{\s*secrets\s*\}\}/);
    });

    test('keeps credentials out of the rollback-state proof', () => {
        expect(code).toContain("MERCHANT_PASSWORD: ${{ inputs.expect_mobile_api == 'enabled' && secrets.META_REVIEW_MERCHANT_PASSWORD || '' }}");
        expect(code).toContain("ADMIN_PASSWORD: ${{ inputs.expect_mobile_api == 'enabled' && secrets.SEED_ADMIN_PASSWORD || '' }}");
        expect(code).toContain("RUN_DEVICE: ${{ inputs.expect_mobile_api == 'enabled' && inputs.device }}");
    });

    test('uses production over SSH read-only, with a pinned host key', () => {
        expect(code).toContain('StrictHostKeyChecking=yes');
        expect(code).toContain('ssh-keygen -F "$DEPLOY_HOST" -f ~/.ssh/known_hosts');
        expect(code).not.toMatch(/ssh-keyscan|StrictHostKeyChecking=no|scp |docker compose|docker (run|restart|stop|rm)\b/);
        const remoteCommands = [...code.matchAll(/remote "([^\n]*)"/g)].map((match) => match[1]);
        expect(remoteCommands).toHaveLength(2);
        expect(remoteCommands[0]).toMatch(/^docker logs --since '\$PROOF_START' easymod-backend-1 /);
        expect(remoteCommands[1]).toMatch(/^docker exec -i easymod-postgres-1 sh -c 'psql /);
        expect(proofSql).toContain('BEGIN TRANSACTION READ ONLY;');
        expect(proofSql).toContain('ROLLBACK;');
        expect(proofSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|GRANT|COPY)\b/i);
    });

    test('verifies the signed artifact before any device run and scans every upload for the credential', () => {
        expect(code).toContain('git diff --quiet "$release_source_sha" HEAD -- EasyMod-mobile');
        expect(code).toContain('sha256sum --check SHA256SUMS');
        expect(code).toContain("steps.api.outcome == 'success'");
        expect(code).toContain("--expect-signer \"$(node -p \"require('./EasyMod-mobile/release-signing.json').certificateSha256\")\"");
        expect(code.indexOf('--expect-signer')).toBeLessThan(code.indexOf('android-emulator-runner'));
        expect(code).toContain('grep -rlF -- "$secret" proof');
        expect(code).toContain("if: ${{ !cancelled() && steps.api.outcome == 'success' && steps.scan.outcome == 'success' }}");
    });

    test('runs a signed build variant only under that variant\'s own identity', () => {
        expect(code).toMatch(/^ {6}variant:\n(?: {8}.+\n)*? {8}options: \[preview, production\]$/m);
        expect(code).toContain('preview) app_id=tech.easymod.merchant.preview; scheme=easymodmerchantpreview; artifact=mobile-release ;;');
        expect(code).toContain('production) app_id=tech.easymod.merchant; scheme=easymodmerchant; artifact=mobile-release-production ;;');
        expect(code).toContain('-n "$RELEASE_ARTIFACT-$release_sha"');
        for (const flag of ['--package "$MAESTRO_PROOF_APP_ID"', '--variant "$RELEASE_VARIANT"', '--source-sha "$RELEASE_SHA"']) {
            expect(code).toContain(flag);
            expect(code.indexOf(flag)).toBeLessThan(code.indexOf('android-emulator-runner'));
        }
    });
});

describe('merchant edge isolation and privileged command coverage', () => {
    test('uses an explicit loopback address for the Growth readiness listener', () => {
        const growthBlock = compose.match(
            /\r?\n {2}growth-frontend:\r?\n([\s\S]*?)(?:\r?\n {2}[a-z0-9-]+:|\r?\nvolumes:)/,
        )?.[1];
        const readinessUrl = growthBlock?.match(/http:\/\/[^\s"']+\/health\/ready/)?.[0];
        expect(readinessUrl).toBeTruthy();

        const url = new URL(readinessUrl);
        const listeners = Array.from(
            growthNginx.matchAll(/^\s*listen\s+([^;]+);/gm),
            (match) => match[1].trim(),
        );
        const reachesConfiguredListener = url.port === '8080'
            && ((url.hostname === '127.0.0.1' && listeners.includes('8080'))
                || (url.hostname === '::1' && listeners.includes('[::]:8080')));

        expect(reachesConfiguredListener).toBe(true);
    });

    test('the TLS edge no longer cold-depends on the internal Growth SPA', () => {
        const caddyBlock = compose.match(/\r?\n {2}caddy:\r?\n([\s\S]*?)\r?\n {2}# ── Backend/)?.[1];
        const dependsBlock = caddyBlock?.match(/\r?\n {4}depends_on:\r?\n([\s\S]*)$/)?.[1];
        expect(caddyBlock).toContain('depends_on:');
        expect(dependsBlock).toContain('backend:');
        expect(dependsBlock).toContain('condition: service_healthy');
        expect(dependsBlock).toContain('frontend:');
        expect(dependsBlock).not.toContain('growth-frontend');
        // The Growth SPA service itself remains defined and routed.
        expect(compose).toContain('  growth-frontend:');
        const caddyfile = fs.readFileSync(path.resolve(__dirname, '../../../../Caddyfile'), 'utf8');
        expect(caddyfile).toContain('growth.easymod.tech');
        expect(caddyfile).toContain('reverse_proxy growth-frontend:8080');
    });

    test('backups tolerate a stopped internal Growth SPA via the deployment-record reference', () => {
        const backupWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../../../../.github/workflows/backup.yml'),
            'utf8',
        );
        expect(backupWorkflow).toContain('BACKUP_GROWTH_IMAGE_SOURCE=deployment-record');
        expect(backupWorkflow).not.toContain('growth-frontend-is-not-running"');
        // The digest-pinned contract itself must stay enforced.
        expect(backupWorkflow).toContain('image-is-not-digest-pinned');
    });

    test('every privileged SSH workflow caps remote commands explicitly', () => {
        const directory = path.resolve(__dirname, '../../../../.github/workflows');
        const offenders = fs.readdirSync(directory).filter((file) => {
            const text = fs.readFileSync(path.join(directory, file), 'utf8');
            return text.includes('appleboy/ssh-action') && !text.includes('command_timeout:');
        });
        expect(offenders).toEqual([]);
    });
});

describe('protected growth importer execution', () => {
    test('is manual, main-only, operator-bound, and serialized on the production environment', () => {
        expect(growthImporterWorkflow).toContain('workflow_dispatch:');
        expect(growthImporterWorkflow).toContain(
            "if: github.ref == 'refs/heads/main' && github.actor == 'mr3826'",
        );
        expect(growthImporterWorkflow).toContain('environment: production');
        expect(growthImporterWorkflow).toContain('group: run-growth-importer');
        expect(growthImporterWorkflow).toContain('cancel-in-progress: false');
    });

    test('defaults to dry-run and requires the literal phrase before any apply', () => {
        expect(growthImporterWorkflow).toContain('default: "dry-run"');
        expect(growthImporterWorkflow).toContain('"mode=apply requires the literal authorization phrase PRODUCTION-IMPORT-APPLY."');
        // Only the apply branch passes --apply; the default branch must not.
        const applyGuard = growthImporterWorkflow.indexOf('"$IMPORT_AUTHORIZATION" != "PRODUCTION-IMPORT-APPLY"');
        const applyFlag = growthImporterWorkflow.indexOf('import-growth-prospects.js --apply');
        expect(applyGuard).toBeGreaterThan(-1);
        expect(applyFlag).toBeGreaterThan(applyGuard);
    });

    test('enforces the post-apply idempotency gate instead of trusting the first run', () => {
        expect(growthImporterWorkflow).toContain('SECOND_RUN_WOULD_CREATE=');
        expect(growthImporterWorkflow).toContain('if [ "$would_create" != "0" ]; then');
    });

    test('refuses the idempotency proof unless the verification scan demonstrably completed', () => {
        // The importer exits 1 on per-row rejections while completing the scan,
        // and appends a sentinel row on a mid-scan read failure — so row-count
        // equality alone cannot prove completeness. The gate must capture the
        // apply status through the pipe, reject source-read failures, require
        // every source row accounted for, and require the same rejected set.
        expect(growthImporterWorkflow).toContain('apply_rc=${PIPESTATUS[0]}');
        expect(growthImporterWorkflow).toContain('verify_rc=${PIPESTATUS[0]}');
        expect(growthImporterWorkflow).toContain('PROBE_READ_FAILURE');
        expect(growthImporterWorkflow).toContain('if [ "$verify_read_failure" = "true" ]; then');
        expect(growthImporterWorkflow).toContain('verification pass incomplete');
        expect(growthImporterWorkflow).toContain('if [ -z "$verify_failed" ] || [ "$verify_failed" != "$apply_failed" ]; then');
        expect(growthImporterWorkflow).toContain('VERIFY_COMPLETED_WITH_KNOWN_ROW_REJECTIONS');
        expect(growthImporterWorkflow).toContain('exit "$apply_rc"');
    });

    test('runs the canonical script in the live backend container and persists receipts on the host', () => {
        expect(growthImporterWorkflow).toContain('scripts/import-growth-prospects.js');
        expect(growthImporterWorkflow).toContain('com.docker.compose.service=backend');
        expect(growthImporterWorkflow).toContain('/root/growth-os-receipts');
        // Inputs must be validated before interpolation into remote commands.
        expect(growthImporterWorkflow).toContain('case "$IMPORT_BATCH_SIZE" in "" | *[!0-9]*) IMPORT_BATCH_SIZE=100;; esac');
        // The remote program travels inside single quotes to ssh; apostrophes
        // inside it silently terminate the quoting (observed in run 36245354832).
        const remoteProgram = growthImporterWorkflow.split('root@"$DEPLOY_HOST" ')[1] || '';
        const quotedBody = remoteProgram.slice(remoteProgram.indexOf("'") + 1, remoteProgram.lastIndexOf("'"));
        expect(quotedBody.length).toBeGreaterThan(500);
        expect((quotedBody.match(/'/g) || []).length).toBe(0);
    });
});
