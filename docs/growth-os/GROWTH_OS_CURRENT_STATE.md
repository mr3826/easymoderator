# Growth OS Current State

Date: 2026-10-07
Evidence checkout: `growth/growth-os-completion` from
`981f8f74595e0c17f3e779b91708e9d5ba79facc`.
Reviewed head: `423ad4f0b09ed68bbcbc263aab9a84a8fc8a2524`.
Release verdict: `CONDITIONAL` while this completion branch is validated;
production deployment remains blocked until the exact branch SHA has CI,
reviewer, credential, and runtime receipts.

> The historical findings and receipts below remain evidence for how the
> current contract was recovered. The 2026-10-07 completion plan and the latest
> completion entry in `EXECUTION_STATE.md` supersede older verdict lines.
>
> **Contract update 2026-11-15:** Growth OS no longer requires MFA for any
> role. The MFA statements below (notably the Authentication and authorization
> table row for Founder/Growth Manager, P0-3 acceptance item 4, P0-4 acceptance
> item 3, and the definition-of-done row about an MFA-backed session) are
> historical evidence for the 2026-10-07 determination only. The current
> contract is the Access contract in `EXECUTION_STATE.md` and its 2026-11-15
> receipt.

This document is a current-state determination, not a product vision. It uses
the current code, tests, deployment configuration, and `EXECUTION_STATE.md` as
the evidence basis. Current code and tests take precedence over historical
design notes, as required by the Growth OS index (`docs/growth-os/README.md:7-17`).

The labels used below are `VERIFIED` (bounded evidence proves behavior),
`PARTIAL` (implementation exists but operating/live proof is incomplete),
`MISSING` (no implementation or evidence), and `UNCERTAIN` (recorded but not
independently proven). A passing local or disposable test is not production
deployment proof.

## 1. Executive Verdict

### Verdict: NOT READY

**The blocker is not code quality. It is deployment and operation.** The
prospect ledger is a real, security-conscious, well-tested implementation. It
has not been demonstrated as a live operating loop because three operational
acts remain open:

1. Execute the first Growth rollout with the immutable image and the gated
   deploy variable enabled.
2. Bootstrap the first Founder through the audited role workflow.
3. Run a live `growth.easymod.tech` browser walkthrough after the host is live
   and the Founder exists.

The ledger still needs real source data and a thin follow-up loop, but those are
business-value gaps after release, not evidence that the foundation is vapor.
The release state explicitly records `PRODUCTION_DEPLOY_ENABLED: false`, an
absent Growth bootstrap digest, open TLS, unclaimed operator bootstrap, an open
live browser gate, and `OVERALL_GROWTH_OS_RELEASE_VERDICT: NO-GO`
(`docs/growth-os/EXECUTION_STATE.md:207-229`, `:408-431`).

Current gate values: `PRODUCTION_DEPLOY_ENABLED: false`,
`GROWTH_BOOTSTRAP_DIGEST: ABSENT`, `GROWTH_DNS_TLS_GATE: OPEN`,
`OPERATOR_BOOTSTRAP_GATE: OPEN`, `PRODUCTION_BROWSER_E2E_GATE: OPEN`, and
`OVERALL_GROWTH_OS_RELEASE_VERDICT: NO-GO`
(`docs/growth-os/EXECUTION_STATE.md:207-229`, `:425-431`).

### Stale-checkout hazard

The default `D:\easymod\easy-moderator` checkout is stale relative to the
Growth release line: the discovery comparison found it 0 commits ahead and 14
commits behind `origin/main`. It has no prospect-ledger implementation and its
execution state is frozen at the earlier foundation phase. Auditing that
directory produces the false conclusion that Phase 3 does not exist.

The authoritative evidence for this historical determination was a now-removed
Phase 3 checkout, where the release state recorded the merged implementation,
the hardening receipts, and the still-open production gates
(`docs/growth-os/EXECUTION_STATE.md:317-361`, `:408-438`). Do not use the
stale checkout for release decisions, code review, or gap counting.

## 2. Current System

### Product boundary

Growth OS is a sibling internal application, not a merchant dashboard or CRM
replacement. Its current Phase 3 boundary is the canonical ledger, lifecycle,
assignment, linkage, merge, timeline, duplicate preflight, and dry-run importer
(`docs/growth-os/README.md:19-47`); business logic remains in the backend
namespace (`EasyMod-growth/README.md:7-16`).

### Implemented capabilities

| Status | Capability | What the code proves | Evidence |
| --- | --- | --- | --- |
| `VERIFIED` | Internal API surface | Session, role grant/revoke, prospect list/create/detail/edit/status/assign/link/linkage-suggestions/merge routes are mounted under `/api/internal/growth-os`. | `EasyMod-backend/src/modules/growth-os/growth-os.routes.js:63-138` |
| `VERIFIED` | Role storage | `growth_os_user_roles` has six allowed roles, active/revoked state, actor references, timestamps, and one-active-role-per-user protection. | `EasyMod-backend/src/database/migrations/20260820_001_growth_os_user_roles.js:9-49` |
| `VERIFIED` | Prospect and event storage | `growth_os_prospects` and append-only `growth_os_prospect_events` store identity, source, lifecycle, ownership, links, merge state, metadata, and event history. | `EasyMod-backend/src/database/migrations/20260820_002_growth_os_prospects.js:53-109` |
| `VERIFIED` | Database integrity | Status, source, merge, converted-link, and channel checks exist; partial unique indexes protect phone, email, page, and source references. | `EasyMod-backend/src/database/migrations/20260820_002_growth_os_prospects.js:86-155`; `20260820_003_growth_os_prospect_source_reference_idx.js:20-31` |
| `VERIFIED` | Lifecycle | Eight states and deterministic transitions prevent arbitrary state jumps; merged rows are terminal and conversion requires a linked shop. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.lifecycle.js:5-56`; `growth-os.prospect.service.js:843-893` |
| `VERIFIED` | Bangladesh identity normalization | Phone values support local, `+880`, `+88`, and `00880` forms; email, page URL, and business name normalization are server-derived. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.identity.js:3-69` |
| `VERIFIED` | Unicode-safe names | Business-name normalization preserves Unicode letters and numbers, so Bangla names are not reduced to ASCII punctuation artifacts. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.identity.js:39-46` |
| `VERIFIED` | Race-safe deduplication | Application preflight plus database unique indexes and unique-violation recovery yield one winner under concurrent creation. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:568-618`; `growth-os.prospects.integration.test.js:441-478` |
| `VERIFIED` | Fail-closed scope | `none` scope becomes `id IS NULL`, and repository lookups combine the scope predicate with caller filters before fetching rows. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.scope.js:10-50`; `growth-os.prospect.repository.js:66-71`, `:151-179` |
| `VERIFIED` | Scoped redaction | Source-scoped users receive no contact fields, notes, metadata, reasons, or actor identity fields. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:306-363`; `growth-os.prospects.integration.test.js:517-560` |
| `VERIFIED` | Transactional audit trail | Each mutation writes a product event and `AuditLog` row in one transaction; audit failure returns a sanitized error and rolls the product write back. | `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:387-458`; `growth-os.prospects.integration.test.js:667-717` |
| `VERIFIED` | Role administration | Grant/revoke validates actors and targets, protects the last Founder, writes an audit row, and rolls back if role-cache invalidation fails. | `EasyMod-backend/src/modules/growth-os/growth-os.roles.service.js:93-149`, `:152-212` |
| `VERIFIED` | Historical importer | CRM audit rows and Partner applications are converted into deterministic source references; dry-run is the default and `--apply` is required to persist. | `EasyMod-backend/scripts/import-growth-prospects.js:120-224`; `:234-245` |
| `VERIFIED` | SPA prospect work surface | List, detail, create, edit, transition, assignment, linkage, merge, and paginated timeline flows exist in the Growth frontend. | `EasyMod-growth/src/pages/ProspectListPage.tsx:89-326`; `ProspectDetailPage.tsx:107-174`, `:397-500` |
| `VERIFIED` | Bounded verification | The current execution state records focused backend, PostgreSQL/Redis, frontend, build, and 12-scenario disposable browser receipts. | `docs/growth-os/EXECUTION_STATE.md:344-358` |

