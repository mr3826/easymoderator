'use strict';

/**
 * Check (a) — forbidden-token scan.
 *
 * Every FORBIDDEN_TOKEN from the frozen commercial contract is compiled with
 * its own `source`/`flags`, then applied line-by-line to tracked text files in
 * the four product modules and root scripts. A token's `excludeSources` are
 * applied to the matching line (e.g. `Growth OS`, `GROWTH_USER`, `GROWTH_OS_`,
 * `growth-os` are not the retired GROWTH plan).
 *
 * Violations are reported as `file:line:tokenId` with a short snippet so a
 * Phase-2 migration has an actionable worklist.
 */

const { FORBIDDEN_TOKENS } = require('../../../EasyMod-backend/src/modules/commercial/commercial.contract');
const { readText } = require('./repo');
const { tokenScanAllowReason } = require('./allowlist');

const HISTORICAL_HEADER = /^\s*<!--\s*HISTORICAL RECORD\s*-->/;

const withGlobal = (flags) => {
    const f = flags || '';
    return f.includes('g') ? f : `${f}g`;
};

const compileTokens = (tokens = FORBIDDEN_TOKENS) => tokens.map((token) => ({
    id: token.id,
    description: token.description,
    regex: new RegExp(token.source, withGlobal(token.flags)),
    excludes: (token.excludeSources || []).map((source) => new RegExp(
        source,
        // No `g`: these are used with .test() repeatedly and a global regex
        // would advance lastIndex and skip matches.
        (token.excludeFlags || 'gi').replace(/g/g, ''),
    )),
}));

const isHistoricalRecord = (file, text) => (
    /\.md$/i.test(file)
    && !/^EasyMod-(backend|frontend|growth|mobile)\//.test(file)
    && HISTORICAL_HEADER.test(text)
);

const snippet = (line) => line.trim().replace(/\s+/g, ' ').slice(0, 180);

/**
 * @returns {{ violations: Array, scanned: number, skipped: Array }}
 */
function scanTokens({ root, files, tokens = FORBIDDEN_TOKENS }) {
    const compiled = compileTokens(tokens);
    const violations = [];
    const skipped = [];
    let scanned = 0;

    for (const file of files) {
        const allow = tokenScanAllowReason(file);
        if (allow) {
            skipped.push({ file, reason: allow });
            continue;
        }
        const text = readText(root, file);
        if (text === undefined) continue;
        if (text === null) continue; // binary
        if (isHistoricalRecord(file, text)) {
            skipped.push({ file, reason: 'historical-record: Markdown outside the product modules' });
            continue;
        }
        scanned += 1;

        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line === '') continue;
            for (const token of compiled) {
                // excludeSources name internal product/role identifiers. Test
                // them against the path as well as the line: `growth-os` is a
                // path namespace (modules/growth-os, scripts/...-growth-os...).
                if (token.excludes.some((exclude) => exclude.test(line) || exclude.test(file))) continue;
                token.regex.lastIndex = 0;
                let match;
                while ((match = token.regex.exec(line)) !== null) {
                    violations.push({
                        file,
                        line: index + 1,
                        tokenId: token.id,
                        match: match[0],
                        snippet: snippet(line),
                    });
                    if (match.index === token.regex.lastIndex) token.regex.lastIndex += 1;
                }
            }
        }
    }

    return { violations, scanned, skipped };
}

module.exports = { scanTokens, compileTokens, HISTORICAL_HEADER };