#!/usr/bin/env bash
# oci-image-pull-check.sh
# On-host proof that the four digest-pinned base images used by the production
# stack pull on the A1 ARM64 instance and resolve to an arm64 manifest.
#
# Run on the OCI host after oci-host-bootstrap.sh, with the compose file
# present (Gate 2 copies it first; see docs/infrastructure/OCI_GATE2_RUNBOOK.md):
#
#   scp docker-compose.prod.yml ubuntu@<OCI_IP>:/tmp/docker-compose.prod.yml
#   ssh -i ~/.ssh/easymod_oci_deploy ubuntu@<OCI_IP> \
#       'sudo -n install -m 644 /tmp/docker-compose.prod.yml /opt/easymod/docker-compose.prod.yml'
#   ssh -i ~/.ssh/easymod_oci_deploy ubuntu@<OCI_IP> 'sudo -n bash -s' \
#       < scripts/oci/oci-image-pull-check.sh
#
# The four images are read directly from the compose file's `image:` lines
# (caddy/postgres/redis/qdrant). They are Docker Hub public images, so no GHCR
# credentials are needed — GHCR login in ci-cd.yml stays ephemeral-per-run for
# the application images only.

set -euo pipefail

COMPOSE_PATH="${1:-/opt/easymod/docker-compose.prod.yml}"

if [[ ! -f "$COMPOSE_PATH" ]]; then
    echo "ERROR: compose file not found: $COMPOSE_PATH" >&2
    echo "       pass the path as arg 1, e.g. $0 ./docker-compose.prod.yml" >&2
    exit 1
fi

echo "=== EasyMod OCI image pull check ==="
echo "Compose: $COMPOSE_PATH"

# Extract the digest-pinned base images for the four services that must run on
# the host itself (caddy, postgres, redis, qdrant). Application images are
# parameterised as ${GHCR_IMAGE_*} and are out of scope for Gate 2.
mapfile -t IMAGES < <(
    sed -nE 's/^[[:space:]]*image:[[:space:]]*//p' "$COMPOSE_PATH" \
        | grep -E '^(caddy|postgres|redis|qdrant/qdrant)@sha256:[0-9a-fA-F]{64}$' \
        | sort -u
)

COUNT="${#IMAGES[@]}"
if [[ "$COUNT" -ne 4 ]]; then
    echo "ERROR: expected 4 digest-pinned base images, found $COUNT:" >&2
    printf '  %s\n' "${IMAGES[@]:-<none>}" >&2
    exit 1
fi

echo "Digests read from compose:"
printf '  %s\n' "${IMAGES[@]}"
echo ""

FAIL=0

for image in "${IMAGES[@]}"; do
    echo "── $image"

    if ! docker pull "$image"; then
        echo "PULL_FAIL $image"
        FAIL=1
        continue
    fi

    arch=""

    # Primary: inspect the manifest. A manifest-list digest exposes
    # manifests[].platform.architecture; a single-platform manifest may expose
    # a top-level architecture. Collect any arm64 occurrence.
    manifest_arch="$(docker manifest inspect "$image" 2>/dev/null \
        | grep -o '"architecture"[[:space:]]*:[[:space:]]*"arm64"' \
        | head -n1 || true)"
    if [[ -n "$manifest_arch" ]]; then
        arch="arm64"
    fi

    # Fallback: the locally pulled image's own architecture.
    if [[ -z "$arch" ]]; then
        arch="$(docker image inspect "$image" --format '{{.Architecture}}' 2>/dev/null || true)"
    fi

    if [[ "$arch" == "arm64" ]]; then
        echo "ARM64_OK $image"
    else
        echo "ARM64_FAIL $image (detected: ${arch:-unknown})"
        FAIL=1
    fi
    echo ""
done

if [[ "$FAIL" -ne 0 ]]; then
    echo "OCI_IMAGE_PULL_CHECK_FAILED=1"
    exit 1
fi

echo "OCI_IMAGE_PULL_CHECK_DONE=1 count=$COUNT"