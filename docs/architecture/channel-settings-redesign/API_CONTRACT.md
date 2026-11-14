# API_CONTRACT — Channel Automation Redesign (FROZEN)

Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md). Baseline `8d477288`. This contract is the integration seam between backend, frontend, and test workstreams — changes require lead approval. All endpoints keep existing mounts, `authenticate` + `verifyShopAccess` (JWT shop only), and existing error envelope `{success:false, code, message}`.

## 1. Resolver module (backend-internal contract)

New `EasyMod-backend/src/modules/channel-providers/channel-automation.resolver.js`:

```js
// Pure. No I/O. Canonicalizes + clamps. Never throws on bad input.
resolveChannelAutomation({ shopAiSettings, channelSettings, emergencyStop, shopIsActive })
// -> {
//   mode: 'AUTO'|'DRAFT'|'MANUAL',
//   modeSource: 'emergency_stop'|'shop_inactive'|'channel_override'|'business_default'|'fail_closed',
//   effective: { automation_mode, confidence_threshold, greeting:{enabled,custom_text},
//                business_hours, allow_order_creation, purpose_label },
//   overrides: { ...canonical explicit overrides only... },
//   warnings: [ 'override_clamped_by_business' | 'invalid_override_value' | ... ]
// }

// Async. Fresh reads. Tenant-asserted.
loadEffectiveChannelAutomation(shopId, channelId, { transaction, createIfMissing } = {})
// -> same shape + { emergencyStop:{active,at,by,source,prior_mode}, shopIsActive, billingAiActive }
// Contracts:
// - assert meta_channels.shop_id === shopId; mismatch/missing channel -> null (fail-closed)
// - missing/unreadable SHOP row -> throw { code:'SHOP_SETTINGS_UNAVAILABLE', retryable:true }
// - empty settings.ai -> DEFAULT_AI_SETTINGS merge (MANUAL), NOT an error
// - missing channel settings row: createIfMissing=true (Guard 4 only) -> findOrCreate defaults;
//   otherwise -> null (caller holds with channel_settings_unavailable)
// - NO INSERT and NO Shop row lock when called with a boundary transaction
// - loader read error -> caller holds; never converts to retry storm
```

Restriction order (most → least restrictive): `MANUAL > DRAFT > AUTO`. `effectiveMode = mostRestrictive(businessMode, overrideMode)`. Override canonicalization: legacy aliases accepted at input (`AI_ACTIVE→AUTO`, `AI_SUGGEST_ONLY→DRAFT`, `HUMAN_ACTIVE→MANUAL`) but **stored canonical**; invalid mode value → inherit + `invalid_override_value` warning; threshold coerced/validated 0–100 finite (invalid → inherit + warning); greeting bounded (`custom_text ≤ 500`, `enabled` boolean; invalid → inherit + warning).

`buildWorkerAiSettings(shopSettings, channelSettings, businessMode)` becomes a thin delegate: whitelist-pick `DEFAULT_AI_SETTINGS` keys from shopSettings (never spread), apply resolver effective values, set `automation_mode` last. Existing call sites keep their signature.

**Boundary test (new, security suite):** static grep-style assertion that `message-worker.js`, `human-handoff.service.js`, `webhook.service.js` do not call `getEffectiveAiReplyMode` directly (resolver only). `getEffectiveAiReplyMode` stays exported for business-default display consumers (admin, growth-os, shop GET).

## 2. Channel settings

### `GET /api/channels/meta/:channelId/settings` (any active member)

Response `data` = existing camelCase fields **unchanged** (`businessHours`, `confidenceThresholdSend`, `confidenceThresholdSuggest`, `allowOrderCreation`, `purposeLabel`) **plus**:

```jsonc
{
  "overrides": { "automation_mode": "DRAFT", "confidence_threshold": 80, "greeting": {"enabled":true,"custom_text":"…"} }, // only explicit keys; canonical values; {} when none
  "effective": { "automation_mode":"DRAFT", "confidence_threshold":80, "greeting":{…}, "business_hours":null, "allow_order_creation":true, "purpose_label":"…" },
  "mode_source": "channel_override", // enum above
  "warnings": ["override_clamped_by_business"],
  "emergency_stop": { "active":false, "at":null, "by":null, "source":null, "prior_mode":null },
  "billing_ai_active": true,
  "deprecated_fields": ["confidenceThresholdSend","confidenceThresholdSuggest"] // legacy dead thresholds; new UI must not render
}
```

