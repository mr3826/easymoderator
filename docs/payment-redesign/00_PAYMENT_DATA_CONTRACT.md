# Payment Architecture Contract — DRAFT v1 (2026-11-26)

Status: DRAFT for orchestrator review. Not implementation. Not committed.
Evidence base: `D:/easymod/_wt-business-faq-20261126/EasyMod-backend` @ `ee67f243` (branch `feat/business-faq-settings-redesign-20261126`) and `D:/easymod/_wt-business-faq-20261126/EasyMod-frontend` @ same worktree. All file:line references are relative to that worktree unless noted. Provider contract facts are from the orchestrator-supplied official-docs sweep and are treated as authoritative inputs; nothing here re-verifies them against the network.

Marked decisions requiring orchestrator ruling are **DECISION-NEEDED [D-n]** with a recommendation inline; all 10 are collected at §10.

---

## 0. Mission, invariants, non-goals

Build a Payment Settings redesign (2 tabs: **Payment Methods** / **Payment Policies**) plus a two-path verification workflow:

1. **Verified merchant gateway** (bKash tokenized v2, gated on a real certification ladder) — Priority 1 for the gateway service rewrite.
2. **Self-MFS with merchant confirmation** (trxId + sender-number claim → pending `PaymentTransaction` → merchant approve/reject → customer notified via existing gate) — Priority 2, and the only path that can go live for bkash/nagad/rocket wallet numbers.
3. **Manual assistance / COD** fallback per policy, unchanged in settlement authority.

Hard invariants this contract must not violate (evidence of current state cited inline):

- **No OTP collection anywhere.** No current flow collects OTP; nothing added may.
- **No screenshot/OCR/TrxID-alone auto-confirmation.** `self-mfs-handler.service.js:9-14` already declares OCR "heuristic evidence only, never payment verification"; the checkout machine no longer calls it (`order-session-standalone.service.js:911-921`) and a source-grep test pins that (`order-session-standalone.steps.test.js:729-734`). This stays.
- **No unofficial payment APIs.** Nagad and Rocket have no public official merchant API (docs sweep) → their automation stays inert; implement nothing that pretends to verify them.
- **No new Meta permissions, no feature-flag activation.** `BKASH_ENABLED` stays `false` default (`scripts/render-production-env.js:130`, `.github/workflows/ci-cd.yml:607`, FE build `VITE_BKASH_ENABLED=false` `EasyMod-frontend/Dockerfile:26`, all playwright configs e.g. `playwright.config.ts:43`); `AI_PAYMENT_ACCEPTANCE_ENABLED` (`src/config/ai-runtime-flags.js:13`, action `ACCEPT_PAYMENT` `src/modules/ai/action-gate/action-gate.service.js:44`) is untouched and stays fail-closed (`action-gate.contract.test.js:188-210`).
- **Mock-tested ≠ live-verified.** The verification ladder (§2) is the mechanism: nothing may display or imply live verification below `live_certified`, and `live_certified` is never self-declared by the app.
- **Existing payment functionality preserved.** Working surfaces that must keep working verbatim: COD settlement authority (`payment.service.js:142-221`, `order.service.js:947-977`), the merchant-owner approve/reject endpoints and their guards (`notification.routes.js:24-64`, `owner-notification.service.js:174-333`), self-MFS config→`shop.settings.bd` write-time sync (`payment.service.js:342-361`, pinned by `payment.config-sync.test.js:3-21`), the AI payment-authority wording contract (`shop-operating-context.service.js:76-104`, pinned by `shop-operating-context.payment-authority.test.js:51-60`), webhook replay/claim/amount guards (`payment-webhook.controller.js:47-183`, pinned by `payment-webhook.controller.test.js:41-250` + real-DB `payment-webhook.courier-race.integration.test.js`), and **platform billing** (below).
- **Billing stays separate.** EasyModerator subscription/topup invoices settle through `src/modules/subscription/invoice-payment.service.js` + `topup.service.js`, which use **platform-level env credentials** (`BKASH_*`, `invoice-payment.service.js:24,31,141,244`) and the `invoices` table — never merchant `payment_configs`. The `payment_transactions` table currently lives under `src/modules/billing/payment-transaction.entity.js` but is a *merchant-order* table; billing does not read it for platform invoices. This contract re-parents that entity (file move + ownership note), not its consumers' semantics.
- **Storefront COD unaffected.** `storefront.service.js:381` hard-codes `payment_method: 'COD'`; out of scope, must keep passing its test (`storefront.service.test.js:175`).

Preserved-correct (do not re-implement, the audits in the task brief confirmed): the dead-vs-broken inventory in §7.

---

## 1. Canonical payment vocabulary + storage redesign

### 1.1 Vocabulary (one enum across DB/API/FE)

Providers: `cod | bkash | nagad | rocket`.
Account semantics per provider — this is the key reframe from today's single confusing `mfs_mode`:

| provider | account_type | Meaning | Verification ceiling (§2) |
|---|---|---|---|
| `cod` | `n/a` (single row, no credentials) | cash collected on delivery | `live_certified` n/a — COD never needs certification; ladder unused |
| `bkash` | `self` | personal bKash wallet number | `configured_unverified` |
| `bkash` | `business` | business-category wallet number (still manual send + merchant confirm) | `configured_unverified` |
| `bkash` | `merchant_gateway` | official Tokenized Checkout v2 merchant account | `live_certified` (only path allowed to automate) |
| `nagad` | `self` \| `business` | wallet number | `configured_unverified` — **official verification unavailable** |
| `rocket` | `self` \| `business` | wallet number (merchant-number payments run ONLY through the self-MFS ladder; no official create/execute/verify API exists) | `configured_unverified` — same copy |

The three-way collapse today:

- DB entity enum allows only `('cod','self-mfs')` (`payment-config.entity.js:47-50`) while the API validator accepts `cod|self-mfs|bkash|nagad|rocket` (`payment.validator.js:21-28`) and `savePaymentConfig` re-rejects everything after aliasing `bkash→self-mfs` (`payment.service.js:8-10,272-275`). So a Nagad row cannot exist at all, Rocket label is absent from the customer prompt (`order-session-standalone.service.js:246-255` shows only "bKash / Nagad"), yet `VALID_MFS_TYPES` admits `rocket` inside credentials (`payment.service.js:12`).
- The FE stores merchant-gateway credentials inside the same `self-mfs` row with `mfs_mode: 'merchant'` (`PaymentSettings.tsx:198-211`), which `normalizeMfsMode` rewrites to `business` (`payment.service.js:23-27`) — merchant gateway is indistinguishable from a business personal wallet in storage. `merchant_gateway` must be an explicit account_type, never smuggled through `mfs_mode`.

**Decision:** introduce a single canonical module `src/modules/payment/payment-taxonomy.js` exporting `PROVIDERS`, `ACCOUNT_TYPES`, `VERIFICATION_LEVELS`, `CLAIM_STATUSES`, `LABELS` (en+bn, all three providers labeled — fixes the Rocket prompt gap). Entity ENUMs, validators, services, notification helpers and the chatbot machine all import it — no local arrays. FE gets a mirror constants file (`src/app/components/payment/taxonomy.ts`) with a mirror-invariant test, following the precedent already established in this worktree (HEAD `ee67f243` "backend pins for mirror invariant"). Legacy alias `self-mfs` is tolerated at the API boundary for one release (maps `self-mfs → provider=bkash? no —` see §1.2) and rejected in new payloads.

Because historical rows carry provider only inside encrypted `credentials.mfs_type`, the alias mapping for stored `gateway='self-mfs'` rows is resolved from credentials during migration (§1.3), not by assuming bkash.

### 1.2 Two candidate designs — evaluated

**Option A — replace `payment_configs` with `payment_accounts` keyed (shop_id, provider, account_type).**
Safest execution: **rename in place**, not create-copy. `ALTER TABLE payment_configs RENAME TO payment_accounts` — in PostgreSQL the existing FK `orders.payment_method_id → payment_configs(id)` (`20260522_004_fix_schema_drift_orders_delivery.js:54`, entity `order.entity.js:135-143`) follows the rename automatically (constraint records the OID, not the name), so every historical order's attribution FK stays valid by construction, `ON DELETE SET NULL` preserved. No retarget migration needed; `down()` renames back. Raw-SQL audit shows the only physical-name references are migrations + one comment (`payment-webhook.controller.js:259`) + entity registry alias string (`entities.js:400`) — code-level rename blast radius is the model `tableName` + that comment.

**Option B — extend `payment_configs` in place** (add `provider`, `account_type`, drop the partial unique `(shop_id, gateway)` `20260522_003_fix_schema_drift_auth_billing.js:94` and the squash-era `UNIQUE(shop_id, provider)` table constraint `20260520_000_initial_schema.js:576`, add partial unique `(shop_id, provider, account_type)`).

Both options need the same legacy-constraint surgery; both preserve `id` values. Differences:

- A gives the clean vocabulary the mission asks for ("payment_accounts" is the model the redesign implies: multiple accounts per provider, account-level verification state, account-level preference). FK validity is equally safe via rename.
- B has a smaller diff (no table rename; ~10 consumers keyed on `PaymentConfig`/`payment_configs` untouched by name) and avoids touching `orders` FK metadata at all.
- Both are data-preserving and idempotent with the same column work.

**Pick: Option A implemented as rename** — **DECISION-NEEDED [D-1]**. Rationale: the redesign's whole point is per-account verification/preference semantics; a row that models *one account* and is called `payment_config` invites the same alias soup again. The rename keeps FKs and ids intact, so "safest with rollback story" is satisfied (down = rename back + column drops, rows never leave the table). If the orchestrator prefers minimum diff at this pre-pilot stage, Option B delivers identical runtime semantics; the contract below is written so only the table/model name flips between A and B.

### 1.3 Target schema + migration `20261126_002_payment_accounts.js`

`20261126_001` is already taken by `faq_question_lifecycle.js` on this branch; numbering continues `002`, and payment-transactions hardening gets `20261126_003_payment_transaction_integrity.js` (separate file so a failed integrity pre-flight does not strand the account model — **DECISION-NEEDED [D-2]**: one combined file vs two; recommend two).

`payment_accounts` (from renamed `payment_configs`):

