#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/ci-cd.yml"
REPORT_PATH="$REPO_ROOT/_tmp/rollback-rehearsal-report.json"
STAGE_ROOT=/opt/easymod
MARKER="$STAGE_ROOT/.rollback-rehearsal-owned"
MARKER_CONTENT=rollback-rehearsal-owned
PROJECT_NAME="easymod-rollback-rehearsal-$$"
ROLLBACK_STATE_DIR="$STAGE_ROOT/.cutover-rollback/rehearsal-$$"
WORK_DIR=""
MARKER_OWNED=false

export PROJECT_NAME
export REPORT_PATH
export REHEARSAL_STATUS=FAIL
export REHEARSAL_EXIT_CODE=1
export EXTRACTED_FUNCTIONS=""
export MIGRATE_DOWN_EXTRACTED=false
export PREV_IMG=""
export CAND_IMG=""
export PREVIOUS_BACKEND_IMAGE=""
export PREVIOUS_FRONTEND_IMAGE=""
export PREVIOUS_GROWTH_IMAGE=""
export MANIFEST_ENV_HASH=""
export SNAPSHOT_ENV_HASH=""
export RESTORED_ENV_HASH=""
export SCENARIO_A=NOT_RUN
export SCENARIO_B=NOT_RUN
export SCENARIO_C=NOT_RUN
export HEALTH_READY=NOT_RUN
export HEALTH=NOT_RUN
export FRONTEND_HEALTH=NOT_RUN
export VERIFIED_WORKER_HEALTH_CALLS=0
export VERIFIED_PUBLIC_STACK_CALLS=0
export SCENARIO_B_WORKER_GATE=NOT_RUN
export SCENARIO_B_PUBLIC_GATE=NOT_RUN

write_report() {
    local exit_code="$1"
    REPORT_EXIT_CODE="$exit_code" node <<'NODE'
const fs = require('fs');
const path = require('path');

const report = {
    status: process.env.REHEARSAL_STATUS,
    exitCode: Number(process.env.REPORT_EXIT_CODE || 1),
    projectName: process.env.PROJECT_NAME,
    images: {
        previous: process.env.PREV_IMG || null,
        candidate: process.env.CAND_IMG || null,
        capturedBackend: process.env.PREVIOUS_BACKEND_IMAGE || null,
        capturedFrontend: process.env.PREVIOUS_FRONTEND_IMAGE || null,
        capturedGrowth: process.env.PREVIOUS_GROWTH_IMAGE || null,
    },
    hashes: {
        manifestEnv: process.env.MANIFEST_ENV_HASH || null,
        snapshotEnv: process.env.SNAPSHOT_ENV_HASH || null,
        restoredEnv: process.env.RESTORED_ENV_HASH || null,
    },
    scenarios: {
        candidateVerificationRejected: process.env.SCENARIO_A,
        rollbackRestoredPreviousState: process.env.SCENARIO_B,
        missingPreviousImageRejected: process.env.SCENARIO_C,
    },
    health: {
        ready: process.env.HEALTH_READY,
        health: process.env.HEALTH,
        frontend: process.env.FRONTEND_HEALTH,
    },
    gates: {
        workerHealth: process.env.SCENARIO_B_WORKER_GATE,
        publicStack: process.env.SCENARIO_B_PUBLIC_GATE,
    },
    extractedFunctions: process.env.EXTRACTED_FUNCTIONS
        ? process.env.EXTRACTED_FUNCTIONS.split(',').filter(Boolean)
        : [],
    migrateDownExtracted: process.env.MIGRATE_DOWN_EXTRACTED === 'true',
};

fs.mkdirSync(path.dirname(process.env.REPORT_PATH), { recursive: true });
fs.writeFileSync(
    process.env.REPORT_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
);
fs.chmodSync(process.env.REPORT_PATH, 0o600);
NODE
}

