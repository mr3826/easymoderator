/**
 * Step-machine behavior tests for OrderSessionService.handleCurrentStep:
 *
 * 1. COLLECTING_NAME must not swallow a bare confirmation ("confirm korun",
 *    "ok") as the customer's name — re-prompts instead. Exact-match only, so
 *    real names that merely contain a confirm word ("Jia") still pass.
 * 2. ORDER_SUMMARY confirmation issues the customer's invoice and appends it
 *    to the success message; invoice failure never un-confirms the order.
 */

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})), transaction: jest.fn() },
}));
jest.mock('../order.service', () => ({
    createOrderInternal: jest.fn(),
}));
jest.mock('../../payment/self-mfs-handler.service', () => ({ verifyPaymentScreenshot: jest.fn() }));
jest.mock('../../rto-shield/rto-shield.service', () => ({ checkPhone: jest.fn() }));
jest.mock('../../product/product-search.service', () => ({
    checkStock: jest.fn(),
    searchForOrder: jest.fn(),
}));
jest.mock('../../ai/image-product-matcher.service', () => ({
    matchImageMessage: jest.fn(),
}));
jest.mock('../../customer/customer.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../shop/shop.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../payment/payment-config.entity', () => ({ findAll: jest.fn() }));
jest.mock('../../shop/shop-bd-settings', () => ({ getBdSettings: jest.fn(), hasSelfMfs: jest.fn() }));
jest.mock('../../invoice/chat-invoice.service', () => ({ issueInvoiceForOrder: jest.fn() }));
jest.mock('../../ai/action-gate', () => ({
    authorize: jest.fn(async (action) => ({
        authorized: true,
        authorization: {
            actionType: action.actionType,
            shopId: action.shopId,
            idempotencyKey: action.idempotencyKey,
        },
    })),
    verifyAuthorization: jest.fn(() => true),
}));

const OrderSessionService = require('../order-session-standalone.service');
const { createOrderInternal } = require('../order.service');
const productSearch = require('../../product/product-search.service');
const { matchImageMessage } = require('../../ai/image-product-matcher.service');
const { authorize } = require('../../ai/action-gate');
const { issueInvoiceForOrder } = require('../../invoice/chat-invoice.service');
const RtoShieldService = require('../../rto-shield/rto-shield.service');
const ShopEntity = require('../../shop/shop.entity');
const PaymentConfigEntity = require('../../payment/payment-config.entity');
let previousPhotoMatchFlag;

const makeSession = (overrides = {}) => ({
    id: 'sess-1',
    shop_id: 'shop-1',
    customer_id: null,
    channel: 'messenger',
    current_step: 'COLLECTING_NAME',
    step_data: {},
    product_info: { id: 'prod-1', name: 'Azal Lawn Two Piece', price: 1650, quantity: 1 },
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    previousPhotoMatchFlag = process.env.AI_PHOTO_MATCH_ENABLED;
    delete process.env.AI_PHOTO_MATCH_ENABLED;
    productSearch.searchForOrder.mockResolvedValue({ products: [], wasFallback: true });
    matchImageMessage.mockResolvedValue({ products: [], method: 'no_match', confidence: 0 });
    // Parcel dispatch is fire-and-forget via setImmediate — keep it out of tests.
    jest.spyOn(OrderSessionService, 'dispatchParcelWithRetry').mockResolvedValue(undefined);
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    if (previousPhotoMatchFlag === undefined) delete process.env.AI_PHOTO_MATCH_ENABLED;
    else process.env.AI_PHOTO_MATCH_ENABLED = previousPhotoMatchFlag;
});

describe('COLLECTING_NAME', () => {
    test.each(['Confirm korun', 'ok', 'YES', 'হ্যাঁ', 'ji'])(
        're-prompts instead of storing "%s" as the name', async (echo) => {
            const session = makeSession();
            const res = await OrderSessionService.handleCurrentStep(session, echo, null);

            expect(res.current_step).toBe('COLLECTING_NAME');
            expect(res.step_data.name).toBeUndefined();
            expect(res.prompt).toMatch(/নাম|name/i);
        });

    test.each(['Evan', 'Jia', 'Hannan'])('accepts the real name "%s"', async (name) => {
        const session = makeSession();
        const res = await OrderSessionService.handleCurrentStep(session, name, null);

        expect(res.current_step).toBe('COLLECTING_PHONE');
        expect(res.step_data.name).toBe(name);
    });
});

