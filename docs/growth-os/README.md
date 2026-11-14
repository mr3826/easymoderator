# Growth OS

Growth OS is EasyModerator's internal acquisition, activation, and retention
workspace. It is a modular surface inside the monorepo, not a CRM replacement or
standalone SaaS product.

## Source Of Truth

- `EXECUTION_STATE.md` records the current phase, gates, evidence, and open
  release constraints.
- `04-prospect-foundation.md` describes the Phase 3 prospect ledger contract.
- The dated audit and architecture documents preserve historical repository
  evidence. Current code and tests take precedence when they differ.

`GROWTH_OS_GOAL.md` is tracked as a goal document, while the legacy
`CURRENT_STATE.md` is absent. `GROWTH_OS_CURRENT_STATE.md` is the tracked
current-state determination; the tracked execution state and this index remain
the durable navigation points. Dated audits are historical evidence and must
not override the current code, refs, or these two living documents.

## Access Boundary

Growth routes are mounted at `/api/internal/growth-os` behind the existing
authentication and server-side Growth role middleware. Access is authorized by
the active Growth role record and the endpoint permission, not by an MFA
assurance claim; the Growth OS MFA requirement was removed 2026-11-15. TOTP
remains a platform feature outside the Growth access decision. Prospect scope is
resolved from `req.growthOs.permissions`; client state never authorizes a row.

## Data Handling

Growth prospect records contain operational lead contact data and remain scoped
by Growth role. Prospect audit snapshots are write-time sanitized: contact
name/phone/email, page URLs, notes, source references, normalized contact keys,
metadata, and disqualification reasons are stored as `[redacted]` rather than
copied into `audit_logs`. Audit-log retention follows the platform audit owner;
the Growth policy target is 365 days for sanitized prospect mutation history,
with Security/Operations responsible for the purge/retention job when the
platform-wide retention control is enabled. No raw contact data is recovered
from the audit trail.

## Phase 3 Surface

Phase 3 provides a canonical prospect ledger, deterministic lifecycle changes,
assignment, deliberate linkage to existing users/shops, merge handling, a typed
timeline, duplicate preflight, and a dry-run-by-default historical importer.
Prospects point to EasyModerator records and never copy or mutate subscriptions,
shops, users, customers, or merchant producer paths. The one-off importer may
read legacy CRM/audit rows to reconstruct provenance, but
`growth_os_prospects` and `growth_os_prospect_events` remain the canonical
Growth source of truth; `audit_logs` is not the prospect ledger.

Frontend routes live inside `EasyMod-growth`:

- `/prospects`
- `/prospects/new`
- `/prospects/:prospectId`
- `/prospects/:prospectId/edit`

## Verification

Backend unit and security tests run through the backend Jest homes. Real
PostgreSQL/Redis integration uses `npm run test:backend:integration:docker`.
Growth frontend tests use Vitest with jsdom and Testing Library. Browser E2E,
the built Nginx smoke (`npm run test:growthos:image`), live Growth-origin
delivery, operator bootstrap, and production deployment remain separate release
gates. `npm run lint:growth` covers the Growth frontend, backend module, and
Growth image helper.

## Current Implementation

The current internal control-plane and capture contracts are documented in
[`05-internal-control-plane.md`](05-internal-control-plane.md) and
[`06-browser-extension.md`](06-browser-extension.md). They describe the
canonical two-role model, server-selected Merchant 360 masking, current
workspace/admin routes, and release versus local extension manifests; current
code remains authoritative over historical documents.
