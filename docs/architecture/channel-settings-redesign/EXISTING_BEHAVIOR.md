# EXISTING_BEHAVIOR — verified current system

Mission: Business / Channel / Conversation ownership redesign.
Evidence baseline: `8d477288594ce522d4c27a5cc8ed09bd8747456f` (`feat(commercial): Truth Gate + delivered-order billing (BDT 10/delivered order) (#256)`).
Companion: [BASELINE.md](BASELINE.md) records repository state, frameworks, environments and the original mission assumptions. This document records **what the code actually does**, with file:line anchors at `8d477288`.

> **Runtime caveat for every behavioural statement below.** Production has 0 messages and 0 orders and has never run the lifecycle ([BASELINE.md](BASELINE.md), "Known environmental / production constraints"). Every enforcement/flow statement is code-verified at `8d477288`; none is observed production behaviour. Latent defects are labelled as such.

## Status key

| Status | Meaning |
|---|---|
| **VERIFIED** | Confirmed by code read and adversarial re-verification at `8d477288`; quoted anchors exist. |
| **PARTIALLY VERIFIED** | The core is real but a stated qualifier, scope, or guarantee is wrong/incomplete. |
| **NOT IMPLEMENTED** | No code exists for the capability in the 3-scope model. |
| **UNKNOWN** | Not determinable from code (typically data-shape or production-state questions). |
| **CONFLICTING** | Code, comment, test, and/or documentation disagree; both readings are quoted. |

---

## 1. Methodology

Three independent Explore agents mapped the system at `c8ce4a84` (frontend surface; backend runtime; tests/CI pins). The mission lead spot-checked load-bearing anchors. A seven-agent adversarial workflow then re-verified the corpus at `8d477288` after PR #256 moved `origin/main`:

- five area verifiers — `worker-boundary`, `channel-ownership`, `handoff-lifecycle`, `safety-tenant`, `frontend-pins`;
- one gap-filler answering 10 open questions;
- The Fool (18 assumptions challenged, one sev-critical verdict worked through a pre-mortem).

Result corpus: **53 findings** — 42 verifier findings + 11 gap findings.

| Verdict | Count | Notes |
|---|---:|---|
| CONFIRMED | 42 | Many carry precision notes that narrow the original claim without refuting it. |
| CORRECTED | 10 | Claim was materially wrong or incompletely scoped; correction recorded in §9. |
| REFUTED | 1 | Vitest coverage is configured but never enforced in CI (gap 6, §9). |

Every anchor below is at `8d477288`. Statements sourced from the workflow use its quoted anchors; statements marked "lead-confirmed" were additionally read directly for this document. No test was run and no mutation was performed to produce this evidence.

---

## 2. Business Profile surface

**What is business-wide.** One `shops` row owns all durable business configuration: `shops.settings.businessInfo` (identity/contact/social/hours text) and `shops.settings.ai` (automation and conversation behaviour). Every connected Page and every conversation in the shop reads these values; there is no per-channel or per-conversation copy of them. `shops.settings.ai.automation_mode` is the **sole business-level reply-mode authority** ([ADR-0003](../../adr/0003-business-ai-reply-mode-source-of-truth.md)), and `getEffectiveAiReplyMode(shopId)` is its only read helper ([ai-reply-mode.js](../../../EasyMod-backend/src/modules/shop/ai-reply-mode.js), `:39-48`).

**What the merchant sees.** One page renders identity and AI behaviour together: [BusinessInfoSettings.tsx](../../../EasyMod-frontend/src/app/components/BusinessInfoSettings.tsx), `:8-9` imports both forms and `:68-80` renders `<BusinessInfoForm>` then `<AISettingsForm>`. Saves go to `PUT /api/shop/business-info` and `PUT /api/shop/ai-settings` ([shop.ts](../../../EasyMod-frontend/src/api/domains/shop.ts):28-40; [BusinessInfoSettings.tsx](../../../EasyMod-frontend/src/app/components/BusinessInfoSettings.tsx):53-61).

**Category view.** *Business-wide:* identity/contact/social fields plus the whole `settings.ai` object (one row per shop, all Pages). *AI-used:* `automation_mode` (pipeline gate), `confidence_threshold` (AUTO gate), `greeting`/`closing` (outbound composition), `primary_language`/`tone_persona` (LLM prompt), `handoff_settings` (escalation), `model_preset` (sentiment routing), `escalation_reply_template`. *Customer-facing:* shop name/phone/address/opening-hours text and social links surface in AI answers; greeting/closing surface in outbound messages. *Duplicated:* confidence threshold and business hours each have a channel-side shadow (below), and reply mode has two dead legacy channel columns.

### Field inventory

| Group | Field | Writer / endpoint | Runtime consumer | Status |
|---|---|---|---|---|
| Identity | `shopName`, `phone`, `address`, `openingHours`, `additionalInfo` (≤3000), `socialLinks` (only `facebook`, `website` editable) | `PUT /api/shop/business-info` (OWNER) | AI prompt/knowledge text; openingHours text is **not** an outbound-policy input | VERIFIED |
| AI mode | `automation_mode` (`AUTO`/`DRAFT`/`MANUAL`; legacy aliases normalized) | `PUT /api/shop/ai-settings` (OWNER) and admin `emergency-off` only; both through `updateShopAiSettings` | Guard 4, recovery control, pre-policy re-read, send guard, provider boundary; display consumers | VERIFIED |
| Confidence | `confidence_threshold` (0–100) | `PUT /api/shop/ai-settings` (OWNER) | `shouldHoldForLowConfidence` in AUTO only | VERIFIED |
| Compatibility | `auto_reply_enabled` | derived on every read/write from `automation_mode`; never authority | none (compatibility data) | VERIFIED (derived) |
| Conversation copy | `greeting` `{enabled, custom_text}`, `closing` `{enabled, custom_text}` | `PUT /api/shop/ai-settings` (OWNER) | greeting/closing builders in AI messaging; closing also read directly by order-session code | VERIFIED |
| Language/persona | `primary_language`, `tone_persona`, `model_preset`, `intent_confidence_map`, `payment_methods` | `PUT /api/shop/ai-settings` (OWNER) | intent-router prompt, sentiment preset gating, intent thresholds, operating context | VERIFIED |
| Handoff | `handoff_settings` (`trigger_keywords`, `notification_channel`, `cooldown_minutes`), `escalation_reply_template` | `PUT /api/shop/ai-settings` (OWNER) | human-handoff cooldown/dedupe; escalation copy | VERIFIED |
| Dead AI fields | `max_auto_order_value`, `ask_email`, `required_fields` | `PUT /api/shop/ai-settings` (OWNER) | **none** — only defaults, validator, controller whitelist, service deep-merge, subscription-plan copy | VERIFIED DEAD |
| Also dead | `auto_send_enabled`, `auto_send_confidence_threshold` | exist only in `DEFAULT_AI_SETTINGS`; not in `AI_SETTINGS_SCHEMA`, no reader | none | VERIFIED DEAD (lead-confirmed) |

Dead-field corroboration: [shop-defaults.js](../../../EasyMod-backend/src/modules/shop/shop-defaults.js):16-66 defines the values; [shop-settings.validator.js](../../../EasyMod-backend/src/modules/shop/shop-settings.validator.js):45-74 validates them; [shop.controller.js](../../../EasyMod-backend/src/modules/shop/shop.controller.js):430-478 whitelists them; [shop.service.js](../../../EasyMod-backend/src/modules/shop/shop.service.js):696-697 deep-merges `required_fields`. A repo-wide grep outside those files, `subscription.plans.js` and tests finds no consumer.

**48h onboarding DRAFT window — dead code.** [ai-chatbot.controller.js](../../../EasyMod-backend/src/modules/conversation/ai-chatbot.controller.js):288-296 would upgrade a shop younger than 48h to `DRAFT`; the rule is reachable only from the unmounted HTTP `processMessage` handler. The live worker calls `processNewIntent` (`message-worker.js:2551`) which never receives `shop_created_at`. The dead rule is also **fail-open** relative to today's defaults: new shops normalize to `MANUAL`, and the rule would add auto-drafting. Status: VERIFIED DEAD CODE.

