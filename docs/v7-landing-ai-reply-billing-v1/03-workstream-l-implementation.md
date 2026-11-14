<!-- HISTORICAL RECORD -->
# Workstream L — V7 Landing Enhancement (V6 Surgical)

> **Historical record.** ADR-0011 (2026-11-14) supersedes the commercial terms
> referenced in this document. Keep it for audit; do not render or copy its
> subscription/plan terms.

Status at this checkpoint: IMPLEMENTED in isolated worktree; local gates pass; PR/merge/deploy pending.

## Scope decision

Keep the shipped V6 React/Vite public surface. Do not replace it with the Qwen static page. The prototype's hero/product-OS promise is not supported by current Messenger-only capabilities; its statistics, testimonials, prices and demo-success form are explicitly placeholders. The work is a small copy/order/accessibility/connection-trust enhancement to the deployed V6 funnel.

## Changes

- Rewrote the V6 hero to the Founder V3.1 Moderator-first **PILOT** message: "Focus on selling. Let your Moderator help with customer questions and order work." The existing `Create a Shuru account` CTA, pricing catalog, locale-routing and signup route are unchanged.
- Reordered the proof flow from Hero → Core Capabilities → Workflow to Hero → Workflow → Core Capabilities → Story → Trust/FAQ → live Plan Comparison → Closing.
- Added an EN/BN FAQ explaining Facebook Login, Page picker, exact scopes (`pages_show_list`, `pages_messaging`, `pages_manage_metadata`), selected-Page behavior, no Instagram/ad scopes and retry/setup fallback. It does not claim Meta review is approved or in progress.
- Expanded the reply-mode FAQ without changing behavior: Manual/Draft/eligible Auto, drafts remain unsent until an authorized person sends, Meta message window still applies.
- Clarified after-signup setup: Dashboard → Settings → Chat → Facebook Login → in-app Page picker.
- Preserved current catalog and conversation allowance copy (not AI-reply credits), server data and fail-closed behavior. Shared `hasRequiredPublicPlans()` now also makes the standalone Pricing page fail closed if any of SHURU/GROWTH/PARTNER is absent.
- Fixed `combineLocale` to deep-merge with app-locale precedence on shared keys and public-only additions retained; public marketing bundle remains public-only. This preserves authenticated production pricing copy.
- Added a keyboard skip link with a persistent `aria-controls` mobile-navigation target and sticky-header scroll margin on Landing/Pricing main targets.
- Improved public language-toggle contrast (inactive label) and restored Hind Siliguri from production.
- Replaced the unverified Meta App Review status wording in linked Privacy/Terms pages with account/Page authorization availability language. No processing rights, gateway functionality or customer contract were changed; document dates updated.
- Follow-up review corrections align Privacy/Terms to source behavior: AI provider and cross-border handling is conditional on provider configuration and routing; submitted payment screenshots may reach Gemini and OpenAI through OCR fallback; Slack/Sentry general alerts are distinct from guardrail webhooks; bKash is described only as optional platform subscription billing; direct bKash/Nagad transfers are merchant-verified.
- Removed the unsupported web-chat collection claim, updated page/social metadata to Messenger-first positioning, clarified the Bengali Page-access eligibility sentence, and bound the public Playwright server to loopback.
- Added an isolated Playwright public-funnel config with local-only API fixtures and explicit blocks for production API/app origins. It tests desktop/tablet/mobile, locale switching, catalog fail-closed, Partner phone validation, synthetic signup/payment-gated growth intent, legal status copy, skip target and Axe WCAG 2.1 A/AA.
- Added E2E assertions for conditional AI providers, alert sinks, gateway/billing scope, legal status and Bengali access eligibility. The latest public run captured 10 screenshots under ignored `EasyMod-frontend/test-results/v7-public-funnel/`.
- The CI public Playwright job uploads the synthetic V7 screenshot set as `v7-public-funnel-screenshots-<run-id>` so the PR can link the review artifact without checking binary screenshots into the repository.
- The protected `release.yml` `target=probe` path reports only live conditional integration states and digest-pinned image refs; secret values are never printed. Use this read-only receipt to verify current AI, bKash, guardrail, Slack, and Sentry settings and capture pre-deploy rollback digests.
- CI adds that public test lane to the existing frontend Playwright job; existing gates are unchanged.
- Existing protected tests were not weakened. Two async test setup stabilizations await already-asserted data (resolve `last_seen_message_id`, invoice-cancellation status); the behavior assertions remain unchanged.

## Validation receipts (local)

| Gate | Result |
|---|---|
| TypeScript `tsc --noEmit` | PASS, 0 errors |
| Frontend Vitest | PASS, 733 tests / 0 failures in the initial implementation run (local-only API stub on 127.0.0.1:3000; not rerun after legal-copy-only follow-ups) |
| Public Playwright | PASS, 8/8 on the latest follow-up (synthetic route fixtures only; 10 screenshots captured) |
| Axe | PASS, 0 WCAG 2.1 A/AA violations on Landing/Pricing in EN and BN |
| Protected merchant Playwright | PASS, 33/33 on CI-matching local origin after auth-fixture stabilization (not rerun after legal-copy-only follow-ups) |
| TypeScript `tsc --noEmit` | PASS, 0 errors on latest follow-up |
| Production Vite build | PASS on latest follow-up; LandingPage chunk 16.10 KB / 4.18 KB gzip; existing Zod/Rollup annotation warnings only |
| `git diff --check` | PASS (line-ending warnings only; no whitespace errors) |
| Backend/mobile/runtime source diff | NONE for Workstream L |

## Remaining gates

- Final independent worktree recheck: no remaining findings. Production configuration remains unverified.
- Verify actual production `BKASH_ENABLED`, AI-provider, Slack/Sentry, and guardrail-webhook settings before describing their live status. The payment-evidence OCR helper is not currently called by the checkout flow and remains disclosed conditionally.
- PR/required CI, merge, frontend-only protected release (backend digest remains `fb3ce2ae…`), live screenshots + `/api/version`/catalog/auth/health checks. No commit, PR, merge, or deployment has been made.
- Do not claim a conversion win: the copy is a hypothesis to pilot with unaided comprehension and qualified signup metrics. Use existing funnel analytics only; no new PII fields.
