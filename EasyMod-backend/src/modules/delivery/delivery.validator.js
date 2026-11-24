const Joi = require('joi');
const { PROVIDER_NAMES } = require('./providers/provider.registry');

const PROVIDER_LIST = PROVIDER_NAMES.join(', ');

/**
 * Joi schemas for delivery settings
 */
const deliveryValidators = {
    /**
     * Validate connect provider request
     */
    connectProvider: Joi.object({
        provider: Joi.string()
            .valid(...PROVIDER_NAMES)
            .required()
            .messages({
                'any.only': `Provider must be one of: ${PROVIDER_LIST}`,
                'any.required': 'Provider is required'
            }),
        credentials: Joi.object({
            // Pathao-specific fields
            client_id: Joi.string().when('/provider', {
                is: 'pathao',
                then: Joi.required().messages({ 'any.required': 'Client ID is required for Pathao' }),
                otherwise: Joi.optional()
            }),
            client_secret: Joi.string().when('/provider', {
                is: 'pathao',
                then: Joi.required().messages({ 'any.required': 'Client Secret is required for Pathao' }),
                otherwise: Joi.optional()
            }),
            username: Joi.string().when('/provider', {
                is: 'pathao',
                then: Joi.string().email({ tlds: { allow: false } }).required().messages({
                    'string.email': 'Valid email is required for Pathao username',
                    'any.required': 'Valid email is required for Pathao username'
                }),
                otherwise: Joi.optional()
            }),
            password: Joi.string().when('/provider', {
                is: 'pathao',
                then: Joi.required().messages({ 'any.required': 'Password is required for Pathao' }),
                otherwise: Joi.optional()
            }),
            // API-key based provider fields
            api_key: Joi.string().trim().when('/provider', {
                is: 'redx',
                then: Joi.required().messages({
                    'string.empty': 'API Key is required for RedX',
                    'any.required': 'API Key is required for RedX'
                }),
                otherwise: Joi.when('/provider', {
                    is: 'steadfast',
                    then: Joi.required().messages({
                        'any.required': 'API Key is required for Steadfast'
                    }),
                    otherwise: Joi.optional()
                })
            }),
            secret_key: Joi.string().when('/provider', {
                is: 'steadfast',
                then: Joi.required().messages({ 'any.required': 'Secret Key is required for Steadfast' }),
                otherwise: Joi.optional()
            })
        })
            .required()
            .messages({
                'object.base': 'Credentials must be an object',
                'any.required': 'Credentials are required'
            }),
        is_sandbox: Joi.boolean()
            .optional()
            .messages({
                'boolean.base': 'is_sandbox must be a boolean'
            }),
        metadata: Joi.object()
            .optional()
            .messages({
                'object.base': 'Metadata must be an object'
            })
    }),

    /**
     * Validate disconnect provider request
     */
    disconnectProvider: Joi.object({
        provider: Joi.string()
            .valid(...PROVIDER_NAMES)
            .required()
            .messages({
                'any.only': `Provider must be one of: ${PROVIDER_LIST}`,
                'any.required': 'Provider is required'
            })
    }),

    /**
     * Validate toggle provider request
     */
    toggleProvider: Joi.object({
        provider: Joi.string()
            .valid(...PROVIDER_NAMES)
            .required()
            .messages({
                'any.only': `Provider must be one of: ${PROVIDER_LIST}`,
                'any.required': 'Provider is required'
            }),
        is_active: Joi.boolean()
            .optional()
            .messages({
                'boolean.base': 'is_active must be a boolean'
            }),
        isActive: Joi.boolean()
            .optional()
            .messages({
                'boolean.base': 'isActive must be a boolean'
            })
    })
        .or('is_active', 'isActive')
        .custom((value) => {
            const normalized = {
                ...value,
                is_active: value.is_active ?? value.isActive
            };
            delete normalized.isActive;
            return normalized;
        })
        .messages({
            'object.missing': 'is_active is required'
        }),

    /**
     * Validate metadata update request
     */
    updateMetadata: Joi.object({
        metadata: Joi.object({
            store_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            stores: Joi.array()
                .max(100)
                .items(
                    Joi.object({
                        store_id: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
                        store_name: Joi.string().allow('', null).optional()
                    }).unknown(true)
                )
                .optional(),
            balance: Joi.number().min(0).optional(),
            pickup_store_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            provider_store_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            pickup_location_id: Joi.string().uuid().optional(),
            city_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            zone_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            area_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
            delivery_area: Joi.string().max(255).optional(),
            delivery_area_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional()
        })
            .max(20)
            .required()
            .messages({
                'object.base': 'metadata must be an object',
                'any.required': 'metadata is required'
            })
    }),

    /**
     * Validate update delivery settings request
     */
    updateSettings: Joi.object({
        default_delivery_charge: Joi.number()
            .optional()
            .messages({
                'number.base': 'default_delivery_charge must be a number'
            }),
        cod_enabled: Joi.boolean()
            .optional()
            .messages({
                'boolean.base': 'cod_enabled must be a boolean'
            }),
        cod_charge: Joi.number()
            .optional()
            .messages({
                'number.base': 'cod_charge must be a number'
            }),
        non_refundable: Joi.boolean()
            .optional()
            .messages({
                'boolean.base': 'non_refundable must be a boolean'
            }),
        area_pricing: Joi.array()
            .items(
                Joi.object({
                    zone: Joi.string()
                        .valid('inside_dhaka', 'sub_dhaka', 'outside_dhaka')
                        .required()
                        .messages({
                            'any.only': 'area_pricing.zone must be inside_dhaka, sub_dhaka, or outside_dhaka'
                        }),
                    charge: Joi.number()
                        .min(0)
                        .optional()
                        .messages({
                            'number.base': 'area_pricing.charge must be a number',
                            'number.min': 'Delivery charge must be non-negative'
                        }),
                    cod_enabled: Joi.boolean()
                        .optional()
                        .messages({
                            'boolean.base': 'area_pricing.cod_enabled must be a boolean'
                        })
                })
            )
            .optional()
            // Overlapping zone validation
            .custom((areaPricing, helpers) => {
                const seenZones = new Set();
                for (const entry of areaPricing) {
                    if (seenZones.has(entry.zone)) {
                        return helpers.error('any.invalid', { message: 'Overlapping delivery zones detected' });
                    }
                    seenZones.add(entry.zone);
                }
                return areaPricing;
            })
            .messages({
                'array.base': 'area_pricing must be an array',
                'any.invalid': 'Overlapping delivery zones detected'
            }),
        weight_tiers: Joi.array()
            .items(
                Joi.object({
                    from_kg: Joi.number()
                        .min(0)
                        .required()
                        .messages({
                            'number.base': 'weight_tiers.from_kg must be a number'
                        }),
                    to_kg: Joi.number()
                        .min(0)
                        .required()
                        .messages({
                            'number.base': 'weight_tiers.to_kg must be a number'
                        }),
                    extra_charge: Joi.number()
                        .min(0)
                        .required()
                        .messages({
                            'number.base': 'weight_tiers.extra_charge must be a number'
                        })
                })
            )
            .optional()
            .custom((tiers, helpers) => {
                const sorted = [...tiers].sort((a, b) => a.from_kg - b.from_kg);

                for (let i = 0; i < sorted.length; i += 1) {
                    const tier = sorted[i];
                    if (tier.from_kg >= tier.to_kg) {
                        return helpers.error('any.invalid', { message: 'weight_tiers.from_kg must be less than weight_tiers.to_kg' });
                    }

                    if (i > 0) {
                        const previous = sorted[i - 1];
                        if (tier.from_kg < previous.to_kg) {
                            return helpers.error('any.invalid', { message: 'weight_tiers must not overlap' });
                        }
                    }
                }

                return tiers;
            })
            .messages({
                'array.base': 'weight_tiers must be an array',
                'any.invalid': 'Invalid weight tier configuration'
            })
    }),

    activateProvider: Joi.object({
        provider: Joi.string().valid(...PROVIDER_NAMES).required()
    }),

    deactivateProvider: Joi.object({
        provider: Joi.string().valid(...PROVIDER_NAMES).required()
    }),

    setAiDefaultProvider: Joi.object({
        provider: Joi.string().valid(...PROVIDER_NAMES).required()
    }),

    pickupLocation: Joi.object({
        display_name: Joi.string().trim().max(255).required(),
        contact_name: Joi.string().trim().max(255).required(),
        phone: Joi.string().trim().max(50).required(),
        secondary_phone: Joi.string().trim().max(50).allow('', null).optional(),
        address: Joi.string().trim().max(2000).required(),
        city_name: Joi.string().trim().max(255).allow('', null).optional(),
        zone_name: Joi.string().trim().max(255).allow('', null).optional(),
        area_name: Joi.string().trim().max(255).allow('', null).optional(),
        postal_code: Joi.string().trim().max(20).allow('', null).optional(),
        is_default: Joi.boolean().optional()
    }),

    /** Route params whitelist for every /:provider/... mutation path. */
    providerParams: Joi.object({
        provider: Joi.string()
            .valid(...PROVIDER_NAMES)
            .required()
            .messages({
                'any.only': `Provider must be one of: ${PROVIDER_LIST}`,
                'any.required': 'Provider is required'
            })
    }),

    /**
     * Merchant-confirmed external pickup store creation. `confirm` stays
     * optional at the schema level on purpose: without it the controller
     * answers the 409 confirmation contract instead of a bare validation
     * error, so the UI can show exactly what will be created.
     */
    createProviderStore: Joi.object({
        confirm: Joi.boolean().optional(),
        name: Joi.string().trim().min(2).max(255).required().messages({
            'any.required': 'Pickup store name is required',
            'string.min': 'Pickup store name must be at least 2 characters',
            'string.max': 'Pickup store name must be at most 255 characters'
        }),
        address: Joi.string().trim().min(3).max(2000).required().messages({
            'any.required': 'Pickup store address is required',
            'string.min': 'Pickup store address must be at least 3 characters',
            'string.max': 'Pickup store address must be at most 2000 characters'
        }),
        contact_name: Joi.string().trim().max(255).optional(),
        phone: Joi.string().trim().max(32).allow('', null).optional().messages({
            'string.max': 'phone must be at most 32 characters'
        }),
        city_id: Joi.alternatives().try(Joi.number().integer().min(0), Joi.string().max(64)).optional(),
        zone_id: Joi.alternatives().try(Joi.number().integer().min(0), Joi.string().max(64)).optional(),
        area_id: Joi.alternatives().try(Joi.number().integer().min(0), Joi.string().max(64)).optional(),
        enabled: Joi.boolean().optional()
    }),

    /** DELETE /pickup-locations/:id?... — confirm=true after the 409 blockers payload. */
    pickupDeleteQuery: Joi.object({
        confirm: Joi.boolean().truthy('true').falsy('false').optional()
    })
};

module.exports = {
    deliveryValidators
};
