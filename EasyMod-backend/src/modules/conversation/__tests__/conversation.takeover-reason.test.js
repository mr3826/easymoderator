'use strict';

/**
 * ADR-0013 §8 / API_CONTRACT §5 — manual takeover reason.
 *
 * - `handoff_reason` is a fixed-list merchant reason, accepted only with hitl:true
 * - metadata.manual_handoff_reason/at/by merge into the SINGLE fields.metadata
 *   object after status/resume-boundary writes (no stale-snapshot overwrite)
 * - takeover/assign/resume/resolve never write channel or shop configuration
 */

const mockConversation = (over = {}) => ({
    id: 'conv-1',
    shop_id: 'shop-1',
    channel: 'messenger',
    customer_id: 'cust-1',
    hitl: false,
    status: 'active',
    assignee_id: null,
    resolution_note: null,
    resolved_at: null,
    metadata: {},
    update: jest.fn(async function (fields) { Object.assign(this, fields); return this; }),
    ...over,
});

jest.mock('../../entities', () => ({
    Conversation: { findOne: jest.fn(), findAll: jest.fn() },
    Message: { findAll: jest.fn(async () => []), findOne: jest.fn(async () => null) },
    Customer: {},
    MetaChannel: {},
    MetaChannelSettings: {
        findOrCreate: jest.fn(),
        update: jest.fn(),
        findByPk: jest.fn(),
        findOne: jest.fn(),
    },
    InboxDeliveryOutbox: {},
    UserShop: { findOne: jest.fn(async () => ({ user_id: 'owner-1', shop_id: 'shop-1' })) },
    User: { findAll: jest.fn(async () => []) },
    AuditLog: { create: jest.fn(async () => ({})) },
}));
// The legacy handoff path lives in conversation-state-standalone.service, which
// imports the entity directly (not the registry above).
jest.mock('../conversation.entity', () => ({
    Conversation: { findByPk: jest.fn() },
    Message: { create: jest.fn() },
}));
jest.mock('../../customer/customer.entity', () => ({}));
jest.mock('../../order/order-session-standalone.service', () => ({}));
jest.mock('../../subscription/subscription.service', () => ({ trackUsage: jest.fn() }));
jest.mock('../../shop/shop.service', () => ({
    getShopAiSettings: jest.fn(async () => ({ automation_mode: 'AUTO' })),
    updateShopAiSettings: jest.fn(),
}));
jest.mock('../../shop/ai-reply-mode', () => ({
    ...jest.requireActual('../../shop/ai-reply-mode'),
    getEffectiveAiReplyMode: jest.fn(async () => 'AUTO'),
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { getDialect: () => 'sqlite', transaction: undefined },
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));

const entities = require('../../entities');
const shopService = require('../../shop/shop.service');
const validator = require('../conversation.validator');
const conversationService = require('../conversation.service');

const actor = { userId: 'owner-1', role: 'owner' };

const validateBody = (body) => validator.updateConversation.body.validate(body);

beforeEach(() => {
    jest.clearAllMocks();
    entities.Conversation.findOne.mockResolvedValue(mockConversation());
    entities.Message.findAll.mockResolvedValue([]);
    entities.UserShop.findOne.mockResolvedValue({ user_id: 'owner-1', shop_id: 'shop-1' });
});

describe('conversation.validator handoff_reason', () => {
    test('accepts the fixed list', () => {
        for (const reason of ['manual_takeover', 'customer_request', 'phone_call', 'order_issue', 'other']) {
            const { error } = validateBody({ hitl: true, handoff_reason: reason });
            expect(error).toBeUndefined();
        }
    });

    test('rejects free text', () => {
        const { error } = validateBody({ hitl: true, handoff_reason: 'because I said so' });
        expect(error).toBeTruthy();
    });
});

describe('manual takeover reason metadata', () => {
    test('hitl + reason writes manual_handoff_reason/at/by into the single metadata object', async () => {
        const conversation = mockConversation({ metadata: { title: 'Order chat' } });
        entities.Conversation.findOne.mockResolvedValue(conversation);

        const result = await conversationService.updateConversation(
            'conv-1', 'shop-1',
            { hitl: true, handoff_reason: 'customer_request' },
            { actor },
        );

        expect(conversation.update).toHaveBeenCalledTimes(1);
        const fields = conversation.update.mock.calls[0][0];
        expect(fields.hitl).toBe(true);
        expect(fields.metadata).toEqual(expect.objectContaining({
            title: 'Order chat',
            manual_handoff_reason: 'customer_request',
            manual_handoff_at: expect.any(String),
            manual_handoff_by: 'owner-1',
        }));
        // The SYSTEM reason is a different key and stays untouched.
        expect(fields.metadata.handoff_reason).toBeUndefined();
        expect(result.hitl).toBe(true);
    });

    test('defaults to manual_takeover when hitl:true and no reason is supplied', async () => {
        const conversation = mockConversation();
        entities.Conversation.findOne.mockResolvedValue(conversation);

        await conversationService.updateConversation('conv-1', 'shop-1', { hitl: true }, { actor });

        expect(conversation.update.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
            manual_handoff_reason: 'manual_takeover',
        }));
    });

    test('combined hitl + status + reason produces ONE metadata merge with no lost update', async () => {
        const conversation = mockConversation({
            metadata: { title: 'Keep me', custom_flag: 'x' },
        });
        entities.Conversation.findOne.mockResolvedValue(conversation);

        await conversationService.updateConversation(
            'conv-1', 'shop-1',
            { hitl: true, status: 'active', handoff_reason: 'order_issue' },
            { actor },
        );

        const fields = conversation.update.mock.calls[0][0];
        expect(fields.metadata).toEqual(expect.objectContaining({
            title: 'Keep me',
            custom_flag: 'x',
            status: 'active',
            manual_handoff_reason: 'order_issue',
            manual_handoff_at: expect.any(String),
            manual_handoff_by: 'owner-1',
        }));
    });

    test('handoff_reason is ignored without hitl:true', async () => {
        const conversation = mockConversation();
        entities.Conversation.findOne.mockResolvedValue(conversation);

        await conversationService.updateConversation(
            'conv-1', 'shop-1',
            { assignee_id: 'owner-1', handoff_reason: 'customer_request' },
            { actor },
        );

        const fields = conversation.update.mock.calls[0][0] || {};
        expect(fields.metadata?.manual_handoff_reason).toBeUndefined();
    });

    test('resume (hitl:false) never writes a manual reason', async () => {
        const conversation = mockConversation({ hitl: true, metadata: {} });
        entities.Conversation.findOne.mockResolvedValue(conversation);

        await conversationService.updateConversation('conv-1', 'shop-1', { hitl: false }, { actor });

        const fields = conversation.update.mock.calls[0][0];
        expect(fields.metadata?.manual_handoff_reason).toBeUndefined();
    });
});

