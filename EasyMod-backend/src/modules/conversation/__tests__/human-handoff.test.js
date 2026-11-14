'use strict';

/**
 * human-handoff.service — escalateToHuman() shared by the sentiment
 * auto-escalation and the low-confidence handoff paths in the message worker.
 */

process.env.NODE_ENV = 'test';

const mockNotifyShop = jest.fn().mockResolvedValue({ queued: true });
const mockGetShopAiSettings = jest.fn();
const mockMessageUpdate = jest.fn(async () => [1]);

jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('src/modules/conversation/escalation-auto-reply.service', () => ({
    sendEscalationAutoReply: jest.fn(),
}));
jest.mock('src/modules/policy/policy.engine', () => ({
    evaluateOutbound: jest.fn(),
}));
jest.mock('src/modules/entities', () => ({
    Customer: { findOne: jest.fn() },
    MetaChannelSettings: { findOne: jest.fn() },
    Message: { update: (...args) => mockMessageUpdate(...args) },
}));
jest.mock('src/modules/conversation/conversation-lock.service', () => ({
    acquireForDelivery: jest.fn(async () => ({ available: false })),
    releaseLock: jest.fn(async () => {}),
}));
jest.mock('src/modules/shop/shop.service', () => ({
    getShopAiSettings: mockGetShopAiSettings,
}));
jest.mock('src/modules/channel-providers/channel-automation.resolver', () => ({
    loadEffectiveChannelAutomation: jest.fn(),
}));
jest.mock('src/modules/notification/merchant-notification.service', () => ({
    notifyShop: mockNotifyShop,
}));

const sseManager = require('src/utils/sse-manager');
const { getProvider } = require('src/modules/channel-providers/provider.registry');
const { sendEscalationAutoReply } = require('src/modules/conversation/escalation-auto-reply.service');
const policyEngine = require('src/modules/policy/policy.engine');
const { Customer, MetaChannelSettings } = require('src/modules/entities');
const { loadEffectiveChannelAutomation } = require('src/modules/channel-providers/channel-automation.resolver');
const { escalateToHuman } = require('src/modules/conversation/human-handoff.service');

