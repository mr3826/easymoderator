# EasyModerator monorepo cutover runbook

This is the authoritative cutover contract for the monorepo deployment path.
It intentionally supersedes the retired Cloud Run deployment procedure; that
historical procedure is not part of the current checkout.

## Safety gates

Production deployment remains disabled until every gate below is evidenced:

- Repository variable `PRODUCTION_DEPLOY_ENABLED=false` during preparation.
- Required production configuration is present: database, Redis, JWT/session/
  CSRF/HMAC, Meta, payment/channel encryption, email, and at least one alert
  sink. Secret values must never be committed or printed.
- Required deployment credentials are present under the canonical names
  `DEPLOY_HOST` and `DO_SSH_PRIVATE_KEY`. The SSH contract is `root@host` and
  `/opt/easymod`.
- Production environment reviewers and main-branch restrictions are verified;
  if the GitHub plan cannot provide them, the cutover remains blocked.
- A fresh database backup and a restore check are recorded before the first
  migration against the live database.
- `npm ci`, backend security/unit tests, backend integration tests, frontend
  unit/build checks, the Growth OS typecheck and build, and the historical
  secret scan are green.

The trusted post-merge entrypoint is `.github/workflows/release.yml`. It calls
the guarded CI/CD engine only from `main` or an operator workflow dispatch.
Pull-request validation remains non-publishing and non-deploying; the
production deploy path requires the existing `PRODUCTION_DEPLOY_ENABLED`
control, exact `DEPLOY-<main SHA>` confirmation, and the production environment.

Telegram is disabled by default. It is an optional integration and may be
enabled only by setting the `TELEGRAM_ENABLED` repository variable and adding
all three Telegram secrets. bKash is likewise disabled unless explicitly
enabled and fully configured.

## Non-deploy dry run

The safe dry run must not use SSH and must not alter the live droplet:

```bash
npm ci
npm run test:backend:integration:docker  # disposable Postgres 16 + Redis 7; Docker required
npm run test:backend
npm run test:frontend
npm run test:growthos
docker compose --env-file .env.prod -f docker-compose.prod.yml config
```

The final compose command is valid only with a local, untracked `.env.prod` and
the immutable image references supplied by the deployment job:
`GHCR_IMAGE_BACKEND` and `GHCR_IMAGE_FRONTEND`. The deployment workflow itself
does not run when `PRODUCTION_DEPLOY_ENABLED` is false. It renders and validates
the environment before SSH only when the operator later enables the guarded
deployment path.

`scripts/render-production-env.js` writes Docker-native `KEY=value` lines and
rejects newline/NUL injection. The runtime decodes legacy JSON-quoted values
before production validation so an older `.env.prod` fails safely only when its
underlying value is actually invalid; malformed quoting remains rejected.

When Docker is unavailable, CI is the authoritative integration execution: the
`meta-e2e` job provisions the same disposable PostgreSQL 16 and Redis 7 services
and runs `npm run test:integration` at Node 20. The integration suite deliberately
does not start Qdrant; it verifies the documented safe-empty vector degradation.

## Image and migration rules

- Application services must use the candidate SHA image tag or a captured
  `RepoDigest`, never a mutable `latest` fallback.
- Qdrant is pinned by digest in both Compose files.
- The candidate backend image is config-validated before service replacement.
- Only additive, backward-compatible migrations may run during cutover. Do not
  run `migrate:down` against production as a rollback mechanism.
- After the candidate migration, the deploy job runs `npm run schema:audit`
  against the target database before replacing any service. A migration ledger
  row is not sufficient proof that the entity-backed schema is complete; any
  missing table, column, incompatible type, required-column drift, or enum
  value fails the rollout closed.
- The deploy job must capture the currently running backend/frontend digests
  before replacement and keep the backup available until the health gate is
  complete.

## Growth OS first rollout

Growth OS is built and published by `growth-os.yml`, not by `ci-cd.yml`. The
deploy job therefore has no build-job digest for it: it reads the digest of the
running `easymod-growth-frontend-1` container and carries it forward unchanged.

