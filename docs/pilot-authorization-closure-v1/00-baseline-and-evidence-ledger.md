# 00 — Baseline, evidence ledger, and blocker matrix (Pilot Authorization Closure V1)

Milestone: Pilot Authorization Closure V1. Base code `04b07134c265b04745d7c3add85154b66e82f132`; base evidence `4c36dffc7071e3baec217b5f7f6bbbcfaf4f1956` (direct child of `04b07134`, documentation-only, 11 files, verified by `git show --name-only` — no non-docs paths). This milestone adds evidence only; no product source changed.

## Phase 0 verification (2026-10-30)

| Check | Result | How to reproduce |
|---|---|---|
| Full SHAs | `04b07134c265b04745d7c3add85154b66e82f132`, `4c36dffc7071e3baec217b5f7f6bbbcfaf4f1956` | `git -C D:\easymod\_wt-operational-gate-closure-v1 rev-parse 04b07134 4c36dffc` |
| Direct ancestry | `4c36dffc^ = 04b07134` exact | `git rev-parse 4c36dffc^` |
| Documentation-only | all paths under `docs/` | `git show --name-only 4c36dffc` |
| Source tree identity | `04b07134^{tree} = db4d3f0c01b1e75482d0291dcd145f6bd5145e8c` | `git rev-parse 04b07134^{tree}` |
| Git object health | `fsck` reported only dangling objects; zero missing/corrupt/invalid lines | `git -C D:\easymod\easy-moderator fsck --no-progress` |
| Protected worktree untouched | `_wt-operational-gate-closure-v1` still at `4c36dffc`; preserved unstaged `native-auth-responses.json` fixture modification remains unstaged; untracked artifact dirs intact | `git -C ... status --short` |
| Isolated worktree for this milestone | `D:\easymod\_wt-pilot-authorization-closure-v1`, branch `ops/pilot-authorization-closure-v1`, created at `4c36dffc`, tracked tree clean | `git worktree list` |
| Candidate runtime identity | backend container `.Image = sha256:3367c27e1af0533be9043a299c84995a8b9eaa6bd94bde6fa792f8118239a1a6` (attested candidate image, created 2026-10-27T22:58+06); env `GIT_SHA=04b07134…`, `BUILD_TIME=2026-10-27T00:00:00Z`; `GET /api/version → gitSha=04b07134…, 66 migrations, latest 20261026_001_order_idempotency_unique` | `D:\easymod\_pilot-authorization-closure-v1-local\inspect-image-identity.sh` |
| Compose-label anomaly (informational) | `com.docker.compose.image` label on the long-lived container reads `sha256:ba25ad84…`, an intermediate build pruned from the store; the authoritative runtime fields (`.Image`, config env, `/api/version`) all agree on `3367c27e`/`04b07134`. Stale label, no security meaning. | same script |

## Durability after the 2026-10-27/28 WSL `/tmp` incident

