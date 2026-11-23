'use strict';

/**
 * W4 — the holding-message send must honor the manual-takeover (human_active)
 * fence `ai:pause:<conv>` and the business-wide emergency stop.
 *
 * Before the fix the holding send read NEITHER fence (emergency stop was honored
 * only via the automation resolver in the same block), so one AI-voiced template
 * could reach the customer during a live merchant takeover (reachable via
 * turn-recovery). Redis reads are bounded and fail-open so an unreachable client
 * never stalls the send path.
 */

process.env.NODE_ENV = 'test';

const mockRedisGet = jest.fn(async () => null);
const mockNotifyShop = jest.fn().mockResolvedValue({ queued: true });
const mockMessageUpdate = jest.fn(async () => [1]);
const mockGetProviderSend = jest.fn().mockResolvedValue({ providerMessageId: 'pm-1' });

jest.mock('src/config/redis', () => ({ cacheRedis: { get: (...a) => mockRedisGet(...a) } }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn(() => ({ sendMessage: mockGetProviderSend })) }));
jest.mock('src/modules/conversation/escalation-auto-reply.service', () => ({
    sendEscalationAutoReply: jest.fn(async () => ({ id: 'm1', content: 'hold on', conversation_id: 'c1', metadata: {} })),
}));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: jest.fn(async () => ({ allow: true, reason: 'OK', transform: null })) }));
jest.mock('src/modules/entities', () => ({
    Customer: { findOne: jest.fn(async () => ({ id: 'cust-1' })) },
    MetaChannelSettings: { findOne: jest.fn(async () => ({ channel_id: 'ch1' })) },
    Message: { update: (...args) => mockMessageUpdate(...args) },
}));
jest.mock('src/modules/conversation/conversation-lock.service', () => ({
    acquireForDelivery: jest.fn(async () => ({ available: false })),
    releaseLock: jest.fn(async () => {}),
}));
jest.mock('src/modules/shop/shop.service', () => ({ getShopAiSettings: jest.fn(async () => ({ handoff_settings: { cooldown_minutes: 30 } })) }));
jest.mock('src/modules/channel-providers/channel-automation.resolver', () => ({
    loadEffectiveChannelAutomation: jest.fn(async () => ({ mode: 'AUTO', modeSource: 'business_default', emergencyStop: { active: false } })),
}));
jest.mock('src/modules/notification/merchant-notification.service', () => ({ notifyShop: mockNotifyShop }));
jest.mock('src/modules/notification/notification-events', () => ({ NOTIFICATION_EVENTS: { AI_HITL: 'ai_hitl' } }));

const { escalateToHuman } = require('src/modules/conversation/human-handoff.service');
const { loadEffectiveChannelAutomation } = require('src/modules/channel-providers/channel-automation.resolver');

const args = (over = {}) => ({
    conversation: { id: 'c1', hitl: false, update: jest.fn().mockResolvedValue(undefined) },
    shopId: 's1', conversationId: 'c1', platform: 'messenger',
    recipientId: 'psid-1', channel: { id: 'ch1' }, reason: 'low_confidence', ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockGetProviderSend.mockResolvedValue({ providerMessageId: 'pm-1' });
});

describe('W4 — holding send honors the manual-takeover fence', () => {
    test('control: no pause, AUTO → the holding message is delivered', async () => {
        await escalateToHuman(args());
        expect(mockGetProviderSend).toHaveBeenCalledTimes(1);
    });

    test('ai:pause set (merchant took over mid-turn) → AI-voiced hold is suppressed, HITL preserved', async () => {
        mockRedisGet.mockImplementation(async (key) => (key === 'ai:pause:c1' ? '1' : null));

        await escalateToHuman(args());

        expect(mockGetProviderSend).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            delivery_state: 'HELD',
            metadata: expect.objectContaining({ held_reason: 'ai_paused', delivery_state: 'HELD' }),
        }), expect.objectContaining({ where: expect.objectContaining({ id: 'm1', conversation_id: 'c1' }) }));
    });

    test('Redis read failure is bounded + fail-open: the send is not blocked by an unreachable client', async () => {
        mockRedisGet.mockRejectedValue(new Error('redis down'));
        await expect(escalateToHuman(args())).resolves.not.toThrow();
        expect(mockGetProviderSend).toHaveBeenCalledTimes(1);
    });

    test('emergency stop still suppresses the holding send even without ai:pause', async () => {
        loadEffectiveChannelAutomation.mockResolvedValueOnce({ mode: 'MANUAL', modeSource: 'emergency_stop', emergencyStop: { active: true } });
        await escalateToHuman(args());
        expect(mockGetProviderSend).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ held_reason: 'emergency_stop' }),
        }), expect.any(Object));
    });
});
