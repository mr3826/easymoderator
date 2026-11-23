'use strict';

/**
 * D-P2-03 / W4 copy-accuracy: the human-handoff reassurance must not assert a
 * response-time SLA the platform never committed to. The old default promised
 * "within 2 hours"; that was a fabricated business claim (no documented service
 * commitment anywhere — confirmed against frontend i18n + backend defaults).
 * The shipped default is now non-time-bound.
 */

const mockConversationFindOne = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageCreate = jest.fn();

jest.mock('../conversation.entity', () => ({
    Conversation: { findOne: mockConversationFindOne },
    Message: { findOne: mockMessageFindOne, create: mockMessageCreate },
}));
jest.mock('../../shop/shop.service', () => ({
    getShopAiSettings: jest.fn(async () => ({})),
}));

const { sendEscalationAutoReply, DEFAULT_ESCALATION_TEMPLATE } = require('../escalation-auto-reply.service');
const shopService = require('../../shop/shop.service');
const { DEFAULT_AI_SETTINGS } = require('../../shop/shop-defaults');

// Any explicit response-time commitment (digits + time unit, either script),
// or a soft ASAP promise. Deliberately broad; the safe copy must match none.
const SLA_PATTERN = new RegExp([
    '\\d+\\s*(?:minute|hour|min|hr|day|week)s?',
    '\\d+\\s*(?:ঘণ্টা|মিনিট|দিন|সেকেন্ড)',
    'ঘণ্টার\\s+মধ্যে',
    'within\\s+\\d',
    'respond\\s+within',
    'as\\s+soon\\s+as\\s+possible',
].join('|'), 'i');

beforeEach(() => {
    jest.clearAllMocks();
    mockConversationFindOne.mockResolvedValue({ id: 'conversation-1', shop_id: 'shop-1', channel: 'messenger' });
    mockMessageFindOne.mockResolvedValue(null);
    mockMessageCreate.mockImplementation(async (attributes) => ({ ...attributes, created_at: new Date() }));
});

describe('escalation holding copy — no fabricated SLA', () => {
    test('DEFAULT_ESCALATION_TEMPLATE asserts no response-time commitment', () => {
        expect(SLA_PATTERN.test(DEFAULT_ESCALATION_TEMPLATE)).toBe(false);
    });

    test('the template still honestly forwards to the team and promises contact', () => {
        expect(DEFAULT_ESCALATION_TEMPLATE).toMatch(/team|প্রতিনিধি|representative/i);
        expect(DEFAULT_ESCALATION_TEMPLATE).toMatch(/contact|যোগাযোগ|get back/i);
    });

    test('sendEscalationAutoReply with no shop override writes the non-time-bound default', async () => {
        await sendEscalationAutoReply('conversation-1', 'shop-1', 'messenger');
        const created = mockMessageCreate.mock.calls[0][0];
        expect(created.content).toBe(DEFAULT_ESCALATION_TEMPLATE);
        expect(SLA_PATTERN.test(created.content)).toBe(false);
    });

    // MF-2 (A9): getShopAiSettings merges DEFAULT_AI_SETTINGS into every shop and the
    // send path PREFERS the shop template over the service default, so the SLA only
    // disappears if the shop-default string itself is non-time-bound. Fails against
    // the old "…within 2 hours." default.
    test('MF-2 — the shop-default escalation template asserts no response-time SLA', () => {
        const tpl = DEFAULT_AI_SETTINGS.escalation_reply_template;
        expect(tpl).toBeTruthy();
        expect(SLA_PATTERN.test(tpl)).toBe(false);
        expect(tpl).toMatch(/team|প্রতিনিধি|representative/i);
        expect(tpl).toMatch(/contact|যোগাযোগ|get back/i);
    });

    test('MF-2 — a default-settings shop still receives SLA-free copy via the shop-template override', async () => {
        shopService.getShopAiSettings.mockResolvedValueOnce({
            escalation_reply_template: DEFAULT_AI_SETTINGS.escalation_reply_template,
        });
        await sendEscalationAutoReply('conversation-1', 'shop-1', 'messenger');
        const created = mockMessageCreate.mock.calls[0][0];
        // The shop template wins (proves this is the path that reaches customers)…
        expect(created.content).toBe(DEFAULT_AI_SETTINGS.escalation_reply_template);
        // …and it carries no fabricated SLA.
        expect(SLA_PATTERN.test(created.content)).toBe(false);
    });
});
