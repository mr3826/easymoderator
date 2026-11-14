# ADR-0012: Mobile Isolation Guard Allows Cross-Cutting Commercial PRs

Status: Accepted<br>
Date: 2026-11-14<br>
Owners: Engineering + Founder<br>
Amends: [ADR M-009](../mobile/adr/M-009-ci-isolation.md) (CI isolation) and [ADR M-013](../mobile/adr/M-013-release-signing.md) (release signing)

## Context

The mobile-program isolation boundary (`verify-mobile-protected-paths.js`) classified
any pull request touching `EasyMod-mobile/`, `docs/mobile/`, `EasyMod-backend/src/modules/auth/`,
`.../notification/`, `.../mobile/`, or `auth.middleware.js` as **mobile-relevant**, then
**hard-failed** if the same diff also touched `EasyMod-frontend/`, `EasyMod-growth/`, root
`package.json`/`package-lock.json`, infra files (`Dockerfile`, `docker-compose*`, `Caddyfile`),
or any non-mobile workflow.

The delivered-order Truth Gate (ADR-0011) is a cross-cutting commercial change. It legitimately
touches mobile-relevant backend contracts — the signup default subscription (`auth.test.js`),
merchant notification copy (`notification/`), and the native read-route allowlist
(`auth.middleware.js`) — **and** the frontend, Growth OS, root scripts, and `ci-cd.yml` in the
same change. The hard-fail therefore blocked a correct, founder-approved commercial PR. The
guard's own header noted that judging whether a backend change is additive "is a human
reviewer's job"; the structural veto could not express that judgment.

## Decision (founder-approved 2026-11-14)

The founder approved amending the guard so cross-cutting commercial PRs may touch
mobile-relevant backend contracts and frontend/growth/infra together.

- `verify-mobile-protected-paths.js` no longer **vetoes** the cross-cutting surfaces. The former
  `NEVER_TOUCH` hard-fail list becomes `CROSS_CUTTING_REVIEW`: matching paths are printed as a
  loud reviewer-attention warning, not a failure.
- The job still detects `mobile_relevant` (so the mobile proof runs for mobile-app changes) and
  `backend_touched`, and still warns when the isolation guards themselves change.
- **The hard mobile security boundary is unchanged.** It lives in the separate
  `isolation-guard` job (`verify-mobile-ci-isolation.js`): `mobile-ci.yml` holds no secrets, no
  deployment environment, no `workflow_dispatch`, no push-to-main trigger, no deploy/SSH/registry
  step, `permissions: contents: read` only; `mobile-release.yml` keeps the upload key in its
  signing step on main only and distributes nothing. That job is not weakened by this amendment.

## Rationale

Every surface removed from the hard-veto is already gated by its own **required** CI context:
frontend by `Quality fast` + `EasyModerator frontend Playwright`, Growth OS by the Growth OS
build/browser gates, infra by `Deployment configuration dry run` + `Docker build validation`,
secrets by `Security Scan`, and everything by `PR Merge Gate`. The mobile guard's unique role is
mobile-contract isolation and triggering the mobile proof — not vetoing changes that other
required gates already review line-by-line. Cross-cutting changes are surfaced for reviewer
attention rather than blocked.

## Consequences

- Cross-cutting commercial PRs that touch auth/notification and frontend/growth/infra are no
  longer structurally blocked; reviewers see an explicit cross-cutting warning listing the paths.
- Mobile-app changes still run the full mobile proof; the isolation-guard still hard-fails any
  attempt to give mobile CI secrets, a deploy environment, or a distribution side effect.
- This is a deliberate, founder-approved policy amendment recorded here — not a silent weakening
  of the guard to make a change pass.

## Rollback

Revert `verify-mobile-protected-paths.js` to the `NEVER_TOUCH` hard-fail form and supersede this
ADR. The isolation-guard job is independent and unaffected either way.