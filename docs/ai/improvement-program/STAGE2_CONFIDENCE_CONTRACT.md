# Shadow Confidence Contract

See [ADR-0015](../../adr/0015-reply-confidence-is-evidence.md) for the decision. Stage 2 does not control whether a reply is sent, including when observation fails. The legacy gate still receives its prior numeric input. Neither the YAML release contract nor merchant settings are part of the scoring candidate.

`confidence_score` is nullable. Deterministic order flow is categorized without a score. A missing observation is distinct from zero. The operator rollup uses the durable turn identity and a shop-scoped join. Its denominator is all selected durable turns, including human-handled turns; missing counts are not scorer errors or a percentage of AI replies. It reports coverage, score buckets and the counterfactual without returning raw text, identifiers or provenance.

`metadata.reply_evidence` contains only allowlisted reason codes and an optional provenance category. A null explicitly clears a previous label. Stage 2 does not claim that a high score verifies facts. An edited draft or one sent with different text cannot inherit the proposal's evidence label. See [evaluation](STAGE2_EVALUATION_BASELINE.md) for measured limitations.