Keep the existing `findOrCreate` side effect for compat (documented); it must not run inside any send-boundary transaction.

### `PATCH /api/channels/meta/:channelId/settings` (OWNER only — `requireOwner`)

Joi body (additive; existing keys unchanged):

```js
overrides: Joi.object({
  automation_mode: Joi.string().valid('AUTO','DRAFT','MANUAL','AI_ACTIVE','AI_SUGGEST_ONLY','HUMAN_ACTIVE').allow(null),
  confidence_threshold: Joi.number().min(0).max(100).allow(null),
  greeting: Joi.object({ enabled: Joi.boolean(), custom_text: Joi.string().max(500).allow('') }).allow(null)
}).unknown(false).allow(null)   // null/absent = no override changes
// businessHours: tightened — day keys mon..sun, HH:MM, optional timezone (IANA validated via Intl),
//   accept {day:{open,close}} and {day:[{open,close},...]}; overnight close<open allowed
// confidenceThresholdSend/Suggest, allowOrderCreation, purposeLabel: unchanged (legacy compat)
// automationMode / aiAutoReply / automation_mode / ai_auto_reply at TOP LEVEL: remain Joi.forbidden()
```

Semantics:
- `overrides.<key> = null` → **revert that key to inherit** (key deleted). Server does **read-modify-write under the channel-settings row lock**: read current overrides, strip null keys, merge provided keys, canonicalize, persist. Never wholesale-replace; never persist null values. Sibling overrides survive; concurrent PATCHes to different keys both survive (row lock).
- **Narrow-only enforcement**: resolved `overrides.automation_mode` must not be less restrictive than the current business default → `400 INVALID_OVERRIDE_WIDENING` (message names the business ceiling). Clamp check uses normalized canonical values.
- Unknown override key → `400 OVERRIDE_KEY_FORBIDDEN`. Invalid value shape → `400 INVALID_OVERRIDE_VALUE`.
- Service signature gains mandatory shop scope: `getSettings(channelId, { shopId })`, `updateSettings(channelId, patch, { shopId })` — assert `channel.shop_id === shopId` (defense-in-depth behind controller assertion). Cross-shop → 404 (existing convention).
- After write: audit `CHANNEL_AUTOMATION_OVERRIDE_CHANGED` (old/new overrides, actor, shop, channel) in the write transaction; `invalidateShopSettingsCaches(shopId)`; SSE `channel_settings_changed`.
- Response: same shape as GET (post-write state).

### `GET /api/channels/meta` (list, any active member)

