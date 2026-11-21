# Stage 2 Quarantine Triage

**G5 open.** [Stage 2 quarantine](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135468) and [reader-only comparison](https://github.com/mr3826/easymoderator/actions/runs/44329542512/job/134889982134) both report 25 failed and 5 passed tests, with two failing suites. The lane is reported and non-gating; no gate policy changes were made. The counts are not 25 distinct defects.

| Cases | Observed signature and classification | Disposition |
|---|---|---|
| 22 cases in `EasyMod-backend/src/modules/ai/__tests__/chatbot-rag.test.js` | Deterministic stale test route: expected contract responses instead returned `404`. The pre-Stage 2 source intentionally unmounts the legacy chatbot route (`de45a744a9f033cc61a8e437d3bae85815832dc8`; `route-perimeter.test.js` asserts it on main). | Do not re-enable the route. QA maps each old contract to a supported worker, provider-double, or router assertion, or records why it is obsolete. |
| 3 cases in the same suite | One missing FAQ counter call and two missing prompt calls. Consistent with downstream assertions never reached from the retired route; same signatures occur without the Stage 2 writer. | Confirm through matched baseline/candidate runs; verify supported retrieval and prompt orchestration coverage independently. |
| `EasyMod-backend/tests/smart-payment-detection.test.js` | Separate setup failure: Jest cannot load ESM Chai from `require`. No tests in this suite were counted among the 25. This does not establish payment correctness. | QA and payment owner confirm current-path coverage; if non-release-related, record a separate tracked disposition rather than silently modifying quarantine. |

## Case Index

The shorthand below follows the 25 failure entries in the [candidate job](https://github.com/mr3826/easymoderator/actions/runs/44330133162/job/134892135468) in their logged order. `404` means expected active endpoint response, but received the retired-route response. `Cascade` means an expected mock call was absent after the request did not reach the handler. The classification describes this lane, not the correctness of the corresponding supported path.

| Case | Fingerprint | Observed classification |
|---|---|---|
| 1 | FAQ answer and confidence | 404 |
| 2 | FAQ hit counter | Cascade: zero calls |
| 3 | FAQ threshold falls through | 404 |
| 4 | Empty retrieval LLM fallback | 404 |
| 5 | LLM provider failover | 404 |
| 6 | Unavailable RAG LLM fallback | 404 |
| 7 | Identical request cache hit | 404 |
| 8 | Missing shop ID validation | 404 |
| 9 | Invalid platform validation | 404 |
| 10 | Overlong message validation | 404 |
| 11 | Empty message validation | 404 |
| 12 | Exact Meta channel routing | 404 |
| 13 | Order intent starts session | 404 |
| 14 | Active order session continuation | 404 |
| 15 | Legacy confidence clarification | 404 |
| 16 | Bangla greeting | 404 |
| 17 | Banglish routing | 404 |
| 18 | Business information and FAQ in prompt | Cascade: missing prompt call |
| 19 | Database FAQ in prompt | Cascade: missing prompt call |
| 20 | Product context in prompt | 404 |
| 21 | Product price and stock | 404 |
| 22 | Greeting without product context | 404 |
| 23 | Product DB failure fallback | 404 |
| 24 | Multiple products in grounding | 404 |
| 25 | Repeated product query cache hit | 404 |

The required integration lane passed 262 tests and the Meta-shaped lane passed 57 on the historical candidate. Those results support, but do not replace, the mapping for tenant isolation, provider acknowledgement, retry/idempotency, payment behavior, RAG cancellation and serialization. Use the same pinned Node, installed dependency graph, PostgreSQL/Redis fixtures and egress restrictions on clean main and the final candidate. Record actual step execution and sanitized test-name/assertion fingerprints, not private logs. Candidate-only or high-impact failures block release; independent review/disposition remains required.

The payment fixture contains a destructive database setup. Do not repair imports and enable it as-is; disposition separately or move a port to the existing guarded, disposable integration suite before running it. The quarantine comparison must use an isolated environment without production credentials or data regardless of the current suite-load error. The backend unit run also reported 13 skips; [CI evidence](STAGE2_CI_EVIDENCE.md) does not classify them as passed. Verify which skips are fixture-dependent and that no mandatory release path was skipped.
