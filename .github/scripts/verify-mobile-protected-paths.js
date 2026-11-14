#!/usr/bin/env node
'use strict';

// Enforces the mobile-program isolation boundary (docs/mobile/CURRENT_STATE.md
// §15) on every pull request: non-mobile diffs report not-applicable, while a
// mobile-relevant diff runs the mobile proof and reports whether a consumed
// backend contract changed.
//
// ADR-0012 (founder-approved 2026-11-14, amending ADR M-009 / M-013): a
// cross-cutting commercial PR may legitimately touch mobile-relevant backend
// contracts (auth/, notification/, auth.middleware.js) AND frontend/growth/infra
// in the same change. Those surfaces are already reviewed by their own required
// CI contexts (PR Merge Gate, Quality fast, frontend Playwright, Growth OS gates,
// Security Scan, deployment-config dry run, Docker build validation), so this
// job REPORTS them for reviewer attention rather than vetoing them. The hard
// mobile security boundary remains the isolation-guard job (no secrets, no
// deploy environment, no registry push, no SSH, signing boundary) — that job is
// unchanged and must never be weakened.
// Dependency-free: only Node's built-in child_process and fs.

const { execSync } = require('child_process');
const fs = require('fs');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

sh('git fetch origin main --quiet');
const mergeBase = sh('git merge-base origin/main HEAD');
const diffOutput = sh(`git diff --name-only ${mergeBase} HEAD`);
const changedPaths = diffOutput.split('\n').filter(Boolean);

const MOBILE_RELEVANT = [
  /^EasyMod-mobile\//,
  /^docs\/mobile\//,
  /^EasyMod-backend\/src\/modules\/mobile\//,
  /^EasyMod-backend\/src\/modules\/auth\//,
  /^EasyMod-backend\/src\/modules\/notification\//,
  /^EasyMod-backend\/src\/middleware\/auth\.middleware\.js$/,
  /^EasyMod-backend\/src\/middleware\/mobile-client-context\.middleware\.js$/,
  /^EasyMod-backend\/src\/config\/config\.js$/,
  /^\.github\/workflows\/mobile-ci\.yml$/,
  /^\.github\/workflows\/mobile-production-proof\.yml$/,
  /^\.github\/scripts\/verify-mobile-(?:ci-isolation|protected-paths)\.js$/,
];

const mobileRelevant = changedPaths.some((p) =>
  MOBILE_RELEVANT.some((pattern) => pattern.test(p)),
);

// ADR-0012: surfaces a cross-cutting PR may change alongside mobile-relevant
// backend contracts. These are NOT vetoed here — each is gated by its own
// required CI context — but they are listed loudly so a reviewer reads them
// line-by-line rather than skimming the aggregate pass/fail.
const CROSS_CUTTING_REVIEW = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^Dockerfile/i,
  /docker-compose.*\.ya?ml$/i,
  /^Caddyfile/i,
  // Any workflow file except this program's own release/CI/proof workflows.
  /^\.github\/workflows\/(?!mobile-(?:ci|release|production-proof)\.yml$).+/,
  /^EasyMod-frontend\//,
  /^EasyMod-growth\//,
];

const crossCutting = changedPaths.filter((p) => CROSS_CUTTING_REVIEW.some((pattern) => pattern.test(p)));

console.log(`Changed paths relative to origin/main (${changedPaths.length}):`);
changedPaths.forEach((p) => console.log(`  - ${p}`));

console.log(`\nmobile_relevant=${mobileRelevant}`);

if (!mobileRelevant) {
  console.log('Mobile CI: not applicable for this diff; skipping mobile build/test jobs.');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'mobile_relevant=false\nbackend_touched=false\n');
  }
  process.exit(0);
}

if (crossCutting.length > 0) {
  console.warn('\n⚠ Cross-cutting change (ADR-0012) — review these alongside their owning CI gates, not just the aggregate pass/fail:');
  crossCutting.forEach((p) => console.warn(`  - ${p}`));
}

// Not a hard failure — the mobile program legitimately needs to be able to
// fix and extend its own CI tooling — but a change to the isolation guards
// themselves is exactly the kind of diff a reviewer should read line-by-line
// rather than skim, so it's called out loudly here instead of silently
// passing alongside everything else.
const guardFilesTouched = changedPaths.filter(
  (p) => /^\.github\/workflows\/mobile-(?:ci|release)\.yml$/.test(p) || p.startsWith('.github/scripts/'),
);
if (guardFilesTouched.length > 0) {
  console.warn('\n⚠ This diff changes the isolation guard(s) themselves — review these line-by-line, not just the aggregate pass/fail:');
  guardFilesTouched.forEach((p) => console.warn(`  - ${p}`));
}

const backendTouched = changedPaths.some((p) =>
  p.startsWith('EasyMod-backend/') && MOBILE_RELEVANT.some((pattern) => pattern.test(p)),
);
console.log(`\nbackend_touched=${backendTouched}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mobile_relevant=${mobileRelevant}\nbackend_touched=${backendTouched}\n`,
  );
}
