# PROPOSED_ARCHITECTURE — Business Profile & Channel Automation Redesign

Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md) (rules) + [API_CONTRACT](API_CONTRACT.md) (seams). This document describes shape, data flow, and UX. Baseline `8d477288`.

## 1. Domain model

```text
Business (Shop)
├── Identity & knowledge            shops.settings.businessInfo, knowledge/FAQs (unchanged)
├── Automation DEFAULTS             shops.settings.ai (unchanged store; new role: ceiling + fallback)
└── Emergency stop                  shops.ai_emergency_stop (+at/by/source/prior_mode)  [NEW]
     │  bypass-proof; engage also writes MANUAL (rollback belt); resume keeps MANUAL
     ▼
Channel (MetaChannel + MetaChannelSettings, 1:1 per connected Page)
├── overrides JSONB [NEW]           automation_mode (NARROW-ONLY), confidence_threshold, greeting
│                                   NULL/absent key = inherit; server-side merge; null = revert
├── channel-native (unchanged)      business_hours (tz-fixed), allow_order_creation, purpose_label
└── legacy dead (unchanged)         automation_mode/ai_auto_reply columns, threshold_send/suggest
     ▼
Conversation (per customer, Page-pinned)
├── hitl / assignee_id / status     unchanged mechanisms; needs_human now pauses AI (hitl=true fix)
├── Redis ai:pause (30min)          unchanged (manual reply pause; never auto-resumes)
├── resume boundary                 unchanged fencing
└── metadata.manual_handoff_reason  [NEW] manual takeover reason (+at/by); system handoff_reason kept
```

Effective configuration is computed by ONE resolver (`channel-automation.resolver.js`), never cached, read fresh at every enforcement site (enumerated in ADR-0013 §5). Precedence: stop → shop-active → conversation safety → effective channel config (clamped override else default) → billing/channel-status → confidence/commerce → final send authorization.

## 2. Data flow

### Configuration write
```text
Merchant (OWNER) → PATCH /channels/meta/:id/settings {overrides}
  → Joi validate → narrow-only check vs business default (400 on widening)
  → row-locked read-modify-write (strip nulls, merge, canonicalize)
  → audit CHANNEL_AUTOMATION_OVERRIDE_CHANGED (in tx)
  → invalidateShopSettingsCaches + SSE channel_settings_changed{channel_id,…}
  → UI invalidates ["channel-settings",id] / ["channels"]
```
Business defaults write (`PUT /shop/ai-settings`) unchanged; propagates to inheriting channels automatically (resolver reads fresh); SSE `ai_reply_mode_changed` unchanged.

### Automatic reply (per turn)
```text
Meta webhook → receipt/dedupe → Page attribution → inbound persist (Page-pinned conv)
→ burst job → worker:
   Guard4: resolver(shop, channel, stop, active) → effective mode
           MANUAL-equiv → notify + skip (no LLM spend)   [stop/inactive/manual reasons]
   → order-flow/interaction: FRESH allow_order_creation re-read → Action Gate (sole mutation authority)
   → LLM/grounding → confidence gate (effective threshold)
   → pre-policy: resolver rebuild + confidence re-check (last reversible point)
   → Outbound Policy (consent…hours(tz-fixed)…draftMode)
   → send guard (resolver) → CAS claim → delivery lock
   → provider boundary (resolver fresh read; hitl/pause/resume/consent; CAS attempted)
   → evidence revalidation → Graph send → SENT only with MID (ADR-0004)
```
Recovery/holding paths and the webhook send shim use the same resolver; stop suppresses their automatic sends. Human sends + draft approvals unaffected by stop (human agency).

### Handoff
```text
Take over (PATCH hitl:true + handoff_reason) → claim/409/force rules (unchanged)
  + metadata.manual_handoff_reason/at/by (single metadata merge)
  → pending candidates HELD human_active → SSE hitl_changed → audit
System escalation → hitl + HUMAN_REQUIRED turn (tx) → holding message via resolver+policy+claim
Legacy keyword fallback → markForHumanHandoff now sets hitl=true (bypass fixed)
Manual reply → pause 30min + hold candidates (no hitl, no auto-resume)
Resume (hitl:false) → resume boundary fences stale candidates → pause cleared
Resolve → closed + note; mode unchanged; newer-customer guard when last_seen supplied
Reopen on new inbound → active, hitl cleared, assignee PRESERVED
```

## 3. Backend component changes

