# Courier destination — release evidence

Release candidate for the courier-destination completion (finding **R-2** of the
2026-11-03 release-gate program). A parcel can only book when the courier receives
a routable destination that belongs to the **order**, never the merchant's pickup
area. This document records the verification evidence for the candidate.

- **Base (`origin/main`)**: `47f442edecc4074a3c4f51da4e3348986d22a418` — "fix(courier): separate serviceability policy from booking payload validity (#240)"
- **Candidate branch**: `feat/courier-destination-completion`
- **Commit A (code)**: `9a6797b0` — "feat(courier): confirm, correct and revalidate the booking destination" (additive on `815ffe30`)
- **Commit A2 (test-infra fix)**: `fac3ccd2` — "fix(test): scope the BullMQ unit stub to the unit lane only" (additive on `9a6797b0`; see Phase C below)
- **Commit A3 (review fixes)**: `0d1bc814` — "fix(courier): resolve independent-review findings on the destination boundary" (additive on `fac3ccd2`; see Phase 4 adjudication)
- **Commit B (docs)**: this file + `COURIER_DESTINATION_CONTRACT.md`
- **Schema**: no new migration. Destination lives in the existing `orders.delivery_location` JSON carrier; schema is identical to base.

## Local verification gates

Environment: Windows 11, **node v25.6.1** (CI runs node 20), Docker Engine 29.8.2 / compose v5.5.1. Disposable infra only (`docker-compose.test.yml`, tmpfs, ephemeral ports, `_test` DB-name guard). Logs retained under `artifacts/courier-release-202611/` (outside the repo).

| Gate | Command | Result | Counts | Log |
|---|---|---|---|---|
| Dependencies | `npm ci` | PASS (exit 0) | 4 workspaces | — |
| Frontend types | `tsc --noEmit` | PASS (exit 0) | 0 errors | — |
| Frontend unit (node 20, Docker) | `npm run test:unit` (vitest) | **PASS (exit 0)** | **806/806, 93 files** (CI parity; +3 QA-6) | `19-frontend-node20-docker.log` |
| Frontend build | `npm run build:frontend` | PASS (exit 0) | — | — |
| Backend unit | `npm run test:backend` | PASS w/ env caveat | 4827 passed, 2 skipped, 2 env failures (4831 total); 358/359 suites | `22-unit-a3.log` |
| Test discovery | `npm run test:discovery` | PASS (exit 0) | 395 files, all homed; 393 coverage; 2 quarantined | `20-discovery-a3.log` |
| Backend security | `npm run test:security` | PASS (exit 0) | 910/910, 58 suites | `21-security-a3.log` |
| **Integration (Docker)** | `npm run test:backend:integration:docker` | **PASS (exit 0)** | **227/227, 32 suites** | `23-integration-a3-docker.log` |
| Meta-shaped E2E (Docker) | `npm run test:backend:meta:e2e:docker` | **PASS (exit 0)** | **48/48, 2 suites** (after A3) | `24-meta-e2e-a3-docker.log` |
| Migration dry-run (prod-shaped) | `npm run test:backend:migration-dryrun` | **PASS** | 6/6 round-trip; latest `20261103_001`; no new migration | `12-migration-dryrun.log` |

> **Rerun after A3 (`0d1bc814`).** Every gate is rerun against the final candidate commit. A2 relocated the BullMQ stub / unit mapper; A3 changed `order.service.js` + `order.validator.js` and three backend test files, so discovery, security, unit, integration and meta-e2e all rerun. The frontend unit gate runs on **node 20 in Docker** (CI parity) because vitest cannot initialize its runner on local node 25. Authoritative logs: `19` frontend · `20` discovery · `21` security · `22` unit · `23` integration · `24` meta-e2e. Migration dry-run is unaffected (no migration change; schema identical to base, `12-migration-dryrun.log`).

### Backend unit caveat — pre-existing, environment-only, NOT a candidate defect

