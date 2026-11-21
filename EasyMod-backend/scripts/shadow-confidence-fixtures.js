'use strict';

// Synthetic author labels refer to the reply and the independent reference, not
// to what the scorer reports or what an upstream gate happened to mark SEND.
const fixture = (id, lang, intent, reference, deliveredText, grounding, review, options = {}) => {
    const { productStatus = 'NONE', knowledgeOutcome = 'NOT_REQUESTED', ...input } = options;
    return {
        id, lang, intent, reference, grounding, review,
        input: {
            groundingDecision: 'SEND', replySource: 'llm', deliveredText,
            evidence: {
                productStatus,
                verifiedProducts: productStatus === 'VERIFIED' ? [{ id: `fixture-${id}` }] : [],
                knowledgeFound: knowledgeOutcome === 'FOUND',
                knowledgeFailed: ['TIMEOUT', 'FAILED'].includes(knowledgeOutcome),
                knowledgeOutcome,
            },
            ...input,
        },
    };
};

const development = [
    fixture('dev-lamp', 'en', 'price', 'Birch lamp: 640 taka.', 'The birch lamp costs 640 taka.', 'grounded', false, { productStatus: 'VERIFIED' }),
    fixture('dev-return', 'bn', 'returns', 'The policy has no return window.', '৩০ দিনের মধ্যে ফেরত দিতে পারবেন।', 'unsupported', true, { knowledgeOutcome: 'EMPTY_RESULT' }),
    fixture('dev-wallet', 'banglish', 'availability', 'No wallet matched.', 'Exact wallet ta confirm korte parchi na.', 'no_claim', false, { productStatus: 'NOT_FOUND', groundingDecision: 'SAFE_FALLBACK' }),
    fixture('dev-faq', 'en', 'hours', 'FAQ only covers pickup location, not business hours.', 'Pickup is on North Lane.', 'grounded', true, { replySource: 'faq', faqScore: 0.5, knowledgeOutcome: 'FOUND' }),
];

const heldout = [
    fixture('ceramic-price', 'bn', 'price', 'Ceramic cup: 350 taka.', 'সিরামিক কাপটির দাম ৩৫০ টাকা।', 'grounded', false, { productStatus: 'VERIFIED', knowledgeOutcome: 'FAILED' }),
    fixture('linen-stock', 'en', 'availability', 'Green linen tote: out of stock.', 'The green linen tote is in stock.', 'unsupported', true, { productStatus: 'VERIFIED' }),
    fixture('invented-silk', 'banglish', 'availability', 'No red silk scarf on record.', 'Red silk scarf stock e ache.', 'unsupported', true, { productStatus: 'NOT_FOUND' }),
    fixture('brass-price', 'en', 'price', 'Brass tray: 580 taka; the rejected reply said 500.', 'I cannot verify that price right now.', 'no_claim', false, { productStatus: 'VERIFIED', groundingDecision: 'SAFE_FALLBACK', groundingReason: 'UNSUPPORTED_PRICE_CLAIM', violations: ['UNSUPPORTED_PRICE_CLAIM'] }),
    fixture('pickup-faq', 'en', 'pickup', 'The collection desk opens at 11.', 'The collection desk opens at 11.', 'grounded', false, { replySource: 'faq', faqScore: 1, knowledgeOutcome: 'FOUND' }),
    fixture('partial-faq', 'bn', 'returns', 'The retrieved FAQ is about pickup, not refunds.', 'পিকআপের জন্য বিকেল পাঁচটার আগে আসুন।', 'grounded', true, { replySource: 'faq', faqScore: 0.5, knowledgeOutcome: 'FOUND' }),
    fixture('timeout-claim', 'banglish', 'returns', 'Lookup timed out; there is no refund approval.', 'Refund approved hoye geche.', 'unsupported', true, { knowledgeOutcome: 'TIMEOUT' }),
    fixture('failure-fallback', 'bn', 'delivery', 'Knowledge lookup failed; delivery date cannot be verified.', 'ডেলিভারির তারিখ এখন নিশ্চিত করতে পারছি না।', 'no_claim', false, { knowledgeOutcome: 'FAILED', groundingDecision: 'SAFE_FALLBACK' }),
    fixture('unknown-custom', 'en', 'customization', 'No customization policy; asking for details is appropriate.', 'Which engraving style are you looking for?', 'no_claim', false, { knowledgeOutcome: 'NO_MATCHES' }),
    fixture('conflicting-faq', 'banglish', 'delivery', 'Two current entries disagree: 1 day versus 4 days.', 'Kalke delivery confirmed.', 'unsupported', true, { knowledgeOutcome: 'FOUND' }),
    fixture('context-cotton', 'banglish', 'price', 'Prior turn selected the cotton cap, not wool; cotton costs 290 taka.', 'Cotton cap ta 290 taka.', 'grounded', false, { productStatus: 'VERIFIED' }),
    fixture('context-variants', 'bn', 'availability', 'Prior turn selected medium; only large is available.', 'মাঝারি সাইজটি স্টকে আছে।', 'unsupported', true, { productStatus: 'VERIFIED' }),
    fixture('cancel-promise', 'en', 'order', 'No cancellation tool ran; the merchant must approve.', 'Your order has already been cancelled.', 'unsupported', true, { knowledgeOutcome: 'NO_VALID_RESULTS' }),
    fixture('order-prompt', 'bn', 'order', 'A verified checkout state asks for confirmation, not authorization.', 'অর্ডারটি নিশ্চিত করতে চান?', 'no_claim', false, { orderFlowHandled: true }),
    fixture('empty-model', 'banglish', 'customization', 'No useful customer reply can be evaluated.', '', 'no_claim', true, { groundingDecision: 'SUPPRESS', knowledgeOutcome: 'EMPTY_RESULT' }),
    fixture('provider-fallback', 'en', 'pickup', 'Pickup ends at 6; the fallback provider repeats the current policy.', 'Pickup closes at 6.', 'grounded', false, { fallbackUsed: true, knowledgeOutcome: 'FOUND' }),
];

module.exports = { development, heldout };
