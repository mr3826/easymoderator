# 08 — Founder authorization package (one consolidated response)

> **Authorization recorded 2026-11-14.** The founder replied "approve all as recommended" to the table below. The answer column and the checkboxes point to the dated section at the end of this file, **which is the authoritative record**; the 2026-10-30 body is preserved as history, not as current state. Read the "2026-11-14 — Founder authorization record" section before acting on anything above it.

**What is now true (each item links to reproducible receipts):**

1. A founder-accessible authenticated preview exists on the founder's own machine: `https://127.0.0.1:54680` (loopback only, self-signed cert, synthetic merchants `closure.{a,b}.owner@ops.easymod.test`, password in the external ops-browser.env). Sign-in, Inbox/Customers/Orders data, cross-tenant denial (404), and a truthful `FEATURE_DISABLED` action-queue were all verified from the Windows host on 2026-10-30 (`01`; `preview-walkthrough-20261030.json`). Nothing was published beyond loopback; no auth/cookie policy was weakened.
2. The artifact that *would* be promoted is fully identified locally (`02`): source `04b07134…` byte-verified twice, image `3367c27e…` runtime self-reporting the same SHA. **What is NOT available:** the immutable digest of the currently deployed image — it exists only in `/opt/easymod/deployment-metadata.json` (and GHCR history). Rollback compatibility therefore stays unproven and the release gate stays blocked until the owner reads that file (one command, digests only, no secrets).
3. The alert pipeline demonstrably delivers to a destination (`03`): synthetic fault → durable receipt → hash-only destination receipt (`a6200c44…`) → reconciler recovery → cleanup, all inside the isolated no-egress stack, zero external calls, zero paid inference. Production destination + named human ack are still missing by design — that is decision D-3.
4. Every production-risk mutation surface is fail-closed at source, strict-literal, test-pinned, and was re-verified in the candidate code itself (`04`) — including the corrected photo-matching default (now OFF, `vision-policy.service.js:40`).
5. The complete Trivy scan (vulnerability + secret + misconfiguration) that previously timed out is now finished (`05`): zero HIGH/CRITICAL everywhere; one MEDIUM (`qs` 6.16.0, fix 6.16.1 available) needs a one-line owner disposition.
6. Prior completed gates (Product Engine, Pilot+, Merchant Workspace, integration, deployment rehearsal, operational-gate closure incl. 32/225 integration, full suites, meta E2E, backup/restore, worker recovery) remain valid and were not re-run without reason; today's additional re-passes (authenticated journeys on the fresh DB) exist because the preview/DB reset changed runtime state.

**What only the founder can supply — answer as one record:**

