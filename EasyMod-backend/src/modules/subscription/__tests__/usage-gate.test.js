'use strict';

/**
 * Conversation usage gate contract — RETIRED by ADR-0011.
 *
 * `conversationEntitlement` is null on the commercial contract: no conversation
 * is metered, capped or sold. These helpers stay exported for serializers but
 * must never withhold automated replies; the only automation gate is billing
 * status (`isAiActive`).
 */

const {
    effectiveConversationLimit,
    isConversationQuotaExhausted
} = require('../subscription.access');

describe('retired conversation usage gate contract', () => {
    it.each([
        [{ conversations_limit: 100, conversations_used: 0 }],
        [{ conversations_limit: 100, conversations_used: 99 }],
        [{ conversations_limit: 100, conversations_used: 100 }],
        [{ conversations_limit: 100, conversations_used: 101 }],
        [{ conversations_limit: 100, topup_balance: 1, conversations_used: 100 }],
        [{ conversations_limit: -1, conversations_used: 100000 }],
        [null]
    ])('never blocks %s', (subscription) => {
        expect(isConversationQuotaExhausted(subscription)).toBe(false);
    });

    it('always reports the unlimited sentinel', () => {
        expect(effectiveConversationLimit(null)).toBe(-1);
        expect(effectiveConversationLimit({ conversations_limit: -1, topup_balance: 999 })).toBe(-1);
        expect(effectiveConversationLimit({ conversations_limit: 100, conversations_used: 100 })).toBe(-1);
    });
});