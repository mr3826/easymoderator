<!-- HISTORICAL RECORD -->
# EasyModerator Founder Pilot v1 Decision Ledger

> **Superseded in full by [ADR-0011](adr/0011-delivered-order-commercial-contract.md)**
> (2026-11-14). The 2026-11-01 commercial ledger recorded below — subscription
> plans, conversation allowances, top-up packs, and Partner order bands — is
> historical record only. The sole current price authority is
> `EasyMod-backend/src/modules/commercial/commercial.contract.js`. Do not copy
> these terms into merchant-facing copy.

**As of:** 2026-11-01
**Implementation base:** `main` at `84a5c528cac719147805c3f8cbee5fb6f3b1846c`
**Release status:** implementation and verification in progress; production has not been changed by this work.

## Authority And Evidence

The founder's implementation/deployment prompt in the project conversation is the source of truth for this increment. The specifically named `EasyModerator_Founder_Pilot_Packages_Addons_Implementation_Deployment_Prompt.md` was not present in the candidate repository checkout. The prompt itself supplies the mandatory Bangla hero ambition and five pain statements; no additional founder-copy file was found. Existing V7 source, billing contracts, tests, repository skills/persona context, CI/CD controls, and live production probes were inspected. Earlier roadmap exclusions are superseded by the founder's explicit Ads Studio and Storefront decisions; they remain historical technical evidence, not authority to replace the chosen commercial direction.

The live backend reports `068e4f9cc5a4abd02c477164a92e923263adfd24`; `/health/ready` reports `ready` with database and Redis connected. The last observed production cutover was run `41250257588` on source SHA `84a5c528cac719147805c3f8cbee5fb6f3b1846c`: backend image `ghcr.io/mr3826/easymoderator-backend@sha256:fb3ce2ae3606ad28c75cc8c0409d2052d61812ec6487041bcc5c41107ca8190e`, frontend image `ghcr.io/mr3826/easymoderator-frontend@sha256:d5d3e3716c00c35f3571a4eb69af3dcb5671052746c0d61fbf49a9301164ffb1`. The later successful run `41250939064` was a deployment-configuration dry run; image build/publish and production deploy jobs were skipped. The public catalog exposed SHURU's 100 and GROWTH's 500 Messenger-conversation allowances, GROWTH at BDT 999/month with conversation top-ups, and delivered-order Partner billing. `BKASH_ENABLED=false` and `PRODUCTION_DEPLOY_ENABLED=false`. The Page OAuth flow did not request `ads_read` or `ads_management`. These active terms and flags remain unchanged unless a later protected release explicitly changes them.

GitHub `main` requires strict `PR Merge Gate` and `Security Scan` checks with admin enforcement. The production environment has a protected-branch policy; its current API configuration does not list a required human reviewer. No policy was changed. Production deployment still requires `PRODUCTION_DEPLOY_ENABLED=true` and a one-shot `DEPLOY-<full-main-sha>` input; the release workflow is the only authorized path, and the variable must be restored to false afterward.

## Commercial Mapping

| Founder-facing package | Compatibility ID | Founder target | Existing active terms retained during shadow validation |
| --- | --- | --- | --- |
| Get Your Moderator | `SHURU` | 300 monthly support units | 100 Messenger conversations/month; no new charge or send limit from the candidate reply target |
| Moderator Plus | `GROWTH` | 3,000 monthly support units, with top-ups | BDT 999/month, 500 Messenger conversations/month, and existing top-ups of 100/300/700 conversations at BDT 250/500/1,000. Top-ups remain conversation credits only. |
| Partnership | `PARTNER` | No upfront subscription; billed by delivered orders | Existing delivered-order rate bands remain unchanged: 300–999 at BDT 15/order, 1,000–2,999 at BDT 12/order, and 3,000+ at BDT 10/order, subject to existing invoice and qualification rules. |

The public catalog keeps founder-facing names while preserving internal IDs and current conversation entitlement values. `support_reply_allowance` identifies 300/3,000 as `shadow_only`, `billable:false`, and `enforced:false`. The active billing UI shows the existing conversation contract and conversation-only top-ups separately. No historical conversation credit is migrated or renamed.