cleanup() {
    local rc=$?
    local cleanup_error=0
    trap - EXIT INT TERM
    set +e

    if [[ "$MARKER_OWNED" == "true" && -f "$STAGE_ROOT/docker-compose.prod.yml" ]]; then
        docker compose \
            --project-name "$PROJECT_NAME" \
            --env-file "$STAGE_ROOT/.env.prod" \
            -f "$STAGE_ROOT/docker-compose.prod.yml" \
            down --volumes --remove-orphans >/dev/null 2>&1 || cleanup_error=1
    fi

    if [[ "$MARKER_OWNED" == "true" ]]; then
        cd "$REPO_ROOT" 2>/dev/null || true
        sudo rm -rf "$STAGE_ROOT/.cutover-rollback"
        sudo rm -f \
            "$STAGE_ROOT/.env.prod" \
            "$STAGE_ROOT/docker-compose.prod.yml" \
            "$STAGE_ROOT/Caddyfile" \
            "$STAGE_ROOT/public-stub.js" \
            "$MARKER"
        sudo rmdir "$STAGE_ROOT" 2>/dev/null || true
    fi

    if [[ -n "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi

    if [[ "$rc" -eq 0 && "$cleanup_error" -ne 0 ]]; then
        rc=1
    fi
    if [[ "$rc" -eq 0 ]]; then
        REHEARSAL_STATUS=PASS
    else
        REHEARSAL_STATUS=FAIL
    fi
    REHEARSAL_EXIT_CODE="$rc"
    export REHEARSAL_STATUS REHEARSAL_EXIT_CODE
    write_report "$rc" || rc=1

    if [[ "$rc" -eq 0 ]]; then
        printf '%s\n' 'rollback-rehearsal=PASS'
    fi
    exit "$rc"
}

if [[ "${1:-}" == --exit-handler-only ]]; then
    trap '[[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"' EXIT
else
    trap cleanup EXIT
    if [[ "${CI:-}" != "true" && "${ROLLBACK_REHEARSAL_ALLOW:-}" != "1" ]]; then
        echo 'ERROR: rollback rehearsal requires CI=true or ROLLBACK_REHEARSAL_ALLOW=1' >&2
        exit 1
    fi
    mkdir -p "$REPO_ROOT/_tmp"
fi
trap 'exit 130' INT TERM

WORK_DIR="$(mktemp -d)"
EXTRACTED_FILE="$WORK_DIR/extracted-functions.sh"
: > "$EXTRACTED_FILE"

extract_function() {
    local name="$1"
    local start_line
    local end_line
    local indent

    start_line="$(grep -nE "^[[:space:]]*${name}\(\) \{$" "$WORKFLOW_FILE" \
        | sed -n '1s/:.*//p' || true)"
    if [[ -z "$start_line" ]]; then
        echo "ERROR: rollback function $name is missing from ci-cd.yml" >&2
        exit 1
    fi

    indent="$(sed -n "${start_line}p" "$WORKFLOW_FILE" | sed -E 's/[^ ].*$//')"
    if [[ -z "$indent" ]]; then
        echo "ERROR: rollback function $name has no YAML block indentation" >&2
        exit 1
    fi

    end_line="$(awk -v start="$start_line" -v indent="$indent" \
        '{ sub(/\r$/, "") } NR > start && $0 == indent "}" { print NR; exit }' "$WORKFLOW_FILE")"
    if [[ -z "$end_line" || "$end_line" -le "$start_line" ]]; then
        echo "ERROR: rollback function $name has no closing brace" >&2
        exit 1
    fi

    sed -n "${start_line},${end_line}p" "$WORKFLOW_FILE" \
        | sed -e "s/^${indent}//" \
            -e 's/\r$//' \
            -e "s/--resolve 'easymod.tech:443:127.0.0.1' //g" \
            -e "s/--resolve 'api.easymod.tech:443:127.0.0.1' //g" \
            -e 's@https://easymod.tech/@http://127.0.0.1:18080/@g' \
            -e 's@https://api.easymod.tech/health/ready@http://127.0.0.1:18080/health/ready@g' >> "$EXTRACTED_FILE"
    printf '\n' >> "$EXTRACTED_FILE"
}

for function_name in \
    resolve_container_digest \
    assert_immutable_ref \
    config_hashes \
    verify_config \
    verify_worker_health \
    verify_public_stack \
    verify_rollback \
    finish_deploy \
    rollback; do
    extract_function "$function_name"
done

EXTRACTED_FUNCTIONS='resolve_container_digest,assert_immutable_ref,config_hashes,verify_config,verify_worker_health,verify_public_stack,verify_rollback,finish_deploy,rollback'
export EXTRACTED_FUNCTIONS
if grep -Fq 'migrate:down' "$EXTRACTED_FILE"; then
    MIGRATE_DOWN_EXTRACTED=true
    export MIGRATE_DOWN_EXTRACTED
    echo 'ERROR: extracted rollback functions contain migrate:down' >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$EXTRACTED_FILE"

# Exercise the shipped EXIT handler independently of the fixture containers.
# The success/metadata publication branch is not used in this test.
for scenario in before_activation restored restore_failed; do
    journal_dir="$WORK_DIR/exit-handler-$scenario"
    mkdir -p "$journal_dir/candidate"
    : > "$journal_dir/candidate/.env.prod"
    : > "$journal_dir/transaction"
    ln -- "$journal_dir/transaction" "$journal_dir/active"
    if (
        trap - EXIT
        ROLLBACK_STATE_DIR="$journal_dir"
        candidate_dir="$journal_dir/candidate"
        active_transaction="$journal_dir/active"
        activation_started=true
        deploy_succeeded=false
        if [[ "$scenario" == before_activation ]]; then activation_started=false; fi
        rollback() {
            : > "$journal_dir/restore-called"
            [[ "$scenario" != restore_failed ]]
        }
        trap finish_deploy EXIT
        trap 'exit 143' TERM
        kill -TERM "$BASHPID"
    ); then
        echo "ERROR: interrupted deployment passed: $scenario" >&2
        exit 1
    else
        journal_rc=$?
    fi
    [[ ! -e "$journal_dir/candidate/.env.prod" ]]
    case "$scenario" in
        before_activation) [[ "$journal_rc" == 143 && ! -e "$journal_dir/active" && ! -e "$journal_dir/restore-called" ]] ;;
        restored) [[ "$journal_rc" == 143 && ! -e "$journal_dir/active" && -e "$journal_dir/restore-called" ]] ;;
        restore_failed) [[ "$journal_rc" == 70 && -e "$journal_dir/active" && -e "$journal_dir/restore-called" ]] ;;
    esac
