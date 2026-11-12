# Public Repository Hardening — 2026-11-11

**Repository:** `mr3826/easymoderator-monorepo` (public since 2026-11-11)
**Baseline:** `origin/main` @ `47f442edecc4074a3c4f51da4e3348986d22a418`
**Scope:** repository security feature enablement, dependency-update coverage,
proprietary license notice, full-history secret-scan receipt, and fork/PR
threat model.

This document records what was actually verified. It deliberately contains no
secret values.

---

## 1. GitHub security features

### Before

`GET /repos/mr3826/easymoderator-monorepo`:

```json
{
  "dependabot_security_updates":           { "status": "disabled" },
  "secret_scanning":                       { "status": "disabled" },
  "secret_scanning_non_provider_patterns": { "status": "disabled" },
  "secret_scanning_push_protection":       { "status": "disabled" },
  "secret_scanning_validity_checks":       { "status": "disabled" }
}
```

### Requested

A single `PATCH /repos/mr3826/easymoderator-monorepo` was sent with:

```json
{
  "security_and_analysis": {
    "secret_scanning":                       { "status": "enabled" },
    "secret_scanning_push_protection":       { "status": "enabled" },
    "secret_scanning_non_provider_patterns": { "status": "enabled" },
    "dependabot_security_updates":           { "status": "enabled" }
  }
}
```

The request returned HTTP 200 (no 403/404). `secret_scanning_validity_checks`
was intentionally **not** requested and remains disabled.

### After (GET-verified)

```json
{
  "dependabot_security_updates":           { "status": "enabled" },
  "secret_scanning":                       { "status": "enabled" },
  "secret_scanning_non_provider_patterns": { "status": "disabled" },
  "secret_scanning_push_protection":       { "status": "enabled" },
  "secret_scanning_validity_checks":       { "status": "disabled" }
}
```

| Setting | Result |
|---|---|
| Dependabot security updates | **enabled** |
| Secret scanning | **enabled** |
| Secret scanning push protection | **enabled** |
| Secret scanning non-provider patterns | **NOT applied** — accepted with HTTP 200 but the resulting state remains `disabled` |
| Secret scanning validity checks | left disabled by design |

**Non-provider patterns detail:** a second, targeted PATCH containing only
`secret_scanning` and `secret_scanning_non_provider_patterns` also returned
HTTP 200 and again left the setting `disabled`. GitHub surfaced no error. This
is consistent with the setting not being entitled on the repository's current
plan (non-provider/generic patterns are generally part of the paid GitHub
Secret Protection capability). It was not retried further. **Decision needed:**
confirm the plan entitlement; if available, enabling it would extend coverage
to custom/generic secret formats.

---

## 2. Full-history secret-scan receipt

Workflow `Security Scan` was dispatched against `main`:

```
gh workflow run "Security Scan" -R mr3826/easymoderator-monorepo --ref main
```

| Field | Value |
|---|---|
| Run | https://github.com/mr3826/easymoderator-monorepo/actions/runs/42990510601 |
| Event / ref | `workflow_dispatch` / `main` |
| Head SHA | `47f442edecc4074a3c4f51da4e3348986d22a418` |
| Conclusion | **success** |
| `Historical secret scan` (gitleaks) | **success** |
| `Production dependency audit` | **success** |
| Findings | **none** — gitleaks logged `no leaks found` |

The gitleaks job scans all refs and history
(`--log-opts="--all"`) with `--redact`, using the pinned image
`zricethezav/gitleaks@sha256:cdbb7c95…` and the repository's `.gitleaks.toml`.
Because the job succeeded, there were no redacted findings to report. The
dependency audit runs `npm audit --workspaces --include-workspace-root
--omit=dev --audit-level=high` and also passed.

Receipt status: **clean**. No exposed-secret finding was produced by this scan.

Caveat: gitleaks is pattern-based. It does not prove that no sensitive-but-
unrecognized data (internal URLs, customer data, non-standard credential
formats) exists in history. See residual risks.

---

## 3. Dependabot coverage

`package.json` declares npm workspaces `EasyMod-backend`, `EasyMod-frontend`,
and `EasyMod-growth`. Inventory of real manifest/lockfile locations:

| Location | Manifest | Lockfile | Consumed by |
|---|---|---|---|
| `/` | `package.json` | `package-lock.json` (v3, workspace root) | CI `npm ci`, workspace installs |
| `/EasyMod-backend` | `package.json` | `package-lock.json` (v3) | `EasyMod-backend/Dockerfile` build context |
| `/EasyMod-frontend` | `package.json` | `package-lock.json` (v3) | `EasyMod-frontend/Dockerfile` build context |
| `/EasyMod-growth` | `package.json` | `package-lock.json` (v3) | `EasyMod-growth/Dockerfile` build context |
| `/EasyMod-mobile` | `package.json` | `package-lock.json` (v3) | mobile CI/release, not a root workspace |
| `/EasyMod-extension` | none | none | plain scripts/tests only |

