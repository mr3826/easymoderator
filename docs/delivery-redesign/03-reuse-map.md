# 03 — Reuse Map (exact paths + import names A0/writers must reuse) and new contracts

Frontend root: `EasyMod-frontend/src/`. Alias `@/` = `src/`, `@shared/` = `src/shared/`.
All paths verified against the delivery worktree at `feat/delivery-settings-redesign-20261124`.

---

## 1. Reuse — existing UI / hooks / helpers (do NOT re-implement)

| Concern | Import path | Imported name | Notes |
|---|---|---|---|
| Button (primary/secondary/ghost/danger/attention, `min-h-11`, `loading`, `disabledReason`, `data-testid`) | `./dashboard/EmButton` (rel to `app/components`) / `@/app/components/dashboard/EmButton` | `EmButton` | `variant`, `loading`, `action` (Action→disabledReason/title) |
| Page header (title + signal + meta + breadcrumb) | `@/app/components/dashboard/PageHeader` | `PageHeader` | props: `title, breadcrumb, signal, signalTestId, signalAnnounce, meta`; NO `primaryAction` here (§29) |
| Signal badge (6 kinds) | `@/app/components/dashboard/SignalBadge` | `SignalBadge` | consumes `Signal` from `dashboard/types` |
| Result feedback (success/error/pending) | `@/app/components/dashboard/ResultBanner` | `ResultBanner` | `role=alert/status` built in; inline-first (§17) |
| Dialog focus trap + Escape + restore | `@/app/components/inbox/useDialogFocus` | `useDialogFocus` | ref + `open` boolean; reuse for disconnect, management drawer, ambiguous-match, delete confirm |
| Delivery header signal derivation | `./delivery/derive` / `@/app/components/delivery/derive` | `deriveDeliverySignal`, `DeliveryDeriveInput` | **pure**; do not duplicate the signal logic in tabs |
| Pill tablist pattern (visual + a11y) | `@/app/components/channels/ChannelDetail.tsx` (L376–395) | — (copy the `role="tablist"`/`role="tab"`/`role="tabpanel"` markup) | active `bg-em-violet-600 text-white`; `aria-selected`/`aria-controls`/`aria-labelledby`; `overflow-x-auto` |
| BD phone input + regex | `@/shared/components/BDPhoneInput` | `BDPhoneInput`, `BD_PHONE_REGEX` (`/^01[3-9]\d{8}$/`) | reuse in pickup create/edit |
| Directory option helpers | `@/app/components/orders/directoryOptions` | `optionId`, `optionLabel` (prefers `name_bn`), `providerId` | shared with Orders — **do not break** |
| UI primitives | `@/app/components/ui/{input,textarea,select,switch,checkbox,label}` | `Input`, `Textarea`, … | used by `PickupDetailsModal` already |
| Motion presets + gate | `@/lib/motion` | `fadeUp`; `MotionConfig reducedMotion="user"`; `ANIMATE = import.meta.env.MODE !== 'test'` | drawer/tab 200–300ms cubic-bezier(.2,.8,.3,1); **no** per-row stagger (§19) |
| Error text extraction | `@shared/lib/http/errors` | `getErrorMessage(err, fallback)` | reads `err.response.data.message`/code |
| Shop name for breadcrumb | `@/app/lib/auth` | `authService.getCurrentShop()?.shop_name` | |
| Toasts | `sonner` `Toaster` (already mounted) | `toast` | optional; banners are the primary channel today |

**i18n / numerals:** `react-i18next` `useTranslation`; default/fallback `bn`; Bangla numerals via
`Intl.NumberFormat('bn-BD')` — follow `customers/customerDisplay.ts` pattern; `em-tabular` class for
counts. bn plurals use `_one`/`_other`.

**Tokens (`src/styles/theme.css`, `--em-*`):** `.em-delivery` scope is **already registered** (focus
rules L325/L346, `.em-tabular` L364, `prefers-reduced-motion` kill block L397/L413). Reuse the exact
classes the current page uses: `border-em-border`, `bg-em-bg-surface`, `bg-em-bg-muted`,
`text-em-text-primary`/`-secondary`/`-disabled`, `bg-em-violet-100/50`, `text-em-violet-700`,
`bg-em-violet-600`, `bg-em-success-100`/`text-em-success-700`, `bg-em-danger-100`/`text-em-danger-700`,
`bg-em-info-100`/`text-em-info-700`, `bg-em-sunlight-100`/`text-em-sunlight-700`, `accent-em-violet-600`,
`outline-em-focus-light`, `bg-em-midnight-950/60`. Do **not** add new colour literals.
Reuse the two const strings: `FOCUS_RING`, `INPUT_CLASSES` (lift them to a shared
`delivery/styles.ts` so all three tabs import the same constants — single source, §24 "reuse existing").

