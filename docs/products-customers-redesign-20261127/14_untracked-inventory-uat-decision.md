# 14 — Default Product-Inventory Semantics: Founder UAT Decision

Mission: Products & Customers redesign (base `fd78afde` = production).
Purpose: state precisely what the new web-path default ("new products are
untracked") means on every surface, with current-code evidence — §1.1 records
that this is a CHANGE from the old tracked web-editor behavior, not a
preservation — so the founder can make the UAT call on
`12_founder-uat-checklist.md:9` (explicit change-acceptance) from facts, not
assumptions.

Every claim below is tagged **[proven]** (read from current working-tree code,
from a named passing test, or from the read-only demo in §5) or **[inferred]**
(reasoned from code without executing it). Line numbers are from this worktree.

---

## 1. Current default (preserved)

**A product created through the new web editor or defaulted by the product API
is untracked: `track_quantity = false`, `quantity = 0`, `in_stock = true`. For
untracked rows, `quantity` is NOT authoritative — every downstream surface
treats it as "no count exists". Availability is carried solely by the `in_stock`
boolean, which defaults to "available" and is only flipped by an explicit
merchant action.** [proven]

Two precision corrections from the A8/A9 concurrence reviews (2026-11-27):

1. **This is a behavior CHANGE for the web path, not a preserved default.**
   The model/migration/validator default has always been untracked (below), but
   the OLD web editor overrode it on every create: baseline `AddProduct.tsx:72`
   starts `stockType = "limited"` and `:334` sends `track_quantity: true` (with
   `quantity: 0`), so web-created products at `fd78afde` were TRACKED. The new
   editor sends the checkbox state with the draft starting `false`
   (`productForm.ts:105`), so web creates now inherit the untracked default —
   a merchant-favorable change (it stops web products reading OUT_OF_STOCK to
   the bot/order gate), but UAT line 9 must be an EXPLICIT change-acceptance,
   not acceptance-by-inaction. [proven from baseline source]
2. **"quantity forced to 0" is editor/API-flag-conditional, not a global
   invariant.** The service zeros quantity only when `track_quantity:false` is
   explicitly present in the payload (`product.service.js:224-227` create,
   `:356-359` update); the new editor always sends it (`productForm.ts:186-187`).
   A raw API create omitting `track_quantity` with `quantity:50` persists 50 on
   an untracked row — inert to every reader, same class as §4.4 (mobile
   quick-update). "Forced to 0" therefore describes the web/editor path and the
   pinned API tests, not a DB constraint. [proven; A9 P2-2]

Creation chain:

- Model defaults — `EasyMod-backend/src/modules/product/product.entity.js`:
  - `quantity` default `0` (:51-54)
  - `low_stock_threshold` default `5` (:55-58)
  - `track_quantity` default `false` (:59-62)
  - `send_low_stock_alert` default `false` (:111-114)
  - `in_stock` default `true` (:115-118)
  - `variants` legacy JSON blob default `[]` (:90-94)
- Database defaults — migrations:
  - `src/database/migrations/20260520_000_initial_schema.js:213` — products
    table `track_quantity BOOLEAN NOT NULL DEFAULT FALSE` (and legacy `stock
    INTEGER DEFAULT 0`, :212)
  - `src/database/migrations/20260522_002_fix_products_schema.js:60` — adds
    `quantity INTEGER NOT NULL DEFAULT 0`; :73 adds
    `in_stock BOOLEAN NOT NULL DEFAULT TRUE`
- API validation — `src/modules/product/product.validator.js`:
  - `track_quantity: Joi.boolean().optional()` with **no `.default()`** on
    create (:28, re-declared identically at :67 — duplicate object key, later
    wins, no behavioral effect) and update (:97, :136)
  - `quantity` optional, min 0, no default (:29-31)
  - `product_variants: Joi.forbidden()` on both create and update (:56, :125) —
    relational variant rows are read-only through this API [proven; pinned by
    `__tests__/product.validator.clear-fields.test.js:36` "rejects client
    patches to authoritative relational variant rows" and
    `product.service.js:209-211` `PRODUCT_VARIANTS_READ_ONLY`]
- Service hard rule — `src/modules/product/product.service.js`:
  - create: `if (productData.track_quantity === false) productData.quantity = 0`
    (:224-227) — "if not tracking, clear quantity"
  - update: same clear, but ONLY when `track_quantity:false` is explicitly
    present in the update payload (:356-359)
  - pinned by API tests: `__tests__/product.test.js:368` "sets quantity to 0
    when track_quantity is false" (POST sends `quantity: 50`, must land 0) and
    `:464` "sets quantity to 0 when track_quantity is false on update"
    (PATCH `track_quantity:false, quantity:99`), plus
    `__tests__/product-inventory.test.js:141` "createProduct — sets quantity
    to 0 when track_quantity is false"
- Web editor makes the same choice visible: new-product draft starts
  `track_quantity: false` (`EasyMod-frontend/src/app/components/products/productForm.ts:105`),
  the create payload always sends the checkbox state and forces `quantity: 0`
  when untracked (:186-187), the "Available Quantity" input is disabled unless
  tracking is on (`Products.tsx:1298`), and the list shows **"Not tracked"** in
  the quantity column (`Products.tsx:687`; `i18n/locales/en.json:4219`,
  `bn.json:4219` "ট্র্যাক করা হয় না"). [proven]

One channel already deviates: the **mobile photo-draft create sets
`track_quantity: true`** (`src/modules/mobile/mobile-product.controller.js:273`)
and derives `in_stock: parsedQuantity > 0` (:274). [proven]

---

## 2. Demonstrated consequences (untracked default, as shipped here)

### 2.1 Chatbot / AI grounding

For a `track_quantity = false` row the bot **asserts IN_STOCK** (not "out of
stock", not an omission) whenever `in_stock` is true — which it is by default —
and **never states a numeric quantity**. [proven]

- Fact builder — `src/modules/ai/grounding/product-evidence.service.js`
  (modified on this branch):
  - `const tracked = product.track_quantity === true` (:351) — strict.
  - Stock verdict (:353-361): inactive → `DISCONTINUED`; untracked →
    `in_stock === false ? OUT_OF_STOCK : in_stock === true ? IN_STOCK : null`;
    tracked → from `computeEffectiveQuantity` (`IN_STOCK` iff > 0).
  - Rationale comment (:366-369): "quantity decides stock ONLY where the
    merchant counts stock… reading that [quantity 0, untracked] as 'sold out'
    told real customers every in-stock product was unavailable."
  - `quantity` fact is `UNKNOWN` unless tracked and finite (:374-376) — so the
    model can never quote a unit count for an untracked product.
  - **Relational `product_variants` rows** are the only variant shape with
    authority (`relationalVariantsOf`, :140-154); legacy JSON `variants`
    strings/option-groups are descriptive metadata only. But variant
    `availability` is `UNKNOWN` for untracked parents regardless of the
    variant's own quantity (:401-405) — variant numbers stay inert until the
    parent tracks stock.
- Prompt + gate: KNOWN/UNKNOWN/UNCERTAIN are each rendered explicitly
  (`grounding-prompt.js:119-138`; :128 prints "UNKNOWN — not recorded"), with
  the rule "Do not state a price, stock level, size…" (:145). The outbound gate
  flags an availability claim whose product's `stock` fact is not KNOWN
  (`outbound-grounding.gate.js:1056-1083`, esp. :1078). Net effect: legacy rows
  with `in_stock` NULL/undefined (possible; the column was added later) produce
  a stock `UNKNOWN` fact → the bot makes **no** stock claim; every web-created
  product (default `in_stock: true`) produces a **positive IN_STOCK claim**.
  [proven]
- Governing tests:
  - `src/modules/ai/grounding/__tests__/product-evidence-variant-shapes.test.js`
  (new on this branch) — "does not turn legacy strings or editor option groups
  into live variant facts" (:17), "uses relational variant quantities when
  parent stock disagrees" (:35, tracked case), "does not report parent
  quantity as available when active relational variants are empty" (:65,
  tracked case). NOTE: the new file does not contain an explicit case for
  untracked-parent-with-variant-quantity; §5 demo (case D) pins that the code
  yields `availability: UNKNOWN` there. [proven via demo]
  - `src/modules/product/__tests__/product-search.variant-stock.test.js:116`
  "non-tracked product honours the existing in_stock semantics, not the variant
  number"; `:122` "product-level out-of-stock (in_stock=false) blocks even a
  healthy variant".
  - `src/modules/conversation/__tests__/conversation.product-card.stock-policy.test.js`
  — case 5 (:434) "tracking disabled follows in_stock/is_active: available
  label only when the flag allows it" (subtitle `৳2500 · Available`, :441),
  case 2 (:410) explicit `in_stock:false` untracked never claims Available,
  guard-predicate block (:562-594) pins
  `quantity: null, in_stock: true` for untracked.
- Merchant inbox product card (same predicate):
  `src/modules/conversation/conversation.controller.js:1602-1625` — 409
  `OUT_OF_STOCK` if the guard says not-in-stock; the card subtitle is
  **`Available` for untracked** (quantity null) vs `In stock (N)` for tracked
  (:1622-1624). The shared predicate lives in
  `src/modules/product/stock-status-guard.service.js:58-61`
  (`quantity: track ? qty : null`; `in_stock: in_stock !== false && (track ? qty > 0 : true)`);
  `formatStockLabel` (:127-132) encodes "untracked → 'আছে ✅' (assume
  available)" — note: in the current tree `formatStockLabel`/`enrichWithStock`
  have no non-test consumers (grep), so the live customer-visible wording comes
  via the card path and the model rendering the fact table. [proven]