**Duplication that matters.**

| Business value | Duplicate / shadow | State |
|---|---|---|
| `confidence_threshold` 0–100 (enforced) | `meta_channel_settings.confidence_threshold_send/suggest` 0–1 | stored/serialized/plumbed, **never read** |
| Channel `business_hours` (enforced in policy) | `shops.business_hours` JSON column | column exists, **never read** by outbound policy |
| `automation_mode` | legacy `meta_channel_settings.automation_mode` + `ai_auto_reply` | API-forbidden, runtime-excluded, **dead** |
| AI behaviour UI | mounted on the Business Information page beside identity | UX conflation, not a data duplication |

Status: VERIFIED.

---

## 3. Channel configuration (`meta_channel_settings`)

One row per connected Page: `channel_id` is the primary key and FK to `meta_channels(id)` (1:1) ([meta-channel-settings.entity.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel-settings.entity.js):14-19; initial schema migration `20260520_000_initial_schema.js:1000-1006`). The channel lease/status/Page identity live on `meta_channels`; only operating defaults live here.

| Field | Column / default | Writer | Runtime reader | Status |
|---|---|---|---|---|
| Reply mode (legacy) | `automation_mode` ENUM, default `MANUAL`, marked "Legacy compatibility field" | none (Joi `forbidden()`; controller defense) | none | VERIFIED DEAD |
| Legacy AI switch | `ai_auto_reply` BOOL, default **true** | none (forbidden) | none | VERIFIED DEAD |
| Send threshold | `confidence_threshold_send` DECIMAL(3,2) default `0.75` | `PATCH /api/channels/meta/:id/settings` (OWNER), accepted | copied into worker `aiSettings` at `message-worker.js:435`, never read | VERIFIED DEAD DATA |
| Suggest threshold | `confidence_threshold_suggest` DECIMAL(3,2) default `0.50` | same | same | VERIFIED DEAD DATA |
| Business hours | `business_hours` JSONB, default NULL (= always active) | same PATCH | [businessHours.rule.js](../../../EasyMod-backend/src/modules/policy/rules/businessHours.rule.js) via policy engine | PARTIALLY VERIFIED — enforced but defective (§3.1) |
| Order permission | `allow_order_creation` BOOL, default **true** | same PATCH | `mutationsAllowed` at `message-worker.js:2392-2393`, `:2452-2453` → Action Gate | PARTIALLY VERIFIED — enforced at mutation, snapshot-only at send (§4) |
| Purpose label | `purpose_label` VARCHAR(64), default NULL | `PATCH .../settings` (OWNER) **and** `PATCH .../purpose-label` (**no owner gate**) | serializer, channel list, conversation list/detail joins; also copied into runtime policy settings | VERIFIED — display-only but leaks into runtime settings |

### 3.1 `business_hours` is enforced but wrong in three independent ways

- **Server-local clock.** `businessHours.rule.js:46` uses `now.getHours()/getMinutes()`; the documented `timezone: 'Asia/Dhaka'` field (`:12-18`) is never read. `Shop.timezone` also exists ([shop.entity.js](../../../EasyMod-backend/src/modules/shop/shop.entity.js):36) but is not consulted by the rule.
- **Shape contradiction.** The entity comment documents `{ mon: [{open, close}] }` (array) ([meta-channel-settings.entity.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel-settings.entity.js):49-55), while the rule expects a single object `{ mon: {open, close} }` (`:41-44`). An array-shaped row therefore behaves as **always open**.
- **Fail-open malformed input.** Unparseable `open`/`close` returns `true` (`:45`), i.e. inside hours, so AUTO continues sending; a missing day key returns `false` (closed).
- Overnight ranges (`close < open`) are unimplemented and evaluate as closed.

Existing tests ([businessHours.rule.test.js](../../../EasyMod-backend/src/modules/policy/__tests__/businessHours.rule.test.js):8-44) pin only the mode mapping (AUTO/`AI_ACTIVE` downgrade to `SUGGEST_ONLY`; DRAFT/MANUAL do not), using `{}` as "outside hours". No timezone, array-shape, malformed, overnight or DST coverage.

Status: PARTIALLY VERIFIED. Production row shapes: **UNKNOWN** (0 runtime messages; no data audit performed).

### 3.2 Ownership/write-surface facts

- **GET has a write side effect.** `GET /settings` calls `getSettings(channelId)` → `MetaChannelSettings.findOrCreate({where:{channel_id}, defaults:{channel_id}})` ([meta-channel.service.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel.service.js):545-551). A read creates a default row.
- **OAuth creates the default row too.** `upsertFromOAuth` does `findOrCreate` inside the connect transaction (`meta-channel.service.js:196-203`), materializing defaults `ai_auto_reply=true`, `allow_order_creation=true`, `automation_mode='MANUAL'`, thresholds `0.75/0.50`. Fail-open defaults for a new channel.
- **Only two mutation endpoints.** `PATCH /:channelId/settings` and `PATCH /:channelId/purpose-label` ([meta-channel.routes.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel.routes.js):102-113). Admin reconnect mutates status only; disconnect/test-webhook mutate channel row fields; no other settings writer exists.
- **Legacy columns are refused.** `unsupportedPageSetting = Joi.any().forbidden()` rejects `automationMode`, `aiAutoReply`, `automation_mode`, `ai_auto_reply` with a stable 400 message ([meta-channel.routes.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel.routes.js):33-41, `:56-66`); [meta-channel.controller.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel.controller.js):186-202 repeats the rejection, and [settings-contract.test.js](../../../EasyMod-backend/src/modules/channel-providers/__tests__/meta-channel.settings-contract.test.js):76-101 pins it.
- **Purpose-label permission asymmetry.** `PATCH /settings` runs `requireOwner`; `PATCH /purpose-label` does not (`meta-channel.routes.js:102-113`). Any active member can rewrite a channel label.
- **Service layer has no tenant predicate.** `getSettings(channelId)` / `updateSettings(channelId, patch)` take no `shopId` and never join `meta_channels.shop_id` (`meta-channel.service.js:545-582`). The only boundary is the controller assertion `assertChannelBelongsToShop` ([meta-channel.controller.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel.controller.js):29-34), used for settings reads/writes. Status: VERIFIED (controller-only defense).
- **No audit/SSE on channel writes.** `updateSettings` only calls `logger.info` (`:580-581`). The business mode write emits `AI_REPLY_MODE_CHANGED` audit + `ai_reply_mode_changed` SSE (`shop.service.js:736-775`); channel writes have no equivalent.
- **Runtime whitelist is five keys.** `RUNTIME_CHANNEL_SETTING_KEYS` = `business_hours`, `confidence_threshold_send`, `confidence_threshold_suggest`, `allow_order_creation`, `purpose_label` ([meta-channel-settings.runtime.js](../../../EasyMod-backend/src/modules/channel-providers/meta-channel-settings.runtime.js):5-11). `purpose_label` is documented display-only in the entity but is still passed into policy `settings` (`runtime.js:10`, `message-worker.js:438`).

### 3.3 Inbound settings injection (verified hazard)

The general shop write surface merges arbitrary nested `settings.ai` keys. `POST /api/shop/update` (OWNER) [shop.controller.js](../../../EasyMod-backend/src/modules/shop/shop.controller.js):212-224 passes raw body to `updateShopById`; [shop.service.js](../../../EasyMod-backend/src/modules/shop/shop.service.js):681-695 spreads `normalizedUpdates` into `settings.ai`; the validator rejects unknown **values** but not unknown **keys** (`shop-settings.validator.js:102-121`, `:263-285`). `stripAutomationModeFromShopUpdate` removes only `automation_mode` (`shop-settings.validator.js:310-325`). Consequently a merchant-writable `settings.ai.business_hours` or `settings.ai.allow_order_creation` can override the channel value in `buildWorkerAiSettings` because those five channel keys are assigned before `...shopSettings` (`message-worker.js:433-441`). `automation_mode` is assigned **after** the spread, so it is not overridable this way. Status: VERIFIED (channel-native keys except mode).

