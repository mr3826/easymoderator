'use strict';

/**
 * Phase 1 D4 web audit instrumentation on the PRODUCT update path: a change
 * touching stock fields (quantity / track_quantity / variants) writes
 * PRODUCT_STOCK_UPDATED on resource 'product' with mobile-matched vocabulary,
 * BEST-EFFORT ({required:false} + try/catch). An audit failure NEVER changes
 * the update outcome; a non-stock update writes no row.
 */

jest.mock('../../audit/audit.service', () => ({
    logOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const makeProduct = () => ({
    id: 'prod-1',
    shop_id: 'shop-1',
    sku: 'TSHIRT-BLUE-M',
    name: 'Blue T-Shirt',
    price: 750,
    quantity: 10,
    low_stock_threshold: 3,
    track_quantity: true,
    is_active: true,
    images: [],
    image_url: null,
    toJSON() { return { ...this }; },
    async update(data) { Object.assign(this, data); return this; },
});

jest.mock('../../entities', () => ({
    Product: {
        findOne: jest.fn(),
        findAll: jest.fn(),
        findByPk: jest.fn(),
        create: jest.fn(),
        destroy: jest.fn(),
    },
    ProductVariant: { create: jest.fn(), findAll: jest.fn(), destroy: jest.fn() },
    Category: { findOne: jest.fn() },
    Shop: { findByPk: jest.fn() },
    UserShop: {
        findOne: jest.fn().mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', role: 'owner', is_active: true }),
    },
}));

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (cb) => {
            const t = { commit: jest.fn(), rollback: jest.fn() };
            if (typeof cb === 'function') return cb(t);
            return t;
        }),
        Op: {},
    },
}));

jest.mock('sequelize', () => ({
    Op: {
        lt: Symbol('lt'), lte: Symbol('lte'), gte: Symbol('gte'), gt: Symbol('gt'),
        like: Symbol('like'), or: Symbol('or'), and: Symbol('and'), in: Symbol('in'),
        notIn: Symbol('notIn'), ne: Symbol('ne'),
    },
}));

jest.mock('../../subscription/subscription.service', () => ({
    trackUsage: jest.fn().mockResolvedValue(true),
    checkProductLimit: jest.fn().mockResolvedValue(true),
}));

jest.mock('../product-ai.service', () => ({ queueProductProcessing: jest.fn().mockResolvedValue(true) }));
jest.mock('../product-embedding.service', () => ({
    embedProduct: jest.fn().mockResolvedValue(true),
    removeProductEmbedding: jest.fn().mockResolvedValue(true),
}));
jest.mock('../clip-client.service', () => ({ removeProductIndex: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../constants/http-status', () => ({
    HTTP_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403, BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 },
}));

const { Product } = require('../../entities');
const AuditService = require('../../audit/audit.service');
const productService = require('../product.service');

describe('updateProduct stock-change audit instrumentation', () => {
    let product;

    beforeEach(() => {
        jest.clearAllMocks();
        AuditService.logOperation.mockResolvedValue(undefined);
        product = makeProduct();
        Product.findOne.mockResolvedValue(product); // update lookup AND final getProductById
    });

    it('quantity change writes PRODUCT_STOCK_UPDATED with previous/next metadata, required:false', async () => {
        await productService.updateProduct('prod-1', 'user-1', 'shop-1', { quantity: 4 });

        expect(AuditService.logOperation).toHaveBeenCalledTimes(1);
        const [{ userId, shopId, action, resourceType, resourceId, metadata }, options] = AuditService.logOperation.mock.calls[0];
        expect({ userId, shopId, action, resourceType, resourceId }).toEqual({
            userId: 'user-1',
            shopId: 'shop-1',
            action: 'PRODUCT_STOCK_UPDATED',
            resourceType: 'product',
            resourceId: 'prod-1',
        });
        expect(metadata).toEqual(expect.objectContaining({
            source: 'WEB',
            sku: 'TSHIRT-BLUE-M',
            previous_quantity: 10,
            next_quantity: 4,
            previous_track_quantity: true,
            next_track_quantity: true,
        }));
        expect(options).toEqual({ required: false });

        // The update response itself is unchanged (still the persisted row).
        expect(product.quantity).toBe(4);
    });

    it('track_quantity toggle and variants blob writes also count as stock changes', async () => {
        await productService.updateProduct('prod-1', 'user-1', 'shop-1', { track_quantity: false });
        expect(AuditService.logOperation).toHaveBeenCalledTimes(1);

        await productService.updateProduct('prod-1', 'user-1', 'shop-1', { product_variants: [] });
        expect(AuditService.logOperation).toHaveBeenCalledTimes(2);
    });

    it('name/price-only updates write NO stock audit row', async () => {
        await productService.updateProduct('prod-1', 'user-1', 'shop-1', { name: 'New name', price: 900 });
        expect(AuditService.logOperation).not.toHaveBeenCalled();
    });

    it.each([
        ['rejected', () => AuditService.logOperation.mockRejectedValueOnce(new Error('audit db down'))],
        ['thrown synchronously', () => AuditService.logOperation.mockImplementationOnce(() => { throw new Error('boom'); })],
        ['returning a non-promise (undefined)', () => AuditService.logOperation.mockReturnValueOnce(undefined)],
    ])('audit %s NEVER changes the update outcome', (_label, arm) => {
        arm();
        return productService.updateProduct('prod-1', 'user-1', 'shop-1', { quantity: 6 })
            .then((result) => {
                expect(result).toBeTruthy();
                expect(product.quantity).toBe(6);
            });
    });

    it('a FAILED update (product missing) writes no audit row', async () => {
        Product.findOne.mockResolvedValueOnce(null);
        await expect(productService.updateProduct('nope', 'user-1', 'shop-1', { quantity: 3 }))
            .rejects.toThrow();
        expect(AuditService.logOperation).not.toHaveBeenCalled();
    });
});