That means `ci-cd.yml` fails closed the first time, before Growth OS has ever
run on the droplet — by design, because a tag would make the deploy
irreproducible and the rollback meaningless. Obtain and verify the first image
digest with:

```bash
cd /opt/easymod
docker pull ghcr.io/mr3826/easymoderator-growth-os:REPLACE_WITH_COMMIT_SHA
docker image inspect -f '{{index .RepoDigests 0}}' \
  ghcr.io/mr3826/easymoderator-growth-os:REPLACE_WITH_COMMIT_SHA
```

Set the repository variable `GROWTH_BOOTSTRAP_DIGEST` to the printed bare
`sha256:...` value, then deploy normally. The production environment file is
regenerated on every deploy, so a value written there is discarded. A running
Growth container always takes precedence over the bootstrap variable, so it
self-disarms after the first rollout. If the first rollout fails, the restored
pre-Growth Compose snapshot removes the Growth container during rollback.
After the first successful rollout, unset the repository variable
`GROWTH_BOOTSTRAP_DIGEST`; if the container is later lost, leaving it set could
resurrect a stale image instead of failing closed.

The placeholder above is an operator input, not a credential.

## Automatic rollback

The workflow stages config in a private per-attempt directory. Under the host
deploy lock, it verifies the captured checksums and image digests and installs
the rollback trap before activating any staged config. On ordinary failure,
the trap restores and verifies the prior config and images. The candidate still
fails; exit 70 means recovery itself needs operator attention. The workflow does
not change `PRODUCTION_DEPLOY_ENABLED`.

An `active` record under `/opt/easymod/.cutover-rollback` blocks a new cutover
after an interrupted or failed recovery. An authorized operator must reconcile
the recorded snapshot, checksums, image refs, running release and health checks
under the deploy lock before clearing it. Do not remove the marker to retry an
unverified cutover. Keep snapshot contents on the host; the environment file can
contain credentials. This is an application rollback only; a schema rollback
requires a reviewed forward fix or a database restore after confirming data-loss
impact.

Keep the current rollback set until the release observation window closes and
the release owner confirms recovery is no longer required. Do not prune its
images or purge snapshots while an active marker or unresolved incident exists.
After that point, retire completed snapshots using the host's approved secrets
and backup retention policy; do not upload credential-bearing files as evidence.

Manual recovery, if the workflow runner is unavailable:

```bash
cd /opt/easymod
export GHCR_IMAGE_BACKEND='REPLACE_WITH_CAPTURED_BACKEND_REPODIGEST'
export GHCR_IMAGE_FRONTEND='REPLACE_WITH_CAPTURED_FRONTEND_REPODIGEST'
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --no-build --remove-orphans
curl --fail https://api.easymod.tech/health/ready
curl --fail https://api.easymod.tech/health
```

The executable non-production rehearsal runs from the repository root in the
CI `Deployment configuration dry run` job:

```bash
bash scripts/rollback-rehearsal.sh
```

It resolves real `node:20-alpine` and `node:22-alpine` RepoDigests at runtime,
extracts the digest, checksum and restore functions directly from the shipped
`ci-cd.yml`, and stages synthetic
previous/candidate files under an owned `/opt/easymod` layout. The rehearsal proves the candidate state is
rejected, then proves the actual rollback restores both captured image
references, the environment hash, Compose, the Caddyfile, and both health checks;
it also proves missing previous images fail closed. This does not prove that a
specific previous application image is compatible with a candidate schema. Its
`rollback-rehearsal-evidence` artifact is a machine-readable receipt. It must not run `migrate:down`:
application rollback can restore images, while a schema change requires a reviewed
forward migration or an isolated database restore.
The current production source and its tags remain the operator's rollback
inputs; this repository must not be required to boot in order to execute that
recovery.

The placeholders above are operator inputs, not credentials and must never be
replaced in committed documentation.
