# Independent Findings Ledger

**Mission:** `merchant-ops-workspaces-2026-11-02`
**Reviewed source base:** `ab0c958efab03a0214776bdb07c95537eaae828c`
**Ledger policy:** Append a new disposition/retest row; do not erase prior review results.

## A4 final G2 review

The final review was read-only, did not run tests, and assessed current worktree source (the reviewer could not obtain `git diff`/status). Verdict: **NO-GO for A6**. The items below must be independently verified against the mission diff and closed before the customer slice starts.

| ID / severity | Finding and evidence | Required safe result | Status |
|---|---|---|---|
| A4-G2-01 / HIGH | Buyer-facing standalone order flow refuses a phone before payment method is known: `EasyMod-backend/src/modules/order/order-session-standalone.service.js:838-853`. The path also calls RTO without honoring the shop `enforce` setting. | Never auto-decline a buyer from a phone signal. Let the order continue; keep any review server-side and merchant-authorized before courier mutation. Test flagged submission proceeds and the buyer response does not disclose a global signal. | OPEN |
| A4-G2-02 / HIGH | `GET /rto-shield/blacklist` exposes raw global rows/phone data to shop members: `EasyMod-backend/src/modules/rto-shield/rto-shield.routes.js:33-44`, `rto-shield.controller.js:63-70`, `rto-shield.service.js:236-262`. | Do not enumerate raw global phone records. Scope results to shop-local data or an authorized in-context signal that does not disclose a global list. Test cross-shop/global rows are absent. | OPEN |
| A4-G2-03 / HIGH | Courier payload is prepared before the booking gate/claim; the claim transaction later reloads and locks a potentially changed order without rebuilding/rechecking the payload: `EasyMod-backend/src/modules/order/order.service.js:1296-1304,2096-2100,2163-2183`. | The provider payload and booking gate must use one locked order snapshot. If amount/method/status/address changes between evaluation and claim, return a conflict before provider mutation. Test a stale COD snapshot cannot dispatch. | OPEN |
| A4-G2-04 / MEDIUM | Non-RTO shop-settings writers can restore stale `contribute=true`: `EasyMod-backend/src/modules/shop/shop.controller.js:133-141,633-657`, `modules/delivery/delivery.controller.js:357-380`, `modules/shop/shop-bd-settings.js:55-80`. | Serialize/merge these settings writes against the current locked shop settings and preserve the RTO consent field. Test unrelated settings updates cannot undo opt-out. | OPEN |
| A4-G2-05 / MEDIUM | No active unique `(shop_id, phone)` constraint exists for `CustomerDeliveryStats`; application shop locking covers one writer but existing duplicate rows or another writer can split counts: `modules/rto-shield/rto-shield.service.js:265-295,77-110`, `customer-delivery-stats.entity.js:4-41`, migration `20260611_003_schema_drift_sweep.js:106-107`. | Without destructive cleanup or an unreviewed migration, make read/threshold paths coalesce existing duplicates and preserve serialized creation. Test duplicate rows do not undercount local thresholds or overcount network signals. | OPEN |
| A4-G2-06 / MEDIUM | Outcome-driven post-commit refresh errors can leave stale auto-global risk scores/rows; the blacklist list does not re-evaluate them: `modules/rto-shield/rto-network-settings.js:90-97`, `modules/rto-shield/rto-shield.service.js:149-160,233-262,301-333`. | Read decisions and list output must reflect current contributing shops and live aggregate, or use durable retry. Test a failed refresh after opt-out/outcome cannot leave a stale active score or global list entry. | OPEN |
| A4-G2-07 / MEDIUM | Order Confidence outcome writes are best-effort after the terminal transaction and only update existing rows; replay does not reliably retry a lost write. The summary silently caps at 20,000 rows: `modules/order-confidence/order-confidence.service.js:521-541,590-626`, `modules/delivery/delivery-tracking.service.js:245-250`. | If these outcomes/summary are presented or used as a decision source, persist them atomically or with a retryable ledger and expose truncation. Until then, do not use them as complete risk/merchant counts. | OPEN / NOT SURFACED IN NEW WORKLIST |
| A4-G2-08 / MEDIUM | A payment correction may still race with a claim at the payload/gate boundary; corrections after failed claims also need an explicit policy. Evidence: `modules/order/order.service.js:870-876,1296-1304,1988-1995,2096-2100,2163-2183`. | Reject corrections while any active/committed or provider-tracked dispatch exists; bind payload/gate/claim to the same source version. Test failed/indeterminate/committed claims and stale snapshots. | OPEN |
| A4-G2-09 / MEDIUM | System evaluation audit writes are best-effort/out-of-order even though human resolutions use CAS: `modules/order-confidence/order-confidence.service.js:161-175,234-246,449-472`. | Human approval/verification must remain transactionally audited. Do not describe best-effort system evaluation logs as durable audit history; if surfaced, add an append-safe event or retry. | OPEN / NOT CLAIMED AS DURABLE AUDIT |
| A4-G2-10 / MEDIUM | Dispatched courier cancellation may be classified as `RETURNED` by the shared classifier while delivery tracking only counts explicit `returned`: `modules/customer-intelligence/order-outcome.js:39-56`, `modules/delivery/delivery-tracking.service.js:196-219`. | Define one canonical outcome mapping so a carrier cancellation cannot silently inflate/erase RTO evidence. Test delivered, returned, cancelled, and retryable failed-delivery states. | OPEN |
| A4-G2-11 / MINOR | Raw error messages are included in several Order Confidence logs and may contain sensitive detail: `modules/order-confidence/order-confidence.service.js:123-134,370-372,538-540`. | Log safe error codes and correlation IDs, not unreviewed raw messages containing request/database values. | OPEN |

## Validation constraints

- Root-run backend unit tests pass 10 suites / 152 tests on the current worktree. These do not prove PostgreSQL row locks, transaction rollback, duplicate-row invariants, Redis behavior, or provider idempotency.
- Docker CLI readiness commands timed out; local `psql`, `pg_ctl`, `initdb`, and Redis tools were not found on PATH. Do not label DB/concurrency findings retested by unit mocks.
- Two project-wide TypeScript errors remain in untouched `Subscription.tsx:590,699`. Orders-focused unit tests pass 54/54; the current full Orders E2E needs a root rerun after the final role/type changes.