---

## 4. Runtime configuration flow

### 4.1 Ordered checkpoints on the automatic path

| # | Checkpoint | Anchor | What is read / decided |
|---|---|---|---|
| 1 | Conversation tenant load | `message-worker.js:2078-2081` | `Conversation.findOne({id, shop_id})`; mismatch → skip |
| 2 | Guard 2 — conversation state | `message-worker.js:2093-2097` | `hitl === true` → `hitl_active`; `status` in `closed`/`archived` → skipped. **No other status is human-owned.** |
| 3 | Guard 3 — manual-reply pause | `message-worker.js:2099-2101` | Redis `ai:pause:{conversationId}` → skip `ai_paused` |
| 4 | Guard 4 — mode gate | `message-worker.js:2103-2121` | Fresh `getShopAISettings(shopId)` + `getChannelAISettings(jobChannel)`; `normalizeAiReplyMode`; `buildWorkerAiSettings`; `businessMode === MANUAL` → merchant notification + skip |
| 5 | Stale-candidate reuse gate | `message-worker.js:2167` | Reuse only when `isAutoSendMode(businessMode)` and prior claim not attempted/expired |
| 6 | Guard 4c — billing | `message-worker.js:2199-2220` | `Subscription.findOne` + `isAiActive`; paused statuses → skip |
| 7 | Guard 4d — allowance | `message-worker.js:2229-2232`, `:1883-1885` | `resolveAllowanceDecision` = `Boolean(subscription)`; missing row → skip `subscription_missing` (**fail-closed**) |
| 8 | Mutation permission | `message-worker.js:2392-2393`, `:2452-2453` | `mutationsAllowed = isAutoSendMode(businessMode) && channelAISettings.allow_order_creation !== false` |
| 9 | Confidence gate | `message-worker.js:2818-2830`; [confidence-gate.service.js](../../../EasyMod-backend/src/modules/ai/confidence-gate.service.js):54-70 | AUTO only; shop-level `confidence_threshold`; order-flow turns exempt (confidence 1.0); LLM output carries hardcoded `0.9` (`intent-router.service.js:1346-1349`) |
| 10 | Channel settings rebuild | `message-worker.js:2961-2977` | Fresh channel settings, but the rebuilt object still carries the Guard-4 `businessMode` |
| 11 | Post-generation mode re-read | `message-worker.js:3023-3024` | Fresh business mode; not AUTO → store HELD/DRAFT and return (no send) |
| 12 | Policy evaluation | `message-worker.js:3060`; policy engine | `automation_mode` overwritten with the fresh mode (`:3059-3062`) |
| 13 | Send guard | `message-worker.js:3144` → `:233-235` | `getAutomaticSendGuard(shopId, conversationId)` does another fresh `getEffectiveAiReplyMode` |
| 14 | Provider boundary + CAS | `message-worker.js:702-812` | See §4.2 |
| 15 | Provider send | provider adapter | Irreversible side effect |

### 4.2 `claimProviderSendBoundary` — ordered re-checks and CAS

Inside one transaction that locks the Conversation (and related customer row), the boundary re-checks in this order:

1. `:714` conversation present;
2. `:715` `conversation.hitl === true` → `human_active`;
3. `:716-718` `closed`/`archived` → `conversation_closed`;
4. `:719-725` resume-boundary validity + candidate start timestamp;
5. `:726-730` candidate before boundary → `resume_obsolete`;
6. `:731-734` fresh mode → `mode_changed`;
7. `:735-737` Redis `ai:pause:{id}` → `ai_paused`;
8. `:739-758` latest business message vs latest customer message (`>=` → `human_active`);
9. `:760-770` customer `messaging_consent = opted_out` → `opted_out`;
10. `:781-803` conditional `Message.update` CAS requiring `provider_send_claimed = 'true'`, `provider_send_attempted IS DISTINCT FROM 'true'`, `delivery_state = SEND_PENDING`, `provider_message_id IS NULL`, plus idempotency key. `provider_send_claimed` was set earlier by `claimAutomaticCandidate` (`:589-597`).

**Corrected freshness fact.** The mode query at `:731` is invoked inside the transaction callback, but `getEffectiveAiReplyMode(shopId)` accepts no transaction handle: the `Shop.findByPk` inside it runs on a **separate connection** as a fresh committed read, not as part of the transaction snapshot ([shop.service.js](../../../EasyMod-backend/src/modules/shop/shop.service.js):633-656). The transaction covers the conversation/customer locks and the CAS update only. Status: VERIFIED (precision correction).

### 4.3 The recovery and human-handoff send paths differ

| Path | Fresh mode | Outbound policy | Send guard | Redis pause | Latest human vs customer | CAS |
|---|---|---|---|---|---|---|
| Worker recovery control (`createRecoveryControl`, `message-worker.js:852+`) | `:988-1000` | `:1004` decision block / `:1033` call | `:1117` | no | no | own claim (`:97-122`, `:357`) |
| `human-handoff.service.js` holding message | `:302-313` | `:325-346` | **no** — file never imports/calls `getAutomaticSendGuard` | no | no | own conditional-update claim (`:97-122`, `:357`) |
| Webhook send shim | `webhook.service.js:156` | yes | no | no | no | no |

`human-handoff.service.js` does re-read `hitl`/`status` (`:239-253`) and re-runs its own CAS, but the **full mode + policy + send-guard triple lives in the worker's recovery control**, not in human-handoff. Status: CORRECTED (original claim attributed the triple to human-handoff).

### 4.4 Corrected facts that must not be re-derived incorrectly

1. **Empty `shops.settings.ai` does not throw.** `getShopAiSettings` always merges `DEFAULT_AI_SETTINGS` (which includes `automation_mode: MANUAL`) ([shop.service.js](../../../EasyMod-backend/src/modules/shop/shop.service.js):641-656; [shop-defaults.js](../../../EasyMod-backend/src/modules/shop/shop-defaults.js):16-66). A retryable `SHOP_SETTINGS_UNAVAILABLE` occurs only when the **shop row** or its settings are unreadable (`message-worker.js:216-230`, `:428-431`; `asRetryableDependencyError` at `:102-109`). Status: CORRECTED.
2. **Missing subscription fails CLOSED.** `subscription.access.js:28-31` returns `true` for a missing row (`isAiActive` fails open), but the immediately following `resolveAllowanceDecision({subscription})` returns `Boolean(subscription)` = `false` (`message-worker.js:2229-2232`, `:1883-1885`), skipping with `subscription_missing`. The test `message-worker.billing-pause.test.js:205-208` asserts this. The comment at `message-worker.js:2201-2202` still says "Fails open" — a **stale comment contradicted by code and test**. Status: CONFLICTING (comment vs code/test); behaviour is fail-closed.
3. **Alias mapping.** `AI_ACTIVE→AUTO`, `AI_SUGGEST_ONLY→DRAFT`, `HUMAN_ACTIVE→MANUAL`; unknown/blank → `MANUAL` ([ai-reply-mode.js](../../../EasyMod-backend/src/modules/shop/ai-reply-mode.js):13-37). Status: VERIFIED.
4. **Only `automation_mode` is re-read at the boundary.** `allow_order_creation`, `business_hours` and both confidence thresholds are snapshotted from the job-start (and partially rebuilt at `:2977`, which is **after** the order mutation). A mid-turn disable does not stop a mutation already past those checks. Status: PARTIALLY VERIFIED.
5. **Draft approval is a human path independent of mode.** `approveAiDraft` opens a transaction, locks Conversation + candidate, writes `DRAFT_APPROVAL`/`SEND_PENDING`, and creates an `InboxDeliveryOutbox` row in the same transaction ([conversation.service.js](../../../EasyMod-backend/src/modules/conversation/conversation.service.js):1058-1164). The reconciler leases with a processing-token CAS (`inbox-delivery-reconciler.job.js:77-89`). There is no reply-mode gate in the method. Status: VERIFIED.
6. **Confidence is not re-checked at the boundary.** `claimProviderSendBoundary` has no confidence/threshold read. The only enforcement point is the pre-policy gate. Status: VERIFIED.

