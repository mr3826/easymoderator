# Products, Categories, and Customers Redesign

## Scope

Implement the workspace-first redesign for product inventory, category management, and customer records while preserving existing merchant workflows. The scope includes truthful overview metrics, clearable product edits, one full-page product editor, variant read-only authority disclosure, category counts and safe deletion, and one flag-aware customer workspace with CRUD, search, filters, and customer detail.

The work is additive to the existing schema. No database migration is planned. Product stock remains governed by the existing stock-exceptions authority; delivered-order outcomes remain governed by the existing order-outcome authority; customer intelligence remains protected by its server-side feature gate.

## Explicit Non-Goals

- Relational product-variant authoring or backfill
- General at-most-once request storage/idempotency middleware beyond the product-create usage-ledger key
- Server-side product pagination
- Persisted AI provenance, unsupported product controls, or new tax/discount engines
- Category image upload, low-stock notifications, or unsupported file extraction
- Customer trust scores, COD blocking, identity merging, or bulk messaging

## Baseline and Worktree

- Planned baseline: `fd78afde` (merge PR #324), verified present in the repository.
- Implementation worktree: `_wt-products-customers-20261127`, created from `fd78afde` on `feat/products-customers-redesign-20261127`.
- The sibling source worktree was at `c9295870`; that commit is included in the planned baseline, but the sibling worktree itself is not tree-identical to the merge commit. Its untracked files were left untouched.
- The plan reports `PRODUCTION_DEPLOY_ENABLED=false`. This implementation does not change the production gate or deploy.

## Acceptance Summary

- Empty optional scalar values clear with `null`; empty list values clear with `[]`; untouched edit fields are omitted.
- Product and customer counts come from their owning backend contracts, not the visible page.
- Category deletion warnings distinguish active inventory counts from all product links removed by deletion, including inactive and soft-deleted products; inactive categories remain discoverable and reactivatable in the management view.
- Unsupported/fake fields are neither rendered nor serialized.
- Flag-off customer routes stay on the legacy customer and order-lookup path; flag-on customer intelligence stays server-gated.
- Clearing an optional customer email is explicit, while omitted edit fields remain unchanged; deletion mutations clamp pagination to a valid page.
- Release remains deferred unless implementation, CI, integration, E2E, and operational pre-deploy gates are verified in an authorized window.

## Status

Implementation is complete in the isolated worktree. Verification state as of 2026-11-28 (see `11_test-review-results.md` for every number and the two pre-push fixes — the validator import crash and the variant-availability over-suppression, both found by the full unit lane after the last session was interrupted):

- Backend full unit lane: zero mission-only regressions vs `fd78afde` on this host; focused mission battery 341/341 (two `sqlite3`-binding suite load failures are identical at baseline — Node v25.6.1 host vs required 20.x). Grounding suites re-run after the availability fix: 190/190 with zero test-file changes.
- Backend integration (real PostgreSQL/Redis, local disposable stack): full lane **47/47 suites, 363/363 tests, JEST_EXIT=0**, including both new integration suites.
- Frontend unit / typecheck / production build: green (re-verified post-fix); locale parity 3,456 keys × 2.
- Playwright: `products-guardrails` 12, `customers-guardrails` 9, `customer-intelligence` 13 — 34/34 serial.
- Before/after screenshots at 1440/390/360 in both locales: captured (`prod-evidence/products-customers-redesign-20261127/09-screenshots/`).
- Independent reviews: A1 UX, A8 merchant (CONCUR_WITH_NOTES), A9 adversarial (CONCUR_WITH_NOTES) — findings remediated; follow-ups FU-PC-01…04 registered.

Hosted CI: **green at head `dc00f363`** (required `PR Merge Gate` + `Security Scan` on Node 20/Linux, plus backend integration, frontend Playwright, Meta-shaped E2E, Docker build validation, deployment-config dry run, secret scans); PR #325 merged to main `d1d9bcc7`; **deployed to production in the founder-authorized window of 2026-11-28** with full read-back and integrity evidence (`13_deployment-rollback.md`). Still open by design: the Option-A untracked-default acceptance (founder, `12_`/`14_`) and founder UAT execution. The production gate was armed only for the two guarded window dispatches and is restored `false` (live re-read).