## A4 final verification after A5B

This later independent source pass supersedes the statuses above for G2 disposition, but does not erase them. It was read-only and no runtime tests/database access were performed. **Verdict remains NO-GO for A6.**

| ID / severity | Current assessment | Required next action |
|---|---|---|
| A4-G2-01 / HIGH | FIXED in source: standalone phone collection proceeds without checking/disclosing risk (`order-session-standalone.service.js:838-849`); merchant booking review is separate. | Retain test and verify after all backend changes. |
| A4-G2-02 / HIGH | FIXED in source: blacklist list scopes to shop-local and `is_global:false` (`rto-shield.service.js:242-269`); tests assert global phone absence. | Retain test and verify after all backend changes. |
| A4-G2-03 / HIGH | PARTIAL: locked latest order is fingerprinted and payload rebuilt (`order.service.js:2103-2114,2146-2190,2266-2271`); `order_status` is excluded from the fingerprint (`order-confidence.rules.js:64-68`). | Decide/test whether every status transition must conflict; claim still separately rejects draft/terminal states. |
| A4-G2-04 / MEDIUM | PARTIAL: several targeted writers serialize/merge RTO consent; unlocked full-settings writes remain in `knowledge/knowledge.service.js:198-229,236-244` and `ai/intent-threshold.service.js:55-72`. | Route remaining full-settings writers through a locked merge preserving consent, or prove those paths cannot write stale settings. |
| A4-G2-05 / MEDIUM | FIXED in source: local and network reads aggregate duplicate rows; current write path locks the shop row (`rto-shield.service.js:77-110,265-321`). DB locking/schema not proven. | Keep unit coverage; real PostgreSQL concurrency verification remains required. |
| A4-G2-06 / MEDIUM | PARTIAL: consent refresh rolls back on failure; `checkPhone` recomputes existing auto-global scores; after refresh failure with a newly qualifying aggregate but no stored row, response may only be VERIFY (`rto-network-settings.js:66-92`, `rto-shield.service.js:151-177`). | Ensure a current qualifying signal is not missed when no cached auto-global row exists; add test for the missing-row case. |
| A4-G2-07 / MEDIUM | OPEN: Order Confidence outcome update remains best effort, no retry/insertion when no row, and summary cap lacks truncation (`order-confidence.service.js:527-550,598-635`; `delivery-tracking.service.js:128-160,237-252`). | Keep outcome summaries out of the redesigned worklist or make the displayed values durable and complete before use. |
| A4-G2-08 / MEDIUM | OPEN: payment method is guarded but `payment_status` can still change after courier booking; failed-claim correction policy is incomplete (`order.routes.js:15-20,27,46`; `order.service.js:870-876,878-881,1287-1336`). | Guard every amount-affecting field after claim/tracking; add tests for failed/indeterminate/committed claims. |
| A4-G2-09 / MEDIUM | PARTIAL: human resolution is transactionally audited; system-evaluation audit remains best effort (`order-confidence.service.js:165-179,219,249,455-477`). | Do not claim system evaluation audit is durable; defer unless surfaced/used as an authoritative record. |
| A4-G2-10 / MEDIUM | OPEN: classifier can treat dispatched cancellation as RETURNED, while tracking stats count only explicit returned (`customer-intelligence/order-outcome.js:39-56`, `delivery-tracking.service.js:196-223`). | Align canonical outcome semantics and tests before customer risk history is redesigned. |
| A4-G2-11 / MINOR | FIXED in Order Confidence logs; delivery webhook still logs raw errors (`delivery-tracking.service.js:274-280`). | Replace raw error text with a safe code/identifier before claiming no PII in logs. |
| A4-G2-12 / HIGH | OPEN: when there is no local history, `getNetworkStats(phone, shopId)` returns zero before cross-shop aggregate (`rto-shield.service.js:61-75`), so first-time local buyers may miss otherwise qualifying shared signals. | Allow global check only from a validated order/customer context, while keeping arbitrary phone probes local-only; test both first-order context and unscoped probe. |

## Root-run verification update (2026-11-02)

| Check | Result |
|---|---|
| Focused backend unit suites before A5B | PASS, 10 suites / 152 tests; predates A5B changes. |
| Backend unit suites after A5B | FAIL, 14 suites / 287 tests; 12 suites / 274 tests passed and 2 suites / 13 tests failed (`shop.service.test.js` missing mocked consent helper; `rto-shield.network.test.js` has three failed expectations). |
| Frontend focused unit | PASS, 54/54. |
| Orders Playwright | PASS, 15/15 on final Orders UI. |
| Full frontend unit | FAIL, 90 files / 772 tests passed with one unhandled teardown error in `App.test.tsx` after `ECONNREFUSED localhost:3000`. |
| Frontend strict TypeScript | PASS after root changed localized `count` interpolation to use numeric `count` and a separate formatted label. |
| Frontend production build | PASS; existing Zod Rollup annotation warnings only. |
| PostgreSQL/Redis integration | BLOCKED: Docker daemon timed out; no local engine/tools available. |

## Root-run verification after A5C (2026-11-02)

| Check | Result |
|---|---|
| Backend targeted unit suites | PASS, 25 suites / 449 tests using Node 20 and the backend-local locked Jest binary. Includes order session, confidence gate, RTO network/settings, shop consent merges, knowledge/AI/delivery settings, and delivery replay. This is not DB-backed proof of row locks or transactions. |
| Frontend focused Orders unit | PASS, 4 files / 54 tests. |
| Orders Playwright | PASS, 15/15 with one worker. API behavior remains mocked. |
| Full strict frontend TypeScript | PASS after the separate numeric-count/format-label correction in `Subscription.tsx` and EN/BN locale keys. |
| Frontend production build | PASS; Zod Rollup annotation warnings remain. |
| Full frontend unit suite | FAIL, 90 files / 772 tests passed but one unhandled teardown error remains in `App.test.tsx` after `ECONNREFUSED localhost:3000`; the test needs to stub the auth/CSRF HTTP dependency instead of using a live server. |
| Real PostgreSQL/Redis and authenticated production journeys | NOT RUN / BLOCKED by unavailable local services and no verified production identity. |
| Independent A4 review after A5C | PENDING; do not treat this test run as reviewer GO. |

## A4 review after A5C (2026-11-02)

