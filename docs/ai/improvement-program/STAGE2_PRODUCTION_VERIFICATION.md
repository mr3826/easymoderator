# Stage 2 Production Verification

**G8 open; G9 not performed.** No Stage 2 deployment was dispatched or authorized. No approved SHA-to-digest pair, release run, migration receipt, or observation window exists. The latest `main` checked for this report was `f38d8be033112c440c3f9e43888c8be1dd9775ec`.

[Production Watch 44266311655](https://github.com/mr3826/easymoderator/actions/runs/44266311655) reported external readiness and API SHA `00f4e82b4ab25aadf9b5507cab3cc7865b119b7f` on 2026-11-18. It predates Stage 2 and is not proof of the running worker, frontend or their digests. This workspace could not inspect the observed incumbent's GHCR manifest without package access.

Before approval, SRE must verify the current digest and route inventory, approved observation window and existing SLOs, and actual dashboards/alerts for worker and queue health, dependency errors, RAG timeouts, latency, metadata writes/failures, PostgreSQL telemetry, provider acknowledgments, duplicates and existing policy decisions. No live rollup dashboard consumer has been verified. Stop on privacy disclosure, duplicate sends, policy drift, incorrect digests or a health/SLO breach. Use the rehearsed privacy-safe rollback, not the pre-reader image. Do not send test messages to customers.

| Required signal | Available evidence / remaining instrumentation or access |
|---|---|
| Routed API and TLS readiness | Production Watch receipt above; obtain a fresh receipt for each intended promotion window. |
| Worker health, queue lag, retries | `EasyMod-backend/src/routes/health.routes.js` includes authenticated critical queue statistics and worker canary freshness. No authorized production snapshot or alert route was inspected. Verify container health, dequeue age and attempts, not just queue depth. Do not trigger a provider canary. |
| Meta acknowledgements, send failures, duplicates and message latency | Source has `meta-webhook-metrics.js` and worker lifecycle/ops signals. Verify production aggregate ACK, send-failure, dedup and latency series and on-call thresholds; webhook delivery counts are not provider ACKs. |
| RAG health, confidence persistence and live policy | Read redacted aggregate retrieval statuses and durations, persist-failure events and coverage, and actual send/hold/handoff disposition rates. A high shadow score does not imply the retriever is healthy, and absent observations are not proof of successful persistence. Verify whether a collector and alerts consume these signals. |
| PostgreSQL, migration and privacy | External readiness does not establish schema compatibility, current backup/restore, or tenant isolation. Verify read-only schema and DB health telemetry plus approved synthetic privacy assertions, never raw customer rows or event frames. |

**Access blocker:** SRE must provide read-only access restricted to these aggregates, or a timestamped redacted export and alert ownership, for the intended production environment. No production credentials or customer payloads are needed for this handoff. Missing series require instrumentation and review before readiness can be signed off; do not invent numeric SLOs.
