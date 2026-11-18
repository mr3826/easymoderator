# Stage 2 CI Evidence

Recorded 2026-11-18. This ledger is a local documentation update, not part of the tested source tree.

| PR | Head SHA | PR Merge Gate | Security Scan |
|---|---|---|---|
| [273: Stage 2 draft](https://github.com/mr3826/easymoderator/pull/273) | `0f21901b4f99d4a237c3a5ac18ffc11e526a16b9` | [44330133162](https://github.com/mr3826/easymoderator/actions/runs/44330133162), pass | [44330133402](https://github.com/mr3826/easymoderator/actions/runs/44330133402), pass |
| [271: privacy reader](https://github.com/mr3826/easymoderator/pull/271) | `a1f567af1fded4499514f7344168dcffbf1a8882` | [44329542512](https://github.com/mr3826/easymoderator/actions/runs/44329542512), pass | [44329542459](https://github.com/mr3826/easymoderator/actions/runs/44329542459), pass |
| [272: rollback and promotion](https://github.com/mr3826/easymoderator/pull/272) | `3800f195178e42862416fc930d7da8efa9de87b4` | [44329546066](https://github.com/mr3826/easymoderator/actions/runs/44329546066), pass | [44329546065](https://github.com/mr3826/easymoderator/actions/runs/44329546065), pass |

`gh pr checks <PR> --required`, `gh run view <run> --json status,conclusion,headSha,jobs`, and the job logs were used. The Stage 2 CI checkout was `1fd8de4c1f4472cea760475a0e8ac5f72344c135`, GitHub's synthetic merge of the draft head into `f38d8be033112c440c3f9e43888c8be1dd9775ec`. That is not a final `main` or image-producing commit.

| Stage 2 job | Verified result |
|---|---|
| [Quality fast](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135582) | Backend 5,315 passed, 13 skipped; 389 suites passed, 4 skipped. Security 917 passed across 59 suites. Qdrant/semantic helper suite 63 passed. Frontend 1,178 passed across 125 files; frontend build step succeeded. |
| [Backend integration](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135468) | PostgreSQL migration and schema audit passed; integration 262/262 across 37 suites; cutover drill passed. Existing non-gating quarantine reported 25 failed and 5 passed across 2 suites. No new exemption was added. Failure attribution is not established by the counts. |
| [Meta-shaped E2E](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135474) | 57/57 across 2 suites. |
| [Mock-only Playwright](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135673) | Four lanes completed: 162, 5, 2 and 19 tests passed. |
| [Other validation](https://github.com/mr3826/easymoderator/actions/runs/44330133162) | Deployment configuration dry run, Docker build validation without push and Growth build, browser and image smoke checks passed. |
| [Mobile CI](https://github.com/mr3826/easymoderator/actions/runs/44330133247) | Isolation/protected-path check lane; no opt-in device run claimed. |
| Artifact publication and deployment | Skipped on the PR as designed. No image digests or deployment receipt. |

The historical draft PR checks passed. This does not close final G7 in the [release report](STAGE2_FINAL_RELEASE_REPORT.md). Reconfirm the required checks, applicable test steps, and provenance on the actual release commit after prerequisites land and the base changes. See [quarantine triage](STAGE2_QUARANTINE_TRIAGE.md) for classification outside the required checks.

Follow-up local checks, not final CI: Node 20.20.2 frontend focused tests (`UnifiedInboxGuardrails`, `UnifiedInbox`, `InboxEvidenceRail`) passed 89/89 and the full `vitest run --maxWorkers=4 --silent` suite passed 1,178 tests across 125 files. It logged loopback proxy errors but no failed suites. A local Vite production-mode bundle built with warnings about third-party Rollup annotations; it is not a registry image. The registry-only workflow passed actionlint 1.7.9 including ShellCheck. No GHCR-authenticated pull was verified by that static check.

The registry verifier was added to [#272](https://github.com/mr3826/easymoderator/pull/272/commits/530ab42da2d1e310706260094a5a3a645c158a82), which started [PR CI 44342691145](https://github.com/mr3826/easymoderator/actions/runs/44342691145) and [Security Scan 44342690449](https://github.com/mr3826/easymoderator/actions/runs/44342690449). These are follow-up PR runs, not a merged release artifact.

The reader hardening was added to [#271 at `f309da82015371c508cf1539563c9f2759c00f03`](https://github.com/mr3826/easymoderator/pull/271/commits/f309da82015371c508cf1539563c9f2759c00f03). Its focused backend tests passed 66/66, and GitHub started [PR CI 44343265880](https://github.com/mr3826/easymoderator/actions/runs/44343265880) and [Security Scan 44343265734](https://github.com/mr3826/easymoderator/actions/runs/44343265734). Read these receipts rather than extrapolating from the earlier reader head.
