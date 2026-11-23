'use strict';

/**
 * D-P2-06 unit coverage for the human-request vocabulary (Guard 5b in
 * message-worker.js consumes classify()'s HUMAN_HANDOFF_REQUEST). Positive
 * cases are the phrasings from the certification incident; negative cases pin
 * that the word-boundary matcher does not create false handoffs (the
 * substring-greeting trap class, D-P2-05, must not repeat here).
 */

const { classify } = require('../intent/stage2-rules');

const hit = (text) => classify(text, {}).intentId === 'HUMAN_HANDOFF_REQUEST';

describe('D-P2-06 human-handoff phrase rules', () => {
    test.each([
        'aman ushno ekjon manus kotha bolte chai. human agent please.',
        'human agent please',
        'I want to talk to a human',
        'need a human',
        'i need an agent',
        'talk to human',
        'ekjon manus din',
        'manus er sathe kotha bolun',
        'একজন মানুষের সাথে কথা বলতে চাই',
        'কাস্টমার কেয়ার চাই',
    ])('classifies human request: %s', (text) => {
        expect(hit(text)).toBe(true);
    });

    test.each([
        'are you a human?',
        'thhis is a huumann toy for kids',
        'koto dam? manus er jonno shirt chai',
        'black panjabi ache?',
        'order korte chai',
        'stop sending messages',
    ])('does NOT false-positive on: %s', (text) => {
        expect(hit(text)).toBe(false);
    });
});

/**
 * W3 FIX 1 (agent A5, from agent A8's blind merchant pass 2026-11-24):
 * "I want to talk to a real human, not a bot" — a common frustrated-customer
 * phrasing — was NOT caught: the phrase list had 'real person' and
 * 'talk to a human' but not the 'real human' class, so the message fell to the
 * product tier and the customer got a catalog apology with no handoff.
 * These positives are the missed phrasings (en + banglish + bangla, each
 * word-boundary / multi-word disciplined). The direction of any residual
 * ambiguity stays fail-safe: a false handoff is reviewed by a human, a false
 * product-boilerplate answer is what A8 observed as the pilot risk.
 */
describe('W3 human-request phrasings missed by the D-P2-06 list (A8 pass)', () => {
    test.each([
        // A8's exact sentence, verbatim.
        'I want to talk to a real human, not a bot',
        'real human please',
        'can I speak to an actual person?',
        'i need to speak to someone real',
        'connect me to a real human',
        'ekjon real manus din please',
        'asol manus please',
        'real manusher kotha bolte chai',
        'manush er sathe kotha bolun',
        'সত্যিকারের মানুষ দরকার আমার',
        'আসল মানুষ চাই',
        'মানুষ দাও',
        'দয়া করে মানুষের সাথে কথা বলুন',
    ])('classifies human request: %s', (text) => {
        expect(hit(text)).toBe(true);
    });

    test.each([
        // Product queries that mention people/realness must NOT hand off:
        // the new phrases are multi-word human-request shapes, and 'actual
        // person' must not read through to 'actual price'.
        'real leather jacket price?',
        'manush er jonno gift suggest koro',
        'actual price koto?',
        'ekjon robot chai amake',
    ])('does NOT false-positive on: %s', (text) => {
        expect(hit(text)).toBe(false);
    });
});
