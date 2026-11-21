'use strict';

/**
 * P03 CROSS-SYSTEM — what the merchant saves is what the bot may say.
 *
 * The save path (merchant API), the retrieval path (webhook → worker →
 * knowledge/catalog reads) and the reply path (grounding gate → Graph send)
 * all had isolated coverage; nothing in the suite drove ONE value through
 * all three in a single chain, which is exactly where config defects hide:
 *
 *   - a saved FAQ whose QUESTION the service overwrote (D3);
 *   - a saved rule/product that never reaches the conversational context;
 *   - shop B's data leaking into shop A's answer (or the reverse);
 *   - absent data fabricated by the model into a business fact.
 *
 * Every leg here enters through the REAL routers (auth → validator →
 * controller → service), then delivers a signed, Meta-shaped webhook and
 * drains the real queue into the real worker. Only the two wire transports
 * are captured (tests/meta-e2e/transport.js): the Graph send and the LLM
 * request — and the LLM capture is what makes "the NEW value appeared in the
 * context the model was given" an observable fact rather than a guess.
 *
 * Grounding contract under test: "LLM output is a candidate response, not an
 * authoritative response" (docs/ai-cost/AI_TRUST_BOUNDARY.md) — the gate at
 * src/modules/ai/grounding/outbound-grounding.gate.js.
 */

const harness = require('./harness');
const transport = require('./transport');
const fixtures = require('./fixtures');
const grounding = require('../../src/modules/ai/grounding');
const { IDS, CUSTOMER_PSID } = fixtures;
const { GroundingDecision, ProductEvidenceStatus } = grounding;

jest.setTimeout(120000);

beforeAll(async () => {
    await harness.setupSuite();
});

beforeEach(async () => {
    await harness.resetRun();
});

afterAll(async () => {
    await harness.teardownSuite();
});

/** Serialized LLM requests since `sinceIndex` — the actual prompt payloads. */
const promptsSince = (sinceIndex) => transport.capturedLlmCalls()
    .slice(sinceIndex)
    .map((call) => JSON.stringify(call.request || {}));

