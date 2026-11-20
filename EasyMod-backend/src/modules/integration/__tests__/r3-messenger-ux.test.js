'use strict';

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'meta-app-test';
process.env.META_APP_SECRET = 'meta-app-secret-test';
process.env.META_GRAPH_API_VERSION = 'v21.0';

const express = require('express');
const request = require('supertest');
const { globalErrorHandler } = require('../../../utils/AppError');

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = '33333333-3333-4333-8333-333333333333';
const PROD_ID = '44444444-4444-4444-8444-444444444444';
const CHAN_ID = '55555555-5555-4555-8555-555555555555';
const CUST_ID = '66666666-6666-4666-8666-666666666666';

const mockState = {
    shopId: SHOP_ID,
    userId: USER_ID,
    convId: CONV_ID,
    features: {
        customerIntelligence: false,
        orderConfidenceMode: 'off',
        interactionChoices: false,
    },
    products: new Map(),
    conversations: new Map(),
    messages: new Map(),
    customers: new Map(),
    metaChannels: new Map(),
    policyDecision: { allow: true, reason: 'WITHIN_24H_WINDOW' },
    axiosGet: jest.fn(),
    axiosPost: jest.fn(),
    providerInstance: null,
};

jest.mock('axios', () => ({
    get: (...args) => mockState.axiosGet(...args),
    post: (...args) => mockState.axiosPost(...args),
    delete: jest.fn(),
}));

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        req.user = { userId: mockState.userId, shopId: mockState.shopId, role: 'owner' };
        next();
    },
    checkSubscriptionStatus: (_req, _res, next) => next(),
}));

jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: (_req, _res, next) => next(),
}));

jest.mock('../../../middleware/shop-permission.middleware', () => ({
    requireOwner: (_req, _res, next) => next(),
}));

jest.mock('../../audit/idempotency.middleware', () => ({
    idempotencyMiddleware: (_req, _res, next) => next(),
}));

jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: jest.fn(async () => ({ ...mockState.features })),
    isInteractionChoicesEnabled: jest.fn(async () => mockState.features.interactionChoices === true),
    isCustomerIntelligenceEnabled: jest.fn(async () => mockState.features.customerIntelligence === true),
}));

jest.mock('../../policy/policy.engine', () => ({
    evaluateOutbound: jest.fn(async () => ({ ...mockState.policyDecision })),
}));

jest.mock('../../policy/rules/rateLimit.rule', () => ({
    reserveSendSlot: jest.fn(async () => ({ allowed: true })),
    releaseSendSlot: jest.fn(async () => {}),
}));

jest.mock('../../shop/ai-reply-mode', () => ({
    AI_REPLY_MODES: { MANUAL: 'MANUAL', DRAFT: 'DRAFT', AUTO: 'AUTO' },
    getEffectiveAiReplyMode: jest.fn(async () => 'MANUAL'),
    normalizeAiReplyMode: jest.fn((m) => m || 'MANUAL'),
}));

jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../utils/ops-alert', () => ({ opsAlert: jest.fn(async () => {}) }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
}));

const mockCacheRedis = {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    setex: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
};
jest.mock('../../../config/redis', () => ({ cacheRedis: mockCacheRedis }));

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        getDialect: () => 'sqlite',
        query: jest.fn(async () => []),
        define: jest.fn(() => ({
            belongsTo: jest.fn(),
            hasMany: jest.fn(),
            hasOne: jest.fn(),
        })),
        transaction: jest.fn(async (fn) => fn(mockTransaction)),
    },
}));

jest.mock('../../audit/audit.service', () => ({ logAction: jest.fn(async () => {}) }));
jest.mock('../../customer-intelligence/customer-360.service', () => ({}));
jest.mock('../../customer-intelligence/opportunity.service', () => ({
    DISMISS_REASONS: ['NOT_INTERESTED', 'ALREADY_HANDLED', 'NOT_A_REAL_REQUEST', 'OTHER'],
}));
jest.mock('../../conversation/conversation-lock.service', () => ({
    acquireForDelivery: jest.fn(async () => ({ success: true, lockId: 'lock-1' })),
    releaseLock: jest.fn(async () => {}),
}));

