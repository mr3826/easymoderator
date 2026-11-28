# Product Editor

## Contract

- Create and edit share one editor state model and serializer.
- Only name and positive selling price are required.
- Create sends normalized supported fields. Edit sends only dirty fields.
- Empty optional scalars clear with `null`; empty tags, variants, and images clear with `[]`.
- Tracked stock starts at zero and the editor explains that quantity must be entered to make it available; disabling tracking discloses that saved quantity is reset to zero and orders are no longer stock-limited.
- A hidden section does not change dirty state. Untouched fields and retired controls are omitted.
- Relational variant rows remain read-only stock authority; legacy string groups remain read-only unless safely normalized.
- `image_url` is the primary image and stays synchronized with `images[0]`.
- Upload failures and save failures preserve the draft; save is blocked while uploads are pending and duplicate submits are blocked synchronously.
- Successful server responses replace the baseline; client-side optimistic field merges are not used.

## Sections

- Essentials: name, BDT selling price, hierarchical category, description, and images.
- Inventory follows the existing Product model default: new products are untracked until the merchant opts in. NOTE: this is a deliberate CHANGE for the web path — the old editor hard-started "limited" and sent `track_quantity:true` on every create (baseline `AddProduct.tsx:72/:334`); see `14_untracked-inventory-uat-decision.md` §1.1 and the explicit change-acceptance in the UAT checklist. The untracked state warns that stock will not limit orders; enabling tracking starts at zero so no on-hand quantity is invented. Disabling tracking warns that a previously saved quantity resets to zero. Tracked quantity appears only when enabled, with a nullable low-stock threshold.
- Variations: supported JSON option groups with required group names, optional SKU/price-adjustment catalog metadata behind a disclosure, and a read-only relational authority disclosure.
- Additional settings: SKU, brand, tags, weight/unit, and active state.

## Verification

Editor contract and image recovery tests passed within the frontend suite and focused backend suite recorded in `11_test-review-results.md`. PostgreSQL/Redis integration and founder UAT remain unverified.
