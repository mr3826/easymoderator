# 01 — Payment Settings Feature / Field / Flow / Test-Pin Preservation Matrix

A1 (as-built audit), 2026-11-26. Worktree `D:/easymod/_wt-payment-20261126`; all
`BE/…` = `EasyMod-backend/…`, `FE/…` = `EasyMod-frontend/…`. Binding input:
`docs/payment-redesign/00_PAYMENT_DATA_CONTRACT.md` (incl. A0 ratification D-1…D-10, R-11…R-15).
Sources audited: legacy page `FE/src/app/components/PaymentSettings.tsx` (760 ln), the new
payment module on disk (`BE/src/modules/payment/`, `FE/src/app/components/payment-settings/`),
legacy vitest suites, `FE/tests/e2e/payment-guardrails.spec.ts` + `payment-settings.spec.ts`,
migrations `BE/src/database/migrations/20261127_001|002`, reference mock
`C:/Users/ahmee/Downloads/new/Qwen_html_20261124_mr27zvyvq-4.html` (VISUAL ONLY — see §I).

**Reviewers reject the PR if a KEEP/CHANGE row is silently dropped.** Rows are the contract's
own scope: the two settings tabs + their API + the pins that guard them. Anything the contract
declares untouched is listed in §H with "untouched" so nobody re-decides it here.

Legend — **Status**:
`KEEP` verbatim · `KEEP+UI` same behaviour, re-presented in the new surface ·
`CHANGE` shape/wording/path altered, test *intent* preserved (migration stated) ·
`REPLACE` mechanism swapped (old dies deliberately; successor named) ·
`REMOVE` deleted per contract row · `NEW` capability the contract ratifies that the old UI never
exposed (flagged NEW so reviewers do not call it invented).

---

## A. Page shell & header

| # | Existing capability (source) | Status | Lives now / notes |
|---|---|---|---|
| A1 | Route `/manage-shop/payment-settings` (FE `src/app/routes.ts:211` mounts legacy `PaymentSettings.tsx`) | CHANGE | Must mount `FE/src/app/components/payment-settings/PaymentWorkspace.tsx`. **As-built gap:** routes.ts still points at the legacy page (one-writer rule; swap owned by integration). |
| A2 | Execution-class `PageHeader` (title + dominant signal + factual pills, **no header CTA**, §29) — `PaymentSettings.tsx:455-469`, e2e `payment-guardrails.spec.ts:144-152`, vitest `PaymentGuardrails.test.tsx:82-90` | KEEP | `PaymentWorkspace.tsx:181-200` reuses the same `PageHeader` + `derivePaymentSignal` (`payment/derive.ts` unchanged); `signalTestId="payment-signal"` preserved. |
| A3 | Header pill "Enabled methods: N" (`enabledMethodsLabel`) | KEEP | `PaymentWorkspace.tsx:189-191` — count semantics unchanged (§7 row 3 note: ladder detail lives on cards, not the signal). |
| A4 | Header pill "Advance rule: X" (`advanceRuleLabel`, legacy maps `delivery→deliveryOnly` label) | KEEP+UI | `PaymentWorkspace.tsx:195-197`; label resolution via `taxonomy.advancePolicyKey` (`payment-settings/taxonomy.ts:141-156`), canonical enum `delivery_charge`. |
| A5 | NEW pill "Preferred: provider · channel" | NEW (contract §6/D-8) | `PaymentWorkspace.tsx:154-157,192-194`; source = `is_preferred` account from `/api/payment/accounts`. |
| A6 | Loading skeleton (3 pulsing cards) + `.em-payment` scope (`FE/src/styles/theme.css:298+`) | KEEP+UI | `PaymentWorkspace.tsx:160-174`; same token scope. |
| A7 | `MotionConfig reducedMotion="user"` + `ANIMATE` mode gate + `fadeUp` | KEEP | `PaymentWorkspace.tsx:37,177`, `MethodsTab.tsx:151`, `AccountDrawer.tsx:275` (axe e2e depends on it — F10). |
| A8 | Dismissible success/error banners (`role="status"`/`role="alert"` + labelled Close) — vitest `PaymentGuardrails.test.tsx:191-201` | CHANGE | 2-tab build uses `ResultBanner` (`MethodsTab.tsx:154-159`) + inline `role="alert"` in `PoliciesTab.tsx:156-173`; banner-roles intent preserved, the legacy "toggle then dismiss" assertion re-targets (see F4). |
| A9 | Two-tab shell with ARIA tablist (roving tabindex, ArrowLeft/Right wrap, Home/End) — house pattern from `DeliverySettings.tsx` | NEW (UI) | `PaymentWorkspace.tsx:203-244`; testids `payment-tab-*` / `payment-panel-*`. Tabs are exactly **Methods / Policies** (contract §0) — the reference mock's third tab is forbidden (§I-2). |

## B. Legacy `PaymentSettings.tsx` capabilities & fields

