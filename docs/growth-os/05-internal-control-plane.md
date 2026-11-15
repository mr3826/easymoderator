# Internal Control Plane

This is the operational snapshot of the current Growth OS internal control-plane
implementation. Current executable code is authoritative over older Growth OS
plans and audit documents. Primary sources are
`EasyMod-backend/src/modules/growth-os/growth-os.permissions.js`,
`growth-os.routes.js`, the workspace/admin services, and `EasyMod-growth/src/App.tsx`.

## Boundary

Growth OS is one internal application: the `EasyMod-growth` React SPA backed by
the Growth OS router. It has two strongly isolated, server-authorized logical
domains:

| Logical domain | Current SPA surface | Server boundary |
| --- | --- | --- |
| Growth Workspace | Home, My Work, Prospects, Pipeline, Follow-ups, Sources, Analytics, Search, lead capture, and role-shaped Merchant Insights | Growth Workspace permissions and prospect scope on `req.growthOs` |
| Admin Control Plane | Growth Users, Access Control, platform Operations, Audit, and the full Merchant 360 view | `growth_os.admin.*` permissions; full merchant data is selected only for a raw `SUPER_ADMIN` |

These are logical domains in one application, not two independently deployed
frontends in the current repository. React route guards only hide or redirect
the UI; the server is the authorization authority. The Merchant App remains a
separate application and merchant membership is not an internal Growth OS role.

The shared `/merchants` and `/merchants/:shopId` routes are deliberately
role-shaped by the server. A canonical `SUPER_ADMIN` receives the Admin Control
Plane shape; a canonical `GROWTH_USER` receives the masked, read-only insight
shape. A legacy display alias does not select the full shape.

## Roles And Permissions

The canonical grantable role set is exactly:

| Role | Effective capability |
| --- | --- |
| `SUPER_ADMIN` | Full Growth Workspace, full Admin Control Plane, user/role administration, full Merchant 360, and reason-bearing approved merchant mutations |
| `GROWTH_USER` | Full Growth Workspace, follow-ups, notes, search, analytics, and masked read-only Merchant Insights; no Admin Control Plane permissions |

The physical role enum also accepts these historical values:
`FOUNDER`, `GROWTH_MANAGER`, `BUSINESS_EXECUTIVE`, `MARKETER`,
`CUSTOMER_SUCCESS`, and `READ_ONLY_ANALYST`. They are compatibility-only,
non-grantable values. They remain in the database and retain their old scoped
permission maps until an explicit, audited migration changes them. The session
may expose a canonical display alias, but that alias is not privilege
equivalence and must never be used as authorization.

| Raw historical value | Display alias only | Retained permissions until audited migration |
| --- | --- | --- |
| `FOUNDER` | `SUPER_ADMIN` | `session.read`, `roles.manage`, `prospects.read_all`, `prospects.manage_all`, `reports.read_all` |
| `GROWTH_MANAGER` | `GROWTH_USER` | `session.read`, `prospects.read_all`, `prospects.manage_all` |
| `BUSINESS_EXECUTIVE` | `GROWTH_USER` | `session.read`, `prospects.read_assigned`, `prospects.update_assigned` |
| `MARKETER` | `GROWTH_USER` | `session.read`, `prospects.read_source_scope` with redacted prospect output |
| `CUSTOMER_SUCCESS` | `GROWTH_USER` | `session.read` only |
| `READ_ONLY_ANALYST` | `GROWTH_USER` | `session.read` only |

The compatibility `/roles` endpoint still accepts only the two canonical role
values. A raw `FOUNDER` can retain its historical `roles.manage` permission,
but that does not make the account an Admin Control Plane `SUPER_ADMIN`.

### Canonical matrix

