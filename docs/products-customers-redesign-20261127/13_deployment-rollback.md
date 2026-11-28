# Deployment and Rollback

## Gate

`PRODUCTION_DEPLOY_ENABLED` **live-verified `false` (disarmed)** via `gh api repos/mr3826/easymoderator/actions/variables/PRODUCTION_DEPLOY_ENABLED` on 2026-11-28. This record has not modified the gate. The checked-in release workflow requires the PR/CI and integration/E2E gates, an operator-enabled repository variable, one-shot `DEPLOY-<full-main-SHA>` confirmation, pinned image digests, and post-cutover smoke/rollback verification.

Local verification is complete and recorded: backend unit lane parity vs baseline (zero mission-only failures), integration full lane 47/47 · 363/363 (`logs/integration-full-lane-final.txt`), frontend unit/tsc/build green, Playwright 34/34 serial. The authoritative remaining automated gate is the hosted PR CI (`PR Merge Gate` + `Security Scan`, Node 20/Linux).

Current status at push: `DEPLOY_PENDING_CI` — deployment may proceed only inside the mission's authorized window after the PR is green and merged, per the release sequence in this directory; if any pre-deploy gate fails, leave the gate `false`, do not deploy, and record `DEPLOY_DEFERRED` with the failing evidence.

## Rollback

- Redeploy the previous frontend and backend digests.
- No database migration is planned, so there is no schema rollback.
- Re-verify login, product create/edit, customer list/detail, chatbot product card, and order eligibility after rollback.
- Use the repository's protected release/restore-floor workflow and its immutable `sha256` inputs; the actual incumbent digests must be captured from that release run before deployment.

Do not record a deployment or smoke test until it has actually occurred in the authorized window.
