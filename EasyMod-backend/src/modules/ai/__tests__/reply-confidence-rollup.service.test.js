'use strict';

const mockQuery = jest.fn();
const mockTransaction = jest.fn(async (callback) => callback({ id: 'mock-transaction' }));

jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        query: (...args) => mockQuery(...args),
        transaction: (...args) => mockTransaction(...args),
    },
}));

const { getReplyConfidenceRollup } = require('../reply-confidence-rollup.service');
const {
    WOULD_HOLD_POLICY_VERSION,
    WOULD_HOLD_SETTINGS_SCOPE,
} = require('../confidence-gate.service');

beforeEach(() => {
    jest.clearAllMocks();
});

test('rollup separates qualified would-hold and retrieval coverage from unknown history', async () => {
    mockQuery
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[
            {
                scope: 'delivered', score: 1, reasons: ['RAG_TIMEOUT', 'unapproved'], wouldHold: true,
                wouldHoldPolicyVersion: WOULD_HOLD_POLICY_VERSION,
                wouldHoldSettingsScope: WOULD_HOLD_SETTINGS_SCOPE,
                retrieval: 'TIMEOUT', computeMs: 7,
            },
            {
                scope: 'suggestion', score: null, reasons: [], wouldHold: true,
                wouldHoldPolicyVersion: 'unversioned',
                wouldHoldSettingsScope: WOULD_HOLD_SETTINGS_SCOPE,
                retrieval: 'UNKNOWN', computeMs: null,
            },
            {
                scope: null, score: null, reasons: null, wouldHold: true,
                wouldHoldPolicyVersion: null, wouldHoldSettingsScope: null,
                retrieval: null, computeMs: null,
            },
            {
                scope: 'delivered', score: 0.9, reasons: [], wouldHold: false,
                wouldHoldPolicyVersion: WOULD_HOLD_POLICY_VERSION,
                wouldHoldSettingsScope: WOULD_HOLD_SETTINGS_SCOPE,
                retrieval: 'NOT_REQUESTED', computeMs: 3,
            },
        ], {}]);

    const report = await getReplyConfidenceRollup('11111111-2222-4333-8444-555555555555');

    expect(report).toMatchObject({
        turns: 4,
        missing: 1,
        suggestion: 1,
        delivered: 2,
        unscored: 1,
        wouldHold: 1,
        wouldHoldCovered: 2,
        wouldHoldUnknown: 2,
        retrievalCovered: 2,
        retrievalUnknown: 2,
        retrieval: { TIMEOUT: 1, UNKNOWN: 1, NOT_REQUESTED: 1 },
        reasons: { RAG_TIMEOUT: 1 },
        computeP95Ms: 7,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
});

test('legacy fixture rows without identity columns still yield safe zero aggregates', async () => {
    mockQuery
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[{
            scope: 'delivered', score: 0.8, reasons: [], wouldHold: false,
            wouldHoldPolicyVersion: WOULD_HOLD_POLICY_VERSION,
            wouldHoldSettingsScope: WOULD_HOLD_SETTINGS_SCOPE,
            retrieval: 'FOUND', computeMs: 5,
        }], {}]);

    const report = await getReplyConfidenceRollup('11111111-2222-4333-8444-555555555555');

    // Rows shaped before WP-03 (no conversationId/turnCreatedAt) must not
    // invent identities: zero conversations, null first observation, but the
    // scored/eligible denominators still count the eligible scored row.
    expect(report).toMatchObject({
        conversations: 0, firstEligibleObservedAt: null,
        scored: 1, unscored: 0, eligible: 1, ineligible: 0,
    });
});

test('observation aggregates cover eligible scored rows only, inside the cap', async () => {
    const convA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const convB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rows = [
        // Eligible scored — newest first (the query orders created_at DESC).
        { scope: 'delivered', score: 0.9, conversationId: convA, turnCreatedAt: new Date('2026-11-21T10:00:00Z') },
        // Eligible scored, different conversation, older.
        { scope: 'suggestion', score: 0.6, conversationId: convB, turnCreatedAt: new Date('2026-11-19T09:00:00Z') },
        // Same conversation as the earliest eligible row.
        { scope: 'delivered', score: 0.8, conversationId: convB, turnCreatedAt: new Date('2026-11-19T08:00:00Z') },
        // In scope but unscored → contributes to ineligible, not to identity.
        { scope: 'suggestion', score: null, conversationId: convA, turnCreatedAt: new Date('2026-11-18T08:00:00Z') },
        // No observation at all (human-handled) → missing.
        { scope: null, score: null, conversationId: convA, turnCreatedAt: new Date('2026-11-17T08:00:00Z') },
    ];
    mockQuery
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([rows, {}]);

    const report = await getReplyConfidenceRollup('11111111-2222-4333-8444-555555555555', 168);

    expect(report).toMatchObject({
        hours: 168, turns: 5, truncated: false,
        missing: 1, suggestion: 2, delivered: 2, unscored: 1,
        conversations: 2,
        // Earliest ELIGIBLE SCORED row: the 18th (unscored) and 17th (missing)
        // rows are in the window but must not move the observation clock.
        firstEligibleObservedAt: '2026-11-19T08:00:00.000Z',
        scored: 3, eligible: 3, ineligible: 2,
    });
    // Existing keys stay present and unchanged in meaning.
    expect(report.scoreBuckets).toEqual({ belowHalf: 0, halfToBelowThreeQuarters: 1, threeQuartersOrAbove: 2 });
});

test('truncation keeps the observation aggregates inside the 5000-row slice', async () => {
    const convA = '33333333-cccc-4ccc-8ccc-cccccccccccc';
    const rows = Array.from({ length: 5001 }, (_, i) => ({
        scope: 'delivered',
        score: i < 5000 ? 0.9 : null, // the 5001st row is cut before scoring
        conversationId: i < 5000 ? convA : '44444444-dddd-4ddd-8ddd-dddddddddddd',
        turnCreatedAt: new Date(Date.UTC(2026, 10, 21, 10, 0, 0) - i * 60000),
    }));
    mockQuery
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([[], {}])
        .mockResolvedValueOnce([rows, {}]);

    const report = await getReplyConfidenceRollup('11111111-2222-4333-8444-555555555555', 168);

    expect(report).toMatchObject({
        turns: 5000, truncated: true,
        conversations: 1,
        scored: 5000, eligible: 5000,
    });
    // Rows beyond the cap never contribute — aggregates are lower bounds:
    // the 5001st row's conversation and clock must not appear.
    expect(report.firstEligibleObservedAt)
        .toBe(new Date(Date.UTC(2026, 10, 21, 10, 0, 0) - 4999 * 60000).toISOString());
    expect(report.ineligible).toBe(0);
});
