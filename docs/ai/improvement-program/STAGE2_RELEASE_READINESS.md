# Stage 2 Release Readiness

**PARTIAL. Do not deploy or enable enforcement.** The scoped release candidate, privacy patch, and rollback patch are separate local worktrees; none is an approved SHA.

| Blocking gate | Owner |
|---|---|
| Equivalent full baseline/candidate tests, independent review, and protected CI | QA / lead |
| Mixed-version reader safety and deployment of the privacy prerequisite or approved containment | Security / release owner |
| Demonstrated retrieval bound, exact-image isolated rollback, rollup evidence and monitoring | Backend / SRE |
| Explicit exact-SHA authorization and protected production approval | Release owner |

The equivalent local unit differential now passes: candidate 391/391 suites and clean `main` 388/388 suites, both with clean exits and no detected open handles. This is not protected CI or an exact-SHA release receipt.

Keep the scoring writer out of production until the privacy-only reader is the verified incumbent, or an approved containment survives image rollback. SRE must obtain the exact incumbent and candidate digests, isolated rehearsal and active alert/runbook evidence before requesting release approval. Monitor API and worker health, queue age and retries, acknowledgment failures and duplicates, response latency, and coverage by retrieval outcome. Use existing alert policy and an approved observation window; no production alert delivery or new dashboard is claimed.

See [verification](STAGE2_VERIFICATION_REPORT.md), [rollback](STAGE2_ROLLBACK_RECEIPT.md), and the [completion ledger](STAGE2_COMPLETION_PLAN.md). Do not treat a static validator or historical result as a release receipt.
