const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const { param, query, validationResult } = require('express-validator');
const NotificationController = require('./notification.controller');
const pushSubscriptionRoutes = require('./push-subscription.routes');
const telegramNotificationRoutes = require('./telegram-notification.routes');
const { authenticate } = require('../../middleware/auth.middleware');
const { OwnerNotification, UserShop } = require('../entities');
const ownerNotificationService = require('./owner-notification.service');
const { AppError } = require('../../utils/AppError');

const router = express.Router();

// Every notification action reads or mutates tenant data.
router.use(authenticate);
const paymentActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});

router.post(
    '/payment-confirmation/:notificationId/:action',
    paymentActionLimiter,
    [
        param('notificationId').isUUID().withMessage('notificationId must be a UUID'),
        param('action').isIn(['approve', 'reject']).withMessage('Invalid action'),
    ],
    async (req, res, next) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ success: false, errors: errors.array() });
            }
            const notification = await OwnerNotification.findByPk(req.params.notificationId, {
                attributes: ['id', 'shop_id'],
            });
            if (!notification) throw new AppError('Notification not found', 404);
            if (req.user?.shopId !== notification.shop_id) {
                throw new AppError('Payment confirmation belongs to another shop', 403);
            }
            const membership = await UserShop.findOne({
                where: {
                    user_id: req.user.userId,
                    shop_id: notification.shop_id,
                    role: 'owner',
                    is_active: true,
                },
            });
            if (!membership) throw new AppError('Active shop owner access is required', 403);

            const result = await ownerNotificationService.handleOwnerResponse(
                notification.id,
                req.params.action,
                { userId: req.user.userId },
            );
            return res.status(200).json(result);
        } catch (err) {
            return next(err);
        }
    },
);

// Push subscription management (register / unregister device tokens)
router.use(pushSubscriptionRoutes);
router.use('/telegram', telegramNotificationRoutes);

router.get(
    '/in-app',
    [query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit must be 1-50')],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ success: false, errors: errors.array() });
            }

            const shopId = req.user?.shopId || req.shopId;
            const limit = Number(req.query.limit || 20);
            // F3/D-4 (2026-11-26): the list read goes through the service so the
            // expiry writer runs on read — past-expiry payment confirmations
            // surface as 'expired', never a stale 'pending', and remain
            // actionable (owner judgment outranks the SLA; D-4 ratified).
            const notifications = await ownerNotificationService.listShopNotifications(shopId, { limit });

            res.json({ success: true, data: notifications });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to load notifications' });
        }
    }
);

router.patch(
    '/in-app/:id/read',
    [param('id').isUUID().withMessage('id must be a UUID')],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ success: false, errors: errors.array() });
            }

            const shopId = req.user?.shopId || req.shopId;
            const notification = await OwnerNotification.findOne({
                where: { id: req.params.id, shop_id: shopId },
                attributes: ['id', 'type'],
            });
            if (!notification) {
                return res.status(404).json({ success: false, error: 'Notification not found' });
            }
            if (notification.type === 'payment_confirmation') {
                return res.status(409).json({
                    success: false,
                    error: 'Payment confirmations require an explicit owner action',
                });
            }
            await notification.update({ status: 'completed', responded_at: new Date() });

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to update notification' });
        }
    }
);

// Validation middleware
const validateMarkHandoff = [
    body('shop_id').optional().isUUID().withMessage('shop_id must be a UUID'),
    body('customer_id').notEmpty().withMessage('customer_id is required'),
    body('platform').isIn(['messenger']).withMessage('Invalid platform'),
    body('trigger_reason').notEmpty().withMessage('trigger_reason is required'),
    body('confidence_score').isInt({ min: 0, max: 100 }).withMessage('confidence_score must be 0-100'),
    body('last_message').optional().isString()
];

const validatePushNotification = [
    body('shop_id').optional().isUUID().withMessage('shop_id must be a UUID'),
    body('type').notEmpty().withMessage('type is required'),
    body('title').notEmpty().withMessage('title is required'),
    body('body').notEmpty().withMessage('body is required'),
    body('data').optional().isObject()
];

// Routes

/**
 * POST /api/notifications/mark-handoff
 * Mark conversation as needing human intervention
 */
router.post('/mark-handoff', validateMarkHandoff, NotificationController.markHandoff);

/**
 * POST /api/notifications/push
 * Send push notification to shop owner
 */
router.post('/push', validatePushNotification, NotificationController.sendPush);

module.exports = router;
