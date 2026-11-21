'use strict';

/**
 * P05 PIPELINE — draft → merchant approval → provider send → evidence.
 *
 * meta-e2e.test.js proves the worker's automatic-send boundary. This file
 * proves the other half of the lifecycle: a DRAFT_READY suggestion stored by
 * a DRAFT-mode turn can only reach the customer through the REAL merchant
 * approval contract —
 *
 *   POST /api/conversation/:conversationId/messages/:messageId/approve
 *
 * behind a real authenticated owner session, exercising
 * conversation.service.approveAiDraft (SELECT ... FOR UPDATE CAS + the
 * InboxDeliveryOutbox insert), the controller's provider delivery, the
 * settleInboxDeliveryOutbox step, and every failure state the merchant UI
 * and the reconciler depend on. Before this file the suite had no route-
 * backed approval path: `harness.sendAgentReply` created a fresh business
 * message and called the delivery helper directly, so a regression anywhere
 * in approve → outbox → deliver → settle was invisible.
 *
 * Business mode stays DRAFT everywhere here — nothing in this file enables
 * AUTO or any customer-facing automatic send.
 */

const harness = require('./harness');
const transport = require('./transport');
const fixtures = require('./fixtures');
const { IDS, EXPECTED } = fixtures;
const { Message } = require('../../src/modules/conversation/conversation.entity');
const InboxDeliveryOutbox = require('../../src/modules/conversation/inbox-delivery-outbox.entity');
const Customer = require('../../src/modules/customer/customer.entity');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    normalizeDeliveryState,
    isReviewableSuggestion,
} = require('../../src/modules/conversation/message-lifecycle');

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

const CANDIDATE = `${EXPECTED.knownProductName} — ৳${EXPECTED.knownProductPrice}.`;

/** One DRAFT-mode customer turn, held for the merchant. Returns the stored draft. */
const storeDraft = async () => {
    await harness.setBusinessReplyMode(IDS.shopA, 'DRAFT');
    const result = await harness.deliver({
        text: 'black panjabi ache?',
        candidate: CANDIDATE,
    });
    // The worker held it — no automatic send happened.
    expect(result.jobResults[0]).toEqual(expect.objectContaining({
        sent: false,
        reason: 'draft_mode',
    }));
    expect(result.sends).toHaveLength(0);

    const draft = await harness.draftMessageFor(IDS.shopA);
    expect(draft).not.toBeNull();
    expect(normalizeDeliveryState(draft)).toBe(MESSAGE_DELIVERY_STATES.DRAFT_READY);
    return { result, draft };
};

const rowOf = (messageId) => Message.findByPk(messageId);
const outboxOf = (messageId) => InboxDeliveryOutbox.findOne({ where: { message_id: messageId } });

