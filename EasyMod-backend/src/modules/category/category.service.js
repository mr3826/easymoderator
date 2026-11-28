const { Category, Product, Shop, UserShop } = require('../entities');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { fn, col, literal, Op } = require('sequelize');

/**
 * Verify user has access to shop
 */
const verifyShopAccess = async (userId, shopId) => {
    const userShop = await UserShop.findOne({
        where: {
            user_id: userId,
            shop_id: shopId,
            is_active: true
        }
    });

    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }

    return userShop;
};

/**
 * Create a new category with optional subcategories
 */
const createCategory = async (userId, shopId, categoryData) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    const transaction = await sequelize.transaction();

    try {
        const { subcategories, ...mainCategoryData } = categoryData;

        // Create main category
        const category = await Category.create({
            shop_id: shopId,
            parent_category_id: null,
            ...mainCategoryData
        }, { transaction });

        // Create subcategories if provided
        if (subcategories && subcategories.length > 0) {
            const subcategoryPromises = subcategories.map(subcat =>
                Category.create({
                    shop_id: shopId,
                    parent_category_id: category.id,
                    ...subcat
                }, { transaction })
            );

            await Promise.all(subcategoryPromises);
        }

        await transaction.commit();

        // Fetch the created category with subcategories
        return await getCategoryById(category.id, userId, shopId);
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

/**
 * Update a category and manage subcategories
 */
const updateCategory = async (categoryId, userId, shopId, updateData) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    const transaction = await sequelize.transaction();

    try {
        // Find category
        const category = await Category.findOne({
            where: {
                id: categoryId,
                shop_id: shopId
            }
        });

        if (!category) {
            throw new AppError('Category not found', 404);
        }

        const { subcategories, ...mainCategoryData } = updateData;

        // Update main category
        await category.update(mainCategoryData, { transaction });

        // Handle subcategories if provided
        if (subcategories && Array.isArray(subcategories)) {
            for (const subcat of subcategories) {
                if (subcat.id) {
                    // Update existing subcategory
                    const existingSubcat = await Category.findOne({
                        where: {
                            id: subcat.id,
                            parent_category_id: categoryId,
                            shop_id: shopId
                        }
                    });

                    if (existingSubcat) {
                        await existingSubcat.update(subcat, { transaction });
                    }
                } else {
                    // Create new subcategory
                    await Category.create({
                        shop_id: shopId,
                        parent_category_id: categoryId,
                        ...subcat
                    }, { transaction });
                }
            }
        }

        await transaction.commit();

        // Fetch updated category with subcategories
        return await getCategoryById(categoryId, userId, shopId);
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

/**
 * Delete a category (will cascade delete subcategories)
 */
const deleteCategory = async (categoryId, userId, shopId) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Find category
    const category = await Category.findOne({
        where: {
            id: categoryId,
            shop_id: shopId
        }
    });

    if (!category) {
        throw new AppError('Category not found', 404);
    }

    // Delete category (will cascade to subcategories)
    await category.destroy();

    return { message: 'Category deleted successfully' };
};

/**
 * Get a single category by ID with subcategories
 */
const getCategoryById = async (categoryId, userId, shopId) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    const category = await Category.findOne({
        where: {
            id: categoryId,
            shop_id: shopId
        },
        include: [{
            model: Category,
            as: 'subcategories',
            where: { is_active: true },
            required: false
        }]
    });

    if (!category) {
        throw new AppError('Category not found', 404);
    }

    return category;
};

/**
 * Get a subcategory by ID scoped to a parent category
 */
const getSubcategoryById = async (categoryId, subcategoryId, userId, shopId) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    const subcategory = await Category.findOne({
        where: {
            id: subcategoryId,
            parent_category_id: categoryId,
            shop_id: shopId
        },
        include: [{
            model: Category,
            as: 'subcategories',
            where: { is_active: true },
            required: false
        }]
    });

    if (!subcategory) {
        throw new AppError('Subcategory not found', 404);
    }

    return subcategory;
};

/**
 * List all categories for a shop with hierarchical structure
 */
const listCategories = async (userId, shopId, searchQuery = null, { includeProductCount = false, includeInactive = false } = {}) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Build where clause for search
    const whereClause = {
        shop_id: shopId,
        parent_category_id: null,
    };
    if (!includeInactive) whereClause.is_active = true;

    // Add search filter if provided
    if (searchQuery) {
        const dialect = sequelize.getDialect();
        whereClause.name = {
            [dialect === 'sqlite' ? Op.like : Op.iLike]: `%${searchQuery}%`
        };
    }

    // Get all root categories (no parent) with their subcategories
    const categories = await Category.findAll({
        where: whereClause,
        include: [{
            model: Category,
            as: 'subcategories',
            ...(includeInactive ? {} : { where: { is_active: true } }),
            required: false
        }],
        order: [
            ['created_at', 'DESC'],
            [{ model: Category, as: 'subcategories' }, 'created_at', 'DESC']
        ]
    });

    if (!includeProductCount) return categories;

    const productCounts = await Product.findAll({
        where: { shop_id: shopId },
        attributes: [
            'category_id',
            [fn('SUM', literal('CASE WHEN deleted_at IS NULL AND is_active = true THEN 1 ELSE 0 END')), 'product_count'],
            [fn('COUNT', col('id')), 'affected_product_count'],
        ],
        group: ['category_id'],
        raw: true,
        paranoid: false,
    });
    const countByCategory = new Map(productCounts.map((row) => [
        String(row.category_id), {
            product_count: Number(row.product_count),
            affected_product_count: Number(row.affected_product_count),
        },
    ]));
    const addCount = (category) => {
        const data = category?.toJSON ? category.toJSON() : category;
        const counts = countByCategory.get(String(data.id));
        return {
            ...data,
            product_count: counts?.product_count || 0,
            affected_product_count: counts?.affected_product_count || 0,
        };
    };

    return categories.map((category) => {
        const data = category?.toJSON ? category.toJSON() : category;
        const counts = countByCategory.get(String(data.id));
        return {
            ...data,
            product_count: counts?.product_count || 0,
            affected_product_count: counts?.affected_product_count || 0,
            subcategories: (data.subcategories || []).map(addCount),
        };
    });
};

module.exports = {
    createCategory,
    updateCategory,
    deleteCategory,
    getCategoryById,
    getSubcategoryById,
    listCategories,
    verifyShopAccess
};
