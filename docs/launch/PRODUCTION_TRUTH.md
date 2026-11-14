# Production Truth — EasyModerator

The single record of **what is running in production** and **how it got there**.
Update this file on every production deploy and on every infrastructure cutover.

**Last verified:** 2026-11-14 by the post-cutover audit, then re-verified by the
`d427f143` batched deploy launch check (receipts below).
**Verification method:** live probes against the public hosts — `https://api.easymod.tech/api/version`
(git SHA and migration ledger), `https://api.easymod.tech/health/ready` (database and
Redis readiness), public DNS resolvers for all five A records, and the served TLS
certificate dates. Claims that rest on a dated run receipt are labelled with that
run; nothing below is inferred from an older receipt alone.

Two health-probe traps are recorded here because they have caused false passes:

- `app.easymod.tech/health` is **not** a health endpoint. The SPA answers any path
  with HTML 200. The real signals are `api.easymod.tech/health/ready` and
  `api.easymod.tech/api/version`.
- `growth.easymod.tech/api/health` is 404 by design (allowlist proxy).

## Rules (launch freeze, effective 2026-07-23)

1. `origin/main` is the only deployable source of truth. Main pushes run
   verification and GHCR image publication; the production cutover happens **only**
   via a protected manual `workflow_dispatch` from `main` with the bounded deploy
   confirmation.
2. No manual code changes on the OCI host. `/opt/easymod` holds only
   `docker-compose.prod.yml`, `Caddyfile`, and `.env` — all rendered by CI.
3. `docker-compose.prod.yml` is the single production process definition. The PM2
   path (`ecosystem.config.js`, `commerce-ai.service`) is retired — Docker Compose
   services (`backend`, `worker`, `frontend`, `growth`, `postgres`, `redis`,
   `qdrant`, `caddy`) are the only supported runtime.
4. Image tags are the version identity: CI tags every changed image with the full
   commit SHA (`ghcr.io/mr3826/easymoderator-backend`, `...-frontend`,
   `...-growth-os`). Backend and worker share one image (different commands), so
   worker version == backend image tag. Production deployment must not use
   `:latest`.

## Current runtime (2026-11-14)

