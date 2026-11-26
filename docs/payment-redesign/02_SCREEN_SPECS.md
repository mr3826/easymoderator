# 02 — Screen Specs — Payment Settings redesign (Guardrails v2 §26 blocks)

A1, 2026-11-26. Per-tab §26 spec for the two-tab workspace (`PaymentWorkspace.tsx`) at
`/manage-shop/payment-settings`: **Payment Methods** / **Payment Policies**. Component refs are
as-built in this worktree; where the spec demands something the code does not yet do, the row is
marked **[owed]** and belongs to the implementer whose file it is (matrix 01 §J lists the reasons).
Shell-level rules: execution-class header, **no header CTA** (§29), `.em-payment` token scope,
`MotionConfig reducedMotion="user"`, bn-first i18n through `manageShop.paymentSettings`.

Capability-boundary ground rules every block below enforces (contract §0/§2, A0 R-12/R-15):
- Pre-certification, ALL gateway automation is INERT: `isAutomatable = enabled ∧ bkash ∧
  merchant_gateway ∧ live_certified ∧ BKASH_ENABLED ∧ creds-complete` is false in this deployment
  (flag ships false; no live credentials). Nothing on either tab may call a provider implicitly —
  the ONLY provider-touching affordance anywhere in settings is "Check credentials" on a bKash
  **merchant_gateway** account (§2.1).
- The UI may claim, and only ever claim, exactly: *saved* (server-echoed), *format validated*
  (local regex/schema), *credentials validated (format)*, *sandbox checkout handshake verified;
  no settlement implied* (D-3 exact sentence), *live-certified — recorded by owner with evidence*
  (§2.3, never app-declared), *enabled/disabled*, *preferred/unpreferred*, *deleted*, *policy saved*.
  It may never claim: verified with provider, connected, "customers can pay automatically",
  any Nagad/Rocket verification beyond format, anything an OTP/screenshot proved (no OTP exists;
  screenshots are optional support only).

---

# Screen: Payment Settings — shell (both tabs)

## Merchant job
Decide, in one visit: which money paths exist for my customers (numbers/API/COD), how trustworthy
each one actually is (ladder), which one the chatbot prefers, and what advance (if any) buyers must
pay first.

## Page archetype
Execution-class settings (like Delivery Settings): configuration/editor archetype with a dominant
channel signal; the §29 header rule applies (title + signal + factual pills, no header CTA).

## Existing capability boundary
Everything in 01 §C compat window must keep answering; the shell itself makes exactly two reads
(`GET /api/payment/accounts`, `GET /api/payment/policy`) and one write pair per tab (R-14). No
billing data, no chatbot orchestration edits, no provider calls on load.

## Core Design Test (semantic)
- WHY HERE: one row/label per provider with its accounts beneath — "this is what a buyer sees".
- WHAT NOW: enable/disable, add/edit account, set preferred, record verification honestly.
- WHERE NEXT: link to Delivery Settings (COD availability / delivery charge), merchant inbox for
  pending claims (approve/reject stays there, never here).
- PROVEN RESULT: header pills (enabled count / preferred / advance rule) + per-account ladder chip,
  all echoed from the server after each mutation — never optimistic.
- Placement: pills in `PageHeader.meta`; tab strip beneath; panels carry the work surface.

## Screen regions
Header (title/signal/pills) · tablist strip (`role=tablist`, roving tabindex, Arrow±wrap, Home/End;
testids `payment-tab-methods|policies`, panels `payment-panel-*`) · Methods panel · Policies panel ·
Account drawer (portal-style fixed overlay, Methods only) · delete-confirm dialog (Methods only).

## States
- Loading: 3 pulsing skeleton cards until first response (`PaymentWorkspace.tsx:160-174`); signal
  reads `Loading payment methods` (`signal.pending`).
- Error (load): blocked signal + reason; the tabs never render stale-guessed data as fact.
- Success affordances come from server echo: policy Saved state = snapshot equality with the PUT
  reply; account mutations reload accounts only (unsaved Policies draft is never clobbered —
  `policyDirtyRef :75-100`).

