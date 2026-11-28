const Joi = require('joi');
const { VALIDATION, PAGINATION } = require('../../constants/http-status');

class ProductValidator {
    createProduct = {
        body: Joi.object({
            name: Joi.string().trim().required().max(VALIDATION.MAX_NAME_LENGTH).messages({
                'string.empty': 'Product name is required',
                'string.max': `Product name must not exceed ${VALIDATION.MAX_NAME_LENGTH} characters`
            }),
            description: Joi.string().trim().allow(null).optional(),
            sku: Joi.string().trim().allow(null).optional().max(VALIDATION.MAX_SKU_LENGTH).messages({
                'string.max': `SKU must not exceed ${VALIDATION.MAX_SKU_LENGTH} characters`
            }),
            category_id: Joi.string().uuid().allow(null).optional().messages({
                'string.uuid': 'Category ID must be a valid UUID'
            }),
            price: Joi.number().positive().required().messages({
                'number.base': 'Price is required',
                'number.positive': 'Price must be a positive number'
            }),
            compare_at_price: Joi.number().positive().optional().messages({
                'number.positive': 'Compare at price must be a positive number'
            }),
            cost_per_item: Joi.number().positive().optional().messages({
                'number.positive': 'Cost per item must be a positive number'
            }),
            track_quantity: Joi.boolean().optional(),
            quantity: Joi.number().integer().min(0).optional().messages({
                'number.min': 'Quantity must be a non-negative integer'
            }),
            allow_backorder: Joi.boolean().optional(),
            low_stock_threshold: Joi.number().integer().min(0).allow(null).optional().messages({
                'number.min': 'Low stock threshold must be a non-negative integer'
            }),
            images: Joi.array().items(Joi.string()).optional(),
            weight: Joi.number().positive().allow(null).optional().messages({
                'number.positive': 'Weight must be a positive number'
            }),
            weight_unit: Joi.string().valid('kg', 'g', 'lb', 'oz').allow(null).optional().messages({
                'any.only': 'Weight unit must be one of: kg, g, lb, oz'
            }),
            is_active: Joi.boolean().optional(),
            is_featured: Joi.boolean().optional(),
            tags: Joi.array().items(Joi.string()).optional(),
            variants: Joi.array().items(Joi.alternatives().try(
                Joi.string().trim().min(1),
                Joi.object({
                    name: Joi.string().trim().required(),
                    options: Joi.array().items(Joi.string().trim().min(1)).required(),
                    price_adjustment: Joi.number().optional(),
                    priceAdjustment: Joi.number().optional(),
                    sku: Joi.string().allow('').optional()
                }),
            )).optional(),
            product_variants: Joi.forbidden(),
            seo_title: Joi.string().trim().optional().max(60),
            seo_description: Joi.string().trim().optional().max(160),
            ai_generated: Joi.boolean().optional(),
            confidence: Joi.number().min(0).max(1).optional(),
            brand: Joi.string().trim().allow(null).optional().max(VALIDATION.MAX_SKU_LENGTH).messages({
                'string.max': `Brand must not exceed ${VALIDATION.MAX_SKU_LENGTH} characters`
            }),
            allow_discounts: Joi.boolean().optional(),
            charge_tax: Joi.boolean().optional(),
            send_low_stock_alert: Joi.boolean().optional(),
            track_quantity: Joi.boolean().optional()
        }).unknown(true)
    };

