# Feature Preservation Matrix

| Workflow | Preservation rule | Verification evidence |
|---|---|---|
| Create a simple product | Name and selling price are the only required fields. | `AddProduct.test.tsx`; `products-guardrails` E2E (12 tests) |
| Edit inventory | Tracked stock uses quantity and nullable low-stock threshold; untracked stock discloses that availability is not guaranteed. | `productForm.test.ts`; backend inventory/overview/stock tests in the focused suite |
| Edit product text and metadata | Untouched values are omitted; empty clearable scalars use `null`; tags, variants, and images clear with `[]`. | `productForm.test.ts`; full frontend suite (36 files, 331 tests) |
| Manage images | Uploads return URLs, any image can become primary, image ordering/removal is retained, and `image_url` follows the primary image. | `AddProduct.test.tsx`; backend media-persistence tests in the focused suite |
| Manage variations | JSON option groups are catalog metadata; relational rows remain the stock authority and are read-only. Legacy strings are preserved read-only. | Product-form and `product-evidence-variant-shapes` tests |
| Import products | CSV, TSV, and TXT review remains available; approval excludes transient provenance and reports partial failures. | `Products.test.tsx`; `products-guardrails` E2E (12 tests) |
| Manage categories | Root/subcategory hierarchy, inactive-category reactivation, active and total affected product counts (including soft-deleted associations), and safe delete warnings remain available. | Category component tests; backend `category.product-count` test |
| Manage customers with the pilot off | Legacy customer records, create/edit/delete permissions, email clearing, channel/phone filters, profile drawer, and phone order lookup remain available. | `Customers.test.tsx`; `customers-guardrails` E2E (9 tests); email-clear backend run (21 tests) |
| Manage customers with the pilot on | Filtered Customer 360, email clearing, honest overview, CRM actions, history, conversations, opportunities, and RTO advisory remain server-gated. | `Customer360.test.tsx` (25 tests); `customer-intelligence` E2E (13 tests) |
| Delete on the final page | Customer pagination returns to a valid page after the final row is deleted. | Out-of-range page clamp in `Customer360Page`; direct delete-last-row browser case remains in founder UAT |
| Recover from failures | Failed save/upload preserves input; no success state is shown until the server confirms. | `AddProduct.test.tsx`, `Products.test.tsx`, and backend media-persistence tests |

These are local verification receipts, not hosted-CI or PostgreSQL/Redis integration evidence; those release gates remain unverified.
