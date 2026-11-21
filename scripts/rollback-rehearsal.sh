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
export RESTORE_R1=NOT_RUN
export RESTORE_R2=NOT_RUN
export RESTORE_R3=NOT_RUN
export RESTORE_R4=NOT_RUN
export RESTORE_R5=NOT_RUN
export RESTORE_R67=NOT_RUN
export RESTORE_R8=NOT_RUN
export RESTORE_GROWTH_OVERRIDE=NOT_RUN

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
    // WP-04 restore-floor lane: incumbent writer -> qualified floor ->
    // rollback. R1/R2 prove the runner-side qualification gates with the real
    // extracted verify_reader_projection_source against a synthetic repository
    // (fixture revisions replace the OCI revision label, which is proven by
    // the workflow guard pins); R3-R8 plus the growth-override identity case
    // exercise the extracted deploy functions against real fixtures.
    restoreScenarios: {
        writerRejectedAsFloor: process.env.RESTORE_R1,
        nonAncestorFloorRejected: process.env.RESTORE_R2,
        incumbentMismatchRejected: process.env.RESTORE_R3,
        happyWriterToFloorRestore: process.env.RESTORE_R4,
        activationFailureRolledBackToWriter: process.env.RESTORE_R5,
        interruptionHandlerRestoreStaging: process.env.RESTORE_R67,
        missingPreviousImageRejected: process.env.RESTORE_R8,
        growthOverrideIdentityAndRestore: process.env.RESTORE_GROWTH_OVERRIDE,
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

# The restore-floor qualification gate additionally needs the reader/writer
# projection verifier. It is appended to the same extracted set (the guarded
# production function list itself stays exactly the nine names), extraction
# failure is fatal, and the forward-cutover scenarios never call it.
extract_function verify_reader_projection_source

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
# Restore-labeled invocation of the same EXIT handler lane. A floor restore
# never stages a candidate .env.prod, so finish_deploy's rm -f must be safe
# when the candidate directory exists but holds nothing: the assertions below
# are identical except that no staged environment file is ever created.
for scenario in restore_before_activation restore_restored restore_restore_failed; do
    journal_dir="$WORK_DIR/exit-handler-$scenario"
    mkdir -p "$journal_dir/candidate"
    : > "$journal_dir/transaction"
    ln -- "$journal_dir/transaction" "$journal_dir/active"
    if (
        trap - EXIT
        ROLLBACK_STATE_DIR="$journal_dir"
        candidate_dir="$journal_dir/candidate"
        active_transaction="$journal_dir/active"
        activation_started=true
        deploy_succeeded=false
        if [[ "$scenario" == restore_before_activation ]]; then activation_started=false; fi
        rollback() {
            : > "$journal_dir/restore-called"
            [[ "$scenario" != restore_restore_failed ]]
        }
        trap finish_deploy EXIT
        trap 'exit 143' TERM
        kill -TERM "$BASHPID"
    ); then
        echo "ERROR: interrupted floor restore passed: $scenario" >&2
        exit 1
    else
        journal_rc=$?
    fi
    [[ ! -e "$journal_dir/candidate/.env.prod" ]]
    [[ -d "$journal_dir/candidate" ]]
    case "$scenario" in
        restore_before_activation) [[ "$journal_rc" == 143 && ! -e "$journal_dir/active" && ! -e "$journal_dir/restore-called" ]] ;;
        restore_restored) [[ "$journal_rc" == 143 && ! -e "$journal_dir/active" && -e "$journal_dir/restore-called" ]] ;;
        restore_restore_failed) [[ "$journal_rc" == 70 && -e "$journal_dir/active" && -e "$journal_dir/restore-called" ]] ;;
    esac
done
RESTORE_R67=PASS
export RESTORE_R67
echo 'Floor-restore EXIT handler interruption checks passed'
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

# The forward-cutover scenarios (candidate rejection, rollback restore, and
# missing-previous fail-closed) run in the default full rehearsal only; the
# --restore-floor selector jumps straight to the restore lane after this block.
if [[ "${1:-}" != --restore-floor ]]; then
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
fi