done
echo 'Rollback EXIT handler interruption checks passed'
if [[ "${1:-}" == --exit-handler-only ]]; then
    # This lane is strictly local and does not run the full rehearsal or emit
    # an exact-image receipt. Leave the host and Docker untouched.
    exit 0
fi

# The worker-health and identity-bound public-stack gates run against the
# disposable fixture services below, so the rehearsal exercises the production
# functions themselves instead of stubbing them out.
previous_backend_commit='0000000000000000000000000000000000000000'
previous_growth_commit='1111111111111111111111111111111111111111'
export previous_backend_commit previous_growth_commit
export REHEARSAL_BACKEND_COMMIT="$previous_backend_commit"
export REHEARSAL_GROWTH_COMMIT="$previous_growth_commit"
export APP_URL="http://127.0.0.1:18081"
export API_URL="http://127.0.0.1:18081"
export GROWTH_URL="http://127.0.0.1:18081"

if [[ -e "$STAGE_ROOT/.env.prod" || -e "$STAGE_ROOT/deployment-metadata.json" ]] \
    && [[ ! -f "$MARKER" ]]; then
    echo "ERROR: refusing to use $STAGE_ROOT because a production state file already exists" >&2
    exit 1
fi

if [[ -d "$STAGE_ROOT" && ! -f "$MARKER" ]] \
    && [[ -n "$(find "$STAGE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "ERROR: refusing to use non-empty unowned directory $STAGE_ROOT" >&2
    exit 1
fi

sudo mkdir -p "$STAGE_ROOT"
sudo chown "$(id -u):$(id -g)" "$STAGE_ROOT"
if [[ -f "$MARKER" ]]; then
    if ! sudo grep -Fxq "$MARKER_CONTENT" "$MARKER"; then
        echo "ERROR: refusing to use $STAGE_ROOT with an unknown rehearsal marker" >&2
        exit 1
    fi
else
    printf '%s\n' "$MARKER_CONTENT" | sudo tee "$MARKER" >/dev/null
    sudo chown "$(id -u):$(id -g)" "$MARKER"
fi
MARKER_OWNED=true

docker pull node:20-alpine
docker pull node:22-alpine
docker pull caddy@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794
PREV_IMG="$(docker image inspect -f '{{index .RepoDigests 0}}' node:20-alpine)"
CAND_IMG="$(docker image inspect -f '{{index .RepoDigests 0}}' node:22-alpine)"
export PREV_IMG CAND_IMG
case "$PREV_IMG" in *@sha256:*) ;; *) echo 'ERROR: previous fixture is not digest-pinned' >&2; exit 1 ;; esac
case "$CAND_IMG" in *@sha256:*) ;; *) echo 'ERROR: candidate fixture is not digest-pinned' >&2; exit 1 ;; esac
assert_immutable_ref "$PREV_IMG"
assert_immutable_ref "$CAND_IMG"

