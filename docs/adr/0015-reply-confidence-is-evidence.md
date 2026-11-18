# ADR-0015: Reply Confidence Is an Evidence Score, Not a Probability

Status: Accepted (shadow rollout)<br>
Date: 2026-11-18<br>
Owners: Engineering + Product<br>
Related: [ADR-0013](0013-channel-automation-ownership.md) (confidence threshold is a channel-overridable setting), [AGENT_ACTION_POLICY](../ai/AGENT_ACTION_POLICY.md) §4

## Context

Every LLM reply reported a fixed `confidence: 0.9`
(`intent-router.service.js:1348`), regardless of what supported it. The
confidence gate compares that number to a merchant-set threshold (default 0.75),
so on the live path the gate could not distinguish a fully grounded catalog
answer from a fluent answer with no evidence behind it. Every other value in the
same file is also a fixed literal on a deterministic branch (`1.0`, `0`, `0.95`).

The 2026-11-18 production audit recorded this as a defect and proposed deriving
confidence from the shadow intent classifier's score. **That proposal was
wrong.** The shadow classifier has no calibrated score: `stage2-rules.js:272`
defaults `confidence = 0.99` and all its call sites pass fixed per-rule literals
(`0`, `0.98`, `0.5`). It is a rule-priority constant, not a per-turn uncertainty
estimate. There is no calibrated uncertainty source anywhere in the codebase.

The merchant UI made the problem visible in two places: the inbox rendered
`Confidence: 90%` with a traffic light, and the AI settings page carried the note
*"AI replies currently report a fixed 90% confidence, so any threshold at or
below 90% passes every reply."*

## Decision

### 1. Confidence reports evidence, not model uncertainty

`modules/ai/reply-confidence.service.js` exposes a pure
`deriveReplyConfidence(...)` returning `{ score, components, reasonCodes,
provenance }`. The score is a function of the evidence that supports the
**delivered text**: product retrieval status and coverage, knowledge retrieval
status (with an outage distinguished from an empty result), grounding decision
and violations, and provider fallback. `provenance ∈ {model, deterministic,
fallback}`.

The score is explicitly **not** a probability and must not be presented as one.
No calibration claim is made; `ROLLOUT_PLAN.md` §5 requires at least 2,000
labelled turns across 10 shops before any accuracy claim.

### 2. The score measures the delivered text, not the rejected candidate

When the grounding gate returns `SAFE_FALLBACK`, the text that reaches the
customer is deterministic written copy with the unsupported claim already
withdrawn. It is supportable by construction, so it is tagged `deterministic` and
keeps a deliverable score. Penalising it for the violations that caused the
fallback would hold exactly the replies grounding already made safe — the
attribute and price fallbacks that `tests/meta-e2e` pins as reaching the customer
— and in a real shop would turn fabric and attribute questions into handoffs.

`SUPPRESS`, `RETRIEVAL_FAILED` and empty completions score zero. Deterministic
order-flow turns are labelled, not scored.

### 3. The FAQ tier is never widened

FAQ relevance already uses the keyword match fraction (`best.score`). The derived
score takes `min(best.score, evidenceScore)` so a partial match that is correctly
held today is still held.

### 4. Shadow first

The derived score, its components, reason codes and the `wouldHold` verdict are
stored as `confidence_*` metadata (`confidence_mode: "shadow"`). A proposal is
labelled `suggestion`. Evidence is labelled `delivered` only after provider
acceptance of the same text, using the existing conditional state update. An
echo-only recovery, transformed outbound text or edited merchant draft may have
no delivered observation. **The gate continues to consume the existing value.** Removing the
`0.9` constant is a separate, explicit change that requires reviewing the
recorded distribution first.

### 5. The merchant sees reasons, not a number

The inbox's numeric confidence badge is replaced by a labelled evidence signal
(text plus colour, never colour alone — UI/UX guardrails §8). Messages written
before the score existed show "Evidence not recorded for this draft" rather than
an invented number. The settings honesty note stays until the constant is removed;
removing it earlier would make it false in the other direction.

## Alternatives Considered

- **Derive confidence from the shadow classifier's score** — rejected: it is a
  fixed per-rule constant, not a calibrated estimate (see Context).
- **Ask the model to self-report confidence** — rejected: unvalidated
  self-report, not evidence, and not comparable across providers.
- **Enforce the evidence score immediately** — rejected for this release: without
  a recorded distribution, a mis-weighted component could hold legitimate replies
  at scale. Shadow first, then flip with evidence.
- **Keep the number but relabel it "evidence score"** — rejected: it still reads
  as a probability and preserves the original defect in a new form.
- **Score the candidate rather than the delivered text** — rejected: penalises
  replies that grounding already made safe.

## Consequences

- Positive: the merchant sees an evidence signal, not a verdict on accuracy;
  the score becomes inspectable; the fail-open knowledge path becomes
  visible as `RAG_UNAVAILABLE` instead of silence.
- Positive: no sending behaviour changes in this release — the change is inert
  until the flip.
- Negative: two confidence values exist during the shadow period (the gate's and
  the recorded score). They are labelled, and the shadow value carries
  `confidence_mode: "shadow"`.
- Negative: the penalties are engineering judgements, not measurements. They are
  named constants in one place (`PENALTY`) precisely so calibration can replace
  them.
- Negative: merchant-facing Bengali for the new signal strings needs a native
  copy pass; the translation-coverage test verifies presence, not quality.

## Verification Contract

1. `deriveReplyConfidence` unit tests cover: order flow, empty completion,
   suppression, safe-fallback delivery, fully grounded, knowledge outage,
   outage-versus-no-evidence, retrieval failure, violations, FAQ minimum,
   provider fallback, and component recording.
2. `confidence-gate.test.js` is unchanged and green — the gate's contract does not
   move.
3. Meta-shaped E2E asserts a delivered AUTO reply records `confidence_mode:
   "shadow"`, a numeric score, reason codes, components and `wouldHold`, and that
   a grounded product answer does not look uncertain.
4. Translation coverage passes for both locales.
5. Flipping the gate is out of scope here and requires its own approval.
