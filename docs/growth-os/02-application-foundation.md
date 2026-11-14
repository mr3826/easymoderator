# Growth OS Application Foundation

> **Historical bootstrap note:** The raw SQL role snippets in this dated
> document are retained as history only. Do not use them for production access
> changes. Use the audited `grant-growth-role.yml` workflow, which delegates to
> the transactional role service, preserves the last-Founder guard, writes the
> audit row, and invalidates the authorization cache. The current release state
> and operator procedure are maintained in `docs/growth-os/EXECUTION_STATE.md`.

Date: 2026-07-18
Status: Prompt 2 foundation implemented
Verdict: CONDITIONALLY READY for Prompt 3 after manual role bootstrap and browser verification

This prompt creates the dedicated Growth OS application shell and backend access boundary only. It does not implement prospects, leads, demos, tasks, trials, scoring, outreach, referrals, customer-success workflows, merchant navigation, merchant routes, production DNS, or live deployment.

## Frontend Location

Growth OS lives in a sibling frontend application:

```text
EasyMod-growth/
  package.json
  package-lock.json
  Dockerfile
  nginx.conf
  vite.config.ts
  src/
```

It is independent from `EasyMod-frontend/` and does not import the merchant router, merchant dashboard components, or merchant navigation.

Build commands:

```bash
cd EasyMod-growth
npm ci
npm run build
```

Local development:

```bash
cd EasyMod-growth
npm run dev
```

Default local URL:

```text
http://127.0.0.1:5175
```

The Vite dev server proxies `/api/*` to `http://localhost:3000`.

## Backend Namespace

Growth OS backend code lives under:

```text
EasyMod-backend/src/modules/growth-os/
```

Mounted namespace:

```text
/api/internal/growth-os/*
```

Implemented endpoint:

```text
GET /api/internal/growth-os/session
```

Safe session response:

```json
{
  "success": true,
  "data": {
    "internalUserId": "user-uuid",
    "displayName": "Internal User",
    "role": "FOUNDER",
    "permissions": ["growth_os.session.read"]
  }
}
```

The endpoint does not return passwords, tokens, merchant secrets, channel credentials, shop secrets, or unnecessary personal data.

## Authentication Behavior

Growth OS reuses the existing EasyModerator authentication foundation:

- `POST /api/auth/signin`
- `POST /api/auth/logout`
- httpOnly `access_token` and `refresh_token` cookies
- backend `authenticate` middleware
- existing CSRF/session behavior
- same backend service behind Caddy

The Growth OS frontend has its own login page. Signing in authenticates with the existing auth endpoint, then immediately calls `/api/internal/growth-os/session`. Authentication alone is not enough to enter Growth OS.

Unauthenticated behavior:

- frontend sends the user to `/login`
- backend returns `401` for `/api/internal/growth-os/session`

Session-expired behavior:

- frontend routes to `/session-expired`
- backend remains the source of truth with `401`

## Authorization Behavior

Growth OS access is explicit and denied by default.

New table:

```text
growth_os_user_roles
```

Migration:

```text
EasyMod-backend/src/database/migrations/20260718_001_growth_os_user_roles.js
```

Entity:

```text
EasyMod-backend/src/modules/growth-os/growth-os-user-role.entity.js
```

Guard:

```text
requireGrowthOsAccess()
```

Rules:

- merchant `user_shops.role` does not grant Growth OS access
- `users.platform_role` does not grant Growth OS access
- frontend route guards are UX only
- every Growth OS backend route must run backend authorization middleware
- role lookups are cached for 60 seconds with `growth-os:user:{userId}:role`

Canonical roles:

- `SUPER_ADMIN`
- `GROWTH_USER`

Historical role values remain database compatibility values only and are not
valid bootstrap inputs.

Initial permissions are intentionally minimal and foundation-oriented. Prompt 3 must extend permissions only for the prospect/lead module it implements.

## Manual Role Bootstrap (Historical, Do Not Execute)

No Founder UI existed when this document was written. The following SQL is a
historical record of the old procedure and must not be executed against a
current environment:

```sql
INSERT INTO growth_os_user_roles (user_id, role, is_active, metadata)
VALUES ('<existing-user-id>', 'FOUNDER', true, '{"bootstrap": true}'::jsonb);
```