`grounding-boundary.test.js` (AI grounding, outside the courier blast radius) fails 2 tests locally: `repeated customer pressure › asking again never converts NOT_FOUND into a claim` (10s timeout) and the cascading `conversation history is not evidence › a hallucinated turn…` (an in-flight LLM call from the timed-out test leaks into the next test's mock count).

Root cause: the suite transitively opens real Redis cache clients (`src/config/redis.js`, `maxRetriesPerRequest: 3`); with no Redis on the unit lane, each cache call retries ~300–500ms, and on **node 25** test 6's four sequential grounding calls exceed the 10s timeout. Proven **pre-existing and environmental**:

- Base `47f442ed` run in the **same node-25 environment** fails the **identical 2 tests, identical reasons**, 175.07s vs candidate 175.307s (`07-grounding-base-comparison.log` vs `06-grounding-isolated.log`).
- CI runs this exact suite on **node 20 without Redis**: PR #240 "Quality fast (affected backend/frontend)" = **pass** (run 41764471327, job 126359554942, 5m42s).
- The candidate does not modify `grounding`, `intent-router`, `llm.service`, or `redis.js`; the only `jest.config.js` change adds a `^bullmq$` mock mapper that *reduces* Redis connections.

The A3 full unit lane (`22-unit-a3.log`) reproduces **only** these 2 failures — 358/359 suites green, 4827 passed — so the candidate's own code (including A3's `updateOrder` deep-equality/sanitizer changes) breaks no audit assertions. The authoritative gate is CI (node 20). All courier-relevant unit/security tests pass.

### Frontend unit caveat — node-25 environment, NOT a candidate defect

Vitest cannot initialize its runner on the local **node v25.6.1**: every suite fails at its first `describe` with `TypeError: Cannot read properties of undefined (reading 'config')` (0 tests), accompanied by node-25's experimental `--localstorage-file` warning. Proven **environmental, not the candidate**: an untouched pre-existing file (`src/api/domains/__tests__/setup.test.ts`) fails identically. The authoritative gate is CI's `npm run test:unit` on **node 20** (`ci-cd.yml:306-310`, blocking "Quality fast"), reproduced here in a `node:20` Docker container with a fresh linux `npm ci`: **93 files / 806 tests pass, exit 0** (`19-frontend-node20-docker.log`). The `ECONNREFUSED 127.0.0.1:3000` line in that log is a test exercising an error path, not a failure.

## Phase C green-rerun (the prior release blocker)

The 2026-11-03 program blocked on `meta-webhook-durability.integration.test.js` calling `getJobs`/`getJob` on a BullMQ mock that only existed in the unit lane. Fix in the candidate: `jest.unmock('bullmq')` + a `require.resolve('bullmq')` tripwire + real `getJobs`/`getJob` assertions, so the integration lane runs real BullMQ + Redis.

**Verified green** in the authoritative Docker integration run (`10-integration-docker.log`, pre-A2):
- `PASS src/modules/integration/__tests__/meta-webhook-durability.integration.test.js (8.893 s)`
- `PASS src/modules/webhooks/__tests__/payment-webhook.courier-race.integration.test.js`
- Full suite: **32 suites / 227 tests passed**, migrations applied clean to the disposable DB.

### A2 — BullMQ stub lane-scoping fix (`fac3ccd2`)

Local meta-e2e verification caught a regression **in the candidate itself**: the unit stub originally lived at `tests/__mocks__/bullmq.js`. Jest's haste-map auto-registers ANY `__mocks__/<node-module>.js` as a manual mock applied in **every** lane, so the stub silently replaced real BullMQ in meta-e2e (48/48 failed). Integration only survived because of its explicit `jest.unmock('bullmq')`; meta-e2e had none.

Root-cause fix (A2, additive): `git mv tests/__mocks__/bullmq.js tests/stubs/bullmq.js` (byte-identical, R100) + point the unit config's `^bullmq$` mapper at the new path. Outside `__mocks__/`, the stub activates **only** through the explicit unit mapper; integration and meta-e2e get real BullMQ. Unit behavior is unchanged (the mapper already covered every `bullmq` import; the stub content is identical).

**meta-e2e Docker rerun: 48/48, 2 suites, `META_E2E_EXIT=0`** (`11-meta-e2e-docker.log`).

### Fixture-hazard guard (CI-green proof)

