# 06 — Consolidated founder decisions D-1..D-7, current evidence (Gate F)

Built directly on `docs/pilot-deployment-rehearsal-v1/05-owner-decisions-d1-d7.md`, preserving its terminology, and re-based on the frozen candidate `04b07134` plus this milestone's new evidence. No decision here is signed on the founder's behalf; none enables a production flag, selects a merchant, or authorizes spend. *(2026-10-30 statement of record — superseded 2026-11-14: the founder approved D-1..D-7 with "approve all as recommended"; see the dated section in `08-founder-authorization-package.md`.)*

**Superseded 2026-11-14:** the founder approved D-1..D-7 and the supplemental items in one response — "approve all as recommended". The authoritative record is the dated section in `08-founder-authorization-package.md`; each decision below now carries a short "Approved 2026-11-14" line that states what was approved without restating the full record. Approval still enables no production flag, selects no merchant, and authorizes no spend. The 2026-10-30 loopback preview cited as evidence in D-1 and D-5 is also superseded: production is live at `https://app.easymod.tech` on OCI (`docs/launch/PRODUCTION_TRUTH.md`), and the DO droplet of this package's era is destroyed.

## D-1 — Pilot cohort and exit criteria
**Approved 2026-11-14:** 2–5 pilot merchants; pilot flags OFF; AI reply mode DRAFT for 7–14 days; stop conditions DLQ>0, send-dedupe>0, or canary stale. Merchant selection remains a separate explicit action.
- **Current evidence:** Original proposal (3–5 BD Messenger shops, ≥30 days history, active `pages_messaging`, named opt-in contact) was challenged to "at most one opted-in **shadow/manual** shop for time-bounded workflow learning, not PMF validation" (Pilot-Deployment-Rehearsal V1 FieldFounder review; unchanged by this milestone) — superseded 2026-11-14: the approved cohort is 2–5 pilot merchants. Stop triggers exist (`runtime_kill_switch_enabled` denial spikes, any unauthorized write via read-only SQL checks, merchant-reported reply-safety incident, Sentry >1% on `/api/mobile|order` 24h) but have no measured denominators for reply safety. New: the founder can now observe the real merchant workflows on the loopback preview (01) with all automation OFF.
- **Recommended (superseded by the 2026-11-14 approval — cohort is 2–5, not one shop):** Defer live traffic; approve at most one opted-in shadow/manual shop after D-2..D-4 and D-1 thresholds are named, commerce flags OFF.
- **Alternative (superseded by the 2026-11-14 approval — cohort is 2–5):** Founder selects the 3–5 cohort now (not recommended — unsupported by rehearsal outcomes).
- **Risk if unresolved:** Unstaffed stop path; cohort sized beyond operational attention.
- **Blocks limited pilot:** YES.
- **Owner authority:** Founder/cohort owner selects shops and authorizes traffic; engineering does not select merchants.
- **Acceptance condition (superseded by the 2026-11-14 approval — cohort is 2–5 merchants; merchant selection remains a separate explicit action):** One named opted-in shop + written numerator/denominator/baseline/review-window/stop-threshold set for unsafe replies, false holds, missed/late replies, inappropriate order prompts, wrong catalog matches, provider spend, operator hours; reply-safety incident = immediate stop.

