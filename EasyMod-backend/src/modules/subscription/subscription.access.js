'use strict';

/**
 * Subscription access helpers — pure, dependency-free predicates used by the
 * AI auto-reply path, jobs and middleware to decide whether *automated* AI
 * replies should run for a shop.
 *
 * ADR-0011 retired every conversation entitlement: `conversationEntitlement`
 * is null on the commercial contract and no conversation is metered, capped or
 * sold. The quota predicates below are kept ONLY for backward compatibility
 * with serializers that still read them; they now always report unlimited, so
 * no caller can gate automated replies on a counter that no longer exists.
 *
 * Design: fail OPEN. Consistent with the rest of the codebase (the rate
 * limiter and getShopPlanCode all fail open), AI is blocked ONLY for explicitly
 * inactive billing states. A missing subscription row or an unknown status
 * never locks a shop out of AI.
 */

// Billing states in which automated AI replies must be paused.
const AI_BLOCKED_STATUSES = Object.freeze(['trial_expired', 'suspended', 'cancelled', 'inactive']);

/**
 * Whether automated AI replies are allowed for a subscription's billing status.
 * @param {{status?: string}|null|undefined} sub
 * @returns {boolean}
 */
const isAiActive = (sub) => {
    if (!sub) return true; // fail-open: no row → don't block
    return !AI_BLOCKED_STATUSES.includes(String(sub.status || '').toLowerCase());
};

/** Whether a legacy pre-migration subscription is still marked trialing. */
const isTrialing = (sub) => !!sub && String(sub.status || '').toLowerCase() === 'trialing';

/**
 * RETIRED by ADR-0011. Every shop has an unlimited conversation entitlement
 * (there is none), so this always returns the unlimited sentinel.
 *
 * Kept exported because API serializers still publish the field; consumers must
 * treat -1 as unlimited and never gate on it.
 * @returns {number} -1 = unlimited
 */
const effectiveConversationLimit = (_sub) => -1;

/**
 * RETIRED by ADR-0011. No conversation quota exists, so exhaustion is
 * impossible. Kept exported for serializers that still publish the boolean.
 * @returns {boolean} always false
 */
const isConversationQuotaExhausted = (_sub) => false;

module.exports = {
    isAiActive,
    isTrialing,
    effectiveConversationLimit,
    isConversationQuotaExhausted,
    AI_BLOCKED_STATUSES
};
