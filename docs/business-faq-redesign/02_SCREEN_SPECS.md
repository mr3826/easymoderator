# 02 — Screen Specs (A1)

Guardrails v2 §26 template per tab. Binding: `00_A0_DATA_CONTRACT.md`; preservation verdicts: `01_FEATURE_PRESERVATION_MATRIX.md`. Reuse paths and client signatures: `03_REUSE_AND_CLIENT_MAP.md`. All copy bn-first (§25 checklist applies per tab).

## 0. Workspace shell (A0-owned; all three tabs share it)

```text
.em-business
├─ PageHeader (execution contract §29: title + ONE signal + factual pills, NO CTA)
│    title ← active tab's page name (h1): "Business Info" | "FAQs" | "Business Policies"
│    signalTestId: business-signal | faq-signal | policies-signal (per tab)
│    breadcrumb: [shopName]
├─ tablist (delivery roving-focus pattern)   business-faq-tab-{profile|faq|policies}
└─ tabpanel (only active mounts)             business-faq-panel-{profile|faq|policies}
     profile/policies panels → inside .em-business only
     faq panel → ALSO carries .em-faqs (existing axe/guardrail selectors stay valid)
```

- Entry: `/manage-shop/business-info` → tab=profile; `/manage-shop/faqs` → tab=faq; no third route (policies reachable only by tab — acceptable: it has no legacy URL, no nav item, frozen scope).
- Tab switch = local state (no URL change, no refetch churn; per-tab data loads on activation).
- WHY HERE (tablist + h1 + breadcrumb shopName); WHAT NOW (active tab's work area); WHERE NEXT (Save/drawer/deep-links); PROVEN RESULT (server-confirmed values + timestamps + chips). Semantic answers live in the controls — no `WHY HERE` copy bands (§23 rejection rules).
- Motion: shell sections use `fadeUp` under `MotionConfig reducedMotion="user"` + `ANIMATE` gate; tab content swap: none/instant (contract — editor swap none/instant).
- Keyboard: tablist Arrow/Home/End roving focus, Enter/Space selects, tab `tabIndex=-1` except selected (delivery `moveTabFocus`). Panels `tabIndex={-1}`.

## 1. Tab — Business Profile

### Merchant job
Keep the shop's identity and facts current so AI replies and the profile itself stay correct — name (bn + en), one-line promise, contact, location, hours, extra facts, links.

### Page archetype
Configuration/editor (§5.6, §21.6). Entry intent: inspect + edit controlled fields, save deliberately. Not overview: no dashboard-style summary beyond one signal.

### Existing capability boundary
- Verified data: `GET /api/shop/business-info` → `{ businessInfo, shop }`; all six `socialLinks` keys valid on backend (`isValidSocialLinks`); new `nameEn/tagline/email/city` optional (A5).
- Verified actions: `PUT /api/shop/business-info` — `verifyShopAccess + requireOwner` (backend `shop.routes.js:61`); existing UI does not gate the button by role — unchanged (403 path shows the server error as `role=alert`; not invented new gating on this legacy behavior).
- Unavailable (do not surface): `deliveryAreas/paymentMethods` (Delivery/Payment pages, frozen), any AI/mode/threshold control (ADR-0013 §1), per-day hours editor, structured business-hours widget.

### Core Design Test (semantic)
- WHY HERE: h1 "Business Info" + selected Profile tab + breadcrumb shop.
- WHAT NOW: grouped labelled inputs; helper text where the field feeds replies (`additionalInfoHelp`, tagline/email help lines); live 3000-char counter.
- WHERE NEXT: dirty → "Save Changes" at the form's stable end-point (single save point, §5.6); `business-info-automation-link` card for behavior work; after save the merchant stays in the (now-saved) profile.
- PROVEN RESULT: notice only after awaited PUT; `authService.refreshShops()` propagates the new shop name; header signal/pills recompute from state; "Saved vs synchronized": profile facts persist synchronously in `shop.settings.businessInfo` — the contract defines NO sync-state for businessInfo, so the UI says saved, never "live for AI" beyond the existing help copy.

### Screen regions
1. Header (P1-P2 pins).
2. Identity card: `shopName` (authoritative; bn) + `nameEn` + `tagline` (grid 2-col md, 1-col mobile).
3. Contact & location card: `phone`, `email`, `address`, `city`.
4. Hours & extra facts card: `openingHours` (free text + placeholder), `additionalInfo` (counter + help).
5. Social links group (all 6 inputs, md 2-col; legacy values preserved).
6. Automation deep-link card (KEEP P11).
7. One Save button at the end of the form + inline notice slot.

### Contextual actions
| Action | Endpoint | Permission | Consequence |
|---|---|---|---|
| Save Changes | `PUT /api/shop/business-info` (10-key payload, P5 rule) | owner (server-enforced) | persists + shop-list refresh; success `role=status`; failure `role=alert`, edits preserved (§12 preserve input) |
| Open automation | `/manage-shop/automation` link | any | ADR-0013 §1 boundary honored — nothing AI-related happens here |
| Retry loading | re-GET with fresh `AbortController` | any | error branch recovers (P9) |

### States
- Loading: 2-row skeleton, `aria-label` loading, signal `pending`.
- Error (load): alert + retry; signal `blocked`.
- Empty: all fields blank + signal `attention` ("Profile needs a name") — empty guidance = name the shop; helper lines carry the rest.
- Pending: Save disabled while `isSaving` (EmButton `loading`) or not dirty; unsaved pill `profile-changes-unsaved` while dirty (delivery precedent).
- Success: inline status notice (3 s auto-clear), baseline re-seeded, dirty clears. No sync chip exists for profile (explicit omission).

### Responsive / keyboard / a11y
360px: single column, inputs `min-h-11`, pills wrap, tablist scrolls horizontally, zero horizontal overflow (e2e pin). Keyboard: natural DOM order; labels `htmlFor`+aria-label pattern kept; social block `role=group`. A11y: counter text is plain text (not color), focus rings `FOCUS_RING`, axe on `.em-business` reduced-motion.

### Explicit omissions
No header CTA (§29), no AI control/range/radiogroup (P12), no per-day hours grid, no save-view/CSV, no "AI is using this now" claim (no sync contract for profile), no delivery/payment fields (6-key rule), no notes/keywords concept (FAQ-only).

## 2. Tab — FAQs

### Merchant job
Maintain the answers the AI uses in customer DMs: write/edit answers, keep the right ones live, pause or retire wrong ones, close the "questions customers keep asking" gaps — and know, honestly, which saved text is actually live in the knowledge index.

### Page archetype
Configuration/editor (content) with an execution-style worklist inside: the FAQ list IS the work surface (rows with per-record status — §5.3/§13 rules apply to the list), but the page's entry task is authoring content, so it keeps the existing §29 execution-page header pins. Primary = author/create; secondary = filter/review/retire.

### Existing capability boundary
- Verified data: `GET /api/knowledge/faqs` now returns ALL statuses with rich fields (`id, question, category_tag, answers{en,bn}, keywords, notes, status, is_active mirror, priority, use_count, created_at, updated_at, sync_status, sync_version, synced_at`) + accurate per-status counts + existing gap stats.
- Verified actions (contract): `POST` create, `PATCH /:id` (status transitions + fields), `POST /:id/archive`, `POST /:id/restore` (→ `disabled`), `POST /:id/resync` (owner), `DELETE /:id` (owner + deletePoint), gap-suggestions ops (feature-flagged, untouched), replies-used = `use_count` relabeled (never "retrieval/success").
- Unavailable: confidence UI, AI-mode linkage, per-row aiUse, RAG simulator, drag-order, CSV/saved views, bulk delete/archive (bulk is enable/disable only), category-free-text that shadows the question (F9).

### Core Design Test (semantic)
- WHY HERE: FAQ tab selected + `faq-signal` + pills (published/total/replies-used) — existing pins.
- WHAT NOW: search box + status/category filter chips with counts + list rows + `faq-add`; gap cards above with their authoritative single next step per domain (F15 unchanged).
- WHERE NEXT: row → editor drawer; save → row refreshed from server; archive → row leaves default list; restore → back as disabled.
- PROVEN RESULT: dual-chip honesty (01 §4): lifecycle chip = server `status`; sync chip = `pending|synced|failed|pruned` + `synced_at`/`updated_at` rendered via `localeFor` Intl, NULL → `—`. Toast/inline copy separates "Saved" from "Live for AI"; `resync` failure state retryable. Never claim synced while pending (§8 Pending rule).

### Screen regions
1. Header (pins F1/F2).
2. Gap-suggestions panel (F15 verbatim, above the work area).
3. Worklist panel:
   - toolbar: `faq-add` (single primary, hidden on loadError), refresh, **search** (`faq-search`, client-side over question/answer/category_tag), **status filter chips** with accurate counts (`faq-filter-all|draft|review|published|disabled|archived`) and **category filter** (`faq-filter-category`, select over distinct `category_tag`s + "Uncategorized");
   - rows `faq-row-<id>`: question (display = `question || category` per contract), lifecycle chip, sync chip, category tag (if set), replies-used, created/updated timestamps, per-row actions (edit, enable/disable, archive|restore, delete[owner]);
   - selection: checkbox per row → **bulk bar** (`faq-bulk-bar`) enabling only Enable/Disable with affected count + server-confirmed results + partial-failure disclosure (§13); selection cleared after bulk; filters preserved across row updates (F13/F14 patterns);
   - default sort: `updated_at` desc, NULL-safe; no manual order control.
4. Editor drawer `faq-editor-drawer` (below).
5. Delete danger-confirm dialog (F11 verbatim).

### FAQ editor drawer (A3-owned `FaqEditorDrawer.tsx`)
- Desktop (≥768px): right-side drawer — scrim `fixed inset-0 bg-em-midnight-950/60`, panel `h-full w-full max-w-md` (ProviderDrawer pattern), slide `initial x:'100%' → 0`, 250 ms transform, ease `[0.2,0.8,0.3,1]`, `MotionConfig reducedMotion="user"` + ANIMATE gate; `role=dialog aria-modal`, `useDialogFocus`, Escape + scrim close, focus restored to invoking control.
- Mobile (<768px): full-screen sheet (same component, `w-full`, no slide transform bounce — opacity/instant swap; editor swap none/instant per contract).
- Mount only while open. Header: title (add/edit) + status chip of the row being edited. Body sections:
  - Question (required, trim; helper that this is what customers ask);
  - Answer EN + Answer BN (both `answer_en`/`answer_bn`; legacy single-answer rows hydrate EN, BN empty; validation: question+answer required as today — server aliases legacy `answer`);
  - Category tag (≤60) + Keywords (chip input array) — helper: internal organization, not customer-visible;
  - Internal notes (textarea) — helper states NEVER shown to customers/AI (01 §5.6 invariant);
  - Status select: Draft | Needs review | Published | Disabled (archived not selectable here — archive is a row action; `published` warns it becomes AI-eligible);
  - Priority (number 0..1000, optional — existing validator range);
  - Footer: Cancel + Save (dirty-gated, `loading` state, server row replaces local). Sync chip after save starts at `pending` — drawer closes, row carries the sync truth (no success-before-sync claim).

### Contextual actions
| Action | Scope | Endpoint | Permission |
|---|---|---|---|
| Add FAQ | page | `POST /api/knowledge/faqs` | any member |
| Edit/save | row→drawer | `PATCH /api/knowledge/faqs/:id` | any member |
| Enable/Disable (+bulk) | row/selection | `PATCH` status | any member (mirrors existing toggle) |
| Archive / Restore | row | `POST /:id/archive` / `/:id/restore` (restore→disabled) | any member (contract marks only resync/delete owner) |
| Retry sync | failed chip | `POST /:id/resync` | **owner** |
| Delete | row, danger-confirm | `DELETE /:id` (+deletePoint) | **owner** |
| Gap publish/dismiss/review | gap card | `/api/knowledge/gap-suggestions/:id/*` | any member (untouched) |

### States
- Loading: 3-row skeleton; signal pending; toolbar disabled-ish only where inconsistency risk (§16).
- Empty: existing empty block + `faq-add` CTA (3-part §16 copy survives).
- Error (load): ResultBanner + retry; `faq-add` hidden; bulk bar absent.
- Pending: row `busyFaqId` spinner (existing pattern), bulk bar shows count; sync chip `pending` = neutral info chip, labeled "Syncing" — no pulsing decoration.
- Sync-failed: danger/info chip + `Retry` (owner) inline on row/`drawer`; copy: saved but not live for replies yet.
- Success: sonner toast on mutation (server-resolved), row reflects returned entity; "Saved" vs "Live" wording per 01 §4.

### Responsive / keyboard / a11y
360px: chips row `overflow-x-auto`; rows stack (question + chips, then meta, then actions — md+ keeps side-aligned actions); drawer full-screen; checkbox targets ≥44px (11-unit pattern); bulk bar sticky bottom within panel. Keyboard: tablist + filter chips reachable; drawer focus trap + Escape; selection operable via checkbox keyboard; row buttons labeled by aria-label with question (`aria-label={\`${t(...)}: ${question}\`}`) so screen-reader action lists stay meaningful. A11y: chips have text labels (no color-only); `aria-live` polite on toasts via sonner (existing); axe over `.em-faqs` reduced-motion (existing pin).

### Explicit omissions
Confidence anywhere; per-row AI toggle; test/simulator; bulk delete; bulk archive; drag order; saved views/CSV/density toggles; category free-text that overwrites question (F9); fabricated timestamps (F5); header CTA; relative-time strings for NULL dates.

## 3. Tab — Business Policies

### Merchant job
State the shop's returns / exchange / refunds / warranty terms in the merchant's own words so customers and AI replies can rely on them — without these notes silently altering how orders are actually processed.

### Page archetype
Configuration/editor (§21.6). Scope = this shop's four facts; entity identified in header breadcrumb + each card title.

### Existing capability boundary
- Verified data: `GET /api/shop/business-policies` (any member) → `{ returns?, exchange?, refunds?, warranty? }` (each field optional; absent = "not stated"); persisted `shop.settings.policies` via `updateShopSettingsPreservingRtoConsent` (merge + RTO consent preserved + cache invalidation — backend contract).
- Verified action: `PUT /api/shop/business-policies` — `requireOwner + verifyShopAccess`.
- Unavailable: enforcement toggles (order-cancel/refund/exchange code paths untouched — Y4 invariant, UI states it), COD/advance/delivery-promise fields (mock-only; Payment/Delivery scope), per-day hours, AI simulator, policy sync chips (contract defines none).

### Core Design Test (semantic)
- WHY HERE: Policies tab + h1 + one info line "informational — shown to customers and AI, does not change how orders are processed" (Y4).
- WHAT NOW: four cards, stance select first, contextual fields per stance; `conditional` reveals details (helper required).
- WHERE NEXT: Save → persisted (PUT resolves → re-read state); nothing else to configure here; orders enforcement lives elsewhere (not linked — avoids implying automation).
- PROVEN RESULT: persisted values + "Last saved" timestamp from server row if returned, else honest `—`; success `role=status`; absence ≠ not_offered rendered visibly ("Not stated" vs "We do not accept").

### Screen regions
1. Header: title, `policies-signal` (derive `policies/derive.ts`, NEW, owned A4; kinds per §8: error→blocked, loading→pending, all-absent→attention "Policies not stated yet", partial→attention with stated count, all-stated→healthy). Pills: stated count X/4, unsaved pill (`policies-unsaved`, dirty-gate).
2. Four policy cards (`policy-card-{key}`), identical skeleton: stance select (`policy-stance-{key}`) → period_days (returns/exchange, 0..365 numeric, only when offered/conditional) → details textarea ≤500 (required when conditional) → exclusions ≤500 → refunds-only: process ≤500 → warranty-only: duration ≤120 + coverage ≤500 + coverage_exclusions ≤500. Empty optional fields show `notSet` style "—" in the read view.
3. Single Save at bottom (mirrors profile's stable save point) + notice slot; Reset-to-saved secondary button (revert edits — cheap, no endpoint needed; only when dirty).
4. Non-owner: controls disabled + `role=note` line "Owner can edit these policies" (Y6) — read-only values still GET-able (permission boundary is real: PUT would 403).

### Contextual actions
| Action | Endpoint | Permission | Notes |
|---|---|---|---|
| Load | GET `/api/shop/business-policies` | member | per-tab lazy load + retry pattern |
| Save | PUT same, body = only edited policies (no `{}` placeholders, no stance defaults invented — Y3) | owner | server-confirmed; re-seed baseline from response |

### States
- Loading: 2-card skeleton (profile pattern), signal pending.
- Error (load): alert + retry (profile pattern verbatim).
- Empty: all four "Not stated" + one-line why ("Until you state them, replies won't guess.") — this is the default; never pre-fill a stance.
- Pending/dirty: Save gated on dirty; unsaved pill; `beforeunload` guard while dirty (delivery precedent, cheap to keep).
- Success: `role=status` "Policies saved"; values become read-state; AI-projection help line static (no sync claims).

### Responsive / keyboard / a11y
360px: cards single column, selects full-width, numeric inputs `inputmode="numeric"`; help text wraps; no overflow. Keyboard: standard. A11y: stance as native `<select>` (4 labeled options incl. "Not stated") — chosen over radios deliberately: keeps the P12 `radiogroup==0` boundary honest workspace-wide and matches the gap-dismiss select precedent; helper text via `aria-describedby`; max-length helpers visible (§12); danger styling unused (nothing destructive here).

### Explicit omissions
Enforcement effects, sync chips, hours grid, COD/advance/delivery-promise fields, duplicate-question AI test, CSV/export, per-policy delete (absent = not stated; no removal affordance — Y3), any copy promising customer-visible policy enforcement.

## 4. Cross-tab acceptance notes (02-level)

1. No tab may contain `input[type=range]`, `ai-reply-mode`, or radiogroups (P12 workspace-wide reading).
2. One writer per file; A0 owns shell + `api/domains/*` + `api/types` + locale JSONs; A2/A3/A4 own tab files and reference shared names only (03).
3. Every `t()` key listed in 03 must exist in bn+en before merge (translation-coverage gate).
4. §25 checklist passes per tab with N/A-justified items (e.g. policies: "bulk actions" N/A — no record list).
5. The three tabs' headers keep independent signals — a fabricated page-wide status across tabs is banned (§8 lists rule; each tab's phase derives from its own load state).
