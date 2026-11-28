# Categories Workspace

## Contract

- Display roots and subcategories as one searchable hierarchy with canonical IDs.
- Product and child counts come from `GET /api/category?include=product_count`; the management query can also include inactive rows for reactivation.
- The product editor's category request does not opt into counts.
- Create/edit/delete expose only persisted name, parent, description, and active-state controls.
- Blob-URL image selection and nested edits without persistence are removed.
- Before deletion, show all product associations (active, inactive, and soft-deleted) and child count that will be affected; deleting a root includes descendants.

## Verification

Category component and backend count tests passed within the local suites recorded in `11_test-review-results.md`. Hosted CI, PostgreSQL/Redis integration, and screenshot evidence remain unverified.
