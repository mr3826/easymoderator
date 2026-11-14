# 03 — Alert pipeline, synthetic incident delivery, and operator runbook (Gate C)

> **2026-11-14 note:** D-3 is recorded in `08-founder-authorization-package.md` — the alert channel is GitHub Actions notifications (`production-watch.yml` hourly probes) and the named on-call is the founder. The test-alert **human acknowledgment remains OPEN**, so this document's `ALERT_AND_OPERATOR_PROOF=PARTIAL` remains correct for the human-ack component; the "production destination/operator unnamed" statements below are the 2026-10-30 assessment.

## Pipeline inspected (candidate `04b07134`, read-only)

Single fan-out helper `EasyMod-backend/src/utils/ops-alert.js`: console `[OPS-ALERT]` always; Sentry (`SENTRY_DSN`) and Slack incoming webhook (`SLACK_ALERT_WEBHOOK_URL`) as external sinks; per-title throttle `OPS_ALERT_THROTTLE_MS` (default 5 min; closure rehearsal set to 0). Production config **fails closed without at least one of** Sentry/Slack (`src/config/production-config.validator.js:219-220`). `describeAlertSinks()` exposes booleans only.

Verified emitter coverage (event → alert): queue backlog / DLQ non-empty / canary staleness (`src/jobs/pipeline-canary.job.js:59,86,94,116`); held-message delivery failure and dead-letters (`src/jobs/message-worker.js:1017,1215,3691,3699`); LLM provider outage via circuit breaker (`src/modules/ai/circuit-breaker.service.js:81,104-127`); webhook store-fail / queue-unavailable / dead-letter / page-not-connected / replay-encryption (`src/modules/integration/meta-webhook-receipt.service.js:125,434,466,492,512`); dispatch-skip and schedule-fail (`meta-webhook-events.handler.js:361,407`); usage-metering failure (`:1228`); automation-integrity violation (`message-worker.js:2757`); stale payment reconciliation (`src/modules/payment/payment-processing-reconciliation.service.js:73`); inbox draft reconciler (`src/jobs/inbox-delivery-reconciler.job.js:281`); Meta GDPR identity (`meta-compliance.service.js:690`); channel auth expiry (`meta-authorization-recovery.service.js:126`). Admin self-test: `POST /api/admin/ops/test-alert` (`admin.routes.js:27`, SUPER_ADMIN-gated, audits `admin:ops_test_alert` first).

Documented gaps (no new platform built — current infra suffices for the pilot if wired):
- **Invalid webhook signature does not alert** (silent 403; metrics only, `meta-webhook.routes.js:169-176`). For a pilot this is acceptable (signature failures are noise-class probes) but should be a monitored metric, not invisible — recommend Sentry/metrics dashboard wiring under D-3.
- **No direct DB-unavailability alert** — surfaces via `/health/ready` 503 and store-fail alerts only; liveness probe + uptime monitor must watch `/health/ready`.
- `opsAlert` does not redact caller-supplied detail text (`gate-cd-local-evidence-procedure.md:164-171` caveat); alert payload hygiene depends on each emitter — all verified PII-free in the rehearsal path.
- No alert persistence table; retention is Docker `json-file` 10 MB × 5 (`docker-compose.prod.yml:18-22`) + external sinks.

## Synthetic incident — full chain executed 2026-10-30

Contract: `alert-recovery-harness.js` subcommands exactly as `docs/operational-gate-closure-v1/alert-recovery-rehearsal.md` prescribes. Isolated stack only; preflight attested `providerKeys=synthetic-marker-values-only`, `externalAlertSinks=disabled`, worker stopped, DB `easymod_ops_gate_e2e` on `postgres`.