The current workflow below is the only supported bootstrap path.

## Protected Role Bootstrap

The first Growth OS role must be established through
`.github/workflows/grant-growth-role.yml` after migrations run. The protected
`production` environment is the intended source for
`GROWTH_BOOTSTRAP_ACTOR_EMAIL`; GitHub has no configured `growth-bootstrap`
environment, and the required production secret is currently not provisioned.
The
workflow accepts only an existing target email and the canonical
`SUPER_ADMIN` role. The role service verifies that configured actor and refuses
to bootstrap after an active Super Admin already exists. Do not use raw SQL or
pass an actor identity as a workflow-dispatch input.

The one-time deadlock resolution is implemented by
`.github/workflows/seed-initial-growth-admin.yml`. Its protected production
secret supplies the temporary password at execution time; the script hashes it
through the existing auth utility, creates no merchant membership or shop, and
sets forced password rotation plus a private bootstrap marker. It deliberately
does not create a Growth role. The canonical role workflow refuses the target
until password rotation is complete, then clears the marker transactionally
with the audited `SUPER_ADMIN` grant and session invalidation. There is no MFA
enrollment precondition (removed 2026-11-15). This implementation
receipt supersedes the old account-provisioning gap; the historical SQL above
remains non-executable.

After the first Super Admin is established, use the authenticated Growth OS
user-administration screen for grants, suspension, role changes, and revocation.
Those operations remain transactional with required audit persistence and role
cache/session invalidation.

## Deployment Preparation

Prepared production host:

```text
https://growth.easymod.tech
```

Prepared files:

- `EasyMod-growth/Dockerfile`
- `EasyMod-growth/nginx.conf`
- `docker-compose.prod.yml`
- `Caddyfile`
- `.github/workflows/ci-cd.yml`
- `.env.prod.example`

Docker Compose service:

```text
growth-frontend
```

Historical development placeholder only. Production must resolve the image to
an immutable `@sha256:<digest>` reference; never deploy this mutable tag:

```text
ghcr.io/mr3826/easymod-growth:latest
```

Caddy routing:

```text
growth.easymod.tech/api/* -> backend:3000
growth.easymod.tech/*     -> growth-frontend:8080
```

CI/CD preparation:

- path filter for `EasyMod-growth/**`
- build gate for Growth OS frontend
- GHCR image `easymod-growth`
- deploy env `GHCR_IMAGE_GROWTH`
- post-deploy container health check for `growth-frontend`

Required production environment:

```text
CORS_ORIGINS=https://easymod.tech,https://growth.easymod.tech
GROWTH_FRONTEND_URL=https://growth.easymod.tech
COOKIE_DOMAIN=easymod.tech
```

DNS is not changed by this prompt. Create or verify DNS separately before production use.

## Health Checks

Growth frontend nginx endpoints:

```text
/health
/health/ready
```

Backend readiness remains:

```text
/health/ready
```

Production smoke after deploy:

```bash
curl -i https://growth.easymod.tech/health/ready
curl -i https://growth.easymod.tech/api/internal/growth-os/session
```

Expected unauthenticated API response:

```text
401
```

Expected authorized founder browser result:

- Growth OS shell
- logged-in internal user
- role
- `No modules enabled yet`
- logout button

Expected merchant browser result:

- access denied
- no access to `/api/internal/growth-os/session`

## Manual Tests

Founder:

1. Start backend locally on `http://localhost:3000`.
2. Run migrations.
3. Bootstrap `FOUNDER` in `growth_os_user_roles`.
4. Start Growth OS: `cd EasyMod-growth && npm run dev`.
5. Open `http://127.0.0.1:5175`.
6. Sign in with the founder account.
7. Expected: Growth OS shell opens and shows the founder role.

Merchant:

1. Open `http://127.0.0.1:5175`.
2. Sign in with a normal merchant account with no Growth OS role.
3. Expected: access denied.
4. Directly request `GET /api/internal/growth-os/session`.
5. Expected: `403`.

Unauthenticated:

1. Open `http://127.0.0.1:5175` in a clean browser session.
2. Expected: login page.
3. Directly request `GET /api/internal/growth-os/session`.
4. Expected: `401`.