This independent read-only review supersedes the prior pending status. It did not run tests or access a database. Verdict: **NO-GO for A6**.

| Finding | Current assessment and exact evidence | Next action |
|---|---|---|
| Courier snapshot status binding | **PARTIAL.** Gate/claim bind payment method/status, total, address, phone and items; `order_status` is not in the fingerprint (`order-confidence.rules.js:64-83`, `order.service.js:2103-2114,2146-2190,2266-2271`). | Add status to the reviewed snapshot or document/test why allowed transitions cannot alter booking safety. |
| Consent settings writers | **PARTIAL.** The latest A4 read still finds stale full-settings writers in `knowledge/knowledge.service.js:198-229,236-244` and `ai/intent-threshold.service.js:55-72`. | Use a fresh-row, locked merge at the final write boundary; verify every path after the A5C changes. |
| Duplicate local stats | **FIXED IN SOURCE; DB UNVERIFIED.** Reads sum matching duplicate rows and count distinct shops; writers lock the shop row (`rto-shield.service.js:77-110,265-321`). | Preserve these tests; PostgreSQL concurrency proof remains a G5 requirement. |
| Post-commit auto-global signal refresh | **PARTIAL.** Explicit consent refresh rolls back on failure, but an outcome refresh failure with no cached global row can leave a newly qualifying signal only at `VERIFY` (`rto-network-settings.js:66-92`, `rto-shield.service.js:151-177`). | Compute the live qualifying signal for trusted order/customer context even when no cached auto-global row exists; keep free-form probes local-only. |
| Order Confidence outcomes | **OPEN / NOT SURFACED.** `recordOutcome` updates only an existing decision and swallows failure; summary caps at 20,000 with no truncation indicator (`order-confidence.service.js:527-550,598-635`). | Do not use summary/outcome values in the redesigned workspace until durable and complete. |
| Payment status after dispatch | **OPEN.** `payment_method` is guarded but `payment_status` updates can proceed after dispatch (`order.service.js:870-876,878-881,1287-1336`). | Guard every amount-affecting payment field after a claim/tracking record; cover failed/indeterminate/committed claim states. |
| System evaluation audit | **PARTIAL / NOT CLAIMED DURABLE.** Human resolution is transactional; system evaluation audit remains best-effort (`order-confidence.service.js:165-179,219,249,455-477`). | Keep system evaluation audit out of product claims unless made durable. |
| Dispatched cancellation outcome | **OPEN.** `order-outcome.js` can classify courier-side cancellation as `RETURNED`, while local RTO stats count explicit `returned` (`customer-intelligence/order-outcome.js:39-56`, `delivery-tracking.service.js:196-223`). | Normalize and test terminal outcomes across customer history and RTO counters. |
| Error logs | **PARTIAL.** Order Confidence logs use safe codes; delivery tracking still logs raw errors (`delivery-tracking.service.js:274-280`). | Replace raw error text with safe codes/identifiers. |
| First-time cross-shop context | **HIGH / OPEN.** `getNetworkStats(phone, shopId)` returns before network aggregation without local history (`rto-shield.service.js:61-75`); a first local order can miss a qualifying shared signal. | Allow shared lookup only for a validated new/existing order or customer context; arbitrary phone probes remain local-only. |

The reviewer also confirms the standalone automatic refusal and raw global blacklist list are fixed in source. No DB-backed row-lock, rollback, or concurrent-writer proof exists.

## A4 latest post-A5D review (2026-11-02)

This later source-only pass supersedes the previous A4 disposition for G2. No tests, database, runtime, provider, or production checks were run. Verdict: **NO-GO for A6**.

| ID / severity | Finding and current evidence | Required disposition |
|---|---|---|
| A4-G2-18 / P1 | `updateOrder` checks active courier dispatch/tracking only for payment fields; status/name/address/contact changes can still occur after claim while the provider call is in flight (`order.service.js:884-921`). | Block payload-affecting/status changes under active/committed claims, or reconcile before provider mutation. Add concurrency tests. |
| A4-G2-19 / P1 | Verified-payment webhook updates `payment_status` and resets `order_status` before `bookForOrder`; a committed/tracked dispatch path returns a synthetic result without reconciling courier collection (`payment-webhook.controller.js:209-219,250-267`; `order.service.js:2055-2063`). COD-confirm route is membership-only and lacks COD/claim/tracking checks (`payment.routes.js:45-46`, `payment.service.js:139-160`). Owner notification response can change order/payment state after dispatch (`owner-notification.service.js:130-165`). | Preserve verified payment truth, but do not silently leave courier collection/order state inconsistent. Define a safe post-claim reconciliation path and protect manual COD/status actions. |
| A4-G2-20 / P2 | `updateLLMConfig` reads a full settings snapshot before submit; non-PostgreSQL growth-metrics fallback replaces settings from a stale object (`shop.controller.js:363-375`, `shop.service.js:247-266`, `growth-metrics.service.js:59-74`). | Use locked fresh-row merge or atomic nested update. Test concurrent settings changes. |
| A4-G2-21 / P2 | `cancelled` is terminal before a later final return can arrive; `partial_delivered` is classified but not terminalized/recorded consistently (`delivery-tracking.service.js:147-157,173-212,255-269`; `order-outcome.js:24-54`; `provider.registry.js:334-348`). | Define canonical provider outcomes and make tracking, confidence history, and RTO stats agree. |
| A4-G2-22 / P2 | Payment webhook, voice/RAG, and standalone courier paths still log raw exception/provider messages or tracking values (`payment-webhook.controller.js:176-179,286-288`; `voice-processing.service.js:225-227,284-309,353-356`; `knowledge.service.js:396-403`; `order-session-standalone.service.js:2304-2306`). | Emit stable codes and redacted identifiers, not raw messages/payloads. |
| A4-G3-01 / P2 | Customer RTO settings still defaults both toggles to true on load failure (`EasyMod-frontend/src/app/components/RtoNetworkSettings.tsx:24-28,88-109`). | A6 must render unavailable, disable consent controls, and never assert enabled consent without a successful read. |
| A4-G2-07 / P2 | Order Confidence outcomes are not durable for every order; summary truncates at 20,000 (`order-confidence.service.js:527-550,598-635`). The new worklist does not call/display this summary. | Defer only while it remains unsurfaced and no “complete outcome” claim is made; revisit before any summary use. |

