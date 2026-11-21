# Stage 2 Independent Review

**Review open.** Historical read-only reviewer session `ses_e10d59a9dffeYtV6yjnfUisODk` reviewed `0f21901b4f99d4a237c3a5ac18ffc11e526a16b9` against `f38d8be033112c440c3f9e43888c8be1dd9775ec`. The reviewer did not implement the candidate, execute tests, or approve the GitHub PR. The current worktree follow-ups require fresh review.

| Finding | Disposition |
|---|---|
| Medium: `confidence_would_hold` uses the settings captured during generation; the last live gate may use refreshed settings. | Treat the value as a counterfactual for its observation boundary, not a comparison to the last send decision. AI evaluation owner must resolve or explicitly accept this before using the distribution for calibration. |
| Medium: independent product evidence can mask the score penalty for a retrieval outage even when the evidence does not bear on a reply's policy claims. | Use the explicit retrieval outcome to monitor outages. Do not interpret a score as claim-level validation. Scorer redesign and threshold changes are outside this release. |
| Release blocker: mixed-version reader and rollback runtime evidence missing. | Reader-first with a verified patched rollback target; see [privacy rollout](STAGE2_PRIVACY_ROLLOUT_PROOF.md). |
| Reader source coverage was incomplete for nested/legacy metadata and route/cache parity. | Verify the reader follow-up using synthetic web/mobile, history, transcript, cache and SSE contracts. Source review is not a live finding or compatibility sign-off. |

Source review found no shadow authority over live send/hold decisions. The LLM path still returns legacy `0.9`. Acknowledgment evidence is gated on provider confirmation and matching text; the echo path retains the confirmed delivery state. The RAG mechanism bounds caller wait but cannot stop a downstream adapter that ignores cancellation. Source review is not a substitute for exact-artifact evidence. Reviewer requested changes before relying on the shadow distribution and did not approve release. Separate approval of the prerequisite PRs and final SHA remains outstanding.

Review handoff: independent Security approves the exact #271 head plus mixed-version outcomes, independent Operations approves #272's guard and exact-image recovery, and independent QA plus the AI evaluation owner disposition the two findings, quarantine and monitoring on the final integration state. Record reviewer, approved revision, evidence and approval URL for each. No advisory agent result or self-review constitutes protected approval.