## Support Unit Contract

The shadow candidate unit is **one logical AI-originated outbound reply accepted by Meta and durably recorded by EasyModerator**. A logical reply can produce multiple provider message IDs but counts once through its logical-turn idempotency key. The implementation records `AUTO` replies and AI drafts sent through the explicit `DRAFT_APPROVAL` path only after provider confirmation. Incoming messages, conversations, unsent drafts, failed sends, and human/HITL messages are not units.

Shadow periods are half-open UTC calendar months `[month_start, next_month_start)`, distinct from existing subscription invoice periods. The platform gate activation timestamp prevents historical backfill. Ledger rows are append-only, shop-scoped, one-unit events with a unique idempotency index, hashed event key, acceptance time, plan code at acceptance, and reply source; message bodies and customer identifiers are not stored. Duplicate retries converge on the same event. A storage/gate failure cannot reject an already accepted customer message; retryable worker/outbox recovery uses the durable provider-confirmed state. The meter never authorizes a charge or blocks a message.

The current implementation is shadow-only. Database writes for the ledger row are atomic and idempotent, but the external Meta acceptance and local database commit cannot share a transaction; correctness relies on the existing durable message/outbox state and retries. Exhausted retries can leave an observation gap, so the shadow meter is not sufficient evidence to activate billing. Required recovery evidence is listed below.

The 300/3,000 reply targets do **not** activate billable reply-credit top-ups. Existing GROWTH top-ups continue to represent Messenger conversations until the founder's reply-unit pricing, pack amounts, notices, renewal transition, and historical entitlement rules are approved and verified.

## Add-On Contracts

The public API catalog exposes exactly two separately labeled optional add-ons. `price_bdt_monthly` is `null` and `billing_terms` is `not_activated`; no price or charge is invented. Access requires a SUPER_ADMIN-controlled per-shop pilot eligibility flag and an owner/admin opt-in. Both gates default off, and disabling a platform gate denies access immediately. A merchant can disable its add-on without affecting other shops.

### EasyModerator Ads Studio

- Working path: import a merchant-supplied Meta CSV, mark it unverified, inspect imported campaign metrics, receive deterministic report-grounded suggestions, create/edit a draft, then explicitly approve the internal draft with an audit record.
- No direct Ads API/account connection is claimed. This pilot does not request or use `ads_read` or `ads_management`.
- Official Meta Marketing API authorization guidance (Context7, checked 2026-11-01) states that report reads require `ads_read` or `ads_management`, while writes require `ads_management` and write access to the ad account. Access to other people's ad accounts requires advanced access; the Marketing API Access Tier is also listed for report-reading and management use cases. None of those grants is assumed here.
- Approval does not publish a campaign or change spend. No ROAS, EasyModerator-order attribution, revenue, or profit calculation is claimed. No Messenger promotional broadcasting is provided.

### EasyModerator Storefront

- Working path: select existing shop products/variants, publish/unpublish a shop-isolated storefront, browse the current catalog, submit a validated COD order, and receive that order in the existing merchant workspace.
- Price, stock, variants, customer, and order state continue to use the existing authorities. No separate inventory or customer ledger is introduced. Checkout uses an idempotency key bound to a payload hash; changed-payload key reuse is rejected. Stock validation/decrement uses the existing order transaction and row locks.
- COD is the only payment mode. No online payment verification, courier automation, delivery promise, or Meta catalog sync is claimed.
- Storefront does not add an add-on charge. Existing Partnership delivered-order invoicing remains authoritative for a storefront-originated order if and when the merchant's existing workflow marks that order delivered.

## Dissent And Decisions