### What the ledger does not do

| Status | Gap | Evidence and consequence |
| --- | --- | --- |
| `VERIFIED` | List priority is creation order only. | Repository ordering is `created_at DESC, id DESC`; there is no due date, priority, or score (`growth-os.prospect.repository.js:151-160`). The system cannot answer who is next. |
| `MISSING` | There is no Growth follow-up, task, due date, SLA, reminder, or next-action subsystem. | The prospect migration has identity, status, ownership, linkage, merge, and metadata fields but no action or due field (`20260820_002_growth_os_prospects.js:53-93`). The foundation explicitly excludes follow-up tasks (`docs/growth-os/04-prospect-foundation.md:101-106`). |
| `VERIFIED` | Notes are a mutable field, not an append-only activity stream. | `notes` is a single prospect column (`20260820_002_growth_os_prospects.js:56-63`), and notes are part of the ordinary update field set (`growth-os.prospect.service.js:248-285`). |
| `MISSING` | Lifecycle stops at converted and has no demo, trial, retention, or referral states. | The allowed transition map ends at `converted` and `merged` (`growth-os.prospect.lifecycle.js:34-43`). |
| `PARTIAL` | A real activation metric exists, but the Growth overview does not consume the founder-only analytics endpoint directly. | The backend exposes founder-only activation/retention analytics (`analytics.routes.js:154-173`), while `HomePage` loads the operational overview through `workspaceApi.home` (`EasyMod-growth/src/pages/HomePage.tsx:32-57`). |
| `PARTIAL` | Paid state exists in billing but not as a Growth funnel concept. | `subscriptions.status` includes paid and trial states (`EasyMod-backend/src/modules/subscription/subscription.entity.js:63-71`), but the Growth prospect lifecycle has no paid state (`growth-os.prospect.lifecycle.js:5-43`). |
| `PARTIAL` | Six roles are defined, but several permissions have no current Growth work surface. | Customer Success and Analyst receive session/report or future-work permissions but no prospect read permission (`growth-os.permissions.js:52-61`); the current Growth router exposes only session, roles, and prospect routes (`growth-os.routes.js:63-138`). |
| `MISSING` | Bulk import has no SPA entry point. | Import is an executable script (`import-growth-prospects.js:234-245`), while the router has no import route (`growth-os.routes.js:63-138`). |
| `VERIFIED` | Automation is absent from the Growth operating path. | The job registry contains the existing 11 jobs and no Growth job (`EasyMod-backend/src/jobs/index.js:8-35`); no Growth route registers a scheduler or queue consumer (`growth-os.routes.js:1-14`). |
| `VERIFIED` | AI is absent from Growth OS. | Growth module imports are local auth, validation, audit, repository, identity, and lifecycle dependencies; no `llm.service` is imported (`growth-os.prospect.service.js:1-21`; `growth-os.routes.js:1-14`). This absence is correct at the current volume and risk stage. |

The delivered system is a manual ledger: it answers what is known, its
controlled state, ownership, provenance, and history. It does not answer who to
act on next, why now, or the highest-value next action. That is an operating-loop
gap, not a request for more screens.

## 3. Lifecycle Coverage

The product judgment should be made against the whole intended funnel, not the
number of database tables. The current ledger covers the first three manual
steps; it does not yet run the acquisition-to-retention loop.

| Funnel stage | Status | Current meaning | Evidence |
| --- | --- | --- | --- |
| Prospect | `VERIFIED` | A canonical row can be created from manual, signup, partner, referral, inbound, event, or other provenance. | `20260820_002_growth_os_prospects.js:14-22`, `:53-70`; `growth-os.prospect.service.js:198-245` |
| Contact | `VERIFIED` | `new -> contacted` is a controlled human transition with an event and audit row. | `growth-os.prospect.lifecycle.js:34-43`; `growth-os.prospect.service.js:843-893` |
| Qualification | `VERIFIED` | `contacted -> qualifying -> qualified` is modeled and can be assigned and scoped. | `growth-os.prospect.lifecycle.js:34-43`; `growth-os.prospect.scope.js:10-41` |
| Demo | `MISSING` | No demo entity, date, attendance, outcome, or route exists. | The foundation explicitly excludes demos (`docs/growth-os/04-prospect-foundation.md:101-106`); current routes end at merge (`growth-os.routes.js:118-138`). |
| Trial | `MISSING` | No Growth trial workflow or prospect state exists. Billing has trial states, but the Growth ledger does not connect them into an operator loop. | `subscription.entity.js:63-71`; `growth-os.prospect.lifecycle.js:5-43` |
| Activation | `PARTIAL` | First successful AI reply records `shop.settings.activation`; a founder-only analytics endpoint reports activation and order-based retention. | `growth-metrics.service.js:83-145`, `:179-222`; `analytics.routes.js:154-173` |
| Paid | `MISSING` as Growth concept | Subscription billing has `active` and related states, but no Growth prospect transition, payment milestone, or conversion report consumes them. | `subscription.entity.js:63-71`; Growth API table `docs/growth-os/04-prospect-foundation.md:70-90` |
| Retention | `MISSING` in Growth workflow | The analytics service computes a weekly order signal, but there is no customer-health, intervention, churn, or retention task surface. | `growth-metrics.service.js:140-222`; `growth-os.permissions.js:52-61` |
| Referral | `MISSING` | Referral can be an acquisition source value, but there is no referral relationship, ask, attribution, or testimonial loop. | `growth-os.prospect.lifecycle.js:26-32`; explicit later-phase boundary `docs/growth-os/04-prospect-foundation.md:101-106` |

