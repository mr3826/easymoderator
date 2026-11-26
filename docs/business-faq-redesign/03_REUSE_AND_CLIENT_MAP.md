# 03 — Reuse & Client Map (A1)

Inventory for A0 (integration) and A2/A3/A4 (tab writers). "Own" = file's single writer per A0 contract. Reference by name; never edit another role's file.

## 1. Components & patterns to reuse (verified paths, `EasyMod-frontend/`)

| Asset | Path | Use |
|---|---|---|
| EmButton | `src/app/components/dashboard/EmButton.tsx` | all buttons; variants primary/secondary/danger + `loading` (existing usage in both legacy pages) |
| PageHeader | `src/app/components/dashboard/PageHeader.tsx` | per-tab header: title/breadcrumb/`signal`/`signalTestId`/`signalAnnounce={false}`/`meta` pills (`.em-tabular`) |
| SignalBadge | `src/app/components/dashboard/SignalBadge.tsx` (via PageHeader `signal`) | §8 signals; kinds healthy/attention/review/blocked/pending/resolved |
| ResultBanner | `src/app/components/dashboard/ResultBanner.tsx` | FAQ load-error banner (`status/title/description/nextAction`) — existing pin |
| useDialogFocus | `src/app/components/inbox/useDialogFocus.ts` | `(ref, open)`; drawer + delete confirm trap/restore (F16) |
| motion presets | `src/lib/motion` (`fadeUp`, `transitions`, `staggerChildren`) | `fadeUp` + `MotionConfig reducedMotion="user"` + `ANIMATE = MODE!=="test"` only; drawer slide mirrors ProviderDrawer `{duration:0.25, ease:[0.2,0.8,0.3,1]}` on transform; do NOT import `successPulse`/`errorShake`/`staggerChildren` (no pulse/stagger-spam) |
| Tablist shell | `src/app/components/DeliverySettings.tsx:82-337` (pattern; shell file A0-owned) | `role=tablist` + roving `moveTabFocus` + `aria-controls` + single-active panel |
| Drawer | `src/app/components/delivery/ProviderDrawer.tsx` (pattern; new file `business-faq/FaqEditorDrawer.tsx` A3-owned) | scrim + right-slide panel + header/status chip + `drawer-action-feedback` role=alert/status INSIDE dialog + close X `min-h-11 min-w-11` + mount-only-while-open; add `w-full` <768px for mobile full-screen |
| derive modules | `src/app/components/business/derive.ts`, `.../faq/derive.ts` (keep as-is) | new `src/app/components/policies/derive.ts` (A4) mirrors their shape: pure `(input, t) => Signal`, keys avoiding pin-regex substrings (error/failed/saved/success/loading/save) |
| localeFor | `src/app/components/delivery/ProviderDrawer.tsx:63` / `customers/customerDisplay.ts` | copy the 1-line `const localeFor = (l) => l.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US'` + `Intl.DateTimeFormat(localeFor(lang), { dateStyle:'medium', timeStyle:'short' })`; NULL/blank → `'—'`; unparseable → raw string; counts via `Intl.NumberFormat(localeFor(lang))` |
| Form constants | `FOCUS_RING` + `INPUT_CLASSES` (defined per-file in `BusinessInfoForm.tsx:7-11`, `ProviderDrawer.tsx:49-53`) | each new file keeps its own local copy (house one-writer rule; precedent = duplication-by-design here) |
| ui kit | `src/app/components/ui/*` (shadcn set) | only where the surface already uses it; Business/FAQ pages use hand-rolled EmButton+native inputs — keep that idiom (do not mix) |
| isOwner | `authService.getCurrentShop()?.role?.toLowerCase() === 'owner'` (`BusinessAutomationDefaults.tsx:94` et al.) | gate resync/delete (FAQ) + policies PUT affordance (Y6) |
| sonner | `toast` (existing import in `FaqSettings.tsx`) | FAQ mutation toasts only (F14); profile/policies use inline notice slot (`role=status` success 3 s auto-clear / `role=alert` error) per P8 |
| apiClient facade | `src/api/index.ts` | components call `apiClient.*` (tests mock the whole `@/api` module — house rule); gap fns import directly from `@/api/domains/knowledge` (existing pin, keep) |
| getErrorMessage | `@shared/lib/http/errors` | all error copy |
| Page scope wrappers | `.em-business`, `.em-faqs` CSS scoping (existing) | shell carries `.em-business`; FAQ panel adds `.em-faqs`; no new wrappers/classes needed |

