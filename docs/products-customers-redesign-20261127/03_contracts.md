# Shared Contracts

## Product Writes

- Create requires `name` and positive `price`.
- Optional scalar fields (`description`, `sku`, `brand`, `category_id`, `low_stock_threshold`, `weight`, and `weight_unit`) use `null` to clear.
- List fields (`tags`, `variants`, and `images`) use `[]` to clear.
- Edit serializes only dirty fields. Hidden or unsupported controls are not part of the write type.
- The client synchronizes `image_url` with the first URL in `images`; the backend normalizes image state before media-cleanup comparison.
- Legacy JSON variant strings remain unchanged and read-only. Existing relational variant rows are the stock authority and are not authored through this editor.

## Product Overview and Stock

`GET /api/product/overview` returns tenant-scoped `total`, `active`, `inactive`, `low_stock`, `out_of_stock`, `scanned`, `cap`, and `coverage_complete` values. Stock exceptions come from the existing product-stock-exceptions authority, not list-page quantities or `in_stock`.

The Products page shows bounded counts as `N+` when coverage is incomplete. The visible-page count remains a separate filtered result count.

## Categories

`GET /api/category?include=product_count&include_inactive=true` opts into active, non-deleted direct `product_count`, total linked direct `affected_product_count` including soft-deleted rows, and `subcategory_count`, while returning inactive categories for reactivation. Counts are grouped once in the backend. The product editor uses `include_inactive=true` without requesting counts so an existing inactive association remains selectable; calls without either query option preserve the prior active-only category shape. Root-delete warnings sum direct impact across descendants.

The category management view uses the inactive-category opt-in to reactivate categories. The delete warning distinguishes active inventory from all product associations (including inactive and soft-deleted products) that deletion will clear; root-category deletion includes descendants.

## Customer Intelligence

- `GET /api/customer-intelligence/overview` is behind `requireCustomerIntelligence` and returns tenant aggregates, bounded order-scan coverage, and definitions for buyer/opportunity metrics. Buyers have at least one delivered order; repeat buyers have at least two. New buyers means first delivered order in the last 30 days and is unavailable when order coverage is incomplete or any delivered timestamp is missing.
- Customer 360 list filters accept `phone` and `channel_type`; server search remains name OR normalized Bangladesh mobile phone, while explicit filters combine with AND.
- Channel validation derives allowed values from the Customer model enum.
- Per-customer order summaries return exact linked-order totals plus scanned/cap/completeness metadata from a grouped query. Bounded delivered/return counts are visibly marked as lower bounds when partial; detail screens disclose partial history.
- Flag-off flows continue to use the legacy customer endpoints and drawer. No feature flag is enabled by this work.

## Retry Safety

Automatic transient retries are allowed only for `GET`, `HEAD`, or requests explicitly marked `__idempotent`. `__noRetry` overrides that opt-in and is applied to create, update, and upload calls. Product creates additionally accept a stable `Idempotency-Key`, persisted through the existing usage ledger in the same transaction as product creation; repeated keys return the existing product. This is product-create protection, not general idempotency middleware for other routes.

**Known caveat (A9 P2-1, ticket FU-PC-02):** when no explicit key is supplied, the backend falls back to `req.requestId`, which is the verbatim client `x-request-id` header. A first-party API client that reuses one `x-request-id` across different product-create POSTs within its own shop gets the second create replayed as the first. Impact is tenant-scoped and self-inflicted (the web and mobile clients never send the header); it is documented here as the de-facto contract. Follow-up FU-PC-02: remove `req.requestId` from the fallback chain (explicit `Idempotency-Key` header or server-generated UUID only).

## Security and Data Scope

All new backend reads remain authenticated and shop-scoped. Customer overview remains feature-gated. No schema migration, identity merge, customer trust score, COD block, or production-gate change is included.

Contract response names and test evidence are finalized after backend/frontend integration tests complete.
