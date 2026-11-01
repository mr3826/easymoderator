'use strict';

const Joi = require('joi');

const UUID = Joi.string().uuid();
const slug = Joi.string().trim().lowercase().min(2).max(80)
    .pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

const storeFields = {
    title: Joi.string().trim().min(1).max(160),
    description: Joi.string().trim().max(3000).allow('', null),
    logo_url: Joi.string().uri({ scheme: ['http', 'https'] }).max(2048).allow('', null),
    slug,
};

const checkoutItem = Joi.object({
    product_id: UUID.required(),
    variant_id: UUID.optional(),
    quantity: Joi.number().integer().min(1).max(99).required(),
    // These client fields are deliberately discarded; the order authority reads live catalog prices.
    price: Joi.any().strip(),
    total: Joi.any().strip(),
}).unknown(false);

module.exports = {
    create: {
        body: Joi.object({
            ...storeFields,
            title: storeFields.title.required(),
        }).unknown(false),
    },
    update: {
        body: Joi.object(storeFields).min(1).unknown(false),
    },
    settings: {
        body: Joi.object({
            delivery_fee: Joi.number().min(0).max(50000),
            delivery_note: Joi.string().trim().max(250).allow('', null),
        }).min(1).unknown(false),
    },
    products: {
        body: Joi.object({
            selected_products: Joi.array().max(100).items(Joi.object({
                product_id: UUID.required(),
                variant_ids: Joi.array().max(100).unique().items(UUID).optional(),
            }).unknown(false)).unique('product_id').required(),
        }).unknown(false),
    },
    slug: {
        params: Joi.object({ slug: Joi.string().trim().lowercase().min(2).max(80).pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).required() }),
    },
    checkout: {
        params: Joi.object({ slug: Joi.string().trim().lowercase().min(2).max(80).pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).required() }),
        body: Joi.object({
            customer_name: Joi.string().trim().min(1).max(100).required(),
            customer_phone: Joi.string().trim().pattern(/^01[3-9]\d{8}$/).required(),
            delivery_address: Joi.object({
                division: Joi.string().trim().max(100).allow('').optional(),
                district: Joi.string().trim().min(1).max(100).required(),
                upazila: Joi.string().trim().max(100).allow('').optional(),
                street_address: Joi.string().trim().min(5).max(500).required(),
                zone: Joi.string().trim().max(50).allow('').optional(),
            }).unknown(false).required(),
            consent: Joi.boolean().valid(true).required(),
            items: Joi.array().min(1).max(50).items(checkoutItem).required(),
            shop_id: Joi.any().forbidden(),
            customer_id: Joi.any().forbidden(),
        }).unknown(false),
    },
};