Consequence in one sentence: **an untracked product tells the customer "in
stock" forever, with no count, until the merchant flips `in_stock` off — and
the web editor offers no `in_stock` control** (absent from
`productForm.ts` payload keys; written today by the mobile quick-update,
`mobile-product.controller.js:197-207`). [proven for web editor; API writes it
because `updateProduct` Joi is `.unknown(true)` and only server-owned fields
are stripped — `product.service.js:31,334-335 — **inferred** that a raw PATCH
with `in_stock` succeeds, not covered by a named test]

### 2.2 Order eligibility

**Out-of-stock denial at order creation keys off the PARENT row: untracked
products are never denied for stock; `in_stock=false` denies storefront
customers only.** [proven]

- `src/modules/order/order.service.js` `validateItemsAndCalculateTotals`
  (:184-288):
  - `requireActiveProducts` (storefront-only flag, :188, wired :653-656):
    `product.is_active === false || product.in_stock === false` → 409
    `PRODUCT_UNAVAILABLE` (:238-240). For merchant/AI orders this check is OFF.
  - `requiresStockCheck = product.track_quantity && (!allowBackorder ||
    !product.allow_backorder)` (:258) → 409 `INSUFFICIENT_STOCK` (:260-266).
    **`track_quantity === false` ⇒ no stock check at all; `quantity` (0) is
    never consulted.** Variant quantities gate only under the same
    `product.track_quantity` (:256 picks `variant || product`, then :258).
  - `allow_backorder` is a dead escape hatch: it appears in the validator
    (`product.validator.js:32,101`), `ORDER_BUSINESS_LOGIC.md:161`, and mock
    fixtures, but **there is no `allow_backorder` column in
    `product.entity.js` and none in any migration** (grep of `src/database`
    returns nothing) → real rows read `undefined` → `!undefined` makes the
    check apply to every tracked product even on manual/AI orders. [proven
    absence of column; **inferred** runtime consequence]
  - Stock mutation is tracked-only everywhere: decrement at creation
    (:330-338), restore at cancel (:440, :449) and via returns; pinned by
    `src/modules/order/__tests__/order-cancel-inventory.test.js:196` "does NOT
    restore stock for non-tracked items" and `:354` (returns equivalent).
    Delivered orders do not change stock state at all — inventory effects (for
    tracked rows) happen at creation and cancel/return, never on delivery
    transition. [proven by reading the order lifecycle; no delivery hook found
    touching quantity]
- Chatbot order sessions use the same semantics through
  `src/modules/product/product-search.service.js` `checkStock` (:265-304):
  :268 inactive fail, :269 `!in_stock` → "Product is out of stock",
  variant quantity checked **only if** `product.track_quantity` (:284-296;
  comment :295 "Not tracked at product level: product.in_stock already gated
  above"), product quantity checked only if tracked (:300-303). Row
  normalization defaults: `track_quantity: row.track_quantity === true`,
  `in_stock: row.in_stock !== false` (:343-348). The confirm-step
  revalidation consults it at
  `src/modules/order/order-session-standalone.service.js:1143-1151`, and the
  "stock changed → fresh customer confirmation" rule applies only to tracked
  items (:1165-1171; test
  `__tests__/order-session-standalone.steps.test.js:568` "requires a fresh
  customer confirmation when tracked stock changes but remains available").
  [proven]
- Authority split (per `docs/products-customers-redesign-20261127/03_contracts.md`):
  the **stock-exceptions authority** (`:14`: "Stock exceptions come from the
  existing product-stock-exceptions authority, not list-page quantities or
  `in_stock`") governs *displayed* out-of-stock/low-stock truth; the
  **order-creation predicates above** govern *actual denial*; and the
  **delivered-order outcome authority** (`:26`, buyers/repeat-buyers from
  delivered orders in customer intelligence) governs *results* reporting. These
  are three separate code paths. For untracked products the first excludes them
  entirely, the second only honors `in_stock`, and the third is indifferent to
  stock — so no delivered/returned order ever revises an untracked product's
  stock facts. [proven]

Consequence in one sentence: **stock-outs of untracked products are invisible to
the order gate — a customer can order 50 units of an untracked product that is
physically gone, and the platform will never notice, because nothing is
counted and nothing is decremented.** [proven from :258/:330/:440]

### 2.3 Merchant-visible surfaces

- `GET /api/product/overview` (`src/modules/product/product.routes.js:34`,
  `product.controller.js:91-99`) delegates `out_of_stock`/`low_stock` to
  `src/modules/product/product-overview.service.js:13-29`, which calls
  `getStockExceptions` — **scoped `is_active: true, track_quantity: true`**
  (`src/modules/product/product-stock-exceptions.service.js:78-82`; variant sum
  over ACTIVE variant rows is the effective quantity :29-44; unparseable stock
  fails toward a visible exception :46-55). **Untracked products are excluded
  from the out-of-stock and low-stock counts by construction, never counted
  even when `in_stock=false`.** [proven; governing tests:
  `product-stock-exceptions.service.test.js:82` "scopes tenant FIRST + active +
  tracked…", `:65` disjoint out/low, `:75` unparseable→visible exception;
  `product-overview.service.test.js:26` "counts tenant products and preserves
  stock-exception scan authority"; route order pinned by
  `product.routes.stock-exceptions.test.js:77,99,109` — including "propagates
  handler 5xx — the client maps failure to null, never to zero counts"]
- Products page tiles + filters mirror the server token-for-token:
  `EasyMod-frontend/src/app/components/Products.tsx:60-93`
  (`isOutOfStockProduct`/`isLowStockProduct` return `false` unless
  `track_quantity === true`, :75/:83); pinned by `Products.test.tsx:242`
  `isStockExceptionProduct({ track_quantity: false, quantity: 0 }) === false`
  and `:228` "keeps stock filters URL-seeded and uses active-variant effective
  quantities". Bounded coverage shows as `N+` with the note "Stock checked for
  {scanned} of {cap} products…" (`Products.tsx:733,738-742`;
  `en.json` `products.overview.incompleteCoverage`). Empty-state copy says
  "**No tracked product** is at or below its configured low-stock threshold"
  (`en.json:4218`). [proven]
- The list discloses the default honestly: quantity column renders **"Not
  tracked"** for untracked rows (`Products.tsx:686-690`); the editor checkbox is
  "Track quantity" (`en.json:4158`, `bn.json:4158` "পরিমাণ ট্র্যাক করুন") and the
  quantity field is disabled while untracked (`Products.tsx:1298`).
  The Products nav badge and Business Health seed reuse the same stock-exceptions
  endpoint (`Products.tsx:43-45` parity comment; deep link `?stock=exceptions`). [proven]
- Mobile app diverges (see §4 surprise): `computeStockStatus`
  (`src/modules/mobile/mobile-product.controller.js:34-43`) and the mobile list
  filters (:92-109) judge `out_of_stock`/`low_stock` from `quantity`/`in_stock`
  **without consulting `track_quantity`** — and `PRODUCT_STOCK_UPDATED`
  (`:215-234`) is the audit vocabulary the web stock-audit deliberately mirrors
  (`product.service.js:398-426`;
  `__tests__/product.service.stock-audit.test.js:107` "quantity change writes
  PRODUCT_STOCK_UPDATED with previous/next metadata, required:false"). The
  mobile RN screens render those labels ("স্টক শেষ"/"কম স্টক"/"স্টকে আছে",
  `EasyMod-mobile/src/components/products/ProductListScreen.tsx:40-42`, schema
  `src/api/mobile/schemas.ts:315-318`). [proven]
- Dashboard "needs attention" Tier-5 low-stock signal is explicitly tracked-only
  — `src/modules/mobile/attention.service.js:351-362`, comment: "untracked
  products default `quantity: 0`, which would otherwise always look 'low
  stock'". [proven]

---

## 3. Decision options for founder UAT

### Option A — Keep untracked-by-default (what this redesign establishes for the web path; §1.1: a CHANGE from old tracked web creates)

Nothing to change. Accepted posture:

- Most BD merchants add products without a count; the bot says "in stock"
  rather than falsely "out of stock" (the rationale written into
  `product-evidence.service.js:366-369`).
- Availability control for untracked rows is the `in_stock` flag (mobile
  quick-update or API), not a number.
- All exception reporting (tiles, badge, filters, attention) is honest only for
  tracked rows; untracked rows are invisible to it by design.
- Residual risks the founder accepts: (1) bot over-promises availability for
  genuinely sold-out untracked products until someone marks `in_stock=false`;
  (2) orders for untracked products are never denied or decremented; (3) the
  mobile app shows those same products as "স্টক শেষ" (§4).
- **A8 concurrence condition:** risk (3) GROWS with this change — old web
  products were tracked so the mobile label was coincidentally correct; post-
  deploy every NEW web product is untracked and mobile labels all of them out
  of stock (while web says "Not tracked" and the bot says IN_STOCK). Shipping
  A as-is is merchant-acceptable only with (a) the founder's explicit Option-A
  acceptance at UAT AND (b) the Option-C predicate fix tracked as a real ticket
  (registered below as FU-PC-01 and appended to the pilot tracker).

### Option B — Tracked-by-default for new products

The flip is small but it is NOT one line; exactly these defaults change:

1. `src/modules/product/product.entity.js:61` — `defaultValue: false` → `true`
   (affects ORM inserts that omit the column).
2. A NEW migration setting the column default (`…_000:213` is historical;
   `ALTER TABLE products ALTER COLUMN track_quantity SET DEFAULT TRUE;`) — and,
   if legacy rows should also become tracked, an explicit `UPDATE` backfill;
   a default change alone leaves every existing row `false`. [proven: NOT NULL
   DEFAULT only affects new inserts]
3. `EasyMod-frontend/src/app/components/products/productForm.ts:105` —
   `product?.track_quantity === true` → default `true` for new drafts, or the
   web editor keeps sending `track_quantity:false` explicitly (:186) and the
   server-side flip changes nothing for web-created products.
4. Optional but likely desired: `product.validator.js` has no quantity
   requirement when `track_quantity` is true (:28-31) — decide whether creation
   must require a quantity.

Immediate consequences of Option B, given `quantity` defaults to 0
(`product.entity.js:51-54`, still forced to 0 whenever the payload says
`track_quantity:false`, `product.service.js:224-227`):

- **Every brand-new product starts tracked with effective stock 0** → the bot
  reports `OUT_OF_STOCK` (stock verdict, `product-evidence.service.js:359-361`;
  demo case E), the merchant product card is blocked with 409
  `OUT_OF_STOCK` (`conversation.controller.js:1611-1615`), `checkStock` fails
  the AI order session (`product-search.service.js:300-303`), storefront
  orders 409 `INSUFFICIENT_STOCK` (`order.service.js:258-266`), and the
  product immediately inflates the out-of-stock tile/badge
  (`product-stock-exceptions.service.js:78-82,46-49`). It is honest but
  pessimistic until the merchant types a count — the mirror image of today's
  optimistic default.
- Ordering authority shifts to variant sums automatically: tracked parents get
  variant-quantity checks at checkout (`order.service.js:256-265`) and
  variant `IN_STOCK`/`OUT_OF_STOCK` facts in the chatbot
  (`product-evidence.service.js:401-405`, demo case F) — which is where
  03_contracts.md:10 "relational variants are the stock authority" becomes
  fully live.
- Mobile `stock_status` (§4) becomes consistent, because tracked + 0 is out of
  stock on both vocabularies.
- Stock audit already covers the flip path: toggling `track_quantity` writes
  `PRODUCT_STOCK_UPDATED` (`product.service.js:405-426`, pinned by
  `product.service.stock-audit.test.js:107,133`).

Blast radius (files reading `track_quantity`; 58 files repo-wide, the live
decision points are): `product-evidence.service.js`,
`stock-status-guard.service.js`, `product-search.service.js`,
`order.service.js`, `order-session-standalone.service.js`,
`product-stock-exceptions.service.js`, `product-overview.service.js`,
`conversation.controller.js`, `mobile-product.controller.js`,
`attention.service.js`, `dashboard-commerce-signals.service.js`, frontend
`Products.tsx`/`productForm.ts`, mobile RN `ProductListScreen.tsx`/`schemas.ts`.
No chatbot/order/mobile code change is needed for Option B — every one of these
branches on the stored boolean; only the three default lines above change.
Legacy pilot data note: existing seeded review products are ALREADY tracked
(`src/scripts/seed-meta-review-merchant.js:623`), and production has never run
an order, so a backfill decision is currently cheap. [proven]

### Option C (variant of A) — Keep untracked but close the disclosure gap

If the founder keeps A, the one demonstrable inconsistency worth a follow-up
ticket (not part of this redesign's scope): mobile `computeStockStatus`
labeling every untracked default product "out of stock". Aligning it with the
`track_quantity ? qty>0 : in_stock!==false` predicate (guard, :58-61) would make
all four surfaces agree under A. [proven divergence; fix is a proposal, not
current behavior]

**FU-PC-01 (registered 2026-11-27, A8 P2-2 condition of concurrence):** fix
mobile `computeStockStatus` in
`EasyMod-backend/src/modules/mobile/mobile-product.controller.js:34-43` to the
tracking-aware predicate above, plus its `stock_status` filter (:104-108).
Tracked in `EASYMODERATOR_PILOT_LAUNCH_ASSESSMENT_TRACKER.md` follow-ups and
the release evidence row for this mission; required BEFORE the pilot merchant
uses the mobile app as their primary product view.

**FU-PC-02 (registered 2026-11-28, A9 P2-1):** product-create idempotency key
falls back to `req.requestId` (the verbatim client `x-request-id` header) when
no `Idempotency-Key` is supplied, so a tenant reusing one `x-request-id` across
different creates gets silently replayed results (tenant-scoped, self-inflicted;
neither first-party client sends the header — verified in
`EasyMod-frontend/src/shared/lib/http/client.ts` and `EasyMod-mobile/src`). Fix:
drop `req.requestId` from the fallback chain (explicit `Idempotency-Key` or
server-generated UUID only). Documented in `03_contracts.md` until then.

**FU-PC-03 (registered 2026-11-28, A9 P2-2):** untracked rows are zeroed at
write time only when `track_quantity:false` is explicitly sent; a raw API
create without the flag persists a non-zero (inert) quantity. Readers treat
untracked quantity as inert everywhere (order gate, stock scan, evidence
facts), and doc 14 §4.4 discloses the explicit-only rule. Optional hardening:
normalize `track_quantity !== true ⇒ quantity = 0` in the service layer.

**FU-PC-04 (registered 2026-11-28, from the availability re-audit):** reconcile
the pre-existing chatbot↔cart divergence for an **untracked product whose
variant is explicitly set to quantity 0** — the grounding layer treats that
variant as OUT_OF_STOCK (shop's explicit signal, per
`product-evidence-hardening.test.js:772,791`) while `checkStock`
(`product-search.service.js:284-296`) still sells it because it ignores variant
numbers for untracked parents. Decide the single authority: either make
`checkStock` honor an explicit variant 0 for untracked products, or downgrade
the grounding claim. The chatbot currently fails safe (never claims
availability it cannot prove). Founder/merchant-facing decision; pre-dates this
mission, not a regression.

---

## 4. Surprise found while establishing evidence

1. **Cross-surface contradiction is already live:** a default web product
   (`track_quantity:false`, forced `quantity:0`, `in_stock:true`) reads
   "Not tracked" on the web Products page, is claimed IN_STOCK by the chatbot,
   is excluded from out-of-stock counts — and simultaneously renders as
   **out_of_stock ("স্টক শেষ")** in the mobile app list, because
   `computeStockStatus` (`mobile-product.controller.js:35`) treats `quantity ≤
   0` as out regardless of tracking, and the mobile `stock_status=in_stock`
   filter (`quantity > 5`, :104-108) excludes every untracked product. [proven
   by code reading; behavior derived by inspection, not executed against a
   device]
2. **`allow_backorder` is a phantom:** accepted by the validator and documented
   in `ORDER_BUSINESS_LOGIC.md:161`, but the column exists in no entity or
   migration → the "backorder allowed" branch of `order.service.js:258` can
   never read true on real rows. Tracked ⇒ hard-gated, always. [proven absence;
   inferred effect]
3. **Variant availability uses the per-variant quantity on BOTH tracked and
   untracked parents** (this is the baseline grounding contract, pinned by
   `product-evidence-hardening.test.js:772,791` and the
   `product-presentation.contract` sold-out-parent case). An intermediate
   session edit suppressed untracked-variant availability to `UNKNOWN`, which
   broke **6 baseline tests** and dropped size/price listing for every
   untracked product; that edit was reverted to the baseline rule (option
   `IN_STOCK` only when the parent stock fact is `IN_STOCK` AND this variant's
   finite count > 0; non-finite → no claim; else `OUT_OF_STOCK`).
   **Residual pre-existing divergence (NOT introduced by this mission, left as
   baseline):** `checkStock` ignores variant numbers for untracked parents
   (`product-search.service.js:284-296` returns available once parent
   `in_stock` passes), so an untracked product's variant the shop set to 0
   reads OUT_OF_STOCK in the chatbot but is still orderable in the cart.
   Reconciling this needs a merchant-facing authority decision (is an explicit
   variant 0 on an untracked product a stock signal or not?) and is
   **registered as FU-PC-04**; the chatbot conservatively refuses the
   "available" claim (no fabricated availability), which is the safe direction.
   `product-evidence-variant-shapes.test.js` covers the tracked + legacy-shape
   rejection cases; the untracked + variant-quantity case is covered by the two
   hardening tests above. [proven by code + green tests]
4. **Mobile quick-update writes `quantity` on untracked rows**
   (`mobile-product.controller.js:201-211`) bypassing the web service's
   untracked-clear rule (which only fires when `track_quantity:false` is
   explicitly sent, `product.service.js:357`) — so the "untracked ⇒ quantity 0"
   invariant is web-enforced only. A later web edit with tracking off re-zeroes
   it; with tracking off but the field untouched (dirty-field serialization,
   03_contracts.md:8), the mobile number silently survives while all surfaces
   ignore it. [proven mechanism; end-state inferred]

---

## 5. Read-only demonstration (re-run 2026-11-28 after the availability fix; first run 2026-11-27)

`node -e` driving the real `buildFacts` (pure; no DB) — exact output:

```
A) default web create (track_quantity:false, quantity:0, in_stock:true):
  stock    = {"state":"KNOWN","value":"IN_STOCK"}
  quantity = {"state":"UNKNOWN","value":null}
  variants = []
