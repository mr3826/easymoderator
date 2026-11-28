# Products Workspace

## Contract

- Product overview cards use the tenant-scoped product overview endpoint, not visible-page counts.
- Incomplete stock coverage is shown as a lower bound with an explicit coverage note.
- Search, category ID, status, stock, sort, and view controls remain separate from overview metrics.
- Product rows use the shared effective-stock mirror so displayed stock agrees with the server exception predicate.
- The selected category is identified by canonical ID; duplicate category names do not collide.
- The current filtered total is labeled as filtered, and pagination remains 10 rows per page.
- Product creation navigates to the full-page editor. Import remains a separate secondary action.
- AI source/provenance is not a product-list field. The AI review retains only transient extraction status.

## Verification

Local unit, TypeScript, production-build, and product E2E evidence is recorded in `11_test-review-results.md`. PostgreSQL/Redis integration and screenshot evidence remain unverified.
