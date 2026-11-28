# AI Import

## Contract

- Accept CSV, TSV, and TXT only.
- Cancel aborts in-flight extraction; a canceled request cannot reopen the review.
- Review rows before approval; required-field validation is shared with the product editor.
- Parsed variants are included in approved product writes; legacy string arrays are accepted and remain read-only catalog metadata rather than making the row unapprovable.
- Import prices normalize Bengali digits. Category choices show the hierarchy path and preserve unmatched source text until the merchant resolves or clears it.
- Extraction confidence is labeled as parse completeness and is transient, never product provenance.
- Each row approval is single-flight and marked `__noRetry`.
- A row is removed only after server success. Bulk approval uses all-settled outcomes, reports partial failures, and keeps failed rows available for retry.
- Retrying a successful row cannot create a duplicate.

## Verification

Import and row-retry behavior passed local unit coverage; the final product Playwright suite result is recorded in `11_test-review-results.md`. Hosted CI and PostgreSQL/Redis integration remain unverified.
