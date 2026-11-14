# IMPLEMENTATION_REPORT — Business Profile & Channel Automation Redesign

Mission: prove → challenge → approve → implement → test real behavior → independently review → report.
Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md) · [API_CONTRACT](API_CONTRACT.md) · [TEST_STRATEGY](TEST_STRATEGY.md).
Baseline: `origin/main` `8d477288` (PR #256). Branch: `feature/channel-settings-redesign-20261114`. Worktree: `D:/easymod/_wt-channel-settings-20261114` (all 25 pre-existing worktrees preserved).

## Executive result

**Implemented and verified end-to-end** (receipts below): three-scope ownership (Business defaults / Channel overrides / Conversation safety), narrow-only channel automation overrides with a single resolver wired at every send path, a merchant-facing bypass-proof emergency stop with rollback-safe MANUAL belt and source-aware resume, conversation handoff hardening (reason recording, owner visibility, `needs_human` bypass fix), timezone-correct fail-closed business hours, and the channel-first frontend workspace with scoped Midnight/Violet/Sunlight tokens.

**Not done (deliberate):** no deploy, no production migration, no flag changes, no AUTO enablement (pilot envelope preserved); confidence-0.9 calibration deferred as a pre-AUTO blocker ([KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md)).

## Architecture delta

- Previous: shop-global reply mode (ADR-0003), connection-only channel page, combined Business Info page, admin-only destructive emergency-off.
- Implemented: [PROPOSED_ARCHITECTURE](PROPOSED_ARCHITECTURE.md) — business defaults as ceiling; `meta_channel_settings.overrides` JSONB (NULL = inherit; narrow-only clamp MANUAL > DRAFT > AUTO); resolver = sole mode authority at 9 enumerated sites; dedicated `shops.ai_emergency_stop*` columns; conversation `manual_handoff_reason`; hours IANA-tz + both shapes + overnight + malformed→CLOSED.
- Migration: expand-only `20261114_004` + `20261114_005` ([MIGRATION_PLAN](MIGRATION_PLAN.md)); no backfill/transform; down-safe; stopped shops stay MANUAL under old code.

## Implementation inventory

- Backend: 2 migrations + entities; `channel-automation.resolver.js` (new); worker wiring (Guard 4, candidate reuse, fresh order-permission re-read, pre-policy confidence re-check, send guard, provider boundary, recovery control); `human-handoff.service.js` + `webhook.service.js` resolver; `businessHours.rule.js` rewrite; emergency stop service/routes (merchant + admin); channel settings API (row-locked merge, widening 400, tenant predicates, audit, SSE, effective/list fields); conversation reason + effective list fields; `inbox-actions` classification; `markForHumanHandoff` hitl fix.
- Frontend: routes + redirects; Business Profile stripped; `BusinessAutomationDefaults` + `EmergencyStopCard`; `channels/` workspace (Overview, Detail tabs, OverrideControl, ConnectionManager extraction, SSE hook); inbox owner chips + literal reason map + effective badge + emergency banner + takeover reason dialog; `.ca-scope` tokens; en+bn keys; Claim-registry copy.
- CI: `channel-automation.spec.ts` registered in the frontend-e2e job.

## Verification receipts (executed; Node 20.20.2, disposable Docker stacks)

| Lane | Command | Result |
|---|---|---|
| Backend unit+security (full, pre-fix-round) | `npm run test:backend` | 5192 pass / 7 fail → all 7 accounted: 3 deliberate amendments (since fixed), 1 untracked-files discovery guard (fixed by commit), 1 grounding local flake (classified below), 2 cascade |
| Targeted post-fix batch (10 suites) | `npx jest <resolver/overrides/settings-contract/oauth/stop/ai-settings/webhook/perimeter/mutation-boundary/boundary-security>` | **179/179 PASS** |
| Frontend unit (full, final, post-merge) | `vitest run --pool=threads` | **900/900 PASS, 104/104 files** (forks pool has a local Windows IPC failure — environmental; threads pool executes the identical suite; CI runs linux) |
| Frontend fix-round targeted + channels dir | vitest | **PASS** (29 + 29 tests) |
| Frontend typecheck / build | `tsc --noEmit` / `npm run build:frontend` | **PASS** |
| Migration rehearsal | `npm run test:backend:migration-dryrun` | **PASS** (prod-shaped, 004/005, down/up round-trip, idempotency) |
| Integration (final, post-D3-fix) | `npm run test:backend:integration:docker` | **262/262 PASS, 37/37 suites** (real PG16+Redis7; incl. race + tenant-isolation + recovery) |
| New race + tenant integration | targeted on disposable PG16+Redis7 | **19/19 PASS** (QA) |
| Meta-e2e (real queue/worker, captured Graph/LLM) | `npm run test:backend:meta:e2e:docker` | **57/57 PASS, 2/2 suites** (final post-fix re-run) incl. 9 new divergence/stop/widening scenarios |
| Playwright (mock-only) | `test:e2e -- channel-automation ai-reply-mode shared-inbox llm-settings meta-oauth-contract` | functional **all PASS**; channel-automation **16/16** incl. both scoped axe tests (post-D1) |
| Growth OS gate | `npm run test:growthos` (serialized) | **141/141 PASS** + tsc clean |
| Claims compliance | `npm run verify:claims` | **PASS** (6/6) |
| Test discovery | `npm run test:discovery` | **PASS** (426 tracked files, one home each) |

All lanes re-executed on the merged tree (origin/main incl. PR #257, merge `83a1eee5`): integration **262/262**, meta-e2e **57/57**, frontend **900/900** (threads pool), build + tsc clean, `verify:claims` PASS incl. the new landing check. Full backend unit+security final: **5220 pass / 2 fail** — both the classified `grounding-boundary` local Windows timing flake (passes in isolation; import graph untouched; main CI green at baseline; PR CI authoritative). Independent review complete (see below).

### grounding-boundary classification (local environmental flake, not a regression)

`src/modules/ai/grounding/__tests__/grounding-boundary.test.js`: 2 failures in the full local run (10s timeout in "repeated customer pressure" + cascading `llm.chat` assertion in the next test). Evidence: (1) the "hallucinated turn" test **passes in isolation (2.9s)** — the second failure is mock pollution from the timed-out test's late async work; (2) `git diff 8d477288` shows **zero changes** in `src/modules/ai/` or the test's import graph; (3) main CI is **green at the exact baseline** `8d477288` (Release/Production run 43607889535, which runs the backend unit suite on linux). Conclusion: load/timing-sensitive on this Windows machine; the PR's CI run is the authoritative gate. Not edited.

## Deliberate test amendments (safety intent preserved)

| Test | Amendment |
|---|---|
| `ai-reply-mode.spec.ts` Scenario A | retarget to `/manage-shop/automation` (radiogroup/testids kept) |
| Scenario B | chat-settings→channels redirect; no LEGACY participation toggle; labeled narrow-only override + inherit/effective/revert |
| Scenario C | takeover reason dialog step (new flow) |
| `llm-settings.spec.ts`, `meta-oauth-contract.spec.ts` | route retargets |
| `ChatSettings.test.tsx` | no-Page-AI pin moved to ConnectionManager parity; override UI pinned in channels tests |
| `meta-channel.settings-contract.test.js` | top-level mode keys STILL forbidden; nested narrow-only overrides accepted |
| `message-worker.reply-mode.test.js:396` | legacy columns still ignored; overrides honored narrow-only |
| `ai-mutation-boundary.security.test.js` | static pin → resolver-derived mutation permission (effective mode + fresh order permission; trace kept) |
| `route-perimeter.test.js` | tenant-scoped `updateSettings(channelId, patch, {shopId, userId})` string; ownership-before-mutation kept |
| `meta-oauth.controller.test.js` | additive GET payload; cross-shop 404 (was 403) |
| `businessHours.rule` tests | truth table (tz, shapes, overnight, malformed→CLOSED) |
| `admin.service.test.js` | emergency-off MANUAL assertion kept + flag/snapshot/source |
| `BusinessAutomationDefaults.test.tsx` | card mocked at page level (card has its own suite); stopped-state test added |

## Defects found and fixed during the mission

- The Fool (design gate): override direction pinned narrow-only (user-approved); resolver sole-authority at all 9 sites; stop atomicity + source-aware resume; row-locked override merge; owner-only client gating; distinct `manual_handoff_reason`; hours fail-closed truth table; fresh order-permission re-read; boundary loader lock/INSERT constraints; dead-settings rationale corrected.
- QA D1–D10: contrast token; multi-slot hours lossless editor; recovery fixture; AUTO-write rejection while stopped; billing fail-closed; SSE on all writes; cross-shop 404; transactional exemption; list warnings + overview N+1 removal. Each with regression tests.
- Lead: `needs_human` live handoff bypass (hitl fix); EmergencyStopCard mounted on defaults page; generated auth fixture restored to keep protected-path diff net-zero.

## Git state

- Commits on branch: contracts freeze → EXISTING_BEHAVIOR → implementation → QA amendments → defect-fix round (see `git log`). Single push + single PR at the end (user standing preference). No deploy.
- Working tree: clean except generated verification artifacts (untracked, excluded).

## CI round 1 — cutover-drill compatibility fix

PR #258 CI round 1: every gate passed except `PR Merge Gate`, failed solely by the **Backend integration** job's `Backend cutover drill` step: `CUTOVER-DRILL: FAIL — 003 must not be applied before the drill seeds data`. Root cause: #256's drill assumed `20261114_003` was the newest migration (single `migrate:down`); ADR-0013's additive 004/005 now sit above it, so one down reversed 005 instead of 003. Fix (preserves every drill assertion): loop `down` until 003 is unapplied; pre-apply post-cutover additive DDL without ledger rows so entity seeding works at the pre-cutover head (003 still applies FIRST against legacy-shaped data in step 4); rollback loop reverses the billing trio plus anything above it. Verified locally with `npm run test:backend:cutover-drill` (receipt appended).

## Independent review (complete)

Code + security reviewers (independent agents) reviewed the full diff with adversarial refutation of critical/high findings. **No critical findings; no unsafe-send, tenant-leak, or data-loss path.** 2 confirmed high findings (controller dropped `handoff_reason`; business greeting >500 chars silently defaulted) + 6 medium/low (conversation display fail-open, boundary-tx subscription read, inbox billing badge, empty-hours silent disable, `greeting.enabled` no-op, stop-baked override) — **all fixed with regression tests** (R1–R8 in [SECURITY_REVIEW](SECURITY_REVIEW.md)). 0 refuted, 0 unverified high. Deliberate amendment added: `ai-messaging.test.js` legacy greeting-enabled no-op pin → enabled now controls custom text (mandatory disclosure unchanged).
