'use strict';

/**
 * Reply confidence — an EVIDENCE score, not a probability.
 *
 * Why this exists
 * ---------------
 * Every LLM reply used to report a fixed `0.9` regardless of what evidence
 * supported it (intent-router.service.js:1348), so a 0.75 threshold could only
 * ever reject catastrophic values. There is no calibrated uncertainty source in
 * this codebase — the shadow intent classifier's "confidence" is itself a fixed
 * per-rule constant (stage2-rules.js:272). This module therefore does NOT
 * estimate model uncertainty. It reports how well evidenced the DELIVERED text
 * is, with named components and reason codes, so the number can be inspected
 * and later calibrated against outcomes.
 *
 * The score measures the delivered text, not the rejected candidate
 * ------------------------------------------------------------------
 * When the grounding gate returns SAFE_FALLBACK, the text that reaches the
 * customer is deterministic written copy with the unsupported claim already
 * withdrawn. That copy is supportable by construction, so it scores high and is
 * tagged `deterministic`. Penalising it for the violations that caused the
 * fallback would hold exactly the replies that grounding already made safe —
 * the attribute and price fallbacks that meta-e2e pins as reaching the customer.
 *
 * Not a decision-maker
 * --------------------
 * This value never authorises anything. The Action Gate must not accept a model
 * confidence as authorization (AGENT_ACTION_POLICY §4). It produces only a
 * shadow `wouldHold` prediction and merchant-facing evidence copy; the existing
 * gate continues to consume the router's confidence value.
 *
 * Rollout: shadow. The gate still consumes the existing value; this module's
 * score and `wouldHold` are recorded so the distribution can be reviewed before
 * any enforcement change.
 */

const {
    GroundingDecision,
    ProductEvidenceStatus,
    ReasonCode,
} = require('./grounding/grounding.contract');

const PROVENANCE = Object.freeze({
    MODEL: 'model',
    DETERMINISTIC: 'deterministic',
    FALLBACK: 'fallback',
});

const CONFIDENCE_REASON = Object.freeze({
    GROUNDED: 'GROUNDED',
    ORDER_FLOW: 'ORDER_FLOW',
    SAFE_COPY_DELIVERED: 'SAFE_COPY_DELIVERED',
    SUPPRESSED: 'SUPPRESSED',
    RETRIEVAL_FAILED: 'RETRIEVAL_FAILED',
    RAG_UNAVAILABLE: 'RAG_UNAVAILABLE',
    RAG_TIMEOUT: 'RAG_TIMEOUT',
    KNOWLEDGE_NOT_FOUND: 'KNOWLEDGE_NOT_FOUND',
    KNOWLEDGE_EMPTY_RESULT: 'KNOWLEDGE_EMPTY_RESULT',
    KNOWLEDGE_NO_MATCHES: 'KNOWLEDGE_NO_MATCHES',
    KNOWLEDGE_NO_VALID_RESULTS: 'KNOWLEDGE_NO_VALID_RESULTS',
    NO_KNOWLEDGE_EVIDENCE: 'NO_KNOWLEDGE_EVIDENCE',
    NO_EVIDENCE: 'NO_EVIDENCE',
    GROUNDING_VIOLATIONS: 'GROUNDING_VIOLATIONS',
    EMPTY_COMPLETION: 'EMPTY_COMPLETION',
    PROVIDER_FALLBACK: 'PROVIDER_FALLBACK',
    INVALID_INPUT: 'INVALID_INPUT',
    GROUNDING_DECISION_MISSING: 'GROUNDING_DECISION_MISSING',
    GROUNDING_DECISION_INVALID: 'GROUNDING_DECISION_INVALID',
    EVIDENCE_MISSING: 'EVIDENCE_MISSING',
    EVIDENCE_INVALID: 'EVIDENCE_INVALID',
    INVALID_FAQ_SCORE: 'INVALID_FAQ_SCORE',
    FAQ_PARTIAL_MATCH: 'FAQ_PARTIAL_MATCH',
    PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
    COMPUTATION_FAILED: 'COMPUTATION_FAILED',
});

const VALID_DECISIONS = new Set(Object.values(GroundingDecision));
const VALID_PRODUCT_STATUSES = new Set(Object.values(ProductEvidenceStatus));
const VALID_KNOWLEDGE_OUTCOMES = new Set([
    'NOT_REQUESTED',
    'FOUND',
    'EMPTY_RESULT',
    'NO_MATCHES',
    'NO_VALID_RESULTS',
    'NO_KNOWLEDGE_EVIDENCE',
    'TIMEOUT',
    'FAILED',
]);

/**
 * Penalties are evidence deficits, not opinions. Each is documented so a future
 * calibration can replace them with measured values instead of guessing.
 */
