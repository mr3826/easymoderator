'use strict';

/**
 * ADR-0013 Verification Contract 4 — queue races against the real resolver.
 *
 * Real PostgreSQL + real Redis (the integration lane). The queue itself is
 * stubbed at the module boundary because these tests call `processMessageJob`
 * and the provider boundary directly; the delivery lock and the ai:pause fence
 * still go through the real Redis client.
 *
 * Covered:
 *   - a mode flip while a job is queued (Guard 4) and mid-flight (boundary);
 *   - an emergency stop flipped while a job is queued (Guard 4) and after the
 *     candidate exists (boundary);
 *   - the real-Redis ai:pause fence;
 *   - the provider-boundary CAS: concurrent claims produce exactly ONE send
 *     authorization (no duplicate replies).
 */

const { randomUUID } = require('crypto');

jest.mock('../message-queue', () => ({ connection: {} }));
// Guard 4's manual-equivalent branch notifies the merchant. The notification
// transport (BullMQ queue) is out of scope here; a real queue would reach the
// notification worker, which this suite does not run.
jest.mock('../../modules/notification/merchant-notification.service', () => ({
    notifyShop: jest.fn(async () => ({ queued: false, skipped: true })),
}));

const {
    IDS, CUSTOMER_PSID, syncSchema, truncateAll, seed,
} = require('../../../tests/meta-e2e/fixtures');
const {
    Conversation, Customer, Message, Shop,
} = require('../../modules/entities');
const MetaChannelSettings = require('../../modules/channel-providers/meta-channel-settings.entity');
const shopService = require('../../modules/shop/shop.service');
const { processMessageJob, _private } = require('../message-worker');
const { claimProviderSendBoundary } = _private;
const { sequelize } = require('../../utils/database/database-setup');
const redis = require('../../config/redis');

const CONVERSATION_ID = 'aaaaaaaa-4444-4444-8444-44444444444a';
const CUSTOMER_ID = 'aaaaaaaa-5555-4555-8555-55555555555a';

let sequence = 0;

async function setBusinessMode(mode) {
    const shop = await Shop.findByPk(IDS.shopA);
    const settings = shop.settings && typeof shop.settings === 'object' ? shop.settings : {};
    const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
    await shop.update({ settings: { ...settings, ai: { ...ai, automation_mode: mode } } });
}

async function clearEmergencyStop() {
    await Shop.update({
        ai_emergency_stop: false,
        ai_emergency_stop_at: null,
        ai_emergency_stop_by: null,
        ai_emergency_stop_source: null,
        ai_emergency_stop_prior_mode: null,
    }, { where: { id: IDS.shopA } });
}

async function runInbound(text) {
    sequence += 1;
    const externalId = `channel-race-${sequence}-${randomUUID()}`;
    const inbound = await Message.create({
        conversation_id: CONVERSATION_ID,
        content: text,
        sender: 'customer',
        external_id: externalId,
    });
    return processMessageJob({
        id: `channel-race-job-${sequence}`,
        attemptsMade: 0,
        data: {
            shopId: IDS.shopA,
            conversationId: CONVERSATION_ID,
            messageId: inbound.id,
            externalId,
            message: text,
            platform: 'facebook',
            recipientId: CUSTOMER_PSID,
            metaChannelId: IDS.channelA,
            senderInfo: { name: 'Race Customer' },
        },
    });
}

/**
 * A fully claimed automatic candidate the boundary may cross. The pre-claim is
 * what the worker does after Guard 4; the boundary re-checks mode/stop.
 */
async function createClaimedCandidate(idempotencyKey) {
    return Message.create({
        conversation_id: CONVERSATION_ID,
        content: 'Candidate reply held for the boundary.',
        sender: 'ai',
        external_id: null,
        delivery_state: 'SEND_PENDING',
        send_idempotency_key: idempotencyKey,
        metadata: {
            type: 'ai_response',
            delivered: false,
            delivery_status: 'pending',
            delivery_state: 'SEND_PENDING',
            provider_send_claimed: true,
            provider_send_claimed_at: new Date().toISOString(),
            provider_send_attempted: false,
        },
    });
}

beforeAll(async () => {
    await syncSchema();
    await truncateAll();
    await seed();
    await Customer.create({
        id: CUSTOMER_ID,
        shop_id: IDS.shopA,
        name: 'Race Customer',
        channel_type: 'messenger',
        channel_user_id: CUSTOMER_PSID,
        meta_channel_id: IDS.channelA,
        messaging_consent: { facebook: { opted_in: true } },
    });
    await Conversation.create({
        id: CONVERSATION_ID,
        shop_id: IDS.shopA,
        customer_id: CUSTOMER_ID,
        channel: 'messenger',
        meta_channel_id: IDS.channelA,
        role: 'user',
        message: 'race fixture',
        status: 'active',
        hitl: false,
    });
});

