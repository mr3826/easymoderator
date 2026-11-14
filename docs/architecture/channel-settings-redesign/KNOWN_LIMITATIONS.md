# KNOWN_LIMITATIONS — Channel Automation Redesign

Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md). Items below are deliberate deferrals, preserved semantics, or pre-existing defects documented (not silently fixed) by this mission. Status labels: **DEFERRED** (future work), **BY DESIGN** (intentional semantics), **PRE-EXISTING** (documented, out of scope).

## Safety gates before production AUTO enablement

1. **DEFERRED — LLM confidence is hardcoded 0.9** (`EasyMod-backend/src/modules/ai/intent-router.service.js:1346-1349`; greeting fastpath 0.95, cache 1.0, order-flow 1.0 exempt). The confidence gate and the new channel/business threshold overrides are wired correctly, but any threshold ≤ 90 passes every LLM reply. **This is a blocking pre-AUTO gate**: calibrate model confidence (grounding/retrieval-derived) in a focused change before enabling AUTO for any pilot merchant. User-approved deferral (2026-11-14); recorded in the launch checklist, not merely documented.
2. **BY DESIGN — narrow-only ceiling.** A channel can never be more automated than the business default (MANUAL > DRAFT > AUTO). Per-channel AUTO under a MANUAL/DRAFT business is rejected at the API and clamped at runtime. Widening is a future launch-gated product decision (pilot envelope: DRAFT/manual, Meta Access Verification pending 2026-11-21). This mission ships plumbing, not enablement.
3. **BY DESIGN — in-flight residual race.** The provider-boundary read is a fresh committed read, not atomic with the Graph HTTP call. A stop/mode/takeover committing after the boundary read but before delivery may still deliver one message. Provider idempotency + reconciliation (ADR-0004) remain the backstop. UI copy must not overpromise ("Messages already being delivered may complete"). Same residual ADR-0003 acknowledged.
4. **BY DESIGN — human agency under stop.** Agent manual sends and draft approvals remain allowed during emergency stop (parity with MANUAL). Stop suppresses automatic AI sends, generation, and recovery/holding messages only.

## Preserved conversation semantics (documented, not changed)

5. **BY DESIGN — reopen clears hitl, preserves assignee.** New customer inbound on a closed/archived conversation reopens it (status active, hitl false, pause cleared) but keeps `assignee_id`. The 24h rolling-window model is preserved; the owner chip may show the prior assignee after reopen.
6. **BY DESIGN — manual reply pause.** A human reply sets Redis `ai:pause` (30 min) and holds pending candidates without setting hitl; AI never auto-resumes from a human reply. Explicit resume (`hitl:false`) fences pre-boundary candidates.
7. **BY DESIGN — resolve guard is conditional.** The newer-customer-message close block applies only when `last_seen_message_id` is supplied and resolvable.
8. **PRE-EXISTING (normalized) — legacy `needs_human` path.** The worker keyword-fallback handoff (`markForHumanHandoff`) is retained; this mission fixed its bypass (now sets `hitl=true`; `needs_human` added to human-owned status set). The path still writes system `handoff_reason` and a `[HANDOFF]` business message; full retirement is future work.

## Dead / legacy configuration (preserved, not presented as enforced)

9. **PRE-EXISTING — dead business settings.** `max_auto_order_value`, `ask_email`, `required_fields` are stored/validated/editable but have **no runtime consumer** (verified). Their existing business-defaults controls are preserved unchanged (no silent functionality removal); they are excluded from channel UI and must not be presented as enforced. Wiring or removing them needs an explicit product decision.
10. **DEFERRED — legacy channel columns.** `meta_channel_settings.automation_mode` / `ai_auto_reply` remain storage-only and top-level API-forbidden; `confidence_threshold_send/suggest` remain runtime-dead, API-accepted for old-client compat, GET-marked deprecated, never rendered in the new UI. Contract-phase removal (drop columns) is a future migration after a deprecation window.
11. **PRE-EXISTING — duplicate hours store.** `shops.business_hours` (default 09–22) is never enforced; only channel `business_hours` is. `businessInfo.openingHours` is prompt/knowledge text. Consolidation deferred.
12. **PRE-EXISTING — dead artifacts.** `shops.config_version` (no reader); `knowledge.updateBusinessInfo` / `updateBrandingRules` frontend clients (no UI callers); BrandingRules type uneditable; `ShopAISettings.ai_enabled/response_language` unused; unmounted `ai-chatbot.routes.js` (perimeter-pinned) incl. its dead 48h onboarding DRAFT window. Documented, not touched.

## Runtime / platform boundaries

13. **BY DESIGN — `is_active` tier is defense-in-depth.** No product path sets `shops.is_active=false`; the operative shop-level kills are subscription suspension (Guard 4c, fail-closed) and the emergency stop. Runbooks must name those, not `is_active`.
14. **PRE-EXISTING — growth-metrics cache hole.** `growth-metrics.service.js` writes `shops.settings.first_ai_reply` without `invalidateShopSettingsCaches`. Documented; not fixed here (out of scope).
15. **PRE-EXISTING — internal service tenant predicates.** `conversation-state-standalone.service.js` methods lack shop predicates (worker-internal, tenant-verified ids; unmounted HTTP router pinned by perimeter test). Channel settings service gained mandatory shop predicates in this mission; the conversation-state internal surface remains a future hardening item.
16. **PRE-EXISTING — vitest coverage thresholds unenforced in CI.** CI runs `vitest run` without `--coverage`; the 70/70/70/60 thresholds are dead configuration. Test quality is reviewed manually; enabling coverage gates is a separate CI decision.
17. **BY DESIGN — hours defect fix changes malformed-row behavior.** Timezone-incorrect and malformed hours rows now evaluate correctly / fail-closed (CLOSED) where they previously used server-local time or failed open. Documented defect fix; shape-audit query in MIGRATION_PLAN. No data transform.
18. **BY DESIGN — scope boundaries.** Web merchant app only: native mobile unchanged (ADR-0012 protected paths respected), Instagram automation unchanged, no new channel platforms, no billing/subscription edits (ADR-0011 fresh), no global retheme (scoped `.ca-scope` tokens only), single resolver abstraction (no workflow engine / new router / global state framework).

## Mission execution limits

19. **No production actions.** No deploy, no production migrations, no flag changes, no merchant enablement. Production remains on its prior commit until a separate human-gated deploy. All proofs run on disposable local stacks.
20. **Verification honesty.** Only executed tests are reported PASS (see IMPLEMENTATION_REPORT receipts). Anything not executed is labeled unverified.
