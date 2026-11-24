# 01 — Feature / Field / Flow / TestID Preservation Matrix

Single source of truth for the Delivery Settings redesign. Every existing capability of the
current page (`EasyMod-frontend/src/app/components/DeliverySettings.tsx`, `PickupDetailsModal.tsx`)
is listed with the new tab that must preserve it. **Reviewers reject the PR if any row is dropped,
silently removed, or moved to a tab that cannot serve it.** Writers: do not invent a row that has no
existing counterpart (see §"Reference-only — DO NOT invent").

Legend
- **Tab**: `P` Providers · `K` Pickup · `C` Charges · `S` Shell (PageHeader/banners, owned by A0).
- **Status**: `KEEP` = behaviour+testid preserved verbatim · `KEEP+UI` = preserved but relocated/
  re-presented in the new tab · `NEW-UI` = capability already exists at the API but was never exposed
  in the UI · `GAP` = needs a backend change (A5) before the UI can honestly expose it.

---

## A. Page shell (owned by A0 — not a tab)

| # | Existing capability (source) | Preserved in | Status | Backend gap needed |
|---|---|---|---|---|
| A1 | `PageHeader` title = `t('manageShop.deliverySettings.title')`, breadcrumb = current shop name | S | KEEP+UI | none |
| A2 | `delivery-signal` testid + dominant signal from `deriveDeliverySignal(...)` (§8/§29) | S | KEEP | none |
| A3 | Header meta pills: active count, connected count, COD on/off (`statuses.active`/`notConfigured`) | S | KEEP+UI | none |
| A4 | **No header CTA** (execution-page rule §29; test-pinned) | S | KEEP | none |
| A5 | Success banner (dismissible, `role="status"`, `common.close`) | S | KEEP | none |
| A6 | Error banner (dismissible, `role="alert"`, `common.close`) | S | KEEP | none |
| A7 | Page-level loading skeletons (3 pulsing cards), `.em-delivery` scope | S | KEEP+UI | none |
| A8 | `MotionConfig reducedMotion="user"` + `fadeUp`/`ANIMATE` gate | S | KEEP | none |
| A9 | Single shared `settings` object + **one PUT** (`updateDeliverySettings`) | S→C | KEEP | none |
| A10 | `savedChargesSnapshot` equality drives `chargesSaved` Saved/Unsaved state | S→C | KEEP+UI | none |
| A11 | `applyDefaults()` hydration (charge 60, COD off, 3 zones 60/80/120, one 0–1kg tier) | S→C | KEEP | none (must NOT change; empty→defaults quirk preserved) |

## B. Providers tab (A2) — Courier Providers

Every provider card feature, for **each** of `pathao`, `steadfast`, `redx`:

| # | Existing capability (source) | Preserved in | Status | Backend gap needed |
|---|---|---|---|---|
| B1 | `PROVIDER_CONFIGS`: display_name, description, icon (`PROVIDER_ICONS` Truck/Package/MapPin) | P | KEEP | none |
| B2 | Activation chip `activation-status-{p}` with 5 states via `normalizeActivationStatus` (`ACTIVATION_STATUS_LABELS`/`_CLASSES`) | P | KEEP | none |
| B3 | Connected indicator (green dot + `connected` label) | P | KEEP | none |
| B4 | `lastTested` from `last_validated_at` | P | KEEP | none |
| B5 | Environment chip `{p}-environment` = Sandbox/Production, **rendered only for pathao/redx** | P | KEEP | none (Steadfast has no real sandbox — do not add) |
| B6 | Pickup summary block `pickup-summary-{p}` (display_name · area_name · address) / `pickup-missing-{p}` when absent | P | KEEP | none |
| B7 | `activation_error` inline alert (`role="alert"`) | P | KEEP | none |
| B8 | "Complete pickup details" button shown when `missing.length > 0` → opens pickup flow | P→K | KEEP+UI (now routes to Pickup tab, not modal) | none |
| B9 | Capabilities `<details>` `provider-capabilities-{p}`: ceiling label + 6 ops `capability-{p}-{op}` (`coverage,rate_quote,create_parcel,tracking,cancel,edit`) + reason/manual_step codes + last_verified/neverVerified | P | KEEP | none (shape from GET `/settings` must stay stable) |
| B10 | Connect button → credentials form (`openCredentialsForm`, per-provider fields) | P | KEEP+UI (inside management drawer) | none |
| B11 | Pathao creds: `client_id, client_secret, username, password` | P | KEEP | none |
| B12 | Steadfast creds: `api_key, secret_key` | P | KEEP | none |
| B13 | RedX creds: `api_key` | P | KEEP | none |
| B14 | Sandbox checkbox `sandbox-{p}` **only for pathao/redx** in the connect form | P | KEEP | none |
| B15 | `saveConnect` → `connectDeliveryProvider({provider,credentials,is_sandbox})`; required-field validation (`errors.fieldRequired`) | P | KEEP | none |
| B16 | Reconnect = re-open creds form when already connected (B10 path) | P | KEEP+UI | none |
| B17 | Test button → `testDeliveryConnection` → success `testSuccess` / `testFailed` | P | KEEP | none |
| B18 | Activate button → `activateDeliveryProvider`; **409 → pickup flow** with `getConflictMissing` + `getProviderMissing` | P→K | KEEP+UI | none |
| B19 | Deactivate button → `deactivateDeliveryProvider` (clears AI-default server-side) | P | KEEP | none |
| B20 | AI-default set: Star `setAsAiDefault` (only when connected+ACTIVE and not already default) → `setAiDefaultDeliveryProvider`; `aiDefaultBadge` chip | P | KEEP | none |
| B21 | **AI-default clear** — NOT exposed in current UI (route `DELETE /ai-default`, `/:provider/ai-default` exists) | P | NEW-UI | client fn `clearAiDefault` (route exists) — see 03 |
| B22 | Disconnect button `disconnect-{p}` (danger) → confirm dialog `delivery-disconnect-confirm` (`disconnectConfirm`/`disconnectConfirmBody`) → `disconnectDeliveryProvider` | P | KEEP | none |
| B23 | Disconnect focus trap (`useDialogFocus(disconnectRef)`, Escape, backdrop click) | P | KEEP | none |
| B24 | AI-default success/error copy (`aiDefaultSuccess`/`errors.aiDefaultFailed`) | P | KEEP | none |
| B25 | Legacy `toggleDeliveryProvider` + `setDefault*` client fns — **DO NOT resurrect** | — | n/a | none (leave unused; do not wire) |

## C. Pickup tab (A4) — Pickup Locations (provider-first)

