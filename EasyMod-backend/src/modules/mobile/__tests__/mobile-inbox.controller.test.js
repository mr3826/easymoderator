'use strict';

jest.mock('../../conversation/conversation.service', () => ({
    getConversations: jest.fn(),
    getConversationById: jest.fn(),
    getMessages: jest.fn(),
    createMessage: jest.fn(),
    holdPendingAiCandidates: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../conversation/conversation.controller', () => ({
    _deliverViaMetaIfApplicable: jest.fn(),
}));

jest.mock('../../../utils/sse-manager', () => ({
    emit: jest.fn(),
}));

jest.mock('../../../config/redis', () => ({
    cacheRedis: {
        setex: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
    },
}));

jest.mock('../../entities', () => ({
    Message: {
        findOne: jest.fn(),
    },
    AuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
}));

const conversationService = require('../../conversation/conversation.service');
const conversationController = require('../../conversation/conversation.controller');
const sseManager = require('../../../utils/sse-manager');
const { cacheRedis } = require('../../../config/redis');
const { Message, AuditLog } = require('../../entities');
const controller = require('../mobile-inbox.controller');

function response() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

describe('mobile Inbox read contract', () => {
    beforeEach(() => jest.clearAllMocks());

    test('lists only bounded shop-scoped conversation data', async () => {
        const res = response();
        conversationService.getConversations.mockResolvedValue({ conversations: [], pagination: { total: 0 } });

        await controller.getConversations({
            shop: { id: 'shop-a' },
            query: { page: '2', limit: '999', channel: 'messenger' },
        }, res, jest.fn());

        expect(conversationService.getConversations).toHaveBeenCalledWith('shop-a', {
            page: 2,
            limit: 50,
            channel: 'messenger',
        });
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('passes the current shop to conversation detail and transcript reads', async () => {
        const res = response();
        conversationService.getConversationById.mockResolvedValue({ id: 'conversation-a' });
        conversationService.getMessages.mockResolvedValue({ messages: [], suggestions: [], pagination: { total: 0 } });

        await controller.getConversation({ params: { conversationId: 'conversation-a' }, shop: { id: 'shop-a' } }, res, jest.fn());
        await controller.getMessages({
            params: { conversationId: 'conversation-a' },
            query: { page: '1', limit: '25' },
            shop: { id: 'shop-a' },
        }, res, jest.fn());

        expect(conversationService.getConversationById).toHaveBeenCalledWith('conversation-a', 'shop-a');
        expect(conversationService.getMessages).toHaveBeenCalledWith('conversation-a', 'shop-a', { page: 1, limit: 25 });
    });

    test('preserves the shared projected message contract in mobile transcript responses', async () => {
        const res = response();
        const transcript = {
            messages: [{
                id: 'message-a',
                conversation_id: 'conversation-a',
                content: 'Catalog attached',
                sender: 'customer',
                message_type: 'file',
                metadata: {
                    file_name: 'catalog.pdf',
                    file_url: 'https://assets.example.test/catalog.pdf',
                    delivery_state: 'SENT',
                    attachments: [{ type: 'file', name: 'catalog.pdf', url: 'https://assets.example.test/catalog.pdf' }],
                },
                source_references: [{ kind: 'faq', id: 'faq-a', title: 'Catalog' }],
                ai_confidence: 0.9,
                created_at: '2026-11-18T12:00:00.000Z',
            }],
            suggestions: [],
            pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        };
        conversationService.getMessages.mockResolvedValue(transcript);

        await controller.getMessages({
            params: { conversationId: 'conversation-a' },
            query: { page: '1', limit: '25' },
            shop: { id: 'shop-a' },
        }, res, jest.fn());

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: transcript }));
    });

    test('rejects an empty conversation id before reaching the service', async () => {
        const next = jest.fn();
        await controller.getConversation({ params: { conversationId: '' }, shop: { id: 'shop-a' } }, response(), next);

        expect(conversationService.getConversationById).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }));
    });
});

