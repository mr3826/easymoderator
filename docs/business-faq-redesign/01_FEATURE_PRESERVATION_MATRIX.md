# 01 — Feature Preservation Matrix (A1)

Writer: A1 (docs). Binding source: `00_A0_DATA_CONTRACT.md`. Evidence read from
`origin/main` @ b8d2d465 in this worktree:

- `EasyMod-frontend/src/app/components/BusinessInfoSettings.tsx` (profile shell/header/load-retry/automation link)
- `EasyMod-frontend/src/app/components/BusinessInfoForm.tsx` (6-key payload, dirty-gate, notice pattern, social group, char counter)
- `EasyMod-frontend/src/app/components/business/derive.ts` + `faq/derive.ts` (signal matrices)
- `EasyMod-frontend/src/app/components/FaqSettings.tsx` (list/toolbar/dialogs/gap cards/sonner usage)
- Tests to preserve: `src/app/components/__tests__/BusinessInfoGuardrails.test.tsx`, `__tests__/FaqGuardrails.test.tsx`, `BusinessInfoSettings.test.tsx`, `BusinessInfoForm.test.tsx`, `FaqSettings.test.tsx`, `FaqSettings.gaps.test.tsx`; `tests/e2e/business-info-guardrails.spec.ts`, `tests/e2e/faq-guardrails.spec.ts`
- API: `src/api/domains/shop.ts`, `src/api/domains/knowledge.ts`, `src/api/types/knowledge.ts`, `src/app/lib/knowledgeTypes.ts`, `src/api/index.ts`
- Backend shapes: `EasyMod-backend/src/modules/shop/shop-settings.validator.js` (BUSINESS_INFO_SCHEMA, isValidSocialLinks), `shop/shop.routes.js` (PUT business-info = `verifyShopAccess, requireOwner`), `knowledge/knowledge.validator.js` (createFaq/updateFaq), `knowledge/knowledge.routes.js` (GET `/shop-settings/:shopId/policies` confused-deputy read), `knowledge/faq-response.entity.js`

Legend — **KEEP**: survives the redesign unchanged (same behavior, same pin). **CHANGE**: capability survives but is moved, extended, or its affordance/wording changes (pin updated by A6). **NEW**: capability introduced by this redesign (contract-backed only). Frozen-scope items (Chat Settings, AI modes/thresholds/handoff, templates, Delivery/Payment Settings) are *not* capabilities of these pages and are listed once under §5 reference-only.

## 1. Workspace shell (route-compatible, A0-owned)

| # | Existing capability / pin | Verdict | Notes |
|---|---|---|---|
| S1 | Route `/manage-shop/business-info` (lazy `BusinessInfoSettings`, `src/app/routes.ts:205`) | CHANGE | Renders the tabbed workspace, initial tab = **Business Profile**. URL stays valid; no nav change (nav items in `DashboardLayout.tsx:77,82` untouched — frozen scope). |
| S2 | Route `/manage-shop/faqs` (lazy `FaqSettings`, `routes.ts:213`) | CHANGE | Same workspace, initial tab = **FAQs**. |
| S3 | `.em-business` wrapper (axe include selector, e2e + guardrail suites) | KEEP | Carried by the shell (A0). Policies panel renders inside it too (A0 contract). |
| S4 | `.em-faqs` wrapper (axe include for FAQ surface) | KEEP | Carried additionally by the FAQ **panel**, not the whole workspace — existing `AxeBuilder.include('.em-faqs')` pin stays valid. |
| S5 | Tablist affordance | NEW | Delivery-style roving-focus tablist (`DeliverySettings.tsx:209-337` pattern): `role=tablist` + `role=tab` buttons `aria-selected/aria-controls/tabIndex`, ArrowLeft/Right/Home/End, `overflow-x-auto` at 360px. New testids `business-faq-tab-*` (03 §4). |
| S6 | Tab switch does not change the URL | NEW | Delivery precedent is local state; switching Profile→FAQs keeps `/manage-shop/business-info`. Gap deep-links that navigate (`openSettings`) still work because both routes exist. |
| S7 | Only the active tab panel mounts | KEEP-pattern | Delivery pattern (`activeTab === … && <tabpanel>`); keeps per-tab fetch lazy so e2e allowlists stay minimal, and keeps the FAQ tablist out of `.em-business` axe scope unless active. |
| S8 | `MotionConfig reducedMotion="user"` + `ANIMATE = import.meta.env.MODE !== "test"` gate + `fadeUp` for panels | KEEP | Already on both pages; shell inherits. No new motion vocabulary. |
| S9 | PageHeader execution contract (title + signal + factual pills, NO header CTA) | CHANGE | Survives per active tab (02): profile tab keeps `business-signal` + "Business Info" h1; FAQ tab keeps `faq-signal` + "FAQs" h1; policies tab gets `policies-signal`. `dashboard-primary-action`/`inbox-primary-action` absence pins keep passing because no tab adds a header CTA. |
| S10 | `authService.refreshShops()` after business-info save (e2e `shopListCalls ≥ 1`) | KEEP | Stays on the profile save path. |
| S11 | Abort discipline (`AbortController` ref + guarded setState + fresh controller on retry, `BusinessInfoSettings.tsx:28-62`, mount-once `load` pinned by eslint-disable) | KEEP | Shell/profile inherit verbatim. FaqSettings today has **no** abort guard; A3 adds the same ref-guard pattern for list load (house rule "abort discipline intact"), no other behavior change. |