beforeEach(async () => {
    await setBusinessMode('AUTO');
    await clearEmergencyStop();
    await Message.destroy({ where: { conversation_id: CONVERSATION_ID } });
    // The provider boundary loads an existing settings row (no INSERT inside the
    // boundary transaction); Guard 4 would have created it on the first turn.
    await MetaChannelSettings.destroy({ where: { channel_id: IDS.channelA } });
    await MetaChannelSettings.create({ channel_id: IDS.channelA });
    await redis.cacheRedis.del(`ai:pause:${CONVERSATION_ID}`).catch(() => {});
    // The dedup namespace is real Redis; clear only this suite's conversation.
    const keys = await redis.cacheRedis.keys('msg:dedup:*').catch(() => []);
    if (keys.length > 0) await redis.cacheRedis.del(...keys).catch(() => {});
});

afterAll(async () => {
    // Leave the shared disposable database empty for the next integration file.
    await truncateAll().catch(() => {});
    if (typeof redis.closeAllRedis === 'function') await redis.closeAllRedis().catch(() => {});
    await sequelize.close();
});

describe('real-Redis queue races — Guard 4', () => {
    test('a mode flip while the job is queued skips before the LLM', async () => {
        const AIChatbotController = require('../../modules/conversation/ai-chatbot.controller');
        const llmSpy = jest.spyOn(AIChatbotController, 'processNewIntent')
            .mockResolvedValue({ response: 'must not be used' });

        await setBusinessMode('MANUAL');
        const result = await runInbound('is the panjabi available?');

        expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'manual_mode' }));
        expect(llmSpy).not.toHaveBeenCalled();
        llmSpy.mockRestore();
    });

    test('an emergency stop while the job is queued skips every channel override', async () => {
        // A channel AUTO override cannot bypass the business-wide stop.
        const [row] = await MetaChannelSettings.findOrCreate({ where: { channel_id: IDS.channelA } });
        await row.update({ overrides: { automation_mode: 'AUTO' } });
        await shopService.engageAiEmergencyStop(IDS.shopA, null, { source: 'merchant' });

        const result = await runInbound('is the panjabi available?');

        expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'emergency_stop' }));
        const ai = await Message.findOne({
            where: { conversation_id: CONVERSATION_ID, sender: 'ai' },
        });
        expect(ai).toBeNull();
    });
});

describe('provider boundary — mid-flight flips and CAS', () => {
    test('a mode flip after the candidate exists holds it at the boundary', async () => {
        const key = `race-mode-${randomUUID()}`;
        const candidate = await createClaimedCandidate(key);
        await setBusinessMode('DRAFT');

        const result = await claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA);

        expect(result).toEqual({ allowed: false, reason: 'mode_changed' });
        const stored = await Message.findByPk(candidate.id);
        expect(stored.metadata.provider_send_attempted).not.toBe(true);
    });

    test('an emergency stop after the candidate exists holds it at the boundary', async () => {
        const key = `race-stop-${randomUUID()}`;
        const candidate = await createClaimedCandidate(key);
        await shopService.engageAiEmergencyStop(IDS.shopA, null, { source: 'merchant' });

        const result = await claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA);

        expect(result).toEqual({ allowed: false, reason: 'emergency_stop' });
        const stored = await Message.findByPk(candidate.id);
        expect(stored.metadata.provider_send_attempted).not.toBe(true);
    });

    test('the real-Redis ai:pause fence holds an otherwise valid candidate', async () => {
        const key = `race-pause-${randomUUID()}`;
        const candidate = await createClaimedCandidate(key);
        await redis.cacheRedis.setex(`ai:pause:${CONVERSATION_ID}`, 60, '1');

        const result = await claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA);

        expect(result).toEqual({ allowed: false, reason: 'ai_paused' });
    });

    test('concurrent boundary claims authorize exactly one send (no duplicate replies)', async () => {
        const key = `race-dupe-${randomUUID()}`;
        const candidate = await createClaimedCandidate(key);

        const results = await Promise.all([
            claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA),
            claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA),
        ]);

        const allowed = results.filter((result) => result.allowed === true);
        const denied = results.filter((result) => result.allowed !== true);
        expect(allowed).toHaveLength(1);
        expect(denied).toHaveLength(1);
        expect(denied[0].reason).toBe('candidate_invalidated');

        const rows = await Message.findAll({
            where: { conversation_id: CONVERSATION_ID, sender: 'ai' },
        });
        const attempted = rows.filter((row) => row.metadata?.provider_send_attempted === true);
        expect(attempted).toHaveLength(1);
    });

    test('an AUTO boundary is allowed when the channel override repeats the ceiling', async () => {
        const key = `race-allow-${randomUUID()}`;
        const candidate = await createClaimedCandidate(key);
        const [row] = await MetaChannelSettings.findOrCreate({ where: { channel_id: IDS.channelA } });
        await row.update({ overrides: { automation_mode: 'AUTO' } });

        const result = await claimProviderSendBoundary(candidate, key, IDS.shopA, IDS.channelA);
        expect(result).toEqual({ allowed: true, reason: null });
    });
});