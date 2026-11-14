# EasyModerator

EasyModerator is a production-focused Messenger sales and order automation platform for Bangladeshi f-commerce sellers. The current launch scope is intentionally narrow: merchants connect Facebook Pages and use EasyModerator for Messenger DM handling, draft and automatic replies, product-grounded order capture, manual inbox work, COD/RTO risk support, and billing.

> Source of truth: `main` is the production branch. Keep short-lived feature/fix branches only while active, then merge or delete them. Do not keep stale local branches, remote branches, or stashes as parallel product history.

---

## Repository Layout

| Path | Purpose |
|---|---|
| `EasyMod-backend/` | Express API, worker, scheduler, Sequelize models/migrations, Meta webhook handling, AI/order services. |
| `EasyMod-frontend/` | React/Vite merchant dashboard, marketing pages, inbox, products, orders, first-time setup, and legal pages. |
| `EasyMod-growth/` | Independent React/Vite TypeScript Growth OS staff frontend, served on `growth.easymod.tech` and using the `/api/internal/growth-os/*` namespace. |
| `.github/workflows/` | Canonical CI/CD, Growth OS publish, backup, administration, purge, and load-testing workflows. |
| `docker-compose.prod.yml` | Production service composition used on the production OCI host. |
| `Caddyfile` | Production reverse proxy/static serving configuration. |
| `docs/` | Launch, App Review, operational, and audit documentation. |
| `package.json` | Root npm workspace orchestration; module package manifests remain authoritative for dependencies. |

---

## Production Scope

- Live channel: Facebook Page Messenger DMs.
- Out of current launch scope: Instagram, WhatsApp, Telegram as a customer/inbox channel, public comment automation, cold-DM automation, and broadcast campaigns.
- Merchant alert channels: browser push, in-app notification center, and one-way Telegram group alerts through the global EasyModerator bot.
- AI reply mode is configured once in Business Settings. New or unresolved shops fail closed to Manual; Draft requires merchant review, and Auto can send only after policy and confidence gates pass.
- Messenger conversations outside Meta's 24-hour reply window are blocked until an approved compliant template path exists.
- Product/order flows must remain grounded in live product, shop, customer, and order data.
- A generated product availability or stock claim requires tenant-scoped product evidence. When no product was identified, subjectless, named, generic, and deictic claims such as “in stock” and “we have it in stock” are withheld; delivery options and recognized bKash/Nagad payment availability route through their own shop-policy checks. Product stock and variant claims remain independently checked when a reply also contains a separate delivery-policy aside. Delivery claims require explicit coverage or timeline evidence; COD acceptance alone cannot authorize delivery scope. Generic “payment is available” wording requires at least one authoritative accepted method.
- Public pricing lives at `/pricing` and is driven by `GET /api/public/commercial-contract` — the delivered-order contract, whose sole authority is `EasyMod-backend/src/modules/commercial/commercial.contract.js`. The landing page pricing section stays the primary conversion surface, and no page may hardcode a merchant price.
- Business Info includes an optional owner-written "additional info" field. It is stored with the shop profile, used in reply context immediately, and included in the scheduled business-info search index.
- Payment and delivery defaults come from the live shop operating context; FAQs are optional shop-specific knowledge, not required starter setup.
- FAQ management lives under `Manage Shop -> FAQs` (`/manage-shop/faqs`). The retired `/knowledge` page redirects there for old bookmarks. FAQ create/update/delete operations sync the matching `faq-<id>` search record immediately so reply answers do not wait for the scheduled auto-index job. Low-confidence and unknown reply turns are captured as knowledge gaps for FAQ improvement.
- Courier providers supported in the merchant delivery settings are Pathao, Steadfast, and RedX; a provider must be connected and then activated before it is used for courier booking.
- Facebook Page reconnects use fresh Meta OAuth as the current ownership proof. Page discovery uses `/me/accounts` only and does not request `business_management`; the callback intersects those Pages with Meta `debug_token` granular permission target IDs so the app picker shows only Pages selected/authorized in Facebook. Stale legacy channel rows are released before a Page is connected to a new shop, while modern active claims from a different EasyModerator user remain blocked and webhooks route only to the active `CONNECTED` channel.

---

