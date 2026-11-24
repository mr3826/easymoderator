# 02 — Screen Specs (one Guardrails §26 block per tab)

Page shell (A0): `DeliverySettings.tsx` keeps the existing `PageHeader` contract verbatim —
**title + `delivery-signal` + factual meta pills, NO header CTA** (test-pinned). Directly beneath the
header renders a hand-rolled pill `role="tablist"` (the `channels/ChannelDetail.tsx:376` pattern:
active = `bg-em-violet-600 text-white`, inactive = `bg-em-bg-surface text-em-text-secondary
hover:bg-em-violet-50`, `aria-selected`/`aria-controls`, matching `role="tabpanel"` +
`aria-labelledby`, `overflow-x-auto`). Tab order: **Providers · Pickup · Charges**. The success/error
banners (A0/A5–A6) and the page loading skeletons (A0/A7) live in the shell, above the tablist, and
apply across tabs; each tab also carries its own inline feedback (§17 "inline first"). Everything is
inside the existing `.em-delivery` scope, `MotionConfig reducedMotion="user"`, `fadeUp`/`ANIMATE`.
Archetype for all three = **Configuration / editor** (§5.6, §21.6, §5.9).

---

# Screen: Delivery Settings — Courier Providers

## Merchant job
See which couriers the shop can hand parcels to right now, connect/reconnect and configure each one's
credentials, prove the connection works, and turn a courier on (activate) or make it the courier the AI
uses (AI-default). "Is my delivery actually live, or does it still need something?"

## Page archetype
Configuration / editor (§5.6). Entry intent = change controlled provider state, not scan records.
Provider records are read via GET `/api/shop/delivery/settings`; mutations via the connect/test/
activate/deactivate/ai-default/disconnect endpoints.

## Existing capability boundary
- Verified: connect, reconnect, test (sets `last_validated_at`), activate/deactivate (409→pickup),
  AI-default set, disconnect, environment (sandbox for pathao/redx only), 5-state activation chip,
  per-op capability truth (`ceiling` + 6 ops + reason/manual codes), pickup summary/missing indicator,
  activation error.
- Honest limits: Steadfast has **no real sandbox** and no store list (`listStoresHook:null`); capability
  ceiling is `IMPLEMENTED_NOT_LIVE_VERIFIED`, `last_verified_at:null` — never render a state as
  "live-verified" that the server has not confirmed (§8: `Pending` until confirmed).
- **NEW in this tab** (exposes an existing route only): clear AI-default (`DELETE /ai-default`).
- Unavailable (do NOT show): auto courier-selection ranking, coverage %, delivered/return stats,
  fake sync timers (reference-only features, §H of 01).

## Core Design Test (semantic)
- **WHY HERE:** the tablist "Providers" is selected; the header `delivery-signal` + active/connected
  pills state the shop-wide courier posture; each card is one named provider with its own activation
  chip (record-level signal, §8).
- **WHAT NOW:** per provider, the contextual actions the current state allows — Connect (if not
  connected), Reconnect/Test/Activate|Deactivate/AI-default|Clear AI-default/Disconnect (if connected);
  the management drawer holds the credential/config work.
- **WHERE NEXT:** a successful action returns to the refreshed card (chip/last-tested/AI badge update);
  an activation 409 moves the merchant to the **Pickup** tab; disconnect shows the confirm dialog then
  the deactivated card.
- **PROVEN RESULT:** server-confirmed `activation_status`, `is_active`, `is_ai_default`,
  `last_validated_at`, `capabilities.*.level` + the success/error banners — **never** a local optimistic
  "done" before the server reply (§4).
- **Placement:** no forced WHY/WHAT headings — the signal pill, per-card chips, action buttons and
  inline result feedback carry the answers.

