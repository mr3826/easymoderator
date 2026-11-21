'use strict';

const { Op } = require('sequelize');

jest.mock('../../entities', () => ({
    MetaChannel: { count: jest.fn(), findOne: jest.fn() },
    Product: { count: jest.fn() },
    FaqResponse: { count: jest.fn() },
    Message: { count: jest.fn(), findOne: jest.fn() },
    Conversation: {},
    InboxDeliveryOutbox: { count: jest.fn() },
}));

jest.mock('../../shop/shop.service', () => ({
    getShopById: jest.fn(),
    getShopAiSettings: jest.fn(),
}));

const {
    MetaChannel, Product, FaqResponse, Message, InboxDeliveryOutbox,
} = require('../../entities');
const shopService = require('../../shop/shop.service');
const setupStatusService = require('../setup-status.service');

const { OPERATIONAL_STATES } = setupStatusService;

/**
 * The service issues every read inside ONE Promise.all; these mock factories
 * therefore queue resolved values in the exact order the service lists its
 * queries. When a query is added to or reordered in
 * setup-status.service.js#getSetupStatus, this list must move with it — that
 * coupling is deliberate: the unit lane pins the read surface, and the
 * integration lane (setup-status.operational.integration.test.js) pins the
 * behaviour of the ladder against a real database.
 */
function mockEvidence({
    connectedFacebookPages = 0,
    webhookVerifiedFacebookPages = 0,
    webhookRecentlyVerifiedFacebookPages = 0,
    webhookLastVerifiedAt = null,
    activeProducts = 0,
    activeFaqs = 0,
    draftsGenerated = 0,
    draftsApproved = 0,
    aiMessagesAcceptedEver = 0,
    aiMessagesAcceptedRecently = 0,
    lastAcceptedReplyCreatedAt = null,
    failedApprovedSends = 0,
    outboxNeedsReconciliation = 0,
} = {}) {
    MetaChannel.count
        .mockResolvedValueOnce(connectedFacebookPages)
        .mockResolvedValueOnce(webhookVerifiedFacebookPages)
        .mockResolvedValueOnce(webhookRecentlyVerifiedFacebookPages);
    MetaChannel.findOne.mockResolvedValueOnce(
        webhookLastVerifiedAt ? { webhook_last_verified_at: webhookLastVerifiedAt } : null,
    );
    Product.count.mockResolvedValueOnce(activeProducts);
    FaqResponse.count.mockResolvedValueOnce(activeFaqs);
    Message.count
        .mockResolvedValueOnce(draftsGenerated)
        .mockResolvedValueOnce(draftsApproved)
        .mockResolvedValueOnce(aiMessagesAcceptedEver)
        .mockResolvedValueOnce(aiMessagesAcceptedRecently);
    Message.findOne.mockResolvedValueOnce(
        lastAcceptedReplyCreatedAt ? { created_at: lastAcceptedReplyCreatedAt } : null,
    );
    Message.count.mockResolvedValueOnce(failedApprovedSends);
    InboxDeliveryOutbox.count.mockResolvedValueOnce(outboxNeedsReconciliation);
}

function mockShop({ businessInfo = {} } = {}) {
    shopService.getShopById.mockResolvedValue({
        id: 'shop-1',
        shop_name: 'Starter Shop',
        settings: { businessInfo },
    });
}

const readyBusinessInfo = {
    phone: '01700000000',
    deliveryAreas: ['Dhaka'],
    paymentMethods: ['COD'],
};