## First-Time Setup Dashboard

New shops start on the single delivered-order `MERCHANT` model automatically after signup; there is no subscription plan and no plan picker before account creation, and merchants are billed ৳10.00 per provider-confirmed delivered order. After signup, merchants land in Business Setup before seeing the normal dashboard.

The setup source of truth is `GET /api/setup/status`. The UI only uses localStorage for presentation state: whether the merchant has started the welcome screen and whether the final completion celebration was dismissed for that shop.

Required completion rules:

- At least one connected Facebook Page channel.
- Minimal shop profile: shop name, support contact, delivery info, and payment methods.
- At least one active product; three or more active products are recommended.
- Reply settings exist with an automation mode and confidence threshold. Manual is the safe default and is recommended for first launch verification.
- AI auto-reply is derived from the business automation mode: Manual disables automatic AI generation, Draft holds replies as merchant-visible suggestions, and Auto can send after policy and confidence gates pass. Page settings do not override the business mode.

The checklist does not lock navigation. Merchants can use the sidebar and settings pages while setup is incomplete. When all required items pass, EasyModerator shows a one-time "Your shop is ready" completion screen before the normal dashboard. Set `VITE_ENABLE_FIRST_TIME_SETUP_DASHBOARD=false` only as an operational fallback.

---

## Local Development

Install once from the repository root — this is an npm workspace, so `npm ci`
inside a module resolves the root lockfile anyway:

```sh
npm ci
```

Then run per module:

```sh
npm run test:backend      # jest unit/service gate
npm run test:frontend     # vitest
npm run test:growthos     # tsc --noEmit
npm run build:all
```

`npm run test:all` and `npm run build:all` run all three. See
[Monorepo Architecture](docs/infrastructure/MONOREPO_ARCHITECTURE.md) for the
boundary and rollback rules.

The isolated Product Engine V1.1 Test Lab, rerun commands, and local QA evidence
are documented in [Product Engine V1.1 Test Lab](docs/ai/product-experience-v1-1/README.md).

The V1.3 customer-truth benchmark, isolated integration workflow, bounded Gemini
opt-in, and consolidated proof package are documented in
[Product Engine V1.3 verification](docs/ai/product-experience-v1-3/README.md).

### Backend test suites

Backend tests belong to exactly one suite, chosen by filename, and
`npm run test:discovery` fails the build if any tracked test file has no home or
more than one:

| Suite | Command | Needs |
|---|---|---|
| unit / service | `npm test` | nothing — the message queue is stubbed |
| integration | `npm run test:integration` | real PostgreSQL + Redis (`*.integration.test.js`) |
| Meta-shaped E2E | `npm run test:meta:e2e` | real PostgreSQL + Redis (`tests/meta-e2e/`) |
| quarantine | `npm run test:quarantine` | known-broken debt — **not coverage** |

`tests/quarantine.json` is the register of tests that are real but not yet
repaired; each entry carries its cause and its repair, and the ceiling only goes
down. A green `npm test` covers everything except that register.

The integration suites refuse to run against a database whose name does not
carry `test` or `e2e` as a whole word. To run them locally:

```sh
docker run -d --name em-pg -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e \
  -e POSTGRES_DB=easymod_integration_test -p 55432:5432 postgres:16-alpine
docker run -d --name em-redis -p 56379:6379 redis:7-alpine

cd EasyMod-backend
DATABASE_URL=postgres://e2e:e2e@127.0.0.1:55432/easymod_integration_test \
  DB_SSL=false NODE_ENV=test npm run migrate
DATABASE_URL=postgres://e2e:e2e@127.0.0.1:55432/easymod_integration_test \
  REDIS_URL=redis://127.0.0.1:56379 npm run test:integration
```

See [EasyMod-backend/README.md](EasyMod-backend/README.md) and [EasyMod-frontend/README.md](EasyMod-frontend/README.md) for module-specific setup, environment variables, testing, and architecture.

The full V1.3 Product Engine integration runner defaults to Docker Compose. If
Docker is unavailable, it can use an explicitly selected user-owned PostgreSQL
and Redis pair on `127.0.0.1`; it verifies an empty test database and Redis
logical databases before running migrations and worker/webhook suites. See the
[V1.3 verification guide](docs/ai/product-experience-v1-3/README.md) for the
external-service setup and cleanup requirements.

