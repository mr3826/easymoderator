# OCI Gate 2 Runbook — ORACLE_FREE_INFRASTRUCTURE_READY

Step-by-step execution once the A1 instance exists and reaches `RUNNING`.
The Lead executes this; this document is instructions only and performs no
cloud mutation itself. Commands use `<...>` placeholders — substitute the
concrete OCID/IP and never paste secret values into logs.

**Inputs**

- `OCI_INSTANCE_OCID` — the `VM.Standard.A1.Flex` instance OCID.
- `OCI_IP` — public IP (captured in step 2).
- `~/.ssh/easymod_oci_deploy` — private key (`.pub` counterpart already
  installed at instance launch).
- Repo checkout at the deploy commit (compose file + `scripts/oci/*`).

**Design reference:** `docs/infrastructure/OCI_MIGRATION_DESIGN.md`.

---

## Step 1 — Confirm the instance is RUNNING and is the right shape

```bash
oci compute instance get --instance-id "$OCI_INSTANCE_OCID" \
  --query 'data.{state:"lifecycle-state",shape:shape,ocpus:"shape-config".ocpus,mem:"shape-config".memory-in-gbs}' \
  --output table
```

Expect `state=RUNNING`, `shape=VM.Standard.A1.Flex`, `ocpus=2`,
`mem=12` (the proven Always-Free continuous spec, V2 D1). If the instance is
still in the capacity-retry loop, stop here.

**Evidence:** the table output (instance OCID, state, shape, OCPU, memory).

## Step 2 — Capture the public IP

```bash
OCI_IP="$(oci compute instance list-vnics --instance-id "$OCI_INSTANCE_OCID" \
  --query 'data[0]."public-ip"' --raw-output)"
echo "$OCI_IP"
```

Note: the public IP is **ephemeral**. An in-VM `reboot` (step 6) preserves it;
stopping and starting the instance from OCI may reassign it. Do not stop/start
between steps.

**Evidence:** the IP, and later the matching `DEPLOY_HOST` value.

## Step 3 — Bootstrap the host

```bash
ssh -i ~/.ssh/easymod_oci_deploy -o StrictHostKeyChecking=accept-new \
    "ubuntu@$OCI_IP" 'sudo -n bash -s' < scripts/oci/oci-host-bootstrap.sh
```

The Ubuntu image's login user is `ubuntu` with passwordless sudo — not
`root`/`opc`. Expect the final line:

```
OCI_HOST_BOOTSTRAP_DONE=1 arch=aarch64 path=/opt/easymod
```

If `arch` reports anything other than `aarch64`/`arm64`, stop — the image is
wrong.

**Evidence:** captured bootstrap output including `Docker architecture` and the
`OCI_HOST_BOOTSTRAP_DONE=1` marker.

## Step 4 — Copy compose and prove image pulls / arm64

```bash
scp -i ~/.ssh/easymod_oci_deploy docker-compose.prod.yml \
    "ubuntu@$OCI_IP:/tmp/docker-compose.prod.yml"
ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" \
    'sudo -n install -m 644 /tmp/docker-compose.prod.yml /opt/easymod/docker-compose.prod.yml'

ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" 'sudo -n bash -s' \
    < scripts/oci/oci-image-pull-check.sh
```

Expect four `ARM64_OK <image>` lines and:

```
OCI_IMAGE_PULL_CHECK_DONE=1 count=4
```

The script reads the exact `caddy`/`postgres`/`redis`/`qdrant` digests from the
compose file — record those digest strings as evidence.

**Evidence:** the pull-check output (all `ARM64_OK`, final marker) and the four
digests.

## Step 5 — Verify the host firewall

```bash
ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" 'sudo -n ufw status verbose'
```

Expect: default deny (incoming), default allow (outgoing), and rules for
`22/tcp`, `80/tcp`, `443/tcp`, `443/udp` only. **No `3000`.** Also confirm the
outer OCI security list / NSG allows only 22 (source-restricted), 80, 443 tcp
+ 443 udp:

```bash
oci network security-list get --security-list-id <SECURITY_LIST_OCID> \
  --query 'data."ingress-security-rules"[].{proto:protocol,src:"source",ports:"tcp-options"."destination-port-range",udp:"udp-options"."destination-port-range"}' \
  --output table
```

**Evidence:** `ufw status verbose` output + the security-list ingress table.
Confirm port 22's source is a restricted CIDR, not `0.0.0.0/0`.

> **Execution deviation (2026-11-13) — FOUNDER-ACCEPTED, option (a):** the live
> security list allows 22/tcp from `0.0.0.0/0`. The approved deploy contract
> SSHes from GitHub-hosted runners whose egress IPs are dynamic, so a fixed
> admin CIDR would break every deploy. Compensating controls verified on the
> host: key-only sshd (`PasswordAuthentication no`, `PermitRootLogin
> without-password`, `KbdInteractiveAuthentication no`), ufw inner firewall,
> OCI list limited to 22/80/443 tcp + 443 udp. Same posture as the current DO
> production host. Recorded as a deviation — this acceptance row is **not**
> silently passed. **Founder decision 2026-11-13: option (a) accepted; the
> key-only posture is the approved production stance. Deviation CLOSED.**

## Step 6 — Reboot recovery test (in-VM reboot)

The reboot is issued **inside the guest** so the ephemeral public IP is
preserved. Take the postgres digest from the compose file (the one the
pull-check already pulled) for the volume probe.

