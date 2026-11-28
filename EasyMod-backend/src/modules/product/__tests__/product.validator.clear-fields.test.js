'use strict';

const ProductValidator = require('../product.validator');

describe('product write clear semantics', () => {
    const validator = ProductValidator;
    const nullableFields = {
        description: null,
        sku: null,
        brand: null,
        category_id: null,
        low_stock_threshold: null,
        weight: null,
        weight_unit: null,
        images: [],
        tags: [],
        variants: [],
    };

    it('accepts explicit null clears and empty arrays on create', () => {
        const { error } = validator.createProduct.body.validate({
            name: 'Product',
            price: 10,
            ...nullableFields,
        });

        expect(error).toBeUndefined();
    });

    it('accepts explicit null clears and empty arrays on update', () => {
        const { error } = validator.updateProduct.body.validate(nullableFields);

        expect(error).toBeUndefined();
    });

    it('rejects client patches to authoritative relational variant rows', () => {
        const { error } = validator.updateProduct.body.validate({ product_variants: [] });

        expect(error).toBeDefined();
    });

    it('accepts legacy string variant labels as read-only product metadata', () => {
        expect(validator.createProduct.body.validate({
            name: 'Product',
            price: 10,
            variants: ['Small', 'Large'],
        }).error).toBeUndefined();
        expect(validator.updateProduct.body.validate({ variants: ['Legacy size'] }).error).toBeUndefined();
        expect(validator.updateProduct.body.validate({ variants: [''] }).error).toBeDefined();
    });
});
