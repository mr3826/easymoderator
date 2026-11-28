# Screenshot Evidence

Packet: `D:/easymod/prod-evidence/products-customers-redesign-20261127/09-screenshots/`
(capture.mjs, README.md, shots-manifest.md, capture-before.log, capture-after.log,
capture-after-recap.log, capture-after-recap2.log, 48 PNGs).

## Method

Mock-only Playwright/Chromium captures from local vite dev servers — the established
packet discipline (payment/header missions): ONE byte-identical fixture set per
before/after pair; the only difference in every pair is the CODE. BEFORE side =
detached worktree `_wt-pc-baseline-20261127` at `fd78afde` (= origin/main =
production at capture time), port 4297. AFTER side = this branch's working tree,
port 4298. Shell fixtures verbatim from the header-removal packet; products/
categories/customers wire shapes taken from this branch's proven e2e specs
(products-guardrails 12, customers-guardrails 9, customer-intelligence 13).
Sides run sequentially (shared .vite cache); stale-file delete guard; mtime floor;
per-DOM JWT-shaped-string scan (0 hits); external hosts hard-aborted; no unmocked
API fired. Honesty pins are asserted per shot in the run logs; a failed pin fails
the run. Captures are mock-only (route-intercepted API), honestly labeled —
real-backend pilot screens remain founder UAT territory.

## Captures (24 before + 24 after; 13 after PNGs re-shot after the i18n fixes below)

- Products list 1440/390/360 EN + 1440 BN: server-owned overview chips
  (148/121/7+/3+), bounded `N+` partial markers, coverage note, relocated filtered
  count (after) vs legacy total pill and zero chips (before).
- Products cards view 390 EN (after-only new view).
- Add Product full-page editor 1440/390 EN + 1440 BN (after) vs legacy long form
  with Business Rules/Shipping sections (before) — the headline pair.
- Product edit 1440/390 (hydrated editor, read-only relational variants) vs
  legacy modal edit (before-only `product-edit-modal-1440-en`; the after side has
  no modal — proven instead by the edit-route navigation shots).
- Product details 1440/390 both sides.
- Categories hierarchy 1440/390 (counts, inactive row + Reactivate) vs flat roots
  (before); delete-impact dialog 1440 (active 5 vs total 10 vs subcategory 1) vs
  legacy confirm lacking role=dialog and impact lines (before).
- Customers legacy 1440/390 + drawer detail 1440/390 (flag-off path preserved).
- Customer 360 1440/390 (bounded overview `1+ / 1+ / Unavailable`, partial-coverage
  disclosure, inline definitions) vs no overview region (before); opportunities
  1440; customer detail 360 1440/390 (partial-history banner, bounded commerce,
  CRM/conversations sections) vs plain counts (before).
- Bengali: products list + Add Product + chips render Bangla numerals (১৪৮, ৭+;
  coverage note now Bangla too — see P2).

## Findings the pixels produced (all fixed in-branch; before frames frozen by design)

1. P1 (branch-introduced): 15 i18n keys referenced by the redesigned Products/
   Categories components existed in NEITHER locale file (products.addProduct,
   products.import, products.sort.*, products.view.*, products.emptyResults,
   categories.detail.parentCategory/status/createSubcategoryButton) and rendered
   as raw keys — invisible to the unit lane because its react-i18next mock passes
   keys through. Fixed: keys added EN+BN;
   `src/app/components/products/__tests__/productsCustomersI18nCompleteness.test.ts`
   now resolves every statically-referenced mission key (299) against the real
   locale JSON in both locales and rejects untranslated bn values. Re-shot after
   frames assert resolved text AND zero raw-key-shaped chrome.
2. P2: Bengali coverage note interpolated ASCII digits while chips used bn-BD
   formatting. Fixed: note passes numbers through `formatNumber`
   (`Products.tsx`); re-shot 1440-bn pins zero ASCII digits + Bangla ৫০০/১,০০০.
3. P3 (pre-existing at fd78afde, fixed in passing): `products.uploadFile` bn
   value was English; now "পণ্যের ফাইল আপলোড করুন". Before frames intentionally
   keep it (frozen baseline).

Not captured (honest): upload-recovery error state (transient save-blocked-while-
POST-fails) — fault-injection would be required; contract-covered by unit/e2e,
not faked as a screenshot. Full per-shot pin table in `shots-manifest.md`.
