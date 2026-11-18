# Stage 2 PR Dependency and Merge Plan

Snapshot: 2026-11-18. Remote base `main` was `f38d8be033112c440c3f9e43888c8be1dd9775ec`. All three PRs were open with no requested or submitted GitHub reviews. See [CI evidence](STAGE2_CI_EVIDENCE.md) for the tested PR runs. The strict main checks are `PR Merge Gate` and `Security Scan`. The ruleset requires PRs but reports zero mandatory approving reviews; the release still explicitly requires qualified non-author approvals.

The collaborator listing returned only `mr3826`, who authored all three PRs. The repository owner must identify and grant appropriate review access to qualified non-authors; advisory local reviews cannot satisfy this gate. Production approval is a separate environment control.

| PR | Remote head | Synthetic merge | Next action |
|---|---|---|---|
| [#272](https://github.com/mr3826/easymoderator/pull/272) | Started at `3800f195`; verifier pushed at `530ab42da2d1e310706260094a5a3a645c158a82` | Historical `57af518282ad197b21d45e33fa13cf4db1f56927` | DevOps and non-author reviewer qualify the guarded workflow and merge tooling only. |
| [#271](https://github.com/mr3826/easymoderator/pull/271) | Started at `a1f567af`; hardened reader pushed at `f309da82` | Historical `fdd5d5e62a121087791e72182b915276a32eab2e` | Privacy reviewer approves explicit projection; refresh CI against main, then publish the reader-only build. |
| [#273](https://github.com/mr3826/easymoderator/pull/273), draft | `0f21901b4f99d4a237c3a5ac18ffc11e526a16b9` | `1fd8de4c1f4472cea760475a0e8ac5f72344c135` | Keep draft until reader is the verified production rollback floor, final review is complete, and maintainer agrees on publish-only integration. |

The second parent of #273 is #271's exact remote commit. Four of six reader paths match; `conversation.service.js` and `sse-manager.js` extend privacy projection with allowlisted evidence. #272's six original paths are disjoint and absent from #273. Preserve ancestry with a protected merge commit where possible. After prerequisites land, merge main forward into the release branch, retaining the hardened projection inside the writer's evidence projection. Inspect the new diff against main before retesting. Do not cherry-pick the original reader again or force-push. Distinguish PR head, synthetic checkout, merged `main`, publisher run and OCI digests.

`#272 tooling -> #271 privacy build and separate protected rollout -> patched incumbent verification -> #273 protected merge (publish only) -> exact-image rehearsal -> authorized Stage 2 rollout`. No branch update should actuate production. The reader-only build can update API and worker together because it does not write Stage 2 observations. Retain and verify the frontend and other service digests; do not bundle unrelated changes. Reject a Stage 2 dispatch if the actual previous service set differs from the rehearsed, privacy-safe rollback set. No source merge or artifact publication is production authorization.

Release owner must approve the distinction between pre-merge checks and post-merge exact-image qualification before merging #273; the supported publisher builds from main. All runtime promotion remains blocked through the [final release gates](STAGE2_FINAL_RELEASE_REPORT.md).
