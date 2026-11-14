# ADR-0011: Delivered-Order Commercial Contract Is the Sole Price Authority

Status: Accepted<br>
Date: 2026-11-14<br>
Owners: Engineering + Founder<br>
Supersedes: the 2026-11-01 commercial ledger recorded in [founder-pilot-v1.md](../founder-pilot-v1.md)

## Context

The platform shipped three public commercial stories at once: a free "Shuru"
plan with 100 conversations, a ৳999/month "Growth" plan with 500 conversations
and paid top-ups, and a delivered-order Partner band (৳15 / ৳12 / ৳10 per
order). Production infrastructure, landing pages, invoices, and the founder's
pilot brief disagreed about which was live. That is a truth violation at the
point of conversion: a merchant can be shown one price, invoiced another, and
told a third by support.

The founder resolved the direction on 2026-11-14: one model, one price, one
authority. The retired subscription and band terms must stop being renderable,
not merely be edited out of the pages someone remembered to check. The
commercial truth therefore needs an executable contract (terms), a claim
registry (what may be said, where, and on what evidence), and a scanner that
fails the build on retired copy.

This ADR records the decision and freezes the interface later phases build
against. It does not deploy anything.

## Decision

### C1 — Full supersession of the 2026-11-01 commercial ledger

The 2026-11-01 founder-pilot ledger is superseded in full. There is no
subscription, no setup fee, no monthly minimum, no conversation entitlement,
and no top-up pack.

- **Model:** `DELIVERED_ORDER`, BDT, postpaid, monthly cycle.
- **Price:** a flat **1000 poisha (BDT 10.00) per provider-confirmed delivered
  order**, from order 1, for every shop.
- **Zero-rated outcomes:** `RETURNED`, `CANCELLED`, `DRAFT`, `CONFIRMED`,
  `BOOKED`, `IN_TRANSIT`, `FAILED`.
- **Due window:** 7 days.
- **Sole price authority:** `EasyMod-backend/src/modules/commercial/commercial.contract.js`.
  Every derived surface — API, invoice, email, landing, collateral, mobile,
  Growth OS — reads that module or its hand-mirrored frontend twin,
  `EasyMod-frontend/src/shared/contracts/commercial-contract.ts`, and renders
  `contractVersion`. Parity between the two is enforced by a fixture exported
  from the backend snapshot.

No other module may define a merchant price. A page that hardcodes a number is
a defect, not a copy change.

### C5 — Overdue behaviour (founder-approved deviation)

The task text's literal `onOverdue` clause listed only a courier-booking block.
The founder approved a stronger policy, and this ADR records the deviation
explicitly so a later reader does not "correct" it back:

| On overdue | Value |
| --- | --- |
| Block new courier bookings | `true` |
| Pause automated AI replies | `true` |
| Keep the manual inbox readable | `true` |
| Keep history readable | `true` |
| Delete merchant data | `false` — never |

The merchant keeps working manually. Pausing automated replies is deliberate:
automated sending is a paid capability, and suspending new bookings without
suspending automatic replies would let usage grow on an unpaid account. Nothing
is deleted, and no history or inbox is hidden.

### Reversal rule

A reversal of a delivered order must not produce a second financial truth, and
returned/cancelled orders must still be visible on the invoice as explicit BDT 0
lines (never omitted):

- **Before invoicing:** the billable line is converted in place to a zero-rated
  `RETURNED` line (`amount_minor = 0`). The invoice later renders it as an
  explicit BDT 0 line, not as a charge and not omitted.
- **After invoicing, before payment:** the unpaid invoice is reduced in place
  (cancelled at BDT 0) and a credit row is marked applied — the existing tested
  `return.service` behaviour. The reduction is explicit and audited, never a
  silent rewrite.
- **After payment:** paid invoices are immutable. A later reversal produces a
  pending credit that nets against the next invoice, never an edit of a settled
  document.

Zero-rated lines for `RETURNED` and `CANCELLED` are always emitted explicitly so
a merchant sees every order accounted for at BDT 0. Non-terminal outcomes
(`DRAFT`, `CONFIRMED`, `BOOKED`, `IN_TRANSIT`, `FAILED`) emit no line until a
terminal outcome occurs.

## Frozen interface

Later phases MUST build against these values. Changing any of them requires a
new ADR and a coordinated bump of the backend contract, the frontend mirror and
the snapshot.

### Contract

```
COMMERCIAL_CONTRACT_VERSION = "1.0.0"
model                      = "DELIVERED_ORDER"
currency                   = "BDT"
trigger                    = "ORDER_DELIVERED_PROVIDER_CONFIRMED"
unitPriceMinor             = 1000        (integer poisha)
zeroRatedOutcomes          = RETURNED, CANCELLED, DRAFT, CONFIRMED,
                             BOOKED, IN_TRANSIT, FAILED
subscriptionFeeMinor       = 0
setupFeeMinor              = 0
monthlyMinimumMinor        = 0
conversationEntitlement    = null
cycle                      = "MONTHLY"
payment                    = "POSTPAID"
dueDays                    = 7
contractHash               = sha256:207a8d899d14f0375a88a2c962f3db7c842ffd3483a27984402c5aef194713d6
```

The contract hash is computed, never typed: it is the SHA-256 of the canonical
JSON of `{ version, contract }`. The snapshot at
`EasyMod-backend/src/modules/commercial/__snapshots__/commercial.snapshot.json`
is the drift receipt.