| Capability | `SUPER_ADMIN` | `GROWTH_USER` | Server permission or rule |
| --- | ---: | ---: | --- |
| Session, home, funnel analytics | Yes | Yes | `growth_os.session.read`; home/analytics also require `prospects.read_all` |
| Read all prospects and timelines | Yes | Yes | `growth_os.prospects.read_all` |
| Create, edit, transition, assign, link, and merge prospects | Yes | Yes | Create/assign/link/merge require `prospects.manage_all`; edit/status also accept `update_assigned` |
| Follow-ups and prospect notes | Yes | Yes | `growth_os.followups.manage`, `growth_os.notes.manage` |
| Global search | Yes | Yes | `growth_os.search.read` |
| Masked Merchant Insights | Yes | Yes | `growth_os.merchants.read_insight` |
| Full Merchant 360 read | Yes | No | `growth_os.admin.merchants.read` and raw role `SUPER_ADMIN` for the full shape |
| Read-only platform Operations and privileged Audit | Yes | No | `growth_os.admin.operations.read`, `growth_os.admin.audit.read` |
| Growth Users and Access Control | Yes | No | `growth_os.admin.users.read` / `growth_os.admin.users.manage` |
| Role administration | Yes | No | `growth_os.roles.manage` |
| Approved merchant status, credits, and reconnect-request mutations | Yes | No | `growth_os.admin.merchants.mutate` |

## HTTP Surface

All paths below are relative to `/api/internal/growth-os`. The router first
authenticates, resolves the active raw role from the server-side role store,
and applies the required permission. Request bodies are JSON and response
payloads use `{ success: true, data }`.

| Route(s) | Purpose | Required permission |
| --- | --- | --- |
| `GET /session` | Canonical session role, optional `legacyRole`, and effective raw-role permissions | `growth_os.session.read` |
| `GET /prospects`, `GET /prospects/:id` | Scoped ledger and timeline reads | Any prospect read permission |
| `POST /prospects/duplicate-check` | Shared normalized identity preflight | Any prospect read permission |
| `POST /prospects` | Create a ledger record | `growth_os.prospects.manage_all` |
| `PATCH /prospects/:id`, `POST /prospects/:id/status` | Edit or transition a scoped record | `manage_all` or `update_assigned` |
| `POST /prospects/:id/assign`, `/link`, `/merge`; `GET /prospects/:id/linkage-suggestions` | Assignment, deliberate record linkage, and merge operations | `growth_os.prospects.manage_all` |
| `GET /home`, `GET /analytics/growth` | Workspace read models and bounded funnel metrics | `growth_os.prospects.read_all` |
| `POST /search` | Global internal search | `growth_os.search.read` |
| `GET /followups`, `POST /followups`, `PATCH /followups/:id`, `POST /followups/:id/status` | Follow-up queue and status changes | `growth_os.followups.manage` |
| `GET /notes`, `POST /notes`, `POST /notes/:id/delete` | Internal note reads, creation, and soft deletion | `growth_os.notes.manage` |
| `GET /merchants`, `GET /merchants/:shopId` | Server-selected masked insight or full Merchant 360 | `admin.merchants.read` or `merchants.read_insight` |
| `POST /roles`, `DELETE /roles/:userId` | Compatibility role grant/revoke API; canonical values only | `growth_os.roles.manage` |
| `GET /admin/users` and `POST /admin/users` | List or create internal users | `admin.users.read` / `admin.users.manage` |
| `POST /admin/users/:userId/status`, `/role`, `/revoke-access`, `/reset-password`, `/revoke-sessions` | Internal access administration | `growth_os.admin.users.manage` |
| `POST /admin/merchants/:shopId/status`, `/grant-credits`, `/channels/:channelId/reconnect-request` | Approved, reason-bearing merchant operations | `growth_os.admin.merchants.mutate` |
| `GET /admin/operations` | Platform health/count snapshot | `growth_os.admin.operations.read` |
| `GET /admin/audit` | Bounded privileged audit browser | `growth_os.admin.audit.read` |

There is no Growth OS route for changing a subscription plan or performing an
AI emergency disable. Both mutations are deliberately deferred until a
dedicated, transaction-safe domain service exists. The Operations page itself
is read-only; it does not mutate payments, subscriptions, channels, or AI.

## Server Enforcement

Denials are fail-closed and are not inferred from client state:

| Condition | Current result |
| --- | --- |
| Missing, invalid, expired, blacklisted, or token-version-mismatched credential | HTTP `401` |
| No Growth role or missing required permission | HTTP `403`, code `GROWTH_OS_FORBIDDEN` |
| Growth disabled, Redis authorization cache unavailable, or authorization service unavailable | HTTP `503` |
| Invalid body/query | HTTP `400`; object scope and lifecycle conflicts remain `404`/`409` |

MFA is not a Growth OS denial condition; `GROWTH_OS_MFA_REQUIRED` was retired on
2026-11-15.