| # | Item | Recommendation | Blocks pilot? | Your answer |
|---|---|---|---|---|
| 1 | D-1 cohort + thresholds | One opted-in shadow/manual shop, flags OFF, measured stop conditions | YES | ☑ 2–5 pilot merchants; flags OFF; AI reply DRAFT 7–14 days; stop on DLQ>0 / send-dedupe>0 / canary stale — approved 2026-11-14, see record below |
| 2 | D-2 Meta console current state | Confirm Human-Agent eligibility + email/support/data-deletion URLs | YES for AI modes | ☑ App Live + Advanced Access confirmed; Tech Provider Access Verification **still pending** (due 2026-11-21); support-email/dashboard drift to fix — approved 2026-11-14, see record below |
| 3 | D-3 alert channel + on-call | Name them; run test-alert; human ack recorded | YES | ☑ GitHub Actions notifications (`production-watch.yml` hourly probes); founder as on-call; test-alert human ack **OPEN** — approved 2026-11-14, see record below |
| 4 | D-4 kill-switch operators | Named per level; two-person rule on global mutation flags | YES | ☑ Founder sole operator per level; two-person rule on global mutation flags **deferred to GA** — approved 2026-11-14, see record below |
| 5 | D-5 mobile photo scope | Accept URL-paste photo-draft (working end-to-end at candidate); exclude camera-file upload; mobile API is production-live since 2026-09-26 (`04`, `06`) | No | ☑ URL-paste photo-draft accepted; camera-file upload excluded — approved 2026-11-14, see record below |
| 6 | D-6 UX debt acceptance | Defer with Inbox guarantees pinned as release condition | No | ☑ Deferred, with Inbox guarantees pinned as release condition — approved 2026-11-14, see record below |
| 7 | D-7 auto-booking stance | Keep OFF, manual dispatch | No (safe default) | ☑ Auto-booking stays OFF; manual dispatch — approved 2026-11-14, see record below |
| 8 | Image-transfer condition | Keep photo matching OFF; approve provider terms before any enablement | YES for photo features | ☑ Photo matching stays OFF; provider terms required before any enablement — approved 2026-11-14, see record below |
| 9 | `qs@6.16.1` disposition | Ship bump increment before deploy (recommended) | Low risk either way | ☑ Already resolved — `qs` 6.16.2 is shipped — approved 2026-11-14, see record below |
| 10 | Droplet digest read (or delegate) | `deployment-metadata.json` digests → unblocks rollback proof | YES for release (rehearsal-only pilot unaffected if deploy path stays blocked) | ☑ Read from the OCI host 2026-11-14 ~02:50Z via delegated SSH — approved 2026-11-14, see record below |
| 11 | Preview walkthrough | Founder login on item-1 URL closes B-1 | Confirmatory | ☑ Superseded — sign in at `https://app.easymod.tech`; the founder sign-in itself is an **OPEN** confirmatory follow-up — approved 2026-11-14, see record below |

**Superseded annotations (2026-11-14). The 2026-10-30 body above is kept as history; these pointers say which of its statements no longer describe current state:**

- **Paragraph 1 and row 11 — loopback preview is stale.** The 2026-10-30 preview at `https://127.0.0.1:54680` was a migration-era artifact; the founder walkthrough is replaced by sign-in at production `https://app.easymod.tech` (row 11, record below).
- **Row 2 — "Human-Agent eligibility not established" is answered.** The 2026-11-14 console inspection recorded below supersedes it: app Live, Advanced Access confirmed, Tech Provider Access Verification pending to 2026-11-21.
- **Paragraph 2 — the local candidate `04b07134` and the unread deployed digest are superseded.** Production is OCI `d427f143`; the deployed digests were read from the OCI host on 2026-11-14 (row 10 and the record below). Rollback rehearsal remains a separate, ungranted action.
- **Paragraph 5 — the `qs` 6.16.0/6.16.1 disposition is discharged.** `qs` 6.16.2 is shipped (row 9, record below).
- **The DigitalOcean droplet this package was written against is destroyed.** DO was fully exited on 2026-11-14 (droplet destroyed; Spaces bucket, keys and backups deleted). OCI `130.210.21.100` is the only production; every remaining "droplet" reference in this package is historical.
- **Row 1's Recommendation column ("one opted-in shadow/manual shop") is superseded** by the approved D-1 cohort of 2–5 pilot merchants.
- **The "If all blocking items are signed" paragraph is superseded by the 2026-11-14 record.** `TECHNICAL_PILOT_READINESS=GO_PENDING_FOUNDER_AUTHORIZATION` is no longer the current token: the recorded state is **GO for shadow/manual DRAFT operation only, with flags OFF**. The D-3 channel and on-call are now named (GitHub Actions notifications; founder), but the human test-alert ack is still **OPEN**, so "with D-3 monitoring live" is not accurate. The "If any remain unverified → `NO_GO_WITH_EXACT_BLOCKERS`" branch is not bypassed silently: the open items it would list are carried in the "Open follow-ups" table below and in the 2026-11-14 record.

**If all blocking items are signed:** `TECHNICAL_PILOT_READINESS=GO_PENDING_FOUNDER_AUTHORIZATION` becomes the recorded state and the pilot proceeds only as shadow/manual, flags OFF, with D-3 monitoring live, on the promotion procedure pre-staged in `02` (still requiring the separate `DEPLOY-<SHA>` confirmation gate).
**If any remain unverified:** the recorded state stays `NO_GO_WITH_EXACT_BLOCKERS` with the unmarked rows above as the exact list.

