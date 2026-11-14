# ADR-0013: Channel Automation Ownership — Business Defaults, Narrow-Only Channel Overrides, Conversation Safety

Status: Accepted<br>
Date: 2026-11-14<br>
Owners: Engineering + Product<br>
Supersedes: [ADR-0003](0003-business-ai-reply-mode-source-of-truth.md)

## Context

EasyModerator has grown from a single-shop settings model into a business workspace with multiple connected Facebook Pages. The Business Information page mixed business identity with AI conversation configuration; the Channel Settings page managed connections only; reply mode was shop-global.

ADR-0003 made `shops.settings.ai.automation_mode` the sole authority and **explicitly rejected** "business default plus Page override" because the legacy implementation produced ambiguous precedence, cached worker state, and multi-Page drift. That rejection was correct for the legacy mechanism: Page mode columns were a second source of truth with no explicit resolution rules.

The verified baseline at `8d477288` (see [EXISTING_BEHAVIOR](../architecture/channel-settings-redesign/EXISTING_BEHAVIOR.md)) shows the runtime has since been hardened: fresh fail-closed mode reads at four worker checkpoints including a transactional provider-send boundary with CAS, Page-pinned conversations, exact channel routing, and complete conversation handoff mechanics (claim/force/assign/resume-boundary). What is missing is **explicit, merchant-visible ownership**: per-channel operating configuration with stated inheritance, a merchant-facing emergency stop that no channel can bypass, and conversation-level reason/owner visibility.

This ADR revisits the rejected alternative with the mechanism ADR-0003 lacked: a single resolver with explicit per-key source reporting, a narrow-only direction rule, and fresh reads at every enforcement site. It supersedes ADR-0003; it does not silently reverse it.

## Decision

### 1. Three ownership scopes

| Scope | Owns | Store |
|---|---|---|
| **Business** | Identity, knowledge, contact, social, opening-hours text; shared default automation configuration | `shops.settings.businessInfo`, `shops.settings.ai` (unchanged) |
| **Channel** (each connected Page) | Operating configuration: narrow-only automation override, confidence-threshold override, greeting override; channel-native business hours, order-creation permission, purpose label | `meta_channel_settings.overrides` (new JSONB, NULL = inherit) + existing channel-native columns |
| **Conversation** | AI pause / human takeover / assignment / resolution; handoff reason and owner | `conversations.hitl`, `assignee_id`, `status`, `metadata`, Redis `ai:pause` (unchanged mechanisms) |
| **Business-wide safety** | Emergency stop that no channel override can bypass | `shops.ai_emergency_stop` + audit columns (new, dedicated — NOT merchant-writable settings JSON) |

### 2. Overridable set (provably enforced)

Only settings with a verified enforcement path through the merged worker settings object are channel-overridable:

- `automation_mode` — **narrow-only** (§3)
- `confidence_threshold` (0–100, same scale as business)
- `greeting` `{enabled, custom_text}` (whole-block override; the fixed Meta AI-disclosure line remains code-prepended and is never overridable)

Channel-native (already independent, unchanged semantics): `business_hours` (NULL = always active), `allow_order_creation` (default true), `purpose_label` (cosmetic).

**Business-only** (displayed read-only "Inherited from business" in channel UI, never duplicated as editable channel controls): `closing`, `primary_language`, `handoff_settings`, `escalation_reply_template`, `tone_persona`, `payment_methods`, `model_preset`, `intent_confidence_map`. Rationale: these are consumed via direct shop reads in order-confirmation (`order-session-standalone.service.js` closing), intent-router (language/persona), and handoff services (cooldown/keywords); a channel override would not be enforced without rewiring those mutation-adjacent paths, which this ADR explicitly excludes.

**Correction to prior rationale:** `max_auto_order_value`, `ask_email`, `required_fields` are verified **dead** (stored/validated/editable, no runtime consumer). Their existing business-defaults controls are preserved unchanged (no silent functionality removal); they are excluded from channel UI and recorded in KNOWN_LIMITATIONS. They must not be presented as channel-enforced.

Legacy `meta_channel_settings.automation_mode` / `ai_auto_reply` columns remain storage-only and API-forbidden at top level. Legacy `confidence_threshold_send` / `confidence_threshold_suggest` remain runtime-dead; the API keeps accepting them for old-client compatibility, GET marks them deprecated, and the new UI never renders them (one live confidence control, 0–100).

