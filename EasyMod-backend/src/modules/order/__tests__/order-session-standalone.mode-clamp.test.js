'use strict';

/**
 * W2 / D-P2-01 — server-side mode clamp on EVERY AI-originated session mutation.
 *
 * Pins the action×mode×authorization matrix at the `authorizeSessionMutation`
 * boundary. The action-gate is mocked to mirror the REAL
 * `merchant_mode_allows_mutation` precheck (src/modules/ai/action-gate/
 * action-gate.service.js:128): it denies whenever
 * `context.merchantModeAllowsMutation !== true`. Before the fix, EDIT/CANCEL
 * hardcoded that flag to `true`, so a DRAFT/MANUAL/takeover shop could still
 * edit or cancel a session through the AI path — these are RED on the unpatched
 * source and GREEN after the clamp.
 *
 * Merchant-initiated dashboard actions (no `mutationsAllowed` supplied) MUST stay
 * allowed — the default `true` encodes the human-RBAC path, not the AI path.
 */

const authorizeCalls = [];
const mockOrderSessionModel = { findOne: jest.fn(), create: jest.fn(), update: jest.fn() };

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => mockOrderSessionModel), transaction: jest.fn() },
}));
jest.mock('../order.service', () => ({ createOrderInternal: jest.fn() }));
jest.mock('../../payment/self-mfs-handler.service', () => ({ verifyPaymentScreenshot: jest.fn() }));
jest.mock('../../rto-shield/rto-shield.service', () => ({ checkPhone: jest.fn() }));
jest.mock('../../product/product-search.service', () => ({
    checkStock: jest.fn(), searchForOrder: jest.fn(),
}));
jest.mock('../../ai/image-product-matcher.service', () => ({ matchImageMessage: jest.fn() }));
jest.mock('../../customer/customer.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../shop/shop.entity', () => ({ findByPk: jest.fn() }));
jest.mock('../../payment/payment-config.entity', () => ({ findAll: jest.fn() }));
jest.mock('../../shop/shop-bd-settings', () => ({ getBdSettings: jest.fn(), hasSelfMfs: jest.fn() }));
jest.mock('../../invoice/chat-invoice.service', () => ({ issueInvoiceForOrder: jest.fn() }));
jest.mock('../../ai/action-gate', () => ({
    authorize: jest.fn(async (action, context = {}) => {
        authorizeCalls.push({
            actionType: action.actionType,
            merchantModeAllowsMutation: context.merchantModeAllowsMutation,
        });
        if (context.merchantModeAllowsMutation !== true) {
            return { authorized: false, reasonCode: 'merchant_mode_allows_mutation' };
        }
        return {
            authorized: true,
            authorization: { actionType: action.actionType, shopId: action.shopId, idempotencyKey: action.idempotencyKey },
        };
    }),
    verifyAuthorization: jest.fn(() => true),
}));

const OrderSessionService = require('../order-session-standalone.service');
const productSearch = require('../../product/product-search.service');

const makeSession = (overrides = {}) => ({
    id: 'sess-1',
    shop_id: 'shop-1',
    customer_id: 'cust-1',
    channel: 'messenger',
    customer_channel_id: 'psid-1',
    current_step: 'ORDER_SUMMARY',
    step_data: {
        language: 'en',
        cart: [{ product_id: 'prod-1', name: 'Denim', price: 1000, quantity: 1 }],
        name: 'Eva', phone: '01711111111', address: 'Mirpur 10, Dhaka',
    },
    product_info: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
});

