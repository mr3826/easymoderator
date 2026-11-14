'use strict';

/**
 * Check (b) — retired plan identifiers.
 *
 * Uppercase SHURU / GROWTH / PARTNER plan CODES may appear only in explicit
 * compatibility paths (legacy subscription readers, migrations, growth-os
 * readers, seeds, tests and the frozen contract's own documentation). Any other
 * path that reintroduces one fails the build. Lowercase `growth` words and
 * role identifiers such as GROWTH_USER / GROWTH_OS_ are not matched.
 */

const { readText } = require('./repo');
const { retiredCodeAllowReason } = require('./allowlist');

const RETIRED_CODE = /\b(SHURU|GROWTH|PARTNER)\b/g;

function scanRetiredIdentifiers({ root, files }) {
    const violations = [];
    const compat = [];
    let scanned = 0;

    for (const file of files) {
        const text = readText(root, file);
        if (text === undefined || text === null) continue;
        const allowReason = retiredCodeAllowReason(file);
        const lines = text.split(/\r?\n/);
        let touched = false;

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line === '') continue;
            RETIRED_CODE.lastIndex = 0;
            let match;
            while ((match = RETIRED_CODE.exec(line)) !== null) {
                touched = true;
                const hit = {
                    file,
                    line: index + 1,
                    code: match[1],
                    snippet: line.trim().replace(/\s+/g, ' ').slice(0, 180),
                };
                if (allowReason) compat.push({ ...hit, reason: allowReason });
                else violations.push(hit);
            }
        }
        if (touched) scanned += 1;
    }

    return { violations, compat, scanned };
}

module.exports = { scanRetiredIdentifiers, RETIRED_CODE };