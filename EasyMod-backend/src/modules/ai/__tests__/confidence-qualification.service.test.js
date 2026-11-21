'use strict';

/**
 * WP-03 evaluator unit suite. The evaluator is pure (no DB, no I/O), so every
 * verdict — including the never-pass rules — is pinned here without fixtures
 * that could drift from the contract.
 */

const {
    evaluateQualification,
    computeShopAuthorized,
    QUALIFICATION_CRITERIA,
    QUALIFICATION_VERDICTS,
} = require('../confidence-qualification.service');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-21T12:00:00.000Z');

// A rollup shape exactly as reply-confidence-rollup.service.js returns it
// (aggregate fields only — the shopId/generatedAt wrapper is the endpoint's).
const rollupFixture = (over = {}) => ({
    hours: 168, turns: 0, truncated: false,
    missing: 0, suggestion: 0, delivered: 0, unscored: 0,
    wouldHold: 0, wouldHoldCovered: 0, wouldHoldUnknown: 0,
    scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 0, threeQuartersOrAbove: 0 },
    reasons: {}, retrieval: {}, retrievalCovered: 0, retrievalUnknown: 0, computeP95Ms: null,
    conversations: 0, firstEligibleObservedAt: null,
    scored: 0, eligible: 0, ineligible: 0,
    ...over,
});

const passingRollup = (over = {}) => rollupFixture({
    turns: 34, missing: 4, suggestion: 12, delivered: 22, unscored: 0,
    conversations: 5,
    firstEligibleObservedAt: new Date(NOW.getTime() - 80 * HOUR_MS).toISOString(),
    scored: 34, eligible: 34, ineligible: 4,
    ...over,
});

const evaluate = (over = {}) => evaluateQualification({
    rollup: passingRollup(),
    shopAuthorized: true,
    shadowToLiveViolations: 0,
    now: NOW,
    ...over,
});

describe('evaluateQualification — QUALIFIED', () => {
    test('all criteria met → QUALIFIED with the full verdict envelope', () => {
        const result = evaluate();
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.QUALIFIED);
        expect(Object.values(result.criteria).every((c) => c.met)).toBe(true);
        expect(result.denominators).toMatchObject({ scored: 34, eligible: 34, conversations: 5 });
        expect(result.firstEligibleObservedAt).toBe(
            new Date(NOW.getTime() - 80 * HOUR_MS).toISOString(),
        );
        expect(result.evaluatedAt).toBe(NOW.toISOString());
        expect(result.contractVersion).toBe('confidence-observation-v1');
        // The isolation input is labelled with its honest source, not passed
        // off as a runtime counter.
        expect(result.shadowToLiveViolationSource).toMatch(/^architectural-isolation:/);
    });

    test('criteria each expose met/value/threshold', () => {
        const { criteria } = evaluate();
        for (const criterion of Object.values(criteria)) {
            expect(criterion).toHaveProperty('met');
            expect(criterion).toHaveProperty('value');
            expect(criterion).toHaveProperty('threshold');
        }
        expect(criteria.observationSpanHours.threshold).toBe(QUALIFICATION_CRITERIA.OBSERVATION_SPAN_HOURS_MIN);
        expect(criteria.scoredTurns.threshold).toBe(QUALIFICATION_CRITERIA.SCORED_TURNS_MIN);
        expect(criteria.conversations.threshold).toBe(QUALIFICATION_CRITERIA.CONVERSATIONS_MIN);
    });
});