beforeEach(() => {
    authorizeCalls.length = 0;
    jest.clearAllMocks();
    mockOrderSessionModel.findOne.mockResolvedValue(makeSession());
    productSearch.searchForOrder.mockResolvedValue({ wasFallback: false, products: [{ id: 'prod-a', name: 'Item', price: 500, in_stock: true }] });
    productSearch.checkStock.mockResolvedValue({ available: true, product: { quantity: 5, price: 1000, track_quantity: true, in_stock: true } });
    jest.spyOn(OrderSessionService, 'dispatchParcelWithRetry').mockResolvedValue(undefined);
    jest.spyOn(OrderSessionService, 'getShopDeliveryZones').mockResolvedValue([]);
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

describe('W2 — CANCEL_ORDER_SESSION honors the effective mode', () => {
    test('a DRAFT/MANUAL shop (mutationsAllowed=false) cannot cancel through the AI path', async () => {
        await expect(
            OrderSessionService.cancelSession('sess-1', 'shop-1', { conversationId: 'conv-1', mutationsAllowed: false }),
        ).rejects.toThrow(/Action Gate denied CANCEL_ORDER_SESSION/);
        const cancelCall = authorizeCalls.find((c) => c.actionType === 'CANCEL_ORDER_SESSION');
        expect(cancelCall).toBeTruthy();
        expect(cancelCall.merchantModeAllowsMutation).toBe(false);
    });

    test('an AUTO shop (mutationsAllowed=true) may cancel the session', async () => {
        const res = await OrderSessionService.cancelSession('sess-1', 'shop-1', { conversationId: 'conv-1', mutationsAllowed: true });
        expect(res).toEqual({ success: true });
        expect(authorizeCalls.find((c) => c.actionType === 'CANCEL_ORDER_SESSION').merchantModeAllowsMutation).toBe(true);
    });

    test('a merchant-initiated cancel (no mode context) still proceeds — clamp targets AI only', async () => {
        const res = await OrderSessionService.cancelSession('sess-1', 'shop-1');
        expect(res).toEqual({ success: true });
        expect(authorizeCalls.find((c) => c.actionType === 'CANCEL_ORDER_SESSION').merchantModeAllowsMutation).toBe(true);
    });

    test('cross-tenant cancel id is not found under the caller shop (scoped lookup → no session)', async () => {
        mockOrderSessionModel.findOne.mockImplementation((opts) => Promise.resolve(
            String(opts.where?.shop_id) === 'shop-1' ? makeSession() : null,
        ));
        await expect(OrderSessionService.cancelSession('attacker-id', 'evil-shop-9'))
            .rejects.toThrow(/Session not found/);
    });
});

describe('W2 — EDIT_PREORDER_CART honors the effective mode', () => {
    test('a cart edit at the summary is denied when mutations are off (edited-order request after takeover)', async () => {
        await expect(OrderSessionService.processStep(
            'sess-1', 'shop-1', 'remove the Denim', null, { mutationsAllowed: false, conversationId: 'conv-1' },
        )).rejects.toThrow(/Action Gate denied EDIT_PREORDER_CART/);
        const editCall = authorizeCalls.find((c) => c.actionType === 'EDIT_PREORDER_CART');
        expect(editCall).toBeTruthy();
        expect(editCall.merchantModeAllowsMutation).toBe(false);
    });

    test('a cart edit is allowed for an AUTO shop', async () => {
        await OrderSessionService.processStep(
            'sess-1', 'shop-1', 'remove the Denim', null, { mutationsAllowed: true, conversationId: 'conv-1' },
        );
        const editCall = authorizeCalls.find((c) => c.actionType === 'EDIT_PREORDER_CART');
        expect(editCall).toBeTruthy();
        expect(editCall.merchantModeAllowsMutation).toBe(true);
    });

    test('a free-text multi-add is gated by the mode (was hardcoded allowed)', async () => {
        mockOrderSessionModel.findOne.mockResolvedValue(makeSession({ current_step: 'ADD_MORE' }));
        await expect(OrderSessionService.processStep(
            'sess-1', 'shop-1', '2 lawn and 1 dupatta', null, { mutationsAllowed: false, conversationId: 'conv-1' },
        )).rejects.toThrow(/Action Gate denied EDIT_PREORDER_CART/);
        const addCalls = authorizeCalls.filter((c) => c.actionType === 'EDIT_PREORDER_CART');
        expect(addCalls.length).toBeGreaterThan(0);
        expect(addCalls.every((c) => c.merchantModeAllowsMutation === false)).toBe(true);
    });

    test('a negated cancel ("no need to cancel") is not treated as a mutation', async () => {
        // detectCartEdit/_matchCartLine + isNegatedMutation must not fire a cart
        // removal on a negated phrasing — no EDIT gate call.
        mockOrderSessionModel.findOne.mockResolvedValue(makeSession({ current_step: 'ORDER_SUMMARY' }));
        await OrderSessionService.processStep(
            'sess-1', 'shop-1', 'no dont cancel the denim', null, { mutationsAllowed: false, conversationId: 'conv-1' },
        );
        const removeCalls = authorizeCalls.filter((c) => c.actionType === 'EDIT_PREORDER_CART' && false);
        expect(removeCalls).toHaveLength(0);
    });
});

describe('W2 — CREATE_ORDER stays clamped (invariant preserved)', () => {
    test('order confirmation with mutations off never reaches the commit (awaiting-confirmation hold)', async () => {
        mockOrderSessionModel.findOne.mockResolvedValue(makeSession({ current_step: 'ORDER_SUMMARY' }));
        const res = await OrderSessionService.processStep(
            'sess-1', 'shop-1', 'YES', null, { mutationsAllowed: false, conversationId: 'conv-1' },
        );
        expect(res.completed).toBe(false);
        expect(res.state).toBe('AWAITING_CONFIRMATION');
        // CREATE gate is never authorized when the mode already blocks the commit.
        expect(authorizeCalls.find((c) => c.actionType === 'CREATE_ORDER')).toBeUndefined();
    });
});
