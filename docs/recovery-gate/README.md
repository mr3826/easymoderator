# Production-readiness recovery gate

This gate is a recovery-only control plane. It does not deploy, switch traffic,
restore over production, rotate credentials, or mutate production data.

## Agent boundary

`scripts/recovery-gate/index.js` is the Recovery-Orchestrator. It coordinates
five isolated checks:

- Backup-Verification: daily application backup workflow, off-host configuration, encryption,
  SHA256, lifecycle, and credential presence.
- Restore-Rehearsal: restore-tool syntax, Docker prerequisites, and explicit
  isolated-target requirements.
- Fraud-Shield: normalization, validation, deduplication, ordering, bounded
  payloads, deterministic scoring, exception containment, and local live
  enforcement-path discovery. The optional external fraud-detector repository
  is intentionally not a cutover dependency.
- Observability: UTC evidence timestamps and RPO/RTO field definitions.
- Security & Secrets: presence-only secret checks and source-level leakage
  searches.

The default command is read-only and synthetic where live infrastructure is
required:

```text
npm run recovery:gate
```

Use `--json` for machine-readable redacted evidence. Use
`--write-evidence --evidence-dir=<directory>` only with a directory intended for
non-secret gate artifacts. The command exits `1` for any blocked verdict and
exits `0` only for `READY_FOR_CONTROLLED_CUTOVER`.

## Current backup policy

The application/off-host workflow is configured as:

```text
BACKUP_FREQUENCY=DAILY
BACKUP_SCHEDULE=DAILY 02:00 UTC
CONFIGURED_BACKUP_INTERVAL=1 day
THEORETICAL_MAX_BACKUP_GAP=1 day
```

DigitalOcean-managed database backups, if enabled, are an independent policy
and must not be conflated with this application/off-host workflow.

Configured cadence is not observed RPO. `OBSERVED_RPO` remains
`NOT_MEASURED` until a real isolated PostgreSQL and product-media restore
captures the source-write, failure, and latest-restored-write timestamps.

## Credential policy

The DigitalOcean API probe (`DO_TOKEN`) was retired with the 2026-11-13 OCI
cutover; `DO_API_TOKEN` and `DO_TOKEN` are ignored. The off-site target is OCI
Object Storage behind its S3-compatible API (secret names kept from the Spaces
era — see `docs/infrastructure/OCI_MIGRATION_DESIGN.md` §1.2/§2.3): access key,
secret key, endpoint (`https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`),
bucket, and encryption-key values must be supplied through the environment or
approved secret manager; they must never be committed, echoed, serialized, or
placed in evidence. `OCI_AUDIT_PRIVATE_KEY` (restricted read-only identity) is
reported as present/absent only and is used by the nightly workflow — not by
this gate — to prove bucket privacy and lifecycle retention OCI-natively.

If off-site credentials are configured at Windows user scope but are not
present in the current process, resolve them into a temporary process
environment before running the gate. Do not print the values and do not persist
them.

```powershell
$env:SPACES_ACCESS_KEY_ID = [Environment]::GetEnvironmentVariable('SPACES_ACCESS_KEY_ID', 'User')
# ...repeat for SPACES_SECRET_ACCESS_KEY, SPACES_ENDPOINT, BACKUP_BUCKET, BACKUP_ENCRYPTION_KEY
npm run recovery:gate -- --execute-offhost --write-evidence
Remove-Item Env:SPACES_ACCESS_KEY_ID  # ...and the rest
```

`--execute-offhost` fails closed when any required Spaces credential is absent.
It never substitutes `DO_API_TOKEN`, anonymous access, or invented credentials.

## Isolated restore policy

`EasyMod-backend/scripts/restore-database.js` accepts only an explicitly
isolated target:

```text
RECOVERY_TARGET=isolated
RECOVERY_DATABASE_URL=<approved isolated database URL supplied outside the repo>
RECOVERY_DB_PASSWORD=<approved isolated database secret supplied outside the repo>
```

The production `DATABASE_URL` and `DB_PASSWORD` variables are intentionally not
used by the restore command. Redis starts empty and Qdrant is regenerated; they
are not authoritative backup inputs.

## Evidence interpretation

The gate distinguishes:

- `CONFIGURED_NOT_EXECUTED`: source/configuration exists, but no live proof.
- `NOT_MEASURED`: a real restore/timing experiment has not run.
- `BLOCKED_EXTERNAL_CREDENTIAL`: a required authorized secret is absent.
- `NEEDS_HARDENING`: code or integration boundaries prevent shadow-only proof.
- `READY_FOR_CONTROLLED_CUTOVER`: only possible after all recovery gates pass.

Even the final ready state keeps `PRODUCTION_DEPLOY_ENABLED=false` and
`PRODUCTION_SWITCHED=NO`. Cutover requires separate explicit authorization.