describe('evaluateQualification — zero observations never pass', () => {
    test('a healthy empty rollup is OBSERVATION_PENDING, never QUALIFIED', () => {
        const result = evaluate({ rollup: rollupFixture() });
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
        expect(result.verdict).not.toBe(QUALIFICATION_VERDICTS.QUALIFIED);
        expect(result.criteria.observationSpanHours).toMatchObject({
            met: false, value: 0, threshold: 72,
        });
        expect(result.firstEligibleObservedAt).toBeNull();
    });

    test('null firstEligibleObservedAt fails the span criterion', () => {
        const result = evaluate({ rollup: passingRollup({ firstEligibleObservedAt: null }) });
        expect(result.criteria.observationSpanHours.met).toBe(false);
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
        // Counts alone must never carry a pending window to QUALIFIED.
        expect(result.verdict).not.toBe(QUALIFICATION_VERDICTS.QUALIFIED);
    });

    test('a malformed firstEligibleObservedAt is treated as absent', () => {
        const result = evaluate({ rollup: passingRollup({ firstEligibleObservedAt: 'not-a-date' }) });
        expect(result.firstEligibleObservedAt).toBeNull();
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
    });
});

describe('evaluateQualification — boundaries are inclusive at the threshold', () => {
    test.each([
        [72, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN, true],
        [71.999, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN, false],
        [80, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN - 1, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN, false],
        [80, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN, true],
        [80, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN - 1, false],
        [80, QUALIFICATION_CRITERIA.SCORED_TURNS_MIN + 7, QUALIFICATION_CRITERIA.CONVERSATIONS_MIN + 2, true],
    ])('span=%sh scored=%s conversations=%s → qualified=%s', (spanHours, scored, conversations, qualified) => {
        const result = evaluate({
            rollup: passingRollup({
                firstEligibleObservedAt: new Date(NOW.getTime() - spanHours * HOUR_MS).toISOString(),
                scored,
                eligible: scored,
                conversations,
            }),
        });
        expect(result.verdict === QUALIFICATION_VERDICTS.QUALIFIED).toBe(qualified);
    });

    test('volume shortfall AFTER a spanned window is INSUFFICIENT_EVIDENCE, not pending', () => {
        const result = evaluate({
            rollup: passingRollup({ scored: 12, eligible: 12, conversations: 1 }),
        });
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
    });

    test('volume shortfall BEFORE a spanned window stays OBSERVATION_PENDING', () => {
        const result = evaluate({
            rollup: passingRollup({
                scored: 12, eligible: 12, conversations: 1,
                firstEligibleObservedAt: new Date(NOW.getTime() - 10 * HOUR_MS).toISOString(),
            }),
        });
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
    });
});