```
id                 UUID PK                       (unchanged; orders FK target)
shop_id            UUID NOT NULL → shops          (unchanged)
provider           VARCHAR(20) NOT NULL           (REUSE legacy column, backfilled canonical: cod|bkash|nagad|rocket)
account_type       VARCHAR(24) NOT NULL           (n/a → 'standard' for cod; self|business|merchant_gateway)
gateway            VARCHAR(50) NULL               (LEGACY, kept one release, dual-written compat value — §1.4)
is_enabled         BOOLEAN NOT NULL DEFAULT FALSE (unchanged; is_active stays, unused, dropped later)
credentials        TEXT NULL                      (unchanged AES-256-CBC envelope — do not re-wrap;
                                                   payment-config.entity.js:5-27 documents why not GCM)
config             JSONB                          (unchanged)
verification_level VARCHAR(24) NOT NULL DEFAULT 'unverified'  (ladder §2)
is_preferred       BOOLEAN NOT NULL DEFAULT FALSE (§6)
created_at/updated_at                              (unchanged)
```

Unique: partial `CREATE UNIQUE INDEX … ON payment_accounts(shop_id, provider, account_type)`. Drops first, in-transaction: legacy `UNIQUE(shop_id, provider)` (look up constraint name via `pg_constraint`, squash-era, `20260520_000:576`) and `idx_payment_configs_shop_gateway` (`20260522_003:94`) — both with existence guards (columns may already differ per environment; the codebase's migration style is `IF EXISTS` everywhere, e.g. `20260823_002_reconcile_legacy_entity_drift.js:41-73`).

Backfill (before adding the unique, same transaction):
1. `gateway='cod'` rows → `provider='cod'`, `account_type='standard'`.
2. `gateway='self-mfs'` rows → decrypt-not-required: `mfs_type`/`mfs_mode` live inside the encrypted TEXT, so backfill is done **in Node using the existing model getter** (Sequelize getter decrypts; `payment-config.entity.js:59-79`), not raw SQL. Mapping: `mfs_type→provider`; `mfs_mode self→self`, `business→business`, legacy `merchant→business` **unless** credentials contain `app_key`/`app_secret` AND `username` → then `merchant_gateway` (this is exactly what the FE stored for merchant mode, `PaymentSettings.tsx:198-211`). This recovers the today-lost distinction.
3. Rows with NULL both `gateway` and `provider` (drift survivors): classify `provider` from legacy `provider` column if in enum set, else `cod`; log to migration report.
4. Postgres-side idempotency guards everywhere (`ADD COLUMN IF NOT EXISTS`, partial unique with duplicate pre-flight that **fails the migration with a row report**, the established pattern of `20261026_001_order_idempotency_unique.js` — its test `20261026_001_order_idempotency_unique.migration.test.js:44-57` shows the convention: reject, never silently dedupe).

FK validity: none to retarget under Option A (rename). Under Option B (no rename) also none. Orders attribution defect fix in §3.5 is a *write-path* fix, not a schema change.

`20261126_003_payment_transaction_integrity.js` — **FINAL (A0 integration 2026-11-26): no third file ever landed. The integrity work is FOLDED: `payment_account_id` FK + index live in `20261127_001`, the `(shop_id, transaction_id)` uniqueness and the §4.4 `(order_id) WHERE status IN ('initiated','processing')` active-attempt partial unique live in `20261127_002` (coordinator ruling: migrations stay the 001/002 pair). Everything below this line describes the folded content.**
- `ADD COLUMN payment_account_id UUID REFERENCES payment_accounts(id) ON DELETE SET NULL` (+ index) — rows must attribute to the *exact account* displayed to the customer (no silent number switching, §6). Entity `payment-transaction.entity.js` moves from `src/modules/billing/` to `src/modules/payment/` (require-path change in `entities.js` + ~10 importers; consumers' semantics unchanged).
- Partial unique `(shop_id, transaction_id) WHERE transaction_id <> ''` — today there is **no** unique on `transaction_id` (`payment-transaction.entity.js:78-86` all non-unique; DB `20260520_000:615-617` same), while both the webhook replay claim (`payment-webhook.controller.js:52-58`) and the owner-approval lookup (`owner-notification.service.js:253-261`) implicitly assume transaction_id uniqueness. Pre-flight duplicate check + fail-with-report, per the 20261026_001 pattern.
- Status vocabulary comment → `pending | initiated | payment_claimed | processing | paid | verified | failed | rejected` (`payment_claimed` is the new self-MFS claim state, §3; the column stays VARCHAR — enum migration on a live-status table is not worth the risk; taxonomy module is the validator).

**Down() honesty:** 002 down = restore dual-write inverse (backfill `gateway` from provider/account_type — already present), drop added columns, drop new unique, recreate old partial unique + legacy constraint, rename back. 003 down = drop index/column/constraints. Both refuse to run down if `payment_claimed` rows would collide with legacy uniques — state that in-file, honestly.

### 1.4 Compatibility window (dual-write)

During rollout, `savePaymentConfig`/its successor **writes both** `gateway` (legacy canonical: `cod` | `self-mfs`) **and** `provider`/`account_type` on every mutation, so unchanged readers keep working:
- `getEnabledPaymentGateways` (chatbot, `order-session-standalone.service.js:1738-1751`),
- `resolveApprovalPaymentGateway` (`owner-notification.service.js:43-88`),
- `order.service.js:579-591,952-965` (payment_method_id verification),
- `payment-webhook.controller.js:259-260` (FK stamp),
- FE `credential_summary` contract (`payment.controller.js:23-55`, `api/domains/payment.ts:15-23`, `PaymentSettings.tsx:113-146`).
Second release removes `gateway` column + aliasing (`payment.service.js:8-10`). This is the only "functionality preservation" tax; paying it in one migration + one cleanup is cheaper than converting all readers in the same PR.

---

## 2. Verification ladder + certification records

Per account (`payment_accounts.verification_level`), strictly ordered, plus an append-only evidence table `payment_account_verifications` (`id, payment_account_id, level, method, evidence JSONB, performed_by_user_id, provider_environment, created_at`):

| Level | Meaning | Set by |
|---|---|---|
| `unverified` | row exists, no check since creation/credential change | default |
| `configured_unverified` | credentials present + locally validated (format/schema), **no provider contact** | save path |
| `sandbox_verified` | a documented **sandbox** provider cycle succeeded (bKash v2 create→query; §2.2) | explicit owner "test" action only |
| `live_certified` | provider go-live evidence recorded by the owner; app never declares this itself | owner action + evidence string + audit + row in `payment_account_verifications` |

Credential-change invalidation: any new `credentials` write demotes the level to `unverified` and stamps a `configured` record — so a stale `sandbox_verified` can never survive credential edits.

- **Nagad / Rocket:** maximum reachable level is `configured_unverified`. Surface copy (both tabs, exact): *"Official automated verification is not available for Nagad/Rocket. Payments to these numbers are confirmed by you (the merchant), never automatically."* Automation is inert: no API calls, ever, for these providers (docs sweep found no public official API; sandbox mirrors are unofficial). Their wallet payments run only through §3.
- **bKash `self`/`business` (wallet numbers):** same ceiling — they are §3 accounts, by design.
- **bKash `merchant_gateway`:** the only automatable account kind, and only at `live_certified`.

### 2.1 bKash credential check primitive — respects the 2 grant/hour hard limit

Documented limit: **2 grant+refresh per hour per merchant app** (docs sweep). Current code violates this on every settings interaction: `testPaymentConnection` is regex-only today (`payment.service.js:369-389`) so it is safe but mislabels; `bkash-merchant.service.js:37-63,314-347` would hit `/oauth/token` on every call and caches **per-process only** (`base-merchant.service.js:43` `new Map()`), so N replicas = N× grant traffic.

New design (all merchant-gateway provider traffic):
1. **Token store moves to Redis** (`utils/cache.service` precedent) keyed by `account:{id}:token`, holding id_token + refresh_token + a per-hour attempt counter; TTLs per docs (1h/30d). In-process Map cache is deleted from `base-merchant.service` for this path.
2. **Nothing implicit.** Save, toggle, list, dashboard load NEVER call the provider. The only grant-bearing action is the explicit owner endpoint `POST /api/payment/accounts/:id/verify-credentials` (bKash merchant only).
3. **Server-enforced cooldown:** if `payment_account_verifications.last credentials_check` < 30 min ago → return the cached verdict, no network; a sliding-window counter refuses more than 2 grants+refreshes per rolling hour per account, returning `429 CREDENTIAL_CHECK_RATE_LIMITED (2 per hour per bKash app)` with the honest message.
4. Classification honesty: grant success (v2 `POST /auth/grant-token`, username/password headers + app_key/app_secret body) = **`CREDENTIALS_VALID` evidence record** — it does NOT raise the ladder above `configured_unverified` and the response must not say "connected"/"verified live". Response copy: *"bKash accepted your app credentials (one of 2 hourly checks used)."*

### 2.2 `sandbox_verified` semantics — **DECISION-NEEDED [D-3]**

bKash Tokenized Checkout v2 sandbox (`tokenized.sandbox.bka.sh`, `/v2/tokenized-checkout/…`) allows: grant → **Create Payment** (taka BigDecimal string, `currency: 'BDT'`, `merchantInvoiceNumber`, `callbackURL`) → assert `paymentId + bkashURL + signature` shape → **Execute** on a simulated return is not possible without the sandbox OTP flow, but **Query Payment {paymentId}** works server-to-server and returns `transactionStatus` + `verificationStatus` + `merchantInvoice`.
Recommendation: define `sandbox_verified` = successful grant + create + query with invoice-echo match (the checkout-handshake half of the documented flow), *not* a completed payment. Record `method: 'sandbox_create_query'`. If the orchestrator wants full-cycle proof (create→execute→'Completed'), that needs sandbox-OTP completion by a human through the hosted page — out of scope for app automation; default to create→query and say so in the surface copy ("sandbox checkout handshake verified; no settlement implied"). Either way this NEVER applies to production creds, and `production-config.validator.js:204` already refuses `BKASH_ENABLED=true` with `BKASH_SANDBOX != false` — keep that gate.

### 2.3 `live_certified` — recorded, never self-declared

`POST /api/payment/accounts/:id/certify-live` (owner-only): requires non-empty `evidence` (provider go-live/approval reference, e.g. "bKash onboarding email 2026-11-30"), writes an append-only `payment_account_verifications` row, sets `verification_level='live_certified'`, writes an `AuditLog` (`AuditLog.create` pattern already used at `owner-notification.service.js:298-309`). Revocation: credential change (§2 invalidation) or owner action.

**A9-R2 amendment (2026-11-26, F-2 — supersedes the old "only a `sandbox_verified` account can be certified" prerequisite, which contradicted §2.2: the sandbox handshake may NEVER run on production credentials, so a production-only merchant could not legitimately reach the rung §2.3 required).** Certification now requires, all of: (i) `account.config.environment === 'production'` **explicitly recorded on the row** — unset/legacy rows are refused with `400 PROVIDER_ENVIRONMENT_NOT_PRODUCTION` and sandbox rows with the same code (no env-var fallback may mint a production attestation); (ii) owner role + 3–500-char evidence (unchanged); (iii) current level is any non-archived rung (`unverified` / `configured_unverified` / `sandbox_verified` all certifiable **from** the production posture; an already-`live_certified` row refuses idempotently). The recorded `provider_environment` is the ACTUAL resolved environment, asserted equal to the config value (a mismatch throws `PROVIDER_ENVIRONMENT_MISMATCH` and records nothing). Symmetrically: ANY write that flips `config.environment` demotes the ladder (append-only `configured_unverified` event, reason `environment_changed`) and clears the account's Redis token/grant cache — same policy as a credential change; and the money paths (`createPayment`/`settleFromQuery`/execute/query/refund via `assertMoneyMovementAllowed`) additionally refuse any account whose RESOLVED environment is not production (`GATEWAY_ENVIRONMENT_NOT_PRODUCTION`) while the sandbox handshake (§2.2/D-3) remains sandbox-only as before.

**Automation enable predicate** (single helper in taxonomy module, used by gateway initiation §4, chatbot eligibility §6, and the settings tab):
`isAutomatable(account) = account.is_enabled && account.provider==='bkash' && account.account_type==='merchant_gateway' && account.verification_level==='live_certified' && BKASH_ENABLED==='true' && credentialsComplete(account)`. Anything below → the account is *displayed* in settings with its honest level, and the customer-facing path for its provider is §3 (self-MFS) or COD.

No new flags (§8.4).

---

## 3. Self-MFS merchant verification flow (chatbot, Priority 2)

### 3.1 Today (defect anchors)

- Chatbot picks a gateway (`COLLECTING_PAYMENT`, `order-session-standalone.service.js:907-927`); selecting "self-mfs" sets `payment_method` and moves on — the order lands `payment_status:'pending'` (`:252-255,1885`) and **nothing else happens in the payment domain**: no claim, no row, no merchant notification.
- `handleOwnerResponse` REQUIRES an existing `PaymentTransaction` matching `transaction_id` (`owner-notification.service.js:253-265`), but the only production writer of such rows is `bkash-merchant.service.js:266-280` — unreachable because it queries `gateway:'bkash'`, which the enum never allows (`payment-config.entity.js:47-50`). Net: the merchant-confirmation machinery exists end-to-end (approve/reject endpoints `notification.routes.js:24-64`, guards, audit, customer response `:489-528`) with **nothing that ever creates the input**.
- The one live caller of `sendPaymentConfirmationRequest` is a wrong trigger: delivery-failure (`delivery-tracking.service.js:564-582` passes `{type:'delivery_failure', …}` with no `paymentMethod`/`transactionId`/`customerMessage`), and the formatter then crashes on `paymentInfo.paymentMethod.toUpperCase()` (`owner-notification.service.js:380,399`) — swallowed only because the caller wraps in try/catch logging (`:589-594`).
- OwnerNotification rows are created without `expires_at` (`:358-367`) although the column exists (`owner-notification.entity.js:55-59`) and `handleOwnerResponse` honors it (`:192-194` → 410). The expiry guard is dead as written.

### 3.2 New chatbot sub-flow (inside the existing machine, no redesign beyond payment steps)

After the customer selects an MFS provider (word-mapping extended per §6: "bkash"/"বিকাশ"/"nagad"/"নগদ"/"rocket"/"রকেট" → matching enabled wallet account):

1. **Display exactly one number:** the *preferred* enabled wallet account for that provider (§6 selection rule), with the amount due for this payment step (order total minus any advance-rule effect §5 — for the current MVP: amount due = the advance amount required by policy, else full total). Prompt template extends `buildPaymentPrompt`'s sibling: `Send ৳{amount} to {providerLabel} {number}. Then type your Transaction ID.` (single number only — never list alternatives; "no silent number switching" starts here).
2. **Collect `trxId`** (normalize: uppercase, strip spaces, `^[A-Z0-9]{6,16}$` — consistent with `self-mfs-handler.service.js:242` and the 8-10-char reality at `:48-51`) and **optionally the sender number** (BD-phone-validated). Ask the sender number once; accept "skip". **Never request an OTP** and never request a screenshot as a requirement (screenshot may be *offered* as optional support evidence via the existing attachment path).
3. **Create the claim** — service `payment/payment-claim.service.js` (new):
   - Re-validate: order belongs to shop+session, `payment_status` still `pending|unpaid`, amount == the displayed amount (server-recomputed, never customer-supplied).
   - Duplicate check: `TrxIDLog` unique `(shop_id, trx_id)` is already DB-enforced (`trx-id-log.entity.js:65-68`; DB `20260522_003:109`, archive `20260331_001:64-66`) **and** the new `payment_transactions` unique `(shop_id, transaction_id)` (§1.3-003). Insert TrxIDLog first (audit ledger: trx_id, mfs_type, amount, sender_phone, order_id, receiver_phone = the account number used, `ocr_raw: null`, `verified_at: null` — nothing is "verified" here), then `PaymentTransaction.create({ order_id, shop_id, payment_method: provider, payment_gateway: null, transaction_id: trxId, amount, status: 'payment_claimed', payment_account_id, gateway_response: { source:'self_mfs_claim', sender_phone, screenshot_url? } })`. Race-safe: unique violations → "this TrxID was already used" reply (same message family as `self-mfs-handler.service.js:255-265`).
   - Notify: call the **fixed** `sendPaymentConfirmationRequest(shopId, orderData, { paymentMethod: providerLabelSafe, transactionId: trxId, screenshotUrl: optional, customerMessage })` — with `expires_at: now+24h` now actually set. The merchant reaches approve/reject through the existing dashboard list (`/api/notifications/in-app`, `notification.routes.js:70-93`) and the explicit action route; the payment-confirmation notification must NOT be dismissible-as-read (`:113-118` already enforces this pin).
   - Reply to customer: `We’ve received your payment details (TrxID {x}). The shop owner will confirm shortly. ✅ পেমেন্ট তথ্য পেয়েছি। দোকান মালিক নিশ্চিত করবেন।` — **no "paid", no "confirmed", no order-status change.**
4. **Merchant approve/reject** — unchanged endpoints, now actually fed:
   - `handleOwnerResponse` approve path stays byte-for-byte: terminal-order guard (`:207-216`), COD-routed-to-settlement-action guard (`:217-229` — `resolveApprovalPaymentGateway:43-88` must be extended to resolve via `provider`/`account_type` after the rename; during the compat window keep the `gateway` dual-write so it works unchanged), courier-claim reconciliation guard (`:245-252`), transaction match + `payment_claimed|pending|initiated|processing` status gate (`:253-265`; add `payment_claimed` to the accepted list — today `:263` accepts `pending, initiated, processing`, so a literal new status name requires touching exactly this line: keep it minimal).
   - Approve ⇒ order `paid/confirmed`, transaction `verified` (`:267-276`) — settlement evidence = **merchant action on a matched claim**, per the existing guards. Screenshot, if attached, is supporting display only, never auto-approval (invariant §0).
   - Reject ⇒ cancel order path + transaction `rejected` (`:277-288`).
   - Customer notified through the existing eligibility gate: `sendCustomerResponse` → `webhook.service.sendToCustomer` (`owner-notification.service.js:489-528`, gate `webhook.service.js:343-444`: needs customer PSID, messenger channel, transactional type). Unreachable customer = logged skip, order state unaffected.
5. **Timeout:** claim expires (24h) → owner response returns 410 (`:192-194`); a small cron (existing scheduler pattern) flips expired `payment_claimed` rows to `failed`? — **DECISION-NEEDED [D-4]**: recommend *do nothing automatic* except surfacing "expired" in the merchant inbox (the row stays `payment_claimed` with `notification.status='expired'`; auto-failing payments on merchant inattention is a business decision, and manual assistance is the third path anyway).

### 3.3 Crash + trigger fixes (required before any of the above works)

- `formatPaymentConfirmationMessage` null-safe (`owner-notification.service.js:380,399`) — use `String(paymentInfo?.paymentMethod || 'Manual payment').toUpperCase()` style, and take provider label from taxonomy.
- `delivery-tracking.service.js:564` must stop misusing the payment-confirmation type: emit a `RTO`/order-review style owner notification instead (`notification-events.js` already has `ORDER_REVIEW_REQUIRED`/`COURIER_BOOKING_FAILED` vocabulary and the dashboard list reads OwnerNotification rows directly). **DECISION-NEEDED [D-5]** exact event for delivery-failure notices — recommend reuse `NOTIFICATION_EVENTS.ORDER_REVIEW_REQUIRED` channel-less dashboard+email row; it is not payment work, keep it out of the payment claim contract except as the crash source.
- `sendPaymentConfirmationRequest` sets `expires_at`; returns the created row; **fix `createDashboardNotification` honesty** (`:469-484` — currently a no-op that reports success; the real dashboard surface is the OwnerNotification row via `/in-app`; change the label to "queued" or actually create nothing and note the row IS the dashboard notification).

### 3.4 Chatbot eligibility wiring

`shop-operating-context.service.js` (write-time-synced `settings.bd`, pinned hot-path-free: `shop-operating-context.payment-authority.test.js:51-55`) keeps its mechanism but gains truthful multiprovider wording from the new account model: preferred wallet accounts → "advance payment via bKash/Nagad/Rocket to {number}"; `merchant_gateway live_certified` accounts → "automated bKash payment link available" (only at live_certified — never earlier). The write-time sync in `payment.service.js:342-361` must extend to write, for each *enabled wallet* account, the same bd-shaped truth (currently single-number: `settings.bd.mfs_*`). Because `hasSelfMfs` is single-valued (`shop-bd-settings.js:87-90`), **DECISION-NEEDED [D-6]**: (a) extend `settings.bd` to `{ default_wallet: {provider,account_type,number,mfs_mode}, wallets: [...] }` keeping `mfs_*` legacy keys for one release, or (b) let the AI context read an account-summary snapshot cached at write time (same single-read-path property the pin protects). Recommendation: (b) — a `settings.bd.wallets[]` array written only by the account save path (still write-time sync, no hot-path PaymentConfig query), legacy `mfs_*` keys kept = preferred wallet for all other consumers (`self-mfs-handler.service.js:68` owner-number fraud exemption reads `settings.bd.mfs_number` — must keep working).

### 3.5 Attribution defect fix

Chatbot-created orders stamp `payment_method` but never `payment_method_id` (`order-session-standalone.service.js:1885-1886`), while every guard that matters (`resolveApprovalPaymentGateway`, `order.service.js:574-591`, webhook `:259`) wants the account FK. Fix: carry the chosen `payment_account_id` in session `step_data` from the payment selection, pass it into `createOrderInternal` → `order.service.js:739` already persists `payment_method_id`. This closes the audit finding and is a prerequisite for §6's number-locking.

---

## 4. Gateway payment initiation — bKash Tokenized Checkout v2 (Priority 1, `live_certified` only)

Rewrite `bkash-merchant.service.js` against the documented v2 contract; keep its safe patterns (error-code-only logging `bkash-merchant.service.js:14-23`, pinned by `bkash-merchant.logs.test.js:24-53` — the rewrite must keep this file's intent and its redaction suite green).

Endpoints (docs sweep, authoritative): base `https://tokenized.sandbox.bka.sh` (sandbox) / official production base per onboarding; paths under `/v2/tokenized-checkout/…`:

1. `POST /auth/grant-token` — headers `username`,`password`; body `app_key`,`app_secret` → `id_token`(1h)/`refresh_token`(30d). **≤2 grant+refresh/hour** — enforced by the §2.1 Redis token store + counter. Refresh path uses the documented refresh grant; both count against the limit.
2. `POST /create/payment` (tokenized create): `amount` taka BigDecimal string, `currency:'BDT'`, `merchantInvoiceNumber` = `orders.order_number`, `callbackURL`. Response: `paymentId`, `bkashURL`, `signature`. On success create `PaymentTransaction { transaction_id: paymentId, status:'initiated', amount, payment_account_id, order_id, shop_id, gateway:'bkash', gateway_response:{ createSignature:true (never store raw secrets) } }`.
3. Customer pays on the hosted bKash page; app returns to our frontend.
4. `POST /execute/payment` — **once**, with `{paymentId}`, on customer return (browser-return leg is a trigger, not evidence). Response yields `trxId`, `transactionStatus` (title-case `'Completed'`), `paymentExecuteTime`. Payment is executable **once** — a second Execute returns already-completed errors, therefore: **failed/timeout/ambiguous Execute must NEVER be retried blindly; fall to Query.**
5. **STATUS VERIFICATION = `POST /query/payment {paymentId}`** → `transactionStatus` + `verificationStatus` + `merchantInvoice`; this Query result is the settlement evidence that flips order → paid (via the same `processSuccessfulPayment` claim machinery, §4.2). `general/search-transaction {trxId}` is the reconciliation cross-check only.

### 4.1 Case/canonicalization notes

Current codebase has both spellings: `bkash-merchant.service.js:173,237` compare `'Completed'` while `bangladesh-payment.service.js:122` compares `'COMPLETED'` for the same v1 execute field. The docs confirm tokenized v2 returns title-case `'Completed'`. The new client compares case-insensitively against the taxonomy's canonical set — this also removes the demonstrated mismatch class without depending on which spelling a given legacy endpoint uses.

### 4.2 Webhook / async confirmation

`POST /api/webhooks/bkash/payment-status` (`payment-webhook.routes.js:32-37`, mounted `app.js:132`, rawBody captured `app.js:124-127`) keeps its **structure** (rate limit, atomic claim, replay dedupe — pins `payment-webhook.controller.test.js:41-250`, real-DB race pin `payment-webhook.courier-race.integration.test.js:152+`) but the trust chain changes:

- **Replace** the invented `x-bkash-signature` HMAC scheme (`webhook.middleware.js:14-65` comments claim "B1/B17" — the docs sweep found no such browser-redirect HMAC in tokenized v2). New verification = the documented IPN/SNS-style handshake (certificate/subscribe model per onboarding; exact scheme pinned by the provider integration doc at implementation time). If, at implementation, the provider scheme cannot be verified with the artifacts we hold, the webhook is **disabled** and confirmation rides on: customer-return → single Execute + Query, plus scheduled Query-reconciliation for stale `processing`/`initiated` rows (§4.3).
- **Callback body status alone is never settlement evidence.** Even after signature verification, `handleBkashWebhook` must call server-side **Query Payment** and require `Completed + verificationStatus pass + merchantInvoice === order_number + amount minor-units equality` (the existing amount/invoice/txnId strictness at `payment-webhook.controller.js:87-102` stays — its tests keep pinning it) before invoking `processSuccessfulPayment`. Order: verify scheme → load transaction by paymentId → atomic claim to `processing` (unchanged `:106-118`) → **Query** → confirmed ⇒ fulfill (unchanged `:188-379`, reconciliation flags, invoice generation `:312-314`, no session touch `:294-306`, transaction terminal `paid` only after fulfillment attempt `:347-357`) → Query-not-completed ⇒ release claim back to the PRE-CLAIM status **`initiated`** — A9-R2/F-1 2026-11-26 corrected the original `pending` ruling: `pending` is invisible to `ACTIVE_ATTEMPT_STATUSES` (re-initiation 409), to the 20261127_002 partial unique on (`initiated`,`processing`) and to the §4.3 reconciler scan, so releasing there opened a duplicate-charge hole (a second live link could coexist with the still-payable first one while nobody reconciled it); CAS (`WHERE status = 'processing'`) unchanged and defer to §4.3.

### 4.3 Failure / timeout / reconciliation

- Execute timeout or network error ⇒ mark nothing; schedule (existing stale-report machinery `payment-processing-reconciliation.service.js:26-90`, admin surface `admin.routes.js:18`) a bounded Query-retry per `initiated/processing` row (e.g. 1/5/15/30 min), always via Query — **never** a second Execute.
- Query says `Initiated/Pending` ⇒ row stays; customer sees "payment still processing — do not pay again" (session-linked message).
- Query says `Failed/Cancelled` ⇒ `failed` (customer can re-attempt; see 4.4).
- Manual path stays: support/dashboard reconciliation (this report is read-only by pin `payment-processing-reconciliation.security.test.js:14-29`).

### 4.4 Duplicate-attempt prevention

An order with an active `PaymentTransaction` in `initiated|processing|payment_claimed` **blocks new initiation** (`409 PAYMENT_IN_PROGRESS`) until it reaches a terminal state — same guarantee billing already earns with its checkout lease (`invoice-payment.service.js:109,136,178`; adopt the lease-row or a status-guarded unique partial index `(order_id) WHERE status IN ('initiated','processing')` — recommend the index (DB-enforced, migration-able) + friendly 409). Cancel-before-repaid: the browser-cancel path mirrors `cancelInvoicePayment` (`invoice-payment.service.js:406-454`) — but for orders it must **Query first**; if Query shows Completed, it settles rather than cancels.

### 4.5 Refunds

Documented path `/refund/payment/transaction` with `paymentId+trxId+refundAmount`, 60-day window (docs sweep). Expose owner-only `POST /api/payment/transactions/:id/refund` (merchant role check + audit + record refund id in `gateway_response`). Not chatbot-facing. Current refund in `bangladesh-payment.service.js:196-229` (v1, env creds, billing-only) stays untouched for billing.

### 4.6 Billing separation guard (explicit)

`invoice-payment.service.js` + `topup.service.js` consume `BangladeshPaymentService` with **platform env credentials** — they are EasyModerator's *own* bKash account. The new v2 merchant client is a different class (`bkash-tokenized-v2.service.js`), different credentials source (`payment_accounts`), different tables (`payment_transactions` vs `invoices.payment_id`). Do not "unify" them. The `payment_transactions` unique `(shop_id,transaction_id)` addition must be scoped so billing flows (which write `invoices`, not `payment_transactions`) are unaffected — verified: billing never creates PaymentTransaction rows (`grep PaymentTransaction.create`: only `bkash-merchant.service.js:269` + one test).

---

## 5. Advance payment policies — from fake persistence to server truth

### 5.1 Current state (worse than "never consumed" — never even stored)

FE writes `POST /shop/update { payment_methods: JSON.stringify({advancePaymentRule, advancePercentage, advanceFixed, paymentMessage}) }` (`PaymentSettings.tsx:329-352`, radio values `none|full|delivery|percentage|fixed` `:56,368-398,690-725`). But **`payment_methods` is not a column of `shops`** (schema `20260520_000:141-155`) and **not an attribute of the Shop entity** (no match in `shop.entity.js`) — `shop.update(nextUpdate)` (`shop.service.js:264-301`) silently drops unknown attributes, and `getShop` can never return it (`PaymentSettings.tsx:154-159` parses what is always `undefined`). The server validator `.trim()`s it (`shop.validator.js:43-45`) as a string and nothing consumes it. Separately, `settings.ai.payment_methods: ['COD']` (`shop-defaults.js:49`, `setup-status.service.js:143-158`) is a *different* legacy chat vocabulary — do not conflate. No backend anywhere reads an advance rule (`grep advancePaymentRule` in BE: zero hits).

Net honest statement for the redesign doc: the current "advance payment policy" is a UI illusion; the FE's own green suites pin only the request shape (mocked), so fixing it breaks nothing server-side, but it *does* break two FE pins (§8.3).

### 5.2 Target model

Persist in `shop.settings.payments` (JSONB on the existing `settings` column — no new table; policy is shop-level, not account-level), via a **dedicated validated endpoint** so it stops masquerading as a shop name field:

```
PATCH /api/payment/policy   (owner, CSRF+auth like existing payment routes)
settings.payments = {
  advance_policy: 'none' | 'full' | 'delivery_charge' | 'percentage' | 'fixed',
  advance_value:  integer,            // percentage: 1..99  | fixed: poisha-safe taka 1..100000
  payment_message: string ≤ 500 chars,
  updated_at, updated_by
}
```

Cross-field rules (server, Joi): `percentage ⇒ advance_value ∈ 1..99`; `fixed ⇒ advance_value ≥ 1`; `none/full/delivery_charge ⇒ advance_value null`. The "fixed > 0 and ≤ order" part is order-relative and therefore enforced at **checkout math**, not config save: at computation, clamp `advance = min(fixed, order_total)` and if `fixed ≥ total` treat as `full` — never silently exceed. (`delivery` renames to `delivery_charge` in the canonical enum; `paymentMessage` preserved verbatim — same key name in settings for migration simplicity: `advancePaymentRule→advance_policy`, `advancePercentage|advanceFixed→advance_value`, `paymentMessage→payment_message`.)

**'delivery_charge' authority:** the advance equals the **delivery charge computed by the existing zone machinery** — `stepData.delivery_charge` from `_advanceAfterZone` (`order-session-standalone.service.js:1701-1727`) and the zones/charges in Delivery Settings are the single authority. The policy engine must *reference* that number, never recompute or store a duplicate fee. This is a hard rule in the contract.

**§5.2 AMENDMENT (2026-11-26, F1/BLOCK ruling + R-17 — display-only advance for self-MFS):** the F1 fix wave made every self-MFS claim collect the **FULL order total** regardless of the stored advance policy (`payment-claim.service.computeClaimAmount` returns `amount = total`, `amount_basis='full'`; approving a below-total claim is refused 409 `CLAIM_AMOUNT_BELOW_ORDER_TOTAL`). Until live-certified gateway automation ships, advance rules (none/full/delivery_charge/percentage/fixed) are therefore **display-only for the only live money path**: the chatbot ALWAYS asks the customer for the full total, and the computed advance survives ONLY as the recorded snapshot (`gateway_response.payment_policy`) for honest merchant review and future gateway automation. The delivery_charge authority above continues to govern *what the policy engine computes for the snapshot* — it must still reference the zone number, never recompute a fee — but that computed number is not a claim amount on self-MFS. The merchant-facing surfaces (Policies tab copy) must state this; a first-class UI that promises enforcement of a rule the machine no longer applies is the round-2 MAJOR this amendment closes.

**Consumption:**
1. Checkout/chatbot: ~~payment prompt line "Order total ৳{t}. Advance required now: ৳{a} ({policy reason}). Pay on delivery: ৳{r}" — advance amount becomes the *claim amount* in §3.2~~ **SUPERSEDED for self-MFS by the F1/BLOCK ruling + R-17 (see the §5.2 amendment above): the chatbot's prompt collects the FULL order total on every self-MFS claim; the policy value is recorded and surfaced as display truth only (with `amount_basis='full'`), never as a partial claim number.** The gateway-side parenthetical remains the ratified rule: gateway create amount follows the policy ONLY once live-certified gateway automation ships — gateway path requires policy ∈ {none, full} to initiate a gateway payment; percentage/fixed never auto-initiate (D-7 as amended); partial gateway capture is not a v2 tokenized feature.
2. `order.metadata.payment_policy = { policy, value, advance_amount, remainder, snapshot_at }` stamped at order creation (server-side, from settings — never trusted from the customer).
3. AI wording: `shop-operating-context.service.js` block (§3.4b) may mention an advance policy only when `settings.payments.advance_policy != 'none'`; `payment_message` (≤500 chars, sanitized as text) may be appended to payment instructions verbatim, with the same "merchant confirms, screenshot ≠ confirmation" guardrails (no OTP, no screenshot-claim language).

### 5.3 Migration

No data to migrate (it was never persisted). FE `savePaymentSettings` switches to `PATCH /api/payment/policy`; the "persisted as blob via /shop/update" e2e/unit pins are migrated in §8.3 with intent preserved (radio state machine + input enablement + server-echoed persistence), and the FE additionally gains a validation-error display (400 messages from the real endpoint replace silently-loved success).

---

## 6. Preferred method + fallback rules engine

Single function `resolvePaymentOptions(shopId, ctx)` (new `payment/payment-rules.service.js`), consumed by chatbot (`getEnabledPaymentGateways` replaces internals, keeping its `['cod','self-mfs']`-shaped compat output during the §1.4 window), the Payment Methods tab (preview column), and the gateway initiation eligibility check. Inputs: enabled accounts + ladder + `is_preferred`, policy (§5), COD availability (zone policy from Delivery Settings — COD is offered only when the zone is serviceable by COD; today zone detection routes to payment regardless — keep: COD row exists ⇒ COD offered, *and* storefront/order flows already gate on delivery serviceability; no new zone logic is created here), runtime flags.

Order of eligibility:
1. **Gateway-eligible bkash merchant accounts** (`isAutomatable`, §2.3) — preferred first. Shown to customer as "Pay with bKash (automatic confirmation)". Only reachable when live_certified; below that, invisible in chatbot (settings tab still lists it, with its honest level).
2. **Self-MFS wallet accounts**, preferred provider first, then by `is_preferred`; one number displayed per selection (§3.2), never a list of alternatives mid-flow.
3. **COD** per policy (manual assistance path; the existing `COLLECTING_PAYMENT → COD` machine and settlement guards unchanged).

Customer choice honored: if the customer names a *visible* method, use it (`extractPaymentGateway` extended keyword map per provider in taxonomy: bkash/বিকাশ, nagad/নগদ, rocket/রকেট, cod/cash/সিওডি). Explicit choice beats preference; absence of choice uses preferred. **No silent number switching:** once a claim or gateway attempt is created, `payment_account_id` is stamped (§1.3-003, §3.5) and every subsequent read (notification, dashboard approval detail, refund) uses the *stamped* account, even if the merchant edits accounts afterwards; the approve UI shows the number the customer was given (from `payment_account_id`) as part of the evidence context.

Legacy `platform_priority.payment` array uses raw `'bkash'` while configs store `'self-mfs'` (guardrail pin `payment-guardrails.spec.ts:183` PUTs `['bkash','cod']`; `PaymentSettings.tsx:33,292` canonicalize only on the config POST side). **DECISION-NEEDED [D-8]**: canonicalize priority to `{provider, account_type}` tuples (breaking the FE pin, honest model) vs keep string ids but define them = `provider` (bkash means "the preferred bkash account of either kind"). Recommendation: keep `platform_priority.payment` as provider-ordered strings (`cod|bkash|nagad|rocket`) = *display* order only, and move true method preference to `payment_accounts.is_preferred` (DB truth, §1.3) — priority stops pretending to select credentials; FE default-election CTA then sets `is_preferred` via the payment API instead of PUTing shop priority (and the `'bkash' vs 'self-mfs'` split-brain disappears).

---

## 7. Misleading-claim cleanup map (every string/endpoint that must change)

| # | Site (file:line) | Today claims | Must become |
|---|---|---|---|
| 1 | `payment.service.js:384` `testPaymentConnection` → "`{mfs_type} number verified`" (regex-only, `:73-101,369-389`) | a *verified* provider connection | `formatValidated` — response `{status:'format_validated', message:'Number format validated — not a provider check'}`; FE button label "Validate format" (wallet) / "Check credentials (rate-limited by bKash to 2/hour)" (gateway) |
| 2 | FE test/save mock copy `payment-guardrails.spec.ts:99` `'Number verified'`, `payment-settings.spec.ts:46` `'Connection verified'` | same | updated to new strings with §1 (#8.3 pins migrate together) |
| 3 | Switch gating `PaymentSettings.tsx:523-524,275-294` enables non-COD toggle once *saved*, regardless of verification | "enabled ⇒ customers can pay" | enabled ⇒ display honest level chip (`unverified`… `live_certified`); **payment path selection (§6) uses the ladder, `is_enabled` alone must never imply payability**; signal `derivePaymentSignal` may keep enabledCount semantics but tooltip gains level detail |
| 4 | `base-merchant.service.js:7-8` docstring cites `NagadMerchantService`, `RocketMerchantService` (no such files — verified `find` zero) | classes that don't exist | docstring rewritten to the real single merchant service + explicit "Nagad/Rocket: no official API — intentionally absent" |
| 5 | `bkash-merchant.service.js:27-29,52,98,154,218` v1.2.0 checkout + `oauth/token` password-grant | current bKash product | replaced wholesale by §4 v2 tokenized client (create/execute/query/search/refund). `validateConfig` (`:314-347`) folds into §2.1 rate-limited check |
| 6 | `payment-config.entity.js:47-50` enum + `payment.validator.js:21-28` + `payment.service.js:272` | three disagreeing vocabularies | single taxonomy (§1.1); validator == enum == service |
| 7 | `order-session-standalone.service.js:246-255,1753-1786` labels/keywords (no Rocket label, 'self-mfs' prompt) | providers as one blob | per-provider labels + keywords from taxonomy (§3.4) |
| 8 | `bangladesh-payment.controller.js:83,108,139,171` calls `getPaymentStatus`/`refundPayment` (don't exist) and `processPaymentCallback(payment_method, data)` (arity: service takes one arg `bangladesh-payment.service.js:169`) on unmounted routes (`route-perimeter.test.js:20` pins unmount) | a working BD API | **DECISION-NEEDED [D-9]** delete dead trio (`bangladesh-payment.controller/routes` + `smart-payment-detection.service.js:116` phantom `bkash-merchant` gateway, zero importers — verified) vs repurpose `simulate` (`bangladesh-payment.controller.js:293-344`, dev-only `bangladesh-payment.routes.js:95-112`) into a clearly-labelled contract-test. Recommendation: delete controller+routes (keep `bangladesh-payment.service.js` — billing depends on it, §4.6), delete smart-payment-detection; simulate stays deleted (its `SIM_*` ids would collide with the new transaction uniqueness story and nothing pins it beyond its own disabled test file §8.1) |
| 9 | `webhook.middleware.js:14-65` `x-bkash-signature` HMAC with invented "B1/B17" comment | provider signature | official v2 IPN/SNS scheme + mandatory server-side Query (§4.2); `BKASH_WEBHOOK_SECRET` requirement story updated (`production-config.validator.js:35-49,102` + its pins `production-config.validator.test.js:75-97` + `render-production-env.test.js:354`) |
| 10 | `payment.routes.js:32-37` `paymentCallbackAuth` middleware array built but applied to **no** route | callback hardening | wire to whatever callback routes exist post-redesign (currently none) or delete; do not leave dead security theater |
| 11 | `owner-notification.service.js:380,399` unguarded `.toUpperCase()` + `delivery-tracking.service.js:564` wrong trigger | payment notifications work | §3.3 fixes |
| 12 | `smart-payment-detection.service.js` (whole file) | an active options engine | deleted (#8) |
| 13 | `scripts/setup-secrets.js:95-99` collects `NAGAD_*` secrets never read by any code (grep zero in src) | Nagad automation readiness | **DECISION-NEEDED [D-10]** remove from the template vs annotate "reserved — no official API; code never reads these". Recommendation: **remove** (collecting unreadable secrets is a liability; the honest note lives in the settings-tab copy for Nagad, §2) |
| 14 | FE `PaymentSettings.tsx:506-514,183-186` `requiresContact` mailto branch (AamarPay/SSLCommerz) — no gateway ever sets it | integrations needing contact | delete dead branch (both providers remain out of scope; "contact us" stays only if a real gated feature list exists) |
| 15 | FE advance-policy "saved" success while server drops it silently (§5.1) | policy persisted | §5.2 endpoint + real error surfacing |
| 16 | `payment-webhook.controller.js:445-468` `handleOwnerPaymentConfirmation` — unreachable (no route; contract test only mocks it, `webhook.routes.contract.test.js:5-8`) | an inbound owner webhook | delete; dashboard route is the single owner-response path (`notification.routes.js:24-64`); keep its mock-out cleanup or the route still doesn't exist |
| 17 | `bangladesh-payment.service.js:122` compares `'COMPLETED'` for a field docs return `'Completed'` (billing verification path `verifyBkashPayment`, used by `invoice-payment.service.js:244`) | correct completion detection | **billing-path defect, flagged not silently fixed**: case-insensitive comparison per §4.1 canonical set; billing has zero live traffic today (prod has never run the lifecycle — memory), so fix it in the same PR with an explicit unit pin flip, calling it out in the PR body |

---

## 8. Migration + test-pin inventory (what breaks, how intent survives)

### 8.1 Backend test pins (all paths under `EasyMod-backend/`)

| Test | What it pins | Disposition |
|---|---|---|
| `src/modules/payment/__tests__/bangladesh-payment.disabled.test.js:39-97` | fail-closed choke point: `BKASH_ENABLED`+all creds or **no network** (503, axios untouched) | keep as-is for the billing service (§4.6); add the equivalent suite for the new v2 client (`isAutomatable` false ⇒ zero HTTP) — same intent, stricter target |
| `src/modules/payment/__tests__/bkash-merchant.logs.test.js:24-53` | provider-error logging redacts PII/amounts, code-only | migrate to v2 client; keep `safeErrorCode` pattern (§4) |
| `src/modules/payment/__tests__/payment.cod-confirmation.test.js` | COD settlement: owner/admin only, delivered-required, courier-reconciliation blocks, `payment_reconciliation.required` guard | untouched — §0 preserves COD settlement verbatim |
| `src/modules/payment/__tests__/payment.config-sync.test.js:3-21` | disable/delete self-mfs clears `settings.bd` (P0-3 write-time sync) | intent moves to account-disable/delete for *the preferred wallet* (legacy `mfs_*` keys); add per-account invalidation pin (§2) |
| `src/modules/payment/__tests__/payment.controller.serialization.test.js:21+` | save response never echoes decrypted credentials | untouched (sanitize stays, `payment.controller.js:23-55`); extend to new account list endpoints — same allowlist discipline |
| `src/modules/payment/__tests__/self-mfs-handler.audit-log-failure.test.js:42-107`, `self-mfs-handler.media-security.test.js` | TrxIDLog write fail-closes; safe-fetch for screenshots | untouched (handler stays merchant-side review helper; §3 uses its duplicate/format patterns but does NOT rewire it into the checkout claim path — the source-grep pin below forbids that) |
| `src/modules/payment/__tests__/payment-processing-reconciliation.security.test.js:14-29` | stale-processing report is read-only, ops-alerts | untouched; §4.3 reuses it |
| `src/modules/order/__tests__/order-session-standalone.steps.test.js:650-734` | COD-only skips the payment question; 2nd gateway asks; legacy `AWAITING_MFS_SCREENSHOT` recovers with **no verification claim** (`:709-712`); **source-grep pins** `:729-734` (`verifyPaymentScreenshot` absent, no "Payment confirmed", no `mfs_payment_verified=true`) | source pins preserved verbatim (§0 invariant); machine tests gain cases for the new claim sub-steps (§3.2) without weakening the pins; `enabled_gateways` shape stays `['cod','self-mfs']`-compat during the §1.4 window so existing mocks `[{gateway:'cod'}]` keep passing, then flip to provider rows in the cleanup release (test intent: *which* gateways cause a prompt vs auto-select — unchanged) |
| `src/modules/order/__tests__/order-session-standalone.{createorder,freetext-edit,mode-clamp,variant-commit}.test.js` (+ `courier-dispatch-idempotency.test.js:11`) | mock self-mfs-handler at import | keep mock lines (file exists) — §0 keeps the module |
| `src/modules/order/__tests__/order.routes.payment-method.test.js:24-57` | REST payment correction = owner/admin gate on both routes | untouched |
| `src/modules/order/__tests__/order.service.test.js:368-488`, `order.validator.test.js:139`, `order.controller.test.js:141` | payment_method_id alias/conflict, tenant check, "COD cannot be created paid" | untouched (§3.5 reuses the same validator path; add a pin: chatbot-created order now carries `payment_method_id` from the session) |
| `src/modules/notification/__tests__/owner-notification.security.test.js:82-322` | approve/reject guards: tenant match, gateway-config consistency (`:201-299` uses `payment_method_id` variants incl. *foreign* + *disabled* config → reject), terminal/courier guards | untouched; add the `payment_claimed` acceptance pin + expiry(410)-now-reachable pin (§3.2-5). `resolveApprovalPaymentGateway` keeps working via §1.4 dual-write |
| `src/modules/notification/__tests__/notification-payment.routes.security.test.js` | approve/reject route: other-shop 403, owner-only membership | untouched |
| `src/modules/webhooks/__tests__/payment-webhook.controller.test.js:41-250,+280-400` | replay dedupe 200/202/409, atomic claim before fulfillment, amount-minor-units equality, invoice match, no session touch, fulfillment-only terminal `paid`, `payment_method_id` stamp (`:259`) | structure stays; new required test: *confirmation path performs server-side Query before settle* (§4.2) — existing mocks of axios/service (`:26`) extend; every kept assertion survives |
| `src/modules/webhooks/__tests__/payment-webhook.courier-race.integration.test.js:54-160` | real-DB webhook+courier-booking race: one claim wins | untouched (reuses `payment_method:'bkash'` string rows — still valid: the payment_method string on PaymentTransaction stays provider vocabulary) |
| `src/modules/webhooks/__tests__/webhook.middleware.test.js:7-58` + `webhook.routes.contract.test.js:5-8,66-73` | HMAC pinning of the *invented* signature; route contract | rewrite to official scheme (§4.2); contract test drops the dead `handleOwnerPaymentConfirmation` mock (#7 row 16); `/api/webhooks/bkash/payment-status` route contract itself stays |
| `src/middleware/__tests__/payment-callback-auth.middleware.test.js` | HMAC/IP/POST-only guards of the unused array | follow #7 row 10 (wire-and-keep or delete-with-intent-memo) |
| `src/modules/ai/__tests__/shop-operating-context.payment-authority.test.js:51-60,+` | hot path must not query PaymentConfig; COD-vs-selfMFS wording | wording gains providers (§3.4); the **no-hot-path-query source pin survives by design** (write-time sync only, §3.4b) |
| `src/modules/ai/__tests__/action-gate.contract.test.js:188-210`, `production-defaults-matrix.test.js:89,145,212` | ACCEPT_PAYMENT kill-switch fail-closed; defaults matrix | untouched (no flag changes) |
| `src/security/__tests__/route-perimeter.test.js:20` | bangladesh routes **not mounted** | survives deletion (line becomes a not-exists assertion) |
| `src/config/__tests__/production-config.validator.test.js:75-97` | `BKASH_WEBHOOK_SECRET` required iff bKash enabled, not core otherwise | updated for scheme change (#7 row 9); requirement stays true-when-enabled |
| `scripts/__tests__/render-production-env.test.js:66,225-265,354,368,396-409` | template renders BKASH_* block only when enabled; `BKASH_ENABLED=false` in example; AI_PAYMENT flag strict-bool | BKASH_* block kept for billing; NAGAD_* removal (#7-13) touches its own pins (none known beyond the template); no new flags (else these tests must gain them — by design they fail on drift) |
| `src/modules/subscription/__tests__/invoice-payment.service.test.js:19,34`, `topup.service.test.js:14,25` | billing mocks the BD service | untouched — proof of §4.6 separation |
| `src/database/__tests__/*.migration.test.js` (convention incl. `20261026_001…:44-57` duplicate-fail pattern, `legacy-entity-drift.migration.test.js:15-17`, `schema-drift-sweep.migration.test.js:70,96`) | migration style | new 002/003 files must ship equivalent drift + duplicate-rejection tests |

### 8.2 New backend tests the contract requires (not "evolutions")

ladder transitions + credential-change demotion; grant-check cooldown/2-per-hour (fake timers, zero extra HTTP); claim create → TrxIDLog unique + PaymentTransaction unique race → "already used" reply; approve path end-to-end on `payment_claimed`; policy validation matrix (all 5 enums × bounds); `resolvePaymentOptions` precedence incl. `live_certified` gate; webhook requires Query confirmation before settle; order attribution `payment_method_id` stamped on chatbot orders.

### 8.3 Frontend pins (all paths under `EasyMod-frontend/`)

| Pin | Site | Intent | Migration |
|---|---|---|---|
| allowlist+abort discipline | `tests/e2e/payment-guardrails.spec.ts:23-34,50-59` | invented backend calls fail CI | add new paths (`/api/payment/accounts…`, `/api/payment/policy`) to `KNOWN_PATHS`; everything else survives unchanged |
| header/signal | `payment-guardrails.spec.ts:144-152`; `PaymentGuardrails.test.tsx:82-103`; `payment/derive.ts` | execution header (§29), enabledCount signal | 2-tab shell keeps the header; signal inputs extend with ladder chip *without* changing derive() semantics (its unit pins `:68-79` survive) |
| test→save order, exact credentials | `payment-guardrails.spec.ts:154-165`; `PaymentGuardrails.test.tsx:124-150` | format-check before save, secrets never echoed | same order retained; wallet flow calls the renamed `validate-format` endpoint; gateway flow calls the rate-limited check endpoint and shows cooldown states |
| switch gating behind saved creds | `payment-guardrails.spec.ts:167-173`; `PaymentGuardrails.test.tsx:106-121` | no activation before config | unchanged, plus ladder honesty copy (#7 row 3) |
| default election PUT `['bkash','cod']` | `payment-guardrails.spec.ts:175-186`; `PaymentGuardrails.test.tsx:161-172` | one CTA reorders priority | per D-8 recommendation → becomes "Set preferred" hitting the payment API (test intent: *explicit, confirmable preference change* — preserved; the old shape's pin is retired deliberately) |
| advance radios → persist JSON blob via `/shop/update` | `payment-guardrails.spec.ts:188-199` (`:196-197` parse), `payment-settings.spec.ts:155-164`, `PaymentGuardrails.test.tsx:174-188` | radio state machine, dependent input enablement, one-click persist | same UI assertions retained; persistence switches to `PATCH /api/payment/policy` with server validation errors surfaced; blob test renamed intent: "policy persists and round-trips from the server" |
| merchant-mode honesty "Automated checkout is not active yet" | `payment-guardrails.spec.ts:201-208`; `PaymentGuardrails.test.tsx:152-158`; `en.json:3032` | never imply live gateway | becomes the **ladder component**: at below-`live_certified` exactly this family of copy (per §2); the forbidden-string pin (`…via official merchant API` absent until certified) stays forever |
| hydration from `credential_summary` | `payment-settings.spec.ts:107-124` | secrets never returned; summary round-trips | unchanged contract (§1.4), fields gain provider/account_type |
| 390px + axe | `payment-guardrails.spec.ts:210-232` | responsive + a11y (reducedMotion) | must pass on the 2-tab build as-is |
| mock env `VITE_BKASH_ENABLED=false` | `playwright.config.ts:43` (+3 configs) | FE renders gateway as disabled | unchanged |
| API domain types | `src/api/domains/payment.ts:15-53` | masked `PaymentConfig` shape | gains provider/account_type/verification_level/is_preferred (additive, compat `gateway` kept §1.4) |
| dead `requiresContact` branch | `PaymentSettings.tsx:183-186,292` never-true | (nothing pins it) | delete (#7 row 14) |

---

## 9. Scope guard list + provider-inert rules

Out of scope, explicitly untouched: chat **settings** redesign, orchestration/AI reply machinery, **billing** (`invoice-payment.service`/`topup`/invoices — §4.6), order-module redesign, courier/delivery redesign, storefront, reports module, Growth OS, mobile, AI certification surface. No new Meta permissions or scopes; no new feature flags (only existing `BKASH_ENABLED`, `AI_PAYMENT_ACCEPTANCE_ENABLED`); no activation of any mode; no chatbot redesign beyond the payment steps enumerated in §3-§5.

Provider-inert rules (enforced by `isAutomatable` + the new fail-closed test family §8.2): Nagad — zero outbound calls, ladder capped at `configured_unverified`, wallet-number payments via §3 only. Rocket — identical to Nagad (its merchant-number payments are exactly the §3 flow; no create/execute/verify API exists). bKash `self|business` — §3 only. bKash `merchant_gateway` below `live_certified` — §3-equivalent display only, no initiation surface in chat. Platform billing bKash (env creds) — separate account of separate semantics; never merged, never re-verified by merchant surfaces.

## 10. Orchestrator checklist (confirm before implementation)

1. **[D-1] Storage design:** Option A rename-to-`payment_accounts` (recommended, §1.2) vs Option B extend-in-place. FK safety equal; naming/diff tradeoff is the ruling.
2. **[D-2] Migration split:** `20261126_002_payment_accounts.js` + `20261126_003_payment_transaction_integrity.js` as two files (recommended) vs one.
3. **[D-3] `sandbox_verified` definition:** create→query handshake only, with explicit "no settlement implied" copy (recommended), vs requiring human-completed sandbox payment.
4. **[D-4] Expired claims policy:** surface "expired" to merchant, no auto-fail (recommended), vs scheduled auto-`failed`.
5. **[D-5] Delivery-failure notification replacement event** (`ORDER_REVIEW_REQUIRED` dashboard+email vs new type) — non-payment owner action, needs a ruling to unblock the crash fix.
6. **[D-6] `settings.bd` multiprovider shape:** `wallets[]` array with legacy `mfs_*` keys = preferred wallet (recommended) vs separate cached snapshot mechanism; must keep the hot-path pin green.
7. **[D-7] Advance-policy × gateway:** percentage/fixed policies never trigger a gateway link (v1 rule, recommended) vs partial gateway capture — confirm the v1 clamp rules (§5.2).
8. **[D-8] Preference model:** `payment_accounts.is_preferred` (DB truth) + `platform_priority.payment` demoted to display order (recommended) vs breaking priority into tuples; the `['bkash','cod']` guardrail pin changes either way.
9. **[D-9] Dead-code disposition:** delete `bangladesh-payment.controller/routes` + `smart-payment-detection.service` + dead owner-confirm webhook handler + unused `paymentCallbackAuth` (recommended), vs rewrite-in-place; `bangladesh-payment.service.js` stays (billing).
10. **[D-10] `NAGAD_*` env template:** remove from `setup-secrets.js:95-99` (recommended) vs annotate-as-reserved; also ratify #7-row-17 (billing `'COMPLETED'` case fix shipped as an explicit, pinned defect correction, not silently).

---

## A0 RATIFICATION (orchestrator decisions, 2026-11-26)

All ten draft decisions RATIFIED as recommended:

- **D-1 rename→`payment_accounts`** RATIFIED (clean semantics; FK-follows-rename verified safe per draft §2; two migrations D-2 RATIFIED: 20261127_001 rename+columns+backfill, 20261127_002 constraints+index swap — each idempotent, real down, additive-first ordering).
- **D-3 `sandbox_verified` = create→Query handshake, "no settlement implied"** copy RATIFIED — the UI must render exactly that sentence; `live_certified` remains a recorded human/provider act only (append-only cert records + audit).
- **D-4 expired claims surfaced, never auto-failed** RATIFIED (merchant judgment is the settlement authority; no silent money state).
- **D-5 `ORDER_REVIEW_REQUIRED`** replaces the crash-causing delivery-failure→payment-notification misfire RATIFIED; the original delivery-failure notification intent stays served by the existing courier exception path.
- **D-6 `settings.bd.wallets[]` + legacy `mfs_*` mirrors the preferred account** RATIFIED (hot-path chatbot pin stays honest because getEnabledPaymentGateways/operating-context read the mirror; every write keeps mirror consistent via single writer).
- **D-7 advance percentage/fixed NEVER auto-initiate gateway links in v1** RATIFIED — chatbot asks the customer to send the computed advance via the ladder's chosen path (self-MFS claim flow carries the amount tolerance rule; mismatch → surfaced to merchant, never auto-rejected/silently accepted). **AMENDED 2026-11-26 by the F1/BLOCK ruling (R-17):** the "computed advance" leg of this sentence is SUPERSEDED for self-MFS — because nothing enforces a remainder-on-delivery there and merchant approval settles the whole order, the chatbot asks for the **full order total** on every self-MFS claim; the computed advance remains ONLY as the recorded policy snapshot + display truth (and the gateway-link prohibition above stands unchanged — percentage/fixed still never auto-initiate until live-certified gateway automation ships).
- **D-8 `is_preferred` column = DB truth; `settings.payment_platform_priority` demoted to display order only** RATIFIED, including the DELIBERATE breaking of the `['bkash','cod']` PUT-shape e2e pin — migrated pin now asserts: exactly one preferred per shop, canonical provider vocabulary, preference changes are owner writes, and the legacy endpoint keeps working for the display list (no dual authority: preferred lives in payment_accounts).
- **D-9 dead-surface deletion** RATIFIED with one hard caveat: any file with a LIVE importer (verified by grep at deletion time in the PR) is rewired, not deleted — specifically `bangladesh-payment.service.js` STAYS (billing), `smart-payment-detection.service.js` must be proven unreferenced or its callers rewired to the new ladder before removal; deletion list otherwise: unmounted bangladesh controller/routes, phantom service-name doc comments, unused paymentCallbackAuth middleware, the invented HMAC webhook handler replaced by the official v2 scheme.
- **D-10 `NAGAD_*` removal from secrets template + billing `verifyBkashPayment` casing fix ('COMPLETED' → compare title-case 'Completed' per official docs) + `expires_at` set on payment confirmations** RATIFIED as pinned DEFECT CORRECTIONS, each with a test proving intent; billing remains architecturally separate (invoice flows untouched otherwise; `ACCEPT_PAYMENT` flags untouched).

Additional orchestrator rulings beyond D-1..D-10:
- **R-11 Migration numbering:** this branch is created from `b8d2d465`; the Business & FAQ branch (20261126_001) lands on main FIRST (release serialization). Payment migrations are numbered 20261127_001/002 to sort after it regardless; before this branch's PR the branch rebases onto updated main and re-runs the full lanes including the two-migration chain against disposable PG16 + `schema:audit` + cutover drill + restore-drill `forward_migration_image` rehearsal with the new backend digest.
- **R-12 Verification ceiling is INERT by default:** every gateway automation gate requires (ladder rung) AND (runtime flag false-by-default) AND (credentials present) — with no live credentials in this environment, all new automation code paths ship exercised ONLY by contract-level mocks (official-doc-derived fixtures, clearly marked), and the founder-visible status for every account is at most `configured-unverified` / `Credentials validated (format)` — never "verified with provider".
- **R-13 Self-MFS is the default money path shipped today** and must be FULLY functional + honestly labeled after this work (claim → pending record → merchant approve/reject → customer notification via eligibility gate), since no merchant's gateway rung exists yet.
- **R-14 One PUT pair per tab** stays the write contract (methods config API + policies API); no chatbot orchestration or messaging-policy edits beyond the payment steps themselves.
- **R-15 Verdict discipline:** final report must present per-provider verification status honestly (mock-contract-tested vs live-verified) and founder UAT must include the live-credential certification legs as explicit external dependencies.
- **R-17 Self-MFS full-total collection + double-settle closure + certify production-rung contract** (A9 round-2 fix wave, 2026-11-26, closing the F1/BLOCK money-integrity chain; supersedes the advance-as-claim-amount reading of D-7/§5.2 for self-MFS — see the §5.2 amendment): (i) **full-total collection** — `performClaim` mints every self-MFS claim at the FULL order total with the machine field `amount_basis='full'`; advance policies stay recorded/display-only until live-certified gateway automation ships; (ii) **ALREADY_SETTLED guard** — a double claim can no longer double-settle: `performClaim` answers an honest already-awaiting-review duplicate when the order already carries an open (`payment_claimed`) or settled (`verified`) claim, and `handleOwnerResponse`'s approve branch refuses 409 `ALREADY_SETTLED` on the LOCKED order row when `payment_status='paid'` — before any write, so no second verified transaction and no second customer "payment confirmed" message ever fires (both halves pinned: `payment-claim.service.test.js`, `payment-confirmation.claim-flow.test.js`); (iii) **certify production-rung contract** — `live_certified` is mintable ONLY from an account whose `config.environment` is EXPLICITLY recorded `'production'` (F-2/A9-R2 rewrite of §2.3: the sandbox_verified prerequisite is REMOVED because §2.2 forbids the handshake on production creds; every non-archived rung is certifiable from the production posture; the recorded `providerEnvironment` is the ACTUAL resolved environment asserted equal before any write), and ANY environment change — PATCH, POST-upsert, or the legacy `POST /api/payment/config` writer (B2, R-16 §1.4 window) — demotes through the ONE exported policy `applyEnvironmentChangeDemotion` + records `environment_changed` + clears the token cache, so no rung ever attests a posture the row no longer records.

---

## A0 INTEGRATION LEDGER (2026-11-26, implementation-time decisions recorded per ratification)

These are integration-wave rulings made while wiring A2/A3/A4/A5's delivered
modules together. Where a draft line said something different, this ledger is
the shipped truth (it supersedes §1.3's 003 mention in place above).

**Migrations.** Final shape is the RATIFIED pair 20261127_001/002 — no 003.
§4.4's `(order_id) WHERE status IN ('initiated','processing')` partial unique is
folded into 002 (coordinator ruling 2026-11-26); `payment_claimed` rows are
deliberately NOT in that predicate (D-4: merchant judgment owns claim rows; the
claim service guards duplicates at (shop_id, trx_id) instead). 002's duplicate
pre-flight fails with a row report per the 20261026_001 convention. Both files
are now enumerated on the WIPE/FRESH sync path (`src/utils/database/sync.js`,
postgres-gated like the founder-pilot set — production `migrate.js`
auto-discovers; this closes A5-Q7/A4-Q7 for the R-11 rehearsal).

**D-9 executed.** Deleted: `bangladesh-payment.controller.js` +
`bangladesh-payment.routes.js` (zero production importers; the billing service
that survives is `bangladesh-payment.service.js` — kept per §4.6),
`smart-payment-detection.service.js` (grep-verified ZERO importers anywhere),
the dead `paymentCallbackAuth` middleware ARRAY +
`middleware/payment-callback-auth.middleware.js` + its unit test (§7 row 10,
with the intent memo now in payment.routes.js), and the unreachable
`handleOwnerPaymentConfirmation` controller method + its mock in
webhook.routes.contract.test.js (§7 row 16). route-perimeter.test.js flipped to
not-exists assertions. base-merchant.service.js docstring rewritten to the
truth (§7 row 4: Nagad/Rocket merchant classes never existed; automation
intentionally absent).
KEPT (live-importer rule): `bkash-merchant.service.js` + `base-merchant.service.js`
retained — `bkash-merchant.logs.test.js` still imports the former, and per D-9
"anything with a live importer stays, note it." A future cleanup wave may retire
the pair together with that test (its redaction intent is already migrated to
bkash-tokenized.logs.test.js). `PAYMENT_CALLBACK_HMAC_SECRET` stays
core-required: flipping the validator core list would touch
production-config.validator.test / production-defaults-matrix /
render-production-env(.test) / auth-rate-limit pins — out of D-9 scope here and
recorded as an A6-wave candidate.

**Secrets posture.** `NAGAD_*` collected-no-more: removed from the
`setup-secrets.js` template with an explanatory note (D-10 ratified).
`BKASH_WEBHOOK_SECRET` requirement UNCHANGED (required iff BKASH_ENABLED=true,
no new env var) — its comment now documents the honest role: deployment
shared-secret TRANSPORT gate inside webhook.middleware.js, never settlement
evidence (the §4.2 mandatory server-side Query is the evidence chain).

**Scheduler (§4.3 wired).** New `src/jobs/gateway-attempt-reconciler.job.js`,
registered in jobs/index.js + queue-manager (queue `gateway-attempt-reconciler`,
manual trigger `gateway_attempt_reconciler`, schedule every minute). The
1/5/15/30 cadence is PER ROW inside `reconcileStaleGatewayAttempts` via the
attempt ledger in `gateway_response.reconcile` (max four provider Queries per
attempt, then quiet — admin read-only report path untouched). BKASH_ENABLED off
⇒ zero sweep HTTP (R-12); throwing passes still consume a rung (bounded by
construction).

**Verdicts & copies.** Test-before-save intent (spec-audit #5) is satisfied
SERVER-side: `savePaymentAccount`/`updatePaymentAccount` format-validate
credentials BEFORE persist and reject with 400s; the e2e pins assert the causal
property (a validation failure never persists) rather than literal call order.
The drawer's sandbox/production selection now PERSISTS to
`account.config.environment` (spec-audit #7), which
`bkash-tokenized.resolveEnvironment()` reads; the verify banner states which
environment was exercised. `modeSelfHint` legacy copy rewritten to the honest
screenshot-is-supporting-evidence wording (§0 invariant; spec-audit #6). Ledger
`evidence` column aligned to JSONB on the entity (spec-audit #9).

**Ratified numeric/behavioral values (previously open):** claim amount
tolerance = max(৳5, 5%) of the server-computed due (mirrors the self-MFS-handler
family; A4-Q5) — mismatch is recorded + merchant-surfaced, never auto-rejected.
Non-mobile sender phone ⇒ treated as not-provided on the machine path, null on
the API path (A4-Q6). NULLABLE provider/account_type at DB level stands (A5-Q6):
an undecryptable row stays honest (null), never coerced to cod. FE taxonomy:
canonical mirror `src/app/components/payment/taxonomy.ts` pinned against the
backend module by `payment-taxonomy.mirror.test.ts`; `payment-settings/taxonomy.ts`
projects it (single vocabulary source, closing A2-Q6).

---

## ROLLBACK RUNBOOK (R-16) — image revert safety after migration 20261127_001/002

Added by the A9 round-2 fix wave (2026-11-26, F-4). The adversarial finding:
the reader/rollback **floor image** (main lineage ≤ `ad79cd9c`, backend `53c6ebb1`)
ships a `PaymentConfig` model bound to table **`payment_configs`** — after the
001 rename that table does not exist, so reverting ONLY the app image (the
documented fast rollback path on the OCI host) would have produced a total
payment table outage (every read AND write of the old image).

**The fix lives in the migration, not in runbook discipline:**
`20261127_001.up()` now ends with

```sql
CREATE OR REPLACE VIEW payment_configs AS
SELECT id, shop_id, gateway, is_enabled, credentials, config, created_at, updated_at
  FROM payment_accounts;
```

which reproduces the floor image's legacy attribute set (verified via
`git show 53c6ebb1:EasyMod-backend/src/modules/payment/payment-config.entity.js`)
verbatim, in legacy names. It is a **single-table view**, hence automatically
updatable in PostgreSQL: the old image's SELECTs, INSERTs, UPDATEs and DELETEs
against `payment_configs` pass through to `payment_accounts` transparently
(columns the view omits take their DB defaults on old-image inserts — the
legacy model never reads them). `down()` drops the view FIRST
(`DROP VIEW IF EXISTS payment_configs`) before the rename-back, so the guarded
`to_regclass('payment_configs') IS NULL` rename check is never poisoned by the
view's existence. Both are idempotent (`CREATE OR REPLACE` / `IF EXISTS`).

**Operator rules — absolute:**

1. **Rollback = image revert is SAFE** once 001 has been applied (it has, if
   the current release ran its migrations). Revert the backend image; the old
   code reads/writes `payment_configs` (the view) over the new table. No
   schema action is needed for a rollback.
2. **`db:sync` (sequelize `sync()`) must NEVER run against the migrated live
   DB.** The legacy model's sync would attempt `CREATE TABLE payment_configs`
   — colliding with the existing VIEW (name clash) — and an alter-style sync
   could orphan/destroy rows through the view or fail mid-way. Any tool or
   script path that calls sync must stay off production/staging DBs; this is
   the standing rule from the §1.4 compat window, now R-16 hardened.
3. **Migration 002's rollback rejects multi-account data LOUDLY.** `down()`
   throws rather than recreating the legacy `UNIQUE(shop_id, gateway)` when a
   shop holds several accounts on one gateway, and likewise for >1 `self-mfs`
   rows per shop (no rows are ever dropped). If a rollback is demanded while
   production holds multi-account data: (a) export the affected
   `payment_accounts` rows; (b) reconcile manually to one row per
   (shop, gateway) — merge credentials/config deliberately, keeping preferred
   account IDs — or keep the current schema and roll forward instead;
   (c) run `down()` only after the unique can legally hold. Re-running 001
   after a partial 002 rollback is safe (guards + `IF NOT EXISTS`).
4. **View hygiene:** the view exposes legacy columns only. If a future release
   drops `gateway` dual-write (§1.4 window end), the compat view must be
   dropped in the SAME migration that removes a listed column, and the
   rollback floor must be re-pointed to an image that no longer needs it.
5. Verification receipts for these pins live in the migration suite:
   `20261127_001_payment_accounts.migration.test.js` (view creation, legacy
   SELECT resolution, down-order, re-up idempotence, PG-only) and
   `20261127_002_payment_account_constraints.migration.test.js` (F-1 release-
   status coverage of the partial unique predicate).
