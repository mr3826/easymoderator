'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/ci-cd.yml'),
    'utf8',
);
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8');
const runbook = fs.readFileSync(
    path.join(repoRoot, 'docs/deployment/MONOREPO_CUTOVER_RUNBOOK.md'),
    'utf8',
);
const dbProbe = fs.readFileSync(
    path.join(repoRoot, 'EasyMod-backend/scripts/production-db-auth-probe.js'),
    'utf8',
);
const sources = [workflow, compose, runbook, dbProbe];

const required = [
    ['full commit SHA image tags', 'backend_tag=${{ env.GHCR_BACKEND }}:${SHA}'],
    ['previous backend capture', 'previous_backend_image=$(resolve_container_digest easymod-backend-1'],
    ['previous frontend capture', 'previous_frontend_image=$(resolve_container_digest easymod-frontend-1'],
    ['RepoDigest capture', "{{index .RepoDigests 0}}"],
    ['running digest guard', 'running services are not backed by content-addressed images'],
    ['candidate digest outputs', 'backend_digest: ${{ steps.backend_image.outputs.digest || inputs.existing_backend_digest }}'],
    ['candidate immutable assertion', 'assert_immutable_ref() {'],
    ['rendered compose image guard', 'config --images'],
    ['deployment metadata', 'deployment-metadata.json'],
    ['rollback function', 'rollback() {'],
    ['rollback image verification', 'verify_rollback() {'],
    ['rollback state directory', 'ROLLBACK_STATE_DIR'],
    ['rollback environment snapshot', 'cp -p /opt/easymod/.env.prod \'$ROLLBACK_STATE_DIR/.env.prod\''],
    ['rollback environment restore', 'cp -p "$ROLLBACK_STATE_DIR/.env.prod" /opt/easymod/.env.prod'],
    ['rollback configuration restore', 'cp -p "$ROLLBACK_STATE_DIR/docker-compose.prod.yml" /opt/easymod/docker-compose.prod.yml'],
    ['previous backend restore', 'export GHCR_IMAGE_BACKEND="$previous_backend_image"'],
    ['previous frontend restore', 'export GHCR_IMAGE_FRONTEND="$previous_frontend_image"'],
    ['no-build restore', 'up --detach --no-build --remove-orphans'],
    ['rollback failure status', 'rollback || rc=70'],
    ['failure trap', 'trap \'rc=$?; if [ "$rc" -ne 0 ]'],
    ['success marker', 'deploy_succeeded=true'],
    ['executable rollback rehearsal', 'scripts/rollback-rehearsal.sh'],
    ['backend immutable interpolation', 'image: ${GHCR_IMAGE_BACKEND:?'],
    ['frontend immutable interpolation', 'image: ${GHCR_IMAGE_FRONTEND:?'],
    ['growth running capture', 'candidate_growth_image=$(resolve_container_digest easymod-growth-frontend-1'],
    ['growth bootstrap pin', 'candidate_growth_image="${GHCR_GROWTH}@${GROWTH_BOOTSTRAP_DIGEST}"'],
    ['growth immutable assertion', 'assert_immutable_ref "$candidate_growth_image"'],
    ['growth immutable interpolation', 'image: ${GHCR_IMAGE_GROWTH:?'],
    ['rollback health contract', 'both health checks'],
    ['independent DB host probe', 'DB_HOST_RESOLUTION=PASS'],
    ['independent DB auth probe', 'DB_AUTH=PASS'],
    ['independent DB expected name', 'DB_NAME=EXPECTED'],
    ['independent DB select probe', 'SELECT_1=PASS'],
    ['schema rollback limitation', 'must not run `migrate:down`'],
];

const missing = required
    .filter(([, text]) => !sources.some((source) => source.includes(text)))
    .map(([label]) => label);

if (missing.length) {
    throw new Error(`Rollback contract missing: ${missing.join(', ')}`);
}

if (/^\s*[^#\n]*:(latest|dev)\b/m.test(workflow)
    || /GHCR_IMAGE_(BACKEND|FRONTEND).*latest/.test(compose)) {
    throw new Error('Rollback contract permits a mutable production image tag.');
}

const probeMount = ':/app/scripts/production-db-auth-probe.js:ro';
const probeCommand = 'node /app/scripts/production-db-auth-probe.js';
if (workflow.split(probeMount).length - 1 !== 2
    || workflow.split(probeCommand).length - 1 !== 2) {
    throw new Error('Production DB probe must preserve the image script path for relative imports.');
}
if (/require\(['"]\.\.\/src\//.test(dbProbe)) {
    throw new Error('Production DB probe must remain standalone inside the running image.');
}

if (!workflow.includes('candidate_backend_image="${GHCR_BACKEND}@${BACKEND_DIGEST}"')
    || !workflow.includes('candidate_frontend_image="${GHCR_FRONTEND}@${FRONTEND_DIGEST}"')
    || !workflow.includes('assert_immutable_ref "$candidate_backend_image"')
    || !workflow.includes('assert_immutable_ref "$candidate_frontend_image"')) {
    throw new Error('Production deployment does not fail closed on digest-pinned candidate references.');
}

if (!runbook.includes('GROWTH_BOOTSTRAP_DIGEST')
    || !workflow.includes('GROWTH_BOOTSTRAP_DIGEST')) {
    throw new Error('Growth OS first-rollout bootstrap contract is not documented in both the workflow and the runbook.');
}
if (/GHCR_IMAGE_GROWTH[^\n]*\.env\.prod|\.env\.prod[^\n]*GHCR_IMAGE_GROWTH/.test(runbook)) {
    throw new Error('Runbook still directs operators to pin GHCR_IMAGE_GROWTH in .env.prod, which the deploy regenerates.');
}

if (/(^|\n)\s*image:\s*[^\n]*:(latest|dev)(\s|$)/m.test(compose)
    || !compose.includes('image: caddy@sha256:')
    || !compose.includes('image: postgres@sha256:')
    || !compose.includes('image: redis@sha256:')
    || !compose.includes('image: qdrant/qdrant@sha256:')) {
    throw new Error('Production Compose contains mutable or unpinned infrastructure images.');
}

console.log('rollback-contract=PASS');
