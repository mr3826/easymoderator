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