---

## 5. Conversation handoff lifecycle

### 5.1 State model as implemented

| Layer | Mechanism | Anchor | Status |
|---|---|---|---|
| Human pause | `conversations.hitl` BOOL default false — the canonical "AI paused, human handling" flag | [conversation.entity.js](../../../EasyMod-backend/src/modules/conversation/conversation.entity.js):73-77 | VERIFIED |
| Owner | `assignee_id` UUID (member of the JWT shop) | entity `:78-81`; membership check `conversation.service.js:1485-1501` | VERIFIED |
| Lifecycle status | `status` STRING default `active`; transitions `active`/`closed`/`archived` | entity `:40-44`; reopen `meta-webhook-events.handler.js:1100-1117` | VERIFIED |
| Resolution | `resolution_note`, `resolved_at` | entity `:82-89` | VERIFIED |
| Resume fence | `metadata.ai_resume_boundary_at` | `message-lifecycle.js:26`; set `conversation.service.js:1519-1549` | VERIFIED |
| System reason | `metadata.handoff_reason` + `handoff_at` | [human-handoff.service.js](../../../EasyMod-backend/src/modules/conversation/human-handoff.service.js):172-182 | VERIFIED |
| Legacy reason | `metadata.handoff_reason` + `handoff_timestamp` + `handoff_metadata` | [conversation-state-standalone.service.js](../../../EasyMod-backend/src/modules/conversation/conversation-state-standalone.service.js):431-439 | VERIFIED |
| Manual reason | `metadata.manual_handoff_reason(+at/by)` | — | NOT IMPLEMENTED |
| Short pause | Redis `ai:pause:{conversationId}`, TTL 1800s | conversation.controller.js:47, `:1010`; mobile `:144` | VERIFIED |

Legacy DB columns `hitl_active`, `hitl_reason`, `hitl_started_at`, `hitl_ended_at`, `resolved_by` exist only in the initial migration and have no writers (VERIFIED orphan). `bulkUpdateStatus` still accepts `unanswered`/`pending_order`/`completed`/`followed_up` (`conversation.service.js:1742-1749`), and the squash default is `open` while the entity default is `active` — heterogeneous vocabulary (VERIFIED).

### 5.2 Transitions

| Transition | Behaviour | Evidence | Status |
|---|---|---|---|
| Take over `PATCH {hitl:true}` | Assigns actor when `assignee_id` omitted; another agent's open handoff → 409 `HUMAN_TAKEOVER_CONFLICT`; resolving another's handoff → 409; owner/admin may force (staff `force` inert); assignee must be active member; un-attempted AI candidates HELD `human_active`; SSE `hitl_changed`; audit `CONVERSATION_OWNERSHIP_UPDATE`; **no handoff reason written** | `conversation.service.js:1462-1501`, `:1550-1605`, `:1703-1714` | VERIFIED (nuance: owner/admin overwrite assignee; privileged bypass needs no `force`) |
| Manual human reply | Stores sender `business`; holds pending candidates; `ai:pause` 1800s; holds delivery lock; **does not set `hitl`**; never auto-resumes | `conversation.controller.js:965-1036`, `:992-1017`; `conversation.service.js:995-1043`, `:1340-1407` | VERIFIED (only for non-replay agent/business sends) |
| Resume `{hitl:false}` | Sets `ai_resume_boundary_at` (now only if previously hitl or no valid boundary); dismisses pre-boundary candidates `resume_obsolete`; clears `ai:pause`; worker/store reject pre-boundary candidates | `conversation.service.js:1454`, `:1519-1549`, `:1594-1637`; `conversation.controller.js:1250-1251`; `message-worker.js:610-621`, `:728`, `:904`, `:1105`, `:1502` | VERIFIED |
| Resolve `status:closed` | `hitl=false`; `resolved_at` only if previously null; `resolution_note`; mode unchanged; sets a new resume boundary; **newer-customer guard runs only when `last_seen_message_id` is supplied** | `conversation.service.js:1425-1453`, `:1527-1556` | VERIFIED (conditional guard) |
| Reopen on new inbound | `status=active`, `hitl=false`, resolve fields cleared, `ai:pause` deleted — **`assignee_id` is preserved** | [meta-webhook-events.handler.js](../../../EasyMod-backend/src/modules/integration/meta-webhook-events.handler.js):1100-1117 | VERIFIED (ownership does not survive as pause, but the assignee does) |
| System escalation | `requireHumanRecovery` → `turn-recovery.service.requireHuman`: one transaction sets `hitl:true` + `HUMAN_REQUIRED` turn; then sends a holding message through policy + claim + provider and notifies merchant with shop-level cooldown dedupe | `message-worker.js:1355-1381`; `turn-recovery.service.js:214-270`; `human-handoff.service.js:185-203`, `:337-369` | VERIFIED (non-transactional second hitl write possible at `human-handoff.service.js:172-182`; test-only fallback at `message-worker.js:1392-1395`) |

### 5.3 LIVE `needs_human` path — AI handoff bypass (D20)

The unmounted HTTP `POST /ai-chatbot/process` is not the only way to reach the legacy service. The live worker path is:

1. `message-worker.js:2551` calls `AIChatbotController.processNewIntent` for every non-order-flow inbound.
2. `processNewIntent` runs keyword detection for order modification/return intents (`ai-chatbot.controller.js:637-649`: `change`, `modify`, `update`, `edit`, `address change`, `return`, `refund`, `cancel`, plus Bangla equivalents). On a hit it calls `escalateToHumanAgent` (`:481-492`).
3. `escalateToHumanAgent` creates a ticket and calls `ConversationStateService.markForHumanHandoff` (`:699`).
4. `markForHumanHandoff` writes `status: 'needs_human'` and `metadata.handoff_reason/handoff_timestamp/handoff_metadata` **without setting `hitl`** ([conversation-state-standalone.service.js](../../../EasyMod-backend/src/modules/conversation/conversation-state-standalone.service.js):426-458, status at `:433`).
5. On the next customer message, Guard 2 checks only `hitl` and `closed`/`archived` (`message-worker.js:2093-2097`); the webhook reopen only handles `closed`/`archived` (`meta-webhook-events.handler.js:1100`). `needs_human` is read nowhere else in non-test code (repo grep: only the writer at `:433` and its return at `:452`).

**Therefore** a conversation marked for human review by this keyword path has no durable AI pause: the AI can resume on the next customer message while the queue says a human is needed. This is a verified code defect. Realization in production today is **zero** because the pilot runs MANUAL and prod has 0 messages; it is latent, not live. Status: VERIFIED DEFECT (latent). See §12 for the mission fix.

### 5.4 `handoff_reason` collision

`metadata.handoff_reason` is written by two systems with different vocabularies: system escalation (`human-handoff.service.js:179`, e.g. `low_confidence`/`sentiment_*`/`human_required`) and the legacy `needs_human` path (`conversation-state-standalone.service.js:436`). The inbox action queue treats **any** `handoff_reason` on an active hitl conversation as a suspended checkout: [inbox-actions.service.js](../../../EasyMod-backend/src/modules/inbox/inbox-actions.service.js):54-56 sets `reason_code = HANDOFF_SUSPENDED_CHECKOUT` whenever `metadata.handoff_reason` is truthy, else `HITL_REQUIRED`. Any merchant-selected reason stored in that key would therefore be mislabeled. Status: VERIFIED (mislabel exists today for system reasons and would multiply).

### 5.5 Frontend/backend handoff type mismatch

