# Stage 2 Release Readiness

**PARTIAL. Do not deploy or enable enforcement.** The [draft candidate and two prerequisite PRs](STAGE2_FINAL_EXECUTION_REPORT.md) are committed and have green required PR checks. None is an approved production SHA.

| Blocking gate | Owner |
|---|---|
| Independent approval and protected CI for the final release commit | QA / lead |
| Mixed-version reader safety and deployment of the privacy prerequisite or approved containment | Security / release owner |
| Demonstrated retrieval bound, exact-image isolated rollback, rollup evidence and monitoring | Backend / SRE |
| Explicit exact-SHA authorization and protected production approval | Release owner |

The [CI evidence](STAGE2_CI_EVIDENCE.md) ties green required PR checks to the draft head and records the synthetic merge checkout used by tests. No protected-main image-producing commit, image digest, or runtime receipt has been qualified.

Keep the scoring writer out of production until the privacy-only reader is the verified incumbent, or an approved containment survives image rollback. SRE must obtain the exact incumbent and candidate digests, isolated rehearsal and active alert/runbook evidence before requesting release approval. Monitor API and worker health, queue age and retries, acknowledgment failures and duplicates, response latency, and coverage by retrieval outcome. Use existing alert policy and an approved observation window; no production alert delivery or new dashboard is claimed.

See [verification](STAGE2_VERIFICATION_REPORT.md), [rollback](STAGE2_ROLLBACK_RECEIPT.md), and the [completion ledger](STAGE2_COMPLETION_PLAN.md). Do not treat a static validator or historical result as a release receipt.