| # | Existing capability (source) | Status | Lives now / notes |
|---|---|---|---|
| B1 | COD gateway card + enable/disable toggle without credentials (`:275-315`, `:475-560`) | KEEP+UI | `MethodsTab.tsx:162-190` single COD row; first enable POSTs `provider:'cod', account_type:'standard'` (`:110-121`). COD stays credential-free (§1.1). |
| B2 | bKash card + `gateway-expand-{id}` disclosure (`:544-556`) | CHANGE | Provider rows for bkash/**nagad/rocket** (`method-row-{p}`, `expand-{p}`, `accounts-panel-{p}`, `MethodsTab.tsx:193-278`). Rocket was previously invisible (its number could be stored but never prompted — §1.1/§7-7; prompt fixed on BE `order-session-standalone.service.js:257`). Legacy testid retired → migrated pin (E5/E7). |
| B3 | Self MFS / Merchant API mode buttons (`:574-597`, `aria-pressed`) | REPLACE | The two-button mode smuggled `mfs_mode:'merchant'` into the single `self-mfs` row (§1.1). Successor: explicit **account channels** radio group in `AccountDrawer.tsx:354-376` (`self \| business \| merchant_gateway`, bkash-only gateway — legal matrix `channelsForProvider`), rows per channel under each provider. |
| B4 | Receiver phone input, placeholder `01XXXXXXXXX`, BD format (legacy line 604-610) | KEEP+UI | `AccountDrawer.tsx:406-420` via shared `BDPhoneInput` (default placeholder **`01XXX-XXX-XXX`**, same `BD_PHONE_REGEX /^01[3-9]\d{8}$/` — `FE/src/shared/components/BDPhoneInput.tsx:18,44`). e2e placeholder locator changes (E7). |
| B5 | Merchant API secret fields app_key / app_secret / username / password (`:613-656`), never re-hydrated (`PaymentGuardrails.test.tsx:124-150`) | KEEP+UI | `AccountDrawer.tsx:422-455` — fields always start blank even in edit; save sends secrets ONLY when the full set was entered (`:152-158`), plus an explicit **replace-by-entry warning** (`:400-404`, `replace-warning`) stating verification resets (§2 demotion). |
| B6 | Test→save ordering: `POST /api/payment/config/test` then `POST /api/payment/config` on "Save bKash" (`:241-256`; pins E6, F5) | CHANGE ⚑ | As-built drawer saves directly (`AccountDrawer.tsx:142-194`); format validation runs **inside** the save (`BE payment-accounts.service.js:95-136` → `validateSelfMfsCredentials`) and the standalone "Validate format"/"Check credentials" buttons are explicit ladder actions (`:486-559`). §8.3 says "same order retained" — intent (format never skipped, secrets never echoed) holds; literal two-call order does not. **Flagged for orchestrator** — see §J-4. |
| B7 | "Set Default" star → `PUT /api/shop/platform-priority {payment:['bkash','cod']}` (`:86-101,493-503`; pins E8, F7) | REPLACE (deliberate, D-8) | `PUT /api/payment/accounts/:id/preferred` (`BE payment.routes.js:69`, owner-only, exactly-one DB truth `payment-accounts.service.js:290-318` + unique index 002). UI: `preferred-toggle-{id}` (`MethodsTab.tsx:397-419`); priority demoted to display-order only. The old PUT-shape pin is retired by ratification, not regression. |
| B8 | Saved-then-enable gate ("Save configuration first", `:279-285`; pins E9, F6) | KEEP+UI | Wallet toggles disabled until `credential_summary.has_credentials` (`MethodsTab.tsx:124-128,353-354,387`); enabling-without-creds refused server-side 400 (`payment-accounts.service.js:193-195,269-271`). §7-3 honesty now comes from the chip, never from `is_enabled` implying payability. |
| B9 | `requiresContact` mailto branch (AamarPay/SSLCommerz "Contact us", `:506-514,183-186`) | REMOVE (§7-14) | Deleted with the branch; both providers remain out of scope. i18n keys `aamarName/aamarDesc/sslCommerzName/sslCommerzDesc/contactUs*` now dead (locale trim = optional follow-up, not a functional row). |
| B10 | Advance-rule radios `none \| full \| delivery \| percentage \| fixed` (`:56,368-398,690-725`; pins E10, F8, E13) | KEEP+UI | `PoliciesTab.tsx:196-259`, canonical `delivery → delivery_charge` (alias tolerated at the API `BE payment-policy.service.js:45-54`; radio testids `advance-radio-{value}`). Dependent-input enablement + "save disabled when clean" semantics retained (`:112-140,137`). |
| B11 | Percentage (default 50) / Fixed (default 100) numeric inputs | KEEP+UI | `PoliciesTab.tsx:223-255` with client bounds mirroring server (1..99 / 1..100000, integers — `taxonomy.ts:77-83`, `payment-policy.service.js:69-98`); defaults preserved on selection (`:112-118`). |
| B12 | Persistence of the policy as `payment_methods` JSON blob via `POST /api/shop/update` (`:329-362`; pins E11, F8) | REPLACE | The blob was a UI illusion (§5.1 — never stored). Now `PUT /api/payment/policy` (R-14; `BE payment.routes.js:82-83`), server-validated, 400s surfaced inline (`PaymentWorkspace.tsx:119-136` + `PoliciesTab.tsx:156-173`). Persisted shape: `shop.settings.payments` (`payment-policy.service.js:136-158`). |
| B13 | Payment-message textarea (≤500, `paymentMessage`, placeholder, `defaultPaymentMessage` init) (`:57,739-741`) | KEEP verbatim | `PoliciesTab.tsx:276-301`; key `payment_message` (§5.2 "preserved verbatim"); char counter `policy-message-count`; `maxLength` = 500 both sides. |
| B14 | "Update Payment Info" CTA (`updatePayment`) | KEEP+UI | Two save affordances (advance section + message section) both run the ONE policy PUT via the shell (`policy-save` / `policy-message-save`). |
| B15 | Hydration from `credential_summary` (number shown, secrets blank — pins E7, F-legacy vitest:127-133) | KEEP (contract §1.4) | Account API reply carries `credential_summary` + new `provider/account_type/verification_level/is_preferred` (`payment-accounts.service.js:66-92`); legacy `/config` GET still masks (`payment.service.js:249-260`), and `Orders.tsx:170`'s legacy consumer keeps working via dual-write `gateway` value. |
| B16 | Disconnect a gateway (API `DELETE /config/:gateway` existed; legacy UI never exposed it — i18n `disconnect*` keys dead) | NEW (UI) | `MethodsTab.tsx:291-334` delete dialog with explicit confirm (`confirm-delete-account`), §12 confirm-dangerous pattern; backed by `DELETE /api/payment/accounts/:id` (`payment.routes.js:65`) which also re-syncs `settings.bd` (`payment-accounts.service.js:280-287`). Old legacy DELETE route stays for compat consumers. |
| B17 | Header copy "activated/deactivated success" implying payability (`:304-306`) | CHANGE (§7-3) | Success copy now server-echoed reload; honesty is the chip's job: `verification-honesty` line ("Enabling only controls whether customers see this option…" `AccountDrawer.tsx:474-476`). |

## C. Backend legacy API surface (compat window §1.4 — what must keep answering)

| # | Endpoint (source) | Status | Notes |
|---|---|---|---|
| C1 | `GET /api/payment/config` (`BE payment.routes.js:49`) | KEEP | `Orders.tsx:170` + legacy page consumers; masked shape unchanged (`payment.service.js:242-261`). |
| C2 | `POST /api/payment/config` (`:50`) | KEEP | Still validates `cod|self-mfs` after aliasing (`payment.service.js:266-364`); dual-written rows from the new API keep `gateway` coherent (`payment-accounts.service.js:200,220,274`). |
| C3 | `POST /api/payment/config/test` (`:51`) | KEEP+wording CHANGE | Response now `{status:'format_validated', message:'Number format validated — not a provider check'}` (`payment.service.js:369-395`) — §7-1 landed. |
| C4 | `DELETE /api/payment/config/:gateway` (`:52`) | KEEP | Compat reader; also clears `settings.bd` (config-sync pin H5). |
| C5 | `POST /api/payment/cod/confirm` (`:55`) | KEEP | COD settlement authority untouched (H1). |
| C6 | `paymentCallbackAuth` middleware array applied to no route (`:41-46`) | CHANGE (§7-10) | **As-built still dead.** D-9 disposition (wire-or-delete) pending; matrix demands a decision before merge so it stays off the "security theater" list. |
| C7 | `GET /api/payment-methods/available|get-config`, `POST /save-config` (`payment-methods.routes.js`, mounted routes.js:47) | KEEP (out-of-scope readers) | Gateway-string display helpers predate the redesign; not the settings write path. No new coupling. |
| C8 | Unmounted `bangladesh-payment.routes/controller` + zero-importer `smart-payment-detection.service.js` | REMOVE pending (D-9) | Files still on disk; grep proves zero importers (verified this session) → deletion owed; `route-perimeter.test.js:17-20` already flips to not-exists pins at deletion. `bangladesh-payment.service.js` **STAYS** (billing, H7) with the ratified casing fix landed (`:4-8,128` via `isSettledStatus`). |

## D. New canonical surface (as built — where each capability now lives)

| # | Capability (contract) | Status | As-built anchor |
|---|---|---|---|
| D1 | Canonical vocabulary module (providers/account types/ladder/labels/keywords/predicates) | NEW (§1.1) | `BE payment-taxonomy.js` — `PROVIDERS :18`, `ACCOUNT_TYPES :24`, `VERIFICATION_LEVELS :40-45`, labels en+bn incl. Rocket `:86-99`, `isAutomatable :251-261`, `maxVerificationLevel :220-227`, `legacyGatewayFor :123-127`. FE mirror: `FE payment-settings/taxonomy.ts` ⚑ (canonical pinned mirror `payment/taxonomy.ts` **missing** — §J-2). |
| D2 | Multi-account rows `(shop, provider, account_type)` on renamed table | NEW (§1.2-20261127_001) | Entity `payment-config.entity.js` — `tableName 'payment_accounts' :162`, exported also `PaymentAccount :186`, indexes `:165-181`; migration `20261127_001_payment_accounts.js` (rename guarded :132-143, additive columns :146-149, Node credential-based classification :172/73-122, honest drift fallback :187-207) + `20261127_002_payment_account_constraints.js` (legacy uniques dropped :76-80, duplicate pre-flight FAILS with row report :82-105, partial uniques `shop+provider+type` / one-preferred / txn-unique :108-122). |
| D3 | `payment_account_verifications` append-only evidence ledger | NEW (§2) | Table 001:214-230; entity `payment-account-verification.entity.js` (INSERT-only, `updatedAt:false`); helpers `appendVerificationRecord`/`readVerificationRecords` (`payment-accounts.service.js:328-353`). ⚑ JSONB (SQL) vs `DataTypes.JSON` (entity) — §J-8. |
| D4 | Account CRUD + serialize (never echoes decrypted credentials) | NEW (§1.4) | `payment-accounts.service.js:139-287` + controller `payment.controller.js:225-265`; allowlist discipline extends the serialization pin (F12). |
| D5 | Preference = DB truth, exactly one per shop, owner write, enabled-only | NEW (§6/D-8) | `setPreferredAccount :290-318` (409 `PREFERRED_ACCOUNT_DISABLED`), unique index 002:113-117, route `payment.routes.js:69`. |
| D6 | Verification ladder: save→`configured_unverified`; credential change→demote `unverified` + record | NEW (§2) | `payment-accounts.service.js:182-234` (demotion :188-189, 257-264; records :204-210, 227-233). |
| D7 | Rate-limited credential check (the ONLY grant-bearing settings action; 30-min cached verdict; ≤2 grants/hr 429; Redis token store) | NEW (§2.1) | `payment-verification.service.js:93-289` (wallet-only notice :110-123, format-only :124-136, cached :150-164, `automation_disabled` when flag off :169-179, production grant→`credentials_valid` copy :237-262, 401/403→`credentials_invalid` :271-286, 502 no-verdict :287); budget lives `bkash-tokenized.service.js:174-226` (`account:{id}:token` + `grant-budget`, Redis cache.service). |
| D8 | `sandbox_verified` = create→query handshake, exact D-3 copy; never on production creds | NEW (§2.2/D-3) | `payment-verification.service.js:182-212` (`method:'sandbox_create_query'`, copy "sandbox checkout handshake verified; no settlement implied" — taxonomy `:108-110`); sandbox-only guard `bkash-tokenized.service.js:115-121` (`SANDBOX_ONLY_OPERATION`). ⚑ env source = `account.config.environment` / `BKASH_ENVIRONMENT` — drawer's sandbox checkbox is unwired (§J-6). |
| D9 | `live_certified` recorded (evidence 3–500 chars, prior-sandbox gate, owner-only, AuditLog) — never self-declared | NEW (§2.3) | `certifyLiveAccount :292-352` (409 `LADDER_CEILING` for wallet kinds, 409 `SANDBOX_HANDSHAKE_REQUIRED`, 400 `INVALID_EVIDENCE`, AuditLog :335-343); validator `payment.validator.js:78-87`; route `payment.routes.js:75`. |
| D10 | Policy API: GET/PUT(/PATCH alias) `/api/payment/policy`, settings.payments store, bounds + cross-field 400s, pure `computeAdvance` referencing zone delivery charge | NEW (§5.2/D-7) | `payment-policy.service.js` (:45-120 validation, :136-158 write with `mergeSettingsPreservingRtoConsent` + cache invalidation, :167-193 clamp incl. `fixed ≥ total → full`); routes `payment.routes.js:81-83`. |
| D11 | Self-MFS claim create: TrxID validate, server-recomputed amount, tolerance-mismatch surfaced, TrxIDLog→PaymentTransaction(`payment_claimed`) race-safe, owner notification with real 24 h `expires_at` | NEW (§3.2/R-13) | `payment-claim.service.js` (`performClaim :278-492`; replies :110-122; `resolvePaymentWallet :163-210` single-number selection preferred-first; stamped `payment_account_id` :432). `POST /api/payment/claims` (routes.js:89, 201 reply controller:324-330); chatbot wiring `order-session-standalone.service.js:937-956, 1321-1330, 2150` (§3.5 attribution `payment_method_id` landed). Owner-approval accepts `payment_claimed` (`owner-notification.service.js:31,310` via `APPROVABLE_STATUSES`). §3.3 crash fixes landed: `expires_at` (:121,414), `ORDER_REVIEW_REQUIRED` replaces misfire (`delivery-tracking.service.js:561-576`, `notification-events.js:10,46`). |
| D12 | `settings.bd` multi-provider mirror: `wallets[]` + legacy `mfs_*` = preferred, write-time only (hot-path pin intact) | NEW (§3.4/D-6) | `syncBdFromAccounts` (`payment-accounts.service.js:369-411`), called on every account mutation; AI wording gains Rocket (`shop-operating-context.service.js:33,85-91`) with the no-hot-path-query pin preserved (F14). |
| D13 | Gateway v2 refund (owner-only, 60-day window, inert 503 honesty) | NEW (§4.5) | `payment-verification.service.js:360-433`; route `payment.routes.js:86`. No settings-tab affordance (transactions surfaces are outside the 2 tabs). |

## E. Playwright e2e pins (the two `payment-*.spec.ts` files)

| # | Pin (file:line) | Intent | Status | Migration as-built / owed |
|---|---|---|---|---|
| E1 | `payment-guardrails.spec.ts:23-34` KNOWN_PATHS allowlist + abort-unknown (`:50-59`) | invented backend calls fail CI | KEEP (list extended) | Add `/api/payment/accounts` (+ per-id patterns, `/preferred`, `/verify-credentials`, `/certify-live`) and `/api/payment/policy`; see 03 §5 delta. |
| E2 | `:99` test mock reply `'Number verified'` | (pins legacy wording) | CHANGE (§7-2) | Mock must return `format_validated` family; legacy wording forbidden in new mocks. |
| E3 | `:144-152` header: title + signal "Accepting payments" + `Enabled methods:` + zero `dashboard-primary-action` | execution header §29 | KEEP | Same assertions work on the workspace (A2-A5); add tab-list assertions alongside. |
| E4 | `:154-165` expand→hydrate→**test-then-save** with exact credentials body | format-check-before-save, secrets never echoed | CHANGE ⚑ | New flow = drawer create/edit; order pin collides with as-built (§J-4). Intent-migrated assertion: save body carries `{mfs_type,mfs_number,mfs_mode}` and NO response ever echoes credentials. |
| E5 | `:167-173` bKash switch disabled before saved creds; COD enabled | no activation before config | KEEP+UI | `MethodTab` wallet toggle disabled until `has_credentials` (B8); locators move off `gateway-expand-bkash`. |
| E6 | `:175-186` default election PUTs `['bkash','cod']` to `/shop/platform-priority` + status confirm | explicit, confirmable preference change | REPLACE (deliberate) | D-8: preference pin becomes `PUT /api/payment/accounts/:id/preferred` (assert exactly-one preferred + owner write). Old shape retired by ratification. |
| E7 | `:188-199` advance radios → JSON blob to `/api/shop/update` (parsed `advancePaymentRule`) | radio machine + one-click persist | CHANGE | Same UI assertions on Policies tab; persistence pin becomes `PUT /api/payment/policy`; blob parse test renamed intent "policy round-trips from the server" (§8.3). |
| E8 | `:201-208` merchant honesty: "Automated checkout is not active yet" visible, `…via official merchant API` **never** visible | never imply live gateway | KEEP forever | Forbidden-string pin survives as the ladder component (VerificationChip tests F11); applies per account, below `live_certified`. |
| E9 | `:210-219` 390px: no horizontal overflow + 5 mobile nav destinations | responsive + shell integrity | KEEP | Must pass as-is on the 2-tab build; also run at 360 (02 specs). |
| E10 | `:221-232` axe: no critical/serious in `.em-payment`, `reducedMotion` emulation | a11y + reduced motion | KEEP | Re-point expand/collapse interactions to new testids; scope class unchanged. |
| E11 | `payment-settings.spec.ts:46` mock `'Connection verified'` | legacy wording | CHANGE (§7-2) | → `format_validated` strings. |
| E12 | `payment-settings.spec.ts:87-124` loads COD+bKash, expand shows `gateway-expand-bkash`/Self MFS/Merchant API, hydrates `01711000000` | page loads; credential_summary hydration, secrets absent | CHANGE | Nagad+Rocket now asserted (B2); hydration pin retargets to `method-row-{p}` → `expand-{p}` → drawer/`credential_summary` (placeholder E note in B4). |
| E13 | `payment-settings.spec.ts:126-164` test→save endpoints; radio selection changes state | order + state machine | CHANGE | Same as E4/E7. |
| E14 | CI inclusion: `payment-guardrails.spec.ts` is in the CI mock-only e2e list (`.github/workflows/ci-cd.yml:383`); `payment-settings.spec.ts` is NOT (local-only) | gate placement | KEEP | Both spec files stay; the CI list keeps `payment-guardrails.spec.ts` name unchanged. |

## F. Vitest pins (FE) 

| # | Pin (file) | Status | Disposition |
|---|---|---|---|
| F1 | `payment/__tests__` does not exist — signal matrix lives in `__tests__/PaymentGuardrails.test.tsx:68-78` (error/loading/enabled/none → blocked/pending/healthy/attention; `:count` reason) | KEEP | `derivePaymentSignal` untouched; unit pins survive verbatim (§8.3). |
| F2 | Execution header test `PaymentGuardrails.test.tsx:82-90` (+ blocked-signal + attention transitions `:92-103`) | CHANGE | Re-render against `PaymentWorkspace` (`PaymentWorkspace.test.tsx:79-86` already pins header + pills on the new shell). |
| F3 | Gateway switch semantics `:107-121` | KEEP+UI | Covered on new surface by `MethodsTab.test.tsx:75,86,95,105,123`. |
| F4 | Banner dismiss `:191-201` | CHANGE | New surfaces assert error banners instead (`MethodsTab.test.tsx:149`, `PoliciesTab.test.tsx` error block). |
| F5 | Test-then-save order + exact credentials body `:124-150` | CHANGE ⚑ | See E4/B6/§J-4; new tests pin save body + never-echo (`AccountDrawer.test.tsx:68-135`). |
| F6 | Merchant-mode honesty `:152-158` | KEEP | Becomes ladder component tests `VerificationChip.test.tsx:28-85` (format-only, wallet-only notice, D-3 exact copy, certified-as-owner-record, forbidden API string absent). |
| F7 | Default election PUT body `:161-172` | REPLACE | `MethodsTab.test.tsx:105-131` (single preferred elected id → API; disabled-preferred 409-prevention). |
| F8 | Advance rules persist blob via updateShop `:174-188` | CHANGE | `PaymentWorkspace.test.tsx:107-123` ONE `PUT /api/payment/policy` + server-echo confirmation; `PoliciesTab.test.tsx:28-86` validation mirror. |
| F9 | Legacy `PaymentSettings.test.tsx:113-214` (11 tests against the old component) | CHANGE | Retires with the legacy page (once routes swap); its unique intents (empty-data no-crash, toggle, pre-fill) are already re-pinned in D/E/F rows above. Until the swap it still pins the legacy page that is actually mounted. |
| F10 | axe/reducedMotion e2e (E10) + `MotionConfig` usage everywhere | KEEP | — |
| F11 | New suites on disk (untracked): `payment-settings/__tests__/{PaymentWorkspace,MethodsTab,PoliciesTab,AccountDrawer,VerificationChip}.test.tsx` — 35 tests | KEEP (A2 output) | They mock `@/api/domains/payment` with the 10 new names ⚑ — the domain module does not export them yet (§J-3). |
| F12 | BE serialization pin `payment.controller.serialization.test.js` (save never echoes decrypted credentials) | KEEP+extend | New endpoints follow the same allowlist (`serializeAccount` reads via getter, returns summary only). |
| F13 | BE `payment.routes.contract.test.js` (validator gates 400, dispatch shapes, `_shop_id` stripped, owner-only preferred, certify evidence) | KEEP | Pins the new surface. |
| F14 | BE wording/authority pins `shop-operating-context.payment-authority.test.js`, `action-gate.contract.test.js`, `order-session-standalone.steps.test.js` (incl. source-grep no-OCR-claim pins), `owner-notification.security.test.js`, `notification-payment.routes.security.test.js`, `payment-webhook.controller.test.js`, `payment.cod-confirmation.test.js`, `payment.config-sync.test.js`, `self-mfs-handler.*`, `webhook.middleware.test.js`, `route-perimeter.test.js` | KEEP per §8.1 | As-built status: wording pins migrated (steps test modified on disk), webhook middleware rewritten to transport-gate-only ("not settlement evidence; controller still requires a server-side Query" — `webhook.middleware.js:6-26`, controller `_settleFromQuery` path). `config-sync` intent moves to per-account disable/delete sync (D12) — legacy route sync also kept (C2). |
| F15 | BE migration drift/duplicate-rejection tests | NEW (required by §8.1) | `src/database/__tests__/20261127_001_payment_accounts.migration.test.js` + `20261127_002_payment_account_constraints.migration.test.js` (present, untracked). |

## G. Misleading-claim cleanup map (contract §7 rows 1–17) — as-built disposition

| §7# | Claim site | Disposition on disk |
|---|---|---|
| 1 | `testPaymentConnection` "…number verified" | **DONE** — `format_validated` + honest message (`payment.service.js:369-395`); FE labels "Validate format" / "Check credentials (limited to 2 per hour by bKash)" (`AccountDrawer.tsx:505,521`). |
| 2 | FE e2e mock wordings `'Number verified'` / `'Connection verified'` | **OPEN** — mocks still carry legacy strings (E2/E11); migrate with the spec rewrite. |
| 3 | Switch enable implies payable | **DONE** — chip per account, `is_enabled` decoupled from verification (`MethodsTab.tsx:393`, `VerificationChip.tsx`; drawer enable-honesty copy `:474-476`). |
| 4 | `base-merchant.service.js:7-8` phantom Nagad/RocketMerchantService docstring | **OPEN** — docstring unchanged on disk; rewrite owed. |
| 5 | `bkash-merchant.service.js` v1.2.0 client | **PARTIAL** — v2 client landed (`bkash-tokenized.service.js`); legacy v1 file still present (imported only by the v2 file + its logs test). Wholesale replacement/removal owed. |
| 6 | Three disagreeing vocabularies | **DONE** — validator imports taxonomy sets (`payment.validator.js:2-6,55-63`); entity documents canonical values; `savePaymentConfig` legacy path unchanged in the compat window only (C2). |
| 7 | Prompt/label gaps (no Rocket; 'self-mfs' blob) | **DONE** — labels `order-session-standalone.service.js:257` + keywords `:1995-2032` via taxonomy. |
| 8 | `bangladesh-payment.controller/routes` phantom API + smart-payment-detection | **OPEN (deletion pending)** — files on disk, unmounted/unreferenced (C8, §7-12); `simulate` dev route still present in the unmounted file. |
| 9 | Invented `x-bkash-signature` HMAC claim | **DONE (interim scheme)** — middleware rewritten to honest transport gate; settlement now requires server-side Query (`payment-webhook.controller.js:14-17,61-62,247-253`); `BKASH_SANDBOX` production gate kept (`production-config.validator.js:201-205`). |
| 10 | Dead `paymentCallbackAuth` array | **OPEN** — still built & unapplied (C6). |
| 11 | `owner-notification` `.toUpperCase()` crash + delivery-failure misfire | **DONE** — `providerLabelSafe` in claim path; `ORDER_REVIEW_REQUIRED` event (`notification-events.js:10` + `delivery-tracking.service.js:561-576`). |
| 12 | smart-payment-detection as active engine | **OPEN (delete)** — zero importers (C8). |
| 13 | `setup-secrets.js:95-99` NAGAD_* collection | **OPEN** — still collects five unread vars; D-10 removal owed. |
| 14 | FE `requiresContact` mailto branch | **DONE** — absent from new surface (B9). |
| 15 | Policy "saved" success while server dropped it | **DONE** — real endpoint + inline 400s (D10, B12). |
| 16 | `handleOwnerPaymentConfirmation` unreachable webhook handler | **OPEN (delete)** — removal owed with contract-test mock-out cleanup. |
| 17 | Billing `'COMPLETED'` vs `'Completed'` | **DONE as pinned defect fix** — `bangladesh-payment.service.js:4-8,128` compares via `isSettledStatus`; pin `bangladesh-payment.casing.test.js` present. |
| + | **NEW (A1-found): legacy `modeSelfHint`** = "Customer sends screenshot → AI verifies via OCR → you approve/reject" — rendered live today (`PaymentSettings.tsx:592`, `en.json manageShop.paymentSettings.modeSelfHint`) | **REPLACE+REMOVE** | Contradicts §0 (OCR is never verification) yet was NOT in §7. Successor copy: wallet hint "Payments are confirmed by you, never automatically" (`AccountDrawer.tsx:416-418`). Delete the key when the legacy page retires. Flagged to orchestrator (§J-1). |

## H. §0 preserved-verbatim invariants (restated so nobody "refactors" them)

| # | Invariant | Where it lives / who guards it |
|---|---|---|
| H1 | COD settlement authority (owner/admin, delivered-required, courier/payment-reconciliation blocks) | `payment.service.js:142-221` untouched; pins `payment.cod-confirmation.test.js` (modified only for imports) — KEEP. |
| H2 | Merchant approve/reject endpoints + guards (tenant, terminal, courier-claim, expiry 410, dismiss pin) | `notification.routes.js:24-64`, `owner-notification.service.js` — unchanged except §3.2-4 status list (+`payment_claimed`) and `expires_at` defect fix; pins `owner-notification.security.test.js`, `notification-payment.routes.security.test.js` — KEEP. |
| H3 | No OTP anywhere; screenshot optional-support-only, OCR never auto-confirms | `payment-claim.service.js:48-63,90-100,268` (+ `self-mfs-handler` untouched as merchant-side helper); source-grep pins in `order-session-standalone.steps.test.js` — KEEP. |
| H4 | `BKASH_ENABLED=false` default + `VITE_BKASH_ENABLED=false` build + `AI_PAYMENT_ACCEPTANCE_ENABLED` untouched | env template/CI/Dockerfile/playwright configs — KEEP; `isAutomatable` false here by construction (R-12). |
| H5 | self-MFS config→`settings.bd` write-time sync | legacy path `payment.service.js:342-361` kept; new path superset `syncBdFromAccounts` (D12); pins `payment.config-sync.test.js` + `shop-operating-context.payment-authority.test.js` hot-path query ban. |
| H6 | Webhook structure: rate limit, atomic claim, replay dedupe, amount/invoice strictness, no session touch, terminal-after-fulfillment | `payment-webhook.controller.js` — structure kept, Query-before-settle ADDED; real-DB race pin file untouched semantics. |
| H7 | Platform billing separate (env creds, invoices; never merchant accounts) | `invoice-payment.service.js`/`topup.service.js` untouched; billing mocks pin the separation (§8.1). ⚑ Entity *move* not done: `payment-transaction.entity.js` still under `src/modules/billing/` (modified in place: +`payment_account_id` :32) instead of relocated to `src/modules/payment/` (§1.3-003 planned move) — §J-7. |
| H8 | Storefront COD hard-code + its test | `storefront.service.js:381` untouched. |
| H9 | Nagad/Rocket provider-inert: zero outbound calls ever; ceiling copy exact | `payment-verification.service.js:110-123` returns the taxonomy notice with `provider_contact:false`; no nagad/rocket client exists on disk. KEEP. |

## I. Reference-only — DO NOT INVENT (from the mock; contract-faithful FE must not add these)

1. **OTP / "Send code" / 6-digit `enterCode` verification** (mock `sendCode/enterCode/codeSent/verifyOk`, `payModal` flow) — FORBIDDEN (§0; no OTP anywhere). No ladder rung may ever be minted from an OTP exchange.
2. **Billing & invoices tab** (mock 3rd tab: rate/৳10-per-delivered-order, billEvent, autoCharge, credit, invoice chain, payNow) — out of scope; platform billing stays invisible on merchant payment settings (H7).
3. **Per-provider boolean `verified:true/false` badge** (mock `method.signal`, `verifyNow`) without a named ladder rung — forbidden; only `unverified | configured_unverified | sandbox_verified | live_certified` chip semantics (§2, VerificationChip).
4. **`verifyMode: manual | TrxID | Screenshot ("shot")`** selector (mock paypolicy tab) — screenshot-as-verification contradicts §0; TrxID claim is not a "mode", it IS the self-MFS path (§3.2).
5. **Account types `personal / agent / merchant`** (mock select) — canonical set is `standard / self / business / merchant_gateway`; "agent" does not exist.
6. **Per-method `fee` (surcharge) and per-method `advancePct`** fields — policy is shop-level (§5.2 `settings.payments`), never per account.
7. **`bank` provider** — canonical providers are exactly `cod | bkash | nagad | rocket`.
8. **COD `codMax` / `blockRefuse` / `codAdvance` toggles** — not in the ratified policy model; COD availability authority is Delivery Settings zones (link, not duplicate — `PoliciesTab.tsx:262-272`).
9. **`{{number}}` instruction-template variable + per-method `instructions` textarea** — not contracted; the only message surface is the shop-level `payment_message` (≤500).
10. **QR-code upload affordances** (legacy dead i18n keys `qrCode/qrUploaded/changeFile/chooseFile`) — no QR capability exists; keys die with the legacy page.
11. **Dead merchant-credential templates** (i18n `storeId/secretKey/merchantId/apiKey/publicKey/serviceId`, AamarPay/SSLCommerz) — no integration row supports them.
12. **Settings JSON export / chatbot simulator / audit-log feed** (mock `exportJson`, `st.ui.sim`, AUD rows) — separate modules; out of the two payment tabs.
13. **"Reveal" unmask of the receiver number with a confirmation modal** — the number is the merchant's own receiver number (non-secret, §3.2 shows it to customers anyway); the drawer shows it directly. Masked-reveal theatre adds no protection and no testid.
14. **Bulk enable/disable/delete** (mock `bulk:[...]` toolbar) — §12 per-record confirm only.

## J. Contradictions / gaps vs the ratified contract (flag — do not "fix" from this doc)

1. **`modeSelfHint` OCR-verification claim** shipped in the live legacy UI is absent from §7's cleanup map (row added §G+; §I-4 forbids its successor).
2. **FE canonical mirror** `src/app/components/payment/taxonomy.ts` with a **backend mirror-invariant test** (§1.1 decision) does not exist; the header comment of `payment-settings/taxonomy.ts:8` *asserts* a pin that no test in `payment-taxonomy.test.js` implements. Mirror-invariant discipline is currently by convention only.
3. **`api/domains/payment.ts`** exports only the 4 legacy functions; the 10 contract names are declared solely by the cast seam `paymentClient.ts:61-79` and mocked into existence by unit tests. Production FE would crash on `paymentClient.getPaymentAccounts is not a function` until the API-domain owner lands them. (03 §2 marks as-built vs owed.)
4. **§8.3 "same order retained" for test→save** vs as-built save-with-implicit-validation + explicit standalone validate/check buttons (B6/E4/F5). Intent survives; the literal pin cannot — orchestrator ruling on the migrated assertion is owed.
5. **Task-brief migration numbering "20261127_001..003"** — only 001/002 exist, matching ratified **R-11** ("two-migration chain"): the draft's §1.3-003 transaction-integrity work was folded into 001 (additive `payment_account_id` FK + index) and 002 (txn-unique swap). No 003 is planned; CI touchpoints must read 001/002.
6. **Sandbox environment control**: `AccountDrawer` "Sandbox (Testing)" checkbox (`:107,477-482`) is never persisted; backend resolves env from `account.config.environment` / `BKASH_ENVIRONMENT` (`bkash-tokenized.service.js:105-109`). The D-3 sandbox rung is therefore unreachable from the UI until `config.environment` is wired on gateway save.
7. **§1.3-003 entity re-parent** (payment-transaction entity billing→payment dir) not executed — column added in place; all consumers unchanged. Cosmetic vs contract letter; decide before merge (move touches `entities.js:43` + ~10 importers).
8. **Ledger evidence column**: SQL `JSONB` (001:223) vs entity `DataTypes.JSON` — potential `schema:audit` drift hit; verify in the migration rehearsal (03 §6).
9. **Legacy page still mounted** (A1) — until routes swap, the e2e CI lane validates the OLD page while the NEW components are pinned by unit tests only; the spec suite rewrite is the swap's PR (02/03 contract for A2).
10. **`paymentCallbackAuth` (C6) + NAGAD_* (G-13) + dead-file deletions (C8)** remain open §7/D-9/D-10 items — owed before "misleading-claim cleanup complete" may be claimed in the PR body.
