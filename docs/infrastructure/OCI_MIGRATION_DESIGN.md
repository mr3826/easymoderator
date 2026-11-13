# OCI Migration — Porting Design

**Status:** design of record for the DigitalOcean → Oracle Cloud Always Free
ARM64 migration. Written from baseline commit `47f442ed` (main tip at time of
writing). This memo does **not** change any workflow; workflow edits are
serialized to the Lead and applied at later gates.

**Target:** `VM.Standard.A1.Flex` 2 OCPU / 12 GB (proven Always-Free
continuous spec, V2 D1), Ubuntu 24.04 aarch64, home region `ap-mumbai-1`.
VCN `10.0.0.0/16`, public subnet `10.0.0.0/24`.

**Source:** DigitalOcean droplet `s-2vcpu-4gb` x64, Ubuntu 24.04,
`139.59.249.141`, deploy root `/opt/easymod`.

---

## 1. Invariant decisions

These are non-negotiable for the port; breaking them silently breaks the
deploy, backup and rollback tooling.

### 1.1 Keep `/opt/easymod` as the deploy root

Docker Compose derives its **project name** from the directory basename. With
the repo checked out / compose file living at `/opt/easymod`, the stack
produces:

| Derived name | Value |
| --- | --- |
| Compose project | `easymod` |
| Network | `easymod_internal` |
| Containers | `easymod-backend-1`, `easymod-worker-1`, `easymod-frontend-1`, `easymod-growth-frontend-1`, `easymod-caddy-1`, `easymod-postgres-1`, `easymod-redis-1`, `easymod-qdrant-1` |

These literals are hardcoded across the deploy/ops surface, including:

- `.github/workflows/ci-cd.yml` — `/opt/easymod/*` paths, `easymod-backend-1`,
  `--network easymod_internal`, rollback state at
  `/opt/easymod/.cutover-rollback/`.
- `.github/workflows/backup.yml` — container-name image resolution and
  `/opt/easymod/backups`.
- `.github/workflows/qdrant-migration.yml`, `meta-canary-log-recovery.yml`,
  `mobile-production-proof.yml`, and the seed/purge/grant/backfill workflows.
- `scripts/rollback-rehearsal.sh` — hardcodes `container_name: easymod-*-1`
  fixtures and `STAGE_ROOT=/opt/easymod`.
- `EasyMod-backend/scripts/validate-rollback-contract.js` — greps
  `ci-cd.yml` for the literal `easymod-backend-1` and `/opt/easymod`.

**Decision:** create `/opt/easymod` verbatim on the A1 host
(`scripts/oci/oci-host-bootstrap.sh` does this) and never rename it. No
`COMPOSE_PROJECT_NAME` override is introduced.

### 1.2 Keep the secret *names*; rotate only the *values*

The deploy workflows consume three secret names:

- `DEPLOY_HOST` — canonical deployment host (IP/hostname)
- `DO_SSH_PRIVATE_KEY` — private key with root access
- `DO_SSH_KNOWN_HOSTS` — pinned host key line(s)

Verified at `47f442ed`: **12 workflow files** reference
`DEPLOY_HOST`/`DO_SSH_PRIVATE_KEY`, and the same 12 reference
`DO_SSH_KNOWN_HOSTS`. Renaming them (`DO_*` → `OCI_*`) would touch all 12 plus
`setup-easymod-recovery-ssh.ps1` and tests
(`EasyMod-backend/src/security/__tests__/workflow-deploy-guard.test.js`,
`scripts/__tests__/semantic-calibration.test.js`). That churn buys no
behavioural change.

**Decision:** keep the names exactly; at cutover, update the *values*:

- `DEPLOY_HOST` → new A1 public IP (or DNS name).
- `DO_SSH_PRIVATE_KEY` → contents of
  `~/.ssh/easymod_oci_deploy` (private key; never printed or committed).
- `DO_SSH_KNOWN_HOSTS` → a `known_hosts` line for the **new** host.

