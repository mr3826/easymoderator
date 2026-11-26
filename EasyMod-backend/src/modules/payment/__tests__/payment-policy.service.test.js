'use strict';

/**
 * A5 policies API service — §5.2 validation matrix (all 5 enums × bounds),
 * paymentMessage preservation (now really persisted), cache invalidation.
 */
process.env.NODE_ENV = 'test';

const mockShop = {
    sequelize: { transaction: jest.fn((cb) => cb({ LOCK: { UPDATE: 'FOR UPDATE' } })) },
    findByPk: jest.fn(),
};
jest.mock('../../entities', () => ({ Shop: mockShop }));
jest.mock('../../shop/shop-settings.validator', () => ({
    mergeSettingsPreservingRtoConsent: (current, patch) => ({ ...(current || {}), ...(patch || {}) }),
}));
jest.mock('../../../utils/shop-settings-cache', () => ({
    invalidateShopSettingsCaches: jest.fn().mockResolvedValue(undefined),
}));

const policy = require('../payment-policy.service');
const { invalidateShopSettingsCaches } = require('../../../utils/shop-settings-cache');

beforeEach(() => {
    jest.clearAllMocks();
    mockShop.findByPk.mockResolvedValue({ settings: {}, update: jest.fn().mockResolvedValue(true) });
});

describe('payment-policy.service — validation matrix (§5.2)', () => {
    const cases = [
        [{ advance_policy: 'none' }, { advance_policy: 'none', advance_value: null }],
        [{ advance_policy: 'full' }, { advance_policy: 'full', advance_value: null }],
        [{ advance_policy: 'delivery_charge' }, { advance_policy: 'delivery_charge', advance_value: null }],
        [{ advance_policy: 'percentage', advance_value: 50 }, { advance_value: 50 }],
        [{ advance_policy: 'fixed', advance_value: 200 }, { advance_value: 200 }],
    ];
    test.each(cases)('accepts %p', (input, expectPartial) => {
        const built = policy.validateAndBuildPolicy(input);
        expect(built).toMatchObject(expectPartial);
    });

    test('legacy "delivery" radio alias maps to delivery_charge (§5.2)', () => {
        expect(policy.validateAndBuildPolicy({ advance_policy: 'delivery' }).advance_policy).toBe('delivery_charge');
    });

    test('legacy FE radio keys still accepted (advancePaymentRule / advancePercentage / advanceFixed / paymentMessage)', () => {
        const built = policy.validateAndBuildPolicy({
            advancePaymentRule: 'percentage', advancePercentage: 30, paymentMessage: 'Pay advance first',
        });
        expect(built).toEqual({ advance_policy: 'percentage', advance_value: 30, payment_message: 'Pay advance first' });
    });

    test('percentage out of 1..99 rejected', () => {
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'percentage', advance_value: 0 })).toThrow();
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'percentage', advance_value: 100 })).toThrow();
    });

    test('fixed must be >= 1 (positive) — fixed>0 legality (§5.2)', () => {
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'fixed', advance_value: 0 })).toThrow();
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'fixed', advance_value: -5 })).toThrow();
    });

    test('none/full/delivery_charge reject a stray advance_value (no dual meaning)', () => {
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'full', advance_value: 10 }))
            .toThrow(/must be empty/);
    });

    test('unknown policy rejected', () => {
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'half' })).toThrow();
    });

    test('payment_message capped at 500 chars (§5.2)', () => {
        expect(() => policy.validateAndBuildPolicy({ advance_policy: 'none', payment_message: 'x'.repeat(501) }))
            .toThrow(/500 characters/);
    });
});

describe('payment-policy.service — persistence + cache invalidation (§5.1/§5.3)', () => {
    test('update writes settings.payments and invalidates shop caches', async () => {
        const update = jest.fn().mockResolvedValue(true);
        mockShop.findByPk.mockResolvedValue({ settings: {}, update });

        const result = await policy.updatePaymentPolicy('shop-1', 'user-1', {
            advance_policy: 'percentage', advance_value: 25, payment_message: 'Half now',
        });

        expect(result.advance_policy).toBe('percentage');
        expect(result.updated_by).toBe('user-1');
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            settings: expect.objectContaining({
                payments: expect.objectContaining({ advance_policy: 'percentage', advance_value: 25, payment_message: 'Half now' }),
            }),
        }), expect.anything());
        expect(invalidateShopSettingsCaches).toHaveBeenCalledWith('shop-1');
    });

    test('paymentMessage is REALLY persisted now and round-trips from the server (§5.1 defect fix)', async () => {
        const stored = { payments: { advance_policy: 'fixed', advance_value: 500, payment_message: 'Send to 01711111111' } };
        mockShop.findByPk.mockResolvedValue({ settings: stored });
        const got = await policy.getPaymentPolicy('shop-1', 'user-1');
        expect(got.payment_message).toBe('Send to 01711111111');
        expect(got.advance_value).toBe(500);
        expect(got._shop_id).toBe('shop-1');
    });

    test('unconfigured shop returns honest defaults (never a fake persisted blob)', async () => {
        mockShop.findByPk.mockResolvedValue({ settings: {} });
        const got = await policy.getPaymentPolicy('shop-1', 'user-1');
        expect(got.advance_policy).toBe('none');
        expect(got.advance_value).toBeNull();
    });
});

describe('payment-policy.service — computeAdvance (§5.2 checkout math, delivery-charge is referenced not recomputed)', () => {
    test('fixed >= total behaves as full, never exceeds', () => {
        expect(policy.computeAdvance({ policy: 'fixed', value: 9999, orderTotal: 500, deliveryCharge: 60 }))
            .toMatchObject({ advance_amount: 500, remainder: 0, note: 'fixed_gte_total_treated_as_full' });
    });
    test('percentage computes rounded advance + remainder', () => {
        expect(policy.computeAdvance({ policy: 'percentage', value: 50, orderTotal: 1000, deliveryCharge: 0 }))
            .toMatchObject({ advance_amount: 500, remainder: 500 });
    });
    test('delivery_charge references the passed zone-computed fee, never recomputes it', () => {
        expect(policy.computeAdvance({ policy: 'delivery_charge', value: null, orderTotal: 1200, deliveryCharge: 80 }))
            .toMatchObject({ advance_amount: 80, remainder: 1120 });
    });
    test('none ⇒ advance 0', () => {
        expect(policy.computeAdvance({ policy: 'none', orderTotal: 700, deliveryCharge: 0 }))
            .toMatchObject({ advance_amount: 0, remainder: 700 });
    });
});