describe('mobile Inbox write contract (replyConversation & setAiMode)', () => {
    beforeEach(() => jest.clearAllMocks());

    test('successfully sends merchant human reply, pauses AI, and emits audit log', async () => {
        const res = response();
        const conv = {
            id: 'conv-123',
            channel: 'messenger',
            last_customer_message_at: new Date().toISOString(), // within 24 hours
        };
        conversationService.getConversationById.mockResolvedValue(conv);
        conversationService.createMessage.mockResolvedValue({
            id: 'msg-1',
            conversation_id: 'conv-123',
            content: 'Hello customer!',
            sender: 'business',
        });
        conversationController._deliverViaMetaIfApplicable.mockResolvedValue({ sent: true });

        const req = {
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            user: { id: 'user-1' },
            body: { message: 'Hello customer!', idempotencyKey: 'idemp-1' },
            get: jest.fn().mockReturnValue('idemp-1'),
        };

        await controller.replyConversation(req, res, jest.fn());

        expect(conversationService.getConversationById).toHaveBeenCalledWith('conv-123', 'shop-a');
        expect(cacheRedis.setex).toHaveBeenCalledWith('ai:pause:conv-123', 1800, '1');
        expect(conversationService.holdPendingAiCandidates).toHaveBeenCalledWith('conv-123', 'shop-a', 'human_active');
        expect(conversationService.createMessage).toHaveBeenCalledWith('conv-123', 'shop-a', expect.objectContaining({
            content: 'Hello customer!',
            sender: 'business',
            send_idempotency_key: 'idemp-1',
            metadata: expect.objectContaining({ source: 'MOBILE' }),
        }));
        expect(sseManager.emit).toHaveBeenCalledWith('shop-a', 'new_message', expect.anything());
        expect(conversationController._deliverViaMetaIfApplicable).toHaveBeenCalledWith('conv-123', 'shop-a', expect.anything(), 'agent');
        expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'INBOX_MESSAGE_SENT',
            shop_id: 'shop-a',
            resource_type: 'conversation_message',
        }));
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                message: expect.objectContaining({ delivery_state: 'SENT' }),
                delivery: expect.objectContaining({ persisted: true, sent: true, state: 'SENT' }),
            }),
        }));
    });

    test('reports a persisted reply as failed rather than sent when delivery fails', async () => {
        const res = response();
        const failedMessage = {
            id: 'msg-failed',
            conversation_id: 'conv-123',
            sender: 'business',
            content: 'Hello customer!',
            message_type: 'text',
            delivery_state: 'FAILED',
            provider_message_id: null,
        };
        conversationService.getConversationById.mockResolvedValue({
            id: 'conv-123',
            channel: 'messenger',
            last_customer_message_at: new Date().toISOString(),
        });
        conversationService.createMessage.mockResolvedValue(failedMessage);
        conversationController._deliverViaMetaIfApplicable.mockResolvedValue({ sent: false, reason_code: 'META_TIMEOUT' });

        await controller.replyConversation({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { message: 'Hello customer!' },
            get: jest.fn(),
        }, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                delivery: expect.objectContaining({ persisted: true, sent: false, state: 'FAILED' }),
                message: expect.objectContaining({ delivery_state: 'FAILED' }),
            }),
        }));
        expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'INBOX_MESSAGE_DELIVERY_FAILED' }));
        expect(AuditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'INBOX_MESSAGE_SENT' }));
    });

    test('rejects reply when message content is missing or whitespace', async () => {
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123', channel: 'web' });

        const req = {
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { message: '   ' },
            get: jest.fn(),
        };

        await controller.replyConversation(req, response(), next);

        expect(conversationService.createMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }));
    });

    test('rejects reply when outside Meta 24-hour messaging window on Facebook/Messenger without message tag', async () => {
        const next = jest.fn();
        const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
        conversationService.getConversationById.mockResolvedValue({
            id: 'conv-123',
            channel: 'messenger',
            last_customer_message_at: thirtyHoursAgo,
        });

        const req = {
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { message: 'Checking in after 30 hours' },
            get: jest.fn(),
        };

        await controller.replyConversation(req, response(), next);

        expect(conversationService.createMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'OUTSIDE_24H_WINDOW',
            status: 422,
        }));
    });

    test('a retired message_tag does NOT bypass the 24h window on the mobile path', async () => {
        const next = jest.fn();
        const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
        conversationService.getConversationById.mockResolvedValue({
            id: 'conv-123',
            channel: 'messenger',
            last_customer_message_at: thirtyHoursAgo,
        });

        const req = {
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            // Meta returns error 100 for POST_PURCHASE_UPDATE since 2026-04-27.
            body: { message: 'Your order has been shipped', message_tag: 'POST_PURCHASE_UPDATE' },
            get: jest.fn(),
        };

        await controller.replyConversation(req, response(), next);

        expect(conversationService.createMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'OUTSIDE_24H_WINDOW',
            status: 422,
        }));
    });

    test('an unrecognized message_tag on an in-window reply is rejected, not silently ignored', async () => {
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({
            id: 'conv-123',
            channel: 'messenger',
            last_customer_message_at: new Date().toISOString(),
        });

        await controller.replyConversation({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { message: 'hello', message_tag: 'MADE_UP_TAG' },
            get: jest.fn(),
        }, response(), next);

        expect(conversationService.createMessage).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MESSAGE_TAG_NOT_ALLOWED',
            status: 422,
        }));
    });

    test('HUMAN_AGENT bypasses the window only when the app holds the Meta permission (flag)', async () => {
        const prev = process.env.META_HUMAN_AGENT_TAG_ENABLED;
        process.env.META_HUMAN_AGENT_TAG_ENABLED = 'true';
        try {
            const res = response();
            const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
            conversationService.getConversationById.mockResolvedValue({
                id: 'conv-123',
                channel: 'messenger',
                last_customer_message_at: thirtyHoursAgo,
            });
            conversationService.createMessage.mockResolvedValue({
                id: 'msg-tagged',
                conversation_id: 'conv-123',
                content: 'Your order has been shipped',
            });
            conversationController._deliverViaMetaIfApplicable.mockResolvedValue({ sent: true });

            await controller.replyConversation({
                params: { conversationId: 'conv-123' },
                shop: { id: 'shop-a' },
                body: { message: 'Your order has been shipped', message_tag: 'HUMAN_AGENT' },
                get: jest.fn(),
            }, res, jest.fn());

            expect(conversationService.createMessage).toHaveBeenCalledWith('conv-123', 'shop-a', expect.objectContaining({
                message_tag: 'HUMAN_AGENT',
            }));
            expect(res.status).toHaveBeenCalledWith(201);
        } finally {
            if (prev === undefined) delete process.env.META_HUMAN_AGENT_TAG_ENABLED;
            else process.env.META_HUMAN_AGENT_TAG_ENABLED = prev;
        }
    });

    test('toggles AI mode to pause and resume', async () => {
        const res1 = response();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123' });

        // Pause
        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'pause' },
        }, res1, jest.fn());

        expect(cacheRedis.setex).toHaveBeenCalledWith('ai:pause:conv-123', 1800, '1');
        expect(conversationService.holdPendingAiCandidates).toHaveBeenCalledWith('conv-123', 'shop-a', 'human_paused');
        expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({ ai_mode: 'paused' }),
        }));

        // Resume
        const res2 = response();
        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'resume' },
        }, res2, jest.fn());

        expect(cacheRedis.del).toHaveBeenCalledWith('ai:pause:conv-123');
        expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({ ai_mode: 'ai_active' }),
        }));
    });

    test('does not report AI paused when Redis cannot persist the pause key', async () => {
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123' });
        cacheRedis.setex.mockRejectedValueOnce(new Error('Redis unavailable'));

        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'pause' },
        }, response(), next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'AI_MODE_UNAVAILABLE',
            status: 503,
        }));
        expect(conversationService.holdPendingAiCandidates).not.toHaveBeenCalled();
        expect(sseManager.emit).not.toHaveBeenCalled();
        expect(AuditLog.create).not.toHaveBeenCalled();
    });

    test('does not report AI resumed when Redis cannot clear the pause key', async () => {
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123' });
        cacheRedis.del.mockRejectedValueOnce(new Error('Redis unavailable'));

        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'resume' },
        }, response(), next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'AI_MODE_UNAVAILABLE',
            status: 503,
        }));
        expect(sseManager.emit).not.toHaveBeenCalled();
        expect(AuditLog.create).not.toHaveBeenCalled();
    });

    test('rolls the pause back when its audit write fails', async () => {
        // IC-V1 review F9: a 503 must not leave AI silently paused — the
        // pause key is deleted so merchant-visible state matches the response.
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123' });
        AuditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'pause' },
        }, response(), next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'AI_MODE_AUDIT_UNAVAILABLE',
            status: 503,
        }));
        expect(cacheRedis.del).toHaveBeenCalledWith('ai:pause:conv-123');
        expect(sseManager.emit).not.toHaveBeenCalled();
    });

    test('rejects setAiMode with invalid mode', async () => {
        const next = jest.fn();
        conversationService.getConversationById.mockResolvedValue({ id: 'conv-123' });

        await controller.setAiMode({
            params: { conversationId: 'conv-123' },
            shop: { id: 'shop-a' },
            body: { mode: 'invalid_mode' },
        }, response(), next);

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }));
    });
});
