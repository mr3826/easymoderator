'use strict';

/**
 * Confidence observation qualification — PURE evaluator (WP-03).
 *
 * Takes the aggregate-only rollup from reply-confidence-rollup.service.js and
 * decides whether a shop's shadow-observation window satisfies the adopted
 * observation contract. This module performs NO database access and NO I/O:
 * every input is a plain value supplied by the caller (admin endpoint or the
 * daily snapshot job), which makes the verdict fully unit-testable and keeps
 * the READ-ONLY/tenant/2s/5000 invariants where they belong — in the rollup
 * query that produced the numbers.
 *
 * CONTRACT STATUS — see docs/ai/improvement-program/CONFIDENCE_OBSERVATION_CONTRACT.md:
 * ADOPTED_MISSION_AUTHORIZED / PENDING_FOUNDER_RATIFICATION. The thresholds
 * below were adopted under the standing founder mission authorization for the
 * Phase 0 remediation; the founder has NOT personally ratified them yet. The
 * verdict this module produces is engineering evidence, never a business
 * approval, and never fabricates a pass: zero observations can only ever be
 * OBSERVATION_PENDING.
 *
 * 168-HOUR WINDOW SUFFICIENCY (why the rollup's max window can prove a 72h
 * criterion): the qualification reader always requests the widest window the
 * rollup allows (168h >= 72h). The turn window is bounded by NOW(), so a
 * non-null firstEligibleObservedAt inside that window means the earliest
 * eligible observation happened at least (now − firstEligibleObservedAt) ago;
 * when that span reaches 72h, observation demonstrably spans >= 72 hours.
 * Counts are LOWER BOUNDS under the 5000-turn cap: truncation can only hide
 * evidence, so a QUALIFIED verdict is conservative with respect to volume.
 * What the span does NOT prove is gap-free coverage inside the window — the
 * contract names this criterion "observation span" for exactly that reason,
 * and the contract record records the limitation honestly.
 *
 * shadowToLiveViolations SOURCE — no runtime counter exists, and this module
 * does not invent one. The value is an architectural-isolation statement,
 * documented in the contract record and evidenced by
 * docs/ai/improvement-program/STAGE2_SHADOW_ISOLATION_PROOF.md plus the
 * confidence-gate source itself: shouldHoldForLowConfidence() in
 * confidence-gate.service.js never reads confidence_mode/confidence_scope/
 * confidence_score shadow metadata — the live hold decision consumes only the
 * legacy router confidence value at the message-worker hold sites — and the
 * shadow rollup is operator-only (READ-ENDING SELECT) so it cannot write a
 * send condition either. Callers pass 0 for that proven isolation; any other
 * value (including a malformed one) fails the criterion. A non-zero value
 * would mean the isolation proof broke, and the contract fails closed.
 */

const OBSERVATION_CONTRACT_VERSION = 'confidence-observation-v1';

// Qualification always reads the rollup's widest window (168h covers the 72h
// span criterion; see the sufficiency note above).
const QUALIFICATION_WINDOW_HOURS = 168;

const QUALIFICATION_CRITERIA = Object.freeze({
    // Continuous observation span from the first eligible scored observation.
    OBSERVATION_SPAN_HOURS_MIN: 72,
    // Eligible scored turns within the window (lower bound under truncation).
    SCORED_TURNS_MIN: 30,
    // Distinct conversations among eligible scored turns.
    CONVERSATIONS_MIN: 3,
    // At least one shop whose pilot authorization is in force.
    AUTHORIZED_SHOPS_MIN: 1,
    // Shadow-to-live isolation violations tolerated. Zero. See header.
    SHADOW_TO_LIVE_VIOLATIONS_MAX: 0,
});