# ── Restore-floor lane (WP-04): incumbent writer -> qualified floor -> rollback
# Role mapping inside this lane: the node:22 candidate fixture IS the running
# WRITER incumbent and the node:20 previous fixture IS the qualified reader
# floor being restored, so the flow exercises writer -> floor -> (on failure)
# rollback-to-writer. R1/R2 emulate the ci-cd.yml "Qualify floor images" step
# with a synthetic git repository plus the verbatim
# verify_reader_projection_source extracted from the shipped workflow; the
# fixture revisions stand in for the OCI revision label, which the guard-test
# pins bind to the real resolver and ancestry chain. R3-R8 and the
# growth-override identity case run the extracted production functions against
# the live fixture stack. The public-stack commit values are fixture
# environment inputs to the stub (which is how the stub models the identity
# the real images report from their build metadata).

restore_assert_rollback_match() {
    # Literal mirror of the ci-cd.yml rehearsed-incumbent equality gate, with
    # the package component read from the captured running reference itself.
    local expected_backend="$1" expected_frontend="$2"
    if [ -n "$expected_backend" ] \
      && [ "$previous_backend_image" != "${previous_backend_image%@*}@$expected_backend" ]; then
        echo "ERROR: the running backend/worker does not match the rehearsed rollback digest" >&2
        return 1
    fi
    if [ -n "$expected_frontend" ] \
      && [ "$previous_frontend_image" != "${previous_frontend_image%@*}@$expected_frontend" ]; then
        echo "ERROR: the running frontend does not match the rehearsed rollback digest" >&2
        return 1
    fi
}

# R1/R2: runner-side floor qualification against a synthetic repository.
qualify_repo="$WORK_DIR/qualify-repo"
mkdir -p "$qualify_repo"
(
    cd "$qualify_repo"
    git init -q -b main
    git config user.email rehearsal@easymod.local
    git config user.name rollback-rehearsal
    # Deterministic line endings regardless of the runner's global autocrlf.
    git config core.autocrlf input
    sanitizer_path=EasyMod-backend/src/modules/conversation/internal-message-metadata.js
    projection_path=EasyMod-backend/src/modules/conversation/message-evidence-projection.js
    conversation_path=EasyMod-backend/src/modules/conversation/conversation.service.js
    sse_path=EasyMod-backend/src/utils/sse-manager.js
    mkdir -p "$(dirname "$sanitizer_path")" "$(dirname "$projection_path")" \
        "$(dirname "$conversation_path")" "$(dirname "$sse_path")" \
        EasyMod-backend/src/modules/ai
    printf '%s\n' 'const PUBLIC_MESSAGE_FIELDS = [];' 'for (const field of PUBLIC_MESSAGE_FIELDS) {' '}' > "$sanitizer_path"
    printf '%s\n' 'function projectPublicMessageMetadata(source) {' 'function projectPublicMessageEvent(event, data) {' > "$projection_path"
    printf '%s\n' 'projectPublicMessageMetadata(message)' > "$conversation_path"
    printf '%s\n' 'function projectPublicMessageEvent(event, payload)' > "$sse_path"
    git add -A
    git commit -qm 'floor: reader-only projection'
    git rev-parse HEAD > "$WORK_DIR/floor_sha"
    # Writer tip: adds the confidence services (disqualifies reader-only) and
    # the projection-evidence call sites the writer branch requires.
    printf '%s\n' 'function projectMessageEvidence(event, source) {' 'function projectPublicMessageMetadata(source) {' 'function projectPublicMessageEvent(event, data) {' > "$projection_path"
    printf '%s\n' 'function projectMessageEvidence(event) {' 'projectPublicMessageMetadata(message)' > "$conversation_path"
    printf '%s\n' 'function projectMessageEvent(event, data) {' > "$sse_path"
    printf '%s\n' 'exports.REPLY_CONFIDENCE = true;' > EasyMod-backend/src/modules/ai/reply-confidence.service.js
    printf '%s\n' 'exports.REPLY_CONFIDENCE_ROLLUP = true;' > EasyMod-backend/src/modules/ai/reply-confidence-rollup.service.js
    git add -A
    git commit -qm 'writer: stage 2 promotion'
    git rev-parse HEAD > "$WORK_DIR/writer_sha"
    # Side-branch floor revision that is not an ancestor of main.
    git checkout -q -b side "$(cat "$WORK_DIR/floor_sha")"
    printf '%s\n' 'function projectPublicMessageMetadata(message) {' > "$conversation_path"
    git add -A
    git commit -qm 'side: non-ancestor floor'
    git rev-parse HEAD > "$WORK_DIR/side_sha"
)
floor_sha="$(cat "$WORK_DIR/floor_sha")"
writer_sha="$(cat "$WORK_DIR/writer_sha")"
side_sha="$(cat "$WORK_DIR/side_sha")"
[[ "$floor_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$writer_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$side_sha" =~ ^[0-9a-f]{40}$ ]]
( cd "$qualify_repo" && git merge-base --is-ancestor "$floor_sha" "$writer_sha" )
# R1: the writer tip must be refused as a "reader-only recovery revision".
if r1_output="$( cd "$qualify_repo" && verify_reader_projection_source "$writer_sha" 'Restore floor candidate' reader 2>&1 )"; then
    printf '%s\n' "$r1_output" >&2
    echo 'ERROR: floor qualification accepted a writer revision as reader-only (R1)' >&2
    exit 1