## Screen regions
- Header (A0) + pill tablist (A0).
- Page success/error banners (A0).
- Tabpanel `providers`: a vertical stack of three **provider cards** (grid `1fr`, gap preserved). Each
  card = identity row (icon/display/desc) + record-level signal chips (`activation-status-{p}`,
  `{p}-environment`, connected dot, `lastTested`) + pickup strip (`pickup-summary-{p}`/`pickup-missing-{p}`
  + "Complete pickup details" → Pickup tab) + `activation_error` alert + capabilities `<details>`
  (`provider-capabilities-{p}` / `capability-{p}-{op}`) + contextual action row.
- **Contextual management drawer** (right panel, `useDialogFocus`, §17) for connect/reconnect creds
  (per-provider fields, sandbox checkbox pathao/redx only) and provider config — **never** exposes
  stored secrets (masked display only; server allowlist already redacts).

## Contextual actions
| Action | Scope | Permission | Consequence |
|---|---|---|---|
| Connect / Reconnect | card→drawer | owner | POST `/connect`; creds encrypted server-side; refresh card |
| Test connection | card | owner | POST `/test`; sets `last_validated_at`; honest pass/fail banner |
| Activate | card | owner | POST `/activate`; **409 → Pickup tab** with `missing[]` |
| Deactivate | card | owner | POST `/deactivate`; clears AI-default server-side |
| Set AI-default | card | owner | POST `/ai-default` (only when connected+ACTIVE) |
| **Clear AI-default** | card | owner | DELETE `/ai-default` (NEW-UI over existing route) |
| Disconnect | card→confirm dialog | owner | POST `/disconnect`; irreversible-ish → `delivery-disconnect-confirm`, danger styling, Cancel default (§12 dangerous rules) |
| View capabilities | card | any member | read-only truth from GET `/settings` |

## Data and evidence
`providers[]` (`DeliveryProviderStatus`) + `settings` from one GET `/settings`. Freshness =
`last_validated_at`, `connected_at`, `capabilities.last_verified_at`. Missing = `missing[]`
(+ legacy `missing_fields`, tolerant parse via `getProviderMissing`). Pickup = `pickup_summary` /
`provider_pickup_meta`. No fabricated numbers.

## States
- **Loading:** shell skeletons (A0). Do not disable reads; disable only actions that could double-submit.
- **Empty:** n/a — providers is a fixed set of three (pathao/steadfast/redx); never "empty".
- **Error:** load failure → shell error banner (`errors.loadFailed`); per-action failure → inline
  `role="alert"` next to the card action (what failed / why / retry — §16). 409 activation is NOT an
  error banner; it routes to Pickup.
- **Pending:** any in-flight action shows that button's `loading` state; status stays `Pending`/prior
  chip until the server reply (§8).
- **Success:** inline `role="status"` confirmation with evidence (provider name, new chip, `lastTested`,
  `aiDefaultSuccess`), plus refreshed card.

## Responsive and accessibility notes
- 360/390px: cards stack single-column, action row wraps, drawer becomes full-width sheet; no horizontal
  page overflow (CI-pinned). Tablist scrolls (`overflow-x-auto`).
- Full keyboard nav on tablist (roving focus, Arrow keys, Home/End) + activation-409 jump to Pickup tab;
  drawer traps focus and restores on close (§18).
- Signal conveyed by label + icon, never colour alone; `min-h-11`/44px targets; WCAG 2.2 AA via
  `--em-*` tokens on `.em-delivery`; reduced-motion kills all transitions (§19).

## Analytics / audit events
Only where a real mutation occurs (connect/activate/deactivate/disconnect/ai-default): surface the
server's own success payload (provider, timestamp). No client-invented audit trail (§H).

## Explicit omissions
No header CTA (§29). No dashboard-style evidence band, no aggregate metrics row, no page "summary".
No new pricing controls here. No auto-select/preferred-courier ranking algorithm beyond the existing
AI-default set/clear. No "live/operational" claim unless `capabilities`/server says so. No per-card
reveal-on-scroll stagger (§19 anti-slop).

