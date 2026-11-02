'use strict';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockOrderFindAll = jest.fn();
const mockOrderFindOne = jest.fn();
const mockConfidenceUpdate = jest.fn();
const mockCheckPhone = jest.fn();
const mockGetNetworkSettings = jest.fn();
const mockGetPilotFeatures = jest.fn();
const mockMetricsIncrement = jest.fn();

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => mockLogger),
}));
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { literal: jest.fn((value) => value) },
}));
jest.mock('sequelize', () => ({
    Op: { ne: Symbol('ne'), in: Symbol('in'), or: Symbol('or') },
}));
jest.mock('../../entities', () => ({
    Order: {
        findAll: (...args) => mockOrderFindAll(...args),
        findOne: (...args) => mockOrderFindOne(...args),
    },
    OrderConfidence: { update: (...args) => mockConfidenceUpdate(...args) },
}));
jest.mock('../../rto-shield/rto-shield.service', () => ({
    checkPhone: (...args) => mockCheckPhone(...args),
}));
jest.mock('../../rto-shield/rto-network-settings', () => ({
    getNetworkSettings: (...args) => mockGetNetworkSettings(...args),
}));
jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: (...args) => mockGetPilotFeatures(...args),
}));
jest.mock('../../pilot-features/pilot-metrics', () => ({
    increment: (...args) => mockMetricsIncrement(...args),
}));

const orderConfidence = require('../order-confidence.service');
const { OUTCOMES } = require('../../customer-intelligence/order-outcome');

const SECRET_ERROR = 'database detail includes private phone 01712345678';

beforeEach(() => {
    jest.clearAllMocks();
    mockOrderFindAll.mockRejectedValue(new Error(SECRET_ERROR));
    mockOrderFindOne.mockRejectedValue(new Error(SECRET_ERROR));
    mockConfidenceUpdate.mockRejectedValue(new Error(SECRET_ERROR));
    mockCheckPhone.mockRejectedValue(new Error(SECRET_ERROR));
    mockGetNetworkSettings.mockResolvedValue({ enforce: true });
    mockGetPilotFeatures.mockResolvedValue({ orderConfidenceMode: 'enforce', orderConfidenceConfig: {} });
});

test('Order Confidence failure logs use stable codes and safe identifiers only', async () => {
    const order = {
        id: 'order-1',
        shop_id: 'shop-1',
        customer_phone: '01712345678',
        payment_method: 'bkash',
        order_status: 'confirmed',
    };

    const facts = await orderConfidence.gatherFacts(order, 'shop-1');
    expect(facts.history).toBeNull();
    expect(facts.rtoShield).toBeNull();

    const gate = await orderConfidence.checkBookingGate(order, 'shop-1', { trigger: 'MANUAL' });
    expect(gate).toMatchObject({ allowed: false, engineFailure: true });

    await expect(orderConfidence.recordOutcome({ ...order, delivery_status: 'returned' }))
        .resolves.toBe(false);

    expect(mockLogger.warn).toHaveBeenNthCalledWith(1, 'order_confidence.history_unavailable', {
        shopId: 'shop-1', orderId: 'order-1', code: 'ORDER_CONFIDENCE_HISTORY_UNAVAILABLE',
    });
    expect(mockLogger.warn).toHaveBeenNthCalledWith(2, 'order_confidence.rto_shield_unavailable', {
        shopId: 'shop-1', orderId: 'order-1', code: 'ORDER_CONFIDENCE_RTO_SHIELD_UNAVAILABLE',
    });
    expect(mockLogger.error).toHaveBeenCalledWith('order_confidence.engine_failure', {
        shopId: 'shop-1', orderId: 'order-1', code: 'ORDER_CONFIDENCE_ENGINE_FAILURE',
    });
    expect(mockLogger.warn).toHaveBeenNthCalledWith(3, 'order_confidence.outcome_hook_failed', {
        shopId: 'shop-1', orderId: 'order-1', code: 'ORDER_CONFIDENCE_OUTCOME_HOOK_FAILED',
    });
    expect(JSON.stringify(mockLogger.warn.mock.calls.concat(mockLogger.error.mock.calls)))
        .not.toContain(SECRET_ERROR);
});

test('the confidence RTO input uses local-only evidence when network enforcement is disabled', async () => {
    const order = {
        id: 'order-2',
        shop_id: 'shop-1',
        customer_phone: '01712345678',
        payment_method: 'COD',
        order_status: 'confirmed',
    };
    mockGetNetworkSettings.mockResolvedValue({ enforce: false });
    mockOrderFindAll.mockResolvedValue([]);
    mockCheckPhone.mockResolvedValue({ flagged: false, tier: 'clear', risk_score: 0 });

    await orderConfidence.gatherFacts(order, 'shop-1');

    expect(mockCheckPhone).toHaveBeenCalledWith('01712345678', 'shop-1', {
        trustedContext: true,
        enforceNetwork: false,
    });
});

test('only an authoritative returned delivery status is stored as Order Confidence RTO outcome', async () => {
    mockConfidenceUpdate.mockResolvedValue([1]);
    const order = {
        id: 'order-outcome-1',
        shop_id: 'shop-1',
        order_status: 'cancelled',
        delivery_tracking_code: 'TRACKING-1',
    };

    await expect(orderConfidence.recordOutcome({ ...order, delivery_status: 'cancelled' })).resolves.toBe(false);
    await expect(orderConfidence.recordOutcome({ ...order, delivery_status: 'failed_delivery' })).resolves.toBe(false);
    expect(mockConfidenceUpdate).not.toHaveBeenCalled();

    await expect(orderConfidence.recordOutcome({ ...order, delivery_status: 'returned' })).resolves.toBe(true);
    expect(mockConfidenceUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: OUTCOMES.RETURNED }),
        { where: { order_id: 'order-outcome-1', shop_id: 'shop-1', outcome: null } },
    );
});
