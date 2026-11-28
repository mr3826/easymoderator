const Joi = require('joi');

class CategoryValidator {
    createCategory = {
        body: Joi.object({
            name: Joi.string().trim().required().max(255).messages({
                'string.empty': 'Category name is required',
                'string.max': 'Category name must not exceed 255 characters',
                'any.required': 'Category name is required'
            }),
            description: Joi.string().trim().optional(),
            cover_image: Joi.string().trim().optional(),
            image: Joi.string().trim().optional(),
            is_active: Joi.boolean().optional().messages({
                'boolean.base': 'is_active must be a boolean'
            }),
            subcategories: Joi.array().items(Joi.object({
                name: Joi.string().trim().required().max(255).messages({
                    'string.empty': 'Subcategory name is required',
                    'string.max': 'Subcategory name must not exceed 255 characters',
                    'any.required': 'Subcategory name is required'
                }),
                description: Joi.string().trim().optional(),
                cover_image: Joi.string().trim().optional(),
                image: Joi.string().trim().optional()
            })).optional().messages({
                'array.base': 'Subcategories must be an array'
            })
        })
    };

    updateCategory = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Category ID must be a valid UUID',
                'any.required': 'Category ID is required'
            })
        }),
        body: Joi.object({
            name: Joi.string().trim().optional().max(255).messages({
                'string.max': 'Category name must not exceed 255 characters'
            }),
            description: Joi.string().trim().optional(),
            cover_image: Joi.string().trim().optional(),
            image: Joi.string().trim().optional(),
            is_active: Joi.boolean().optional().messages({
                'boolean.base': 'is_active must be a boolean'
            }),
            subcategories: Joi.array().items(Joi.object({
                id: Joi.string().uuid().optional().messages({
                    'string.uuid': 'Subcategory ID must be a valid UUID'
                }),
                name: Joi.string().trim().required().max(255).messages({
                    'string.empty': 'Subcategory name is required',
                    'string.max': 'Subcategory name must not exceed 255 characters',
                    'any.required': 'Subcategory name is required'
                }),
                description: Joi.string().trim().optional(),
                cover_image: Joi.string().trim().optional(),
                image: Joi.string().trim().optional(),
                is_active: Joi.boolean().optional().messages({
                    'boolean.base': 'Subcategory is_active must be a boolean'
                })
            })).optional().messages({
                'array.base': 'Subcategories must be an array'
            })
        })
    };

    getCategories = {
        query: Joi.object({
            search: Joi.string().trim().optional(),
            include: Joi.string().valid('product_count').optional(),
            include_inactive: Joi.boolean().optional(),
            page: Joi.number().integer().min(1).default(1),
            limit: Joi.number().integer().min(1).max(100).default(20)
        })
    };

    getCategoryById = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Category ID must be a valid UUID',
                'any.required': 'Category ID is required'
            })
        })
    };

    getSubcategoryById = {
        params: Joi.object({
            categoryId: Joi.string().uuid().required().messages({
                'string.uuid': 'Category ID must be a valid UUID',
                'any.required': 'Category ID is required'
            }),
            subcategoryId: Joi.string().uuid().required().messages({
                'string.uuid': 'Subcategory ID must be a valid UUID',
                'any.required': 'Subcategory ID is required'
            })
        })
    };

    deleteCategory = {
        params: Joi.object({
            id: Joi.string().uuid().required().messages({
                'string.uuid': 'Category ID must be a valid UUID',
                'any.required': 'Category ID is required'
            })
        })
    };
}

module.exports = new CategoryValidator();