describe('P05 PIPELINE — draft → approve → send → evidence', () => {

    test('a DRAFT reply reaches the customer ONLY through the real approve route, exactly once', async () => {
        const { draft } = await storeDraft();

        // Zero provider sends before the merchant acts.
        expect(transport.capturedSends()).toHaveLength(0);

        const approval = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });

        expect(approval.status).toBe(200);
        expect(approval.body.success).toBe(true);

        // Exactly ONE provider call, carrying the text the merchant approved.
        const sends = transport.capturedSends();
        expect(sends).toHaveLength(1);
        expect(harness.sentBody(sends)).toContain(EXPECTED.knownProductName);

        // Evidence: SENT + a provider message id + approval provenance.
        const stored = await rowOf(draft.id);
        expect(normalizeDeliveryState(stored)).toBe(MESSAGE_DELIVERY_STATES.SENT);
        expect(stored.delivery_state).toBe(MESSAGE_DELIVERY_STATES.SENT);
        expect(stored.provider_message_id).toMatch(/^mid\.e2e\./);
        expect(stored.metadata.delivery_source).toBe('DRAFT_APPROVAL');
        expect(stored.metadata.provider_send_confirmed).toBe(true);
        expect(stored.metadata.approved_at).toBeTruthy();

        // The outbox row the approval created is settled, not stranded.
        expect(await outboxOf(draft.id)).toMatchObject({ status: 'COMPLETED' });

        // A second approval replays idempotently: 200, no second provider send.
        const replay = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });
        expect(replay.status).toBe(200);
        expect(transport.capturedSends()).toHaveLength(1);

        // The merchant can still continue the conversation over HTTP.
        const continuation = await harness.merchantAgentReply({
            shopId: IDS.shopA,
            content: 'Anything else I can help with?',
        });
        expect([200, 201]).toContain(continuation.status);
        expect(transport.capturedSends()).toHaveLength(2);
        expect(harness.sentBody(transport.capturedSends().slice(1)))
            .toContain('Anything else I can help with?');
    });

    test('a provider error holds the draft as HELD with the attempt recorded; retry cannot re-send', async () => {
        const { draft } = await storeDraft();

        transport.failNextSend(new Error('(#190) Temporary hold on messaging'));

        const approval = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });

        // The merchant is told the truth: no success is reported.
        expect(approval.status).toBe(409);
        expect(approval.body.success).toBe(false);
        expect(approval.body.code).toBe('DRAFT_DELIVERY_NOT_CONFIRMED');

        const stored = await rowOf(draft.id);
        expect(normalizeDeliveryState(stored)).toBe(MESSAGE_DELIVERY_STATES.HELD);
        expect(stored.provider_message_id).toBeNull();
        expect(stored.metadata.provider_send_attempted).toBe(true);
        expect(stored.metadata.held_reason).toBe('provider_send_failed');
        // The failure stays merchant-visible so the inbox can recover deliberately.
        expect(stored.metadata.suggestion_visibility).toBe(SUGGESTION_VISIBILITY.VISIBLE_HITL_REVIEW);

        expect(await outboxOf(draft.id)).toMatchObject({
            status: 'NEEDS_RECONCILIATION',
            last_error_code: 'DRAFT_DELIVERY_NOT_CONFIRMED',
        });

        // Retry guard (mirrors the reconciler's never-resend-attempted rule):
        // a second approval is refused and NO second provider call leaves.
        const sends = transport.capturedSends().length;
        const retry = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });
        expect(retry.status).toBe(409);
        expect(retry.body.success).toBe(false);
        expect(String(retry.body.message)).toMatch(/already attempted/i);
        expect(transport.capturedSends()).toHaveLength(sends);
    });

    test('a provider response without a message id is never reported as delivered', async () => {
        const { draft } = await storeDraft();

        transport.succeedNextSendWithoutAck();
        const approval = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });

        expect(approval.status).toBe(409);
        expect(approval.body.success).toBe(false);

        const stored = await rowOf(draft.id);
        // PROVIDER_NO_ACK: the row must hold, never claim SENT without a
        // provider message id (updateDeliveryStatus refuses that write).
        expect(normalizeDeliveryState(stored)).toBe(MESSAGE_DELIVERY_STATES.HELD);
        expect(stored.delivery_state).not.toBe(MESSAGE_DELIVERY_STATES.SENT);
        expect(stored.provider_message_id).toBeNull();

        // Nothing in this conversation may claim delivery.
        const conversation = await harness.conversationFor(IDS.shopA);
        const sentRows = (await harness.messagesFor(conversation.id))
            .filter((m) => normalizeDeliveryState(m) === MESSAGE_DELIVERY_STATES.SENT);
        expect(sentRows).toHaveLength(0);
    });

    test('an approval outside the 24-hour window is denied BEFORE any provider call', async () => {
        const { draft } = await storeDraft();

        // Age the customer's verified inbound evidence past Meta's window.
        const conversation = await harness.conversationFor(IDS.shopA);
        const customer = await Customer.findByPk(conversation.customer_id);
        const consent = { ...(customer.messaging_consent || {}) };
        expect(consent.facebook?.opted_in).toBe(true); // set by the real webhook turn
        consent.facebook = {
            ...consent.facebook,
            last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        };
        await customer.update({ messaging_consent: consent });

        const approval = await harness.approveDraft({ shopId: IDS.shopA, messageId: draft.id });

        // twentyFourHourWindow sets within_window=false and templateRequired
        // owns the deny: the request is never built and the provider is never
        // called — no doomed send can teach Meta to distrust the app.
        expect(approval.status).toBe(409);
        expect(String(approval.body.message)).toMatch(/blocked by policy/i);
        expect(transport.capturedSends()).toHaveLength(0);

        const stored = await rowOf(draft.id);
        expect(normalizeDeliveryState(stored)).toBe(MESSAGE_DELIVERY_STATES.HELD);
        expect(stored.metadata.provider_send_attempted).not.toBe(true);
        // A policy hold stays reviewable: once the window reopens (a fresh
        // inbound), the merchant can still approve the same suggestion.
        expect(isReviewableSuggestion(stored)).toBe(true);
        expect(await outboxOf(draft.id)).toMatchObject({ status: 'PENDING' });
    });
});