describe('COLLECTING_PHONE', () => {
    test('continues a flagged phone without disclosing a risk signal or declining the order', async () => {
        RtoShieldService.checkPhone.mockResolvedValue({
            flagged: true,
            tier: 'block',
            risk_score: 95,
            reason: 'global network signal',
        });
        const session = makeSession({
            current_step: 'COLLECTING_PHONE',
            step_data: { language: 'en', name: 'Evan' },
        });

        const result = await OrderSessionService.handleCurrentStep(session, '01712345678', null);

        expect(result.current_step).toBe('COLLECTING_ADDRESS');
        expect(result.step_data.phone).toBe('01712345678');
        expect(result.prompt).toMatch(/delivery address/i);
        expect(JSON.stringify(result)).not.toMatch(/global network signal|risk_score|flagged|blacklist|declin/i);
        expect(RtoShieldService.checkPhone).not.toHaveBeenCalled();
    });
});

describe('ORDER_SUMMARY confirmation → order + invoice', () => {
    const stepData = {
        name: 'Evan',
        phone: '01886895874',
        address: 'Mirpur, Dhaka',
        delivery_charge: 60,
        payment_method: 'cod',
    };

    beforeEach(() => {
        productSearch.checkStock.mockResolvedValue({ available: true });
        createOrderInternal.mockResolvedValue({
            id: 'ord-1', order_number: '100001', total: 1710,
            shop_id: 'shop-1', customer_name: 'Evan', payment_method: 'cod',
        });
    });

    // The step machine fires parcel dispatch via setImmediate. Drain it while
    // the dispatch spy is still installed, or it leaks past test teardown.
    const drainImmediates = () => new Promise(resolve => setImmediate(resolve));

    test('appends the invoice to the confirmation message', async () => {
        issueInvoiceForOrder.mockResolvedValue({
            invoice: { invoice_number: 'INV-100001' },
            text: '🧾 ইনভয়েস / INVOICE\nইনভয়েস নং: INV-100001\n💰 সর্বমোট / Total: ৳1710',
        });
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(session, 'YES', null, { conversationId: 'conv-1' });
        await drainImmediates();

        expect(OrderSessionService.dispatchParcelWithRetry).toHaveBeenCalled();
        expect(res.completed).toBe(true);
        expect(res.prompt).toContain('100001');           // order number
        expect(res.prompt).toContain('INV-100001');        // invoice attached
        const [orderArg, optsArg] = issueInvoiceForOrder.mock.calls[0];
        expect(orderArg.id).toBe('ord-1');
        expect(optsArg.items).toEqual([
            expect.objectContaining({ name: 'Azal Lawn Two Piece', quantity: 1, total: 1650 }),
        ]);
    });

    test('invoice failure does not un-confirm the order', async () => {
        issueInvoiceForOrder.mockRejectedValue(new Error('db hiccup'));
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(session, 'YES', null, { conversationId: 'conv-1' });
        await drainImmediates();

        expect(res.completed).toBe(true);
        expect(res.prompt).toContain('100001');
        expect(res.prompt).toMatch(/অর্ডার সফলভাবে|placed successfully/);
    });

    test.each([
        'y',
        'হ্যাঁ না',
        'na hoile',
        'nibo na',
        'why so expensive?',
        'ok kintu address change korbo',
    ])('does not create an order for non-confirmation "%s"', async (answer) => {
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(session, answer, null, { conversationId: 'conv-1' });

        expect(res.completed).toBe(false);
        expect(res.current_step).toBe('ORDER_SUMMARY');
        expect(createOrderInternal).not.toHaveBeenCalled();
    });

    test.each(['ha', 'confirm korun', 'জি'])('accepts an exact confirmation "%s"', async (answer) => {
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(session, answer, null, { conversationId: 'conv-1' });
        await drainImmediates();

        expect(res.completed).toBe(true);
        expect(createOrderInternal).toHaveBeenCalledTimes(1);
    });

    test('keeps a confirmed summary awaiting confirmation when mutations are disabled', async () => {
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(
            session,
            'YES',
            null,
            { mutationsAllowed: false }
        );

        expect(res.completed).toBe(false);
        expect(res.mutation_blocked).toBe(true);
        expect(res.state).toBe('AWAITING_CONFIRMATION');
        expect(res.current_step).toBe('ORDER_SUMMARY');
        expect(res.prompt).toMatch(/team member|টিম সদস্য/i);
        expect(createOrderInternal).not.toHaveBeenCalled();
    });

    // Founder's live failure: order creation threw a 400 "Insufficient stock"
    // (AppError, exposed as `.status`), but the catch read `.statusCode` →
    // undefined → treated as 5xx → customer saw the scary generic line instead
    // of the real reason. A genuine business 4xx must surface its own message.
    test('surfaces the real reason on a business 4xx (out of stock)', async () => {
        const appErr = Object.assign(new Error('Insufficient stock for product: Azal Lawn Two Piece'), { status: 400 });
        createOrderInternal.mockRejectedValue(appErr);
        const session = makeSession({ current_step: 'ORDER_SUMMARY', step_data: stepData });

        const res = await OrderSessionService.handleCurrentStep(session, 'YES', null, { conversationId: 'conv-1' });

        expect(res.completed).toBeFalsy();
        expect(res.current_step).toBe('ORDER_SUMMARY');           // stays so they can adjust
        expect(res.prompt).toBe('Insufficient stock for product: Azal Lawn Two Piece');
    });

    test('keeps the generic apology on a real 5xx (server fault)', async () => {
        const serverErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { status: 500 });
        createOrderInternal.mockRejectedValue(serverErr);
        const session = makeSession({
            current_step: 'ORDER_SUMMARY',
            step_data: { ...stepData, language: 'en' },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'YES', null, { conversationId: 'conv-1' });

        expect(res.completed).toBeFalsy();
        expect(res.prompt).toMatch(/contact you shortly/i);       // generic, not the raw DB error
        expect(res.prompt).not.toMatch(/ECONNREFUSED/);
    });
});

