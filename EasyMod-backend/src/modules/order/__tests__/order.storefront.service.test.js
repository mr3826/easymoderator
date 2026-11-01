'use strict';

const mockOrder = { findOne: jest.fn(), create: jest.fn() };
const mockOrderItem = { create: jest.fn(), findAll: jest.fn() };
const mockProduct = { findAll: jest.fn() };
const mockProductVariant = { findAll: jest.fn() };
const mockCustomer = { findOne: jest.fn(), create: jest.fn() };
const mockUserShop = { findOne: jest.fn() };
const mockSubscriptionService = { checkOrderLimit: jest.fn(), trackUsage: jest.fn() };
const mockRto = { checkPhone: jest.fn() };
const mockQuery = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockCreateLogger = jest.fn(() => mockLogger);

jest.mock('../../entities', () => ({
    Order: mockOrder,
    OrderItem: mockOrderItem,
    Product: mockProduct,
    ProductVariant: mockProductVariant,
    Customer: mockCustomer,
    UserShop: mockUserShop,
    OrderReturn: {},
    CourierDispatch: {},
    AuditLog: {},
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
        query: mockQuery,
        getDialect: jest.fn(),
    },
}));
jest.mock('../../subscription/subscription.service', () => mockSubscriptionService);
jest.mock('../../rto-shield/rto-shield.service', () => mockRto);
jest.mock('../../rto-shield/rto-network-settings', () => ({ getNetworkSettings: jest.fn().mockResolvedValue({ enforce: true }) }));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: mockCreateLogger }));
jest.mock('../../product/stock-status-guard.service', () => ({ invalidate: jest.fn().mockResolvedValue(true) }));
jest.mock('../../delivery/delivery.service', () => ({ getActiveProvider: jest.fn(), createOrder: jest.fn() }));
jest.mock('../../customer-intelligence/opportunity.service', () => ({ convertForOrder: jest.fn().mockResolvedValue(null) }));
jest.mock('../../analytics/funnel-events.service', () => ({ recordInternalFunnelEvent: jest.fn().mockResolvedValue(null) }));

const orderService = require('../order.service');
const { sequelize } = require('../../../utils/database/database-setup');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const requestData = (overrides = {}) => ({
    items: [{ product_id: 'product-a', variant_id: 'variant-a', quantity: 1 }],
    customer_name: 'Rina Buyer',
    customer_phone: '01712345678',
    delivery_address: { district: 'Dhaka', street_address: 'House 7, Road 2, Dhanmondi' },
    order_status: 'confirmed',
    payment_status: 'unpaid',
    payment_method: 'COD',
    channel: 'storefront',
    metadata: { storefront: { idempotency_payload_hash: HASH_A, buyer_consent: { accepted: true } } },
    ...overrides,
});

let ordersByKey;
let createdOrderData;
let transactionFactory;

beforeEach(() => {
    jest.clearAllMocks();
    ordersByKey = new Map();
    createdOrderData = [];
    sequelize.getDialect.mockReturnValue('postgres');
    mockQuery.mockResolvedValue([[{ next_number: 1 }]]);
    mockOrder.findOne.mockImplementation(async ({ where }) => ordersByKey.get(`${where.shop_id}:${where.idempotency_key}`) || null);
    mockOrder.create.mockImplementation(async (data) => {
        createdOrderData.push(data);
        const order = {
            id: `order-${createdOrderData.length}`,
            order_number: `ORD-${createdOrderData.length}`,
            ...data,
            save: jest.fn().mockResolvedValue(true),
        };
        if (data.idempotency_key) ordersByKey.set(`${data.shop_id}:${data.idempotency_key}`, order);
        return order;
    });
    mockOrderItem.create.mockResolvedValue({ id: 'order-item-1' });
    mockSubscriptionService.checkOrderLimit.mockResolvedValue(true);
    mockSubscriptionService.trackUsage.mockResolvedValue({ transactionId: 'usage-1' });
    mockRto.checkPhone.mockResolvedValue({ flagged: false, tier: 'allow' });
    mockCustomer.findOne.mockResolvedValue(null);
    mockCustomer.create.mockResolvedValue({ id: 'customer-storefront' });
    mockProductVariant.findAll.mockResolvedValue([]);
    transactionFactory = () => ({
        LOCK: { UPDATE: 'UPDATE' },
        commit: jest.fn().mockResolvedValue(true),
        rollback: jest.fn().mockResolvedValue(true),
    });
    sequelize.transaction.mockImplementation(async () => transactionFactory());
});

