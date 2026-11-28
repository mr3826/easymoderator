'use strict';

jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { transaction: jest.fn() },
}));

jest.mock('src/modules/entities', () => ({
    Product: { create: jest.fn(), findOne: jest.fn() },
    ProductVariant: {},
    Category: { findOne: jest.fn() },
    Shop: {},
    UserShop: { findOne: jest.fn() },
}));

jest.mock('src/modules/product/product-media.service', () => ({
    getProductMediaPaths: jest.fn((images, imageUrl) => [
        ...(Array.isArray(images) ? images : []),
        imageUrl,
    ].filter((value) => typeof value === 'string' && value.startsWith('/uploads/product-images/'))),
    removeUnreferencedProductMedia: jest.fn(() => Promise.resolve()),
}));

jest.mock('src/modules/subscription/subscription.service', () => ({
    trackUsage: jest.fn(),
}));
jest.mock('src/modules/product/product-ai.service', () => ({
    queueProductProcessing: jest.fn(),
}));
jest.mock('src/modules/product/product-embedding.service', () => ({
    embedProduct: jest.fn(),
    removeProductEmbedding: jest.fn(),
}));
jest.mock('src/modules/product/clip-client.service', () => ({
    removeProductIndex: jest.fn(),
}));
jest.mock('src/utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        logUsage: jest.fn(),
    })),
}));

const { createProduct } = require('../product.service');
const { Product, UserShop } = require('src/modules/entities');
const { sequelize } = require('src/utils/database/database-setup');
const { removeUnreferencedProductMedia } = require('../product-media.service');

describe('product media persistence compensation', () => {
    const shopId = 'shop-with-failed-product-save';
    const userId = 'user-with-product-access';
    const uploadedPath = `/uploads/product-images/${shopId}/uploaded.png`;

    it('preserves newly uploaded media when create fails so the editor can retry', async () => {
        const transaction = {
            commit: jest.fn(),
            rollback: jest.fn(() => Promise.resolve()),
        };
        sequelize.transaction.mockResolvedValue(transaction);
        UserShop.findOne.mockResolvedValue({ user_id: userId, shop_id: shopId, is_active: true });
        Product.create.mockRejectedValue(new Error('database write failed'));

        await expect(createProduct(userId, shopId, { images: [uploadedPath] }))
            .rejects.toThrow('database write failed');

        expect(transaction.commit).not.toHaveBeenCalled();
        expect(transaction.rollback).toHaveBeenCalledTimes(1);
        expect(removeUnreferencedProductMedia).not.toHaveBeenCalled();
    });

    it('preserves newly uploaded media when update fails so the editor can retry', async () => {
        const product = {
            id: 'product-1',
            shop_id: shopId,
            images: [],
            image_url: null,
            quantity: 0,
            track_quantity: true,
            update: jest.fn().mockRejectedValue(new Error('database write failed')),
        };
        UserShop.findOne.mockResolvedValue({ user_id: userId, shop_id: shopId, is_active: true });
        Product.findOne.mockResolvedValue(product);

        const { updateProduct } = require('../product.service');
        await expect(updateProduct('product-1', userId, shopId, { images: [uploadedPath] }))
            .rejects.toThrow('database write failed');

        expect(product.update).toHaveBeenCalledWith({
            images: [uploadedPath],
            image_url: uploadedPath,
        });
        expect(removeUnreferencedProductMedia).not.toHaveBeenCalled();
    });
});
