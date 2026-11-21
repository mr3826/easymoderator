'use strict';

/**
 * META-E2E P0-01 / P0-02 / P0-03 — postback, referral and redelivery intake.
 *
 * These scenarios enter through the real signed webhook route (HMAC, durable
 * receipt, dedupe), traverse the REAL Redis/BullMQ queue handoff, and run the
 * real worker guard chain — exactly like meta-e2e.test.js. The Graph transport
 * stays captured by tests/meta-e2e/transport.js: a green suite here proves the
 * contract EasyModerator implements, NOT that Meta acknowledged a delivery
 * (that boundary is recorded in the P0 acceptance matrix).
 *
 * P0-01 quick-reply button tap → receipt QUEUED → real drain → worker settles
 *       it QUEUED → PROCESSED (the same settleInboundReceipts the production
 *       worker's `completed` listener runs) → interaction CONSUMED.
 * P0-02 m.me referral intake: pure referral, referral riding a message, and
 *       referral on a postback — with the sanitizer refusing @/http/://phone
 *       and >64-char refs.
 * P0-03 redelivery dedupe: the page-scoped payload-hash identity means one tap
 *       answered once, while two different taps that share a postback.mid
 *       (Meta semantics: mid names the OUTBOUND button message) are NOT
 *       conflated.
 */

const crypto = require('crypto');

const harness = require('./harness');
const transport = require('./transport');
const fixtures = require('./fixtures');
const interactions = require('../../src/modules/interactions/interactions.service');
const CustomerInteraction = require('../../src/modules/interactions/interaction.entity');
const { ShopPilotFeatures, Message } = require('../../src/modules/entities');
const { Conversation } = require('../../src/modules/conversation/conversation.entity');

const { IDS, EXPECTED, CUSTOMER_PSID } = fixtures;

let psidSeq = 0;
const freshPsid = () => String(7200000000000000 + (psidSeq += 1));

jest.setTimeout(120000);

beforeAll(async () => {
    await harness.setupSuite();
});

beforeEach(async () => {
    await harness.resetRun();
    // The interaction intake (postback allowlist, referral merge) is gated on
    // the platform pilot flag; these scenarios pin the flag-ON path plus one
    // explicit flag-OFF kill-switch case.
    await ShopPilotFeatures.create({
        shop_id: IDS.shopA,
        interaction_choices: true,
    });
});

afterAll(async () => {
    await harness.teardownSuite();
});

/** Open a thread with a real, grounded FAQ turn so the conversation/customer rows exist. */
const openThread = async () => {
    await harness.deliver({
        text: EXPECTED.faqQuery,
        candidate: `Inside Dhaka delivery charge ${EXPECTED.faqDeliveryInsideDhaka} taka; `
            + `outside Dhaka delivery charge ${EXPECTED.faqDeliveryOutsideDhaka} taka.`,
    });
    const conversation = await harness.conversationFor(IDS.shopA);
    if (!conversation) throw new Error('postback-referral: FAQ turn created no conversation');
    return conversation;
};

/**
 * Create + deliver a CLARIFY_NEEDS proposal against a live conversation and
 * return the exact opaque payload a customer's finger would produce.
 */
const seedDeliveredProposal = async (conversation, { language = 'en' } = {}) => {
    const proposal = await interactions.createProposal({
        shopId: IDS.shopA,
        customerId: conversation.customer_id,
        customerChannelId: CUSTOMER_PSID,
        metaChannelId: IDS.channelA,
        conversationId: conversation.id,
        kind: 'CLARIFY_NEEDS',
        language,
    });
    await interactions.markSent(proposal.interactionId);
    const row = await CustomerInteraction.findByPk(proposal.interactionId);
    if (row.status !== 'SENT') throw new Error(`postback-referral: expected SENT, got ${row.status}`);
    return proposal;
};

const tapPayloadFor = (proposal, optionId) => {
    const option = proposal.options.find((o) => o.option_id === optionId);
    if (!option) throw new Error(`postback-referral: option ${optionId} not offered`);
    return option.payload;
};

// ─────────────────────────────────────────────────────────────────────────────
// P0-01 — postback intake: webhook → queue → worker → settled receipt → CONSUMED
// ─────────────────────────────────────────────────────────────────────────────

