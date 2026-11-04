/**
 * Contract test for OrderSessionService.createOrderFromSession — the final link
 * in the chat→order chain that the live worker now reaches via order-flow.service.
 *
 * Before the order-flow wiring, this code path was never invoked in production
 * (the worker only ran the conversational LLM), so an Order was never created.
 * This locks the conversion contract: a completed session must produce a real
 * createOrderInternal call with the right shape, and a session with no linked
 * product must fail loudly rather than silently dead-end.
 */

// Make the module load without a live DB: stub the sequelize instance so the
// top-level model definitions resolve to plain objects.
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})), transaction: jest.fn() },
}));
jest.mock('../order.service', () => ({
    createOrderInternal: jest.fn().mockResolvedValue({ id: 'ord-1', order_number: '1001', total: 1260 }),
}));
jest.mock('../../payment/self-mfs-handler.service', () => ({ verifyPaymentScreenshot: jest.fn() }));
jest.mock('../../ai/action-gate', () => ({ verifyAuthorization: jest.fn(() => true) }));
jest.mock('../../customer/customer.entity', () => ({
    findOne: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    findByPk: jest.fn(),
}));

const OrderSessionService = require('../order-session-standalone.service');
const { createOrderInternal } = require('../order.service');

beforeEach(() => jest.clearAllMocks());

describe('createOrderFromSession', () => {
    test('converts a completed session into a real Order (idempotent, catalog-priced)', async () => {
        const session = {
            id: 'sess-1',
            shop_id: 'shop-1',
            customer_id: 'cust-1',
            customer_channel_id: 'customer-1',
            meta_channel_id: 'channel-1',
            channel: 'messenger',
            product_info: { id: 'prod-1', name: 'Red Saree', price: 1200, quantity: 1 },
        };
        const stepData = {
            name: 'Rahim',
            phone: '01711111111',
            address: 'Mirpur 10, Dhaka',
            delivery_charge: 60,
            payment_method: 'cod',
            notes: null,
        };

        const order = await OrderSessionService.createOrderFromSession(session, stepData, {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-1',
        });

        expect(createOrderInternal).toHaveBeenCalledTimes(1);
        const [shopIdArg, orderData, requestId] = createOrderInternal.mock.calls[0];
        expect(shopIdArg).toBe('shop-1');
        expect(requestId).toMatch(/^[a-f0-9]{64}$/);
        expect(orderData).toEqual(expect.objectContaining({
            customer_id: 'cust-1',
            customer_name: 'Rahim',
            customer_phone: '01711111111',
            delivery_address: 'Mirpur 10, Dhaka',
            delivery_fee: 60,
            order_status: 'confirmed',
            payment_status: 'unpaid', // COD → unpaid
            payment_method: 'cod',
            idempotency_key: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        // price omitted on purpose — the server uses the live catalog price
        expect(orderData.items).toEqual([{ product_id: 'prod-1', quantity: 1 }]);
        expect(order.order_number).toBe('1001');
    });

    test('keeps the buyer\'s own words in the canonical destination carrier', async () => {
        // A chat address is one free-text line. No directory can be matched
        // against it without a guess, so it is preserved verbatim: the merchant
        // confirms a directory area against exactly this text.
        const session = {
            id: 'sess-3',
            shop_id: 'shop-1',
            customer_id: 'cust-1',
            customer_channel_id: 'customer-1',
            meta_channel_id: 'channel-1',
            channel: 'messenger',
            product_info: { id: 'prod-1', name: 'Red Saree', price: 1200, quantity: 1 },
        };

        await OrderSessionService.createOrderFromSession(session, {
            name: 'Rahim',
            phone: '01711111111',
            address: 'House 4, Road 12, Mirpur 10, Dhaka',
            delivery_charge: 60,
            payment_method: 'cod',
        }, {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-3',
        });

        const [, orderData] = createOrderInternal.mock.calls[0];
        expect(orderData.delivery_location).toEqual({
            full_address: 'House 4, Road 12, Mirpur 10, Dhaka',
            source: 'chat',
        });
    });

    test('converts a multi-item cart into one order with all line items', async () => {
        const session = {
            id: 'sess-2',
            shop_id: 'shop-1',
            customer_id: 'cust-1',
            customer_channel_id: 'customer-1',
            meta_channel_id: 'channel-1',
            channel: 'messenger',
            // product_info holds only the last-configured item; the cart is the truth.
            product_info: { id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 2 },
            step_data: {},
        };
        const stepData = {
            name: 'Rahim',
            phone: '01711111111',
            address: 'Mirpur 10, Dhaka',
            delivery_charge: 60,
            payment_method: 'cod',
            cart: [
                { product_id: 'prod-1', name: 'Red Saree', price: 1200, quantity: 1 },
                { product_id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 2 },
            ],
        };

        await OrderSessionService.createOrderFromSession(session, stepData, {
            authorization: { actionType: 'CREATE_ORDER', shopId: 'shop-1', idempotencyKey: 'test' },
            conversationId: 'conv-1',
        });

        const [, orderData] = createOrderInternal.mock.calls[0];
        // Catalog-priced (price omitted); one entry per cart line, quantities preserved.
        expect(orderData.items).toEqual([
            { product_id: 'prod-1', quantity: 1 },
            { product_id: 'prod-2', quantity: 2 },
        ]);
    });

    test('refuses to create an order when no product is linked to the session', async () => {
        await expect(
            OrderSessionService.createOrderFromSession({ id: 's', shop_id: 'sh', product_info: null }, {})
        ).rejects.toThrow(/no product/i);
        expect(createOrderInternal).not.toHaveBeenCalled();
    });

    test('mutationsAllowed=false leaves the confirmed session awaiting confirmation', async () => {
        const session = {
            id: 'sess-draft',
            shop_id: 'shop-1',
            current_step: 'ORDER_SUMMARY',
            step_data: {
                language: 'en',
                name: 'Rahim',
                phone: '01711111111',
                address: 'Mirpur, Dhaka',
                delivery_charge: 60,
                payment_method: 'cod',
                cart: [{ product_id: 'prod-1', name: 'Red Saree', price: 1200, quantity: 1 }],
            },
            product_info: { id: 'prod-1', name: 'Red Saree', price: 1200, quantity: 1 },
            update: jest.fn(),
        };

        const result = await OrderSessionService.handleCurrentStep(
            session,
            'YES',
            null,
            { mutationsAllowed: false }
        );

        expect(result.current_step).toBe('ORDER_SUMMARY');
        expect(result.state).toBe('AWAITING_CONFIRMATION');
        expect(result.mutation_blocked).toBe(true);
        expect(createOrderInternal).not.toHaveBeenCalled();
    });
});