Cross-shop lookup is scoped to trusted order/customer contexts in source, and direct free-form probe/list paths are local-only. The reviewer nevertheless did not validate the trust boundary, API behavior, payment callback reconciliation, or locks at runtime.

## A4 review after A5E (2026-11-02)

This read-only source review found material progress but remains **NO-GO for A6**. No tests or runtime/database checks were performed.

| ID / severity | Current finding | Required next action |
|---|---|---|
| A4-G2-23 / HIGH | `confirmCodPayment` requires owner/admin, COD, and delivered status, but accepts `partial_delivered` and sets the entire payment status to `paid`: `EasyMod-backend/src/modules/payment/payment.service.js:140-185`. | Disallow full COD settlement for partial delivery without an authoritative paid/due amount; require explicit amount authority or keep settlement unavailable. |
| A4-G2-24 / MEDIUM | The bKash merchant writer updates payment state by `order_number` without transaction, claim/tracking guard, or shop scope; static callers are not found but reachability is unverified: `EasyMod-backend/src/modules/payment/bkash-merchant.service.js:135-169,200-235,291-300`. | Verify route/export reachability; if reachable, scope tenant and apply the same post-claim payment reconciliation policy. |
| A4-G2-25 / HIGH | Hard order delete remains routed and destroys the row without courier/tracking checks, inventory restoration, or safe audit: `EasyMod-backend/src/modules/order/order.routes.js:26-30,43-59`; `order.service.js:1056-1068`. | Remove/disable hard deletion or gate a demonstrably safe cancellation/compensation path; no ordinary API hard-delete capability. |
| A4-G2-26 / HIGH | `completed` is not consistently terminal: generic edits exclude shipped/delivered/cancelled but not completed, and cancel can restore stock after completion: `order.service.js:880-885,1227-1249`. | Enforce a server-side lifecycle graph; block completed-to-cancelled and status mutations after dispatch. |
| A4-G2-27 / MEDIUM | Verified payment after dispatch records `metadata.payment_reconciliation.required`, but no owner-facing reconciliation UI/workflow consumes it: `payment-webhook.controller.js:260-287`; `Orders.tsx` currently has no evidence of displaying the flag. | Display a clear, non-settlement reconciliation warning and a supported next step; do not claim courier amount was amended. |
| A4-G2-28 / MEDIUM | Partial delivery/return semantics remain incomplete: partial delivery can be treated as fully delivered/value/paid; courier cancellation/partial-return sequencing is not runtime-verified. | Keep partial COD un-settled; define explicit provider state outcomes and avoid full-value/revenue claims. |
| A4-G2-29 / HIGH for G3 | Customer RTO settings read failure still shows both contribution/enforcement enabled: `EasyMod-frontend/src/app/components/RtoNetworkSettings.tsx:22-28,88-109`. | A6 must render unavailable and disable controls on read failure; do not represent consent as known. |
| A4-G2-30 / MEDIUM | Raw exception/provider details remain in payment webhook, voice/RAG, and bKash logs; full voice error objects or response data can be serialized: `webhooks/payment-webhook.controller.js:176-179,286-288`, `ai/voice-processing.service.js:225-227,284-309,353-356`, `knowledge/knowledge.service.js:396-403`, `payment/bkash-merchant.service.js:122-128,187-193,244-250`. | Sanitize all remaining logged error/provider data to safe codes and identifiers. |

The A4 review confirms the standalone buyer refusal and direct global blacklist enumeration are closed in source. It does not establish PostgreSQL/Redis behavior or live payment/courier reconciliation.

## Root-run verification after App isolation (2026-11-02)

| Check | Result |
|---|---|
| Full frontend unit suite | PASS, 90 files / 772 tests. `App.test.tsx` stubs auth/CSRF bootstrap and the shop-context hook; console output includes expected connection-refused logs from tests that exercise network errors, but Vitest reports no unhandled errors and exits successfully. |
| Full strict frontend TypeScript | PASS, `tsc --noEmit -p EasyMod-frontend/tsconfig.json`. |
| Orders E2E | PASS, 15/15 with one worker. |
| Frontend production build | PASS; existing Zod Rollup annotation warnings only. |
| Backend targeted unit suite | PASS, 25 suites / 449 tests after A5C. |
| Real PostgreSQL/Redis and latest independent A4 verdict | Still BLOCKED/NO-GO; do not start A6. |

## Root-run verification after A5D and Customer E2E repair (2026-11-02)

| Check | Result |
|---|---|
| Backend affected unit suites | PASS, 25 suites / 458 tests under Node 20; expected BullMQ/ioredis `ECONNREFUSED localhost:6379` diagnostics occurred. |
| AI settings service suite | PASS, 1 suite / 23 tests using `--forceExit`; no real Redis service was available. |
| Combined Orders and Customer Intelligence E2E | PASS, 22/22 with one worker; both suites use API fixtures/mocks. |
| Full frontend unit / typecheck / build | PASS, 90 files / 772 tests, strict TypeScript, and production Vite build. |
| PostgreSQL/Redis integration and current A4 review after A5D | Still BLOCKED/PENDING; no A6 or production claim until current-source review and real-stack gate. |

## A4 review after A5D (2026-11-02)

This independent review inspected current source only, ran no tests, and used no database/runtime. Verdict: **NO-GO for A6**.