- All attested closure receipts reside on NTFS: `D:\easymod\_operational-gate-closure-v1-independent-final\` (147 top-level files: 91 evidence receipts incl. the 995 KB PASS jest log `postgres-redis-integration-overlay-rerun-20261028t012248-11923.log`, plus harness scripts and the frozen source tars) and `D:\easymod\_operational-gate-closure-v1-local\evidence\` (browser/worker/backup receipts). Verified by directory listing 2026-10-30; independently re-counted by the adversarial verifier (F-2 correction applied here). The Trivy vulnerability DB cache (`trivy-cache/`) also lives under the first directory as a tool cache — distinct from receipt files, touched by scan runs, not evidence.
- Frozen tars (`frozen-source-04b07134.tar`, `full-source-04b07134-wsl-raw.tar`, `closure-backup.dump`) on NTFS; Trivy tooling and DB cache on NTFS (`tooling/trivy-0.76.1/`, `trivy-cache/`).
- This milestone's preview source mirror was moved to **durable ext4** (`/root/pilot-preview/raw`) instead of `/tmp` and was byte-verified against the attested manifest: **2,920/2,920 tracked files match, 0 missing, 0 mismatch** (`verify-preview-tree.sh`; baseline `exact-source-filehashes.tsv`, manifest SHA-256 `4799041f8bf827afc8b9196e06f133d85ccfab7700c4211fa8f517f6d99bcfc5`).
- A WSL keeper process (`bgp_18e098175001ktb6uzcjv8RG8U`) pins the distro VM for the session; a repeat idle-restart no longer destroys any attested artifact. QA caches, source mirrors and Product Experience artifact dirs were not deleted.
- Docker images/volumes/containers survived the intervening VM restarts (inspected 2026-10-30): candidate backend `3367c27e`, attested frontend `7f29dd67fc9c…`, browser runner `easymod-closure-browser-runner:04b07134`, pinned postgres/redis/qdrant/playwright digests, all five closure volumes.

## Standards register (loaded, not assumed)

`AGENTS.md` (repo), `CONTRIBUTING-AI.md` (repo, normative MUST/MUST-NOT contract incl. the human-gate list mirrored in this mission's stop rules), `karpathy-guidelines`, `devops-engineer`, `security-reviewer`, `test-master`, `code-reviewer`, `spec-miner` (Jeffallan equivalents all available and loaded). Workflow applied per change: read evidence → reproduce gap → compare alternatives → minimum intervention → verify → independent review → immutable receipt.

## Blocker matrix (single current view)

| BLOCKER_ID | REPORTED_STATUS | LATEST_VERIFIED_EVIDENCE | OWNER | AUTONOMOUSLY_RESOLVABLE | REQUIRED_ACCESS | SAFE_NEXT_ACTION | ACCEPTANCE_PROOF |
|---|---|---|---|---|---|---|---|
| B-1 Founder preview | SUPERSEDED 2026-11-14 — confirmatory pending | The 2026-10-30 loopback preview (`https://127.0.0.1:54680`) is stale/migration-era; production is live at `https://app.easymod.tech` on OCI (`08`, item 11). Founder sign-in there is the confirmatory replacement and is **OPEN** | Founder (use it) | Yes (use) | none | Founder signs in at `https://app.easymod.tech` | Founder sign-in confirmation recorded (open follow-up in `08`) |
| B-2 Deployed image digest / rollback | BLOCKED | On-host `/opt/easymod/deployment-metadata.json` is the only digest ledger; not locally reachable; `PRODUCTION_TRUTH.md` records commits + Growth digest only | Release owner | No | read-only host/SSH or ghcr admin | Owner reads metadata file + `docker inspect` digests | `DEPLOYED_IMAGE_VERIFIED` + prior-digest compatibility rehearsal |
| B-3 Human alert receipt | PARTIAL (2026-11-14) | Local chain CLOSED incl. destination receipt (`03-alert-delivery-and-operations.md`); channel and on-call named 2026-11-14 — GitHub Actions notifications via `production-watch.yml` hourly probes, founder on-call (`08`, D-3); test-alert human ack still **OPEN** | Ops owner (founder) | No | alert channel + operator | Run the documented test alert and record the human ack on a watched device | Operator ack on watched device |
| B-4 Effective production flags | UNKNOWN | Source/render defaults verified (`04-effective-production-config.md`); host env not readable | Ops owner | No | authorized env inspection | Owner redacted `docker compose exec backend printenv` capture | `EFFECTIVE_PRODUCTION_FLAGS` table signed |
| B-5 Full security scan | DISPOSITIONED 2026-11-14 | Scan completed (vuln+secret+misconfig); `qs` MEDIUM discharged — **`qs` 6.16.2 shipped**, verified at `EasyMod-backend/package.json:109` and `package-lock.json`; no bumped re-scan run (`08`, item 9) | Release owner | Yes for scan; accept = owner | none | None required; optional re-scan for a clean post-bump record | `qs` 6.16.2 shipped (no re-scan) |
| B-6 D-1..D-7 decisions | SIGNED 2026-11-14 | Founder replied "approve all as recommended" to the consolidated package; authoritative record in `08-founder-authorization-package.md` → "2026-11-14 — Founder authorization record". Open follow-ups carried forward: D-2 Tech Provider Access Verification (due 2026-11-21), D-3 test-alert human ack, D-4 two-person rule deferred to GA, D-1 merchant selection, B-1 founder production sign-in at `https://app.easymod.tech`, mobile device proof re-run against the re-signed artifact (mobile-release run `43546632124`) | Founder | No | founder signature | One consolidated response per `08-founder-authorization-package.md` | Signed GO/NO-GO record — RECORDED 2026-11-14 |

Gate: `BASELINE_PROVENANCE=PASS`.

## Recorded readiness state (2026-11-14)

B-6 is signed. The recorded state after the founder's "approve all as recommended" is: **pilot GO for shadow/manual DRAFT operation with flags OFF**; **AI auto-reply and photo features remain gated** (D-2 Tech Provider Access Verification due 2026-11-21; item 8 provider terms). No deploy, production flag change, merchant selection, provider spend or image transfer is authorized by that record.

**Scope reconciliation (2026-11-14).** That GO is deliberately narrow: it authorizes only shadow/manual DRAFT operation with flags OFF. It does **not** mean the blocker matrix is fully closed. B-3 (test-alert human acknowledgment; written escalation contact) and B-4 (effective production env capture) remain open operational gaps, and D-4's acceptance condition (one rehearsed production-side flag flip) has not been performed. The two-person rule on global mutation flags is a founder-accepted deviation deferred to GA. **Pre-traffic gate:** no merchant traffic starts until the D-3 test-alert human ack is recorded on a watched device; B-4's redacted `printenv` capture and the D-4 flip rehearsal remain open actions, not silently waived. Items that are resolved or superseded are recorded as such in the rows above (B-1, B-2, B-5, B-6); the remainder are 2026-10-30 statements carried forward unchanged.

- **B-2 is partly discharged:** the deployed digests were read from the OCI host `/opt/easymod/deployment-metadata.json` on 2026-11-14 (item 10 in `08`); the rollback rehearsal named there is still a separate, ungranted action.
- **B-3 is partly discharged:** channel (GitHub Actions notifications via `production-watch.yml`) and on-call (founder) were named 2026-11-14; the human test-alert ack is still OPEN.
- **B-5 is dispositioned** by the shipped `qs` 6.16.2 (no bumped re-scan run); see item 9 in `08`.
- **Pre-migration references in this file are historical.** The DigitalOcean droplet this baseline was written against is destroyed (DO fully exited 2026-11-14: droplet, Spaces bucket, keys and backups deleted). OCI `130.210.21.100` is the only production, running `d427f143` via protected run `43543879447`; see `docs/launch/PRODUCTION_TRUTH.md`.