Backend Joi accepts `force` (`conversation.validator.js:99-103`); the frontend `updateConversation` TS type omits it ([conversation.ts](../../../EasyMod-frontend/src/api/domains/conversation.ts):154-169) while [CustomerContextPanel.tsx](../../../EasyMod-frontend/src/app/components/inbox/CustomerContextPanel.tsx):493-497 sends it. Runtime works; the type is incomplete. Status: VERIFIED.

---

## 6. Safety & tenant isolation

### 6.1 Emergency stop (as built)

- Single mechanism: platform-admin `POST /api/admin/shops/:shopId/ai/emergency-off` → `emergencyDisableAi` → `updateShopAiSettings(..., {automation_mode:'MANUAL'})`, audited `admin:emergency_ai_off` with `oldValues`, `required:true` ([admin.routes.js](../../../EasyMod-backend/src/modules/admin/admin.routes.js):17, `:34`; [admin.service.js](../../../EasyMod-backend/src/modules/admin/admin.service.js):481-499; [admin.controller.js](../../../EasyMod-backend/src/modules/admin/admin.controller.js):127-141).
- It **destroys the prior mode**: no snapshot column, no separate flag, no restore path. The only record is audit `oldValues` plus the mode-change audit.
- **No merchant-facing emergency stop** endpoint or UI; merchants have only the ordinary MANUAL setting and a per-conversation mobile pause. **No `ai_emergency_stop`-style column exists** (repo grep). Status: VERIFIED; merchant stop + distinct flag: NOT IMPLEMENTED.
- `pilot-features/disable-all` zeroes only `shop_pilot_features` columns and cannot change reply mode ([pilot-features.service.js](../../../EasyMod-backend/src/modules/pilot-features/pilot-features.service.js):212-228). Status: VERIFIED.

### 6.2 Shop-level kill reality

- The worker **never reads `shops.is_active`**; its only `is_active` hit is an FAQ query (`message-worker.js:156`). Its effective gates are mode, channel, and subscription.
- Admin suspend changes `Subscription.status` (`admin.service.js:353-363`), which is exactly what Guard 4c/4d read and fails closed on. **Operative shop kill = subscription suspension or the admin emergency MANUAL write.**
- **No product path sets `shops.is_active = false`** (only `user_shops` membership and auth sessions write `is_active`). Status: VERIFIED. Whether any production row is already false: **UNKNOWN** (not queried).

### 6.3 Tenant isolation layers

| Layer | Defence | Gap | Status |
|---|---|---|---|
| API auth | `verifyShopAccess` takes shop only from the verified JWT, re-checks live membership + `shops.is_active`; `X-Shop-ID` is ignored when the token has a shop | — | VERIFIED |
| Channel endpoints | `assertChannelBelongsToShop(channelId, shopId)` in the controller | Service methods are unscoped; any future caller bypasses the assertion | VERIFIED |
| Conversation services | Every query re-scopes by `{id, shop_id}` (e.g. `conversation.service.js:1062,1198,1283,1342,1413`) | — | VERIFIED |
| `conversation-state-standalone.service.js` | Worker validates the tenant before calling (`message-worker.js:2078-2081`); HTTP router unmounted and pinned absent by the route-perimeter test | Methods themselves use `findByPk`/`findOne({id})` with no shop predicate | VERIFIED (worker-internal) |
| Worker routing | Channel resolved by exact shop + platform + asset; explicit channel id has no shop-wide fallback | — | VERIFIED |

`POST /api/shop/update` is OWNER-gated (`shop.routes.js:34`), so the settings-injection hazard in §3.3 is owner-only, not a cross-tenant path. Status: VERIFIED.

### 6.4 Cache invalidation

`invalidateShopSettingsCaches` deletes `ai_settings` + knowledge caches, bumps `settings:generation`, and retries on a 1s/5s/15s/60s/240s ladder ([shop-settings-cache.js](../../../EasyMod-backend/src/utils/shop-settings-cache.js):6-17, `:40-119`). It is invoked by **every Shop.settings writer that uses the shared helpers** (`shop.service.js:286,317,729,844`; `shop.controller.js:151,670`; `shop-bd-settings.js:79,115`; `rto-network-settings.js:102`; `delivery.controller.js:383`; `knowledge.service.js:133`).

**Exception:** [growth-metrics.service.js](../../../EasyMod-backend/src/modules/analytics/growth-metrics.service.js):26-56 (Postgres JSON-literal path) and `:78-83` (SQLite path) write `shops.settings.first_ai_reply` directly and never import/call the invalidator; its caller `message-worker.js:3545-3546` does not either. Channel settings are read directly from the DB and have no cache at all. Status: CORRECTED (the original "after every write" claim) + VERIFIED gap.

### 6.5 Other safety-relevant facts

- **Billing pause is independent of mode.** Guard 4c can pause AI while `settings.ai.automation_mode = AUTO`; any UI that renders mode alone can give a false "live" impression. ADR-0011 C5 requires billing-standing state (VERIFIED).
- **Channel writes are unaudited/unpropagated** (§3.2) — unlike the business mode.
- **Malformed hours fail open** (§3.1).
- **`shops.config_version` is dead**: defined in the initial schema (`:151`) and the entity (`shop.entity.js:55-59`), never read anywhere. Status: VERIFIED.
- **Pilot flags fail closed** (`pilot-features.service.js:23-35`, `:55-56`, `:99-105`) and are platform-admin-only writes; reply mode is **not** pilot-flag-gated. Status: VERIFIED.

---

## 7. Frontend truth

### 7.1 Surfaces and routes

- **Business Information** = identity form + AI form on one page (§2). Identity fields: `shopName`, `phone`, `address`, `openingHours`, `additionalInfo` (≤3000), `socialLinks` (facebook, website only) ([BusinessInfoForm.tsx](../../../EasyMod-frontend/src/app/components/BusinessInfoForm.tsx):31-34, `:87-143`). Status: VERIFIED.
- **Chat Settings is a connection manager only**: OAuth popup + nonce + `BroadcastChannel`, multi-Page picker, health grid, test/reconnect/disconnect, `purposeLabel`, consent summary — and **no automation/confidence/order configuration** ([ChatSettings.tsx](../../../EasyMod-frontend/src/app/components/ChatSettings.tsx):39, `:176-193`, `:312-423`, `:535-625`, `:770-829`, `:875-971`). Status: VERIFIED.
- **Unused client.** `getMetaChannelSettings`/`updateMetaChannelSettings` exist ([meta-channels.ts](../../../EasyMod-frontend/src/api/domains/meta-channels.ts):211-236) but have zero production callers — only test mocks (`Channels.test.tsx:62-63`) — and are not re-exported from `api/index.ts:54-62`. The TS type omits `businessHours` although the API returns it. Status: VERIFIED.
- **Routes.** `/manage-shop` hub → `business-info`, `chat-settings`, `delivery-settings`, `payment-settings`, `notifications`, `faqs`; `/channels` and `/settings/channels` redirect to `/manage-shop/chat-settings`; `/channels/oauth-callback` is standalone ([routes.ts](../../../EasyMod-frontend/src/app/routes.ts):192-204, `:234-237`, `:179-184`). Status: VERIFIED.
- **Theme split.** Merchant app uses Tailwind blue/gray + shadcn vars, `--brand: #00A651` ([theme.css](../../../EasyMod-frontend/src/styles/theme.css):3-15). Midnight/Violet/Sunlight (`#17223b`/`#7460d9`/`#5d49bb`/`#f4c35e`) exists only in `landing-v6.css` / `public-funnel.css`, imported by marketing/auth pages, not merchant settings. Status: VERIFIED.

### 7.2 Inbox controls