The server resolves scope from the raw permission map. Full-scope roles use an
all-record query; assigned roles are constrained by `owner_user_id`; source
scope is constrained to the controlled marketing sources and returns redacted
records. Follow-up object reads and mutations re-check the related prospect in
a transaction, so an ID alone is not an authorization grant. Growth lookup
endpoints share a `120` requests/minute limiter; Growth mutations share a
`40` requests/minute per-user/IP limiter.

### Sessions

TOTP remains a shared platform authentication feature: it is stored encrypted
with AES-256-GCM and, when enabled, sign-in still issues the short-lived
temporary challenge and then the full session cookies with `mfaVerified: true`.
Growth OS does not require that claim for any role; a session with an active
Growth role and the endpoint permission is authorized whether or not the
account has TOTP enabled, and the SPA has no enrollment-required redirect.
`GROWTH_OS_MFA_REQUIRED` is retired as of 2026-11-15.

Logout blacklists the access token and clears the refresh token. Role grant,
role change, revoke, suspension, password reset, and explicit session revoke
bump `token_version`, clear the stored refresh token, and update the strict
authorization/revocation cache. Every request checks that version; old sessions
therefore fail closed rather than waiting for a normal expiry. Cache or Redis
confirmation failure in the role/session invalidation transaction rolls back
that security-sensitive mutation.

Super Admin safeguards are transactional and count both canonical
`SUPER_ADMIN` and legacy `FOUNDER` rows:

- The last active Super Admin cannot be revoked, suspended, or demoted.
- A Super Admin cannot lock out their own account or self-escalate to
  `SUPER_ADMIN`.
- Grant and role-change operations reject a target with an active merchant
  membership with `GROWTH_OS_MERCHANT_ROLE_CONFLICT` (`409`). Internal Growth
  accounts must not also be active merchant members.
- Each role mutation requires a reason and writes an audit row. Role rows are
  not rewritten by the additive compatibility migration.

## Merchant Views And Operations

### Full Merchant 360

Only a raw canonical `SUPER_ADMIN` receives the full shape from
`GET /merchants/:shopId`:

- `overview`: existing admin overview plus activation timestamps, AI mode
  summary, and last activity;
- `growth.linkedProspects`: up to 10 linked prospect summaries;
- `subscription`: plan, cycle/model, status, period, usage, invoices, and
  outstanding amount;
- `facebook.channels`: existing channel diagnostics with credential-bearing
  token fields omitted by the admin service;
- `notes`: up to 50 active internal shop notes.

The full view is operationally sensitive and can contain merchant owner and
billing context. It is never selected from the session's display alias alone.

### Masked Merchant Insight

The non-admin insight shape contains only `shopId`, merchant name, signup date,
plan name/status, activation state, Facebook connected boolean, and up to 10
linked prospect summaries. It contains no merchant-owner PII, tokens, secrets,
invoices, payments, internal shop notes, or infrastructure state. It is
read-only.

This masking statement is scoped to the Merchant Insight response. The current
full-scope `GROWTH_USER` Workspace can read prospect contact fields, and the
global search response includes those fields for matching prospects. Do not
describe the entire GROWTH_USER output as PII-free; this is a known residual
boundary that must be resolved separately if a PII-free GROWTH_USER contract is
required.

Admin merchant mutations are limited to status, merchant credit grants, and a
channel reconnect request. They require an explicit reason, are transactionally
audited, and are not a general platform impersonation path.

## Growth Workflow

### Lifecycle and activation

The controlled status set is:
`new`, `contacted`, `qualifying`, `qualified`, `onboarding`, `disqualified`,
`unreachable`, `converted`, and `merged`.

The normal activation chain is:

```text
new -> contacted -> qualifying -> qualified -> onboarding -> converted
```

Side paths are `disqualified` and `unreachable`; a disqualified record can
reopen to `qualifying`, and an unreachable record can return to `contacted`.
There is no operator `qualified -> converted` transition; converted status is
reached only through the activation sync below (or, for historical rows,
through an import that sets the initial status directly). A record must have a
linked shop before entering `onboarding` or `converted`; merged records cannot
be edited, and converted records have no further status transitions. The
current field-update path does not make converted rows fully immutable.

