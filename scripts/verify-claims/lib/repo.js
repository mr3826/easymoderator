'use strict';

/**
 * Filesystem helpers for the claims scanner.
 *
 * The scanner is deliberately dependency-free: node builtins only. It may
 * require the pure backend contract/registry/evidence modules (and the pure
 * provider-capabilities module) through a relative path, but it must never
 * require an npm package or a module that opens a DB/network handle, because
 * the PR merge gate runs it without `npm ci`.
 *
 * `REPO_ROOT` is where the frozen modules live. `scanRoot` (CLI --scan-root)
 * is where files are discovered, which lets the self-tests point the scanner at
 * a throwaway fixture tree without duplicating the frozen contract.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The four product modules plus root scripts are the token-scan boundary. */
const MODULE_PREFIXES = Object.freeze([
    'EasyMod-backend/',
    'EasyMod-frontend/',
    'EasyMod-growth/',
    'EasyMod-mobile/',
]);
const SCAN_PREFIXES = Object.freeze([...MODULE_PREFIXES, 'scripts/']);

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.vite',
    'playwright-report',
    'test-results',
]);

const normalize = (file) => String(file).split(path.sep).join('/');

const inScanScope = (file) => {
    const p = normalize(file).replace(/^\.\//, '');
    return SCAN_PREFIXES.some((prefix) => p.startsWith(prefix));
};

const isUnderModule = (file) => {
    const p = normalize(file);
    return MODULE_PREFIXES.some((prefix) => p.startsWith(prefix));
};

function walk(root) {
    const files = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                visit(path.join(dir, entry.name));
            } else if (entry.isFile()) {
                files.push(normalize(path.relative(root, path.join(dir, entry.name))));
            }
        }
    };
    visit(root);
    return files.sort();
}

/**
 * Tracked text-file candidates. `git ls-files` is the authority for a real
 * checkout (it never sees build output); a fixture tree is walked because it is
 * not a git repository.
 */
function listTrackedFiles(root = REPO_ROOT) {
    // A fixture tree has no .git: walk it instead of asking git (which would
    // fail and fall back to the same walk, just more slowly).
    if (!fs.existsSync(path.join(root, '.git'))) return walk(root);
    try {
        const out = execFileSync('git', ['ls-files', '-z'], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.split('\0').filter(Boolean).map(normalize);
    } catch {
        return walk(root);
    }
}

/**
 * Read a repo-relative file as text.
 * Returns undefined if it is not a readable file inside `root`, null if binary.
 */
function readText(root, file) {
    const abs = path.resolve(root, file);
    const rootAbs = path.resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return undefined;
    let stat;
    try {
        stat = fs.statSync(abs);
    } catch {
        return undefined;
    }
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_FILE_BYTES) return undefined;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
}

module.exports = {
    REPO_ROOT,
    MODULE_PREFIXES,
    SCAN_PREFIXES,
    MAX_FILE_BYTES,
    normalize,
    inScanScope,
    isUnderModule,
    listTrackedFiles,
    readText,
};