```bash
# 6a. Markers before reboot
ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" '
  set -e
  ts="$(date -u +%FT%TZ)"
  echo "gate2 $ts" | sudo -n tee /opt/easymod/.gate2-probe >/dev/null
  sudo -n docker volume create oci-gate2-probe >/dev/null
  sudo -n docker run --rm -v oci-gate2-probe:/probe \
    postgres@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a \
    sh -c "date -u +%FT%TZ > /probe/marker"
  cat /opt/easymod/.gate2-probe
'
```

```bash
# 6b. Reboot (SSH drops; ignore the disconnect)
ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" 'sudo -n systemctl reboot' || true
```

```bash
# 6c. Wait for the host to come back (re-probe after ~60-90 s)
until ssh -i ~/.ssh/easymod_oci_deploy -o ConnectTimeout=5 \
          -o StrictHostKeyChecking=accept-new "ubuntu@$OCI_IP" 'true' 2>/dev/null; do
  sleep 5
done
echo "host is back"
```

```bash
# 6d. Prove persistence + Docker health after reboot
ssh -i ~/.ssh/easymod_oci_deploy "ubuntu@$OCI_IP" '
  set -e
  echo "--- boot dir marker ---"; cat /opt/easymod/.gate2-probe
  echo "--- probe volume ---";    sudo -n docker volume ls | grep oci-gate2-probe
  sudo -n docker run --rm -v oci-gate2-probe:/probe \
    postgres@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a \
    sh -c "cat /probe/marker"
  echo "--- docker arch ---"; sudo -n docker info --format "{{.Architecture}}"
  sudo -n docker compose version
'
```

Expect the same `/opt/easymod/.gate2-probe` timestamp, the named volume still
present with its marker intact, and Docker reporting `aarch64`/`arm64`.

> At Gate 2 the application stack is **not yet deployed**, so the real
> `postgres_data` / `redis_data` / `qdrant_data` / `caddy_data` volumes do not
> exist. This probe volume proves the Docker volume store on the boot volume
> survives a reboot. The stack's named volumes are re-proven after the first
> deploy; see step 7.

**Evidence:** pre-reboot marker line, post-reboot marker line (same value),
`docker volume ls` line, and post-reboot arch.

## Step 7 — Static check: data services never publish ports

On the workstation (no env needed for this static assertion):

```bash
awk '/^  [a-zA-Z0-9_-]+:/{s=$1} /^    ports:/{print s, "publishes host ports"}' \
  docker-compose.prod.yml
```

Expect exactly one line: `caddy:` (and nothing for `postgres`, `redis`,
`qdrant`, `backend`, `frontend`, `growth-frontend`, `worker`). After the first
real deploy, confirm with `docker ps --format '{{.Names}} {{.Ports}}'` that only
`easymod-caddy-1` shows published ports.

**Evidence:** the awk output (only `caddy:`), and post-deploy `docker ps`
port column.

---

## Gate 2 acceptance evidence map

Record the following in the gate acceptance record (redact secrets; no private
keys, no `~/.oci/config` contents):

| Required acceptance item | Proof to record |
| --- | --- |
| Entitlement proven | Pre-done: home region `ap-mumbai-1`, 41 A1 cores / 277 GB available, greenfield tenancy (cite the limits output date). |
| A1 allocated | Step 1 output: OCID, `lifecycle-state=RUNNING`, `VM.Standard.A1.Flex`, 2 OCPU / 12 GB. |
| Every resource provably Always Free | A1 2 OCPU / 12 GB continuous (V2 D1: 1,460 OCPU-h ≤ 1,500; 8,760 GB-h ≤ 9,000); boot volume ≤ 200 GB (`oci bv boot-volume get --boot-volume-id <ID>` → `size-in-gbs`); VCN free; ephemeral public IP; Object Storage ≤ 20 GB (confirm bucket usage at provisioning). |
| NSG/security list: only 22 (restricted), 80, 443 tcp+udp | Step 5: security-list ingress table (22 source is a restricted CIDR) + `ufw status verbose`. |
| Redis/Postgres/Qdrant never published | Step 7 static awk output (only `caddy:`). |
| Persistent volumes | Step 6 probe volume survives reboot; re-confirm real named volumes after first deploy. |
| Reboot recovery proven | Step 6: identical marker before/after reboot, host returns, Docker arch intact. |
| Image pulls work | Step 4: four `ARM64_OK` lines + `OCI_IMAGE_PULL_CHECK_DONE=1 count=4` + digests. |

When every row is evidenced, mark **ORACLE_FREE_INFRASTRUCTURE_READY**.
Then proceed to secret rotation (design §1.2/§1.3) before the first OCI
deploy.

---

## Failure handling

- **Bootstrap arch assertion fails** → wrong image; stop and re-launch an
  aarch64 Ubuntu 24.04 image.
- **Pull-check `ARM64_FAIL` or `PULL_FAIL`** → the compose digest is not
  arm64-capable or the pull failed; do not deploy. Re-read the digest from
  `docker-compose.prod.yml` and verify the pinned manifest.
- **Host does not return after reboot** → use the OCI console serial/VNC
  console; do not stop/start from the console until you have recorded the
  current public IP (it may change).
- **ufw shows 3000 or a default-allow incoming** → re-run
  `scripts/oci/oci-host-bootstrap.sh` (idempotent) and re-verify.