| ID / severity | Finding and source | Required disposition |
|---|---|---|
| A4-G2-13 / HIGH | Post-claim `updateOrder` blocks payment fields but still permits status-only edits while courier provider call may be in flight: `order.service.js:2026-2029,2180-2205,884-921`. | Reject status/payload-affecting edits while active/committed claim exists, or reconcile before provider call; add race test. |
| A4-G2-14 / HIGH | Verified-payment webhook, COD confirm, and owner response write payment/order state without applying courier claim/tracking reconciliation: `webhooks/payment-webhook.controller.js:209-219,250-267`; `payment/payment.service.js:139-160`; `notification/owner-notification.service.js:130-165`. | Preserve verified payment truth, but do not reset order state or silently leave provider COD amount stale. Define a safe reconciliation/alert path; protect manual changes and role gates. |
| A4-G2-15 / MEDIUM | `updateLLMConfig` submits a full settings snapshot that may overwrite concurrent changes despite consent merge; PostgreSQL analytics has an atomic branch but non-Postgres fallback writes a stale full settings object: `shop.controller.js:363-375`, `shop.service.js:247-266`, `analytics/growth-metrics.service.js:59-74`. | Use fresh-row locked merge or atomic nested updates for all writers; scope test to consent and unrelated settings preservation. |
| A4-G2-16 / MEDIUM | Cancellation can be terminal before a later authoritative return and suppress the final outcome; `partial_delivered` is classified as delivered but delivery tracking finalizes only exact `delivered`: `delivery-tracking.service.js:147-157,173-212,255-269`; `customer-intelligence/order-outcome.js:24-54`; `delivery/providers/provider.registry.js:334-348`. | Canonicalize provider terminal/intermediate statuses and test partial outcomes/cancel-then-return. |
| A4-G2-17 / MEDIUM | Raw exception/provider messages remain in payment webhook, voice processing, RAG, and standalone courier logs: `webhooks/payment-webhook.controller.js:176-179,286-288`; `ai/voice-processing.service.js:225-227,284-309,353-356`; `knowledge/knowledge.service.js:396-403`; `order-session-standalone.service.js:2304-2306`. | Replace with safe code and redacted correlation identifiers; do not log request/provider payloads. |
| A4-G3-01 / MEDIUM | Customer RTO settings read failure still shows both consent/enforcement as enabled: `EasyMod-frontend/src/app/components/RtoNetworkSettings.tsx:24-28,88-109`. | A6 must render unavailable, disable controls, and not assert consent state until a successful read. |

The review found the trust-context guard, shop-local blacklist list, standalone buyer continuation, current aggregate filtering, and source-level test fixtures improved. No PostgreSQL/Redis proof exists for row locks, payment webhook reconciliation, settings concurrency, duplicate data, or provider callbacks.

## A4 review after A5G (2026-11-02)

This latest source review remains **NO-GO for A6**. No tests/runtime/database/provider checks were performed.

| ID / severity | Finding and source | Required next action |
|---|---|---|
| A4-G2-37 / HIGH | Generic PATCH checks the resulting payment method only; a COD order can be changed to `payment_method=bkash` and `payment_status=paid` in one update. Order creation also accepts COD+paid, which `isCodOrder` excludes and can send as zero COD (`order.validator.js:67-78`; `order.service.js:118-122,602-625,829-842`). | Reject COD+paid at creation; generic updates must inspect both prior and resulting method/status and route COD-to-paid only through dedicated settlement. |
| A4-G2-38 / HIGH | Generic PATCH can set `order_status=completed` without full delivery evidence (`order.validator.js:88-99`, `order.service.js:849-867`). | Enforce a server transition graph and require authoritative full delivery before completed. |
| A4-G2-39 / HIGH | Generic PATCH permits `fulfillment_status=partially_fulfilled`, while cancellation blocks only full fulfillment and restores every item (`order.validator.js:95-96`, `order.service.js:860-867,1226-1238,1276-1301`). | Reject unsupported client fulfillment transitions and do not restore stock for partially fulfilled orders without item-level quantities. |
| A4-G2-40 / HIGH | Owner-notification rejection can directly cancel a completed order when no courier record exists (`notification/owner-notification.service.js:138-170,196-202`). | Guard current terminal state before owner approval/rejection; use the safe cancellation service for eligible cases only. |
| A4-G2-41 / HIGH conditional | Owner shop deletion cascades orders (`shop.routes.js:36-37`, `shop.service.js:324-355`, `entities.js:247-252`, `order.entity.js:10-17`). | Keep outside Orders/Customers UI and do not trigger. Resolve account-erasure policy separately; no production data deletion in this mission. |
| A4-G2-42 / MEDIUM | bKash direct order writer is not routed in-tree but still updates by order number without tenant/claim guard (`payment/bkash-merchant.service.js:174-180,238-244,300-309`). | Keep dormant/unmounted or make the service itself safe before any future route wires it. |
| A4-G2-43 / MEDIUM | Partial-delivery status can set `delivered_at`/order delivery state and full `delivered_value`, while partial-return/cancellation sequences remain provider-dependent (`delivery-tracking.service.js:220-257`, `customer-intelligence/order-outcome.js:43-50,100-118`). | Do not claim full-order delivered value for partial delivery; preserve exact provider outcome and avoid full COD settlement. |
| A4-G2-44 / MEDIUM | Residual raw provider/error data remains in delivery service, self-MFS, and notification logs (`delivery.service.js:754-780`, `self-mfs-handler.service.js:322,359`, `owner-notification.service.js:372-376`). | Emit sanitized codes and safe identifiers only. |
| A4-G3-02 / MEDIUM | Customer RTO settings continue to default to enabled on read failure (`RtoNetworkSettings.tsx:17-28,90-108`). | G3 must show unavailable, not enabled; disable changes until settings read succeeds. |

Source-only checks also confirmed the hard DELETE service returns 410, terminal cancellation protection covers completed/full fulfillment, COD settlement blocks partial/return/reconciliation cases, and verified payment webhooks preserve courier/terminal state. These do not close the generic bypasses above. No DB-backed behavior was verified.

## Root-run A5H unit verification (2026-11-02)

Root reran the focused COD/lifecycle suites under Node 20.20.2: **5 suites / 180 tests passed** (`order.service`, `order-cancel-inventory`, `payment.cod-confirmation`, `owner-notification.security`, `payment-webhook.controller`). These results do not prove PostgreSQL inventory transactions, Redis, or courier-provider behavior. A4 re-review of A5H is still pending.

## A4 review after A5H (2026-11-02)

Latest read-only verdict: **NO-GO for A6**. No tests, runtime, or database access were performed.

