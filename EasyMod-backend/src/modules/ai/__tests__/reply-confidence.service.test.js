'use strict';

const {
    deriveReplyConfidence,
    PROVENANCE,
    CONFIDENCE_REASON,
} = require('../reply-confidence.service');
const { GroundingDecision, ReasonCode } = require('../grounding/grounding.contract');

const groundedEvidence = {
    productStatus: 'VERIFIED',
    verifiedProducts: [{ id: 'p1' }],
    knowledgeFound: false,
    knowledgeFailed: false,
};

describe('deriveReplyConfidence — evidence score, not a probability', () => {
    test('a nonempty allowed order-flow turn is labelled deterministic without scoring', () => {
        const result = deriveReplyConfidence({
            orderFlowHandled: true,
            groundingDecision: GroundingDecision.SEND,
            deliveredText: 'Your order is confirmed.',
        });
        expect(result.score).toBeNull();
        expect(result.provenance).toBe(PROVENANCE.DETERMINISTIC);
        expect(result.reasonCodes).toEqual([CONFIDENCE_REASON.ORDER_FLOW]);
    });

    test.each(['SEND', 'SUPPRESS'])('order flow does not mask a blank or suppressed outcome (%s)', groundingDecision => {
        expect(deriveReplyConfidence({ orderFlowHandled: true, groundingDecision, deliveredText: '' }).score).toBe(0);
    });

    test('a malformed catalog row is not treated as verified product evidence', () => {
        const result = deriveReplyConfidence({
            groundingDecision: 'SEND', deliveredText: 'It is in stock.',
            evidence: { ...groundedEvidence, verifiedProducts: [null, {}] },
        });
        expect(result).toMatchObject({ score: 0, reasonCodes: ['EVIDENCE_INVALID'] });
    });

    test('an empty completion scores zero with a reason', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            deliveredText: '   ',
        });
        expect(result.score).toBe(0);
        expect(result.reasonCodes).toEqual([CONFIDENCE_REASON.EMPTY_COMPLETION]);
    });

    test('a suppressed candidate scores zero and carries the grounding reason', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SUPPRESS,
            groundingReason: ReasonCode.UNSUPPORTED_PRICE_CLAIM,
            deliveredText: 'It costs 500 taka.',
        });
        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.SUPPRESSED);
        expect(result.reasonCodes).toContain(ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('the DELIVERED safe-fallback copy is supportable, not penalised', () => {
        // The customer receives deterministic copy with the claim withdrawn.
        // Scoring this low would hold the attribute fallbacks that meta-e2e
        // pins as reaching the customer.
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SAFE_FALLBACK,
            groundingReason: ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN,
            violations: ['attribute_asserted_but_unknown:material'],
            evidence: { ...groundedEvidence, verifiedProducts: [] },
            deliveredText: 'I do not have the fabric recorded for that item. Please confirm with the shop.',
        });
        expect(result.score).toBe(1);
        expect(result.provenance).toBe(PROVENANCE.DETERMINISTIC);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.SAFE_COPY_DELIVERED);
        expect(result.reasonCodes).toContain(ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a fully grounded model reply scores above the default threshold', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            groundingReason: ReasonCode.GROUNDED,
            evidence: groundedEvidence,
            replySource: 'llm',
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });
        expect(result.score).toBe(1);
        expect(result.provenance).toBe(PROVENANCE.MODEL);
        expect(result.reasonCodes).toEqual([CONFIDENCE_REASON.GROUNDED]);
    });

    test('a knowledge-retrieval outage lowers the score below the default threshold', () => {
        // This is the fail-open case: retrieval broke, the answer still looks
        // fluent. The shadow score must show it.
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: {
                ...groundedEvidence,
                knowledgeFailed: true,
                knowledgeOutcome: 'FAILED',
                productStatus: 'NONE',
                verifiedProducts: [],
            },
            replySource: 'llm',
            deliveredText: 'Our return policy allows exchange within seven days.',
        });
        expect(result.score).toBeLessThan(0.75);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.RAG_UNAVAILABLE);
    });

    test.each([
        ['FAILED', CONFIDENCE_REASON.RAG_UNAVAILABLE],
        ['TIMEOUT', CONFIDENCE_REASON.RAG_TIMEOUT],
    ])('a knowledge %s remains visible without discounting independent product evidence', (knowledgeOutcome, reason) => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: {
                ...groundedEvidence,
                knowledgeFailed: true,
                knowledgeOutcome,
            },
            replySource: 'llm',
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });

        expect(result.score).toBe(1);
        expect(result.components).toMatchObject({ knowledgeOutcome, verifiedProductCount: 1 });
        expect(result.reasonCodes).toContain(reason);
        expect(result.reasonCodes).not.toContain(CONFIDENCE_REASON.GROUNDED);
    });

    test('an unavailable diagnostic is distinct from retrieval that was not requested', () => {
        const unknown = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { ...groundedEvidence, knowledgeOutcome: 'UNKNOWN' },
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });
        const notRequested = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: groundedEvidence,
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });

        expect(unknown.components.knowledgeOutcome).toBe('UNKNOWN');
        expect(notRequested.components.knowledgeOutcome).toBe('NOT_REQUESTED');
        expect(unknown.score).toBe(1);
        expect(notRequested.score).toBe(1);
    });

    test('a knowledge outage is distinguished from a reply with no evidence at all', () => {
        const outage = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { productStatus: 'NONE', verifiedProducts: [], knowledgeFound: false, knowledgeFailed: true },
            deliveredText: 'We open at ten.',
        });
        const nothing = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { productStatus: 'NONE', verifiedProducts: [], knowledgeFound: false, knowledgeFailed: false },
            deliveredText: 'We open at ten.',
        });
        expect(outage.score).toBeLessThan(nothing.score);
        expect(outage.reasonCodes).toContain(CONFIDENCE_REASON.RAG_UNAVAILABLE);
        expect(nothing.reasonCodes).toContain(CONFIDENCE_REASON.NO_EVIDENCE);
    });

    test('retrieval timeout and successful empty results remain distinct', () => {
        const timeout = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: {
                productStatus: 'NONE',
                verifiedProducts: [],
                knowledgeFound: false,
                knowledgeFailed: true,
                knowledgeOutcome: 'TIMEOUT',
            },
            deliveredText: 'I will check and get back to you.',
        });
        const empty = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: {
                productStatus: 'NONE',
                verifiedProducts: [],
                knowledgeFound: false,
                knowledgeFailed: false,
                knowledgeOutcome: 'EMPTY_RESULT',
            },
            deliveredText: 'Please share more details so I can help.',
        });

        expect(timeout.score).toBeLessThan(empty.score);
        expect(timeout.reasonCodes).toContain(CONFIDENCE_REASON.RAG_TIMEOUT);
        expect(timeout.reasonCodes).not.toContain(CONFIDENCE_REASON.RAG_UNAVAILABLE);
        expect(empty.reasonCodes).toContain(CONFIDENCE_REASON.KNOWLEDGE_EMPTY_RESULT);
        expect(empty.reasonCodes).toContain(CONFIDENCE_REASON.NO_EVIDENCE);
    });

    test('an empty knowledge search does not hide independent product evidence', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { verifiedProducts: [{ id: 'fixture' }], productStatus: 'VERIFIED', knowledgeOutcome: 'EMPTY_RESULT' },
            deliveredText: 'The shirt costs 100 taka.',
        });
        expect(result.reasonCodes).toEqual(expect.arrayContaining([
            CONFIDENCE_REASON.KNOWLEDGE_EMPTY_RESULT, CONFIDENCE_REASON.GROUNDED,
        ]));
    });

    test('unavailable product truth is no answer, not a low-confidence one', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { ...groundedEvidence, productStatus: 'RETRIEVAL_FAILED', verifiedProducts: [] },
            deliveredText: 'Yes, we have that in stock.',
        });
        expect(result.score).toBe(0);
        expect(result.reasonCodes).toEqual([CONFIDENCE_REASON.RETRIEVAL_FAILED]);
    });

    test('grounding violations reduce a SEND candidate and are named', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            violations: ['unsupported_url:1'],
            evidence: groundedEvidence,
            deliveredText: 'See the photo.',
        });
        expect(result.score).toBeCloseTo(0.75, 2);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.GROUNDING_VIOLATIONS);
    });

    test('the FAQ tier never widens: a partial keyword match stays below threshold', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: groundedEvidence,
            replySource: 'faq',
            faqScore: 0.67,
            deliveredText: 'Delivery inside Dhaka is 60 taka.',
        });
        expect(result.score).toBeCloseTo(0.67, 2);
        expect(result.components.faqScore).toBe(0.67);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.FAQ_PARTIAL_MATCH);
        expect(result.reasonCodes).not.toContain(CONFIDENCE_REASON.GROUNDED);
    });

    test('a missing FAQ relevance score cannot become a grounded success', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: groundedEvidence,
            replySource: 'faq',
            deliveredText: 'The return window is seven days.',
        });

        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.INVALID_FAQ_SCORE);
    });

    test.each([null, '0.67', Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])(
        'a malformed FAQ relevance score (%s) fails conservatively',
        (faqScore) => {
            const result = deriveReplyConfidence({
                groundingDecision: GroundingDecision.SEND,
                evidence: groundedEvidence,
                replySource: 'faq',
                faqScore,
                deliveredText: 'The return window is seven days.',
            });

            expect(result.score).toBe(0);
            expect(result.reasonCodes).toContain(CONFIDENCE_REASON.INVALID_FAQ_SCORE);
        },
    );

    test('a model SEND verdict cannot turn a catalog no-match into a success', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { ...groundedEvidence, productStatus: 'NOT_FOUND', verifiedProducts: [] },
            deliveredText: 'Yes, that item is available for 1290 taka.',
        });

        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.PRODUCT_NOT_FOUND);
    });

    test('a missing grounding decision is not treated as SEND', () => {
        const result = deriveReplyConfidence({
            evidence: groundedEvidence,
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });

        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.GROUNDING_DECISION_MISSING);
    });

    test('an unknown grounding decision is not treated as SEND', () => {
        const result = deriveReplyConfidence({
            groundingDecision: 'DELIVER_ANYWAY',
            evidence: groundedEvidence,
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });

        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.GROUNDING_DECISION_INVALID);
    });

    test('missing or contradictory evidence cannot produce a reassuring score', () => {
        const missing = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });
        const contradictory = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { ...groundedEvidence, verifiedProducts: [] },
            deliveredText: 'The black Panjabi is 1290 taka and in stock.',
        });

        expect(missing.score).toBe(0);
        expect(missing.reasonCodes).toContain(CONFIDENCE_REASON.EVIDENCE_MISSING);
        expect(contradictory.score).toBe(0);
        expect(contradictory.reasonCodes).toContain(CONFIDENCE_REASON.EVIDENCE_INVALID);
    });

    test('null input is safe and deterministic', () => {
        expect(deriveReplyConfidence(null)).toEqual(deriveReplyConfidence(null));
        expect(deriveReplyConfidence(null).score).toBe(0);
        expect(deriveReplyConfidence(null).reasonCodes).toContain(CONFIDENCE_REASON.INVALID_INPUT);
    });

    test('suppression remains visible when the suppressed candidate is empty', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SUPPRESS,
            deliveredText: '',
        });

        expect(result.score).toBe(0);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.SUPPRESSED);
    });

    test.each([
        'The black Panjabi is in stock.',
        'কালো পাঞ্জাবি স্টকে আছে।',
        'Black panjabi stock e ache.',
    ])('the same evidence yields stable bounds for multilingual text: %s', (deliveredText) => {
        const input = {
            groundingDecision: GroundingDecision.SEND,
            evidence: groundedEvidence,
            replySource: 'llm',
            deliveredText,
        };
        const first = deriveReplyConfidence(input);
        const second = deriveReplyConfidence(input);

        expect(first).toEqual(second);
        expect(first.score).toBeGreaterThanOrEqual(0);
        expect(first.score).toBeLessThanOrEqual(1);
    });

    test('a fallback provider is recorded without being treated as ungrounded', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            evidence: { ...groundedEvidence, knowledgeFailed: true, knowledgeOutcome: 'TIMEOUT' },
            replySource: 'llm',
            provider: 'openai',
            fallbackUsed: true,
            deliveredText: 'The black Panjabi is 1290 taka.',
        });
        expect(result.provenance).toBe(PROVENANCE.FALLBACK);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.PROVIDER_FALLBACK);
        expect(result.reasonCodes).toContain(CONFIDENCE_REASON.RAG_TIMEOUT);
        expect(result.score).toBe(0.95);
    });

    test('components are recorded as facts for later calibration', () => {
        const result = deriveReplyConfidence({
            groundingDecision: GroundingDecision.SEND,
            groundingReason: ReasonCode.GROUNDED,
            evidence: groundedEvidence,
            replySource: 'llm',
            provider: 'gemini-lite',
            deliveredText: 'The black Panjabi is 1290 taka.',
        });
        expect(result.components).toEqual(expect.objectContaining({
            groundingDecision: GroundingDecision.SEND,
            groundingReason: ReasonCode.GROUNDED,
            violationCount: 0,
            productStatus: 'VERIFIED',
            verifiedProductCount: 1,
            knowledgeFound: false,
            knowledgeFailed: false,
            replySource: 'llm',
            provider: 'gemini-lite',
            orderFlowHandled: false,
        }));
    });
});