const PENALTY = Object.freeze({
    // Retrieval did not work. Distinct from "the shop has nothing to say" —
    // conflating the two is the fail-open defect this reason code exists for.
    knowledgeUnavailable: 0.30,
    // Retrieval worked and returned nothing on a knowledge question.
    knowledgeNotFound: 0.10,
    // Neither product nor knowledge evidence supports the reply at all.
    noEvidence: 0.15,
    // The gate found unsupported claims it had to strip from a SEND candidate.
    violations: 0.25,
    // The primary provider failed and the fallback answered.
    providerFallback: 0.05,
});

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round2 = (n) => Math.round(n * 100) / 100;

const factComponents = ({
    groundingDecision, groundingReason, violations, evidence, replySource,
    provider, fallbackUsed, orderFlowHandled, faqScore, deliveredText, replyMode,
}) => ({
    groundingDecision: groundingDecision || null,
    groundingReason: groundingReason || null,
    violationCount: Array.isArray(violations) ? violations.length : 0,
    productStatus: evidence?.productStatus ?? null,
    verifiedProductCount: Array.isArray(evidence?.verifiedProducts) ? evidence.verifiedProducts.length : 0,
    knowledgeFound: evidence?.knowledgeFound === true,
    knowledgeFailed: evidence?.knowledgeFailed === true,
    knowledgeOutcome: evidence?.knowledgeOutcome
        || (evidence?.knowledgeFailed === true ? 'FAILED' : evidence?.knowledgeFound === true ? 'FOUND' : 'EMPTY'),
    evidenceSource: orderFlowHandled
        ? 'deterministic_order_flow'
        : groundingDecision === GroundingDecision.SAFE_FALLBACK
            ? 'deterministic_safe_copy'
            : evidence?.productStatus === ProductEvidenceStatus.RETRIEVAL_FAILED
                ? 'product_retrieval_failed'
                : evidence?.verifiedProducts?.length > 0
                    ? 'product_catalog'
                    : replySource === 'faq'
                        ? 'faq'
                        : evidence?.knowledgeFound === true
                            ? 'knowledge_base'
                            : evidence?.knowledgeOutcome === 'TIMEOUT'
                                ? 'knowledge_timeout'
                                : evidence?.knowledgeFailed === true
                                    ? 'knowledge_retrieval_failed'
                                    : evidence?.knowledgeOutcome || 'no_evidence',
    replySource: replySource || null,
    replyMode: ['AUTO', 'DRAFT', 'MANUAL'].includes(replyMode) ? replyMode : null,
    provider: provider || null,
    fallbackUsed: fallbackUsed === true,
    orderFlowHandled: orderFlowHandled === true,
    faqScore: typeof faqScore === 'number' && Number.isFinite(faqScore) ? faqScore : null,
    deliveredTextLength: typeof deliveredText === 'string' ? deliveredText.trim().length : 0,
});

const invalidEvidenceReason = (evidence) => {
    if (evidence === null || evidence === undefined) return CONFIDENCE_REASON.EVIDENCE_MISSING;
    if (typeof evidence !== 'object' || Array.isArray(evidence)) return CONFIDENCE_REASON.EVIDENCE_INVALID;
    if (!VALID_PRODUCT_STATUSES.has(evidence.productStatus) || !Array.isArray(evidence.verifiedProducts)) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeFound !== undefined && typeof evidence.knowledgeFound !== 'boolean') {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeFailed !== undefined && typeof evidence.knowledgeFailed !== 'boolean') {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeOutcome !== undefined
        && !VALID_KNOWLEDGE_OUTCOMES.has(evidence.knowledgeOutcome)) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeFound === true && evidence.knowledgeFailed === true) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeOutcome === 'FOUND' && evidence.knowledgeFound !== true) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (['TIMEOUT', 'FAILED'].includes(evidence.knowledgeOutcome)
        && evidence.knowledgeFailed !== true) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    if (evidence.knowledgeFailed === true
        && evidence.knowledgeOutcome
        && !['TIMEOUT', 'FAILED'].includes(evidence.knowledgeOutcome)) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }

    const verifiedProductCount = evidence.verifiedProducts.length;
    if ((evidence.productStatus === ProductEvidenceStatus.VERIFIED) !== (verifiedProductCount > 0)
        || [...evidence.verifiedProducts].some(product => typeof product?.id !== 'string' || !product.id.trim())) {
        return CONFIDENCE_REASON.EVIDENCE_INVALID;
    }
    return null;
};

const invalidResult = (reasonCode, components = {}) => ({
    score: 0,
    components,
    reasonCodes: [reasonCode],
    provenance: PROVENANCE.FALLBACK,
});