## D-2 — Meta eligibility
**Approved 2026-11-14:** app Live + Advanced Access confirmed; Tech Provider Access Verification still PENDING (deadline 2026-11-21); support-email/dashboard drift to fix. AI auto-reply modes remain gated until Access Verification clears — the pilot runs DRAFT/manual.
- **Current evidence (superseded 2026-11-14 where noted):** Candidate adds zero Graph scopes; permissions held: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`; production messaging proof exists (2026-09-22: `provider_send_confirmed=true, delivered=true`). ~~**Human-Agent eligibility not established.**~~ *(superseded 2026-11-14 — app Live + Advanced Access confirmed; Tech Provider Access Verification still PENDING to 2026-11-21; see `08`.)* 2026-10-27 inspection reported `contact_email_verified=false` and `support_url`/`data_deletion_url` unset — drifting against a 2026-08-20 audit that recorded the data-deletion callback configured; the console current-state is the only tie-breaker (the URL drift remediation is still open). `HUMAN_AGENT` remains an ungranted permission; backend blocks the send outright rather than mis-tagging (docs/meta-app-review.md:94).
- **Recommended (partly performed 2026-11-14 — app Live + Advanced Access confirmed, Access Verification pending; URL drift still open):** Keep existing scope; verify current console state (Human-Agent review, contact email, support/data-deletion URLs) before any AI mode above `MANUAL`.
- **Alternative:** Defer all AI-reply modes; manual-only pilot.
- **Risk:** Messaging eligibility/compliance lapse breaks sends or violates Meta policy mid-pilot.
- **Blocks limited pilot:** YES for AI modes; manual-only could proceed under D-7/D-4 posture.
- **Owner authority:** Meta app admin/founder.
- **Acceptance condition (partly met 2026-11-14 — app Live + Advanced Access confirmed; URL drift remediation still open):** Console screenshot/state record: Human-Agent status, verified contact email, both URLs configured, zero new scopes requested.

## D-3 — Monitoring ownership
**Approved 2026-11-14:** GitHub Actions notifications (`production-watch.yml` hourly probes) as the alert channel; founder as named on-call. The test-alert human ack is an OPEN operational step, not yet performed.
- **Current evidence (changed by this milestone; superseded 2026-11-14 where noted):** Full isolated chain now proven — synthetic fault → durable receipt → **real destination delivery receipt at the local sink** (sequence 1, 284 B, `bodySha256=a6200c447726a9c51e35a815c55c7d6f048d7237d5b2e35a58f1f7220eadbbca`) → reconciler recovery → cleanup (03). Emitter map, PII posture, retention, and gaps (no signature-failure alert, no direct DB-down alert, no alert persistence) documented. ~~Production destination/operator still unnamed~~ *(superseded 2026-11-14 — channel = GitHub Actions notifications via `production-watch.yml` hourly probes; on-call = founder; see `08`)*; **the human acknowledgment remains unproven — a machine receipt is not an operator ack, and the test-alert ack is still OPEN.**
- **Recommended (channel and on-call named 2026-11-14 as GitHub Actions notifications + founder; Slack/Sentry not chosen; test-alert + human ack still open):** Name the production Slack/Sentry destination + on-call; run the documented self-test (`POST /api/admin/ops/test-alert`, SUPER_ADMIN) against the named channel; operator confirms receipt on a device they watch; add `/health/ready` uptime probe (covers the DB-gap alert).
- **Alternative:** Staffed manual log/runbook checks for a tightly bounded pilot while automation stays off (explicitly weaker).
- **Risk:** Silent failures; unbounded detection/response time.
- **Blocks limited pilot:** YES (per prior attestation and this mission).
- **Owner authority:** Founder/operations owner.
- **Acceptance condition:** Written channel + primary/escalation names + ack of a live test alert.

## D-4 — Kill switches
**Approved 2026-11-14:** founder as sole operator per level (pre-launch team of one); the two-person rule on global mutation flags is explicitly DEFERRED to GA — a founder-accepted deviation.
- **Current evidence (superseded 2026-11-14 where noted):** Three levels exercised and independently received (global `runtime_kill_switch_enabled` denial + audit row; per-conversation `ai_paused`; per-shop `manual_mode`); strict-literal fail-closed flag semantics re-confirmed at `ai-runtime-flags.js:26-39` incl. unmapped-mutation-type-DENIED-by-construction; preview stack visibly enforces OFF-state (`/api/inbox/actions → 409 FEATURE_DISABLED`). ~~Authorized flip operators, second approver, and production confirmation path remain unnamed.~~ *(superseded 2026-11-14 — founder is sole operator per level; the two-person rule on global mutation flags is deferred to GA as a founder-accepted deviation; see `08`.)*
- **Recommended (two-person rule superseded by the 2026-11-14 approval — deferred to GA as an accepted deviation):** All mutation switches OFF for pilot; name per-level operators; two-person rule for the four global mutation flags; keep the blocked-synthetic-action confirmation method.
- **Alternative:** Manual-only pilot with no automation authorization at all (safe but reduces what the pilot learns).
- **Risk:** Ambiguous authority delays incident suppression; a stale rollout flag keeps mutations on.
- **Blocks limited pilot:** YES.
- **Owner authority:** Founder names operators/approvers and accepts the confirmation method.
- **Acceptance condition (2026-11-14: authority named — founder sole operator per level; two-person rule deferred to GA; the one rehearsed production-side flag flip remains an OPEN follow-up):** Written authority matrix + one rehearsed production-side flag flip + verification query results.

## D-5 — Mobile limitation (re-derived at the frozen candidate)
**Approved 2026-11-14:** accept the URL-paste photo-draft flow; exclude camera-file upload from pilot scope.
- **Current evidence:** The IC-era framing "client calls a missing endpoint" is **superseded**: at `04b07134` the mobile photo flow is `usePhotoDraft` (`EasyMod-mobile/src/hooks/useProducts.ts:167–196`) → **`POST /api/mobile/products/photo-draft`**, implemented backend-side (`mobile.routes.js:73`, `mobile-product.controller.js:241`) and presented through `PhotoToProductModal.tsx` — an end-to-end **working draft flow where the image is a pasted `image_url` text field**. The multipart file-upload endpoint `/api/mobile/products/images` remains absent from the backend **and no longer referenced by the client** (repo grep: zero call sites) — so there is no broken button. `MOBILE_API_ENABLED` is literal-`'true'`-only and OFF at source (`config.js:43`) but **production-recorded TRUE** since 2026-09-26 (`04`); the real, narrower product limitation is: **mobile merchants cannot upload a camera/gallery file — they must supply an already-hosted image URL** (server-side file upload exists on the web API only, `product.controller.js:429`). The preview demonstrates the truthful disabled-surface pattern (action queue 409, 01).
- **Recommended:** Accept the URL-paste draft flow as the pilot's mobile photo path; explicitly exclude camera-file upload from pilot scope; keep Wave-3 mutation sub-flags unrendered.
- **Alternative:** Add the mobile multipart upload endpoint in a separately scoped post-pilot increment (aligns with `docs/ic-merchant-workspace-v1/02` handoff ask #2).
- **Risk:** Merchants whose images exist only on-device experience a workflow dead-end mid-conversation; messaging clarity needed at enablement.
- **Blocks limited pilot:** NO — the flow is truthful and functional as it stands.
- **Owner authority:** Product owner.
- **Acceptance condition:** Written scope note: pilot excludes mobile camera-file upload; photo-draft-with-URL accepted as the interim merchant path; acknowledgment that the mobile API surface is production-live.

## D-6 — V6/Phase-D debt
**Approved 2026-11-14:** defer the UX debt, with the Inbox guarantees pinned as a release condition.
- **Current evidence:** 30-item V6 action-first UX list + one skipped Phase-D `Channels.tsx` e2e spec unchanged; no UX work was in scope this milestone. Inbox guarantees re-validated on the current stack: authenticated journeys (chromium 58.5s / firefox 1.3m, pilot logs) still assert draft-unsent (`DRAFT_DELIVERY_NOT_CONFIRMED`), dismissed-expiry persistence, handoff claim/resolve, expired-window no-send, and cross-tenant 404s.
- **Recommended:** Classify the named debt post-pilot ONLY while the reviewed Inbox message lifecycle remains intact — draft explicitly unsent in transcript, safe inline actions, unknown/expired reply windows fail closed (guarantees are a release condition, not deletable debt).
- **Alternative:** Defer pilot until the UX list + skipped spec are done (slower learning).
- **Risk:** Debt items hide reply-safety gaps if discarded rather than deferred.
- **Blocks limited pilot:** NO (conditional on guarantee preservation).
- **Owner authority:** Founder accepts named debt + guarantees.
- **Acceptance condition:** Written acceptance listing the 30 items + Phase-D spec as tracked debt with the Inbox guarantees pinned.

## D-7 — Webhook auto-booking
**Approved 2026-11-14:** keep webhook auto-booking OFF; manual dispatch is the pilot stance (matches live production).
- **Current evidence:** `AI_COURIER_BOOKING_ENABLED=false` is the rendered production default; verified paid webhook records payment truth but booking returns `{blocked, automation_disabled}`, logged, manual dispatch (AGENT_ACTION_POLICY §11; matrix-pinned, zero provider/dispatch side effects). This milestone re-attested hold-and-replay truthfulness on the live stack (alert chain: held inbound, recovered, no queue job created without authorization).
- **Recommended:** Keep webhook auto-booking OFF; manual dispatch is the pilot stance.
- **Alternative:** A later, explicitly scoped enablement after main-stack replay/idempotency/monitoring/rollback evidence.
- **Risk:** Merchants expecting auto-dispatch need explicit communication of the manual path.
- **Blocks limited pilot:** NO while OFF (it is the safe default).
- **Owner authority:** Founder/ops authorizes any future scope + dispatch ownership.
- **Acceptance condition:** Written manual-dispatch SRE acknowledgment + merchant-facing expectation note.

## Additional owner items carried into the single authorization response

8. **Supplemental AI image-data transfer condition (updated):** the photo-matching default-ON mismatch is corrected and fail-closed at source (`04`); the transfer condition now applies to any *future enablement*: allowed image-data classes, provider terms for Gemini/OpenAI image forwarding, gated/calibrated photo-triggered order selection (text-RAG caveat retained from the base document). Keep OFF for pilot. **Approved 2026-11-14:** photo matching stays OFF; provider terms must be approved before any enablement.
9. **New — `qs` MEDIUM disposition (Gate E):** ship the `qs@6.16.1` lockfile bump increment before any deploy (recommended), or sign a time-bound acceptance with the flag-OFF posture as compensating control. One line either way. **Resolved 2026-11-14:** `qs` 6.16.2 is shipped (`EasyMod-backend/package.json` line 109 and `package-lock.json`), past the 6.16.1 fix — no action needed.
10. **Deployed digest read (recorded as `08` item 10):** the deployed image digests were read from the OCI host `/opt/easymod/deployment-metadata.json` on 2026-11-14 ~02:50Z via delegated SSH; the verbatim block is in `08` item 10. Rollback rehearsal remains a separate, ungranted action.
11. **Confirmation-only (item 11 in `08`):** founder walkthrough of the loopback preview (`01`) closes B-1 on first login. **Superseded 2026-11-14:** the loopback preview is stale; production is live at `https://app.easymod.tech` on OCI, and the founder sign-in there replaces the walkthrough — it is an OPEN confirmatory follow-up, not yet recorded.