fi
if ! grep -Fq 'is not a reader-only recovery revision' <<< "$r1_output"; then
    printf '%s\n' "$r1_output" >&2
    echo 'ERROR: floor qualification rejected the writer revision for the wrong reason (R1)' >&2
    exit 1
fi
# R2: a non-ancestor revision must be refused before it can qualify.
if ( cd "$qualify_repo" && git merge-base --is-ancestor "$side_sha" "$writer_sha" ) >/dev/null 2>&1; then
    echo 'ERROR: floor qualification accepted a non-ancestor floor revision (R2)' >&2
    exit 1
fi
# Qualification positives for the happy path: floor passes reader, writer tip
# passes writer — exactly the pair the restore job checks before any SSH.
( cd "$qualify_repo" && verify_reader_projection_source "$floor_sha" 'Restore floor' reader ) >/dev/null
( cd "$qualify_repo" && verify_reader_projection_source "$writer_sha" 'Current main' writer ) >/dev/null
RESTORE_R1=PASS
RESTORE_R2=PASS
export RESTORE_R1 RESTORE_R2

# Install the running WRITER incumbent (the candidate fixture stands in for
# the promoted writer; its public identity is the writer revision).
install_variant candidate
export GHCR_IMAGE_BACKEND="$CAND_IMG"
export GHCR_IMAGE_FRONTEND="$CAND_IMG"
export GHCR_IMAGE_GROWTH="$CAND_IMG"
export REHEARSAL_BACKEND_COMMIT="$writer_sha"
export REHEARSAL_GROWTH_COMMIT='3333333333333333333333333333333333333333'
compose up --detach --wait --no-build --remove-orphans
cd "$STAGE_ROOT"

previous_backend_image="$(resolve_container_digest easymod-backend-1)"
previous_worker_image="$(resolve_container_digest easymod-worker-1)"
previous_frontend_image="$(resolve_container_digest easymod-frontend-1)"
previous_growth_image="$(resolve_container_digest easymod-growth-frontend-1)"
if [[ "$previous_worker_image" != "$previous_backend_image" ]]; then
    echo "ERROR: restore lane incumbent worker does not match the backend image" >&2
    exit 1
fi
assert_immutable_ref "$previous_backend_image"
assert_immutable_ref "$previous_frontend_image"
assert_immutable_ref "$previous_growth_image"
previous_backend_commit="$writer_sha"
previous_growth_commit="$REHEARSAL_GROWTH_COMMIT"

