# Stage 2 Regression Triage

The mixed tree's historical failures are not test receipts for the isolated branch. The clean reference is detached at `f38d8be033112c440c3f9e43888c8be1dd9775ec`; compare identical Node 20 and disposable infrastructure against it.

| Historical failure | Current disposition |
|---|---|
| Worker score 0 and 1 expected delivered scope on the initial write; effective-text length was asserted at the wrong write | Split regression expectations by stored suggestion and provider acknowledgment. Separately cover policy-transformed text without stale labels. The complete candidate rerun passed 391/391 suites and 5,305 tests with 2 skipped and no open handles. |
| `ai-mutation-boundary.security.test.js:58` expected the legacy resolver literal, absent from the mixed ADR-0016 worker | The clean base and release branch retain the expected legacy literal; diagnostic runs pass 2/2 on both without changing the test. |
| Four other failures in the historical full backend run | Identities not recovered from the available retained summary. The complete candidate rerun now passes 391/391 suites with 5,305 tests passed and 2 skipped; clean `main` passes 388/388 suites with 5,261 passed and 2 skipped after applying the identical test-only Redis-settings mock. |
| Two checkout integration failures in `message-worker.action-gate.integration.test.js`, replay and price change, stopped at `order session was not created` | Clean main and isolated candidate both pass 262/262 in Docker. No checkout changes imported. Do not attribute a root cause to a particular mixed-tree hunk without a controlled comparison. |
| Full frontend: Customers pilot header asserted while loading | Both trees pass that unchanged suite 3/3 in isolation. One observed failure in the parallel full candidate suite; serial rerun passed 1,178/1,178. |
| Full backend: repeated product pressure timeout and subsequent history/mock assertion | Both trees failed the same pair. The router waited for Redis through an unmocked settings-generation lookup; the timed-out case's model mock call appeared in the subsequent test. Mocking only that lookup passed the 52-case suite without changing production code, timeouts, or assertions. |
| Clean-`main` full rerun: egress-fence loopback fetch failed with `bad port` | The suite passed 7/7 alone and passed in the candidate full receipt. The immediate clean-`main` full rerun passed 388/388 suites, so this was a transient local port collision rather than a deterministic baseline failure. |

Initial test commands against unfinished Windows installs failed to load Jest's `yargs` and `exit-x`. The first full candidate run had two test-discovery failures caused by untracked new tests and a missing SQLite native binding that stopped 51 other suites and one assertion. The binding now loads and the new tests are staged, without changing the discovery rules.