const QUALIFICATION_VERDICTS = Object.freeze({
    QUALIFIED: 'QUALIFIED',
    OBSERVATION_PENDING: 'OBSERVATION_PENDING',
    INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

const HOUR_MS = 60 * 60 * 1000;

const safeIntOr = (value, fallback = 0) =>
    (Number.isSafeInteger(value) && value >= 0 ? value : fallback);

function parseTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Engineering proxy for the signed pilot authorization. The authoritative
 * consent lives in the pilot authorization record (documentary, not a DB
 * fact); this maps the code-visible state that mirrors it: the shop row is
 * ACTIVE, no bypass-proof AI emergency stop is engaged, and the shop carries
 * at least one enabled pilot feature (SUPER_ADMIN-granted enrollment). A
 * missing pilot-features row, a row with every flag off (post disable-all kill
 * switch), or a suspended/emergency-stopped shop is NOT authorized. Pure —
 * callers pass plain values read outside this module.
 */
function computeShopAuthorized({ shop, pilotFeatures } = {}) {
    if (!shop || shop.is_active === false || shop.is_active === 0) return false;
    if (shop.ai_emergency_stop === true || shop.ai_emergency_stop === 1) return false;
    if (!pilotFeatures || typeof pilotFeatures !== 'object') return false;
    const booleanFlags = [
        'customer_intelligence', 'interaction_choices', 'action_queue',
        'knowledge_suggestions', 'ads_studio', 'storefront', 'ai_reply_shadow_meter',
    ];
    if (booleanFlags.some((flag) => pilotFeatures[flag] === true)) return true;
    return pilotFeatures.order_confidence_mode === 'shadow'
        || pilotFeatures.order_confidence_mode === 'enforce';
}

/**
 * @param {object} input
 * @param {object|null} input.rollup              rollup report (widest window) or null when the read failed
 * @param {boolean} input.shopAuthorized          computeShopAuthorized() result for this shop
 * @param {number} input.shadowToLiveViolations   architectural-isolation statement; 0 = proven isolated
 * @param {Date|number|string} input.now          evaluation clock (caller supplies)
 */
function evaluateQualification({ rollup, shopAuthorized, shadowToLiveViolations, now } = {}) {
    const nowMs = parseTimestamp(now);
    if (nowMs === null) {
        throw new TypeError('evaluateQualification requires a resolvable "now" timestamp');
    }

    // A failed rollup read is MISSING evidence, not zero evidence: it must not
    // be reported as a healthy window still filling (OBSERVATION_PENDING).
    const rollupAvailable = Boolean(rollup) && typeof rollup === 'object';

    const scored = rollupAvailable ? safeIntOr(rollup.scored,
        // Older rollup shapes: derive the same denominator from its parts.
        Math.max(0, safeIntOr(rollup.suggestion) + safeIntOr(rollup.delivered) - safeIntOr(rollup.unscored))) : 0;
    const unscored = rollupAvailable ? safeIntOr(rollup.unscored) : 0;
    const eligible = rollupAvailable ? safeIntOr(rollup.eligible, scored) : 0;
    const ineligible = rollupAvailable ? safeIntOr(rollup.ineligible,
        safeIntOr(rollup.missing) + unscored) : 0;
    const conversations = rollupAvailable ? safeIntOr(rollup.conversations) : 0;
    const firstEligibleObservedAtMs = rollupAvailable ? parseTimestamp(rollup.firstEligibleObservedAt) : null;
    const observationSpanHours = firstEligibleObservedAtMs === null
        ? 0 : Math.max(0, (nowMs - firstEligibleObservedAtMs) / HOUR_MS);

    const violationsValue = Number.isSafeInteger(shadowToLiveViolations) && shadowToLiveViolations >= 0
        ? shadowToLiveViolations : null; // malformed input can never satisfy 0

    const criteria = {
        observationSpanHours: {
            met: firstEligibleObservedAtMs !== null
                && observationSpanHours >= QUALIFICATION_CRITERIA.OBSERVATION_SPAN_HOURS_MIN,
            value: Number(observationSpanHours.toFixed(4)),
            threshold: QUALIFICATION_CRITERIA.OBSERVATION_SPAN_HOURS_MIN,
        },
        scoredTurns: {
            met: scored >= QUALIFICATION_CRITERIA.SCORED_TURNS_MIN,
            value: scored,
            threshold: QUALIFICATION_CRITERIA.SCORED_TURNS_MIN,
        },
        conversations: {
            met: conversations >= QUALIFICATION_CRITERIA.CONVERSATIONS_MIN,
            value: conversations,
            threshold: QUALIFICATION_CRITERIA.CONVERSATIONS_MIN,
        },
        authorizedShop: {
            met: shopAuthorized === true,
            value: shopAuthorized === true ? QUALIFICATION_CRITERIA.AUTHORIZED_SHOPS_MIN : 0,
            threshold: QUALIFICATION_CRITERIA.AUTHORIZED_SHOPS_MIN,
        },
        shadowToLiveIsolation: {
            met: violationsValue === QUALIFICATION_CRITERIA.SHADOW_TO_LIVE_VIOLATIONS_MAX,
            value: violationsValue,
            threshold: QUALIFICATION_CRITERIA.SHADOW_TO_LIVE_VIOLATIONS_MAX,
        },
    };

    const allMet = Object.values(criteria).every((criterion) => criterion.met);
    let verdict;
    if (!rollupAvailable) {
        // The evidence could not be read at all (e.g. statement timeout).
        verdict = QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE;
    } else if (allMet) {
        verdict = QUALIFICATION_VERDICTS.QUALIFIED;
    } else if (!criteria.authorizedShop.met || !criteria.shadowToLiveIsolation.met) {
        // Hard blockers: waiting cannot fix an unauthorized shop or a broken
        // isolation proof, so this is not merely "pending" more observation.
        verdict = QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE;
    } else if (!criteria.observationSpanHours.met) {
        // Authorized and isolated, but the window has not spanned 72h yet
        // (including the zero-observation case) → keep observing, never pass.
        verdict = QUALIFICATION_VERDICTS.OBSERVATION_PENDING;
    } else {
        // Window spanned >= 72h and the shop is otherwise eligible, but the
        // evidence volume fell short → insufficient, not pending.
        verdict = QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE;
    }

    return {
        verdict,
        contractVersion: OBSERVATION_CONTRACT_VERSION,
        contractStatus: 'ADOPTED_MISSION_AUTHORIZED_PENDING_FOUNDER_RATIFICATION',
        windowHours: rollupAvailable && Number.isSafeInteger(rollup.hours) ? rollup.hours : QUALIFICATION_WINDOW_HOURS,
        rollupAvailable,
        criteria,
        denominators: {
            turns: rollupAvailable ? safeIntOr(rollup.turns) : 0,
            scored,
            unscored,
            eligible,
            ineligible,
            conversations,
            truncated: rollupAvailable ? rollup.truncated === true : false,
        },
        firstEligibleObservedAt: firstEligibleObservedAtMs === null
            ? null : new Date(firstEligibleObservedAtMs).toISOString(),
        evaluatedAt: new Date(nowMs).toISOString(),
        // Honest provenance of the isolation input — documented constant, not
        // a fabricated runtime counter. See the module header.
        shadowToLiveViolationSource: 'architectural-isolation:confidence-gate-never-reads-shadow-metadata-v1',
    };
}

module.exports = {
    OBSERVATION_CONTRACT_VERSION,
    QUALIFICATION_WINDOW_HOURS,
    QUALIFICATION_CRITERIA,
    QUALIFICATION_VERDICTS,
    evaluateQualification,
    computeShopAuthorized,
};
