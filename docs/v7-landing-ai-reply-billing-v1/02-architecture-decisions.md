<!-- HISTORICAL RECORD -->
# V7 Architecture Decisions (Pre-Implementation)

> **Historical record.** ADR-0011 (2026-11-14) supersedes the commercial terms
> referenced in this document. Keep it for audit; do not render or copy its
> subscription/plan terms.

Status: accepted for implementation in **Landing L** and **Billing B1 shadow / B3 disabled**. B2 entitlement activation and B3 live-money activation remain blocked pending evidence gates.

## ADR-L1 — Enhance V6 rather than replace it with Qwen HTML

### Context

The live V6 funnel is React/Vite, bilingual, route-aware, server-catalog driven, with an illustrative Messenger → grounded draft → review flow. The uploaded single-file prototype is a static design artifact and explicitly marks its prices, impact numbers, testimonials, dashboard data and demo lead form as sample/placeholders. Its prose markets capabilities currently out of scope (Instagram, ads/ROAS, Storefront, reconciliation).

### Decision

Keep the V6 component, design-token, routing, locale, signup, analytics, and catalog architecture. Apply a small “Hook → Reality Check → Grounded Promise” rewrite on the existing first screen, improve Page-connection/control explanations using verified Meta and reply-mode behavior, restore accessibility gaps (skip target/anchor offset if needed), and correct the founder brand signature in both locales. Keep live plan cards and signup unchanged. Do not add fake statistics, reviews, demo submissions, sticky mobile CTA, new navigation, or unsupported product claims.

The hero headline/copy is a **PILOT message candidate**, not a proven winner. Preserve the CTA that leads to the actual Shuru signup; measure qualified activation/retention through existing consent-safe funnel events rather than claiming conversion lift.

### Alternatives considered

- Full Qwen HTML replacement: rejected; hardcoded placeholder prices/outcomes, non-submitting form, unsupported product breadth, no V6 routing/i18n/accessibility integration, and a conflicting “BikroyOS” identity.
- Add a fixed mobile CTA: rejected for now; existing mobile menu is available, but persistent CTA may obscure consent/controls and has no evidence of incremental benefit.
- Do nothing: rejected because the current V6 hero is truthful but less immediate than the founder's Moderator-first entry hypothesis, and the mobile accessibility/anchor friction is verifiable.

### Consequences

- Existing pricing, signup behavior, and conversion instrumentation remain authoritative.
- Copy changes are reversible and can be A/B tested later; no efficacy claim is made until a properly sampled pilot meets the stated comprehension and qualified activation gates.
- BrandForge V2/Founder V3.1 are strategy/experience contracts, not proof of market validation or permission to rebrand/reprice.

## ADR-B1 — Dedicated AI-reply event ledger; shadow first

### Context

The existing `usage_events` resource enum is `conversations|orders|products` and `trackUsage()` is invoked by conversation-window metering before AI reply generation. Existing top-up balances are conversation units. `ai_response_count`/AI provider-cost metadata count candidates/provider calls, not one logical AI reply accepted and durably recorded. Reusing any of these would silently change customer contracts or miscount drafts/retries.

### Decision

Add a separate, tenant-scoped `ai_reply_ledger` with a stable, per-logical-reply idempotency key and state transitions:

```text
RESERVED -> COMMITTED
RESERVED -> RELEASED
RESERVED -> AMBIGUOUS -> COMMITTED | RELEASED (only after reconciliation)
```

- Reserve once per logical AI-originated reply before the send boundary; draft generation may create a shadow reservation but is not billable.
- Commit only after Meta accepts the send **and** the outbound result is durably recorded. One logical reply split into multiple transport fragments remains one ledger row.
- Known pre-acceptance rejection/failure releases the reservation. Timeout, connection loss after request start, partial fragment acceptance, or DB failure after provider acceptance is `AMBIGUOUS`; never blindly release or resend.
- Retries/replays reuse the same key; unique `(shop_id, idempotency_key)` enforces one logical event. Reconciliation uses provider/client send IDs/outbox evidence before final resolution.
- Human replies, inbound messages, provider/model retries, sentiment/retrieval calls, and unsent drafts have zero committed merchant AI-reply credits. Static deterministic responses are separately classified and excluded unless an explicit future contract says otherwise.
- `AI_REPLY_LEDGER_MODE=shadow` observes candidate limit/overage only; it never denies generation/send, modifies `subscriptions`, `usage_events`, or `topup_balance`, nor changes Manual/Draft/Auto behavior.
- Shadow period key uses UTC calendar month solely for measurement. Activation requires an explicit reset-time contract (and annual-plan monthly windows), customer communication and grandfathering decision; do not use `current_period_end` blindly because annual billing periods exist.
- Proposed Shadow comparison limits: SHURU 300, GROWTH 3,000; PARTNER limit is **unset** and not interpreted as unlimited/new entitlement. No plan UI/catalog/public price is changed.
- Missing/corrupt plan data yields `unknown/not-enforced` in shadow and must fail closed if a later enforcement mode is explicitly approved.
- Existing conversation counters/top-up packs and historical `ai_response_count` are never converted into reply credits. Legacy entitlements remain untouched.