| Reviewer / role | Dissent or uncertainty | Decision owner | Release implication |
| --- | --- | --- | --- |
| BazarLens + FieldFounder | Repository/production evidence does not prove merchant willingness to pay, additive value, or positive margin for the new reply targets or either add-on. No structured merchant interviews, CAC, support-cost distribution, or add-on cost model were supplied. | Founder | Preserve the chosen packages/add-ons. Do not fabricate ROI or pricing. Collect pilot evidence before billing or add-on price activation. |
| Billing Architect | Existing customers bought conversation entitlements; changing those to reply units or treating old top-ups as reply credits would alter contracts and risk accounting drift. Reply top-up prices and transition/proration terms are unspecified. | Founder for commercial terms; Engineering for safe mechanics | Separate UTC shadow ledger; do not bill, enforce, convert history, change Partner rates, or sell reply top-ups until explicit terms and boundary tests pass. |
| Meta Specialist | Current Page OAuth evidence does not grant Ads read/manage permissions, so direct account dashboards, campaign mutation, and spending controls are unauthorized. | Founder for future Meta authorization; Meta/app review for permissions | Ship only manual report import and internal drafts. Direct Ads API integration remains disabled and unclaimed. |
| Commerce Architect | COD orders can reuse existing products, variants, inventory, customers, and order service, but payment receipt, courier handoff, and delivery are not integrated. Stock races and duplicate submissions need server-side protection. | Founder for scope; Engineering for correctness | Deliver COD-only pilot; do not claim online payment, courier dispatch, delivery completion, or cash reconciliation. |
| MomentumUX / BrandForge | The “ads to profit” aspiration is not supported by operational attribution data. Mobile next actions must not imply guaranteed fraud prevention or completed cash reconciliation. | Founder | Adapt hero to “বিজ্ঞাপনের রিপোর্ট থেকে সিদ্ধান্ত” while preserving the ambition; show limitations and actions for all five pains. |
| Security, QA, SRE | Add-on/shadow endpoints must fail closed on denied/unavailable reads, scope tenant data, protect public checkout from duplicate/concurrent requests, and preserve schema constraints on both migration and wipe/bootstrap paths. | Engineering and repository owners | Default all pilot flags off, require owner/admin selection, use Redis-backed public rate limits, apply migrations before marking history executed, and preserve protected release controls. |

The dissent does not replace the founder's commercial decision. It limits unsupported claims, charges, permissions, and activation until evidence exists.

## Independent Review Findings And Resolutions

- Landing/package review found missing Bengali shadow/add-on pricing translations; EN/BN copy and a Bengali pricing test were added.
- UI re-review found the V7 landing still rendered the legacy static plan-only block; it now uses the live plan and add-on catalogs and the browser test asserts exactly three packages plus two add-ons. A follow-up drift review found local descriptions/fallback values could mask a missing API contract; public and merchant billing surfaces now fail closed unless public names, bilingual descriptions, current fields, and the approved non-billable shadow allowance are present in the live catalog.
- Ads Studio review found a concurrent same-file import race; the service now recovers a duplicate after the losing transaction rolls back and re-reads the committed report, with concurrency tests. The review also found the destructive `sequelize.sync`/`seed-as-executed` bootstrap could mark Ads constraints applied without creating them; idempotent constraint repair now runs through the founder migrations before migration history is seeded.
- Gate review found test behavior did not match production behavior; Ads and Storefront use strict pilot-feature reads and the shared owner/admin add-on assertion.
- Storefront review found process-local public rate limits; production now uses the shared Redis store when configured, with store errors failing closed. Current production compose uses one API service; shared storage also prevents multiplied counters if it is scaled.
- Final backend review found that an already-sent AUTO reply could bypass a failed shadow write on retry; the provider-confirmed `provider_send_already_claimed` branch now retries the idempotent meter write before returning. The same review found missing Ads actor foreign keys and source-deletion cascades; importer/creator/approver references are now restricted and approved drafts prevent deleting their report/metric evidence.
- Storefront uses the existing order quota path. The current three plan catalog entries have unlimited order limits, so COD checkout does not create a new add-on charge or a new quota. If a Partnership storefront order is later marked delivered, the existing delivered-order invoice applies exactly once under the existing rate bands.

## Activation Gates

