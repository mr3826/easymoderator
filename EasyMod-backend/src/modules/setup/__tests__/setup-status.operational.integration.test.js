'use strict';

/**
 * P04 — setup-status operational truth against the REAL PostgreSQL.
 *
 * The unit lane pins the ladder with mocked reads; this file pins it against
 * the actual evidence tables (meta_channels, conversations, messages,
 * inbox_delivery_outbox) so no mock can make "configured" look like
 * "verified_operational". The seven required P04 scenarios each get one test,
 * plus cross-shop isolation and the fail-closed recency window.
 */

const crypto = require('crypto');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    User, UserShop, Shop, MetaChannel, Conversation, Message, InboxDeliveryOutbox,
} = require('../../entities');
const setupStatusService = require('../setup-status.service');
const { IDS, syncSchema, truncateAll, seed } = require('../../../../tests/meta-e2e/fixtures');

const { OPERATIONAL_STATES } = setupStatusService;

const uuid = () => crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;

// Shop A settings that finish every CONFIGURATION task on top of the fixture
// seed (channels + products + one active FAQ already exist there). The reply
// mode is pinned to DRAFT so no AUTO warning noise rides along.
const CONFIGURED_SETTINGS = {
    ai: { automation_mode: 'DRAFT', confidence_threshold: 75, payment_methods: ['COD'] },
    businessInfo: {
        phone: '01700000000',
        deliveryAreas: ['Dhaka'],
        paymentMethods: ['COD'],
    },
};

let owner;

async function freshSetupStatus() {
    return setupStatusService.getSetupStatus({ shopId: IDS.shopA, userId: owner.id });
}

async function resetOperationalEvidence() {
    await InboxDeliveryOutbox.destroy({ where: {}, truncate: true, cascade: true });
    await Message.destroy({ where: {}, truncate: true, cascade: true });
    await Conversation.destroy({ where: {}, truncate: true, cascade: true });
    await MetaChannel.update(
        { webhook_last_verified_at: null },
        { where: { shop_id: [IDS.shopA, IDS.shopB] } },
    );
}

async function seedConversation(shopId, metaChannelId = null) {
    return Conversation.create({
        shop_id: shopId,
        channel: 'messenger',
        meta_channel_id: metaChannelId,
        role: 'assistant',
        message: 'em p04 setup evidence conversation',
        status: 'active',
    });
}

/**
 * Writes evidence the way the production lifecycle writes it: first-class
 * delivery_state / delivery_source / provider_message_id columns (the same
 * contract message-lifecycle.js and the approval flow maintain).
 */
async function seedAiMessage(conversation, {
    deliveryState, deliverySource = null, providerMessageId = null, createdAt, content = 'EM P04 test reply',
}) {
    return Message.create({
        conversation_id: conversation.id,
        content,
        sender: 'ai',
        delivery_state: deliveryState,
        delivery_source: deliverySource,
        provider_message_id: providerMessageId,
        ...(createdAt ? { created_at: createdAt } : {}),
        metadata: {
            delivery_state: deliveryState,
            ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
        },
    });
}

async function stampWebhookVerified(channelId = IDS.channelA, at = new Date()) {
    await MetaChannel.update({ webhook_last_verified_at: at }, { where: { id: channelId } });
}

beforeAll(async () => {
    await syncSchema();
    await truncateAll();
    await seed();

    owner = await User.create({
        email: `p04-owner-${uuid().slice(0, 8)}@example.test`,
        password: 'unused-test-hash',
        full_name: 'P04 setup owner',
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: owner.id, shop_id: IDS.shopA, role: 'owner', is_active: true });

    await (await Shop.findByPk(IDS.shopA)).update({ settings: CONFIGURED_SETTINGS });
}, 180000);

beforeEach(async () => {
    await resetOperationalEvidence();
});

afterAll(async () => {
    await truncateAll().catch(() => {});
    await sequelize.close();
});

