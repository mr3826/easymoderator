/**
 * subscription.access — AI-gate predicate tests (pure, no DB).
 */

const {
    isAiActive,
    isTrialing,
    effectiveConversationLimit,
    isConversationQuotaExhausted
} = require('../subscription.access');

describe('subscription.access · isAiActive', () => {
    it('allows AI for active and trialing shops', () => {
        expect(isAiActive({ status: 'active' })).toBe(true);
        expect(isAiActive({ status: 'trialing' })).toBe(true);
    });

    it('blocks AI for explicitly inactive billing states', () => {
        expect(isAiActive({ status: 'trial_expired' })).toBe(false);
        expect(isAiActive({ status: 'suspended' })).toBe(false);
        expect(isAiActive({ status: 'cancelled' })).toBe(false);
        expect(isAiActive({ status: 'inactive' })).toBe(false);
    });

    it('fails open for a missing subscription or unknown status', () => {
        expect(isAiActive(null)).toBe(true);
        expect(isAiActive(undefined)).toBe(true);
        expect(isAiActive({})).toBe(true);
        expect(isAiActive({ status: 'something_new' })).toBe(true);
    });

    it('is case-insensitive on status', () => {
        expect(isAiActive({ status: 'SUSPENDED' })).toBe(false);
        expect(isAiActive({ status: 'Trialing' })).toBe(true);
    });
});

describe('subscription.access · isTrialing', () => {
    it('is true only for trialing status', () => {
        expect(isTrialing({ status: 'trialing' })).toBe(true);
        expect(isTrialing({ status: 'active' })).toBe(false);
        expect(isTrialing(null)).toBe(false);
    });
});

describe('subscription.access · retired conversation quota (ADR-0011)', () => {
    it('reports unlimited for every row, including exhausted legacy counters', () => {
        expect(effectiveConversationLimit({ conversations_limit: 100, conversations_used: 100 })).toBe(-1);
        expect(effectiveConversationLimit({ conversations_limit: 500, conversations_used: 600, topup_balance: 0 })).toBe(-1);
        expect(effectiveConversationLimit(null)).toBe(-1);
        expect(effectiveConversationLimit(undefined)).toBe(-1);
    });

    it('never reports exhaustion, whatever the historical counter says', () => {
        expect(isConversationQuotaExhausted({ conversations_limit: 100, conversations_used: 99 })).toBe(false);
        expect(isConversationQuotaExhausted({ conversations_limit: 100, conversations_used: 100 })).toBe(false);
        expect(isConversationQuotaExhausted({ conversations_limit: 100, conversations_used: 101 })).toBe(false);
        expect(isConversationQuotaExhausted({ conversations_limit: -1, conversations_used: 100000 })).toBe(false);
        expect(isConversationQuotaExhausted(null)).toBe(false);
    });
});