---

## 2. Existing API client functions to reuse as-is (`@/api/domains/order.ts`)

`getDeliverySettings`, `updateDeliverySettings`, `connectDeliveryProvider`,
`disconnectDeliveryProvider`, `testDeliveryConnection`, `activateDeliveryProvider`,
`deactivateDeliveryProvider`, `setAiDefaultDeliveryProvider`, `getPickupLocations`,
`createPickupLocation`, `updatePickupLocation`, `syncProviderPickup`, `getProviderAreas`,
`getPathaoCities`, `getPathaoZones`, `getPathaoAreas`.
**`toggleDeliveryProvider` exists but MUST NOT be used** (legacy; plan §"do not resurrect").
Also **do not import from `@/api/domains/delivery.ts`** except leaving `ConnectionHealth`'s
`/readiness` read untouched.

## 2a. NEW API client functions A0 adds to `@/api/domains/order.ts` (confirmed vs `delivery.routes.js`)

Base path `/api/shop/delivery`. **✓ route exists (client wrapper missing)** · **✗ NEW route (A5 adds
backend + client together)**. Signatures use types from `@/api/types/order` (see §3).

| Client fn (A0 adds) | Endpoint | Method | Route status | Notes |
|---|---|---|---|---|
| `listProviderStores(provider)` | `/api/shop/delivery/${provider}/stores` | GET | ✓ **Pathao-only today** | controller/service hard-reject non-pathao (`400 DELIVERY_PROVIDER_UNSUPPORTED`). Returns `{ stores, pickup_locations }`. **A5 extends to RedX** (normalized, honest ceiling). Steadfast → unsupported (manual only). |
| `importProviderStores(provider, storeIds)` | `/api/shop/delivery/${provider}/stores/import` | POST | ✗ **NEW** | Selective import. Today GET `/stores` silently upserts ALL via `syncProviderStores`; there is **no** selective import/link endpoint. A5 must add this route (Joi body `{store_ids: string[]}`) + Action Gate. |
| `setProviderPickup(provider, payload)` | `/api/shop/delivery/${provider}/pickup` | POST (PUT alias ✓) | ✓ (controller `setPickupConfiguration`) | No client wrapper today. Body `{pickup_location_id?, provider_pickup_meta?, store_id?, enabled?}`. **A5 removes the first-store fallback (service L467–470).** |
| `createProviderStore(provider, payload, confirm)` | `/api/shop/delivery/${provider}/stores` | POST | ✗ **NEW** | External store create, **merchant-confirmation only**. The only current create is a hidden auto-create inside `syncProviderPickup` L577–587 — A5 removes it. Body carries `confirmation:true` flag; without it → reject. |
| `deletePickupLocation(locationId)` | `/api/shop/delivery/pickup-locations/${locationId}` | DELETE | ✓ (controller `deletePickupLocation`) | No client wrapper today. **Backend gap:** service does hard `destroy` (L264–269) — A5 adds safe-delete guard (block/warn default / integration-selected / in-use; preserve dispatch assocs). |
| `setDefaultPickupLocation(locationId)` | `/api/shop/delivery/pickup-locations/${locationId}/default` | POST (PUT alias ✓) | ✓ (controller `setDefaultPickupLocation`) | No client wrapper today. |
| `clearAiDefault(provider?)` | `/api/shop/delivery/ai-default` **or** `/api/shop/delivery/${provider}/ai-default` | DELETE | ✓ (controller `clearAiDefaultProvider`) | No client wrapper today (only the POST set). Exposes preservation row B21. |
| `retryPickupSync(provider, payload)` | `/api/shop/delivery/${provider}/pickup/sync` | POST | ✓ (reuse `syncProviderPickup`) | **Not a distinct endpoint** — it re-invokes sync. Prefer calling `syncProviderPickup(provider, payload)` with the merchant-resolved `store_id`. A thin `retryPickupSync` alias is optional; do **not** add a new route. |

> **Name corrections to lock:** `retryPickupSync` → reuse existing `syncProviderPickup` (no new endpoint).
> `listProviderStores` must be **provider-aware** (only pathao/redx yield stores; steadfast → 400).
> `importProviderStores`, `createProviderStore` = genuinely **new backend routes** (A5), not wrappers
> over existing ones — flag in the PR so `delivery-guardrails.spec.ts` `KNOWN_PATHS`/`KNOWN_PATTERNS`
> and `delivery.routes.js`/`validator.js`/Action Gate are updated in the same change.