describe('P0-01 — quick-reply postback through the real intake pipeline', () => {
    test('a signed p1: tap is acknowledged QUEUED, answered from the durable body, and settled PROCESSED', async () => {
        const conversation = await openThread();
        const proposal = await seedDeliveredProposal(conversation);
        const payload = tapPayloadFor(proposal, 'delivery.info');

        const envelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID, payload, title: 'Delivery info',
        });
        const messaging = envelope.entry[0].messaging[0];

        const response = await harness.postWebhook(envelope);
        expect(response.status).toBe(200);

        // Durable acceptance BEFORE acknowledgement: a postback is replayable,
        // so its encrypted body must survive alongside the queue handoff.
        const receipt = await harness.receiptForPayload(IDS.pageA, messaging);
        expect(receipt).not.toBeNull();
        expect(receipt.event_type).toBe('postback');
        expect(receipt.status).toBe('QUEUED');
        expect(receipt.queue_job_id).toBeTruthy();
        expect(receipt.shop_id).toBe(IDS.shopA);
        expect(receipt.meta_channel_id).toBe(IDS.channelA);
        expect(receipt.payload_encrypted).toMatch(/^v1:/);

        const sendsBefore = transport.capturedSends().length;
        const providersBefore = transport.llmProvidersCalled().length;
        const results = await harness.drainAndSettle();
        expect(results).toHaveLength(1);

        // The production settlement step the worker's completed-listener runs.
        await receipt.reload();
        expect(receipt.status).toBe('PROCESSED');
        expect(receipt.payload_encrypted).toBeNull();

        // The kernel consumed the choice exactly once, server-side.
        const row = await CustomerInteraction.findByPk(proposal.interactionId);
        expect(row.status).toBe('CONSUMED');
        expect(row.resolution.option_id).toBe('delivery.info');
        expect(row.resolution.resolved_at).toBeTruthy();

        // The customer would have received the authoritative zone answer — and
        // NO model was consulted for a structured tap.
        const sends = transport.capturedSends().slice(sendsBefore);
        expect(sends.length).toBeGreaterThan(0);
        const sent = harness.sentBody(sends);
        expect(sent).toMatch(/Select your delivery area|ডেলিভারি এলাকা/);
        expect(sent).toMatch(/৳\d+/);
        expect(transport.llmProvidersCalled()).toHaveLength(providersBefore);

        // The tap is stored once as a customer message carrying the opaque
        // reference — the durable event identity is the postback RECEIPT, not
        // Meta's shared outbound mid.
        const tapMessages = await Message.findAll({
            where: { conversation_id: conversation.id, sender: 'customer' },
        });
        expect(tapMessages).toHaveLength(2); // FAQ turn + the tap itself
        const tapMessage = tapMessages.find((m) => m.metadata?.quick_reply?.payload === payload);
        expect(tapMessage).toBeTruthy();
        expect(tapMessage.external_id).toBe(`postback:${receipt.id}`);
        expect(tapMessage.content).toBe('Delivery info');
    });

    test('the kill switch OFF skips the tap at ingress with zero pipeline work', async () => {
        const conversation = await openThread();
        const proposal = await seedDeliveredProposal(conversation);
        await ShopPilotFeatures.update({ interaction_choices: false }, { where: { shop_id: IDS.shopA } });

        const envelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: tapPayloadFor(proposal, 'delivery.info'), title: 'Delivery info',
        });

        const sendsBefore = transport.capturedSends().length;
        const response = await harness.postWebhook(envelope);
        expect(response.status).toBe(200);

        const receipt = await harness.receiptForPayload(IDS.pageA, envelope.entry[0].messaging[0]);
        expect(receipt.status).toBe('SKIPPED');
        expect(receipt.last_error_code).toBe('INTERACTION_CHOICES_DISABLED');
        expect(await harness.waitForJobs(1, { timeoutMs: 1000 })).toHaveLength(0);
        expect(transport.capturedSends()).toHaveLength(sendsBefore);
        const row = await CustomerInteraction.findByPk(proposal.interactionId);
        expect(row.status).toBe('SENT'); // untouched, not consumed
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-03 — redelivery dedupe on the page-scoped payload-hash identity
// ─────────────────────────────────────────────────────────────────────────────