The name is now historically inaccurate (`DO_`) — that is accepted and
documented; it is a label, not a provider binding.

### 1.3 Known-hosts regeneration (must precede the first deploy)

`backup.yml` (and every other SSH workflow) derives a SHA-256 fingerprint from
`DO_SSH_KNOWN_HOSTS` and pins it via `appleboy/ssh-action`'s `fingerprint:`
input. The stored line must be keyed by the **new** `DEPLOY_HOST` value and
must match the host's live key, or the first deploy fails closed.

Agent-side regeneration (run only after Gate 2 instance is RUNNING; output is
the secret value — do not paste it into logs or this repo):

```bash
# 1. Capture the host key for the address that DEPLOY_HOST will hold.
ssh-keyscan -t ed25519 <OCI_IP> > /tmp/oci_known_hosts

# 2. Prove the pinned fingerprint exactly as the workflow derives it.
entry="$(ssh-keygen -F <OCI_IP> -f /tmp/oci_known_hosts | awk '!/^#/ {print; exit}')"
printf '%s %s\n' "$(printf '%s' "$entry" | awk '{print $2}')" \
                   "$(printf '%s' "$entry" | awk '{print $3}')" \
  | ssh-keygen -lf - -E sha256

# 3. Store the full line as DO_SSH_KNOWN_HOSTS.
```

Record the derived `SHA256:...` fingerprint as evidence; the host-key change
is expected (new machine), not a compromise indicator.

### 1.4 Stack composition and network exposure unchanged

`docker-compose.prod.yml` is not edited by this pack. Redis, PostgreSQL and
Qdrant already publish **no** ports and are reachable only on
`easymod_internal`; Caddy is the only service publishing host ports
(80/tcp, 443/tcp, 443/udp). Do not add `ports:` to the data services during
the port.

### 1.5 GHCR login stays ephemeral-per-run

`ci-cd.yml` forwards the run-scoped `GITHUB_TOKEN` over SSH and runs
`docker login ghcr.io` immediately before pulling application images. No
long-lived registry credential is written to the host. This behaviour is
preserved on OCI; `scripts/oci/oci-image-pull-check.sh` needs no credentials
because the four base images are public Docker Hub images.

---

## 2. DigitalOcean-gated pieces and their OCI replacements

Only `.github/workflows/backup.yml` calls the DigitalOcean API or assumes DO
Spaces semantics. `security-scan.yml` matched a case-insensitive grep only on
`npm audit` text — it has no DO dependency.

### 2.1 `DO_TOKEN` account probe (`backup.yml` lines 110–124)

Current behaviour: fail closed if `DO_TOKEN` is unset; then
`GET https://api.digitalocean.com/v2/account` must return HTTP 200, proving
the DO credential is live before any backup runs.

There is no `DO_TOKEN` equivalent on OCI and no reason to put OCI IAM
credentials on the GitHub runner.

**Replacement (design):** turn the credential probe into an **endpoint +
credential reachability probe** using the S3-compatible credentials the backup
path already needs. Before dumping, run a `HeadBucket` against the configured
bucket through the S3 endpoint:

```bash
aws s3api head-bucket --bucket "$BACKUP_BUCKET" --endpoint-url "$SPACES_ENDPOINT"
```

- Success proves: S3 credentials parse, the endpoint is reachable, and the
  bucket exists and is addressable with those credentials.
- Failure modes map to the same fail-closed contract
  (`RECOVERY_EXECUTION_PAUSED_FOR_CREDENTIAL`), with a redacted status only.
- Secret-name indirection is preserved: reuse `SPACES_ENDPOINT`,
  `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`, `BACKUP_BUCKET`; only
  their values change (see 2.2). No new secret name is introduced.
- `DO_TOKEN` is retired from the job's `env:`/`envs:` list by the Lead's later
  workflow edit; this memo defines the target, not the edit.

### 2.2 Spaces ACL + lifecycle audit (`backup.yml` lines 320–355)