## 3. New / reused TypeScript types to add to `@/api/types/order.ts`

Reuse verbatim: `DeliveryProvider`, `DeliveryActivationStatus`, `DeliveryProviderStatus`
(`provider_store_id` already present but **currently unrendered — render it**), `PickupLocation`,
`PickupLocationSummary`, `PickupLocationPayload`, `ProviderPickupMetadata`, `ProviderPickupSyncRequest`,
`DeliveryLocationOption`, `DeliveryShopSettings`, `DeliveryAreaPricing`, `DeliveryWeightTier`,
`DeliverySettings`.

Add:
```ts
// shape matches delivery.controller serializeStore (['store_id','store_name','city_id','zone_id','area_id'])
export interface ProviderStore {
  store_id: string;
  store_name?: string;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
}

export interface ProviderStoresResult {
  stores: ProviderStore[];
  pickup_locations: PickupLocation[];
}

// body for POST /:provider/stores/import (new route)
export interface ImportProviderStoresRequest { store_ids: string[] }

// body for POST /:provider/stores (new route) — confirmation required
export interface CreateProviderStoreRequest {
  name: string;
  address: string;
  phone?: string;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  confirmation: true;            // explicit merchant confirm; rejected if absent
}

// explicit-selection body for setProviderPickup / sync retry
export interface ProviderPickupSelection {
  pickup_location_id?: string | null;
  store_id: string;              // authoritative provider store id
  provider_pickup_meta?: ProviderPickupMetadata;
}
```

## 4. AMBIGUOUS-match error contract the Pickup tab must handle

Backend errors flow through `utils/AppError.js` → `globalErrorHandler`, which returns the AppError's
HTTP `status` with body `appError.toJSON(requestId)`:
```json
{ "success": false, "message": "<sanitized>", "code": "<CODE>", "requestId": "...", "timestamp": "..." }
```
**Critical gap to close in A5:** `toJSON` currently forwards `details` **only** for a hard-coded
whitelist (`DELIVERY_NOT_READY`, `DELIVERY_PROVIDER_SETUP_INCOMPLETE`, `META_PAGE_DISCOVERY_FAILED`).
For an explicit-selection prompt to carry candidate stores, A5 **must** either add the new code to that
whitelist or always forward a safe `details` object — otherwise the candidates never reach the client.

**Mirror the proven contract** from `courier-destination.service resolveRedX` (`candidates.length > 1`
→ disambiguate by district → if still >1 → `UNCERTAIN / 'AMBIGUOUS_MATCH'`, **never** guesses; never a
silent `stores.find()` like the current `syncProviderPickup` L575). When `syncProviderPickup` /
`setProviderPickup` finds multiple matching provider stores, return:

```jsonc
// HTTP 409 Conflict
{
  "success": false,
  "code": "DELIVERY_PICKUP_AMBIGUOUS_MATCH",       // NEW code
  "message": "Multiple pickup stores match. Choose one.",
  "requestId": "...", "timestamp": "...",
  "details": {
    "provider": "pathao" | "redx",
    "pickup_location_id": "<uuid|null>",
    "candidates": [ /* ProviderStore[] — same serializeStore shape */ ]
  }
}
```

**Frontend handling (Pickup tab):**
1. Existing `isConflictError(err)` already treats `statusCode===409 || status===409 ||
   response?.status===409 || type==='CONFLICT'` as conflict — reuse it.
2. Then branch on `err.response?.data?.code === 'DELIVERY_PICKUP_AMBIGUOUS_MATCH'` and read
   `err.response?.data?.details?.candidates` (tolerant: also check `details.stores`, top-level
   `candidates`). Render the **explicit-selection dialog** (`useDialogFocus`) listing each candidate's
   `store_name`/`city_id`/`zone_id`/`area_id`.
3. On merchant pick → re-call `syncProviderPickup(provider, { pickup_location_id, store_id,
   provider_pickup_meta })` with the chosen authoritative `store_id`. **Never** auto-pick the first.
4. If `candidates` is missing/empty on the wire (contract not yet deployed), fall back to the honest
   sync-failed message — **do not** guess and do not surface a fake success.

**Other real pickup/sync codes the tab must map to honest messages (all exist today):**