## 2. API clients (A0 owns `src/api/domains/*`, `src/api/types/*`, facade; writers call EXACTLY these)

`src/api/domains/shop.ts` (existing + NEW):
```ts
getShopBusinessInfo(): Promise<{ businessInfo: any; shop: any }>            // existing, unchanged
updateShopBusinessInfo(data): Promise<any>                                  // existing; payload now 10 keys (P5)
getShopBusinessPolicies(): Promise<ShopBusinessPolicies>                    // NEW  GET  /api/shop/business-policies
updateShopBusinessPolicies(payload: Partial<ShopBusinessPolicies>): Promise<ShopBusinessPolicies> // NEW  PUT, owner
```
`src/api/domains/knowledge.ts` (extended + NEW):
```ts
listKnowledgeFaqs(): Promise<FAQRich[]>            // existing list call; returns ALL statuses + rich shape (contract serialization list)
createKnowledgeFaq(payload): Promise<FAQRich>      // payload {question, answer_en?, answer_bn?, category_tag?, keywords?[], notes?, status?, priority?} (+legacy alias path server-side)
updateKnowledgeFaq(id, payload): Promise<FAQRich>  // PATCH; also status transitions
archiveKnowledgeFaq(id): Promise<FAQRich>          // NEW POST /api/knowledge/faqs/:id/archive
restoreKnowledgeFaq(id): Promise<FAQRich>          // NEW POST /api/knowledge/faqs/:id/restore   (→ 'disabled')
resyncKnowledgeFaq(id): Promise<FAQRich>           // NEW POST /api/knowledge/faqs/:id/resync    (owner)
deleteKnowledgeFaq(id) / listGapSuggestions / reviewGapSuggestion / dismissGapSuggestion / publishGapSuggestion  // unchanged (F15)
```
Type names A0 will add in `src/api/types/knowledge.ts` (reference only): `FaqStatus = 'draft'|'review'|'published'|'disabled'|'archived'`, `FaqSyncStatus = 'pending'|'synced'|'failed'|'pruned'`, rich `FAQ` extension with `answers:{en,bn}`, `category_tag`, `keywords`, `notes`, `use_count`, `updated_at|null`, `sync_*` — plus `ShopBusinessPolicies` / `PolicyStance` / per-policy shapes per contract §policies. Mapper rule (F5): new mapper must NOT fabricate `createdAt/updatedAt/confidence` — NULL passes through, UI shows `—`.
Traps: never import/call `updateBusinessInfo` from `api/domains/knowledge.ts` (dead `PUT /api/knowledge/business-info`); `apiClient` facade must expose the new names under the same `get/update/listKnowledgeFaqs...` spelling used by the existing suites.

## 3. i18n (A0 merges both locales; bn first; en parity gate)

Prefix decisions:
- REUSE verbatim: all `manageShop.businessInfo.*` (34 keys) for profile fields/notice/link/counter; all `manageShop.faqs.*` (41) except `confidence` (retires with F3; `modal.*` survives for drawer titles/labels); all `faqSettings.*` (37, gap cards untouched); `nav.businessInfo`, `nav.faqs`, `common.cancel`, `common.close`.
- NEW workspace/tab keys → `manageShop.businessFaq.*`:
  - `tabs.label|profile|faq|policies`
  - `profile.nameEn|tagline|email|city` + `*Placeholder` + `taglineHelp|emailHelp|cityHelp` + `social.instagramLabel|instagramPlaceholder|whatsappLabel|whatsappPlaceholder|tiktokLabel|tiktokPlaceholder|youtubeLabel|youtubePlaceholder` + `unsavedPill`
  - `faq.search|searchAria|filter.label|filter.all|filter.status.draft|review|published|disabled|archived|filter.category|filter.category.none|bulk.selected{count}|bulk.enable|bulk.disable|bulk.done|chip.status.draft|review|published|disabled|archived|chip.sync.pending|synced|failed|pruned|sync.retry|time.created|time.updated|repliesUsed|notSet|archived|restored|resynced (archive/restore stay single-tap+toast — confirm dialog is delete-only)|editor.answerEn|editor.answerBn|editor.categoryTag|editor.keywords|editor.keywordsPlaceholder|editor.notes|editor.notesHelp|editor.status|editor.statusHelp|editor.priority|editor.publishedWarn|savedToast`
  - `policies.title|intro|informational|signal.pending|signal.blocked|signal.attention|signal.reason.unavailable|signal.healthy|signal.reason.stated{count}|stated|notStated|notOffered|offered|conditional|card.returns|card.exchange|card.refunds|card.warranty|stance|periodDays|periodDaysHelp|details|detailsConditionalHelp|exclusions|process|duration|coverage|coverageExclusions|notSet|save|saving|saved|unsavedPill|ownerOnly|errors.load|errors.save|help.aiProjection`
  - `heading.profile|heading.faq|heading.policies` only if shell h1 must differ from `nav.*`/`manageShop.faqs.title` (02 §1) — prefer reuse.
