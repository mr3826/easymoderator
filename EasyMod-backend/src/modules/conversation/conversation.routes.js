const express = require('express');
const router = express.Router();
const conversationController = require('./conversation.controller');
const conversationValidator = require('./conversation.validator');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { idempotencyMiddleware } = require('../audit/idempotency.middleware');

// All conversation routes require authentication. Billing suspension pauses
// automated AI replies in the worker; the manual inbox must stay usable so
// merchants can read and respond to customers while resolving billing.
router.use(authenticate);
router.use(verifyShopAccess);

// Routes for conversations
router.get(
    '/',
    validate(conversationValidator.getConversations),
    conversationController.getConversations
);

router.get(
    '/history',
    conversationController.getHistory
);

// SSE stream — must be before /:conversationId to avoid param capture.
// Supports Last-Event-ID header for replay on reconnect (handled by
// sseManager.attachToRequest inside the controller). Each emitted event
// includes an "id:" line so the browser can track the last received id.
router.get(
    '/events',
    conversationController.getEventStream
);

// Bug #2: full-history search — must be before /:conversationId
router.get('/search', conversationController.searchConversations);

// B3: Bulk status update — must be before /:conversationId to avoid param capture
router.patch('/bulk-status', conversationController.bulkUpdateStatus);

router.post(
    '/messages/check-duplicate',
    conversationController.checkDuplicate
);

router.post(
    '/',
    validate(conversationValidator.createConversation),
    conversationController.createConversation
);

router.get(
    '/:conversationId',
    conversationController.getConversationById
);

router.patch(
    '/:conversationId',
    validate(conversationValidator.updateConversation),
    conversationController.updateConversation
);

router.put(
    '/:conversationId/status',
    validate(conversationValidator.updateConversationStatus),
    conversationController.updateConversationStatus
);

// Routes for messages within a conversation
router.post(
    '/:conversationId/messages/:messageId/approve',
    verifyShopAccess,
    validate(conversationValidator.approveAiDraft),
    conversationController.approveAiDraft
);

router.post(
    '/:conversationId/messages/:messageId/dismiss',
    verifyShopAccess,
    validate(conversationValidator.conversationMessageAction),
    conversationController.dismissAiDraft
);

router.post(
    '/:conversationId/read',
    verifyShopAccess,
    validate(conversationValidator.markConversationRead),
    conversationController.markConversationRead
);

router.get(
    '/:conversationId/messages',
    validate(conversationValidator.getMessages),
    conversationController.getMessages
);

router.post(
    '/:conversationId/messages',
    idempotencyMiddleware,
    validate(conversationValidator.createMessage),
    conversationController.createMessage
);

router.post(
    '/:conversationId/product-card',
    idempotencyMiddleware,
    validate(conversationValidator.sendProductCard),
    conversationController.sendProductCard
);

module.exports = router;