| Code | HTTP | Where | UI meaning |
|---|---|---|---|
| `DELIVERY_PICKUP_AMBIGUOUS_MATCH` | 409 | new | explicit-selection prompt (§above) |
| `DELIVERY_PICKUP_STORE_REQUIRED` | 409 | `syncProviderPickup` L582 | "a pickup store is required" → guide to Pickup/Stores |
| `DELIVERY_PICKUP_STORE_SYNC_FAILED` | 502 | `syncProviderPickup` L589 | provider returned no store → retry, preserve values |
| `DELIVERY_STORE_SYNC_FAILED` | 503 | controller `/stores` L679 (with `details.cause`) | stores read but not synced → retry, **no external create** |
| `DELIVERY_PROVIDER_UNSUPPORTED` | 400 | `getProviderStores` L627 | provider has no store API (steadfast) → manual only |
| `DELIVERY_PROVIDER_NOT_CONNECTED` | 400 | pickup set/sync | connect first |
| `PICKUP_LOCATION_PROVIDER_MISMATCH` | 400 | `setPickupConfiguration` L478 | location belongs to another provider |
| `PICKUP_LOCATION_NOT_FOUND` | 404 | get/update/delete | refresh list |
| `VALIDATION_ERROR` | 400 | Joi/`updateSettings` | field-level inline errors |
| (activation) `CONFLICT`/409 | 409 | activate | → navigate to Pickup with `missing[]` (existing B18) |

## 5. New i18n keys (en.json + bn.json — full parity; existing prefixes stay)

Reuse `manageShop.deliverySettings.*` (98 keys) and `courier.pickup.*` verbatim where possible. Add
**new prefixes** under `manageShop.deliverySettings`:

- `.tabs.{providers,pickup,charges}` — tablist labels + `aria-label`.
- `.providers.*` — drawer title, reconnect, clearDefault / clearDefaultSuccess / clearDefaultFailed,
  drawer field/help labels, sandbox label per provider.
- `.pickup.*` — workspace: `title, description, storePanel, localList, import, importAll, link,
  create, edit, setDefault, delete, deleteConfirm, deleteConfirmBody, syncStatus, syncing,
  synced, syncFailed, retry, noStores, noLocations, manualOnly` and per-provider unsupported copy.
- `.pickup.ambiguous.*` — `title, body, choose, candidatesLabel, confirm, cancel` (the explicit-selection
  dialog).
- `.charges.*` (optional grouping labels only — keep existing `generalSettings`, `areaBasedPricing`,
  `weightCharges`, `saveCharges`, `saveChargesScope`, `chargesSaved`, honesty copy unchanged).
- New under `.errors.*`: `importFailed, createStoreFailed, deleteFailed, setDefaultFailed,
  clearDefaultFailed, retryFailed, ambiguousUnresolved`; under `courier.pickup.errors.*` reuse
  existing `fieldsRequired/locationsLoadFailed/syncFailed` + add `storesLoadFailed, deleteBlocked`.

Rules: bn default + en fallback, `_one`/`_other` plural keys, keep Bangla numerals in number copy, use
`defaultValue:''` for optional capability/reason codes as today. Do not remove any existing key — tests
reference them.

## 6. File ownership recap (writers must not collide — from plan file-level map)

- `DeliverySettings.tsx` = **A0** (shell, tablist, banners, one-PUT orchestration, cross-tab dirty/saved
  snapshot, unsaved-draft guard; adds the §2a client fns + §3 types; i18n wiring).
- `delivery/ProvidersTab.tsx` + `delivery/ProviderDrawer.tsx` = **A2**.
- `delivery/ChargesTab.tsx` = **A3**.
- `delivery/PickupTab.tsx` (+ refactor/reuse of `PickupDetailsModal.tsx`) = **A4**.
- `api/domains/order.ts` + `api/types/order.ts` = **A0/A5 coordinated**.
- `i18n/locales/en.json` + `bn.json` = A0 (each writer submits the keys it needs; A0 merges).
- Optional shared `delivery/styles.ts` (lifted `FOCUS_RING`/`INPUT_CLASSES`) = **A0**, imported by A2/A3/A4.
- Backend `delivery.service.js` / `delivery.controller.js` / `pickup-location.service.js` /
  `delivery.routes.js` / `delivery.validator.js` / `provider-capabilities.js` = **A5**.
- **New `/api/*` paths from §2a (`/:provider/stores/import`, `/:provider/stores` POST) MUST be added to
  `tests/e2e/delivery-guardrails.spec.ts` `KNOWN_PATHS`/`KNOWN_PATTERNS` in the same PR**, or CI fails.
