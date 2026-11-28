# Deployment and Rollback

## Gate

`PRODUCTION_DEPLOY_ENABLED` is **`false` (disarmed) and live re-read after the window** (armed only for the two authorized guarded dispatches of 2026-11-28, restored immediately after each attempt — including the fail-safe one — per contract). The checked-in release workflow requires the PR/CI and integration/E2E gates, an operator-enabled repository variable, one-shot `DEPLOY-<full-main-SHA>` confirmation, pinned image digests, and post-cutover smoke/rollback verification.

Local verification is complete and recorded: backend unit lane parity vs baseline (zero mission-only failures), integration full lane 47/47 · 363/363 (`logs/integration-full-lane-final.txt`), frontend unit/tsc/build green, Playwright 34/34 serial. The authoritative remaining automated gate is the hosted PR CI (`PR Merge Gate` + `Security Scan`, Node 20/Linux).

Status: **DEPLOYED + RUNTIME_VERIFIED** in the founder-authorized window of 2026-11-28 (see receipt below). Earlier `DEPLOY_PENDING_CI` and the pre-window staging records are superseded.

## Deployment execution receipt (2026-11-28, founder GO for `d1d9bcc7` only)

PR #325 merged to main `d1d9bcc7f6230753e69684a19c9c60f908cee822` (plain merge, required checks green incl. real-PG/Redis integration). Window chronology (full detail: `prod-evidence/products-customers-redesign-20261127/14_deployment-execution.md`):

1. First dispatch (`46109784531`, single-stage paired promotion) **failed safe** at the reader-floor guard (`Stage 2 rollback floor is not a reader-only recovery revision`, `ci-cd.yml:1095-1101`); production untouched; gate immediately restored `false`.
2. Corrected to the established two-stage chain (restore qualified reader floor, then paired promotion with the floor bound as rollback — the doctrine used by phase1-nav, delivery, business-faq and payment releases). Floor pair digests resolved from recorded receipts, never assumed: backend `sha256:5a308ae6597adbd6e2c68d2bd6c465055d34b167901993d208076cfbc66b5fbb` (revision `ad79cd9c…`, ancestor of the candidate), frontend `sha256:9f1262d5c3dab6e40ab4a92fd0cce9bfca3ba141b5263e4966e2cf9c5ff61213`.
3. Restore-floor run `46111302628` SUCCESS (`target=restore-floor` requires the one-shot `DEPLOY-<sha>` confirmation too — a dispatch without it silently skips; caught by read-back). Floor verified live: `/api/version` `ad79cd9c…`, migrations 83, `/health/ready` 200, on-host floor digests.
4. Paired promotion run `46113394505` SUCCESS — `target=all`, candidate digests unchanged from main-push (backend `sha256:27ee2306641d7a6f9ba3faf8988ac2fbf8886a8c6e33a6cdc156ab758260c6c1`, frontend `sha256:1114d8f4cbb46985ffda15890dc53d2175f91ff849eb942ed4bf57792bded05c`), `expected_rollback_*` = floor pair, Growth override empty (carried `c3f4e90c…`). Environment `production` approved via the configured API.
5. Post-cutover read-backs: `/api/version` gitSha `d1d9bcc7f6230753e69684a19c9c60f908cee822` (startedAt 05:54:39Z), migrations **83** with **zero applied during the window**, `/health/ready`/app/growth **200**, on-host backend=worker `27ee2306…` and frontend `1114d8f4…` exactly the candidate digests, Growth `c3f4e90ca4fe` preserved, `.cutover-rollback/46113394505-1` manifest with byte-identical config hashes (zero config drift).
6. Integrity (read-only): connected Meta-channel roster byte-identical to pre-window baseline (4 CONNECTED + bootstrap placeholder + 1 legacy DISCONNECTED; app-level `page.messages` subscription unaffected), products/customers counts intact, `enum_customers_channel_type` live order exactly matches the new single-source `customer-channels.js` (messenger, instagram, webchat, manual, facebook, telegram), zero ERROR/FATAL log lines post-cutover, unauthenticated route-mount guards 401 on product/category/customer-intelligence/channels. Workflow's own deploy verification (DB auth probe, immutable-ref assertions, worker health, public app/API/Growth smoke incl. version-body match) passed.
7. Gate **restored `false`** and live re-read at 05:57Z. Founder-assisted UAT legs remain open (doc 12; incl. the post-deploy Meta-connect smoke leg covering the http-client retry-gating change). No founder checkbox ticked; no PILOT_GO.

## Rollback

- Bound rollback: qualified floor pair above (`46113394505-1` manifest). The prior writer release `fd78afde` (backend `sha256:08b24eef…`, frontend `sha256:358aa96c…`) remains published and is restorable via a fresh guarded window if a further interlude is ever required.
- No database migration shipped with this release — 83 before, 83 after; no schema rollback exists to perform.
- Re-verify login, product create/edit, customer list/detail, chatbot product card, and order eligibility after any rollback.
- Use the repository's protected restore-floor/paired-promotion workflows with full immutable `sha256` inputs; digests must be read, never assumed.
