# EasyModerator — Launch Gate Checklist

The 10-shop smoke test is the acceptance test for the whole launch-hardening effort.
**Do not launch publicly until every hard gate below is green.** Most are checked
automatically by `scripts/launch-readiness.js`; the rest are human steps.

Run the automated gates any time with:

```bash
# from EasyMod-backend/
BASE_URL=https://api.easymod.tech ADMIN_TOKEN=<admin-jwt> ACTIVATION_TARGET=10 \
  node scripts/launch-readiness.js
# or: npm run launch:check   (reads the same env vars)
```

Exit code `0` = all hard gates pass. The script prints PASS/FAIL per gate.

---

## Hard gates (must all be ✅ before launch)

| # | Gate | How it's verified | Owner |
|---|------|-------------------|-------|
| 1 | **CI is green on `main`** — backend tests + frontend build pass; build/deploy only run after the test gate | GitHub Actions: the `Quality fast` job is green on the latest `main` validation | Eng |
| 2 | **Infra up** — API answers `/health/ready` 200 | `launch-readiness.js` gate 1 | Auto |
| 3 | **DB + Redis + Vector store healthy** — Postgres connected, Redis connected, Qdrant available | `launch-readiness.js` gate 2 (`/health/detailed`) | Auto |
| 4 | **No silent reply failures** — `message-dlq` depth = 0 | `launch-readiness.js` gate 3 (`autoReplyDlq`) | Auto |
| 5 | **Auto-reply canary fresh** — the message worker has completed a synthetic probe within `CANARY_MAX_STALENESS_MS` | `launch-readiness.js` gate 4 (`autoReplyCanary.fresh`) | Auto |
| 6 | **Canary green for 7 straight days** — no STALE / DLQ / enqueue-failure ops alerts fired in the alert channel for a week | Review Slack/Sentry ops-alert history | Eng |
| 7 | **≥10 shops activated** — 10 real shops reached their first successful AI reply | `launch-readiness.js` gate 5 (`/api/analytics/growth` → `totals.activated`) | Auto |
| 8 | **Alerting actually reaches a human** — `SLACK_ALERT_WEBHOOK_URL` and/or `SENTRY_DSN` set in prod and a test alert was received | Trigger a test alert; confirm receipt | Eng |
| 9 | **Shared Inbox upload volume ready** — outbound attachments persist on the OCI host volume + off-site object storage and are publicly reachable for Meta Messenger | Manual upload smoke test below | Eng |
| 10 | **Meta deletion identity coverage ready** — every connected active pilot/reviewer Page has a legitimate app-scoped/Page-scoped identity mapping | `GET /api/admin/meta-identity-readiness` reports `connectedChannelsMissingMappings: 0`; reconnect missing channels before Meta submission/public launch | Eng |
| 11 | **Commercial model is live and honest** — Shuru signup, Growth quota/top-ups, Partner eligibility/bands, and payment replay guards match the server catalog | Apply migration `20260828_004_commercial_model`; smoke-test `/api/subscription/plans`, `/pricing`, a 100/500-conversation boundary, and a forged/replayed bKash callback | Eng |

### Gate 7 re-baseline — 2026-11-14 founder decision

The **pilot phase** requires **≥2 activated pilot shops** (2–5 merchants, per the
approved pilot plan), not 10. The **≥10 activated shops** threshold remains the
**GA bar** and is unchanged.

`EasyMod-backend/scripts/launch-readiness.js` still enforces the GA number
(`ACTIVATION_TARGET`, default `10`). The pilot waiver is **manual** and is not
encoded in that script; do not edit the code for the pilot phase.

## Informational (track, not blocking)

- **Retention** — how many activated shops transacted this week (`/api/analytics/growth` → `totals.retainedThisWeek` / `retentionRate`). Watch the week-1 → week-2 trend before spending on ads.
- **Activation speed** — `daysToActivation` per shop. A high number means onboarding friction.
- **Commercial conversion** — Shuru signups, Growth upgrades, top-up purchases, and Partner applications are recorded as funnel events; no annual or trial CTA should appear for new users.