## Responsive and accessibility notes
360px: header pills wrap; tab strip horizontal-scroll (`overflow-x-auto :203`); drawer `w-full`;
delete dialog stacks buttons (`flex-col sm:flex-row`). 390/360 both must show zero document
overflow. Keyboard: tablist keys above; drawer focus trap + restore (`useDialogFocus`), Esc closes,
overlay-click closes. axe: no critical/serious in `.em-payment`; run with reducedMotion (e2e E10).
Screen-reader labels on every switch (`aria-checked`, name = provider/account-type label).

## Explicit omissions
Billing/subscription anything; OTP; provider auto-verification; per-provider "verified" booleans;
screenshot as verification; any chatbot message beyond the payment steps themselves; Add-ons.

---

# Screen: Payment Settings — Tab 1 "Payment Methods"

## Merchant job
Answer: "How can customers pay me right now, and how honest is each option?" — manage COD, up to
three wallet providers (bKash/Nagad/Rocket), multiple accounts per provider (personal/business
wallet number, plus bKash Merchant API), enable/disable each, elect exactly one preferred, add /
edit / delete accounts, and (bKash Merchant API only) run the rate-limited credential check or
record a go-live certification.

## Page archetype
Configuration/editor archetype inside an execution-class page. Structure: provider-grouped account
list with a per-account editor drawer + confirm dialog — deliberately not the mock's data-table
grid (01 §I-14 forbids bulk actions; per-account affordances beat columns at 360px).

## Existing capability boundary (what automation is INERT, what the UI may claim)
- bKash **self/business** wallets and **all Nagad/Rocket** accounts: automation permanently inert —
  ceiling `configured_unverified`; payments confirm only through the merchant-claim flow (§3, judged
  in the inbox, never here). "Check" on these = `format_valid` only, `provider_contact:false`
  (`payment-verification.service.js:110-136`).
- bKash **merchant_gateway**: create/query/checkout automation reachable ONLY at `live_certified`
  AND `BKASH_ENABLED=true` — neither exists today (R-12). Below that rung the account is *displayed*
  with honest status but never offered to customers via gateway (chatbot falls to §3/COD).
- `automated_checkout_active` from the API is the only machine flag the UI may reflect, and even
  then copy stays "not active yet"-class below live_certified (§7-3, E8 forbidden-string pin).
- Nagad/Rocket rows always render the exact §2 notice, regardless of state.

## Core Design Test (semantic)
- WHY HERE: each provider row shows account count + enabled count + preferred star — the buyer-
  visible truth for that method.
- WHAT NOW: toggle a configured account, add one, set preferred (owner), manage/delete, run the
  honest check/certify actions in the drawer.
- WHERE NEXT: pending claims are confirmed in the merchant inbox (not here); COD availability +
  delivery charge live in Delivery Settings (link in Policies, B4-of-tab note below); billing is
  elsewhere on purpose.
- PROVEN RESULT: every mutation reloads from the server before any success is asserted
  (`MethodsTab.runAction → onMutate`; no optimistic flips — F3/vitest).
- Placement: per-account `VerificationChip` under each card; drawer header repeats it.

## Screen regions
1. **COD row** (`method-row-cod`) — single, credential-free; switch only (creates the row on first
   enable: `POST /api/payment/accounts {provider:'cod',account_type:'standard',is_enabled:true}`).
2. **Provider rows** (`method-row-bkash|nagad|rocket`): name + `N enabled` pill + accounts count +
   preferred badge + `Add account` (`add-account-{p}`) + expand chevron (`expand-{p}`) →
   `accounts-panel-{p}` listing account cards (`account-card-{id}`: channel label, stored number —
   gateway secrets never shown, chip, 44px switch, `preferred-toggle-{id}`, `manage-{id}`,
   `delete-{id}`).
3. **Account drawer** (`account-drawer`) — create/edit; regions: provider select (create), channel
   radios (`channel-option-*`, locked on edit + honest "add new to change channel" note), credentials
   section (wallet: `BDPhoneInput` + "confirmed by you, never automatically" hint; gateway:
   app_key/app_secret/username/password, always blank, replace-warning `replace-warning`),
   availability checkbox + honesty copy, verification section (below), save/cancel footer.