## 2. Business Profile tab (from BusinessInfoSettings + BusinessInfoForm)

| # | Existing capability / pin | Verdict | Notes |
|---|---|---|---|
| P1 | Signal matrix `deriveBusinessSignal` (error→blocked "Profile unavailable"; loading→pending; shopName set→healthy "Profile ready"; unset→attention "Profile needs a name"), `signalTestId="business-signal"`, `signalAnnounce={false}` | KEEP | Pure fn file `business/derive.ts` stays unedited; tab passes same input. Key-name lesson preserved: signal keys avoid the pin-regex substrings (error/failed/saved/success/loading/save) so tMock raw-key renders never collide. |
| P2 | Pills: `socialCountLabel` + `infoLengthLabel` (extra-info length) | CHANGE | Pill markup/`em-tabular` pattern kept. Social count currently only tallies `facebook, website` (`BusinessInfoSettings.tsx:75`); once A2 enables all six social keys the tally must cover all six (else a stored Instagram link is invisible). e2e only pins `Social links: 1` with one facebook link — passes either way. |
| P3 | Field set: shopName, address, phone, openingHours, additionalInfo | KEEP | Same ids/labels (`bi-*`, `manageShop.businessInfo.*`), `INPUT_CLASSES`, `FOCUS_RING`, helper + placeholder keys. `shopName` remains THE authoritative identity (single-shop-name sync contract via shop.service rename path — do not re-home it). `openingHours` stays free text with placeholder (per-day hours grid is reference-only, §5). |
| P4 | NEW fields `nameEn` (≤120), `tagline` (≤160), `email` (≤254, RFC-lite), `city` (≤60) | NEW | A0 §businessInfo extension. Email is customer-facing info only — zero auth/credentials coupling; never labeled or placed as login data. New ids `bi-nameEn/bi-tagline/bi-email/bi-city`; max lengths mirror the validator so maxLength never fights the server. |
| P5 | **6-key payload exclusion rule**: PUT body carries only edited fields; `deliveryAreas`/`paymentMethods` must NOT be present (backend preserves stored values; they live on Delivery/Payment pages). Pinned by unit (`not.toHaveProperty`) AND e2e (`lastPutBody` assertions) | KEEP-as-rule | Rule survives verbatim. Payload grows to **10 keys** (6 + nameEn/tagline/email/city) — A6 updates the payload pin per contract; the two exclusions stay asserted. `normalizeBusinessInfo` must list the new fields explicitly (do not spread `initialData` — that is what keeps the exclusions true). |
| P6 | Social links: label/placeholder key pattern, `role="group"` + aria-label ("Social Media Links"), 2 visible fields (facebook/website) | CHANGE | All six keys (`instagram`, `whatsapp`, `tiktok`, `youtube` added to UI) per contract — backend `isValidSocialLinks` already covers six. Legacy stored values for not-yet-edited keys survive round-trip (normalize keeps `socialLinks` object as-is). New label/placeholder keys in 03 §3. |
| P7 | Dirty gate: `JSON.stringify(businessInfo) !== JSON.stringify(savedBusinessInfo)`; Save disabled until dirty; baseline reset only after server-resolved save | KEEP | Exact pattern survives (delivery `chargesDirty` shows the house style). Add unsaved pill mirroring `delivery-charges-unsaved` (`profile-changes-unsaved`). |
| P8 | Notice pattern (NOT sonner): inline `role="status"` on success (auto-clears after 3 s) / `role="alert"` on error, server-confirmed — shown only after awaited `updateShopBusinessInfo` resolves | KEEP | Profile keeps inline notice; FAQ keeps sonner for row-level mutations (house rule: both existing patterns survive, don't unify, don't invent). Success text stays `manageShop.businessInfo.successMsg`. |
| P9 | Load-failure alert with `retryLoad` button that recovers the form (e2e "load failure offers a retry"; dev-double-mount handled by fail-all-until-flip) | KEEP | Stays in the profile tab's error branch. |
| P10 | Loading skeleton: 2 `animate-pulse` rows, `aria-label=loading` | KEEP | Same markup moves into the tab panel. |
| P11 | `business-info-automation-link` → `/manage-shop/automation` (Bot icon card, `ChevronRight`) | KEEP | A0 explicitly keeps the deep-link on Profile. Pins: testid + href + absence of `ai-reply-mode`, `radiogroup`, `Save Reply Settings` — the ADR-0013 §1 boundary. |
| P12 | ADR-0013 §1 boundary (no AI reply-mode control anywhere on this surface; radiogroup-free; range-free) | KEEP, EXTEND | Boundary applies to the WHOLE workspace (all three tabs + editor drawer): no `input[type=range]` (kills the mock's confidence slider), no AI mode/threshold controls, no "notes feed AI" copy. The e2e `radiogroup==0` pin is scoped to the business-info route with Profile tab active; A6 must NOT broaden it blindly — policies stance uses `<select>`, not radios (02 §3), so the pin stays true even if A6 checks all tabs. |
| P13 | Char counter `N/3000` on additionalInfo + `maxLength=3000` + help text | KEEP | Counter uses `em-tabular`. |

## 3. FAQs tab (from FaqSettings + faq/derive + gap cards)

| # | Existing capability / pin | Verdict | Notes |
|---|---|---|---|
| F1 | Signal matrix `deriveFaqSignal` (blocked/pending/attention-with-openGapCount/empty/healthy), `faq-signal` testid | KEEP | Inputs survive: `phase`, `openGapCount` (gap list), `activeCount`→ **publishedCount**, `totalCount`. "active" in the reason text stays truthful because server keeps `is_active` mirror in sync with status (contract). |
| F2 | Pills: `metrics.active`, `metrics.total`, `metrics.used` | CHANGE | `active` relabels to **published** (lifecycle chip semantics §4), `used` relabels to **replies used** — contract bans the words "retrieval"/"success" for `use_count`. Counts must become **per-status accurate** against the merchant list (contract: GET returns all statuses + accurate per-status counts) — no fabricated totals. |
| F3 | Confidence text on every row (`manageShop.faqs.confidence` = percent) | REMOVE (replaced) | Contract inverts the assertion: **no confidence text anywhere**. The locale key retires (A0); the API keeps accepting `confidence` but discards it (backend comment survives). Unit guardrail's `queryByRole('radiogroup')`/range-free rule covers slider ban; A6 adds "no `confidence`/`%` text" assertion. |
| F4 | Row meta lines `source`, `usedTimes` | KEEP | `usedTimes` copy relabels to replies-used (F2). Timestamps newly displayed per contract. |
| F5 | Honest timestamps | CHANGE (bug-fix) | `mapFaqFromBackend` currently FABRICATES `createdAt/updatedAt` with `new Date().toISOString()` fallbacks (`knowledge.ts:348-349`); backend `formatFaq` fabricates `updatedAt=created_at`. New mapper passes NULL through; UI renders `—` (never a lie, never relative-time). `updated_at` becomes real (migration column). |
| F6 | `faq-add` single screen-level primary in work-area toolbar; hidden while `loadError`; shown in empty state | KEEP | Same gating rule (error hides creation, empty offers it). |
| F7 | Refresh button → reloads list from server | KEEP | |
| F8 | Create/edit via in-system modal (`role=dialog`, `aria-modal`, labelled Question/Answer, Escape + backdrop close, `useDialogFocus` trap + focus restore to invoking button, server-response replaces row) | CHANGE → drawer | Becomes `FaqEditorDrawer`: right-side drawer on desktop (`ProviderDrawer` pattern), full-screen on mobile. Focus discipline, labels, Escape/backdrop close, and "list row updated from server payload, not optimistic merge" all survive. Editor gains fields (answer_bn, category_tag, keywords, notes, status, priority — contract payload). |
| F9 | Category-overwrites-question guard (payload sends NO `category`; unit pin `expect(sent).not.toHaveProperty('category')`; removed duplicate Category input) | KEEP-as-rule, SUPERSEDED | Contract makes the bug structurally impossible (`category_tag` own column; new writes dual-write `category:=question`). Frontend rule survives: the client NEVER sends a standalone category value that could shadow the question; it sends `question` + optional `category_tag`. A6 re-pins the regression per contract ("rewrite of the old P03 regression pins"). |
| F10 | Row activate/deactivate toggle via `updateKnowledgeFaq({active})` + success toast only after await; error toast on failure | CHANGE | Becomes explicit **enable/disable lifecycle transition** (PATCH `status`), plus per-row Archive/Restore and BULK enable/disable (NEW, §4). Same server-confirmed rule; no optimistic flip. |
| F11 | In-system danger delete confirm (`faq-delete-confirm`, question shown, Cancel restores focus, NOT `window.confirm`), hard delete + `deletePoint` owner-only | KEEP | Permission: DELETE owner-only — `isOwner` pattern (`getCurrentShop()?.role === "owner"`); non-owners don't see the control. |
| F12 | ResultBanner load error with refresh `nextAction` + `role=alert` | KEEP | Stays inside the work surface (§13 rule). |
| F13 | 3-row skeleton loading; 3-part empty state (icon+title+description+CTA) | KEEP | Empty copy survives; CTA opens the drawer. |
| F14 | Sonner toasts for mutation feedback (`saved/activated/deactivated/deleted/validationError` + gap-flow toasts) | KEEP | FAQ area keeps sonner; ResultBanner/inline notice stay for load errors. No new toast vocabulary. |
| F15 | Gap-suggestions section: `gap-suggestions` testid, per-card `gap-suggestion-<id>`, single fetch on mount, FEATURE_DISABLED/404/409 → render nothing, domain pill `faqSettings.gaps.domain.*`, `askedTimes`, IN_REVIEW chip, `gap-open-settings` routing via `GAP_SUGGESTION_SETTINGS_PATHS` (PAYMENT→payment-settings, DELIVERY→delivery-settings, PRODUCT→/products, POLICY/OTHER→inline author), `gap-publish` through FAQ authority (merchant-authored only), dismiss reasons (5) + `gap-dismiss-confirm`, 409 GAP_STATE_CONFLICT → refetch + `refreshed` error toast, NEVER claim success | KEEP — UNTOUCHED | A0: flags/ops/domain-routing untouched. Section moves verbatim into the FAQ panel; publish creates a **published eligible** FAQ through the new path (server-side; client call unchanged). Guardrail pin "textarea-last while authoring" survives. |
| F16 | `useDialogFocus(editorRef, Boolean(editingFaq))` + separate ref for delete | KEEP | Drawer keeps the hook; both dialogs keep focus-return semantics. |
| F17 | New: worklist search + category_tag/status filters with accurate counts, per-row timestamps, reply-usage, bulk enable/disable, archive/restore/resync, lifecycle + sync chips | NEW | All contract-backed (A0 FAQ API + transitions + sync integrity). No sort beyond "updated first" default; no saved views/CSV/drag/manual order (they are not in the contract) — §5. |
| F18 | Saved-vs-synchronized honesty: response returns `sync_status='pending'` after DB commit; UI distinguishes "Saved" (row exists, server-confirmed) from "Live for AI" (synced) | NEW | §8 Pending-signal rule; failure shows retryable `resync`. Never claim synced without the server field. |

## 4. Lifecycle chip semantics (single source for 02/03)

Status (merchant-visible, server truth): `draft` (saved, AI does not use), `review` (saved, flagged for review, AI does not use), `published` (AI may answer from it — ONLY eligible state), `disabled` (paused, out of index), `archived` (hidden from default list; restore → `disabled`, no extra stored state per contract).
Sync (RAG): `pending` (saved, syncing), `synced` (live at `synced_at`), `failed` (saved but not applied — Retry/`resync` visible), `pruned` (dropped from index by reconcile).
`is_active` is a server-maintained mirror only — never a separate UI concept.
Chip pairing rule: lifecycle chip answers "can AI answer from this?", sync chip answers "is the latest text live in the index?". Both labeled, never color-only (§8/§18).

## 5. Reference-only — DO NOT invent (from the Qwen mock)

Visual language may be borrowed (cards, chips, toolbar rhythm). These mock features have **no backend contract** and must not appear:

1. Confidence slider / `%` meters / "below-confidence threshold" warnings (per row or page-level) — F3 bans all confidence UI.
2. Per-day opening-hours grid (`hoursHtml`) — `openingHours` stays a single free-text field.
3. Saved views, CSV export, density/motion toggles in-toolbar.
4. Drag/manual row reordering (grip, mv-up/mv-down) and `sorts` rail beyond updated-default.
5. Simulator / "test answer" preview (`rec-test`, `faqCoverage%`, `sim-zone`, quote/bill chains).
6. Notes-in-AI: `internal_notes`/`keywords` NEVER surface as AI-visible or customer-facing facts (contract pins exclusion at every read; UI copy must not promise otherwise — notes are "internal only").
7. Per-row `aiUse` toggle / tone / register / language segmented controls on FAQ tab — AI modes/thresholds are frozen scope.
8. The mock's 4th "Message templates" tab — templates frozen scope; exactly three tabs.
9. Mock policy fields COD-allowed / advance-required / delivery-promise / return-days-only toggles — COD & delivery promise live on Payment/Delivery Settings (frozen); policies tab implements ONLY the contract's four policies {returns, exchange, refunds, warranty} with stance/period/details/exclusions/process/duration/coverage shapes.
10. Platform limit pills, activity/audit rails, avatar-ID monospace sublines beyond what the API returns.

## 6. Business Policies tab (all NEW)

| # | Capability | Verdict | Notes |
|---|---|---|---|
| Y1 | GET/PUT `/api/shop/business-policies` under `shop.settings.policies` via `updateShopSettingsPreservingRtoConsent` | NEW | Middleware mirrors business-info: GET any member, PUT `verifyShopAccess+requireOwner`. Confused-deputy guard test pattern copied from `knowledge.routes.js:16` (`shop-settings/:shopId/policies`). |
| Y2 | Four policy cards with fields per contract (`stance: unspecified|offered|not_offered|conditional`; `period_days 0..365|null`; `details ≤500`; `exclusions ≤500|null`; refunds `process ≤500|null`; warranty `duration ≤120|null`, `coverage ≤500|null`, `coverage_exclusions ≤500|null`) | NEW | `conditional` REQUIRES details text (UI helper; server validator authoritative). |
| Y3 | No-defaults rule: absent ≠ `{}` ≠ `not_offered`. UI must render "Not stated" distinctly from "We do not accept" and must not PUT empty objects for untouched policies | NEW | Contract's central honesty rule; tests pin it. Dirty-gate compares against loaded row; only edited policies are sent. |
| Y4 | Informational-only: policies NEVER change order-cancel/refund/exchange/warranty enforcement code paths | NEW (invariant) | UI copy states it; zero automation (contract + tests). This does not touch the frozen order surfaces — it is a documented boundary. |
| Y5 | Projection into AI knowledge (reserved `returnPolicy` slot + `policies` block in `getKnowledgeForAI`) | NEW (backend) | UI states facts flow to AI replies as a plain help line; no "simulate answer" affordance (§5.5). |
| Y6 | Permission view: non-owner members see read-only values + "an owner can change these" note (§21.6 show-permission rule) | NEW | `isOwner` pattern; do not PUT as staff (would 403). |

## 7. Retired / superseded items (explicit)

- Dead `PUT /api/knowledge/business-info` (`updateBusinessInfo` in `api/domains/knowledge.ts:54-60`): NEVER used by the new tree (A0 trap). Function stays until A0 decides; no component imports it.
- `mapFaqFromBackend` `confidence: 0.9` default fabrication: new mapper drops confidence display entirely (accept-but-discard is backend-side only).
- `manageShop.faqs.modal.*` centered-modal CSS block: replaced by drawer; keys survive for title/labels where reusable.
- `manageShop.faqs.confidence` locale key: retires with F3 (A0 removal, parity gate must stay green).
- Legacy `BusinessInfoSettings.tsx`/`BusinessInfoForm.tsx`/`FaqSettings.tsx` files: untouched until A0 integration, then retired/updated by A6 (contract).

## 8. Test-pin index (what must still pass, adapted where marked)

Unit (each component self-tests via `vi.mock` of the whole api module domain — house rule):
- business-info: signal matrix (4 kinds), header-no-CTA (`dashboard-primary-action` null), label association incl. `id="bi-shopName"`, social group + Website visibility, counter `5/3000` + `maxlength`, dirty-gate + 10-key payload with both exclusions, success `role=status` + error `role=alert`, retry recovers + `getShopBusinessInfo` called 2×, automation link href, no `ai-reply-mode`/`radiogroup`/`range`, `refreshShops` invoked.
- faq: signal matrix (incl. attention-count "1", blocked hides `faq-add`, empty shows it), dialog role + Escape + focus-return, no category-input + no-category-payload regression, danger-confirm pins, gap cards (primary-per-domain, textarea-last, 409→refetch-no-success).

E2e (`tests/e2e/*-guardrails.spec.ts`) — all keep `state.unexpected == []` allowlist+abort discipline; A6 adapts per contract:
- business-info: heading "Business Info", `business-signal` text, `Social links:`, save PUT pin (now 10-key), `deliveryAreas/paymentMethods` NOT in body, `shopListCalls ≥ 1`, status "Business info saved", retry-recovery flow (loadFails=99 trick), automation href, no ai-reply-mode/radiogroup/"Save Reply Settings", 390px overflow ≤0 + 5 mobile nav links, axe on `.em-business` with `reducedMotion:'reduce'` + 800 ms settle.
- faq: heading "FAQs" level 1, `faq-signal` texts ("Knowledge ready"/"Questions need answers"/"No answers yet"/"Knowledge unavailable"), `faq-add` count pins, create-flow lands row, delete-flow `faq-delete-confirm`, gap card flow + `state.published`, 390px + 5 mobile links, axe on `.em-faqs`.
- NEW allowlist entries needed (03 §5): `/api/shop/business-policies` + `/api/knowledge/faqs/<id>/(archive|restore|resync)` patterns.
- NEW inverted pin: no "confidence" or "%" confidence text renders anywhere; no range input.

Numerals/dates: bn-first, `Intl` with `localeFor` pattern (bn→bn-BD), NULL timestamps → `—` (no fabricated relative time). Motion: 100-200 ms micro, 200-300 ms panels/drawer, `reducedMotion="user"`, ANIMATE gate; no pulsing dots, no stagger-spam, no bounce/blur.
