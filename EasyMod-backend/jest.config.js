/**
 * The default backend gate: deterministic unit and service tests. No Postgres,
 * no Redis, no network — the moduleNameMapper below stubs the message queue so
 * BullMQ never opens a connection.
 *
 * The exclusion list below is deliberately TINY, and every entry names a suite
 * that has its own command and its own CI job. It used to hold 21 patterns that
 * hid 18 test files — four entire feature domains — behind a green `npm test`.
 * None of them were `.skip`, so every audit of "which tests are disabled?"
 * answered "none". Never grow this list to hide a failure: a test excluded here
 * and nowhere else does not count as coverage, and
 * scripts/check-test-discovery.js fails the build if one ends up that way.
 *
 * Membership is by filename, not by exclusion:
 *   *.integration.test.js   → npm run test:integration (real Postgres/Redis)
 *   tests/meta-e2e/*        → npm run test:meta:e2e
 *   tests/quarantine.json   → npm run test:quarantine (known-broken, NOT coverage)
 *   everything else         → here
 */

// The known-broken list lives in tests/quarantine.json, not in this array, so
// there is one place to look and every entry carries its cause and its repair.
// It is a debt register with a ceiling that only goes down — see that file.
const quarantined = require('./tests/quarantine.json').files.map((f) => f.file);

module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
    testPathIgnorePatterns: [
        '/node_modules/',
        // Needs PostgreSQL + Redis and the REAL message queue (which the
        // moduleNameMapper below deliberately stubs out here).
        // Runs under jest.meta-e2e.config.js via `npm run test:meta:e2e`.
        'tests/meta-e2e/',
        // Needs a real PostgreSQL. Runs under jest.integration.config.js via
        // `npm run test:integration`, which CI provisions a database for.
        '\\.integration\\.test\\.js$',
        ...quarantined,
    ],
    moduleNameMapper: {
        // Even with the message-queue singleton stubbed, importing
        // queue-manager constructs several BullMQ Queue instances. Unit tests
        // must never open Redis connections; queue-specific tests opt into
        // their own explicit BullMQ mocks, while Redis-backed behavior belongs
        // to the integration suite.
        '^bullmq$': '<rootDir>/tests/__mocks__/bullmq.js',
        '^src/(.*)$': '<rootDir>/src/$1',
        // Redirect all message-queue imports to a stub so BullMQ never opens
        // a real Redis connection during unit tests (path varies: ../../jobs/...,
        // ../src/jobs/..., src/jobs/... — the regex catches all forms).
        '.*/jobs/message-queue$': '<rootDir>/tests/__mocks__/message-queue.js',
    },
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/database/migrations/**',
        '!src/scripts/**',
        '!src/jobs/test-jobs.js',
        '!src/**/*.update.js',          // WIP draft files with TypeScript syntax
        '!src/**/*.latency-failover.js', // Experimental stub files
    ],
    coverageReporters: ['text', 'lcov'],
    testTimeout: 10000
};