### Alternatives considered

- Extend `usage_events`/`trackUsage`: rejected because it meters the wrong event, mutates existing conversation entitlements and has no pending/ambiguous send lifecycle.
- New generic billing platform: rejected as overbuilt; a narrow tenant-scoped ledger plus existing subscription/invoice infrastructure meets the verified need.
- Post-send-only audit log: rejected because it cannot model retry concurrency, draft approval, reservation ambiguity or future quota atomicity.

### B2 activation gate

Current cost documents are scenario/provider-cost models per conversation, not historical per-shop AI-reply distributions. No production database or historical export was available/queried. Before B2: replay a consented/anonymized historical sample; establish P50/P90/P99 replies per conversation and cost per accepted reply; compare proposed limits against real existing users, yearly Growth contracts and Partner; decide grandfathering and user-visible reset period. Until then B2 remains `DEPLOYED-FLAG-OFF` or shadow-only, never `ACTIVE`.

## ADR-B3 — Separate transaction claims from verified settlements

### Context

Existing subscription invoices use provider-issued bKash payment IDs and server-side provider verification. Existing order/mobile-money transaction references and OCR review belong to merchant order payments; they are not proof of a subscription receipt and are not independent settlement controls. No repository evidence establishes a lawful subscription receiving account, independent statement source, finance staffing, or dispute/reversal runbook.

### Decision

Implement (if all checks pass) an isolated, tenant-scoped subscription `payment_claim` workflow, reusing invoice identity and admin authorization but **not** the bKash completion function or order-transaction OCR path. A claim records provider, server-selected verified receiving-account identifier, invoice/shop, exact amount in minor units/currency, normalized reference (plus a provider/account-scoped unique reference digest), submitted transfer time, minimal evidence pointer, idempotency key and status. Settlement is a separate immutable record/event linked to one accepted claim/invoice. The service requires an independent finance reviewer, exact amount/currency/payee/reference/provider-time match from an authorized provider source, reviewer/reason/audit evidence, and one-time atomic invoice/entitlement settlement. Provider/account/reference reuse across invoice/top-up/shop is rejected globally.

Statuses: `PENDING_VERIFICATION`, `REJECTED`, `VERIFIED`, `SETTLED`, `REVERSED`, `DISPUTED`. A screenshot or user-entered transaction ID alone can only create a claim; it cannot create a verified payment or activate entitlement. Do not collect PINs, OTPs, credentials or unnecessary PII. Receiving-account data must be supplied by protected runtime configuration and absent from source.

Feature flag defaults OFF; disabled endpoint exposes no payee instructions and returns the existing safe unavailable/disabled contract. Existing bKash gateway checkout remains unchanged. Code may be deployed disabled; no live collection, test transfers, settlement, or activation occurs until ownership/lawfulness, independent reconciliation source, authorized finance operations, fraud/dispute controls, and rollback are evidenced.

### Alternatives considered

- Reuse order `TrxIDLog`/OCR: rejected (wrong entity/uniqueness scope, not independent provider verification, and not tied to subscription invoice settlement).
- Treat screenshots or an ID as proof: rejected (user-controlled and replayable).
- Enable a generic manual payment button now: rejected (no verified recipient account or independent operations evidence).

## Release decision

Landing L may ship independently using the existing frontend-only lane after tests/review. B1/B3 code requires backend migrations/API/workers and therefore a separate protected `target=all` release (backend+frontend artifacts from the exact merged SHA) with backups, migration/rollback verification and flags configured to `AI_REPLY_LEDGER_MODE=shadow`, `AI_REPLY_CREDITS_ENFORCEMENT=false`, `SUBSCRIPTION_TRANSACTION_CLAIMS_ENABLED=false`. B2/B3 activation requires separate explicit evidence gates; production payment collection stays disabled.
