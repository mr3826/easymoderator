'use strict';

const Joi = require('joi');
const { DISMISS_REASONS } = require('./opportunity.service');
const { CUSTOMER_CHANNEL_TYPES } = require('../customer/customer-channels');

const uuid = Joi.string().guid({ version: ['uuidv4', 'uuidv5', 'uuidv1'] }).required();

module.exports = {
    listCustomers: {
        query: Joi.object({
            page: Joi.number().integer().min(1).max(10000).default(1),
            pageSize: Joi.number().integer().min(1).max(50).default(20),
            search: Joi.string().trim().max(100).allow('').default(''),
            phone: Joi.string().trim().max(40).allow('').default(''),
            channel_type: Joi.string().valid(...CUSTOMER_CHANNEL_TYPES).optional(),
            view: Joi.string().valid('all', 'opportunities').default('all'),
        }),
    },
    customerParams: {
        params: Joi.object({ customerId: uuid }),
    },
    listOpportunities: {
        query: Joi.object({
            status: Joi.string().valid('LIVE', 'OPEN', 'ACTIONED', 'CONVERTED', 'DISMISSED', 'EXPIRED').default('LIVE'),
            page: Joi.number().integer().min(1).max(10000).default(1),
            pageSize: Joi.number().integer().min(1).max(50).default(20),
        }),
    },
    opportunityParams: {
        params: Joi.object({ opportunityId: uuid }),
    },
    dismissOpportunity: {
        params: Joi.object({ opportunityId: uuid }),
        body: Joi.object({
            reason: Joi.string().valid(...DISMISS_REASONS).required(),
        }),
    },
    contactedOpportunity: {
        params: Joi.object({ opportunityId: uuid }),
        body: Joi.object({}),
    },
    summary: {
        query: Joi.object({
            days: Joi.number().integer().min(1).max(180).default(30),
        }),
    },
};