| ID / severity | Finding and current source | Required next action |
|---|---|---|
| A4-G2-45 / HIGH | Generic PATCH still permits COD `paid` via a simultaneous method change and create accepts COD+paid (`order.validator.js:67-78`; `order.service.js:118-122,602-625,829-842`). | Reject COD+paid at create; compare prior and resulting payment method/status in updates; use dedicated settlement only. |
| A4-G2-46 / HIGH | Generic PATCH can set `order_status=completed` without full delivery evidence (`order.validator.js:88-99`; `order.service.js:849-867`). | Require full delivery and an allowed transition for completed. |
| A4-G2-47 / HIGH | Create/patch can forge `fulfilled`, `partially_fulfilled`, or `cancelled` fulfillment values and cancellation may restore all stock (`order.validator.js:67-78,95-96`; `order.service.js:860-867,1226-1238,1276-1301`). | Keep fulfillment values server-authoritative; do not restock partial fulfillment without item-level quantities. |
| A4-G2-48 / HIGH | Courier booking does not independently reject all terminal order/fulfillment states before provider mutation (`order.service.js:2252-2276`; `order-confidence.rules.js:33-34`). | Add a server-side bookability gate for terminal/fulfilled states. |
| A4-G2-49 / MEDIUM | Owner-notification terminal guards and safe cancellation still need verification for orders lacking courier rows. | Block approve/reject on terminal order state and route eligible rejection via the cancellation service. |
| A4-G2-50 / MEDIUM | bKash writer remains unmounted but unsafe if reconnected; preserve as latent/unverified and do not claim safety. | Keep it unexposed; require tenant/claim guard before wiring. |
| A4-G2-51 / MEDIUM | Partial delivery/return and delivered value may still overstate complete order value or collapse partial return into full return. | Preserve exact provider partial state; do not claim full delivery/value or full settlement without item-level evidence. |
| A4-G2-52 / MEDIUM | Raw provider/recipient errors remain in self-MFS/owner notification paths. | Sanitize remaining log fields. |

The account-level Shop deletion cascade is conditional and remains outside the Orders/Customers page scope; no account deletion was performed. The separate G3 `RtoNetworkSettings.tsx` read-failure state remains open.

## A4 final review after A5H (2026-11-02)

This later read-only source review remains **NO-GO for A6**. No tests or database/runtime access were performed.

| ID / severity | Finding and source | Required next action |
|---|---|---|
| A4-G2-53 / HIGH | COD+paid creation can bypass when payment method is provided only by `payment_method_id`; create persists the ID without resolving its shop-scoped gateway (`order.validator.js:67-78`; `order.service.js:511-517,651-652`). | Resolve/validate the scoped payment config before COD classification, or reject ID-only/ambiguous methods; test ID-only COD+paid. |
| A4-G2-54 / HIGH | Create accepts client fulfillment values `fulfilled`, `cancelled`, and `partially_fulfilled`, and `_createOrderCore` persists them without delivery evidence (`order.validator.js:67-78`; `order.service.js:638-642`). | Force the server default unfulfilled; reject client terminal/partial fulfillment on create. |
| A4-G2-55 / HIGH | Courier booking checks cancelled/delivered/returned/refunded but not completed/fulfilled before provider mutation (`order.service.js:2252-2276`; `order-confidence.rules.js:33-34`). | Add an independent server booking guard for completed/fulfilled/terminal lifecycle states; test provider call is not made. |
| A4-G2-56 / MEDIUM | Dedicated COD settlement, owner-notification terminal checks, and safe delete were improved, but generic lifecycle/creation paths bypass them (`payment.service.js:142-218`; `owner-notification.service.js:145-188`; `order.service.js:1040-1046`). | Keep the dedicated paths as sole authorities; test all route-level bypasses. |
| A4-G3-03 / HIGH | RTO settings read failure remains visually enabled and backend missing settings defaults to on (`RtoNetworkSettings.tsx:25-28,90-106`; `rto-network-settings.js:7-18,25-41`; `rto-shield.service.js:87-93,293`). | G3 must distinguish unknown from opted-in/opted-out; confirm the intended default consent policy before presenting sharing as enabled. |

Other source-only residuals are recorded above: partial-return metrics lack item-level quantities; the bKash writer remains dormant but unsafe if wired; some provider/payment/notification log paths still contain sensitive diagnostics; and shop deletion cascades order history under a separate account-erasure policy. The direct order delete itself returns 410. Database cascade, payment, and courier behavior were not verified.

## A4 final review after A5I (2026-11-02)

Latest read-only verdict: **NO-GO for A6**. No tests or database/runtime/provider checks were performed.

| ID / severity | Finding and source | Required next action |
|---|---|---|
| A4-G2-57 / HIGH | Order creation resolves only `paymentMethodId || payment_method_id`; a conflicting second ID is ignored, allowing non-COD precedence to mask a COD ID with paid status (`order.service.js:524-543`). | Reject conflicts; resolve/validate IDs against the selected shop and canonical gateway. Test conflicting aliases through single and bulk create. |
| A4-G2-58 / HIGH | Bulk create passes raw items to `createOrder`; terminal `order_status` values can be persisted without delivery evidence (`order.routes.js:37`, `order.controller.js:549-578`, `order.service.js:22-38,360-371,667-678`). | Reject/sanitize terminal lifecycle states on all create paths, including bulk. |
| A4-G2-59 / MEDIUM | The terminal booking guard runs before already-booked/committed replay recovery (`order.service.js:2354-2363,2422-2435,2482-2490`). | Return existing committed tracking/claim without a new provider call, even when the order is now terminal; keep new claims blocked. |

The A4 reviewer re-confirmed the separate G3 settings-read failure. No DB-backed proof exists for the reported source fixes.

## A4 review after A5K (2026-11-02)

Latest read-only verdict: **NO-GO for A6**. No tests or runtime/database/provider checks were performed.

| ID / severity | Finding and source | Required next action |
|---|---|---|
| A4-G2-57 / HIGH | Conflicting payment aliases are rejected and IDs are shop-scoped, but single-ID COD+paid through bulk is not separately exercised (`order.service.js:528-567`; `order.controller.js:574-590`). | Add a bulk regression for one shop-scoped COD ID with paid status; prove no order/stock mutation. |
| A4-G2-58 / HIGH | Terminal order status on create is rejected at the shared service boundary and validator; bulk uses that boundary (`order.service.js:521-526`; `order.validator.js:50-85`). | Retain tests; ensure no terminal state or stock reservation occurs. |
| A4-G2-59 / MEDIUM | Existing committed dispatch recovery precedes terminal new-booking guard, but response can prefer caller-selected provider over persisted provider (`order.service.js:2370-2382,2577-2596`; `order.controller.js:773-779`; mobile controller `:92-101,174-180`). | Return only persisted provider/tracking data on replay; if provider is missing, fail safely. Test conflicting provider through service and API/mobile responses. |
| A4-G3-04 / HIGH | RTO settings read failure remains visually enabled and backend defaults missing contribution/enforcement to on (`RtoNetworkSettings.tsx:22-28,88-109`; `rto-network-settings.js:7-18,25-41`; `rto-shield.service.js:87-93,293`). | G3 must represent unknown distinctly and confirm the consent default policy before showing sharing as enabled. |