// Founder feedback 2026-06-12: the bot assumed 1 piece and never verified the
// quantity, so the invoice product count was wrong. A dedicated step now asks.
describe('COLLECTING_QUANTITY (verify pieces, not assume 1)', () => {
    beforeEach(() => {
        // Requested quantity is verified against live stock before advancing.
        productSearch.checkStock.mockResolvedValue({ available: true });
    });

    test.each([
        ['ami 3 ta nibo', 3],
        ['2', 2],
        ['৫', 5],          // Bengali numeral
        ['duita', 2],       // spoken word
        ['ekta', 1],
    ])('parses "%s" → quantity %i, carts the item and asks add-more', async (answer, expected) => {
        const session = makeSession({ current_step: 'COLLECTING_QUANTITY', step_data: { language: 'bn' } });
        const res = await OrderSessionService.handleCurrentStep(session, answer, null);

        // Multi-product: after quantity we offer "add another or checkout" instead
        // of jumping straight to the name step.
        expect(res.current_step).toBe('ADD_MORE');
        expect(productSearch.checkStock).toHaveBeenCalledWith('prod-1', 'shop-1', expected);
        expect(session.update).toHaveBeenCalledWith(
            expect.objectContaining({ product_info: expect.objectContaining({ quantity: expected }) })
        );
        // The configured item is now the first line in the cart.
        expect(res.step_data.cart).toEqual([
            expect.objectContaining({ product_id: 'prod-1', quantity: expected }),
        ]);
    });

    test('re-prompts (stays on the step) when no quantity is given', async () => {
        const session = makeSession({ current_step: 'COLLECTING_QUANTITY', step_data: { language: 'en' } });
        const res = await OrderSessionService.handleCurrentStep(session, 'asdf', null);

        expect(res.current_step).toBe('COLLECTING_QUANTITY');
        expect(res.prompt).toMatch(/how many/i);
    });

    // Founder's live failure: ordering 3 of a 2-in-stock item used to sail past
    // here (stock checked without the quantity) and only blew up at order
    // creation with a scary generic error. Now it's caught early and re-asked.
    test('re-asks with the remaining count when requested qty exceeds stock', async () => {
        productSearch.checkStock.mockResolvedValue({
            available: false, reason: 'Only 2 unit(s) left in stock', quantity: 2,
        });
        const session = makeSession({ current_step: 'COLLECTING_QUANTITY', step_data: { language: 'en' } });
        const res = await OrderSessionService.handleCurrentStep(session, '3', null);

        expect(res.current_step).toBe('COLLECTING_QUANTITY');
        expect(res.prompt).toMatch(/only 2 in stock/i);
        // Must NOT advance or persist the impossible quantity.
        expect(session.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ product_info: expect.objectContaining({ quantity: 3 }) })
        );
    });

    test('stays on quantity collection when the stock lookup is unavailable', async () => {
        productSearch.checkStock.mockRejectedValue(new Error('db down'));
        const session = makeSession({ current_step: 'COLLECTING_QUANTITY', step_data: { language: 'bn' } });
        const res = await OrderSessionService.handleCurrentStep(session, '2', null);

        expect(res.current_step).toBe('COLLECTING_QUANTITY');
        expect(res.prompt).toContain('স্টক এখন যাচাই করা যাচ্ছে না');
    });
});