cat > "$WORK_DIR/docker-compose.prod.yml" <<'YAML'
services:
  backend:
    image: ${GHCR_IMAGE_BACKEND:?GHCR_IMAGE_BACKEND must be immutable}
    container_name: easymod-backend-1
    env_file:
      - .env.prod
    command: ["node", "-e", "require('http').createServer((_, res) => res.end()).listen(3000)"]
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 1s
      timeout: 2s
      retries: 10
  frontend:
    image: ${GHCR_IMAGE_FRONTEND:?GHCR_IMAGE_FRONTEND must be immutable}
    container_name: easymod-frontend-1
    env_file:
      - .env.prod
    command: ["node", "-e", "require('http').createServer((_, res) => res.end(process.env.REHEARSAL_VARIANT)).listen(8080)"]
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 1s
      timeout: 2s
      retries: 10
  growth-frontend:
    image: ${GHCR_IMAGE_GROWTH:?GHCR_IMAGE_GROWTH must be immutable}
    container_name: easymod-growth-frontend-1
    env_file:
      - .env.prod
    command: ["node", "-e", "require('http').createServer((_, res) => res.end()).listen(8080)"]
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:8080/health/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 1s
      timeout: 2s
      retries: 10
  caddy:
    image: caddy@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794
    container_name: easymod-caddy-1
    ports:
      - "18080:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
  worker:
    image: ${GHCR_IMAGE_BACKEND:?GHCR_IMAGE_BACKEND must be immutable}
    container_name: easymod-worker-1
    env_file:
      - .env.prod
    command: ["node", "-e", "require('http').createServer((_, res) => res.end()).listen(3000)"]
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 1s
      timeout: 2s
      retries: 10
  public-stub:
    image: ${GHCR_IMAGE_BACKEND:?GHCR_IMAGE_BACKEND must be immutable}
    container_name: easymod-public-stub-1
    environment:
      REHEARSAL_BACKEND_COMMIT: ${REHEARSAL_BACKEND_COMMIT:?REHEARSAL_BACKEND_COMMIT must be set}
      REHEARSAL_GROWTH_COMMIT: ${REHEARSAL_GROWTH_COMMIT:?REHEARSAL_GROWTH_COMMIT must be set}
    command: ["node", "/rehearsal/public-stub.js"]
    volumes:
      - ./public-stub.js:/rehearsal/public-stub.js:ro
    ports:
      - "18081:8080"
YAML

cat > "$WORK_DIR/previous.env.prod" <<'EOF'
REHEARSAL_VARIANT=previous
EOF
cat > "$WORK_DIR/candidate.env.prod" <<'EOF'
REHEARSAL_VARIANT=candidate
EOF
cat > "$WORK_DIR/previous.Caddyfile" <<'EOF'
:80 {
    reverse_proxy /health/ready backend:3000
    reverse_proxy frontend:8080
}
EOF
cat > "$WORK_DIR/candidate.Caddyfile" <<'EOF'
:80 {
    header X-Rehearsal-Variant candidate
    reverse_proxy /health/ready backend:3000
    reverse_proxy frontend:8080
}
EOF

install_variant() {
    local variant="$1"
    cp -p "$WORK_DIR/docker-compose.prod.yml" "$STAGE_ROOT/docker-compose.prod.yml"
    cp -p "$WORK_DIR/${variant}.env.prod" "$STAGE_ROOT/.env.prod"
    cp -p "$WORK_DIR/${variant}.Caddyfile" "$STAGE_ROOT/Caddyfile"
    chmod 600 "$STAGE_ROOT/.env.prod"
}

compose() {
    docker compose \
        --project-name "$PROJECT_NAME" \
        --env-file "$STAGE_ROOT/.env.prod" \
        -f "$STAGE_ROOT/docker-compose.prod.yml" \
        "$@"
}

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"