describe('P0-03 — redelivered postbacks answer once', () => {
    test('the same signed tap twice yields one message, one CONSUMED, and no second job', async () => {
        const conversation = await openThread();
        const proposal = await seedDeliveredProposal(conversation);
        const envelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: tapPayloadFor(proposal, 'delivery.info'), title: 'Delivery info',
            mid: 'm_e2e_shared_outbound',
        });
        const messaging = envelope.entry[0].messaging[0];

        expect((await harness.postWebhook(envelope)).status).toBe(200);
        const receipt = await harness.receiptForPayload(IDS.pageA, messaging);
        await harness.drainAndSettle();
        await receipt.reload();
        expect(receipt.status).toBe('PROCESSED');
        const sendsAfterFirst = transport.capturedSends().length;
        const firstResolution = (await CustomerInteraction.findByPk(proposal.interactionId)).resolution;

        // Meta redelivers the identical body (retry after a lost ACK).
        const second = await harness.postWebhook(envelope);
        expect(second.status).toBe(200);

        const same = await harness.receiptForPayload(IDS.pageA, messaging);
        expect(same.id).toBe(receipt.id); // one durable row, flagged by identity

        // A terminal duplicate must not re-run intake: no queued job, no second
        // tap message, no second provider send, and the CONSUMED resolution is
        // byte-identical (single execution, same as the kernel CAS guarantees).
        expect(await harness.waitForJobs(1, { timeoutMs: 1000 })).toHaveLength(0);
        expect(transport.capturedSends()).toHaveLength(sendsAfterFirst);
        const tapMessages = await Message.findAll({ where: { conversation_id: conversation.id, sender: 'customer' } });
        expect(tapMessages.filter((m) => m.metadata?.quick_reply?.payload)).toHaveLength(1);
        const row = await CustomerInteraction.findByPk(proposal.interactionId);
        expect(row.status).toBe('CONSUMED');
        expect(row.resolution).toEqual(firstResolution);
    });

    test('two different taps sharing one postback.mid stay distinct events (mid is not the identity)', async () => {
        const conversation = await openThread();
        const proposal = await seedDeliveredProposal(conversation);
        const sharedMid = 'm_e2e_button_message_shared';

        const tapA = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: tapPayloadFor(proposal, 'delivery.info'), title: 'Delivery info', mid: sharedMid,
        });

        expect((await harness.postWebhook(tapA)).status).toBe(200);
        const receiptA = await harness.receiptForPayload(IDS.pageA, tapA.entry[0].messaging[0]);
        await harness.drainAndSettle();
        const sendsAfterA = transport.capturedSends().length;

        // Built AFTER the first tap's reply exists: the durable turn reader
        // orders by created_at, and the inbound envelope's Meta timestamp is
        // its created_at — an early-built envelope would sort behind the reply.
        const tapB = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: tapPayloadFor(proposal, 'support.human'), title: 'Talk to a person', mid: sharedMid,
        });

        expect((await harness.postWebhook(tapB)).status).toBe(200);
        const receiptB = await harness.receiptForPayload(IDS.pageA, tapB.entry[0].messaging[0]);
        expect(receiptB.id).not.toBe(receiptA.id); // deduped by content, not mid
        const resultsB = await harness.drainAndSettle();

        // The second option hits the already-CONSUMED row → replay no-op: the
        // worker skips with interaction_replay, sends nothing, and escalates to
        // a human NOT (support.human never dispatched).
        expect(resultsB).toHaveLength(1);
        expect(resultsB[0].skipped).toBe(true);
        expect(resultsB[0].reason).toBe('interaction_replay');
        expect(transport.capturedSends()).toHaveLength(sendsAfterA);
        await receiptB.reload();
        expect(receiptB.status).toBe('PROCESSED');

        const row = await CustomerInteraction.findByPk(proposal.interactionId);
        expect(row.status).toBe('CONSUMED');
        expect(row.resolution.option_id).toBe('delivery.info');
        const reloadedConversation = await Conversation.findByPk(conversation.id);
        expect(reloadedConversation.hitl).toBe(false);

        // Both events are durably stored as their own messages.
        const tapMessages = await Message.findAll({ where: { conversation_id: conversation.id, sender: 'customer' } });
        expect(tapMessages.filter((m) => m.metadata?.quick_reply?.payload)).toHaveLength(2);
    });

    test('a forged (non-allowlisted) postback payload is skipped without any mutation', async () => {
        const conversation = await openThread();
        const envelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: 'forged:confirm:order-99', title: 'Confirm',
        });

        const sendsBefore = transport.capturedSends().length;
        expect((await harness.postWebhook(envelope)).status).toBe(200);
        const receipt = await harness.receiptForPayload(IDS.pageA, envelope.entry[0].messaging[0]);
        expect(receipt.status).toBe('SKIPPED');
        expect(receipt.last_error_code).toBe('POSTBACK_NOT_ALLOWLISTED');
        expect(await harness.waitForJobs(1, { timeoutMs: 1000 })).toHaveLength(0);
        expect(transport.capturedSends()).toHaveLength(sendsBefore);
        // A card quick-reply (product:<id>:q:<idx>) is deliberately NOT p1: — same terminal skip.
        const cardEnvelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: `product:${crypto.randomUUID()}:q:0`, title: 'Order now',
        });
        expect((await harness.postWebhook(cardEnvelope)).status).toBe(200);
        const cardReceipt = await harness.receiptForPayload(IDS.pageA, cardEnvelope.entry[0].messaging[0]);
        expect(cardReceipt.status).toBe('SKIPPED');
        expect(cardReceipt.last_error_code).toBe('POSTBACK_NOT_ALLOWLISTED');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-02 — referral intake + sanitizer
