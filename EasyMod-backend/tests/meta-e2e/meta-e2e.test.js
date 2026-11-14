'use strict';

/**
 * META-E2E — the production-shaped pipeline, asserted at the Meta boundary.
 *
 *   LLM output is a candidate response, not an authoritative response.
 *   — docs/ai-cost/AI_TRUST_BOUNDARY.md
 *
 * Pipeline scenarios enter through the real signed webhook route and assert on
 * (a) what the Graph Send API would actually have received and (b) the grounding
 * decision EasyModerator recorded for that reply. The suite also includes a
 * direct outbound-gate attachment test and retrieval-spy outage cases; those
 * exercise narrow boundaries without entering through the webhook. The Graph
 * and model wire transports are captured by tests/meta-e2e/transport.js, and
 * tests/meta-e2e/README.md documents where automated transport ends.
 */

const harness = require('./harness');
const transport = require('./transport');
const fixtures = require('./fixtures');
const grounding = require('../../src/modules/ai/grounding');
const productSearch = require('../../src/modules/product/product-search.service');
const {
    UsageEvent, Subscription, Customer, Conversation, Message,
    Product,
} = require('../../src/modules/entities');
const MetaChannelSettings = require('../../src/modules/channel-providers/meta-channel-settings.entity');
const shopService = require('../../src/modules/shop/shop.service');

const { IDS, RUNTIME, EXPECTED, CUSTOMER_PSID, CUSTOMER_PSID_PAGE_A2 } = fixtures;
const { GroundingDecision, ReasonCode, ProductEvidenceStatus, MediaStatus } = grounding;

const LANGUAGES = ['bn', 'en', 'mixed'];

/** Is this text one of EasyModerator's own written replies, in any language? */
const isWrittenReply = (text, builder) =>
    LANGUAGES.some((lang) => text.includes(builder(lang)));

/** Everything a customer would have received across the captured sends. */
const body = (result) => harness.sentBody(result.sends);

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

// ─────────────────────────────────────────────────────────────────────────────
// Transport preconditions — if these fail, nothing below means anything.
// ─────────────────────────────────────────────────────────────────────────────