describe('legacy keyword-fallback handoff', () => {
    test('markForHumanHandoff sets hitl=true so later customer messages cannot get an AI reply', async () => {
        const conversationEntity = require('../conversation.entity');
        const conversation = {
            id: 'conv-1',
            metadata: { title: 'legacy' },
            update: jest.fn(async function (fields) { Object.assign(this, fields); return this; }),
        };
        conversationEntity.Conversation.findByPk.mockResolvedValue(conversation);
        conversationEntity.Message.create.mockResolvedValue({ id: 'handoff-msg' });

        const ConversationStateService = require('../conversation-state-standalone.service');
        const result = await ConversationStateService.markForHumanHandoff(
            'conv-1', 'keyword_fallback', { source: 'keyword' },
        );

        expect(conversation.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'needs_human',
            hitl: true,
            metadata: expect.objectContaining({
                handoff_reason: 'keyword_fallback',
                title: 'legacy',
            }),
        }));
        expect(result).toEqual(expect.objectContaining({ status: 'needs_human' }));
    });
});

describe('ownership transitions never write channel or shop configuration', () => {
    test.each([
        ['takeover', { hitl: true }],
        ['assign', { assignee_id: 'owner-1' }],
        ['resume', { hitl: false }],
        ['resolve', { status: 'closed' }],
    ])('%s performs no channel/shop settings write', async (_label, patch) => {
        entities.Conversation.findOne.mockResolvedValue(mockConversation({ hitl: true }));

        await conversationService.updateConversation('conv-1', 'shop-1', patch, { actor });

        expect(entities.MetaChannelSettings.findOrCreate).not.toHaveBeenCalled();
        expect(entities.MetaChannelSettings.update).not.toHaveBeenCalled();
        expect(entities.MetaChannelSettings.findByPk).not.toHaveBeenCalled();
        expect(shopService.updateShopAiSettings).not.toHaveBeenCalled();
    });
});