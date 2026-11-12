'use strict';

const mockStorefront = {
    findOne: jest.fn(),
    create: jest.fn(),
};
const mockStorefrontProduct = {
    findAll: jest.fn(),
    destroy: jest.fn(),
    bulkCreate: jest.fn(),
};
const mockShop = { findByPk: jest.fn() };
const mockProduct = { findAll: jest.fn() };
const mockProductVariant = { findAll: jest.fn() };
const mockCreateStorefrontCodOrder = jest.fn();

jest.mock('./storefront.entity', () => ({ Storefront: mockStorefront, StorefrontProduct: mockStorefrontProduct }));
jest.mock('../entities', () => ({ Shop: mockShop, Product: mockProduct, ProductVariant: mockProductVariant }));
jest.mock('../order/order.service', () => ({ createStorefrontCodOrder: mockCreateStorefrontCodOrder }));
jest.mock('../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } })),
    },
}));
jest.mock('sequelize', () => ({ Op: { in: Symbol.for('sequelize.op.in') } }));

const service = require('./storefront.service');
const validator = require('./storefront.validator');

const PRODUCT_A = '0194f3aa-9d2c-7abc-8def-0123456789ab';
const PRODUCT_B = '0194f3aa-9d2c-7abc-8def-0123456789cd';
const PRODUCT_A_VARIANT = '0194f3aa-9d2c-7abc-8def-0123456789ef';
const VARIANT_A1 = '0194f3aa-9d2c-7abc-8def-1123456789a1';
const VARIANT_A2 = '0194f3aa-9d2c-7abc-8def-1123456789a2';

const storefrontA = {
    id: 'store-a', shop_id: 'shop-a', slug: 'shop-a-71c3', title: 'A Shop',
    description: null, logo_url: null, settings: { delivery_fee: 40 }, is_published: true,
};
const storefrontB = {
    id: 'store-b', shop_id: 'shop-b', slug: 'shop-b-280e', title: 'B Shop',
    description: null, logo_url: null, settings: { delivery_fee: 0 }, is_published: true,
};
const products = [
    { id: PRODUCT_A, shop_id: 'shop-a', name: 'A Product', price: '100.00', is_active: true, in_stock: true, sku: 'PRIVATE-A', quantity: 9 },
    { id: PRODUCT_B, shop_id: 'shop-b', name: 'B Product', price: '200.00', is_active: true, in_stock: true, sku: 'PRIVATE-B', quantity: 5 },
    { id: PRODUCT_A_VARIANT, shop_id: 'shop-a', name: 'Variant Product', price: '50.00', is_active: true, in_stock: true },
];
const variants = [
    { id: VARIANT_A1, product_id: PRODUCT_A_VARIANT, option_name: 'Size', option_value: 'M', price: '75.00', quantity: 2, is_active: true },
    { id: VARIANT_A2, product_id: PRODUCT_A_VARIANT, option_name: 'Size', option_value: 'L', price: null, quantity: 1, is_active: true },
];
const selections = {
    'store-a': [
        { storefront_id: 'store-a', product_id: PRODUCT_A, variant_ids: [], position: 0 },
        { storefront_id: 'store-a', product_id: PRODUCT_A_VARIANT, variant_ids: [VARIANT_A1], position: 1 },
    ],
    'store-b': [{ storefront_id: 'store-b', product_id: PRODUCT_B, variant_ids: [], position: 0 }],
};