- All new keys need bn + en; numeric interpolation `{count}` with bn numerals through `Intl` (localeFor), never string-built digits.
- Report to A0 at handoff: complete key list above + retirement of `manageShop.faqs.confidence`.

## 4. Testids

Mint NEW (02 regions):
- shell: `business-faq-tab-profile|faq|policies`, `business-faq-panel-profile|faq|policies`
- profile: `profile-changes-unsaved` (mirrors `delivery-charges-unsaved`)
- faq worklist: `faq-search`, `faq-filter-<status>`, `faq-filter-category`, `faq-row-<id>`, `faq-status-chip-<id>`, `faq-sync-chip-<id>`, `faq-resync-<id>`, `faq-archive-<id>`, `faq-restore-<id>`, `faq-bulk-bar`, `faq-bulk-enable`, `faq-bulk-disable`, `faq-editor-drawer`
- policies: `policies-signal`, `policy-card-<key>`, `policy-stance-<key>`, `policies-save`, `policies-unsaved`

Preserve EXACT pins (do not rename): `business-signal`, `faq-signal`, `business-info-automation-link`, `faq-add`, `faq-delete-confirm`, `gap-suggestions`, `gap-suggestion-<id>`, `gap-open-settings`, `gap-publish`, `gap-dismiss-confirm`. Absence pins: `dashboard-primary-action`, `inbox-primary-action` = 0 everywhere; `ai-reply-mode` = 0; no `input[type=range]`; no radiogroup under business-info route; no confidence text.

## 5. E2e allowlist additions (A6 adapts the two specs)

`tests/e2e/business-info-guardrails.spec.ts` KNOWN_PATHS += `'/api/shop/business-policies'` (shell may not fetch it while Profile is active — only add what the tree actually calls; keep `state.unexpected==[]` meaningful).
`tests/e2e/faq-guardrails.spec.ts` KNOWN_PATTERNS += `/^\/api\/knowledge\/faqs\/[\w-]+\/(archive|restore|resync)$/`; KNOWN_PATHS += `'/api/shop/business-policies'` only if A6 adds policies-tab coverage there; PATCH/DELETE `faqs/:id` patterns already exist.
Both specs: route→workspace renders same URL; header assertions unchanged (02 §1); mock FAQ rows must use the rich serialization (`answers:{en,bn}`, `status`, `sync_status`, nullable `updated_at`) — fixtures fake ids only, no JWT-shaped strings (gitleaks rule); PUT business-info body pin updates to 10-key shape with `deliveryAreas/paymentMethods` exclusion retained; axe includes stay `.em-business` / `.em-faqs` + `reducedMotion:'reduce'` + settle.

## 6. Component self-test contracts (A2/A3/A4 write; mirrors proven suites)

- Mock the WHOLE api module domain (`vi.mock('@/api', …)` listing every fn the component touches incl. `getShopBusinessPolicies/updateShopBusinessPolicies/archiveKnowledgeFaq/restoreKnowledgeFaq/resyncKnowledgeFaq`; gap fns `vi.mock('@/api/domains/knowledge', …)`) — no network, no partial mocks.
- Pin payloads: profile PUT key-set equality; FAQ PATCH/POST bodies never carry shadowing `category` and never fabricate timestamps; policies PUT omits untouched policies (no `{}`).
- Server-confirmed success: assert the resolved-call ordering (notice/toast only after awaited api) and error `role=alert` from thrown normalized errors.
- Drawer: `role=dialog` + aria-modal + Escape + focus-restore to invoker; `MODE==='test'` collapses motion (`initial={false}`), so never assert on animation.
- Honest timestamps: assert `—` for NULL updated_at/created_at under both locales via localeFor.
