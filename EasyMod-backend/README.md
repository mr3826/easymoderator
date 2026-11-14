# EasyModerator — Backend

Messenger sales and order automation API for Bangladeshi f-commerce sellers. Merchants connect one or more **Facebook Pages**; EasyModerator drafts or sends Bengali/Banglish-capable replies, captures orders from conversations, routes them to couriers, and bills the merchant on a simple monthly plan.

> **Customer channels:** Facebook Messenger only (Facebook-only launch, 2026-06-24). Instagram, WhatsApp, Telegram customer chat, and other providers are out of product scope. Telegram exists only as a one-way merchant alert bot; it is not a connectable customer inbox. The `instagram`/`telegram`/`webchat`/`manual` values that still appear in some enums and validators are legacy taxonomy retained for stored historical conversations — they are **not** connectable customer channels.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Module / Route Map](#module--route-map)
- [AI & RAG Pipeline](#ai--rag-pipeline)
- [Product Evidence & Local Evaluation](#product-evidence--local-evaluation)
- [Meta Integration & Compliance](#meta-integration--compliance)
- [Billing Model](#billing-model)
- [Background Jobs](#background-jobs)
- [Database](#database)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Deployment](#deployment)
- [Operational Endpoints](#operational-endpoints)
- [Project Conventions](#project-conventions)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (alpine in prod) |
| Web framework | Express 4 |
| ORM / DB | Sequelize 6 + PostgreSQL 15 (`pg`, `pg-hstore`) |
| Queue / cache | BullMQ 5 + Redis 7 (`ioredis`) |
| Vector store | Qdrant (`@qdrant/qdrant-js`) — RAG retrieval |
| AI / LLM | Google Gemini (primary) + OpenAI (fallback) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs`, HttpOnly refresh cookies, CSRF (`csrf-csrf`) |
| Security | `helmet`, `cors`, `express-rate-limit` + `rate-limit-redis`, XSS sanitiser, HMAC webhook verification |
| Validation | `joi` + `express-validator` |
| Notifications | `web-push` + `firebase-admin` (FCM), Telegram Bot API, `resend` (transactional email) |
| Docs / invoices | `pdfkit` |
| Observability | Sentry (`@sentry/node`, profiling), structured logger, ops/Slack alerts |
| Process mgmt | Docker Compose (single production definition) |
| Tests | Jest 30 + Supertest, SQLite in-memory DB |

---

## Architecture

EasyModerator is a **modular monolith**. One codebase and one Docker image run in three process roles in production:

```
                         Meta Graph API (Facebook Pages)
                                  │  webhooks (HMAC-signed)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Digital Ocean Droplet                                            │
│                                                                    │
│   ┌───────────┐     ┌────────────┐      ┌────────────┐            │
│   │   api     │     │   worker   │      │ scheduler  │            │
│   │ Express   │     │ BullMQ     │      │ cron       │            │
│   │ :3000     │     │ consumer   │      │ runner     │            │
│   └─────┬─────┘     └─────┬──────┘      └─────┬──────┘            │
│         │   (same image, different entrypoint)                    │
│         └─────────────────┼───────────────────┘                  │
│                           ▼                                       │
│   ┌────────────┐   ┌────────────┐   ┌────────────┐               │
│   │ PostgreSQL │   │   Redis    │   │  Qdrant    │               │
│   │  :5432     │   │  :6379     │   │  :6333     │               │
│   └────────────┘   └────────────┘   └────────────┘               │
│                                                                    │
│   ┌────────────┐                                                  │
│   │  frontend  │  nginx-served React SPA (separate image)         │
│   └────────────┘                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Why a queue?** Inbound webhooks must return `200` to Meta within seconds. The API enqueues each event to BullMQ and returns immediately; the **worker** does the slow AI/LLM work. This decouples Meta's latency budget from our processing time and lets the worker scale independently.

### Entry points

| File | Role |
|---|---|
| `server.js` | Boots secrets → DB → Redis → migrations, then starts Express. Optionally starts an embedded worker in dev. |
| `src/app.js` | Express app factory: middleware stack + route mounting. |
| `src/modules/routes.js` | Central router registry — mounts every domain router under `/api/*`. |
| `src/jobs/worker.js` | Standalone BullMQ worker (separate prod container). |
| `src/jobs/job-runner.js` | Cron scheduler for recurring jobs. |
| `src/jobs/queue-manager.js` | Registers repeatable BullMQ jobs. |

### Source layout

```
src/
├── app.js                  # Express app factory
├── config/                 # config.js (env), secrets-loader, redis, sentry
├── constants/
├── database/
│   ├── migrate.js          # Sequelize migration runner
│   ├── migrations/         # YYYYMMDD_NNN_*.js  (+ archive/ for superseded ones)
│   └── seed*.js
├── jobs/                   # BullMQ workers + cron jobs (see Background Jobs)
├── middleware/             # auth, csrf, rate-limit, shop-access, validation, …
├── modules/                # Domain modules (see Module / Route Map)
│   ├── routes.js           # central router registry
│   └── entities.js         # Sequelize model registry
├── routes/                 # health.routes.js (liveness / readiness / SSE)
├── scripts/                # one-off ops scripts (seed-admin, reindex-qdrant, …)
├── uploads/                # local upload scratch dir
└── utils/                  # sequelize setup, redis-client, structured-logger, …
```

Each domain module is self-contained: `*.routes.js` → `*.controller.js` → `*.service.js`, with `*.entity.js` (Sequelize model), `*.validator.js` (Joi), and `__tests__/`.

---

## Module / Route Map

All routers mount under `/api`. Source of truth: `src/modules/routes.js`.

| Mount | Module | Responsibility |
|---|---|---|
| `/auth` | `auth` | Signup (atomically creates one shop), signin, refresh, logout, 2FA, password reset |
| `/shop` | `shop` | Shop profile, business info, `GET /shop/context` (plan + usage), platform-priority ordering |
| `/shop/delivery` | `delivery` | Courier zones & mapping (Pathao, Steadfast, RedX, PaperFly, …) |
| `/channels/meta` | `channel-providers` | Meta OAuth (Business Login), connect/disconnect Facebook Pages, per-channel health, token refresh |
| `/conversation` | `conversation` | Unified inbox: list, filter, assign, handoff, resolve |
| `/ai-chatbot` | `conversation` | Manual agent send, AI draft/suggest endpoints |
| `/customer` | `customer` | Customer records across channels |
| `/order`, `/order-session` | `order` | Order lifecycle + in-conversation order capture |
| `/product`, `/category` | `product`, `category` | Catalog (indexed into RAG) |
| `/knowledge` | `knowledge` | Manual merchant FAQs, knowledge gaps, and policy docs → vector index |
| `/rag`, `/delivery/rag` | `rag`, `delivery` | Retrieval-augmented context for replies |
| `/payment`, `/payment/bangladesh`, `/payment-methods` | `payment` | bKash tokenized checkout + payment config |
| `/subscription` | `subscription` | Plan, usage, top-ups, invoices |
| `/partner`, `/admin/partner` | `subscription` | Partner-plan application + admin approval |
| `/dashboard`, `/analytics` | `dashboard`, `analytics` | KPIs, GMV, resolution rate, growth metrics |
| `/notifications` | `notification` | Browser push subscriptions, in-app owner notifications, Telegram alert settings/test |
| `/audit` | `audit` | Audit log of sensitive actions |
| `/rto-shield` | `rto-shield` | Return-to-origin / fake-order risk scoring |
| `/templates` | `template` | Canned response templates |
| `/language`, `/voice`, `/sentiment` | `language`, `ai` | Banglish handling, voice-note transcription, sentiment |
| `/admin/failed-jobs` | `admin` | Inspect & retry dead-lettered BullMQ jobs |
| `/public` | `public` | Unauthenticated marketing stats |
| `/webhooks/meta` | `integration` | Inbound Meta webhooks (mounted in `app.js`, outside `/api`) |
| `/api/webhooks/telegram` | `webhooks` | Telegram Bot API webhook for merchant alert group binding/removal |

---

## AI & RAG Pipeline

Inbound message → reply, end to end:

1. **Webhook in** — `POST /webhooks/meta` verifies the `x-hub-signature-256` HMAC, then enqueues the event to the `message-queue` (returns `200` immediately).
2. **Burst coalescing** — `burst-coalescer.js` waits for a short window (`AI_BURST_WINDOW_MS`, default 8s) so a customer who splits one thought across several quick messages (or a photo + a caption) gets **one** combined reply, not many.
3. **Worker** — `message-worker.js` resolves conversation state, enforces policy guards, and builds context.
4. **Deterministic order capture** — `order-flow.service.js` runs before the LLM. Active order sessions always stay in the step-machine. Clear purchase intent such as `order korbo` either starts/continues the order flow or gets a safe product-needed/unavailable reply; it must not fall through to a generic AI reply that claims an order has started.
5. **Intent routing** — `intent-router.service.js` classifies the message (order, payment, support, …) and decides whether to retrieve product/FAQ context.
6. **RAG** — `rag.service.js` embeds the query and queries **Qdrant** (per-tenant collection) for the top-K product/knowledge chunks; live prices are read from Postgres so the model never quotes a stale price.
7. **LLM failover chain** (`llm.service.js`):
   1. `gemini-3.1-flash-lite` — primary (fast, cheap)
   2. `gemini-3.1-pro-preview` — fallback / high-stakes
   3. `gpt-4.1-mini` — final fallback
   A circuit breaker (`circuit-breaker.service.js`) trips a provider after repeated failures.
8. **Safety** — prompt sanitiser, guardrail service, hallucination/quality gate, and a confidence threshold decide auto-send vs. human handoff. Low-confidence handoffs and default unknown responses are captured in `knowledge_gaps` so merchants can turn real customer questions into FAQs.
9. **Disclosure + send policy** — the first AI response after the customer's first turn prepends the required automated-assistant disclosure plus the owner's optional greeting. The business reply setting is authoritative across connected Pages: Draft mode stores the reply as an inbox suggestion, Manual mode disables AI generation, and Auto mode can send only after policy and confidence gates pass. Per-channel toggles can opt a Page out, but cannot upgrade Draft/Manual to auto-send.
10. **Send** — the reply goes back via the Meta Graph API on the originating page/IG account.

**Embeddings:** controlled by `EMBEDDING_PROVIDER`. Production defaults to Gemini (`GEMINI_API_KEY`, `gemini-embedding-2` at `QDRANT_VECTOR_SIZE`) and uses OpenAI (`OPENAI_EMBEDDING_MODEL=text-embedding-3-small`) only through a separately reindexed, provider-homogeneous fallback collection configured by `QDRANT_FALLBACK_COLLECTION`. A failed Gemini request never inserts an OpenAI vector into the Gemini collection. Every knowledge collection carries a durable provider/model/version/dimension manifest and legacy collections without trusted provenance fail closed. Gemini Embedding 2 uses its asymmetric retrieval input contract: `task: search result | query: ...` for queries and `title: ... | text: ...` for documents. The `local` n-gram fallback is **dev-only** — it produces near-random retrieval and is surfaced as `embedding.semantic = false` on `GET /health/detailed`. Any provider, model, or input-contract version change requires a new full-reindex collection; live switching remains an explicit operational action.

Business Info updates are part of the AI knowledge path. The owner-written `settings.businessInfo.additionalInfo` field is stored with the shop profile, injected into the system prompt immediately, and included by the scheduled business-info RAG reindex job together with shop name, address, phone, and opening hours.

---

## Product Evidence & Local Evaluation

Product answers pass through the tenant-scoped catalog resolver and outbound grounding gate. Catalog-backed replies may quote only facts the shop's current records establish; absent prices and stock remain unknown, variant selection requires a matching catalog dimension, and model observations from images are retrieval hints rather than verified product facts. The deterministic Messenger presenter applies those same evidence and media ownership checks before a reply can be sent.

The local Product Engine Test Lab, synthetic multi-tenant catalog fixtures, replay contracts, and evaluation operations are documented in [`docs/ai/product-experience-v1-2/README.md`](../docs/ai/product-experience-v1-2/README.md). CSV replay, synthetic catalog cases, mocked route comparison, and real Gemini measurements use separate denominators and must be reported separately. A real provider run is an explicit local evaluation action, not production traffic.

## Meta Integration & Compliance

This product is built for **Meta App Review**. Relevant code and guarantees:

- **OAuth (Business Login):** `channel-providers/meta-channel.*` — short-lived state stored in Redis for multi-instance safety; per-page access tokens stored **AES-256 encrypted** at rest (`CHANNEL_ENCRYPTION_KEY`).
- **Webhook verification:** `integration/meta-webhook.routes.js` — `GET` challenge with a constant-time verify-token compare; `POST` rejected unless the HMAC-SHA256 signature matches `META_APP_SECRET` (timing-safe).
- **Data Deletion Callback:** `integration/meta-webhook-gdpr.handler.js` — validates Meta's `signed_request`, hard-deletes all records for the affected user (idempotent), returns the confirmation code. Mounted at `POST /webhooks/meta/data-deletion`.
- **Deauthorize callback:** same handler — disconnects the channel when a user removes the app.
- **Consent + policy engine:** `consent/` records inbound consent; the policy engine blocks cold outreach, honours opt-outs, enforces the 24-hour messaging window, and rate-limits outbound DMs per page.
- **Reviewer docs:** see `.easymod/meta-app-review/` (permission justifications, compliance checklist, data-deletion flow, screencast storyboards, test-user credentials).

Requested permissions (3, Messenger-only): `pages_show_list`, `pages_messaging`, `pages_manage_metadata`. Each is justified in `permissions-justification.md`.

---

## Billing Model

Source of truth: `src/modules/commercial/commercial.contract.js`. Every derived
surface — API, invoice, email, landing, collateral, mobile and the internal
Growth OS console — reads that module or its hand-mirrored frontend twin and
renders `contractVersion`. The public payload is served at
`GET /api/public/commercial-contract`.

- **Model:** `DELIVERED_ORDER`, BDT, postpaid, monthly cycle.
- **Price:** a flat ৳10.00 per provider-confirmed delivered order, from order 1,
  for every shop.
- **Zero-rated outcomes:** `RETURNED`, `CANCELLED`, `DRAFT`, `CONFIRMED`,
  `BOOKED`, `IN_TRANSIT`, `FAILED`.
- **Due window:** 7 days.
- **No subscription, no setup fee, no monthly minimum, no conversation
  entitlement, and no top-up purchase.**

`billing_lines` records one row per delivered order with the contract version and
a deterministic idempotency key; `invoice-generator.js` aggregates uninvoiced
lines into a monthly `delivered_order` invoice. Returned and cancelled orders
still appear on the invoice as explicit ৳0.00 lines. Historical subscription and
credit-purchase rows remain readable at their original sold values for audit;
they are never re-rendered as an offer.

**Payments: bKash only.** No other gateway is wired. Adding one requires implementing its full tokenized-checkout + webhook-verification path.

---

## Merchant Notifications

Day-one merchant alert channels:

- Browser push: `/api/notifications/subscriptions`, backed by `push_subscriptions` and VAPID/FCM.
- In-app notification center: `/api/notifications/in-app`, backed by `owner_notifications`.
- Telegram alerts: `/api/notifications/telegram/*`, backed by `telegram_notification_bindings`.

Telegram is a **one-way alert channel**. It sends only merchant operational alerts and deep links back to EasyModerator. It does not receive customer messages, does not show AI logs, and does not let merchants reply to customers from Telegram.

Human-handoff settings can select `telegram` as the alert channel after the shop connects the EasyModerator bot in Settings -> Notifications. Handoff still creates an in-app notification first; Telegram is an additional group alert, not a customer communication channel.

Supported Telegram event preferences:

- New order
- AI needs human help / HITL
- Customer waiting too long
- Courier booking failed
- Payment or subscription issue
- Daily sales summary

Operational requirements:

- Telegram is disabled by default. Set `TELEGRAM_ENABLED=true` and provide
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET`
  only when the optional alert integration is intentionally enabled.
- Configure Telegram `setWebhook` to `https://<api-domain>/api/webhooks/telegram` with `secret_token` equal to `TELEGRAM_WEBHOOK_SECRET`.
- Merchant connect flow is Settings → Notifications → Connect Telegram group. The backend creates a short-lived one-time command, stores only its hash, and binds the Telegram `chat_id` after Telegram sends the command to the webhook.
- The `notifications` BullMQ queue fans out event jobs to browser push and Telegram. In-app notification records are created before queue fan-out so the header bell remains useful even if an external provider is unavailable.
- Source events are emitted from order creation, human handoff, courier booking failure, failed-payment reconciliation, `customer-waiting-notifier`, and `daily-sales-summary-notifier`.
- `CUSTOMER_WAITING_ALERT_MINUTES` and `CUSTOMER_WAITING_ALERT_SCAN_LIMIT` are optional production knobs for the waiting-customer scan.

---

## Background Jobs

`src/jobs/` — workers (BullMQ consumers) and cron jobs (registered by `job-runner.js` / `queue-manager.js`):

| File | Type | Purpose |
|---|---|---|
| `message-worker.js` | Worker | Process inbound messages through the AI pipeline |
| `burst-coalescer.js` | Helper | Debounce rapid message bursts into one reply |
| `meta-token-refresh.job.js` | Cron | Re-auth Meta tokens nearing expiry |
| `monthly-usage-reset.js` | Cron | Reset counters and advance expired periods daily |
| `invoice-generator.js` | Cron | Aggregate uninvoiced billing lines into monthly delivered-order invoices |
| `failed-payment-reconciler.js` | Cron | Retry/flag failed bKash payments |
| `customer-waiting-notifier.js` | BullMQ cron | Alert when a HITL customer waits too long |
| `daily-sales-summary-notifier.js` | BullMQ cron | Send previous-24h merchant sales summary |
| `courier-reconciliation.job.js` | Cron | Reconcile courier delivery statuses |
| `pipeline-canary.job.js` | Cron | Synthetic auto-reply canary + DLQ watchdog → ops alert |
| `knowledge/auto-index.job.js` | Cron | Re-index product/knowledge embeddings |

---

## Subscription model

There is no subscription. The delivered-order contract above is the sole price
authority, so `GET /api/subscription/plans`, `PUT /api/subscription/plan` and
`POST /api/subscription/renew` are retired and return `410 Gone`.
`GET /api/subscription` returns the active `MERCHANT` contract view
(`contract_version`, usage and period) for admin and internal consumers.

Payment completion endpoints bind the gateway payment ID to the
server-created transaction/invoice, compare the gateway amount in minor units,
and use a conditional database claim to make replays idempotent.

---

## Database

PostgreSQL 15 via Sequelize. **Migrations are the source of truth** — never `db:sync` in production.

```sh
npm run migrate          # apply pending migrations
npm run migrate:down     # roll back the latest
npm run migrate:status   # show applied / pending
```

Migration files live in `src/database/migrations/` (`YYYYMMDD_NNN_description.js`); superseded ones are moved to `migrations/archive/`. Key tables include `users`, `shops`, `subscriptions`, `conversation_usage`, `topup_transactions`, `conversations`, `messages`, `orders`, `order_sessions`, `products`, `meta_channels`, `knowledge_documents`, `customers`, `audit_logs`.

---

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for Postgres, Redis, and optionally Qdrant)
- A Gemini API key and/or OpenAI API key for the AI pipeline

### Setup

```sh
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env        # then fill in secrets

# 3. Start Postgres + Redis (+ Qdrant)
npm run docker:up

# 4. Run migrations
npm run migrate

# 5. Seed an admin user
npm run seed:admin

# 6. Run the API (nodemon)
npm run dev

# 7. (Optional) run the worker in a second terminal
npm run start:worker
```

For a fully self-contained local run, set `START_EMBEDDED_WORKERS=true` to run the worker inline with the API.

---

## Environment Variables

Copy `.env.example` (the authoritative list) to `.env`. In local development, the CSRF double-submit cookie is host-only and named `easymod.csrf-token` so browsers accept it on HTTP localhost. Staging and production keep the library default `__Host-psifi.x-csrf-token` name (set `NODE_ENV` explicitly — an unset value defaults to `development`). Authentication stays enabled in development; use local synthetic data for UX review, not production merchant data.

Highlights:

```env
# Core
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/easymod
REDIS_URL=redis://localhost:6379
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173

# Auth & crypto
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
SESSION_SECRET=...
COOKIE_DOMAIN=                       # Optional; leave blank for same-origin /api deployments
PAYMENT_ENCRYPTION_KEY=...            # 32 bytes
CHANNEL_ENCRYPTION_KEY=...            # 64-hex (32 bytes) — encrypts Meta tokens at rest

# Meta (Facebook)
META_APP_ID=...
META_APP_SECRET=...
META_OAUTH_REDIRECT_URI=http://localhost:5173/channels/oauth-callback
META_WEBHOOK_VERIFY_TOKEN=...         # App Dashboard webhook handshake
META_APP_SECRET=...                   # OAuth and HMAC signature secret from Meta App Settings

# AI / LLM
GEMINI_API_KEY=...
OPENAI_API_KEY=...
LLM_PROVIDER=gemini

# Vector DB (Qdrant) + embeddings
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=knowledge_documents
QDRANT_FALLBACK_COLLECTION=                  # optional READY OpenAI collection; cold fallback only
QDRANT_PER_TENANT=true
EMBEDDING_PROVIDER=gemini             # gemini | openai | http | local(dev-only)
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
GEMINI_EMBEDDING_SPACE_VERSION=gemini-embedding-2-search-v1
OPENAI_EMBEDDING_SPACE_VERSION=openai-text-embedding-3-small-v1
QDRANT_VECTOR_SIZE=384

# Email, push, errors, ops
RESEND_API_KEY=...
EMAIL_FROM=EasyModerator <no-reply@easymod.tech>
SENTRY_DSN=...
SLACK_ALERT_WEBHOOK_URL=...
ADMIN_EMAIL=support@easymod.tech
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=EasyModBot
TELEGRAM_WEBHOOK_SECRET=...
CUSTOMER_WAITING_ALERT_MINUTES=30
CUSTOMER_WAITING_ALERT_SCAN_LIMIT=200

# AI behaviour
AI_BURST_WINDOW_MS=8000
```

See `.env.example` for the full annotated set (Redis multi-DB allocation, canary tuning, embedding retry/backoff, etc.).

---

## Testing

```sh
npm test               # Jest with coverage (--forceExit --detectOpenHandles)
npm run test:watch     # watch mode
```

Tests live in `src/**/__tests__/` and `tests/`. Integration tests run against a **real SQLite in-memory database** (not mocked), so they exercise actual Sequelize queries.

> **Current state:** the full backend suite is green — **999 tests / 66 suites passing**.

> **Monorepo note:** `EasyMod-backend/` may contain a stale nested `.git`. Always run git from the repository root (`git -C <repo-root>`). When running Jest from the root, wrap it in a subshell: `(cd EasyMod-backend && npm test)`.

---

## Deployment

CI/CD via GitHub Actions (`.github/workflows/ci-cd.yml`):

1. **Detect changes** — only rebuild the package that changed.
2. **Test** — backend Jest suite against a Redis service container.
3. **Build & push** — Docker images to GHCR, tagged with the commit SHA only.
4. **Deploy** — SSH into the droplet, pull images, `docker compose up -d`, run `npm run migrate`, health-check `/health/ready`.

The droplet runs `docker-compose.prod.yml` with the `api`, `worker`, `scheduler`, `frontend`, `postgres`, and `redis` services from a single backend image. The backend `Dockerfile` is multi-stage on Node 20 alpine. Docker Compose is the only supported production runtime (the legacy PM2 path was retired 2026-07-23).

**Required deployment configuration:** droplet host/SSH key, `VITE_META_APP_ID`, and the production `.env` values delivered to the droplet. The canonical origins are `easymod.tech` (marketing/legal), `app.easymod.tech` (merchant app/OAuth completion), and `api.easymod.tech` (API/webhooks/uploads). Set `VITE_API_BASE_URL=https://api.easymod.tech` and keep `COOKIE_DOMAIN` unset. `LEGACY_COOKIE_DOMAIN=easymod.tech` may be retained only for the documented cookie-cleanup window.

---

## Operational Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health/live` | none | Liveness — always 200 if the process is up |
| `GET /health/ready` | none | Readiness — 200 when DB + Redis are reachable (CI gate) |
| `GET /health/detailed` | yes | Queue depths, infra topology, key presence, `embedding.semantic` |
| `GET /health/sse` | — | Server-Sent Events stream for live inbox updates |

---

## Project Conventions

- **One shop per user** — signup atomically creates exactly one shop; there is no shop-switch.
- **Migrations over sync** — production schema changes always go through `npm run migrate`.
- **bKash-only payments** — do not re-add other gateways without their full verification path.
- **RAG always on** — product/knowledge context is injected on every relevant reply; it is not a toggle.
- **Plan codes** — only `GROWTH` and `PARTNER` are canonical; legacy/unknown codes normalise to `GROWTH` (fail-safe to full AI rather than lock-out).
- **AI attribution is policy** — keep the bot marker on for Meta compliance unless you have a documented reason.