const mockCustomerModel = {
    findOne: jest.fn(async ({ where }) => {
        for (const c of mockState.customers.values()) {
            if (where.id && c.id !== where.id) continue;
            if (where.shop_id && c.shop_id !== where.shop_id) continue;
            if (where.channel_type && c.channel_type !== where.channel_type) continue;
            if (where.channel_user_id && c.channel_user_id !== where.channel_user_id) continue;
            if (Object.prototype.hasOwnProperty.call(where, 'meta_channel_id')
                && c.meta_channel_id !== where.meta_channel_id) continue;
            return c;
        }
        return null;
    }),
    update: jest.fn(async () => [0]),
    create: jest.fn(async (row) => {
        const created = {
            id: `cust-${mockState.customers.size + 1}`,
            ...row,
            update: jest.fn(async (patch) => Object.assign(created, patch)),
        };
        mockState.customers.set(created.id, created);
        return created;
    }),
};

const mockConversationModel = {
    findOne: jest.fn(async ({ where }) => {
        for (const conv of mockState.conversations.values()) {
            if (where.id && conv.id !== where.id) continue;
            if (where.shop_id && conv.shop_id !== where.shop_id) continue;
            if (where.customer_id && conv.customer_id !== where.customer_id) continue;
            if (where.channel && conv.channel !== where.channel) continue;
            if (Object.prototype.hasOwnProperty.call(where, 'meta_channel_id')
                && conv.meta_channel_id !== where.meta_channel_id) continue;
            return conv;
        }
        return null;
    }),
    create: jest.fn(async (row) => {
        const created = {
            id: mockState.convId,
            ...row,
            update: jest.fn(async (patch) => Object.assign(created, patch)),
        };
        mockState.conversations.set(created.id, created);
        return created;
    }),
    update: jest.fn(async (patch, { where }) => {
        let count = 0;
        for (const conv of mockState.conversations.values()) {
            if (where.id && conv.id !== where.id) continue;
            if (where.shop_id && conv.shop_id !== where.shop_id) continue;
            Object.assign(conv, patch);
            count += 1;
        }
        return [count];
    }),
};

const mockMessageModel = {
    findOne: jest.fn(async ({ where }) => {
        if (where.id && mockState.messages.has(where.id)) {
            const msg = mockState.messages.get(where.id);
            if (!where.conversation_id || msg.conversation_id === where.conversation_id) {
                return msg;
            }
        }
        for (const msg of mockState.messages.values()) {
            if (where.external_id && msg.external_id !== where.external_id) continue;
            if (where.conversation_id && msg.conversation_id !== where.conversation_id) continue;
            if (where.send_idempotency_key && msg.send_idempotency_key !== where.send_idempotency_key) continue;
            return msg;
        }
        return null;
    }),
    create: jest.fn(async (row) => {
        const created = {
            id: `msg-${mockState.messages.size + 1}`,
            created_at: new Date().toISOString(),
            ...row,
            update: jest.fn(async (patch) => Object.assign(created, patch)),
            toJSON() { return { ...this }; },
        };
        mockState.messages.set(created.id, created);
        return created;
    }),
    update: jest.fn(async (patch, { where }) => {
        let count = 0;
        for (const msg of mockState.messages.values()) {
            if (where.id && msg.id !== where.id) continue;
            if (where.conversation_id && msg.conversation_id !== where.conversation_id) continue;
            Object.assign(msg, patch);
            count += 1;
        }
        return [count];
    }),
    count: jest.fn(async () => mockState.messages.size),
};

const mockProductModel = {
    findOne: jest.fn(async ({ where }) => {
        const p = mockState.products.get(where.id);
        if (!p) return null;
        if (where.shop_id && p.shop_id !== where.shop_id) return null;
        if (where.is_active !== undefined && p.is_active !== where.is_active) return null;
        return p;
    }),
};

jest.mock('../../entities', () => ({
    Conversation: mockConversationModel,
    Customer: mockCustomerModel,
    Message: mockMessageModel,
    Product: mockProductModel,
    AuditLog: { create: jest.fn(async () => ({})) },
    InboxDeliveryOutbox: { update: jest.fn(async () => [0]) },
    MetaChannel: { findByPk: jest.fn(async (id) => mockState.metaChannels.get(id) || null) },
}));

jest.mock('../../conversation/conversation.entity', () => ({
    Conversation: mockConversationModel,
    Message: mockMessageModel,
}));