B) untracked but merchant marked out (in_stock:false):
  stock    = {"state":"KNOWN","value":"OUT_OF_STOCK"}
C) legacy row with in_stock null:
  stock    = {"state":"UNKNOWN","value":null}
D) untracked with ACTIVE variant qty=4:
  stock    = {"state":"KNOWN","value":"IN_STOCK"}
  variants = [{"state":"KNOWN","value":"IN_STOCK"}]
D2) untracked with ACTIVE variant qty=0 (shop's explicit signal; FU-PC-04 boundary):
  variants = [{"state":"KNOWN","value":"OUT_OF_STOCK"}]
E) tracked-by-default hypothetical (track_quantity:true, quantity:0):
  stock    = {"state":"KNOWN","value":"OUT_OF_STOCK"}
  quantity = {"state":"KNOWN","value":0}
F) tracked with variant sums (variant qty 3):
  stock    = {"state":"KNOWN","value":"IN_STOCK"}
  quantity = {"state":"KNOWN","value":3}
  variants = [{"state":"KNOWN","value":"IN_STOCK"}]
```

(B/C/F variant arrays abbreviated; quantity facts for B/C are UNKNOWN.)
**D/D2 changed on 2026-11-28:** the intermediate session edit returned
`UNKNOWN` for untracked variants (breaking 7 baseline tests); the reverted
baseline rule uses the variant's own quantity — D is IN, D2 is OUT (pinned by
`product-evidence-hardening.test.js:772,791`; D2's cart-side divergence =
FU-PC-04). A–D are the current default's reality; E–F are what the flipped
default does. Full jest suites were deliberately NOT re-run for this demo
(the grounding suites were re-run standalone: 190/190).

---

## 6. How UAT can verify on the pilot

1. **Create-and-ask (default semantics):** Products → Add → name + price only,
   leave "Track quantity" unchecked → save. Confirm the list quantity column
   says "Not tracked", the Out-of-stock tile does NOT change, and the row's
   stored quantity is 0. Then in a Meta conversation (or Inbox AI preview) ask
   "oi <name> ta ache?" → the reply must state availability positively with no
   unit count, and sending the product card from the Inbox must show
   "৳<price> · Available".
2. **Order-through (no stock gate):** place a chat/storefront order of, say, 5
   units of that untracked product → it must succeed; cancel it → quantity
   still 0 (nothing was ever deducted). This demonstrates Option A's core
   accepted risk: over-selling is structurally invisible.
3. **Flip to tracked (demonstrates the other default):** edit the same product,
   tick "Track quantity", save with no number → the row should now appear in the
   Out-of-stock tile/filter, the bot must switch to an out-of-stock answer, and
   the product-card send must be refused (409). Enter quantity 3 → counts and
   bot facts update; if the product has relational variant rows, confirm the
   variant sum (not the parent number) is what the tile and the bot report.
4. **Cross-surface check (surprise #1):** with the product still untracked,
   open the mobile app Products list and the "স্টকে আছে" filter → confirm the
   contradiction (§4.1) before/after choosing A vs B; on mobile quick-update
   set stock to 0 → confirm `in_stock=false` now blocks the card and the
   storefront order even while untracked.

Pilot note: existing seeded review products are tracked
(`seed-meta-review-merchant.js:623`), so test 1 must use a fresh web-created
product; production has run 0 orders, so none of this has realized customer
exposure to date.

---

*Prepared read-only from the working tree at base `fd78afde`; no source,
migration, or runtime state was modified. New file: this document only.*