describe('setup-status.service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        shopService.getShopAiSettings.mockResolvedValue({
            automation_mode: 'DRAFT',
            confidence_threshold: 75,
            payment_methods: ['COD'],
        });
    });

    it('returns a dashboard setup checklist from shop data without completion flags', async () => {
        mockShop();
        mockEvidence();

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.isComplete).toBe(false);
        expect(status.completedCount).toBe(1);
        expect(status.tasks).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'connect_channel', status: 'incomplete' }),
            expect.objectContaining({ key: 'shop_profile', status: 'incomplete', missing: ['support_contact', 'delivery_info'] }),
            expect.objectContaining({ key: 'first_product', status: 'incomplete' }),
            expect.objectContaining({ key: 'ai_settings', status: 'complete' }),
        ]));
        expect(status.totalCount).toBe(4);
        expect(status.tasks.map((task) => task.key)).not.toContain('starter_knowledge');
        expect(status.counts).toMatchObject({
            connectedFacebookPages: 0,
            activeProducts: 0,
            activeFaqs: 0,
            aiMessagesSent: 0,
        });
        // A brand-new shop is configuration-only: never operational, never
        // claiming a test is already underway.
        expect(status.operational.state).toBe(OPERATIONAL_STATES.CONFIGURED);
        expect(status.operational.operationalVerified).toBe(false);
    });

    it('normalizes legacy reply modes before evaluating setup warnings', async () => {
        shopService.getShopAiSettings.mockResolvedValue({
            automation_mode: 'AI_ACTIVE',
            confidence_threshold: 75,
            payment_methods: ['COD'],
        });
        mockShop();
        mockEvidence();

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.tasks.find((task) => task.key === 'ai_settings')).toMatchObject({
            status: 'complete',
            warnings: [expect.objectContaining({ code: 'AI_AUTO_ENABLED' })],
            meta: { automationMode: 'AUTO' },
        });
    });

    it('does not warn a new or explicitly manual shop to enable automation', async () => {
        shopService.getShopAiSettings.mockResolvedValue({
            automation_mode: 'MANUAL',
            confidence_threshold: 75,
            payment_methods: ['COD'],
        });
        mockShop();
        mockEvidence();

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.tasks.find((task) => task.key === 'ai_settings')).toMatchObject({
            status: 'complete',
            warnings: [],
            meta: { automationMode: 'MANUAL' },
        });
    });

    it('reports configuration complete while an unverified webhook keeps the shop unverified operationally', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 0,
            webhookRecentlyVerifiedFacebookPages: 0,
            activeProducts: 1,
        });

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        // isComplete means configuration only — that semantic is unchanged...
        expect(status.isComplete).toBe(true);
        expect(status.completedCount).toBe(4);
        expect(status.totalCount).toBe(4);
        // ...but configuration can no longer masquerade as operational proof.
        expect(status.operational.state).toBe(OPERATIONAL_STATES.CONFIGURED);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.warnings).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'WEBHOOK_NOT_VERIFIED' })]),
        );
        expect(status.tasks.find((task) => task.key === 'connect_channel')).toMatchObject({
            status: 'complete',
            warnings: [expect.objectContaining({ code: 'WEBHOOK_NOT_VERIFIED' })],
        });
        expect(status.tasks.find((task) => task.key === 'first_product')).toMatchObject({
            status: 'complete',
            warnings: [expect.objectContaining({ code: 'LOW_PRODUCT_COUNT' })],
        });
    });

    it('flags a webhook verification older than the evidence window as stale, never as verified', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 1,
            webhookRecentlyVerifiedFacebookPages: 0,
            webhookLastVerifiedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
            activeProducts: 3,
        });

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.evidence.webhook.lastVerifiedAt).toBeTruthy();
        expect(status.tasks.find((task) => task.key === 'connect_channel').warnings)
            .toEqual([expect.objectContaining({ code: 'WEBHOOK_VERIFICATION_STALE' })]);
        expect(status.operational.warnings)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'WEBHOOK_VERIFICATION_STALE' })]));
    });

    it('keeps a listening channel with no accepted reply at waiting_for_test, and promotes only real provider acceptance', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 1,
            webhookRecentlyVerifiedFacebookPages: 1,
            activeProducts: 3,
        });

        const waiting = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(waiting.isComplete).toBe(true);
        expect(waiting.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
        expect(waiting.operational.operationalVerified).toBe(false);

        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 1,
            webhookRecentlyVerifiedFacebookPages: 1,
            webhookLastVerifiedAt: new Date(),
            activeProducts: 3,
            draftsGenerated: 1,
            draftsApproved: 1,
            aiMessagesAcceptedEver: 1,
            aiMessagesAcceptedRecently: 1,
            lastProviderAcceptedAt: new Date(),
        });

        const verified = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(verified.operational.state).toBe(OPERATIONAL_STATES.VERIFIED_OPERATIONAL);
        expect(verified.operational.operationalVerified).toBe(true);
        expect(verified.operational.warnings).toEqual([]);
    });

    it('requires BOTH a recent webhook verification and a recent provider-accepted reply for verified_operational', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 1,
            webhookRecentlyVerifiedFacebookPages: 0,
            activeProducts: 3,
            draftsGenerated: 1,
            draftsApproved: 1,
            aiMessagesAcceptedEver: 2,
            aiMessagesAcceptedRecently: 0,
        });

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.state).toBe(OPERATIONAL_STATES.WAITING_FOR_TEST);
    });

    it('reports action_required when an approved reply failed to deliver or the outbox is stuck', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence({
            connectedFacebookPages: 1,
            webhookVerifiedFacebookPages: 1,
            webhookRecentlyVerifiedFacebookPages: 1,
            activeProducts: 3,
            draftsGenerated: 1,
            draftsApproved: 1,
            aiMessagesAcceptedEver: 1,
            aiMessagesAcceptedRecently: 1,
            failedApprovedSends: 1,
        });

        const status = await setupStatusService.getSetupStatus({
            shopId: 'shop-1',
            userId: 'user-1',
        });

        expect(status.operational.state).toBe(OPERATIONAL_STATES.ACTION_REQUIRED);
        expect(status.operational.operationalVerified).toBe(false);
        expect(status.operational.warnings)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OPERATIONAL_TEST_FAILED' })]));
    });

    it('only counts provider acceptance from APPROVED SENT/DELIVERED rows that carry a provider_message_id (A5-1)', async () => {
        mockShop({ businessInfo: readyBusinessInfo });
        mockEvidence();

        await setupStatusService.getSetupStatus({ shopId: 'shop-1', userId: 'user-1' });

        const providerQueries = Message.count.mock.calls
            .map((call) => call[0])
            .filter((options) => options?.where?.provider_message_id !== undefined);

        // Exactly the all-time and within-window acceptance counts filter on
        // provider_message_id, and every acceptance query requires a real id
        // AND delivery_source='DRAFT_APPROVAL' on the SAME row — an AUTO or
        // HITL_ESCALATION send never verifies operationally.
        expect(providerQueries).toHaveLength(2);
        for (const options of providerQueries) {
            expect(options.where.sender).toBe('ai');
            expect(options.where.delivery_source).toBe('DRAFT_APPROVAL');
            expect(options.where.delivery_state[Op.in]).toEqual(
                expect.arrayContaining(['SENT', 'DELIVERED']),
            );
            const idFilters = options.where.provider_message_id[Op.and];
            expect(idFilters).toEqual(expect.arrayContaining([
                { [Op.ne]: null },
                { [Op.ne]: '' },
            ]));
            // Tenant scoping rides the messages→conversations join.
            expect(options.include[0].where).toEqual({ shop_id: 'shop-1' });
        }
    });

    it('maps the legacy onboarding contract truthfully: FAQs, real approved+accepted replies, real message counts', () => {
        const base = {
            isComplete: true,
            counts: {
                connectedFacebookPages: 1,
                activeProducts: 1,
                activeFaqs: 3,
            },
            tasks: [
                { key: 'connect_channel', status: 'complete' },
                { key: 'shop_profile', status: 'complete' },
                { key: 'first_product', status: 'complete' },
                { key: 'ai_settings', status: 'complete' },
            ],
        };

        const approvedOnly = setupStatusService.toLegacyOnboardingStatus({
            ...base,
            operational: {
                state: OPERATIONAL_STATES.WAITING_FOR_TEST,
                operationalVerified: false,
                evidence: { assistant: { draftsApproved: 1, providerAcceptedEver: 0 } },
            },
        });
        // An approved draft that Messenger never accepted is NOT a completed
        // assistant test, even though the product count and FAQ count are up.
        expect(approvedOnly.checks.knowledge_added).toBe(true);
        expect(approvedOnly.checks.assistant_test_completed).toBe(false);
        expect(approvedOnly.counts.ai_messages).toBe(0);
        expect(approvedOnly.counts.active_faqs).toBe(3);
        expect(approvedOnly.operational_verified).toBe(false);

        const completed = setupStatusService.toLegacyOnboardingStatus({
            ...base,
            counts: { ...base.counts, activeFaqs: 0 },
            operational: {
                state: OPERATIONAL_STATES.VERIFIED_OPERATIONAL,
                operationalVerified: true,
                evidence: { assistant: { draftsApproved: 2, providerAcceptedEver: 2 } },
            },
        });
        // knowledge_added comes from active FAQs — products alone no longer
        // claim knowledge.
        expect(completed.checks.knowledge_added).toBe(false);
        expect(completed.checks.assistant_test_completed).toBe(true);
        expect(completed.counts.ai_messages).toBe(2);
        expect(completed.counts.active_faqs).toBe(0);
        expect(completed.operational_verified).toBe(true);
        expect(completed.completed).toBe(true);
        expect(completed.can_complete).toBe(true);
        expect(completed.missing).toEqual([]);
    });

    it('keeps assistant_test_completed consistent with an action_required ladder (A5-2 contradiction pin)', () => {
        // Shape after A5-1 for "an approved send FAILED while an unrelated
        // AUTO send got accepted": the approved+accepted SAME-ROW count is 0,
        // so the legacy check must be false while the ladder is action_required
        // — the old two-independent-counts version could call this completed.
        const contradicted = setupStatusService.toLegacyOnboardingStatus({
            isComplete: true,
            counts: { connectedFacebookPages: 1, activeProducts: 3, activeFaqs: 1 },
            tasks: [
                { key: 'connect_channel', status: 'complete' },
                { key: 'shop_profile', status: 'complete' },
                { key: 'first_product', status: 'complete' },
                { key: 'ai_settings', status: 'complete' },
            ],
            operational: {
                state: OPERATIONAL_STATES.ACTION_REQUIRED,
                operationalVerified: false,
                evidence: {
                    assistant: {
                        draftsApproved: 1,
                        providerAcceptedEver: 0,
                        providerAcceptedWithinWindow: 0,
                        approvedSendFailures: 1,
                    },
                },
            },
        });

        expect(contradicted.checks.assistant_test_completed).toBe(false);
        expect(contradicted.counts.ai_messages).toBe(0);
        expect(contradicted.operational_verified).toBe(false);
    });

    it('fails closed when an old-shape status carries no operational evidence at all', () => {
        const legacy = setupStatusService.toLegacyOnboardingStatus({
            isComplete: false,
            counts: {
                connectedFacebookPages: 1,
                activeProducts: 1,
            },
            tasks: [
                { key: 'connect_channel', status: 'complete' },
                { key: 'shop_profile', status: 'complete' },
                { key: 'first_product', status: 'complete' },
                { key: 'ai_settings', status: 'complete' },
            ],
        });

        expect(legacy.completed).toBe(false);
        expect(legacy.can_complete).toBe(false);
        expect(legacy.checks).toMatchObject({
            facebook_connected: true,
            business_info_added: true,
            // No products-inferred knowledge, no settings-inferred assistant test.
            knowledge_added: false,
            assistant_test_completed: false,
        });
        expect(legacy.counts.ai_messages).toBe(0);
        expect(legacy.counts.active_faqs).toBe(0);
        expect(legacy.operational_verified).toBe(false);
        expect(legacy.missing).toEqual([]);
    });
});
