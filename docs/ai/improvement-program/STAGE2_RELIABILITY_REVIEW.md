# Stage 2 Reliability Review

The isolated port adds no RAG requests or default deadline. Retrieval outcomes are observed at the existing router seam; they do not feed Action Gate evidence or the legacy confidence. A renewable queue lease and recovery notices do not cancel I/O. The existing Qdrant and embedding paths lack a demonstrated end-to-end bound; SRE must verify one or separately approve and test a cancellation budget before release. A `Promise.race` alone is insufficient.

The existing conditional delivery write can carry delivered evidence after provider acknowledgment without a second DB round trip or any new delivery-state fields. A mismatched archived proposal gets no delivered evidence. Echo-only recovery may lack an observation; coverage measures that gap separately from score zero. The scorer is synchronous, catches errors and checks its JSON output before storing it. Validate finalization failure, partial ack/rejection, restart, and event-order parity against main before asserting lifecycle equivalence.

The operator rollup uses a read-only, tenant-scoped transaction with a statement timeout and bounded lookback/result size. It makes no write, adds no migration, and has no public HTTP route. A disposable PostgreSQL fixture verified the query semantics; run the normal Sequelize path and benchmark realistic data before activating an operator consumer.