const validSelection = jest.fn().mockResolvedValue(undefined);

describe('storefront COD order authority', () => {
    test('returns the same order for an identical key and rejects a changed payload replay', async () => {
        const existing = {
            id: 'existing-order',
            order_number: 'ORD-OLD',
            metadata: { storefront: { idempotency_payload_hash: HASH_A } },
        };
        ordersByKey.set('shop-a:checkout-key-000001', existing);

        await expect(orderService.createStorefrontCodOrder('shop-a', requestData(), 'checkout-key-000001', {
            payloadHash: HASH_A, validateSelection: validSelection,
        })).resolves.toBe(existing);

        await expect(orderService.createStorefrontCodOrder('shop-a', requestData(), 'checkout-key-000001', {
            payloadHash: HASH_B, validateSelection: validSelection,
        })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(mockOrder.create).not.toHaveBeenCalled();
        expect(mockSubscriptionService.checkOrderLimit).not.toHaveBeenCalled();
    });

    test('uses the live variant price and locked variant stock, stores the variant snapshot and keeps COD unpaid', async () => {
        const variant = {
            id: 'variant-a', product_id: 'product-a', option_name: 'Size', option_value: 'M',
            price: '75.00', quantity: 2, is_active: true,
            decrement: jest.fn().mockResolvedValue(true),
        };
        const product = {
            id: 'product-a', shop_id: 'shop-a', name: 'T-Shirt', price: '100.00',
            quantity: 40, track_quantity: true, is_active: true, in_stock: true,
            decrement: jest.fn().mockResolvedValue(true),
        };
        mockProduct.findAll.mockResolvedValue([product]);
        mockProductVariant.findAll.mockResolvedValue([variant]);
        sequelize.transaction.mockResolvedValue(transactionFactory());

        const result = await orderService.createStorefrontCodOrder('shop-a', requestData(), 'checkout-key-000002', {
            payloadHash: HASH_A,
            validateSelection: validSelection,
        });

        expect(result.payment_status).toBe('unpaid');
        expect(result.order_status).toBe('confirmed');
        expect(createdOrderData[0]).toEqual(expect.objectContaining({
            channel: 'storefront', payment_status: 'unpaid', payment_method: 'COD', customer_id: 'customer-storefront',
            subtotal: 75, total: 75,
            items: [expect.objectContaining({ variant_id: 'variant-a', variant_name: 'Size: M', price: 75 })],
            metadata: requestData().metadata,
        }));
        expect(mockOrderItem.create).toHaveBeenCalledWith(expect.objectContaining({
            product_id: 'product-a', variant_id: 'variant-a', quantity: 1, price: 75, total: 75,
        }), expect.objectContaining({ transaction: expect.any(Object) }));
        expect(variant.decrement).toHaveBeenCalledWith('quantity', expect.objectContaining({ by: 1 }));
        expect(product.decrement).not.toHaveBeenCalled();
        expect(mockCustomer.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: 'shop-a', phone: '01712345678', channel_type: 'webchat',
        }), expect.any(Object));
        expect(validSelection).toHaveBeenCalled();
    });

    test('rejects invalid catalog price and client cannot replace the live value', async () => {
        const product = {
            id: 'product-a', shop_id: 'shop-a', name: 'Bad Catalog Product', price: 'not-a-price',
            quantity: 1, track_quantity: false, is_active: true, in_stock: true,
        };
        mockProduct.findAll.mockResolvedValue([product]);
        mockProductVariant.findAll.mockResolvedValue([]);

        await expect(orderService.createStorefrontCodOrder('shop-a', requestData({
            items: [{ product_id: 'product-a', variant_id: null, quantity: 1, price: 0.01 }],
        }), 'checkout-key-000003', { payloadHash: HASH_A, validateSelection: validSelection }))
            .rejects.toMatchObject({ status: 409, code: 'CATALOG_PRICE_INVALID' });
        expect(mockOrder.create).not.toHaveBeenCalled();
    });

    test('rejects a variant quantity above its locked available stock', async () => {
        const variant = {
            id: 'variant-a', product_id: 'product-a', option_name: 'Size', option_value: 'M',
            price: '75.00', quantity: 1, is_active: true,
            decrement: jest.fn().mockResolvedValue(true),
        };
        mockProduct.findAll.mockResolvedValue([{
            id: 'product-a', shop_id: 'shop-a', name: 'T-Shirt', price: '100.00',
            quantity: 10, track_quantity: true, is_active: true, in_stock: true,
        }]);
        mockProductVariant.findAll.mockResolvedValue([variant]);

        await expect(orderService.createStorefrontCodOrder('shop-a', requestData({
            items: [{ product_id: 'product-a', variant_id: 'variant-a', quantity: 2 }],
        }), 'checkout-key-000004', { payloadHash: HASH_A, validateSelection: validSelection }))
            .rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
        expect(variant.decrement).not.toHaveBeenCalled();
        expect(mockOrder.create).not.toHaveBeenCalled();
    });

    test('rejects a parent product when active variants make the selection ambiguous', async () => {
        mockProduct.findAll.mockResolvedValue([{
            id: 'product-a', shop_id: 'shop-a', name: 'T-Shirt', price: '100.00',
            quantity: 10, track_quantity: true, is_active: true, in_stock: true,
        }]);
        mockProductVariant.findAll.mockResolvedValue([{
            id: 'variant-a', product_id: 'product-a', option_name: 'Size', option_value: 'M',
            price: '75.00', quantity: 2, is_active: true,
        }]);

        await expect(orderService.createStorefrontCodOrder('shop-a', requestData({
            items: [{ product_id: 'product-a', quantity: 1 }],
        }), 'checkout-key-000005', { payloadHash: HASH_A, validateSelection: validSelection }))
            .rejects.toMatchObject({ status: 400, code: 'PRODUCT_VARIANT_REQUIRED' });
        expect(mockOrder.create).not.toHaveBeenCalled();
    });

    test('serializes concurrent checkouts for the last tracked unit', async () => {
        let stock = 1;
        let locked = false;
        const waiters = [];
        const acquire = () => new Promise((resolve) => {
            if (!locked) {
                locked = true;
                resolve();
            } else {
                waiters.push(resolve);
            }
        });
        const release = () => {
            const next = waiters.shift();
            if (next) next();
            else locked = false;
        };
        sequelize.transaction.mockImplementation(async () => {
            let hasLock = false;
            return {
                LOCK: { UPDATE: 'UPDATE' },
                commit: jest.fn(async () => { if (hasLock) release(); }),
                rollback: jest.fn(async () => { if (hasLock) release(); }),
                acquireProductLock: async () => { await acquire(); hasLock = true; },
            };
        });
        mockProduct.findAll.mockImplementation(async ({ transaction }) => {
            await transaction.acquireProductLock();
            const product = {
                id: 'product-a', shop_id: 'shop-a', name: 'Last Unit', price: '20.00',
                quantity: stock, track_quantity: true, is_active: true, in_stock: true,
                decrement: jest.fn(async (_field, { by }) => { stock -= by; }),
            };
            return [product];
        });
        mockProductVariant.findAll.mockResolvedValue([]);

        const makeOrder = (key, hash) => orderService.createStorefrontCodOrder('shop-a', requestData({
            items: [{ product_id: 'product-a', variant_id: null, quantity: 1 }],
            customer_phone: key === 'checkout-key-race-0001' ? '01712345678' : '01812345678',
            metadata: { storefront: { idempotency_payload_hash: hash } },
        }), key, { payloadHash: hash, validateSelection: validSelection });
        const outcomes = await Promise.allSettled([
            makeOrder('checkout-key-race-0001', HASH_A),
            makeOrder('checkout-key-race-0002', HASH_B),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')[0].reason)
            .toMatchObject({ code: 'INSUFFICIENT_STOCK' });
        expect(stock).toBe(0);
        expect(mockOrder.create).toHaveBeenCalledTimes(1);
    });
});