// ─────────────────────────────────────────────────────────────────────────────

describe('P0-02 — m.me referral capture and sanitization', () => {
    test('a valid pure referral open creates a conversation stamped with the ref, no queue job', async () => {
        const psid = freshPsid();
        const result = await harness.deliver({
            psid, referral: { ref: 'eid_campaign-2026.a', source: 'AD', type: 'OPEN_THREAD' },
            drain: false,
        });

        expect(result.status).toBe(200);
        expect(result.receipt).toMatchObject({
            event_type: 'referral',
            status: 'PROCESSED',
        });
        expect(result.receipt.queue_job_id).toBeNull();
        expect(await harness.waitForJobs(1, { timeoutMs: 1000 })).toHaveLength(0);

        const conversation = await Conversation.findOne({
            where: { shop_id: IDS.shopA }, order: [['created_at', 'DESC']],
        });
        expect(conversation).not.toBeNull();
        expect(String(conversation.meta_channel_id)).toBe(IDS.channelA);
        // Pin the demonstrated defect fix: first-touch pure-referral create must
        // set the NOT NULL customer role exactly as message ingress does.
        expect(conversation.role).toBe('user');
        expect(conversation.metadata).toMatchObject({
            referral_source: 'eid_campaign-2026.a',
            referral_source_type: 'm_me',
        });
        expect(Number.isNaN(Date.parse(conversation.metadata.referral_captured_at))).toBe(false);
        // Attribution only — a referral open invents no message content.
        expect(await Message.count({ where: { conversation_id: conversation.id } })).toBe(0);
    });

    test.each([
        ['email-like', 'user@test.com'],
        ['bare phone', '01712345678'],
        ['international phone', '+8801712345678'],
        ['url', 'https://evil.com/phish'],
        ['oversized ref', 'a'.repeat(65)],
    ])('a %s referral is refused (REFERRAL_REF_INVALID) and never reaches the conversation', async (_label, ref) => {
        const psid = freshPsid();
        const result = await harness.deliver({ psid, referral: { ref }, drain: false });

        expect(result.status).toBe(200);
        expect(result.receipt).toMatchObject({
            event_type: 'referral',
            status: 'SKIPPED',
            last_error_code: 'REFERRAL_REF_INVALID',
        });
        expect(await Conversation.count({ where: { shop_id: IDS.shopA } })).toBe(0);
    });

    test('a referral riding on a real message merges onto the conversation metadata', async () => {
        const conversation = await openThread();
        expect(conversation.metadata?.referral_source).toBeUndefined();

        await harness.deliver({
            text: 'delivery charge ache?',
            referral: { ref: 'eid_newsletter_nov', source: 'AD' },
        });

        const reloaded = await Conversation.findByPk(conversation.id);
        expect(reloaded.metadata).toMatchObject({
            referral_source: 'eid_newsletter_nov',
            referral_source_type: 'm_me',
        });
    });

    test('a postback carrying referral.ref stamps the conversation and still consumes the tap', async () => {
        const conversation = await openThread();
        const proposal = await seedDeliveredProposal(conversation);
        const envelope = harness.postbackPayload({
            pageId: IDS.pageA, psid: CUSTOMER_PSID,
            payload: tapPayloadFor(proposal, 'delivery.info'), title: 'Delivery info',
            referral: { ref: 'eid_button_link.2', source: 'OPEN_THREAD' },
        });

        expect((await harness.postWebhook(envelope)).status).toBe(200);
        await harness.drainAndSettle();

        const reloaded = await Conversation.findByPk(conversation.id);
        expect(reloaded.metadata).toMatchObject({
            referral_source: 'eid_button_link.2',
            referral_source_type: 'm_me',
        });
        const row = await CustomerInteraction.findByPk(proposal.interactionId);
        expect(row.status).toBe('CONSUMED');
    });
});