    updateProduct = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Product ID must be a valid UUID'
            })
        }),
        body: Joi.object({
            name: Joi.string().trim().optional().max(VALIDATION.MAX_NAME_LENGTH).messages({
                'string.max': `Product name must not exceed ${VALIDATION.MAX_NAME_LENGTH} characters`
            }),
            description: Joi.string().trim().allow(null).optional(),
            sku: Joi.string().trim().allow(null).optional().max(VALIDATION.MAX_SKU_LENGTH).messages({
                'string.max': `SKU must not exceed ${VALIDATION.MAX_SKU_LENGTH} characters`
            }),
            category_id: Joi.string().uuid().allow(null).optional().messages({
                'string.uuid': 'Category ID must be a valid UUID'
            }),
            price: Joi.number().positive().optional().messages({
                'number.positive': 'Price must be a positive number'
            }),
            compare_at_price: Joi.number().positive().optional().messages({
                'number.positive': 'Compare at price must be a positive number'
            }),
            cost_per_item: Joi.number().positive().optional().messages({
                'number.positive': 'Cost per item must be a positive number'
            }),
            track_quantity: Joi.boolean().optional(),
            quantity: Joi.number().integer().min(0).optional().messages({
                'number.min': 'Quantity must be a non-negative integer'
            }),
            allow_backorder: Joi.boolean().optional(),
            low_stock_threshold: Joi.number().integer().min(0).allow(null).optional().messages({
                'number.min': 'Low stock threshold must be a non-negative integer'
            }),
            images: Joi.array().items(Joi.string()).optional(),
            weight: Joi.number().positive().allow(null).optional().messages({
                'number.positive': 'Weight must be a positive number'
            }),
            weight_unit: Joi.string().valid('kg', 'g', 'lb', 'oz').allow(null).optional().messages({
                'any.only': 'Weight unit must be one of: kg, g, lb, oz'
            }),
            is_active: Joi.boolean().optional(),
            is_featured: Joi.boolean().optional(),
            tags: Joi.array().items(Joi.string()).optional(),
            variants: Joi.array().items(Joi.alternatives().try(
                Joi.string().trim().min(1),
                Joi.object({
                    name: Joi.string().trim().required(),
                    options: Joi.array().items(Joi.string().trim().min(1)).required(),
                    price_adjustment: Joi.number().optional(),
                    priceAdjustment: Joi.number().optional(),
                    sku: Joi.string().allow('').optional()
                }),
            )).optional(),
            product_variants: Joi.forbidden(),
            seo_title: Joi.string().trim().optional().max(60),
            seo_description: Joi.string().trim().optional().max(160),
            ai_generated: Joi.boolean().optional(),
            confidence: Joi.number().min(0).max(1).optional(),
            brand: Joi.string().trim().allow(null).optional().max(VALIDATION.MAX_SKU_LENGTH).messages({
                'string.max': `Brand must not exceed ${VALIDATION.MAX_SKU_LENGTH} characters`
            }),
            allow_discounts: Joi.boolean().optional(),
            charge_tax: Joi.boolean().optional(),
            send_low_stock_alert: Joi.boolean().optional(),
            track_quantity: Joi.boolean().optional()
        }).unknown(true)
    };

    getProducts = {
        query: Joi.object({
            page: Joi.number().integer().min(1).default(1),
            limit: Joi.number().integer().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
            category_id: Joi.string().uuid().optional(),
            is_active: Joi.boolean().optional(),
            search: Joi.string().trim().optional(),
            min_price: Joi.number().min(0).optional().messages({
                'number.min': 'Minimum price must be non-negative'
            }),
            max_price: Joi.number().min(0).optional().messages({
                'number.min': 'Maximum price must be non-negative'
            }),
            sort_by: Joi.string().valid('name', 'price', 'created_at', 'updated_at').default('created_at'),
            sort_order: Joi.string().valid('asc', 'desc').default('desc')
        })
    };

    getProductById = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Product ID must be a valid UUID'
            })
        })
    };

    deleteProduct = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Product ID must be a valid UUID'
            })
        })
    };

    aiExtract = {
        body: Joi.object({
            filename: Joi.string().trim().optional(),
            content_type: Joi.string().trim().optional(),
            content: Joi.string().trim().required().max(VALIDATION.MAX_CONTENT_LENGTH || 2000000).messages({
                'string.empty': 'Uploaded content is required',
                'string.max': 'Uploaded content exceeds the maximum size'
            })
        })
    };

    // Legacy route validators (for backward compatibility)
    // POST /product/update - expects product_id in body or query
    legacyUpdate = {
        body: Joi.object({
            product_id: Joi.string().uuid().optional(),
            id: Joi.string().uuid().optional(),
            name: Joi.string().trim().optional().max(VALIDATION.MAX_NAME_LENGTH),
            description: Joi.string().trim().optional(),
            price: Joi.number().positive().optional(),
            quantity: Joi.number().integer().min(0).optional(),
            is_active: Joi.boolean().optional()
        }).min(1).messages({
            'object.min': 'At least one field to update is required'
        }),
        query: Joi.object({
            product_id: Joi.string().uuid().optional(),
            id: Joi.string().uuid().optional()
        })
    };

    // POST /product/delete - expects product_id in body or query
    legacyDelete = {
        body: Joi.object({
            product_id: Joi.string().uuid().optional(),
            id: Joi.string().uuid().optional()
        }),
        query: Joi.object({
            product_id: Joi.string().uuid().optional(),
            id: Joi.string().uuid().optional()
        })
    };

    // GET /product/get - expects id in query
    legacyGet = {
        query: Joi.object({
            product_id: Joi.string().uuid().optional(),
            id: Joi.string().uuid().optional()
        })
    };
}

module.exports = new ProductValidator();