| Component | Change |
|---|---|
| `channel-automation.resolver.js` | NEW — pure resolver + tenant-asserted loader (contract §1) |
| `message-worker.js` | resolver at 7 sites; whitelist merge; fresh order-permission re-read; pre-policy confidence re-check; needs_human in human-owned statuses; effective-mode candidate reuse |
| `human-handoff.service.js`, `webhook.service.js` | resolver replaces business-mode reads; stop suppression |
| `businessHours.rule.js` | tz-correct, both shapes, overnight, malformed→CLOSED |
| `meta-channel.{routes,controller,service,serializer}.js` | overrides Joi + narrow-only + row-locked merge + shop predicate + audit + SSE + effective/deprecated fields; list batch effective fields |
| `shop.{routes,controller,service}.js` | emergency-stop/resume endpoints (tx, source-aware); GET ai-settings + emergency block |
| `admin.{routes,service,controller}.js` | emergency-off delegates (source=admin); admin resume |
| `conversation.{service,validator}.js` | handoff_reason Joi; manual_handoff_reason metadata merge; list/detail effective fields (batched) |
| `conversation-state-standalone.service.js` | markForHumanHandoff sets hitl=true |
| `inbox-actions.service.js` | manual vs system reason classification |
| entities + migrations 004/005 | overrides JSONB; 5 stop columns |
| security boundary test | NEW — no direct getEffectiveAiReplyMode in send paths |

Untouched: Action Gate, Outbound Policy rule order, ADR-0004 delivery truth/outbox, order-confidence (ADR-0007/0010), pilot flags (ADR-0009), billing (ADR-0011), draft approval, subscription guards.

## 4. Frontend architecture

### Component hierarchy (new `src/app/components/channels/`)
```text
ChannelsOverview (/manage-shop/channels)
├── EmergencyStopCard (banner + OWNER Stop/Resume confirm; honest copy)
├── BusinessDefaultsSummaryCard (current ceiling mode + link to /manage-shop/automation)
└── ChannelCard[] (Page identity + purposeLabel, health grid [extracted],
    effective-mode badge [Inherited|Overridden|Clamped|STOPPED|PAUSED-billing],
    warnings [token expiry, hours malformed, clamped override], Manage → detail)
ChannelDetail (/manage-shop/channels/:channelId)
├── header: identity, health, effective mode + source (aria-live)
└── Tabs: Reply behavior (mode OverrideControl) · AI behavior (confidence + greeting
    OverrideControls; language/closing read-only inherited + edit link) ·
    Order handling (allow_order_creation switch; max_auto_order_value read-only) ·
    Operating rules (hours editor + timezone; truth-table states) ·
    Advanced (purpose label, connection actions, deprecated-threshold disclosure)
OverrideControl: inherit/override toggle → effective value line → source badge →
    Revert-to-default (PATCH null) → save state; OWNER-only editing
BusinessAutomationDefaults (/manage-shop/automation): refactored AISettingsForm host
    (testids kept; single shared normalizer; emergency stop card; billing standing)
ChannelConnectionManager + useMetaChannelConnection: behavior-preserving extraction
    of ChatSettings OAuth/health/disconnect logic
BusinessInfoSettings: identity/knowledge only + link card (AI controls removed)
SettingsHub: 8 cards (Channels & Automation replaces Chat Settings; + Automation defaults)
```

### Inbox enhancements
Owner/assignee chip in thread rows + detail header; reason display via literal map (i18n bug fixed); mode badge = effective (fallback business); emergency banner + SSE; takeover dialog with optional reason select; `force`/`handoff_reason` typed. No channel-config writes from inbox (pinned).

### States (every surface)
Loading skeletons; error + retry; empty (no channels → connect CTA); permission-denied (read-only + accurate reason); fail-closed warning ("Automation paused: configuration unavailable"); stopped/clamped/billing-paused badges. Mobile 360–390: stacked cards, scrollable tabs, sticky save bar, bottom-sheet patterns reused. a11y: labeled radiogroups, aria-live effective mode, focus return after revert, axe in new spec.

### Design
Scoped `.ca-scope` Midnight/Violet/Sunlight semantic tokens (theme.css) on redesigned surfaces; shadcn/Radix kit; bn+en literal keys; Claim-registry capability copy (ADR-0011); no global retheme; no fake stats.

## 5. Compatibility

- Old routes redirect; old API clients unchanged (business defaults PUT; legacy channel keys accepted; top-level mode keys still forbidden); conversation payloads additive; SSE additive.
- Existing channels: NULL overrides → identical behavior; hours defect-fix changes only malformed/tz-wrong rows (documented, audited).
- Rollback: old code ignores new columns; stopped shops stay MANUAL.

## 6. Deliberate behavior-contract amendments (tests)

See [TEST_STRATEGY](TEST_STRATEGY.md) §4 — Scenario A/B, ChatSettings:173, settings-contract, reply-mode:396, businessHours, admin stop. Each amendment preserves the original safety intent (no unbounded Page mode authority; legacy columns dead; owner-only writes) while pinning the NEW contract (narrow-only overrides, effective-mode display). None weakens a safety pin.
