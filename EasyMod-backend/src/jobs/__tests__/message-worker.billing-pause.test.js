'use strict';

/**
 * Billing-paused inbound messages must not be operationally silent.
 *
 * Pausing the AI when billing lapses is correct. Leaving nobody aware of it is
 * not: before this, a customer's message was stored, the AI did nothing, and the
 * only trace was a console line. The merchant saw an unanswered customer with
 * no explanation, and customer-waiting-notifier could not see it either because
 * that job only scans conversations flagged `hitl`.
 *
 * The customer must never be told anything about the merchant's billing.
 */

process.env.NODE_ENV = 'test';

jest.mock('bullmq', () => ({ Worker: jest.fn(), Queue: jest.fn() }));
jest.mock('src/jobs/message-queue', () => ({ connection: {} }));
jest.mock('src/config/redis', () => ({
    cacheRedis: { get: jest.fn(), set: jest.fn(), setex: jest.fn() },
}));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn() }));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: {},
    Message: { count: jest.fn(), findAll: jest.fn(), findByPk: jest.fn() },
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({}));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({}));
jest.mock('src/modules/channel-providers/meta-channel.entity', () => ({}));
jest.mock('src/modules/customer/customer.entity', () => ({}));
jest.mock('src/modules/conversation/order-flow.service', () => ({ hasPurchaseIntent: jest.fn() }));
jest.mock('src/modules/notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));

const { Message } = require('src/modules/conversation/conversation.entity');
const sseManager = require('src/utils/sse-manager');
const merchantNotificationService = require('src/modules/notification/merchant-notification.service');
const { NOTIFICATION_EVENTS } = require('src/modules/notification/notification-events');
const { getProvider } = require('src/modules/channel-providers/provider.registry');
const { _private } = require('src/jobs/message-worker');

const { signalBillingPause, resolveAllowanceDecision } = _private;

const ARGS = {
    shopId: 'shop-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    status: 'suspended',
    platform: 'messenger',
};

let inbound;

beforeEach(() => {
    jest.clearAllMocks();
    inbound = { id: 'msg-1', metadata: { mid: 'm_abc' }, update: jest.fn().mockResolvedValue(undefined) };
    Message.findByPk.mockResolvedValue(inbound);
});

describe('the merchant is told', () => {
    it('raises a subscription alert naming the waiting customers', async () => {
        await signalBillingPause(ARGS);

        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            'shop-1',
            NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE,
            expect.objectContaining({
                subscriptionStatus: 'suspended',
                conversationId: 'conv-1',
                issue: expect.stringMatching(/waiting for a manual reply/i),
            }),
            expect.any(Object),
        );
    });

    it('distinguishes a billing pause from an AI failure', async () => {
        await signalBillingPause(ARGS);

        const [[, , payload]] = merchantNotificationService.notifyShop.mock.calls;
        expect(payload.issue).toMatch(/billing/i);
        // B7 regression: the contract has no subscription; the retired token
        // must never reappear in a merchant-facing alert.
        expect(payload.issue).not.toMatch(/subscription/i);
        expect(payload.subscriptionStatus).toBe('suspended');
    });

    it('notifies live dashboards without claiming the AI broke', async () => {
        await signalBillingPause(ARGS);

        expect(sseManager.emit).toHaveBeenCalledWith('shop-1', 'ai_paused', {
            conversation_id: 'conv-1',
            reason: 'subscription_inactive',
        });
    });
});

