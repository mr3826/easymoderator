const Joi = require('joi');

class ConversationValidator {
    getConversations = {
        query: Joi.object({
            page: Joi.number().integer().min(1).default(1),
            limit: Joi.number().integer().min(1).max(100).default(20),
            status: Joi.string().valid('active', 'closed', 'archived'),
            channel: Joi.string().valid('telegram', 'messenger', 'instagram', 'web', 'webchat'),
            // MW-V1: verified-association filter used by the inbox context panel
            // and Order→Inbox link. Service applies it INSIDE the JWT shop scope
            // (whereClause { shop_id, customer_id }); typed here because the
            // module-level helpers validator rejects unknown query keys.
            customer_id: Joi.string().uuid()
        })
    };

    getMessages = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required()
        }),
        query: Joi.object({
            page: Joi.number().integer().min(1).default(1),
            limit: Joi.number().integer().min(1).max(100).default(50)
        })
    };

    conversationMessageAction = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required(),
            messageId: Joi.string().uuid().required(),
        }),
    };

    approveAiDraft = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required(),
            messageId: Joi.string().uuid().required(),
        }),
        body: Joi.object({
            content: Joi.string().trim().max(4000).optional(),
        }),
    };

    markConversationRead = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required(),
        }),
        body: Joi.object({
            message_id: Joi.string().uuid().required(),
        }),
    };

    createConversation = {
        body: Joi.object({
            customer_id: Joi.string().uuid().required(),
            channel: Joi.string().valid('telegram', 'messenger', 'instagram', 'web', 'webchat').optional(),
            channel_type: Joi.string().valid('telegram', 'messenger', 'instagram', 'web', 'webchat').optional(),
            role: Joi.string().valid('user', 'assistant', 'system').default('user'),
            message: Joi.string().required(),
            title: Joi.string().max(255),
            status: Joi.string().valid('active', 'closed', 'archived').default('active'),
            intent: Joi.string().max(50).optional(),
            intent_confidence: Joi.number().min(0).max(1).optional(),
            normalized_message: Joi.string().optional(),
            entities: Joi.object().optional(),
            response_metadata: Joi.object().optional(),
            metadata: Joi.object()
        }).or('channel', 'channel_type')
    };

    createMessage = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required()
        }),
        body: Joi.object({
            content: Joi.string().required(),
            sender: Joi.string().valid('customer', 'agent', 'ai').required(),
            message_type: Joi.string().valid('text', 'image', 'file', 'location').default('text'),
            metadata: Joi.object(),
            ai_suggestion: Joi.string(),
            ai_confidence: Joi.number().min(0).max(1),
            message_tag: Joi.any().forbidden().messages({
                'any.unknown': 'Legacy Messenger message tags are disabled for the BD launch'
            })
        })
    };

    updateConversation = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required()
        }),
        body: Joi.object({
            hitl: Joi.boolean(),
            status: Joi.string().valid('active', 'closed', 'archived'),
            assignee_id: Joi.string().uuid().allow(null),
            resolution_note: Joi.string().max(1000).allow('', null),
            last_seen_message_id: Joi.string().uuid().allow(null),
            // MW-V1 D1: privileged manager escalation must be expressible over
            // HTTP. The service honors force ONLY for owner/admin actors; staff
            // sending it is inert (conversation-ownership tests pin this).
            force: Joi.boolean(),
            // ADR-0013 §8: merchant-facing takeover reason. Applies only with
            // hitl:true; ignored otherwise. Fixed list — never free text.
            handoff_reason: Joi.string().valid(
                'manual_takeover',
                'customer_request',
                'phone_call',
                'order_issue',
                'other',
            )
        }).min(1)
    };

    updateConversationStatus = {
        params: Joi.object({
            conversationId: Joi.string().uuid().required()
        }),
        body: Joi.object({
            status: Joi.string().valid('active', 'closed', 'archived').required()
        })
    };
}

module.exports = new ConversationValidator();