| Stage | Result | Receipt (`D:\easymod\_pilot-authorization-closure-v1-local\evidence\`) |
|---|---|---|
| Synthetic fault | Signed synthetic `optin` for unconnected Page `OPS_E2E_ALERT_PAGE_alert-20261030T185031Z-40377` → HTTP 200 | `alert-post.json` |
| Application event | Durable receipt `IDENTITY_NOT_RESOLVED` / `PAGE_NOT_CONNECTED`, `payloadSha256=8e8bb040…d96d1a4`, encrypted replay present, no queue job | same |
| Alert pipeline → destination | **Exactly one new sink receipt: sequence 1, 284 bytes, `bodySha256=a6200c447726a9c51e35a815c55c7d6f048d7237d5b2e35a58f1f7220eadbbca`, receivedAt 18:50:36.554Z** — destination received, not just created | `alert-post.json`, `alert-inspect-held.txt`, `alert-sink-after.json` |
| Recovery | `prepare-replay` → real `WebhookReceiptReconcilerJob`: claimed 1 / processed 1; receipt `PROCESSED`; one `OPT_IN_EXPLICIT` consent audit; replay body cleared; **no queue job; alert count unchanged during replay** | `alert-reconcile.txt` (from live monitor output; partial file `alert-reconcile-partial.txt`), `alert-inspect-recovered.out` |
| Cleanup | Helper channel `DISCONNECTED`, `tokenConfigured=false`, receipt+audit retained | `alert-cleanup.out` |

QA observation (MINOR, tooling not product): the one-shot harness process prints its JSON then keeps the event loop alive (unclosed ioredis handles), which is why the destination receipt was never collected on 2026-10-27 within the command window. Workaround this run: bounded `timeout` + reap; state persisted correctly before the hang. Server process (`node server.js`) is unaffected — the sink receipt arrived 90 ms after the webhook. Recommend a `process.exit` fix in a future harness-only change.

## What is NOT proven

- **Production destination and human acknowledgment: unverified.** The receipt above proves delivery to an in-network test sink. No production Slack/Sentry target was contacted; no operator acknowledged. A machine receipt is not a human ack and is not presented as one. `ALERT_DELIVERY_RECEIPT=PASS (isolated destination)`, `HUMAN_OPERATOR_ACKNOWLEDGMENT=BLOCKED (owner)`.
- The SUPER_ADMIN `test-alert` endpoint was not exercised over HTTP (no super-admin in the synthetic seed by design); the production-code `opsAlert` path above is the stronger evidence.

## Operator runbook (pilot scope, positions not invented names)

Roles: **detector** = alert pipeline + `/health/ready` uptime probe; **responder** = on-call engineer (unnamed until D-3); **automation disabler** = per-shop `automation_mode=MANUAL` (instant, DB-backed), per-conversation pause `ai:pause:<id>`, global mutation flags (render+restart; two-person rule recommended, D-4); **restoration authorizer** = founder/cohort owner (D-4).

1. **Meta webhook failures** — receipts table `meta_webhook_receipts` (`held/dead-lettered/oldest` in `/health/detailed`); alerts named above; action: verify callback URL/subscription and verify-token; dead-letters require manual replay decision (runbook §4 of `docs/pilot-intelligence/07-operations-runbook.md`).
2. **Stuck queues** — canary staleness/backlog alerts; check worker container health; BullMQ delayed-completed keys are normal (queue-safety attestation); action: restart worker (`dc/docker compose restart worker`), confirm canary heartbeat resumes.
3. **Failed AI provider** — circuit-breaker open alert + SSE `llm_outage`; merchant-facing drafts degrade safely; action: confirm provider status, set shop `MANUAL` if outage persists; never blind-retry sends.
4. **Database unavailability** — `/health/ready` 503 + store-fail/dead-letter alerts; action: restore per attested backup/restore drill (`gate-cd-local-evidence-procedure.md:57-65`); note harness `migrate:down` is production-forbidden (forward-only policy).
5. **Payment verification uncertainty** — stale-payment reconciliation alert; action: manual verification with merchant; do not auto-advance status.
6. **Courier integration failure** — `automation_disabled` block volume + booking alerts; pilot stance = manual dispatch (D-7).
7. **Kill-switch activation** — three levels above; verify by action-gate audit rows (`ai.action_gate.denied` with `reasonCode=runtime_kill_switch_enabled`).
8. **High error rates** — Sentry error-rate; inherited 24h >1% `/api/mobile|order` threshold — reply-safety denominator thresholds are open under D-1.

`ALERT_AND_OPERATOR_PROOF=PARTIAL` — pipeline and destination delivery PASS on isolated infrastructure; production routing + named accountable human remain owner actions feeding D-3.