Launch-critical Meta deletion/deauthorization behavior, the authenticated/public
route inventory, webhook guarantees, external-media policy, required production
configuration, and rollback instructions live in
[docs/security/PHASE1_SECURITY_COMPLIANCE.md](docs/security/PHASE1_SECURITY_COMPLIANCE.md).

---

## Deployment

Production verification and image publication are driven by pushes to `main`
through `.github/workflows/ci-cd.yml`; a push does not switch production traffic.
The production cutover is a separate, manually confirmed step:

1. Detect backend/frontend changes and run the required test/build gates.
2. Build and push SHA-tagged GHCR images by immutable digest.
3. Dispatch the same workflow from the current `main` SHA with
   `PRODUCTION_DEPLOY_ENABLED=true` and the exact
   `DEPLOY-<full main SHA>` confirmation.
4. The `production` environment policy gates the deploy job; GitHub currently
   has no configured reviewer rule, so this is not a substitute for protected
   `main` and human environment approval.
5. Sync `/opt/easymod`, run the candidate image migration, replace services,
   and verify `/health/ready`, `/health/live`, and version/digest receipts.

The backend configuration preflight runs before traffic is served and before CI
replaces a production container. For Phase 1 changes, run the merge-blocking
security suite plus full backend and frontend verification:

```bash
cd EasyMod-backend
npm run test:security
npm test -- --runInBand

cd ../EasyMod-frontend
npm run test:unit
npm run build
```

Manual production changes should not bypass this path unless there is an incident and the workaround is documented afterward.

The current production cutover deliberately rejects the destructive
`wipe_db_first=WIPE` path. Confirmed database resets, if ever required during
an incident, must use a separately reviewed recovery procedure rather than the
normal deployment gate.

The manual workflow input `seed_admin=SEED` creates or updates the production review account from `SEED_ADMIN_*` environment values. The seed grants `SUPER_ADMIN`, ensures an owner shop, resets the configured password, and keeps that shop on an active Growth subscription paid through the next 12 months. The password is supplied by GitHub Secrets, never committed.

Production has three canonical origins: `https://easymod.tech` for marketing/legal pages, `https://app.easymod.tech` for merchant authentication and product routes, and `https://api.easymod.tech` for API/webhook/upload traffic. Build the SPA with `VITE_API_BASE_URL=https://api.easymod.tech`, `VITE_APP_URL=https://app.easymod.tech`, and `VITE_MARKETING_URL=https://easymod.tech`. Keep `COOKIE_DOMAIN` unset so auth cookies remain API-host-only; `LEGACY_COOKIE_DOMAIN=easymod.tech` is a temporary cleanup control for cookies issued before the split. See [Domain and Route Architecture](docs/infrastructure/DOMAIN_AND_ROUTE_ARCHITECTURE.md).

### Telegram alert bot

Telegram is notification-only. It is not a customer inbox, AI reply surface, or second support channel.

Telegram is disabled by default for the Facebook-first cutover. Set the
repository variable `TELEGRAM_ENABLED=true` before configuring these optional
production secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`

Configure BotFather/setWebhook to deliver Telegram updates to `https://api.easymod.tech/webhooks/telegram` with the same `secret_token` value as `TELEGRAM_WEBHOOK_SECRET`. The API hostname is the public namespace; do not add `/api` to provider-facing production URLs. Do not commit token values.

Supported merchant alert events are new order, AI human-handoff, customer waiting too long, courier booking failure, payment/subscription issue, and daily sales summary.

---

## Working Agreement

- Keep the repo clean: no dead feature branches, stale stashes, abandoned generated assets, or obsolete specs in the active tree.
- README/docs updates are part of done when behavior, setup, deployment, or operational workflows change.
- Prefer small, reviewable commits by product slice: backend behavior, frontend UI, docs, and deployment changes should be separated when practical.
- Before deployment, run focused tests for touched modules plus the frontend build; rely on CI/CD for the final production gate.
- AI runtime changes must follow [CONTRIBUTING-AI.md](CONTRIBUTING-AI.md) and the normative documents under `docs/ai/`.
