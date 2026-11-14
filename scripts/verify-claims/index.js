#!/usr/bin/env node
'use strict';

/**
 * verify:claims — the commercial truth gate.
 *
 * Six independent checks, each failing the process (exit 1) with an actionable
 * report:
 *
 *   (a) tokens      forbidden retired copy in the four modules + root scripts
 *   (b) retired     uppercase SHURU/GROWTH/PARTNER plan codes outside compat paths
 *   (c) registry    every rendered claim resolves to a CLAIM_REGISTRY id
 *   (d) evidence    every evidence flag has a resolvable authority / doc pointer
 *   (e) snapshot    contractHash / registryHash / token ids match both receipts
 *   (f) collateral  committed one-pager matches the contract render
 *
 * Dependency-free (node builtins only) so the PR merge gate can run it without
 * `npm ci`. It requires the pure backend contract/registry/evidence modules
 * through a relative path.
 *
 * Exit codes: 0 all selected checks pass; 1 a check failed; 2 usage/internal
 * error.
 */

const path = require('path');

const { REPO_ROOT, inScanScope, listTrackedFiles, normalize } = require('./lib/repo');
const { scanTokens } = require('./lib/token-scan');
const { scanRetiredIdentifiers } = require('./lib/retired-identifiers');
const { checkRegistry } = require('./lib/registry-check');
const { checkEvidence } = require('./lib/evidence-check');
const { checkSnapshots } = require('./lib/snapshot-check');
const { checkCollateral } = require('./lib/collateral-check');

const CHECK_ORDER = Object.freeze(['tokens', 'retired', 'registry', 'evidence', 'snapshot', 'collateral']);

const USAGE = `verify:claims — commercial truth gate

Usage: node scripts/verify-claims/index.js [options]

Options:
  --scan-root <dir>       discover files under <dir> (default: repository root)
  --only <list>           comma-separated subset of: ${CHECK_ORDER.join(', ')}
  --update-snapshots      regenerate both snapshot receipts and the one-pager
  --strict                treat warnings (e.g. missing claims.* locale keys) as failures
  --worklist              report forbidden-token violations as a Phase-2 worklist
                          instead of failing the build (tokens check only)
  --json                  machine-readable report
  --quiet                 suppress per-violation lines (summary only)
  --help                  show this text

Exit codes: 0 pass, 1 check failed, 2 usage/internal error.`;

function usageError(message) {
    const error = new Error(message);
    error.usage = true;
    return error;
}

function parseArgs(argv) {
    const opts = {
        scanRoot: REPO_ROOT,
        only: null,
        update: false,
        strict: false,
        worklist: false,
        json: false,
        quiet: false,
        help: false,
    };
    const takeValue = (arg, index) => {
        const inline = arg.indexOf('=');
        if (inline !== -1) return arg.slice(inline + 1);
        const next = argv[index + 1];
        if (!next || next.startsWith('--')) throw usageError(`${arg} requires a value`);
        return next;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--strict') opts.strict = true;
        else if (arg === '--update-snapshots' || arg === '--update') opts.update = true;
        else if (arg === '--worklist' || arg === '--tokens-report-only') opts.worklist = true;
        else if (arg === '--json') opts.json = true;
        else if (arg === '--quiet') opts.quiet = true;
        else if (arg === '--scan-root' || arg === '--root' || arg.startsWith('--scan-root=') || arg.startsWith('--root=')) {
            const value = takeValue(arg, index);
            if (arg.indexOf('=') === -1) index += 1;
            opts.scanRoot = path.resolve(value);
        } else if (arg === '--only' || arg.startsWith('--only=')) {
            const value = takeValue(arg, index);
            if (arg.indexOf('=') === -1) index += 1;
            const only = value.split(',').map((part) => part.trim()).filter(Boolean);
            if (only.length === 0) throw usageError('--only requires at least one check name');
            const unknown = only.filter((key) => !CHECK_ORDER.includes(key));
            if (unknown.length) throw usageError(`unknown check(s): ${unknown.join(', ')}`);
            opts.only = only;
        } else {
            throw usageError(`unknown argument: ${arg}`);
        }
    }
    return opts;
}

function formatViolation(violation) {
    if (violation.tokenId) {
        return `${violation.file}:${violation.line} ${violation.tokenId}: "${violation.match}"`;
    }
    if (violation.code) {
        return `${violation.file}:${violation.line} ${violation.code} (retired plan code): ${violation.snippet}`;
    }
    if (violation.id) {
        return `${violation.file}: ${violation.id} — ${violation.reason}`;
    }
    return `${violation.file}: ${violation.reason}`;
}

function worklistSummary(violations) {
    const byFile = new Map();
    for (const violation of violations) {
        byFile.set(violation.file, (byFile.get(violation.file) || 0) + 1);
    }
    return [...byFile.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([file, count]) => `${file} (${count})`);
}

