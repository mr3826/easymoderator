'use strict';

/**
 * Release-readiness: production-default + feature-flag MATRIX.
 *
 * The behavior matrix of the shipped deployment defaults, driven through the
 * REAL renderer contract (buildRenderedEnv with no AI vars set — exactly what
 * a first production deploy gets). Pins, in one place:
 *   1. every AI commerce flag renders strict-literal 'false';
 *   2. under production defaults, no mutating action can pass the gate kill
 *      switch (denials are audited);
 *   3. audited READ_PRODUCT reports the policy state domain_agent_runtime_disabled
 *      (the intent-router's legacy-continuation branch is pinned in
 *      intent-router.test.js — R2-F1);
 *   4. a signed payment-webhook system booking is blocked as automation_disabled
 *      with ZERO provider/dispatch side effects (R2-F10 — previously untested);
 *   5. partial enablement is granular: order mutations on does NOT open courier
 *      booking or payment acceptance; in-flight kill switch revokes a minted
 *      authorization at verify time.
 */

process.env.NODE_ENV = 'test';

const mockOrder = { findOne: jest.fn(), update: jest.fn() };
const mockCourierDispatch = { findOrCreate: jest.fn(), update: jest.fn(), findOne: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockAuditLog = { create: jest.fn() };

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: {},
    Product: {},
    Customer: {},
    UserShop: mockUserShop,
    AuditLog: mockAuditLog,
    OrderReturn: {},
    CourierDispatch: mockCourierDispatch,
    // Billing standing gate (ADR-0011 C5) counts unpaid recurring invoices
    // inside the booking claim; this matrix is about automation defaults.
    Invoice: { count: jest.fn().mockResolvedValue(0) },
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
        query: jest.fn(),
        getDialect: jest.fn(),
    },
}));
jest.mock('../../delivery/delivery.service', () => ({
    resolveAiDefaultProvider: jest.fn(),
    createDeliveryOrder: jest.fn(),
}));
jest.mock('../../order/order-session-standalone.service', () => ({
    persistDeliveryResult: jest.fn(),
}));
jest.mock('../../notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));
jest.mock('../../notification/notification-events', () => ({
    NOTIFICATION_EVENTS: {
        COURIER_SETUP_REQUIRED: 'courier_setup_required',
        COURIER_BOOKING_FAILED: 'courier_booking_failed',
    },
}));

const { buildRenderedEnv } = require('../../../../scripts/render-production-env');
const {
    authorize,
    verifyAuthorization,
} = require('../action-gate');
const { evaluateReadAction } = require('../action-gate/read-action-evaluator');
const { MUTATING_ACTION_FLAGS } = require('../../../config/ai-runtime-flags');
const {
    MUTATING_ACTION_TYPES,
    createProposedAction,
    deriveCreateOrderIdempotencyKey,
    deriveBookCourierIdempotencyKey,
    deriveIdempotencyKey,
} = require('../contracts/action.contract');
const { withEvidenceSnapshot } = require('../contracts/evidence.contract');
const orderService = require('../../order/order.service');
const deliveryService = require('../../delivery/delivery.service');
const { sequelize } = require('../../../utils/database/database-setup');

const AI_FLAG_NAMES = [
    'DOMAIN_AGENT_RUNTIME_ENABLED',
    'AI_ORDER_MUTATIONS_ENABLED',
    'AI_COURIER_BOOKING_ENABLED',
    'AI_PAYMENT_ACCEPTANCE_ENABLED',
    'AI_SUPPORT_CASE_ENABLED',
];

const MATRIX_ENV_KEYS = [...AI_FLAG_NAMES, 'NODE_ENV', 'AI_ACTION_GATE_SECRET'];

const applyEnv = async (overrides, fn) => {
    const saved = {};
    for (const key of MATRIX_ENV_KEYS) saved[key] = process.env[key];
    Object.assign(process.env, overrides);
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const withRenderedProductionDefaults = (fn) => applyEnv({
    NODE_ENV: 'production',
    ...Object.fromEntries(AI_FLAG_NAMES.map((name) => [name, 'false'])),
}, fn);

const withFlags = (overrides, fn) => applyEnv({
    NODE_ENV: 'production',
    AI_ACTION_GATE_SECRET: 'f'.repeat(64),
    ...Object.fromEntries(AI_FLAG_NAMES.map((name) => [name, 'false'])),
    ...overrides,
}, fn);

const makeOrder = () => ({
    id: 'order-1',
    shop_id: 'shop-1',
    order_number: 'ORD-PROD-0001',
    order_status: 'confirmed',
    fulfillment_status: 'unfulfilled',
    customer_name: 'Rahim',
    customer_phone: '01711111111',
    delivery_address: { street_address: 'Road 1', upazila: 'Dhanmondi', district: 'Dhaka' },
    total: '1250.00',
    items: [{ name: 'Red Saree', quantity: 2 }],
    update: jest.fn(async function update(values) { Object.assign(this, values); }),
});

const buildAction = (actionType, evidence) => {
    const keyByType = {
        CREATE_ORDER: deriveCreateOrderIdempotencyKey({ shopId: 'shop-1', conversationId: 'conv-1', orderSessionId: 'sess-matrix-1', confirmedSummaryHash: 'a'.repeat(64) }),
        BOOK_COURIER: deriveBookCourierIdempotencyKey({ shopId: 'shop-1', orderId: 'order-1', provider: 'pathao' }),
    };
    const domainByType = {
        CREATE_ORDER: 'ORDER',
        EDIT_PREORDER_CART: 'ORDER',
        CANCEL_ORDER_SESSION: 'ORDER',
        BOOK_COURIER: 'COMMERCE_OPS',
        ACCEPT_PAYMENT: 'COMMERCE_OPS',
        CREATE_SUPPORT_CASE: 'SUPPORT',
    };
    return createProposedAction({
        requestedByAgent: 'OrderAgent',
        actionType,
        domain: domainByType[actionType],
        shopId: 'shop-1',
        conversationId: 'conv-1',
        idempotencyKey: keyByType[actionType] || deriveIdempotencyKey(['matrix', actionType]),
        evidenceSnapshotHash: evidence.snapshotHash,
        payload: { confirmedSummaryHash: 'a'.repeat(64), orderId: 'order-1', provider: 'pathao' },
    });
};

const gateContext = (evidence, action) => ({
    traceId: 'trace-matrix-1',
    tenant: {
        shopId: 'shop-1',
        channelId: 'channel-1',
        platform: 'META_MESSENGER',
        customerId: 'customer-1',
        conversationId: action.conversationId,
    },
    tenantRecordsMatch: true,
    currentDomain: 'ORDER',
    domainHops: 0,
    expectedIdempotencyKey: action.idempotencyKey,
    idempotencyCommitted: false,
    evidenceSnapshot: evidence,
    materialStateRevalidated: true,
    customerConfirmationValid: true,
    merchantModeAllowsMutation: true,
    costBudgetAvailable: true,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLog.create.mockResolvedValue({ id: 'audit-1' });
    mockOrder.findOne.mockResolvedValue(makeOrder());
    mockUserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'owner' });
    sequelize.transaction.mockImplementation(async (callback) => {
        const transaction = { LOCK: { UPDATE: 'UPDATE' }, rollback: jest.fn(), commit: jest.fn() };
        return callback(transaction);
    });
});

