<!-- HISTORICAL RECORD -->
# V7 Preflight Evidence Ledger

> **Historical record.** ADR-0011 (2026-11-14) supersedes the commercial terms
> referenced in this ledger. Keep it for audit; do not render or copy its
> subscription/plan terms.

Audit date: 2026-10-31. Source branch: `feat/easymod-unified-landing-v7` at `39ac79793215bcf1b5f25bc0ad9034b50928bd4f`.

## Baseline

| Claim | Evidence | Status / decision |
|---|---|---|
| Current main | `gh api repos/mr3826/easymoderator-monorepo/git/refs/heads/main` → `39ac79793215bcf1b5f25bc0ad9034b50928bd4f`; isolated V7 worktree is clean at that SHA. | Verified |
| Live backend | `GET https://api.easymod.tech/api/version` → backend Git SHA `068e4f9c…`, build time `2026-10-30T23:16:13Z`; `GET /health` → `ok`, commit `068e4f9c…`. The current main is newer than the deployed backend. | Verified; don't claim main==deployed backend |
| Migrations | Live version reports 66 migrations. Source's latest migration is `20261026_001_order_idempotency_unique`; no database credentials or live migration ledger query was used. | Count verified; live schema consistency not independently verified |
| Production deploy guard | `PRODUCTION_DEPLOY_ENABLED=false` (repo variable API). No V7 deploy dispatched. | Verified off |
| Other production flags | Production renderer defaults payment/AI-integration opt-ins off (`render-production-env.js`); current effective droplet environment values are not externally observable from the API. | Source default verified; effective runtime values otherwise unknown. V7 payment-claim flag must default off. |
| Live public catalog | `GET https://api.easymod.tech/api/subscription/plans` on 2026-10-31: SHURU ৳0/100 conversations; GROWTH ৳999 monthly / ৳9,990 yearly / 500 conversations; Growth top-ups remain 100/300/700 conversations at ৳250/500/1,000; PARTNER is per delivered order with 300–999 at ৳15/order, 1,000–2,999 at ৳12, 3,000+ at ৳10. | Verified at runtime; supersedes stale V6-release report quoting ৳2,499 |
| Supported channel | `README.md:24-30`; `subscription.plans.js:56-72`: Facebook Page Messenger true; Instagram, webchat, Telegram, comment automation and campaigns false. | Verified; no other channels advertised |
| Current UX safety | `README.md:29-32`; `LandingPageV6Sections.tsx:28-61` marks illustrative Messenger/Draft/order states and says draft is not sent / order is not confirmed. | Verified in source/live V6 evidence |
| Billing spec file | Searched `C:\Users\ahmee\OneDrive\Documents` and repo for “AI Reply Credits”, “Transaction-ID Billing”, “300 AI replies”, “reply credits”; no separate V1 file found. The active user mandate supplies the provisional behavior and target values. | Missing standalone artifact; proceed only with prompt-specified rules and keep commercial activation gated |

## Prototype Claim Register

Prototype: `C:\Users\ahmee\OneDrive\Documents\EasyModerator-v1.01\New folder\Qwen_html_20261031_4ffycsorc.html`. Prototype sections explicitly label data, metrics, testimonials, pricing and lead form as placeholders/sample UI (`843-865`, `916-927`, `1130-1227`, `1285-1437`).

| Claim / feature | Evidence | Decision |
|---|---|---|
| “BikroyOS”, full commerce OS / “ads to profit” / all-in-one | Conflicts with master brand and narrow launch scope. `README.md:24-38`; BrandForge V2 says the future Growth Pilot/Storefront are hypotheses (`28-45`, `84-93`); Founder V3.1 says current Moderator job first (`66-88`). | Reject replacement brand and full-prototype replacement |
| Instagram, WhatsApp, ads/ROAS, Storefront/checkout, Meta pixel, broad reconciliation | Not available/enabled per plan flags and README. Merchant product catalog is not a buyer storefront. No campaign-spend-to-delivered-order attribution is evidenced. | Do not advertise |
| 2.4x ROAS, fraud reduction, more confirmed orders, sample dashboard values, sample testimonials | Hardcoded prototype values and placeholders; no merchant outcome/causal evidence. No live spend-to-delivered-order attribution. | Reject as public claims; no fabricated stats/testimonials |
| Prototype prices/packages/demo success form | HTML marks pricing and reviews as placeholders; demo form only prevents default, displays local success, and resets (`1285-1437`). Current server catalog is authoritative. | Reject prototype prices/form. Keep API-driven catalog and real signup |
| Messenger-first Moderator entry | Matches README-supported current job and V6's truthful sample flow. Founder V3.1 hero is expressly a test candidate, not validated winning copy (`70-88`, `103-117`). | Pilot a more immediate Moderator-first V6 hero; retain actual signup route and account/setup explanation |
| Mobile nav/sticky CTA | V6 has a keyboard-operable mobile menu; prototype fixed bottom bar can cover controls and its menu is absent. | Retain V6 menu; do not add sticky CTA without a controlled mobile usability pilot |
| Meta access/review status | `docs/meta-app-review.md:4,10` (2026-08) says access verification submitted/in review; `docs/testing/META_E2E_TEST_SETUP.md:182-233` says `is_live=false`, App Review `UNSUBMITTED`, dev-mode, and Page scopes unavailable to non-app-role accounts; the 2026-09-22 production proof says Live and permission-approved. No authenticated Meta status was inspected. | Conflict remains in source evidence. V7 landing/FAQ and Privacy/Terms now use account/Page eligibility wording only; the “review is being completed” claim was removed without asserting approval or a new review state. |