Current behaviour: `s3api get-bucket-acl` must not expose
`AllUsers`/`AuthenticatedUsers`; `s3api get-bucket-lifecycle-configuration`
must show enabled `db/` and `uploads/` expiry rules equal to
`OFFSITE_RETENTION_DAYS`.

OCI Object Storage exposes an **S3-compatible API**, so the `aws-cli`
container keeps working with an endpoint swap:

```
https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
```

Concrete values for this tenancy/region:

- namespace: `bm1siqos8k1u`
- region: `ap-mumbai-1`
- endpoint: `https://bm1siqos8k1u.compat.objectstorage.ap-mumbai-1.oraclecloud.com`

Use the **`compat`** hostname. The non-compat hostname
(`https://bm1siqos8k1u.objectstorage.ap-mumbai-1.oraclecloud.com`) does **not**
resolve for S3 requests in this tenancy.

Mark namespace/region as **placeholders** in any template so a different
tenancy/region can substitute them; do not hardcode the concrete endpoint into
shared workflow text without that note.

Important compatibility limits (design-level):

- **ACL check:** OCI Object Storage buckets are private by default and use
  IAM/bucket policies rather than the S3 ACL grant model. `get-bucket-acl` is
  not a reliable privacy proof on OCI. Replace the ACL assertion with an
  OCI-native check: confirm the bucket is not public and, where scoped sharing
  is needed, use **pre-authenticated requests** (PARs) with explicit expiry
  and object-prefix scope instead of object/bucket ACL grants. A PAR is
  time-boxed and revocable; it is the OCI analogue of a scoped signed URL, not
  of a public bucket ACL.
- **Lifecycle:** OCI lifecycle management is configured through
  `oci os object-lifecycle-policy` (OCI CLI / OCI API), not the S3
  `put-bucket-lifecycle-configuration` path. The retention proof becomes:
  read the bucket's object lifecycle policy and assert an enabled rule for
  `db/` and `uploads/` with the expected day count.
- **The encrypted-upload / readback / decrypt / restore-list path is
  unchanged.** It is S3-cp based and works against the OCI endpoint as-is.

**Bucket names:** do not invent any. Continue to address the bucket only
through the existing `BACKUP_BUCKET` secret-name indirection; the actual bucket
is provisioned out-of-band and never named in this repo.

**Credential mapping:** OCI S3-compatible credentials are **Customer Secret
Keys** (access key + secret). They populate the existing
`SPACES_ACCESS_KEY_ID` / `SPACES_SECRET_ACCESS_KEY` names at cutover. A future
rename to `OCI_*` is optional cleanup, out of scope here.

### 2.3 Work items deferred to the Lead (not done in this pack)

1. `backup.yml`: remove `DO_TOKEN` from `env:`/`envs:`; replace the account
   probe (2.1); replace ACL/lifecycle audit (2.2). Keep secret names.
2. Provision the bucket + lifecycle policy + private posture on OCI.
3. Rotate `SPACES_ENDPOINT` (→ OCI endpoint), `SPACES_ACCESS_KEY_ID`,
   `SPACES_SECRET_ACCESS_KEY`, `BACKUP_BUCKET` values; preserve
   `BACKUP_ENCRYPTION_KEY` (losing it makes archives unrecoverable).
4. Cutover secret rotation (1.2/1.3) before the first OCI deploy.

---

## 3. `setup-easymod-recovery-ssh.ps1` host assertion (design only)

Line 53 currently hardcodes:

```powershell
$script:ProductionHost = '139.59.249.141'
```

Change (design, not applied here):

- Replace the literal with a value resolved from an explicit parameter or the
  canonical `DEPLOY_HOST` setting, with `139.59.249.141` removed as the
  default.
- Add a **fail-closed assertion**: abort with a blocker if
  `ProductionHost` is empty, does not resolve, or still equals the legacy
  droplet IP after cutover. This prevents a recovery-ssh key install from
  silently targeting the retired droplet.