---

# Screen: Delivery Settings — Pickup Locations

## Merchant job
Manage **where the courier collects parcels** per provider: see the shop's saved pickup locations,
import or link the courier's own existing pickup stores (authoritative store ids), create/edit a
location, choose a default, safely delete, and — when several provider stores match — pick the right
one instead of the system guessing (fixes the first-match bug).

## Page archetype
Configuration / editor (§5.6) with a light list surface. Entry intent = edit pickup wiring, not process
orders. Reads: GET `/pickup-locations`, GET `/:provider/stores`, directory cascade endpoints. Writes:
POST/PUT `/pickup-locations[/:id]`, `/:id/default`, DELETE `/pickup-locations/:id`, `/:provider/pickup`,
`/:provider/pickup/sync`, stores import/create (new).

## Existing capability boundary
- Verified: create/update location, BD phone validation, Pathao city→zone→area cascade
  (`getPathaoCities/Zones/Areas`, `optionLabel` prefers `name_bn`), RedX `delivery_area_id`
  (`getProviderAreas('redx')`), Steadfast free-text area, list locations (route exists), set default
  (route exists), provider-store read/upsert for Pathao (`/:provider/stores`).
- Honest limits: RedX store contract **unverified** (`getPickupStores` returns raw provider data) →
  shown at ceiling `IMPLEMENTED_NOT_LIVE_VERIFIED`; if the backend cannot honestly establish the RedX
  store list, the tab falls back to manual entry + documented note (no fake success). Steadfast:
  manual only (no store API).
- **Gaps surfaced (A5, see 03):** selective import/link; merchant-confirmed external-store **create**;
  safe-delete guard; explicit-selection (AMBIGUOUS_MATCH) error; stale-mapping prune; remove
  first-store fallback + auto-create.

## Core Design Test (semantic)
- **WHY HERE:** "Pickup" tab selected; per-provider store/location lists state what is wired; a
  `pickup-missing`/incomplete row states why a courier can't activate.
- **WHAT NOW:** fetch stores, import/link a store, create/edit/select-default/delete a location, or —
  when multiple match — choose among listed candidates.
- **WHERE NEXT:** after import/link/create the row + provider card update (return to Providers shows
  activation now possible); after selection of an ambiguous match the sync completes.
- **PROVEN RESULT:** persisted location (`is_default`, `provider_store_id`), server `pickup_summary`,
  sync status, and the explicit AMBIGUOUS_MATCH prompt until the merchant actually resolves it —
  **never** auto-created external store, **never** a silent first match (§4).
- **Placement:** no WHY/WHAT headings; list rows, status pills, the ambiguous-selection prompt carry it.

## Screen regions
- Header + tablist + banners (A0).
- Tabpanel `pickup`:
  - **Provider-first store panel** (per connected pathao/redx): list provider stores (id/name/city/zone),
    Import/Link action, sync status + Retry (C14).
  - **Local locations list**: rows with display_name · phone · area · default star · provider badge +
    edit / set-default / safe-delete (confirm) actions.
  - **Create/edit form** (reuses/refactors `PickupDetailsModal` field logic inline): name/phone/address/area,
    provider-specific directory (Pathao cascade / RedX area / Steadfast free-text), `BDPhoneInput`.
  - **Ambiguous-match prompt**: when sync returns `DELIVERY_PICKUP_AMBIGUOUS_MATCH`, a dialog/inline
    panel listing candidate stores → explicit selection → re-sync (see 03 error contract).

