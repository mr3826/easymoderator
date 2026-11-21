# Stage 2 Verification Report

**PARTIAL.** This ledger retains historical local worktree evidence, based on `f38d8be033112c440c3f9e43888c8be1dd9775ec` using Node `20.20.2`. See [CI evidence](STAGE2_CI_EVIDENCE.md) for the later draft commit, merge checkout, and actual Actions results.

| Gate | Evidence |
|---|---|
| Scope | `git diff --exit-code HEAD --` for confidence gate, policy, channel providers and order modules returned zero. |
| Shadow evidence | Direct projection smoke passed four assertions. A focused diagnostic runner using preinstalled dependencies passed 52 assertions across four suites (scorer, projection, confidence gate, mutation boundary); Sequelize-dependent suites did not load on that run. The [evaluation](STAGE2_EVALUATION_BASELINE.md) ran on this worktree. |
| Worker/router | A second diagnostic run with an explicit Sequelize path passed 228/228 across five suites for reply mode, grounding, router and order-lookup authorization, and transcript delivery state. Scorer scores `0`, `1`, and failure did not alter tested sends/holds. This is not the full backend gate. |
| Privacy | **51/51** across four suites on `fix/conversation-wire-privacy-stage2`: history, metadata compatibility, transcript delivery state and SSE authorization. Exact old/new image rehearsal remains open. |
| Rollup | PostgreSQL 16 disposable fixture passed five assertions on the candidate SQL (same service with a `pg` adapter): scoped turns, delivered-versus-suggestion precedence, zero versus unscored, reason filtering and draft approval exclusion. Tiny-fixture `EXPLAIN (ANALYZE, BUFFERS)` is not production sizing. |
| Meta-shaped Docker | **57/57**, 2 suites via `npm run test:backend:meta:e2e:docker`, ports `55571`/`56471`. Covers captured provider acknowledgment, persisted final-text evidence, observed RAG failure with independent product evidence, and the tenant-keyed PostgreSQL rollup. |
| Docker integration | **262/262** on both the isolated candidate and clean `main` using `npm run test:backend:integration:docker` with separate services and ports. Both historical checkout failures pass; no checkout changes were imported. |
| Security | **917/917**, 59 suites via `npm run test:security --workspace=easymod-backend -- --runInBand --coverage=false --silent --forceExit --detectOpenHandles`. The JSON receipt reports zero failures and `openHandles: []`; this invocation did not establish a natural process exit. |
| Frontend focused | **7/7** inbox guardrails, including new and old reply rendering. Test fixtures wait for the expected inbox state instead of asserting against its loading placeholder. |
| Reliability/rollback | [Static contract and isolated interruption checks](STAGE2_ROLLBACK_RECEIPT.md) pass. RAG retrieval deadline implemented and unit-tested. Exact application image rehearsal remains pending. |
| Playwright | **20/20** in 3.5m across `ai-reply-mode.spec.ts` and `inbox-guardrails.spec.ts` with mocked APIs and one worker. |
| Full frontend | **1,178/1,178** on the serial rerun. The previous run had one failure in an unchanged Customers test that passed in isolation on both trees. |
| Builds and types | Backend entrypoint syntax check, Vite production build, and frontend `tsc --noEmit` passed. |
| Backend unit | Historical local receipt before the deadline cleanup fix and reader integration: **391/391 suites**, **5,314 passed**, 2 skipped. Main reference with the same test-only Redis-settings mock: **388/388 suites**, **5,261 passed**, 2 skipped. Both JSON receipts report success and no detected open handles; both invocations used `--forceExit`. The later draft CI results supersede these counts for the integrated tree. See [triage](STAGE2_REGRESSION_TRIAGE.md). |
| Release | [Draft PR 273](https://github.com/mr3826/easymoderator/pull/273) is pushed. No deployment or production runtime verification. |

## Independent Review

Independent read-only reviews of the Stage 2 and rollback diffs requested changes. Follow-ups added fallback observation, preserved valid product evidence when retrieval was empty, used the existing metadata merge when an echo wins, and strengthened the rollback marker and routed-health checks. These changes were retested locally; the original reviews were not final branch approvals.

| Question | Evidence and disposition |
|---|---|
| Can a shadow score change a send? | No in the reviewed path: scorer output is metadata only; focused tests varied output while asserting the legacy send and hold. |
| Can failure bypass a safety restriction? | No in the reviewed path: scorer failure is caught; the policy and confidence gates continue to use their prior inputs. |
| Can persistence corrupt delivery state? | No new lifecycle writes. The normal and echo-winning paths use existing conditional updates; tests preserve acknowledgment time and state. Exact-image and broader restart/failure verification remain open. |
| Can a merchant see another shop's metadata? | Tenant-bound source queries and synthetic REST/SSE tests pass. No cross-shop disclosure demonstrated; not a global perimeter sign-off. |
| Can internal metadata escape? | Known history and Stage 2 REST/SSE namespaces are projected locally. Older running readers remain a blocker without a deployed privacy prerequisite and mixed-version verification. |
| Can retrieval hang? | The original deadline cleared its timer before a pending search settled; the prior full suite did not establish that guarantee. The revised query uses one 8000 ms default budget through binding, embedding and search, including response bodies. Loopback Node fetch tests observed stalled collection, manifest and search response streams close. A deadline also bounds caller wait if an adapter ignores abort; it cannot terminate a non-cooperative upstream. Deadline overrides are trusted service options only. The worker's whole-turn recovery timers are unchanged and do not cancel the whole reply. Production environment rendering of the optional timeout override is unverified. |
| Does the exact incumbent work after rollback? | Not proven by fixture images or handler tests. Require the exact digest rehearsal. |
| Are unrelated automation and checkout included? | No, per scoped diff and integration comparison. |
| Does the UI claim verified factual accuracy? | It describes an evidence signal and explicitly distinguishes it from fact-checking; browser and component tests passed. |
| Is release backed by exact-SHA evidence? | The draft PR has protected merge-tree CI evidence. It has no protected-main image-producing SHA or runtime receipt. |