Present and working: Take over / Resume AI (`PATCH hitl`), gated by `advanced_ai` ([InboxThreadDetail.tsx](../../../EasyMod-frontend/src/app/components/inbox/InboxThreadDetail.tsx):623-648; `UnifiedInbox.tsx:306`, `:1481`); owner display, Claim, Assign (agent list), Force-on-409, Resolve-with-note ([CustomerContextPanel.tsx](../../../EasyMod-frontend/src/app/components/inbox/CustomerContextPanel.tsx):475-598; `UnifiedInbox.tsx:1153`); business-level read-only mode badge (`data-testid="inbox-ai-reply-mode"`, `UnifiedInbox.tsx:1419-1424`). Subscription capability flags fail closed ([useSubscriptionFeatures.ts](../../../EasyMod-frontend/src/app/lib/useSubscriptionFeatures.ts):11-15, `:39-49`). Status: VERIFIED.

Gaps:

- **No queue-level owner visibility.** `InboxThreadList.tsx` renders no assignee; owner is visible only after opening the conversation. Status: PARTIALLY VERIFIED (detail-only).
- **Reason display i18n bug (real).** [InboxThreadList.tsx](../../../EasyMod-frontend/src/app/components/inbox/InboxThreadList.tsx):289-294 looks up `inbox.replyReason.<SCREAMING_SNAKE_CODE>` with a generic fallback. Backend emits `PROVIDER_SEND_FAILED`, `AI_FAILED`, `DRAFT_REVIEW_REQUIRED`, `HITL_REQUIRED`, `CUSTOMER_UNANSWERED` (`conversation.service.js:352-370`), but `inbox.replyReason` only defines camelCase keys (en.json `:914-925`; bn.json `:916+`), so the code never resolves. Correct snake-case copies exist at `inbox.actions.reason.*` (en.json `:886-895`) and at **`dashboard.pulse.replyTasks.reasons.*`** (en.json `:431-442`, lead-confirmed), **not** `dashboard.replyTasks.reasons.*`. Status: CORRECTED (namespace path) — bug VERIFIED.
- `force` is missing from the frontend `updateConversation` type (§5.5).

### 7.3 Authority and i18n mechanics

- **RBAC client/server mismatch.** Server settings writes are `requireOwner` (`req.userRole === 'owner'`) ([shop-permission.middleware.js](../../../EasyMod-backend/src/middleware/shop-permission.middleware.js):6-9; `shop.routes.js:52,70`; `meta-channel.routes.js:105`). The client permission matrix grants `WRITE_SETTINGS` to `MANAGER` ([rbac/types.ts](../../../EasyMod-frontend/src/shared/lib/rbac/types.ts):216-233; `WRITE_SETTINGS` defined `:77-78`). Settings pages themselves currently apply **no** client role gate (only `role="alert"` attributes). A manager sees enabled write affordances and receives 403. Status: VERIFIED.
- **Translation coverage** checks every statically visible `t('dotted.key')` in non-test `src/**/*.ts(x)` against **both** merged `en` and merged `bn` locales ([translation-coverage.test.ts](../../../EasyMod-frontend/src/i18n/__tests__/translation-coverage.test.ts):107-124). Dynamic/template keys are invisible; they must be surfaced through literal maps. PR #256 only scoped dynamic-key resolution per file (removed 4 false positives). Status: VERIFIED.
- **Vitest coverage thresholds are dead config.** `vitest.config.js:23-34` sets 70/70/70/60 with `checkCoverage: true`, but CI runs plain `npm run test:unit` = `vitest run` (`.github/workflows/ci-cd.yml:310`); no `--coverage` appears in any workflow. Status: REFUTED (the assumption that thresholds are enforced). See §9.

---

## 8. Test/CI pins that constrain the redesign

| Pin / gate | Anchor | What it requires today | Redesign consequence |
|---|---|---|---|
| E2E Scenario A | [ai-reply-mode.spec.ts](../../../EasyMod-frontend/tests/e2e/ai-reply-mode.spec.ts):551-553 | Navigates to `/manage-shop/business-info`, expects a 3-option `role=radiogroup` `ai-reply-mode` | Removing AI controls from Business Info fails CI; must be amended deliberately |
| E2E Scenario B | same file `:591-614` | `/manage-shop/chat-settings` has heading "Channel Settings", **zero switches**, no "Page AI participation" text | Any channel override control added there fails CI |
| ChatSettings unit pin | [ChatSettings.test.tsx](../../../EasyMod-frontend/src/app/components/ChatSettings.test.tsx):173-178 | Asserts no Page-level AI reply mode/participation control | Same as above, unit level |
| Settings contract | [meta-channel.settings-contract.test.js](../../../EasyMod-backend/src/modules/channel-providers/__tests__/meta-channel.settings-contract.test.js):76-101 | PATCH rejects `automationMode`/`aiAutoReply`/`automation_mode`/`ai_auto_reply` with 400 and never calls the service | Top-level legacy mode keys must stay forbidden |
| Page-cannot-override | [message-worker.reply-mode.test.js](../../../EasyMod-backend/src/jobs/__tests__/message-worker.reply-mode.test.js):396-410 | A channel `automation_mode: 'MANUAL'` cannot stop an AUTO business's send | Directly contradicts narrow-only override direction as written; must be rewritten to "legacy columns ignored; new overrides narrow only" |
| Business hours | [businessHours.rule.test.js](../../../EasyMod-backend/src/modules/policy/__tests__/businessHours.rule.test.js):8-44 | Only mode downgrade mapping; `{}` counts as outside hours | No shape/timezone/overnight coverage exists to inherit |
| Admin emergency test | [admin.service.test.js](../../../EasyMod-backend/src/modules/admin/__tests__/admin.service.test.js):114-130 | `emergencyDisableAi` sets MANUAL via business settings only and never touches channel settings | New stop must preserve "business-level only" plus the flag |
| Route perimeter | [route-perimeter.test.js](../../../EasyMod-backend/src/security/__tests__/route-perimeter.test.js):11-15 | `ai-chatbot` router must remain unmounted | The live bypass is via the worker, not the route |
| Gitleaks | `.gitleaks.toml:1-60`; `.github/workflows/security-scan.yml:30-37` | Full-history scan (`--log-opts="--all"`); allowlists are narrow path+regex (one legacy JWT fixture, two Growth literals, 40-hex SHAs) | No blanket `tests/` allowlist; never commit JWT-shaped fixtures |
| ADR-0011 + claims | [commercial.contract.js](../../../EasyMod-backend/src/modules/commercial/commercial.contract.js):80-101; [verify-claims/index.js](../../../scripts/verify-claims/index.js):1-35; `ci-cd.yml:1971-1978` | No forbidden price tokens; capability/price copy through the claim registry; C5 billing-standing UI; `claims.*` keys in en+bn; snapshot/registry hashes stable; Playwright DOM-absence truth gate | New merchant copy must use `claims.ai.*` with truthful fallback (`production_verified=false` for auto/draft reply) and show contract version |
| ADR-0012 | [0012](../../adr/0012-mobile-isolation-cross-cutting-amendment.md):25-49 | Touching `auth/`, `notification/`, `mobile/`, `config/config.js`, mobile workflows triggers mobile proof; cross-cutting combos warn, isolation guard stays hard | Mission avoids protected paths |
| Frontend unit execution | `.github/workflows/ci-cd.yml:305-310` | Plain `vitest run`; coverage not enforced | Coverage thresholds give no gate |
| Meta-e2e | `tests/meta-e2e/meta-e2e.test.js:682` | Two-Page reply-mode convergence under the business mode | Per-channel divergence tests are new, not extensions of this |
| Translation coverage | §7.3 | Static `t()` keys must exist in en **and** bn | Every new label needs both locales (or a public-bundle equivalent) |

---

## 9. Ground-truth corrections register

Every CORRECTED/REFUTED finding from the verification and gap-fill passes. Original claim → correction → evidence.