1. The landing/package/catalog release may ship only with current production pricing and entitlements intact and all visible capability claims matched by code in the same merged release.
2. The shadow ledger may ship with recording disabled by default. It does not change messages, invoices, top-ups, or plan transitions.
3. Billable reply-unit activation is **not** approved by this implementation. Blockers include founder-approved unit wording and customer notice, reply top-up prices/pack definitions, renewal/proration behavior, contract migration/grandfathering, proven database/outbox recovery under failures and concurrency, and a verified rollback.
4. Ads Studio's manual-report pilot does not depend on Meta scopes. Any later direct read/write integration requires actual grants, Meta policy review, owner approval, spending safeguards, and audit evidence.
5. Storefront access stays off until an eligible merchant is approved and opts in; checkout remains COD-only. Payments/courier integrations require separate operational/legal verification.
6. GitHub protected checks/environment controls remain authoritative. Never impersonate a reviewer, bypass a gate, deploy a mutable image, or leave the temporary deployment-enable variable on.

## Validation Snapshot

- Frontend build: passed after landing/catalog and merchant pilot UI changes.
- Frontend unit suite: 89 files and 762 tests passed after live-catalog validation and no-fallback billing changes.
- Public Playwright funnel: 8/8 passed with API responses deliberately mocked for UI verification only. It covers the Bangla/English package and add-on cards, 390px/320px layouts, conversion/signup routes, and Axe accessibility checks. Screenshots were captured and inspected in `EasyMod-frontend/test-results/v7-public-funnel/`; these are local test screenshots, not production evidence.
- Backend focused tests: public catalog/gates, shadow idempotency, Ads report/draft/audit paths, storefront tenant/checkout/variant cases, migration/bootstrap guard, worker retry recovery, and existing order/Partner compatibility passed. The latest worker/Ads retention verification passed 5 suites/93 tests; the storefront, catalog, and billing/order targeted suites also passed.
- Full backend Jest run: 333 suites passed, 1 suite failed (4,412 passed, 2 failed, 2 skipped). The failures are in the unchanged `src/modules/ai/grounding/__tests__/grounding-boundary.test.js`: one 10-second timeout in repeated-pressure handling and one existing expectation that `llm.chat` is not called for a no-product context. `src/modules/ai/grounding` has no diff against `main`; this local result is a pre-existing/regression-unrelated test limitation, still to be checked by required PR CI.
- Local commands ran on Node 25.6.1 while the repository declares Node 20.x; required GitHub checks on the configured runtime remain authoritative.
- Local backend tests also emit Redis connection/open-handle warnings because no Redis service is running on the developer machine. Production readiness probes did report Redis connected; pilot rate-limit stores are shared Redis-backed in production and fail closed.

## Evidence Receipt

Recorded 2026-11-01 (UTC) after two bounded, protected production releases. Production environment/branch policy, required checks, and the one-shot deploy confirmation were used as-is; no reviewer was impersonated and no gate bypassed.

### Releases

| Item | Release 1 (pilot implementation) | Release 2 (public add-on CORS fix) |
| --- | --- | --- |
| PR | #230 (squash-merged 2026-11-01T20:11:17Z) | #231 (squash-merged 2026-11-01T20:51:03Z) |
| Merged main SHA | `a473e5a3150eb4b96dd5b178e87b44ff6c0dbc79` | `ab0c958efab03a0214776bdb07c95537eaae828c` |
| Required checks | PR Merge Gate, Security Scan, Quality fast, Backend integration (PostgreSQL + Redis), frontend Playwright, Meta-shaped E2E, Growth OS gates — all pass | Same set — all pass |
| Release runs | push `41345546671` (publish) + dispatch `41345665422` with `DEPLOY-a473e5a3…`, deploy job `124969253270` | push `41348957529` + dispatch `41348979305` with `DEPLOY-ab0c958e…`, deploy job `124978825038` |
| Deployed backend image | `ghcr.io/mr3826/easymoderator-backend@sha256:910119fb784d5ec6ccd16b6f4e3e4e8a672d93af4cba0b00f02891ababafa631` | `ghcr.io/mr3826/easymoderator-backend@sha256:cbb4580797c77ccc2b537536b70b37a56ad78763942c52dbcecfc1b16d6f2ec6` |
| Deployed frontend image | `ghcr.io/mr3826/easymoderator-frontend@sha256:99e1b358a1ef32e370275d101d0c638db2844b299a5eadcfa34bd9d0c59f5bda` | `ghcr.io/mr3826/easymoderator-frontend@sha256:4a82890ca145a37f0c2f96d7b3fe7294f58ed13b5d108ba887b90f58b27db5eb` |