cat > "$STAGE_ROOT/public-stub.js" <<'STUB_JS'
const http = require('http');

const backendCommit = process.env.REHEARSAL_BACKEND_COMMIT || '';
const growthCommit = process.env.REHEARSAL_GROWTH_COMMIT || '';

function send(res, status, type, body) {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
}

http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/') {
        return send(res, 200, 'text/html', '<!doctype html><html><body><div id="root"></div></body></html>');
    }
    if (path === '/health/ready') {
        return send(
            res,
            200,
            'application/json',
            JSON.stringify({
                service: 'easymod-backend',
                status: 'ready',
                database: 'connected',
                redis: 'connected',
            }),
        );
    }
    if (path === '/api/version') {
        return send(res, 200, 'application/json', JSON.stringify({ gitSha: backendCommit }));
    }
    if (path === '/build-info.json') {
        return send(res, 200, 'application/json', JSON.stringify({ commit: growthCommit }));
    }
    return send(res, 404, 'text/plain', 'not found');
}).listen(8080, '0.0.0.0');
STUB_JS

install_variant previous
export GHCR_IMAGE_BACKEND="$PREV_IMG"
export GHCR_IMAGE_FRONTEND="$PREV_IMG"
export GHCR_IMAGE_GROWTH="$PREV_IMG"
compose up --detach --wait --no-build --remove-orphans

previous_backend_image="$(resolve_container_digest easymod-backend-1)"
previous_frontend_image="$(resolve_container_digest easymod-frontend-1)"
previous_growth_image="$(resolve_container_digest easymod-growth-frontend-1)"
export PREVIOUS_BACKEND_IMAGE="$previous_backend_image"
export PREVIOUS_FRONTEND_IMAGE="$previous_frontend_image"
export PREVIOUS_GROWTH_IMAGE="$previous_growth_image"
assert_immutable_ref "$previous_backend_image"
assert_immutable_ref "$previous_frontend_image"
assert_immutable_ref "$previous_growth_image"

mkdir -p "$ROLLBACK_STATE_DIR"
chmod 700 "$ROLLBACK_STATE_DIR"
cp -p "$STAGE_ROOT/.env.prod" "$ROLLBACK_STATE_DIR/.env.prod"
cp -p "$STAGE_ROOT/docker-compose.prod.yml" "$ROLLBACK_STATE_DIR/docker-compose.prod.yml"
cp -p "$STAGE_ROOT/Caddyfile" "$ROLLBACK_STATE_DIR/Caddyfile"
config_hashes "$ROLLBACK_STATE_DIR" > "$ROLLBACK_STATE_DIR/manifest.sha256"
chmod 600 "$ROLLBACK_STATE_DIR/.env.prod" "$ROLLBACK_STATE_DIR/manifest.sha256"

SNAPSHOT_ENV_HASH="$(sha256sum "$ROLLBACK_STATE_DIR/.env.prod" | awk '{print $1}')"
MANIFEST_ENV_HASH="$(awk '$2 == ".env.prod" {print $1}' "$ROLLBACK_STATE_DIR/manifest.sha256")"
export SNAPSHOT_ENV_HASH MANIFEST_ENV_HASH

install_variant candidate
export GHCR_IMAGE_BACKEND="$CAND_IMG"
export GHCR_IMAGE_FRONTEND="$CAND_IMG"
export GHCR_IMAGE_GROWTH="$CAND_IMG"
compose up --detach --wait --no-build --remove-orphans

cd "$STAGE_ROOT"
if verify_rollback > "$WORK_DIR/scenario-a.log" 2>&1; then
    cat "$WORK_DIR/scenario-a.log" >&2
    echo 'ERROR: verify_rollback accepted the still-running candidate state' >&2
    exit 1
fi
if ! grep -Fq 'rollback image references were not restored' "$WORK_DIR/scenario-a.log"; then
    cat "$WORK_DIR/scenario-a.log" >&2
    echo 'ERROR: verify_rollback did not report the expected negative scenario' >&2
    exit 1
fi
SCENARIO_A=PASS
export SCENARIO_A

if ! rollback > "$WORK_DIR/scenario-b.log" 2>&1; then
    cat "$WORK_DIR/scenario-b.log" >&2
    echo 'ERROR: rollback did not restore the captured previous state' >&2
    exit 1
