# SECURITY_REVIEW — Channel Automation Redesign

Independent review of the mission diff (`8d477288..HEAD`) by a dedicated security reviewer and a code reviewer (separate agents, no implementation context), with adversarial refutation of every critical/high finding. Reviewers read the actual code, executed the hours rule to verify behavior, and checked the static boundary tripwire against its claims.

## Verdict

**No critical findings. No unsafe-send path, no cross-tenant leak, no data-loss path found.** Two high findings were confirmed by adversarial verification and **fixed with regression tests** (below). Seven medium/low findings were addressed in the same fix round. Zero findings were refuted; zero critical/high findings left unverified.

## What the reviewers verified as holding

- **Authorization**: owner-only writes enforced server-side (`requireOwner` on emergency stop/resume, `PUT /shop/ai-settings`, `PATCH /channels/meta/:id/settings`) and mirrored client-side; admin resume SUPER_ADMIN-only behind `authenticate` + `requirePlatformAdmin`; merchant resume hardcodes `source:'merchant'` — an admin-source stop cannot be cleared by a shop (403 `EMERGENCY_STOP_ADMIN_SOURCE`); spoofed `source` in the body rejected by Joi.
- **Tenant isolation**: asserted at controller (`assertChannelBelongsToShop`, 404 no existence leak), service (mandatory `shopId` on get/update), and resolver loader (shop assertion → null fail-closed); `X-Shop-ID` cannot widen scope (JWT-only `verifyShopAccess`); pinned by the new 13-test integration suite.
- **Stop enforcement**: every enumerated send path consults the resolver (worker Guard 4, candidate reuse, pre-policy, send guard, provider boundary, recovery holding, human-handoff holding, webhook shim); single-transaction engage with Shop row lock + MANUAL belt + AUTO-write 409 guard; resume clears only the flag; transactional exemption is internal-only (`messageType` hardcoded by `sendToCustomer`; no HTTP route can set it).
- **Boundary discipline**: provider-boundary read is fresh, tenant-asserted, no INSERT, no Shop row lock; CAS `provider_send_attempted` preserved; ADR-0004 delivery truth intact.
- **Migration safety**: 004/005 purely additive, idempotent, no backfill/destructive DDL; parameterized ORM calls only; new logs/SSE/audit payloads carry no secrets or customer PII; auth fixture gitleaks-safe (placeholder tokens).
- **Static tripwire**: `channel-automation.boundary.security.test.js` pins absence of direct `getEffectiveAiReplyMode` in all three send-path files; human-handoff/webhook import-level scope is acceptable because behavioral stop tests cover them.
- Test-only fail-open branches (`loadShopSafetyState` with a stubbed entity registry) are unreachable in production (`modules/entities.js` always exports `Shop`).

## Confirmed findings and resolutions

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R1 | high | `handoff_reason` dropped by the conversation PATCH controller — every manual takeover persisted the default reason; unit/e2e proofs bypassed the controller seam | Controller forwards the field (`conversation.controller.js`); NEW HTTP-seam test `conversation.handoff-reason.controller.test.js` (3 tests: forwarding, all fixed-list reasons, absent→service default) |
| R2 | high | `normalizeBusinessGreeting` replaced business greetings >500 chars with the stock default (business validator allows 1000) — violated byte-identical behavior | Business greeting passes through verbatim; 500-char bound applies to channel overrides only; resolver test with a 600-char Bangla greeting |
| R3 | medium | Conversation list/detail automation context failed OPEN for `billing_ai_active` and `emergency_stop` on read errors | Fail-closed defaults (stop active, billing false) + missing-row handling; new fail-closed projection test in `conversation.delivery-state.test.js` |
| R4 | medium | Display-only `Subscription.findOne` inside the provider-boundary transaction could abort the Postgres tx on error and fail the send | Loader skips the billing read entirely when a transaction is supplied (boundary never consumes it; Guard 4c enforces billing); resolver test pins no subscription read under transaction |
| R5 | medium | Inbox AI-mode badge ignored `billing_ai_active` (could show AUTO while worker blocks) | Badge renders PAUSED-billing when `billing_ai_active === false` (frontend fix round; test added) |
| R6 | medium | Hours editor could save an all-disabled schedule → `{}` = CLOSED every day, silently pausing all automatic replies | Explicit warning + confirmation before saving an empty schedule (frontend fix round; tests added) |
| R7 | medium | `greeting.enabled` override honored by nothing — custom text sent regardless | `buildGreeting` honors `enabled === false` (custom text dropped; mandatory AI disclosure always kept); deliberate amendment of the legacy no-op pin + enabled=true test |
| R8 | low | Override editor stayed enabled during stop; "Start override" seeded the stop-forced MANUAL as a persistent override | Override editing disabled while stopped with notice; seed never uses stop-forced effective values (frontend fix round; tests added) |

Also fixed in the same round: cross-shop 403→404 pin in `meta-channel.webhook-health.controller.test.js` (contract alignment, rejection-before-Meta-request intent preserved).

## Accepted residual risks (documented, not defects)

- In-flight provider-call race: a stop/mode change committing after the boundary read but before the Graph call may still deliver one message (ADR-0003/0013 acknowledged; provider idempotency + reconciliation backstop; honest UI copy).
- Human agency under stop: agent sends and draft approvals remain allowed (deliberate; parity with MANUAL).
- `needs_human` legacy path retained (now sets `hitl=true`; bypass closed).
- Confidence 0.9 hardcode: pre-AUTO blocking gate in [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) (user-approved deferral).
- Reopen clears hitl but preserves assignee (24h model, deliberate).

## Review method

- Code reviewer: full diff vs ADR-0013/API_CONTRACT; executed the hours rule (null→always, {}→closed, multi-slot/overnight correct); verified all 9 send sites + both mutation seams; migration/entity match; amendment intent preserved.
- Security reviewer: authorization/tenant/stop-bypass/validation/fail-closed/audit/secrets/migration focus; verified the static tripwire's actual scope; confirmed `messageType` cannot be set externally.
- Adversarial verification: each critical/high finding independently re-checked against code + contracts with a refutation default; both confirmed findings survived with concrete reachable failure scenarios; 0 refuted.