describe('repeated inbound messages do not spam', () => {
    it('dedupes to one alert per shop per day regardless of how many customers write', async () => {
        await signalBillingPause({ ...ARGS, conversationId: 'conv-1', messageId: 'msg-1' });
        await signalBillingPause({ ...ARGS, conversationId: 'conv-2', messageId: 'msg-2' });
        await signalBillingPause({ ...ARGS, conversationId: 'conv-3', messageId: 'msg-3' });

        const keys = merchantNotificationService.notifyShop.mock.calls.map(([, , , opts]) => opts.dedupeKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toMatch(/^billing_paused:shop-1:\d{4}-\d{2}-\d{2}$/);
        expect(merchantNotificationService.notifyShop.mock.calls[0][3].dedupeTtlSeconds).toBe(24 * 60 * 60);
    });
});

describe('the reason is durable', () => {
    it('records why the AI stayed silent on the inbound message', async () => {
        await signalBillingPause(ARGS);

        expect(inbound.update).toHaveBeenCalledWith({
            metadata: expect.objectContaining({
                ai_skipped_reason: 'subscription_inactive',
                subscription_status: 'suspended',
                ai_skipped_at: expect.any(String),
            }),
        });
    });

    it('does not discard metadata the message already carried', async () => {
        await signalBillingPause(ARGS);

        const [[written]] = inbound.update.mock.calls;
        expect(written.metadata.mid).toBe('m_abc');
    });
});

describe('the customer is told nothing', () => {
    it('sends no reply to the customer at all', async () => {
        await signalBillingPause(ARGS);

        expect(getProvider).not.toHaveBeenCalled();
    });

    // The billing state IS recorded on the message's metadata — that is the
    // operator evidence. What must never happen is it reaching the customer, and
    // the only customer-visible field on a message is its content.
    it('never rewrites the customer-visible message content', async () => {
        await signalBillingPause(ARGS);

        const [[written]] = inbound.update.mock.calls;
        expect(Object.keys(written)).toEqual(['metadata']);
        expect(written).not.toHaveProperty('content');
    });

    it('creates no outbound message row for the customer to receive', async () => {
        await signalBillingPause(ARGS);

        expect(Message.create).toBeUndefined();
        expect(getProvider).not.toHaveBeenCalled();
    });
});

describe('announcing the pause never breaks the job', () => {
    it('survives the message row being unreadable', async () => {
        Message.findByPk.mockRejectedValue(new Error('db down'));

        await expect(signalBillingPause(ARGS)).resolves.toBeUndefined();
        expect(merchantNotificationService.notifyShop).toHaveBeenCalled();
    });

    it('survives the notification service failing', async () => {
        merchantNotificationService.notifyShop.mockRejectedValue(new Error('redis down'));

        await expect(signalBillingPause(ARGS)).resolves.toBeUndefined();
        expect(sseManager.emit).toHaveBeenCalled();
    });

    it('survives a job that carries no message id', async () => {
        await expect(signalBillingPause({ ...ARGS, messageId: undefined })).resolves.toBeUndefined();

        expect(Message.findByPk).not.toHaveBeenCalled();
        expect(merchantNotificationService.notifyShop).toHaveBeenCalled();
    });
});

describe('conversation quota path is retired (ADR-0011)', () => {
    // ADR-0011 sets conversationEntitlement = null: no conversation is metered,
    // capped or sold. An exhausted historical counter must never withhold a
    // reply; the only automation gate left is billing status (isAiActive).
    it('never blocks an exhausted legacy allowance', () => {
        expect(resolveAllowanceDecision({
            jobDecision: undefined,
            conversationMetadata: {},
            subscription: { conversations_limit: 100, conversations_used: 100, topup_balance: 0 },
        })).toBe(true);
        expect(resolveAllowanceDecision({
            jobDecision: false,
            conversationMetadata: { within_allowance: false },
            subscription: { conversations_limit: 100, conversations_used: 100000, topup_balance: 0 },
        })).toBe(true);
    });

    it('removes the usage-exhausted alarm entirely', () => {
        expect(_private.signalUsageExhausted).toBeUndefined();
    });

    it('still fails closed when no subscription row exists', () => {
        expect(resolveAllowanceDecision({ jobDecision: undefined, conversationMetadata: {} })).toBe(false);
        expect(resolveAllowanceDecision({ subscription: null })).toBe(false);
    });
});