The canonical activation population — used by the Home activated card, the
Analytics funnel, the Sources activated column, the list `activated=true`
filter, and every drill-through link built from them — is exactly: status
`converted`, a linked shop, and that shop currently active. Counted metrics
must be drill-verifiable: a link generated from a metric carries the same
population predicates and the same frozen window/boundary the metric used
(for example the stalled cards pass the computed `stalledBefore` instant
instead of letting the destination re-derive a moving 15-day cutoff).

The activation event is source-of-truth driven by the merchant engine:

1. A prospect is linked to an existing shop and moved to `onboarding`.
2. The merchant path records the shop's first successful AI reply in
   `settings.first_ai_reply.occurred_at` with the first conversation ID.
3. The Growth activation hook finds linked prospects still in `onboarding`,
   changes them to `converted`, and writes an `activated` event with reason
   `first_successful_ai_reply` and the shop/conversation IDs.

If a shop was already activated when it enters `onboarding`, the transition
performs the same best-effort synchronization immediately. Activation sync
failures are logged and must not fail merchant message processing.

### Sources, duplicate preflight, and import

Lead source is a database-checked taxonomy, not free text:

```text
self_signup, partner_form, manual_entry, referral_mention, inbound_message,
event, browser_extension, facebook, facebook_group, website, linkedin, partner,
paid, other
```

The marketing source subset used by source-scoped compatibility roles is
`self_signup`, `partner_form`, `referral_mention`, `inbound_message`, and
`event`.

Manual Quick Add and browser-extension capture use the same
`POST /prospects/duplicate-check` contract. Identity is normalized from phone,
email, and page URL; the response contains only matching prospect ID, business
name, status, and matched fields. Create and update paths also enforce the
database uniqueness checks, so preflight is advisory and a race can still
return `GROWTH_OS_PROSPECT_DUPLICATE` (`409`). PII stays in the POST body rather
than an API URL. Search terms are passed between Growth OS views through router
state, not URL query parameters, so the SPA does not expose email, phone, or
page URL searches through normal URL history, referrer headers, or server access
logs.

`EasyMod-backend/scripts/import-growth-prospects.js` is a legacy one-off
compatibility importer, not a bounded production ingestion service. It loads
the full legacy `crm_lead` and `partner` sets in bounded read batches, and is
dry-run by default; `--apply` is required to write. Source references and
normalized identity are checked for duplicates, and reruns skip already
imported sources. Production execution goes only through the protected
`run-growth-importer.yml` workflow (main + operator binding + production
environment + serialized concurrency; apply additionally requires the literal
`PRODUCTION-IMPORT-APPLY` phrase). After an apply, the workflow re-runs the
importer in dry-run mode and FAILS unless the verification pass reports zero
would-create rows — repeat-run idempotency is enforced by the pipeline.
Receipts (source references, outcomes, conflict pointers — no contact PII)
are persisted under `/root/growth-os-receipts/`.

Activation-import rule: an imported row becomes `converted` only with an
active linked shop. It receives a canonical `activated` event only when the
shop's history proves the same business outcome (`settings.first_ai_reply.occurred_at`);
the event is written at that historical instant. Converted rows without
evidence are never synthesized an activation event and are therefore counted
in activation totals but excluded from activation timing. The importer still
has no production ingestion status API, so no bounded-import improvement
should be claimed.

### Follow-ups and notes

Follow-ups are operator actions attached to a prospect. Their states are
`open`, `completed`, and `cancelled`; `overdue` and `due_today` are query
filters derived from `due_at` against the Asia/Dhaka business day (the fixed
UTC+06 business calendar in `growth-os.time.js` / `growthTime.ts`). All
writers convert `datetime-local` selections through the canonical
`fromBusinessDateTimeLocal` helper — never browser-local `Date` parsing — so
the selected wall-clock instant is stored identically regardless of the
operator's browser zone. An API response contains the prospect ID and name,
owner/creator IDs, due time, action, note, status, completion time, derived
overdue flag, and timestamps.

- Create defaults the owner to the actor; an explicit owner must have an active
  Growth OS role.
- A full-scope operator may manage any accessible follow-up. A scoped operator
  may manage only a follow-up they own or created and may assign it only to
  themselves or retain its current owner.
- `action` is capped at 200 characters and the follow-up note at 2,000.
- Page size is bounded to 100, with default page size 50 in the service.
- Completed and cancelled are terminal: the service accepts transitions and
  edits only from `open` rows, so neither outcome can be silently reopened
  through any current endpoint.

