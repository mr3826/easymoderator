# Meta-shaped E2E

Proves that the production-shaped pipeline preserves the invariant in
[`docs/ai-cost/AI_TRUST_BOUNDARY.md`](../../../docs/ai-cost/AI_TRUST_BOUNDARY.md):

> **LLM output is a candidate response, not an authoritative response.**

Run it:

```bash
node scripts/product-experience/run-integration.js  # recommended: disposable DB/Redis plus egress fence
npm run test:meta:e2e                             # needs dedicated disposable PostgreSQL + Redis
```

The runner defaults to a project-scoped PostgreSQL 16 / Redis 7 Compose stack.
When Docker is unavailable, an explicit external-service mode is available for
an isolated PostgreSQL database and Redis process already running on the local
machine or in WSL:

```powershell
$env:LAB_EXTERNAL_SERVICES = 'true'
$env:LAB_POSTGRES_PORT = '55432'
$env:LAB_REDIS_PORT = '56379'
node scripts/product-experience/run-integration.js
```

That mode connects only to `127.0.0.1`, requires the empty
`easymod_product_lab_test` database with role `lab` / password
`lab-local-only`, and requires Redis to expose at least 23 logical databases
with indexes 0–3, 10–15, and 20–22 empty. The runner verifies both protocol
endpoints and records their actual versions before migrations. It does not
create, start, or stop externally managed services, so the caller remains
responsible for their lifecycle and cleanup. The receipt records the loopback
client endpoint but does not inspect other listener interfaces; keep both
service listeners bound to loopback.
Provider credentials are stripped and the same Node egress guard remains
active.

Setup, fixtures and the live-Meta procedure:
[`docs/testing/META_E2E_TEST_SETUP.md`](../../../docs/testing/META_E2E_TEST_SETUP.md).

## Where automated transport ends

```
 signed Meta-shaped webhook ─┐
                             │  ← the suite writes this, with a real HMAC over
                             │    an ISOLATED integration-test App Secret
   meta-webhook.routes ──────┤  REAL: rate limit, HMAC verify, dispatcher
   meta-webhook-events ──────┤  REAL: durable receipt, dedup, consent, storage
   Redis / BullMQ ───────────┤  REAL queue, real job payload
   message-worker ───────────┤  REAL: dedup, HITL, automation mode, billing,
                             │        sentiment, order-flow, confidence gate
   intent-router ────────────┤  REAL: shop-scoped catalog search, FAQ retrieval
   llm.service ──────────────┤  REAL provider chain, failover, circuit breaker
        └─ HTTP to Gemini/OpenAI  ← CAPTURED (transport.js): the wire response
                             │      is scripted so a test can hand the pipeline
                             │      a deliberately hallucinated candidate
   outbound grounding gate ──┤  REAL, never mocked
   policy engine ────────────┤  REAL
   MetaMessengerProvider ────┤  REAL: attachment mapping, messaging_type, proof
        └─ POST graph.facebook.com/me/messages  ← CAPTURED: the assertion target
```

The provider `fetch` and the Meta Graph `axios.get/post` hops are captured in
[`transport.js`](./transport.js); unexpected outbound provider fetches and
non-Graph `axios.get/post` calls throw. The standalone Jest command does not
install an OS-wide network firewall. The product integration runner installs
a Node API egress fence that allows loopback hosts while rejecting non-loopback
network operations. In Compose mode it starts disposable services; in external
mode it uses the explicitly configured user-owned loopback services. The guard
does not restrict loopback access to the service ports, and it is not an
OS-wide network firewall.

Most scenarios cover the full signed-webhook pipeline. Two boundary cases are
deliberate exceptions: one calls the outbound grounding gate directly with a
proposed attachment vector, and retrieval-outage cases spy on product lookup to
simulate a catalog read failure. These narrow tests are labeled in
`meta-e2e.test.js`; they do not claim webhook-to-worker coverage.

## Merchant-API entry points

`harness.api()` mounts the REAL `knowledge`, `shop` and `conversation` routers
behind the production auth chain; `harness.asMerchant(shopId)` seeds an active
owner membership and mints a real Bearer token. On top of that:

- [`cross-system-config.test.js`](./cross-system-config.test.js) — P03: one
  value travels save (merchant API) → retrieve (webhook → worker) → reply
  (grounding gate → Graph send) in a single chain, with the LLM capture proving
  the NEW value entered the model's context, cross-shop markers proving the
  other shop's data never does, and an unsourced figure proving absent data is
  not fabricated.
- [`draft-approval-pipeline.test.js`](./draft-approval-pipeline.test.js) — P05:
  the DRAFT → approve → send → evidence pipeline THROUGH the real
  `POST /api/conversation/:cid/messages/:mid/approve` route (service CAS +
  `InboxDeliveryOutbox` + settle + provider-error/no-ack/outside-window
  states). `harness.sendAgentReply` remains a plain agent-send shortcut and is
  NOT approval coverage — do not use it to claim the approval contract.

## Assertions

Every scenario asserts on two things, never on model phrasing alone:

1. **What Meta would have received** — the exact Graph Send API bodies, text and
   attachments (`harness.sentTexts` / `sentAttachments`).
2. **The evidence EasyModerator recorded** — the grounding decision the worker
   really emitted (`decision`, `reasonCode`, `productStatus`, `mediaStatus`,
   `verifiedProductIds`, `mediaProductId`, `knowledgeIds`, `violations`,
   `provider`) plus the `grounding_*` stamps and `source_references` persisted
   on the stored `Message` row.

## Known boundaries

- **Queue timing.** The webhook really enqueues into Redis; the harness then
  drains those jobs and calls the real worker handler, rather than racing a live
  BullMQ `Worker`. The job payload, the queue round-trip and the handler are
  real; BullMQ's own scheduler is not under test here (`pipeline-canary.job.js`
  probes that in production).
- **Vector retrieval.** No Qdrant instance runs in CI, so the vector tier
  degrades to empty exactly as it does when Qdrant is down. The keyword-FAQ
  knowledge tier is exercised for real against PostgreSQL.
- **Gemini context caching** is disabled (`GEMINI_CACHE_MIN_CHARS`) so the
  request shape is constant across the suite. It is an input-token cost
  optimisation, not part of the trust boundary.
- **The intent-router response cache** is disabled (`INTENT_CACHE_TTL_SECONDS=0`)
  so every turn re-derives its answer from the catalog — which is the property
  META-E2E-002 exists to prove.