| # | Existing capability (source) | Preserved in | Status | Backend gap needed |
|---|---|---|---|---|
| C1 | `PickupDetailsModal` field set: name, phone (`BDPhoneInput`/`BD_PHONE_REGEX`), address (`Textarea`), area; Pathao city→zone→area cascade selects; RedX area select (`getProviderAreas('redx')` → `delivery_area_id`); Steadfast free-text area | K | KEEP+UI (becomes a create/edit panel in-tab) | none |
| C2 | Pathao directory chain `getPathaoCities`→`getPathaoZones`→`getPathaoAreas`; `optionLabel` prefers `name_bn` | K | KEEP | none |
| C3 | Save chain: validate → `createPickupLocation`/`updatePickupLocation` → `syncProviderPickup` → `activateDeliveryProvider` → reload | K | KEEP+UI | see C9/C10 for the matching fix |
| C4 | Hydrate from `getPickupLocations()` (`is_default ?? first`) when no initial pickup | K | KEEP+UI (now a list, pick row to edit) | none |
| C5 | **Values preserved on save/sync failure** (test-pinned behaviour) | K | KEEP | none |
| C6 | `missing[]`-driven conditional field display (`hasMissingField`, aliases) | K | KEEP+UI | none |
| C7 | List existing pickup locations — types carry it (`DeliverySettings.pickup_locations?`) but **no list UI today** | K | NEW-UI | none (GET `/pickup-locations` exists; client `getPickupLocations` exists) |
| C8 | Set default location — `POST/PUT /pickup-locations/:id/default` exists (`setDefaultPickupLocation`) but **no UI/client** | K | NEW-UI | client fn (route exists) — see 03 |
| C9 | Delete location — `DELETE /pickup-locations/:id` exists but **no UI/client**, and service does a **hard `destroy`** with no guard | K | NEW-UI + GAP | client fn + **safe-delete guard** in `pickup-location.service.deletePickupLocation` (block/warn default · integration-selected · in-use; preserve dispatch assocs) |
| C10 | **Provider store list (Pathao)** — `GET/POST/GET /:provider/stores[/sync]` exist (controller hard-codes pathao) but **no UI**; `provider_store_id`/`provider_store_count` in types are unrendered | K | NEW-UI | extend `getProviderStores` to RedX (normalized, honest ceiling); Pathao already works |
| C11 | **Import/link existing provider stores** — `/stores` currently auto-upserts ALL via `syncProviderStores`; no *selective* import/link, no explicit link of a chosen store id to a pickup | K | NEW-UI + GAP | **new endpoint** selective import/link (e.g. `POST /:provider/stores/import`) taking store ids; provider store ids authoritative |
| C12 | **External store create** — today happens *automatically* inside `syncProviderPickup` L577–587 when no match (the bug). Redesign requires **merchant-confirmed** create only | K | GAP | **remove auto-create**; add explicit `createProviderStore` route (POST) with a confirmation contract flag |
| C13 | **First-match geographic bug** — `syncProviderPickup` L575 `stores.find(...)` picks first match; `setPickupConfiguration` L467–470 falls back to first cached store | K | GAP | explicit-selection error (mirror `courier-destination.resolveRedX` `candidates>1 → AMBIGUOUS_MATCH`); remove L467–470 fallback. Update `delivery-pickup-activation.test.js` L399 |
| C14 | **Stale-mapping / sync-failure handling + retry** — `DELIVERY_STORE_SYNC_FAILED` 503 exists; retry only re-invokes sync; stale local mappings never pruned | K | KEEP+UI + GAP | retry = re-POST sync (no new endpoint); stale-mapping prune/repair in `pickup-location.service`; honest sync status surface |
| C15 | Preserve dispatch associations on edit/delete (orders reference `pickup_location_id`/`provider_store_id` via `delivery-integration`, `courier-dispatch`) | K | KEEP + GAP (see C9 guard) | same safe-delete guard |
| C16 | Never auto-create an external store merely because sync failed | K | KEEP (guaranteed by removing C12) | covered by C12 gap |

## D. Charges & Policies tab (A3) — all seven existing pricing items

| # | Existing capability (source) | Preserved in | Status | Backend gap needed |
|---|---|---|---|---|
| D1 | `default_delivery_charge` numeric input | C | KEEP | none |
| D2 | `cod_enabled` checkbox (`enableCOD`) | C | KEEP | none |
| D3 | `cod_charge` numeric, **disabled unless `cod_enabled`** | C | KEEP | none (stored-only — honest label) |
| D4 | `non_refundable` checkbox (`nonRefundable`) | C | KEEP | none (stored-only — honest label) |
| D5 | `area_pricing[]`: zone enum (`inside_dhaka/sub_dhaka/outside_dhaka`, no dup), `charge`, per-area `cod_enabled` | C | KEEP | none |
| D6 | Add area (`addArea`) / remove area (`removeArea`) | C | KEEP | none |
| D7 | `weight_tiers[]`: `from_kg`, `to_kg`, `extra_charge`; `from<to` validated **before PUT** | C | KEEP | none |
| D8 | Add tier (`addTier`) / remove tier (`removeTier`) | C | KEEP | none |
| D9 | `weightTierInfo` + `weightTierTooltip` honesty copy: **"recorded only — NOT applied to quotes/bookings"** (test-pinned) | C | KEEP | none |
| D10 | `noTiers` empty-state copy | C | KEEP | none |
| D11 | Per-card save `area-pricing-save`, `weight-charges-save` + shared `saveCharges`/`chargesSaved`/`saveChargesScope` ("Saves the general, area and weight settings on this page") | C | KEEP | none |
| D12 | Inline `errors.invalidWeightTiers` guard | C | KEEP | none |
| D13 | `errors.loadFailed`/`saveFailed` handling via `getErrorMessage` | C→S | KEEP | none |