Both deploy jobs recorded `deploy_succeeded=true`, candidate backend health passed, `Version check passed` for the exact merged SHA, and rollback state was written to `/opt/easymod/.cutover-rollback/<run-id>` with the previous image digests.

### Rollback readiness

- Pre-pilot production baseline (first rollback pair): backend `sha256:fb3ce2ae3606ad28c75cc8c0409d2052d61812ec6487041bcc5c41107ca8190e`, frontend `sha256:d5d3e3716c00c35f3571a4eb69af3dcb5671052746c0d61fbf49a9301164ffb1` (source `068e4f9cc5a4abd02c477164a92e923263adfd24`).
- Current rollback pair retained by release 2: release 1's deployed images (`910119fb…` backend / `99e1b358…` frontend), plus the pre-pilot pair above in earlier cutover directories.

### Production verification (live, post-release-2)

- `GET /version`: `gitSha=ab0c958efab03a0214776bdb07c95537eaae828c`, 70 migrations, latest `20261101_004_storefront_cod`.
- `GET /health/ready`: `ready`, database connected, Redis connected (rate-limit client live).
- Plan catalog: `SHURU` → “Get Your Moderator”, 100 conversations, shadow allowance 300 (`billable:false`, `enforced:false`, `utc_calendar_month`); `GROWTH` → “Moderator Plus”, ৳999, 500 conversations, three conversation top-up packs, shadow allowance 3,000; `PARTNER` → “Partnership”, unlimited conversations, three delivered-order bands (৳15/৳12/৳10), no reply allowance. Active entitlements/top-ups/bands are unchanged from the pre-release contract.
- Add-on catalog: exactly two entries (`ADS_STUDIO`, `STOREFRONT`), both `price_bdt_monthly:null`, `billing_terms:not_activated`, `availability:pilot_approval_required`.
- CORS: `Origin: https://easymod.tech` on `/api/public/addons` → 200 with `Access-Control-Allow-Origin: https://easymod.tech`; hostile origin → 403 with no ACAO.
- Fail-closed pilots: unauthenticated `storefront/manage`, `ads-studio/reports`, and shadow-ledger usage all return 401. All new per-shop pilot flags default off; no merchant was enrolled, no flag activated, no Meta scope requested.
- Marketing `https://easymod.tech` and `https://app.easymod.tech/signin` return 200. The live pricing page renders the three founder packages with the non-billable shadow boxes, both optional add-on cards with their limits, and the pilot-terms note; the Bangla landing renders the founder hero and add-on sections.
- Screenshots (real production, Playwright/Chromium): `prod-evidence/release2-check/production-landing-en-1440.png`, `production-pricing-en-1280.png`, `production-landing-bn-390.png`, plus `production-pricing-en-final.png` and `production-landing-bn-390-final.png` (kept off-repo with this run's verification logs).
- `PRODUCTION_DEPLOY_ENABLED` was set true only for each bounded window and restored to `false` at 2026-11-01T21:09:18Z after the final deploy; it remains `false`.
- The unchanged local `grounding-boundary` timeout did not reproduce in CI: the required `Quality fast` and `Backend integration` checks passed on Node 20.x for both releases.

### Known blockers (unchanged by deployment)

1. Billable 300/3,000 reply-unit activation: founder-approved customer terms, reply top-up pricing/pack definitions, renewal/proration, customer notice, and contract migration/grandfathering remain undecided; conversation entitlements/top-ups stay authoritative.
2. Direct Meta Ads integration: `ads_read`/`ads_management` are not granted; Ads Studio stays manual-report-only until app review/advanced access and spending safeguards exist.
3. Storefront payments/courier: COD only; online payment verification, courier automation, catalog sync, and cash reconciliation stay unclaimed.
4. Market evidence: willingness-to-pay, support-cost distribution, and add-on ROI data for the pilot cohort are still to be collected; pilot flags stay off until per-shop approval and owner/admin opt-in.
