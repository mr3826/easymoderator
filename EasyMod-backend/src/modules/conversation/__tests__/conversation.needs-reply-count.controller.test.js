'use strict';

/**
 * Phase 1 C1 — controller surface of GET /api/conversation/needs-reply-count
 * (doc 05 §1). Guard behavior + envelope + 5xx-on-failure (client maps null,
 * never 0). The bounded scan semantics live in the inbox service's own suite.
 */

jest.mock('../../inbox/inbox-needs-reply.service', () => ({
    getNeedsReplyCount: jest.fn(),
}));
jest.mock('../conversation.service', () => ({
    approveAiDraft: jest.fn(),
    updateConversation: jest.fn(),
    dismissAiDraft: jest.fn(),
    markConversationRead: jest.fn(),
    mapMessage: jest.fn((message) => message),
}));
jest.mock('../escalation-auto-reply.service', () => ({ sendEscalationAutoReply: jest.fn() }));
jest.mock('../../entities', () => ({
    Conversation: { findOne: jest.fn(), update: jest.fn() },
    Customer: {},
    Message: { findOne: jest.fn(), update: jest.fn() },
}));
jest.mock('../../channel-providers/meta-channel.service', () => ({
    findConnectedById: jest.fn(),
    findUniqueConnectedByShopAndPlatform: jest.fn(),
}));
jest.mock('../../channel-providers/provider.registry', () => ({ getProvider: jest.fn(() => ({ sendMessage: jest.fn() })) }));
jest.mock('../../policy/policy.engine', () => ({ evaluateOutbound: jest.fn(async () => ({ allow: true })) }));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../config/redis', () => ({ cacheRedis: { setex: jest.fn(), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
        define: jest.fn(() => ({ findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() })),
    },
}));

const inboxNeedsReplyService = require('../../inbox/inbox-needs-reply.service');
const controller = require('../conversation.controller');

const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
});

describe('conversation.controller.getNeedsReplyCount', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('answers the { success, data } envelope with the service payload (shopId from the verified JWT only)', async () => {
        const payload = { count: 3, scanned: 12, cap: 200, coverageComplete: true, generated_at: '2026-11-24T10:00:00.000Z' };
        inboxNeedsReplyService.getNeedsReplyCount.mockResolvedValue(payload);
        const req = { user: { userId: 'user-1', shopId: 'shop-1' }, query: { shop_id: 'other-shop' } };
        const res = makeRes();
        const next = jest.fn();

        await controller.getNeedsReplyCount(req, res, next);

        expect(inboxNeedsReplyService.getNeedsReplyCount).toHaveBeenCalledTimes(1);
        expect(inboxNeedsReplyService.getNeedsReplyCount).toHaveBeenCalledWith({ shopId: 'shop-1' });
        expect(res.json).toHaveBeenCalledWith({ success: true, data: payload });
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects requests without a shop scope (400 VALIDATION_ERROR) and never queries', async () => {
        const req = { user: { userId: 'user-1' }, query: {} };
        const res = makeRes();
        const next = jest.fn();

        await controller.getNeedsReplyCount(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        }));
        expect(inboxNeedsReplyService.getNeedsReplyCount).not.toHaveBeenCalled();
    });

    it('fails to the error handler (5xx via next) — the honest read failure the client maps to null', async () => {
        const error = new Error('conversation scan unavailable');
        inboxNeedsReplyService.getNeedsReplyCount.mockRejectedValue(error);
        const req = { user: { userId: 'user-1', shopId: 'shop-1' }, query: {} };
        const res = makeRes();
        const next = jest.fn();

        await controller.getNeedsReplyCount(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
        expect(res.json).not.toHaveBeenCalled();
    });
});