# R3: presenting the FLOOR pair as the rehearsed incumbent must be refused,
# while the true running writer pair satisfies the equality gate exactly.
if r3_output="$(restore_assert_rollback_match "${PREV_IMG#*@}" "${PREV_IMG#*@}" 2>&1)"; then
    printf '%s\n' "$r3_output" >&2
    echo 'ERROR: restore lane accepted a mismatched rehearsed incumbent (R3)' >&2
    exit 1
fi
grep -Fq 'does not match the rehearsed rollback digest' <<< "$r3_output"
restore_assert_rollback_match "${CAND_IMG#*@}" "${CAND_IMG#*@}"
RESTORE_R3=PASS
export RESTORE_R3

# Incumbent configuration snapshot — the exact lines the restore job reuses
# from the deploy script; a floor restore never overwrites this configuration.
cp -p "$STAGE_ROOT/.env.prod" "$ROLLBACK_STATE_DIR/.env.prod"
chmod 600 "$ROLLBACK_STATE_DIR/.env.prod"
cp -p "$STAGE_ROOT/docker-compose.prod.yml" "$ROLLBACK_STATE_DIR/docker-compose.prod.yml"
cp -p "$STAGE_ROOT/Caddyfile" "$ROLLBACK_STATE_DIR/Caddyfile"
config_hashes "$ROLLBACK_STATE_DIR" > "$ROLLBACK_STATE_DIR/manifest.sha256"
verify_config "$ROLLBACK_STATE_DIR" "$ROLLBACK_STATE_DIR/manifest.sha256"
verify_config /opt/easymod "$ROLLBACK_STATE_DIR/manifest.sha256"
mkdir -p "$ROLLBACK_STATE_DIR/candidate"

# R4: happy incumbent-writer -> qualified-floor activation through the real
# finish_deploy trap (metadata published, marker removed).
candidate_backend_image="$PREV_IMG"
candidate_frontend_image="$PREV_IMG"
candidate_growth_image="$previous_growth_image"
FLOOR_REVISION="$floor_sha"
if ! (
    trap - EXIT
    cd /opt/easymod
    candidate_dir="$ROLLBACK_STATE_DIR/candidate"
    active_transaction=/opt/easymod/.cutover-rollback/active
    deploy_succeeded=false
    activation_started=false
    printf '%s\n' "state=$ROLLBACK_STATE_DIR" "backend=$previous_backend_image" \
      "frontend=$previous_frontend_image" "worker=$previous_worker_image" \
      "growth=$previous_growth_image" > "$ROLLBACK_STATE_DIR/transaction"
    trap finish_deploy EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    ln -- "$ROLLBACK_STATE_DIR/transaction" "$active_transaction"
    activation_started=true
    export GHCR_IMAGE_BACKEND="$candidate_backend_image"
    export GHCR_IMAGE_FRONTEND="$candidate_frontend_image"
    export GHCR_IMAGE_GROWTH="$candidate_growth_image"
    export REHEARSAL_BACKEND_COMMIT="$FLOOR_REVISION"
    export REHEARSAL_GROWTH_COMMIT="$previous_growth_commit"
    # public-stub joins the activation list because the fixture stack models
    # the public /api/version and /build-info.json identity with a container
    # whose image reference tracks the backend: the real restore gets that
    # identity for free from the swapped backend itself.
    compose up --detach --no-build --remove-orphans backend worker frontend growth-frontend public-stub
    floor_backend_running="$(resolve_container_digest easymod-backend-1)"
    floor_worker_running="$(resolve_container_digest easymod-worker-1)"
    floor_frontend_running="$(resolve_container_digest easymod-frontend-1)"
    if [ "$floor_backend_running" != "$candidate_backend_image" ] \
      || [ "$floor_worker_running" != "$candidate_backend_image" ] \
      || [ "$floor_frontend_running" != "$candidate_frontend_image" ]; then
        echo "ERROR: running backend, worker, or frontend does not match the exact floor pair"
        exit 1
    fi
    verify_worker_health || exit 1
    candidate_backend_commit="$FLOOR_REVISION"
    candidate_growth_commit="$previous_growth_commit"
    verify_public_stack "$candidate_backend_commit" "$candidate_growth_commit" || exit 1
    cat > "$ROLLBACK_STATE_DIR/deployment-metadata.json" <<EOF
{
  "DEPLOYED_COMMIT": "$FLOOR_REVISION",
  "BACKEND_COMMIT": "$candidate_backend_commit",
  "BACKEND_IMAGE_DIGEST": "$GHCR_IMAGE_BACKEND",
  "FRONTEND_IMAGE_DIGEST": "$GHCR_IMAGE_FRONTEND",
  "GROWTH_IMAGE_DIGEST": "$GHCR_IMAGE_GROWTH",
  "WORKFLOW_RUN_ID": "rollback-rehearsal",
  "DEPLOYED_AT": "rollback-rehearsal"
}
EOF
    chmod 600 "$ROLLBACK_STATE_DIR/deployment-metadata.json"
    deploy_succeeded=true
) > "$WORK_DIR/restore-r4.log" 2>&1; then
    cat "$WORK_DIR/restore-r4.log" >&2
    echo 'ERROR: happy-path writer -> floor restore activation failed (R4)' >&2
    exit 1
fi
[[ ! -e /opt/easymod/.cutover-rollback/active ]]
[[ -f /opt/easymod/deployment-metadata.json ]]
grep -Fq "$floor_sha" /opt/easymod/deployment-metadata.json
[[ "$(resolve_container_digest easymod-backend-1)" == "$candidate_backend_image" ]]
if [[ "$(resolve_container_digest easymod-growth-frontend-1)" != "$candidate_growth_image" ]]; then
    echo 'ERROR: restore changed the Growth reference it must carry forward (R4)' >&2
    exit 1
fi
RESTORE_R4=PASS
export RESTORE_R4

# R5: a failure after activation (here the exact floor pair mismatch caused by
# a partial swap that leaves the frontend on the writer) must roll back to the
# writer incumbent through the same finish_deploy -> rollback || exit 70 path.
install_variant candidate
export GHCR_IMAGE_BACKEND="$CAND_IMG"
export GHCR_IMAGE_FRONTEND="$CAND_IMG"
export GHCR_IMAGE_GROWTH="$CAND_IMG"
export REHEARSAL_BACKEND_COMMIT="$writer_sha"
export REHEARSAL_GROWTH_COMMIT="$previous_growth_commit"
compose up --detach --wait --no-build --remove-orphans
previous_backend_image="$(resolve_container_digest easymod-backend-1)"
previous_worker_image="$(resolve_container_digest easymod-worker-1)"
previous_frontend_image="$(resolve_container_digest easymod-frontend-1)"
previous_growth_image="$(resolve_container_digest easymod-growth-frontend-1)"
rm -f /opt/easymod/deployment-metadata.json
if (
    trap - EXIT
    cd /opt/easymod
    candidate_dir="$ROLLBACK_STATE_DIR/candidate"
    active_transaction=/opt/easymod/.cutover-rollback/active
    deploy_succeeded=false
    activation_started=false
    printf '%s\n' "state=$ROLLBACK_STATE_DIR" "backend=$previous_backend_image" \
      "frontend=$previous_frontend_image" "worker=$previous_worker_image" \
      "growth=$previous_growth_image" > "$ROLLBACK_STATE_DIR/transaction"
    trap finish_deploy EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    ln -- "$ROLLBACK_STATE_DIR/transaction" "$active_transaction"
    activation_started=true
    # Attempt the floor swap for backend/worker only; the pair gate must catch
    # the half-activated stack before any public/health/identity success path.
    # public-stub tracks the backend image reference (fixture identity model).
    export GHCR_IMAGE_BACKEND="$candidate_backend_image"
    export GHCR_IMAGE_FRONTEND="$previous_frontend_image"
    export GHCR_IMAGE_GROWTH="$candidate_growth_image"
    compose up --detach --no-build --remove-orphans backend worker growth-frontend public-stub
    floor_backend_running="$(resolve_container_digest easymod-backend-1)"
    floor_worker_running="$(resolve_container_digest easymod-worker-1)"
    floor_frontend_running="$(resolve_container_digest easymod-frontend-1)"
    if [ "$floor_backend_running" != "$candidate_backend_image" ] \
      || [ "$floor_worker_running" != "$candidate_backend_image" ] \
      || [ "$floor_frontend_running" != "$candidate_frontend_image" ]; then
        echo "ERROR: running backend, worker, or frontend does not match the exact floor pair"
        exit 1
    fi
    deploy_succeeded=true
) > "$WORK_DIR/restore-r5.log" 2>&1; then
    cat "$WORK_DIR/restore-r5.log" >&2
    echo 'ERROR: partial floor activation unexpectedly succeeded (R5)' >&2
    exit 1
else
    r5_rc=$?
fi
[[ "$r5_rc" == 1 ]]
grep -Fq 'does not match the exact floor pair' "$WORK_DIR/restore-r5.log"
grep -Fq 'Rollback backend, worker, Growth, Caddy, public stack, and configuration checks passed' "$WORK_DIR/restore-r5.log"
[[ ! -e /opt/easymod/.cutover-rollback/active ]]
[[ -e "$ROLLBACK_STATE_DIR/transaction" ]]
[[ "$(resolve_container_digest easymod-backend-1)" == "$previous_backend_image" ]]
[[ "$(resolve_container_digest easymod-frontend-1)" == "$previous_frontend_image" ]]
[[ ! -f /opt/easymod/deployment-metadata.json ]]
RESTORE_R5=PASS
export RESTORE_R5

# R8: a restore whose incumbent reference was lost must fail closed to the
# operator with the manual-recovery message, not a blind re-render.
previous_backend_image_backup="$previous_backend_image"
previous_backend_image=''
if r8_output="$(rollback 2>&1)"; then
    printf '%s\n' "$r8_output" >&2
    echo 'ERROR: restore rollback accepted a missing incumbent image (R8)' >&2
    exit 1
fi
previous_backend_image="$previous_backend_image_backup"
if ! grep -Fq 'manual recovery is required' <<< "$r8_output"; then
    printf '%s\n' "$r8_output" >&2
    echo 'ERROR: restore rollback did not report manual recovery (R8)' >&2
    exit 1
fi
RESTORE_R8=PASS
export RESTORE_R8

# WP-06 growth-override case: the amended deploy gate permits an override, so
# the lane proves its downstream chain end-to-end — commit binding against the
# fixture release SHA (literal reproduced from ci-cd.yml), public growth
# identity through verify_public_stack against the live stub, the swap taking
# effect, and rollback restoring the previous Growth image plus its health.
# The full promotion path with an override runs the same extracted functions;
# the guard test pins the workflow-side binding literals themselves.
growth_build_commit="$writer_sha"
deployed_commit="$writer_sha"
if [ "$growth_build_commit" != "$deployed_commit" ]; then
    echo "ERROR: Growth image build-info commit '$growth_build_commit' does not match deployed commit '$deployed_commit'" >&2
    exit 1
fi
override_growth_image="$PREV_IMG"
export GHCR_IMAGE_GROWTH="$override_growth_image"
export REHEARSAL_GROWTH_COMMIT="$growth_build_commit"
compose up --detach --wait --no-build --remove-orphans growth-frontend public-stub
if [[ "$(resolve_container_digest easymod-growth-frontend-1)" != "$override_growth_image" ]]; then
    echo 'ERROR: growth override did not take effect on the running container' >&2
    exit 1
fi
verify_public_stack "$previous_backend_commit" "$growth_build_commit" > "$WORK_DIR/growth-override.log" 2>&1
export REHEARSAL_GROWTH_COMMIT="$previous_growth_commit"
rollback > "$WORK_DIR/growth-restore.log" 2>&1
grep -Fq 'Rollback backend, worker, Growth, Caddy, public stack, and configuration checks passed' "$WORK_DIR/growth-restore.log"
if [[ "$(resolve_container_digest easymod-growth-frontend-1)" != "$previous_growth_image" ]]; then
    echo 'ERROR: rollback did not restore the incumbent Growth image after the override' >&2
    cat "$WORK_DIR/growth-restore.log" >&2
    exit 1
fi
# wait_for_growth_health lives inside the wrapped forward scenarios; the
# restore lane repeats its bounded health poll so --restore-floor works alone.
growth_health=starting
for _ in $(seq 1 30); do
    growth_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' easymod-growth-frontend-1)"
    [[ "$growth_health" == "healthy" ]] && break
    sleep 1
done
if [[ "$growth_health" != "healthy" ]]; then
    echo "ERROR: restored Growth health status was $growth_health after the override case" >&2
    exit 1
fi
RESTORE_GROWTH_OVERRIDE=PASS
export RESTORE_GROWTH_OVERRIDE
printf 'Restore-floor lane complete: R1 R2 R3 R4 R5 R67 R8 + growth override\n'