describe('setup-status operational truth (P04, real Postgres)', () => {
    it('(a) configuration complete with zero messages is configured, never verified_operational', async () => {
        const status = await freshSetupStatus();

        expect(status.isComplete).toBe(true); // configuration semantics unchanged
        expect(status.operational.state).toBe(OPERATIONAL_STATES.CONFIGURED);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.counts.activeFaqs).toBe(1); // the seeded active FAQ
        expect(status.counts.aiMessagesSent).toBe(0);

        const legacy = setupStatusService.toLegacyOnboardingStatus(status);
        // The legacy contract must not fabricate an assistant test from settings.
        expect(legacy.checks.assistant_test_completed).toBe(false);
        expect(legacy.checks.knowledge_added).toBe(true);
        expect(legacy.counts.ai_messages).toBe(0);
        expect(legacy.counts.active_faqs).toBe(1);
        expect(legacy.operational_verified).toBe(false);
    });

    it('(b) a connected, webhook-verified channel with no accepted reply is waiting_for_test', async () => {
        await stampWebhookVerified();

        const status = await freshSetupStatus();

        expect(status.isComplete).toBe(true);
        expect(status.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.evidence.webhook.verifiedWithinWindow).toBe(1);

        // Same channel, stale verification and no evidence → configured with a
        // stale warning, never a silent success.
        await stampWebhookVerified(IDS.channelA, new Date(Date.now() - 60 * DAY));
        const stale = await freshSetupStatus();
        expect(stale.operational.state).toBe(OPERATIONAL_STATES.CONFIGURED);
        expect(stale.operational.operationalVerified).toBe(false);
        expect(stale.operational.warnings)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'WEBHOOK_VERIFICATION_STALE' })]));
    });

    it('(c) a generated draft that was never approved keeps the shop at waiting_for_test', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        await seedAiMessage(conversation, { deliveryState: 'DRAFT_READY' });

        const status = await freshSetupStatus();

        expect(status.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.evidence.assistant).toMatchObject({
            draftsGenerated: 1,
            draftsApproved: 0,
            providerAcceptedEver: 0,
        });
        expect(setupStatusService.toLegacyOnboardingStatus(status).checks.assistant_test_completed).toBe(false);
    });

    it('(d) an approved reply whose delivery failed requires action, not green bullets', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        const failed = await seedAiMessage(conversation, {
            deliveryState: 'FAILED',
            deliverySource: 'DRAFT_APPROVAL',
        });
        await InboxDeliveryOutbox.create({
            shop_id: IDS.shopA,
            conversation_id: conversation.id,
            message_id: failed.id,
            delivery_source: 'DRAFT_APPROVAL',
            status: 'NEEDS_RECONCILIATION',
            attempt_count: 3,
            last_error_code: 'PROVIDER_SEND_FAILED',
        });

        const status = await freshSetupStatus();

        expect(status.isComplete).toBe(true);
        expect(status.operational.state).toBe(OPERATIONAL_STATES.ACTION_REQUIRED);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.warnings)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OPERATIONAL_TEST_FAILED' })]));
        expect(status.operational.evidence.assistant).toMatchObject({
            draftsApproved: 1,
            providerAcceptedEver: 0,
            approvedSendFailures: 1,
            outboxNeedsReconciliation: 1,
        });
    });

    it('(d2) an approved row stuck in the outbox also requires action even without a FAILED message state', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        const pending = await seedAiMessage(conversation, {
            deliveryState: 'SEND_PENDING',
            deliverySource: 'DRAFT_APPROVAL',
        });
        await InboxDeliveryOutbox.create({
            shop_id: IDS.shopA,
            conversation_id: conversation.id,
            message_id: pending.id,
            status: 'NEEDS_RECONCILIATION',
            attempt_count: 5,
        });

        const status = await freshSetupStatus();
        expect(status.operational.state).toBe(OPERATIONAL_STATES.ACTION_REQUIRED);
    });

    it('(e) an approved reply that Messenger accepted (SENT + provider_message_id) verifies operationally', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        await seedAiMessage(conversation, {
            deliveryState: 'SENT',
            deliverySource: 'DRAFT_APPROVAL',
            providerMessageId: `pmid-${uuid().slice(0, 8)}`,
        });

        const status = await freshSetupStatus();

        expect(status.operational.state).toBe(OPERATIONAL_STATES.VERIFIED_OPERATIONAL);
        expect(status.operational.operationalVerified).toBe(true);
        expect(status.operational.evidence.assistant.providerAcceptedWithinWindow).toBe(1);
        expect(status.operational.evidence.assistant.lastProviderAcceptedAt).toBeTruthy();

        const legacy = setupStatusService.toLegacyOnboardingStatus(status);
        expect(legacy.checks.assistant_test_completed).toBe(true);
        expect(legacy.counts.ai_messages).toBe(1);
        expect(legacy.operational_verified).toBe(true);
    });

    it('(e2) SENT without a provider_message_id never counts as provider acceptance', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        await seedAiMessage(conversation, {
            deliveryState: 'SENT',
            deliverySource: 'DRAFT_APPROVAL',
            providerMessageId: null, // normalizeDeliveryState() downgrades this to HELD
        });

        const status = await freshSetupStatus();

        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.evidence.assistant.providerAcceptedEver).toBe(0);
        expect(status.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
    });

    it('(e3) provider evidence older than the window fails closed back to waiting_for_test', async () => {
        await stampWebhookVerified(IDS.channelA); // fresh verification, but no fresh reply
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        await seedAiMessage(conversation, {
            deliveryState: 'SENT',
            deliverySource: 'DRAFT_APPROVAL',
            providerMessageId: `pmid-${uuid().slice(0, 8)}`,
            createdAt: new Date(Date.now() - 60 * DAY),
        });

        const status = await freshSetupStatus();

        expect(status.operational.evidence.assistant.providerAcceptedEver).toBe(1);
        expect(status.operational.evidence.assistant.providerAcceptedWithinWindow).toBe(0);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
    });

    it('(f) returning after a partial test re-reads live evidence and promotes on completion', async () => {
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        const inflight = await seedAiMessage(conversation, {
            deliveryState: 'SEND_PENDING',
            deliverySource: 'DRAFT_APPROVAL',
        });

        // No webhook verification stamped yet: partial evidence still reads as
        // waiting (the draft exists), and the shop is not verified.
        const first = await freshSetupStatus();
        expect(first.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
        expect(first.operational.operationalVerified).toBe(false);

        await stampWebhookVerified();
        await (await Message.findByPk(inflight.id)).update({
            delivery_state: 'SENT',
            provider_message_id: `pmid-${uuid().slice(0, 8)}`,
        });

        const second = await freshSetupStatus();
        expect(second.operational.state).toBe(OPERATIONAL_STATES.VERIFIED_OPERATIONAL);
        expect(second.operational.operationalVerified).toBe(true);
    });

    it('(g) refreshing during an incomplete setup recomputes both axes independently', async () => {
        await stampWebhookVerified();
        const conversation = await seedConversation(IDS.shopA, IDS.channelA);
        await seedAiMessage(conversation, {
            deliveryState: 'SENT',
            deliverySource: 'DRAFT_APPROVAL',
            providerMessageId: `pmid-${uuid().slice(0, 8)}`,
        });

        // Knock the shop back into "profile incomplete" (payment info gone).
        await (await Shop.findByPk(IDS.shopA)).update({
            settings: {
                ...CONFIGURED_SETTINGS,
                businessInfo: { phone: CONFIGURED_SETTINGS.businessInfo.phone },
            },
        });

        const incomplete = await freshSetupStatus();
        expect(incomplete.isComplete).toBe(false);
        // The fresh provider proof is real, so the ladder may still call it
        // verified — but the UI gate (isComplete) keeps the setup screen up,
        // and the legacy config gate stays closed.
        expect(setupStatusService.toLegacyOnboardingStatus(incomplete).can_complete).toBe(false);
        expect(incomplete.operational.evidence.assistant.providerAcceptedWithinWindow).toBe(1);

        // Merchant finishes configuration; a refresh recomputes everything.
        await (await Shop.findByPk(IDS.shopA)).update({ settings: CONFIGURED_SETTINGS });
        const refreshed = await freshSetupStatus();
        expect(refreshed.isComplete).toBe(true);
        expect(refreshed.operational.state).toBe(OPERATIONAL_STATES.VERIFIED_OPERATIONAL);
        expect(setupStatusService.toLegacyOnboardingStatus(refreshed).can_complete).toBe(true);
    });

    it('keeps evidence tenant-scoped: shop B traffic never verifies shop A', async () => {
        await stampWebhookVerified();
        const shopBConversation = await seedConversation(IDS.shopB, IDS.channelB);
        await seedAiMessage(shopBConversation, {
            deliveryState: 'SENT',
            deliverySource: 'DRAFT_APPROVAL',
            providerMessageId: `pmid-${uuid().slice(0, 8)}`,
        });

        const status = await freshSetupStatus();

        expect(status.operational.evidence.assistant.providerAcceptedEver).toBe(0);
        expect(status.operational.evidence.assistant.draftsGenerated).toBe(0);
        expect(status.operational.operationalVerified).toBe(false);
    });
});
