#!/usr/bin/env bash
# oci-host-bootstrap.sh
# Idempotent first-boot bootstrap for the Oracle Cloud Always Free ARM64 A1
# instance that replaces the DigitalOcean droplet.
#
# Target: VM.Standard.A1.Flex (4 OCPU / 24 GB), Ubuntu 24.04 aarch64.
# Run as root over SSH, streamed from the repo:
#
#   ssh -i ~/.ssh/easymod_oci_deploy root@<OCI_IP> 'bash -s' \
#       < scripts/oci/oci-host-bootstrap.sh
#
# The script is safe to re-run: every step converges to the same state.
#
# What it intentionally does NOT do:
#   * open :3000 (the old do-server-setup.sh leaked the backend port; the
#     compose stack reaches backend/frontend over the internal bridge only)
#   * configure swap (the A1 has 24 GB RAM vs the droplet's 4 GB; not needed)
#   * clone the repo or place secrets (ci-cd.yml owns those steps)
#   * log in to GHCR (login stays ephemeral-per-run in ci-cd.yml)

set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: run as root" >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "=== EasyMod OCI host bootstrap (Ubuntu 24.04 aarch64) ==="

# ── 1. System update + host tools the deploy path depends on ─────────────────
echo "[1/7] Updating packages and installing host tools..."
apt-get update -q
apt-get upgrade -y -q
# jq               — compose/daemon.json + workflow probes
# coreutils        — GNU `timeout` used by deploy/health scripts
# openssl          — backup encryption (backup.yml)
# tar              — uploads backup/restore
# gawk + sed       — workflow string parsing
apt-get install -y -q \
    ca-certificates curl wget git \
    jq coreutils openssl tar gawk sed \
    ufw

# ── 2. Docker Engine + compose plugin v2 ─────────────────────────────────────
echo "[2/7] Installing Docker Engine + compose plugin v2..."
if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
fi
# The convenience script installs the plugin on current Ubuntu, but make the
# guarantee explicit and idempotent.
apt-get install -y -q docker-compose-plugin
systemctl enable docker
systemctl start docker
docker --version
docker compose version

# ── 3. Docker log rotation defaults (match compose json-file 10m x5) ─────────
echo "[3/7] Configuring /etc/docker/daemon.json log rotation..."
DAEMON_JSON=/etc/docker/daemon.json
DESIRED_LOG_JSON='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}'
DOCKER_CHANGED=0
mkdir -p /etc/docker
if [[ -f "$DAEMON_JSON" ]]; then
    tmp="$(mktemp)"
    # Recursive merge preserves any operator-added keys (data-root, etc.).
    jq --argjson desired "$DESIRED_LOG_JSON" '. * $desired' "$DAEMON_JSON" > "$tmp"
    if ! cmp -s "$tmp" "$DAEMON_JSON"; then
        cp "$tmp" "$DAEMON_JSON"
        DOCKER_CHANGED=1
    fi
    rm -f "$tmp"
else
    printf '%s\n' "$DESIRED_LOG_JSON" | jq . > "$DAEMON_JSON"
    DOCKER_CHANGED=1
fi
chmod 644 "$DAEMON_JSON"
if [[ "$DOCKER_CHANGED" -eq 1 ]]; then
    systemctl restart docker
fi
docker info --format 'Log driver: {{.LoggingDriver}}' 2>/dev/null || true

# ── 4. Host firewall (ufw) ───────────────────────────────────────────────────
# OCI security list (22/80/443 tcp + 443 udp) is the outer perimeter; ufw is
# defence-in-depth and must agree. Port 3000 is deliberately absent.
echo "[4/7] Configuring ufw..."
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Caddy ACME + redirect)
ufw allow 443/tcp   # HTTPS
ufw allow 443/udp   # HTTP/3
# Remove a legacy :3000 rule if a re-run lands on an old droplet-style host.
ufw --force delete allow 3000/tcp >/dev/null 2>&1 || true
ufw --force enable
ufw status verbose

# ── 5. Deployment directory (exact path is part of the naming contract) ──────
# The compose project name derives from the /opt/easymod basename, producing
# the `easymod_internal` network and `easymod-<service>-1` container names
# hardcoded across ci-cd.yml, backup.yml, the seed/purge workflows and
# scripts/rollback-rehearsal.sh. Do not rename this directory.
echo "[5/7] Creating /opt/easymod..."
mkdir -p /opt/easymod
chmod 755 /opt/easymod

# ── 6. Swap note ─────────────────────────────────────────────────────────────
echo "[6/7] Swap: not configured by design (A1 24 GB RAM >> 4 GB droplet)."
echo "      If the kernel ever reports memory pressure, add a 2-4 GB swapfile"
echo "      rather than shrinking the stack."

# ── 7. Architecture assertion ────────────────────────────────────────────────
echo "[7/7] Asserting Docker architecture is aarch64/arm64..."
ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || true)"
case "$ARCH" in
    aarch64|arm64) ;;
    *)
        echo "ERROR: expected aarch64/arm64 Docker architecture, got '${ARCH:-unknown}'" >&2
        exit 1
        ;;
esac
echo "Docker architecture: $ARCH"

echo ""
echo "OCI_HOST_BOOTSTRAP_DONE=1 arch=$ARCH path=/opt/easymod"
echo "Next: copy docker-compose.prod.yml into /opt/easymod, then run"
echo "      scripts/oci/oci-image-pull-check.sh"