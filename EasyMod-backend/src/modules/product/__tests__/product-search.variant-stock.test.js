'use strict';

/**
 * D-P2-02 — variant-level stock is authoritative at the order gate.
 *
 * `checkStock` previously read ONLY product-level quantity/in_stock and ignored
 * `variants[].quantity`, so a specific size could be ordered while its own count
 * was zero. The fix gates on the SELECTED variant's finite quantity and fails
 * CLOSED (no silent product-level substitution) when a selected variant is
 * missing, inactive, stale, or invalid. Product-level stock is used only when no
 * variant is requested — which is what keeps every existing product-level caller
 * byte-for-byte. RED on the unpatched source for the variant cases.
 */

process.env.NODE_ENV = 'test';

jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { query: jest.fn() },
}));

const { sequelize } = require('src/utils/database/database-setup');
const { checkStock } = require('src/modules/product/product-search.service');

const PRODUCT_ID = 'product-1';
const SHOP_ID = 'shop-a';

// A single-product live row. `variantList` populates relational variants;
// `product` fields control the product-level gate.
const rowFor = ({ quantity = 10, track_quantity = true, in_stock = true, is_active = true, variants = [] }) => [{
    id: PRODUCT_ID,
    shop_id: SHOP_ID,
    name: 'Denim Jacket',
    name_bn: null,
    price: '3200.00',
    compare_at_price: null,
    quantity,
    track_quantity,
    in_stock,
    is_active,
    variants: [],
    images: [],
    image_url: null,
    category: null,
    aliases: [],
    ai_category: null,
    product_variants: variants,
}];

const variant = (id, value, quantity, is_active = true) => ({
    id, option_name: 'Size', option_value: value, price: '3300.00', quantity, is_active, attributes: {},
});

beforeEach(() => jest.clearAllMocks());

describe('checkStock — variant authority', () => {
    test('RED/GREEN: a tracked product with product stock 10 but selected XL at 0 cannot be ordered', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-xl', 'XL', 0)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-xl' });
        expect(r.available).toBe(false);
        expect(r.reason).toMatch(/0 unit\(s\) left/);
    });

    test('with NO variant selected the product-level gate still governs (backward compatible)', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-xl', 'XL', 0)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1);
        expect(r.available).toBe(true);
    });

    test('selected variant with sufficient finite quantity is available', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 5)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 3, { variantId: 'variant-m' });
        expect(r.available).toBe(true);
        expect(r.selectedVariant.id).toBe('variant-m');
    });

    test('requested quantity above the variant count fails with the live count', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 5)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 6, { variantId: 'variant-m' });
        expect(r.available).toBe(false);
        expect(r.quantity).toBe(5);
    });

    test('selection by size/color option value resolves the variant quantity', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-xl', 'XL', 0)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { size: 'XL' });
        expect(r.available).toBe(false);
    });

    test('neighbouring shop / unknown variant id fails CLOSED (no product-level fallback)', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 5)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'other-shop-variant-99' });
        expect(r.available).toBe(false);
        expect(r.variant_missing).toBe(true);
    });

    test('stale claim vs current record: product has no variant data for the requested id → closed', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-removed' });
        expect(r.available).toBe(false);
        expect(r.variant_missing).toBe(true);
    });

    test('inactive selected variant is refused', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 5, false)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        expect(r.available).toBe(false);
    });

    test('tracked product with unresolvable variant quantity fails closed (invalid/stale stock)', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', null)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        expect(r.available).toBe(false);
        expect(r.invalid_variant_stock).toBe(true);
    });

    test('non-tracked product honours the existing in_stock semantics, not the variant number', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 0, track_quantity: false, in_stock: true, variants: [variant('variant-m', 'M', 0)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        expect(r.available).toBe(true);
    });

    test('product-level out-of-stock (in_stock=false) blocks even a healthy variant', async () => {
        sequelize.query.mockResolvedValue(rowFor({ quantity: 0, in_stock: false, variants: [variant('variant-m', 'M', 5)] }));
        const r = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        expect(r.available).toBe(false);
    });

    test('concurrent stock change between turns is reflected (live read each call)', async () => {
        sequelize.query
            .mockResolvedValueOnce(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 1)] }))
            .mockResolvedValueOnce(rowFor({ quantity: 10, variants: [variant('variant-m', 'M', 0)] }));
        const first = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        const second = await checkStock(PRODUCT_ID, SHOP_ID, 1, { variantId: 'variant-m' });
        expect(first.available).toBe(true);
        expect(second.available).toBe(false);
    });

    test('missing product still fails', async () => {
        sequelize.query.mockResolvedValue([]);
        const r = await checkStock('nope', SHOP_ID, 1);
        expect(r.available).toBe(false);
    });
});
