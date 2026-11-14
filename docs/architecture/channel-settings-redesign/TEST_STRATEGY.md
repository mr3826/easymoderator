# TEST_STRATEGY — Channel Automation Redesign

Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md) Verification Contract + [API_CONTRACT](API_CONTRACT.md). Mission §11 groups A–H mapped to concrete suites. **No test may be reported PASS unless executed.** Node 20 (`D:/easymod/_local-runtimes/node-v20.20.2`), worktree root `D:/easymod/_wt-channel-settings-20261114`.

## 1. Suites & commands

| Lane | Command | Infra |
|---|---|---|
| Backend unit/security | `npm run test:backend` | none (BullMQ stubbed) |
| Backend integration | `npm run test:backend:integration:docker` | disposable PG16+Redis7 (Windows-safe wrapper) |
| Meta-shaped E2E | `npm run test:backend:meta:e2e:docker` | real queue/worker; Graph+LLM captured |
| Migration rehearsal | `npm run test:backend:migration-dryrun` | prod-shaped stack |
| Frontend unit | `npm run test:frontend` | vitest happy-dom |
| Frontend build | `npm run build:frontend` | prod env |
| Playwright (mock-only) | `npm --workspace=easymod-frontend run test:e2e -- channel-automation ai-reply-mode shared-inbox` | Vite 4273 auto-start |
| Growth gate | `npm run test:growthos` | triggered by any backend diff in CI |
| Claims | `npm run verify:claims` | copy compliance |
| Migration status | `npm --workspace=easymod-backend run migrate:status` | disposable stack |

CI required: `PR Merge Gate` + `Security Scan`. New Playwright spec `channel-automation.spec.ts` must be registered in `.github/workflows/ci-cd.yml` frontend-e2e spec list (lead-owned edit). gitleaks: NO JWT-shaped fixtures (fake placeholders only). Avoid `src/config/config.js`, `auth/`, `notification/` (mobile proof).

## 2. New / extended coverage by mission group

### A. Channel isolation & inheritance
- NEW `EasyMod-backend/src/modules/channel-providers/__tests__/channel-automation.resolver.test.js`: pure fn — override wins within ceiling; **widening clamped** (business MANUAL + stored AUTO → MANUAL + `override_clamped_by_business`); revert/absent → business default; unknown mode → MANUAL fail-closed; alias canonicalization; threshold 0–100 + invalid→inherit+warning; greeting bounds; stop trumps everything; inactive shop; per-key source reporting; whitelist merge (malicious `settings.ai.business_hours`/`allow_order_creation` keys cannot override channel values).
- EXTEND `src/jobs/__tests__/message-worker.reply-mode.test.js`: channel A AUTO-override vs B DRAFT-override under business AUTO; changing A never touches B; MANUAL-override channel → reason `manual_mode`, NO LLM call; pre-override candidate not reused after narrowing; business-default change propagates only to inheriting channels.
- EXTEND `tests/meta-e2e/meta-e2e.test.js` (fixtures shopA=2 Pages, shopB=1 Page): two-Page divergence (Page1 AUTO send vs Page2 DRAFT hold) under business AUTO; override revert → convergence; business MANUAL → both skip; **widening PATCH rejected 400**; cross-shop isolation preserved (META-E2E-006).

### B. Conversation isolation
- EXTEND `conversation/__tests__/human-handoff.test.js`, `conversation-ownership.test.js`, `customer/__tests__/mwv1-increment2.integration.test.js`: takeover A pauses only A (B continues per channel policy); resume/resolve never write channel/shop config (assert no settings writes); claim/409/force/assign unchanged; reopen preserves assignee.
- NEW `conversation/__tests__/conversation.takeover-reason.test.js`: PATCH hitl+reason writes `metadata.manual_handoff_reason/at/by`; combined PATCH hitl+status+reason single-metadata merge (no lost update); default `manual_takeover`; reason ignored without hitl; inbox-actions classifies manual vs system (no HANDOFF_SUSPENDED_CHECKOUT mislabel).
- NEW legacy-path regression: keyword-fallback `markForHumanHandoff` sets hitl=true + status needs_human; subsequent customer message does NOT get AI reply (worker guards + boundary); `needs_human` in human-owned status set.