Payment alias conflicts and terminal create states are fixed in source. Existing dispatch replay and disabled-config resolution require the targeted follow-up; PostgreSQL/provider behavior remains unverified.

## A4 re-review after A5M (2026-11-02)

Latest source-only verdict: **NO-GO for A6**. No tests or runtime/database/provider access were performed.

| ID / severity | Finding and source | Required next action |
|---|---|---|
| A4-G2-60 / MEDIUM | Committed dispatch replay can return success with an empty/invalid tracking identity when the claim/provider row lacks it; controller/mobile response paths do not validate synthesized tracking (`order.service.js:2201-2227,2395-2405,2577-2614`; `order.controller.js:773-780`; `mobile-courier.controller.js:164-173`). | Fail safely when an existing committed claim has no valid tracking identity; never substitute request provider/IDs. Test missing provider/track/consignment values. |
| A4-G2-61 / MEDIUM | Mobile tracking GET swallows tracking-store read errors and falls back to denormalized order tracking fields without validating them (`mobile-courier.controller.js:311-328`). | Distinguish not-found from read failure; return unavailable on read error and validate any persisted fallback identity. |
| A4-G2-62 / MEDIUM test gap | Bulk COD+paid is behaviorally guarded through the shared service, but no dedicated bulk case covers a single shop-scoped COD `paymentMethodId` with paid status (`order.controller.js:574-590`). | Add a test asserting row-level failure and no order/stock writes. |
| A4-G2-63 / PASS source | Owner notification payment-config resolver checks shop scope, alias consistency, and enabled status before payment writes (`owner-notification.service.js:43-87,217-230`). | Keep regression tests; DB/runtime behavior is not proven. |
| A4-G3-05 / HIGH | `RtoNetworkSettings` still shows both settings enabled after read failure; backend missing settings default on (`RtoNetworkSettings.tsx:22-28,88-109`; `rto-network-settings.js:25-42`). | G3 must show unavailable and verify the approved consent default before displaying enabled sharing. |

Tests cited in source were not executed by A4. The real provider identity and mobile tracking behavior remain unverified against a database/runtime.

## Root-run A5N verification (2026-11-02)

Node 20.20.2 Jest run over six courier replay, mobile tracking, order service, controller, and dispatch-contract suites completed with **5 suites / 189 tests passing and 1 test failing**. The failing test expects a thrown rejection for a committed replay with missing tracking identity; the implementation returns a structured `{ blocked: true, status: 'tracking_unavailable' }` result. Root is holding acceptance until A4 verifies the API/controller maps this state to a non-success response and no provider call. This is a contract assertion mismatch, not a claimed test pass.

## A5N closure: tracking_unavailable contract disposition (2026-11-02)

Founder directive resolved the A5N hold through source tracing and verification, not assertion-only change. Contract settled on evidence at every layer:

