/**
 * buildCourierOrderData — COD/collection amount tests
 *
 * Courier collection must be based on an explicit payment method, and an
 * unknown partial COD balance must not fall back to the order face value.
 */

// Mock entities before requiring service (mirrors order.service.test.js).
jest.mock('../../entities', () => ({
    Order: {
        findOne: jest.fn(),
        findAll: jest.fn(),
        findAndCountAll: jest.fn(),
        create: jest.fn()
    },
    OrderItem: {
        findAll: jest.fn(),
        create: jest.fn()
    },
    Product: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        decrement: jest.fn(),
        increment: jest.fn()
    },
    Customer: {
        findOne: jest.fn()
    },
    UserShop: {
        findOne: jest.fn()
    },
    OrderReturn: {
        create: jest.fn()
    },
    Channel: {
        findOne: jest.fn()
    }
}));

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (cb) => {
            const t = { commit: jest.fn(), rollback: jest.fn() };
            if (typeof cb === 'function') return cb(t);
            return t;
        }),
        query: jest.fn(),
        getDialect: jest.fn()
    }
}));

jest.mock('../../subscription/subscription.service', () => ({
    checkOrderLimit: jest.fn(),
    trackUsage: jest.fn()
}));

jest.mock('../../rto-shield/rto-shield.service', () => ({
    checkPhone: jest.fn()
}));

jest.mock('../../rto-shield/rto-network-settings', () => ({
    getNetworkSettings: jest.fn().mockResolvedValue({ contribute: true, enforce: true })
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }))
}));

jest.mock('../../product/stock-status-guard.service', () => ({
    invalidate: jest.fn()
}));

jest.mock('../../delivery/delivery.service', () => ({
    getTracking: jest.fn(),
    syncStatus: jest.fn(),
    createConsignment: jest.fn(),
    getActiveProvider: jest.fn(),
    createOrder: jest.fn()
}));

const { buildCourierOrderData } = require('../order.service');
const { AppError } = require('../../../utils/AppError');

const baseOrder = (overrides = {}) => ({
    id: 'order-1',
    order_number: 'ORD-TEST-0001',
    customer_name: 'Rahim',
    customer_phone: '01711111111',
    delivery_address: {
        street_address: 'Road 1',
        upazila: 'Dhanmondi',
        district: 'Dhaka',
    },
    total: 1500,
    payment_method: 'COD',
    items: [{ name: 'Red Saree', quantity: 1 }],
    ...overrides,
});
const captureBuildError = (order) => {
    try {
        buildCourierOrderData(order);
        return null;
    } catch (error) {
        return error;
    }
};

describe('buildCourierOrderData — safe courier collection amount', () => {
    test('prepaid order (payment_status: "paid") must not be re-collected as COD', () => {
        const order = baseOrder({ payment_status: 'paid' });

        const orderData = buildCourierOrderData(order);

        expect(orderData.cod_amount).toBe(0);
        expect(orderData.amount_to_collect).toBe(0);
        // The true order value is still reported (e.g. for courier declared value).
        expect(orderData.total).toBe(1500);
    });

    test('explicitly recorded unpaid COD collects the order total', () => {
        const order = baseOrder({ payment_status: 'unpaid' });

        const orderData = buildCourierOrderData(order);

        expect(orderData.cod_amount).toBe(1500);
        expect(orderData.amount_to_collect).toBe(1500);
        expect(orderData.total).toBe(1500);
    });

    test('ignores client-supplied collection amounts and derives COD from the order total', () => {
        const orderData = buildCourierOrderData(baseOrder({ payment_status: 'unpaid' }), {
            overrides: { cod_amount: 1, amount_to_collect: 2, total: 3 },
        });

        expect(orderData.cod_amount).toBe(1500);
        expect(orderData.amount_to_collect).toBe(1500);
        expect(orderData.total).toBe(1500);
    });

    test('explicit COD with no payment status is blocked instead of inferring the order total', () => {
        const order = baseOrder();
        delete order.payment_status;

        const error = captureBuildError(order);
        expect(error).toMatchObject({ status: 409, code: 'PAYMENT_STATUS_REQUIRED' });
        expect(error.message).toContain('payment status is verified');
    });

    test('partial COD without an authoritative due amount is blocked with a recoverable error', () => {
        const order = baseOrder({ payment_status: 'partially_paid' });

        const error = captureBuildError(order);
        expect(error).toMatchObject({
            status: 409,
            code: 'COD_DUE_AMOUNT_UNKNOWN',
        });
        expect(error.message).toContain('COD balance is unavailable');
    });

    test('COD with an unknown payment status does not infer the full order total', () => {
        const order = baseOrder({ payment_status: undefined });
        const error = captureBuildError(order);

        expect(error).toMatchObject({ status: 409, code: 'PAYMENT_STATUS_REQUIRED' });
        expect(error.message).toContain('payment status is verified');
    });

    test('an explicit non-COD method is never recast as COD', () => {
        const order = baseOrder({ payment_method: 'bKash', payment_status: 'unpaid' });

        const orderData = buildCourierOrderData(order);

        expect(orderData.cod_amount).toBe(0);
        expect(orderData.amount_to_collect).toBe(0);
    });

    test('missing payment method blocks unpaid courier booking instead of assuming COD', () => {
        const order = baseOrder({ payment_status: 'unpaid' });
        delete order.payment_method;

        const error = captureBuildError(order);
        expect(error).toMatchObject({
            status: 409,
            code: 'PAYMENT_METHOD_REQUIRED',
        });
        expect(error.message).toContain('Payment method is not recorded');
    });
});

describe('buildCourierOrderData — the order\'s own confirmed destination', () => {
    const withConfirmation = (overrides = {}) => baseOrder({
        payment_status: 'unpaid',
        delivery_location: JSON.stringify({
            provider_destination: {
                redx: { area_id: 77, area_name: 'Dhanmondi', district: 'Dhaka' },
            },
        }),
        ...overrides,
    });

    test('carries the ids the merchant confirmed for that courier', () => {
        const orderData = buildCourierOrderData(withConfirmation(), { provider: 'redx' });

        expect(orderData).toMatchObject({
            delivery_area_id: 77,
            delivery_area: 'Dhanmondi',
        });
    });

    test('never sends one courier\'s ids to another', () => {
        const orderData = buildCourierOrderData(withConfirmation(), { provider: 'pathao' });

        expect(orderData).not.toHaveProperty('delivery_area_id');
        expect(orderData).not.toHaveProperty('recipient_area', 77);
    });

    test('leaves the payload untouched when no courier is named', () => {
        const orderData = buildCourierOrderData(withConfirmation());

        expect(orderData).not.toHaveProperty('delivery_area_id');
    });
});
