# Deployment Readiness — ACME Contact + Redis Health Semantics

Owner-facing reference for two production-readiness contracts introduced after
the 2026-11-13 OCI cutover audit:

1. **Caddy has an explicit, configurable ACME contact email** so Let's Encrypt
   renewal-failure notices reach a human (the account previously had an empty
   contact list — silent expiry risk).
2. **Redis readiness is PING-verified**, not inferred from a container state,
   an open port, or a configured `REDIS_URL`.

Related: `docs/launch/PRODUCTION_TRUTH.md` (what is running),
`.github/workflows/production-watch.yml` (external uptime + cert-expiry probes),
`.github/workflows/backup.yml` header (off-site DR contract).

---

## 1. ACME email configuration

### Chain of custody

```
GitHub repo variable ACME_EMAIL          (not committed to git)
  → ci-cd.yml deploy env                 (both dry-run and deploy blocks)
  → render-production-env.js             (required + format-validated; render
                                          FAILS the deployment if missing or
                                          malformed — before the host is touched)
  → /opt/easymod/.env.prod               (rendered on the host, mode 0600)
  → docker-compose.prod.yml caddy env    (${ACME_EMAIL:?...} — `compose up`
                                          fails fast if unset)
  → Caddyfile global block               (email {$ACME_EMAIL})
  → Let's Encrypt account contact        (registered on next reload/renewal)
```

### Required configuration

| Where | Name | Value | Notes |
|---|---|---|---|
| GitHub → Settings → Variables → Actions | `ACME_EMAIL` | a monitored mailbox | repository **variable**, not secret — an email address is not a credential, but it is never committed |
| `.env.prod.example` | `ACME_EMAIL=CHANGE_ME@example.com` | template only | must stay a placeholder |

### Failure behavior (by design)

| Condition | Detected where | Result |
|---|---|---|
| `ACME_EMAIL` variable missing/empty | `render-production-env.js` | deploy fails: `Missing deployment environment variables: ACME_EMAIL` |
| Malformed value (`ops@`, spaces, newlines) | `render-production-env.js` (`validAcmeEmail`) | deploy fails: `ACME_EMAIL must be a single valid email address` |
| Empty at compose time (hand-edited host env) | `docker-compose.prod.yml` `${ACME_EMAIL:?…}` | `docker compose up` refuses to start the edge |
| Unset at Caddy adapt time | Caddy | placeholder expands empty → validation error, old config keeps serving |

### Verification commands

```bash
# Caddyfile + environment (offline; does NOT issue certificates):
ACME_EMAIL=ops@example.com docker run --rm \
  -e ACME_EMAIL \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Compose interpolation guard (must FAIL with a clear message when unset):
docker compose --env-file /dev/null -f docker-compose.prod.yml config >/dev/null
# → error: required variable ACME_EMAIL is missing a value

# On the production host after a deploy — contact registered with the CA:
docker logs easymod-caddy-1 2>&1 | grep -i "acme" | grep -i "account"

# Live renewal schedule (ARI) per certificate:
docker exec easymod-caddy-1 sh -c 'ls /data/caddy/certificates/*/*/'
```

Renewal itself is Caddy-managed (no certbot, no cron). External monitoring:
`production-watch.yml` fails when any certificate is <21 days from expiry and
warns inside the ~35-day renewal window.

---

## 2. Redis health-check behavior

### Endpoint semantics

| Endpoint | Purpose | Redis dependency | Failure response |
|---|---|---|---|
| `GET /health/live` | Liveness: process functions | **none** | 200 as long as the process answers |
| `GET /health/ready` | Readiness: can serve requests | database authenticate **and** PING-verified Redis | 503 `status:"not_ready"` when either dependency fails |
| `GET /health/detailed` (auth) | Diagnostics for the launch gate | same as ready, plus queues/canary | 503 when database disconnected or redis `degraded`/`disconnected` |

### How Redis readiness is decided (`EasyMod-backend/src/config/redis.js`)

- Each of the six clients (session, cache, rateLimit, legacy, ssePub, sseSub)
  is probed with a **real `PING` over its own configured connection** — host,
  port, password and TLS all come from the client's existing configuration; the
  probe never opens extra connections and never handles credentials itself.