jest.mock('../../channel-providers/meta-channel.entity', () => ({
    findByPk: jest.fn(async (id) => mockState.metaChannels.get(id) || null),
}));

jest.mock('../../channel-providers/meta-channel.service', () => ({
    findConnectedById: jest.fn(async (id, { shopId }) => {
        const ch = mockState.metaChannels.get(id);
        if (!ch || ch.shop_id !== shopId || ch.status !== 'CONNECTED') return null;
        return ch;
    }),
    findUniqueConnectedByShopAndPlatform: jest.fn(async (shopId, platform) => {
        for (const ch of mockState.metaChannels.values()) {
            if (ch.shop_id === shopId && ch.platform === platform && ch.status === 'CONNECTED') return ch;
        }
        return null;
    }),
    confirmWebhookActive: jest.fn(async () => {}),
    getSettings: jest.fn(async () => ({
        confidence_threshold_send: '0.80',
        confidence_threshold_suggest: '0.50',
        business_hours: null,
        allow_order_creation: true,
        purpose_label: null,
    })),
}));

jest.mock('../../channel-providers/provider.registry', () => ({
    getProvider: jest.fn((platform) => {
        if (platform === 'facebook' || platform === 'messenger') return mockState.providerInstance;
        throw new Error(`Unsupported platform ${platform}`);
    }),
}));

jest.mock('../../conversation/conversation.service', () => ({
    mapMessage: jest.fn((msg) => ({ ...msg })),
    createMessage: jest.fn(async (conversationId, shopId, messageData) => {
        const conv = mockState.conversations.get(conversationId);
        if (!conv || conv.shop_id !== shopId) {
            throw new Error('Conversation not found');
        }
        const created = await mockMessageModel.create({
            conversation_id: conversationId,
            content: messageData.content,
            sender: 'business',
            metadata: messageData.metadata || {},
            delivery_state: 'SEND_PENDING',
            provider_message_id: null,
            send_idempotency_key: messageData.send_idempotency_key || null,
        });
        return { ...created, idempotency_replay: false };
    }),
    holdPendingAiCandidates: jest.fn(async () => 0),
}));

jest.mock('../../consent/consent.service', () => ({
    isStopKeyword: jest.fn(() => false),
    recordInbound: jest.fn(async () => ({ id: 'consent-1', status: 'OPT_IN_IMPLICIT' })),
    recordOptOut: jest.fn(async () => ({ id: 'consent-1', status: 'OPT_OUT' })),
    recordOptIn: jest.fn(async () => ({ id: 'consent-1', status: 'OPT_IN_EXPLICIT' })),
}));

jest.mock('../../subscription/subscription.service', () => ({
    trackUsage: jest.fn(async () => ({ within_allowance: true })),
}));

jest.mock('../../customer/customer-profile.service', () => ({
    enrichCustomerNameFromMeta: jest.fn(async () => false),
    isPlaceholderName: jest.fn(() => false),
}));

const mockReceiptService = {
    markProcessing: jest.fn(async () => {}),
    bindReceiptTenant: jest.fn(async () => true),
    claimProcessing: jest.fn(async () => true),
    markProcessed: jest.fn(async () => {}),
    markQueued: jest.fn(async () => {}),
    markSkipped: jest.fn(async () => {}),
    rebindQueuedReceipts: jest.fn(async () => {}),
    markStoreFailure: jest.fn(async () => {}),
    markQueueFailure: jest.fn(async () => {}),
    markIdentityNotResolved: jest.fn(async () => {}),
};
jest.mock('../meta-webhook-receipt.service', () => mockReceiptService);

const mockQueueAdd = jest.fn(async () => ({ id: 'job-1' }));
jest.mock('../../../jobs/message-queue', () => ({
    messageQueue: { add: (...args) => mockQueueAdd(...args) },
}));
const mockScheduleBurstFlush = jest.fn(async () => ({ id: 'burst-job-1', data: { receiptIds: [] } }));
const mockCancelBurstFlush = jest.fn(async () => {});
jest.mock('../../../jobs/burst-coalescer', () => ({
    scheduleBurstFlush: (...args) => mockScheduleBurstFlush(...args),
    cancelBurstFlush: (...args) => mockCancelBurstFlush(...args),
}));

const MetaMessengerProvider = require('../../channel-providers/providers/MetaMessengerProvider');
mockState.providerInstance = new MetaMessengerProvider();

