# Growth OS Execution State

Updated: 2026-11-15

## Current execution

- `CURRENT_MAIN`: current `origin/main` (verify with `git rev-parse origin/main`)
- `BASE_MAIN`: current `origin/main`; post-release documentation/test commits are not deployed
- `WORKTREE`: `D:\easymod\production-conversation-reply-engine`
- `BRANCH`: `main`
- `PHASE`: production release receipt verified; Growth operator bootstrap remains open
- `STATUS`: CI, migration, schema, backend version, and public smoke receipts pass; post-release main changes are docs/tests only, while live Growth digest and operator bootstrap remain unverified
- `RELEASE_STATUS`: CONDITIONAL — merchant production is running the verified main SHA; Growth operator gates remain open
- `PRODUCTION_CHANGED`: YES — bounded workflow dispatch `35812554066`

## 2026-09-26 first-operator bootstrap implementation receipt

This is an implementation receipt only; no production credential, MFA secret,
role grant, Sentry event, or live authenticated walkthrough is claimed here.

- `SEED_WORKFLOW`: `.github/workflows/seed-initial-growth-admin.yml`
- `SEED_IDENTITY`: dedicated shop-less internal user; no merchant membership or
  Growth role is created by the seed.
- `SEED_SECRET_HANDLING`: protected production secret, existing password hash
  utility, forced rotation, transaction/advisory lock, non-secret audit fields,
  stdin transfer to the container, and no password process argument.
- `ROLE_WORKFLOW`: existing `grant-growth-role.yml`; first `SUPER_ADMIN` grant
  requires the seed marker, completed password rotation, and real MFA, then
  clears the marker and invalidates sessions transactionally.
- `BOOTSTRAP_LIVE_PROOF`: `NOT_RUN`
- `SENTRY_BROWSER_PROOF`: `BLOCKED_CANONICAL_DSN_NOT_DISCOVERABLE`
- `MOBILE_WORK`: `PROTECTED_AND_UNMODIFIED`

## Phase 1 base proof

Phase 1 was merged through PR #34 using squash merge:

- `PR_34_STATE`: `MERGED`
- `PR_34_MERGE_SHA`: `b786c1ecfd4d4f03cf3f47c2945bc8c3ba8780de`
- `MERGE_METHOD`: `SQUASH`
- Original Phase 1 commit `0041311dd3f4ac8c48347a24f8adb41aec6a6e10` is intentionally not required to be an ancestor of `main`.
- The current base contains the Phase 1 telemetry/idempotency implementation, regression tests, and completion evidence.

Phase 1 evidence reused:

- unsupported funnel events remain rejected;
- browser telemetry markers are set only after successful server acceptance;
- idempotency is bound to tenant/user/payload identity;
- analytics dependency failures return sanitized `503` responses rather than false zero-valued success;
- activation writes are atomic;
- deployed analytics rate limiting uses Redis;
- Phase 1 focused evidence remains 5 backend suites/34 tests, 27 backend security suites/183 tests, 59 merchant frontend files/483 tests, PostgreSQL/Redis integration, Meta-shaped E2E, secret scan, dependency audit, and changed-service checks.

## Phase 2 merge proof

PR #35 was squash-merged into `main` after the final current-head checks
passed:

- `PR_35_STATE`: `MERGED`
- `PR_35_MERGE_SHA`: `a0e41ab5dcfdcafe11d6acc410c5cd5144602719`
- `PR_35_HEAD`: `62a542dce4066872a64594205b5c973b554bb176`
- The Phase 2 head is intentionally not an ancestor of `main` because the PR
  used squash merge; the resulting main tree and content are the authoritative
  verification.

## Access contract

### Authorized identities and roles

Growth OS reuses EasyModerator's authenticated JWT/httpOnly-cookie identity and the authoritative `users` records. Access requires an active `growth_os_user_roles` record and a matching permission in the server-side policy:

- `FOUNDER`
- `GROWTH_MANAGER`
- `BUSINESS_EXECUTIVE`
- `MARKETER`
- `CUSTOMER_SUCCESS`
- `READ_ONLY_ANALYST`

Access is authorized solely by an active `growth_os_user_roles` record and the permission required by the endpoint. Growth OS has no MFA precondition for any role: the platform TOTP flow remains available and the server may still issue an `mfaVerified` claim, but Growth authorization ignores it, so a password-only session with a valid Growth role is authorized. `users.platform_role` and merchant `user_shops.role` do not authorize Growth OS. (MFA requirement removed 2026-11-15; see the receipt below.)

### Unauthorized identities and roles

- unauthenticated, malformed, expired, revoked, or token-version-invalid sessions;
- ordinary merchant accounts, even when they know the URL or supply a different shop/merchant identifier;
- EasyModerator platform/admin accounts without an explicit Growth OS role;
- internal users with no active Growth role or without the permission required by an endpoint;
- any request that attempts to use a frontend-only claim or client-side state as authorization.

### Enforcement and data scope

- Backend authority: `authenticate` followed by `requireGrowthOsAccess` on the Growth router and on privileged endpoints.
- Frontend defense: `GrowthAuthProvider` and `ProtectedRoute` control navigation and show explicit denied/temporary-unavailable states; these checks are UX only.
- Current Growth APIs expose a safe internal session profile and an intentionally internal cross-shop analytics endpoint. The current Phase 2 surface does not accept merchant/customer/prospect resource IDs.
- Cross-shop analytics is allowed only through the explicit `growth_os.reports.read_all` permission. Merchant shop context is never used to grant Growth access, and forged shop identifiers do not expand access.
- Future resource endpoints must derive authorization from the server-side Growth role/policy and must add resource-scope tests before implementation.

### Failure contract

- missing, malformed, expired, revoked, or invalid-version authentication: sanitized `401`;
- authenticated without Growth authorization: sanitized `403 GROWTH_OS_FORBIDDEN`;
- Growth disabled by configuration: `503 GROWTH_OS_DISABLED`;
- unavailable role database/authentication store: sanitized `503`;
- unavailable deployed Redis authorization cache, including strict-cache read/write failure: sanitized `503`, never an in-memory authorization decision;
- unavailable analytics/data dependency: Phase 1 sanitized `503`, never fabricated analytics success.

## Phase 2 evidence matrix

| Capability | Status | Current evidence and expected property | Remaining gap |
| --- | --- | --- | --- |
| Authentication | COMPLETE for bounded gate | Shared JWT/cookie auth, token-version and blacklist checks; invalid/expired claims return `401`; revocation-store failures return sanitized `503`. | Live browser/session proof remains outside the local gate. |
| Internal Growth authorization | COMPLETE for bounded gate | Explicit six-role table, permission policy, default-deny middleware; MFA is not a Growth OS access precondition (removed 2026-11-15). | Operator bootstrap and production enablement remain separate gates. |
| Frontend route protection | PARTIAL | Growth provider/route guard reflects `401`, `403`, `503`, refresh, and logout failure states. | Live cross-origin browser verification is not available in this worktree. |
| Backend Growth APIs | COMPLETE for bounded gate | Session, analytics, prospect, and role routes enforce backend auth and server-side permission/scope predicates; remote Test & Build Gate passed for the merged release. | No live host proof. |
| Direct endpoint bypass | COMPLETE | Real integration and mocked security tests call protected endpoints directly; merchant calls receive `403`. | No live host proof. |
| Tenant/resource isolation | COMPLETE for current surface | Merchant tokens with forged frontend claims and foreign shop IDs remain denied; no current Growth resource-ID lookup exists. | Future resource APIs require new IDOR tests. |
| Privileged mutations | COMPLETE for bounded gate | Founder-only grant/revoke policy, input validation, transaction, last-Founder guard, cache invalidation, and audit rows. | No role-management UI; API is intentionally internal. |
| Auditability | COMPLETE for implemented mutation | Role grant/revoke write `AuditLog` records in the same database transaction. | Future Growth mutations remain out of scope. |
| Invalid/expired sessions | COMPLETE | Unit/security/integration coverage includes no credentials, invalid/expired credentials, token version, and valid signed sessions. | Live cookie expiry flow remains unverified. |
| PostgreSQL runtime | COMPLETE locally | Disposable PostgreSQL migrations and Growth access integration pass; real constraints and transactional role lifecycle exercised. | No production database was touched. |
| Redis runtime | COMPLETE locally | Disposable Redis supports role cache, invalidation, startup probe, and strict authorization cache operations; outage path returns `503`. | No production Redis was touched. |
| Phase 1 telemetry/error contract | COMPLETE | Phase 1 focused analytics suites pass after Phase 2 changes; sanitized dependency failures and idempotency behavior remain intact. | None identified in the bounded suite. |
| Deployment/readiness | COMPLETE for config gate | Caddy validates; Growth frontend has exact health/readiness paths and Compose healthcheck; Growth host rejects unsupported API paths with `404`. | Live DNS/TLS/host checks remain unverified. |
| Remote CI/build gate | COMPLETE for bounded gate | Draft PR #35 remote checks passed: Test & Build Gate, backend PostgreSQL/Redis integration, Meta-shaped E2E, Growth build, secret scan, dependency audit, deployment dry run, and no-push Docker validation; publish/deploy jobs were skipped. | Live delivery proof is still required for release. |

## Phase 2 implementation

Existing implementation reused:

- shared EasyModerator authentication, refresh, token-version, blacklist, TOTP, CSRF, session, `User`, `AuditLog`, PostgreSQL, Redis, Caddy, Compose, and deployment workflows;
- existing Growth role entity/migration, permission map, session controller, analytics route, and separate `EasyMod-growth` frontend;
- existing sanitized `AppError`/global error handling and Phase 1 telemetry/idempotency behavior.

Bounded changes made:

- added exact Growth origin configuration and production CSRF trust for `growth.easymod.tech`;
- made privileged MFA assurance explicit in server-issued tokens and Growth authorization;
- added audited Founder-only Growth role grant/revoke operations with validation, transactional last-Founder protection, and cache invalidation;
- prevented Growth authorization from falling back to generic in-memory cache behavior; lazy Redis startup is probed with a bounded timeout and strict role-cache operations fail closed;
- added sanitized authentication service failure behavior for revocation-store outages;
- fixed Growth client CSRF behavior for authenticated mutations, refresh/retry behavior, logout failure handling, and temporary dependency-unavailable UI;
- narrowed the Growth host proxy to the Growth auth/session contract and made unsupported API paths deterministic `404` responses;
- added Growth frontend readiness/build identity, Compose healthcheck, behavioral test execution in CI, and Windows-compatible integration migration/test discovery;
- made the existing Growth role migration DDL transactional and corrected its migration log identifier.

No new merchant-facing feature, CRM feature, prospect discovery, enrichment, outreach, retention, referral, AI, or Phase 3 implementation was added.

## Runtime and validation evidence

- Disposable PostgreSQL/Redis stack: migrations completed successfully, including `20260820_001_growth_os_user_roles`.
- Real Growth access integration: final disposable PostgreSQL/Redis gate passed 2 suites/22 tests after the strict Redis/startup-probe correction; migrations completed before the test run.
- Growth authorization focused suite: final combined affected suite passed 4 suites/29 tests, including 13 Growth authorization tests and the authentication, CSRF, and origin regressions.
- Merchant frontend unit suite: 59 files/483 tests passed.
- Growth frontend behavioral test: passed; Growth frontend TypeScript check and production build passed.
- Backend build/syntax check: passed.
- Phase 1 analytics focused regression: 4 suites/27 tests passed in the current checkout; historical merged Phase 1 acceptance remains 5 suites/34 tests.
- Production Compose parse: passed; Caddy configuration validation: passed; Growth Docker image build: passed.
- Dependency audit: `npm audit --audit-level=high --omit=dev` passed with 0 vulnerabilities.
- Changed-code Gitleaks directory scans passed for backend, Growth frontend, and workflow paths.

## Phase 3 merged-release validation evidence (pre-hardening)

- Prospect backend focused unit/security/migration gate: **4 suites, 26 tests
  passed**.
- Disposable PostgreSQL/Redis integration gate: **4 suites, 28 tests passed**,
  including prospect CRUD, scope/IDOR, scoped duplicate conflict redaction,
  multi-field search, concurrent duplicate creation, merge index release, audit
  rollback, and import dry-run/idempotency.
- Growth frontend Vitest/jsdom/typecheck gate: **3 files, 17 tests passed**.
- Growth production build: passed.
- Backend syntax/build check: passed.
- Fresh bootstrap smoke check: passed; prospect tables were absent before the
  migration and both migrated tables contained the required `CHECK` constraints.
- Complete backend unit gate: **170 suites, 2,006 tests passed** (including the
  Growth role bootstrap CLI check).
- Backend security gate: **29 suites, 198 tests passed**.
- Focused auth/analytics/Growth regression: **11 suites, 92 tests passed**.
- Backend test discovery: **177 tracked files, 177 with exactly one execution
  home**; 2 quarantined files remain within the existing allowance.

## Phase 3 merge and post-merge release evidence

- `PR_37_STATE`: `MERGED`
- `PR_37_HEAD`: `0f09704` (`feat(growth-os): ship prospect ledger and operator bootstrap`)
- `PR_37_MERGE_SHA`: `974533af5e9783100dbf7db8b00f775623e3d5a1`
- PR #37 remote gates passed: Test & Build Gate, PostgreSQL/Redis integration,
  Meta-shaped E2E, security scan, Growth OS build, deployment dry run, and
  no-push Docker validation.
