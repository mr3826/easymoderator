'use strict';

/**
 * Check (d) — evidence resolvability.
 *
 * Every requiredEvidence flag on every registry entry must have exactly one
 * authority in EVIDENCE_AUTHORITIES. A pure authority module is required and
 * its named export is checked (a pure module may not touch DB/network). A
 * non-pure authority is checked by file existence plus the export token.
 * Finally, every PLATFORM_EVIDENCE document pointer must resolve to a real file
 * or directory in the tree — a broken pointer is a hard failure.
 */

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, readText } = require('./repo');
const { loadRegistry } = require('./registry-check');

const COMMERCIAL_DIR = path.resolve(REPO_ROOT, 'EasyMod-backend/src/modules/commercial');
const BACKEND_ROOT = path.resolve(REPO_ROOT, 'EasyMod-backend');

const realEvidence = () => require('../../../EasyMod-backend/src/modules/commercial/evidence-authorities');
const realRegistry = () => require('../../../EasyMod-backend/src/modules/commercial/claim.registry');

const PATH_CANDIDATE = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g;

const extractPointers = (text) => {
    const found = String(text).match(PATH_CANDIDATE) || [];
    return [...new Set(found.map((p) => p.replace(/[.,;:]+$/, '')))];
};

const resolvesInTree = (candidate) => {
    const direct = path.resolve(REPO_ROOT, candidate);
    const backend = path.resolve(BACKEND_ROOT, candidate);
    return fs.existsSync(direct) || fs.existsSync(backend);
};

function checkEvidence({ root }) {
    const violations = [];
    const { EVIDENCE_AUTHORITIES, EVIDENCE_FLAGS } = realEvidence();
    const { PLATFORM_EVIDENCE } = realRegistry();
    const { registry } = loadRegistry(root);

    // 1. Registry coverage: every flag an entry requires must be in the manifest.
    for (const entry of Object.values(registry)) {
        for (const flag of entry.requiredEvidence || []) {
            if (!Object.prototype.hasOwnProperty.call(EVIDENCE_AUTHORITIES, flag)) {
                violations.push({
                    file: entry.id,
                    reason: `requiredEvidence flag "${flag}" has no EVIDENCE_AUTHORITIES entry`,
                });
            }
        }
    }

    // 2. Every authority resolves.
    for (const [flag, authority] of Object.entries(EVIDENCE_AUTHORITIES)) {
        if (authority.pure) {
            const modulePath = path.resolve(COMMERCIAL_DIR, authority.module);
            try {
                // eslint-disable-next-line global-require, import/no-dynamic-require
                const mod = require(modulePath);
                if (!(authority.exportName in mod)) {
                    violations.push({
                        file: authority.path || authority.module,
                        reason: `pure authority for "${flag}" does not export ${authority.exportName}`,
                    });
                }
            } catch (error) {
                violations.push({
                    file: authority.path || authority.module,
                    reason: `pure authority for "${flag}" failed to require: ${error.message}`,
                });
            }
        } else {
            const filePath = path.resolve(BACKEND_ROOT, authority.path);
            if (!fs.existsSync(filePath)) {
                violations.push({
                    file: authority.path,
                    reason: `authority for "${flag}" file does not exist`,
                });
            } else {
                const text = readText(BACKEND_ROOT, path.relative(BACKEND_ROOT, filePath));
                if (text === undefined || text === null || !text.includes(authority.exportName)) {
                    violations.push({
                        file: authority.path,
                        reason: `authority for "${flag}" does not export ${authority.exportName}`,
                    });
                }
            }
        }
    }

    // 3. PLATFORM_EVIDENCE doc pointers resolve.
    for (const [flag, fact] of Object.entries(PLATFORM_EVIDENCE)) {
        const pointers = extractPointers(fact.evidence);
        if (pointers.length === 0) {
            violations.push({
                file: flag,
                reason: `platform evidence pointer has no resolvable path: "${fact.evidence}"`,
            });
            continue;
        }
        for (const pointer of pointers) {
            if (!resolvesInTree(pointer)) {
                violations.push({
                    file: flag,
                    reason: `platform evidence pointer does not exist: "${pointer}"`,
                });
            }
        }
    }

    return {
        violations,
        flags: EVIDENCE_FLAGS.length,
        authorities: Object.keys(EVIDENCE_AUTHORITIES).length,
        platformPointers: Object.keys(PLATFORM_EVIDENCE).length,
    };
}

module.exports = { checkEvidence, extractPointers, resolvesInTree, COMMERCIAL_DIR, BACKEND_ROOT };