describe('escalateToHuman', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetShopAiSettings.mockResolvedValue({
            handoff_settings: { cooldown_minutes: 30 },
        });
        Customer.findOne.mockResolvedValue({ id: 'cust-1' });
        MetaChannelSettings.findOne.mockResolvedValue({ channel_id: 'ch1' });
        policyEngine.evaluateOutbound.mockResolvedValue({
            allow: true,
            reason: 'OK',
            augment: {},
            transform: null,
        });
        loadEffectiveChannelAutomation.mockResolvedValue({
            mode: 'AUTO',
            modeSource: 'business_default',
            emergencyStop: { active: false },
        });
    });

    test('sets hitl=true, emits hitl_changed, and delivers a holding message to the customer', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on', conversation_id: 'c1' });
        MetaChannelSettings.findOne.mockResolvedValue({
            channel_id: 'ch1',
            ai_auto_reply: false,
            automation_mode: 'AUTO',
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            purpose_label: 'Sales',
        });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' }, reason: 'low_confidence',
        });

        expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({
            hitl: true,
            // P+03: the reason is recorded on the authoritative record itself.
            metadata: expect.objectContaining({
                handoff_reason: expect.any(String),
                handoff_at: expect.any(String),
            }),
        }));
        expect(sseManager.emit).toHaveBeenCalledWith('s1', 'hitl_changed', {
            conversation_id: 'c1',
            hitl: true,
            needs_merchant_reply: true,
            needs_merchant_reply_reason: 'HITL_REQUIRED',
            ai_is_replying: false,
        });
        expect(sendEscalationAutoReply).toHaveBeenCalledWith('c1', 's1');
        expect(send).toHaveBeenCalledTimes(1);
        const arg = send.mock.calls[0][0];
        expect(arg.normalizedMessage.text).toBe('hold on');
        expect(arg.normalizedMessage.platform).toBe('facebook'); // messenger normalizes to facebook
        expect(arg.recipientId).toBe('123');
        expect(policyEngine.evaluateOutbound).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'hold on', platform: 'facebook', senderRole: 'ai' }),
            expect.objectContaining({
                shopId: 's1',
                channelId: 'ch1',
                conversationId: 'c1',
                recipientId: '123',
                platform: 'facebook',
                settings: expect.objectContaining({
                    automation_mode: 'AUTO',
                    business_hours: { mon: { open: '09:00', close: '18:00' } },
                    purpose_label: 'Sales',
                }),
            }),
        );
        expect(policyEngine.evaluateOutbound.mock.calls[0][1].settings).not.toHaveProperty('ai_auto_reply');
        expect(arg.decision.reason).toBe('OK');
    });

    test('does not flip hitl again when already true (idempotent), still reassures', async () => {
        const conversation = { id: 'c1', hitl: true, update: jest.fn().mockResolvedValue() };
        getProvider.mockReturnValue({ sendMessage: jest.fn().mockResolvedValue() });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'instagram', recipientId: 1, channel: { id: 'ch1' },
        });

        expect(conversation.update).not.toHaveBeenCalled();
        expect(sendEscalationAutoReply).toHaveBeenCalled();
    });

    test('never throws when holding-message delivery fails', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        getProvider.mockReturnValue({ sendMessage: jest.fn().mockRejectedValue(new Error('meta down')) });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });

        await expect(escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'instagram', recipientId: 1, channel: { id: 'ch1' },
        })).resolves.not.toThrow();
    });

    test('does not deliver the holding message when policy blocks it', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });
        policyEngine.evaluateOutbound.mockResolvedValue({
            allow: false,
            reason: 'OPTED_OUT',
            augment: {},
        });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(policyEngine.evaluateOutbound).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('retains the holding message and HITL visibility without sending when customer context is missing', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        const holdingMessage = { id: 'm1', content: 'hold on' };
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue(holdingMessage);
        Customer.findOne.mockResolvedValue(null);

        const result = await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(result).toBe(holdingMessage);
        expect(sseManager.emit).toHaveBeenCalledWith('s1', 'new_message', {
            conversation_id: 'c1', message: holdingMessage,
        });
        expect(sseManager.emit).toHaveBeenCalledWith('s1', 'hitl_changed', {
            conversation_id: 'c1',
            hitl: true,
            needs_merchant_reply: true,
            needs_merchant_reply_reason: 'HITL_REQUIRED',
            ai_is_replying: false,
        });
        expect(mockNotifyShop).toHaveBeenCalledWith(
            's1', 'ai_hitl', expect.objectContaining({ conversationId: 'c1' }), expect.any(Object),
        );
        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('retains HITL visibility and explicitly does not send when customer lookup fails', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });
        Customer.findOne.mockRejectedValue(new Error('customer store unavailable'));

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('retains HITL visibility and explicitly does not send when channel settings are missing', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });
        MetaChannelSettings.findOne.mockResolvedValue(null);

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('retains HITL visibility and explicitly does not send when channel settings lookup fails', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });
        MetaChannelSettings.findOne.mockRejectedValue(new Error('settings store unavailable'));

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('does not send when the conversation cannot be marked HITL', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockRejectedValue(new Error('conversation store unavailable')) };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(send).not.toHaveBeenCalled();
    });

    test('retains the holding message and HITL visibility but does not send without platform context', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });

        const result = await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            recipientId: 123, channel: { id: 'ch1' },
        });

        expect(result).toEqual(expect.objectContaining({ id: 'm1' }));
        expect(sseManager.emit).toHaveBeenCalledWith('s1', 'hitl_changed', {
            conversation_id: 'c1',
            hitl: true,
            needs_merchant_reply: true,
            needs_merchant_reply_reason: 'HITL_REQUIRED',
            ai_is_replying: false,
        });
        expect(sseManager.emit).toHaveBeenCalledWith('s1', 'new_message', expect.any(Object));
        expect(mockNotifyShop).toHaveBeenCalled();
        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('does not send when the resolved customer context is malformed', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });
        Customer.findOne.mockResolvedValue({});

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 123, channel: { id: 'ch1' },
        });

        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    test('skips provider delivery when no channel could be resolved', async () => {
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        sendEscalationAutoReply.mockResolvedValue({ id: 'm1', content: 'hold on' });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1',
            platform: 'messenger', recipientId: 1, channel: null,
        });

        expect(getProvider).not.toHaveBeenCalled();
    });
});