// Multi-product: a customer can put several products in one order via an
// add-another loop. Decision: deterministic loop, minimal editing (add + cancel).
describe('ADD_MORE (multi-product cart)', () => {
    const cartWith = (...items) => items;

    beforeEach(() => {
        productSearch.checkStock.mockResolvedValue({ available: true });
    });

    test('"done" proceeds to checkout (name step)', async () => {
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'en', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });
        const res = await OrderSessionService.handleCurrentStep(session, 'done', null);

        expect(res.current_step).toBe('COLLECTING_NAME');
        expect(res.prompt).toMatch(/name/i);
    });

    test('a Bengali "শেষ" also proceeds to checkout', async () => {
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'bn', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });
        const res = await OrderSessionService.handleCurrentStep(session, 'শেষ', null);
        expect(res.current_step).toBe('COLLECTING_NAME');
    });

    test.each([
        'no',
        'না',
        'আর লাগবে না',
        'no, confirm this',
        'না, অর্ডার করুন',
        'confirm kore den',
        'order ta confirm koren',
        'এইটাই দেন',
    ])('treats "%s" as done adding products and proceeds to name collection', async (answer) => {
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'bn', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, answer, null);

        expect(res.current_step).toBe('COLLECTING_NAME');
        expect(res.prompt).toMatch(/নাম|name/i);
        expect(productSearch.searchForOrder).not.toHaveBeenCalled();
        expect(console.info).toHaveBeenCalledWith(
            '[OrderSession] add_more_reply_proceed_to_confirm_order',
            expect.objectContaining({
                normalized_intent: 'proceed_to_confirm_order',
                original_message: answer,
            })
        );
    });

    test('a vague Bengali no outside ADD_MORE does not confirm the product', async () => {
        const session = makeSession({
            current_step: 'PRODUCT_CONFIRMATION',
            step_data: { language: 'bn' },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'না', null);

        expect(res.current_step).toBe('PRODUCT_CONFIRMATION');
        expect(res.prompt).toMatch(/নিশ্চিত|confirm/i);
    });

    test('naming a second product identifies it and asks its quantity', async () => {
        productSearch.searchForOrder.mockResolvedValue({
            products: [{ id: 'prod-2', name: 'Silk Dupatta', price: 500, in_stock: true }],
            wasFallback: false,
        });
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'en', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'Silk Dupatta', null);

        expect(res.current_step).toBe('COLLECTING_QUANTITY');
        expect(session.update).toHaveBeenCalledWith(
            expect.objectContaining({ product_info: expect.objectContaining({ id: 'prod-2', name: 'Silk Dupatta' }) })
        );
    });

    test('explicit add-another language remains a product-add intent', async () => {
        productSearch.searchForOrder.mockResolvedValue({
            products: [{ id: 'prod-4', name: 'Blue Shirt', price: 800, in_stock: true }],
            wasFallback: false,
        });
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'bn', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'আরেকটা নীল শার্ট দেন', null);

        expect(res.current_step).toBe('COLLECTING_QUANTITY');
        expect(productSearch.searchForOrder).toHaveBeenCalledWith({
            shopId: 'shop-1',
            query: 'আরেকটা নীল শার্ট দেন',
            limit: 5,
        });
        expect(session.update).toHaveBeenCalledWith(
            expect.objectContaining({ product_info: expect.objectContaining({ id: 'prod-4', name: 'Blue Shirt' }) })
        );
    });

    test('cart removal language at ADD_MORE removes only the referenced product', async () => {
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: {
                language: 'en',
                cart: cartWith(
                    { product_id: 'prod-1', name: 'Blue Shirt', price: 800, quantity: 1 },
                    { product_id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 1 }
                ),
            },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'remove the shirt', null);

        expect(res.current_step).toBe('ORDER_SUMMARY');
        expect(res.step_data.cart).toEqual([
            expect.objectContaining({ product_id: 'prod-2', name: 'Silk Dupatta' }),
        ]);
        expect(productSearch.searchForOrder).not.toHaveBeenCalled();
    });

    test('single-line quantity edit at ADD_MORE updates that cart item', async () => {
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'bn', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'quantity 2 করেন', null);

        expect(res.current_step).toBe('ORDER_SUMMARY');
        expect(res.step_data.cart).toEqual([
            expect.objectContaining({ product_id: 'prod-1', quantity: 2 }),
        ]);
        expect(productSearch.searchForOrder).not.toHaveBeenCalled();
    });

    test('the second product quantity appends a second cart line and loops back to add-more', async () => {
        const session = makeSession({
            current_step: 'COLLECTING_QUANTITY',
            product_info: { id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 1 },
            step_data: { language: 'en', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, '2', null);

        expect(res.current_step).toBe('ADD_MORE');
        expect(res.step_data.cart).toHaveLength(2);
        expect(res.step_data.cart[1]).toEqual(expect.objectContaining({ product_id: 'prod-2', quantity: 2 }));
    });

    test('an ambiguous second product routes to the numbered picker', async () => {
        productSearch.searchForOrder.mockResolvedValue({
            products: [
                { id: 'prod-2', name: 'Silk Dupatta', price: 500, in_stock: true },
                { id: 'prod-3', name: 'Cotton Dupatta', price: 350, in_stock: true },
            ],
            wasFallback: false,
        });
        const session = makeSession({
            current_step: 'ADD_MORE',
            step_data: { language: 'en', cart: cartWith({ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }) },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'dupatta', null);

        expect(res.current_step).toBe('SELECTING_PRODUCT');
        expect(res.prompt).toMatch(/1\./); // a numbered list
    });
});

describe('multi-item order: summary, create, invoice', () => {
    const drainImmediates = () => new Promise(resolve => setImmediate(resolve));
    const twoLineCart = () => ([
        { product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 },
        { product_id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 2 },
    ]);
    const stepData = () => ({
        language: 'en',
        name: 'Evan',
        phone: '01886895874',
        address: 'Mirpur, Dhaka',
        delivery_charge: 60,
        payment_method: 'cod',
        cart: twoLineCart(),
    });

    test('the summary lists every line and sums items + delivery', () => {
        const session = makeSession({ product_info: null, step_data: {} });
        const summary = OrderSessionService.generateOrderSummary(session, stepData(), 'en');

        expect(summary).toContain('Azal Lawn');
        expect(summary).toContain('Silk Dupatta');
        expect(summary).toContain('2650');  // items subtotal: 1650 + 2*500
        expect(summary).toContain('2710');  // grand total: + 60 delivery
    });

    test('confirming creates an order with N items and an N-line invoice', async () => {
        productSearch.checkStock.mockResolvedValue({ available: true });
        createOrderInternal.mockResolvedValue({
            id: 'ord-2', order_number: '100002', total: 2710, shop_id: 'shop-1', payment_method: 'cod',
        });
        issueInvoiceForOrder.mockResolvedValue({
            invoice: { invoice_number: 'INV-100002' },
            text: '🧾 INVOICE\nTotal: ৳2710',
        });
        const session = makeSession({
            current_step: 'ORDER_SUMMARY',
            product_info: { id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 2 },
            step_data: stepData(),
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'confirm', null, { conversationId: 'conv-1' });
        await drainImmediates();

        expect(res.completed).toBe(true);

        // Order created with both lines (catalog-priced — price omitted).
        const [, orderData] = createOrderInternal.mock.calls[0];
        expect(orderData.items).toEqual([
            { product_id: 'prod-1', quantity: 1 },
            { product_id: 'prod-2', quantity: 2 },
        ]);

        // Stock re-checked for EVERY line before committing.
        expect(productSearch.checkStock).toHaveBeenCalledWith('prod-1', 'shop-1', 1);
        expect(productSearch.checkStock).toHaveBeenCalledWith('prod-2', 'shop-1', 2);

        // Invoice carries both display lines.
        const [, optsArg] = issueInvoiceForOrder.mock.calls[0];
        expect(optsArg.items).toHaveLength(2);
        expect(optsArg.items[1]).toEqual(expect.objectContaining({ name: 'Silk Dupatta', quantity: 2, total: 1000 }));
    });

    test('requires a fresh customer confirmation when tracked stock changes but remains available', async () => {
        productSearch.checkStock.mockResolvedValue({
            available: true,
            product: { id: 'prod-1', track_quantity: true, quantity: 8, price: 1650 },
        });
        authorize.mockResolvedValueOnce({ authorized: false, reasonCode: 'material_state_revalidated' });
        const session = makeSession({
            current_step: 'ORDER_SUMMARY',
            product_info: { id: 'prod-1', name: 'Azal Lawn Two Piece', price: 1650, quantity: 1, track_quantity: true, stock_snapshot: 10 },
            step_data: {
                language: 'en',
                name: 'Evan',
                phone: '01886895874',
                address: 'Mirpur, Dhaka',
                delivery_charge: 60,
                payment_method: 'cod',
                cart: [{ product_id: 'prod-1', name: 'Azal Lawn Two Piece', price: 1650, quantity: 1, track_quantity: true, stock_snapshot: 10 }],
            },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'confirm', null, { conversationId: 'conv-1' });

        expect(res.current_step).toBe('ORDER_SUMMARY');
        expect(res.mutation_blocked).toBe(true);
        expect(res.prompt).toMatch(/stock availability changed/i);
        expect(res.step_data.cart[0].stock_snapshot).toBe(8);
        expect(authorize.mock.calls[0][1].materialStateRevalidated).toBe(false);
        expect(authorize.mock.calls[0][1].customerConfirmationValid).toBe(false);
        expect(createOrderInternal).not.toHaveBeenCalled();
    });

    test('confirmation appends the shop closing message (thank-you + social links)', async () => {
        productSearch.checkStock.mockResolvedValue({ available: true });
        createOrderInternal.mockResolvedValue({
            id: 'ord-3', order_number: '100003', total: 1650, shop_id: 'shop-1', payment_method: 'cod',
        });
        issueInvoiceForOrder.mockResolvedValue({ invoice: { invoice_number: 'INV-100003' }, text: '🧾 INVOICE' });
        ShopEntity.findByPk.mockResolvedValue({
            settings: {
                ai: { closing: { enabled: true, custom_text: 'Thank you for shopping!' } },
                businessInfo: { socialLinks: { facebook: 'https://fb.com/rina' } },
            },
        });
        const session = makeSession({
            current_step: 'ORDER_SUMMARY',
            product_info: { id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 },
            step_data: {
                language: 'en', name: 'Evan', phone: '01886895874', address: 'Mirpur, Dhaka',
                delivery_charge: 60, payment_method: 'cod',
                cart: [{ product_id: 'prod-1', name: 'Azal Lawn', price: 1650, quantity: 1 }],
            },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'confirm', null, { conversationId: 'conv-1' });
        await drainImmediates();

        expect(res.completed).toBe(true);
        expect(res.prompt).toContain('Thank you for shopping!');
        expect(res.prompt).toContain('Follow us:');
        expect(res.prompt).toContain('https://fb.com/rina');
    });

    test('an out-of-stock line at confirmation cancels with the real reason', async () => {
        productSearch.checkStock
            .mockResolvedValueOnce({ available: true })                                  // prod-1 ok
            .mockResolvedValueOnce({ available: false, reason: 'out of stock' });         // prod-2 gone
        const session = makeSession({
            current_step: 'ORDER_SUMMARY',
            product_info: { id: 'prod-2', name: 'Silk Dupatta', price: 500, quantity: 2 },
            step_data: stepData(),
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'confirm', null, { conversationId: 'conv-1' });

        expect(res.completed).toBeFalsy();
        expect(res.cancelled).toBe(true);
        expect(res.prompt).toMatch(/Silk Dupatta/);
        expect(createOrderInternal).not.toHaveBeenCalled();
    });
});

// Founder feedback 2026-06-12: with only COD available, asking the customer to
// "select a payment method" (with COD the sole option) is pointless friction.
describe('COLLECTING_ZONE → payment routing', () => {
    beforeEach(() => {
        ShopEntity.findByPk.mockResolvedValue(null); // → default BD zones
    });

    const zoneSession = () => makeSession({
        current_step: 'COLLECTING_ZONE',
        step_data: {
            language: 'bn',
            address: 'Mirpur 10, Dhaka',
            delivery_zones: [{ zone: 'inside_dhaka', charge: 60 }],
        },
    });

    test('skips the payment step when COD is the only enabled gateway', async () => {
        PaymentConfigEntity.findAll.mockResolvedValue([{ gateway: 'cod' }]);
        const res = await OrderSessionService.handleCurrentStep(zoneSession(), '1', null);

        expect(res.current_step).toBe('COLLECTING_NOTES');
        expect(res.step_data.payment_method).toBe('cod');
        expect(res.prompt).not.toMatch(/পেমেন্ট পদ্ধতি নির্বাচন|select payment method/i);
    });

    test('still asks for payment when a second gateway is enabled', async () => {
        PaymentConfigEntity.findAll.mockResolvedValue([{ gateway: 'cod' }, { gateway: 'self-mfs' }]);
        const res = await OrderSessionService.handleCurrentStep(zoneSession(), '1', null);

        expect(res.current_step).toBe('COLLECTING_PAYMENT');
        expect(res.prompt).toMatch(/পেমেন্ট পদ্ধতি/);
    });
});

// Pilot+ P0-2: an OCR screenshot is NOT payment verification. The step machine
// must never tell a customer "Payment confirmed" from a screenshot, and the
// historical AWAITING_MFS_SCREENSHOT step (whose gateway condition was already
// unsatisfiable — enabled ids are only 'cod'|'self-mfs') recovers to the
// payment question instead of claiming verification. Payment truth remains
// merchant confirmation / verified gateway webhook only.
describe('self-MFS payment truth (P0-2)', () => {
    const { verifyPaymentScreenshot } = require('../../payment/self-mfs-handler.service');

    test('a legacy AWAITING_MFS_SCREENSHOT step never claims payment confirmed', async () => {
        verifyPaymentScreenshot.mockResolvedValue({ verified: true, trxId: 'TRXFAKE1', amount: 1650 });
        const session = makeSession({
            current_step: 'AWAITING_MFS_SCREENSHOT',
            step_data: {
                language: 'en',
                enabled_gateways: ['cod', 'self-mfs'],
                delivery_zone: 'inside_dhaka',
                delivery_charge: 60,
                total: 1710,
            },
        });

        const res = await OrderSessionService.handleCurrentStep(session, 'see attachment', {
            imageUrl: 'https://cdn.example.test/screenshot.png',
        });

        expect(verifyPaymentScreenshot).not.toHaveBeenCalled();
        expect(res.step_data.mfs_payment_verified).toBeUndefined();
        expect(res.prompt).not.toMatch(/Payment confirmed|পেমেন্ট নিশ্চিত/i);
        expect(res.current_step).toBe('COLLECTING_PAYMENT');
    });

    test('answering "bkash" when self-mfs is enabled advances without any screenshot claim', async () => {
        const session = makeSession({
            current_step: 'COLLECTING_PAYMENT',
            step_data: { language: 'en', enabled_gateways: ['cod', 'self-mfs'], delivery_zone: 'inside_dhaka', delivery_charge: 60 },
        });
        const res = await OrderSessionService.handleCurrentStep(session, 'bkash', null);

        expect(verifyPaymentScreenshot).not.toHaveBeenCalled();
        expect(res.current_step).toBe('COLLECTING_NOTES');
        expect(res.prompt).not.toMatch(/screenshot|স্ক্রিনশট/i);
        expect(res.step_data.payment_method).toBe('self-mfs');
    });

    test('service source contains no OCR-confirmation success path at all', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../order-session-standalone.service'), 'utf8');
        expect(src).not.toMatch(/verifyPaymentScreenshot/);
        expect(src).not.toMatch(/Payment confirmed ✅/);
        expect(src).not.toMatch(/পেমেন্ট নিশ্চিত হয়েছে/);
        expect(src).not.toMatch(/mfs_payment_verified\s*=\s*true/);
    });
});

// P+04 belt: identity-capturing steps must refuse question-shaped answers
// instead of storing "delivery charge koto?" as the customer's name, while
// ordinary names/addresses/digits keep flowing through unchanged.
describe('question-shape belt on capture steps (P+04)', () => {
    test.each([
        ['COLLECTING_NAME', 'delivery charge koto?'],
        ['COLLECTING_NAME', 'আপনার নাম কি?'],
        ['COLLECTING_PHONE', 'number ta ki apnar?'],
        ['COLLECTING_ADDRESS', 'which area deliver covers?'],
        ['COLLECTING_ZONE', 'কত charge?'],
    ])('%s refuses to store question %s as field data', async (step, answer) => {
        const session = makeSession({ current_step: step, step_data: { language: 'en' } });
        const res = await OrderSessionService.handleCurrentStep(session, answer, null);

        expect(res.question_deferred).toBe(true);
        expect(res.current_step).toBe(step);
        expect(session.update).not.toHaveBeenCalled();
    });

    test.each([
        ['COLLECTING_NAME', 'Rahim Uddin'],
        ['COLLECTING_NAME', 'Karim'],
        ['COLLECTING_PHONE', '01712345678'],
        ['COLLECTING_ADDRESS', 'House 12, Road 5, Mirpur 10, Dhaka'],
        ['COLLECTING_ZONE', '1'],
    ])('%s still accepts plain answer %s', async (step, answer) => {
        const session = makeSession({
            current_step: step,
            step_data: { language: 'en', enabled_gateways: ['cod'], delivery_charge: 60 },
        });
        const res = await OrderSessionService.handleCurrentStep(session, answer, null);

        expect(res.question_deferred).toBeUndefined();
    });
});

describe('customer-photo order selection policy', () => {
    test('unset photo flag skips image matching while preserving text lookup', async () => {
        const product = { id: 'prod-1', name: 'Lawn' };
        productSearch.searchForOrder.mockResolvedValue({ products: [product], wasFallback: false });

        const result = await OrderSessionService.identifyProduct('shop-1', 'lawn', {
            imageUrl: 'https://cdn.example.test/synthetic.jpg',
        });

        expect(result).toEqual({ products: [product], wasFallback: false });
        expect(matchImageMessage).not.toHaveBeenCalled();
    });

    test('unset photo flag skips image matching when text lookup has no result', async () => {
        const result = await OrderSessionService.identifyProduct('shop-1', '', {
            imageUrl: 'https://cdn.example.test/synthetic.jpg',
        });

        expect(result).toEqual({ products: [], wasFallback: true });
        expect(matchImageMessage).not.toHaveBeenCalled();
    });

    test('explicit opt-in keeps the image matcher available', async () => {
        const product = { id: 'prod-1', name: 'Lawn' };
        process.env.AI_PHOTO_MATCH_ENABLED = 'true';
        matchImageMessage.mockResolvedValue({ products: [product], method: 'vision', confidence: 0.9 });

        const result = await OrderSessionService.identifyProduct('shop-1', '', {
            imageUrl: 'https://cdn.example.test/synthetic.jpg',
        });

        expect(matchImageMessage).toHaveBeenCalledWith({
            shopId: 'shop-1', imageUrl: 'https://cdn.example.test/synthetic.jpg', text: '',
        });
        expect(result).toEqual({ products: [product], wasFallback: false });
    });

    test('product prompts do not advertise photo selection while matching is disabled', () => {
        expect(OrderSessionService.generateStepPrompt('ADDING_PRODUCT', {}, 'en')).not.toMatch(/photo/i);
        expect(OrderSessionService.buildAddMorePrompt({ name: 'Lawn' }, [], 'en')).not.toMatch(/photo/i);
        expect(OrderSessionService.buildMultiAddPrompt([{ name: 'Lawn', quantity: 1 }], [], [], 'en'))
            .not.toMatch(/photo/i);
    });
});

// Founder feedback 2026-06-13: infer the delivery zone from the typed address and
// apply the charge automatically; only ask inside/outside Dhaka when it's unclear.
describe('COLLECTING_ADDRESS → zone auto-detection', () => {
    beforeEach(() => {
        ShopEntity.findByPk.mockResolvedValue(null); // → default BD zones (60/80/120)
        PaymentConfigEntity.findAll.mockResolvedValue([{ gateway: 'cod' }]); // COD only
    });

    const addressSession = () => makeSession({
        current_step: 'COLLECTING_ADDRESS',
        step_data: { language: 'bn', name: 'Evan', phone: '01712345678' },
    });

    test('a Dhaka-city address auto-applies inside_dhaka and skips the zone question', async () => {
        const res = await OrderSessionService.handleCurrentStep(addressSession(), 'Mirpur 10, Dhaka', null);

        expect(res.step_data.delivery_zone).toBe('inside_dhaka');
        expect(res.step_data.delivery_charge).toBe(60);
        expect(res.current_step).toBe('COLLECTING_NOTES');
        expect(res.step_data.payment_method).toBe('cod');
        expect(res.prompt).toMatch(/৳60/);
        expect(res.prompt).not.toMatch(/ডেলিভারি এলাকা নির্বাচন|select your delivery area/i);
    });

    test('an out-of-Dhaka district auto-applies outside_dhaka', async () => {
        const res = await OrderSessionService.handleCurrentStep(addressSession(), 'Agrabad, Chittagong', null);

        expect(res.step_data.delivery_zone).toBe('outside_dhaka');
        expect(res.step_data.delivery_charge).toBe(120);
        expect(res.current_step).toBe('COLLECTING_NOTES');
    });

    test('a sub-Dhaka area auto-applies sub_dhaka', async () => {
        const res = await OrderSessionService.handleCurrentStep(addressSession(), 'Savar Bazar Road', null);

        expect(res.step_data.delivery_zone).toBe('sub_dhaka');
        expect(res.step_data.delivery_charge).toBe(80);
    });

    test('an unrecognisable address falls back to ASKING the zone', async () => {
        const res = await OrderSessionService.handleCurrentStep(addressSession(), 'House 5, Road 3, Block C', null);

        expect(res.current_step).toBe('COLLECTING_ZONE');
        expect(res.step_data.delivery_zone).toBeUndefined();
        expect(res.prompt).toMatch(/এলাকা|delivery area/i);
    });

    test('with a second gateway enabled, detection still routes to the payment step', async () => {
        PaymentConfigEntity.findAll.mockResolvedValue([{ gateway: 'cod' }, { gateway: 'self-mfs' }]);
        const res = await OrderSessionService.handleCurrentStep(addressSession(), 'Uttara Sector 7', null);

        expect(res.step_data.delivery_zone).toBe('inside_dhaka');
        expect(res.current_step).toBe('COLLECTING_PAYMENT');
        expect(res.prompt).toMatch(/পেমেন্ট পদ্ধতি/);
    });
});

// Founder feedback 2026-06-12: the bot replied in Bengali AND English at once.
// Every prompt must now be a single language matching the customer.
describe('single-language prompts (never both at once)', () => {
    test('an English session emits no Bengali script', async () => {
        const session = makeSession({ current_step: 'COLLECTING_NAME', step_data: { language: 'en' } });
        const res = await OrderSessionService.handleCurrentStep(session, 'Evan', null);

        expect(res.prompt).toMatch(/mobile number/i);
        expect(res.prompt).not.toMatch(/[ঀ-৿]/); // no Bengali codepoints
    });

    test('a Bengali session adds no English translation', async () => {
        const session = makeSession({ current_step: 'COLLECTING_NAME', step_data: { language: 'bn' } });
        const res = await OrderSessionService.handleCurrentStep(session, 'Evan', null);

        expect(res.prompt).toMatch(/মোবাইল/);
        expect(res.prompt).not.toMatch(/mobile number/i);
    });
});
