const categoryService = require('./category.service');

/**
 * RESTful: Get categories with pagination and filters
 */
const getCategories = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const options = req.query; // Already validated
        const result = await categoryService.listCategories(req.user.userId, shopId, options.search, {
            includeProductCount: options.include === 'product_count',
            includeInactive: options.include_inactive === true,
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get category by ID
 */
const getCategoryById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params; // Already validated
        const category = await categoryService.getCategoryById(id, req.user.userId, shopId);

        res.status(200).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get subcategory by ID scoped to a parent category
 */
const getSubcategoryById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { categoryId, subcategoryId } = req.params;
        const subcategory = await categoryService.getSubcategoryById(
            categoryId,
            subcategoryId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            data: subcategory
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Create category
 */
const createCategoryRest = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const category = await categoryService.createCategory(
            req.user.userId,
            shopId,
            req.body // Already validated
        );

        res.status(201).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Update category by ID
 */
const updateCategoryById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        console.log('Update category payload:', JSON.stringify(req.body, null, 2));

        const { id } = req.params; // Already validated
        const category = await categoryService.updateCategory(
            id,
            req.user.userId,
            shopId,
            req.body // Already validated
        );

        res.status(200).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Delete category by ID
 */
const deleteCategoryById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { id } = req.params; // Already validated
        const result = await categoryService.deleteCategory(
            id,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Create a new category (legacy)
 */
const createCategory = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const category = await categoryService.createCategory(
            req.user.userId,
            shopId,
            req.body // Already validated by Joi
        );

        res.status(201).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update a category (legacy)
 */
const updateCategory = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { categoryId, ...updateData } = req.body;
        const category = await categoryService.updateCategory(
            categoryId,
            req.user.userId,
            shopId,
            updateData
        );

        res.status(200).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a category (legacy)
 */
const deleteCategory = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { categoryId } = req.body;
        const result = await categoryService.deleteCategory(
            categoryId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get a single category (legacy)
 */
const getCategory = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        const { categoryId } = req.query;
        const category = await categoryService.getCategoryById(
            categoryId,
            req.user.userId,
            shopId
        );

        res.status(200).json({
            success: true,
            data: category
        });
    } catch (error) {
        next(error);
    }
};

/**
 * List all categories for the shop (legacy)
 */
const listCategories = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'No shop selected. Please login again.'
                }
            });
        }

        // Get search query from request
        const { search, include } = req.query;

        const categories = await categoryService.listCategories(
            req.user.userId,
            shopId,
            search,
            { includeProductCount: include === 'product_count' }
        );

        res.status(200).json({
            success: true,
            data: categories
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    // RESTful methods
    getCategories,
    getCategoryById,
    getSubcategoryById,
    createCategoryRest,
    updateCategoryById,
    deleteCategoryById,
    // Legacy methods (for backward compatibility)
    createCategory,
    updateCategory,
    deleteCategory,
    getCategory,
    listCategories
};