### C. Global emergency stop
- NEW `src/jobs/__tests__/message-worker.emergency-stop.test.js`: stop → Guard4 skip (no LLM), pre-policy hold, boundary hold, recovery/holding suppression (HELD emergency_stop, hitl preserved); channel AUTO override cannot bypass; resume keeps MANUAL; agent send + draft approval succeed during stop.
- NEW `src/modules/shop/__tests__/ai-emergency-stop.test.js` (+ integration): single-tx atomicity (flag+MANUAL+snapshot+audit); double-engage preserves prior_mode/source; merchant resume of admin-source → 403; admin resume clears; idempotency; SSE events; cache invalidation; rollback belt (mode MANUAL readable by old resolver).
- EXTEND `admin/__tests__/admin.service.test.js`: emergency-off delegates (flag + MANUAL + snapshot; existing assertion survives).
- Real-Redis integration: stop flip while job queued/in-flight → no automatic delivery (meta-e2e or integration lane with real BullMQ).

### D. Queue races & runtime hardening
- EXTEND reply-mode tests: AUTO→MANUAL flip after Guard4 holds text; late human pause suppresses in-flight; mode recheck before delivery (existing pins kept).
- NEW real-Redis integration: mode-flip + stop-flip vs inflight job (concurrent), no duplicate replies (idempotency keys unchanged), DLQ behavior unchanged.
- NEW `message-worker.settings-whitelist.test.js`: spread-hazard closed.
- NEW order-permission freshness: disable `allow_order_creation` mid-turn (after job start, before mutation) → mutation denied (Action Gate), session parks AWAITING_CONFIRMATION; committed-mutation send NOT suppressed.
- EXTEND `confidence-gate.test.js` + worker tests: effective (channel) threshold honored; pre-policy re-check holds on threshold raise mid-turn; order-flow exempt; unknown confidence holds.

### E. Tenant & API contract
- EXTEND `channel-providers/__tests__/meta-channel.settings-contract.test.js` (DELIBERATE AMENDMENT): top-level mode keys STILL forbidden; `overrides.automation_mode` accepted narrow-only; widening 400; unknown key 400; null revert; owner-only (staff/manager 403).
- NEW `meta-channel.overrides-contract.test.js`: row-locked merge (concurrent PATCHes different keys both survive; revert preserves siblings); canonical storage; deprecated threshold marker; GET effective/mode_source/warnings/emergency/billing fields.
- EXTEND security suite (`shop-tenant-scope`, `route-perimeter`, `ai-mutation-boundary`): cross-shop channelId on settings GET/PATCH/list/detail/every new field → 404/403 at controller AND service/loader; loader tenant assertion; NEW static boundary test (no direct `getEffectiveAiReplyMode` in worker/handoff/webhook).
- Old-client safety: `PUT /shop/ai-settings` + `POST /shop/update` cannot write overrides or stop columns; strip list intact.

### F. Migration
- NEW `src/database/__tests__/20261114_004_channel_automation_overrides.migration.test.js` + `...005_shop_ai_emergency_stop.migration.test.js`: SQL shape, idempotency, defaults, down.
- `npm run test:backend:migration-dryrun`: prod-shaped round-trip + verification queries (overrides count 0, stop count 0, legacy unchanged) + hours shape audit.

### G. Frontend
- NEW `EasyMod-frontend/tests/e2e/channel-automation.spec.ts` (mock-only, CI-registered): business-info has NO AI controls; automation defaults page saves (testid `ai-reply-mode` kept); overview loads with effective badges (Inherited/Overridden/Clamped/STOPPED/PAUSED-billing); detail override save → effective updates; revert → inherit; widening option absent/rejected; save channel A does not modify B; stop banner + confirm + resume keeps MANUAL; inbox takeover reason + owner chip + resume; staff/manager read-only; 360px + 390px layouts; axe.
- NEW unit tests `channels/__tests__/*`: Overview, Detail, OverrideControl, EmergencyStopCard, ConnectionManager extraction parity; defaults refactor parity (AISettingsForm.test adapted, testids kept).
- EXTEND `UnifiedInbox.test.tsx`, `CustomerContextPanel.test.tsx`: effective badge fallback, reason display map (literal keys), owner chips, emergency banner, takeover reason dialog, force typed.
- i18n: translation-coverage test green (literal keys en+bn); `verify:claims` green (Claim registry copy, no forbidden tokens).