## Contextual actions
| Action | Scope | Permission | Consequence |
|---|---|---|---|
| Fetch/import provider stores | store panel | owner | `listProviderStores`/`importProviderStores` (Pathao live; RedX honest) |
| Link store → location | row | owner | `setProviderPickup` (POST/PUT `/:provider/pickup`) with authoritative store id |
| Create external store | panel | owner, **explicit confirm** | `createProviderStore` (new) — only on merchant confirm, never auto |
| New / edit location | list | owner | POST/PUT `/pickup-locations[/:id]`; then sync + (activate when completing 409 flow) |
| Set default | row | owner | `POST /pickup-locations/:id/default` |
| Delete | row→confirm | owner | `DELETE /pickup-locations/:id`; safe-delete guard blocks/warns if in use (§12 dangerous) |
| Retry sync | row/store | owner | re-POST `/:provider/pickup/sync` |
| Resolve ambiguous match | prompt | owner | re-sync with explicit `store_id` |

## Data and evidence
`pickup_locations` (`PickupLocation`), provider `stores` (`{store_id,store_name,city_id,zone_id,area_id}`),
`provider_pickup_meta` (`city_id/zone_id/area_id/delivery_area_id/pickup_store_id`). Freshness =
`synced_from_provider`, sync error codes. No invented coverage.

## States
- **Loading:** skeleton store list + location list; disable mutating buttons while a sync is in flight.
- **Empty:** per §16 — "No pickup locations yet / import from [provider] or create one / the courier then
  collects from here." RedX-empty when contract unavailable: honest "stores couldn't be verified — add
  manually" (no fake).
- **Error:** create/update/sync failure → inline alert (what/why/retry); **values preserved**;
  `DELIVERY_STORE_SYNC_FAILED`/`DELIVERY_PICKUP_STORE_SYNC_FAILED`/`DELIVERY_PICKUP_STORE_REQUIRED`/
  `PICKUP_LOCATION_PROVIDER_MISMATCH` each map to a distinct honest message + action.
- **Pending:** sync/store-read in flight → `Pending` pill; AMBIGUOUS_MATCH = `Review`-style state awaiting
  merchant choice (§8), never auto-resolved.
- **Success:** saved location with id/default state + sync confirmation near the row; ambiguous prompt
  closes only after a confirmed store selection.

## Responsive and accessibility notes
- 360/390px: store panel and list stack; create/edit form full-width; directory selects wrap to single
  column; no page overflow.
- Ambiguous-match prompt is a focus-trapped dialog with explicit non-destructive confirm; destructive
  delete is a confirm dialog where **Cancel is the default focused button** (§12).
- Full keyboard for tablist + lists; rows are operable by Enter; `optionLabel` keeps Bangla names;
  44px targets, WCAG 2.2 AA, reduced-motion (§18/§19).

## Analytics / audit events
Persisted `provider_store_id`/`is_default` and sync outcomes (server-confirmed) are the evidence. No
client audit UI, no undo (§H).

## Explicit omissions
No first-match auto-link, no auto external-store create on sync failure, no bulk import, no time-of-day /
return-window / days-promise fields, no coverage %, no fake provider sync. No new pricing here.

---

# Screen: Delivery Settings — Delivery Charges & Policies

## Merchant job
Set and save the shop's delivery pricing exactly as today — default charge, COD availability + COD charge,
the non-refundable policy flag, area-based pricing, and weight tiers — with inline validation and clear
Saved/Unsaved state, honestly labelling which values the platform actually applies vs records-only.

## Page archetype
Configuration / editor (§5.6, §21.6). Single shared `settings` object, **one PUT** to
`/api/shop/delivery/settings`. `shop.settings.delivery` remains the single configuration authority
(ADR-0013); **no** new pricing authority, no relocation to Business Settings.

## Existing capability boundary
- Verified & preserved (D1–D13 of 01): default_delivery_charge, cod_enabled, cod_charge (disabled unless
  COD), non_refundable, area_pricing (zone enum/charge/cod), add/remove area, weight_tiers
  (from<to validated before PUT), add/remove tier, per-card saves (`area-pricing-save`,
  `weight-charges-save`), `chargesSaved`/`saveChargesScope`, honesty copy.
