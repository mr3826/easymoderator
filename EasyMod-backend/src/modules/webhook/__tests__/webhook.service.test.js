'use strict';

/**
 * Tests for src/modules/webhook/webhook.service.js
 *
 * Routing-boundary rewrite: shim delegates to providerRegistry + MetaChannel lookup.
 * All DB and provider calls are mocked — no real HTTP calls.
 *
 * Test cases preserved from the pre-Phase-5 suite:
 *   1. delegates to provider.sendMessage with correct args
 *   2. maps facebook channel type to facebook platform (provider key)
 *   3. rejects unsupported channel types instead of reinterpreting them
 *   4. does nothing if channel is missing
 *   5. does nothing if recipientId is missing
 *   6. does nothing if message is missing
 *   7. re-throws errors from provider.sendMessage
 *   8. converts numeric recipientId to string
 */

// ── Mock MetaChannel ─────────────────────────────────────────────────────────
const mockMetaChannel = {
    id: 'mc-1',
    shop_id: 'shop-uuid-1234',
    platform: 'facebook',
    meta_asset_id: 'page-1',
    status: 'CONNECTED',
};

const mockMetaChannelService = {
    findConnectedById: jest.fn().mockResolvedValue(mockMetaChannel),
    findByMetaAssetId: jest.fn().mockResolvedValue(null),
    findUniqueConnectedByShopAndPlatform: jest.fn().mockResolvedValue(mockMetaChannel),
    getSettings: jest.fn().mockResolvedValue({ channel_id: 'mc-1', automation_mode: 'DRAFT', ai_auto_reply: true }),
};
jest.mock('../../channel-providers/meta-channel.service', () => mockMetaChannelService);

const mockConversation = {
    findAll: jest.fn().mockResolvedValue([]),
};
jest.mock('../../conversation/conversation.entity', () => ({ Conversation: mockConversation }));

// Customer is now looked up in the shim so the policy engine has opt-out context.
const mockCustomerRecord = {
    id: 'cust-uuid-1',
    shop_id: 'shop-uuid-1234',
    channel_type: 'messenger',
    channel_user_id: 'psid-123',
    meta_channel_id: 'mc-1',
};
jest.mock('../../customer/customer.entity', () => ({
    findOne: jest.fn().mockResolvedValue(mockCustomerRecord),
}));

// ── Mock provider registry ───────────────────────────────────────────────────
const mockSendMessage = jest.fn();

jest.mock('../../channel-providers/provider.registry', () => ({
    getProvider: jest.fn(() => ({ sendMessage: mockSendMessage })),
}));

// ── Mock policy engine — always allow ────────────────────────────────────────
jest.mock('../../policy/policy.engine', () => ({
    evaluateOutbound: jest.fn().mockResolvedValue({
        allow: true,
        reason: 'OK',
        transform: null,
        augment: {},
        decisionId: 'dec-1',
    }),
}));

// The shim consults the single resolver (ADR-0013 §5); never the business-only
// display reader.
jest.mock('../../channel-providers/channel-automation.resolver', () => ({
    loadEffectiveChannelAutomation: jest.fn(),
}));

const metaChannelService = require('../../channel-providers/meta-channel.service');
const { Conversation } = require('../../conversation/conversation.entity');
const Customer = require('../../customer/customer.entity');
const { getProvider } = require('../../channel-providers/provider.registry');
const policyEngine = require('../../policy/policy.engine');
const { loadEffectiveChannelAutomation } = require('../../channel-providers/channel-automation.resolver');
const { sendMessage, sendToCustomer } = require('../webhook.service');