| # | Original claim | Correction | Evidence |
|---|---|---|---|
| 1 | Empty/missing shop AI settings raise retryable `SHOP_SETTINGS_UNAVAILABLE`; only unknown modes map to MANUAL | Empty `settings.ai` is merged with `DEFAULT_AI_SETTINGS` → effective **MANUAL**; retryable error only for a missing/unreadable **shop row**. Aliases are `AI_ACTIVE→AUTO`, `AI_SUGGEST_ONLY→DRAFT`, `HUMAN_ACTIVE→MANUAL`; only unknown values → MANUAL | `shop.service.js:641-656`; `shop-defaults.js:16-66`; `message-worker.js:216-230`; `ai-reply-mode.js:13-37` |
| 2 | `human-handoff.service.js` independently re-reads mode, policy **and the send guard** | It re-reads mode + policy + own hitl/closed + CAS, but **never** calls `getAutomaticSendGuard`, Redis pause, or latest-human check. The full triple is in the worker recovery control | `human-handoff.service.js:239-253,302-346,357`; `message-worker.js:988,1033,1117` |
| 3 | Subscription guard fails open on a missing row; Guard 4d quota retired | Quota retirement is correct, but the pipeline **fails closed**: `resolveAllowanceDecision` = `Boolean(subscription)`. The "fails open" comment is stale | `message-worker.js:2229-2232,1883-1885`; `message-worker.billing-pause.test.js:205-208`; stale comment `:2201-2202` |
| 4 | `needs_human` is an orphan written only by an unmounted path; `handoff_reason` has one writer | `needs_human` **is live** via the worker → `processNewIntent` → `escalateToHumanAgent` → `markForHumanHandoff`. `handoff_reason` has two writers; `handoff_at` is exclusive to human-handoff. Bulk statuses and the `open` DB default add vocabulary drift | `message-worker.js:2551`; `ai-chatbot.controller.js:481-492,699`; `conversation-state-standalone.service.js:426-458`; `human-handoff.service.js:179`; `conversation.service.js:1742-1749` |
| 5 | Resolve is blocked whenever a newer customer message exists | The guard is **conditional**: it runs only when the PATCH supplies `last_seen_message_id` and it resolves to a finite `created_at`. Without it, close proceeds. `resolved_at` is written only if previously null; close sets a resume boundary | `conversation.service.js:1425-1453,1527-1556` |
| 6 | New inbound after resolution reopens the conversation, so ownership does not survive | Reopen mechanics are right, but **`assignee_id` is preserved**; no non-test code nulls it. hitl is cleared; the assignee remains attached | `meta-webhook-events.handler.js:1108-1114`; repo grep for assignee null writes |
| 7 | Cache invalidation runs after **every** settings write | It runs after every write through the **shared write helpers**. `growth-metrics.service.js` writes `shops.settings.first_ai_reply` directly with no invalidation | `shop-settings-cache.js:6-17,40-119`; `growth-metrics.service.js:26-56,78-83`; `message-worker.js:3545-3546` |
| 8 | Reason-display i18n bug; correct second namespace is `dashboard.replyTasks.reasons.*` | Bug stands, but the correct path is **`dashboard.pulse.replyTasks.reasons.*`**; `inbox.actions.reason.*` is also correct. `inbox.replyReason.*` is camelCase, so SCREAMING_SNAKE codes never resolve | `InboxThreadList.tsx:289-294`; `conversation.service.js:352-370`; en.json `:886-895,914-925`; lead-confirmed `dashboard.pulse.replyTasks.reasons` |
| 9 | There are only PATCH settings/purpose-label writers, so no other mutation path exists | No third settings endpoint, but **GET /settings** and **OAuth connect-asset** create default rows (`findOrCreate`). Purpose-label PATCH lacks the owner gate that settings PATCH has | `meta-channel.service.js:196-203,545-551`; `meta-channel.routes.js:102-113` |
| 10 | No business-default/channel-override surface exists that could be duplicated; stale controller comments imply per-channel overrides | No inheritance surface exists (ADR-0003 rejected it), the channel settings client is unused, and two safety pins forbid a Page-level AI toggle. A stale `draftOrdersOnly` override comment exists only in the dead controller and must not be implemented against | `docs/adr/0003...md:43-44`; `meta-channels.ts:211-240`; `ChatSettings.test.tsx:173`; `ai-reply-mode.spec.ts:591-614`; `ai-chatbot.controller.js:181-183` |
| 11 | Vitest coverage thresholds are enforced in CI | **Refuted.** CI runs plain `vitest run`; thresholds only apply with `--coverage`, which no workflow uses. The 70/70/70/60 config is dead | `vitest.config.js:23-34`; `ci-cd.yml:305-310`; `EasyMod-frontend/package.json:10` |

Additional CONFIRMED-with-precision notes folded into the sections above: boundary mode read is not transaction-enlisted (§4.2); Guard 4 and the post-generation re-read are separate, and the `:2977` rebuild reuses the old mode (§4.1); owner/admin takeover can overwrite the assignee and bypass 409 without `force` (§5.2); repeat resume reuses an existing valid boundary (§5.2); manual reply pause applies only to non-replay agent/business sends (§5.2); `escalateToHuman` may perform a second non-transactional hitl write (§5.2).

---

## 10. NOT IMPLEMENTED for the 3-scope model

Each item below was searched for and does **not** exist at `8d477288`. They are the mission's construction surface, not defects to "fix" by assumption.

| Capability | Evidence of absence | Status |
|---|---|---|
| Per-channel mode override + inheritance + effective-config API (`overrides`, `effective_mode`, `mode_source`, `warnings`) | No `overrides` column in `meta_channel_settings`; no resolver module; no `inheritedFrom`/`isOverridden`/`effectiveValue`; ADR-0003 explicitly rejected the model; channel settings client unused | NOT IMPLEMENTED |
| Narrow-only override direction / server rejection of widening | No direction rule exists; `automation_mode` is business-global and legacy channel mode is forbidden | NOT IMPLEMENTED |
| Merchant-facing emergency stop + dedicated non-JSON flag (`ai_emergency_stop` + at/by/source/prior_mode) | Only admin `emergency-off` writes MANUAL; no such columns, endpoint, UI, audit, or SSE | NOT IMPLEMENTED |
| Channel overrides for language, greeting, closing, handoff settings | Channel settings accepts only the five columns; greeting/closing/language/handoff exist business-only | NOT IMPLEMENTED |
| Boundary re-read of channel order permission (and effective hours) before mutation/send | `allow_order_creation` is snapshotted at job start; only `automation_mode` is re-read after generation and at the boundary | NOT IMPLEMENTED |
| Timezone-correct, fail-closed, shape-tolerant business hours | Rule uses server-local clock, ignores `timezone`/`Shop.timezone`, expects one shape, fails open on malformed input, no overnight support | NOT IMPLEMENTED (defect) |
| Unified conversation state machine | Mixed vocabulary: `active/closed/archived` + live `needs_human` + legacy bulk statuses; pause split across `hitl`, `status`, Redis, metadata boundaries | NOT IMPLEMENTED |
| Manual takeover reason (`manual_handoff_reason`) | `updateConversation` writes no reason; any `handoff_reason` would be misclassified by the action queue | NOT IMPLEMENTED |
| Queue-level owner visibility | Inbox list renders no assignee; detail panel shows owner only | NOT IMPLEMENTED (detail-only today) |
| Channel-settings audit + SSE (`channel_settings_changed`), optimistic concurrency | Channel writes only `logger.info`; no audit, no SSE, no version/ETag | NOT IMPLEMENTED |
| Billing-standing state in settings UI (ADR-0011 C5) | UI renders `automation_mode` without `isAiActive` status; pause is independent of mode | NOT IMPLEMENTED |
| Canonical resolver + static "no direct mode read in send paths" guard | Six independent `getEffectiveAiReplyMode` call sites in send paths | NOT IMPLEMENTED |

**UNKNOWN (not code-determinable):** existing production `business_hours` row shapes; whether any production shop has `shops.is_active = false`; provider-side behaviour after a stop commits mid-call (the boundary read is not atomic with the HTTP send).

---

## 11. The Fool — 18 challenges and lead dispositions

All dispositions below are the mission lead's decisions (2026-11-14), recorded verbatim in intent; they are not re-litigated here.