### Funnel judgment

The current path is:

```text
Prospect -> Contact -> Qualification -> [manual handoff outside the system]
```

The correct next investment is not to implement all missing funnel nouns. It is
to make the existing qualified queue actionable with one due timestamp and one
next-action description. The missing piece is when and why the operator should
act.

## 4. Architecture and Automation State

### Request and data flow

```text
operator -> growth.easymod.tech -> Caddy -> growth-frontend nginx
  -> auth/CSRF/Growth API -> authenticate -> Growth role policy
  -> repository scope -> PostgreSQL growth_os_* tables
  -> prospect event + platform audit row in one transaction
```

The host routing is explicit: only the auth/session contract and Growth routes
are proxied, unsupported `/api/*` paths return 404, and all other paths go to
the Growth SPA (`Caddyfile:204-230`). Compose defines the Growth frontend as an
internal-only service with a health check (`docker-compose.prod.yml:105-117`).

### Authentication and authorization

| Status | Property | Evidence |
| --- | --- | --- |
| `VERIFIED` | Every Growth router request passes shared authentication and the default Growth role guard. | `growth-os.routes.js:63-66` |
| `VERIFIED` | Access comes from an active `growth_os_user_roles` record, not merchant shop roles or frontend claims. | `growth-os.middleware.js:57-110`; `growth-os.authz.test.js:123-149`, `:222-229` |
| `VERIFIED` | Founder and Growth Manager require the server-issued MFA assurance claim. | `growth-os.middleware.js:98-106`; `growth-os.authz.test.js:212-220` |
| `VERIFIED` | Production authorization fails closed when Redis is absent, not ready, or a strict cache operation fails. | `growth-os.middleware.js:14-54`, `:60-74`; `growth-os.authz.test.js:151-180` |
| `VERIFIED` | Resource access is query-scoped, including detail and mutation lookups. | `growth-os.prospect.scope.js:10-50`; `growth-os.prospect.repository.js:170-215` |
| `PARTIAL` | Authentication and authorization are proven in bounded environments, but no live cookie, MFA, or cross-origin browser receipt exists. | `docs/growth-os/EXECUTION_STATE.md:90-107`, `:224-229` |

### Mutation and failure handling

Prospect mutations use database transactions, row locks for edits and
transitions, deterministic validation, and paired event/audit writes
(`growth-os.prospect.service.js:707-747`, `:848-893`). The integration suite
proves that an audit insert failure returns a sanitized 503 and leaves neither
the prospect nor its event (`growth-os.prospects.integration.test.js:667-717`).

Role changes have the same discipline, including last-Founder protection and
cache invalidation before commit (`growth-os.roles.service.js:173-212`). This is
why the raw SQL bootstrap in the old application-foundation document is not an
acceptable production procedure (`docs/growth-os/02-application-foundation.md:154-174`).

### Deployment path

| Status | Component | Current state | Evidence |
| --- | --- | --- | --- |
| `VERIFIED` | Growth image | Separate `growth-os.yml` verifies, runs disposable browser E2E, and publishes the image. | `.github/workflows/growth-os.yml:14-27`, `:56-177` |
| `VERIFIED` | Runtime image | Docker builds the SPA into nginx and writes `dist/build-info.json` with the build SHA. | `EasyMod-growth/Dockerfile:1-29` |
| `VERIFIED` | SPA health | `/health` and `/health/ready` are served by nginx; the latter checks that `index.html` exists. | `EasyMod-growth/nginx.conf:14-25` |
| `VERIFIED` | Compose contract | Growth image must be supplied as an immutable `GHCR_IMAGE_GROWTH` reference; there is no mutable fallback. | `docker-compose.prod.yml:105-117` |
| `VERIFIED` | First rollout handoff | Deploy carries the running Growth digest forward or requires `GROWTH_BOOTSTRAP_DIGEST` when no Growth container exists. | `.github/workflows/ci-cd.yml:861-883` |
| `PARTIAL` | Caddy certificate | The Growth Caddy block is in the checkout and will be synced by deploy, but the live SNI currently fails TLS. | `Caddyfile:204-230`; `docs/growth-os/EXECUTION_STATE.md:218-223` |
| `PARTIAL` | Rollback | The live deploy script carries Growth image metadata, but the disposable rehearsal fixture contains only backend and merchant frontend services. | `.github/workflows/ci-cd.yml:1169-1181`; `scripts/rollback-rehearsal.sh:229-253` |
| `UNCERTAIN` | GHCR digest availability | The exact digest was published, but the local Docker pull and inspect cross-check was skipped. | `docs/growth-os/EXECUTION_STATE.md:231-252` |

### Automation and AI

**Automation: `VERIFIED ZERO`.** The repository job registry contains the
existing merchant, billing, reliability, and webhook jobs, but none imports or
operates on Growth prospects (`EasyMod-backend/src/jobs/index.js:8-35`). The
Growth route and service modules contain no cron, BullMQ, worker, or scheduler
registration (`growth-os.routes.js:1-14`; `growth-os.prospect.service.js:1-21`).

**AI: `VERIFIED ZERO`, and correct for now.** No Growth module imports the LLM
service or defines a model call (`growth-os.routes.js:1-14`; `growth-os.prospect.service.js:1-21`).
The current code has no Growth-specific model declaration, prompt contract, or
AI spend. Adding scoring or autonomous outreach before there is a live queue
and meaningful prospect volume would add cost and failure modes without closing
the current operating gap.

### Cost and capacity