| Field | Value |
|---|---|
| Cloud | Oracle Cloud Infrastructure (OCI) — sole production host |
| Public host | `130.210.21.100` |
| Instance | `easymod-oci-prod-a1` — `ocid1.instance.oc1.ap-mumbai-1.anrg6ljrgdua7wacrqez7xvw2rcim7e6g2jw6u7lytm4yeum4a3erh3sticq` |
| Shape | `VM.Standard.A1.Flex`, 2 OCPU / 12 GB |
| OS / arch | Ubuntu 24.04 LTS, aarch64 |
| Region / tenancy | `ap-mumbai-1` / `ocid1.tenancy.oc1..aaaaaaaahdl6usyhhi6jc4bghpvz3rlbrhyuplj6xyrsf7b4ggrcj3635nva` |
| Object Storage namespace | `bm1siqos8k1u` |
| Deploy root | `/opt/easymod` (Docker Compose) |
| Stack | `backend`, `worker`, `frontend`, `growth`, `postgres`, `redis`, `qdrant`, `caddy`; Caddy is the only public listener and terminates TLS |
| Running commit | `d427f143` — "feat(readiness): env-driven Caddy ACME contact + PING-verified Redis readiness" (PR #252, merged 2026-11-14T02:00:16Z) |
| Runtime identity | `/api/version` reports `gitSha=d427f143…` (canonical API-origin path `/version`) |
| Migrations | 72 applied at the 2026-11-13 cutover (latest `20261103_001_courier_collection_recon_state`); ledger not re-enumerated for `d427f143` |
| Readiness | `/health/ready` HTTP 200; database `connected`; Redis `connected` verified by an actual PING from the readiness probe (no longer only per-client classification) |
| Cutover deploy | Latest protected `workflow_dispatch` run `43543879447` — success 2026-11-14T02:19:28Z, deployed `d427f143` (previous cutover run `43353881466`, success 2026-11-13T02:48:55Z) |
| Image digests | Deploy pulls digest-pinned GHCR images; per-image digests for `d427f143` are not recorded in this receipt (2026-11-13 cutover digests were backend `sha256:b8d9abc5…`, frontend `sha256:c1ed9d23…`, growth `sha256:4d0ceebc…`) |

## Domain and DNS authority

Canonical domain: **`easymod.tech`**. The old `easymoderator.com` name does not
exist (NXDOMAIN) and must not be used in any production URL.

| Host | Role | DNS |
|---|---|---|
| `easymod.tech` (apex) | Marketing, pricing, privacy, terms | A → `130.210.21.100` |
| `www.easymod.tech` | 301 → apex | A → `130.210.21.100` |
| `app.easymod.tech` | Merchant/admin SPA | A → `130.210.21.100` |
| `api.easymod.tech` | JSON API, webhooks, health, uploads, SSE | A → `130.210.21.100` |
| `growth.easymod.tech` | Growth OS staff frontend | A → `130.210.21.100` |

- DNS authority is **Cloudflare** for the `easymod.tech` zone. Every A record is
  **grey-cloud / DNS-only** (`proxied=false`), TTL 300, so Caddy owns TLS and ACME
  end to end.
- MX, TXT (SPF/DMARC/DKIM) and Resend rows were preserved unchanged through the
  2026-11-13 cutover; transactional mail continues through Resend.
- `www` answers 301 to the apex. Caddy host blocks live in `Caddyfile` at ~line 23
  (`www`), 28 (`api`), 87 (`app`), 122 (apex) and 204 (`growth`).

## TLS and certificate renewal

- Five Let's Encrypt certificates (issuers YE1/YE2), one per host, issued during
  the cutover window 2026-11-13T01:59–02:58Z and valid until **2027-02-11T01:59Z**.
- Caddy **v2.11.3** manages issuance and renewal with **ACME HTTP-01**. Records
  stay grey-cloud so ports 80/443 reach the host directly.
- ARI renewal windows are 2027-01-11/12. `caddy_data` is a Docker named volume and
  persists across container restarts (proven on the OCI host).
- Certificate expiry is a founder-owned risk: the certificates expire 2027-02-11,
  **19 days after** the Namecheap registration expires (2027-01-22).

## Deploy pipeline and gates

- Repository: `mr3826/easymoderator` (renamed from `easymoderator-monorepo`; the old
  name 307-redirects). The repository is public; it was briefly flipped private on
  2026-11-12 and restored the same day.
- Main pushes run the required test/build gates and publish **multi-arch
  (amd64+arm64)** GHCR images tagged by full commit SHA:
  `ghcr.io/mr3826/easymoderator-backend`, `...-frontend`, `...-growth-os`.
- Production cutover is a separate protected `workflow_dispatch` (Release/Production)
  from `main`:
  - Repo variable `PRODUCTION_DEPLOY_ENABLED=false` (re-armed 2026-11-13T03:14:43Z).
    **A dispatch while `false` silently SKIPS the deploy job** — it does not fail
    and does not deploy.
  - The dispatch must carry the exact `DEPLOY-<full main SHA>` confirmation marker.
  - The `production` GitHub environment requires reviewer `mr3826`
    (`required_reviewers: [mr3826]`, `prevent_self_review=false`, so it is
    self-approvable).
  - Only digest-pinned images are pulled and started; `:latest` is invalid.
- `DEPLOY_HOST` holds the OCI IP (rotated 2026-11-13T02:06:50Z).
  `DO_SSH_PRIVATE_KEY` and `DO_SSH_KNOWN_HOSTS` intentionally keep their historical
  names; their **values** are OCI's. `known_hosts` must remain ECDSA-first (see
  `scripts/oci/README.md`).
- Health gating uses `api.easymod.tech/health/ready` and `/api/version`; never
  `app.easymod.tech/health`.

## Backup and disaster recovery