### 3. Narrow-only ceiling (user-approved 2026-11-14)

Restriction order: `MANUAL > DRAFT > AUTO`. **Effective mode = most-restrictive(business default, channel override).**

- A channel override may only narrow or repeat the business default, never widen it. Business MANUAL ⇒ every channel MANUAL; business DRAFT ⇒ channels DRAFT/MANUAL; business AUTO ⇒ channels AUTO/DRAFT/MANUAL.
- PATCH rejects a widening override with `400 INVALID_OVERRIDE_WIDENING`; the UI offers only allowed options.
- The resolver **clamps at runtime** regardless of stored values: if the business default later narrows, a previously-valid stored override is clamped and surfaced with a warning (`override_clamped_by_business`). Storage is never silently rewritten.
- One merchant decision (the business default) governs enablement; channels govern restriction. This keeps the pilot envelope intact: there is no per-channel path to auto-send while the business is MANUAL/DRAFT. Widening is a future launch-gated decision, not a code path shipped here.

### 4. Runtime precedence (every automatic turn and send)

1. **Emergency stop** (`shops.ai_emergency_stop = true`) → no generation, no automatic send, no recovery/holding automatic send. `mode_source = 'emergency_stop'`. No channel override bypasses it.
2. **Shop active** (`shops.is_active = false`) → skip (`shop_inactive`). Defense-in-depth: no product path currently sets this false; the operative shop-level kills are subscription suspension (Guard 4c, fail-closed) and the emergency stop. Documented honestly in runbooks.
3. **Conversation safety** (unchanged, always fresh): `hitl`, `status` closed/archived/**needs_human**, Redis `ai:pause`, latest-human-message fence, resume boundary, consent opt-out.
4. **Effective channel configuration**: narrow-only clamped mode; override-else-default for `confidence_threshold` and `greeting`; channel-native hours/order-permission/label.
5. **Billing/subscription** (Guard 4c `isAiActive` + row-exists, fail-closed — unchanged) and **channel CONNECTED** (unchanged).
6. **Confidence/commerce policies**: effective confidence threshold (AUTO only; deterministic order-flow exempt); `allow_order_creation` re-read fresh **immediately before** order-flow/interaction mutation (Action Gate remains sole mutation authority); business hours (timezone-correct, §7) in Outbound Policy; rule order unchanged.
7. **Final send authorization**: send guard → CAS claim → Redis delivery lock → provider boundary (fresh resolver read) → evidence revalidation → provider send. [ADR-0004](0004-inbox-message-delivery-truth.md) delivery truth untouched.

Not all settings inherit identically: mode/threshold/greeting are override-else-default (mode additionally clamped); hours/order/label are channel-native with fixed defaults; business-only keys never inherit into channel writes; emergency stop and conversation state are non-inheriting layers.

### 5. Single resolver, enumerated enforcement

New `src/modules/channel-providers/channel-automation.resolver.js`:

- Pure `resolveChannelAutomation({ shopAiSettings, channelSettings, emergencyStop, shopIsActive })` → `{ mode, modeSource, effective, overrides, warnings }`. `modeSource ∈ {emergency_stop, shop_inactive, channel_override, business_default, fail_closed}`. Normalization reuses `normalizeAiReplyMode`; unknown/unreadable → MANUAL fail-closed; override values are canonicalized (no stored aliases, 0–100 threshold, bounded greeting); invalid override value → inherit + warning.
- Async `loadEffectiveChannelAutomation(shopId, channelId, { transaction, createIfMissing })`: asserts `meta_channels.shop_id === shopId` (fail-closed null otherwise); fresh `Shop.findByPk` (settings + `is_active` + emergency columns) + `MetaChannelSettings` read. **No `findOrCreate`/INSERT and no Shop row lock inside the provider-boundary transaction** (fresh committed reads; lock order remains Conversation row lock → reads). Missing shop row → retryable `SHOP_SETTINGS_UNAVAILABLE`; missing channel row at Guard 4 → `findOrCreate` defaults; missing channel row inside boundary → hold `channel_settings_unavailable`; loader error → hold, never a retry storm.

The resolver is the **sole mode authority for every send path**. Enumerated sites (each gets a test):

| Site | Anchor (8d477288) |
|---|---|
| Guard 4 early short-circuit | `message-worker.js:2103-2113` |
| Stale-candidate reuse gate | `message-worker.js:2167` |
| `mutationsAllowed` (order flow / interaction) | `message-worker.js:2392, :2452` |
| Pre-policy fresh rebuild + mode re-read | `message-worker.js:2977, :3023` |
| `getAutomaticSendGuard` | `message-worker.js:235` |
| `claimProviderSendBoundary` | `message-worker.js:731` |
| Recovery control holding path | `message-worker.js:988` |
| Human-handoff holding message | `human-handoff.service.js:312` |
| Webhook send shim | `webhook.service.js:156` |

`getEffectiveAiReplyMode` remains the **business-default reader** for display/consumer paths (admin, growth-os, shop AI settings GET) only. A static boundary test forbids its direct use in the worker/handoff/webhook send paths. `buildWorkerAiSettings` delegates to the resolver with a **whitelist merge** (explicit `DEFAULT_AI_SETTINGS` keys) — the `...shopSettings` spread hazard (unknown merchant JSON keys overriding channel `business_hours`/`allow_order_creation`) is removed and unit-tested.

Guard 4 and candidate reuse use the **effective** mode: a channel narrowed to MANUAL skips the LLM entirely (reason `manual_mode`, merchant notification preserved) and pre-override candidates are not reused.

**Honest guarantee:** the boundary read is a fresh committed read, not atomic with the provider HTTP call. A stop/mode change committing after the boundary read but before the Graph call may still deliver; provider idempotency and reconciliation remain the backstop (same residual race ADR-0003 acknowledged). The stop blocks every send that has not yet passed the boundary.

### 6. Emergency stop

- **Engage** (merchant `POST /api/shop/ai/emergency-stop`, OWNER; admin `emergency-off` delegates): ONE transaction under the Shop row lock writes `ai_emergency_stop=true` (conditional `WHERE ai_emergency_stop=false`), `ai_emergency_stop_at/by/source`, `ai_emergency_stop_prior_mode` (snapshot of the current normalized business mode; **preserved on repeat engage**) **and** calls `updateShopAiSettings(shopId, userId, { automation_mode: 'MANUAL' }, { transaction, auditRequired: true })`. The MANUAL write is the rollback-safety belt: old code rolled back over a stopped shop still sees MANUAL. Audit `AI_EMERGENCY_STOP_ENGAGED`; SSE `emergency_stop_changed`; cache invalidation via the shared helper.
- **Resume** is source-aware: merchant-source stop → OWNER may resume (`POST /api/shop/ai/emergency-resume`); admin-source stop → platform admin only (`POST /api/admin/shops/:shopId/ai/emergency-resume`); merchant resume of an admin-source stop → `403 EMERGENCY_STOP_ADMIN_SOURCE`. Resume clears the flag columns only; **mode stays MANUAL** — the owner explicitly re-chooses (UI shows the prior mode). Never enable AUTO unexpectedly. Audit `AI_EMERGENCY_STOP_RESUMED`; SSE.
- **Belt integrity while stopped:** `PUT /api/shop/ai-settings` rejects raising the business default to `AUTO` during an active stop (`409 EMERGENCY_STOP_ACTIVE`); DRAFT/MANUAL writes remain allowed. Without this, a defaults write could defeat the MANUAL rollback belt until a repeat engage.
- **Human agency preserved:** agent manual sends and draft approvals remain allowed under stop (parity with MANUAL; `draftMode.rule` bypasses `senderRole 'agent'`). Stop suppresses new draft generation at Guard 4 and all automatic sends including recovery/holding messages. UI copy must state: "Stops AI replies. Your team can still reply. Messages already being delivered may complete."
- Tests: partial-failure ordering (flag vs MANUAL atomicity), double-engage preserves prior_mode, admin-stop/merchant-resume 403, stop-vs-queued-job, stop-vs-in-flight pre-policy/boundary, holding-message suppression, agent send + draft approval succeed during stop, rollback safety (old code sees MANUAL).

### 7. Channel operating rules correctness

- `business_hours`: evaluate in `hours.timezone || Shop.timezone || 'Asia/Dhaka'` via `Intl.DateTimeFormat.formatToParts`; accept both `{mon:{open,close}}` and `{mon:[{open,close},…]}` shapes (inside if any slot matches); support overnight ranges (`close < open`); **malformed/unparseable → CLOSED (fail-closed, no auto-send)** — truth table written before code and table-driven tested (missing day, empty array/object, unparseable times, overnight, non-Dhaka timezone, DST). PATCH Joi tightened (day keys, `HH:MM`, IANA validated). Existing-row shape audit query in the migration dry-run. This is a documented defect fix: server-local `getHours()` and fail-open malformed handling were wrong.
- `allow_order_creation`: fresh channel re-read immediately before `handleOrderFlow`/`resolveInteraction` so a mid-turn disable is honored at the mutation boundary. Residual race during the mutation transaction itself is acknowledged. **Committed-mutation sends are never suppressed** (AGENT_ACTION_POLICY: post-mutation fact must reach the customer).
- Confidence gate re-check with the effective threshold at the pre-policy rebuild (last reversible point), not inside the boundary transaction (threshold is a policy preference, not an ownership signal; boundary stays minimal).

### 8. Conversation handoff hardening (no weakening)

- Manual takeover (`PATCH {hitl:true}`) records `metadata.manual_handoff_reason` (fixed list: `manual_takeover`, `customer_request`, `phone_call`, `order_issue`, `other`; default `manual_takeover`) + `manual_handoff_at/by`, merged into the single `fields.metadata` object **after** status/resume-boundary writes (no lost update). Distinct from system `handoff_reason` so `inbox-actions.service.js` classification does not mislabel merchant reasons as `HANDOFF_SUSPENDED_CHECKOUT`; queue classification distinguishes manual vs system sources.
- **Legacy `needs_human` bypass fixed:** `markForHumanHandoff` (live via worker keyword fallback) now also sets `hitl=true` (the canonical pause flag) and the worker human-owned status set includes `needs_human` as defense-in-depth. Regression test: keyword-fallback handoff pauses AI for subsequent customer messages.
- Preserved semantics (documented, not changed): manual reply pauses 30 min without hitl and never auto-resumes AI; resume fences pre-boundary candidates; resolve leaves mode unchanged and is blocked on newer customer messages only when `last_seen_message_id` is supplied; reopen on new inbound clears hitl/pause but **preserves `assignee_id`**; claim/409/force/assign rules unchanged. Takeover never writes channel configuration (pinned by test).

### 9. API, propagation, UI authority

- Channel settings PATCH: `overrides` object with `null` = revert-to-inherit; **server-side read-modify-write under row lock** (strip nulls, merge, never persist null, never wholesale-replace); double validation (Joi + resolver canonicalization); top-level `automationMode`/`aiAutoReply` remain forbidden; OWNER-only; service layer gains mandatory shop predicate. Audit `CHANNEL_AUTOMATION_OVERRIDE_CHANGED` + SSE `channel_settings_changed {channel_id, effective_mode, mode_source, override_keys}` on every write (channel settings have no cache; business caches invalidated via the shared helper).
- Effective-config reads (list/detail/settings GET) are additive and include `mode_source`, `overrides`, `warnings`, `emergency_stop`, and **`billing_ai_active`** (ADR-0011 C5: the UI must not present AUTO as effective while billing is overdue; badge shows PAUSED-billing).
- Business defaults API (`PUT /api/shop/ai-settings`) unchanged — structurally cannot clobber channel overrides (different table). Old clients keep working.
- Client write controls (overrides, defaults, stop) gated on **OWNER role**, matching server `requireOwner` (the client RBAC matrix's MANAGER `WRITE_SETTINGS` does not apply to these surfaces); manager/staff read-only. Server remains authority.
- Merchant-facing capability copy obeys ADR-0011: Claim registry (`claims.ai.*`, truthful fallback while `production_verified=false`), no forbidden tokens, `claims.*` keys in en+bn, `verify:claims` green.
- Redesigned surfaces use scoped Midnight/Violet/Sunlight semantic tokens (`.ca-scope`); no global retheme.

### 10. Migration

Expand-only: `20261114_004_channel_automation_overrides.js` (nullable JSONB `overrides`) + `20261114_005_shop_ai_emergency_stop.js` (5 additive columns, `ai_emergency_stop BOOLEAN NOT NULL DEFAULT FALSE`). No backfill, no data transform, no row writes; existing channels inherit (NULL) → byte-identical behavior; nothing enables AUTO. Down drops the columns; stopped shops remain MANUAL under old code. Legacy-column contract removal deferred to a future migration. See [MIGRATION_PLAN](../architecture/channel-settings-redesign/MIGRATION_PLAN.md).

## Alternatives Considered

- **Full per-channel independence (widening allowed)** — rejected (user decision 2026-11-14): creates a per-channel auto-send enablement path during the pilot envelope (DRAFT/manual, Meta Access Verification pending) while the business screen says MANUAL. Narrow-only preserves one enablement decision.
- **Revive legacy Page mode/threshold columns as the override mechanism** — rejected: NOT NULL defaults (0.75/0.50, MANUAL) make "merchant chose" indistinguishable from "default"; ENUM lacks AUTO; would silently enforce overrides on every existing channel.
- **New channel-overrides table** — rejected: needless join/abstraction for a 1:1 row.
- **Emergency stop as `settings.ai` JSON key** — rejected: merchant-writable JSON is merged/preserved by general writers (`POST /shop/update`); a safety flag must be outside that surface, audited, and readable in the resolver's existing Shop read.
- **Auto-restore prior mode on resume** — rejected: never enable AUTO unexpectedly; explicit owner re-choice required.
- **Override all `settings.ai` keys per channel** — rejected: partial enforcement (closing/language/handoff read shop directly) would create silent lies; overridable set limited to provably enforced keys.
- **Confidence re-check inside the boundary transaction** — rejected: lengthens the row lock for a policy preference; pre-policy re-check is the last reversible point.
- **Global app retheme** — rejected: 30+ suite regression surface; scoped tokens satisfy the brand direction.

## Consequences

- Positive: explicit per-key ownership with visible source (inherited/overridden/clamped/stopped); one resolver, enumerated enforcement, fresh reads; merchant-facing bypass-proof stop; channel isolation provable end-to-end; conversation reasons/owner visible; legacy drift mechanism stays dead.
- Positive: expand-only migration; old clients and old code rollback-safe; pilot envelope preserved (plumbing, not enablement).
- Negative: narrow-only means a channel cannot be more automated than the business default — a real product limitation, stated here, revisitable only via a launch-gated decision.
- Negative: business-only settings appear read-only in channel UI; merchants must edit them at business scope (edit links provided).
- Negative: dead settings (`max_auto_order_value`, `ask_email`, `required_fields`, legacy thresholds) remain stored/editable at business scope pending a separate cleanup decision; documented, not presented as channel-enforced.
- Negative: the in-flight provider-call residual race remains (acknowledged, same as ADR-0003); stop copy must not overpromise.
- Negative: hours fail-closed malformed handling changes behavior for malformed rows (documented defect fix; shape audit provided).

## Verification Contract

The implementation must prove (see [TEST_STRATEGY](../architecture/channel-settings-redesign/TEST_STRATEGY.md)):

1. Channel isolation: A AUTO-override vs B DRAFT-override under business AUTO; changing A never changes B; revert restores inheritance; business-default change propagates only to inheriting channels; **widening rejected at API and clamped at runtime**.
2. Conversation isolation: takeover pauses only that conversation; resume/resolve never write channel config; reason/owner recorded; legacy `needs_human` path pauses AI.
3. Emergency stop: overrides every channel; queued and pre-policy/in-flight jobs held; holding messages suppressed; resume keeps MANUAL; admin-source resume authority; agent sends + draft approvals unaffected; rollback safety.
4. Queue races: real-Redis mode-flip and stop-flip mid-queue; late pause; spread-hazard unit; order-permission fresh re-read before mutation; no duplicate replies.
5. Tenant isolation: cross-shop channel settings/list/detail/effective fields denied at controller AND service/loader; staff/manager write 403; old-client defaults writes cannot clobber overrides.
6. Migration: idempotent up/down round-trip on prod-shaped data; NULL invariance; verification queries; dry-run green.
7. Frontend: Business Profile has no AI controls; overview/detail effective badges (incl. billing-paused, clamped, stopped); override/revert UI; owner chips + reason labels; 360/390 widths; axe; Claim-registry copy compliance.
8. Every enumerated enforcement site consults the resolver; static boundary test pins no direct business-mode reads in send paths.
