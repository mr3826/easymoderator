# 03 — Reuse & Client Map — Payment Settings redesign

A1, 2026-11-26. Paths relative to `D:/easymod/_wt-payment-20261126/`
(`BE/` = `EasyMod-backend/`, `FE/` = `EasyMod-frontend/`). Documents what the redesign reuses,
the payment client names↔routes as built, i18n namespaces, testids minted by A2 (the
payment-settings components), the e2e `KNOWN_PATHS` delta, and CI/migration/rehearsal touchpoints.

## 1. Reused components & patterns (paths)

| Piece | Path | Role in payment workspace |
|---|---|---|
| `PageHeader` (title + signal + meta pills, §29 no-CTA) | `FE/src/app/components/dashboard/PageHeader.tsx` | shell header; `signalTestId="payment-signal"` |
| `EmButton` (primary/secondary/ghost/danger, loading) | `FE/src/app/components/dashboard/EmButton.tsx` | all CTAs incl. drawer + dialogs |
| `ResultBanner` | `FE/src/app/components/dashboard/ResultBanner.tsx` | error banners (Methods tab, drawer result) |
| `derivePaymentSignal` + `Signal` type | `FE/src/app/components/payment/derive.ts`, `dashboard/types` | header signal — semantics UNCHANGED (§8.3 pin survival) |
| `BDPhoneInput` / `BD_PHONE_REGEX` | `FE/src/shared/components/BDPhoneInput.tsx` | receiver-number field (regex matches BE `payment-verification.service.js:64`) |
| `useDialogFocus` (trap/restore) | `FE/src/app/components/inbox/useDialogFocus.ts` | drawer + delete dialog |
| `getErrorMessage` | `FE/src/shared/lib/http/errors` | server-message passthrough everywhere |
| motion pattern (`fadeUp`, `ANIMATE=MODE!=='test'`, `MotionConfig reducedMotion="user"`) | `FE/src/lib/motion` | shell/cards/drawer |
| `.em-payment` token scope + `em-tabular` | `FE/src/styles/theme.css:298-418` | scoped `--em-*` design tokens (guardrails PR #269 lineage) |
| Tabbed-shell precedent (roving tablist, snapshot-equality Saved state, dirty-draft survival) | `FE/src/app/components/DeliverySettings.tsx` (+ delivery 02/03 docs) | `PaymentWorkspace` mirrors the house contract |
| Drawer precedent | `FE/src/app/components/delivery/ProviderDrawer.tsx` | `AccountDrawer` slide/focus/ANIMATE pattern |
| i18n `t(key, {defaultValue})` bn-first pattern | locales `FE/src/i18n/locales/{en,bn}.json` | every label resolves through `t()`; defaultValues are fallbacks only |

## 2. Payment client — names ↔ routes (as built)

Backend mount chain: `BE/src/modules/routes.js:46` → `/api/payment` = `BE/src/modules/payment/payment.routes.js`.
FE seam: `FE/src/app/components/payment-settings/paymentClient.ts` declares the contract names by
casting `@/api/domains/payment` (`:79`). **As-built (A0 integration 2026-11-26): DONE** — the domain
module (`FE/src/api/domains/payment.ts`) now exports the 4 legacy compat functions AND all 9 seam
names the cast binds (getPaymentAccounts, savePaymentAccount, updatePaymentAccount,
deletePaymentAccount, setPreferredAccount, verifyPaymentAccountCredentials, certifyLiveAccount,
getPaymentPolicy, updatePaymentPolicy) against the mounted A5 routes; wire types live in
`FE/src/api/types/payment.ts`, legacy names added to `apiClient` in `FE/src/api/index.ts`, and the
route `/manage-shop/payment-settings` now lazy-mounts `payment-settings/PaymentWorkspace` (legacy
`PaymentSettings.tsx` remains on disk only for its own unit pins). The cast is no longer
aspirational — `tests/e2e/payment-guardrails/payment-settings/payment-verification` exercise the
real domain layer through route-level mocks.

| # | paymentClient / domain name (owed impl) | Method+Path (mounted) | Controller → Service | Permission |
|---|---|---|---|---|
| 1 | `getPaymentAccounts()` | `GET /api/payment/accounts` | `payment.controller.getPaymentAccounts:225` → `payment-accounts.listPaymentAccounts` | auth + shop member |
| 2 | `savePaymentAccount(payload)` | `POST /api/payment/accounts` | `:241` → `savePaymentAccount` (validator `savePaymentAccountValidator`) | + owner |
| 3 | `getPaymentAccount(id)` *(route exists; no FE name yet)* | `GET /api/payment/accounts/:accountId` | `:233` | member |
| 4 | `updatePaymentAccount(id, patch)` | `PATCH /api/payment/accounts/:accountId` | `:249` → `updatePaymentAccount` | owner |
| 5 | `deletePaymentAccount(id)` | `DELETE /api/payment/accounts/:accountId` | `:259` | owner |
| 6 | `setPreferredAccount(id)` | `PUT /api/payment/accounts/:accountId/preferred` | `:267` → 409 `PREFERRED_ACCOUNT_DISABLED` if disabled | owner |
| 7 | `verifyPaymentAccountCredentials(id)` | `POST /api/payment/accounts/:accountId/verify-credentials` | `:276` → delegate → A3 `payment-verification.verifyPaymentAccount` (501 `PAYMENT_SERVICE_NOT_IMPLEMENTED` guard) | owner (member-read routes only for GET) |
| 8 | `certifyLiveAccount(id, evidence)` | `POST /api/payment/accounts/:accountId/certify-live` | `:285` → A3 `certifyLiveAccount` (409 ceiling / 409 need-sandbox / 400 evidence) | owner |
| 9 | `getPaymentPolicy()` | `GET /api/payment/policy` | `:296` (`_shop_id` stripped) | member |
| 10 | `updatePaymentPolicy(payload)` | `PUT /api/payment/policy` (PATCH alias same handler) | `:305` → `payment-policy.updatePaymentPolicy` | owner |
| — | (no settings-UI name) | `POST /api/payment/transactions/:id/refund` | `:314` → A3 refund (§4.5; transaction surfaces, not these tabs) | owner |
| — | (no settings-UI name) | `POST /api/payment/claims` | `:324` → A4 `payment-claim.createSelfMfsClaim` (201) — checkout surface; auth+shop, no owner gate |
| legacy | `getPaymentConfig` / `updatePaymentConfig` / `testPaymentConnection` / `deletePaymentConfig` | `GET|POST /api/payment/config`, `POST /api/payment/config/test`, `DELETE /api/payment/config/:gateway` | `payment.service.js` (compat §1.4; consumers: legacy page, `Orders.tsx:170`) | member / owner writes |

Shape notes: responses `{success, data|…, message}`; `serializeAccount` adds
`automated_checkout_active` + `provider_notice` (`payment-accounts.service.js:66-92`). Taxonomy
response copy sources: `format_validated`, `credentials_valid`, `verification_unavailable`,
`cached_verdict`, `automation_disabled`, `sandbox_verified`, `sandbox_handshake_incomplete`,
`credentials_invalid` (+ HTTP 400/409/429/501/502/503 codes listed in 02 Tab-1 States).

## 3. i18n namespaces

- Namespace: **`manageShop.paymentSettings`** (+ `common.*` for close/cancel/delete). BE-side
  provider labels/keywords live in `BE payment-taxonomy.js` (en+bn) — independent of FE locale.
- Existing & kept: 101 keys, en+bn parity verified (title, codName/Desc, bkashName/Desc,
  advanceTitle/noPayment*/fullPayment*/deliveryOnly*/percentage(+Suffix)/fixedAmount(+Suffix),
  paymentMessage*, updatePayment, mfsPhoneNumber, appKey/appSecret/username/password(+placeholders),
  saveConfigFirst, toggleActivateTitle, enabledMethodsLabel, advanceRuleLabel, signal.* incl.
  reason.*, errors.* (12 subkeys), sandbox/live/environment, savedSuccess/activatedSuccess…).
- Keys the redesign references via defaultValue but which are **missing and owed** (add en+bn):
  `tabs.{label,methods,policies}`, `accounts.{add,addTitle,manageTitle,noneConfigured,provider,
  credentials,available,enableLabel,enableHonesty,walletHint,preferred,setPreferred,
  alreadyPreferred,preferredNeedsEnabled,enabledCount,accountsCount,expandProvider,gatewayStored,
  noCredentials,channelLocked,allChannelsConfigured,replaceWarning,actionFailedTitle,
  storedValue,walletOnlyNotice,codAvailability}`, `accountTypes.{standard,self,business,
  merchant_gateway}`, `ladder.{cod,unverified,credentialsValidated,sandboxVerified,liveCertified,
  level.{unverified,configured,sandbox,certified}}`, `verify.{credentialHelp,formatHelp,
  checkCredentials,validateFormat,resultTitle,failedTitle,notActiveYet,evidenceLabel,
  evidencePlaceholder,evidenceRequired,certify,certifyHonesty,certifyTitle,certifyFailedTitle}`,
  `policy.{saved,allSaved,unsaved,fixBeforeSave,percentageRange,fixedRange,valueNotAllowed,
  messageTooLong,deliveryPointerPrefix,deliveryLink,deliveryPointerSuffix}`,
  `delete.{title,body}`, `errors.{merchantCredentialsRequired,phoneRequired}`, `accountType`,
  `nagadName`, `rocketName`, `save`.
- Keys to **retire with the legacy page** (01 B9/B17/§I-10/11): aamar/ssl + contactUs*,
  disconnect*, qrCode/qrUploaded/qrUploadHint/changeFile/chooseFile, storeId/secretKey/merchantId/
  apiKey/publicKey/serviceId(+placeholders), environment/environmentHint/live, paymentMode/modeSelf/
  modeMerchant/mode**SelfHint (OCR claim — 01 §G+)**, paymentInstructions*, saveMFS, mfsType,
  personal/agent/merchant, defaultPaymentMessage (only if the successor uses a different seed),
  setDefault*/defaultBadge (priority-PUT language), subtitle/gatewaysTitle/gatewaysSubtitle.
- bn copy for the §2 wallet notice + D-3 sentence: taxonomy ships `WALLET_ONLY_VERIFICATION_NOTICE`
  en+bn (`payment-taxonomy.js:102-105`); D-3 copy is en-only on BE — FE key
  `ladder.sandboxVerified` needs en (exact sentence) + bn (translation that preserves "no settlement
  implied"); the EN sentence must stay byte-exact where tested.

## 4. Testids

**Carried forward (pin-compatible):** `payment-signal`, absence of `dashboard-primary-action`.
**Minted by A2 (payment-settings components — stable contract for e2e):**
- Shell: `payment-tab-methods`, `payment-tab-policies`, `payment-panel-methods`, `payment-panel-policies`
- Methods: `methods-tab`, `method-row-cod`, `method-row-{bkash|nagad|rocket}`,
  `expand-{p}`, `accounts-panel-{p}`, `add-account-{p}`, `preferred-badge-{p}`,
  `account-card-{id}`, `preferred-toggle-{id}`, `manage-{id}`, `delete-{id}`,
  `confirm-delete-account`, `verification-chip-{id|provider}`, `verification-level-badge`,
  `verification-honesty`, `verification-extra`
- Drawer: `account-drawer`, `account-drawer-save`, `channel-option-{standard|self|business|merchant_gateway}`,
  `gateway-app-key`, `gateway-app-secret`, `gateway-username`, `gateway-password`,
  `drawer-enable-checkbox`, `drawer-validate-format`, `drawer-verify-credentials`,
  `drawer-certify-live`, `certify-evidence`, `replace-warning`
- Policies: `policies-tab`, `advance-radio-{none|full|delivery_charge|percentage|fixed}`,
  `advance-percentage-input`, `advance-fixed-input`, `policy-save`, `policy-message-save`,
  `policy-message-input`, `policy-message-count`, `policy-delivery-link`
**Retired with the legacy page:** `gateway-card-{id}`, `gateway-expand-{id}` (successor `expand-{p}`).

## 5. e2e KNOWN_PATHS delta (`FE/tests/e2e/payment-guardrails.spec.ts:23-34`)

ADD (exact paths/prefixes the redesign will call):
- `/api/payment/accounts` (GET/POST)
- `/api/payment/policy` (GET/PUT)
- Patterns (add to `KNOWN_PATTERNS`): `/^\/api\/payment\/accounts\/[\w-]+$/` (PATCH/DELETE),
  `/^\/api\/payment\/accounts\/[\w-]+\/preferred$/` (PUT),
  `/^\/api\/payment\/accounts\/[\w-]+\/verify-credentials$/` (POST),
  `/^\/api\/payment\/accounts\/[\w-]+\/certify-live$/` (POST)
KEEP (shell/other-page traffic already allowlisted; legacy payment entries may remain for the
legacy-spec pair): `/api/csrf`, `/api/auth/*`, `/api/setup/status`, `/api/subscription`,
`/api/notifications/in-app`(+read pattern), `/api/commercial/claims`,
`/api/public/commercial-contract`, `/api/shop/me`, Phase-1 shell reads (`/api/order/counts`,
`/api/conversation/needs-reply-count`, `/api/product/stock-exceptions`,
`/api/shop/delivery/readiness`, `/api/channels/meta`).
DROP from the payment workspace's expected traffic (calls must simply not occur; keeping or removing
the allowlist entries is a spec-writing choice, but a NEW unexpected-path hit on them = fail):
`/api/shop/platform-priority` (D-8 — no longer written here), `/api/shop/update` (policy blob dead),
`/api/payment/config/test` (legacy ordering pin retired per 01 §J-4 — the workspace never calls it;
the legacy spec file may still allowlist it while the old page exists).
Also update mocks: `/api/payment/config/test` reply `'Number verified'` (`:99`) and
`payment-settings.spec.ts:46` `'Connection verified'` → `format_validated` wording family (01 §G-2).

## 6. Migration / rehearsal / CI touchpoints

- **Migrations (as built, exactly two — R-11):**
  `BE/src/database/migrations/20261127_001_payment_accounts.js` (guarded rename, additive columns,
  Node credential-based self-mfs classification, honest drift fallback, `payment_account_verifications`
  table, `payment_transactions.payment_account_id` + non-unique index) and
  `20261127_002_payment_account_constraints.js` (legacy-unique lookup + drop, duplicate pre-flight
  fail-with-row-report, partial uniques: account key / one-preferred / txn `(shop_id,transaction_id)
  WHERE transaction_id <> ''`). **No `20261127_003` exists or is planned** — the draft §1.3-003
  integrity work is folded into these two (01 §J-5; correct the brief's "001..003" in CI wording).
  Migration tests: `BE/src/database/__tests__/20261127_001_payment_accounts.migration.test.js`,
  `20261127_002_payment_account_constraints.migration.test.js` (drift + duplicate-reject convention,
  `20261026_001` pattern).
- **R-11 pre-PR lane (per ratified checklist):** rebase onto updated main (Business-FAQ
  `20261126_001` lands FIRST), then full lanes against disposable PG16 including the
  two-migration chain, `npm run schema:audit` (`ci-cd.yml:906`), cutover drill
  `npm run test:backend:cutover-drill` (`ci-cd.yml:927`), and the isolated restore-drill with
  `FORWARD_MIGRATION_IMAGE` input (`.github/workflows/backup.yml:19,508, restore-drill job :459+`)
  rehearsed **with the new backend digest** (digest-without-read:packages trick: build log prints it).
  ⚠ schema:audit watch-item: `payment_account_verifications.evidence` JSONB vs entity JSON (01 §J-8).
- **Backend unit/security lanes** (`BE package.json test:security`) already route:
  `payment-callback-auth.middleware`, `payment-processing-reconciliation.security`,
  `payment.controller.serialization`, `self-mfs-handler.media-security`,
  `payment-webhook.controller`, `webhook.routes.contract`, `route-perimeter`,
  `owner-notification.security`, `notification-payment.routes.security`, invoice/topup billing
  separation tests — all must stay green with the migrated additions (01 F14). New BE test family
  §8.2 present on disk (taxonomy/accounts/verification/policy/claim/tokenized + casing pins).
- **Frontend lanes:** vitest (new `payment-settings/__tests__` suites must run once components are
  routed); Playwright mock lane — `tests/e2e/payment-guardrails.spec.ts` remains the CI-listed
  payment gate (`ci-cd.yml:383`; `payment-settings.spec.ts` stays local/extended), `VITE_BKASH_ENABLED=false`
  in `playwright.config.ts:43` family unchanged (§0), 390px + axe pins must pass as-is on the 2-tab
  build, extended to 360.
- **Env flags:** no new flags anywhere (`render-production-env.js:119-130`, `ci-cd.yml:607`,
  FE Dockerfile build arg) — NAGAD_* removal from `scripts/setup-secrets.js:95-99` still OWED (01 G-13).

## 7. Ownership seams to respect when wiring (one-writer rule)

- `FE/src/app/routes.ts` swap to `PaymentWorkspace` + domain-module function additions + locale key
  additions: integration/API owner (A1/A2 files must not pre-empt them).
- Dead-file deletions (`bangladesh-payment.controller/routes`, `smart-payment-detection.service.js`,
  `handleOwnerPaymentConfirmation`, `paymentCallbackAuth` wire-or-delete): BE owner with grep-proof of
  zero LIVE importers at deletion time (D-9 caveat).
- `payment/taxonomy.ts` canonical FE mirror + backend mirror-invariant test: vocabulary owner (01 §J-2).
- Sandbox env wiring for gateway accounts (`config.environment` ↔ drawer checkbox): A2/A5 seam (01 §J-6).
