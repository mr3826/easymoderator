'use strict';

/**
 * Check (f) — collateral drift.
 *
 * The committed one-pager must be byte-identical to the renderer's output.
 * `--update-snapshots` rewrites it together with the snapshot receipts.
 */

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, normalize } = require('./repo');
const {
    renderOnePager,
    ONE_PAGER_REL_PATH,
    onePagerAbsolutePath,
} = require('../../build-collateral');

function checkCollateral({ root = REPO_ROOT, update = false } = {}) {
    const target = onePagerAbsolutePath(root);
    const rel = normalize(path.relative(root, target)) || ONE_PAGER_REL_PATH;
    const expected = renderOnePager();

    if (update) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, expected, 'utf8');
        return { violations: [], updated: [rel] };
    }

    if (!fs.existsSync(target)) {
        return { violations: [{ file: rel, reason: 'one-pager missing — run `npm run build:collateral`' }], updated: [] };
    }
    const actual = fs.readFileSync(target, 'utf8');
    // Normalise line endings: core.autocrlf may hand a Windows checkout CRLF
    // while the renderer always emits LF. The content, not the EOL byte, is the
    // contract.
    if (actual.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
        return {
            violations: [{ file: rel, reason: 'collateral drift — committed file differs from contract render' }],
            updated: [],
        };
    }
    return { violations: [], updated: [] };
}

module.exports = { checkCollateral };