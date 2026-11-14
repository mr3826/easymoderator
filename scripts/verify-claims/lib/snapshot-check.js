'use strict';

/**
 * Check (e) — snapshot drift.
 *
 * The contract hash and registry hash are computed, never typed. This check
 * recomputes them from the frozen modules and compares the result against both
 * drift receipts: the backend snapshot and the frontend fixture. The forbidden
 * token id list must match exactly too, so adding/removing a token without
 * regenerating the receipts fails the build.
 *
 * `--update-snapshots` regenerates both receipts (and the collateral) together.
 */

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, normalize } = require('./repo');

const contract = require('../../../EasyMod-backend/src/modules/commercial/commercial.contract');
const registry = require('../../../EasyMod-backend/src/modules/commercial/claim.registry');

const BACKEND_SNAPSHOT_REL = 'EasyMod-backend/src/modules/commercial/__snapshots__/commercial.snapshot.json';
const FRONTEND_FIXTURE_REL = 'EasyMod-frontend/src/shared/contracts/__fixtures__/commercial-contract.fixture.json';

function buildSnapshot() {
    return {
        contractVersion: contract.COMMERCIAL_CONTRACT_VERSION,
        contractHash: contract.contractHash,
        registryHash: registry.registryHash,
        forbiddenTokenIds: contract.FORBIDDEN_TOKENS.map((token) => token.id),
        publicContract: JSON.parse(JSON.stringify(contract.publicContractPayload())),
    };
}

const serializeSnapshot = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;

function snapshotPaths(root = REPO_ROOT) {
    const base = path.resolve(root);
    return {
        backend: path.join(base, BACKEND_SNAPSHOT_REL),
        frontend: path.join(base, FRONTEND_FIXTURE_REL),
    };
}

function compareReceipt(label, expected, actual) {
    const problems = [];
    const fields = ['contractVersion', 'contractHash', 'registryHash'];
    for (const field of fields) {
        if (actual[field] !== expected[field]) {
            problems.push(`${label}: ${field} drift — expected ${expected[field]}, found ${actual[field]}`);
        }
    }
    if (JSON.stringify(actual.forbiddenTokenIds) !== JSON.stringify(expected.forbiddenTokenIds)) {
        problems.push(`${label}: forbiddenTokenIds drift — regenerate the receipt`);
    }
    if (JSON.stringify(actual.publicContract) !== JSON.stringify(expected.publicContract)) {
        problems.push(`${label}: publicContract drift — regenerate the receipt`);
    }
    return problems;
}

function readReceipt(label, file) {
    if (!fs.existsSync(file)) {
        return { error: `${label}: receipt missing at ${normalize(path.relative(REPO_ROOT, file))}` };
    }
    try {
        return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
        return { error: `${label}: receipt is not valid JSON (${error.message})` };
    }
}

function writeReceipt(file, snapshot) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeSnapshot(snapshot), 'utf8');
}

function checkSnapshots({ root = REPO_ROOT, update = false } = {}) {
    const expected = buildSnapshot();
    const paths = snapshotPaths(root);
    const violations = [];

    if (update) {
        writeReceipt(paths.backend, expected);
        writeReceipt(paths.frontend, expected);
        return {
            violations,
            updated: [normalize(path.relative(root, paths.backend)), normalize(path.relative(root, paths.frontend))],
            expected,
        };
    }

    const backend = readReceipt('backend snapshot', paths.backend);
    if (backend.error) violations.push({ file: BACKEND_SNAPSHOT_REL, reason: backend.error });
    else compareReceipt('backend snapshot', expected, backend.value).forEach((reason) => {
        violations.push({ file: BACKEND_SNAPSHOT_REL, reason });
    });

    const frontend = readReceipt('frontend fixture', paths.frontend);
    if (frontend.error) violations.push({ file: FRONTEND_FIXTURE_REL, reason: frontend.error });
    else compareReceipt('frontend fixture', expected, frontend.value).forEach((reason) => {
        violations.push({ file: FRONTEND_FIXTURE_REL, reason });
    });

    return { violations, updated: [], expected };
}

module.exports = {
    buildSnapshot,
    serializeSnapshot,
    snapshotPaths,
    checkSnapshots,
    BACKEND_SNAPSHOT_REL,
    FRONTEND_FIXTURE_REL,
};