Each channel gains additive fields: `effective_mode`, `mode_source`, `override_count` (number of explicit override keys), `emergency_stop` (shop-level block, same shape), `billing_ai_active`. One batched resolver pass (single Shop read + `MetaChannelSettings.findAll` for the shop's channels) — no N+1. Existing fields unchanged.

### `PATCH /api/channels/meta/:channelId/purpose-label` — unchanged (any member; cosmetic).

## 3. Business defaults (unchanged semantics)

- `GET /api/shop/ai-settings` (any member): existing payload **plus** read-only `emergency_stop {active,at,by,source,prior_mode}`.
- `PUT /api/shop/ai-settings` (OWNER): unchanged whitelist/validation. This is the **business defaults editor**; it cannot clobber channel overrides (different table). Mode normalization + `ai_reply_mode_changed` SSE + cache invalidation unchanged.
- `POST /shop/update`: unchanged strip list (`automation_mode` stripped; emergency columns unreachable via settings JSON).

## 4. Emergency stop

### `POST /api/shop/ai/emergency-stop` (OWNER)
Body: `{ reason?: string ≤500 }`. Idempotent. ONE transaction, Shop row lock:
- conditional engage `WHERE ai_emergency_stop = false`; repeat engage preserves `prior_mode/source/at/by` and returns current state (200, `already_active:true`).
- writes `ai_emergency_stop=true, at=now, by=actor, source='merchant', prior_mode=<normalized current business mode>` **and** `updateShopAiSettings(shopId, actor, {automation_mode:'MANUAL'}, {transaction, auditRequired:true})`.
- audit `AI_EMERGENCY_STOP_ENGAGED` (reason, prior_mode) in-transaction; after commit: cache invalidation + SSE `emergency_stop_changed`.
- Response: `{ active:true, at, by, source, prior_mode, already_active }`.

### `POST /api/shop/ai/emergency-resume` (OWNER)
- If `source='admin'` → `403 EMERGENCY_STOP_ADMIN_SOURCE` (platform admin must resume).
- Clears the five columns (flag false, at/by/source/prior_mode null) in one transaction; **mode stays MANUAL**; audit `AI_EMERGENCY_STOP_RESUMED`; SSE; cache invalidation. Idempotent when not stopped (200, `already_inactive:true`).
- Response: `{ active:false, automation_mode:'MANUAL', prior_mode:<cleared snapshot for UI> }`.

### Admin
- `POST /api/admin/shops/:shopId/ai/emergency-off` (SUPER_ADMIN): delegates to the same service with `source='admin'` (flag + MANUAL + snapshot + audit). Existing assertion "sets MANUAL through the business setting" survives.
- `POST /api/admin/shops/:shopId/ai/emergency-resume` (SUPER_ADMIN, new): clears any source; mode stays MANUAL; audit + SSE.

## 5. Conversation PATCH additions

`PATCH /api/conversation/:id` Joi gains:
```js
handoff_reason: Joi.string().valid('manual_takeover','customer_request','phone_call','order_issue','other')
// applies only with hitl:true; default 'manual_takeover' when hitl:true and absent; ignored otherwise
```
- Service claim branch writes `metadata.manual_handoff_reason`, `manual_handoff_at`, `manual_handoff_by` — merged into the **single** `fields.metadata` object after status/resume-boundary application (no stale-snapshot spread). System `handoff_reason` untouched.
- `inbox-actions.service.js` classification: `manual_handoff_reason` present → manual-handoff bucket/reason (NOT `HANDOFF_SUSPENDED_CHECKOUT`); system `handoff_reason` behavior preserved.
- `force` already declared server-side — no backend change; frontend type fixed.
- Takeover/assign/resume/resolve never write channel settings or shop settings (pinned by test).

## 6. Conversation list/detail additive fields

`GET /api/conversation` list + detail payloads gain (batched resolver, no N+1):
- `effective_ai_reply_mode` (channel-aware, stop-aware, clamped)
- `mode_source`
- `emergency_stop` (shop-level boolean block)
- `billing_ai_active`
Existing `ai_reply_mode` (business default) retained for old clients. Frontend badge uses `effective_ai_reply_mode ?? ai_reply_mode`.

## 7. Worker runtime contracts

- Guard 4: resolver effective mode; skip reasons add `emergency_stop`, `shop_inactive` (merchant notification preserved for manual-equivalent skips); MANUAL-override channel → reason `manual_mode`, no LLM call.
- Candidate reuse gate: effective mode (pre-override SEND_PENDING candidates not reused after narrowing).
- `mutationsAllowed`: effective mode AND **fresh** `allow_order_creation` re-read immediately before `handleOrderFlow`/`resolveInteraction`.
- Pre-policy rebuild: resolver; **confidence re-check** with effective threshold → HELD `low_confidence` (no second escalation/holding message).
- Send guard / provider boundary: resolver with `meta_channel_id` from the (locked) conversation; hold reasons `emergency_stop`, `shop_inactive`, `channel_settings_unavailable`, `mode_changed`. No INSERT/no Shop lock in boundary.
- Recovery control + human-handoff holding + webhook send shim: resolver; stop suppresses automatic holding sends (stamp HELD `emergency_stop`, hitl preserved).
- `markForHumanHandoff`: also sets `hitl=true`; worker human-owned status set includes `needs_human` (Guard 2 + send guard + boundary).
- Draft approval path: **unchanged** (human agency under stop).
- Hours rule: timezone-correct, both shapes, overnight, malformed→CLOSED (truth table in TEST_STRATEGY).

## 8. SSE events (shop-scoped, existing manager)

| Event | Payload | Emitted on |
|---|---|---|
| `channel_settings_changed` (new) | `{ channel_id, effective_mode, mode_source, override_keys }` | every channel settings PATCH (incl. purpose-label? NO — settings PATCH only) |
| `emergency_stop_changed` (new) | `{ active, at, by, source, prior_mode }` | engage/resume (merchant + admin) |
| `ai_reply_mode_changed` (existing) | unchanged | business defaults writes |
| `hitl_changed` (existing) | unchanged (+ assignee fields already present) | claim/resume/assign |

Frontend `useInboxSSE.ts` + sse-client event list gain the two new events; channel detail/overview invalidate `["channel-settings", id]` / `["channels"]` on `channel_settings_changed` (scope by channel_id); inbox badge + emergency banner react to `emergency_stop_changed`.

## 9. Frontend registry

### Routes (`src/app/routes.ts`)
| Route | Component | Notes |
|---|---|---|
| `/manage-shop/channels` | `ChannelsOverview` | new |
| `/manage-shop/channels/:channelId` | `ChannelDetail` | new |
| `/manage-shop/automation` | `BusinessAutomationDefaults` | new (refactored AISettingsForm host) |
| `/manage-shop/chat-settings` | redirect → `/manage-shop/channels` | compat |
| `/channels`, `/settings/channels` | redirect → `/manage-shop/channels` | retargeted |
| `/manage-shop/business-info` | `BusinessInfoSettings` | AI form removed; link card to automation |
| `/channels/oauth-callback` | unchanged | standalone |

### Testids (stable registry)
`ai-reply-mode` (business defaults radiogroup — KEPT), `channel-mode-override` (channel radiogroup), `channel-override-revert-<key>`, `channel-effective-mode`, `channel-mode-source`, `emergency-stop-button`, `emergency-resume-button`, `emergency-stop-banner`, `inbox-ai-reply-mode` (KEPT, now effective), `inbox-owner-chip`, `inbox-handoff-reason`, `takeover-reason-select`.

### React-query keys
`["channels"]`, `["channel-settings", channelId]`, `["shop-ai-settings"]` (existing), `["conversations"]` (existing). SSE-driven invalidation; no polling.

### i18n
New literal keys in BOTH `en.json` + `bn.json`: namespaces `manageShop.channels.*`, `manageShop.automation.*`, `inbox.replyReason.*` (add missing camelCase keys: `lowConfidence`, `sentimentNegative`, `manualTakeover`, `humanRequired`, `hitlRequired`, `customerUnanswered`, `aiPaused`, `providerSendFailed`, …), `inbox.owner.*`, `emergencyStop.*`. Reason display via **literal display map** (SCREAMING/snake code → camelCase key) — never interpolated `t()` keys (coverage test). Capability/price copy via `<Claim>` registry (`claims.ai.*` truthful fallback; ADR-0011 C5 billing-standing badge; no forbidden tokens; `verify:claims` green).

### Tokens
`.ca-scope` semantic tokens in `src/styles/theme.css`: `--ca-midnight:#17223b; --ca-violet:#7460d9; --ca-violet-deep:#5d49bb; --ca-sunlight:#f4c35e;` (+ surface/ink derivatives). Applied to redesigned surfaces only; emergency uses existing `--destructive`. No global retheme.

### Permission UX
Write controls (defaults save, overrides, stop/resume) visible/enabled for **OWNER only** (matches server `requireOwner`); MANAGER/STAFF read-only with accurate reason. Subscription `advanced_ai` gating of inbox takeover/suggestions unchanged (fail-closed).

## 10. Error codes (new)

| Code | HTTP | When |
|---|---|---|
| `INVALID_OVERRIDE_WIDENING` | 400 | override less restrictive than business default |
| `OVERRIDE_KEY_FORBIDDEN` | 400 | unknown key in overrides |
| `INVALID_OVERRIDE_VALUE` | 400 | value shape/range invalid |
| `EMERGENCY_STOP_ADMIN_SOURCE` | 403 | merchant resume of admin-source stop |
| `CHANNEL_SETTINGS_UNAVAILABLE` | worker hold | channel row missing at boundary |
| `SHOP_SETTINGS_UNAVAILABLE` | worker retryable | shop row missing/unreadable (existing) |

Existing codes unchanged: `HUMAN_TAKEOVER_CONFLICT`, `HANDOFF_RESOLUTION_CONFLICT`, `VALIDATION_ERROR` (top-level mode keys), 404 cross-shop.