describe('production-defaults feature-flag matrix', () => {
    test('the real renderer emits strict-literal false for every AI commerce flag with no source vars', () => {
        const source = {
            DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n',
            JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
            SESSION_SECRET: 'c'.repeat(64), CSRF_SECRET: 'd'.repeat(64),
            PAYMENT_ENCRYPTION_KEY: 'x'.repeat(64), DELIVERY_ENCRYPTION_KEY: 'e'.repeat(64),
            REDX_WEBHOOK_SECRET: 'r'.repeat(64), CHANNEL_ENCRYPTION_KEY: 'f'.repeat(64),
            PAYMENT_CALLBACK_HMAC_SECRET: 'g'.repeat(64), AI_ACTION_GATE_SECRET: 'i'.repeat(64),
            MARKETING_URL: 'https://easymod.tech', APP_URL: 'https://app.easymod.tech',
            API_URL: 'https://api.easymod.tech', PUBLIC_ASSET_URL: 'https://api.easymod.tech',
            CORS_ORIGINS: 'https://app.easymod.tech', FRONTEND_URL: 'https://app.easymod.tech',
            BASE_URL: 'https://api.easymod.tech',
            META_OAUTH_REDIRECT_URI: 'https://app.easymod.tech/channels/oauth-callback',
            META_LOGIN_CONFIG_ID: '1685388446490514', META_APP_ID: '1234567890', META_APP_SECRET: 'j'.repeat(64),
            META_WEBHOOK_VERIFY_TOKEN: 'k'.repeat(64),
            RESEND_API_KEY: 're_live', EMAIL_FROM: 'no-reply@easymod.tech',
            ACME_EMAIL: 'ops@example.com',
            SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
            OPENAI_API_KEY: 'sk-openai-test',
            BKASH_ENABLED: 'false', TELEGRAM_ENABLED: 'false',
        };
        const env = buildRenderedEnv(source);
        for (const name of AI_FLAG_NAMES) expect(env[name]).toBe('false');
    });

    test('under production defaults every mutating gate attempt is denied at the kill switch, audited', async () => {
        await withRenderedProductionDefaults(async () => {
            for (const actionType of MUTATING_ACTION_TYPES) {
                mockAuditLog.create.mockClear();
                const evidence = withEvidenceSnapshot({ shopId: 'shop-1', conversationId: 'conv-1', sourceText: 'matrix' });
                const action = buildAction(actionType, evidence);
                const result = await authorize(action, gateContext(evidence, action));
                expect(result.authorized).toBe(false);
                expect(result.reasonCode).toBe('runtime_kill_switch_enabled');
                expect(mockAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
                    action: 'ai.action_gate.denied',
                    shop_id: 'shop-1',
                }));
            }
        });
    });

    test('READ_PRODUCT under production defaults reports the policy state, not an integrity failure', async () => {
        await withRenderedProductionDefaults(() => {
            const evidence = withEvidenceSnapshot({ shopId: 'shop-1', conversationId: 'conv-1', sourceText: 'catalog' });
            const result = evaluateReadAction({
                actionType: 'READ_PRODUCT',
                tenant: { shopId: 'shop-1', conversationId: 'conv-1' },
                traceId: 'trace-matrix-1',
                evidenceSnapshot: evidence,
                payload: { productIds: ['p-1'] },
            });
            expect(result).toEqual({ recorded: false, reasonCode: 'domain_agent_runtime_disabled' });
        });
    });

    test('a verified payment webhook cannot auto-book the courier at production defaults (R2-F10)', async () => {
        await withRenderedProductionDefaults(async () => {
            const result = await orderService.bookForOrder(makeOrder(), {
                shopId: 'shop-1',
                trigger: 'PAYMENT_WEBHOOK',
                mutationAuthority: {
                    kind: 'system',
                    source: 'payment_webhook',
                    signatureVerified: true,
                    eventId: 'evt-matrix-1',
                },
            });
            expect(result).toMatchObject({ blocked: true, status: 'automation_disabled' });
            expect(deliveryService.resolveAiDefaultProvider).not.toHaveBeenCalled();
            expect(deliveryService.createDeliveryOrder).not.toHaveBeenCalled();
            expect(mockCourierDispatch.findOrCreate).not.toHaveBeenCalled();
        });
    });

    test('partial enablement is granular: order mutations ON does not open courier booking', async () => {
        await withFlags({ DOMAIN_AGENT_RUNTIME_ENABLED: 'true', AI_ORDER_MUTATIONS_ENABLED: 'true' }, async () => {
            const evidence = withEvidenceSnapshot({ shopId: 'shop-1', conversationId: 'conv-1', sourceText: 'matrix' });
            const createAction = buildAction('CREATE_ORDER', evidence);
            const create = await authorize(createAction, gateContext(evidence, createAction));
            expect(create.authorized).toBe(true);
            const bookAction = buildAction('BOOK_COURIER', evidence);
            const book = await authorize(bookAction, gateContext(evidence, bookAction));
            expect(book.authorized).toBe(false);
            expect(book.reasonCode).toBe('runtime_kill_switch_enabled');
        });
    });

    test('an authorization minted while flags are on fails verification after the kill switch flips off', async () => {
        const evidence = withEvidenceSnapshot({ shopId: 'shop-1', conversationId: 'conv-1', sourceText: 'matrix' });
        const action = buildAction('CREATE_ORDER', evidence);
        const granted = await withFlags({ DOMAIN_AGENT_RUNTIME_ENABLED: 'true', AI_ORDER_MUTATIONS_ENABLED: 'true' }, async () => (
            authorize(action, gateContext(evidence, action))
        ));
        expect(granted.authorized).toBe(true);
        await withFlags({ DOMAIN_AGENT_RUNTIME_ENABLED: 'true', AI_ORDER_MUTATIONS_ENABLED: 'false' }, async () => {
            expect(verifyAuthorization(granted.authorization, {
                shopId: 'shop-1',
                actionType: 'CREATE_ORDER',
                idempotencyKey: action.idempotencyKey,
                evidenceSnapshotHash: evidence.snapshotHash,
            })).toBe(false);
        });
    });

    test('every mutating action type maps to exactly one real render-production-env flag', () => {
        const flags = new Set(Object.values(MUTATING_ACTION_FLAGS));
        for (const flag of flags) expect(AI_FLAG_NAMES).toContain(flag);
        expect(Object.keys(MUTATING_ACTION_FLAGS).sort()).toEqual([...MUTATING_ACTION_TYPES].sort());
    });
});