describe('emergency stop / fail-closed holding delivery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetShopAiSettings.mockResolvedValue({ handoff_settings: { cooldown_minutes: 30 } });
        Customer.findOne.mockResolvedValue({ id: 'cust-1' });
        MetaChannelSettings.findOne.mockResolvedValue({ channel_id: 'ch1' });
        policyEngine.evaluateOutbound.mockResolvedValue({ allow: true, reason: 'OK', transform: null });
        sendEscalationAutoReply.mockResolvedValue({
            id: 'm1', content: 'hold on', conversation_id: 'c1', metadata: {},
        });
        mockMessageUpdate.mockResolvedValue([1]);
    });

    test('stop suppresses the automatic holding send, stamps HELD emergency_stop, preserves hitl', async () => {
        loadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL', modeSource: 'emergency_stop', emergencyStop: { active: true },
        });
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1', platform: 'messenger',
            recipientId: 123, channel: { id: 'ch1' }, reason: 'low_confidence',
        });

        expect(send).not.toHaveBeenCalled();
        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            delivery_state: 'HELD',
            metadata: expect.objectContaining({
                held_reason: 'emergency_stop',
                delivery_state: 'HELD',
            }),
        }), expect.objectContaining({
            where: expect.objectContaining({ id: 'm1', conversation_id: 'c1' }),
        }));
        // Human agency: hitl is only ever SET here, never cleared by the stop.
        expect(conversation.update).toHaveBeenCalledTimes(1);
        expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({ hitl: true }));
    });

    test('an unavailable resolver holds with channel_settings_unavailable and never calls the provider', async () => {
        loadEffectiveChannelAutomation.mockRejectedValueOnce(new Error('shop settings unavailable'));
        const conversation = { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue() };
        const send = jest.fn().mockResolvedValue();
        getProvider.mockReturnValue({ sendMessage: send });

        await escalateToHuman({
            conversation, shopId: 's1', conversationId: 'c1', platform: 'messenger',
            recipientId: 123, channel: { id: 'ch1' }, reason: 'low_confidence',
        });

        expect(send).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ held_reason: 'channel_settings_unavailable' }),
        }), expect.any(Object));
    });
});

describe('configured handoff notification cooldown', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetShopAiSettings.mockResolvedValue({ handoff_settings: { cooldown_minutes: 45 } });
        sendEscalationAutoReply.mockResolvedValue({ id: 'holding-1', content: 'A human will help shortly' });
    });

    test('uses one shop-wide dedupe key and the configured TTL', async () => {
        await escalateToHuman({
            conversation: { id: 'conversation-1', hitl: false, update: jest.fn().mockResolvedValue(undefined) },
            shopId: 'shop-1', conversationId: 'conversation-1', platform: 'messenger',
            recipientId: 'customer-1', channel: null, reason: 'low_confidence',
        });

        expect(mockNotifyShop).toHaveBeenCalledWith(
            'shop-1', 'ai_hitl',
            expect.objectContaining({ conversationId: 'conversation-1' }),
            { dedupeKey: 'shop:shop-1:ai_handoff', dedupeTtlSeconds: 45 * 60 },
        );
    });

    test('zero disables the configurable shop-wide suppression key', async () => {
        mockGetShopAiSettings.mockResolvedValue({ handoff_settings: { cooldown_minutes: 0 } });

        await escalateToHuman({
            conversation: { id: 'conversation-2', hitl: false, update: jest.fn().mockResolvedValue(undefined) },
            shopId: 'shop-1', conversationId: 'conversation-2', platform: 'messenger',
            recipientId: 'customer-2', channel: null, reason: 'sentiment_angry',
        });

        expect(mockNotifyShop).toHaveBeenCalledWith(
            'shop-1', 'ai_hitl',
            expect.objectContaining({ conversationId: 'conversation-2' }), {},
        );
    });
});