### Surfaces

```
['pricing', 'subscription', 'signup', 'landing', 'email', 'usage-banner',
 'mobile', 'collateral', 'growth-os', 'admin', 'invoice']
```

### Modes

Every merchant surface — `pricing`, `subscription`, `signup`, `landing`,
`email`, `usage-banner`, `mobile`, `collateral`, `invoice` — runs `enforce`.
The internal surfaces `growth-os` and `admin` run `off`. `GATE_MODES` is
`['off', 'shadow', 'enforce']`.

The `CLAIM_GATE_MODE` environment override may force `shadow` globally for an
emergency but may never take a merchant surface `off`; an `off` override is
clamped to `shadow`. A money-facing surface that stops checking claims is a
truth regression, not a rollback.

### Claim registry ids (19)

```
billing.delivered_order
billing.overdue_policy
courier.pathao.booking_live
courier.steadfast.booking_live
courier.redx.booking_live
courier.pathao.integration_status
courier.steadfast.integration_status
courier.redx.integration_status
courier.all_providers
courier.cod_settlement.pathao
courier.cod_settlement.steadfast
courier.cod_settlement.redx
voice.transcription
voice.auto_reply
ai.auto_reply
ai.draft_reply
addons.ads_studio.pilot
addons.storefront.pilot
ai.reply_shadow_meter
```

`ai.reply_shadow_meter` is `internalOnly`: it renders on Growth OS and admin
only and may never be merchant-rendered. Every merchant entry carries a
truthful `fallbackI18nKey` where its evidence is not yet satisfied; a surface
renders the fallback, never the unimplemented promise.

```
registryHash = sha256:ae42a84c063458cd6bdc8af51d2b862224783dc495f2ec90340b5f9f1f328e27
```

### Evidence flags (21)

```
contract
courier.pathao.code_present
courier.pathao.production_verified
courier.pathao.settlement_present
courier.steadfast.code_present
courier.steadfast.production_verified
courier.steadfast.settlement_present
courier.redx.code_present
courier.redx.production_verified
courier.redx.settlement_present
addons.ads_studio.merchant_enabled
addons.storefront.merchant_enabled
ai.auto_reply.merchant_enabled
platform.voice.transcription.code_present
platform.voice.transcription.production_verified
platform.voice.auto_reply.code_present
platform.ai.auto_reply.code_present
platform.ai.auto_reply.production_verified
platform.ai.draft_reply.code_present
platform.ai.draft_reply.production_verified
platform.addons.code_present
```

Each flag has exactly one authority in
`EasyMod-backend/src/modules/commercial/evidence-authorities.js`, which names
the module, export, purity and resolution hint. The manifest is static and
requires no DB, so CI can scan it. A claim whose flag has no authority fails the
registry at require time.

Current evidence truth, restated so nobody "remembers" otherwise:

- Voice transcription code exists but is mock-only and never live-verified.
- Voice auto-reply code does not exist.
- AI auto-reply code exists; automatic sending has **never** been proven live,
  so `platform.ai.auto_reply.production_verified` is `false` and the AUTO claim
  is fail-closed.
- AI draft reply is verified in production (DRAFT/manual pipeline).
- Courier booking is implemented but never live-verified for any provider;
  Pathao/Steadfast/RedX `production_verified` is unavailable, so
  `courier.all_providers` (scope match N=3, verified 0) may not render.
- Add-on pilots ship per shop with GA unavailable.

### Cutover timestamp

The cutover instant is persisted by migration `20261114_003` and read from the
database. It MUST NOT be hardcoded in application code or copy.

## Consequences

- One number, one model, one module. Marketing, invoices and support read the
  same contract hash.
- Retired copy becomes a build failure through the forbidden-token scanner,
  with the 24 qualified tokens frozen in the contract.
- The honesty cost is visible: until couriers and automatic replies are
  live-verified, those claims render truthful fallbacks instead of the pitch.
- The frontend carries a hand-maintained mirror. That is a deliberate
  trade-off: workspace imports across backend/frontend are forbidden, so parity
  is enforced by a generated fixture and a failing test rather than by an
  import that cannot exist.
- Historical conversation credits are not migrated or renamed; the ledger is
  archived for audit.

## Rollback

Rollback is data- and flag-level. There is **no deploy in this decision**.

- Schema rollback: `migrate down` x3 reverses `20261114_001`–`003`. Archived
  `billing_lines` rows are retained, not dropped.
- Emergency copy override: set `CLAIM_GATE_MODE=shadow`. Claims are still
  evaluated and logged but render fallbacks; merchant surfaces cannot be set
  to `off`.
- The contract module stays the price authority through any rollback. A rollback
  that reintroduces the retired ৳999/৳15/৳12 copy is a new decision requiring a
  new ADR, not an operational rollback.

## References

- [BILLING_OPERATIONS.md](../billing/BILLING_OPERATIONS.md) — operational billing
  rules that this contract supersedes where they describe subscription plans.
- [founder-pilot-v1.md](../founder-pilot-v1.md) — the 2026-11-01 ledger,
  superseded in full by C1.
- ADR-0003 (business AI reply mode) and ADR-0009 (pilot feature flags) — the
  evidence authorities referenced by the claim registry.