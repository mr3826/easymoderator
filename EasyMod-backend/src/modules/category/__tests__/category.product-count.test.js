'use strict';

jest.mock('../../entities', () => ({
    Category: { findAll: jest.fn() },
    Product: { findAll: jest.fn() },
    UserShop: { findOne: jest.fn() },
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { getDialect: jest.fn(() => 'postgres') },
}));

const { Category, Product, UserShop } = require('../../entities');
const { listCategories } = require('../category.service');
const CategoryValidator = require('../category.validator');

describe('category product_count projection', () => {
    const userId = 'user-a';
    const shopId = 'shop-a';
    let categoryRows;

    beforeEach(() => {
        jest.clearAllMocks();
        UserShop.findOne.mockResolvedValue({ user_id: userId, shop_id: shopId, is_active: true });
        const child = { id: 'child-a', name: 'Shirts' };
        categoryRows = [{
            id: 'root-a',
            name: 'Clothing',
            subcategories: [child],
            toJSON: () => ({ id: 'root-a', name: 'Clothing', subcategories: [child] }),
        }];
        Category.findAll.mockResolvedValue(categoryRows);
        Product.findAll.mockResolvedValue([
            { category_id: 'root-a', product_count: '3', affected_product_count: '4' },
            { category_id: 'child-a', product_count: '7', affected_product_count: '9' },
        ]);
    });

    it('accepts only the optional product_count list projection', () => {
        const validator = CategoryValidator;

        expect(validator.getCategories.query.validate({ include: 'product_count' }).error).toBeUndefined();
        expect(validator.getCategories.query.validate({ include: 'all' }).error).toBeDefined();
        expect(validator.getCategories.query.validate({ include_inactive: 'true' }).error).toBeUndefined();
    });

    it('keeps the prior category result shape and avoids product queries by default', async () => {
        const result = await listCategories(userId, shopId);

        expect(result).toBe(categoryRows);
        expect(Product.findAll).not.toHaveBeenCalled();
    });

    it('runs one grouped active count and total linked impact including soft-deleted products', async () => {
        const result = await listCategories(userId, shopId, null, { includeProductCount: true });

        expect(Product.findAll).toHaveBeenCalledTimes(1);
        const options = Product.findAll.mock.calls[0][0];
        expect(options.where).toEqual({ shop_id: shopId });
        expect(options.paranoid).toBe(false);
        expect(options.group).toEqual(['category_id']);
        expect(options.raw).toBe(true);
        expect(options.attributes[0]).toBe('category_id');
        expect(options.attributes[1][0]).toMatchObject({ fn: 'SUM' });
        expect(options.attributes[2][0]).toMatchObject({ fn: 'COUNT' });

        expect(result).toEqual([{
            id: 'root-a',
            name: 'Clothing',
            product_count: 3,
            affected_product_count: 4,
            subcategories: [{ id: 'child-a', name: 'Shirts', product_count: 7, affected_product_count: 9 }],
        }]);
    });

    it('includes inactive roots and children only for the explicit management opt-in', async () => {
        await listCategories(userId, shopId, null, { includeProductCount: true, includeInactive: true });

        const [options] = Category.findAll.mock.calls[0];
        expect(options.where).toEqual({ shop_id: shopId, parent_category_id: null });
        expect(options.include[0]).not.toHaveProperty('where');
    });
});
