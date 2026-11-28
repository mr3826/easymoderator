const Joi = require('joi');

// Channels supported across the entity and external API
const VALID_CHANNELS = ['messenger', 'instagram', 'facebook', 'telegram', 'webchat', 'manual'];
// Channels exposed on the REST/manual-create interface (messenger/instagram are channel-only, not manual)
const REST_CHANNELS = ['facebook', 'telegram', 'webchat', 'manual'];

// Max bytes for the metadata JSON blob (16 KB)
const METADATA_MAX_BYTES = 16 * 1024;

const metadataSchema = Joi.object()
    .max(20)
    .custom((value, helpers) => {
        const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (size > METADATA_MAX_BYTES) {
            return helpers.error('any.invalid', { message: 'Metadata must not exceed 16 KB' });
        }
        return value;
    })
    .optional()
    .messages({ 'any.invalid': 'Metadata must not exceed 16 KB' });

class CustomerValidator {
    static createCustomer = Joi.object({
        name: Joi.string()
            .trim()
            .required()
            .max(255)
            .messages({
                'string.empty': 'Customer name is required',
                'string.max': 'Customer name must not exceed 255 characters',
                'any.required': 'Customer name is required'
            }),

        email: Joi.string()
            .trim()
            .email()
            .max(255)
            .optional()
            .messages({
                'string.email': 'Email must be a valid email address',
                'string.max': 'Email must not exceed 255 characters'
            }),

        number: Joi.string()
            .trim()
            .pattern(/^01[3-9]\d{8}$/)
            .required()
            .messages({
                'string.empty': 'Phone number is required',
                'string.pattern.base': 'Must be a valid Bangladeshi mobile number (e.g. 01712345678)',
                'any.required': 'Phone number is required'
            }),

        channel: Joi.string()
            .trim()
            .required()
            .valid(...REST_CHANNELS)
            .messages({
                'string.empty': 'Channel is required',
                'any.only': `Channel must be one of: ${REST_CHANNELS.join(', ')}`,
                'any.required': 'Channel is required'
            }),

        metadata: metadataSchema
    });

    static updateCustomer = Joi.object({
        customerId: Joi.string()
            .trim()
            .required()
            .uuid()
            .messages({
                'string.empty': 'Customer ID is required',
                'string.uuid': 'Customer ID must be a valid UUID',
                'any.required': 'Customer ID is required'
            }),

        name: Joi.string()
            .trim()
            .optional()
            .max(255)
            .messages({
                'string.empty': 'Customer name cannot be empty',
                'string.max': 'Customer name must not exceed 255 characters'
            }),

        email: Joi.string()
            .trim()
            .email()
            .max(255)
            .allow(null)
            .optional()
            .messages({
                'string.email': 'Email must be a valid email address',
                'string.max': 'Email must not exceed 255 characters'
            }),

        number: Joi.string()
            .trim()
            .pattern(/^01[3-9]\d{8}$/)
            .optional()
            .messages({
                'string.empty': 'Phone number cannot be empty',
                'string.pattern.base': 'Must be a valid Bangladeshi mobile number (e.g. 01712345678)'
            }),

        channel: Joi.string()
            .trim()
            .valid(...REST_CHANNELS)
            .optional()
            .messages({
                'any.only': `Channel must be one of: ${REST_CHANNELS.join(', ')}`
            }),

        metadata: metadataSchema
    });

    static getCustomer = Joi.object({
        customerId: Joi.string()
            .trim()
            .required()
            .uuid()
            .messages({
                'string.empty': 'Customer ID is required',
                'string.uuid': 'Customer ID must be a valid UUID',
                'any.required': 'Customer ID is required'
            })
    });

    static listCustomers = Joi.object({
        search: Joi.string().trim().max(200).optional(),
        email:  Joi.string().trim().max(255).optional(),
        number: Joi.string().trim().optional(),
        phone:  Joi.string().trim().optional(),

        channel_type: Joi.string()
            .valid(...VALID_CHANNELS)
            .optional()
            .messages({ 'any.only': `Channel must be one of: ${VALID_CHANNELS.join(', ')}` }),

        start_date: Joi.date().iso().optional()
            .messages({ 'date.format': 'Start date must be a valid ISO 8601 date' }),
        end_date: Joi.date().iso().optional()
            .messages({ 'date.format': 'End date must be a valid ISO 8601 date' }),

        page:     Joi.number().integer().min(1).optional().default(1),
        pageSize: Joi.number().integer().min(1).max(100).optional().default(20)
    });

    static getCustomerById = Joi.object({
        id: Joi.string()
            .trim()
            .required()
            .uuid()
            .messages({
                'string.empty': 'Customer ID is required',
                'string.uuid': 'Customer ID must be a valid UUID',
                'any.required': 'Customer ID is required'
            })
    });

    static updateCustomerById = Joi.object({
        name: Joi.string()
            .trim()
            .optional()
            .max(255)
            .messages({
                'string.empty': 'Customer name cannot be empty',
                'string.max': 'Customer name must not exceed 255 characters'
            }),

        email: Joi.string()
            .trim()
            .email()
            .max(255)
            .allow(null)
            .optional()
            .messages({
                'string.email': 'Email must be a valid email address',
                'string.max': 'Email must not exceed 255 characters'
            }),

        number: Joi.string()
            .trim()
            .pattern(/^01[3-9]\d{8}$/)
            .optional()
            .messages({
                'string.empty': 'Phone number cannot be empty',
                'string.pattern.base': 'Must be a valid Bangladeshi mobile number (e.g. 01712345678)'
            }),

        channel: Joi.string()
            .trim()
            .valid(...REST_CHANNELS)
            .optional()
            .messages({
                'any.only': `Channel must be one of: ${REST_CHANNELS.join(', ')}`
            }),

        metadata: metadataSchema
    });

    static deleteCustomerById = Joi.object({
        id: Joi.string()
            .trim()
            .required()
            .uuid()
            .messages({
                'string.empty': 'Customer ID is required',
                'string.uuid': 'Customer ID must be a valid UUID',
                'any.required': 'Customer ID is required'
            })
    });

    // External API validators (webhook / channel integrations)
    static createCustomerExternal = Joi.object({
        channel_type: Joi.string()
            .valid(...VALID_CHANNELS)
            .required()
            .messages({
                'any.only': `channel_type must be one of: ${VALID_CHANNELS.join(', ')}`,
                'any.required': 'channel_type is required'
            }),

        channel_user_id: Joi.string().trim().max(255).required()
            .messages({ 'any.required': 'channel_user_id is required' }),

        name: Joi.string().trim().max(255).optional(),
        phone: Joi.string().trim().max(20).optional(),
        language_preference: Joi.string().valid('bangla', 'english', 'banglish').optional(),
        last_active: Joi.date().iso().optional(),
        metadata: metadataSchema
    });

    static getCustomerExternal = Joi.object({
        customerId: Joi.string().trim().uuid().required()
            .messages({
                'string.uuid': 'customerId must be a valid UUID',
                'any.required': 'customerId is required'
            })
    });

    static updateCustomerExternal = Joi.object({
        customerId: Joi.string().trim().uuid().required()
            .messages({
                'string.uuid': 'customerId must be a valid UUID',
                'any.required': 'customerId is required'
            }),

        name: Joi.string().trim().max(255).optional(),
        phone: Joi.string().trim().max(20).optional(),
        language_preference: Joi.string().valid('bangla', 'english', 'banglish').optional(),
        last_active: Joi.date().iso().optional(),
        metadata: metadataSchema
    });
}

module.exports = CustomerValidator;