function runChecks(opts) {
    const scanRoot = path.resolve(opts.scanRoot);
    const files = listTrackedFiles(scanRoot).filter(inScanScope);
    const switches = opts.only || CHECK_ORDER;
    const results = [];

    if (switches.includes('tokens')) {
        const report = scanTokens({ root: scanRoot, files });
        results.push({
            key: 'tokens',
            label: '(a) forbidden-token scan',
            ok: report.violations.length === 0 || opts.worklist,
            treatedAsWorklist: report.violations.length > 0 && opts.worklist,
            violations: report.violations,
            warnings: [],
            meta: {
                scannedFiles: report.scanned,
                allowlistedFiles: report.skipped.length,
                violationCount: report.violations.length,
                filesWithViolations: new Set(report.violations.map((v) => v.file)).size,
            },
        });
    }

    if (switches.includes('retired')) {
        const report = scanRetiredIdentifiers({ root: scanRoot, files });
        results.push({
            key: 'retired',
            label: '(b) retired plan identifiers',
            ok: report.violations.length === 0,
            violations: report.violations,
            warnings: [],
            meta: {
                compatMatches: report.compat.length,
                compatFiles: new Set(report.compat.map((v) => v.file)).size,
            },
        });
    }

    if (switches.includes('registry')) {
        const report = checkRegistry({ root: scanRoot, files });
        results.push({
            key: 'registry',
            label: '(c) claim registry completeness',
            ok: report.violations.length === 0 && (!opts.strict || report.warnings.length === 0),
            violations: report.violations,
            warnings: report.warnings,
            meta: {
                registryIds: report.registrySize,
                usages: report.usages.length,
                localeWarnings: report.warnings.length,
            },
        });
    }

    if (switches.includes('evidence')) {
        const report = checkEvidence({ root: scanRoot });
        results.push({
            key: 'evidence',
            label: '(d) evidence resolvability',
            ok: report.violations.length === 0,
            violations: report.violations,
            warnings: [],
            meta: { flags: report.flags, authorities: report.authorities },
        });
    }

    if (switches.includes('snapshot')) {
        const report = checkSnapshots({ root: scanRoot, update: opts.update });
        results.push({
            key: 'snapshot',
            label: '(e) snapshot drift',
            ok: report.violations.length === 0,
            violations: report.violations,
            warnings: [],
            meta: report.updated.length ? { updated: report.updated } : {},
        });
    }

    if (switches.includes('collateral')) {
        const report = checkCollateral({ root: scanRoot, update: opts.update });
        results.push({
            key: 'collateral',
            label: '(f) collateral drift',
            ok: report.violations.length === 0,
            violations: report.violations,
            warnings: [],
            meta: report.updated.length ? { updated: report.updated } : {},
        });
    }

    return { scanRoot, files: files.length, results };
}

function printHuman(report, opts) {
    const lines = [];
    lines.push(`verify-claims: ${report.results.length} check(s), ${report.files} tracked file(s) under ${normalize(report.scanRoot)}`);
    for (const result of report.results) {
        const status = result.ok ? 'PASS' : 'FAIL';
        const suffix = result.treatedAsWorklist ? ' (violations reported as Phase-2 worklist)' : '';
        lines.push('');
        lines.push(`${status} ${result.label}${suffix}`);
        const meta = Object.entries(result.meta || {})
            .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
            .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : value}`);
        if (meta.length) lines.push(`     ${meta.join(' ')}`);
        if (!opts.quiet) {
            for (const warning of result.warnings) lines.push(`  ! ${formatViolation(warning)}`);
            for (const violation of result.violations) lines.push(`  - ${formatViolation(violation)}`);
        } else if (result.violations.length) {
            lines.push(`     ${result.violations.length} violation(s) suppressed by --quiet`);
        }
        if (result.key === 'tokens' && result.violations.length) {
            lines.push('     token worklist by file:');
            for (const entry of worklistSummary(result.violations)) lines.push(`       ${entry}`);
        }
    }

    const failed = report.results.filter((result) => !result.ok);
    lines.push('');
    if (failed.length) {
        lines.push(`verify-claims: FAILED — ${failed.map((result) => result.key).join(', ')}`);
    } else {
        lines.push(`verify-claims: PASSED — ${report.results.map((result) => result.key).join(', ')}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`verify-claims: ${error.message}\n\n${USAGE}\n`);
        process.exit(2);
    }
    if (opts.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    let report;
    try {
        report = runChecks(opts);
    } catch (error) {
        process.stderr.write(`verify-claims: internal error: ${error.stack || error.message}\n`);
        process.exit(2);
    }

    if (opts.json) {
        const failed = report.results.filter((result) => !result.ok);
        process.stdout.write(`${JSON.stringify({
            ok: failed.length === 0,
            scanRoot: normalize(report.scanRoot),
            files: report.files,
            checks: report.results,
        }, null, 2)}\n`);
    } else {
        printHuman(report, opts);
    }

    process.exit(report.results.some((result) => !result.ok) ? 1 : 0);
}

if (require.main === module) main();

module.exports = { parseArgs, runChecks, CHECK_ORDER };