// ── Helpers ──────────────────────────────────────────────────────────────────
const buildChannel = (overrides = {}) => ({
    shop_id: 'shop-uuid-1234',
    type: 'facebook',
    is_active: true,
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    Conversation.findAll.mockResolvedValue([]);
    metaChannelService.findConnectedById.mockResolvedValue(mockMetaChannel);
    metaChannelService.findByMetaAssetId.mockResolvedValue(null);
    metaChannelService.findUniqueConnectedByShopAndPlatform.mockResolvedValue(mockMetaChannel);
    metaChannelService.getSettings.mockResolvedValue({ channel_id: 'mc-1', automation_mode: 'DRAFT', ai_auto_reply: true });
    Customer.findOne.mockResolvedValue(mockCustomerRecord);
    mockSendMessage.mockResolvedValue({ providerMessageId: 'mid-1' });
    loadEffectiveChannelAutomation.mockResolvedValue({
        mode: 'AUTO',
        modeSource: 'business_default',
        emergencyStop: { active: false },
        shopIsActive: true,
        billingAiActive: true,
    });
});

describe('sendMessage (webhook shim — exact routing)', () => {

    test('delegates to provider.sendMessage with correct args', async () => {
        mockSendMessage.mockResolvedValueOnce({});

        const channel = buildChannel();
        await sendMessage(channel, 'psid-123', 'Hello customer');

        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).toHaveBeenCalledWith(
            'shop-uuid-1234',
            'facebook',
        );
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(Customer.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ meta_channel_id: 'mc-1' }),
        }));
        expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            channel: mockMetaChannel,
            recipientId: 'psid-123',
            normalizedMessage: expect.objectContaining({ text: 'Hello customer' }),
        }));
        const policySettings = policyEngine.evaluateOutbound.mock.calls[0][1].settings;
        expect(policySettings).not.toHaveProperty('ai_auto_reply');
        expect(policySettings).not.toHaveProperty('channel_id');
    });

    test('maps facebook channel type to facebook platform', async () => {
        mockSendMessage.mockResolvedValueOnce({});
        await sendMessage(buildChannel({ type: 'facebook' }), 'psid', 'msg');

        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).toHaveBeenCalledWith(
            'shop-uuid-1234',
            'facebook',
        );
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test('maps messenger channel type to facebook platform', async () => {
        mockSendMessage.mockResolvedValueOnce({});
        await sendMessage(buildChannel({ type: 'messenger' }), 'psid', 'msg');

        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).toHaveBeenCalledWith(
            'shop-uuid-1234',
            'facebook',
        );
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test('does not reinterpret an Instagram channel as Facebook', async () => {
        await sendMessage(buildChannel({ type: 'instagram' }), 'legacy-id', 'msg');

        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not call provider.sendMessage if channel is missing', async () => {
        await sendMessage(null, 'psid', 'msg');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not resolve a channel when the tenant scope is missing', async () => {
        await sendMessage({ type: 'facebook' }, 'psid', 'msg');

        expect(metaChannelService.findConnectedById).not.toHaveBeenCalled();
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not call provider.sendMessage if recipientId is missing', async () => {
        await sendMessage(buildChannel(), null, 'msg');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not call provider.sendMessage if message is missing', async () => {
        await sendMessage(buildChannel(), 'psid', '');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('re-throws errors from provider.sendMessage', async () => {
        mockSendMessage.mockRejectedValueOnce(new Error('Meta API error'));
        await expect(sendMessage(buildChannel(), 'psid', 'msg')).rejects.toThrow('Meta API error');
    });

    test('converts numeric recipientId to string', async () => {
        mockSendMessage.mockResolvedValueOnce({});
        await sendMessage(buildChannel(), 12345, 'msg');
        expect(mockSendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ recipientId: '12345' })
        );
    });

    test('drops send silently when no MetaChannel found for shop+platform', async () => {
        metaChannelService.findUniqueConnectedByShopAndPlatform.mockResolvedValueOnce(null);
        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toMatchObject({
            sent: false,
            reason: 'no_channel',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when the customer lookup dependency fails', async () => {
        Customer.findOne.mockRejectedValueOnce(new Error('customer store unavailable'));

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'customer_lookup_error',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when the customer context is unknown', async () => {
        Customer.findOne.mockResolvedValueOnce(null);

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'customer_context_unavailable',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when channel settings are missing', async () => {
        metaChannelService.getSettings.mockResolvedValueOnce(null);

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'settings_unavailable',
        });
        expect(policyEngine.evaluateOutbound).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when channel settings lookup fails', async () => {
        metaChannelService.getSettings.mockRejectedValueOnce(new Error('settings store unavailable'));

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'settings_lookup_error',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when channel settings are an empty object', async () => {
        metaChannelService.getSettings.mockResolvedValueOnce({});

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'settings_unavailable',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not require the deprecated Page mode in channel settings', async () => {
        metaChannelService.getSettings.mockResolvedValueOnce({ channel_id: 'mc-1' });
        mockSendMessage.mockResolvedValueOnce({});

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual(expect.objectContaining({
            sent: true,
        }));

        expect(policyEngine.evaluateOutbound).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                settings: expect.objectContaining({ automation_mode: expect.any(String) }),
            }),
        );
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('the effective resolver mode (not the business default) reaches the policy engine', async () => {
        loadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'DRAFT',
            modeSource: 'channel_override',
            emergencyStop: { active: false },
        });
        mockSendMessage.mockResolvedValueOnce({});

        await sendMessage(buildChannel(), 'psid', 'msg');

        expect(loadEffectiveChannelAutomation).toHaveBeenCalledWith('shop-uuid-1234', 'mc-1');
        expect(policyEngine.evaluateOutbound).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({ settings: expect.objectContaining({ automation_mode: 'DRAFT' }) }),
        );
    });

    test('an unavailable resolver blocks the automatic send (fail-closed)', async () => {
        loadEffectiveChannelAutomation.mockRejectedValueOnce(new Error('shop unavailable'));

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'channel_settings_unavailable',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('emergency stop suppresses a non-transactional automatic send', async () => {
        loadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL',
            modeSource: 'emergency_stop',
            emergencyStop: { active: true },
        });

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'emergency_stop',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('transactional post-mutation facts still reach the customer during a stop', async () => {
        loadEffectiveChannelAutomation.mockResolvedValueOnce({
            mode: 'MANUAL',
            modeSource: 'emergency_stop',
            emergencyStop: { active: true },
        });
        mockSendMessage.mockResolvedValueOnce({});

        await expect(sendMessage(buildChannel(), 'psid', 'order confirmed', { messageType: 'transactional' }))
            .resolves.toEqual(expect.objectContaining({ sent: true }));
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('does not send when the customer channel type is unknown', async () => {
        Customer.findOne.mockResolvedValueOnce({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_user_id: 'psid',
        });

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'platform_mismatch',
        });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not send when policy allow is not the boolean true', async () => {
        policyEngine.evaluateOutbound.mockResolvedValueOnce({ allow: 'true', reason: 'malformed' });

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual(expect.objectContaining({
            sent: false,
            reason: 'policy_denied',
        }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not report sent when the provider completes without a send result', async () => {
        mockSendMessage.mockResolvedValueOnce(undefined);

        await expect(sendMessage(buildChannel(), 'psid', 'msg')).resolves.toEqual({
            sent: false,
            reason: 'provider_no_send',
        });
    });

    // Exact channel routing
    test('uses findByPk when channel.meta_channel_id is provided', async () => {
        mockSendMessage.mockResolvedValueOnce({});
        await sendMessage(buildChannel({ meta_channel_id: 'mc-explicit' }), 'psid', 'msg');

        expect(metaChannelService.findConnectedById).toHaveBeenCalledWith('mc-explicit', {
            shopId: 'shop-uuid-1234',
            platform: 'facebook',
        });
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test('does not fall back when an explicit meta_channel_id is stale', async () => {
        metaChannelService.findConnectedById.mockResolvedValueOnce(null);

        await expect(sendMessage(buildChannel({ meta_channel_id: 'mc-deleted' }), 'psid', 'msg'))
            .resolves.toMatchObject({ sent: false, reason: 'no_channel' });

        expect(metaChannelService.findConnectedById).toHaveBeenCalledWith('mc-deleted', expect.any(Object));
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('uses an explicit Page asset without falling back to shop-wide lookup', async () => {
        metaChannelService.findByMetaAssetId.mockResolvedValueOnce(mockMetaChannel);
        mockSendMessage.mockResolvedValueOnce({});

        await sendMessage(buildChannel({ meta_asset_id: 'page-1' }), 'psid', 'msg');

        expect(metaChannelService.findByMetaAssetId).toHaveBeenCalledWith('page-1');
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test.each(['wrong shop', 'disconnected', 'platform mismatch', 'asset mismatch'])(
        'does not send or fall back when the explicit channel has a %s',
        async () => {
            metaChannelService.findConnectedById.mockResolvedValueOnce(null);

            await expect(sendMessage(buildChannel({
                meta_channel_id: 'mc-explicit',
                meta_asset_id: 'page-expected',
            }), 'psid', 'msg')).resolves.toMatchObject({ sent: false, reason: 'no_channel' });

            expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
            expect(mockSendMessage).not.toHaveBeenCalled();
        },
    );

    test('sendToCustomer uses the one distinct Messenger conversation channel', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
        });
        Conversation.findAll.mockResolvedValue([
            { meta_channel_id: 'mc-1' },
            { meta_channel_id: 'mc-1' },
        ]);
        mockSendMessage.mockResolvedValueOnce({});

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(Conversation.findAll).toHaveBeenCalledWith(expect.objectContaining({
            where: { shop_id: 'shop-uuid-1234', customer_id: 'cust-uuid-1', channel: 'messenger' },
            attributes: ['meta_channel_id'],
        }));
        expect(metaChannelService.findConnectedById).toHaveBeenCalledWith('mc-1', expect.any(Object));
        expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'psid-cust-9',
        }));
        expect(result).toEqual(expect.objectContaining({ sent: true, recipientId: 'psid-cust-9' }));
    });

    test('sendToCustomer fails closed instead of using a shop-wide Page fallback', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
            meta_channel_id: null,
        });
        Conversation.findAll.mockResolvedValue([]);

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(result).toEqual({ sent: false, reason: 'no_channel' });
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('sendToCustomer returns ambiguous_channel and does not send for multiple distinct channels', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
        });
        Conversation.findAll.mockResolvedValue([
            { meta_channel_id: 'mc-1' },
            { meta_channel_id: 'mc-2' },
        ]);

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(result).toEqual({ sent: false, reason: 'ambiguous_channel' });
        expect(metaChannelService.findConnectedById).not.toHaveBeenCalled();
        expect(metaChannelService.findUniqueConnectedByShopAndPlatform).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('sendToCustomer honors an explicit channel without querying conversation candidates', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
        });
        mockSendMessage.mockResolvedValueOnce({});

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
            metaChannelId: 'mc-explicit',
        });

        expect(Conversation.findAll).not.toHaveBeenCalled();
        expect(metaChannelService.findConnectedById).toHaveBeenCalledWith('mc-explicit', expect.any(Object));
        expect(result).toEqual(expect.objectContaining({ sent: true }));
    });

    test('sendToCustomer does not reinterpret a non-Messenger customer as Messenger', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'instagram',
            channel_user_id: 'legacy-7',
        });

        const result = await sendToCustomer({ shopId: 'shop-uuid-1234', customerId: 'cust-uuid-1', message: 'hi' });

        expect(result).toEqual({ sent: false, reason: 'platform_mismatch' });
        expect(Conversation.findAll).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('sendToCustomer fails closed when conversation channel context is unavailable', async () => {
        Customer.findOne.mockResolvedValue({
            id: 'cust-uuid-1',
            shop_id: 'shop-uuid-1234',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
        });
        Conversation.findAll.mockResolvedValueOnce(null);

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(result).toEqual({ sent: false, reason: 'lookup_error' });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('sendToCustomer rejects a customer record from another tenant', async () => {
        Customer.findOne.mockResolvedValueOnce({
            id: 'cust-uuid-1',
            shop_id: 'other-shop',
            channel_type: 'messenger',
            channel_user_id: 'psid-cust-9',
        });

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(result).toEqual({ sent: false, reason: 'customer_context_unavailable' });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});

// ── sendToCustomer: resolve a Customer record → PSID + platform, then send ─────
// Regression coverage for the silent-notification bug: callers (order/delivery/
// payment) used to look up an undefined `Channel` model and pass a phone or an
// internal customer UUID as the recipient. sendToCustomer resolves the real
// channel_user_id (PSID/IGSID) and the customer's platform.
describe('sendToCustomer (resolve PSID from a customer record)', () => {
    const buildCustomer = (overrides = {}) => ({
        id: 'cust-uuid-1',
        shop_id: 'shop-uuid-1234',
        channel_type: 'messenger',
        channel_user_id: 'psid-cust-9',
        meta_channel_id: 'mc-1',
        ...overrides,
    });

    test('resolves the customer PSID and sends via the customer platform', async () => {
        Customer.findOne.mockResolvedValue(buildCustomer());
        mockSendMessage.mockResolvedValueOnce({});

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        // The recipient must be the channel_user_id (PSID) — NOT the customer UUID or a phone.
        expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'psid-cust-9',
            normalizedMessage: expect.objectContaining({ text: 'Your order shipped' }),
        }));
        expect(result).toEqual(expect.objectContaining({ sent: true, recipientId: 'psid-cust-9' }));
    });

    test('marks sendToCustomer as transactional for legacy consent compatibility', async () => {
        Customer.findOne.mockResolvedValue(buildCustomer({ messaging_consent: {} }));
        mockSendMessage.mockResolvedValueOnce({});

        await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(policyEngine.evaluateOutbound).toHaveBeenCalledWith(
            expect.objectContaining({ messageType: 'transactional' }),
            expect.objectContaining({ messageType: 'transactional' }),
        );
    });

    test('rejects a legacy Instagram customer instead of sending through Messenger', async () => {
        Customer.findOne.mockResolvedValue(buildCustomer({ channel_type: 'instagram', channel_user_id: 'legacy-7' }));

        const result = await sendToCustomer({ shopId: 'shop-uuid-1234', customerId: 'cust-uuid-1', message: 'hi' });

        expect(result).toEqual({ sent: false, reason: 'platform_mismatch' });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('does not report a transactional send when policy denies the outbound message', async () => {
        const policyEngine = require('../../policy/policy.engine');
        policyEngine.evaluateOutbound.mockResolvedValueOnce({ allow: false, reason: 'NO_CONSENT' });

        const result = await sendToCustomer({
            shopId: 'shop-uuid-1234',
            customerId: 'cust-uuid-1',
            message: 'Your order shipped',
        });

        expect(result).toEqual({ sent: false, reason: 'policy_denied' });
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('returns no_customer when the customer is not found', async () => {
        Customer.findOne.mockResolvedValue(null);
        const result = await sendToCustomer({ shopId: 'shop-uuid-1234', customerId: 'missing', message: 'hi' });
        expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'no_customer_psid' }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('returns no_customer_psid when the customer has no channel_user_id', async () => {
        Customer.findOne.mockResolvedValue(buildCustomer({ channel_user_id: null }));
        const result = await sendToCustomer({ shopId: 'shop-uuid-1234', customerId: 'cust-uuid-1', message: 'hi' });
        expect(result).toEqual(expect.objectContaining({ sent: false, reason: 'no_customer_psid' }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('returns missing_args when required args are absent', async () => {
        const r1 = await sendToCustomer({ shopId: null, customerId: 'c', message: 'hi' });
        const r2 = await sendToCustomer({ shopId: 's', customerId: null, message: 'hi' });
        const r3 = await sendToCustomer({ shopId: 's', customerId: 'c', message: '' });
        expect(r1).toEqual(expect.objectContaining({ sent: false, reason: 'missing_args' }));
        expect(r2).toEqual(expect.objectContaining({ sent: false, reason: 'missing_args' }));
        expect(r3).toEqual(expect.objectContaining({ sent: false, reason: 'missing_args' }));
        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});