---

## Human runbook — onboarding the 10 smoke-test shops

For each of the 10 pilot shops:

1. Sign up → the **Onboarding Wizard** opens automatically.
2. **Connect** the Facebook Page (wizard step 1).
   - Confirm the aggregate Meta identity-readiness diagnostic still has zero
     connected channels missing mappings.
3. Add 3–5 products (step 2).
4. Review shop profile delivery/payment defaults and keep AI mode on **DRAFT** for the first 7–14 days.
5. Send a test customer message and confirm an AI reply is produced.
   - This is what flips the shop to **Activated** (gate 7).

Then watch for one week:
- `npm run launch:check` shows activation climbing toward 10.
- The ops-alert channel stays quiet (gate 6).
- DLQ stays at 0 (gate 4).

---

## Shared Inbox attachment launch check

Run these on every initial-launch deploy before testing with real shops:

```bash
ssh root@130.210.21.100   # OCI production host; receipts: /api/version, /health/ready
cd /opt/easymod
docker compose --env-file .env.prod -f docker-compose.prod.yml config --volumes
docker volume ls | grep backend_uploads
df -h
docker system df
```

Expected:
- `backend_uploads` exists as a Docker named volume.
- Backend has `BASE_URL=https://api.easymod.tech`, `APP_URL=https://app.easymod.tech`, and `BODY_SIZE_LIMIT=35mb` in `/opt/easymod/.env.prod`.
- OCI host disk has enough free space for launch testing and pilot-shop attachments.
- Daily backup workflow archives both Postgres and `easymod-uploads-*.tar.gz`.

Then verify the live Shared Inbox flow with a Facebook Page tester:

1. Send an inbound Messenger DM from a roster tester account.
2. Reply with text; confirm customer receives it.
3. Reply with an image; confirm customer receives it and the message metadata URL opens over HTTPS.
4. Reply with a PDF/common file; confirm customer receives it and the metadata URL opens over HTTPS.
5. Force or observe an attachment failure; confirm failed/retry appears and retry sends a fresh outbound message.
6. Re-check the 24-hour window/tag behavior still blocks/allows correctly.
7. Open `/pricing` in English and Bengali. Confirm Shuru is free forever, Growth is ৳999/month for 500 conversations, Partner shows the delivered-order bands, and no trial/annual/overage claim appears.
8. Verify a Growth top-up uses `PACK_100`, `PACK_300`, or `PACK_700`; replaying the same callback does not credit twice, and a mismatched payment ID/amount is rejected.

---

## Sign-off

- [ ] Gate 1 — CI green on `main`
- [ ] Gate 2 — Infra up
- [ ] Gate 3 — DB + Redis + Qdrant healthy
- [ ] Gate 4 — DLQ empty
- [ ] Gate 5 — Canary fresh
- [ ] Gate 6 — Canary green 7 days, no ops alerts
- [ ] Gate 7 — ≥10 shops activated (GA bar); pilot phase: ≥2 activated pilot shops under the 2026-11-14 waiver
- [ ] Gate 8 — Alerting verified reaching a human
- [ ] Gate 9 — Shared Inbox upload volume + attachment round-trip verified
- [ ] Gate 10 — All connected pilot/reviewer Meta channels have valid identity mappings
- [ ] Gate 11 — Commercial model, quota, and payment replay smoke tests green

**Launch approved by:** ______________________  **Date:** ____________

---

## Post-cutover addenda (2026-11-14)

- DNS and TLS are now OCI-terminated: all five `easymod.tech` A records point at the
  OCI host `130.210.21.100` (Cloudflare, grey-cloud), and Caddy v2.11.3 issues and
  renews the five Let's Encrypt certificates with ACME HTTP-01.
- The nightly `Database Backup` waits on a manual `production` environment approval
  by `mr3826` every day. That is by design, not a stuck workflow.
- `production-watch.yml` provides scheduled uptime and certificate-expiry
  monitoring. Do not use `app.easymod.tech/health` as a probe; it returns SPA HTML
  200 for any path.
