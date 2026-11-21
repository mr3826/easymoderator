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