- The existing `KnownHostsPath`/fingerprint assertions continue to operate on
  the resolved host; regenerate that file for the new host in the same step
  as §1.3.
- `$script:ProductionPath = '/opt/easymod'` and `ProductionUser = 'root'` stay
  unchanged (§1.1).

---

## 4. Host firewall posture

Two layers, both required:

1. **OCI security list / NSG (outer):** ingress only 22/tcp, 80/tcp, 443/tcp,
   443/udp; all egress. This already exists. **Live check 2026-11-13: 22/tcp
   source is `0.0.0.0/0`, not a restricted admin CIDR.** The approved deploy
   contract SSHes from GitHub-hosted runners with dynamic egress IPs, so a
   fixed admin CIDR would break every deploy. Compensating controls: key-only
   sshd + ufw + the 22/80/443-only list (same posture as current DO prod).
   Recorded as a deviation pending founder decision — see runbook step 5.
2. **ufw (inner, `scripts/oci/oci-host-bootstrap.sh`):** default deny
   incoming, allow outgoing; allow 22/tcp, 80/tcp, 443/tcp, 443/udp.

**Port 3000 is explicitly not opened.** The legacy
`EasyMod-backend/scripts/do-server-setup.sh` opened `ufw allow 3000/tcp`; that
leak is *not* reproduced. Backend (3000), frontend/growth (8080),
PostgreSQL (5432), Redis (6379) and Qdrant (6333) are reachable only on the
Docker `easymod_internal` bridge.

---

## 5. `PAYMENT_GATEWAY_IP_ALLOWLIST` dead-path decision record

Declared and parsed, but never enforced on a route:

| Location | State |
| --- | --- |
| `.env.prod.example:102` | `PAYMENT_GATEWAY_IP_ALLOWLIST=` declared |
| `EasyMod-backend/src/config/config.js:89` | parsed into `paymentGatewayIpAllowlist` |
| `EasyMod-backend/src/middleware/payment-callback-auth.middleware.js` | middleware implemented (and unit-tested) |
| `EasyMod-backend/src/modules/payment/payment.routes.js:32-37` | collected into `paymentCallbackAuth` array |
| same file, routes | **the array is never attached to any route; no callback routes are defined in this router** |

The middleware exists and is tested, but the composed `paymentCallbackAuth`
guard is dead code in production: no route references it. Setting the env var
today changes nothing at runtime.

**Options**

- **Wire + render:** add the callback routes and attach `paymentCallbackAuth`,
  and render the DO egress IP / gateway CIDR into `.env.prod`. Correct, but
  it changes request-routing and callback behaviour during a migration.
- **Delete:** remove the env var, config field, middleware and tests. Clean,
  but drops tested security scaffolding that may be needed when callbacks
  are actually implemented.

**Decision:** leave the code untouched during the migration. This is a
pre-existing dead path, unrelated to the host port; touching it expands the
migration blast radius for no infrastructure benefit. Record it here and open
a separate follow-up to either wire-and-document the expected gateway CIDRs or
delete the dead guard. Do **not** copy an allowlist value into OCI `.env.prod`
under the assumption it is enforced.

---

## 6. Rollback anchor — keep the DO droplet stopped, not destroyed

Mirror plan **R5**. After the OCI cutover is accepted:

- **Stop**, do not destroy, the DigitalOcean droplet. Leave
  `/opt/easymod`, its named volumes and its last local backups intact.
- Do not rotate away the DO SSH key or destroy DO resources until the OCI
  **restore rehearsal proves off-host backups**: a backup produced on OCI is
  uploaded to OCI Object Storage, read back, decrypted, integrity-checked and
  restore-listed (the existing readback path in `backup.yml`).
- Only after that rehearsal passes does the droplet become eligible for
  destruction in a separate, explicit step with its own approval.
- Keep the DO droplet's firewall closed and the old DNS/TLS entry as the
  documented fallback until the OCI stack has served traffic successfully.