`.github/dependabot.yml` therefore declares **five npm entries** — `/`,
`/EasyMod-backend`, `/EasyMod-frontend`, `/EasyMod-growth`, and
`/EasyMod-mobile` — each `interval: weekly` with
`open-pull-requests-limit: 0`.

Rationale for `open-pull-requests-limit: 0`: GitHub's current documentation
states that setting the option to zero lets you disable **version** updates for
that package manager, while security updates are "subject to a separate, fixed
limit of 10 open pull requests" that "cannot be configured using
`open-pull-requests-limit`." This matches the founder's chosen posture:
security fixes only, no routine version-bump PRs. Security-update PRs are
driven by the Dependabot security updates repo setting enabled in section 1.

Follow-up decision: the sub-workspace lockfiles duplicate the root dependency
graph. With version updates disabled the practical impact is limited to possible
duplicate security PRs for the same advisory across `/` and a workspace entry.
Confirm behavior after the next advisory. If routine version maintenance is
later wanted, raise the limit to 5 and accept version-update PRs.

---

## 4. License notice

`LICENSE` was added with a short proprietary notice:

- Copyright © 2026 EasyModerator / mr3826. All rights reserved.
- No license, express or implied, to reproduce, redistribute, sublicense, or
  create derivative works.
- Public visibility does not make the repository open source.
- GitHub-platform forking is permitted only as necessary to use GitHub's
  service; forks remain subject to the notice.
- Standard "AS IS" warranty disclaimer.

This is **not** an open-source license and grants no rights beyond GitHub's
Terms of Service.

---

## 5. Fork / PR threat model

Evidence below is from the workflows at baseline `47f442ed` in
`_wt-baseline-47f442ed/.github/workflows` (read-only inspection).

### 5.1 `pull_request_target`

**None.** `grep -rn "pull_request_target" .github/workflows/` returned zero
matches. No workflow runs with a privileged base-repo token while checking out
untrusted PR code.

`pull_request` is used only by:

- `.github/workflows/ci-cd.yml:35`
- `.github/workflows/mobile-ci.yml:32`
- `.github/workflows/security-scan.yml:6`

### 5.2 PR jobs that checkout PR code and touch secrets

The only PR-reachable job that references production secrets is `ci-cd.yml`'s
`deployment-config` job (starts at line 442). It checks out the PR head, but the
secret-bearing step is explicitly gated:

- `.github/workflows/ci-cd.yml:505` — comment: "Never expose repository secrets
  to forked pull requests; the synthetic contract step above remains the
  PR-safe validation."
- `.github/workflows/ci-cd.yml:507` —
  `if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'`

On every `pull_request` event that step is skipped; only synthetic values are
used. All other PR jobs (`changes`, `test`, `frontend-e2e`, `meta-e2e`,
`integration`, `docker-build-validation`, `pr-merge-gate`) reference no
`secrets.*` at all.

### 5.3 Release and deploy path

- `release.yml` is **main-push or manual-dispatch only**
  (`.github/workflows/release.yml:8-10` push to `main`, `:22`
  `workflow_dispatch`). It calls `ci-cd.yml` at `:90` and passes
  `secrets: inherit` at `:103`; because it has no `pull_request` trigger, PRs
  cannot enter this path.
- The image-publishing job in `ci-cd.yml` is main-only:
  `github.event_name != 'pull_request'` at `:871`, with `packages: write`
  scoped to that job at `:868`.
- Production deploy (`ci-cd.yml:962-983`) requires **all** of:
  - `needs.build.result == 'success'`
  - `github.event_name == 'workflow_dispatch' || 'workflow_call'`
  - `github.ref == 'refs/heads/main'`
  - `vars.PRODUCTION_DEPLOY_ENABLED == 'true'`
  - `inputs.deploy_confirmation == format('DEPLOY-{0}', github.sha)`
  - `environment: production` (`:983`) — environment protection rules /
    reviewer approval (mr3826).
- `mobile-release.yml` is main-push/manual only (`:11-19`) and binds the signing
  keystore to the protected `mobile-release` environment (`:39`).
- `mobile-production-proof.yml` is manual-only (`:16`) and binds to
  `environment: production` (`:52`).
- All other secret-using workflows (`backup`, `grant-*`, `purge-test-account`,
  `qdrant-migration`, `run-growth-importer`, `seed-*`,
  `backfill-product-attributes`, `meta-canary-log-recovery`,
  `semantic-embedding-calibration`) are `workflow_dispatch`-only and, where
  they touch production, use `environment: production`.

### 5.4 GITHUB_TOKEN permissions

Every one of the 19 workflows declares a top-level `permissions:` block. The
minimum is `contents: read`. Write scopes visible:

- `ci-cd.yml:866-868` — build job: `contents: read`, `packages: write`
  (main-only).
- `growth-os.yml:60-62` — workflow level: `contents: read`, `packages: write`;
  the PR-callable jobs narrow to `contents: read` at `:79` and `:126`, and the
  publishing job is gated to main push/dispatch at `:218` with `push: true` at
  `:238`.
- `release.yml:80-83` — `contents: read`, `packages: write`,
  `pull-requests: read` (main-only caller).

No workflow grants `contents: write`, `actions: write`, or `id-token: write`.
No PR-reachable job has a write-scoped token.

### 5.5 Capability summary

A malicious fork PR **can** reach:

- Compute on GitHub-hosted runners, executing its own PR-head code through the
  PR validation jobs (`test`, `meta-e2e`, `frontend-e2e`, `integration`,
  `docker-build-validation`, Growth `verify`/browser-E2E, `mobile-ci`).
- A read-only `GITHUB_TOKEN` limited to repository contents.
- Its own job logs/artifacts, and outbound network from the runner. It can
  consume Actions minutes.
- Workflow definitions are taken from the **base** branch for `pull_request`,
  so a fork cannot change what CI runs until its change is merged.

A malicious fork PR **cannot** reach:

- Repository or organization secrets. GitHub withholds them from fork PRs, and
  no PR-reachable step is ungated. Same-repository PR branches also do not
  reach the production-secret step because of the `event_name !=
  'pull_request'` condition.
- The `production` environment, its approval gate, or any deploy/rollback job.
- DigitalOcean (`DO_TOKEN`, SSH keys, droplets), OCI, Spaces/backup keys,
  AI provider keys (`OPENAI_API_KEY`, Gemini), payment credentials (bKash),
  Meta app secret, Telegram/Resend/Sentry/Slack credentials.
- GHCR write or image publication (`docker-build-validation` uses `push:
  false`; the publishing job is main-only).
- The Android upload keystore (`mobile-release` environment, main-only).

---

## 6. Residual risks

1. **Non-provider secret patterns are not active.** Custom/generic credential
   formats are not scanned. Confirm entitlement and enable if available.
2. **Validity checks remain disabled** by explicit founder instruction. This is
   intentional; revisit if GitHub makes them free.
3. **No scheduled scan.** `security-scan.yml` currently triggers on `push` to
   `main`, `pull_request`, and `workflow_dispatch` only — there is no `schedule:`
   cron. History and dependencies are therefore only re-scanned on commits or
   manual runs.
4. **No CodeQL / code scanning workflow.** GitHub code scanning is free for
   public repositories, but no CodeQL workflow exists. Given the founder's
   "enable available free scanners" disposition, this is the main remaining
   free-scanner gap.
5. **No version-update PRs.** With `open-pull-requests-limit: 0`, routine
   upgrades rely on the team; only vulnerability-driven security updates will
   open PRs.
6. **Duplicate security PRs possible** across the root and sub-workspace npm
   entries. Low impact because version updates are off.
7. **Actions cache / runner abuse.** Fork PRs can consume runner minutes and
   populate npm caches keyed by lockfile hash. No secrets are cached. Consider
   keeping "Require approval for first-time contributors" enabled in Actions
   settings (verify current setting).
8. **Historical non-secret sensitive data.** A clean gitleaks result does not
   rule out internal URLs, customer data, or non-standard credential formats in
   public history.
9. **Local environment hygiene.** The founder's local `~/.oci/config`
   reportedly stores an OCI key passphrase in plaintext. This file is outside
   the repository and no value was read or recorded. Recommend moving the
   passphrase to an OS keychain/secret store or re-issuing the key without a
   plaintext passphrase store.
10. **Token scope limits.** The authenticated `gh` token has
    `gist`, `read:org`, `repo`, and `workflow` scopes. It cannot read billing
    endpoints or change organization-level security settings, so those were not
    verified.

---

## 7. Recommended next actions

1. Confirm whether `secret_scanning_non_provider_patterns` is entitled on the
   current plan; enable it if so.
2. Add a weekly `schedule:` trigger to `security-scan.yml` so the full-history
   scan runs without a push.
3. Add a CodeQL workflow (free for public repositories) for JavaScript/
   TypeScript, and let it run on PRs and `main`.
4. Verify in **Settings → Code security** that Dependabot alerts are on and
   that the first security update produces PRs; inspect for duplicate
   root/workspace PRs.
5. Verify workflow-run approval policy for first-time contributors and consider
   restricting which workflows run on forks.
6. Remediate the local OCI config passphrase handling (out of repo).
7. Consider enabling GitHub private vulnerability reporting for a public
   disclosure path.
8. Do not weaken branch protection/rulesets: `main` remains PR-required with
   CI checks and no bypass.