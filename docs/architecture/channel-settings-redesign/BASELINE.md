# BASELINE — Business Profile & Channel Automation Redesign

Mission: establish Business / Channel / Conversation ownership end-to-end (prove → challenge → approve → implement → test → review → report).
Status at baseline: **Phase 0 complete, Phase 1 (evidence verification) in progress.**

## Repository state

| Item | Value |
|---|---|
| Repository | `mr3826/easymoderator` (monorepo; renamed from `easymoderator-monorepo` — `gh api` must use the new name) |
| Baseline commit | `8d477288594ce522d4c27a5cc8ed09bd8747456f` — `feat(commercial): Truth Gate + delivered-order billing (BDT 10/delivered order) (#256)` |
| Mission branch | `feature/channel-settings-redesign-20261114` |
| Mission worktree | `D:/easymod/_wt-channel-settings-20261114` (created from freshly fetched `origin/main`; clean at baseline) |
| Main checkout | `D:/easymod/easy-moderator` — left untouched on stale merged branch `fix/meta-all-pages-granular-authorization` (212 commits behind at recon; 0 ahead). Untracked developer files preserved: `EasyModerator_Merchant_Workspace_Brand_and_Action_First_UX_Addendum_v1.md`, `docs/ui-deployment-and-worktree-consolidation-v1/` |
| Other worktrees | 25 pre-existing worktrees preserved untouched (incl. `_wt-truth-gate-impl-20261114`, whose PR #256 landed during planning and moved `origin/main` from `c8ce4a84` → `8d477288`) |
| Drift policy | Re-verify `origin/main` SHA and code anchors at every phase boundary; rebase before the single final push |

## Frameworks

- **Backend** `EasyMod-backend/`: Node.js CommonJS, Express 4.22, Sequelize 6.37 over PostgreSQL, BullMQ 5 + ioredis (queues, cache, SSE pub/sub). Custom migration runner `src/database/migrate.js` (advisory lock 726573474, transactional, `{name, up, down}`, lexicographic `YYYYMMDD_NNN_slug.js`). Latest migrations at baseline: `20261114_001..003` (billing). Jest 30 suites: unit/security (`jest.config.js`, BullMQ stubbed), integration (`*.integration.test.js`, real PG16+Redis7), meta-e2e (real queue/worker; only Graph+LLM transports captured), quarantine (ceiling 2, non-gating).
- **Frontend** `EasyMod-frontend/`: React + Vite + Tailwind v4 + Radix/shadcn kit (`src/app/components/ui/`), i18next (bn default+fallback; en+bn literal keys enforced by `translation-coverage.test.ts`), react-query, sonner, motion/react. Vitest 4 (happy-dom) + Playwright 1.58.2 (mock-only CI specs; dev port 4273).
- **Other workspaces**: `EasyMod-growth` (gate triggered by any backend diff), `EasyMod-mobile` (standalone; out of scope), `EasyMod-extension`.
- **Node pin**: 20 (`.nvmrc`/engines). Mission runtime: `D:/easymod/_local-runtimes/node-v20.20.2/node.exe` (v20.20.2 verified). Machine default Node 25 must NOT be used for repo commands.

## Relevant modules

- Settings: `src/modules/shop/` (shop.service, ai-reply-mode, shop-defaults, shop-settings.validator), `src/modules/channel-providers/` (meta-channel entity/service/controller/routes/serializer, meta-channel-settings entity + runtime), `src/modules/knowledge/`.
- Runtime: `src/jobs/message-worker.js`, `burst-coalescer.js`, `message-queue.js`, `src/modules/policy/` (Outbound Policy engine + rules), `src/modules/ai/` (confidence-gate, action-gate, intent-router), `src/modules/conversation/` (handoff, ownership, delivery truth), `src/modules/integration/` (Meta webhook durability/resolver).
- Frontend surfaces: `BusinessInfoSettings.tsx`, `BusinessInfoForm.tsx`, `AISettingsForm.tsx`, `ChatSettings.tsx`, `SettingsHub.tsx`, `routes.ts`, `UnifiedInbox.tsx` + `inbox/*`, `api/domains/{shop,meta-channels,conversation}.ts`, `styles/theme.css`.
- Normative docs: `CONTRIBUTING-AI.md`, `docs/ai/AGENT_CONTRACTS.md`, `AGENT_ACTION_POLICY.md`, `CONVERSATION_RECOVERY_POLICY.md`, ADRs 0001–0012 (0003 governs reply-mode ownership; **0011/0012 landed in #256 — next free ADR = 0013**).

## Existing test coverage (redesign area)

- Backend unit: `shop/__tests__/ai-settings.test.js`, `ai-reply-mode.test.js`; `jobs/__tests__/message-worker.reply-mode.test.js` (mode flips, late pause, pre-delivery recheck, Page-cannot-override), `message-worker.grounding.test.js` (channel routing isolation); `channel-providers/__tests__/meta-channel.settings-contract.test.js` (top-level mode keys forbidden); `conversation/__tests__/human-handoff.test.js`, `conversation-ownership.test.js`; `ai/__tests__/confidence-gate.test.js`; security suite (tenant scope, route perimeter, AI mutation boundary).
- Integration: `customer/__tests__/mwv1-increment2.integration.test.js` (claim/force/cross-shop), order-confidence concurrency, queue-race precedents.
- Meta-e2e: `tests/meta-e2e/meta-e2e.test.js` (cross-shop Page isolation, Page-pinned conversations, two-Page reply-mode convergence; fixtures shopA=2 Pages, shopB=1 Page).
- Frontend: AISettingsForm.test (27), ChatSettings.test (24, incl. "no Page-level AI control" pin), BusinessInfoSettings/Form tests, UnifiedInbox.test (~30), CustomerContextPanel.test; e2e `ai-reply-mode.spec.ts` (Scenario B pins no per-Page toggle), `shared-inbox.spec.ts`, `mwv1-journeys.spec.ts` (not CI), `llm-settings.spec.ts` (not CI).
- CI: required contexts `PR Merge Gate` + `Security Scan` (gitleaks v8.28 full-history + npm audit high). Component jobs: Quality fast, frontend-e2e (6 specs + public funnel, ubuntu-24.04), meta-e2e, integration (migrate → schema:audit → tests), deployment-config, docker-build-validation, growth-os (any backend change). Mobile-ci protected-paths relaxed by ADR-0012 to reporting; mission still avoids `src/config/config.js`, `auth/`, `notification/`.

## Environment

- Windows 11; Git Bash + PowerShell 7; Docker Desktop 29.8.2 (daemon verified up); WSL2 Ubuntu present (not needed for test gates). No `jq` (use `gh --jq` / node).
- Disposable test stacks (Windows-safe Node wrappers): `npm run test:backend:integration:docker` (PG 55432/Redis 56379 per-pid), `test:backend:meta:e2e:docker` (55433/56380), `test:backend:migration-dryrun` (prod-shaped rehearsal). DB-name guard requires whole-word `test`/`e2e`.
- Dependencies: `npm ci` at worktree root with Node 20 (running at baseline write).

## Known environmental / production constraints

- Production = OCI host only; pilot authorization (2026-11-14) = shadow/manual DRAFT, flags OFF; prod has 0 messages / 0 orders ever; Meta Access Verification pending (deadline 2026-11-21) gates AI auto-reply enablement.
- **This mission ships plumbing, not enablement**: no deploy, no production migrations, no flag changes, nothing enables AUTO. Human gates per CONTRIBUTING-AI §3 respected.
- Git workflow (user standing preference): one clean worktree, local commits after fetching/merging `origin/main`, **single push + single PR at the end**; no `git stash`; preserve all worktrees; plain `gh pr merge` (no `--admin`).
- gitleaks full-history trap: no JWT-shaped test fixtures (use fake placeholders; allowlist entries require review).
- Tooling note: claude-mem observer authentication outage reported to founder at session start; native memory used for durable notes.

## Baseline corrections vs mission assumptions (verified)

1. Per-channel settings record **already exists** (`meta_channel_settings`, 1:1 with `meta_channels`): business hours + order-creation permission are enforced today; confidence thresholds are stored but runtime-dead; legacy Page mode columns are API-forbidden and runtime-excluded.
2. Worker send boundary is **already hardened**: fresh fail-closed mode reads at 4 checkpoints incl. inside the provider-boundary transaction with CAS; late-pause and mode-flip suppression unit-tested.
3. Inbox handoff (takeover/claim/force/assign/resume/resolve) is **already implemented**; gaps are reason recording on manual takeover, owner visibility, and a reason-display i18n bug.
4. ADR-0003 **explicitly rejected** business-default + Page-override; this mission supersedes it via ADR-0013 with an explicit-source resolver, not a silent reversal.
5. Emergency stop exists only as platform-admin `emergency-off` (sets business MANUAL, destroying prior mode). Merchant-facing stop and a distinct bypass-proof flag are new.
6. `origin/main` drifted mid-planning (#256): ADR numbering 0013, migrations `20261114_004/005`, worker/frontend anchors re-verified at `8d477288`.