`native-auth-responses.json` is a **regenerated output** (`fs.writeFileSync`, `native-auth.integration.test.js:711`), not a golden input; its only reader is the mobile contract test (ADR M-003 shape drift). The committed fixture at `fac3ccd2` is **byte-identical to base `47f442ed`** (`git diff 47f442ed..HEAD -- <fixture>` is empty), so CI validates exactly the fixture `main` already passes. The local working-tree churn (timestamp/id regeneration) is excluded from every commit. No CI hazard.

## Race guard (stale-destination protection)

Reuses the existing mechanism — no new revision field. `courierBookingFingerprint` (confidenceRules.fingerprint + order_status) is compared under `SELECT … FOR UPDATE`; a mismatch returns 409 `ORDER_CHANGED_BEFORE_COURIER_CLAIM`; the payload is rebuilt from the locked latest row (`buildCourierOrderData`); dispatch-claim CAS + `COURIER_DISPATCH_ACTIVE` give mutual exclusion.

The two reads live in **separate transactions** (`order.service.js:3029-3036` gate read commits and releases its lock; `3082-3085` claim re-read re-acquires it), so a destination edit that commits in the gap is caught by the fingerprint compare at `3097`. Coverage is layered:

- **Deterministic unit pins** — `order-confidence.gate.test.js`: a `delivery_address` change before claim → 409 (`test.each` row), and an area-only confirmed change before claim → books the **refreshed** `recipient_area` (12), never the stale id (11), via the `findOne` Once/Once harness; plus "provider payload is built from the locked order snapshot" and "rechecks persisted order status under a row lock" (asserts `lock: 'UPDATE'`).
- **Real-PostgreSQL concurrency** — `order-confidence.integration.test.js`: "a READY order books exactly once under concurrent booking requests" (5 simultaneous `bookForOrder` → 1 provider call, 1 COMMITTED dispatch); "a material edit after approval voids it and the order is held again" (real `updateOrder({delivery_address})` → `RESOLUTION_STALE`, `resolution_fingerprint !== input_fingerprint`, `stale:true`); "after a successful booking, later order updates never cause a second booking" (`COURIER_DISPATCH_ACTIVE` fail-closed). `courier-dispatch-ownership.integration.test.js`: concurrent same-provider and **cross-provider** double-book both blocked; stale terminal transition refused.

**QA-3 adjudication (no new test).** The only interleaving not explicitly exercised is a destination UPDATE committing in the narrow gap between the two locked reads of a *single* in-flight booking. That sliver is a PostgreSQL READ COMMITTED guarantee (a fresh `SELECT … FOR UPDATE` in a new transaction sees committed changes), not application logic — the app's reaction to the change is fully unit-pinned above, and real row-lock serialization is integration-proven. A test for that exact interleaving would require either mocking the real confidence gate to inject a mid-flight mutation (degrading the integration suite) or non-deterministic timing (flakiness risk against a blocking gate). Per YAGNI it is **accepted as covered**; residual risk owner: backend.

## Independent review adjudication (Phase 4)

Three independent reviews of `47f442ed..HEAD` (QA, Security, Ops). Verdicts: **no P0** from any reviewer; Security **no P1**; QA elevated one finding (CONTRADICTED rethrow) to P1. All actionable findings resolved in **commit A3** (additive on `fac3ccd2`) before PR; the rest accepted with rationale.

### Resolved in A3 — 4 code fixes

| # | Finding | Sev | Fix | Pinning test |
|---|---|---|---|---|
| 1 | `COURIER_DESTINATION_CONTRADICTED` absent from the pre-provider rethrow whitelist → a contradicted destination was swallowed into a generic failure for `throwOnError:false` callers | P1 (QA) | added to the `!providerCallStarted` whitelist (`order.service.js:3381`) | "a contradicted destination reaches throwOnError:false callers as the specific 409" |
| 2 | Confirm-schema id strings unbounded → a huge `area_id`/`zone_id`/`city_id` amplifies directory comparisons (DoS) | P2 | `.max(64)` on all three (`order.validator.js:184-188`) | "bounds id strings so a huge id cannot amplify directory comparisons" |
| 3 | A JSON-string `delivery_address` bypassed `sanitizeStructuredAddress` → courier ids smuggled in the string form survived | P2 | normalize a JSON-object string to an object before stripping (`order.service.js:1108`) | "strips courier ids smuggled in a JSON-string delivery_address" |
| 4 | Reference equality (`!==`) in the `updateOrder` audit flagged a byte-identical address resubmission as changed → wiped a merchant confirmation | P2 | deep equality `valuesEqual` (`order.service.js:1101`) | "a byte-identical address resubmission keeps the merchant confirmation" |

