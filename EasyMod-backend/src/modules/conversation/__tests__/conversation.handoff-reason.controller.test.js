'use strict';

/**
 * ADR-0013 §8 / API_CONTRACT §5 — controller seam regression.
 *
 * The Joi-validated `handoff_reason` MUST reach conversationService.updateConversation.
 * A prior revision destructured the body without it, silently falsifying every
 * manual takeover reason to the default. This test pins the HTTP handler seam
 * (the service-level suite bypasses the controller and could not catch it).
 */

const mockUpdateConversation = jest.fn();

jest.mock('../conversation.service', () => ({
    updateConversation: (...args) => mockUpdateConversation(...args),
}));
jest.mock('../../../config/redis', () => ({ cacheRedis: {} }));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../utils/cache.service', () => ({}));
jest.mock('../../channel-providers/meta-channel.service', () => ({}));
jest.mock('../../channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('../conversation-lock.service', () => ({}));
jest.mock('../../policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('../../../config/origins', () => ({
    resolvePublicAssetOrigin: jest.fn(() => ''),
    getOrigins: jest.fn(() => []),
}));
jest.mock('../../entities', () => ({
    Conversation: {},
    Message: {},
    Customer: {},
    MetaChannel: {},
    MetaChannelSettings: {},
    User: {},
    UserShop: {},
    Shop: {},
    Subscription: {},
    InboxDeliveryOutbox: {},
}));

const controller = require('../conversation.controller');

const mkRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    res.json = jest.fn((payload) => { res.body = payload; return res; });
    return res;
};

describe('conversation PATCH controller — handoff_reason forwarding', () => {
    beforeEach(() => {
        mockUpdateConversation.mockReset();
        mockUpdateConversation.mockResolvedValue({
            id: 'conv-1', shop_id: 'shop-1', hitl: true, status: 'active', metadata: {},
        });
    });

    test('forwards the merchant-selected handoff_reason to the service', async () => {
        const res = mkRes();
        await controller.updateConversation({
            params: { conversationId: 'conv-1' },
            user: { shopId: 'shop-1', userId: 'user-1', role: 'owner' },
            body: { hitl: true, handoff_reason: 'order_issue' },
        }, res);

        expect(mockUpdateConversation).toHaveBeenCalledWith(
            'conv-1',
            'shop-1',
            expect.objectContaining({ hitl: true, handoff_reason: 'order_issue' }),
            expect.objectContaining({ actor: expect.objectContaining({ userId: 'user-1' }) }),
        );
        expect(res.body.success).toBe(true);
    });

    test('forwards every fixed-list reason verbatim', async () => {
        for (const reason of ['manual_takeover', 'customer_request', 'phone_call', 'order_issue', 'other']) {
            mockUpdateConversation.mockClear();
            await controller.updateConversation({
                params: { conversationId: 'conv-1' },
                user: { shopId: 'shop-1', userId: 'user-1', role: 'owner' },
                body: { hitl: true, handoff_reason: reason },
            }, mkRes());
            expect(mockUpdateConversation).toHaveBeenCalledWith(
                'conv-1', 'shop-1',
                expect.objectContaining({ handoff_reason: reason }),
                expect.any(Object),
            );
        }
    });

    test('absent reason stays absent (service applies the default)', async () => {
        await controller.updateConversation({
            params: { conversationId: 'conv-1' },
            user: { shopId: 'shop-1', userId: 'user-1', role: 'owner' },
            body: { hitl: true },
        }, mkRes());

        const updates = mockUpdateConversation.mock.calls[0][2];
        expect(updates.handoff_reason).toBeUndefined();
    });
});
