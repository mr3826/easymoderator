'use strict';

const express = require('express');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { validate } = require('../helpers');
const controller = require('./customer-intelligence.controller');
const schemas = require('./customer-intelligence.validator');

const router = express.Router();

// Every route: verified JWT + active shop membership (sets req.userRole).
router.use(authenticate, verifyShopAccess);

// Always answers, so the dashboard can decide between the pilot and legacy UI.
router.get('/status', controller.getStatus);

router.use(controller.requireCustomerIntelligence);

router.get('/overview', controller.getOverview);
router.get('/customers', validate(schemas.listCustomers), controller.listCustomers);
router.get('/customers/:customerId', validate(schemas.customerParams), controller.getCustomer);
router.get('/opportunities', validate(schemas.listOpportunities), controller.listOpportunities);
router.get('/opportunities/summary', validate(schemas.summary), controller.opportunitySummary);
router.post(
    '/opportunities/:opportunityId/contacted',
    validate(schemas.contactedOpportunity),
    controller.markContacted,
);
router.post(
    '/opportunities/:opportunityId/dismiss',
    validate(schemas.dismissOpportunity),
    controller.dismissOpportunity,
);

module.exports = router;
