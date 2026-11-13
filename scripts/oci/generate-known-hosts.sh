#!/usr/bin/env bash
# generate-known-hosts.sh
#
# Generate the exact DO_SSH_KNOWN_HOSTS block used by appleboy/ssh-action for
# the OCI production host. The secret name is kept from the DigitalOcean era by
# design; the values are now OCI host keys.
#
# WHY THE ORDER MATTERS
#   appleboy/ssh-action pins the FIRST line of the DO_SSH_KNOWN_HOSTS secret and
#   its Go SSH client offers ECDSA first. A first line that is not the ECDSA key
#   makes every deploy fail with "host key fingerprint mismatch". The scan is
#   therefore performed one key type at a time and concatenated in this order:
#       ecdsa-sha2-nistp256, ed25519, ssh-rsa
#
# USAGE
#   scripts/oci/generate-known-hosts.sh [host] [output-file]
#   scripts/oci/generate-known-hosts.sh 130.210.21.100 ./known_hosts.txt
#
# Then update the secret without passing its value through a shell variable:
#   gh secret set DO_SSH_KNOWN_HOSTS --repo mr3826/easymoderator < ./known_hosts.txt
#
# Never point this at the destroyed DigitalOcean droplet 139.59.249.141.

set -euo pipefail

HOST="${1:-130.210.21.100}"
OUT_FILE="${2:-}"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

[ -n "$HOST" ] || fail "host argument is empty"
[ "$HOST" != "139.59.249.141" ] || fail "139.59.249.141 is the destroyed DigitalOcean droplet; use the OCI host 130.210.21.100"

command -v ssh-keyscan >/dev/null 2>&1 || fail "ssh-keyscan is not available"
command -v ssh-keygen >/dev/null 2>&1 || fail "ssh-keygen is not available"

scan_type() {
    local key_type="$1"
    ssh-keyscan -T 10 -t "$key_type" "$HOST" 2>/dev/null | tr -d '\r' || true
}

ECDSA_LINES="$(scan_type ecdsa | sed '/^[[:space:]]*$/d')"
ED25519_LINES="$(scan_type ed25519 | sed '/^[[:space:]]*$/d')"
RSA_LINES="$(scan_type rsa | sed '/^[[:space:]]*$/d')"

[ -n "$ECDSA_LINES" ] || fail "ssh-keyscan returned no ecdsa host key for $HOST"
[ -n "$ED25519_LINES" ] || fail "ssh-keyscan returned no ed25519 host key for $HOST"
[ -n "$RSA_LINES" ] || fail "ssh-keyscan returned no RSA host key for $HOST"

BLOCK="$ECDSA_LINES
$ED25519_LINES
$RSA_LINES"
FIRST_LINE="$(printf '%s\n' "$BLOCK" | head -n 1)"
FIRST_KEY_TYPE="$(printf '%s\n' "$FIRST_LINE" | awk '{print $2}')"

[ "$FIRST_KEY_TYPE" = "ecdsa-sha2-nistp256" ] || \
    fail "first emitted line key type is '$FIRST_KEY_TYPE', expected ecdsa-sha2-nistp256"

FINGERPRINT_FILE="$(mktemp)"
trap 'rm -f "$FINGERPRINT_FILE"' EXIT
printf '%s\n' "$FIRST_LINE" > "$FINGERPRINT_FILE"
FINGERPRINT="$(ssh-keygen -lf "$FINGERPRINT_FILE" -E sha256 | grep -oE 'SHA256:[A-Za-z0-9+/=]+' | head -n 1)"
[ -n "$FINGERPRINT" ] || fail "unable to compute the first-line SHA256 fingerprint"

echo "HOST=$HOST"
echo "FIRST_KEY_TYPE=$FIRST_KEY_TYPE"
echo "FIRST_KEY_FINGERPRINT=$FINGERPRINT"
echo ""
echo "----- BEGIN DO_SSH_KNOWN_HOSTS -----"
printf '%s\n' "$BLOCK"
echo "----- END DO_SSH_KNOWN_HOSTS -----"
echo ""

if [ -n "$OUT_FILE" ]; then
    umask 077
    printf '%s\n' "$BLOCK" > "$OUT_FILE"
    echo "WROTE=$OUT_FILE"
fi

echo "Update the GitHub secret with:"
echo "  gh secret set DO_SSH_KNOWN_HOSTS --repo mr3826/easymoderator < <file>"
echo "Then record the new fingerprint receipt in scripts/oci/README.md."