const validCheckout = (overrides = {}) => ({
    customer_name: 'Rina Buyer',
    customer_phone: '01712345678',
    delivery_address: {
        district: 'Dhaka', upazila: 'Dhanmondi', area: 'Dhanmondi',
        street_address: 'House 7, Road 2, Dhanmondi',
    },
    consent: true,
    items: [{ product_id: PRODUCT_A, quantity: 1 }],
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    storefrontA.slug = 'shop-a-71c3';
    storefrontA.title = 'A Shop';
    storefrontA.is_published = true;
    storefrontA.settings = { delivery_fee: 40 };
    storefrontA.update = jest.fn(async (updates) => Object.assign(storefrontA, updates));
    mockStorefront.findOne.mockImplementation(async ({ where }) => {
        if (where.shop_id) return ({ 'shop-a': storefrontA, 'shop-b': storefrontB })[where.shop_id] || null;
        if (where.id) return [storefrontA, storefrontB].find((storefront) => storefront.id === where.id
            && (!where.is_published || storefront.is_published)) || null;
        return [storefrontA, storefrontB].find((storefront) => storefront.slug === where.slug
            && (!where.is_published || storefront.is_published)) || null;
    });
    mockShop.findByPk.mockImplementation(async (shopId) => ({ id: shopId, is_active: true }));
    mockStorefrontProduct.findAll.mockImplementation(async ({ where }) => selections[where.storefront_id] || []);
    mockProduct.findAll.mockImplementation(async ({ where }) => products.filter((product) =>
        product.shop_id === where.shop_id
        && product.is_active === where.is_active
        && (!where.id || productIdsIn(where.id).includes(product.id))));
    mockProductVariant.findAll.mockImplementation(async ({ where }) => variants.filter((variant) =>
        variant.is_active === where.is_active
        && productIdsIn(where.product_id).includes(variant.product_id)));
    mockCreateStorefrontCodOrder.mockImplementation(async (_shopId, orderData, _key, options) => {
        await options.validateSelection({ transaction: { LOCK: { UPDATE: 'UPDATE' } }, items: orderData.items });
        return { id: 'order-1', order_number: 'ORD-1', total: 140, payment_status: 'unpaid', order_status: 'confirmed' };
    });
});

function productIdsIn(where) {
    const inOperator = Object.getOwnPropertySymbols(where).find((symbol) => symbol === Symbol.for('sequelize.op.in'));
    return inOperator ? where[inOperator] : [where];
}