const ciRoutes = require('../../customer-intelligence/customer-intelligence.routes');
const convRoutes = require('../../conversation/conversation.routes');
const channelRoutes = require('../../channel-providers/meta-channel.routes');
const webhookHandler = require('../meta-webhook-events.handler');
const interactionsService = require('../../interactions/interactions.service');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/customer-intelligence', ciRoutes);
    app.use('/api/conversation', convRoutes);
    app.use('/api/channels/meta', channelRoutes);
    app.use(globalErrorHandler);
    return app;
}

describe('R3 Messenger UX — safety, grounding, policy, webhook & probe verification', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        mockState.axiosGet.mockReset();
        mockState.axiosPost.mockReset();
        mockState.features = {
            customerIntelligence: false,
            orderConfidenceMode: 'off',
            interactionChoices: false,
        };
        mockState.products.clear();
        mockState.conversations.clear();
        mockState.messages.clear();
        mockState.customers.clear();
        mockState.metaChannels.clear();
        mockState.policyDecision = { allow: true, reason: 'WITHIN_24H_WINDOW' };

        const channel = {
            id: CHAN_ID,
            shop_id: SHOP_ID,
            platform: 'facebook',
            meta_asset_id: 'page-123',
            page_access_token_ct: 'test-page-token',
            status: 'CONNECTED',
        };
        mockState.metaChannels.set(CHAN_ID, channel);

        const customer = {
            id: CUST_ID,
            shop_id: SHOP_ID,
            channel_type: 'messenger',
            channel_user_id: 'psid-customer-1',
            meta_channel_id: CHAN_ID,
            name: 'Nadia',
            metadata: {},
            update: jest.fn(async (patch) => Object.assign(customer, patch)),
        };
        mockState.customers.set(CUST_ID, customer);

        const conversation = {
            id: CONV_ID,
            shop_id: SHOP_ID,
            customer_id: CUST_ID,
            channel: 'messenger',
            meta_channel_id: CHAN_ID,
            status: 'active',
            hitl: false,
            metadata: {},
            customer,
            update: jest.fn(async (patch) => Object.assign(conversation, patch)),
        };
        mockState.conversations.set(CONV_ID, conversation);

        mockState.products.set(PROD_ID, {
            id: PROD_ID,
            shop_id: SHOP_ID,
            name: 'Jamdani Saree',
            price: 2500,
            is_active: true,
            track_quantity: true,
            quantity: 7,
            images: ['https://cdn.example.com/jamdani.jpg'],
        });

        app = buildApp();
    });

    it('1) preserves GET /customer-intelligence/status contract, exposes interaction_choices on channel settings, and rejects product-card + probe with 409 FEATURE_DISABLED when off', async () => {
        const statusOff = await request(app).get('/api/customer-intelligence/status');
        expect(statusOff.status).toBe(200);
        expect(statusOff.body.data).toEqual({
            customer_intelligence: false,
            order_confidence_mode: 'off',
        });

        const chSettingsOff = await request(app).get(`/api/channels/meta/${CHAN_ID}/settings`);
        expect(chSettingsOff.status).toBe(200);
        expect(chSettingsOff.body.data.interaction_choices).toBe(false);

        const cardRes = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: PROD_ID });
        expect(cardRes.status).toBe(409);
        expect(cardRes.body.error.code).toBe('FEATURE_DISABLED');
        expect(mockState.axiosPost).not.toHaveBeenCalled();

        const probeRes = await request(app)
            .post(`/api/channels/meta/${CHAN_ID}/probe-interaction-fields`)
            .send({});
        expect(probeRes.status).toBe(409);
        expect(probeRes.body.code || probeRes.body.error?.code).toBe('FEATURE_DISABLED');

        mockState.features.interactionChoices = true;
        const chSettingsOn = await request(app).get(`/api/channels/meta/${CHAN_ID}/settings`);
        expect(chSettingsOn.status).toBe(200);
        expect(chSettingsOn.body.data.interaction_choices).toBe(true);
    });

    it('2) sends DB-grounded product card generic template + quick replies and rejects cross-shop, OOS, and client price overrides', async () => {
        mockState.features.interactionChoices = true;

        const otherShopProd = '77777777-7777-4777-8777-777777777777';
        mockState.products.set(otherShopProd, {
            id: otherShopProd,
            shop_id: 'other-shop',
            name: 'Other Shop Item',
            price: 999,
            is_active: true,
            track_quantity: false,
        });
        const crossShopRes = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: otherShopProd });
        expect(crossShopRes.status).toBe(404);
        expect(crossShopRes.body.error.code).toBe('PRODUCT_NOT_FOUND');

        const overrideRes = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: PROD_ID, price: 1 });
        expect(overrideRes.status).toBe(400);
        expect(overrideRes.body.error.code).toBe('VALIDATION_ERROR');

        const oosProd = '88888888-8888-4888-8888-888888888888';
        mockState.products.set(oosProd, {
            id: oosProd,
            shop_id: SHOP_ID,
            name: 'Sold Out Item',
            price: 1200,
            is_active: true,
            track_quantity: true,
            quantity: 0,
        });
        const oosRes = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: oosProd });
        expect(oosRes.status).toBe(409);
        expect(oosRes.body.error.code).toBe('OUT_OF_STOCK');
        expect(mockState.axiosPost).not.toHaveBeenCalled();

        mockState.axiosPost.mockResolvedValueOnce({
            data: { recipient_id: 'psid-customer-1', message_id: 'mid.product-card-1' },
        });
        const okRes = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: PROD_ID, quick_replies: ['Order now', 'Check sizes'] });
        expect(okRes.status).toBe(201);
        expect(okRes.body.data.delivery_state).toBe('SENT');
        expect(okRes.body.data.provider_message_id).toBe('mid.product-card-1');

        expect(mockState.axiosPost).toHaveBeenCalledTimes(1);
        const [, wireBody] = mockState.axiosPost.mock.calls[0];
        expect(wireBody.recipient).toEqual({ id: 'psid-customer-1' });
        expect(wireBody.message.attachment.type).toBe('template');
        expect(wireBody.message.attachment.payload.template_type).toBe('generic');
        expect(wireBody.message.attachment.payload.elements[0]).toEqual({
            title: 'Jamdani Saree',
            subtitle: '৳2500 · In stock (7)',
            image_url: 'https://cdn.example.com/jamdani.jpg',
        });
        expect(wireBody.message.quick_replies).toHaveLength(2);
        expect(wireBody.message.quick_replies[0].title).toBe('Order now');
    });

    it('3) blocks product card send outside active 24h window without calling provider', async () => {
        mockState.features.interactionChoices = true;
        mockState.policyDecision = { allow: false, reason: 'outside_24h_window' };

        const res = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: PROD_ID });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('POLICY_BLOCKED');
        expect(mockState.axiosPost).not.toHaveBeenCalled();
        expect(res.body.data.delivery_state).not.toBe('SENT');
    });

    it('4) fails closed when Meta omits provider message ACK and never marks message SENT', async () => {
        mockState.features.interactionChoices = true;
        mockState.axiosPost.mockResolvedValueOnce({ data: { recipient_id: 'psid-customer-1' } });

        const res = await request(app)
            .post(`/api/conversation/${CONV_ID}/product-card`)
            .send({ product_id: PROD_ID });

        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe('DELIVERY_FAILED');
        expect(res.body.data.delivery_state).not.toBe('SENT');
        expect(res.body.data.provider_message_id).toBeNull();
    });

    it('5) rejects postbacks when flag=OFF and skips forged/non-allowlisted postbacks without mutations when flag=ON', async () => {
        const receipt = { id: 'rcpt-1', status: 'RECEIVED', received_at: new Date().toISOString() };
        const forgedEvent = {
            sender: { id: 'psid-customer-1' },
            recipient: { id: 'page-123' },
            timestamp: Date.now(),
            postback: { title: 'Confirm', payload: 'forged:confirm:order-99', mid: 'pb-1' },
        };

        const resOff = await webhookHandler.processMessagingEvent({
            messaging: forgedEvent,
            channel: mockState.metaChannels.get(CHAN_ID),
            receipt,
            pageId: 'page-123',
        });
        expect(resOff).toBe('skipped');
        expect(mockReceiptService.markSkipped).toHaveBeenCalledWith(receipt, 'INTERACTION_CHOICES_DISABLED');
        expect(mockMessageModel.create).not.toHaveBeenCalled();

        jest.clearAllMocks();
        mockState.features.interactionChoices = true;
        const resForged = await webhookHandler.processMessagingEvent({
            messaging: forgedEvent,
            channel: mockState.metaChannels.get(CHAN_ID),
            receipt,
            pageId: 'page-123',
        });
        expect(resForged).toBe('skipped');
        expect(mockReceiptService.markSkipped).toHaveBeenCalledWith(receipt, 'POSTBACK_NOT_ALLOWLISTED');
        expect(mockMessageModel.create).not.toHaveBeenCalled();
        expect(mockConversationModel.update).not.toHaveBeenCalled();

        jest.clearAllMocks();
        const validPayload = interactionsService.buildPayload('99999999-9999-4999-8999-999999999999', 'checkout.confirm');
        const validEvent = {
            sender: { id: 'psid-customer-1' },
            recipient: { id: 'page-123' },
            timestamp: Date.now(),
            postback: { title: 'Confirm', payload: validPayload, mid: 'pb-valid-1' },
        };
        const resValid = await webhookHandler.processMessagingEvent({
            messaging: validEvent,
            channel: mockState.metaChannels.get(CHAN_ID),
            receipt,
            pageId: 'page-123',
        });
        expect(resValid).toBe('processed');
        expect(mockMessageModel.create).toHaveBeenCalledTimes(1);
    });

    it('6) persists sanitized m.me referral_source on Page-pinned conversation and rejects PII/URL/phone refs', async () => {
        mockState.features.interactionChoices = true;
        const receipt = { id: 'rcpt-ref-1', status: 'RECEIVED', received_at: new Date().toISOString() };

        for (const unsafeRef of ['user@test.com', '01712345678', 'https://evil.com/phish', '+8801712345678']) {
            jest.clearAllMocks();
            const outcome = await webhookHandler.processMessagingEvent({
                messaging: {
                    sender: { id: 'psid-customer-1' },
                    recipient: { id: 'page-123' },
                    timestamp: Date.now(),
                    referral: { ref: unsafeRef, source: 'SHORTLINK', type: 'OPEN_THREAD' },
                },
                channel: mockState.metaChannels.get(CHAN_ID),
                receipt,
                pageId: 'page-123',
            });
            expect(outcome).toBe('skipped');
            expect(mockReceiptService.markSkipped).toHaveBeenCalledWith(receipt, 'REFERRAL_REF_INVALID');
            expect(mockState.conversations.get(CONV_ID).metadata.referral_source).toBeUndefined();
        }

        jest.clearAllMocks();
        const okOutcome = await webhookHandler.processMessagingEvent({
            messaging: {
                sender: { id: 'psid-customer-1' },
                recipient: { id: 'page-123' },
                timestamp: Date.now(),
                referral: { ref: 'eid_campaign-2026.a', source: 'SHORTLINK', type: 'OPEN_THREAD' },
            },
            channel: mockState.metaChannels.get(CHAN_ID),
            receipt,
            pageId: 'page-123',
        });
        expect(okOutcome).toBe('processed');
        expect(mockState.conversations.get(CONV_ID).metadata.referral_source).toBe('eid_campaign-2026.a');
        expect(mockState.conversations.get(CONV_ID).metadata.referral_source_type).toBe('m_me');
        expect(mockReceiptService.markProcessed).toHaveBeenCalled();
    });

    it('7) keeps default webhookFields strictly [messages] and returns EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS on Graph denial', async () => {
        expect(mockState.providerInstance.webhookFields()).toEqual(['messages']);

        mockState.features.interactionChoices = true;
        mockState.axiosGet.mockResolvedValue({ data: { data: [{ subscribed_fields: ['messages'] }] } });
        mockState.axiosPost.mockRejectedValueOnce({
            response: {
                status: 403,
                data: { error: { code: 200, error_subcode: 1545041, message: 'Permissions error' } },
            },
        });

        const res = await request(app)
            .post(`/api/channels/meta/${CHAN_ID}/probe-interaction-fields`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data.ok).toBe(false);
        expect(res.body.data.code).toBe('EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS');
        expect(res.body.data.coreMessagesIntact).toBe(true);
        expect(res.body.data.blockedFields).toEqual(['messaging_postbacks', 'messaging_referrals']);
        expect(res.body.data.metaCode).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('test-page-token');
    });
});
