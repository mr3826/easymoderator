# ADR-0003: Business-Level AI Reply Mode

Status: Superseded by [ADR-0013](0013-channel-automation-ownership.md) (2026-11-14)<br>
Date: 2026-09-03<br>
Owners: Engineering + Product

## Context

EasyModerator supports more than one Facebook Page under a merchant business.
The legacy channel settings model also stored `automation_mode` and
`ai_auto_reply` per Page. That model created ambiguous precedence and allowed a
Page configuration or cached worker state to disagree with the merchant's
intended behavior across the business.

The active runtime now resolves AI reply mode from `shops.settings.ai` through
`getEffectiveAiReplyMode(shopId)`. Page settings remain available only for
genuinely Page-specific concerns such as business hours, confidence thresholds,
order capability, and a cosmetic purpose label. The legacy Page mode columns are
retained temporarily for migration safety and are not runtime authority.

## Decision

`shops.settings.ai.automation_mode` is the sole business-level source of truth.
The supported canonical values are `AUTO`, `DRAFT`, and `MANUAL`.

All missing, null, invalid, or unreadable values normalize to `MANUAL`. Legacy
aliases may be accepted only at controlled input boundaries and are normalized
before persistence or runtime decisions. No resolver may fall back to a Page
mode, and no Page API may write the legacy mode fields.

The Inbox consumes the business mode returned by the conversation list API and
receives mode changes through the shop-scoped SSE event. Automatic workers read
the business mode at the initial guard and again immediately before policy and
provider delivery. They also re-check current conversation/human activity so a
manual reply or HITL takeover can suppress an in-flight automatic send.

Settings mutations invalidate the shop-scoped AI settings cache and the existing
settings generation/knowledge caches. This preserves the current cache design
without introducing polling or a second mode store.

## Alternatives Considered

- **Business default plus Page override** — rejected because it preserves the
  ambiguous precedence and multi-Page drift this change is intended to remove.
- **Remove the legacy Page columns immediately** — rejected for this rollout
  because existing production rows and rollback compatibility make a staged
  deprecation safer. Runtime reads and writes are removed; schema removal is a
  follow-up migration.
- **Remove AI settings caching entirely** — rejected because it adds avoidable
  database load. Explicit tenant-scoped invalidation keeps the hot path cheap
  while making mode changes visible promptly.

## Consequences

- Positive: one merchant decision governs every connected Page, worker retry,
  Inbox view, and automatic-send decision.
- Positive: `MANUAL` is fail-closed at every boundary, reducing accidental AI
  sends when configuration or cache state is unavailable.
- Positive: Page-specific operational settings remain useful without acting as
  hidden automation overrides.
- Negative: legacy columns and aliases remain in storage/tests until their
  scheduled removal; static searches must distinguish compatibility data from
  authority.
- Negative: a final read immediately before provider delivery reduces but cannot
  make a distributed provider call fully transactional with a concurrent mode
  mutation. Provider idempotency and existing policy gates remain required.

## Verification Contract

The implementation must prove business-mode convergence across multiple Pages,
cache invalidation, Inbox/SSE propagation, `AUTO` to `MANUAL` queued-job safety,
manual/HITL suppression of in-flight AI sends, explicit draft sends, and
cross-shop authorization isolation.