describe('P03 CROSS-SYSTEM — save through the merchant API → retrieve → reply', () => {

    test('a FAQ saved through the API is retrieved by the worker turn and quoted to the customer (P03 D3 live)', async () => {
        const merchant = await harness.asMerchant(IDS.shopA);

        const created = await harness.merchantPost(merchant, '/api/knowledge/faqs', {
            // D3 shape: category AND question supplied, with different text.
            // The merchant's QUESTION must be what survives and is retrieved.
            question: 'delivery chattogram',
            answer: 'Delivery to Chattogram costs 95 taka.',
            category: 'shipping',
        });
        expect(created.status).toBe(201);
        expect(created.body.success).toBe(true);
        const faqId = String(created.body.data.id);
        expect(created.body.data.question).toBe('delivery chattogram');

        // The read-back through the merchant API also proves the stored text.
        const listed = await harness.merchantGet(merchant, '/api/knowledge/faqs');
        expect(listed.status).toBe(200);
        const storedFaq = listed.body.data.find((faq) => String(faq.id) === faqId);
        expect(storedFaq.question).toBe('delivery chattogram');

        const promptsBefore = transport.capturedLlmCalls().length;
        const result = await harness.deliver({
            text: 'delivery chattogram',
            candidate: 'Delivery to Chattogram costs 95 taka.',
        });

        // Retrieval: the FAQ text the merchant just saved is in the real
        // prompt the pipeline handed to the model.
        const prompts = promptsSince(promptsBefore);
        expect(prompts.some((p) => p.includes('Delivery to Chattogram costs 95 taka'))).toBe(true);

        // Reply: the NEW value reached the customer, attributed to the FAQ row.
        expect(result.decision.decision).toBe(GroundingDecision.SEND);
        expect(result.decision.knowledgeIds.map(String)).toContain(faqId);
        expect(harness.sentBody(result.sends)).toContain('95 taka');

        // Cross-shop: the identical question on Shop B's Page must never see
        // Shop A's saved fact — not in the prompt, not in the reply.
        const promptsBeforeB = transport.capturedLlmCalls().length;
        const other = await harness.deliver({
            text: 'delivery chattogram',
            pageId: IDS.pageB,
            candidate: 'Let me check the delivery details for you.',
        });
        const promptsB = promptsSince(promptsBeforeB);
        expect(promptsB.length).toBeGreaterThan(0);
        expect(promptsB.some((p) => p.includes('95 taka') || p.includes('Chattogram'))).toBe(false);
        expect(harness.sentBody(other.sends)).not.toContain('95 taka');
        expect(other.decision.knowledgeIds.map(String)).not.toContain(faqId);
    });

    test("a business rule saved through the API reaches THAT shop's prompt only", async () => {
        const merchantA = await harness.asMerchant(IDS.shopA);

        const saved = await harness.merchantPut(merchantA, '/api/shop/business-info', {
            additionalInfo: 'Exchange requires an unboxing video EM-P03-RULE-42',
        });
        expect(saved.status).toBe(200);
        expect(saved.body.success).toBe(true);
        expect(saved.body.data.businessInfo.additionalInfo).toContain('EM-P03-RULE-42');

        // Shop A's next AI turn is built from a freshly-read context — the
        // save invalidated the knowledge caches, so the rule is visible with
        // no TTL wait.
        const promptsBeforeA = transport.capturedLlmCalls().length;
        await harness.deliver({
            text: 'exchange rule',
            candidate: 'For exchanges, please keep an unboxing video ready.',
        });
        const promptsA = promptsSince(promptsBeforeA);
        expect(promptsA.length).toBeGreaterThan(0);
        expect(promptsA.some((p) => p.includes('EM-P03-RULE-42'))).toBe(true);

        // Shop B's context for the same question never contains Shop A's rule.
        const promptsBeforeB = transport.capturedLlmCalls().length;
        await harness.deliver({
            text: 'exchange rule',
            pageId: IDS.pageB,
            candidate: 'Thanks for your question about exchanges.',
        });
        const promptsB = promptsSince(promptsBeforeB);
        expect(promptsB.length).toBeGreaterThan(0);
        expect(promptsB.every((p) => !p.includes('EM-P03-RULE-42'))).toBe(true);
    });

    test('a product saved through the merchant API becomes quotable catalog truth', async () => {
        const merchant = await harness.asMerchant(IDS.shopA);

        const created = await harness.merchantPost(merchant, '/api/product', {
            name: 'EM E2E Jamdani Stole',
            price: 650,
            description: 'Handloom jamdani stole.',
            quantity: 10,
            track_quantity: true,
        });
        expect(created.status).toBe(201);
        const productId = String(created.body.data.id || created.body.data.product?.id);
        expect(productId).toBeTruthy();

        const result = await harness.deliver({
            text: 'jamdani stole ache?',
            // Deliberately contradicting the catalog: a saved, active product
            // must not be answered as absent.
            candidate: 'We do not have that item.',
        });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(result.decision.verifiedProductIds.map(String)).toContain(productId);
        const sent = harness.sentBody(result.sends);
        expect(sent).toContain('650');          // the NEW saved price reached the customer
        expect(sent).not.toMatch(/do not have that/i); // and the model's denial was overridden
    });

    test('data that does not exist is never fabricated into a business fact', async () => {
        // Nothing in either shop mentions loyalty. A model output inventing a
        // fee must not reach Meta — on either Page.
        const fabricating = 'Yes! Loyalty signup is 4477 taka.';

        const shopA = await harness.deliver({
            text: 'loyalty signup',
            candidate: fabricating,
        });
        expect(shopA.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(harness.sentBody(shopA.sends)).not.toContain('4477');

        const shopB = await harness.deliver({
            text: 'loyalty signup',
            pageId: IDS.pageB,
            candidate: fabricating,
        });
        expect(shopB.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(harness.sentBody(shopB.sends)).not.toContain('4477');
    });
});
