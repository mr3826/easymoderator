# OCI host tooling (`scripts/oci/`)

Idempotent bootstrap and image-pull validation for the Oracle Cloud Always Free
ARM64 A1 instance that replaces the DigitalOcean droplet. These scripts are
**on-host** helpers; the GitHub Actions deploy path in `.github/workflows/` is
unchanged by this pack (workflow edits are handled separately by the Lead).

Target host: `VM.Standard.A1.Flex` 2 OCPU / 12 GB (proven Always-Free
continuous spec, V2 D1), Ubuntu 24.04 aarch64,
region `ap-mumbai-1`. Deployment root is `/opt/easymod` (the basename is part of
the container/network naming contract — see `OCI_MIGRATION_DESIGN.md`).

## Prerequisites (Gate 2)

- Instance lifecycle state is `RUNNING` and the public IP is captured.
- `~/.ssh/easymod_oci_deploy` (private) / `.pub` exist locally.
- OCI security list / NSG allows only 22 (source-restricted), 80, 443 tcp and
  443 udp ingress; all egress.

## 1. Bootstrap the host

Streamed over SSH, with `bash -s` reading the script from stdin:

```bash
ssh -i ~/.ssh/easymod_oci_deploy ubuntu@<OCI_IP> 'sudo -n bash -s' \
    < scripts/oci/oci-host-bootstrap.sh
```

Installs Docker Engine + compose plugin v2, host tools (`jq`, GNU `timeout`,
`openssl`, `tar`, `awk`/`sed`), sets `/etc/docker/daemon.json` log rotation to
`json-file` 10m x5 (matching the compose stack), opens ufw 22/80/443 tcp and
443 udp — **not** 3000 — and creates `/opt/easymod`. It ends with an
`aarch64`/`arm64` Docker architecture assertion and prints
`OCI_HOST_BOOTSTRAP_DONE=1`. The script is safe to re-run.

## 2. Prove the images pull and are arm64

Copy the compose file to the host first, then run the check:

```bash
scp -i ~/.ssh/easymod_oci_deploy docker-compose.prod.yml \
    ubuntu@<OCI_IP>:/tmp/docker-compose.prod.yml
ssh -i ~/.ssh/easymod_oci_deploy ubuntu@<OCI_IP> \
    'sudo -n install -m 644 /tmp/docker-compose.prod.yml /opt/easymod/docker-compose.prod.yml'

ssh -i ~/.ssh/easymod_oci_deploy ubuntu@<OCI_IP> 'sudo -n bash -s' \
    < scripts/oci/oci-image-pull-check.sh
```

The script reads the exact `caddy`/`postgres`/`redis`/`qdrant` digests from the
compose `image:` lines (no hardcoded digests), pulls each, and asserts the
manifest / local image architecture is `arm64`. Success prints
`OCI_IMAGE_PULL_CHECK_DONE=1 count=4`; any non-arm64 or failed pull exits
non-zero.

Optional argument: pass a compose path if it is not at the default location,
e.g. `... 'bash -s' -- ./docker-compose.prod.yml < scripts/oci/oci-image-pull-check.sh`.

## Registry credentials

`caddy`, `postgres`, `redis` and `qdrant` are public Docker Hub images and need
no login. GHCR login for the application images (backend/frontend/growth)
**stays ephemeral-per-run** exactly as it is today: `ci-cd.yml` forwards the
run-scoped `GITHUB_TOKEN` to `docker login ghcr.io` immediately before pulling,
and no persistent registry credentials are stored on the host. Do not add a
long-lived `~/.docker/config.json` login on the new instance.

## Host keys and the `DO_SSH_KNOWN_HOSTS` secret

CI deploys through `appleboy/ssh-action`, which pins the **first line** of the
`DO_SSH_KNOWN_HOSTS` GitHub secret and whose Go SSH client offers **ECDSA
first**. If the first line is not the ECDSA host key, every deploy fails with
`host key fingerprint mismatch`. The secret name is kept from the DigitalOcean
era by design; its values are now the OCI host keys.

The host keys must therefore be listed in this exact order:

1. `ecdsa-sha2-nistp256`
2. `ed25519`
3. `ssh-rsa`

### Regenerate the block

```bash
# Git Bash / Linux runner
scripts/oci/generate-known-hosts.sh 130.210.21.100 ./known_hosts.txt

# Windows OpenSSH (PowerShell)
.\scripts\oci\generate-known-hosts.ps1 -TargetHost 130.210.21.100 -OutFile .\known_hosts.txt
```

Both scripts scan one key type at a time in the order above, refuse a first line
that is not `ecdsa-sha2-nistp256`, and print the `ssh-keygen -lf -E sha256`
fingerprint of the first line.

### Update the secret

```bash
gh secret set DO_SSH_KNOWN_HOSTS --repo mr3826/easymoderator < ./known_hosts.txt
```

The value never passes through a shell variable or a command-line argument.

### Receipt

- Host: `130.210.21.100` (`easymod-oci-prod-a1`, OCI `ap-mumbai-1`)
- ECDSA fingerprint: `SHA256:s68VTR/KVo5rQvBhVPaPf24Nb9ieSqbmy4mMtloi3zY`
- `DO_SSH_KNOWN_HOSTS` last updated: `2026-11-13T02:41:07Z`, during the Gate-4
  cutover, in the required ECDSA → ed25519 → RSA order.
- Failed runs before the ordering fix: `43349876742`, `43352077829`. Both failed
  with a host-key mismatch; the reordered secret resolved them.

`setup-easymod-recovery-ssh.ps1` must **never** be pointed at the destroyed
DigitalOcean droplet `139.59.249.141`. It now requires a mandatory
`-ProductionHost` argument and refuses that address.

## Related documents

- `docs/infrastructure/OCI_MIGRATION_DESIGN.md` — porting design + decisions.
- `docs/infrastructure/OCI_GATE2_RUNBOOK.md` — step-by-step Gate 2 execution
  and acceptance evidence.