fi

restored_backend="$(docker inspect -f '{{.Config.Image}}' easymod-backend-1)"
restored_frontend="$(docker inspect -f '{{.Config.Image}}' easymod-frontend-1)"
restored_growth="$(docker inspect -f '{{.Config.Image}}' easymod-growth-frontend-1)"
if [[ "$restored_backend" != "$previous_backend_image" \
    || "$restored_frontend" != "$previous_frontend_image" \
    || "$restored_growth" != "$previous_growth_image" ]]; then
    echo 'ERROR: independent image assertion did not match the captured RepoDigests' >&2
    exit 1
fi

RESTORED_ENV_HASH="$(sha256sum "$STAGE_ROOT/.env.prod" | awk '{print $1}')"
export RESTORED_ENV_HASH
if [[ -z "$MANIFEST_ENV_HASH" \
    || "$RESTORED_ENV_HASH" != "$MANIFEST_ENV_HASH" \
    || "$SNAPSHOT_ENV_HASH" != "$MANIFEST_ENV_HASH" ]]; then
    echo 'ERROR: restored environment hash did not match the snapshot manifest' >&2
    exit 1
fi
cmp -s "$ROLLBACK_STATE_DIR/docker-compose.prod.yml" "$STAGE_ROOT/docker-compose.prod.yml"
cmp -s "$ROLLBACK_STATE_DIR/Caddyfile" "$STAGE_ROOT/Caddyfile"

check_backend_health() {
    local endpoint="$1"
    docker exec easymod-backend-1 node -e \
        "require('http').get('http://127.0.0.1:3000${endpoint}', r => { r.resume(); r.on('end', () => process.exit(r.statusCode === 200 ? 0 : 1)); }).on('error', () => process.exit(1));"
}

check_backend_health /health/ready
HEALTH_READY=PASS
export HEALTH_READY
check_backend_health /health
HEALTH=PASS
export HEALTH

wait_for_frontend_health() {
    local frontend_health
    for _ in $(seq 1 30); do
        frontend_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' easymod-frontend-1)"
        if [[ "$frontend_health" == "healthy" ]]; then
            return 0
        fi
        sleep 1
    done
    echo "ERROR: restored frontend health status was $frontend_health" >&2
    return 1
}

wait_for_frontend_health
FRONTEND_HEALTH=PASS
export FRONTEND_HEALTH

wait_for_growth_health() {
    local growth_health
    for _ in $(seq 1 30); do
        growth_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' easymod-growth-frontend-1)"
        if [[ "$growth_health" == "healthy" ]]; then
            return 0
        fi
        sleep 1
    done
    echo "ERROR: restored Growth frontend health status was $growth_health" >&2
    return 1
}

wait_for_growth_health
docker exec easymod-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
if ! grep -Fq 'Worker health check passed on attempt' "$WORK_DIR/scenario-b.log"; then
    cat "$WORK_DIR/scenario-b.log" >&2
    echo 'ERROR: rollback did not run the worker-health gate' >&2
    exit 1
fi
SCENARIO_B_WORKER_GATE=PASS
export SCENARIO_B_WORKER_GATE
if ! grep -Fq 'smoke passed on attempt' "$WORK_DIR/scenario-b.log"; then
    cat "$WORK_DIR/scenario-b.log" >&2
    echo 'ERROR: rollback did not run the identity-bound public-stack gate' >&2
    exit 1
fi
SCENARIO_B_PUBLIC_GATE=PASS
export SCENARIO_B_PUBLIC_GATE
SCENARIO_B=PASS
export SCENARIO_B

previous_backend_image_backup="$previous_backend_image"
previous_backend_image=''
if scenario_c_output="$(rollback 2>&1)"; then
    printf '%s\n' "$scenario_c_output" >&2
    echo 'ERROR: rollback accepted a missing previous backend image' >&2
    exit 1
fi
previous_backend_image="$previous_backend_image_backup"
if ! grep -Fq 'manual recovery is required' <<< "$scenario_c_output"; then
    printf '%s\n' "$scenario_c_output" >&2
    echo 'ERROR: rollback did not report manual recovery for missing previous image' >&2
    exit 1
fi
SCENARIO_C=PASS
export SCENARIO_C
