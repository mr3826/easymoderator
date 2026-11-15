const Joi = require('joi');

const signupValidator = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .lowercase()
        .required()
        .messages({
            'string.email': 'Please provide a valid email address',
            'any.required': 'Email is required'
        }),
    password: Joi.string()
        .min(8)
        .pattern(/[A-Z]/, 'uppercase')
        .pattern(/[0-9]/, 'digit')
        .pattern(/[^A-Za-z0-9]/, 'special')
        .required()
        .messages({
            'string.min': 'Password must be at least 8 characters long',
            'string.pattern.name': 'Password must contain at least one {{#name}} character',
            'any.required': 'Password is required'
        }),
    full_name: Joi.string()
        .trim()
        .min(2)
        .optional()
        .messages({
            'string.min': 'Full name must be at least 2 characters long'
        }),
    phone: Joi.string()
        .trim()
        .optional(),
    accepted_terms: Joi.boolean()
        .strict()
        .valid(true)
        .required()
        .messages({
            'any.only': 'You must accept the terms and conditions',
            'any.required': 'You must accept the terms and conditions'
        }),
    // Marketing acquisition attribution from landing CTAs. Bounded URL-safe
    // slugs only; stored as analytics/lead metadata, never used in queries.
    source: Joi.string()
        .trim()
        .lowercase()
        .pattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)
        .optional()
        .messages({ 'string.pattern.base': 'source must be a short URL-safe slug' }),
    offer: Joi.string()
        .trim()
        .lowercase()
        .pattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)
        .optional()
        .messages({ 'string.pattern.base': 'offer must be a short URL-safe slug' })
});

const signinValidator = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .lowercase()
        .required()
        .messages({
            'string.email': 'Please provide a valid email address',
            'any.required': 'Email is required'
        }),
    password: Joi.string()
        .required()
        .messages({
            'any.required': 'Password is required',
            'string.empty': 'Password is required'
        })
});

const refreshTokenValidator = Joi.object({
    refresh_token: Joi.string()
        .optional()
        .messages({
            'string.empty': 'Refresh token cannot be empty'
        })
});

const forgotPasswordValidator = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .lowercase()
        .required()
        .messages({
            'string.email': 'Please provide a valid email address',
            'any.required': 'Email is required'
        })
});

const resetPasswordValidator = Joi.object({
    token: Joi.string()
        .required()
        .messages({
            'any.required': 'Reset token is required',
            'string.empty': 'Reset token is required'
        }),
    password: Joi.string()
        .min(8)
        .pattern(/[A-Z]/, 'uppercase')
        .pattern(/[0-9]/, 'digit')
        .pattern(/[^A-Za-z0-9]/, 'special')
        .required()
        .messages({
            'string.min': 'Password must be at least 8 characters long',
            'string.pattern.name': 'Password must contain at least one {{#name}} character',
            'any.required': 'Password is required'
    })
});

const changePasswordValidator = Joi.object({
    currentPassword: Joi.string()
        .required()
        .messages({
            'any.required': 'Current password is required',
            'string.empty': 'Current password is required'
        }),
    newPassword: Joi.string()
        .min(8)
        .pattern(/[A-Z]/, 'uppercase')
        .pattern(/[0-9]/, 'digit')
        .pattern(/[^A-Za-z0-9]/, 'special')
        .required()
        .messages({
            'string.min': 'Password must be at least 8 characters long',
            'string.pattern.name': 'Password must contain at least one {{#name}} character',
            'any.required': 'New password is required'
        })
}).unknown(false);

module.exports = {
    signupValidator,
    signinValidator,
    refreshTokenValidator,
    forgotPasswordValidator,
    resetPasswordValidator,
    changePasswordValidator
};