Nothing in this package authorizes a push, merge, deploy, production flag change, merchant selection, provider spend, or image-data transfer. Those all remain separate explicit actions.

## 2026-11-14 — Founder authorization record

**Approval (verbatim).** On 2026-11-14, in the Claude Code session, the founder replied to this decision sheet with the single sentence **"approve all as recommended"**. That reply is the entire authorization — nothing wider is granted by it.

**Relationship to the body above.** This section is the authoritative record of the answers. The "Your answer" column and checkboxes above are pointers to this section, not independent restatements. This is a documentation record only: it was filed without any push, merge, deploy, flag change, merchant selection, provider spend or image transfer.

### D-1 — pilot cohort and thresholds — APPROVED

- Cohort: **2–5 pilot merchants** (the founder's earlier explicit choice; the "one opted-in shadow/manual shop" recommendation above is superseded).
- Pilot flags **OFF**.
- AI reply mode **DRAFT** for **7–14 days**.
- Stop conditions: **DLQ>0**, **send-dedupe>0**, or **canary stale**.
- **Open:** merchant selection itself remains a separate explicit action and is **not** granted by this record.

### D-2 — Meta console state — APPROVED

- App **Live** + **Advanced Access** confirmed.
- **Tech Provider Access Verification STILL PENDING — deadline 2026-11-21.**
- Support-email / dashboard drift to fix.
- **Gate that stays:** AI auto-reply modes remain gated until Access Verification clears; the pilot runs **DRAFT / manual**.

### D-3 — alert channel and on-call — APPROVED

- Alert channel: **GitHub Actions notifications** (`production-watch.yml` hourly probes).
- Named on-call: **founder**.
- **Open operational step:** the **test-alert human ack has not been performed yet**. It is open, not waived.

### D-4 — kill-switch operators — APPROVED

- **Founder as sole operator per level** (pre-launch team of one).
- The **two-person rule on global mutation flags is explicitly DEFERRED to GA** — a founder-accepted deviation, recorded so it is not mistaken for an oversight.

### D-5 — mobile photo scope — APPROVED

- Accept the **URL-paste photo-draft** path.
- **Exclude camera-file upload** from pilot scope.

### D-6 — UX debt — APPROVED

- **Defer** the UX debt, with the **Inbox guarantees pinned as a release condition**.

### D-7 — auto-booking — APPROVED

- **Keep OFF**; **manual dispatch** (matches live production).

### Item 8 — image-data transfer — APPROVED

- **Photo matching stays OFF.**
- **Provider terms must be approved before any enablement.** No image transfer is authorized by this record.

### Item 9 — `qs` disposition — ALREADY RESOLVED

`qs` **6.16.2** is shipped — `EasyMod-backend/package.json` line 109, and `EasyMod-backend/package-lock.json` — past the 6.16.1 fix that the 2026-10-30 scan asked for. **No action needed.** This discharges the `qs` 6.16.0/6.16.1 text in paragraph 5 and row 9 above.

### Item 10 — deployed image digests — READ (matches `06` item 10)

Read from the OCI host `/opt/easymod/deployment-metadata.json` on **2026-11-14 ~02:50Z** via delegated SSH (the founder-approved recommendation included reading or delegating the read). Verbatim block:

```text
DEPLOYED_COMMIT d427f1431c68f6c16a398daa223961f3a0a28dd8
BACKEND ghcr.io/mr3826/easymoderator-backend@sha256:e683f3234f249926e71097231ce6d13a778a56f9642b3a47e2f785ed8c1455f9
FRONTEND ghcr.io/mr3826/easymoderator-frontend@sha256:2fa813a7e011304c2ca9328316cc115a757c57f7581d0c538c7c17b4436595f5
GROWTH ghcr.io/mr3826/easymoderator-growth-os@sha256:4d0ceebc579ac5e7ed44144861fbf9206d823996f13baf78e75823c6c2bc5b22
PREVIOUS_BACKEND sha256:b8d9abc50826104237e4eec145549a6eed9d4be762bd0308c36cb703530b2d7a
PREVIOUS_FRONTEND sha256:a0c573105aca26c64dac7f2b681c744c5428d9b6fb7fa4f8c38fc9c193d60e09
PREVIOUS_GROWTH sha256:4d0ceebc579ac5e7ed44144861fbf9206d823996f13baf78e75823c6c2bc5b22
WORKFLOW_RUN_ID 43543879447
DEPLOYED_AT 2026-11-14T02:14:23Z
```

The addresses above are the OCI host's file, not a droplet path: the pre-migration `02` reference to a droplet-resident `deployment-metadata.json` is superseded (see the annotations above).

### Item 11 — preview walkthrough — SUPERSEDED (matches `06` item 11)

The 2026-10-30 loopback preview is **stale**. Production is live at **`https://app.easymod.tech`** on OCI; the founder sign-in there replaces the loopback walkthrough.

### Production truth at authorization (2026-11-14)

- **OCI `130.210.21.100` is the only production**; deployed commit `d427f143` (PR #252: ACME contact email + PING-verified Redis readiness) via protected run `43543879447`.
- `main` is `79743ded` (docs PR #253).
- **DO fully exited:** droplet destroyed; Spaces bucket, keys and backups deleted 2026-11-14.
- `launch:check` **5/6** — the remaining item is the activation gate, pilot-pending.
- Meta-review merchant seeded on OCI (run `43538146002`).
- Mobile API proof green at `d427f143` — 50 checks: 47 pass / 0 fail / 3 benign skips. Device proof pending a re-signed artifact (mobile-release run `43546632124` in flight).
- Canonical running-state reference: `docs/launch/PRODUCTION_TRUTH.md`.

### Recorded state after signing (2026-11-14)

- **Pilot GO for shadow/manual DRAFT operation with flags OFF.**
- **AI auto-reply and photo features remain gated** — D-2 Tech Provider Access Verification (due 2026-11-21) and item 8 provider terms.
- **No** deploy, merge/push, production flag change, merchant selection, provider spend, or image transfer is authorized by this record. The package constraint above stands unchanged.

### Open follow-ups (not closed by this record)

| # | Follow-up | Status | Owner | Due |
|---|---|---|---|---|
| D-1 | Merchant selection (2–5 pilot merchants) | **Separate explicit action**, not granted here | Founder | Before pilot start |
| D-2 | Tech Provider Access Verification | **PENDING**; AI auto-reply stays gated until it clears | Founder / Meta app admin | 2026-11-21 |
| D-2 | Support-email / `support_url` / `data_deletion_url` drift remediation | **OPEN** — approved fix, not yet performed | Founder / Meta app admin | Against the 2026-11-21 Access Verification deadline |
| D-3 | Test-alert human acknowledgment | **OPEN** — not yet performed | Founder | Before first merchant traffic |
| D-3 | Written escalation contact | **OPEN** — founder on-call named; escalation path not yet written | Founder | Before first merchant traffic |
| D-4 | Two-person rule on global mutation flags | **DEFERRED to GA** (accepted deviation) | Founder | GA |
| D-4 | One rehearsed production-side flag flip | **OPEN** — not yet performed | Founder | Before first merchant traffic |
| Item 8 | Provider image-transfer terms | **Not approved**; photo matching stays OFF | Product / release owner | Before any photo enablement |
| B-1 | Founder production sign-in at `https://app.easymod.tech` | **OPEN** — confirmatory replacement for the loopback walkthrough; closes B-1 | Founder | Before first merchant traffic |
| B-4 | Effective production env capture | **OPEN** — redacted `printenv` capture not yet recorded | Founder / ops owner | Before pilot sign-off |
| Mobile | Device proof re-run against the re-signed artifact (mobile-release run `43546632124`) | **OPEN** — was in flight at authorization | Founder | Before pilot start |
