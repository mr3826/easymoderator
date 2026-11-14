'use strict';

const { randomUUID } = require('crypto');

const mockHoldingKeys = new Set();
const mockSendMessage = jest.fn(async () => ({ providerMessageId: `holding-${randomUUID()}` }));
const mockHandoff = jest.fn(async () => ({ id: 'handoff-1' }));
const mockOpsAlert = jest.fn(async () => {});
const mockRedisSet = jest.fn(async (key) => {
    if (mockHoldingKeys.has(key)) return null;
    mockHoldingKeys.add(key);
    return 'OK';
});

jest.mock('../message-queue', () => ({ connection: {} }));
jest.mock('../../config/redis', () => ({
    cacheRedis: {
        set: mockRedisSet,
        get: jest.fn(async () => null),
        setex: jest.fn(async () => 'OK'),
        del: jest.fn(async () => 1),
    },
}));
jest.mock('../../modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn(() => ({ sendMessage: mockSendMessage })) }));
jest.mock('../../modules/conversation/human-handoff.service', () => ({ escalateToHuman: mockHandoff }));
jest.mock('../../modules/policy/policy.engine', () => ({
    evaluateOutbound: jest.fn(async () => ({ allow: true, decisionId: 'recovery-policy', transform: null })),
}));
jest.mock('../../utils/ops-alert', () => ({ opsAlert: mockOpsAlert }));
jest.mock('bullmq', () => ({ Worker: jest.fn(), Queue: jest.fn(), UnrecoverableError: class extends Error {} }));

const {
    IDS,
    syncSchema,
    truncateAll,
    seed,
} = require('../../../tests/meta-e2e/fixtures');
const {
    Conversation,
    ConversationTurn,
    Customer,
    Message,
    Shop,
} = require('../../modules/entities');
const { sequelize } = require('../../utils/database/database-setup');
const MetaChannelSettings = require('../../modules/channel-providers/meta-channel-settings.entity');
const recovery = require('../../modules/ai/recovery/turn-recovery.service');
const policyEngine = require('../../modules/policy/policy.engine');
const { _private: workerPrivate } = require('../message-worker');

jest.useFakeTimers();

const CONVERSATION_ID = 'aaaaaaaa-2222-4222-8222-22222222222b';
const CUSTOMER_ID = 'aaaaaaaa-3333-4333-8333-33333333333b';
const TURN_ID = 'recovery-integration-turn';

beforeAll(async () => {
    await syncSchema();
    await seed();
    // ADR-0013: the recovery holding path reads the resolver WITHOUT
    // createIfMissing (boundary semantics). In production Guard 4 has already
    // created the channel-settings row on the first turn; mirror that state so
    // the fixture exercises the send path, not the missing-row hold.
    await MetaChannelSettings.findOrCreate({
        where: { channel_id: IDS.channelA },
        defaults: { channel_id: IDS.channelA },
    });
    await Customer.create({
        id: CUSTOMER_ID,
        shop_id: IDS.shopA,
        name: 'Recovery Integration Customer',
        channel_type: 'messenger',
        channel_user_id: '7000000000000002',
        phone: '01711111112',
    });
    await Conversation.create({
        id: CONVERSATION_ID,
        shop_id: IDS.shopA,
        customer_id: CUSTOMER_ID,
        channel: 'messenger',
        role: 'user',
        message: 'recovery integration fixture',
        status: 'active',
        hitl: false,
    });
});

beforeEach(async () => {
    jest.clearAllMocks();
    mockHoldingKeys.clear();
    await ConversationTurn.destroy({ where: { conversation_id: CONVERSATION_ID } });
    await Message.destroy({ where: { conversation_id: CONVERSATION_ID } });
    await Conversation.update({ hitl: false }, { where: { id: CONVERSATION_ID } });
});

afterAll(async () => {
    await truncateAll();
    await sequelize.close();
    jest.useRealTimers();
});

test('replaying one turn preserves its start timestamp and sends one holding message by 8 seconds', async () => {
    const first = await recovery.startTurn({
        turnId: TURN_ID, traceId: 'trace-1', shopId: IDS.shopA, conversationId: CONVERSATION_ID,
    });
    const startedAt = first.turn.turn_started_at;
    await recovery.startTurn({
        turnId: TURN_ID, traceId: 'trace-retry', shopId: IDS.shopA, conversationId: CONVERSATION_ID,
    });

    const control = workerPrivate.createRecoveryControl({
        turnId: TURN_ID,
        shopId: IDS.shopA,
        conversationId: CONVERSATION_ID,
        platform: 'facebook',
        recipientId: '7000000000000002',
        channel: { id: IDS.channelA },
        language: 'en',
    });
    control.setPolicySettings({ automation_mode: 'AI_ACTIVE', ai_auto_reply: true });
    await jest.advanceTimersByTimeAsync(8000);
    await control.flush();
    await control.close();

    const stored = await ConversationTurn.findOne({ where: { turn_id: TURN_ID, conversation_id: CONVERSATION_ID } });
    expect(new Date(stored.turn_started_at).toISOString()).toBe(new Date(startedAt).toISOString());
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(await Message.count({ where: { conversation_id: CONVERSATION_ID } })).toBe(1);
});

test('recovery holding delivery rechecks business mode before provider delivery', async () => {
    const shop = await Shop.findByPk(IDS.shopA);
    const originalSettings = JSON.parse(JSON.stringify(shop.settings || {}));
    const control = workerPrivate.createRecoveryControl({
        turnId: 'mode-race-holding-turn',
        shopId: IDS.shopA,
        conversationId: CONVERSATION_ID,
        platform: 'facebook',
        recipientId: '7000000000000002',
        channel: { id: IDS.channelA },
        language: 'en',
    });

    policyEngine.evaluateOutbound.mockImplementationOnce(async () => {
        await shop.update({
            settings: {
                ...shop.settings,
                ai: {
                    ...(shop.settings?.ai || {}),
                    automation_mode: 'MANUAL',
                    auto_reply_enabled: false,
                },
            },
        });
        return { allow: true, decisionId: 'recovery-policy', transform: null };
    });
    control.setPolicySettings({ automation_mode: 'AI_ACTIVE', ai_auto_reply: true });

    try {
        await jest.advanceTimersByTimeAsync(8000);
        await control.flush();

        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(await Message.count({ where: { conversation_id: CONVERSATION_ID } })).toBe(0);
    } finally {
        await control.close();
        await shop.update({ settings: originalSettings });
    }
});

test('AI pipeline turns do not emit provider-delay holding messages before the send boundary', async () => {
    const control = workerPrivate.createRecoveryControl({
        turnId: 'ai-pipeline-turn',
        shopId: IDS.shopA,
        conversationId: CONVERSATION_ID,
        platform: 'facebook',
        recipientId: '7000000000000002',
        channel: { id: IDS.channelA },
        language: 'en',
        providerDelayRecovery: false,
    });
    control.setPolicySettings({ automation_mode: 'AI_ACTIVE', ai_auto_reply: true });

    await jest.advanceTimersByTimeAsync(8000);
    await control.flush();
    await control.close();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(await Message.count({ where: { conversation_id: CONVERSATION_ID } })).toBe(0);
});

test('HUMAN_REQUIRED and hitl are committed together and a missing conversation creates neither', async () => {
    await recovery.requireHuman({
        turnId: 'human-turn', traceId: 'trace-human', turnStartedAt: new Date().toISOString(), shopId: IDS.shopA, conversationId: CONVERSATION_ID,
        reason: 'ACTION_DENIED', conversation: { id: CONVERSATION_ID },
    });
    expect((await Conversation.findByPk(CONVERSATION_ID)).hitl).toBe(true);
    expect(await ConversationTurn.findOne({ where: { turn_id: 'human-turn', conversation_id: CONVERSATION_ID } })).toEqual(expect.objectContaining({
        state: 'HUMAN_REQUIRED',
    }));

    await expect(recovery.requireHuman({
        turnId: 'missing-human-turn', traceId: 'trace-missing', shopId: IDS.shopA,
        conversationId: 'aaaaaaaa-2222-4222-8222-22222222222c', reason: 'ACTION_DENIED',
    })).rejects.toThrow(/Conversation not found/);
    expect(await ConversationTurn.findOne({ where: { turn_id: 'missing-human-turn' } })).toBeNull();
});

test('recovery holding delivery does not send when the customer context is missing', async () => {
    const control = workerPrivate.createRecoveryControl({
        turnId: 'missing-customer-turn',
        shopId: IDS.shopA,
        conversationId: CONVERSATION_ID,
        platform: 'facebook',
        recipientId: 'psid-that-is-not-in-the-customer-table',
        channel: { id: IDS.channelA },
        language: 'en',
    });
    control.setPolicySettings({ automation_mode: 'AI_ACTIVE', ai_auto_reply: true });

    await jest.advanceTimersByTimeAsync(8000);
    await control.flush();
    await control.close();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(await Message.count({ where: { conversation_id: CONVERSATION_ID } })).toBe(0);
});

test('recovery holding delivery does not send with an empty settings context', async () => {
    const control = workerPrivate.createRecoveryControl({
        turnId: 'missing-settings-turn',
        shopId: IDS.shopA,
        conversationId: CONVERSATION_ID,
        platform: 'facebook',
        recipientId: '7000000000000002',
        channel: { id: IDS.channelA },
        language: 'en',
    });
    control.setPolicySettings({});

    await jest.advanceTimersByTimeAsync(8000);
    await control.flush();
    await control.close();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(await Message.count({ where: { conversation_id: CONVERSATION_ID } })).toBe(0);
});
