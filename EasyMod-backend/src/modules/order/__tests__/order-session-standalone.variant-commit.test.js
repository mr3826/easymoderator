'use strict';

/**
 * D-P2-02 — the order-commit path must NOT silently drop a selected variant.
 *
 * createOrderFromSession previously sent only { product_id, quantity } per line,
 * so order.service's authoritative per-variant stock/price validation never ran
 * and an out-of-stock size could be committed as a product-level order. The fix
 * carries variant_id when present and keeps the product-level shape when absent
 * (backward compatible with the existing createorder contract test).
 */

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})), transaction: jest.fn() },
}));
jest.mock('../order.service', () => ({
    createOrderInternal: jest.fn().mockResolvedValue({ id: 'ord-1', order_number: '1001', total: 1260 }),
}));
jest.mock('../../payment/self-mfs-handler.service', () => ({ verifyPaymentScreenshot: jest.fn() }));
jest.mock('../../ai/action-gate', () => ({ verifyAuthorization: jest.fn(() => true) }));
jest.mock('../../customer/customer.entity', () => ({
    findOne: jest.fn().mockResolvedValue({ id: 'cust-1' }), findByPk: jest.fn(),
}));

const OrderSessionService = require('../order-session-standalone.service');
const { createOrderInternal } = require('../order.service');

const baseSession = (cart) => ({
    id: 'sess-1',
    shop_id: 'shop-1',
    customer_id: 'cust-1',
    customer_channel_id: 'customer-1',
    meta_channel_id: 'channel-1',
    channel: 'messenger',
    product_info: null,
    step_data: {},
});

const stepData = (cart) => ({
    name: 'Rahim', phone: '01711111111', address: 'Mirpur 10, Dhaka',
    delivery_charge: 60, payment_method: 'cod', notes: null, cart,
});

beforeEach(() => jest.clearAllMocks());

describe('createOrderFromSession — variant carry-through', () => {
    test('RED/GREEN: a selected variant id is carried into the server order line', async () => {
        const cart = [{ product_id: 'prod-1', variant_id: 'variant-xl', name: 'Denim', price: 3300, quantity: 1 }];
        await OrderSessionService.createOrderFromSession(baseSession(cart), stepData(cart), {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-1',
        });
        const [, orderData] = createOrderInternal.mock.calls[0];
        expect(orderData.items).toEqual([{ product_id: 'prod-1', quantity: 1, variant_id: 'variant-xl' }]);
    });

    test('a line with NO variant keeps the product-level shape (no spurious variant_id)', async () => {
        const cart = [{ product_id: 'prod-1', name: 'Denim', price: 3300, quantity: 2 }];
        await OrderSessionService.createOrderFromSession(baseSession(cart), stepData(cart), {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-1',
        });
        const [, orderData] = createOrderInternal.mock.calls[0];
        expect(orderData.items).toEqual([{ product_id: 'prod-1', quantity: 2 }]);
    });

    test('mixed cart: variant and non-variant lines each keep the right shape', async () => {
        const cart = [
            { product_id: 'prod-1', variant_id: 'variant-m', name: 'Lawn', price: 500, quantity: 1 },
            { product_id: 'prod-2', name: 'Dupatta', price: 300, quantity: 1 },
        ];
        await OrderSessionService.createOrderFromSession(baseSession(cart), stepData(cart), {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-1',
        });
        const [, orderData] = createOrderInternal.mock.calls[0];
        expect(orderData.items).toEqual([
            { product_id: 'prod-1', quantity: 1, variant_id: 'variant-m' },
            { product_id: 'prod-2', quantity: 1 },
        ]);
    });
});