`VERIFIED`: the incremental runtime shape is one nginx-based
`growth-frontend` container on the existing Compose network
(`docker-compose.prod.yml:5-15`, `:105-117`; `EasyMod-growth/Dockerfile:21-29`).
`VERIFIED`: Growth has no AI spend because it has no AI call. `UNCERTAIN`: no
dollar estimate or Growth model cost is declared in the reviewed docs; the
metrics contract only records that approved targets were not found
(`docs/growth-os/03-metrics-definitions.md:21-32`). Pre-launch restore evidence
reports two users, two shops, and no Growth tables, supporting a single-row
next-action field rather than a queue, but not proving live volume
(`docs/growth-os/EXECUTION_STATE.md:282-289`).

## 5. Remaining Work

The backlog is deploy-first. Each item below names the implementation surface,
acceptance criteria, and the release gate or readiness condition it affects.

### P0: release and first usage

#### P0-1 Reconcile the stale working checkout

**Status: `VERIFIED BLOCKER` for process correctness.**

Files and surfaces:

- `D:\easymod\easy-moderator` default checkout.
- The historical Phase 3 checkout (no longer retained locally).
- `docs/growth-os/README.md` and `docs/growth-os/EXECUTION_STATE.md`.

Acceptance criteria:

1. All Growth reviews and release commands run from a checkout whose commit
   contains `20260820_002_growth_os_prospects.js`, the Growth routes, and the
   current execution state.
2. `git rev-parse --show-toplevel`, `git status --short --branch`, and
   `git log --oneline -5` are captured before any further audit.
3. The stale checkout is either rebased/replaced or explicitly labeled as
   non-authoritative; no release decision uses its Phase 1-only state.

Gate effect: no production gate is closed by this task. It restores evidence
integrity and is the prerequisite for every subsequent gate. The current
source-of-truth rule is `docs/growth-os/README.md:7-17`.

#### P0-2 Execute the first Growth rollout

**Status: `OPEN`.**

Files and surfaces:

- `.github/workflows/ci-cd.yml:659-669`, `:861-883`, `:975-983`, `:1184-1200`.
- `docker-compose.prod.yml:105-117`.
- `Caddyfile:204-230`.
- `docs/growth-os/EXECUTION_STATE.md:231-264`.

Acceptance criteria:

1. Set repository variable `GROWTH_BOOTSTRAP_DIGEST` to the exact bare digest
   recorded by the publication run: `sha256:7421a9b49792fb02d6f8c18acd9d5a547966684529c8dfaa1df8629bdff02b00`.
2. Set `PRODUCTION_DEPLOY_ENABLED=true` only after the production environment
   reviewer gate is intentionally approved.
3. Run the deploy workflow from the intended merged `main` SHA. The workflow
   must pull the immutable Growth reference, sync the Caddy block, run additive
   migrations, reload Caddy, and pass service health checks.
4. Verify `https://growth.easymod.tech/health/ready` returns the Growth-ready
   response and `https://growth.easymod.tech/api/internal/growth-os/session`
   returns sanitized `401` without credentials.
5. Verify the TLS certificate covers `growth.easymod.tech` and capture the
   response, certificate, deployed digest, and workflow run as receipts.
6. Clear the bootstrap variable after the first successful rollout if the
   operator runbook requires the one-time handoff to be consumed.

Gate effect: closes `FIRST_GROWTH_ROLLOUT` and
`GROWTH_TLS_ISSUANCE_GATE`; it advances but does not by itself close
`PHASE_B_POST_DEPLOY_GATE`. The current deployment guard and bootstrap failure
path are explicit in `.github/workflows/ci-cd.yml:668-669`, `:870-883`.

#### P0-3 Bootstrap the first Super Admin through the protected workflow

**Status: `CLOSED 2026-09-26` — see live receipt in `EXECUTION_STATE.md`.**

Implementation closure added on 2026-09-26 (live proof remains open): the
supported path now starts with the protected
`.github/workflows/seed-initial-growth-admin.yml` workflow. It creates only a
shop-less internal identity with a production password hash, forced password
rotation, and an internal bootstrap marker. It does not grant a Growth role.
The canonical `grant-growth-role.yml` path now requires that seeded identity to
finish password rotation and real MFA enrollment, then clears the marker in the
same transaction as the role grant, audit row, and session invalidation.
The prior existing-user requirement below describes the pre-seed deadlock and
must not be used as an alternative account-promotion path.

Closure executed 2026-09-26 (same day, live production): the seed workflow ran
(`36218828021`), the temporary credential was rotated and the old one verified
rejected, MFA was enrolled through the genuine production flow and enforced at
login, `GROWTH_BOOTSTRAP_ACTOR_EMAIL` was configured, and the canonical
`grant-growth-role.yml` run `36220618508` created the first `SUPER_ADMIN`
(user `a5004286-2908-4841-a09f-1a907127c642`) with audit receipt, marker
clear, and session invalidation all confirmed through a fresh authenticated
SUPER_ADMIN session. `GROWTH_BOOTSTRAP_STATUS=CLOSED`. The Sentry browser-DSN
and admin test-event provider-receipt items remain a separate documented
configuration boundary; see the 2026-09-26 live receipt in
`EXECUTION_STATE.md`.

Files and surfaces:

- `.github/workflows/grant-growth-role.yml:1-73`.
- `EasyMod-backend/src/scripts/grant-growth-role.js:3-23`, `:43-70`.
- `EasyMod-backend/src/modules/growth-os/growth-os.roles.service.js:93-149`.
- `EasyMod-backend/src/modules/growth-os/growth-os.middleware.js:98-106`.

Acceptance criteria:

1. Configure the explicit
   `GROWTH_BOOTSTRAP_ACTOR_EMAIL` secret in the protected `production`
   environment after the seeded identity exists. The role workflow must not
   accept an actor as dispatch input or create a user account.
2. Dispatch `grant-growth-role.yml` with the seeded target email and canonical
   `SUPER_ADMIN` role. Do not execute raw SQL; the old SQL procedure has been
   removed from the supported runbook.
3. Capture the role-service result and the `growth_os:role_granted` audit row.
   The transaction must include role creation, audit, and cache invalidation,
   and the one-time bootstrap must refuse to run after an active Super Admin
   exists.
4. Complete the existing TOTP step-up so the authenticated session has
   `mfaVerified=true`; a password-only Super Admin session must remain denied.
5. Verify the Super Admin can load the Growth session and prospect list from
   the live host, while a merchant without the role receives `403`.

Gate effect: closes `OPERATOR_BOOTSTRAP_GATE`. The supported workflow delegates
to the tested backend role service (`grant-growth-role.yml:3-9`, `:64-68`).

#### P0-4 Run the live Growth-origin browser walkthrough

**Status: `OPEN`.**

Files and surfaces:

- `Caddyfile:204-230`.
- `EasyMod-growth/nginx.conf:14-49`.
- `EasyMod-growth/src/auth/GrowthAuthProvider.tsx` and route guard code.
- `EasyMod-growth/src/pages/ProspectListPage.tsx:89-326`.
- `EasyMod-growth/src/pages/ProspectDetailPage.tsx:107-174`, `:397-500`.
- `docs/growth-os/EXECUTION_STATE.md:218-229`.

Acceptance criteria:

1. Use the real `https://growth.easymod.tech` origin, not Vite localhost.
2. Verify health, login, cookie persistence, CSRF acquisition, MFA step-up,
   session loading, prospect list, detail, create, edit, transition, assign,
   link, merge, and logout.
3. Verify the unauthorized matrix: anonymous `401`, merchant `403`, Founder
   without MFA `GROWTH_OS_MFA_REQUIRED`, and Redis/auth dependency failure as a
   sanitized `503`.
4. Verify the browser receives the nginx CSP, cache policy, SPA fallback, and
   health responses. The current E2E configuration runs a Vite dev server and
   therefore is not a substitute (`EasyMod-growth/playwright.config.ts:3-34`).
5. Store a live-origin browser receipt with timestamp, host, build SHA, and
   scenario outcomes.

Gate effect: closes `PRODUCTION_BROWSER_E2E_GATE` and supplies the live portion
of `PHASE_B_POST_DEPLOY_GATE`.

#### P0-5 Import real prospects

**Status: `OPEN`.**

Files and surfaces:

- `EasyMod-backend/scripts/import-growth-prospects.js:120-224`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:628-671`.
- `EasyMod-backend/src/database/migrations/20260820_003_growth_os_prospect_source_reference_idx.js:20-31`.
- `docs/growth-os/04-prospect-foundation.md:92-99`.

Acceptance criteria:

1. Run the importer without `--apply`; save the dry-run counts and failed-row
   details. Dry-run must not mutate source tables or Growth tables.
2. Review source mappings and non-fatal row failures. Correct mapping defects
   before applying rather than suppressing them.
3. Run with `--apply` only after the dry-run review. Capture created,
   skipped-duplicate, and failed counts.
4. Re-run the same command and prove idempotency through `(source,
   source_reference)` and identity deduplication.
5. Verify each created record has an `imported` timeline event and matching
   platform audit row; verify a failure does not partially create a row.

Gate effect: no named pre-deploy gate is closed by the importer. It is required
for the `GROWTH_OS_OPERATIONALLY_READY` usage proof because a ledger with no
real prospects has no business value. The dry-run can run in parallel with
P0-2 because it needs database access, not a live host.

### P1: the smallest operating loop

#### P1-1 Add one next action and due timestamp

**Status: `MISSING`; recommended first product change after P0.**

Files and surfaces:

- `EasyMod-backend/src/database/migrations/` new additive Growth migration.
- `EasyMod-backend/src/modules/growth-os/growth-os-prospect.entity.js`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.validator.js`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.repository.js`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js`.
- `EasyMod-growth/src/api/client.ts`.
- `EasyMod-growth/src/pages/ProspectListPage.tsx` and
  `ProspectDetailPage.tsx`.
- Prospect unit, integration, and browser tests.

Recommended shape:

1. Add nullable `next_action_at` and bounded `next_action` fields to the
   canonical prospect row.
2. Default list ordering to `next_action_at ASC NULLS LAST`, then
   `created_at DESC, id DESC` for deterministic ties.
3. Add `due=now`, `overdue=true`, or one equivalent allowlisted filter.
4. Render due and overdue state in the list and edit/detail flow.
5. Include both fields in ordinary mutation audit snapshots, but do not create
   a separate tasks table, BullMQ queue, SLA engine, or reminder worker yet.

Acceptance criteria:

1. Existing rows remain valid with null next-action fields.
2. Server validation rejects overlong text and invalid timestamps.
3. All scopes retain their existing query predicate and redaction behavior.
4. Due and overdue filters are tested against timezone-safe UTC timestamps.
5. A Founder can identify the next records to act on in one list request and
   record the reason/action without overwriting the append-only timeline.
6. The API, UI, migration, and integration tests pass, and no queue or AI
   dependency is introduced.

Gate effect: no deployment gate; closes the primary manual-ledger operating
gap and makes "who is next?" answerable for a two-person team.

#### P1-2 Make the dashboard truthful

**Status: `PARTIAL`.**

Files and surfaces:

- `EasyMod-growth/src/pages/HomePage.tsx:32-229`.
- `EasyMod-backend/src/modules/analytics/analytics.routes.js:154-173`.
- `EasyMod-backend/src/modules/analytics/growth-metrics.service.js:140-222`.
- Growth frontend API client and home tests.

Acceptance criteria:

1. Fetch `GET /api/analytics/growth` only for a role with
   `growth_os.reports.read_all`.
2. Display observed values as observed, distinguish unavailable data from zero,
   and keep the backend `503` contract intact.
3. Add loading, error, empty, and permission-denied states.
    4. Add tests proving the dashboard does not display static "healthy" numbers
   when the analytics request fails.

Gate effect: no deployment gate; removes a misleading static dashboard while
preserving the founder-only analytics boundary.

#### P1-3 Remove duplicate-conflict scope disclosure

**Status: `PARTIAL`; low-severity security debt.**

Files and surfaces:

- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:730-735`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:777-781`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.repository.js:194-215`.
- `growth-os.prospects.integration.test.js:425-437`.

Acceptance criteria:

1. Duplicate conflict probes during update use the caller's resolved scope, or
   return a generic conflict without an out-of-scope `conflictingProspectId`.
2. The database unique-index race path remains safe and still returns a useful
   in-scope conflict where permitted.
3. Add an integration test for an executive colliding with a foreign prospect
   that proves no foreign UUID is disclosed.

Gate effect: no release gate; reduces cross-scope identifier disclosure.

#### P1-4 Make backend Growth tests run when Growth frontend changes

**Status: `MISSING` in the CI path filter.**

Files and surfaces:

- `.github/workflows/ci-cd.yml:120-148`.
- `.github/workflows/growth-os.yml:29-42`, `:82-86`.
- `EasyMod-backend/src/modules/growth-os/__tests__/growth-os.authz.test.js`.
- `EasyMod-backend/src/modules/growth-os/__tests__/growth-os.prospects.security.test.js`.

Acceptance criteria:

1. A PR changing `EasyMod-growth/**` schedules the backend Growth authorization
   and security suites in the blocking test graph, or the Growth workflow gains
   an equivalent blocking backend job.
2. A PR changing only unrelated merchant files does not pay the full Growth
   integration cost unless the shared backend or migration paths changed.
3. Branch protection behavior is verified on a real draft PR, including whether
   a skipped generic Test & Build Gate is accepted as neutral.

Gate effect: closes a CI coverage gap; the branch-protection result remains
`UNCERTAIN` until verified against GitHub behavior.

### P2: hardening after first use

#### P2-1 Define audit PII retention and redaction

**Status: `MISSING`; security and compliance debt.**

Files and surfaces:

- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:292-304`.
- `EasyMod-backend/src/modules/growth-os/growth-os.prospect.service.js:419-458`.
- `EasyMod-backend/src/modules/audit/audit-log.entity.js:44-75`.
- Audit policy, migration, retention job, and security tests.

Acceptance criteria:

1. Decide which prospect fields may be retained in `audit_logs` and redact raw
   phone, email, page URL, notes, and metadata where policy requires it.
2. Define retention duration, deletion/archival ownership, and access scope.
3. Prove old/new audit snapshots remain useful for operational reconstruction
   without duplicating unrestricted PII forever.
4. Add migration and test coverage; do not break the transactional rollback
   guarantee.

Gate effect: no current release gate; reduces security, privacy, and storage
growth risk.

#### P2-2 Make prospect enumeration limiting user-keyed and fail observable

**Status: `PARTIAL`; reliability/security debt.**

Files and surfaces:

- `EasyMod-backend/src/modules/growth-os/growth-os.routes.js:34-61`, `:82-88`, `:125-131`.
- `EasyMod-backend/src/config/redis.js` rate-limit setup.
- Rate-limit tests and structured operational logging.

Acceptance criteria:

1. Apply a user or internal-identity key to list and lookup surfaces, with a
   separate bounded IP control for abuse.
2. Decide and document the production behavior when Redis is unavailable; do
   not silently downgrade a multi-instance enumeration control to per-process
   memory without an operational signal.
3. Cover `GET /prospects`, duplicate-check, linkage suggestions, and any future
   export endpoint with tests and metrics.

Gate effect: no release gate; reduces PII enumeration and uneven-instance
rate-limit risk.

#### P2-3 Exercise Growth in rollback rehearsal

**Status: `PARTIAL`; release reliability debt.**

Files and surfaces:

- `scripts/rollback-rehearsal.sh:229-253`, `:292-320`, `:361-390`.
- `.github/workflows/ci-cd.yml:985-1039`.
- `docker-compose.prod.yml:105-117`.

Acceptance criteria:

1. Add a Growth frontend service to the disposable rehearsal fixture with an
   immutable image reference and `/health/ready` check.
2. Capture and restore the Growth image reference, Compose file, Caddyfile, and
   environment hash.
3. Prove candidate rejection, rollback restoration, health, and missing-previous
   image failure for the Growth service as well as backend/frontend.
4. Decide and document schema rollback policy; the current rehearsal correctly
   avoids pretending that `migrate:down` is safe, but it does not test Growth
   schema rollback.

Gate effect: strengthens `ROLLBACK_REHEARSAL_GATE`; the existing receipt is not
invalid, but its scope must be stated as backend/frontend-only.

#### P2-4 Add lint and remove dead build configuration

**Status: `MISSING`.**

Files and surfaces:

- `EasyMod-growth/package.json:7-12`.
- `EasyMod-growth/Dockerfile:9-19`.
- `.github/workflows/growth-os.yml:69-86`, `:164-177`.
- New lint configuration and CI step.

Acceptance criteria:

1. Add a repository-compatible lint command and run it in the Growth blocking
   workflow.
2. Decide whether `VITE_ENV` is needed; if not, remove the unused build arg and
   CI input, or add a real runtime/build behavior and test it.
3. Keep typecheck, behavioral tests, build, and lint separate so green build
   output does not masquerade as behavioral coverage.

Gate effect: no production gate; reduces maintainability and dead-config risk.

#### P2-5 Run browser E2E against the built nginx image

**Status: `PARTIAL`.**

Files and surfaces:

- `EasyMod-growth/playwright.config.ts:29-34`.
- `scripts/run-growth-e2e.js:206-212`.
- `EasyMod-growth/Dockerfile:21-29`.
- `EasyMod-growth/nginx.conf:14-49`.

Acceptance criteria:

1. Build the exact Growth image used by the test or load the image into a
   disposable Compose stack.
2. Route the browser through nginx and Caddy-equivalent API behavior rather
   than the Vite dev server.
3. Assert CSP, cache headers, SPA fallback, health endpoints, unsupported API
   404 behavior, and cookies in addition to current prospect workflows.
4. Retain the existing 390px, 768px, and 1440px scenarios after the image path
   is added.

Gate effect: closes the production-parity portion of the browser confidence
gap; it does not replace the live-origin receipt.

### Defer and reject decisions

The historical determination said the original `GROWTH_OS_GOAL.md` and legacy
`CURRENT_STATE.md` were absent. The current repository contains
`GROWTH_OS_GOAL.md` and `GROWTH_OS_CURRENT_STATE.md`; the seven questions below
remain explicit decision tests rather than a claim that the historical legacy
list was recovered:

1. What user problem is being solved now?
2. Is there enough real volume and evidence to justify the proposed system?
3. What is the smallest reliable operating loop?
4. Does the work create an auditable human action?
5. Does it preserve existing source-of-truth boundaries?
6. Is its operational, security, and cost risk acceptable now?
7. What evidence would justify expanding the scope later?

| Decision | Status | Scope | Product-judgment trace |
| --- | --- | --- | --- |
| Defer demos | `VERIFIED DECISION` | No demo workflow until the qualified queue has a follow-up loop. | Q1/Q2/Q3: the current pain is dropped follow-up, and production evidence shows pre-launch scale (`EXECUTION_STATE.md:282-289`). |
| Defer trials | `VERIFIED DECISION` | Billing trial states remain authoritative; do not create a second Growth trial system yet. | Q5/Q6: subscriptions already own billing state (`subscription.entity.js:63-71`), while Growth has no trial behavior. |
| Defer retention and churn scoring | `VERIFIED DECISION` | Keep the existing observed order-based metric; wait for real cohorts and interventions. | Q2/Q7: current metrics contract calls targets and hypotheses unapproved (`03-metrics-definitions.md:21-32`). |
| Defer command center | `VERIFIED DECISION` | Make the operational overview truthful and the queue actionable before adding a cross-funnel command center. | Q1/Q3/Q4: the existing overview plus no next-action field does not justify another surface (`HomePage.tsx`). |
| Defer referral/testimonial | `VERIFIED DECISION` | Revisit after merchants have completed and valued the core product. | Q2/Q7: referral is only a source value today and no outcome loop is evidenced (`growth-os.prospect.lifecycle.js:26-32`). |
| Reject AI outreach copilot | `VERIFIED DECISION` | No model, prompt, external send, or AI cost in Growth OS now. | Q4/Q6: automation and AI are absent by design; human-audited next action is safer (`growth-os.routes.js:1-14`). |
| Reject lead scoring | `VERIFIED DECISION` | Do not score sparse, unvalidated records before a due-action queue exists. | Q2/Q3/Q7: there are no approved target values and no real prospect history (`03-metrics-definitions.md:21-32`; `EXECUTION_STATE.md:282-289`). |
| Reject autonomous agents | `VERIFIED DECISION` | No autonomous state transitions or outbound actions. | Q4/Q6: lifecycle mutations are deliberately human and audited (`growth-os.prospect.service.js:843-893`). |
| Reject the Master Goal nine-agent orchestration model | `VERIFIED DECISION` | Do not add orchestration worktrees or agents without a repository-traceable operational need. | Q1/Q3/Q6: the current bottleneck is three release acts and one thin queue, not coordination infrastructure. |
| Reject further evidence-bookkeeping worktrees | `VERIFIED DECISION` | Record receipts in the execution state and ship the release instead of producing more parallel receipt-only branches. | Q1/Q3/Q7: the evidence base already exceeds live usage; the next proof must be a live usage proof (`EXECUTION_STATE.md:317-361`). |

## 6. Risks and Technical Debt

These are the concrete risks worth carrying forward. Cosmetic issues are
omitted. Each item states consequence and the recommended disposition.

| # | Status | Risk | Consequence | Disposition |
| --- | --- | --- | --- | --- |
| 1 | `PARTIAL` | Update duplicate probes pass `scope: null` and can expose an out-of-scope conflicting prospect UUID. | Security: low-severity cross-scope identifier disclosure; product: a caller may infer another record exists. | Fix in P1-3; cite `growth-os.prospect.service.js:730-735`, `:777-781`. |
| 2 | `PARTIAL` | `auditSnapshot` removes normalized columns but retains raw contact PII, page URL, notes, and metadata in `audit_logs`. | Security/compliance: broader audit access and indefinite accumulation increase PII exposure; cost: table growth. | Define redaction and retention in P2-1; cite `growth-os.prospect.service.js:292-304`, `audit-log.entity.js:44-75`. |
| 3 | `PARTIAL` | Only duplicate-check and linkage suggestions use the targeted limiter; the list route has no route-specific limiter, and Redis fallback returns the process MemoryStore. | Security/reliability: enumeration controls are incomplete and inconsistent across instances; cost: potentially avoidable database load. | Fix in P2-2; cite `growth-os.routes.js:34-61`, `:68-88`, `:125-131`. |
| 4 | `PARTIAL` | Backend Growth security tests do not run from the `ci-cd.yml` changed-path cases when only `EasyMod-growth/**` changes. | Reliability: frontend authorization assumptions can drift without the backend negative suites. | Fix in P1-4; cite `.github/workflows/ci-cd.yml:120-148` and `.github/workflows/growth-os.yml:29-42`. |
| 5 | `VERIFIED` | The old application-foundation document still presents raw SQL role bootstrap. | Security/operability: operators can bypass audit, last-Founder protection, and cache invalidation if they follow stale instructions. | Correct the document or prominently redirect to the workflow in P0-3; cite `02-application-foundation.md:154-174` and `grant-growth-role.yml:3-9`. |
| 6 | `VERIFIED` | `EasyMod-growth/README.md` says there is no behavioral test suite, while the repository has Vitest and browser E2E coverage. | Reliability/process: contributors may skip the real test commands or misread coverage. | Correct README in a small documentation change; cite `EasyMod-growth/README.md:30-46`, `package.json:7-12`, `playwright.config.ts:7-34`. |
| 7 | `PARTIAL` | Growth frontend has no lint command, and `VITE_ENV` is passed through Docker/CI without a demonstrated consumer. | Maintainability: dead configuration and absent static checks increase drift risk; cost: failures surface later in CI or runtime. | Fix in P2-4; cite `EasyMod-growth/package.json:7-12`, `Dockerfile:9-19`, `growth-os.yml:164-177`. |
| 8 | `PARTIAL` | Playwright uses a Vite dev server, not the nginx image and its CSP/cache/SPA fallback. | Reliability/security: production-serving behavior is untested; browser confidence overstates deployment parity. | Fix in P2-5; cite `playwright.config.ts:29-34`, `nginx.conf:14-49`. |
| 9 | `PARTIAL` | Rollback rehearsal omits the Growth service and does not exercise schema rollback. | Reliability: a Growth-specific rollback failure can escape the current receipt; data safety: migration reversal remains manual and unproven. | Fix in P2-3; cite `scripts/rollback-rehearsal.sh:229-253` and current receipt caveat `EXECUTION_STATE.md:207-210`. |

## 7. Recommended Execution Order

1. **P0-1 first.** Reconcile the stale checkout and establish the authoritative
   commit before anyone edits release configuration or audits gaps.
2. **P0-2 second.** Run the first rollout. TLS is intentionally circular: the
   Growth Caddy block is delivered and reloaded by the gated deploy, so a
   pre-deploy TLS failure cannot be closed independently
   (`EXECUTION_STATE.md:218-223`, `:300-306`).
3. **P0-3 third.** Bootstrap the Founder only after the live host exists; use
   the audited workflow, not raw SQL.
4. **P0-4 fourth.** Run the live-origin browser walkthrough after both TLS and
   Founder bootstrap are complete.
5. **P0-5 in parallel with P0-2 as dry-run.** It needs the database, not the
   live host. Apply only after the dry-run mapping is reviewed.
6. **P1 items after P0.** P1-1, P1-2, P1-3, and P1-4 are independent and can
   be parallelized once the release boundary is proven.
7. **P2 after first usage.** Use real audit volume, request volume, browser
   receipts, and rollback evidence to set the retention, limiting, and parity
   policies rather than guessing at pre-launch scale.

This order is intentionally not a feature roadmap. It first makes the existing
system real, then makes it useful, then hardens the observed failure modes.

## 8. Definition of Done

The release may be labeled `GROWTH_OS_OPERATIONALLY_READY` only when all of the
following objective evidence exists:

| Status required | Evidence |
| --- | --- |
| `PASS` | All applicable `EXECUTION_STATE.md` release gates are `PASS`, including `GROWTH_TLS_ISSUANCE_GATE`, `OPERATOR_BOOTSTRAP_GATE`, `PRODUCTION_BROWSER_E2E_GATE`, and `PHASE_B_POST_DEPLOY_GATE`. |
| `GO` | `OVERALL_GROWTH_OS_RELEASE_VERDICT: GO` replaces the current `NO-GO` (`EXECUTION_STATE.md:408-431`). |
| `VERIFIED` | `https://growth.easymod.tech` serves a valid certificate for the Growth hostname, and `/health/ready` is healthy through the real Caddy/nginx path. |
| `VERIFIED` | A real existing app user is granted `FOUNDER` through `grant-growth-role.yml`, with an audit receipt and MFA-backed session. |
| `VERIFIED` | The dry-run importer is reviewed, `--apply` imports real source records, and a repeat run proves idempotency. |
| `VERIFIED` | The live Founder moves at least one real prospect through `new -> contacted -> qualifying -> qualified -> converted` in the UI, with a linked shop before conversion. |
| `VERIFIED` | The prospect event timeline and platform `AuditLog` both contain the complete mutation history, and an audit failure would still roll back the product mutation. |
| `VERIFIED` | A live-origin browser receipt covers the authorized and unauthorized access matrix and records the deployed build digest. |

The minimum usage proof deliberately stops at the existing lifecycle. It does
not require demos, trials, AI, scoring, retention automation, or referrals. Those
are later decisions that require real volume and evidence.

## Verification Record

This deliverable is a document, so verification is read-back and citation
review rather than an application test run.

1. Spot-check every cited path in the current repository revision, including
   the migration checks/indexes, the `scope: null` sites, the workflow bootstrap
   path, and the rollback fixture.
2. Compare every quoted `EXECUTION_STATE.md` gate and value against the source;
   the current source remains `NO-GO` and production deploy remains disabled.
3. Confirm every P0 and P1 task names implementation files, acceptance criteria,
   and the gate or readiness condition it affects.
4. Confirm all defer/reject decisions have a product-judgment trace and do not
   silently turn hypotheses into production facts.
5. Treat the published GHCR digest, strict branch-protection interpretation,
   and all live production state as `UNCERTAIN` where the source says the local
   or live check was not independently completed (`EXECUTION_STATE.md:249-252`,
   `:363-371`).

The discovery that produced this document was read-only. It touched no
production host, database, prospect data, secrets, billing state, DNS, TLS,
infrastructure, registry state, or external service. The Growth image
publication and prior CI receipts are recorded evidence, not actions performed
by this document.

## Historical platform audit reconciliation (2026-09-21)

The dated determination and the evidence below are historical to the audit date:

- `origin/main` was `cf57db1e4706c9d7b3b32f180e1dbede3b64e7c4`; the recorded
  `cf634fab...` current-main value is stale.
- The current repository still contains the Growth backend/frontend surface and
  the separate path-filtered `growth-os.yml` pipeline. It is not part of the
  merchant image build/deploy decision except for preserving the running
  immutable Growth reference during a production cutover.
- GitHub's latest production deployment record is for `cf57db1e...`, but the
  live Growth digest, TLS certificate, authenticated Founder bootstrap, and
  real-origin browser walkthrough were not independently verified in this audit.
- `PRODUCTION_DEPLOY_ENABLED` was observed `true` after the latest manual
  deployment and was restored to `false` on 2026-09-21. No production deploy was
  initiated by this audit.
- The release disposition remains `CONDITIONAL / NO-GO` until the three live
  Growth acts named in the historical determination have receipts from the
  current deployment.

## Historical intermediate reconciliation (before the 2026-09-23 release)

- `origin/main` is now `45f651927aae21db5aea9de62c675cbb6f8e5bbb` after PR #127
  was validated and merged.
- The production receipt remains the earlier `cf57db1e...` deployment; the merge
  did not itself deploy or alter production.

## Current production reconciliation (2026-09-23)

- Current `origin/main` should be read from GitHub or `git rev-parse origin/main`;
  production runs the code-equivalent `696a83c9f75737c2609873f0c09c6498bcfb6332`.
  Intervening main commits changed only documentation and tests.
- The bounded production workflow used the existing `production` environment;
  GitHub has no `growth-bootstrap` environment. `PRODUCTION_DEPLOY_ENABLED` was
  restored to `false` after the successful cutover.
- Public Growth readiness returned HTTP 200, but the running Growth image digest,
  authenticated Founder bootstrap, and live authenticated browser walkthrough
  remain unverified. The Growth release verdict therefore remains conditional.

## 2026-10-07 Completion Branch Reconciliation

The completion branch closes the locally actionable correctness and release
hardening gaps identified above:

- source/assigned Growth analytics follow-up counts now use the same cohort and
  row scope as the report;
- source-scoped search no longer returns owner identifiers, and normalized
  search preserves Unicode letters/numbers;
- prospect audit snapshots redact contact fields, URLs, notes, metadata, source
  references, and disqualification reasons;
- prospect merge uses `RESTRICT` referential integrity and rehomes follow-ups
  and notes to the surviving prospect;
- delayed prospect linkage reconciles an already-recorded first AI reply;
- follow-up owners must have an eligible operational Growth role;
- Growth read/mutation quotas are authenticated-user keyed and Redis fail closed
  outside development;
- migrations serialize through a PostgreSQL transaction advisory lock and the
  source-cohort indexes are present in the entity, migration, and sync paths;
- production config explicitly opts Growth in, validates its CORS origin, binds
  changed Growth images to the deployed commit, and rollback restores Growth
  and reloads/validates Caddy;
- the restore drill reads the actual Growth tables and extracts the uploads
  archive into an isolated volume;
- the worker exposes readiness, Compose logs rotate, the Growth Nginx image has
  a deterministic API 404 boundary, and CI runs a built-image smoke gate;
- Growth Vitest file parallelism is deterministic and the repository has a
  strict Growth lint gate.

The following remain release evidence gates rather than code claims: PostgreSQL
and Redis integration receipts, Docker/image smoke execution on a runner with
the daemon available, live Growth origin health/auth/CORS proof, production
repository variables and secrets, off-site backup credentials, reviewer
approval, CI for the final branch SHA, and an authorized deployment.