- **Nightly off-site backup:** the `Database Backup` workflow (`backup.yml`). Its
  schedule is declared at 02:00 UTC, but GitHub actually fires it ~08:0x–09:0x UTC.
  Each run waits on a **manual `production` environment approval by `mr3826`** — the
  founder chose to keep this approval, so it is manual daily by design.
- **Off-site destination:** OCI Object Storage bucket `easymod-backups-prod`
  (namespace `bm1siqos8k1u`), S3-compatible endpoint
  `https://bm1siqos8k1u.compat.objectstorage.ap-mumbai-1.oraclecloud.com`.
  - `NoPublicAccess`; 30-day DELETE lifecycle on the `db/` and `uploads/` prefixes.
  - Credentials: OCI Customer Secret Key `easymod-backup-s3-20261114`.
  - Lifecycle and privacy are audited nightly through restricted read-only OCI
    identity `easymod-backup-audit` (group `easymod-backup-auditors`, policy
    `easymod-backup-audit-read`). Lifecycle execution depends on IAM policy
    `objectstorage-lifecycle-easymod-v2`.
  - The job fail-closes on a failed `head-bucket` / credential probe before any
    dump runs.
- **First OCI-era run + isolated restore drill:** run `43397427527`, success
  2026-11-13T09:35Z. The SSH host fingerprint was
  `SHA256:s68VTR/KVo5rQvBhVPaPf24Nb9ieSqbmy4mMtloi3zY` (OCI host ECDSA key); every
  pre-cutover run pinned `SHA256:S7VfelwQ19Q9FVVQ0twlKM/XmEoM2OjLa61ItW7g8iI`
  (the destroyed DigitalOcean droplet).
- **Boot-volume backups:** boot volume
  `ocid1.bootvolume.oc1.ap-mumbai-1.abrg6ljrxr3a7t5iaa6uzes2oepoh6vqojlwthwh76yxx62eoxngkaye2mgq`
  has custom policy `easymod-prod-boot-gold`
  (`ocid1.volumebackuppolicy.oc1.ap-mumbai-1.amaaaaaagdua7waa5jbwy2anttm24ora3bg6mb3wub5q5gyqubbpszxbw7ga`):
  weekly FULL Sunday 04:00 UTC retained 30 days + daily INCREMENTAL 05:00 UTC
  retained 7 days.
- **Restore-drill contract:** after any change to the backup path, a backup
  produced on OCI must be uploaded, read back from OCI Object Storage, decrypted,
  integrity-checked and restore-listed. Run `43397427527` is the current proof.
- The DO Spaces bucket and `DO_TOKEN` are retained only until the first green OCI
  off-site run. After that run they are deleted and the DO account can close
  (founder action).

## Rollback

- **No rollback to DigitalOcean exists.** The droplet `easymod-prod` (`572180595`,
  `139.59.249.141`, `s-2vcpu-4gb`, `sgp1`) was **DESTROYED 2026-11-13 (~10:27 UTC)**
  on explicit founder confirmation. The product is pre-launch with no real
  merchants, so DO-era data was declared moot. The droplet list was verified empty
  and OCI health was re-verified immediately after. Any runbook section that says
  "start the DO stack" or "keep the droplet stopped but intact" is void.
- The only rollback is **redeploy-from-GHCR to the OCI host**: re-dispatch
  Release/Production with `PRODUCTION_DEPLOY_ENABLED=true`, the exact
  `DEPLOY-<sha>` marker, and `production` environment approval. It pulls the
  digest-pinned `ghcr.io/mr3826/easymoderator-{backend,frontend,growth-os}` images
  for the target SHA and restarts the stack.
- A rollback is a code/SHA rollback only. It does not restore DO-era data, which no
  longer exists anywhere.

## History timeline

