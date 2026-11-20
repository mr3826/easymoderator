'use strict';

/**
 * WP-01 — durable receipt/replay for postback and referral events.
 *
 * PR #278 added guarded postback / m.me referral ingestion, but the durability
 * layer still classified both as `unknown` and retained encrypted replay bodies
 * only for message/optin/echo. A transient database, queue, or channel-resolution
 * failure therefore lost the customer selection permanently after the webhook
 * was acknowledged (channel failures skipped the event; processing failures left
 * a payload-less receipt the reconciler dead-lettered as PAYLOAD_MISSING).
 *
 * Every test below is a property of "an eligible postback/referral survives a
 * transient failure and is replayed exactly once through the existing path".
 * Harness mirrors meta-webhook-durability.test.js: in-memory receipt table,
 * real receipt service + reconciler + signed webhook route, mocked everything
 * else. No production system is touched.
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_SECRET = 'pb-ref-test-app-secret';
process.env.CHANNEL_ENCRYPTION_KEY = 'a'.repeat(64);

// ── Mocks (before any require) ────────────────────────────────────────────────

jest.mock('src/config/redis', () => ({
    sessionRedis: null, cacheRedis: null, rateLimitRedis: null,
    closeAllRedis: jest.fn(), checkRedisAvailability: jest.fn(() => ({})),
}));
jest.mock('rate-limit-redis', () => ({ RedisStore: jest.fn() }));

const logCalls = [];
jest.mock('src/utils/structured-logger', () => ({
    createLogger: jest.fn(() => new Proxy({}, {
        get: () => (...args) => { logCalls.push(args); },
    })),
}));

const alertCalls = [];
jest.mock('src/utils/ops-alert', () => ({
    opsAlert: jest.fn(async (title, opts) => { alertCalls.push({ title, ...opts }); }),
    sendSlack: jest.fn(),
}));

jest.mock('src/config/config', () => ({
    metaAppSecret: 'pb-ref-test-app-secret',
    metaWebhookAppSecret: 'pb-ref-test-app-secret',
    metaWebhookVerifyToken: 'verify-token',
    jwtAccessSecret: 'x'.repeat(32),
}));

const mockMetaChannelService = { findByMetaAssetId: jest.fn() };
jest.mock('src/modules/channel-providers/meta-channel.service', () => mockMetaChannelService);
jest.mock('src/modules/channel-providers/meta-channel.entity', () => ({ findOne: jest.fn() }));
const mockChannelResolver = {
    resolveConnectedChannel: jest.fn(),
    resolveConnectedChannelForReceipt: jest.fn(),
};
jest.mock('src/modules/integration/meta-channel-resolver', () => mockChannelResolver);

const mockCustomer = { findOrCreate: jest.fn() };
const mockConversation = { findOne: jest.fn(), create: jest.fn() };
const mockMessage = { findOne: jest.fn(), create: jest.fn() };
jest.mock('src/modules/entities', () => ({
    Customer: mockCustomer,
    Conversation: mockConversation,
    Message: mockMessage,
    AuditLog: { create: jest.fn() },
    InboxDeliveryOutbox: { update: jest.fn(async () => [0]) },
}));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: mockConversation, Message: mockMessage,
}));

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: {
        define: jest.fn(() => ({})),
        transaction: jest.fn(async (fn) => fn(mockTransaction)),
        authenticate: jest.fn(),
    },
}));

const mockConsentService = {
    isStopKeyword: jest.fn(() => false),
    recordInbound: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    recordOptOut: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    recordOptIn: jest.fn().mockResolvedValue({ id: 'cust-1' }),
};
jest.mock('src/modules/consent/consent.service', () => mockConsentService);
jest.mock('src/modules/customer/customer-profile.service', () => ({
    enrichCustomerNameFromMeta: jest.fn().mockResolvedValue(true),
    isPlaceholderName: jest.fn(() => false),
}));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
const mockMessageQueue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
};
jest.mock('src/jobs/message-queue', () => ({ messageQueue: mockMessageQueue }));
const mockScheduleBurstFlush = jest.fn();
jest.mock('src/jobs/burst-coalescer', () => ({
    scheduleBurstFlush: (...args) => mockScheduleBurstFlush(...args),
    cancelBurstFlush: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('src/modules/subscription/subscription.service', () => ({
    trackUsage: jest.fn().mockResolvedValue({ within_allowance: true }),
}));

// The R3 guard flag stays a mock switch here; production keeps it disabled.
let mockInteractionChoicesEnabled = true;
jest.mock('src/modules/pilot-features/pilot-features.service', () => ({
    isInteractionChoicesEnabled: jest.fn(async () => mockInteractionChoicesEnabled),
}));

// Keep the REAL strict payload allowlist (interaction/contract v1) without
// pulling the interaction entity/sequelize surface into this unit harness.
jest.mock('src/modules/interactions/interactions.service', () => {
    const contract = jest.requireActual('src/modules/interactions/interaction.contract');
    return { parsePayload: contract.parsePayload, buildPayload: contract.buildPayload };
});

// ── In-memory MetaWebhookReceipt standing in for the Postgres table ───────────

class UniqueConstraintError extends Error {
    constructor() { super('duplicate key'); this.name = 'SequelizeUniqueConstraintError'; }
}

const store = new Map();
let failCreate = null;
let idCounter = 0;

const matches = (row, where) => Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const [[opSym, value]] = Object.getOwnPropertySymbols(cond).length
            ? [[Object.getOwnPropertySymbols(cond)[0], cond[Object.getOwnPropertySymbols(cond)[0]]]]
            : Object.entries(cond);
        const opName = String(opSym);
        if (opName.includes('in')) return value.includes(row[field]);
        if (opName.includes('lte')) return row[field] != null && row[field] <= value;
        if (opName.includes('lt')) return row[field] != null && row[field] < value;
        return false;
    }
    return row[field] === cond;
});

const evalWhere = (row, where = {}) => {
    const orSym = Object.getOwnPropertySymbols(where).find((s) => String(s).includes('or'));
    if (orSym) return where[orSym].some((clause) => evalWhere(row, clause));
    return matches(row, where);
};

const makeRow = (fields) => {
    const row = {
        id: `receipt-${++idCounter}`,
        status: 'RECEIVED',
        retry_count: 0,
        processing_token: null,
        queue_job_id: null,
        next_retry_at: null,
        received_at: new Date(),
        updated_at: new Date(),
        created_at: new Date(),
        ...fields,
    };
    row.update = jest.fn(async (patch) => { Object.assign(row, patch, { updated_at: new Date() }); return row; });
    row.set = jest.fn((patch) => { Object.assign(row, patch); return row; });
    return row;
};

const MockReceipt = {
    findOne: jest.fn(async ({ where }) => [...store.values()].find((r) => evalWhere(r, where)) || null),
    findAll: jest.fn(async ({ where, limit, order }) => {
        const rows = [...store.values()].filter((r) => evalWhere(r, where));
        const orderExpression = order?.[0]?.[0]?.val || order?.[0]?.[0] || '';
        if (String(orderExpression).includes('COALESCE')) {
            rows.sort((left, right) => (
                (left.next_retry_at || left.updated_at).getTime()
                - (right.next_retry_at || right.updated_at).getTime()
            ));
        }
        return rows.slice(0, limit);
    }),
    count: jest.fn(async ({ where }) => [...store.values()].filter((r) => evalWhere(r, where)).length),
    destroy: jest.fn(async () => 0),
    create: jest.fn(async (fields) => {
        if (failCreate) throw failCreate;
        if ([...store.values()].some((r) => r.page_id === fields.page_id && r.dedupe_key === fields.dedupe_key)) {
            throw new UniqueConstraintError();
        }
        const row = makeRow(fields);
        store.set(row.id, row);
        return row;
    }),
    update: jest.fn(async (patch, { where }) => {
        const rows = [...store.values()].filter((r) => evalWhere(r, where));
        rows.forEach((r) => Object.assign(r, patch, { updated_at: new Date() }));
        return [rows.length];
    }),
};
jest.mock('src/modules/integration/meta-webhook-receipt.entity', () => MockReceipt);

// ── Requires (after mocks) ────────────────────────────────────────────────────

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const receiptService = require('src/modules/integration/meta-webhook-receipt.service');
const WebhookReceiptReconcilerJob = require('src/jobs/webhook-receipt-reconciler.job');
const { buildPayload: buildInteractionPayload } = require('src/modules/interactions/interactions.service');

const APP_SECRET = 'pb-ref-test-app-secret';
const PAGE_ID = 'page-pb-ref-1';
const PAGE_ID_B = 'page-pb-ref-2';
const SHOP_ID = 'shop-pb-ref-1';
const SHOP_ID_B = 'shop-pb-ref-2';
const CHANNEL_ID = 'mc-pb-ref-1';
const CHANNEL_ID_B = 'mc-pb-ref-2';
const SENDER_PSID = 'psid-fake-1122334455';
const POSTBACK_TITLE = 'Confirm order';
const REFERRAL_REF = 'eid_campaign-2026.a';
const INTERACTION_UUID = '99999999-9999-4999-8999-999999999999';
const VALID_PAYLOAD = buildInteractionPayload(INTERACTION_UUID, 'checkout.confirm');

let app;
beforeAll(() => {
    const webhookRouter = require('src/modules/integration/meta-webhook.routes');
    app = express();
    app.use('/webhooks/meta', webhookRouter);
});

const postbackMessaging = (overrides = {}) => ({
    sender: { id: SENDER_PSID },
    recipient: { id: PAGE_ID },
    timestamp: 1_800_000_000_000,
    postback: {
        title: POSTBACK_TITLE,
        payload: VALID_PAYLOAD,
        mid: 'mid.BUTTONMESSAGE.1',
        ...overrides,
    },
});

const referralMessaging = (overrides = {}) => ({
    sender: { id: SENDER_PSID },
    recipient: { id: PAGE_ID },
    timestamp: 1_800_000_000_000,
    referral: { ref: REFERRAL_REF, source: 'SHORTLINK', type: 'OPEN_THREAD' },
    ...overrides,
});

const buildPayload = (messaging, pageId = PAGE_ID) => ({
    object: 'page',
    entry: [{ id: pageId, messaging: [messaging] }],
});

const post = (payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
    return request(app)
        .post('/webhooks/meta')
        .set('Content-Type', 'application/octet-stream')
        .set('x-hub-signature-256', sig)
        .send(body);
};

const connectedChannel = (pageId = PAGE_ID) => (pageId === PAGE_ID_B
    ? {
        id: CHANNEL_ID_B,
        shop_id: SHOP_ID_B,
        platform: 'facebook',
        meta_asset_id: PAGE_ID_B,
        status: 'CONNECTED',
    }
    : {
        id: CHANNEL_ID,
        shop_id: SHOP_ID,
        platform: 'facebook',
        meta_asset_id: PAGE_ID,
        status: 'CONNECTED',
    });

const receipts = () => [...store.values()];
const dueNow = (receipt) => { receipt.next_retry_at = new Date(Date.now() - 1000); };

beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    logCalls.length = 0;
    alertCalls.length = 0;
    failCreate = null;
    idCounter = 0;
    mockInteractionChoicesEnabled = true;
    process.env.CHANNEL_ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.CHANNEL_ENCRYPTION_KEY_PREVIOUS;

    mockMessageQueue.getJob.mockResolvedValue(null);
    mockScheduleBurstFlush.mockResolvedValue({ id: 'queue-job-1', data: {} });

    mockMetaChannelService.findByMetaAssetId.mockImplementation(async (pageId) => connectedChannel(pageId));
    mockChannelResolver.resolveConnectedChannel.mockImplementation(async (pageId) => {
        const channel = await mockMetaChannelService.findByMetaAssetId(pageId, 'facebook');
        return channel?.status === 'CONNECTED' ? channel : null;
    });
    mockChannelResolver.resolveConnectedChannelForReceipt.mockImplementation(async ({ assetId }) => {
        const channel = await mockMetaChannelService.findByMetaAssetId(assetId, 'facebook');
        return channel?.status === 'CONNECTED' ? channel : null;
    });
    mockConsentService.isStopKeyword.mockReturnValue(false);
    mockConsentService.recordInbound.mockResolvedValue({ id: 'cust-1' });
    mockCustomer.findOrCreate.mockResolvedValue([{ id: 'cust-1', name: 'Facebook User', metadata: {} }, true]);
    mockConversation.findOne.mockResolvedValue(null);
    mockConversation.create.mockImplementation(async (fields) => ({
        id: 'conv-1', ...fields, update: jest.fn(async (patch) => patch),
    }));
    mockMessage.findOne.mockResolvedValue(null);
    mockMessage.create.mockResolvedValue({ id: 'msg-1', metadata: {}, toJSON: () => ({ id: 'msg-1' }) });
});

// ── 1. Normal durable acceptance ─────────────────────────────────────────────

describe('postback and referral are durably accepted', () => {
    test('an allowlisted postback is classified, encrypted, and settled QUEUED after handoff', async () => {
        await post(buildPayload(postbackMessaging())).expect(200);

        expect(receipts()).toHaveLength(1);
        const r = receipts()[0];
        expect(r.event_type).toBe('postback');
        expect(r.status).toBe('QUEUED');
        expect(r.shop_id).toBe(SHOP_ID);
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(r.queue_job_id).toBe('queue-job-1');
        expect(mockMessage.create).toHaveBeenCalledTimes(1);
        expect(mockScheduleBurstFlush).toHaveBeenCalledTimes(1);
        expect(mockScheduleBurstFlush).toHaveBeenCalledWith(expect.objectContaining({
            receiptIds: [r.id],
            metaAssetId: PAGE_ID,
        }));
    });

    test('a valid m.me referral is classified, encrypted, and settled PROCESSED with attribution', async () => {
        await post(buildPayload(referralMessaging())).expect(200);

        expect(receipts()).toHaveLength(1);
        const r = receipts()[0];
        expect(r.event_type).toBe('referral');
        expect(r.status).toBe('PROCESSED');
        expect(r.shop_id).toBe(SHOP_ID);
        // Terminal success clears the replay body under the existing policy.
        expect(r.payload_encrypted).toBeNull();
        expect(mockConversation.create).toHaveBeenCalledTimes(1);
        expect(mockConversation.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: SHOP_ID,
            meta_channel_id: CHANNEL_ID,
            metadata: expect.objectContaining({
                referral_source: REFERRAL_REF,
                referral_source_type: 'm_me',
            }),
        }), expect.anything());
    });

    test('dedupe identity is the page-scoped payload hash, never the shared button-message mid', async () => {
        // Two DIFFERENT taps on the same outbound button message share
        // postback.mid. They are distinct customer selections, not duplicates.
        const tapOne = postbackMessaging({ payload: buildInteractionPayload(INTERACTION_UUID, 'checkout.confirm') });
        const tapTwo = postbackMessaging({
            payload: buildInteractionPayload(INTERACTION_UUID, 'checkout.cancel'),
            title: 'Cancel',
        });
        tapTwo.timestamp = tapOne.timestamp + 1;

        await post(buildPayload(tapOne)).expect(200);
        await post(buildPayload(tapTwo)).expect(200);

        expect(receipts()).toHaveLength(2);
        expect(receipts().every((r) => r.event_id === null)).toBe(true);
        expect(receipts().every((r) => r.event_type === 'postback')).toBe(true);
        expect(mockMessage.create).toHaveBeenCalledTimes(2);
        // Each tap gets its own receipt-scoped external id, so message-level
        // dedupe cannot conflate the two selections either.
        const externalIds = mockMessage.create.mock.calls.map(([fields]) => fields.external_id);
        expect(new Set(externalIds).size).toBe(2);
        expect(externalIds.every((id) => /^postback:receipt-/.test(id))).toBe(true);
    });

    test('a text message carrying a referral keeps its existing message classification', async () => {
        await post(buildPayload({
            ...referralMessaging(),
            message: { mid: 'mid.WITHREF.1', text: 'Hello from an ad' },
        })).expect(200);

        expect(receipts()[0].event_type).toBe('message');
        expect(receipts()[0].event_id).toBe('mid.WITHREF.1');
        expect(receipts()[0].status).toBe('QUEUED');
    });

    test('a postback-contained referral still merges attribution after storage', async () => {
        const conversation = {
            id: 'conv-1',
            shop_id: SHOP_ID,
            customer_id: 'cust-1',
            channel: 'messenger',
            meta_channel_id: CHANNEL_ID,
            status: 'active',
            metadata: {},
            update: jest.fn(async function patch(patch) { Object.assign(this, patch); return this; }),
        };
        mockConversation.findOne.mockResolvedValue(conversation);

        await post(buildPayload(postbackMessaging({
            referral: { ref: REFERRAL_REF, source: 'SHORTLINK', type: 'OPEN_THREAD' },
        }))).expect(200);

        expect(receipts()[0].status).toBe('QUEUED');
        expect(conversation.metadata.referral_source).toBe(REFERRAL_REF);
        expect(conversation.metadata.referral_source_type).toBe('m_me');
    });
});

// ── 2. Transient database failure ────────────────────────────────────────────

describe('transient database failure keeps the event replayable', () => {
    test('a postback store failure holds an encrypted RETRY_PENDING receipt and recovers once', async () => {
        mockMessage.create.mockRejectedValueOnce(new Error('deadlock detected'));

        await post(buildPayload(postbackMessaging())).expect(200);

        const r = receipts()[0];
        expect(r.status).toBe('RETRY_PENDING');
        expect(r.retry_count).toBe(1);
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(r.status).not.toBe('SKIPPED');

        dueNow(r);
        const result = await new WebhookReceiptReconcilerJob().execute();

        expect(result.processed).toBe(1);
        expect(r.status).toBe('QUEUED');
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(mockMessage.create).toHaveBeenCalledTimes(2); // 1 failed + 1 recovery
        expect(mockScheduleBurstFlush).toHaveBeenCalledTimes(1);
    });

    test('a referral store failure holds an encrypted receipt and recovers attribution', async () => {
        mockConversation.create.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

        await post(buildPayload(referralMessaging())).expect(200);

        const r = receipts()[0];
        expect(r.status).toBe('RETRY_PENDING');
        expect(r.payload_encrypted).toMatch(/^v1:/);

        dueNow(r);
        const result = await new WebhookReceiptReconcilerJob().execute();

        expect(result.processed).toBe(1);
        expect(r.status).toBe('PROCESSED');
        expect(mockConversation.create).toHaveBeenCalledTimes(2); // 1 failed + 1 recovery
        expect(mockConversation.create.mock.calls[1][0].metadata.referral_source).toBe(REFERRAL_REF);
    });

    test('a receipt INSERT failure returns 503 so Meta redelivers — never a silent 200', async () => {
        failCreate = new Error('connection terminated unexpectedly');

        await post(buildPayload(postbackMessaging())).expect(503);
        await post(buildPayload(referralMessaging())).expect(503);

        expect(receipts()).toHaveLength(0);
        expect(mockMessage.create).not.toHaveBeenCalled();
        expect(mockConversation.create).not.toHaveBeenCalled();
    });
});

// ── 3. Transient queue failure ───────────────────────────────────────────────

describe('transient queue failure keeps the event replayable', () => {
    test('a postback enqueue failure stays QUEUED with payload and recovers without a second message', async () => {
        mockScheduleBurstFlush.mockRejectedValueOnce(new Error('queue unavailable'));

        await post(buildPayload(postbackMessaging())).expect(200);

        const r = receipts()[0];
        expect(r.status).toBe('QUEUED');
        expect(r.last_error_code).toBe('QUEUE_DISPATCH_FAILED');
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(mockMessage.create).toHaveBeenCalledTimes(1);

        // The message is already durable; recovery must find it by external_id
        // instead of storing a second copy.
        mockMessage.findOne.mockResolvedValue({
            id: 'msg-1',
            conversation_id: 'conv-1',
            external_id: `postback:${r.id}`,
            conversation: {
                id: 'conv-1',
                shop_id: SHOP_ID,
                customer_id: 'cust-1',
                channel: 'messenger',
                meta_channel_id: CHANNEL_ID,
                metadata: { within_allowance: true },
            },
        });

        dueNow(r);
        const result = await new WebhookReceiptReconcilerJob().execute();

        expect(result.processed).toBe(1);
        expect(r.status).toBe('QUEUED');
        expect(r.last_error_code).toBeNull();
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(mockMessage.create).toHaveBeenCalledTimes(1); // no duplicate business action
        expect(mockScheduleBurstFlush).toHaveBeenCalledTimes(2);
    });
});

// ── 4. Channel-resolution failure and recovery ───────────────────────────────

describe('channel-resolution failure no longer skips postbacks or referrals', () => {
    test('a resolver throw holds both event types retryable, then recovery delivers them', async () => {
        mockChannelResolver.resolveConnectedChannel.mockRejectedValueOnce(new Error('channel store unavailable'));

        await post(buildPayload(postbackMessaging())).expect(200);
        const postbackReceipt = receipts()[0];
        expect(postbackReceipt.status).toBe('RETRY_PENDING');
        expect(postbackReceipt.last_error_code).toBe('CHANNEL_RESOLUTION_FAILED');
        expect(postbackReceipt.payload_encrypted).toMatch(/^v1:/);

        mockChannelResolver.resolveConnectedChannel.mockRejectedValueOnce(new Error('channel store unavailable'));
        await post(buildPayload(referralMessaging())).expect(200);
        const referralReceipt = receipts()[1];
        expect(referralReceipt.status).toBe('RETRY_PENDING');
        expect(referralReceipt.payload_encrypted).toMatch(/^v1:/);

        expect(mockMessage.create).not.toHaveBeenCalled();
        expect(mockConversation.create).not.toHaveBeenCalled();

        dueNow(postbackReceipt);
        dueNow(referralReceipt);
        const result = await new WebhookReceiptReconcilerJob().execute();

        expect(result.processed).toBe(2);
        expect(postbackReceipt.status).toBe('QUEUED');
        expect(referralReceipt.status).toBe('PROCESSED');
        expect(mockMessage.create).toHaveBeenCalledTimes(1);
        // One thread for the recovered postback, one for the recovered referral.
        expect(mockConversation.create).toHaveBeenCalledTimes(2);
        expect(mockConversation.create.mock.calls.some(([fields]) => (
            fields.metadata?.referral_source === REFERRAL_REF
        ))).toBe(true);
    });

    test('a disconnected Page holds both event types IDENTITY_NOT_RESOLVED until reconnect', async () => {
        mockMetaChannelService.findByMetaAssetId.mockResolvedValue(null);

        await post(buildPayload(postbackMessaging())).expect(200);
        await post(buildPayload(referralMessaging())).expect(200);

        for (const r of receipts()) {
            expect(r.status).toBe('IDENTITY_NOT_RESOLVED');
            expect(r.last_error_code).toBe('PAGE_NOT_CONNECTED');
            expect(r.payload_encrypted).toMatch(/^v1:/);
            expect(r.shop_id ?? null).toBeNull();
            expect(r.meta_channel_id ?? null).toBeNull();
        }

        // Merchant reconnects; the retries become due.
        mockMetaChannelService.findByMetaAssetId.mockImplementation(async (pageId) => connectedChannel(pageId));
        receipts().forEach(dueNow);
        const result = await new WebhookReceiptReconcilerJob().execute();

        expect(result.processed).toBe(2);
        expect(receipts().find((r) => r.event_type === 'postback').status).toBe('QUEUED');
        expect(receipts().find((r) => r.event_type === 'referral').status).toBe('PROCESSED');
    });

    test('a bound channel that disappears holds the receipt instead of skipping it', async () => {
        const messaging = postbackMessaging();
        const { receipt } = await receiptService.recordReceipt({
            pageId: PAGE_ID,
            messaging,
            shopId: SHOP_ID,
            metaChannelId: CHANNEL_ID,
        });
        mockChannelResolver.resolveConnectedChannelForReceipt.mockResolvedValue(null);

        await post(buildPayload(messaging)).expect(200);

        expect(receipt.status).toBe('IDENTITY_NOT_RESOLVED');
        expect(receipt.payload_encrypted).toMatch(/^v1:/);
        expect(mockMessage.create).not.toHaveBeenCalled();
    });
});

// ── 5. Duplicate delivery ────────────────────────────────────────────────────

describe('duplicate webhook delivery causes no duplicate business action', () => {
    test('a redelivered postback creates no second receipt, message, or AI turn', async () => {
        const payload = buildPayload(postbackMessaging());
        await post(payload).expect(200);
        await post(payload).expect(200);

        expect(receipts()).toHaveLength(1);
        expect(mockMessage.create).toHaveBeenCalledTimes(1);
        expect(mockScheduleBurstFlush).toHaveBeenCalledTimes(1);
    });

    test('a redelivered referral creates no second receipt or conversation', async () => {
        const payload = buildPayload(referralMessaging());
        await post(payload).expect(200);
        await post(payload).expect(200);

        expect(receipts()).toHaveLength(1);
        expect(mockConversation.create).toHaveBeenCalledTimes(1);
    });

    test('concurrent deliveries of the same postback stay idempotent', async () => {
        const payload = buildPayload(postbackMessaging());
        await Promise.all([post(payload), post(payload)]);

        expect(receipts()).toHaveLength(1);
        expect(mockMessage.create).toHaveBeenCalledTimes(1);
    });
});

// ── 6. Missing encryption configuration fails safe ───────────────────────────

describe('missing encryption configuration fails safe', () => {
    test('postback and referral are rejected before durable acceptance when the key is absent', async () => {
        delete process.env.CHANNEL_ENCRYPTION_KEY;

        await post(buildPayload(postbackMessaging())).expect(503);
        await post(buildPayload(referralMessaging())).expect(503);

        // No receipt row at all — nothing plaintext, nothing silently lost:
        // Meta redelivers once the key is restored.
        expect(receipts()).toHaveLength(0);
        expect(mockMessage.create).not.toHaveBeenCalled();
        expect(mockConversation.create).not.toHaveBeenCalled();
        expect(alertCalls.some((a) => a.title.includes('encryption unavailable'))).toBe(true);

        process.env.CHANNEL_ENCRYPTION_KEY = 'a'.repeat(64);
        await post(buildPayload(postbackMessaging())).expect(200);
        expect(receipts()[0].payload_encrypted).toMatch(/^v1:/);
    });
});

// ── 7. Invalid / expired events and the disabled flag stay terminal ──────────

describe('invalid events and the disabled guard flag remain terminal skips', () => {
    test('a non-allowlisted postback payload is skipped terminally with its payload cleared', async () => {
        await post(buildPayload(postbackMessaging({ payload: 'forged:confirm:order-99' }))).expect(200);

        const r = receipts()[0];
        expect(r.event_type).toBe('postback');
        expect(r.status).toBe('SKIPPED');
        expect(r.last_error_code).toBe('POSTBACK_NOT_ALLOWLISTED');
        expect(r.payload_encrypted).toBeNull();
        expect(mockMessage.create).not.toHaveBeenCalled();
    });

    test('an invalid referral ref (PII / URL / phone) is skipped terminally', async () => {
        for (const unsafeRef of ['user@test.com', 'https://evil.example/phish', '01712345678']) {
            store.clear();
            await post(buildPayload(referralMessaging({
                referral: { ref: unsafeRef, source: 'SHORTLINK', type: 'OPEN_THREAD' },
            }))).expect(200);

            const r = receipts()[0];
            expect(r.status).toBe('SKIPPED');
            expect(r.last_error_code).toBe('REFERRAL_REF_INVALID');
            expect(r.payload_encrypted).toBeNull();
            expect(mockConversation.create).not.toHaveBeenCalled();
        }
    });

    test('with interaction_choices disabled both event types skip without business actions', async () => {
        mockInteractionChoicesEnabled = false;

        await post(buildPayload(postbackMessaging())).expect(200);
        await post(buildPayload(referralMessaging())).expect(200);

        for (const r of receipts()) {
            expect(r.status).toBe('SKIPPED');
            expect(r.last_error_code).toBe('INTERACTION_CHOICES_DISABLED');
            expect(r.payload_encrypted).toBeNull();
        }
        expect(mockMessage.create).not.toHaveBeenCalled();
        expect(mockConversation.create).not.toHaveBeenCalled();
        expect(mockScheduleBurstFlush).not.toHaveBeenCalled();
    });

    test('exhausted store retries dead-letter the postback with its replay payload retained', async () => {
        mockMessage.create.mockRejectedValue(new Error('deadlock detected'));

        await post(buildPayload(postbackMessaging())).expect(200);
        for (let i = 0; i < receiptService.MAX_STORE_RETRIES; i += 1) {
            dueNow(receipts()[0]);
            await new WebhookReceiptReconcilerJob().execute();
        }

        const r = receipts()[0];
        expect(r.status).toBe('DEAD_LETTERED');
        expect(r.last_error_code).not.toBe('PAYLOAD_MISSING');
        expect(r.payload_encrypted).toMatch(/^v1:/);
        expect(alertCalls.some((a) => a.title.includes('DEAD-LETTERED'))).toBe(true);

        // Terminal receipts are never claimed again.
        const again = await new WebhookReceiptReconcilerJob().execute();
        expect(again.claimed).toBe(0);
    });
});

// ── 8. Unsupported event behavior is unchanged ───────────────────────────────

describe('unsupported and non-business events behave exactly as before', () => {
    test('delivery, read, and unrecognised events are skipped without a replay body', async () => {
        const events = [
            { sender: { id: SENDER_PSID }, delivery: { watermark: 1 } },
            { sender: { id: SENDER_PSID }, read: { watermark: 1 } },
            { sender: { id: SENDER_PSID }, reaction: { reaction: 'love', emoji: '❤' } },
        ];
        for (const messaging of events) {
            store.clear();
            await post(buildPayload(messaging)).expect(200);
            const r = receipts()[0];
            expect(r.status).toBe('SKIPPED');
            expect(r.payload_encrypted ?? null).toBeNull();
        }
        expect(receiptService.REPLAYABLE_EVENT_TYPES).not.toContain('delivery');
        expect(receiptService.REPLAYABLE_EVENT_TYPES).not.toContain('read');
        expect(receiptService.REPLAYABLE_EVENT_TYPES).not.toContain('unknown');
        expect(mockMessage.create).not.toHaveBeenCalled();
    });

    test('a channel-resolution failure still skips non-business events instead of holding them', async () => {
        mockChannelResolver.resolveConnectedChannel.mockRejectedValueOnce(new Error('channel store unavailable'));

        await post(buildPayload({ sender: { id: SENDER_PSID }, delivery: { watermark: 1 } })).expect(200);

        expect(receipts()[0].status).toBe('SKIPPED');
        expect(receipts()[0].last_error_code).toBe('CHANNEL_RESOLUTION_FAILED');
    });
});

// ── 9. Cross-shop isolation ──────────────────────────────────────────────────

describe('cross-shop isolation', () => {
    test('the same postback body delivered to two Pages stays scoped to each shop', async () => {
        const messaging = postbackMessaging();

        await post(buildPayload(messaging, PAGE_ID)).expect(200);
        await post(buildPayload({ ...messaging, recipient: { id: PAGE_ID_B } }, PAGE_ID_B)).expect(200);

        expect(receipts()).toHaveLength(2);
        const first = receipts().find((r) => r.page_id === PAGE_ID);
        const second = receipts().find((r) => r.page_id === PAGE_ID_B);
        expect(first.shop_id).toBe(SHOP_ID);
        expect(first.meta_channel_id).toBe(CHANNEL_ID);
        expect(second.shop_id).toBe(SHOP_ID_B);
        expect(second.meta_channel_id).toBe(CHANNEL_ID_B);

        const customerScopes = mockCustomer.findOrCreate.mock.calls.map(([args]) => args.where.shop_id);
        expect(customerScopes).toEqual(expect.arrayContaining([SHOP_ID, SHOP_ID_B]));
        expect(mockScheduleBurstFlush.mock.calls.map(([args]) => args.shopId))
            .toEqual(expect.arrayContaining([SHOP_ID, SHOP_ID_B]));
    });

    test('a held postback is never associated with another tenant', async () => {
        mockMetaChannelService.findByMetaAssetId.mockResolvedValue(null);
        await post(buildPayload(postbackMessaging())).expect(200);

        expect(receipts()[0].shop_id ?? null).toBeNull();
        expect(receipts()[0].meta_channel_id ?? null).toBeNull();
    });
});

// ── 10. No PII or secret leakage ─────────────────────────────────────────────

describe('receipts and operational logs carry no customer content or secrets', () => {
    test('the sender PSID is hashed and no raw content reaches receipts, logs, or alerts', async () => {
        await post(buildPayload(postbackMessaging())).expect(200);
        await post(buildPayload(referralMessaging())).expect(200);
        mockMetaChannelService.findByMetaAssetId.mockResolvedValue(null);
        await post(buildPayload(postbackMessaging({ payload: 'p1:other:tap' }))).expect(200);

        const serializedReceipts = JSON.stringify(receipts().map((r) => ({ ...r, update: undefined, set: undefined })));
        const serializedLogs = JSON.stringify(logCalls);
        const serializedAlerts = JSON.stringify(alertCalls);

        for (const serialized of [serializedReceipts, serializedLogs, serializedAlerts]) {
            expect(serialized).not.toContain(SENDER_PSID);
            expect(serialized).not.toContain(POSTBACK_TITLE);
            expect(serialized).not.toContain(REFERRAL_REF);
            expect(serialized).not.toContain(VALID_PAYLOAD);
            expect(serialized).not.toContain(APP_SECRET);
            expect(serialized).not.toContain(process.env.CHANNEL_ENCRYPTION_KEY);
        }

        for (const r of receipts()) {
            expect(r.sender_ref).toBe(crypto.createHash('sha256').update(SENDER_PSID).digest('hex'));
            if (r.payload_encrypted) {
                expect(r.payload_encrypted).toMatch(/^v1:/);
                expect(r.payload_encrypted).not.toContain(SENDER_PSID);
                expect(r.payload_encrypted).not.toContain(POSTBACK_TITLE);
                expect(r.payload_encrypted).not.toContain(REFERRAL_REF);
            }
        }
    });
});
