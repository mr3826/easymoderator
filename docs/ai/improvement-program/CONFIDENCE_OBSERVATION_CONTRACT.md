# Confidence Observation Qualification Contract

Status: **ADOPTED_MISSION_AUTHORIZED / PENDING_FOUNDER_RATIFICATION**
(adopted under the standing founder mission authorization for the autonomous
Phase 0 remediation; the founder has not personally ratified the numeric
thresholds. Until ratification, every verdict this contract produces is
engineering evidence — never a business acceptance, and never a send/hold
condition.)

Contract version: `confidence-observation-v1`
Implemented in: `EasyMod-backend/src/modules/ai/confidence-qualification.service.js`
(pure evaluator), `reply-confidence-rollup.service.js` (evidence source),
`admin.service.js` → `GET /api/admin/shops/:shopId/confidence-qualification`
(operator read), `jobs/confidence-qualification-snapshot.job.js` (daily durable
collection).

## What this contract decides

Whether a shop's **shadow-confidence observation window** is strong enough to
support a future proposal to change confidence behavior. It does not change
behavior. Shadow observation remains, per
[ADR-0015](../../adr/0015-reply-confidence-is-evidence.md) and
[STAGE2_CONFIDENCE_CONTRACT.md](STAGE2_CONFIDENCE_CONTRACT.md), an evidence
score that authorizes nothing.

## Qualification criteria (all must hold)

| # | Criterion | Threshold | Source in the rollup report |
|---|-----------|-----------|------------------------------|
| 1 | Observation span from the first eligible scored observation | ≥ 72 hours | `firstEligibleObservedAt` vs evaluation clock |
| 2 | Eligible scored turns in the window | ≥ 30 | `scored` |
| 3 | Distinct conversations among eligible scored turns | ≥ 3 | `conversations` |
| 4 | Authorized shops in scope | ≥ 1 | `shopAuthorized` input (see below) |
| 5 | Explicit denominators present | `scored`/`unscored` + `eligible`/`ineligible` always echoed | denominators block |
| 6 | Shadow-to-live violations | = 0 | architectural isolation (see below) |

**Eligible scored** means a durable turn whose single selected AI message
carries a shadow observation with scope `suggestion` or `delivered` AND a
finite `confidence_score` in [0, 1]. `unscored` counts in-scope turns without a
usable score; `missing` counts turns with no eligible observation at all;
`scored = suggestion + delivered − unscored`, `eligible = scored`,
`ineligible = missing + unscored`.

Verdicts: `QUALIFIED` (all criteria met) · `OBSERVATION_PENDING` (authorized,
isolated, but the window has not spanned 72h yet — including the zero-
observation case; **zero observations can never yield QUALIFIED**) ·
`INSUFFICIENT_EVIDENCE` (an unauthorized shop, a broken isolation statement, a
failed evidence read, or a span ≥ 72h with insufficient volume). Any read
failure (e.g. statement timeout) maps to `INSUFFICIENT_EVIDENCE` — the
evaluator never fabricates a pass.

## Why the 168h window suffices to prove the 72h span

The qualification reader always requests the rollup's widest allowed window
(168h, itself capped by the service's 1..168h validation). The window is
bounded by `NOW() − hours`, so a non-null `firstEligibleObservedAt` inside it
demonstrates an eligible observation that happened between 72h and 168h ago
the moment the span criterion reaches 72h; no longer window is needed. All
counters remain inside the single 5000-turn cap, so under truncation counts
are **lower bounds** — a QUALIFIED verdict is conservative with respect to
volume. The span proves observation *reaches back* ≥ 72h, not gap-free
coverage inside the window; the criterion is named `observationSpanHours` for
that reason and the limitation is part of the contract.

## Evidence invariants (unchanged, per design ruling R5)

One query per shop: `SET TRANSACTION READ ONLY` + `SET LOCAL
statement_timeout = '2s'`, tenant-scoped (`t.shop_id = $shopId` with a
conversation join that re-checks `c.shop_id = t.shop_id`), `LIMIT 5001` with
the 5001st row only signalling `truncated`. The WP-03 extension adds exactly
two columns (`t.conversation_id`, `t.created_at`) to the same SELECT and
aggregates them in JS inside the existing slice — no new query, no new table,
no new migration, no PII. Responses carry only counts, buckets, and ISO
timestamps.

## shadowToLiveViolations — honest source

There is **no runtime violation counter**, and none was fabricated. The value
0 is an architectural-isolation statement:
`shouldHoldForLowConfidence()` in `confidence-gate.service.js` consumes only
the legacy router confidence, automation mode, and threshold — it never reads
`confidence_mode`/`confidence_scope`/`confidence_score` shadow metadata — and
the isolation is proven by
[STAGE2_SHADOW_ISOLATION_PROOF.md](STAGE2_SHADOW_ISOLATION_PROOF.md) plus the
focused tests it names. The rollup is operator-only and READ-ONLY, so no read
path can write a send condition either. If that isolation ever changes, the
caller must pass a non-zero value and the contract fails closed
(`shadowToLiveIsolation.met = false`). The evaluator treats any malformed
input as unmet.

## shopAuthorized — code-visible proxy

The authoritative consent is the signed pilot-authorization record
(documentary, held outside the schema). The code proxy — deliberately narrow —
is: the shop row is ACTIVE (`is_active`), no bypass-proof AI emergency stop is
engaged (`ai_emergency_stop`, ADR-0013 §6), and the shop's pilot-features row
has at least one enabled feature (SUPER_ADMIN-granted enrollment; a missing
row or an all-off row after `disable-all` is NOT authorized). The verdict
echoes the boolean as an input, so a reviewer can re-check the proxy against
the signed record.

## Not commercial metering

`ai_reply_shadow_ledger` (`ai-reply-shadow-ledger.service.js`) is **commercial
metering** of accepted AI replies. This contract reads neither it nor its
flags; a shop with metering off still qualifies, and metering rows never mark
anything QUALIFIED.

## Daily durable collection

`confidence-qualification-snapshot` runs daily (03:30 UTC) through the
existing BaseJob pattern: Redis lock, AuditLog idempotency by `executionId`,
`dryRun` writes nothing. One aggregate-only `AuditLog` row per authorized shop
(`action: job:confidence-qualification-snapshot`, `resource_type: shop`,
metadata = verdict + denominators + `firstEligibleObservedAt` + report
summary). Slack notification fires only on a transition INTO `QUALIFIED`, and
only when `SLACK_ALERT_WEBHOOK_URL` is configured. No raw messages, no shop
names, no PII in any persisted or emitted field.

## G03 boundary

This contract instruments observation; it does not close Gate 0 G03. With zero
real production shadow observations today, the honest live verdict is
`OBSERVATION_PENDING`, and G03 remains `OBSERVATION_PENDING` until real
evidence — never simulated traffic — satisfies the window.