Notes are internal-only records with target types `prospect`, `user`, or `shop`.
Prospect notes follow prospect scope; user/shop operational notes require a
raw canonical `SUPER_ADMIN`. Notes are soft-deleted, excluded from normal list
results, and remain represented by their audit record. Prospect note creation
also appends a `note_added` timeline event. Note bodies are capped at 4,000
characters.

Operator-facing attribution: note list and create responses expose a joined
`authorDisplayName` (full name, then email), never a raw author UUID as the
primary label. A null author id with no display name renders as a removed-
account fallback; timeline events with a null actor render as system events.
Under redacted source scope, other operators' identities are hidden
(`authorRedacted`), consistent with timeline actor-name omission; the acting
user always sees their own attribution. Prospect timeline events whose values
are timestamps render in the Asia/Dhaka business clock like every other
surface.

## Search Contract

`POST /api/internal/growth-os/search` accepts `{ "q": "..." }`, with a query
length of 2 to 100 characters. It returns this stable top-level shape:

```json
{
  "prospects": [],
  "merchants": [],
  "users": []
}
```

Each category is independently capped at 10 results, ordered newest first.
There is no page, cursor, or total count in this endpoint. Prospect matches use
normalized business name, exact normalized email when the term contains `@`,
and a bounded phone-digit suffix when enough digits are present. Prospect
fields are filtered by the resolved prospect scope.

Result shapes are:

- Prospect: `prospectId`, `businessName`, `status`, `source`, `ownerUserId`,
  and, for an unredacted scope, `contactName`, `contactPhone`, and
  `contactEmail`.
- Full admin merchant: `shopId`, `merchantName`, `uniqueCode`, `planName`,
  `subscriptionStatus`, and optional owner name/email.
- Masked insight merchant: `shopId`, `merchantName`, `signupDate`, `planName`,
  and `activated`.
- User: `userId`, `email`, and `displayName`; user results are returned only
  to the raw canonical `SUPER_ADMIN` branch.

The API sets `Cache-Control: no-store` and carries the search body in a POST,
but the SPA navigation URL remains a separate residual risk as noted above.

## Audit And Limitations

Growth role, prospect, follow-up, note, and admin merchant mutations write
audit data with the actor user ID, action, resource type/ID, shop ID where
applicable, IP address, user agent, timestamps, old/new values, and reason.
The privileged audit endpoint is an allowlisted, paginated view of role,
internal-user, prospect, and admin-merchant resources; it caps page size at
100 and returns redacted old/new values plus value counts. Follow-up and note
audit resource types are written but are not in that privileged browser
allowlist; prospect lifecycle events remain in the prospect timeline.

Secret redaction is key/name based for fields containing password, token,
secret, key, OTP/TOTP, authorization, cookie, or credential. Prospect audit
snapshots additionally truncate long strings and redact values deeper than the
supported nesting bound; the admin audit redactor does not provide a general
length/depth or PII policy. Prospect audit snapshots may therefore contain raw
contact fields, notes, or metadata. The one-time initial password returned by
internal-user creation/reset is an operational credential handoff and must not
be copied into audit notes or logs.

Current source-backed limitations include missing outreach volume, reply rate,
CAC, and cohort-retention events; no campaign/workflow builder; no broad export;
no autonomous AI action; the 10-result unpaginated search; and the legacy
unbounded importer. These are not evidence of a production deployment.

## Deployment Status

This document is the living contract; execution truth lives in
`EXECUTION_STATE.md` receipts and `docs/launch/PRODUCTION_TRUTH.md`.

Growth OS is deployed to production behind its own image and pinned-digest
contract (initial rollout and MVP-1 closure receipts are dated in
`EXECUTION_STATE.md`; the live backend/Growth runtime SHAs are recorded in
`PRODUCTION_TRUTH.md` and re-verifiable at `api.easymod.tech/api/version`
and `growth.easymod.tech/build-info.json`). The historical snapshot below
was accurate only at drafting time and is preserved as dated record.

```text
HISTORICAL_SNAPSHOT_2026-09 (pre-rollout, no longer the current status):
DEPLOYMENT_STATUS=NOT_DEPLOYED_TO_PRODUCTION
PRODUCTION_MUTATED=NO
META_REVIEW_CONFIGURATION_CHANGED=NO
PRODUCTION_WORKFLOW_OR_CONFIG_MUTATED=NO
```