describe('Storefront service', () => {
    test('isolates published product browse by storefront shop and only returns minimal active catalog fields', async () => {
        const storeA = await service.getPublicStorefrontRecord('shop-a-71c3');
        const storeB = await service.getPublicStorefrontRecord('shop-b-280e');

        const [catalogA, catalogB] = await Promise.all([
            service.listPublicProducts(storeA),
            service.listPublicProducts(storeB),
        ]);

        expect(catalogA.map((product) => product.id)).toEqual([PRODUCT_A, PRODUCT_A_VARIANT]);
        expect(catalogB.map((product) => product.id)).toEqual([PRODUCT_B]);
        expect(catalogA[0]).toEqual(expect.objectContaining({ id: PRODUCT_A, price: 100 }));
        expect(catalogA[0]).not.toHaveProperty('sku');
        expect(catalogA[0]).not.toHaveProperty('quantity');
        expect(catalogA[1].variants).toEqual([
            { id: VARIANT_A1, option_name: 'Size', option_value: 'M', price: 75 },
        ]);
    });

    test('does not resolve an unpublished storefront for public requests', async () => {
        storefrontA.is_published = false;

        await expect(service.getPublicStorefrontRecord(storefrontA.slug)).resolves.toBeNull();

        storefrontA.is_published = true;
    });

    test('rejects selecting a product owned by another shop', async () => {
        await expect(service.replaceSelectedProducts('shop-a', [
            { product_id: PRODUCT_B, variant_ids: [] },
        ])).rejects.toMatchObject({ code: 'INVALID_STOREFRONT_PRODUCT' });
    });

    test('rejects checkout items that are not listed by this storefront', async () => {
        const storefront = await service.getPublicStorefrontRecord(storefrontA.slug);

        await expect(service.checkout(storefront, validCheckout({
            items: [{ product_id: PRODUCT_B, quantity: 1 }],
        }), 'checkout-key-000001', jest.fn())).rejects.toMatchObject({
            code: 'STOREFRONT_PRODUCT_NOT_SELECTED',
        });
        expect(mockCreateStorefrontCodOrder).toHaveBeenCalledTimes(1);
    });

    test('rejects an active variant that the merchant did not select for the storefront', async () => {
        const storefront = await service.getPublicStorefrontRecord(storefrontA.slug);

        await expect(service.checkout(storefront, validCheckout({
            items: [{ product_id: PRODUCT_A_VARIANT, variant_id: VARIANT_A2, quantity: 1 }],
        }), 'checkout-key-000007', jest.fn())).rejects.toMatchObject({
            code: 'STOREFRONT_VARIANT_NOT_SELECTED',
        });
    });

    test('passes only catalog identifiers, records consent and payload hash, and returns no buyer PII', async () => {
        const storefront = await service.getPublicStorefrontRecord(storefrontA.slug);
        const gate = jest.fn().mockResolvedValue(true);

        const result = await service.checkout(storefront, validCheckout({
            items: [{ product_id: PRODUCT_A, quantity: 1, price: 0.01 }],
        }), 'checkout-key-000002', gate);

        const [shopId, orderData, idempotencyKey, options] = mockCreateStorefrontCodOrder.mock.calls[0];
        expect(shopId).toBe('shop-a');
        expect(idempotencyKey).toBe('checkout-key-000002');
        expect(orderData.items).toEqual([{ product_id: PRODUCT_A, variant_id: null, quantity: 1 }]);
        expect(orderData).toEqual(expect.objectContaining({
            channel: 'storefront', payment_status: 'unpaid', payment_method: 'COD', order_status: 'confirmed',
            delivery_area: 'Dhanmondi',
        }));
        expect(orderData.metadata.storefront.idempotency_payload_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(orderData.metadata.storefront.buyer_consent).toEqual(expect.objectContaining({
            accepted: true,
            policy_version: service.BUYER_CONSENT_POLICY_VERSION,
            accepted_at: expect.any(String),
        }));
        expect(options.validateSelection).toEqual(expect.any(Function));
        expect(gate).toHaveBeenCalledWith('shop-a');
        expect(result).toEqual({
            order_id: 'order-1', order_number: 'ORD-1', total: 140,
            payment_status: 'unpaid', order_status: 'confirmed',
        });
        expect(JSON.stringify(result)).not.toMatch(/Rina Buyer|01712345678|Dhanmondi/);
    });

    test('derives the legacy courier area from upazila when checkout clients omit area', async () => {
        const storefront = await service.getPublicStorefrontRecord(storefrontA.slug);

        await service.checkout(storefront, validCheckout({
            delivery_address: {
                district: 'Dhaka',
                upazila: 'Mirpur',
                street_address: 'House 7, Road 2, Mirpur',
            },
        }), 'checkout-key-000008', jest.fn());

        expect(mockCreateStorefrontCodOrder.mock.calls[0][1]).toMatchObject({
            delivery_address: expect.objectContaining({ upazila: 'Mirpur' }),
            delivery_area: 'Mirpur',
        });
    });

    test('generates a slug-safe non-guessable default slug and refuses a second storefront per shop', async () => {
        const created = { ...storefrontA, slug: undefined, is_published: false };
        mockStorefront.findOne.mockResolvedValueOnce(null);
        mockStorefront.create.mockImplementation(async (values) => Object.assign(created, values));

        const result = await service.createMerchantStorefront('shop-a', { title: 'A Shop!' });
        expect(result.slug).toMatch(/^a-shop-[a-f0-9]{24}$/);

        mockStorefront.findOne.mockResolvedValueOnce(storefrontA);
        await expect(service.createMerchantStorefront('shop-a', { title: 'Duplicate' }))
            .rejects.toMatchObject({ code: 'STOREFRONT_EXISTS' });
    });

    test('updates merchant storefront details and allowlisted delivery settings', async () => {
        const updated = await service.updateMerchantStorefront('shop-a', {
            title: 'Updated Shop',
            slug: 'updated-shop',
        });
        const settings = await service.updateStorefrontSettings('shop-a', {
            delivery_fee: 90,
            delivery_note: 'Delivery fee is shown at checkout',
        });

        expect(updated).toEqual(expect.objectContaining({ title: 'Updated Shop', slug: 'updated-shop' }));
        expect(settings.settings).toEqual({ delivery_fee: 90, delivery_note: 'Delivery fee is shown at checkout' });
    });

    test('replaces selected active products and only records the requested active variants', async () => {
        await service.replaceSelectedProducts('shop-a', [{
            product_id: PRODUCT_A_VARIANT,
            variant_ids: [VARIANT_A1],
        }]);

        expect(mockStorefrontProduct.destroy).toHaveBeenCalledWith({
            where: { storefront_id: 'store-a' },
            transaction: expect.any(Object),
        });
        expect(mockStorefrontProduct.bulkCreate).toHaveBeenCalledWith([{
            storefront_id: 'store-a',
            product_id: PRODUCT_A_VARIANT,
            variant_ids: [VARIANT_A1],
            position: 0,
        }], { transaction: expect.any(Object) });
    });

    test('publishes a valid selected catalog and supports unpublishing it', async () => {
        const published = await service.setPublished('shop-a', true);
        expect(published.is_published).toBe(true);
        expect(published.published_at).toBeInstanceOf(Date);

        const unpublished = await service.setPublished('shop-a', false);
        expect(unpublished.is_published).toBe(false);
        expect(unpublished.published_at).toBeNull();
    });
});

describe('Storefront checkout validation', () => {
    const checkoutSchema = validator.checkout.body;
    const base = validCheckout();

    test('rejects an invalid Bangladeshi phone number', () => {
        expect(checkoutSchema.validate({ ...base, customer_phone: '12345' }).error).toBeDefined();
    });

    test('rejects an incomplete delivery address', () => {
        expect(checkoutSchema.validate({
            ...base,
            delivery_address: { district: 'Dhaka', street_address: 'Road' },
        }).error).toBeDefined();
    });

    test('accepts the thana/area a courier directory is keyed by', () => {
        // District alone is not enough to pick a courier area; the buyer's
        // thana is what lets checkout create a bookable order.
        const { error, value } = checkoutSchema.validate({
            ...base,
            delivery_address: {
                district: 'Dhaka',
                upazila: 'Mirpur',
                area: 'Mirpur 10',
                street_address: 'House 7, Road 2, Mirpur 10',
            },
        });

        expect(error).toBeUndefined();
        expect(value.delivery_address.area).toBe('Mirpur 10');
    });

    test('rejects checkout when neither area nor upazila is provided', () => {
        const result = checkoutSchema.validate({
            ...base,
            delivery_address: {
                district: 'Dhaka',
                street_address: 'House 7, Road 2, Mirpur 10',
            },
        });

        expect(result.error).toBeDefined();
    });

    test('requires affirmative buyer consent and rejects client customer/shop authority', () => {
        expect(checkoutSchema.validate({ ...base, consent: false }).error).toBeDefined();
        expect(checkoutSchema.validate({ ...base, customer_id: 'not-authoritative' }).error).toBeDefined();
        expect(checkoutSchema.validate({ ...base, shop_id: 'not-authoritative' }).error).toBeDefined();
    });

    test('strips client-supplied price and line total rather than treating them as authority', () => {
        const { error, value } = checkoutSchema.validate({
            ...base,
            items: [{ product_id: PRODUCT_A, quantity: 1, price: -1000, total: 0 }],
        });
        expect(error).toBeUndefined();
        expect(value.items[0]).toEqual({ product_id: PRODUCT_A, quantity: 1 });
    });
});