4. **Delete dialog** — named consequence ("existing orders keep attribution; this account stops
   being offered") + `confirm-delete-account` (danger) + cancel (cancel never calls API — vitest).

## Contextual actions (endpoint · permission · when offered)
| Action | Endpoint | Permission | Offered when | Result copy family |
|---|---|---|---|---|
| Enable/disable account | `PATCH /api/payment/accounts/:id` `{is_enabled}` | member read, owner write (`requireOwner`) | always per row | server echo + reload |
| Add account | `POST /api/payment/accounts` | owner | drawer save; channel must be legal+unclaimed | "Payment account saved" |
| Edit (credentials/config/enable) | `PATCH /api/payment/accounts/:id` | owner | drawer save; full secret set or none | same; **ladder resets** if creds changed |
| Delete account | `DELETE /api/payment/accounts/:id` | owner | confirm dialog | "Payment account deleted" |
| Set preferred | `PUT /api/payment/accounts/:id/preferred` | owner | enabled & not already preferred (else disabled + title reason; server 409 `PREFERRED_ACCOUNT_DISABLED`) | "preferred_account_id" echo |
| Validate format (wallet) | `POST /api/payment/accounts/:id/verify-credentials` | owner | any wallet account | `format_validated` — "…not a provider check" |
| Check credentials (gateway) | same endpoint | owner | bkash merchant_gateway w/ creds | `credentials_valid` — "bKash accepted your app credentials (one of 2 hourly checks used)." / `cached_verdict` + cooldown seconds / `automation_disabled` / 429 `CREDENTIAL_CHECK_RATE_LIMITED` |
| Record go-live certification | `POST /api/payment/accounts/:id/certify-live` `{evidence 3..500}` | owner | ONLY `sandbox_verified` gateway (`canCertify` drawer gate) | owner-record framing; AuditLog BE |
| List / hydrate | `GET /api/payment/accounts` | member | tab load (shell) | masked summaries only |

Wallet "Validate format" against Nagad/Rocket returns the wallet-only notice with
`provider_contact:false` — button stays honest; **[owed]** the drawer currently offers
`drawer-validate-format` for wallet accounts generically (`AccountDrawer.tsx:265-524`): for Nagad/
Rocket the result panel must render the §2 notice (the service already returns it) — verify the
banner path, do NOT add any provider-call affordance.

## States
- **Loading**: shell skeleton (shell block).
- **Empty provider**: panel copy "No accounts yet. Add one to offer this method to customers."
- **All channels configured**: info note + save disabled (`allChannelsConfigured :382-386`).
- **Error (mutation)**: `ResultBanner` "Action not completed" + server message; state NOT optimistically
  changed; failed reload keeps last-known + banner (MethodsTab comment + `runAction`).
- **501 `PAYMENT_SERVICE_NOT_IMPLEMENTED`** (delegate guard `payment-accounts.service.js:440-445`):
  render server message as-is ("automation pending"), never green.
- **400 ladder refusals**: `INVALID_PROVIDER` / `INVALID_ACCOUNT_TYPE` /
  `GATEWAY_PROVIDER_UNSUPPORTED` / `MFS_TYPE_PROVIDER_MISMATCH` / `GATEWAY_CREDENTIALS_INCOMPLETE` /
  enable-without-credentials — inline field errors (`fieldErrors.gateway`, BD phone error) + 400s.
- **409**: `LADDER_CEILING` (cannot verify/certify a wallet-kind account),
  `SANDBOX_HANDSHAKE_REQUIRED` (certify before sandbox), `PREFERRED_ACCOUNT_DISABLED`.
- **429 `CREDENTIAL_CHECK_RATE_LIMITED`** (≤2 grants/rolling hour per app/account) and cached verdict
  with `cooldown_remaining_seconds` — cooldown must be visibly honest (pending-verification affordance
  disabled with remaining time) **[owed: FE currently prints the server message string only]**.
- **Pending-verification**: any account at `unverified`/`configured_unverified` is the pending state —
  amber chip, never greyed-away; enabling a never-validated wallet is allowed (§3 makes it safe) with
  the chip stating what "validated" means.

## Sync / verification chip semantics (`VerificationChip.tsx` — single source of copy)
- `unverified` → badge "Not verified" (neutral) + "Not verified yet."
- `configured_unverified` → "Format validated" (amber) + **"Credentials validated (format) — not
  verified with bKash"**; gateway kind adds "Automated checkout is not active yet — you confirm
  payments manually."
- `sandbox_verified` → "Sandbox tested" (info) + **exact D-3 sentence** "sandbox checkout handshake
  verified; no settlement implied" + not-active line.
- `live_certified` → "Owner-certified" (success, BadgeCheck) + "Live-certified by the owner —
  payments are still confirmed manually. The app never declares this itself."
- Nagad/Rocket (any rung): the §2 notice verbatim (EN key + bn; server also ships `provider_notice`).
- COD: "No verification needed — cash on delivery." (no ladder).
- Never colour-only: icon + visible label; forbidden strings (…official merchant API automation,
  "verified with provider" for format runs, "Payment confirmed") must never appear (E8/F6 pins).

## Data and evidence
`PaymentAccountView` (id, provider, account_type, gateway-compat, is_enabled, is_preferred,
verification_level, automated_checkout_active, provider_notice, credential_summary{has_credentials,
mfs_type, mfs_mode, mfs_number}, config sanitized, created/updated). Freshness: full reload after
every mutation; no client-side merging. Secrets: absent by construction (controller allowlist).

## Responsive, keyboard, a11y, reduced motion
All 44px interactive (switch/manage/toggle min-h-11); focus ring token class; switch exposes
role+aria-checked+disabled reason via title; delete dialog `aria-modal` + `aria-labelledby` +
initial focus + Esc; drawer same via `useDialogFocus`. 360px: cards stack, provider header wraps
(label + Add + expand remain ≥44px targets), drawer full-width, long numbers `break-all`. 390px:
zero horizontal overflow (e2e E9 pattern extends). Reduced motion: slide/`fadeUp` collapse to
instant (MotionConfig + ANIMATE gate). Keyboard-only path: tablist → expand → drawer → save, no
trap escapes except Esc.

## Analytics / audit events
BE records every ladder/certify/refund/preference write with `performed_by_user_id`
(`payment_account_verifications`) + AuditLog on certify (§2.3). FE: none beyond existing error
reporting; no new telemetry invented.

## Explicit omissions
No refunds UI (API §4.5 exists, settings-out-of-scope), no transaction list, no claims inbox,
no OTP/simulator/billing (01 §I), no reordering of `platform_priority` from this page, no AI-reply
settings editing, no per-account fees/instructions templates.

---

# Screen: Payment Settings — Tab 2 "Payment Policies"

## Merchant job
Answer: "How much must a buyer pre-pay before I ship, and what instruction do they see?" — pick one
of five advance rules, set its one numeric bound (or none), write the ≤500-char payment message, and
know exactly where COD-availability/delivery-charge authority lives (Delivery Settings).

## Page archetype
Configuration/editor form archetype — two sections (advance rule; payment message), one dirty-state
chip pair, one PUT pair behind the shell (R-14). No table, no drawer.

## Existing capability boundary (INERT claims)
- Nothing here contacts any provider or the chatbot at save time; the policy only *feeds* checkout
  math (`computeAdvance`) and AI wording (§5.2 consumption) — the AI mentions advance ONLY when
  policy ≠ none.
- `delivery_charge` is a REFERENCE to the zone-computed charge, never a re-computed/stored fee
  (hard contract rule; copy states it and links out).
- Advance percentage/fixed NEVER offer a gateway link (D-7 ratified) — the tab must not hint that
  partial amounts unlock automated checkout.
- Legacy note (honesty): the old page claimed to save this and silently dropped it (UI illusion
  §5.1). If a legacy blob somehow round-trips, it is ignored; the server store is
  `shop.settings.payments` only.

## Core Design Test (semantic)
- WHY HERE: radio labels + descriptions map straight to what the buyer is asked ("advance = delivery
  charge", "X% now, rest on delivery").
- WHAT NOW: choose rule, set value, edit message, save once.
- WHERE NEXT: Delivery Settings link (COD/charge authority); checkout behavior is not editable here.
- PROVEN RESULT: Saved chip + `updated_at` come from the server reply snapshot, not from a click
  (shell snapshot equality).
- Placement: section headers + status chip + save button per section; delivery pointer inline under
  the radio set.

## Screen regions
1. Advance-rule card: heading, status chip + `policy-save`, five radios (`advance-radio-none|full|
   delivery_charge|percentage|fixed`, with descriptions), percentage input (`advance-percentage-input`,
   suffix) / fixed taka input (`advance-fixed-input`, ৳ prefix) shown ONLY when selected, delivery
   pointer + `policy-delivery-link` → `/manage-shop/delivery-settings`.
2. Payment-message card: heading, `policy-message-count` (n / 500, bn-digit aware), textarea
   (`policy-message-input`, maxLength 500), status chip + `policy-message-save`.

## Contextual actions
| Action | Endpoint | Permission | Notes |
|---|---|---|---|
| Read policy | `GET /api/payment/policy` | member | hydration + snapshot basis; defaults `none/null/''` |
| Save policy | `PUT /api/payment/policy` (PATCH alias) | owner | canonical keys `{advance_policy, advance_value, payment_message}`; legacy aliases accepted at boundary but the FE sends canonical |
| Go to Delivery Settings | route link | — | read-only pointer |

## States
- **Loading**: shell owns first paint; tab renders from hydrated draft.
- **Empty/default**: `advance_policy:'none'` is the honest empty state (nothing enforced on buyers).
- **Dirty**: amber "Unsaved changes" chip; save enabled.
- **Clean just-saved**: "Payment policy saved" (server echo); clean otherwise shows "All changes
  saved" with save disabled (`!isDirty`).
- **Validation issues** (client mirror of server): blocking list `role=alert` ("Fix these before
  saving") + per-rule messages (percentage 1..99 integer; fixed 1..100000 integer taka; value forced
  null for none/full/delivery_charge; message ≤500) — the PUT is never asked to reject what the
  merchant could already see; save blocked until fixed.
- **Error (server 400/4xx)**: inline red banner with the server message (the §5.2 real-error surface
  replacing legacy silently-loved success); draft survives for retry.
- **Background reload while dirty**: draft never clobbered (shell rule; saved snapshot updates).
- **501/409 ladder refusals**: cannot occur on this tab (no provider semantics) — do not add any.

## Sync / verification chip semantics
None — this tab has no verification affordance and must not borrow ladder copy; the only status
vocabulary here is Unsaved changes / Payment policy saved / All changes saved.

## Data and evidence
`PaymentPolicyView` (advance_policy, advance_value, payment_message, updated_at?, updated_by?) stored
at `shop.settings.payments` with write-time stamp `updated_at/updated_by` and cache invalidation
(`payment-policy.service.js:136-158`). Checkout consumption + `order.metadata.payment_policy`
snapshot (§5.2-#2) is BE-side; the tab never previews per-order math (no fake calculator invented).

## Responsive, keyboard, a11y, reduced motion
Radios are full-width tap cards (≥44px), native inputs (no custom ARIA to break); numeric inputs
`inputMode="numeric"` + min/max mirrored; char counter `em-tabular`; bn numerals render via
`Intl.NumberFormat('bn-BD')` like the house pattern. 360/390: single column, chips wrap, no overflow.
Keyboard: natural tab order; no traps. Motion: sections use the shell's fadeUp only; reducedMotion
kills it.

## Analytics / audit events
Server stores `updated_by/updated_at` in the settings blob; no extra audit surface requested.

## Explicit omissions
COD max-amount/block-refusal/codAdvance toggles, per-method advance/fee, verifyMode selector,
billing rate, delivery-zone editing, gateway-vs-advance routing decisions (BE rules §5.2-#1/D-7
own those), message templating variables. All forbidden per 01 §I.