## E. TestIDs — every one must survive into the new layout (CI `delivery-guardrails.spec.ts` asserts them)

| TestID | Where it lives today | New tab | Must still exist |
|---|---|---|---|
| `delivery-signal` | PageHeader | S | ✅ |
| `activation-status-{p}` | provider card | P | ✅ |
| `{p}-environment` | provider card (pathao/redx) | P | ✅ |
| `pickup-summary-{p}` | provider card | P | ✅ |
| `pickup-missing-{p}` | provider card | P | ✅ |
| `provider-capabilities-{p}` | provider card `<details>` | P | ✅ |
| `capability-{p}-{op}` | provider card `<details>` | P | ✅ |
| `disconnect-{p}` | provider card action | P | ✅ |
| `delivery-disconnect-confirm` | disconnect dialog | P | ✅ |
| `area-pricing-save` | area card | C | ✅ |
| `weight-charges-save` | weight card | C | ✅ |
| (new) pickup list / default / delete / import / ambiguous | — | K | add + register in `KNOWN_PATHS` |

## F. Regression tests to keep green / extend (do not delete)

- Vitest: `__tests__/DeliverySettings.test.tsx`, `DeliveryGuardrails.test.tsx`, `PickupDetailsModal.test.tsx`.
- Playwright: `tests/e2e/delivery-guardrails.spec.ts` (allowlist+abort discipline — **every new
  `/api/*` call must be added to `KNOWN_PATHS`/`KNOWN_PATTERNS` in the SAME PR** — capability honesty,
  activation-409 pickup, AI-default, disconnect confirm, 390px no-overflow + 5 nav links, axe on
  `.em-delivery` reducedMotion), `courier-setup.spec.ts`.
- Backend: `delivery-pickup-activation.test.js` (**L399 first-match assertion must be updated**;
  L342 "keeps local selection when sync fails" must stay green), `delivery-schema.test.js`
  (pins migration filenames — avoid new migration unless unavoidable), `delivery-tracking.tenant-and-replay.test.js`.

## G. Adjacent consumers — must not break

- `dashboard/ConnectionHealth.tsx` → GET `/api/shop/delivery/readiness`
  (`src/api/domains/delivery.ts`). **Do NOT change the `/readiness` response shape** — it is consumed
  by `shell-guardrails`, `shell-nav-badges`, `dashboard-commerce-signals`
  (`pickup_location_configured`, `pickup_summary`, `missing_fields`).
- `CourierBookingModal` / Orders share directory helpers (`orders/directoryOptions.ts`) + provider status.

## H. Reference-only — DO NOT invent (no backend counterpart; mission §"excluded scope")

Zone days-promise · sync interval · pickup time-of-day · return window · auto-handoff · legacy
default-provider select · coverage % · delivered/return-rate stats · bulk ops · CSV export · saved
views · density/motion toggles · simulator/quote calculator · notes · audit-trail UI · undo · archive ·
Messenger preview rail · fake `setTimeout` sync · auto courier selection. **Reference Tab 3
"Sync & returns" is NOT mission Tab 3** — mission Tab 3 = the 7 existing pricing items (D1–D7) only.

## I. Frozen — do not change (preserve behaviour exactly)

- Charge calculators: `order-session-standalone.service getShopDeliveryZones` /
  `generateOrderSummary` / `createOrderFromSession`; `order.service calculateOrderTotals` /
  `createOrderInternal`; `message-worker resolveStaticConfigAvailability`.
- Zero-charge fallback quirk (`Number(z.charge)||DEFAULT`) and empty-array→defaults — **preserve
  unchanged**, document as pre-existing.
- `applyDeliveryDefaults` + transactional merge + cache invalidation.
- `shop.settings.delivery` = single configuration authority (ADR-0013). No relocation to Business Settings.