| Date | Event |
|---|---|
| 2026-09-26 | Production ran on the DigitalOcean Singapore droplet `139.59.249.141`; runtime `e6bf0c7e`, 58 migrations. |
| 2026-11-02 | DigitalOcean-era production runtime `91c0558e`. |
| 2026-11-12/13 | `3dda3037` → `90e66d65` (multi-arch image builds, PR #246 merged 2026-11-12T22:13Z); OCI cutover deploy run `43353881466` succeeded 2026-11-13T02:48:55Z. |
| 2026-11-13 ~10:27 UTC | DigitalOcean droplet `easymod-prod` destroyed on founder confirmation; OCI became the only production host. |
| 2026-11-14 02:19Z | `6b367939` → `d427f143` (env-driven Caddy ACME contact + PING-verified Redis readiness, PR #252); protected deploy run `43543879447` succeeded. |

## Open founder actions

| Action | Why | Current evidence |
|---|---|---|
| Verify Namecheap auto-renew | Registration expires **2027-01-22**, 19 days before the certificates (2027-02-11). Registered 2026-01-22, never renewed, auto-renew unverified. | Namecheap panel; only `clientTransferProhibited` status |
| Add CAA record `0 issue "letsencrypt.org"` | No CAA record exists and Caddy uses Let's Encrypt. | Cloudflare DNS |
| Consider DNSSEC + registry lock | Zone is not DNSSEC-signed; transfer lock is only `clientTransferProhibited`. | Cloudflare / Namecheap |
| Meta Tech Provider Access Verification | Deadline **2026-11-21**. | Meta dashboard |
| Restore Android device-proof evidence | The `mobile-e2e` production proof (`43545688253`) failed before the emulator steps: no `mobile-release-production-<sha>` artifact exists (newest successful `mobile-release.yml` run `37415393394` reports `total_count=0`). Until a signed artifact is republished, there is **no Android device proof** for the deployed SHA. | [run 43545688253](https://github.com/mr3826/easymoderator/actions/runs/43545688253) |
| Close the DigitalOcean account | Only after the first green OCI off-site backup run, once the Spaces bucket and `DO_TOKEN` are deleted. | Pending run |

## Receipts

### 2026-11-13 — OCI production cutover

- `DEPLOY_RUN`: `43353881466` (`workflow_dispatch`, success
  `2026-11-13T02:48:55Z`).
- `RUNTIME_SHA`: `90e66d65`; `/api/version` matches; 72 migrations with latest
  `20261103_001_courier_collection_recon_state`.
- `READINESS`: `/health/ready` HTTP 200.
- `DNS`: five A records at `130.210.21.100`, grey-cloud, TTL 300; non-A mail rows
  unchanged.
- `TLS`: five Let's Encrypt certificates live, valid to `2027-02-11T01:59Z`.
- `DEPLOYMENT_GATE`: `PRODUCTION_DEPLOY_ENABLED=false` re-armed
  `2026-11-13T03:14:43Z`.

### 2026-11-13 — first OCI-era backup and isolated restore drill

- `BACKUP_RUN`: `43397427527`, success `2026-11-13T09:35Z`.
- `HOST_PROOF`: SSH fingerprint
  `SHA256:s68VTR/KVo5rQvBhVPaPf24Nb9ieSqbmy4mMtloi3zY` (OCI host ECDSA key).
- `RESTORE_DRILL`: isolated restore drill passed — backup read back, decrypted,
  integrity-checked and restore-listed.

### 2026-11-14 — post-cutover audit

- The 11-agent adversarial audit confirmed the runtime, DNS, TLS and backup facts
  above. It also found and recorded the health-probe traps at the top of this file,
  the missing external uptime monitoring (now covered by `production-watch.yml`) and
  the over-reported Redis readiness field (fixed in this PR: the `redis` field now
  reports `connected` / `degraded` / `not_configured` from per-client
  classification).

### 2026-11-14 — batched deploy receipts (`d427f143`)

- `DEPLOYED_SHA`: `d427f1431c68f6c16a398daa223961f3a0a28dd8` (PR #252), deployed
  via protected `workflow_dispatch`.
- `DEPLOY_RUN`: `43543879447` (`CI / CD`, `workflow_dispatch`, success — dispatched
  `2026-11-14T02:00:47Z`, completed `2026-11-14T02:19:28Z`).
- `SEED_RUN`: `43538146002` (`Seed Meta Review Merchant`, `workflow_dispatch`,
  success `2026-11-14T01:31:47Z`, head `6b367939`).
- `LAUNCH_CHECK`: **5/6 gates PASS**. `launch-readiness` exits 1 solely on the
  expected pre-pilot activation gate:
  - PASS — Infra up: `/health/ready` HTTP 200,
    `commit=d427f1431c68f6c16a398daa223961f3a0a28dd8`.
  - PASS — DB + Redis + vector store: `db=connected redis=connected
    vector=available qdrant`.
  - PASS — Auto-reply DLQ empty: `dlq=0`.
  - PASS — Inbound webhook DLQ empty: `deadLettered=0 held=0`.
  - PASS — Auto-reply canary fresh: last ok 45s ago.
  - FAIL (expected, pilot-pending) — Activation >= 2 shops: unverified;
    `/api/analytics/growth` returns 503 pre-pilot.
- `REDIS_READINESS`: the readiness `redis` field now reflects an actual PING rather
  than only per-client classification (PR #252); production reports `connected`.
- `ACME_CONTACT`: **registered** — the Caddy ACME account contact is supplied from
  the environment instead of being hard-coded (PR #252).
- `WATCH`: `production-watch.yml` green for the deployed SHA.
- `MOBILE_PROOF`: **FAIL — API half green, device half not run.** Run
  `43545688253`.
  - API checks: 50 total — 47 passed, 0 failed, 3 skipped (benign: "no order entity
    on Home", "no conversation entity on Home", "second shop has no
    order/conversation on Home"). The suite is **50 checks, not 18**. Production
    `gitSha=d427f1431c68f6c16a398daa223961f3a0a28dd8` was confirmed via HTTP 200 on
    the commit check; app on `https://api.easymod.tech`;
    `database=connected redis=connected`.
  - Device proof: **not run.** The job failed at step 6, "Locate the signed release
    of the current mobile source" — `gh run download … -n
    mobile-release-production-<sha>` printed "no valid artifacts found to
    download". The newest successful `mobile-release.yml` run on `main` is
    `37415393394` (head `981f8f74595e0c17f3e779b91708e9d5ba79facc`, 2026-10-06) and
    its artifacts API reports `total_count=0`; repo-wide there are 61 artifacts and
    none match `mobile-release-*`. Steps 7–10 (APK signature verify, Maestro
    install, KVM, signed APK on API 34 emulator) and step 13 ("Signed APK against
    production on API 34 (x86_64)") were skipped.
  - Uploaded artifact `mobile-production-proof-43545688253` is only 2,794 bytes —
    API proof only, **no device evidence**. This receipt records a failed mobile
    proof; it is not evidence for the Android release.

## Verification limits

The receipts above prove the deployed SHA, the migration ledger as of the
2026-11-13 cutover, readiness, DNS
ownership, TLS issuance and the off-site backup/restore path. They do **not** prove
an authenticated operator walkthrough, a human-visible Sentry receipt, worker
canary behavior, media restore, Qdrant recovery, Redis recovery, or a live
production rollback execution. No claim is made for those boundaries.

## Post-deploy verification (run against the OCI host after each deploy)

```bash
# What is actually running, and since when
ssh root@130.210.21.100 "docker ps --format '{{.Names}}\t{{.Image}}\t{{.CreatedAt}}'"

# Cross-check against the canonical repository main ref
git ls-remote https://github.com/mr3826/easymoderator.git refs/heads/main

# Application-reported release and migration ledger summary. This is not schema proof.
curl --fail --silent --show-error https://api.easymod.tech/version

# Entity-backed schema contract (read-only; must return no drift)
ssh root@130.210.21.100 "cd /opt/easymod && docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm --no-deps -T -e RUN_MIGRATIONS_ON_STARTUP=false backend npm run schema:audit"
```

## Launch-freeze exception log

| Date | Exception | Resolution |
|---|---|---|
| 2026-07-23 | Prod had been running `f1c7ee5` from unmerged branch `codex/messenger-production-recovery` | PR #73 merged as `3f878e3`; the canonical `main` deployment workflow completed successfully and restored the source-of-truth invariant |