## Existing Billing Contract and Behavior

| Claim | Evidence | Decision |
|---|---|---|
| SHURU/GROWTH current allowance is conversation windows | `subscription.plans.js:114-160`; public API above. | Keep existing entitlement untouched |
| Current meter runs on inbound conversation creation/24-hour-window logic | `meta-webhook-events.handler.js:946-1051,1194-1257`; `subscription.service.js:430-632`. It meters before AI reply generation and uses conversation UUID/idempotency. | Not reusable as an AI reply meter |
| Top-ups are conversation units | `subscription.plans.js:33-53`; `topup.service.js`; `BILLING_OPERATIONS.md:33-48`. | Never convert balance 1:1 into AI replies |
| Model calls/cost differ from merchant-facing reply events | `AI_COST_AUDIT.md:47-68,70-105`; `AI_COST_MODEL.csv`; `AI_COST_ASSUMPTIONS.md:107-165`. One conversation can generate several LLM calls; deterministic paths can make zero calls; drafts can incur provider cost without send. | Separate internal model-cost controls from reply-credit ledger |
| Historical per-shop AI replies and P50/P90/P99 | Existing `ai_response_count` counts candidates/drafts, not Meta-accepted replies; provider usage recorder is disabled/weakly wired (`usage-recorder.service.js`, `AI_COST_AUDIT.md:671-684`). No production database/historical export was available or queried. | Cannot claim historical reply distribution, profitability at 300/3,000, or grandfathering impact. Shadow first; B2 activation BLOCKED |
| Existing transaction-ID subscription flow | Invoice checkout uses provider payment IDs verified server-side (`invoice-payment.service.js`); manual order review is separate. `TrxIDLog` is shop-scoped; OCR is evidence only and not independent settlement. No subscription payment-claim route/entity/workflow exists. | New isolated, audited claim state; do not reuse order OCR or bKash completion path |
| Lawful receiving-account ownership / independent finance operations | Not demonstrated by repository/runtime evidence. No payment transaction attempted; no receiving account or credentials inspected. | B3 implementation may be dark/flagged off; activation BLOCKED until independent human/finance verification |

## Inputs and Review Notes

- BrandForge V2 is a strategy/persona document, not a release/visual rebrand approval (`lines 1-16`). It says the DM-to-order job first and calls Growth Pilot/Storefront hypotheses (`28-45`, `84-93`).
- Founder V3.1 explicitly says Moderator-first hero wording is a test candidate, not market-validated (`70-88`, `103-127`). The proposed 12–15 merchant comprehension/activation pilot is not evidence that the pilot happened (`107-117`).
- The separate “AI Reply Credits & Transaction-ID Billing V1” file was not found; this preflight uses the explicit current user mandate as the provisional behavior contract, not historical draft docs.
- No secrets, live payment credentials, transaction IDs, customer data, or production database records were accessed.

## Lane Gates

- **L:** GO for a small V6 enhancement with verified Moderator-first copy, connection/control clarification, accessible skip/anchor behavior, correct bilingual promise, API-driven current prices, and no prototype claims. Message-market fit remains PILOT.
- **B1:** GO for additive ledger in shadow mode, no legacy counter/top-up mutations and no gate on sends. Use a distinct table/state protocol; measure before enforcing.
- **B2:** BLOCKED for quota activation: no historic per-shop reply distribution, paid cost per reply, or grandfathering decision is available. The 300/3,000 numbers remain proposed shadow comparators only.
- **B3:** BLOCKED for live money: no independently verified lawful recipient account, verification source, finance staffing, or dispute/reversal operations evidence. Code/UX may be deployed dark only with strict flag-off and no payment instructions when disabled.