/**
 * @param {object}   input
 * @param {string}   [input.groundingDecision]  GroundingDecision (SEND|SAFE_FALLBACK|SUPPRESS)
 * @param {string}   [input.groundingReason]    ReasonCode emitted by the gate
 * @param {string[]} [input.violations]         violations found on the candidate
 * @param {object}   [input.evidence]           GroundingEvidence (+ knowledgeFailed)
 * @param {string}   [input.replySource]        llm | faq | cache | deterministic source
 * @param {string}   [input.provider]           gemini-lite | gemini-pro | openai
 * @param {boolean}  [input.fallbackUsed]       the fallback provider answered
 * @param {boolean}  [input.orderFlowHandled]   a deterministic order step produced the reply
 * @param {number}   [input.faqScore]           the FAQ tier's own relevance score, if any
 * @param {string}   [input.deliveredText]      text that will actually reach the customer
 * @returns {{score:number|null, components:object, reasonCodes:string[], provenance:string}}
 */
function deriveReplyConfidence(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return invalidResult(CONFIDENCE_REASON.INVALID_INPUT, {
            inputValid: false,
            deliveredTextLength: 0,
        });
    }

    const {
        groundingDecision = null,
        groundingReason = null,
        violations = [],
        evidence,
        replySource = null,
        provider = null,
        fallbackUsed = false,
        orderFlowHandled = false,
        faqScore = null,
        deliveredText = '',
        replyMode = null,
    } = input;
    const components = factComponents({
        groundingDecision, groundingReason, violations, evidence, replySource,
        provider, fallbackUsed, orderFlowHandled, faqScore, deliveredText, replyMode,
    });
    const text = typeof deliveredText === 'string' ? deliveredText.trim() : '';
    const violationList = Array.isArray(violations) ? violations : [];

    if (groundingDecision === null || groundingDecision === undefined) {
        return invalidResult(CONFIDENCE_REASON.GROUNDING_DECISION_MISSING, components);
    }
    if (!VALID_DECISIONS.has(groundingDecision)) {
        return invalidResult(CONFIDENCE_REASON.GROUNDING_DECISION_INVALID, components);
    }

    if (groundingDecision === GroundingDecision.SUPPRESS) {
        const reasonCodes = [CONFIDENCE_REASON.SUPPRESSED];
        if (groundingReason) reasonCodes.push(groundingReason);
        if (violationList.length > 0) reasonCodes.push(CONFIDENCE_REASON.GROUNDING_VIOLATIONS);
        return { score: 0, components, reasonCodes, provenance: PROVENANCE.MODEL };
    }

    if (!text) {
        return {
            score: 0,
            components,
            reasonCodes: [CONFIDENCE_REASON.EMPTY_COMPLETION],
            provenance: PROVENANCE.MODEL,
        };
    }

    if (groundingDecision === GroundingDecision.SAFE_FALLBACK) {
        // The delivered text is deterministic safe copy with the unsupported
        // claim already withdrawn. It is supportable by construction.
        const reasonCodes = [CONFIDENCE_REASON.SAFE_COPY_DELIVERED];
        if (groundingReason) reasonCodes.push(groundingReason);
        if (violationList.length > 0) reasonCodes.push(CONFIDENCE_REASON.GROUNDING_VIOLATIONS);
        if (evidence?.knowledgeOutcome === 'TIMEOUT') reasonCodes.push(CONFIDENCE_REASON.RAG_TIMEOUT);
        else if (evidence?.knowledgeFailed === true) reasonCodes.push(CONFIDENCE_REASON.RAG_UNAVAILABLE);
        else if (evidence?.knowledgeOutcome === 'EMPTY_RESULT') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_EMPTY_RESULT);
        else if (evidence?.knowledgeOutcome === 'NO_MATCHES') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_NO_MATCHES);
        else if (evidence?.knowledgeOutcome === 'NO_VALID_RESULTS') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_NO_VALID_RESULTS);
        else if (evidence?.knowledgeOutcome === 'NO_KNOWLEDGE_EVIDENCE') reasonCodes.push(CONFIDENCE_REASON.NO_KNOWLEDGE_EVIDENCE);
        return {
            score: round2(clamp01(1 - (fallbackUsed ? PENALTY.providerFallback : 0))),
            components,
            reasonCodes,
            provenance: PROVENANCE.DETERMINISTIC,
        };
    }

    if (orderFlowHandled === true) {
        return { score: null, components, reasonCodes: [CONFIDENCE_REASON.ORDER_FLOW], provenance: PROVENANCE.DETERMINISTIC };
    }

    const evidenceError = invalidEvidenceReason(evidence);
    if (evidenceError) return invalidResult(evidenceError, components);

    if (replySource === 'faq'
        && !(typeof faqScore === 'number' && Number.isFinite(faqScore) && faqScore >= 0 && faqScore <= 1)) {
        return invalidResult(CONFIDENCE_REASON.INVALID_FAQ_SCORE, components);
    }

    // ── SEND: the candidate survived grounding ──────────────────────────────
    // Product truth unavailable is not a low-confidence answer, it is no answer.
    if (evidence.productStatus === ProductEvidenceStatus.RETRIEVAL_FAILED) {
        return invalidResult(CONFIDENCE_REASON.RETRIEVAL_FAILED, components);
    }
    if (evidence.productStatus === ProductEvidenceStatus.NOT_FOUND) {
        return invalidResult(CONFIDENCE_REASON.PRODUCT_NOT_FOUND, components);
    }

    let score = 1;
    const reasonCodes = [];
    const hasIndependentEvidence = components.verifiedProductCount > 0
        || evidence.knowledgeFound === true
        || (replySource === 'faq' && typeof faqScore === 'number' && Number.isFinite(faqScore));

    if (evidence.knowledgeOutcome === 'TIMEOUT') {
        if (!hasIndependentEvidence) score -= PENALTY.knowledgeUnavailable;
        reasonCodes.push(CONFIDENCE_REASON.RAG_TIMEOUT);
    } else if (evidence?.knowledgeFailed === true) {
        // A failed knowledge store is still visible, but does not discount an
        // answer independently supported by the authoritative product catalog
        // or an already-matched FAQ.
        if (!hasIndependentEvidence) score -= PENALTY.knowledgeUnavailable;
        reasonCodes.push(CONFIDENCE_REASON.RAG_UNAVAILABLE);
    }
    if (evidence.knowledgeOutcome === 'EMPTY_RESULT') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_EMPTY_RESULT);
    if (evidence.knowledgeOutcome === 'NO_MATCHES') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_NO_MATCHES);
    if (evidence.knowledgeOutcome === 'NO_VALID_RESULTS') reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_NO_VALID_RESULTS);
    if (evidence.knowledgeOutcome === 'NO_KNOWLEDGE_EVIDENCE') reasonCodes.push(CONFIDENCE_REASON.NO_KNOWLEDGE_EVIDENCE);
    if (groundingReason === ReasonCode.KNOWLEDGE_NOT_FOUND) {
        score -= PENALTY.knowledgeNotFound;
        reasonCodes.push(CONFIDENCE_REASON.KNOWLEDGE_NOT_FOUND);
    }
    if (
        (evidence.productStatus === ProductEvidenceStatus.NONE
            || evidence.productStatus === ProductEvidenceStatus.NOT_FOUND)
        && components.verifiedProductCount === 0
        && evidence?.knowledgeFound !== true
    ) {
        score -= PENALTY.noEvidence;
        reasonCodes.push(CONFIDENCE_REASON.NO_EVIDENCE);
    }
    if (violationList.length > 0) {
        score -= PENALTY.violations;
        reasonCodes.push(CONFIDENCE_REASON.GROUNDING_VIOLATIONS);
    }
    if (fallbackUsed) {
        score -= PENALTY.providerFallback;
        reasonCodes.push(CONFIDENCE_REASON.PROVIDER_FALLBACK);
    }

    // The FAQ tier already computes a relevance score; never widen it. Taking
    // the minimum preserves the existing behaviour where a partial keyword
    // match is correctly held.
    if (typeof faqScore === 'number' && Number.isFinite(faqScore)) {
        score = Math.min(score, faqScore);
        if (faqScore < 1) reasonCodes.push(CONFIDENCE_REASON.FAQ_PARTIAL_MATCH);
    }

    score = round2(clamp01(score));
    if (reasonCodes.length === 0 || (hasIndependentEvidence && reasonCodes.every(code => [
        CONFIDENCE_REASON.KNOWLEDGE_EMPTY_RESULT, CONFIDENCE_REASON.KNOWLEDGE_NO_MATCHES,
        CONFIDENCE_REASON.KNOWLEDGE_NO_VALID_RESULTS, CONFIDENCE_REASON.NO_KNOWLEDGE_EVIDENCE,
    ].includes(code)))) {
        reasonCodes.push(CONFIDENCE_REASON.GROUNDED);
    }

    return {
        score,
        components,
        reasonCodes,
        provenance: fallbackUsed ? PROVENANCE.FALLBACK : PROVENANCE.MODEL,
    };
}

module.exports = {
    deriveReplyConfidence,
    PROVENANCE,
    CONFIDENCE_REASON,
    PENALTY,
};