1. **Service** — `order.service.js:2210-2242` `synthesizeCommittedCourierResult` resolves the structured blocked result for committed-replay identity failures. This is the established pattern for every non-exceptional dispatch state (`courier_setup_required`, `confidence_hold`, `dispatch_indeterminate`); thrown `AppError` is reserved for authorization/tenant/lifecycle violations (403/409/400 via controller catch at `order.controller.js:817-820`).
2. **Web controller** — `order.controller.js:758-770` maps `blocked && tracking_unavailable` to HTTP **409** with `COURIER_TRACKING_UNAVAILABLE` / `COURIER_DISPATCH_PROVIDER_UNAVAILABLE`, provider normalized via `tracking-identity.js` (never the caller's requested provider). A second fail-closed guard at `:793-806` rejects any non-blocked success lacking a valid tracking identity.
3. **Mobile controller** — `mobile-courier.controller.js:154-166` identical mapping; `:189-202` identical success guard.
4. **Frontend/API** — `bookCourier` uses the shared axios client (`EasyMod-frontend/src/api/domains/order.ts:237-241`); a 4xx rejects and the existing booking error/retry path surfaces `trackingUnavailableMessage(code)` ("Do not book again; reconcile…"). No silent success is reachable.

**Assertion disposition:** the stale `rejects` expectation in `order.dispatch.contract.test.js` predated the A5M/A5N provider-identity work and contradicted the sibling gate contract test (`order-confidence.gate.test.js:226-276`) for the same behavior. The aligned test still asserts every safety property: `blocked: true`, exact code, `provider: null` (no echo of the caller-selected provider), no `resolveAiDefaultProvider`, no `createDeliveryOrder` (zero provider calls), no `findOrCreate` (no new claim). Two new controller tests pin the structured-blocked → 409 HTTP mapping in the contract layer itself. This aligns duplicate contract tests to one verified end-to-end contract; no weakened assertion.

**Additional defects found and fixed while tracing (both source-verified):**

- `ORDER_STATUS_TRANSITIONS` (`order.service.js:32-36`) omitted `pending → confirmed`. `pending` is the primary create state (storefront/inbox/manual; entity default), so the redesigned Orders page's core **Confirm** action would 409 against a real backend. Added `pending: ['confirmed']`; `order.api.test.js` PATCH/cancel suites now exercise the true lifecycle. Regression: `order.api.test.js` 37/37 with the module.
- `order.api.test.js` fixtures omitted `fulfillment_status`, which every real row carries via schema default (`order.entity.js:53-56`, migration `20260522_004` `DEFAULT 'unfulfilled'`); fixture aligned with the true row shape. The `CANCELLATION_REQUIRES_UNFULFILLED_ORDER` guard is unchanged.
- Entity mocks in `order.api.test.js` lacked `DeliveryTracking`; lifecycle guards fail closed (503) when tracking state is unreadable (`order.service.js:1543-1545,1621-1623`), exactly as A4-G2-61 requires. Mock now provides the entity the real schema always exposes.
- `shop.api.test.js` mocks lagged two intentional A5 changes: missing `mergeSettingsPreservingRtoConsent` delegation (E-044 consent-preservation merge) and a `Shop.sequelize.transaction` stub for the locked platform-priority write (`shop.controller.js:633-653`). Test doubles aligned with the concurrency-safe implementation; update call-shape assertions include the transaction argument.

**A4-G2 blocker status with source evidence:** A4-G2-60 resolved (structured fail-closed replay + both controller mappings + no-echo tests); A4-G2-61 resolved (`mobile-courier.controller.js:354-413`: read failure → 503 `COURIER_TRACKING_READ_UNAVAILABLE`, distinct from not-found; persisted fallback identity validated before use); A4-G2-62 resolved (`order.service.test.js:433,477` bulk row-failure-before-writes tests, suite green); A4-G2-63 PASS already recorded.

**Verification after fixes:** the six A5N suites pass **6/6 suites, 83/83 tests**; the full touched-module backend regression passes **79/79 suites, 1102/1102 tests** (Node 20.20.2); the entire backend suite is **310/311 suites, 3985/3987 tests** with the only failure in `ai/grounding/grounding-boundary.test.js` — reproduced identically at baseline `ab0c958` in this Windows environment via a disposable detached probe checkout (created and retired same session; junctions removed without touching targets), and green in CI at baseline (release run 41348979305). Pre-existing environment-specific failure; not mission-caused; carried as an OPEN limitation, not a fabricated pass. A4-G3-05 (RTO settings read failure UI) remains open and belongs to G3.

**Disposition: A5N CLOSED; the E-062 backend blocker is resolved.** G2 completion additionally requires the frontend verification rerun on this exact tree (documented separately) and remains subject to the standing real PostgreSQL/Redis-stack limitation.

## A6 Customers implementation and A4-G3-05 closure (2026-11-02)

**A4-G3-05 (P0) resolved at the UI boundary:** `RtoNetworkSettings.tsx` previously converted a failed `GET /api/rto-shield/settings` into an assumed `{contribute:true, enforce:true}` display. It now has an explicit `unavailable` state: nothing rendered as a choice, toggles absent, retry re-reads, alert role for AT. Stored values are displayed exactly as the server answers (the documented default-ON network policy is applied server-side in `rto-network-settings.js:25-41`, consent writes are owner/admin + audited + refresh-gated per A5's E-016 fix), and non-owners receive read-only switches because the PUT route enforces `requireOwnerOrAdmin`.

**Legacy Customers worklist rebuilt against verified server truth:**
- Passive three-card summary removed with its two extra unfiltered count fetches and the optimistic post-create stat bump (E-007); the only total shown is the server `total` of the current query.
- `search` (server: name only, `customer.service.js:170-172`) and `phone` (`:174-176`) are now separate inputs with honest labels; the previous placeholder promised name/phone/email in one box while the endpoint filtered only names.
- The `rto_risk` column and drawer RTO block were dead UI: the web customer list/detail return neither field (verified `customer.service.js:161-203`) and free phone-risk prober endpoints are prohibited (E-020). Removed rather than stubbed.
- Mobile gets a card worklist; desktop keeps the dense table. Error path clears rows and offers Retry; no-match (query active) and truly-empty (no query) are distinct, with the empty state naming supported paths (manual add, Page connection).
- Delete affordance only for owner/admin — matching `customer.service.js:135` — with confirmation copy that no longer implies total erasure (phone-keyed network history persists; E-022/A4-G3-06).
- Profile → `/orders?search=<phone>` deep link; Orders gained URL `search` init + mirror sync (server-backed search covers number/name/phone). Verified as an E2E journey; not a new API surface.
- Pilot `Customer360Page` keeps its server-scoped `customer_id`, contextual RTO evidence (`loadRtoSignal` only for a valid phone), and deep links; its settings panel moves under the worklist controls.

**Verification:** 14 focused unit tests (boundary normalization, filter contract, no-match/empty/error separation, delete visibility by role, orders deep link, RTO unavailable/retry/read-only), full strict `tsc`, production build, and the combined 26-test browser suite twice serialized (22 prior journeys + 3 new legacy journeys + existing mobile overflow).

**Remaining for Customers acceptance (G5/A8):** BN responsive/zoom audit, 270–390px real-browser pass, RTO evidence-source labeling review, and the real-backend authenticated journey.

## A7 brand/typography convergence (G4, 2026-11-02)

The approved brand source of truth resolved in G0 was the repo's own production shell plus its public brand assets. The machine-local evidence copy `D:\easymod\archive\brand-evidence\2026-10-31-approved-logos` has since been removed from this host; its disappearance is recorded here rather than papered over. The in-repo authority is intact and was the convergence target: `src/styles/theme.css` (`--brand:#00A651`, `--brand-hover:#008040`, `--primary:#030213`, `--destructive:#d4183d`, Hind Siliguri `--font-bn`), mapped into Tailwind v4 `@theme inline`, plus `BrandLogo` serving `/brand/mark.svg`/`logo-192.png` in the authenticated shell and shadcn primitives already bound to those tokens.

**Implemented:** every piece of independently invented chrome on the mission surfaces — Orders worklist/detail/create/courier flow, legacy Customers, Customer 360 list/detail/opportunities, RTO settings — now uses `bg-primary`/`text-primary-foreground` for solid actions (matching the A5 OrderRow convention and ui/button default), `text-brand`/`bg-brand`/`focus:ring-brand` for brand emphasis, and the `bg-emerald-50 text-brand` tint pairing already established on Subscription/Add-ons. Blue-purple gradient avatars became `bg-muted`; indigo opportunity emphasis became brand/emerald. Deliberately preserved as semantic scales, not brand chrome: the order-status pill colors (pending/confirmed/…), per-channel identity colors (facebook/messenger/telegram/webchat), and informational lifecycle hues. No new palette, logo, or font was introduced anywhere.

**Typography:** Hind Siliguri is now applied once at the `DashboardLayout` workspace root (it is the approved Bengali-first face with full Latin coverage), instead of relying on scattered per-element `font-bn` classes; public/landing routes are untouched.

**Validation:** strict `tsc --noEmit` pass; 92-file/791-test unit suite pass; production build pass; 26/26 serialized Orders+Customers browser journeys pass. Real-viewport type-scale measurement, 125–200% zoom, and contrast audit are scheduled in G5 with screenshots.
