# Stage 2 Exact-Image Rollback Receipt

**G4: NOT RUN.** No receipt or sign-off exists for exact application images. Previous [fixture evidence](STAGE2_ROLLBACK_RECEIPT.md) and the [draft deployment dry run](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134894740923) establish contract and synthetic interruption coverage, not the ability to restore the real application with Stage 2 state. Docker availability does not remove the [required digest/access blocker](STAGE2_GHCR_IMAGE_PROVENANCE.md).

| Required record | State |
|---|---|
| Incumbent, reader-only, final and recovery source SHAs/digests; actual architecture | Unverified |
| Isolated stack, provider doubles, denied provider egress; database schema and backup/restore snapshot | Not exercised with exact images |
| Reader-first activation, worker readiness and legacy delivery behavior | Not exercised with exact images |
| Synthetic Stage 2 persistence, routed privacy, durable PostgreSQL and Redis replay compatibility | Not exercised with exact images |
| Controlled interruption before activation, after writes and during recovery; exact digest and checksum restoration | Not exercised with exact images |
| Timestamped run, reviewed redacted commands, outcome and Security/SRE/QA sign-off | Not available |

Run on disposable Linux/Compose with the correct platform, independent volumes and synthetic data. Start the immutable incumbent; qualify schema, API, worker, queue and provider-double baseline. Promote the exact reader-only build and verify routed privacy, then activate the exact writer and verify delivery state, shadow-only behavior, evidence labels and both tenant contracts. Rehearse automatic and runbook recovery, including interruption that retains the active marker. Verify image identities, config hashes, worker recovery and public projections with Stage 2 rows and Redis entries retained. Measure against the approved recovery window. Never use the real provider, production database, `migrate:down`, or unpatched fallback after writes. Keep config and backup contents in approved storage; record only redacted evidence and the actual successful/failed operations. A failed recovery or unresolved marker blocks promotion.