| # | Sev | Challenge (assumption attacked) | Lead disposition |
|---:|---|---|---|
| 1 | critical | Override direction is unstated; allowing a channel to widen (MANUAL business → AUTO Page) would be production enablement while the pilot is shadow/manual and Meta verification is pending | **ACCEPTED CHANGE — narrow-only ceiling (user-approved).** Effective mode = most-restrictive(business, override); PATCH rejects widening `400`; UI filters options; runtime clamps; restriction order `MANUAL > DRAFT > AUTO` |
| 2 | critical | `automation_mode` has ≥8 independent reads; wiring the resolver into only the main path leaves bypasses in human-handoff, recovery and webhook shims | **ACCEPTED.** Resolver wired at ALL enumerated sites (Guard 4 `:2103-2113`, candidate reuse `:2167`, `mutationsAllowed` `:2392/:2452`, pre-policy `:3023`, send guard `:235`, boundary `:731`, recovery `:988`, `human-handoff.service.js:312`, `webhook.service.js:156`); static boundary test forbids direct `getEffectiveAiReplyMode` in send paths; it remains for business-default display consumers |
| 3 | high | Emergency stop's flag write and MANUAL write are not atomic; source authority between admin and merchant resume is unenforced | **ACCEPTED.** ONE transaction (Shop row lock) for 5 columns + `updateShopAiSettings(MANUAL, auditRequired, same tx)`; conditional engage `WHERE ai_emergency_stop=false` preserves `prior_mode`/source; resume source-aware (admin-source only platform admin; merchant-source OWNER); resume keeps MANUAL; honest copy (AI only; humans unaffected; in-flight provider calls may complete) |
| 4 | high | Guard 4 and stale-candidate reuse still key off the business mode; a channel narrowed to MANUAL would still run the LLM and could reuse pre-override candidates | **ACCEPTED.** Guard 4 uses effective mode; a MANUAL override skips the LLM with reason `manual_mode`; pre-override candidates are not reused |
| 5 | high | "null = revert to inherit" as a whole-JSONB PATCH destroys sibling overrides and lets concurrent writes clobber | **ACCEPTED.** Server-side read-modify-write under row lock, strip null keys, merge, never persist null; concurrency + sibling-survival tests |
| 6 | high | Dead `confidence_threshold_send/suggest` (0–1) stay visible beside the live 0–100 override; merchants get contradictory controls | **ACCEPTED.** Legacy threshold fields stay API-accepted for compatibility, GET marks them deprecated, new UI renders only the live `confidence_threshold` 0–100 override |
| 7 | high | Test-amendment list omits Scenario A (`:551-553`) and `message-worker.reply-mode.test.js:396`, and Scenario B's zero-switch assertion contradicts the new UI | **ACCEPTED.** Add Scenario A; rewrite reply-mode `:396` (legacy columns ignored + overrides narrow-only); rewrite Scenario B (scoped + narrow-only + override labeling) |
| 8 | high | Client RBAC grants `WRITE_SETTINGS` to MANAGER while the server requires `owner`; a manager would see write controls and get 403 | **ACCEPTED.** Client write controls gated on OWNER matching server `requireOwner`; manager/staff read-only; tests both sides |
| 9 | high | Reusing `metadata.handoff_reason` for merchant reasons mislabels queue items and risks lost updates on the metadata object | **ACCEPTED.** Distinct `metadata.manual_handoff_reason(+at/by)` merged into the single `fields.metadata` after status/resume; inbox-actions classification distinguishes manual vs system; combo PATCH + queue-classification tests |
| 10 | high | The business-hours "fix" changes which shops auto-send; hardcoding Asia/Dhaka ignores `Shop.timezone`; overnight ranges remain unimplemented | **ACCEPTED.** Malformed → CLOSED fail-closed; tz resolution = `hours.timezone`, else `Shop.timezone`, else `Asia/Dhaka`; overnight ranges; both shapes; table-driven tests; shape audit query |
| 11 | high | `allow_order_creation`/hours are configuration-independent but enforcement is snapshotted; a mid-turn disable still mutates | **ACCEPTED.** Fresh channel re-read immediately before order-flow/interaction mutation; residual during-mutation race documented; committed-mutation sends never suppressed (`AGENT_ACTION_POLICY`) |
| 12 | medium | A boundary loader could lengthen locks, accidentally INSERT via `findOrCreate`, and its fail-closed hold can cause a retry storm; the guarantee overpromises | **ACCEPTED.** Loader `(shopId, channelId, {transaction})` asserts `channel.shop_id === shopId` else null fail-closed; NO `findOrCreate`/INSERT and NO Shop row lock inside the boundary (fresh committed reads; lock order Conversation→reads documented); loader error/missing → hold, no retry storm; honest in-flight guarantee |
| 13 | medium | Key rejection alone is insufficient for a merchant-writable JSONB driving send behaviour (shapes, aliases, scales, greeting bounds) | **ACCEPTED.** Joi at route + resolver canonical normalization (no stored aliases, 0–100 scale, bounded greeting); invalid → inherit + warning |
| 14 | medium | The "business-only because directly read" rationale is wrong for `max_auto_order_value`, `ask_email`, `required_fields` — they are dead, not directly read | **ACCEPTED CORRECTION.** Those three are verified DEAD (no runtime consumer; only defaults/validator/controller/service/subscription-plans copy). Keep existing defaults-editor controls unchanged (preserve behaviour), exclude from channel UI, document dead status |
| 15 | high | New resolver/list/detail fields multiply call sites on unscoped service methods; a channelId-only resolver could leak another shop's config | **ACCEPTED.** Tenant loader contract (as #12); tenant tests for list, detail and every new field |
| 16 | low | `shops.is_active` is presented as a kill-switch tier that no product path can produce | **ACCEPTED CORRECTION.** Keep the resolver check as defense-in-depth; document operative shop kill = subscription suspension + emergency stop; no product path sets `is_active=false` |
| 17 | low | The stop UI promise must match mechanism: humans and draft approvals are outside the mode gate; in-flight calls cannot be aborted | **ACCEPTED.** Copy "Stops AI replies; humans can still reply; messages already delivering may complete"; tests that agent-send and draft-approval succeed during stop |
| 18 | low | The SSE/cache bullet conflates channel settings with business caches; channel settings have no cache; the growth-metrics gap is unrelated and unfixed | **ACCEPTED.** Channel settings have NO cache; add SSE `channel_settings_changed` (with `channel_id`) + audit on PATCH; add `emergency_stop_changed`; growth-metrics invalidation gap documented, not fixed |
| — | — | Hardcoded LLM confidence `0.9` is deferred | **ACCEPTED with condition:** enforced as a pre-AUTO blocking gate in `KNOWN_LIMITATIONS` + launch checklist, not merely documented |

---

## 12. Additional lead-verified defect (D20): `needs_human` handoff bypass

**Finding.** The legacy `markForHumanHandoff` path is reachable from the live worker (§5.3). It writes `status='needs_human'` and `metadata.handoff_reason` but leaves `hitl=false`. The worker's only human-owned statuses are `hitl=true` and `closed`/`archived` (`message-worker.js:2093-2097`); `needs_human` is not human-owned anywhere. Consequently a customer message containing a modification/return keyword (`change`, `address change`, `return`, `refund`, `cancel`, Bangla equivalents) escalates the conversation in the queue while AI remains free to reply on the next inbound. Status: **VERIFIED DEFECT (latent; not realized in production today because the pilot is MANUAL and prod has 0 messages).**

**Mission fix (lead-approved).** `markForHumanHandoff` must also set `hitl = true` — the canonical pause flag — so the existing Guard 2, send guard, recovery and boundary checks all see the handoff. Add a regression test proving that a keyword-fallback handoff pauses AI for subsequent customer messages. The legacy path is otherwise preserved (status value, metadata keys, business-visible `[HANDOFF]` message), so no downstream consumer loses its current input.