Test hardening alongside: an ambiguous directory match never guesses an id at booking (2 Mirpur/Dhaka areas → `PAYLOAD_INVALID`); QA-5 strengthened (another courier's confirmed selection — with `source`/`confirmed_at`/`confirmed_by` markers — survives); directory-route auth/membership **ordering** pinned (Security P2-1). Targeted courier blast-radius: **9 suites / 270 tests pass** (`17-targeted-a3.log`).

### QA-6 — frontend recovery UX (resolved)

Added to `CourierBookingModal.test.tsx`: steadfast **never renders the directory** (it books by text address); a 409 `COURIER_DESTINATION_PAYLOAD_INVALID` **or** `COURIER_DESTINATION_CONTRADICTED` **auto-opens the area picker** so the merchant can correct it. The safety boundary (server `enforced` fail-closed, D5-1; correct native confirm ids for REDX/Pathao) was already pinned. "Picker re-render" polish skipped — the server re-decides every book, so no frontend UX defect can produce a wrong parcel.

### Accepted with rationale — no code change

- **Rollback fails-closed** (Ops): app-level snapshot + previous-digest rollback; no down-migration (forward-fix only). No new migration ⇒ previous images stay schema-compatible.
- **PATCH `delivery_location` guard** (Security): the generic update validator rejects injected `provider_destination`; only the confirm endpoint writes it.
- **Directory-read role relaxation** (Security named item): `requireOwner` dropped from 4 read-only directory GETs, but `authenticate` + `verifyShopAccess` remain and are now **ordering-pinned**; tenancy-safe (a member reads only their own shop's courier directory).
- **Storefront stale-bundle deploy note** (Ops): cached pre-candidate bundles send `area` only; the validator's `.or('area','upazila')` accepts both and fresh bundles send both — no rejection window. Cache-busting carried in the deploy plan.
- **Cumulative deploy delta** (Ops): prod `91c0558e` → HEAD adds only migration `20261103_001` plus undeployed PRs #236–#240; rehearsed at the candidate digest.

## Provider audit (Gate E)

Founder constraints honoured: live courier APIs **read-only**; Pathao/RedX **sandbox** create-chains allowed; **Steadfast sandbox forbidden** (its sandbox host IS production) — zero Steadfast network requests. No credential or token value is written into any repo file; receipts store hashes only.

| Provider | Lane | Verdict | Evidence |
|---|---|---|---|
| **Pathao** | Sandbox read | **VERIFIED** | issue-token (password grant) → city-list (64) → zone-list (12) → area-list (156); adapter-exact paths; `pathao-sandbox-receipt.json` |
| **Pathao** | Sandbox create-chain | **VERIFIED** | stores-list (reuse store 37) → order-create (dest city 52 / zone 156 / area 13193, non-COD) → order-info; consignment `DS121126JKZJSU`; `pathao-sandbox-create-receipt.json` |
| **Pathao** | Live | UNVERIFIED (blocked) | Needs merchant portal username/password — off-limits per founder constraint. Prod has no Pathao integration row; non-blocking. Adapter ≡ vendor doc verified by inspection (`pathao.provider.js` TOKEN_PATH `/aladdin/api/v1/issue-token`, grant_type password; `provider.registry.js:47-50` hosts). |
| **RedX** | Live read-only | **VERIFIED** | `GET /areas` → 200, **2866 areas**; `API-ACCESS-TOKEN: Bearer` auth + host + endpoint correct; `redx-audit-receipt.json`. No mutation issued. |
| **RedX** | Sandbox create-chain | UNVERIFIED (auth) | Env `REDX_TOKEN` is a live merchant token; sandbox rejects it (`401 invalid signature`). No sandbox credentials available. Deterministic adapter evidence stands. |
| **Steadfast** | Any network | **FORBIDDEN / none** | Sandbox host = production. Zero requests. Deterministic-only. Prod row inactive; non-blocking. |

### Deterministic provider/destination evidence (in-tree, all green in `test:security` / integration)

- `provider-adapters.test.js`: **"registry never invents a RedX destination from pickup metadata (P0 regression)"**, "registry never invents Pathao location ids from metadata", "registry takes the RedX destination from order data and the store from metadata", "registry emits Pathao location ids supplied by the order", "RedX uses the environment host, documented auth header, endpoint, and timeout", "RedX provider errors carry status and redact the API key", "Pathao provider errors … redact access credentials", "all providers preserve an explicit zero collection amount ahead of order total fallbacks".
- `courier-destination.service.test.js`: "trusts provider ids only when the server confirmation marker is present", "returns an empty destination rather than inventing one", "an ambiguous match without a district is UNCERTAIN, never a guess", "a provider lookup failure is CHECK_UNAVAILABLE, not SERVICEABLE", "a lookup failure is never cached", Steadfast "has no destination directory, so it answers UNCERTAIN honestly".
- `order.courier-destination.test.js`: "sends the order directory match to the provider, not the pickup area", "COURIER_SERVICEABILITY_ENFORCE turns NOT_SERVICEABLE into a 409 without a provider call", "a directory lookup failure cannot produce an addressable payload, so it refuses instead of sending one", "the resolution kill switch skips the directory and the unaddressable payload is refused", "a selection confirmed for one courier is never reused for another", "invalidates an old confirmation when the address changes and books against the corrected area", "a chatbot free-text order becomes bookable after merchant confirmation", "a merchant-confirmed area still books when destination resolution is switched off".
- `order.build-courier-order-data.test.js`: "carries the ids the merchant confirmed for that courier", "never sends one courier's ids to another", "does not send unnamespaced or unconfirmed ids without a successful directory lookup", "uses a chatbot full-address carrier when no structured delivery address exists", COD safety ("ignores client-supplied collection amounts and derives COD from the order total", "missing payment method blocks unpaid courier booking instead of assuming COD").

### Production inertness (code-verified)

Prod has **no RedX/Pathao integration rows** and the **Steadfast row is inactive**. Merchants therefore hit `blockedCourierResolution` → `markCourierSetupRequired`; the release is **courier-inert in production**. No provider activation, no feature-flag changes. AI-path courier booking is fail-closed at production defaults (`AI_COURIER_BOOKING_ENABLED`, pinned by `production-defaults-matrix.test.js`).

## Exclusions preserved (never committed)

- `EasyMod-backend/src/modules/auth/native/__tests__/__fixtures__/native-auth-responses.json` — regenerated fixture churn (the native-auth integration test rewrites it; it is an output, not an input). Left modified-uncommitted.
- `docs/ai/product-experience-v1/artifacts/`, `docs/ai/product-experience-v1-3/artifacts/` — unrelated untracked artifacts. Left untracked.

No `git stash`, no `git clean`, no `reset --hard`, no force-push. Commit A staged with explicit pathspecs only.

## Rollback target (current production pair)

Production currently runs `91c0558e`. The recorded app-level rollback pair (receipts `/opt/easymod/.cutover-rollback/41537253598/`):
- backend `sha256:1ba00a97…`
- frontend `sha256:cfd0483e…`
- growth `sha256:e3e46b09…`

Schema rollback is out of scope (forward-fix only); no new migration in this candidate, so the previous images remain schema-compatible. Full digests re-confirmed from the droplet receipts at deploy time.

## Pending (gated — not yet performed)

- Push branch → PR to `main` → protected CI (PR Merge Gate + Security Scan) → squash merge → NEW_MAIN_SHA + image digests.
- `backup.yml` restore-drill at the new backend digest (main-only, fresh prod dump first).
- **STOP for Approval B** (explicit founder authorization of the exact merged SHA). No deploy without it.
- **Approval C** (live courier automation) remains separately gated; production code deployment does not authorize live booking.
