const express = require('express');
const request = require('supertest');
const { AppError, globalErrorHandler } = require('../../../utils/AppError');

const mockAuthenticate = jest.fn((req, _res, next) => {
    req.user = { userId: 'user-1', shopId: 'shop-1' };
    next();
});
const mockVerifyShopAccess = jest.fn((_req, _res, next) => next());
const mockCheckSubscriptionStatus = jest.fn((_req, _res, next) => {
    next(new Error('subscription gate should not run for manual inbox routes'));
});

const mockController = {
    getConversations: jest.fn((_req, res) => res.status(200).json({ success: true, data: { conversations: [], pagination: { total: 0 } } })),
    getHistory: jest.fn((_req, res) => res.status(200).json({ success: true, data: [] })),
    getEventStream: jest.fn((_req, res) => res.status(204).end()),
    searchConversations: jest.fn((_req, res) => res.status(200).json({ success: true, data: [] })),
    bulkUpdateStatus: jest.fn((_req, res) => res.status(200).json({ success: true })),
    checkDuplicate: jest.fn((_req, res) => res.status(200).json({ success: true })),
    createConversation: jest.fn((_req, res) => res.status(201).json({ success: true })),
    getConversationById: jest.fn((req, res, next) => {
        if (['missing-conversation', 'shop-b-conversation'].includes(req.params.conversationId)) {
            return next(new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND'));
        }
        return res.status(200).json({ success: true });
    }),
    updateConversation: jest.fn((_req, res) => res.status(200).json({ success: true })),
    updateConversationStatus: jest.fn((_req, res) => res.status(200).json({ success: true })),
    getMessages: jest.fn((_req, res) => res.status(200).json({ success: true, data: { messages: [], pagination: { page: 1, totalPages: 0 } } })),
    createMessage: jest.fn((_req, res) => res.status(201).json({ success: true })),
    sendProductCard: jest.fn((_req, res) => res.status(201).json({ success: true })),
    approveAiDraft: jest.fn((_req, res) => res.status(200).json({ success: true })),
    dismissAiDraft: jest.fn((_req, res) => res.status(200).json({ success: true })),
    markConversationRead: jest.fn((_req, res) => res.status(200).json({ success: true })),
};

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: mockAuthenticate,
    checkSubscriptionStatus: mockCheckSubscriptionStatus,
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: mockVerifyShopAccess,
}));
jest.mock('../../audit/idempotency.middleware', () => ({
    idempotencyMiddleware: (_req, _res, next) => next(),
}));

jest.mock('../conversation.controller', () => mockController);

jest.mock('../../helpers', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../conversation.validator', () => ({
    getConversations: {},
    createConversation: {},
    updateConversation: {},
    updateConversationStatus: {},
    getMessages: {},
    createMessage: {},
    sendProductCard: {},
    approveAiDraft: {},
    conversationMessageAction: {},
    markConversationRead: {},
}));

describe('conversation.routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/conversation', require('../conversation.routes'));
        app.use(globalErrorHandler);
    });

    it('keeps the manual inbox accessible when billing suspension only pauses AI', async () => {
        const res = await request(app).get('/api/conversation?limit=50');

        expect(res.status).toBe(200);
        expect(mockAuthenticate).toHaveBeenCalledTimes(1);
        expect(mockVerifyShopAccess).toHaveBeenCalledTimes(1);
        expect(mockCheckSubscriptionStatus).not.toHaveBeenCalled();
        expect(mockController.getConversations).toHaveBeenCalledTimes(1);
    });

    it('returns 200 for the authenticated shop own conversation', async () => {
        const res = await request(app).get('/api/conversation/own-conversation');

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ success: true }));
    });

    it.each(['missing-conversation', 'shop-b-conversation'])(
        'returns 404 CONVERSATION_NOT_FOUND for %s without becoming a 500',
        async (conversationId) => {
            const res = await request(app).get(`/api/conversation/${conversationId}`);

            expect(res.status).toBe(404);
            expect(res.body).toEqual(expect.objectContaining({
                success: false,
                code: 'CONVERSATION_NOT_FOUND',
            }));
        },
    );
});