- `PR_38_STATE`: `MERGED` — release-state evidence documentation;
  `PR_38_MERGE_SHA`: `52819cc07098863ede1adef2a89cfa479cd096d9`.
- `PR_39_STATE`: `MERGED` — corrected the production DB probe's image path;
  `PR_39_MERGE_SHA`: `f3c1b6314ee467f4ffa3d2fd9444706fe67443ae`.
- `PR_40_STATE`: `MERGED` — made the production DB probe standalone and added
  regression coverage; `PR_40_MERGE_SHA`:
  `0e1251c73ba9d1d56f8e27344eb0b72ca8a6aabf`.
- `PR_42_STATE`: `MERGED`.
- `PR_42_HEAD`: `a673aa5204485e22613313ff14eb1b6976af8549`.
- `PR_42_MERGE_SHA`: `c65919238b608b5329aa0c152be4387dbafbfb67`.
- `PR_42_MERGE_METHOD`: `SQUASH`.
- `PR_42_MERGED_SHA_E2E_RUN`: `32412540978` passed; the browser gate reported
  12 of 12 Chromium scenarios.
- `PR_42_MERGED_SHA_CI_RUN`: `32412540977` passed; image publication completed
  and the deploy job was skipped.
- Growth image publication run `32412540978` passed after the merge.
- `PR_42_GHCR_IMAGE_GROWTH_CANDIDATE`: `ghcr.io/mr3826/easymoderator-growth-os@sha256:353e55de49eff657e9304c54e10b54ce005a8ffdd22ea82eab400f74e7d506c0` (historical; superseded by the PR #43 publication below).
- `PR_43_STATE`: `MERGED`.
- `PR_43_HEAD`: `f808e5913932a6c2ec3b65bd61fc3d1909ce024b`.
- `PR_43_MERGE_SHA`: `ff33c056c3e3c8a0ffd80b92e30f9589c05486fa`.
- `PR_43_MERGE_METHOD`: `SQUASH`.
- `PR_43_MERGED_SHA_CI_RUN`: `32449959064` passed; Test & Build, Meta-shaped E2E, PostgreSQL/Redis integration, deployment configuration, and Build & Push passed; Docker build validation (no push) and `Deploy to DO Droplet` were skipped.
- `PR_43_MERGED_SHA_GROWTH_RUN`: `32449958917` passed; Growth typecheck/tests/build, browser E2E reported 12 of 12 Chromium scenarios, and Growth image publication passed.
- `PR_43_MERGED_SHA_SECURITY_RUN`: `32449958900` passed; historical secret scan and production dependency audit passed.
- `PR_43_GROWTH_RUNTIME_SOURCE_SHA`: `c65919238b608b5329aa0c152be4387dbafbfb67` — PR #43 changed no `EasyMod-growth/**` files; `ff33c056c3e3c8a0ffd80b92e30f9589c05486fa` is the later deploy/CI/docs SHA.
- `PR_43_GROWTH_IMAGE_DIGEST`: `ghcr.io/mr3826/easymoderator-growth-os@sha256:353e55de49eff657e9304c54e10b54ce005a8ffdd22ea82eab400f74e7d506c0` (verified 64-hex first-rollout candidate for runtime source SHA `c65919238b608b5329aa0c152be4387dbafbfb67`; the invalid 63-hex handoff value is rejected).
- `PR_44_STATE`: `MERGED`.
- `PR_44_HEAD`: `82ba19f97fcfb0c87a4f118fb7ed409cec435a18`.
- `PR_44_MERGE_SHA`: `0f327dd4728c649a3ed849f6915043f0410af278`.
- `PR_44_MERGE_METHOD`: `SQUASH`.
- `PR_44_MERGED_SHA_CI_RUN`: `32456686329` passed; deployment configuration dry run, including the executable rollback rehearsal, passed; Build & Push passed; Docker build validation (no push) and `Deploy to DO Droplet` were skipped.
- `PR_44_MERGED_SHA_CI_JOB`: `96695826601` passed; the rehearsal receipt was uploaded.
- `PR_44_MERGED_SHA_SECURITY_RUN`: `32456686304` passed; historical secret scan and production dependency audit passed.
- `PR_44_ROLLBACK_REHEARSAL_ARTIFACT`: `rollback-rehearsal-evidence` (`659` bytes, unexpired).
- `PR_44_ROLLBACK_REHEARSAL_RECEIPT_SHA256`: `160f59bd56257807aeaba18ad40e727c37e73720dbf978ce8d19b282b275dccb`.
- `PRODUCTION_DEPLOY_ENABLED`: `false`.
- `GROWTH_BOOTSTRAP_DIGEST`: `ABSENT`.
- `PR_44_ROLLBACK_REHEARSAL`: `PASS` — the merged-SHA receipt reports candidate verification rejection, previous digest-pinned backend/frontend restoration, matching environment hashes, byte-identical Compose/Caddyfile restoration, backend `/health/ready` and `/health` success, frontend health success, and missing-previous-image rejection; it does not prove the production topology or run `migrate:down`.
- `PRODUCTION_PREFLIGHT_RUN`: `32413675729` passed in read-only probe mode;
  production environment rendering, SSH, DB host resolution, TCP connectivity,
  expected database name, DB authentication, and `SELECT 1` all passed.
- `PRODUCTION_DROPLET`: DigitalOcean read-only API confirmed active droplet
  `easymod-prod` (`id=572180595`, `139.59.249.141`).
- `CORS_ORIGINS_PREREQUISITE`: `CLOSED` — repository variable
  `CORS_ORIGINS` now contains `https://app.easymod.tech` and
  `https://growth.easymod.tech`; it still excludes the marketing origin.
- `GROWTH_DNS_TLS_GATE`: `OPEN` — `growth.easymod.tech` resolves to
  `139.59.249.141`, but HTTPS still fails with `tlsv1 alert internal error`
  (TLS alert 80). Caddy on the droplet has no certificate for the Growth SNI
  because its deployed `Caddyfile` predates the Growth site block, and that
  file is synced inside the gated deploy. TLS is therefore a post-deploy
  validation and cannot be closed beforehand.
- `FIRST_GROWTH_ROLLOUT`: `NOT RUN` — the image is published but not pinned on
  the droplet; `PRODUCTION_DEPLOY_ENABLED` remains `false`.
- `OPERATOR_BOOTSTRAP`: `NOT RUN` — no Founder target credentials or live
  authenticated bootstrap session were available.
- `PHASE_3_BROWSER_WALKTHROUGH`: `NOT RUN` — the host is not live.
- `ROLLBACK_REHEARSAL`: `PASS` — merged SHA `0f327dd4728c649a3ed849f6915043f0410af278`; CI run `32456686329`, deployment-config job `96695826601`, artifact `rollback-rehearsal-evidence`, receipt SHA256 `160f59bd56257807aeaba18ad40e727c37e73720dbf978ce8d19b282b275dccb`.

## First-rollout digest pin

The first Growth rollout must be hand-pinned with the exact image built from
`origin/main` at `e455b0c` before any separately authorized deploy. The source
delta check `git log c65919238b608b5329aa0c152be4387dbafbfb67..origin/main --
EasyMod-growth` is empty, but an exact publication is still required because
the Docker build embeds its SHA in `dist/build-info.json`.

The exact publication completed through workflow dispatch:

- `GROWTH_IMAGE_PUBLICATION_RUN`: `32477273787`
- `GROWTH_IMAGE_BUILD_JOB`: `96756642973`
- `GROWTH_IMAGE_BUILD_SHA`: `e455b0c69ce8aca1a18d7dc4085f1cd6854d25d0`
- `GROWTH_IMAGE_TAG`: `e455b0c69ce8aca1a18d7dc4085f1cd6854d25d0`
- `GROWTH_IMAGE_DIGEST`: `sha256:7421a9b49792fb02d6f8c18acd9d5a547966684529c8dfaa1df8629bdff02b00`
- `GROWTH_IMAGE_BUILD_INFO`: run log confirms `VITE_BUILD_SHA=e455b0c...`
- `GROWTH_IMAGE_IMMUTABLE_CHECK`: `PASS` — bare digest is 64 hex characters

The previous `ff33c056` and `c659192` image digests remain historical evidence
only. The local Docker Desktop daemon was unavailable for the optional pull and
`docker image inspect` cross-check; the authoritative digest is the successful
GHCR push step's digest from the exact-SHA run. The following operator commands
remain prepared only; they were not executed:

```bash
cd /opt/easymod
docker pull ghcr.io/mr3826/easymoderator-growth-os:e455b0c69ce8aca1a18d7dc4085f1cd6854d25d0
test "$(docker image inspect -f '{{index .RepoDigests 0}}' ghcr.io/mr3826/easymoderator-growth-os:e455b0c69ce8aca1a18d7dc4085f1cd6854d25d0)" = "ghcr.io/mr3826/easymoderator-growth-os@sha256:7421a9b49792fb02d6f8c18acd9d5a547966684529c8dfaa1df8629bdff02b00"
```

After separate authorization, set `GROWTH_BOOTSTRAP_DIGEST` to this verified
bare digest, confirm the droplet pulled the same immutable reference, and clear
the variable after a successful rollout. It remains unset until the human gate
opens.

## Phase A-C pre-deploy receipts

These receipts were collected on `2026-08-21`. No deploy, DNS/TLS change,
Founder credential handling, or production data mutation occurred. The restore
drill used a temporary container, volume, and network and removed all three in
its trap-guarded teardown.

- `PHASE_A_PREFLIGHT_GATE`: `PASS` for pre-deploy lanes 1-4; the restore-drill
  workflow is now published on `main`
- `DIGEST_AUTHORITY`: `PASS` — exact-SHA publication run `32477273787` produced
  `sha256:7421a9b49792fb02d6f8c18acd9d5a547966684529c8dfaa1df8629bdff02b00`
- `PRODUCTION_DIGEST_CAPTURE`: `PASS` — backend rollback ref
  `ghcr.io/mr3826/easymod-backend@sha256:016272e5ee91f821ef27f9a93cc07874036a567bc22fa1f1973193bde0921b18`
  and frontend rollback ref
  `ghcr.io/mr3826/easymod-frontend@sha256:496aac5a73e954ed8d08f94250bbaddc5321f6a63555e81c139acab0d3db6fc5`
  were captured with `docker inspect`; Growth was confirmed absent
- `BACKUP_READINESS`: `PASS` — published-main workflow dispatch run
  `32484826577` (backup job `96778894448`, restore job `96778894595`), resolved
  `/opt/easymod/backups/easymod-20260821-025646.dump`, and reported
  `RESTORE_ROW_COUNT_users=2`, `RESTORE_ROW_COUNT_shops=2`, Growth tables absent,
  `RESTORE_MAX_MIGRATION=20260726_001_meta_webhook_receipts`,
  `RESTORE_PG_RESTORE=PASS`, and
  `PRODUCTION_POSTGRES_UPTIME_UNCHANGED=PASS`; isolated container, volume, and
  network teardown completed successfully
- `DEPLOY_PATH_INTEGRITY`: `PASS` — validator returned
  `rollback-contract=PASS`; `production` now has required reviewer `mr3826` and
  protected-branch policy; `main` requires pull requests, admin enforcement,
  conversation resolution, strict `Test & Build Gate`, `Growth OS build gate`,
  and `Growth OS browser E2E gate` checks, with required approvals set to `0`,
  force-push and deletion disabled;
  required secret names passed, `PRODUCTION_DEPLOY_ENABLED=false`, and
  `GROWTH_BOOTSTRAP_DIGEST` is absent. Single-maintainer review is structurally
  unavailable; the `production` environment reviewer gate with
  `prevent_self_review=false` remains the human checkpoint.
- `DNS_HTTP_BASELINE`: `PASS` — expected hosts resolve to `139.59.249.141` and
  HTTP redirects to HTTPS
- `GROWTH_TLS_ISSUANCE`: `DEFERRED_TO_POST_DEPLOY` — the pre-deploy TLS failure
  is circular by design because the Growth Caddy block is delivered and reloaded
  only by the gated deploy; no pre-deploy TLS failure is counted against Phase A
- `PHASE_B_POST_DEPLOY_GATE`: `OPEN` — Growth TLS issuance, live
  Growth-origin browser walkthrough, and operator bootstrap remain pending
- `PRODUCTION_DEPLOY_ENABLED`: `false` confirmed by names-only repository
  variable inspection
- `GROWTH_BOOTSTRAP_DIGEST`: absent during preflight
- `HUMAN_AUTHORIZATION_GATE`: closed

PR #46 CI run `32484251281`, Growth OS run `32484251140`, and Security run
`32484251127` passed with deployment and image publication skipped for the PR.
The post-merge restore run `32484826577` also passed. These checks and receipts
do not authorize the live rollout.

## Phase 3 prospect foundation hardening

The merged Phase 3 implementation had confirmed defects in source scoping,
redaction, phone normalization, linkage authorization, assignment validation,
source-reference tombstones, timeline bounds, duplicate conflict handling, and
diagnostic error visibility. The hardening implementation is the focused remediation; it
does not rebuild the already-merged prospect foundation.

- `HARDENING_BRANCH`: `codex/growth-os-phase-3-prospect-hardening`
- `HARDENING_BASE`: `930005db170761a472576e597df900bc77dc67bd`
- `HARDENING_PR_STATE`: `MERGED — PR #42 squash-merged as
  c65919238b608b5329aa0c152be4387dbafbfb67`
- `REPOSITORY_VISIBILITY`: `PUBLIC — verified with gh repo view`
- `HARDENING_PRODUCTION_CHANGED`: `NO`
- `HARDENING_DNS_CHANGED`: `NO`
- `HARDENING_BROWSER_E2E`: `PASS remotely — merged SHA c65919238b608b5329aa0c152be4387dbafbfb67; Growth OS browser E2E run 32412540978 reported 12/12 Chromium scenarios; live Growth-origin browser/DNS/TLS remains open`
- Server enforcement now restricts marketer source rows, redacts notes/metadata
  and timeline private fields, gates linkage suggestions, permits read-assigned
  without mutation permission, requires active Growth roles for owners, and
  requires explicit CLI audit actors.
- Data integrity now preserves non-Bangladesh phone digits, excludes merged
  tombstones from source-reference deduplication, bounds timeline pages, and
  returns consistent duplicate conflicts through global error handling.
- Growth UI now sends explicit nulls for cleared edit fields, routes endpoint
  `401`/`403`/`503` responses through `GrowthAuthProvider`, follows the legal
  lifecycle map, gates the prospect sidebar, validates UUID inputs, and caps
  mutation reasons at 200 characters.
- Local hardening validation: focused prospect gate **6 suites, 41 tests
  passed**; full backend unit gate **174 suites, 2,027 tests passed**; backend
  security gate **29 suites, 203 tests passed**; test-discovery guard **181
  tracked files, 181 with exactly one execution home**; disposable PostgreSQL/
  Redis integration **4 suites, 35 tests passed**, including migration
  `20260820_003` and importer re-linking; Growth frontend gate **6 files, 34
  tests passed with TypeScript check**; Growth production build passed; merchant
  frontend gate **59 files, 483 tests passed**; backend syntax/build passed.
- Disposable Growth browser gate: `npm run test:growthos:e2e` passed **12 of 12
  Chromium scenarios** across prospect workflows, role/scoped permissions,
  mocked and real failure states, and 390px/768px/1440px responsive layouts.
  The runner completed migrations and fixture seeding against disposable
  PostgreSQL/Redis services and removed the owned containers, volumes, and
  network during teardown; no production service or data was touched.
- `HARDENING_REMOTE_CI`: `PASS — merged SHA c65919238b608b5329aa0c152be4387dbafbfb67 passed Growth OS build, browser E2E run 32412540978 (12/12), CI run 32412540977, historical secret scan, dependency audit, backend integration, Meta-shaped E2E, deployment dry run, and Test & Build; the Growth image was published and deployment was skipped`
- The merged hardening implementation remains separate from the Phase 2
  Cloudflare credential recovery and release verdict block above. No DNS, deploy,
  bootstrap, or production data action was authorized by this state update.

## Known limitations and pre-existing debt

- The historical Phase 2 receipt said `docs/growth-os/GROWTH_OS_GOAL.md` and
  `CURRENT_STATE.md` were absent. The current repository contains the tracked
  `GROWTH_OS_GOAL.md` and `GROWTH_OS_CURRENT_STATE.md`; this receipt is retained
  as history and the reconciliation appendix is the current platform record.
- Node `v25.6.1` is newer than the repository's Node 20 engine. The local unit/security gates pass, but runs without Redis emit pre-existing post-test BullMQ/ioredis `ECONNREFUSED` logs; the disposable PostgreSQL/Redis gate passes with Redis available.
- The two existing quarantine suites remain unrelated debt: the chatbot suite currently assumes a legacy route, and the smart-payment suite requires an unsupported CommonJS/ESM Chai load. They remain within the tracked quarantine allowance and were not changed by Phase 3.
- Meta-shaped E2E remains an open pre-existing gate and does not provide live Growth-origin browser proof in this worktree. It is intentionally not represented as a Phase 3 pass.
- A full Gitleaks history scan cannot traverse the linked-worktree `.git` pointer. The bounded changed-code scans passed. A whole-worktree scan reports the pre-existing public Resend DKIM TXT record in `docs/launch/cloudflare-zone-records.txt` as a generic-key false positive; it was not changed.
- No production deployment, DNS/TLS change, live browser session, operator bootstrap, or production data mutation was performed; the Growth image was published and the later production preflight was read-only.
- Remote CI and draft PR checks passed on PR #35; Phase 3 remote CI/build gates passed on PR #37, #39, and #40; merged PR #42 passed its remote browser gate in run 32412540978 and CI run 32412540977; merged PR #44 passed CI run 32456686329, Security run 32456686304, and rollback rehearsal job 96695826601 with receipt hash 160f59bd56257807aeaba18ad40e727c37e73720dbf978ce8d19b282b275dccb. Live Growth-origin browser parity, DNS/TLS, operator bootstrap, and production delivery remain unverified; the disposable browser and rollback rehearsals are not live-host receipts.

## Phase 3 implementation

Implemented the canonical two-table prospect ledger and its internal operator
surface:

- PostgreSQL migration with named checks, scope/query indexes, and partial
  unique identity indexes;
- lazy-loaded Sequelize prospect/event entities and associations;
- pure phone/email/page/business normalization and deterministic lifecycle;
- repository-enforced all, assigned, and redacted source scopes;
- transactional create/edit/status/assignment/link/merge services writing both
  product events and platform audit rows;
- GET duplicate preflight and linkage suggestions with targeted rate limiting;
- dry-run-by-default historical importer for `crm_lead` and Partner rows;
- Growth list/detail/create/edit pages, permission UX guards, redacted rendering,
  timeline, assignment, linkage, merge, and Vitest/jsdom setup;
- backend unit/security/migration/integration/import tests and Growth UI/client
  tests.

Merchant signup/Partner producers, subscriptions, billing, and merchant
frontend were not changed by the prospect implementation. PR #44 later added
only the non-production rollback-rehearsal CI wiring.

## Deferred Growth OS debt

The following remain explicitly deferred and were not expanded by the hardening
implementation: unindexed `%LIKE%` linkage suggestions; no `pg_trgm` index for `q`
search; punctuation-normalized business-name search gaps; IP-only rate limits covering
only a subset of routes; entity/migration index drift; missing role DDL checks
and partial indexes on the `db:sync` path; and the `merged_into_id ON DELETE SET
NULL` conflict with the merge check. Outreach, Next Best Action, demos, trials,
retention/churn scoring, referrals/testimonials, and autonomous AI remain Phase
4+ scope.

## Phase 3 development and release gates

The gates are intentionally separate:

- `PHASE_2_IMPLEMENTATION_GATE`: `PASS`
- `PHASE_2_MERGE_GATE`: `PASS — PR #35 squash-merged and verified on main`
- `PHASE_2_PRODUCTION_RELEASE_GATE`: `BLOCKED`
- `PHASE_3_DEVELOPMENT_BLOCKED_BY`: `NONE`
- `PHASE_3_MERGED_IMPLEMENTATION_GATE`: `CORRECTED — merged implementation had confirmed security/correctness defects; the merged hardening implementation addresses them`
- `PHASE_3_IMPLEMENTATION_GATE`: `PASS — local hardening validation and PR #42 remote checks complete on merged SHA c65919238b608b5329aa0c152be4387dbafbfb67`
- `PHASE_3_BROWSER_E2E_GATE`: `PASS remotely — merged SHA c65919238b608b5329aa0c152be4387dbafbfb67; run 32412540978 reported 12/12 Chromium scenarios; live Growth-origin browser/DNS/TLS remains OPEN`
- `PHASE_A_PREFLIGHT_GATE`: `PASS — exact digest, incumbent rollback refs, isolated restore, deploy protections, required names-only configuration checks, and the published restore-drill workflow are evidenced`
- `FIRST_GROWTH_ROLLOUT_DIGEST_GATE`: `PASS — exact e455b0c publication run 32477273787 produced digest sha256:7421a9b49792fb02d6f8c18acd9d5a547966684529c8dfaa1df8629bdff02b00`
- `PRODUCTION_DIGEST_CAPTURE_GATE`: `PASS — backend/frontend incumbent refs are digest-pinned and Growth is absent, so the bootstrap path is confirmed`
- `BACKUP_RESTORE_GATE`: `PASS — published-main run 32484826577 / job 96778894595 restored the resolved dump, reported users 2 and shops 2, confirmed Growth tables absent and unchanged production PostgreSQL uptime, and cleaned all temporary resources`
- `DEPLOY_PATH_INTEGRITY_GATE`: `PASS — rollback contract, production reviewer policy, protected main branch with zero required approvals and strict required checks, and required secret names are verified`
- `DNS_HTTP_BASELINE_GATE`: `PASS — DNS and HTTP redirect baseline recorded`
- `GROWTH_TLS_ISSUANCE_GATE`: `OPEN — post-deploy Caddy certificate issuance and HTTPS validation are required because the Caddy Growth block is delivered by the gated deploy`
- `PHASE_B_POST_DEPLOY_GATE`: `OPEN — Growth TLS, live Growth-origin browser walkthrough, and operator bootstrap remain pending`
- `PHASE_C_PUBLICATION_GATE`: `PASS — PR #46 merged as `cf634fab5d47477f9cda4113237561471454a8ae`; the restore mechanism was dispatched from that merged `main` and passed`
- `OPERATOR_BOOTSTRAP_GATE`: `OPEN — Founder/operator bootstrap remains unclaimed`
- `PRODUCTION_BROWSER_E2E_GATE`: `OPEN — no live Growth-origin browser receipt`
- `ROLLBACK_REHEARSAL_GATE`: `PASS — merged SHA 0f327dd4728c649a3ed849f6915043f0410af278; CI run 32456686329; deployment-config job 96695826601; artifact rollback-rehearsal-evidence; receipt SHA256 160f59bd56257807aeaba18ad40e727c37e73720dbf978ce8d19b282b275dccb`
- `OVERALL_GROWTH_OS_RELEASE_VERDICT`: `NO-GO`

Phase 3 implementation and the disposable local and remote browser gates are
complete for the development gate. The pre-deploy rollout gate is now
evidenced, but live Growth-origin TLS/browser delivery, operator bootstrap,
rollback rehearsal and production delivery remain open and must not be
represented as passed by this phase. The restore mechanism remains a release
precondition, not authorization to deploy.

## Growth OS current-state determination

- `CURRENT_STATE_DOCUMENT`: `docs/growth-os/GROWTH_OS_CURRENT_STATE.md` — current-state
  determination dated 2026-08-22; evidence basis is the merged Phase 3 line, not the
  stale `easy-moderator` checkout.
- `CURRENT_STATE_VERIFICATION`: read-back and citation review only. Cited paths, gate
  values, and backlog gate effects were spot-checked against this checkout; the document
  is ASCII-only. No application test, production host, database, or live gate was
  exercised by it.
- `CURRENT_STATE_VERDICT`: `NOT READY` — consistent with
  `OVERALL_GROWTH_OS_RELEASE_VERDICT: NO-GO`; it closes no gate and changes no gate value.
- `CURRENT_STATE_OPEN_ACTS`: first Growth rollout, Founder bootstrap, and the live
  `growth.easymod.tech` browser walkthrough remain the three open release acts.

## Historical platform audit reconciliation (2026-09-21)

This appendix is the current platform-audit receipt. Earlier dated receipts and
their cited historical SHAs remain unchanged and are not rewritten.

```text
AUDIT_DATE=2026-09-21
CURRENT_MAIN=cf57db1e4706c9d7b3b32f180e1dbede3b64e7c4
GROWTH_PR_HEAD=1f4cd9de398f9814a2e8dc2cb69fe22b83bc1f05
PRODUCTION_DEPLOYMENT_SHA=cf57db1e4706c9d7b3b32f180e1dbede3b64e7c4
PRODUCTION_DEPLOY_ENABLED=false
GROWTH_WORKFLOW_BOUNDARY=SEPARATE_PATH_FILTERED_PUSH_AND_WORKFLOW_CALL
GROWTH_LIVE_ORIGIN=NOT_VERIFIED
GROWTH_OPERATOR_BOOTSTRAP=NOT_VERIFIED
GROWTH_NATIVE_PRODUCTION_DIGEST=NOT_VERIFIED
GROWTH_RELEASE_VERDICT=NO-GO / NOT READY
```

The old `CURRENT_MAIN`, worktree, and live-gate values above this appendix are
historical evidence. The current code still contains the Growth OS surface and
its separate verification/publish workflow, but this audit found no new live
Growth-origin browser, TLS, Founder bootstrap, or operator-delivery receipt.
The production deploy gate was explicitly restored to `false` after the latest
manual deployment run.

## Post-reconciliation state (2026-09-23)

The dated audit above remains historical. After PR #127 was validated and merged,
the authoritative main ref became `45f651927aae21db5aea9de62c675cbb6f8e5bbb`.
The production deployment receipt remains the earlier `cf57db1e...` record;
no deployment is inferred from the merge.

## Branch Validation Receipt / Status (2026-09-14)

This is an additive receipt for the current development branch. Historical
phase, release, and audit records above are preserved and are not reclassified
by this section.

- `BRANCH`: `feat/growth-os-internal-control-plane`
- `HEAD`: `d76877d`
- `BASE`: `origin/main` at `77790a8`
- `WORKTREE`: `DIRTY` — pre-existing implementation, test, workflow, package, and historical-doc changes were not modified by this docs pass
- `SOURCE_OF_TRUTH`: current executable code and current test/validation receipts; older plans remain historical
- `DOCS_ONLY_PASS`: `YES` — this pass changed only the four permitted Growth OS documentation files; pre-existing code, test, workflow, and package changes were left untouched
- `PRODUCTION_COMMANDS`: `NOT_RUN`
- `DEPLOYMENT_STATUS`: `NOT_DEPLOYED_TO_PRODUCTION`
- `PRODUCTION_MUTATED`: `NO`
- `META_REVIEW_CONFIGURATION_CHANGED`: `NO`
- `PRODUCTION_WORKFLOW_OR_CONFIG_MUTATED`: `NO`
- `LOCAL_DOC_VALIDATION`: `READ-ONLY SOURCE REVIEW; no application test, build, migration, browser, or deployment command was run by this documentation pass`
- `PRIOR_EXTENSION_RECEIPT`: `31 tests passed, 0 failed` — implementation transcript receipt; not rerun by this documentation pass
- `PRIOR_BACKEND_GROWTH_RECEIPT`: `7 suites, 58 tests passed` — implementation transcript receipt; not rerun by this documentation pass
- `PRIOR_CONTROL_PLANE_INTEGRATION_RECEIPT`: `18/18 passed` — implementation transcript receipt; not rerun by this documentation pass
- `ACCESS_AND_PROSPECT_INTEGRATION_FINAL_RECEIPT`: `TO BE FILLED BY LEAD`
- `BROWSER_E2E_FINAL_RECEIPT`: `TO BE FILLED BY LEAD`; no claim that all E2E passed is made here
- `FINAL_BRANCH_VALIDATION_RECEIPT`: `TO BE FILLED BY LEAD` after the final affected suites are rerun; prior receipts above are not a current all-pass claim

## Targeted Growth-user creation diagnosis receipt (2026-09-14)

- `TARGETED_BROWSER_E2E`: `PASS` — `npx playwright test tests/e2e/admin-journey.spec.ts --project=chromium --no-deps --grep "super creates a growth user" --trace on`; 1 Chromium scenario passed against an isolated disposable PostgreSQL/Redis stack.
- `FAILURE_WIRE_EVIDENCE`: the failing POST returned `400` with `GROWTH_OS_WORK_INVALID_INPUT` and `"email" must be a valid email`; the initial user-list GET returned `500` with `column reference "is_active" is ambiguous`.
- `FAILURE_TRACE`: `EasyMod-growth/test-results/admin-journey-super-create-f2d68-finds-it-in-the-grant-table-chromium/trace.zip` and its `error-context.md` capture the failed UI state and both server errors.
- `FIX_SCOPE`: qualified the Growth role ordering expression, aligned Growth user email validation with the existing syntactic email policy, and corrected the E2E assertion to the established `GROWTH USER` rendered label.
- `PRODUCTION_CHANGED`: `NO` — only disposable local services and database resources were used; no production configuration or service was touched.

## Targeted Cleanup Receipt (2026-09-14)

- `REFERENCE_AUDIT`: `DashboardPage` had no route import; its only code consumer
  was a stale `App.test.tsx` mock, and its CSS selectors were otherwise
  unreferenced. `eligibleForNextPhase` had no frontend type, client, or UI
  consumer; it was only emitted by the mapper and asserted by stale tests.
- `CLEANUP`: removed the orphaned dashboard component and its CSS, removed the
  unconsumed eligibility field and related assertions, and updated the affected
  Growth OS references.
- `EXTENSION_GATE`: `npm run test:extension` passed **33/33 tests**, including
  `relay.test.js`; extension runtime files were not changed.
- `GROWTH_FOCUSED_GATE`: affected `App.test.tsx` and
  `ProspectListPage.test.tsx` passed **11/11 tests** with one Vitest worker.
- `BACKEND_FOCUSED_GATE`: prospect lifecycle suite passed **1 suite, 8 tests**.
- `GROWTH_TYPECHECK`: blocked by pre-existing errors in
  `EasyMod-growth/src/api/client.test.ts:92`; no cleanup file was implicated.
- `PRODUCTION_COMMANDS`: `NOT RUN`; no commit was created.

## Temporary credential hardening receipt (2026-09-14)

- `SCOPE`: generated Growth OS invite/reset passwords only; normal users and
  canonical `SUPER_ADMIN`/`GROWTH_USER` role resolution remain unchanged
- `CONTROL`: `users.must_change_password` plus nullable
  `users.temporary_password_expires_at`; generated credentials expire after 24
  hours, forced sessions cannot access normal routes or refresh, and completion
  clears the state and revokes all sessions
- `MFA_PATH`: TOTP completion preserves the forced-change claim before issuing
  the restricted session
- `UI_PATH`: Growth login redirects restricted sessions to `/change-password`;
  the Growth user-admin reveal displays the expiry and never persists plaintext
- `BACKEND_AUTH_TEST`: `auth.test.js` passed **17/17 tests**, including expiry,
  route blocking, forced completion, and token-version revocation
- `TOTP_TEST`: `totp.service.test.js` passed **7/7 tests**
- `GROWTH_TYPECHECK`: `npm run typecheck` passed
- `GROWTH_VITEST`: the full suite passed **23 files / 122 tests** before the
  later worker/resource-constrained rerun; no assertion failure was reported
- `INTEGRATION_SERVICES`: disposable PostgreSQL `127.0.0.1:55432` and Redis
  `127.0.0.1:56379` were unavailable, so the modified real-database control-plane
  integration was not run
- `MIGRATION`: existing PostgreSQL deployments must run
  `20260914_001_add_temporary_password_controls`; fresh Sequelize sync creates
  the columns from the updated User entity
- `PRODUCTION_CHANGED`: `NO`; no production configuration, deployment, or
  commit was performed

## Backend security-blocker validation receipt (2026-09-15)

- `SCOPE`: backend-only Growth role/membership boundary, shop membership
  transaction safety, credential/session invalidation, TOTP revocation, and
  controlled schema bootstrap; unrelated dirty work was preserved
- `UNIT_REGRESSIONS`: `9 suites / 115 tests` passed, covering shop service/API,
  Growth role/authz/prospect security, auth/session invalidation, TOTP, and
  strict cache behavior
- `GROWTH_INTEGRATION`: affected access/prospect suites `17/17` passed;
  control-plane suite `18/18` passed on disposable PostgreSQL/Redis,
  including temporary-password completion and stale-token rejection
- `MIGRATION_BOOTSTRAP`: `npm run migrate` and `npm run db:sync` completed
  against the tmpfs-backed disposable PostgreSQL database; Growth role,
  prospect/workflow, follow-up, note, and temporary-password schemas were
  present afterward
- `TOTP_DISPOSABLE_CHECK`: real service check passed with `enabled:false`,
  `tokenVersion:1`, and `refreshToken:null` after disable
- `PRODUCTION_CHANGED`: `NO`; disposable containers only, no commit, push,
  merge, deploy, or production connection

## Browser-extension hardening receipt (2026-09-15)

This is an additive receipt for the authorized browser-extension slice. Existing
dirty implementation and workflow changes outside this slice were not modified.

- `EXTENSION_SCOPE`: manual public-web capture only; no cookies/history/tabs
  broad permission, background scraping, API token, outreach, or admin action
  was added.
- `EXTENSION_TEST`: `npm run test:extension` passed **38/38 tests**, including
  social-host rejection, URL credential stripping, popup target-tab cleanup,
  development-manifest target selection, and nonce/origin/path relay checks.
- `EXTENSION_VALIDATION`: `npm run validate:extension` passed; release and
  development manifests remain bounded and all extension JavaScript passed
  syntax validation. No distributable package was produced.
- `GROWTH_CAPTURE_TEST`: focused `CapturePage.test.tsx` passed **10/10 tests**,
  including asynchronous `MessageEvent` delivery, spoofed-message rejection,
  duplicate-integrity UI, storage fallback, and URL credential stripping.
- `GROWTH_TYPECHECK`: `npm run typecheck --workspace=easymod-growth` passed.
- `GROWTH_BUILD`: `npm run build --workspace=easymod-growth` passed.
- `GROWTH_DEV_PORT`: Vite, Playwright, the development extension manifest, and
  the extension's local origin contract use `127.0.0.1:5175`.
- `GROWTH_ORIGIN_CONFIG_TEST`: focused backend origin/CSRF suites passed
  **11/11 tests** after aligning the shared development Growth origin.
- `GROWTH_WORKFLOW_GATE`: `growth-os.yml` now runs extension source validation
  and extension tests in its existing verification job; CI was not triggered.
- `PRODUCTION_CHANGED`: `NO`; no commit, push, merge, deploy, workflow
  dispatch, production connection, or production data mutation occurred.
- `UNRESOLVED`: browser-installed Chromium handoff against the live Growth
  origin remains unverified; the release host/TLS and operator bootstrap gates
  above remain unchanged and open.

## Frontend contract UX hardening receipt (2026-09-15)

This is an additive receipt for the authorized Growth frontend contract slice.
Pre-existing backend, importer, analytics, extension, workflow, and unrelated
frontend changes remain untouched.

- `SCOPE`: permission-set-driven legacy navigation and route guards, Merchant
  360 note-author rendering, duplicate-blocking Quick Add/Capture UX, Growth
  user admin reason/search validation alignment, audit permission alignment,
  and the homepage assigned-prospect destination.
- `GROWTH_FOCUSED_GATE`: **9 files, 54 tests passed**.
- `GROWTH_FULL_GATE`: **23 files, 132 tests passed**.
- `GROWTH_TYPECHECK`: `npm test` completed with `tsc --noEmit` passing.
- `E2E`: not run in this pass; live Growth-origin browser delivery remains
  unverified and the existing release gates remain open.
- `PRODUCTION_CHANGED`: `NO`; no commit, push, merge, deploy, reset, or
  production connection was performed.

## Importer safety receipt (2026-09-15)

- `SCOPE`: Growth prospect importer only; analytics and producer paths were not changed.
- `CONTRACT`: dry-run remains the default; `--apply`, bounded `--batch-size`,
  deterministic source ordering, `--run-id`, and `--receipt` are explicit CLI
  controls.
- `BOUNDED_READS`: CRM and Partner sources use ascending `(created_at, id)`
  keyset pages with required-column projections. User, shop, and owner lookups
  are batch-scoped and exclude passwords, tokens, settings, and unrelated fields.
- `DRY_RUN_DUPLICATES`: in-run source-reference and normalized-identity
  reservations make duplicate input rows deterministic without writes.
- `APPLY_SAFETY`: per-row service transactions retain database unique constraints
  and unique-constraint conflict handling for concurrent apply runs.
- `RESTART_SEMANTICS`: receipts are durable JSON execution records; restart is
  intentionally idempotent reprocessing, not checkpoint resumability.
- `FAILURE_CONTRACT`: row failures are retained in the receipt and the CLI exits
  nonzero when any row fails.
- `HISTORICAL_MAPPING`: source timestamps and valid historical statuses are
  preserved; inactive shops do not force conversion. Import run IDs are present
  in prospect event and audit metadata.
- `VALIDATION`: importer-focused integration tests and changed-file syntax checks
  were run for this worktree; exact command results are recorded in the handoff
  response for this task.

## Phase 2 analytics integrity receipt (2026-09-15)

- `SCOPE`: Growth analytics backend/workspace, funnel contracts, Growth analytics
  labels/types/tests, and metrics definitions only; importer files were not changed.
- `ACTIVATION_DEFINITION`: canonical Growth activation is a non-merged prospect
  in `converted` status linked to an active merchant/shop. First successful AI
  reply is recorded separately as `shop.settings.first_ai_reply` and is not activation.
- `FUNNEL_INTEGRITY`: merged tombstones are excluded from status/source/lost
  denominators; imported cohorts use `source_recorded_at`, while `created_at`
  remains import arrival time and prospect-event `created_at` remains event time.
- `TIMING_INTEGRITY`: unordered `limit: 500` timing reads were replaced with
  ordered, uncapped reads and deterministic in-process first-event aggregation.
- `METRICS`: qualification timing, first-follow-up timing, lost-reason counts,
  source-to-activation rates, and lead-to-activation are returned from available
  ledger/event fields; unavailable metrics remain explicit in `notAvailable`.
- `EVENT_SECURITY`: public funnel ingestion is limited to `landing_view` and
  `signup_started`; privileged lifecycle events require the trusted server
  producer API and accepted rows include actor/correlation metadata where present.
- `BACKEND_TEST`: focused analytics/security suites passed **5 suites, 40 tests**
  (`growth-metrics`, `funnel-events`, funnel route security, workspace analytics,
  and Growth authorization scope coverage).
- `GROWTH_TEST`: focused `AnalyticsPage` and `SourcesPage` tests passed **2 files,
  9 tests**; Growth TypeScript check passed.
- `SYNTAX`: changed analytics/prospect/merchant backend JavaScript syntax checks passed.
- `DIFF_SCOPE`: no commit, push, importer modification, deployment, or production
  connection was performed.

## Phase 2 funnel producer boundary receipt (2026-09-15)

- `CALL_SITE_AUDIT`: every production internal funnel producer now calls
  `recordInternalFunnelEvent`; the public analytics controller is the only
  production caller of `recordFunnelEvent`.
- `PRODUCERS`: audited signup completion, inbound consent, AI reply, order,
  RTO, partner, top-up, plan/usage, and renewal success/failure paths.
- `BEST_EFFORT`: existing catch-and-log/swallow behavior was preserved at each
  producer; no producer failure is promoted into the business operation.
- `TEST`: analytics and producer regression command passed **14 suites, 222
  tests** with `--forceExit`; existing local Redis/BullMQ connection-refused
  diagnostics were emitted by worker initialization.
- `SYNTAX`: all changed analytics and producer JavaScript files passed
  `node --check`; `git diff --check` passed.
- `TRUSTED_API_ASSERTION`: funnel service tests verify privileged events reject
  the untrusted API and trusted internal writes retain actor/correlation metadata.
- `PRODUCTION_CHANGED`: `NO`; no importer file, commit, deployment, or
  production connection was changed.

## Final local verification receipt (2026-09-15)

- `IMPORTER_UNIT`: `PASS` — importer contract, 1 suite / 3 tests.
- `ANALYTICS_FOCUSED`: `PASS` — 3 suites / 23 tests; producer regression run,
  14 suites / 222 tests.
- `BACKEND_BUILD`: `PASS` — backend build syntax check.
- `GROWTH_UNIT_TYPECHECK`: `PASS` — 23 files / 133 tests and TypeScript check.
- `GROWTH_BUILD`: `PASS` — production Vite build.
- `EXTENSION`: `PASS` — 38/38 tests and manifest/source validation.
- `DISPOSABLE_INTEGRATION`: `PASS` — 14 suites / 86 tests with PostgreSQL and
  Redis containers cleaned up by the harness.
- `PLAYWRIGHT_E2E`: `FAIL` — 22 passed, 3 failed, 4 dependent scenarios not
  run. Failures are in the admin temporary-session flow, lifecycle status-option
  flow, and masked-merchant copy assertion; artifacts remain under
  `EasyMod-growth/test-results`.
- `BACKEND_DEFAULT_UNIT`: `FAIL/BLOCKED` — the default run reported 224 suites
  passed but failed test discovery for five untracked tests and a Redis-dependent
  grounding timeout. An exclusion run reported 226 suites passed and 17
  disposable/environment-dependent suites failed without configured services;
  the dedicated disposable integration gate passed.
- `TEST_DISCOVERY`: `BLOCKED` — five intended backend test files remain
  untracked. No files were staged merely to hide this state.
- `DIFF_CHECK`: `PASS` — `git diff --check`.
- `PRODUCTION_CHANGED`: `NO`; no commit, push, deployment, production
  connection, or production data mutation occurred.

## Stabilization checkpoint receipt (2026-09-15)

- `START`: branch `feat/growth-os-internal-control-plane`, head
  `d76877dc7329a74fc18f369d968d39234ac0cb2b2`, base
  `77790a833da372a03899686a365d7a40b2a95a67`, 117 tracked changes, 34
  untracked paths, 2 deletions, and 0 staged paths.
- `CLASSIFICATION`: every starting path was classified; no unknown or
  unrelated path was found. The attachment upload tree was generated test
  output, removed, and ignored. The deleted Dashboard page remains deleted;
  the deleted prospect E2E was superseded while its missing filter coverage
  was restored in the replacement lifecycle spec.
- `BACKEND`: full controlled unit suite `229/229` suites and `2819/2819`
  tests; security `49/49` suites and `452/452` tests; backend build and test
  discovery passed. Unit verification explicitly unset the ambient local
  Redis URL because the unit contract is no-Redis.
- `INTEGRATION`: disposable PostgreSQL/Redis `14/14` suites and `87/87`
  tests; the healthy migration plus schema-drift audit passed on a fresh
  loopback-only database. Meta-shaped disposable E2E passed `43/43` tests.
- `GROWTH`: frontend `23/23` files and `133/133` tests, TypeScript, and
  production build passed. Main frontend passed `68/68` files and `575/575`
  tests plus its production build.
- `PLAYWRIGHT`: full Growth browser run passed `32/32` tests with the opt-in
  headed Chromium extension check enabled. It includes access, lifecycle,
  duplicate prevention, follow-up, activation, administration, Merchant 360,
  stale-session, and real extension relay coverage.
- `EXTENSION`: `38/38` automated tests, manifest/source validation, and a
  headed Chromium load-unpacked relay probe passed. Release permissions remain
  `activeTab`, `scripting`, and `storage` with first-party Growth hosts only;
  no distributable package is produced by this repository.
- `SECURITY_FIXES`: privileged Growth mutations remain audit fail-closed;
  audit reads are server-authorized; credit grants use transactional
  idempotency keys for same, concurrent, retry, conflict, and distinct-key
  cases; audit reason/value redaction is centralized; sensitive auth/Growth
  responses are `no-store`; self-lockout and shop-creation races are guarded.
- `CI`: `PASS` on draft PR #127 at the pushed checkpoint: Security Scan,
  Test & Build Gate, backend integration, Meta-shaped E2E, Growth build and
  browser gates, frontend Playwright, deployment dry run, Docker no-push
  validation, and PR Merge Gate all passed. Image publication and production
  deployment were skipped.
- `PRODUCTION_CHANGED`: `NO`; no production connection, mutation, deployment,
  Meta review configuration, OAuth configuration, webhook configuration, or
  secret was changed.

## Independent re-verification receipt (2026-09-15)

- `ACTUAL_START`: the supplied dirty snapshot was already superseded in this
  worktree. The actual start was clean at `1332005e4b7031e39dfa135a49bb6e81b82c20d2`,
  with zero staged, modified, deleted, or standard untracked paths. The full
  feature diff against `origin/main` contains 186 classified paths: 97 feature,
  74 test, 7 migration, and 8 documentation paths; zero artifact, accidental,
  unrelated, or unknown paths.
- `BASELINE`: the first Growth run had one suite-load timeout in
  `ChangePasswordPage` (`132/133`); the isolated test, one-worker suite, and two
  subsequent canonical runs passed. An unisolated aggregate also hit the known
  grounding timeout while inheriting local Redis. These were classified as
  environment/resource failures, not feature assertions.
- `STABILIZATION_FIX`: removed search-term email, phone, and page-URL exposure
  from SPA query parameters. Global search and user-result navigation now use
  router state; Growth user search terms use a CSRF-protected POST body, and the
  legacy query form is rejected. The affected unit, API, RBAC, and browser
  assertions verify that sensitive terms stay out of URL and access-log paths.
- `FULL_REGRESSION`: after the privacy fix and with the unit environment
  explicitly isolated, the root
  aggregate passed backend `229/229` suites and `2819/2819` tests, merchant
  frontend `68/68` files and `575/575` tests, Growth `23/23` files and `133/133`
  tests, and extension `38/38` tests. Backend security passed `49/49` suites and
  `452/452` tests; backend syntax, test discovery, Growth TypeScript, and both
  production build checks passed.
- `DISPOSABLE_INTEGRATION`: final fresh PostgreSQL/Redis verification passed
  `14/14`
  suites and `87/87` tests. A separate fresh schema audit found no drift across
  62 models and 71 tables. The Meta-shaped disposable E2E passed `43/43` tests.
- `MIGRATION_BOOTSTRAP`: final fresh loopback-only PostgreSQL verification ran the full
  migration chain, ran it a second time with every migration skipped, seeded
  five users and nine Growth prospects, started the backend, returned health
  `200`, and denied an unauthenticated Growth session with `401`.
- `PLAYWRIGHT_EXTENSION`: the full Growth browser gate passed `32/32` tests with
  the opt-in headed Chromium extension flow enabled. Automated extension source
  validation and manifest tests passed; release permissions remain
  `activeTab`, `scripting`, and `storage`, with no extension package produced.
- `CLEAN_CHECKOUT`: a `git archive` checkout installed successfully from the
  root lockfile and passed the Growth suite, TypeScript, Growth build, backend
  build, extension tests, and extension validation. Node `25.6.1` emitted the
  expected repository engine warning because the project requires Node `20.x`.
- `CI`: draft PR #127 already points at this head; Security Scan, Test & Build
  Gate, integration, Meta-shaped E2E, Growth build/browser gates, frontend
  Playwright, deployment dry run, Docker no-push validation, and PR Merge Gate
  are green. Image publication and production deployment are skipped.
- `PRODUCTION_CHANGED`: `NO`; no production database, Redis, Qdrant, service,
  deployment, Meta review configuration, OAuth configuration, webhook
  configuration, or secret was changed.

## Final P1 hardening receipt (2026-09-15)

- `P1_SECURITY`: bootstrap now uses a protected operator secret, canonical
  `SUPER_ADMIN`, one-time database advisory locking, and trusted GitHub actor
  provenance. Shared audit readers return tenant-safe summaries; privileged
  audit reads are Super Admin-only; legacy admin mutations share transactions
  with required audit writes. URL, bearer, funnel, audit, and error-log
  redaction is server-side. First-AI-reply activation, onboarding conversion,
  and activation audits are atomic/retriable. Stale shop claims are checked
  against active memberships; Growth users cannot receive merchant sessions;
  sensitive merchant settings require owner membership; browser funnel code
  emits public events only; credit idempotency keys survive tab reloads.
- `FINAL_BACKEND`: isolated aggregate `231/231` suites and `2833/2833` tests;
  security `49/49` suites and `452/452` tests; discovery, syntax, and builds
  passed.
- `FINAL_FRONTEND`: merchant frontend `68/68` files and `575/575` tests;
  Growth `23/23` files and `135/135` tests; TypeScript and production builds
  passed. Extension `38/38` tests and validation passed.
- `FINAL_DISPOSABLE`: PostgreSQL/Redis integration `14/14` suites and `87/87`
  tests; Meta-shaped E2E `43/43` tests; fresh schema/migration/bootstrap
  verification passed twice with no drift; Growth Playwright and headed
  extension E2E `32/32` tests passed.
- `FINAL_AUDIT`: production dependency audit has no high/critical findings
  under the CI `--omit=dev --audit-level=high` gate. Five low/moderate legacy
  advisories remain deferred; they are not changed by this checkpoint.
- `DEFERRED_P2`: audit snapshot PII retention, prospect/analytics query
  pagination/rate limits and search-query transport, credit idempotency expiry,
  SQLite/PostgreSQL runtime parity, Unicode search normalization, and optional
  extension CI installation remain explicitly deferred. No P0/P1 blocker
  remains.
- `PRODUCTION_CHANGED`: `NO`; all databases, Redis, Qdrant, services, CI
  deployment jobs, Meta review settings, OAuth/webhook configuration, and
  secrets remained untouched.

## Follow-up terminal-integrity batch receipt (2026-09-25)

- `BATCH`: follow-up lifecycle integrity — the smallest coherent next phase
  selected from the 2026-09-25 reverse-engineering audit; no campaign, referral,
  retention, demo, scoring, or outreach scope was touched.
- `DEFECT`: `transitionFollowup` rejected reopening only `completed` rows, so a
  direct API caller could move `cancelled -> completed` and misdate work as done;
  cancellation wrote an audit row but no prospect timeline event, so the
  operator-visible timeline claimed a follow-up was created but never resolved.
- `FIX`: both terminal states now reject every transition with
  `409 GROWTH_OS_FOLLOWUP_DONE` under the same row lock; the target status is
  restricted to `completed|cancelled` at the service boundary; completion and
  cancellation each write one prospect event inside the same transaction as the
  row update and audit write, so an audit-service failure still rolls the whole
  mutation.
- `MIGRATION`: `20260925_001_growth_os_followup_cancel_event_type` replaces the
  prospect-event `event_type` CHECK with a superset adding
  `followup_cancelled`, following the named-replacement pattern of
  `20260913_002`; historical rows are untouched and `down()` refuses to revert
  while the new value is in use.
- `VALIDATION`: disposable PostgreSQL/Redis integration `14/14` suites and
  `88/88` tests passed with the extended terminal-state and event assertions;
  the new migration unit suite passed `4/4`; affected mock Growth lifecycle,
  identity, and scope suites passed `24/24`; `git diff --check` passed. The
  `growth-os.authz` suite cannot load in this local worktree because the
  install skipped sqlite3 native build scripts (pre-existing environment
  limitation, reproduced identically on clean main); CI runs the full unit and
  security gates on the PR.
- `PRODUCTION_CHANGED`: `YES` — PR #159 merged as
  `61f92dbc60b6dbde80357b143d47961ef65120e0`; exact-SHA production deploy run
  `36145507046` completed successfully and the deployment variable was restored
  to `PRODUCTION_DEPLOY_ENABLED=false`.
- `PRODUCTION_VERSION`: public `/version` returned
  `61f92dbc60b6dbde80357b143d47961ef65120e0` and migration count `57` with
  latest `20260925_001_growth_os_followup_cancel_event_type`.
- `PRODUCTION_HEALTH`: `/health/ready` returned HTTP 200 with database and
  Redis readiness; Growth origin `/health/ready` returned HTTP 200; Growth
  root returned HTTP 200; unauthenticated Growth session and prospect API
  boundaries returned HTTP 401.
- `AUTHENTICATED_PRODUCTION`: `BLOCKED_EXTERNAL_CREDENTIAL` — no operator
  identity, MFA proof, or `GROWTH_BOOTSTRAP_ACTOR_EMAIL` was available; no
  privileged bypass was attempted.
- `SENTRY`: `BLOCKED_EXTERNAL_CREDENTIAL` — DSN provisioning and human receipt
  remain unavailable.
- `POST_DEPLOY_MAIN`: `0eb614a1d3769d03f770b22829e2b8e996f2c0d0` is a
  documentation-only receipt commit merged after deployment; it was not
  redeployed because no runtime code changed. Production remains intentionally
  pinned to the exact verified runtime SHA above.
- `DEFERRED_NEXT`: owner-discovery/assignment UX (name-based owner selector and
  filtered home destinations) as the next product batch; prospect PII-retention
  policy in audit snapshots requires an explicit retention/redaction policy
  decision first; `growth_os_followup` audit rows remain outside the bounded
  privileged-audit allowlist by design until that policy lands.

## Owner discovery and actionable work queues receipt (2026-09-25)

- `BATCH`: PR #162 implemented the next evidence-backed phase without schema
  changes: eligible owner discovery, server-validated assignment, human-readable
  owner projections, `owner=me`, `owner=unassigned`, and UUID owner filters,
  plus Home and analytics queue destinations.
- `ELIGIBILITY`: an active, non-revoked Growth role with either
  `growth_os.prospects.manage_all` or both
  `growth_os.prospects.read_assigned` and
  `growth_os.prospects.update_assigned`; the same predicate is used by discovery
  and assignment mutation validation.
- `VALIDATION`: disposable PostgreSQL/Redis integration `14/14` suites and
  `89/89` tests; Growth frontend `23/23` files and `135/135` tests; Growth
  browser E2E `31` tests locally; CI backend integration, Growth build/browser
  E2E, security, Docker, dependency, and merge gates passed; quarantine remains
  `2/2`.
- `MERGED_SHA`: `ccae4b97af3eeb4765c5e78911d74a817ff750a2` from PR #162.
- `DEPLOYMENT_RUN`: `36156435580` completed successfully with `target=all`.
- `PRODUCTION_VERSION`: public `/version` returned the exact merged SHA and
  migration count 57.
- `PRODUCTION_HEALTH`: backend and Growth readiness/root returned HTTP 200;
  unauthenticated Growth session and prospect APIs returned HTTP 401.
- `DEPLOYMENT_GATE`: restored to `PRODUCTION_DEPLOY_ENABLED=false`.
- `AUTHENTICATED_PRODUCTION`: `BLOCKED_EXTERNAL_CREDENTIAL`; no operator
  identity, MFA proof, or `GROWTH_BOOTSTRAP_ACTOR_EMAIL` was available.
- `SENTRY`: `BLOCKED_EXTERNAL_CREDENTIAL`; DSN provisioning and human receipt
  remain unavailable.
- `ROLLBACK_STATUS`: `MECHANISM_VERIFIED`; previous runtime SHA is
  `61f92dbc60b6dbde80357b143d47961ef65120e0`, no migration rollback is needed,
  and live rollback was not rehearsed in this phase.
- `DEFERRED_NEXT`: improve analytics drill-through coverage and define the
  prospect audit-snapshot PII retention/redaction policy before expanding into
  reminders, workload scheduling, or automation.
- `POST_DEPLOY_MAIN`: `c0d45a3607d3910a53080d7ac150879a2399dd50` is the
  documentation-only receipt commit merged after deployment; it was not
  redeployed because no runtime code changed. Production remains pinned to
  `ccae4b97af3eeb4765c5e78911d74a817ff750a2`.

## Growth OS MVP-1 final engineering closure receipt (2026-09-25)

- `MVP1_ENGINEERING_REMAINING`: `0` for the repository-backed MVP-1 scope.
- `MVP1_FUNCTIONAL_REMAINING`: `0` for the production-verifiable, unauthenticated
  and test-covered scope; privileged operator proof remains an external
  credential boundary and is not misrepresented as complete.
- `IMPLEMENTATION_PR`: `#166`, merged as
  `50b659bb4949afaec78a462818b3573d0f99e3e0`.
- `DEPLOY_CONTRACT_PR`: `#167`, merged as
  `bbc1024af831549436afb074ca5037925137d402`; workflow-only `growth_image_override`
  support was required because the prior deploy path carried the running Growth
  digest forward and could not rotate an already-running Growth container.
- `BOOTSTRAP_WORKFLOW_FIX_PR`: `#169`, merged as
  `e5d6f973ae55ab497801d2c4e4f09c5690db5769`; the audited role grant now
  executes inside the running backend container without requiring Compose image
  variables from `.env.prod`.
- `ENGINEERING_SCOPE`: canonical `Asia/Dhaka` business-day semantics; exact Home,
  My Work, follow-up, stalled, converted-window, Analytics, and Sources
  metric/destination parity; bounded prospect date/stage filters; URL state
  hydration; bounded Notes pagination; activation-only conversion; structured
  contact PII redaction in audit snapshots; follow-up/note privileged audit
  visibility; analytics permission parity; and search text removed from browser
  URLs.
- `VALIDATION`: Growth frontend `23/23` files and `136/136` tests; TypeScript
  check and production build passed; Growth OS backend targeted suite `10/10`
  files and `71/71` tests; security suite `45/45`; migration suite `49/49`;
  deploy-guard suite `28/28`; CI PostgreSQL/Redis integration, Growth build and
  browser E2E, Meta-shaped E2E, security, Docker, dependency, deployment-dry-run,
  and merge gates passed; quarantine remains `2/2`.
- `DATABASE`: no new migration, table, column, or index; production remains at
  migration count 57 with latest
  `20260925_001_growth_os_followup_cancel_event_type`.
- `PRODUCTION_RUNTIME`: backend/worker exact runtime SHA is
  `bbc1024af831549436afb074ca5037925137d402`; the Growth SPA intentionally uses
  the existing published runtime-affecting artifact `50b659bb` because PR #167
  changed only deployment workflow code. PR #169 also changes only the audited
  bootstrap execution path.
- `GROWTH_IMAGE`: exact digest
  `sha256:c54a14e4d426ed8908592093bf5147462ed8cd562fa5dc7f4d7dd2aefeb7f942`;
  public `build-info.json` reports `50b659bb` after the explicit override deploy.
- `DEPLOYMENT_RUN`: `36185036774` completed successfully with `target=all` and
  the explicit Growth image override. Backend `/version`, backend readiness,
  Growth readiness/root, public Growth build info, and the unauthenticated
  Growth session boundary were verified after deployment.
- `DEPLOYMENT_GATE`: `PRODUCTION_DEPLOY_ENABLED=false` restored at
  `2026-09-25T20:34:24Z`.
- `ROLLBACK_STATUS`: `MECHANISM_VERIFIED`; protected rollback checks completed,
  but no live production rollback was executed.
- `AUTHENTICATED_PRODUCTION`: `BLOCKED_EXTERNAL_CREDENTIAL` — no eligible
  shop-less operator identity is available. The corrected audited workflow
  reached the role service: `info@easymod.tech` was rejected for active merchant
  membership; `founder@easymod.tech` and `growth@easymod.tech` were not found.
  No role grant or manual data mutation was performed.
- `SENTRY`: `BLOCKED_EXTERNAL_CREDENTIAL` — DSN provisioning and human-visible
  event receipt remain unavailable.
- `BOOTSTRAP_WORKFLOW_RUNS`: `36190311748` and `36190777841` failed closed before
  production mutation; `36192440171` proved the Compose interpolation fix; and
  `36193382364`/`36193473306` proved target-account validation.
- `POST_DEPLOY_MAIN`: `e5d6f973ae55ab497801d2c4e4f09c5690db5769` is the current
  `origin/main`; the backend runtime remains the previously deployed
  `bbc1024af831549436afb074ca5037925137d402`. The Growth image's
  `50b659bb` identity is intentional and documented above, not a stale/unverified
  artifact.

## Growth OS MVP-1 autonomous credential audit (2026-09-25)

- `AUDIT_START_MAIN`: `aea32dddb65dd86bddf36dd080e0dd89c8ed18c8`.
- `CURRENT_PRODUCTION_RUNTIME`: backend/worker `bbc1024af831549436afb074ca5037925137d402`;
  Growth SPA `50b659bb4949afaec78a462818b3573d0f99e3e0`; exact Growth digest
  remains `sha256:c54a14e4d426ed8908592093bf5147462ed8cd562fa5dc7f4d7dd2aefeb7f942`.
- `ENGINEERING_AUDIT`: no new MVP-1 TODO, disabled control, placeholder, or
  unwired Growth mutation was found. Existing deferred markers are post-MVP-1
  roadmap items. No runtime code change was required in this audit run.
- `CREDENTIAL_MATRIX`: repository secret `SENTRY_DSN` is present and consumed by
  backend/worker deployment; `VITE_SENTRY_DSN` is absent from repository and
  production environment variables; `GROWTH_BOOTSTRAP_ACTOR_EMAIL` is absent
  after temporary candidate checks were cleaned up; `GROWTH_BOOTSTRAP_DIGEST` is
  present and the Growth image digest is already verified; the deployment gate
  is false.
- `BOOTSTRAP_SEMANTICS`: `GROWTH_BOOTSTRAP_ACTOR_EMAIL` is a production
  environment secret naming an existing actor account, while the workflow input
  names an existing target account. The role service requires no active merchant
  membership, no active Growth role, and an empty active-Super-Admin set for
  first bootstrap. The actor/target identity must have real MFA before login;
  the script itself does not fabricate or weaken MFA.
- `IDENTITY_PROVISIONING`: Growth user creation is a `SUPER_ADMIN`-only route;
  there is no self-registration or approved pre-bootstrap autonomous account
  creation path. The platform-admin workflow only changes `platform_role` and
  does not grant Growth access. No direct SQL or arbitrary customer account was
  used.
- `BOOTSTRAP_ATTEMPTS`: the corrected protected workflow reached the live role
  service. `info@easymod.tech` was rejected for active merchant membership;
  `founder@easymod.tech` and `growth@easymod.tech` were not found; the known
  `admin@easymod.tech` candidate was also rejected for active merchant
  membership. Runs failed closed before any role mutation.
- `AUTHENTICATED_PROOF`: no eligible shop-less target identity or authorized
  authenticated session was available, so Home, My Work, assignment, notes,
  follow-ups, audit, logout, and session-invalidation walkthroughs were not
  falsely claimed.
- `SENTRY_BROWSER`: `EasyMod-frontend/src/sentry.ts` consumes
  `vars.VITE_SENTRY_DSN`; the variable is absent and the browser initializes
  Sentry only when it is non-empty. Backend `SENTRY_DSN` is intentionally not
  copied across the server/browser configuration boundary.
- `SENTRY_BACKEND`: repository secret `SENTRY_DSN` is present; deployment
  preflight and production deployment succeeded with the backend sink mapping.
  The privileged `/api/admin/ops/test-alert` path requires an authenticated
  `SUPER_ADMIN`, so no production test event or human receipt was claimed.
- `MOBILE_ISOLATION`: mobile worktrees/branches were inventoried and left
  untouched; no mobile source, CI, dirty file, branch, or worktree was changed.
- `PROOF_REMAINING`: `MVP1_ENGINEERING_REMAINING=0`; remaining proof is
  configuration-dependent: create/select an existing shop-less production
  account with MFA, configure the protected actor secret and target email, and
  provide a canonical browser Sentry DSN plus human-visible event receipt.

## 2026-09-26 (evening) live bootstrap execution receipt — deadlock resolved

The first-operator deadlock is closed in production. All steps below executed
through the canonical protected workflows; no credential, DSN, MFA secret, or
session value is recorded here.

- `DEPLOYMENT_CHAIN`: exact merged SHAs deployed through the existing gate;
  `PRODUCTION_DEPLOY_ENABLED` was set true only for each bounded dispatch and
  restored to false. Production runtime is `5d1929dbc1d247de010e4724d649740d9e5b35c0`
  (backend `/version` and Growth `build-info.json` both confirm; 57 migrations;
  Growth image digest pinned; unauthenticated Growth API returns 401).
  Earlier deploy of `bc781d45` and intermediate `e3c7016a`/`18b78ff9` runs are
  historical receipts: the first failed the live schema audit (no `users.role`
  column) and rolled back before service replacement — the model was corrected
  to the existing schema; production data was never mutated by it.
- `INITIAL_ADMIN_SEED`: `seed-initial-growth-admin.yml` run `36218828021`
  succeeded on production. The first attempt (run `36216031493`) failed closed
  before insertion when the live `users.settings` column proved to be `json`
  rather than `jsonb`; the containment query was cast accordingly (merged via
  PR #175) with no partial write. The seeded identity is shop-less, active,
  non-revoked, has no merchant membership, a production bcrypt hash of the
  protected temporary credential, forced rotation, and the one-time bootstrap
  marker only.
- `PASSWORD_ROTATION`: completed through the normal forced first-login change
  flow. The bootstrap temporary credential was verified to no longer
  authenticate (`Invalid credentials`). The post-rotation password exists only
  as a bcrypt hash; no copy is retained in repository, workflow, audit, or
  automation storage — operator recovery is the standard email reset for the
  account address.
- `MFA`: real enrollment through the production `/auth/2fa/setup` → genuine
  TOTP verification → `/auth/2fa/enable` flow. No SQL flag, no bypass, no
  exception. Login challenge enforcement verified: password-only sign-in is
  rejected with an MFA step-up; the Growth Users control plane shows
  `MFA: Yes`. The enrolled authenticator seed was displayed only inside the
  one-time setup UI and is never reproduced in documents.
- `GROWTH_BOOTSTRAP_ACTOR_EMAIL`: configured in the protected production
  environment to the seeded operator address, matching the actor semantics
  asserted by the canonical role service (actor must equal the first target).
- `SUPER_ADMIN_GRANT`: `grant-growth-role.yml` run `36220618508` executed the
  audited `bootstrapRole` transaction. The backend log line `OK: ... =>
  SUPER_ADMIN (user a5004286-2908-4841-a09f-1a907127c642)` is the positive
  effect receipt; the workflow's red step is the post-output drone-ssh channel
  timeout after Redis handles kept the session open past the 10-minute command
  timeout — the grant committed before that artifact appeared. Effects verified
  independently: pre-existing sessions returned 401 (invalidated), the audit
  trail shows `growth_os:role_granted` with GitHub actor `mr3826`, and a fresh
  MFA-authenticated session resolved `SUPER_ADMIN` with full workspace scopes.
- `AUTHENTICATED_GROWTH_PROOF`: full production walkthrough passed as
  `Growth Administrator` (`SUPER_ADMIN`): Home/My Work queues, Prospects list
  with filters/pagination, Quick Add create, edit-form update, lifecycle
  transition, notes with attribution, follow-up create/complete/reschedule/
  cancel, state queues (due today/overdue/cancelled/completed), Sources,
  Analytics, Pipeline, Operations, Audit with server-side redaction (no raw
  contact PII rendered), merchant read-only control plane (7 live merchants,
  none mutated), linkage negative path (invalid shop id → 404, no side
  effect), activation display. Logout verified: stale session 401 and stale
  refresh rejected.
- `OWNER_REVOCATION_LIVE_PROOF`: disposable subordinate `MVP1 Proof Agent`
  (`GROWTH_USER`) created via the Growth control plane, assigned the fixture
  prospect, then permanently revoked with typed confirmation. After revocation
  the owner picker excluded the revoked user (ineligible for new assignments),
  historical assignment remained attributable in the timeline, the prospect
  stayed discoverable, and `SUPER_ADMIN` reassignment succeeded with a reason —
  matching the eligibility contract without touching the bootstrap identity.
- `PLATFORM_ADMIN_GRANT`: `grant-platform-admin.yml` (now using the proven
  direct docker-exec pattern, PR #177) run `36222365407` succeeded; the
  operator also holds the canonical platform `SUPER_ADMIN` role required by
  `/api/admin/*`. The admin API host is deliberately outside the Growth proxy
  boundary, so those routes require an operator-authenticated merchant-app
  session — by repository design.
- `SENTRY_BOUNDARY`: backend Sentry remains configured and health-verified.
  The controlled `POST /api/admin/ops/test-alert` invocation was NOT executed
  by automation because that route requires a human-held operator session on
  the API host and the repository's lockout-prevention guard correctly refused
  automation re-issuance of the sole Super Admin credential. No provider auth
  token exists in any authorized source for machine-readable event-receipt
  verification. Browser Sentry stays disabled by design until a canonical
  public DSN is provisioned: `VITE_SENTRY_DSN` is absent from repository
  secrets/variables, git history, the deployed frontend bundle, and all
  authorized discovery sources; it must never be inferred from the backend
  DSN. `USER_CONFIGURATION_REQUIRED`: provision a canonical browser DSN in
  the Sentry project, then set the `VITE_SENTRY_DSN` repository variable and
  rebuild through the canonical pipeline.
- `ROLLBACK_STATUS`: `MECHANISM_VERIFIED` — the canonical pipeline executed
  the disposable rollback rehearsal during deployment validation; no live
  rollback was needed.
- `MOBILE_ISOLATION`: re-verified at completion — mobile worktrees, the
  `v1.0.2-rc3` release worktree and its dirty files, mobile branches, mobile
  CI, and mobile source were never reset, rebased, stashed, cleaned, deleted,
  committed into, or otherwise modified by this task.

---

## 2026-09-26 — MVP-1 Remediation, Real-Data Cutover & Value-Measurement Receipt

Independent-audit remediation executed end to end against production. Scope
discipline: no new product features; frozen roadmap untouched; mobile
worktrees/branches never modified.

### Remediation PRs (all merged to main, all gates green)

- PR #179 `fix/growth-mvp1-remediation` (merge `831fb45e`): Quick Add
  browser-local due-time defect closed via the canonical
  `fromBusinessDateTimeLocal`/`toBusinessDateTimeLocal` contract (pinned by
  `growthTime` unit tests, a deterministic Quick Add assertion, and a
  Playwright spec executed in BOTH Asia/Dhaka and UTC browser projects);
  canonical `activated=true` list filter (converted + active linked shop)
  shared by Home, Analytics funnel, Sources column, and every drill-through;
  merged tombstones excluded from default lists and search; frozen
  `stalledBefore` boundary makes stalled drill-throughs equal their card;
  Operations AI metrics now count activity inside the window
  (`message.created_at`, distinct AI-touched conversations); notes and
  timeline events surface operator names with removed/system/redacted
  fallbacks (no raw UUIDs); URL-backed filter state with live query-only
  navigation sync while search text stays out of URLs by PII policy;
  dead `ATTENTION_WINDOW_DAYS` removed. Review round: validator rejects
  contradictory `activated`+`status/stage`, own-note authorship parity under
  redaction, Quick Add full schedule-block reset, FollowUpsPage bare-navigation
  tab sync, panel parser alignment.
- PR #184 `fix/growth-mvp1-security-workflows` (merge `53cfa8e9`): every
  canonical Growth session now requires the MFA assurance claim
  (`GROWTH_USER` joins `MFA_REQUIRED_ROLES`; legacy roles follow via canonical
  alias); enrollment copy operator-generic; StrictMode-safe completion
  hand-off to sign-in; auth boundary runs BEFORE TOTP challenge issuance
  (suspended operators get 403, never a fresh temp token); subordinate
  GROWTH_USER browser E2E proves rotation → denial-without-MFA → enrollment →
  assured re-login → suspend/revoke fail-closed; `grant-growth-role` closes
  Redis handles (committed-grant-then-red-X hang root cause); explicit
  `command_timeout` on privileged SSH steps (grants 15m, deploy 30m);
  `grant-platform-admin` rebuilt to Growth parity (advisory + row locks,
  mandatory audit row with `GITHUB_ACTOR`, transactional session
  invalidation, strict cache re-confirm incl. NOOP convergence, distinct exit
  codes) and its workflow gained actor binding; update-prospect duplicate
  probe no longer discloses out-of-scope prospect ids (race path included,
  unit + integration regression).
- PR #186 `fix/growth-mvp1-edge-isolation` (merge `bdafc560`): Caddy no
  longer `depends_on` growth-frontend — merchant TLS edge boots without the
  internal SPA (per-request upstream resolution; guard-pinned); backups no
  longer hard-fail when the internal SPA is down (deployment-record digest
  fallback, digest-pinned contract preserved); remaining privileged SSH
  workflows capped (`backup` 30m, restore drill 30m, `purge` 15m, `qdrant`
  45m, `seed-meta-review` 15m) with a directory-wide guard rule that any
  appleboy workflow must declare `command_timeout`.
- PR #185 `feat/growth-mvp1-data-cutover` (merge `c3388832`): activation
  import rule — imported converted rows carry a canonical `activated` event
  ONLY with linked-shop `first_ai_reply` evidence, written at the historical
  instant; no evidence → no synthesized event (counted in funnel, excluded
  from timing). Analytics measurement (existing tables only): follow-up
  discipline (on-time/late/overdue/cancelled + rate), owner performance
  (created/qualified/converted + rates, cohort basis), unassigned open age.
  Protected `run-growth-importer.yml`: dry-run default, literal-phrase apply
  authorization, actor/environment/concurrency gates, host-side input
  hardening, receipts on the droplet.
- PRs #187/#188/#190 (merges before `ec8fd4fc`): importer workflow quoting
  fix (single quotes inside the single-quoted ssh program — fail-closed, zero
  writes), per-row receipt evidence echo, and rc-capture so row failures
  never abort before evidence and the idempotency gate.
- PR #193 `fix/growth-cutover-hardening` (merge `e6bf0c7e`): adversarial
  review hardening — idempotency proof requires a demonstrably COMPLETE
  verification scan (SOURCE_READ_FAILED sentinel refused, full row
  accounting, identical rejected-row set); activation clamp drop logged with
  source reference; `byOwner` redaction parity (null owner ids for redacted
  scopes); AnalyticsPage/SourcesPage version-skew normalization (backend
  rollback degrades to neutral values, not an app-level crash); guard tests
  pin every gate line.

### Runtime deployment (exact-SHA, gate discipline)

- Interim deploy `bdafc560` (run `36243485372` + growth swap `36244737728`,
  growth digest `d2cb6c40…`) — verified: `/api/version` gitSha, 58
  migrations, growth build-info aligned, boundary 401, merchant hosts 200.
- FINAL deploy `e6bf0c7e` (run `36250821060`, success): backend
  `/api/version` = `e6bf0c7ea038ab7ca092f0edb25a691342ed6243`,
  `migrations.count=58`, latest `20260914_001_native_session_refresh_lineage`;
  growth `build-info.json` = same SHA (image digest
  `sha256:85a3ee2241a9912779cd6268b6d0ea8d4b69772ea253374a8efe578dfc133b68`
  built by growth-os run `36250464586`); growth `/health/ready` 200; growth
  root 200; unauthenticated `/api/internal/growth-os/session` 401; apex and
  app hosts 200. `PRODUCTION_DEPLOY_ENABLED` restored to `false` after each
  dispatch window. Mobile wave-2 backend code rode main into this runtime per
  monorepo contract (`MOBILE_API_ENABLED` already true; native routes gated
  by their own tests).

### Real-data cutover (Workstreams J/K)

- Dry-run review passes: runs `36245996452` (counts), `36246299579` (evidence
  plumbing proved), `36247168710` (row evidence): `SOURCE_ROWS=6` (all
  `crm_lead` signups; `partner_applications` contributed 0),
  `WOULD_CREATE=4`, `SKIPPED_DUPLICATE=1`, `REJECTED=1`.
- APPLY run `36251822972` (authorization phrase + production environment
  approval): `IMPORTED=4` (`crm:lead:signup:7de23c4f…`, `3d0624d6…`,
  `36b74cb3…`, `fe866b70…` → ledger ids `2c92e2af…`*, `d5d85436…`,
  `b21730a7…`, `d1db0b51…`), `MERGED=0`, `SKIPPED=1` (identity dedupe onto
  existing prospect `2c92e2af…`), `REJECTED=1`
  (`crm:lead:signup:7d35049d-ec5a-431b-b2a5-a857181efc2f`,
  `GROWTH_OS_PROSPECT_INVALID_INPUT` — permanently invalid legacy source
  row; recorded in host receipts for triage; the importer correctly refused
  to fabricate data). Job exit 1 is the designed signal for a rejected row.
- IDEMPOTENCY (enforced gate, not trust): post-apply verification dry-run —
  `VERIFY_ROWS=6` (== apply total), `VERIFY_READ_FAILURE=false`,
  `VERIFY_FAILED=1` (== apply failed set), **`SECOND_RUN_WOULD_CREATE=0`**,
  `VERIFY_COMPLETED_WITH_KNOWN_ROW_REJECTIONS`. All five created/deduped
  sources resolved to their ledger ids on re-run.
- Receipts persisted on the droplet:
  `/root/growth-os-receipts/growth-prospect-import-gha-36251822972-{apply,verify}.{stdout,receipt}.json`
  (source references and outcomes only — no contact PII by design).
- Post-import health: `/api/version` 200, backend `/health/ready` 200, growth
  `/health/ready` 200, apex 200, app 200, growth boundary 401.

### Value measurement baseline (Workstream L)

Analytics now computes from the ledger alone: follow-up discipline
(on-time/late/overdue-open/cancelled + on-time rate), owner performance
(created/qualified/converted + qualification/activation rates per owner on
the source cohort), unassigned open count + oldest age. No browser telemetry
added. Baseline values require an authenticated operator session to read
(`PROOF_REQUIRES_OPERATOR_SESSION` for numeric capture); the definitions and
queries are deployed at `e6bf0c7e`.

### Status

```text
MVP1_REMEDIATION_STATUS=COMPLETE
REAL_DATA_CUTOVER_STATUS=COMPLETE (4 imported, 1 deduped, 1 rejected-and-recorded)
IMPORT_IDEMPOTENCY=VERIFIED (SECOND_RUN_WOULD_CREATE=0, completeness-gated)
PRODUCTION_RUNTIME_SHA=e6bf0c7ea038ab7ca092f0edb25a691342ed6243
DEPLOYMENT_GATE=false (restored)
NEW_FEATURE_DEVELOPMENT=FROZEN_PENDING_USAGE_EVIDENCE
VALUE_REALIZATION=NOT_YET_PROVEN (observation window starts with real operator usage)
MOBILE_WORK_PROTECTED=YES
```
## S-2 authentication hardening receipt (2026-09-21)

This is a security hardening receipt only. It does not start or advance a Growth
OS product phase and does not change the Growth release gates above.

- Growth OS and internal Growth analytics now use explicit authentication
  middleware with shop-membership enforcement disabled before the existing
  server-side `requireGrowthOsAccess` policy runs. Merchant identities remain
  denied by the Growth role/permission gate.
- The disposable PostgreSQL/Redis integration gate passed `14` suites / `71`
  tests, including Growth access with zero merchant membership rows.
- The backend security gate passed `50` suites / `455` tests. Growth and
  analytics route regressions passed `37` tests.
- Live membership revocation remains database-backed and does not use frontend
  claims or stale membership cache state. No production Growth host, database,
  Redis, TLS, operator bootstrap, or browser gate was changed or claimed.

## Growth completion branch receipt (2026-10-07)

This entry supersedes older branch/runtime values above for the completion work.
It records the exact local evidence; it does not claim production or CI proof
for an unpushed SHA.

```text
INITIAL_BRANCH=execution/mobile-release-readiness
INITIAL_HEAD=981f8f74595e0c17f3e779b91708e9d5ba79facc
ORIGIN_MAIN=981f8f74595e0c17f3e779b91708e9d5ba79facc
INITIAL_WORKTREE_CLEAN=false (two pre-existing mobile workflow modifications were reported; they were not carried into this branch)
PREBRANCH_WORKTREE_CLEAN=true (the transient mobile workflow state was no longer present before branch creation)
BASE_SHA=981f8f74595e0c17f3e779b91708e9d5ba79facc
BRANCH=growth/growth-os-completion
FINAL_HEAD=423ad4f0b09ed68bbcbc263aab9a84a8fc8a2524
REMOTE_BRANCH_HEAD=423ad4f0b09ed68bbcbc263aab9a84a8fc8a2524
```

Implementation commits on this branch:

- `e2f8708f` `docs(growth): record completion execution plan`
- `a854d5c6` `fix(growth): close scoped analytics and search leaks`
- `8ffe44a6` `fix(growth): reconcile activation and merged work`
- `b48c349d` `fix(growth): harden production rollback and release gates`
- `7dc8c00a` `test(growth): make validation and image gates reproducible`
- `5eacc81b` `fix(growth): align auth origin and rollback assertions`
- `c20f8dcd` `docs(growth): record completion receipts and gates`
- `d4494441` `docs(growth): add live release evidence`
- `682ba57b` `test(growth): use distinct merge fixture identities`
- `5b11a4c1` `fix(growth): preserve merge audit metadata`
- `423ad4f0` `fix(growth): close independent release review findings`

Completed locally:

- source/assigned analytics follow-up counts use cohort and row scope;
- source-scoped search suppresses owner identifiers and preserves Unicode
  normalized search;
- Growth prospect audit snapshots redact contact data, URLs, notes, metadata,
  source references, and disqualification reasons;
- merge referential integrity is `RESTRICT`, and merged follow-ups/notes are
  rehomed to the surviving prospect;
- delayed linkage reconciles an already-recorded first AI reply;
- follow-up ownership requires an eligible operational Growth role;
- Growth reads and mutations use authenticated-user keyed, IPv6-safe quotas;
- migration advisory locking, cohort indexes, explicit Growth opt-in/CORS,
  commit-bound Growth image checks, Growth-aware rollback, Caddy reload/validate,
  worker readiness, log rotation, restore-table/upload verification, and Nginx
  image smoke coverage are implemented;
- the frontend test worker pool is deterministic and the Growth lint gate is
  strict.

Validation receipts:

| Command | Result |
| --- | --- |
| `npm test --workspace=easymod-growth` | PASS, 24 files / 151 tests; TypeScript no-emit passed. |
| `npm run typecheck --workspace=easymod-growth` | PASS. |
| `npm run build --workspace=easymod-growth` | PASS, Vite production build. |
| `npm run lint:growth -- --max-warnings=0` | PASS. |
| `npx jest src/modules/growth-os/__tests__ --testPathIgnorePatterns=integration --runInBand --forceExit` | PASS, 12 suites / 88 tests before the post-`npm ci` Node 25 native SQLite loader mismatch; remote Node 20 quality passed the same backend suite. |
| Growth security/config/migration focused Jest suites | PASS, including 69 auth-origin/workflow-guard tests and production config/migration tests. |
| `npm run test:discovery` | PASS, 296 tracked tests with one execution home. |
| `npm audit --omit=dev --audit-level=high` | PASS, 0 production vulnerabilities. |
| GitHub `CI / CD` run `37627702108` at `5b11a4c1` | PASS: migration/schema audit, 28 integration suites / 196 tests, backend quality, frontend build/unit, Meta E2E, and mock Playwright. |
| GitHub `Growth OS CI / CD` run `37628476705` at `5b11a4c1` | PASS: extension validation/tests, typecheck, lint, 151 behavioral tests, build, browser E2E, and built Nginx image smoke. |
| GitHub `Security Scan` run `37627981587` at `5b11a4c1` | PASS: historical Gitleaks and production dependency audit. |
| `npx jest --runInBand` backend aggregate | CONDITIONAL: 257 suites / 3362 tests passed; 7 unrelated/environment-sensitive suites failed because local PostgreSQL/Redis were unavailable, plus existing environment-dependent TOTP/grounding assertions. |
| Growth PostgreSQL/Redis integration, `migrate:status`, `schema:audit` | NOT RUNNABLE locally: required services refused connections at the configured local ports. |
| `npm run test:growthos:image` | NOT RUNNABLE locally: Docker Desktop Linux daemon unavailable. CI image-smoke job is wired for this gate. |

Current release status:

```text
LOCAL_CODE_GATES=PASS (Node 20 CI is authoritative for native SQLite/Docker-dependent paths)
REMOTE_CODE_GATES=PASS
PRODUCTION_RUNTIME_RECEIPTS=UNVERIFIED
FINAL_STATUS=CONDITIONAL
DEPLOYMENT_READINESS=NOT_READY
INDEPENDENT_REVIEW=PASS (review findings closed: backend port, restore helper image, stale-link race, and PR package permissions)
```

Remaining release evidence is limited to PostgreSQL/Redis integration and
schema receipts, Docker image smoke, final remote CI/security/reviewer results,
production CORS/flag/secrets/backup configuration, live Growth health/auth
checks, and an authorized release decision. No deployment or production
mutation was performed.

Read-only live-origin receipt (2026-10-07):

```text
https://growth.easymod.tech/health/ready=200
https://growth.easymod.tech/api/internal/growth-os/session=401
https://growth.easymod.tech/api/version=404
https://growth.easymod.tech/build-info.json.commit=8e83f17839b21331bbda52f164a3cc8b6a3af918
```

The live image predates this branch and its CSP does not yet contain the new
API-origin allowance; this is evidence of the current deployed state, not a
claim that the branch has been deployed.

## 2026-11-15 Growth OS MFA requirement removal receipt

Founder decision: remove multi-factor authentication as a Growth OS access
requirement. The founder was locked out of Growth OS by the end-to-end TOTP
gate; the requirement is removed rather than weakened with a bypass.

- `DECISION`: founder-directed, 2026-11-15; scope is the Growth OS access chain only.
- `ACCEPTED_RISK`: with this change a stolen password alone yields Growth OS
  (cross-shop prospect PII and the Admin Control Plane, including role grants).
  This is an explicit, founder-accepted security-posture change, not a silent
  simplification. Shared merchant/mobile TOTP, the `mfaVerified` claim
  issuance, and every fail-closed Redis/role/merchant-context guard remain.
- `CHANGED`:
  - `growth-os.middleware.js`: `requireGrowthOsAccess` no longer evaluates
    `mfaVerified`; `GROWTH_OS_MFA_REQUIRED` is retired. Fail-closed Redis
    startup/probe/strict-cache behavior, `GROWTH_OS_DISABLED`,
    `GROWTH_OS_MERCHANT_CONTEXT_FORBIDDEN`, role/permission resolution, and the
    sanitized `GROWTH_OS_AUTHZ_UNAVAILABLE` path are unchanged.
  - bootstrap: `getInitialBootstrapState` reports `pending` for a bootstrap
    operator (no `mfa-required` state); `GROWTH_OS_BOOTSTRAP_MFA_REQUIRED` and
    the `totp_enabled` precondition are removed from the middleware and
    `growth-os.roles.service.js`. The seed marker, forced password rotation,
    audited transactional `SUPER_ADMIN` grant, marker clear, and session
    invalidation remain.
  - `growth-os.permissions.js`: `MFA_REQUIRED_ROLES` removed.
  - `seed-growth-e2e.js`: MFA comment corrected; `growth` and `staleSession`
    fixtures no longer enroll TOTP (`super` and `legacy` stay enrolled so the
    optional TOTP sign-in path is still covered).
  - `EasyMod-growth`: enrollment-required redirects/route and `EnrollMfaPage`
    removed; the `MFA: Yes/No` column remains only as the informational
    `users.service` `mfaEnabled` display. The Access Control "Key security
    facts" list no longer claims MFA is required for Super Admin sign-in; it
    now states TOTP is optional and access is an active role plus the endpoint
    permission.
  - workflows: `grant-growth-role.yml` and `seed-initial-growth-admin.yml`
    comments/input description no longer require MFA enrollment. Gates
    (main-only, actor, environment, confirmation literals) are unchanged.
  - docs: this access/failure contract, `05-internal-control-plane.md`,
    `02-application-foundation.md`, and `README.md` updated;
    `GROWTH_OS_CURRENT_STATE.md` carries a superseded banner. Dated receipts
    are not rewritten; this receipt supersedes their MFA requirement
    statements.
- `KEPT`: shared `auth.service.js` / `totp.service.js` / `totp.controller.js` /
  `auth.middleware.js` TOTP issuance untouched; `mfaVerified` may still be
  issued and is simply not a Growth precondition.
- `NEW_CONTRACT`: active Growth role + endpoint permission only; MFA is not
  required for any Growth role; frontend checks remain UX only.
- `VALIDATION` (local battery run 2026-11-15, re-run green after FIX_ROUND_1;
  local Node v25.6.1 vs CI Node 20 — no version-specific failures observed):
  - backend Growth Jest suites: `PASS` — 12 suites / 89 tests
    (`jest --runInBand`: authz, middleware.bootstrap, roles.service,
    audit-sanitizer, time, workspace.analytics/home/search,
    prospect.identity/lifecycle/scope, prospects.security)
  - Growth PostgreSQL/Redis integration: `PASS` — 4 suites / 45 tests against
    a disposable Postgres 16 + Redis 7 stack (`docker-compose.test.yml`, full
    migration chain; access, control-plane, prospect-import, prospects);
    stack torn down with volumes after the run
  - shared-auth regression: `PASS` — auth-token-version.security +
    native-sid-revocation, 40 tests (`mfaVerified` claim issuance unbroken)
  - ancillary Growth script suites: `PASS` — 9 files / 42 tests
    (grant-growth-role, seed-initial-growth-admin, both import-growth-prospects,
    growth-metrics.service, 4 growth-os migration suites)
  - `npm run test:security` (full): `CI_ONLY` — targeted security suites above
    passed locally; full script runs in CI
  - `npm test` (backend full): `CI_ONLY` — targeted suites above ran locally
  - `npm test --workspace=easymod-growth`: `PASS` — vitest `--pool=threads`,
    25 files / 157 tests
  - `npm run typecheck --workspace=easymod-growth`: `PASS` — `tsc --noEmit`
    exit 0
  - `npm run lint:growth -- --max-warnings=0`: `CI_ONLY`
  - `npm run build --workspace=easymod-growth`: `CI_ONLY`
  - `npm run test:growthos:e2e`: `CI_ONLY` — specs updated to the no-MFA
    contract; not run locally
  - `npm run test:growthos:image`: `CI_ONLY`
  - CI run IDs: `PENDING_PR`
  - adversarial review: initial pass found 1 blocking item (stale Access
    Control copy) → FIX_ROUND_1; re-review `PASS`, completeness critic `PASS`
    (full seed → rotation → grant → login → first API call trace confirms no
    step demands TOTP)
- `FIX_ROUND_1` (2026-11-15): stale Access Control copy corrected;
  `npx vitest run src/pages/AccessControlPage.test.tsx --pool=threads` passed
  4/4 after the edit. No test asserted the removed sentence.
- `CLAIMS_NOT_MADE`: no production deploy, credential, role grant, or live
  browser walkthrough is claimed.
