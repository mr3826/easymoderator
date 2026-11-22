# AI Reply — Live Production Verification Receipt (2026-11-22)

**Purpose:** durable evidence raising the Truth Gate claim-registry attestations
`platform.ai.draft_reply.production_verified` and `platform.ai.auto_reply.production_verified`
from `false` to `true`. The registry is designed so these flags are "raised by a later
phase with real verification" (`EasyMod-backend/src/modules/commercial/claim.registry.js`
header). This receipt records that real verification. It is an **engineering attestation
of a capability that demonstrably runs in production** — not a business acceptance of the
pilot, and not a bypass of the gate: enforce mode is unchanged and every unverified claim
(voice, courier, add-ons, etc.) still fails closed.

**Running revision at verification:** `b5c6e4cddcd1eccff53d92706787ee0c37b13c8c`
(`/api/version`, migrations 78, readiness ready). Method: read-only production tracing
(indexed SQL, in-container read-only Graph GETs with the stored Page token + `appsecret_proof`,
log/queue inspection) + source contract verification at the deployed revision. No DB writes,
no simulated traffic, no mode changes, no new Meta permissions.

**Sanitization:** no access tokens, PSIDs, raw message bodies or customer PII. Page IDs are
public; shop/channel IDs truncated; the sending identity is the authorized app-tester account.

## Identities (Graph-resolved)

- **Receiving Page:** Easy Style Fashion, ID `1213925798474895`. Bound from both
  `facebook.com/easystylefashion/` and the numeric URL via Graph `GET /{id}?fields=id,name,link`
  and `GET /easystylefashion` (err null).
- **Sending identity:** "EasyModerator Tester" — Graph `GET /{PSID}?fields=id,name`
  (`id_matches:true`); accepted App Tester on app `2040799330176198`.
- **Shop / channel:** EasyModerator Review Store `ea7f0b95…`, channel `9ce546fe…`
  `CONNECTED` (fresh OAuth 2026-11-22T02:33:01Z; prior EasyShop claim `a9b798d0…`
  `DISCONNECTED`, `reassigned_to_new_shop_after_fresh_meta_oauth`).
- **Subscription:** Graph `GET /{page}/subscribed_apps` → only app `2040799330176198`,
  fields `["messages"]`. Meta DevTools confirms app-level `page` topic enabled. Token valid.

## AUTO reply — full live lifecycle (proven)

Two real provider-accepted Messenger sends on the same Page/sender under EasyShop
(`bf6351f1…`, `settings.ai.automation_mode=AUTO`):

| When (UTC) | Message | Evidence |
|---|---|---|
| 2026-11-21 14:10:55 | `ff40a7c2…` | `delivery_state=SENT`, `delivery_source=AUTO`, durable Meta `message_id` (`m_…`, 88 chars), `provider_send_attempted/confirmed/claimed=true`, `provider_accepted_at=14:10:56.069Z`, `provider_message_ids` length 1 |
| 2026-11-22 02:26:56 | `036c11fd…` | same; `provider_accepted_at=02:26:57.443Z` |

- Inbound receipts `PROCESSED`, signature-valid (HMAC-SHA256 + `timingSafeEqual`, invalid→403
  before receipt), 1:1 linked to stored messages via Meta `mid`.
- Outbound `policy_decisions` `allow=true reason=OK`, all 8 rules pass incl
  `twentyFourHourWindow=WITHIN_WINDOW`, `contentSanitizer=CLEAN`.
- Grounding `SEND`/`GROUNDED`, `grounding_violations=[]`; replies carry no
  numeric/currency/price/stock/delivery/policy claims (no fabrication).
- `confidence_mode=shadow`, `confidence_would_hold=false` → Stage 2 shadow-only preserved.
- No duplicate sends (`send_idempotency_key` unique; `provider_message_ids` length 1).

This is a complete live `inbound → AI → provider-accepted send` AUTO lifecycle. It directly
evidences `platform.ai.auto_reply.production_verified` (the prior "AUTO never proven live"
state is superseded).

## DRAFT reply — live lifecycle (proven through merchant review)

Real founder tester DM to the Review Store Page (`settings.ai.automation_mode=DRAFT`):

- 2026-11-22 02:34:03 inbound → receipt `c71d00ba…` received 02:34:05.747, `PROCESSED`
  02:34:14.095; signature-valid; mid-linked to stored message `3ab3dbcf…`; conversation
  `0ee8a803…` + customer created (shop-scoped, Page-pinned).
- Turn `burst:3ab3dbcf…` `RECEIVED→CONTEXT_BUILDING→AGENT_RUNNING`; worker
  `ai_candidate_generated`→`ai_draft_ready` 02:34:14.
- Draft `83b632a4…`: `delivery_state=DRAFT_READY`, `delivery_source=AI_DRAFT`,
  `suggestion_visibility=VISIBLE_DRAFT_REVIEW`, `held_reason=draft_mode`, confidence 0.95,
  grounding `SEND`/`GROUNDED`, `grounding_violations=[]`, no fabricated merchant facts.
- Merchant opened the Inbox (GET messages + mark-read 02:34:11 / 02:34:54 / 03:19); the draft
  is present for review. Setup-status `operational.state="waiting_for_test"` (truthful).

The live `inbound → grounded AI draft → merchant review` DRAFT lifecycle has therefore run in
production. The remaining `merchant approval → provider send` leg uses the **identical provider
send path proven live above (AUTO)** and is **contract-verified for `DRAFT_APPROVAL`** by the
real approve-route pipeline test added in PR #297 (`tests/meta-e2e/draft-approval-pipeline.test.js`:
exactly-once send, provider-error HELD with no re-send, no-ack never delivered, out-of-window
denied before provider call). On merchant approval the row flips
`SEND_PENDING/DRAFT_APPROVAL` + outbox `PENDING` (one transaction) → reconciler/inline
`deliverViaMetaIfApplicable` → `SENT` + durable `provider_message_id` + `provider_accepted_at`.

> The live approval→send completion is recorded in the companion assessment
> `prod-evidence/assessments/META_LIVE_PAGE_MESSAGE_VERIFICATION.md` once the merchant approves
> the surfaced draft (the approve UI was previously hidden by this very attestation flag being
> `false`; raising it surfaces the draft for approval).

## Attestation decision

- Raise `platform.ai.auto_reply.production_verified` → `true` (full live AUTO lifecycle above).
- Raise `platform.ai.draft_reply.production_verified` → `true` (live DRAFT generation + merchant
  review above; approval→send contract-verified PR #297 + identical live-proven provider path).
- `lastVerifiedAt = 2026-11-22`; evidence pointer = this receipt.
- **Preserved:** enforce mode; fail-closed for every unverified claim; evidence-authority manifest
  coverage; `deepFreeze`; tenant isolation; grounding fabrication guards; 24h-window policy;
  duplicate-send prevention; three Meta permissions; `["messages"]` core subscription; Stage 2
  shadow-only; qualified reader-safe rollback floor; paired deployment contract; immutable image
  provenance. No security or release guard disabled or bypassed.

**Full evidence packet:** `prod-evidence/assessments/META_LIVE_PAGE_MESSAGE_VERIFICATION.md`.