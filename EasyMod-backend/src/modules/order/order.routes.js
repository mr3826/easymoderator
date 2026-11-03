const express = require('express');
const orderController = require('./order.controller');
const orderValidator = require('./order.validator');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwnerOrAdmin } = require('../../middleware/shop-permission.middleware');

const router = express.Router();

// All order routes require authentication
router.use(authenticate);
router.use(verifyShopAccess);

const requireOwnerForPaymentCorrection = (req, res, next) => {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'payment_method')
        || Object.prototype.hasOwnProperty.call(body, 'payment_status')) {
        return requireOwnerOrAdmin(req, res, next);
    }
    return next();
};

// Legacy routes (for backward compatibility)
// Keep static legacy paths before parameterized routes to avoid route shadowing.
router.get('/list', validate(orderValidator.getOrders), orderController.listOrders);
router.get('/get', validate(orderValidator.legacyGet), orderController.getOrder);
router.post('/create', validate(orderValidator.createOrder), orderController.createOrder);
router.post('/update', validate(orderValidator.legacyUpdate), requireOwnerForPaymentCorrection, orderController.updateOrder);
router.post('/delete', validate(orderValidator.legacyDelete), orderController.deleteOrder);

// Additional routes
router.post('/draft', validate(orderValidator.createOrder), orderController.createDraftOrder);
router.post('/confirm', validate(orderValidator.confirmOrder), orderController.confirmOrder);

// Bug #7: bulk order creation — must be before /:id to avoid param capture
router.post('/bulk', orderController.bulkCreateOrders);

// D3: Return requests — static path must be before /:id to avoid param capture
router.get('/returns', orderController.getReturnRequests);

// RESTful routes
router.get('/', validate(orderValidator.getOrders), orderController.getOrders);
router.get('/by-customer/:customerId', orderController.getOrdersByCustomer);
router.get('/:id', validate(orderValidator.getOrderById), orderController.getOrderById);
router.post('/', validate(orderValidator.createOrder), orderController.createOrderRest);
router.post('/:orderId/confirm', orderController.confirmOrder);
router.patch('/:id', validate(orderValidator.updateOrder), requireOwnerForPaymentCorrection, orderController.updateOrderById);
router.post('/:orderId/cancel', orderController.cancelOrder);
router.patch('/:orderId/cancel', orderController.cancelOrder);
router.post('/:orderId/return-request', orderController.createReturnRequest);
// Courier booking
router.get('/:orderId/courier/eligibility', orderController.getCourierEligibility);
router.post('/:orderId/courier', orderController.bookCourier);
router.post('/:orderId/book-courier', orderController.bookCourier);
// D3: Return automation endpoints
router.post('/:orderId/return', orderController.initiateReturn);
router.patch('/:orderId/return/status', orderController.updateReturnStatus);
router.delete('/:id', validate(orderValidator.deleteOrder), orderController.deleteOrderById);

module.exports = router;