- **Dead-field honesty:** `cod_charge`, `non_refundable`, `weight_tiers`, per-area `cod_enabled` are
  stored/editable but **no calculator consumes them** → keep the "recorded only — not applied to
  quotes/bookings" labels; chatbot COD availability comes from `PaymentConfig`, not these.
- Zero-charge fallback quirk + empty-array→defaults are **pre-existing, unchanged, documented** — do
  not "fix" them (would alter calculation rules).

## Core Design Test (semantic)
- **WHY HERE:** "Charges" tab selected; each grouped form is scoped and named; `saveChargesScope` states
  exactly what Save persists.
- **WHAT NOW:** edit the grouped fields; add/remove area rows and weight tiers.
- **WHERE NEXT:** Save persists all six keys in one PUT; the card's own `chargesSaved` tick updates;
  editing any field drops it back to unsaved.
- **PROVEN RESULT:** the persisted value + the Saved indicator (snapshot equality), inline validation
  errors, and the recorded-only disclosure (§4).
- **Placement:** no headings for WHY/WHAT; the grouped cards, helper text, `chargesSaved` state and the
  weight-tier info band convey it.

## Screen regions
- Header + tablist + banners (A0).
- Tabpanel `charges`: three grouped cards — **General** (`default_charge`, `cod_enabled`, `cod_charge`
  disabled-linked, `non_refundable`), **Area-based pricing** (rows + add/remove + `area-pricing-save`),
  **Weight tiers** (info band + rows + add/remove + `noTiers` empty + `weight-charges-save`). Each card
  carries the shared scope copy + save affordance where the merchant edits.

## Contextual actions
| Action | Scope | Permission | Consequence |
|---|---|---|---|
| Edit field / toggle | card | owner | local dirty state; `chargesSaved` clears |
| Add/remove area row | area card | owner | mutates `area_pricing[]` |
| Add/remove tier | weight card | owner | mutates `weight_tiers[]`; `from<to` validated before save |
| Save | per-card button | owner | one PUT `/settings`; transaction + row lock + cache invalidation (frozen merge) |

## Data and evidence
The `DeliveryShopSettings` six keys, `applyDefaults()` hydrated from server. Validation via
`delivery.validator.updateSettings` (charge ≥ 0 where enforced, zone enum no-dup, `from<to`, non-overlap).
No computed/derived pricing shown (calculators frozen, out of scope).

## States
- **Loading:** shell skeletons (A0); inputs disabled until hydrated.
- **Empty:** `noTiers` copy for zero weight tiers; area rows always seeded by `applyDefaults` (empty→
  defaults preserved) — do not show a fabricated empty pricing.
- **Error:** PUT failure → inline `role="alert"` (`errors.saveFailed`), **inputs preserved**; inline
  field errors for `invalidWeightTiers` etc. (§16/§12).
- **Pending:** `saveSettings`/per-card `loading`; Saved state withheld until server returns.
- **Success:** `chargesSaved` tick + `success.settingsSaved`, snapshot re-baselined.

## Responsive and accessibility notes
- 360/390px: two-col general grid collapses to one; area/tier rows reflow (grid 12 → stacked) without
  overflow; number inputs keep `min-h-11`, 44px remove-buttons.
- Labels always visible (§12); `aria-label`s retained (`defaultCharge`, `codCharge`, extra/weight labels
  with index); `disabled` COD-charge communicated via helper not colour only; keyboard + reduced-motion
  (§18/§19). `Intl.NumberFormat('bn-BD')` numerals kept.

## Analytics / audit events
Server-confirmed PUT result + persisted snapshot is the evidence. No actor/time UI invented.

## Explicit omissions
No delivery-calculator / quote preview. No zone days-promise, return window, sync interval, or
policy-document editor. No relocation of pricing. No "Sync & returns" card (that is the reference's Tab
3, out of scope). No new save button at the header (one-PUT stays in-card).
