# Stage 2 Privacy Rollout Proof

**G2 incomplete.** [PR 271](https://github.com/mr3826/easymoderator/pull/271) isolates the reader change; [PR 273](https://github.com/mr3826/easymoderator/pull/273) integrates the original reader commit with the writer. Historical local integrated history, metadata, delivery, projection and SSE assertions passed 55/55 across six suites. That source evidence predates this follow-up and does not establish exact-image mixed-version compatibility.

The #271 follow-up at `f309da82` adds typed message and nested metadata projections in `internal-message-metadata.js`, applies them before SSE publication and framing, and updates the dedup cache to use the authenticated tenant namespace. Nine focused backend suites passed 66 tests (conversation, attachment, mobile inbox controller, SSE and cache contracts). A separate Expo unit run could not start because its workspace Jest was not installed. No production or mixed-version image tests are claimed. #273 must integrate the follow-up and retain only the explicitly projected Stage 2 evidence label before final checks.

Checked-in `docker-compose.prod.yml` and `Caddyfile` describe Caddy in front of API and UI containers, a distinct worker sharing the backend image, and persistent PostgreSQL/Redis state. These are source observations, not a verified live route, cache, or replica inventory. Stage 2 has no schema migration of its own; deployment schema state and migration compatibility still need rehearsal.

| State | Treatment |
|---|---|
| A: unpatched reader, old worker and UI | Incumbent baseline only; not a qualified rollback target once Stage 2 rows exist. |
| B: patched reader, old worker and UI | Required first. Verify all public reader paths including live and replayed SSE, history, pagination, authenticated tenant scope, and cached/old UI behavior. |
| C: unpatched reader, Stage 2 worker | Must be excluded by rollout order and recovery controls, not presumed to be safe. |
| D: Stage 2 reader and worker, old UI | Verify optional evidence compatibility and delivery acknowledgment. |
| E: Stage 2 reader, worker and UI | Verify English and Bangla, REST/SSE parity, restart and the shadow-only live policy. |
| F: patched rollback reader with Stage 2 rows/events and mixed UI | Verify persisted data and buffered events remain filtered, including after reconnect. The reader-only build may omit the public Stage 2 label. Block rollback to an unpatched reader. |
| G: patched reader with historical rows and pages | Verify web and mobile transcript/history, deployment-era and historical events, attachment and delivery fields, and tenant-scoped lookup/cache behavior. |

Select reader-first, not ordinary rolling replacement with stale readers. It adds a separately authorized rollout and observation step but removes reliance on timing between reader and worker replacement. The first artifact may update API and worker together because it contains no Stage 2 writer. Before the writer can start, confirm all active routes, caches, open connections and fallback/DR readers are on the safe contract. Require isolated runtime assertions with synthetic records, actual pinned artifacts, cache/replay coverage, a verified live routing inventory and non-author approval before marking G2 passed. Do not publish sensitive security evidence in the public repository.
