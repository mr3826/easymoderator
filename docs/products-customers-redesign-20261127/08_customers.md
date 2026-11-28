# Customers Workspace

## Contract

- Both feature-flag modes retain server search, channel filtering, 20-row pagination, create, edit, and permission-aware delete.
- Legacy mode uses the existing customer endpoint, profile drawer, and phone-based order lookup.
- Customer 360 mode uses server-side name-or-phone search, phone/channel filters, and the gated overview endpoint.
- Overview definitions and bounded-order coverage are returned by the server; buyers/repeat buyers show lower bounds when partial, and new buyers are unavailable until coverage is complete and delivered-order dates are known.
- Metric definitions (including the 30-day new-buyer window) are visible on mobile, not tooltip-only.
- Per-customer order summaries expose the linked-order total and coverage metadata; capped count and money aggregates are marked as lower bounds, and lifecycle context is labeled partial.
- Customer detail keeps contactability beside a phone call action and an inbox link even when there is no conversation; the inbox link preserves a customer filter. Detail also includes verified commerce, history, returned conversations, CRM notes/tags, opportunities, and advisory RTO.
- `/customers/:id` resolves to Customer 360 only when enabled; otherwise it opens the existing legacy drawer.
- No messaging send, identity merge, trust score, COD block, or bulk customer action is added.

## Verification

Legacy/pilot unit and Playwright evidence is recorded in `11_test-review-results.md`. The partial-value lower-bound display has focused regression coverage; hosted CI and PostgreSQL/Redis integration remain unverified.
