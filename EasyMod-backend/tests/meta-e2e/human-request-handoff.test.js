'use strict';

/**
 * D-P2-06 REGRESSION — an explicit human-agent request must produce a live
 * human handoff on the Messenger path, not a conversational answer.
 *
 * The original defect (Phase 2 certification, 2026-11-22): "aman ushno ekjon
 * manus kotha bolte chai. human agent please." was answered with the
 * product-not-found boilerplate and no HITL marking — reproduced twice on the
 * real pipeline. Guard 5b in message-worker.js now detects the phrase list
 * deterministically BEFORE any LLM call and routes through the shared
 * requireHumanRecovery machinery (same path as sentiment escalation).
 *
 * Business mode stays DRAFT here — nothing enables AUTO.
 */

const harness = require('./harness');
const fixtures = require('./fixtures');
const { IDS } = fixtures;
const { Conversation } = require('../../src/modules/conversation/conversation.entity');

jest.setTimeout(120000);

beforeAll(async () => { await harness.setupSuite(); });
beforeEach(async () => { await harness.resetRun(); });
afterAll(async () => { await harness.teardownSuite(); });

const REQUESTS = [
    'aman ushno ekjon manus kotha bolte chai. human agent please.',
    'Human agent please',
    'একজন মানুষের সাথে কথা বলতে চাই',
];

describe('D-P2-06: explicit human-agent request', () => {
    test.each(REQUESTS)('handoff fires before any LLM turn: %s', async (text) => {
        await harness.setBusinessReplyMode(IDS.shopA, 'DRAFT');
        const result = await harness.deliver({ text });

        const job = (result.jobResults || [])[0] || {};
        expect(job).toEqual(expect.objectContaining({
            sent: false,
            reason: 'human_requested',
            handoff: true,
        }));

        // No provider send happened (DRAFT + handoff holding message is
        // policy-held; either way nothing was auto-delivered).
        expect(result.sends || []).toHaveLength(0);

        const conv = await harness.conversationFor(IDS.shopA);
        expect(conv).toBeTruthy();
        const fresh = await Conversation.findByPk(conv.id);
        expect(fresh.hitl).toBe(true);
    });

    test('a product question is NOT swallowed by the human-request guard', async () => {
        await harness.setBusinessReplyMode(IDS.shopA, 'DRAFT');
        const result = await harness.deliver({
            text: 'black panjabi ache?',
            candidate: 'Ji, EM E2E Black Panjabi — ৳1847.(stock e ache)',
        });
        const job = (result.jobResults || [])[0] || {};
        expect(job.reason).not.toBe('human_requested');
        const conv = await harness.conversationFor(IDS.shopA);
        const fresh = await Conversation.findByPk(conv.id);
        expect(fresh.hitl).not.toBe(true);
    });
});