Merchant dashboard regression:

1. Build merchant frontend.
2. Confirm `EasyMod-frontend/src/app/routes.ts` has no Growth OS route.
3. Open the merchant dashboard under the normal host.
4. Expected: no Growth OS navigation, routes, or shell.

## Tests Run

Backend:

```bash
cd EasyMod-backend
npx jest src/modules/growth-os/__tests__/growth-os.authz.test.js --runInBand
```

Result:

```text
PASS
6 tests passed
```

Frontend:

```bash
cd EasyMod-growth
npm ci
npm run build
```

Result:

```text
PASS
```

Merchant regression:

```bash
cd EasyMod-frontend
npm run build
```

Result:

```text
PASS
```

Deployment config:

```bash
docker compose -f docker-compose.prod.yml config --quiet
```

Initial result without env:

```text
blocked by missing DB_PASSWORD interpolation
```

This is expected because the production compose file requires `.env.prod` or equivalent environment variables.

Validation result with a temporary `.env.prod` copied from `.env.prod.example`:

```text
PASS
```

The local Docker client emitted `C:\Users\ahmee\.docker\config.json: Access is denied`; that is a local Docker config permission warning, not a Compose YAML error.

## Audit Logging

Phase 2 adds the first Growth OS mutation endpoints: Founder-only role grant and revoke. Each operation validates the target and reason, writes an `AuditLog` row in the same PostgreSQL transaction, and invalidates the target's Redis authorization cache before commit. A failed audit or cache invalidation rolls the role change back.

Future mutation endpoints must log important changes using the same existing audit architecture, including:

- role assignment and revocation
- prospect create/update/status transitions
- task assignment/completion
- demo state changes
- trial/customer-health interventions
- exports
- outreach draft lifecycle

## Rollback

Frontend rollback:

1. Remove or disable the `growth.easymod.tech` Caddy site block.
2. Stop `growth-frontend`.
3. Re-deploy the previous Compose/Caddy config.

Backend rollback:

1. Remove the `/api/internal/growth-os` route mount.
2. Revert `EasyMod-backend/src/modules/growth-os/`.
3. Run migration down only if no Growth OS access data must be preserved:

```bash
cd EasyMod-backend
npm run migrate:down
```

Data safety:

- rollback does not delete merchant data
- migration down only drops `growth_os_user_roles`
- no shop, subscription, message, order, billing, Meta webhook, or merchant dashboard data is modified by Prompt 2

## Known Limitations

- no Growth OS role-management UI yet; the internal role API is server-protected and intentionally not exposed in the SPA
- the first Founder still must be bootstrapped through database access or an approved operator runbook
- no prospects/leads/tasks/demos/trials modules yet
- role grant/revoke audit events exist; prospect/task/demo/trial mutation audit events are not implemented
- no live deployment or DNS change was performed
- the current production dependency audit reports zero high-severity vulnerabilities; Node 25 local execution still leaves one unrelated sqlite3 loader suite unavailable
- frontend route guards are intentionally not treated as security controls

## Prompt 3 Readiness

Phase 3 is not started. Its development gate is the Phase 2 merge gate, not
the separate production-release gate. Start it only from a fresh worktree
after PR #35 is merged and its squash result plus Phase 2 evidence are
verified on `main`.

The bounded implementation/runtime evidence already covers migration
compatibility, real PostgreSQL/Redis authorization and failure behavior,
direct API denial, and merchant regression. The remaining production-release
gates are:

1. an internal operator is bootstrapped as `FOUNDER` through an approved
   production runbook;
2. `https://growth.easymod.tech` is validated in a real browser for the
   authorized and unauthorized access matrix, including DNS/TLS and cookie
   behavior;
3. the production delivery path is executed and independently verified.

These must keep the overall Growth OS release verdict at `NO-GO` until closed;
they are not Phase 3 development prerequisites.

Live Growth-origin browser/DNS/TLS validation, operator bootstrap, and
production delivery proof remain release blockers even while Phase 3
development proceeds after the merge gate.

Prompt 3 should implement only the prospect and lead foundation under the existing Growth OS boundary.
