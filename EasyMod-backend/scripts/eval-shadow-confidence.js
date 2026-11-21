'use strict';

const assert = require('node:assert/strict');
const { deriveReplyConfidence } = require('../src/modules/ai/reply-confidence.service');
const { development, heldout } = require('./shadow-confidence-fixtures');

const split = process.argv[2] ?? 'heldout';
assert(['development', 'heldout'].includes(split), 'Use development or heldout');
assert.equal(new Set([...development, ...heldout].map(row => row.id)).size, development.length + heldout.length);

const thresholds = [0.60, 0.75, 0.90]; // Offline comparisons only; never loaded by the worker.
const rows = (split === 'heldout' ? heldout : development).map(({ input, ...label }) => {
    const result = deriveReplyConfidence(input);
    assert(result.score === null || (Number.isFinite(result.score) && result.score >= 0 && result.score <= 1));
    assert.deepEqual(deriveReplyConfidence(input), result);
    return { ...label, retrieval: input.evidence.knowledgeOutcome, score: result.score, reasons: result.reasonCodes, provenance: result.provenance };
});

const round = value => Number(value.toFixed(4));
const rate = (n, d) => d === 0 ? null : round(n / d);
// Wilson intervals describe the arithmetic uncertainty of a binomial estimate.
// Non-random synthetic fixtures cannot supply a population confidence interval.
function interval(n, d) {
    if (d === 0) return null;
    const p = n / d;
    const z = 1.96;
    const center = p + z * z / (2 * d);
    const margin = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d));
    const denominator = 1 + z * z / d;
    return [round((center - margin) / denominator), round((center + margin) / denominator)];
}

function summarize(group) {
    const scored = group.filter(row => row.score !== null);
    return {
        n: group.length,
        unscored: group.filter(row => row.score === null).map(row => row.id),
        distribution: Object.fromEntries(['grounded', 'unsupported', 'no_claim'].map(label => [label,
             scored.filter(row => row.grounding === label).map(row => row.score).sort((a, b) => a - b),
        ])),
        thresholds: thresholds.map(threshold => {
            const flagged = scored.filter(row => row.score < threshold);
            const tp = flagged.filter(row => row.review).length;
            const fp = flagged.length - tp;
            const positives = scored.filter(row => row.review).length;
            return {
                threshold, tp, fp, fn: positives - tp, tn: scored.length - positives - fp,
                precision: rate(tp, tp + fp), recall: rate(tp, positives),
                precisionWilson95: interval(tp, tp + fp), recallWilson95: interval(tp, positives),
                falseSafe: scored.filter(row => row.review && row.score >= threshold).map(row => row.id),
                falseHold: flagged.filter(row => !row.review).map(row => row.id),
            };
        }),
    };
}

console.log(JSON.stringify({
    split,
    synthetic: true,
    overall: summarize(rows),
    segments: Object.fromEntries(['lang', 'intent', 'retrieval'].map(dimension => [dimension,
        Object.fromEntries([...new Set(rows.map(row => row[dimension]))].sort().map(value => [value,
            summarize(rows.filter(row => row[dimension] === value)),
        ])),
    ])),
    cases: rows,
}, null, 2));
