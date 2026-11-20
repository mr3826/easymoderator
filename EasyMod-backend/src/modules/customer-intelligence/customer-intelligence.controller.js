'use strict';

const auditService = require('../audit/audit.service');
const { AppError } = require('../../utils/AppError');
const { getPilotFeatures } = require('../pilot-features/pilot-features.service');
const customer360 = require('./customer-360.service');
const opportunityService = require('./opportunity.service');

// Tenant comes from the verified JWT only (req.user.shopId), never from input.
const shopIdOf = (req) => req.user.shopId;

/** Feature gate: the pilot routes answer only for shops with the flag. */
const requireCustomerIntelligence = async (req, res, next) => {
    try {
        const features = await getPilotFeatures(shopIdOf(req));
        if (!features.customerIntelligence) {
            throw new AppError('Customer intelligence is not enabled for this shop', 409, 'FEATURE_DISABLED');
        }
        next();
    } catch (error) {
        next(error);
    }
};

const getStatus = async (req, res, next) => {
    try {
        const features = await getPilotFeatures(shopIdOf(req));
        res.json({
            success: true,
            data: {
                customer_intelligence: features.customerIntelligence,
                order_confidence_mode: features.orderConfidenceMode,
            },
        });
    } catch (error) {
        next(error);
    }
};

const listCustomers = async (req, res, next) => {
    try {
        const result = await customer360.listCustomers(shopIdOf(req), req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
};

const getCustomer = async (req, res, next) => {
    try {
        const data = await customer360.getCustomerDetail(shopIdOf(req), req.params.customerId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const listOpportunities = async (req, res, next) => {
    try {
        const result = await opportunityService.listOpportunities(shopIdOf(req), req.query);
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
};

const opportunitySummary = async (req, res, next) => {
    try {
        const data = await opportunityService.summary(shopIdOf(req), req.query);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const auditOpportunity = (req, action, opportunity, extra = {}) => auditService.logOperation({
    userId: req.user.userId,
    shopId: shopIdOf(req),
    action,
    resourceType: 'CUSTOMER_OPPORTUNITY',
    resourceId: opportunity.id,
    newValues: { status: opportunity.status, ...extra },
    metadata: { customer_id: opportunity.customer_id, endpoint: req.originalUrl },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
});

const markContacted = async (req, res, next) => {
    try {
        const opportunity = await opportunityService.markContacted(
            shopIdOf(req), req.params.opportunityId, req.user.userId,
        );
        await auditOpportunity(req, 'OPPORTUNITY_CONTACTED', opportunity);
        res.json({ success: true, data: opportunityService.serializeOpportunity(opportunity) });
    } catch (error) {
        next(error);
    }
};

const dismissOpportunity = async (req, res, next) => {
    try {
        const opportunity = await opportunityService.dismiss(
            shopIdOf(req), req.params.opportunityId, req.user.userId, req.body.reason,
        );
        await auditOpportunity(req, 'OPPORTUNITY_DISMISSED', opportunity, { reason: req.body.reason });
        res.json({ success: true, data: opportunityService.serializeOpportunity(opportunity) });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    requireCustomerIntelligence,
    getStatus,
    listCustomers,
    getCustomer,
    listOpportunities,
    opportunitySummary,
    markContacted,
    dismissOpportunity,
};