### H. Regression
Full battery §1 + existing suites unchanged except deliberate amendments §4. Quarantine ceiling not raised. Coverage thresholds not enforced in CI (verified) — do not rely on them; review test quality manually.

## 3. Business-hours truth table (write BEFORE coding the rule)

| Input (day slot) | Timezone | Result |
|---|---|---|
| missing day key | any | CLOSED (deny AUTO) |
| `{}` / `[]` empty | any | CLOSED |
| valid `{open,close}`, now inside | hours.tz | OPEN |
| valid, now outside | hours.tz | CLOSED |
| array of slots, now inside ANY | hours.tz | OPEN |
| array, now inside NONE | hours.tz | CLOSED |
| overnight `close < open`, now in night span | hours.tz | OPEN |
| unparseable open/close | any | **CLOSED (fail-closed)** |
| hours set, no tz | Shop.timezone | evaluate in Shop.timezone |
| hours set, no tz, no Shop.timezone | — | Asia/Dhaka |
| hours NULL | — | always OPEN (unchanged) |
| transactional message | any | bypass hours (unchanged) |
| non-AUTO mode | any | rule not reached (unchanged) |
| DST transition day | valid IANA tz | Intl-correct local time |

Table-driven tests incl. a non-Dhaka timezone (e.g. `America/New_York`) and an overnight range. Existing-row behavior change is a documented defect fix (server-local clock + fail-open malformed were wrong).

## 4. Deliberate test amendments (each preserves safety intent; listed in IMPLEMENTATION_REPORT)

| Test | Current pin | Amendment |
|---|---|---|
| `ai-reply-mode.spec.ts` Scenario A (:551-553) | mode radio on /manage-shop/business-info | navigate to /manage-shop/automation; same radiogroup assertions (testid kept) |
| `ai-reply-mode.spec.ts` Scenario B (:591/:609) | zero switches on chat-settings | chat-settings redirects to channels; assert no LEGACY participation toggle; assert override control is labeled, narrow-only, inherit/effective/revert visible |
| `ChatSettings.test.tsx:173` | no Page-level AI control | moved to ChannelConnectionManager.test (connection manager still has none); channels detail tests pin the labeled narrow-only override |
| `meta-channel.settings-contract.test.js` | PATCH rejects mode keys | top-level rejection KEPT; overrides.automation_mode allowed narrow-only; widening 400 |
| `message-worker.reply-mode.test.js:396` | Page automation_mode/ai_auto_reply cannot override AUTO business | legacy columns STILL ignored; new overrides honored narrow-only (cannot widen MANUAL/DRAFT business) |
| `businessHours.rule` tests | server-local, single shape | truth-table §3 (tz, both shapes, overnight, malformed→CLOSED) |
| `admin.service.test.js:114` | emergency-off sets MANUAL via business setting | KEPT + flag/snapshot/source assertions |
| `AISettingsForm.test.tsx` | form on business-info page | defaults-editor host; all field/testid assertions kept |

## 5. Execution order

1. Resolver pure-fn unit tests (contract milestone — frontend/test can build against it).
2. Migration tests + dry-run.
3. Backend unit suites per workstream step (stop, overrides API, worker wiring, handoff).
4. Integration + meta-e2e (real stacks) — channel divergence, races, stop, tenant.
5. Frontend unit + Playwright (mock-only) + amendments.
6. Full battery + growth gate + verify:claims + pr-docs-check.
7. Independent code/security review of the actual diff; fix round; re-run affected suites.

Evidence receipts (command + result + run id) recorded in IMPLEMENTATION_REPORT.md. Unexecuted = never PASS.