- Per-client classification:
  - `ready` — PING answered `PONG`
  - `fallback` — in-memory dev fallback (no real Redis configured)
  - `down` — PING rejected (auth failure, refused, reset) or timed out
- Overall status: `degraded` if any client is `down`; `not_configured` if every
  client is the in-memory fallback; otherwise `connected`.
- **Bounded**: each PING is raced against `REDIS_HEALTH_PROBE_TIMEOUT_MS`
  (default 1500 ms), so an unreachable server can never hang the probe.
- **Cached**: results are reused for `REDIS_HEALTH_CACHE_MS` (default 10 s) so a
  fleet of load-balancer probes cannot become a PING storm; `force:true` /
  `resetRedisReadinessCache()` bypass the cache.
- Lazy-connect clients (`lazyConnect:true`) are PINGed too — the first probe
  warms the connection instead of reporting a false `idle`-but-unknown state.
- The SSE subscriber connection only accepts subscription commands in some
  ioredis modes; a `subscriber mode` refusal falls back to connection-state
  truth for that one client (the shared server is already proven by `ssePub`).
- **No internals leak**: `/health/ready` is unauthenticated and returns only
  neutral status words — never error messages, hosts, or connection strings.

### Docker Compose integration

- `redis` healthcheck is a genuine server-side `redis-cli ping` (interval 10s,
  timeout 5s, retries 5, start_period 10s). This stack runs Redis **without**
  `requirepass`; if auth is ever added, the healthcheck must become
  `redis-cli --no-auth-warning -a "$REDIS_PASSWORD" ping` (documented inline in
  `docker-compose.prod.yml`).
- `backend` and `worker` use `depends_on: redis: condition: service_healthy`
  and their own healthchecks call `/health/ready` — so a container is
  `healthy` only when the application confirms Redis answers PING. Docker's
  container-running state is never mistaken for readiness.
- `caddy` depends on `backend: service_healthy`, chaining the guarantees:
  Redis healthy → backend ready → edge starts.

### Expected failure and recovery behavior

| Scenario | Observed behavior |
|---|---|
| Redis running, PING OK | `/health/ready` 200 `redis:"connected"` |
| Redis stopped / unreachable | 503 `redis:"degraded"` within ~1.5 s (probe timeout) |
| Wrong password (WRONGPASS) | 503 `redis:"degraded"`, that client `down` |
| Redis recovers | next probe (≤10 s cache) returns 200 `connected` — no restart needed |
| App without Redis (dev fallback) | `/health/live` 200, `/health/ready` 200 `redis:"not_configured"` |
| Redis down at deploy time | deploy verification fails on `/health/ready` ≠ 200 → cutover aborted (fail-closed) |
| Missing `ACME_EMAIL` | deployment render fails before any host mutation |

### Tests

```bash
cd EasyMod-backend
npx jest src/config/__tests__/redis-readiness-probe.test.js \
         src/routes/__tests__/health-readiness-http.test.js \
         scripts/__tests__/render-production-env.test.js --runInBand
```

Scenarios covered: PONG-only readiness, WRONGPASS, ECONNREFUSED, hung PING
timeout bound, recovery, cache/force semantics, subscriber-mode fallback,
in-memory `not_configured`, liveness independence, ACME_EMAIL missing /
malformed / trimmed rendering.

### Integration evidence (2026-11-14)

Real Redis 7 at the production-pinned digest `sha256:6ab0b6e7…`, with
`--requirepass`, on port 6399:

| Scenario | Result |
|---|---|
| Correct password | `PROBE=connected`, all six clients `ready` |
| Wrong password | `PROBE=degraded`, all six `down` (WRONGPASS surfaced as down, no leak) |
| Server stopped | `PROBE=degraded` in ~2.2 s wall (parallel probes, 800 ms bound each) |
| Unreachable port | `PROBE=degraded` |
| Server restarted | `PROBE=connected` on the next forced probe — no app restart |

Caddyfile validated with the production-pinned Caddy image
(`sha256:86deaf5e…`): `caddy validate` → **Valid configuration** with
`ACME_EMAIL` set; with the variable unset the adapt fails loudly
(`wrong argument count … after 'email'`). `docker compose config` interpolates
`ACME_EMAIL` into the caddy service and refuses to render without it
(`${ACME_EMAIL:?…}`). No live certificate issuance was attempted.