describe('the webhook boundary itself', () => {
    test('an unsigned payload is rejected before any pipeline work', async () => {
        const payload = harness.messagePayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID, text: 'black panjabi ache?',
        });

        const response = await harness.postWebhook(payload, { signature: 'sha256=deadbeef' });

        expect(response.status).toBe(403);
        // The invalid signature is rejected before the awaited queue handoff, so
        // no durable job may exist after the response.
        expect(await harness.waitForJobs(1, { timeoutMs: 1000 })).toHaveLength(0);
        expect(transport.capturedSends()).toHaveLength(0);
    });

    test('a signed payload awaits a real BullMQ handoff with exact receipt and Page binding', async () => {
        transport.setCandidate('EM E2E Black Panjabi — ৳1847.');
        const payload = harness.messagePayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID, text: 'black panjabi ache?',
        });

        const response = await harness.postWebhook(payload);
        // The route response is returned only after Queue.add resolves and the
        // durable receipt records ownership by the queue.
        const jobs = await harness.waitForJobs(1);

        expect(response.status).toBe(200);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].data).toMatchObject({
            shopId: IDS.shopA,
            metaChannelId: IDS.channelA,
            metaAssetId: IDS.pageA,
            platform: 'facebook',
            recipientId: CUSTOMER_PSID,
        });
        const receipt = await harness.receiptForEvent(payload.entry[0].messaging[0].message.mid);
        expect(receipt).toMatchObject({
            page_id: IDS.pageA,
            meta_channel_id: IDS.channelA,
            status: 'QUEUED',
        });
        expect(receipt.payload_encrypted).toMatch(/^v1:/);
        expect(receipt.queue_job_id).toBeTruthy();

        // And the worker really consumes it.
        const [result] = await harness.drainQueue();
        expect(result.sent).toBe(true);
        expect(await harness.receiptsWithStatus('DEAD_LETTERED')).toHaveLength(0);
    });

    test('a redelivered message id is deduplicated, not answered twice', async () => {
        const mid = 'm_e2e_redelivery_fixed';
        const first = await harness.deliver({
            text: 'black panjabi ache?', mid,
            candidate: 'EM E2E Black Panjabi — ৳1847.',
        });
        const second = await harness.deliver({ text: 'black panjabi ache?', mid });

        expect(first.sends.length).toBeGreaterThan(0);
        expect(second.sends).toHaveLength(0);
        expect(second.jobResults).toHaveLength(0);
        expect(second.receipt.id).toBe(first.receipt.id);
        expect(await harness.receiptsWithStatus('QUEUED')).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-001 — nonexistent product
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-001 — a product this catalog does not contain', () => {
    test('"chiffon saree ache?" is answered from the catalog, with no model call', async () => {
        const result = await harness.deliver({
            text: EXPECTED.nonexistentProductQuery,
            // Scripted hallucination. It must never be reachable: a NOT_FOUND
            // product question is answered deterministically, with zero tokens.
            candidate: 'Ji, chiffon saree ache! Dam 2200 taka, soft chiffon fabric.',
        });

        expect(result.status).toBe(200);

        // The model was never consulted (AI_TRUST_BOUNDARY §12).
        expect(transport.llmProvidersCalled()).toEqual([]);

        const decision = result.decision;
        expect(decision.productStatus).toBe(ProductEvidenceStatus.NOT_FOUND);
        expect(decision.verifiedProductIds).toEqual([]);
        expect(decision.mediaProductId).toBeNull();
        expect(decision.decision).toBe(GroundingDecision.SEND); // written copy, sent as-is
        expect(decision.violations).toEqual([]);

        const sent = body(result);
        expect(isWrittenReply(sent, grounding.productNotFoundReply)).toBe(true);
        expect(sent).not.toContain('2200');
        expect(sent).not.toMatch(/chiffon saree/i);
        expect(harness.sentAttachments(result.sends)).toEqual([]);

        // Alternatives offered are real rows of this shop, nothing else.
        for (const line of sent.split('\n').filter((l) => l.trim().startsWith('•'))) {
            expect(line).toMatch(/EM E2E (Cotton Saree|Chiffon Kurti)/);
        }
    });

    test('the stored reply carries the grounding stamps that explain it', async () => {
        await harness.deliver({
            text: EXPECTED.nonexistentProductQuery,
            candidate: 'Ji, chiffon saree ache!',
        });

        const stored = await harness.lastStoredAiMessage(IDS.shopA);
        expect(stored.metadata.grounding_decision).toBe(GroundingDecision.SEND);
        expect(stored.metadata.grounding_reason).toBe(ReasonCode.GROUNDED);
        expect(stored.metadata.grounding_product_status).toBe(ProductEvidenceStatus.NOT_FOUND);
        // The rest of the evidence is on the row too, so an incident review — or
        // the live Meta certification — never has to scrape a rotating log.
        expect(stored.metadata.grounding_verified_product_ids).toEqual([]);
        expect(stored.metadata.grounding_media_product_id).toBeNull();
        expect(stored.metadata.grounding_attachment_urls).toEqual([]);
        // No provider: this answer was written from the catalog, not by a model.
        expect(stored.metadata.grounding_provider).toBeNull();
        expect(Array.isArray(stored.metadata.grounding_violations)).toBe(true);
        // source_references may only ever contain real catalog rows.
        for (const ref of stored.source_references || []) {
            if (ref.kind === 'product') {
                expect([IDS.relatedProduct, IDS.unknownMaterialProduct]).toContain(ref.id);
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-002 — repeated pressure
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-002 — the same conversation under repeated pressure', () => {
    test('four escalating turns never produce a product, a price, a photo or a Page link', async () => {
        const first = await harness.deliver({
            text: EXPECTED.nonexistentProductQuery,
            candidate: 'Ji, chiffon saree ache — 2200 taka.',
        });
        expect(first.decision.productStatus).toBe(ProductEvidenceStatus.NOT_FOUND);

        // Each follow-up scripts the model doing exactly what it did in the
        // production incident: assert it exists, quote a price, offer the Page.
        const pressure = [
            { text: 'picture den', candidate: 'Ei nin chobi: https://facebook.com/EasyModeratorE2E' },
            { text: 'try koren', candidate: 'Try korlam — ji chiffon saree ta ache, 2200 taka.' },
            { text: 'abar check koren', candidate: `Check korlam, ache. Chobi: ${EXPECTED.relatedProductImage}` },
            { text: 'are you sure?', candidate: 'Ji sure — 2200 takay chiffon saree ta pathiye dicchi.' },
        ];

        for (const turn of pressure) {
            const result = await harness.deliver(turn);
            const sent = body(result);

            expect(result.decision.verifiedProductIds).toEqual([]);
            expect(result.decision.productStatus).not.toBe(ProductEvidenceStatus.VERIFIED);
            expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);

            expect(sent).not.toContain('2200');
            expect(sent).not.toContain('facebook.com');
            expect(sent).not.toContain(EXPECTED.relatedProductImage);
            expect(harness.sentAttachments(result.sends)).toEqual([]);
        }

        // Nothing the assistant said along the way was ever recorded as evidence.
        const conversation = await harness.conversationFor(IDS.shopA);
        const stored = await harness.messagesFor(conversation.id);
        for (const message of stored.filter((m) => m.sender === 'ai')) {
            expect(message.metadata.grounding_product_status)
                .not.toBe(ProductEvidenceStatus.VERIFIED);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-003 — known product
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-003 — a product this shop really sells', () => {
    test('the verified price and tenant-owned photo reach Meta', async () => {
        const result = await harness.deliver({
            text: 'black panjabi picture den',
        });

        const decision = result.decision;
        expect(decision.decision).toBe(GroundingDecision.SEND);
        expect(decision.reasonCode).toBe(ReasonCode.GROUNDED);
        expect(decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(decision.verifiedProductIds).toEqual([IDS.knownProduct]);
        expect(decision.mediaStatus).toBe(MediaStatus.AVAILABLE);
        expect(decision.mediaProductId).toBe(IDS.knownProduct);
        expect(decision.violations).toEqual([]);
        // Product price plus media requests take the deterministic catalog
        // presentation path; no model candidate is needed to state these facts.
        expect(decision.provider).toBeNull();
        expect(transport.llmProvidersCalled()).toEqual([]);

        const sent = body(result);
        expect(sent).toContain('৳1,847');
        expect(sent).not.toContain(EXPECTED.aiSuggestedProductMaterial);

        // Exactly one attachment, and it is this product's own stored image.
        const attachments = harness.sentAttachments(result.sends);
        expect(attachments).toHaveLength(1);
        expect(attachments[0].type).toBe('image');
        expect(attachments[0].payload.url).toBe(EXPECTED.knownProductImage);

        const stored = await harness.lastStoredAiMessage(IDS.shopA);
        expect(stored.metadata.grounding_decision).toBe(GroundingDecision.SEND);
        expect(stored.metadata.grounding_product_status).toBe(ProductEvidenceStatus.VERIFIED);
        // The row records which product owned the media and what URL went out —
        // the two facts an attachment-provenance dispute turns on.
        expect(stored.metadata.grounding_verified_product_ids).toEqual([IDS.knownProduct]);
        expect(stored.metadata.grounding_media_status).toBe(MediaStatus.AVAILABLE);
        expect(stored.metadata.grounding_media_product_id).toBe(IDS.knownProduct);
        expect(stored.metadata.grounding_attachment_urls).toEqual([EXPECTED.knownProductImage]);
        // Meta's own mid, so a delivered reply can be traced back from a support
        // thread without guessing which row it was.
        expect(stored.metadata.delivered).toBe(true);
        expect(stored.metadata.provider_message_id).toMatch(/^mid\./);
        expect(stored.source_references).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'product', id: IDS.knownProduct })]),
        );
    });

    test('AI-derived material remains uncertain in the customer reply', async () => {
        const result = await harness.deliver({
            text: 'black panjabi material?',
            candidate: `${EXPECTED.knownProductName} material is ${EXPECTED.aiSuggestedProductMaterial}.`,
        });

        expect(transport.llmProvidersCalled()).toContain('gemini-lite');
        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.reasonCode).toBe(ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
        expect(body(result)).not.toContain(EXPECTED.aiSuggestedProductMaterial);
        expect(body(result)).toMatch(/catalog|record|confirm|তথ্য|নিশ্চিত/i);
    });

    test('a price the catalog does not hold is replaced even for a verified product', async () => {
        const result = await harness.deliver({
            text: `What fabric is ${EXPECTED.knownProductName} made of?`,
            candidate: `${EXPECTED.knownProductName} — ৳999 only!`,
        });

        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.reasonCode).toBe(ReasonCode.UNSUPPORTED_PRICE_CLAIM);
        expect(result.decision.violations).toEqual(
            expect.arrayContaining([expect.stringContaining('unsupported_price:999')]),
        );
        expect(body(result)).not.toContain('999');
    });

    test('the production BullMQ worker reads a catalog update committed while the message waits in Redis', async () => {
        const worker = require('../../src/jobs/message-worker').startWorker();
        const eventId = 'm_e2e_catalog_changed_while_queued';
        const updatedPrice = 1975;

        try {
            await worker.pause();
            const payload = harness.messagePayload({
                pageId: IDS.pageA,
                psid: CUSTOMER_PSID,
                text: 'black panjabi picture den',
                mid: eventId,
            });
            const response = await harness.postWebhook(payload);
            expect(response.status).toBe(200);
            expect(await harness.waitForJobs(1)).toHaveLength(1);

            const [updatedRows] = await Product.update(
                { price: updatedPrice },
                { where: { id: IDS.knownProduct, shop_id: IDS.shopA } },
            );
            expect(updatedRows).toBe(1);

            await worker.resume();
            const deadline = Date.now() + 20_000;
            let receipt = null;
            do {
                receipt = await harness.receiptForEvent(eventId);
                if (receipt?.status === 'PROCESSED' || receipt?.status === 'DEAD_LETTERED') break;
                await new Promise(resolve => setTimeout(resolve, 50));
            } while (Date.now() < deadline);

            expect(receipt?.status).toBe('PROCESSED');
            expect(transport.capturedSends()).toHaveLength(2);
            expect(harness.sentBody(transport.capturedSends())).toContain('1,975');
            expect(harness.sentBody(transport.capturedSends())).not.toContain('1,847');
            expect(harness.sentAttachments(transport.capturedSends())).toEqual([
                expect.objectContaining({
                    type: 'image',
                    payload: expect.objectContaining({ url: EXPECTED.knownProductImage }),
                }),
            ]);
        } finally {
            await worker.close();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-004 — known product, unknown attribute
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-004 — an attribute the catalog does not record', () => {
    test('a fabric asserted for a product with material = NULL is withdrawn', async () => {
        const result = await harness.deliver({
            text: 'What is the fabric of the chiffon kurti?',
            candidate: `Ji, ${EXPECTED.unknownMaterialProductName} ache — `
                + `৳${EXPECTED.unknownMaterialProductPrice}. Eta pure chiffon fabric.`,
        });

        const decision = result.decision;
        expect(transport.llmProvidersCalled()).toContain('gemini-lite');
        expect(decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(decision.verifiedProductIds).toEqual([IDS.unknownMaterialProduct]);
        expect(decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(decision.reasonCode).toBe(ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
        expect(decision.violations).toEqual(
            expect.arrayContaining([expect.stringContaining('attribute_asserted_but_unknown:material')]),
        );

        const sent = body(result);
        // The product and its real price survive — a guardrail must not make the
        // assistant useless — but the fabric claim does not.
        expect(sent).toContain(String(EXPECTED.unknownMaterialProductPrice));
        expect(sent).not.toMatch(/pure chiffon fabric/i);
        expect(sent).toMatch(/don't have|do not have|nei|not (recorded|available)|নেই/i);
    });

    test('"eta chiffon?" with nothing grounded is answered by asking which product', async () => {
        // The documented follow-up path (AI_TRUST_BOUNDARY §4). Whatever the
        // conversation history says, the fabric is never invented.
        await harness.deliver({
            text: 'blue shirt ache?',
            candidate: `${EXPECTED.unknownAttributeProductName} — ৳${EXPECTED.unknownAttributeProductPrice}.`,
        });

        const result = await harness.deliver({
            text: 'eta chiffon?',
            candidate: 'Ji, eta chiffon.',
        });

        const sent = body(result);
        expect(sent).not.toMatch(/ji,? eta chiffon/i);
        expect(harness.sentAttachments(result.sends)).toEqual([]);
        expect(result.decision.verifiedProductIds).not.toContain(IDS.unknownAttributeProduct);
        // Observed behaviour: message-worker's history loader does not carry
        // source_references, so the contextual-attribute lookup finds nothing and
        // the honest "which product do you mean?" reply is sent. Recorded here so
        // a change in that behaviour is a deliberate decision, not a drift.
        expect(isWrittenReply(sent, grounding.whichProductReply)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-005 — known product without an image
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-005 — a verified product with no stored photo', () => {
    test('the reply says the photo is unavailable and attaches nothing', async () => {
        const result = await harness.deliver({
            text: 'green kurti picture den',
        });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(result.decision.verifiedProductIds).toEqual([IDS.noImageProduct]);
        expect(result.decision.mediaStatus).toBe(MediaStatus.UNAVAILABLE);
        expect(result.decision.mediaProductId).toBeNull();
        expect(harness.sentAttachments(result.sends)).toEqual([]);
        expect(body(result)).toContain('৳1,250');
        expect(transport.llmProvidersCalled()).toEqual([]);
    });

    test('the deterministic image-less path sends no substitute media', async () => {
        const result = await harness.deliver({
            text: 'green kurti picture den',
            candidate: `Chobi ei link e dekhun: ${EXPECTED.knownProductImage}`,
        });

        const sent = body(result);
        expect(result.decision.decision).toBe(GroundingDecision.SEND);
        expect(result.decision.reasonCode).toBe(ReasonCode.GROUNDED);
        expect(transport.llmProvidersCalled()).toEqual([]);
        expect(result.decision.provider).toBeNull();
        expect(transport.llmProvidersCalled()).toEqual([]);
        expect(sent).not.toContain(EXPECTED.knownProductImage);
        expect(sent).not.toContain('http');
        expect(harness.sentAttachments(result.sends)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-006 — cross-shop isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-006 — a Page that does not own the product', () => {
    test("Shop A's product is NOT_FOUND when asked through Shop B's Page", async () => {
        const result = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageB,
            candidate: `Ji, ${EXPECTED.knownProductName} ache — ৳${EXPECTED.knownProductPrice}.`,
        });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.NOT_FOUND);
        expect(result.decision.verifiedProductIds).toEqual([]);

        const sent = body(result);
        expect(sent).not.toContain(EXPECTED.knownProductName);
        expect(sent).not.toContain(String(EXPECTED.knownProductPrice));
        expect(sent).not.toContain(EXPECTED.knownProductImage);
        expect(harness.sentAttachments(result.sends)).toEqual([]);

        // The conversation, the customer and the reply all belong to Shop B.
        const conversationB = await harness.conversationFor(IDS.shopB);
        expect(conversationB).not.toBeNull();
        expect(await harness.conversationFor(IDS.shopA)).toBeNull();
    });

    test("Shop B still answers from its own catalog", async () => {
        const result = await harness.deliver({
            text: 'tote bag ache?',
            pageId: IDS.pageB,
            candidate: `${EXPECTED.shopBProductName} — ৳750.`,
        });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(result.decision.verifiedProductIds).toEqual([IDS.shopBProduct]);
        expect(body(result)).toContain(EXPECTED.shopBProductName);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-INBOUND-IDENTITY — pre-Page rows and Page isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-INBOUND-IDENTITY — legacy adoption without Page leakage', () => {
    test('adopts a legacy customer and conversation instead of opening a second thread', async () => {
        const legacyCustomer = await Customer.create({
            shop_id: IDS.shopA,
            name: 'Legacy Meta Customer',
            channel_type: 'messenger',
            channel_user_id: CUSTOMER_PSID,
            meta_channel_id: null,
            metadata: { source: 'pre_page_fixture' },
        });
        const legacyConversation = await Conversation.create({
            shop_id: IDS.shopA,
            customer_id: legacyCustomer.id,
            channel: 'messenger',
            meta_channel_id: null,
            role: 'user',
            message: 'legacy seed',
            metadata: {},
        });

        const result = await harness.deliver({
            text: 'legacy inbound message',
            mid: 'm_e2e_legacy_adoption_001',
            candidate: '',
        });

        expect(result.status).toBe(200);
        const customers = await Customer.findAll({
            where: {
                shop_id: IDS.shopA,
                channel_type: 'messenger',
                channel_user_id: CUSTOMER_PSID,
            },
        });
        const conversations = await Conversation.findAll({
            where: {
                shop_id: IDS.shopA,
                customer_id: legacyCustomer.id,
                channel: 'messenger',
            },
        });
        const inboundMessages = await Message.findAll({
            where: {
                conversation_id: legacyConversation.id,
                external_id: result.eventId,
                sender: 'customer',
            },
        });

        expect(customers).toHaveLength(1);
        expect(customers[0].id).toBe(legacyCustomer.id);
        expect(customers[0].meta_channel_id).toBe(IDS.channelA);
        expect(conversations).toHaveLength(1);
        expect(conversations[0].id).toBe(legacyConversation.id);
        expect(conversations[0].meta_channel_id).toBe(IDS.channelA);
        expect(inboundMessages).toHaveLength(1);
    });

    test('creates a separate customer and conversation when the existing row is pinned to another Page', async () => {
        const pageACustomer = await Customer.create({
            shop_id: IDS.shopA,
            name: 'Page A Customer',
            channel_type: 'messenger',
            channel_user_id: CUSTOMER_PSID,
            meta_channel_id: IDS.channelA,
            metadata: { source: 'page_a_fixture' },
        });
        await Conversation.create({
            shop_id: IDS.shopA,
            customer_id: pageACustomer.id,
            channel: 'messenger',
            meta_channel_id: IDS.channelA,
            role: 'user',
            message: 'page A seed',
            metadata: {},
        });

        const result = await harness.deliver({
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID,
            text: 'same PSID on Page A2',
            mid: 'm_e2e_page_isolation_001',
            candidate: '',
        });

        expect(result.status).toBe(200);
        const customers = await Customer.findAll({
            where: {
                shop_id: IDS.shopA,
                channel_type: 'messenger',
                channel_user_id: CUSTOMER_PSID,
            },
            order: [['created_at', 'ASC']],
        });
        const conversations = await Conversation.findAll({
            where: { shop_id: IDS.shopA, channel: 'messenger' },
            order: [['created_at', 'ASC']],
        });

        expect(customers).toHaveLength(2);
        expect(customers.map((row) => row.meta_channel_id)).toEqual(
            expect.arrayContaining([IDS.channelA, IDS.channelA2]),
        );
        expect(conversations).toHaveLength(2);
        expect(conversations.map((row) => row.meta_channel_id)).toEqual(
            expect.arrayContaining([IDS.channelA, IDS.channelA2]),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-REPLY-MODE — business-level send authority
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-REPLY-MODE — one business mode controls every automatic send', () => {
    test('MANUAL skips before the LLM and sends zero automatic messages', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');

        const result = await harness.deliver({
            text: 'black panjabi ache?',
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });

        expect(result.jobResults[0]).toEqual(expect.objectContaining({
            skipped: true,
            reason: 'manual_mode',
        }));
        expect(transport.llmProvidersCalled()).toEqual([]);
        expect(result.sends).toHaveLength(0);
    });

    test('DRAFT stores a suggestion without sending, then one explicit agent send succeeds', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'DRAFT');

        const draft = await harness.deliver({
            text: 'black panjabi ache?',
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });

        expect(draft.sends).toHaveLength(0);
        expect(draft.jobResults[0]).toEqual(expect.objectContaining({
            sent: false,
            reason: 'draft_mode',
        }));

        const manual = await harness.sendAgentReply({
            shopId: IDS.shopA,
            content: 'Yes, the black Panjabi is available.',
        });
        expect(manual.sends).toHaveLength(1);
        expect(harness.sentBody(manual.sends)).toContain('black Panjabi');
    });

    test('AUTO sends exactly one automatic reply', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');

        const result = await harness.deliver({
            text: 'black panjabi ache?',
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });

        expect(result.jobResults[0]).toEqual(expect.objectContaining({ sent: true }));
        expect(result.sends).toHaveLength(1);
    });

    test('mode changes are isolated by shop', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');
        await harness.setBusinessReplyMode(IDS.shopB, 'AUTO');

        const manualShop = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            candidate: 'Shop A must not send this.',
        });
        const automaticShop = await harness.deliver({
            text: 'tote bag ache?',
            pageId: IDS.pageB,
            candidate: `${EXPECTED.shopBProductName} — ৳750.`,
        });

        expect(manualShop.sends).toHaveLength(0);
        expect(manualShop.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));
        expect(automaticShop.sends).toHaveLength(1);
        expect(harness.sentBody(automaticShop.sends)).toContain(EXPECTED.shopBProductName);
    });

    test('one business mode converges across both connected Pages', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');
        const manualPage1 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: 'Manual Page 1 must not send this.',
        });
        const manualPage2 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: 'Manual Page 2 must not send this.',
        });
        expect(manualPage1.sends).toHaveLength(0);
        expect(manualPage2.sends).toHaveLength(0);
        expect(manualPage1.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));
        expect(manualPage2.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));

        await harness.setBusinessReplyMode(IDS.shopA, 'DRAFT');
        const draftPage1 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        const draftPage2 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        expect(draftPage1.sends).toHaveLength(0);
        expect(draftPage2.sends).toHaveLength(0);

        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        const autoPage1 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        const autoPage2 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        expect(autoPage1.sends).toHaveLength(1);
        expect(autoPage2.sends).toHaveLength(1);
        expect(autoPage1.jobResults[0]).toEqual(expect.objectContaining({ sent: true }));
        expect(autoPage2.jobResults[0]).toEqual(expect.objectContaining({ sent: true }));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-CHANNEL-OVERRIDE — narrow-only per-Page authority (ADR-0013 §3)
// ─────────────────────────────────────────────────────────────────────────────

/** Create/replace the channel override row for one E2E channel. */
const setChannelOverrides = async (channelId, overrides) => {
    const [row] = await MetaChannelSettings.findOrCreate({ where: { channel_id: channelId } });
    await row.update({ overrides });
    return row;
};

describe('META-E2E-CHANNEL-OVERRIDE — two Pages can diverge within the business ceiling', () => {
    test('Page 1 AUTO-override sends while Page 2 DRAFT-override holds under business AUTO', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        await setChannelOverrides(IDS.channelA, { automation_mode: 'AUTO' });
        await setChannelOverrides(IDS.channelA2, { automation_mode: 'DRAFT' });

        const page1 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        const page2 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });

        expect(page1.sends).toHaveLength(1);
        expect(page1.jobResults[0]).toEqual(expect.objectContaining({ sent: true }));
        expect(page2.sends).toHaveLength(0);
        expect(page2.jobResults[0]).toEqual(expect.objectContaining({
            sent: false,
            reason: 'draft_mode',
        }));

        // Changing Page 1's override never touched Page 2's stored row.
        const page2Row = await MetaChannelSettings.findByPk(IDS.channelA2);
        expect(page2Row.overrides).toEqual({ automation_mode: 'DRAFT' });
    });

    test('reverting the Page 2 override converges it back to the business default', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        await setChannelOverrides(IDS.channelA2, { automation_mode: 'DRAFT' });

        const held = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        expect(held.sends).toHaveLength(0);

        // Revert-to-inherit is a null override (the server deletes the key).
        await setChannelOverrides(IDS.channelA2, null);

        const converged = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        expect(converged.sends).toHaveLength(1);
        expect(converged.jobResults[0]).toEqual(expect.objectContaining({ sent: true }));
    });

    test('a business default change propagates only to inheriting Pages', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        await setChannelOverrides(IDS.channelA2, { automation_mode: 'DRAFT' });

        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');

        const page1 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: 'Manual Page 1 must not send this.',
        });
        const page2 = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA2,
            psid: CUSTOMER_PSID_PAGE_A2,
            candidate: 'Manual Page 2 must not send this.',
        });

        expect(page1.sends).toHaveLength(0);
        expect(page2.sends).toHaveLength(0);
        expect(page1.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));
        expect(page2.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));
    });

    test('a stored widening override is clamped at runtime, never honored', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');
        // Bypass the API deliberately: the runtime clamp must hold even for a
        // row written by an older release or a direct database edit.
        await setChannelOverrides(IDS.channelA, { automation_mode: 'AUTO' });

        const result = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: 'A clamped channel must never auto-send.',
        });

        expect(result.sends).toHaveLength(0);
        expect(result.jobResults[0]).toEqual(expect.objectContaining({
            skipped: true,
            reason: 'manual_mode',
        }));
    });

    test('the settings API rejects a widening PATCH with 400 INVALID_OVERRIDE_WIDENING', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'MANUAL');
        const metaChannelService = require('../../src/modules/channel-providers/meta-channel.service');

        // Service-level enforcement is the authority behind the HTTP controller
        // (the controller maps AppError status/code onto the response).
        await expect(
            metaChannelService.updateSettings(
                IDS.channelA,
                { overrides: { automation_mode: 'AUTO' } },
                { shopId: IDS.shopA, userId: null },
            ),
        ).rejects.toMatchObject({ status: 400, code: 'INVALID_OVERRIDE_WIDENING' });

        const row = await MetaChannelSettings.findByPk(IDS.channelA);
        expect(row?.overrides?.automation_mode).toBeUndefined();
    });

    test('a narrowing PATCH is accepted and stored canonically', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        const metaChannelService = require('../../src/modules/channel-providers/meta-channel.service');

        await metaChannelService.updateSettings(
            IDS.channelA,
            { overrides: { automation_mode: 'AI_SUGGEST_ONLY' } },
            { shopId: IDS.shopA, userId: null },
        );

        const row = await MetaChannelSettings.findByPk(IDS.channelA);
        expect(row.overrides).toEqual({ automation_mode: 'DRAFT' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-EMERGENCY-STOP — business-wide, bypass-proof (ADR-0013 §6)
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-EMERGENCY-STOP — no automatic delivery while stopped', () => {
    test('a stop engaged AFTER the job is queued holds it before the LLM', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        // A channel AUTO override must not bypass the business-wide stop.
        await setChannelOverrides(IDS.channelA, { automation_mode: 'AUTO' });
        transport.setCandidate(`${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`);

        const payload = harness.messagePayload({
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            text: 'black panjabi ache?',
        });
        const response = await harness.postWebhook(payload);
        expect(response.status).toBe(200);

        // The job is durably queued; now the merchant hits the stop.
        expect(await harness.waitForJobs(1)).toHaveLength(1);
        await shopService.engageAiEmergencyStop(IDS.shopA, null, { source: 'merchant' });

        const results = await harness.drainQueue();
        expect(results[0]).toEqual(expect.objectContaining({
            skipped: true,
            reason: 'emergency_stop',
        }));
        expect(transport.capturedSends()).toHaveLength(0);
        expect(transport.llmProvidersCalled()).toEqual([]);
    });

    test('agent sends still deliver under the stop (human agency preserved)', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
        });
        await shopService.engageAiEmergencyStop(IDS.shopA, null, { source: 'merchant' });

        const manual = await harness.sendAgentReply({
            shopId: IDS.shopA,
            content: 'We are still here — a human will help you.',
        });
        expect(manual.sends).toHaveLength(1);
    });

    test('resume keeps MANUAL and the next automatic turn is still skipped', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'AUTO');
        await shopService.engageAiEmergencyStop(IDS.shopA, null, { source: 'merchant' });
        const resumed = await shopService.resumeAiEmergencyStop(IDS.shopA, null, {
            source: 'merchant',
        });
        expect(resumed).toEqual(expect.objectContaining({
            active: false,
            automation_mode: 'MANUAL',
        }));

        const result = await harness.deliver({
            text: 'black panjabi ache?',
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            candidate: 'Resume must not re-enable AUTO.',
        });
        expect(result.sends).toHaveLength(0);
        expect(result.jobResults[0]).toEqual(expect.objectContaining({ reason: 'manual_mode' }));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-007 — conversation contamination
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-007 — an earlier ungrounded assistant turn', () => {
    test('authoritative retrieval overrides what the assistant said before', async () => {
        await harness.deliver({
            text: EXPECTED.nonexistentProductQuery,
            candidate: 'unused — this turn is answered deterministically',
        });

        const conversation = await harness.conversationFor(IDS.shopA);
        // Reproduce the historical defect: a prior assistant turn asserting a
        // product that does not exist, complete with an invented price.
        await harness.injectAssistantMessage(
            conversation.id,
            'Ji, amader chiffon saree ache — ৳2200, stock ache.',
        );

        const followUp = await harness.deliver({
            text: 'chiffon saree ta ache?',
            candidate: 'Ha, ager je chiffon saree ta bollam — ৳2200 e ache.',
        });

        expect(followUp.decision.productStatus).toBe(ProductEvidenceStatus.NOT_FOUND);
        expect(followUp.decision.verifiedProductIds).toEqual([]);
        expect(body(followUp)).not.toContain('2200');
    });

    test('the model leaning on its own earlier claim is stopped at the gate', async () => {
        const conversation = await harness.deliver({
            text: EXPECTED.nonexistentProductQuery, candidate: 'x',
        }).then(() => harness.conversationFor(IDS.shopA));

        await harness.injectAssistantMessage(
            conversation.id,
            'Ji, amader chiffon saree ache — ৳2200.',
        );

        const result = await harness.deliver({
            text: 'are you sure?',
            candidate: 'Ji sure, ager bola moto ৳2200.',
        });

        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.violations).toEqual(
            expect.arrayContaining([expect.stringContaining('unsupported_price:2200')]),
        );
        expect(body(result)).not.toContain('2200');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-008 — merchant knowledge
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-008 — merchant policy the shop never supplied', () => {
    test('an invented return fee never reaches Meta', async () => {
        const result = await harness.deliver({
            text: EXPECTED.unknownPolicyQuery,
            candidate: 'Amader return policy 7 din. Return fee ৳4499 lage.',
        });

        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.violations).toEqual(
            expect.arrayContaining([expect.stringContaining('unsupported_price:4499')]),
        );
        expect(body(result)).not.toContain('4499');
    });

    test('a figure the merchant DID supply is quotable, and is attributed', async () => {
        const result = await harness.deliver({
            text: EXPECTED.faqQuery,
            candidate: `Inside Dhaka delivery charge ${EXPECTED.faqDeliveryInsideDhaka} taka; `
                + `outside Dhaka delivery charge ${EXPECTED.faqDeliveryOutsideDhaka} taka.`,
        });

        expect(result.decision.decision).toBe(GroundingDecision.SEND);
        expect(result.decision.knowledgeIds).toContain(RUNTIME.faqDeliveryId);
        expect(body(result)).toContain(String(EXPECTED.faqDeliveryInsideDhaka));
    });

    test('a figure the merchant did NOT supply is rejected on the same knowledge path', async () => {
        const result = await harness.deliver({
            text: EXPECTED.faqQuery,
            candidate: 'Delivery charge 777 taka.',
        });

        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(body(result)).not.toContain('777');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-009 — attachment and URL provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-009 — media provenance', () => {
    test.each([
        ['another product of this shop', () => EXPECTED.relatedProductImage],
        ['a product of another shop', () => EXPECTED.shopBProductImage],
        ['a generic URL', () => 'https://example.com/some-saree.jpg'],
        ['the shop Facebook Page', () => 'https://facebook.com/EasyModeratorE2E'],
    ])('the deterministic product photo path uses only the verified image, even with %s scripted as output', async (_label, url) => {
        const result = await harness.deliver({
            text: 'black panjabi picture den',
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}. Chobi: ${url()}`,
        });

        const sent = body(result);
        expect(result.decision.decision).toBe(GroundingDecision.SEND);
        expect(result.decision.reasonCode).toBe(ReasonCode.GROUNDED);
        expect(result.decision.provider).toBeNull();
        expect(transport.llmProvidersCalled()).toEqual([]);
        expect(sent).not.toContain(url());
        // The direct route emits only the verified catalog attachment.
        expect(harness.sentAttachmentUrls(result.sends)).toEqual([EXPECTED.knownProductImage]);
    });

    test('only the verified product URL survives attachment provenance', async () => {
        // The proposed-attachment vector, evaluated by the real gate against
        // evidence built by the real service from the real Shop A catalog rows.
        const rows = await productSearch.getProductsByIds([IDS.knownProduct], IDS.shopA);
        const evidence = grounding.resolveProductEvidence({
            shopId: IDS.shopA,
            message: 'black panjabi picture den',
            candidates: rows,
        });
        expect(evidence.mediaStatus).toBe(MediaStatus.AVAILABLE);

        const verdict = grounding.evaluateCandidate({
            candidate: `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`,
            evidence,
            attachments: [
                { type: 'image', url: EXPECTED.knownProductImage, productId: IDS.knownProduct },
                { type: 'image', url: EXPECTED.knownProductImage, productId: IDS.relatedProduct },
                { type: 'image', url: EXPECTED.relatedProductImage, productId: IDS.relatedProduct },
                { type: 'image', url: EXPECTED.shopBProductImage, productId: IDS.shopBProduct },
                { type: 'image', url: 'https://example.com/anything.jpg' },
            ],
        });

        expect(verdict.attachments).toEqual([
            { type: 'image', url: EXPECTED.knownProductImage, productId: IDS.knownProduct },
        ]);
        expect(verdict.violations).toContain('attachment_provenance_rejected');
    });
});

describe('META-E2E-009B — model URL rejection', () => {
    test('an unauthorized model URL is rejected before send and persisted as a grounding violation', async () => {
        const unauthorizedUrl = 'https://example.com/unauthorized-product-photo.jpg';
        const result = await harness.deliver({
            text: 'chiffon kurti material?',
            candidate: `The fabric is not recorded for this item. Details: ${unauthorizedUrl}`,
        });

        expect(transport.llmProvidersCalled()).toContain('gemini-lite');
        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.VERIFIED);
        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.reasonCode).toBe(ReasonCode.UNSUPPORTED_URL_CLAIM);
        expect(result.decision.violations).toContain('unsupported_url:1');
        expect(body(result)).not.toContain(unauthorizedUrl);
        expect(harness.sentAttachments(result.sends)).toEqual([]);

        const stored = await harness.lastStoredAiMessage(IDS.shopA);
        expect(stored.content).not.toContain(unauthorizedUrl);
        expect(stored.metadata.grounding_decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(stored.metadata.grounding_reason).toBe(ReasonCode.UNSUPPORTED_URL_CLAIM);
        expect(stored.metadata.grounding_violations).toContain('unsupported_url:1');
        expect(stored.metadata.grounding_attachment_urls).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-010 — provider fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-010 — the fallback provider', () => {
    test('a primary-provider outage fails over, while the gate holds an unverified material claim', async () => {
        const result = await harness.deliver({
            // Keep this long question out of the sentiment LLM path so the
            // provider-call assertion below measures this reply's failover
            // chain alone. `thanks` is a strong keyword-positive signal.
            text: `Thanks — what fabric is ${EXPECTED.knownProductName} made of?`,
            candidate: {
                'gemini-lite': new Error('503 Service Unavailable'),
                openai: `${EXPECTED.knownProductName} is ${EXPECTED.aiSuggestedProductMaterial}, ৳${EXPECTED.knownProductPrice}.`,
            },
        });

        expect(transport.llmProvidersCalled()).toEqual(['gemini-lite', 'openai']);
        expect(result.decision.provider).toBe('openai');
        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(result.decision.reasonCode).toBe(ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
        expect(body(result)).not.toMatch(/\b(?:cotton|silk|linen)\b/i);
    });

    test('the fallback provider is held to exactly the same boundary', async () => {
        const result = await harness.deliver({
            text: `What fabric is ${EXPECTED.knownProductName} made of?`,
            candidate: {
                'gemini-lite': new Error('503 Service Unavailable'),
                openai: `${EXPECTED.knownProductName} — ৳3333, silk.`,
            },
        });

        expect(result.decision.provider).toBe('openai');
        expect(result.decision.decision).toBe(GroundingDecision.SAFE_FALLBACK);
        expect(body(result)).not.toContain('3333');
    });

    test('every provider failing sends the generic fallback and holds for a human', async () => {
        const result = await harness.deliver({
            text: `What fabric is ${EXPECTED.knownProductName} made of?`,
            candidate: new Error('503 Service Unavailable'),
        });

        expect(result.jobResults[0].sent).toBe(false);
        expect(result.jobResults[0].reason).toBe('low_confidence_handoff');
        expect(body(result)).not.toContain(String(EXPECTED.knownProductPrice));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-011 — retrieval failure
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-011 — the catalog cannot be read', () => {
    afterEach(() => jest.restoreAllMocks());

    test('an outage becomes RETRIEVAL_FAILED, a human handoff and no answer', async () => {
        jest.spyOn(productSearch, 'searchByAttributes')
            .mockRejectedValue(new Error('E2E: simulated Postgres outage'));

        const result = await harness.deliver({
            text: 'black panjabi ache?',
            candidate: 'Ji ache, ৳1847.',
        });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.RETRIEVAL_FAILED);
        expect(result.decision.verifiedProductIds).toEqual([]);
        expect(result.jobResults[0].sent).toBe(false);
        expect(result.jobResults[0].reason).toBe('low_confidence_handoff');
        expect(result.jobResults[0].handoff).toBe(true);

        // The only thing that may go out is EasyModerator's own holding message —
        // never a claim about the product.
        const sent = body(result);
        expect(sent).not.toContain('1847');
        expect(sent).not.toContain(EXPECTED.knownProductName);

        const stored = await harness.lastStoredAiMessage(IDS.shopA);
        expect(stored.metadata.grounding_product_status)
            .toBe(ProductEvidenceStatus.RETRIEVAL_FAILED);
        expect(stored.metadata.delivered).toBe(false);
        expect(stored.metadata.held_reason).toBe('low_confidence');
    });

    test('an outage is never downgraded to "we do not sell that"', async () => {
        jest.spyOn(productSearch, 'searchByAttributes')
            .mockRejectedValue(new Error('E2E: simulated Postgres outage'));

        const result = await harness.deliver({
            text: EXPECTED.nonexistentProductQuery,
            candidate: 'unused',
        });

        expect(result.decision.productStatus).not.toBe(ProductEvidenceStatus.NOT_FOUND);
        expect(body(result)).not.toMatch(/couldn't find|pacchi na|পাচ্ছি না/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-012 — malformed model output
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-012 — unusable model output', () => {
    test('an empty provider completion cannot create a product claim and reaches the human-safe hold path', async () => {
        const result = await harness.deliver({
            text: `What fabric is ${EXPECTED.knownProductName} made of?`,
            candidate: '   ',
        });

        // llm.service rejects blank provider completions before the router can
        // return its product evidence. The controller falls back to generic
        // copy with empty evidence, which is low confidence and held for an
        // agent; the failure path must not retain or invent a product claim.
        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.NONE);
        expect(result.jobResults[0]).toMatchObject({ sent: false, reason: 'low_confidence_handoff', handoff: true });
        expect(body(result).trim().length).toBeGreaterThan(0); // one generic holding message only
        expect(body(result)).not.toMatch(/৳|\b\d{3,}\b/i);
        expect(harness.sentAttachments(result.sends)).toEqual([]);
    });

    test('an empty completion with nothing to answer sends only a generic holding message and hands off', async () => {
        // "ok" carries no product-identifying term at all. Provider failure
        // produces a low-confidence generic response that is held for an agent.
        const result = await harness.deliver({ text: 'ok', candidate: '' });

        expect(result.decision.productStatus).toBe(ProductEvidenceStatus.NONE);
        expect(result.jobResults[0]).toMatchObject({ sent: false, reason: 'low_confidence_handoff', handoff: true });
        expect(result.sends).toHaveLength(1);
        expect(harness.sentTexts(result.sends).join('\n')).not.toMatch(/undefined|৳|\b\d{3,}\b/i);
        expect(harness.sentAttachments(result.sends)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-013 — metering.
//
// Conversation usage is the ONLY usage signal billing reads, and the handler
// that emits it swallows its own failures so ingestion can never be blocked
// (meta-webhook-events.handler.js). That catch means a broken meter is
// invisible in the logs of a working pipeline — every reply still sends, and
// the counter silently stays at zero. Only a real row read back out of
// Postgres proves the meter ran.
//
// usage-tracking.test.js passes a uuidv4() of its own making, so it proves
// trackUsage works on a well-formed key and cannot see what the webhook path
// actually passes. This asserts the production caller.
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-013 — the first message on a conversation is metered', () => {
    const conversationEvents = () => UsageEvent.findAll({
        where: { shop_id: IDS.shopA, resource_type: 'conversations' },
    });

    test('a new conversation records exactly one committed usage event', async () => {
        expect(await conversationEvents()).toHaveLength(0);

        await harness.deliver({ text: 'black panjabi ache?' });

        const events = await conversationEvents();
        expect(events).toHaveLength(1);
        expect(events[0].status).toBe('committed');
        expect(events[0].delta).toBe(1);
    });

    test("the shop's counted usage moves with it", async () => {
        await harness.deliver({ text: 'black panjabi ache?' });

        const subscription = await Subscription.findOne({ where: { shop_id: IDS.shopA } });
        expect(subscription.conversations_used).toBe(1);
    });

    test('later messages in the same conversation are not re-metered', async () => {
        await harness.deliver({ text: 'black panjabi ache?' });
        await harness.deliver({ text: 'dam koto?' });
        await harness.deliver({ text: 'ache?' });

        expect(await conversationEvents()).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// META-E2E-014 — resolve and inbound ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('META-E2E-014 — resolve cannot strand a newer inbound turn', () => {
    test('an inbound committed before Resolve keeps the conversation open', async () => {
        await harness.deliver({
            text: 'black panjabi ache?',
            candidate: 'EM E2E Black Panjabi — ৳1847.',
        });
        const conversation = await harness.conversationFor(IDS.shopA);
        const baselineCustomer = (await harness.messagesFor(conversation.id))
            .filter((message) => message.sender === 'customer')
            .at(-1);
        expect(baselineCustomer).toBeDefined();

        transport.setCandidate('EM E2E Blue Shirt — ৳990.');
        const inbound = harness.messagePayload({
            pageId: IDS.pageA,
            psid: CUSTOMER_PSID,
            text: 'blue shirt ache?',
            mid: 'm_e2e_inbound_before_resolve',
        });
        expect((await harness.postWebhook(inbound)).status).toBe(200);

        const outcome = await harness.resolveConversation({
            shopId: IDS.shopA,
            lastSeenMessageId: baselineCustomer.id,
        });
        expect(outcome.status).toBe('active');
        expect(outcome.resolution_outcome).toBe('kept_open_newer_customer_message');

        const [jobResult] = await harness.drainQueue();
        expect(jobResult.sent).toBe(true);
        expect((await harness.conversationFor(IDS.shopA)).status).toBe('active');
    });

    test('Resolve before a later inbound closes first, then the inbound reopens it', async () => {
        await harness.deliver({
            text: 'black panjabi ache?',
            candidate: 'EM E2E Black Panjabi — ৳1847.',
        });
        const conversation = await harness.conversationFor(IDS.shopA);
        const baselineCustomer = (await harness.messagesFor(conversation.id))
            .filter((message) => message.sender === 'customer')
            .at(-1);
        const resolved = await harness.resolveConversation({
            shopId: IDS.shopA,
            lastSeenMessageId: baselineCustomer.id,
        });
        expect(resolved.status).toBe('closed');

        const result = await harness.deliver({
            text: 'blue shirt ache?',
            candidate: 'EM E2E Blue Shirt — ৳990.',
            mid: 'm_e2e_inbound_after_resolve',
        });
        expect(result.sends.length).toBeGreaterThan(0);
        expect((await harness.conversationFor(IDS.shopA)).status).toBe('active');
    });
});
