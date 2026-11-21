# Stage 2 Shadow Isolation

The scoped patch does not edit the live confidence gate, policy engine, channel provider, or order modules. The LLM returns legacy `0.9`. The worker uses existing selection, policy, claim and provider acknowledgement; its Stage 2 output is observational metadata, not a send condition. The counterfactual never updates merchant settings or handoff logic.

Focused tests proved the same legacy send for shadow scores 0, 1 and scorer failure, and the same low-confidence hold with a shadow score of 1. They also exercise transformed text, an echo winning acknowledgment without a lifecycle rewrite, fallback observations and replay filtering. The Meta-shaped suite verified provider-captured sends and the real PostgreSQL query. The [verification report](STAGE2_VERIFICATION_REPORT.md) distinguishes these fixtures from exact-image and production proof.