This gives a real reverse path: if OCI fails before off-host backups are
proven, the droplet is restarted and DNS is pointed back.

---

## 7. Explicit non-goals

- **No Kubernetes.** The stack stays a single-host compose deployment.
- **No paid OCI shapes.** Only Always Free eligible resources: A1 2 OCPU /
  12 GB continuous (V2 D1 — the 4/24 eligibility cap exceeds the 1,500 OCPU-h
  / 9,000 GB-h monthly free allowance for 24/7 use), one boot volume ≤ 200 GB,
  free VCN, ephemeral public IP, Object Storage ≤ 20 GB. Anything that would
  incur charges is out of scope.
- **No ML sidecars on the new host.** `banglish-bert` and `clip-similarity`
  are not deployed: their `torch` + CPU wheel set has no aarch64 wheels, so
  they cannot run on the ARM64 A1 without an unsupported build. Keep them off
  the A1; treat any future need as a separate decision.

---

## 8. Coupling summary (why "port" is mostly a host swap)

- Application images are already immutable `@sha256:` references and the four
  base images (`caddy`, `postgres`, `redis`, `qdrant`) are digest-pinned.
- The deploy path is SSH + `scp`; it does not care which cloud the host is on
  once `DEPLOY_HOST`/keys/known-hosts point at the new machine.
- Therefore the minimal correct port is: new host prepared to the same
  contract (`/opt/easymod`, Docker, ufw), secrets re-pointed (names kept),
  and the DO-only backup probe/audit rewritten. Everything else rides
  unchanged.

---

## Post-cutover status (2026-11-14)

Gate 4 is complete and this memo's target is now the live production host.

- **Gate 4 — complete.** Protected cutover deploy `43353881466`
  (`workflow_dispatch`, success 2026-11-13T02:48:55Z) put main `90e66d65` on
  `130.210.21.100`. `/api/version` matches the SHA, 72 migrations are applied
  (latest `20261103_001_courier_collection_recon_state`), `/health/ready` is 200,
  and the five host certificates were issued by Let's Encrypt during the cutover.
- **Droplet destroyed 2026-11-13 (~10:27 UTC).** This crossed §6's
  "stop, do not destroy" precondition. The founder waived it explicitly because the
  product is pre-launch with no real merchants (DO-era data declared moot) and the
  OCI restore drill had passed (run `43397427527`). The droplet list was verified
  empty afterwards and OCI health was re-verified. Every rollback path that mentions
  the DO droplet is void; rollback is redeploy-from-GHCR to the OCI host.
- **§2.3 items 1–3 are IMPLEMENTED in this PR.**
  1. `backup.yml` is repointed to OCI Object Storage. The `DO_TOKEN` account probe is
     replaced by a `head-bucket` probe against the configured bucket through the
     S3-compatible endpoint.
  2. Privacy is proven OCI-natively via the bucket's `public_access_type`
     (`NoPublicAccess`) instead of the unreliable S3 ACL check.
  3. Lifecycle compliance is proven through the restricted read-only audit identity
     `easymod-backup-audit` using `oci-python-sdk` `GetObjectLifecyclePolicy` and
     `GetBucket`. The S3 endpoint is
     `https://bm1siqos8k1u.compat.objectstorage.ap-mumbai-1.oraclecloud.com`; the
     bucket is `easymod-backups-prod`, with a 30-day DELETE lifecycle on the `db/`
     and `uploads/` prefixes.
- **Boot-volume backup policy assigned.** `easymod-prod-boot-gold` on boot volume
  `ocid1.bootvolume.oc1.ap-mumbai-1.abrg6ljrxr3a7t5iaa6uzes2oepoh6vqojlwthwh76yxx62eoxngkaye2mgq`:
  weekly FULL Sunday 04:00 UTC retained 30 days + daily INCREMENTAL 05:00 UTC
  retained 7 days.
- **Remaining sequence:** first green OCI off-site backup run → delete the DO Spaces
  bucket and the `DO_TOKEN` secret → founder closes the DO account.