describe('evaluateQualification — hard blockers fail closed', () => {
    test('shadowToLiveViolations > 0 fails even with otherwise-complete evidence', () => {
        const result = evaluate({ shadowToLiveViolations: 1 });
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
        expect(result.criteria.shadowToLiveIsolation).toMatchObject({
            met: false, value: 1, threshold: 0,
        });
        expect(result.verdict).not.toBe(QUALIFICATION_VERDICTS.QUALIFIED);
    });

    test('a malformed violation count can never satisfy the zero threshold', () => {
        for (const bad of [undefined, null, -1, 1.5, '0', NaN]) {
            const result = evaluate({ shadowToLiveViolations: bad });
            expect(result.verdict).not.toBe(QUALIFICATION_VERDICTS.QUALIFIED);
            expect(result.criteria.shadowToLiveIsolation.met).toBe(false);
        }
    });

    test('shopAuthorized=false is a hard blocker, not pending', () => {
        const result = evaluate({ shopAuthorized: false });
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
        expect(result.criteria.authorizedShop).toMatchObject({ met: false, value: 0, threshold: 1 });
    });

    test('shopAuthorized must be exactly true', () => {
        for (const notTrue of ['true', 1, {}]) {
            const result = evaluate({ shopAuthorized: notTrue });
            expect(result.verdict).not.toBe(QUALIFICATION_VERDICTS.QUALIFIED);
        }
    });

    test('a missing rollup (failed read / statement timeout) is INSUFFICIENT_EVIDENCE', () => {
        expect(evaluate({ rollup: null }).verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
        expect(evaluate({ rollup: undefined }).verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
        const result = evaluate({ rollup: null });
        expect(result.rollupAvailable).toBe(false);
        expect(result.denominators).toMatchObject({ scored: 0, conversations: 0, truncated: false });
        expect(result.firstEligibleObservedAt).toBeNull();
    });

    test('an unresolvable clock throws instead of guessing', () => {
        expect(() => evaluate({ now: 'nonsense' })).toThrow(TypeError);
        expect(() => evaluate({ now: undefined })).toThrow(TypeError);
    });
});

describe('evaluateQualification — denominators and legacy shapes', () => {
    test('explicit scored/unscored + eligible/ineligible are echoed even when unmet', () => {
        const result = evaluate({
            rollup: passingRollup({
                scored: 4, eligible: 4, unscored: 2, missing: 9, ineligible: 11,
                firstEligibleObservedAt: new Date(NOW.getTime() - 5 * HOUR_MS).toISOString(),
            }),
        });
        expect(result.denominators).toMatchObject({ scored: 4, unscored: 2, eligible: 4, ineligible: 11 });
    });

    test('a pre-WP-03 rollup shape (no new keys) derives the same denominators', () => {
        const legacy = {
            hours: 168, turns: 40, truncated: false,
            missing: 6, suggestion: 18, delivered: 22, unscored: 2,
        };
        const result = evaluate({ rollup: legacy });
        expect(result.denominators.scored).toBe(18 + 22 - 2);
        expect(result.denominators.ineligible).toBe(6 + 2);
        // No observation identity in a legacy shape → span unmet → pending.
        expect(result.criteria.observationSpanHours.met).toBe(false);
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
    });

    test('malformed counters cannot poison verdicts', () => {
        // A corrupt `scored` (-5) falls back to the primitive counters
        // (12+22−0=34), while non-integer identity/turn counts clamp to zero
        // — an unverifiable `conversations` value can never meet the
        // threshold, so the verdict stays non-QUALIFIED either way.
        const result = evaluate({
            rollup: passingRollup({ scored: -5, conversations: 2.5, turns: 'x' }),
        });
        expect(result.denominators.scored).toBe(34);
        expect(result.denominators.conversations).toBe(0);
        expect(result.denominators.turns).toBe(0);
        expect(result.criteria.conversations.met).toBe(false);
        expect(result.verdict).toBe(QUALIFICATION_VERDICTS.INSUFFICIENT_EVIDENCE);
        // And when even the primitives are corrupt, scored clamps to 0.
        const noPrimitives = evaluate({
            rollup: { hours: 168, scored: -5, firstEligibleObservedAt: null },
        });
        expect(noPrimitives.denominators.scored).toBe(0);
        expect(noPrimitives.verdict).toBe(QUALIFICATION_VERDICTS.OBSERVATION_PENDING);
    });
});

describe('computeShopAuthorized — pilot-authorization proxy', () => {
    const active = { is_active: true, ai_emergency_stop: false };
    const enrolled = { customer_intelligence: true, order_confidence_mode: 'off' };

    test('active + enrolled + no stop → authorized', () => {
        expect(computeShopAuthorized({ shop: active, pilotFeatures: enrolled })).toBe(true);
    });

    test.each([
        ['suspended shop', { ...active, is_active: false }, enrolled],
        ['emergency-stopped shop', { ...active, ai_emergency_stop: true }, enrolled],
        ['no pilot-features row', active, null],
        ['all-off row after disable-all', active, { customer_intelligence: false, order_confidence_mode: 'off' }],
        ['missing shop', null, enrolled],
    ])('%s → not authorized', (_label, shop, pilotFeatures) => {
        expect(computeShopAuthorized({ shop, pilotFeatures })).toBe(false);
    });

    test('shadow order-confidence mode counts as enrollment without any boolean flag', () => {
        expect(computeShopAuthorized({
            shop: active,
            pilotFeatures: { order_confidence_mode: 'shadow' },
        })).toBe(true);
        expect(computeShopAuthorized({
            shop: active,
            pilotFeatures: { order_confidence_mode: 'enforce' },
        })).toBe(true);
    });
});
