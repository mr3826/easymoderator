'use strict';

jest.mock('../../entities', () => ({
    Subscription: { findOne: jest.fn(), create: jest.fn() },
    Invoice: { create: jest.fn(), findAll: jest.fn(), findOne: jest.fn() },
    UsageEvent: { findOne: jest.fn() },
    AuditLog: { create: jest.fn(), findOne: jest.fn(), findOrCreate: jest.fn() },
    UserShop: { findOne: jest.fn() },
    Order: { count: jest.fn() },
}));
jest.mock('../../../utils/cache.service', () => ({ clearForShop: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { Subscription, Invoice, UserShop } = require('../../entities');
const subscriptionService = require('../subscription.service');

const makeSubscription = (overrides = {}) => ({
    id: 'sub-1',
    shop_id: 'shop-1',
    plan_code: 'MERCHANT',
    plan_name: 'MERCHANT',
    plan_price: 0,
    billing_cycle: 'monthly',
    billing_model: 'per_order',
    conversations_limit: -1,
    orders_limit: -1,
    products_limit: -1,
    conversations_used: 12,
    orders_used: 0,
    products_used: 0,
    topup_balance: 30,
    current_period_start: new Date('2026-08-01T00:00:00.000Z'),
    current_period_end: new Date('2026-09-01T00:00:00.000Z'),
    // Apply the update in place so period assertions read what was written.
    update: jest.fn(function (values) { Object.assign(this, values); }),
    ...overrides,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / MS_PER_DAY);

beforeEach(() => {
    jest.clearAllMocks();
    UserShop.findOne.mockResolvedValue({ id: 'membership-1' });
    Invoice.create.mockResolvedValue({ id: 'invoice-1' });
});

describe('commercial subscription lifecycle (ADR-0011)', () => {
    it('creates the single MERCHANT delivered-order default with a current UTC month', async () => {
        const created = makeSubscription();
        Subscription.create.mockResolvedValueOnce(created);

        const before = new Date();
        const result = await subscriptionService.createDefaultSubscription('shop-1');
        const after = new Date();

        expect(Subscription.create).toHaveBeenCalledWith(expect.objectContaining({
            plan_code: 'MERCHANT',
            plan_name: 'MERCHANT',
            plan_price: 0,
            billing_model: 'per_order',
            per_order_charge_bdt: 10,
            conversations_limit: -1,
            orders_limit: -1,
            products_limit: -1,
            status: 'active',
            billing_cycle: 'monthly',
            trial_ends_at: null,
        }));

        const values = Subscription.create.mock.calls[0][0];
        expect(values.current_period_start.getUTCDate()).toBe(1);
        expect(values.current_period_start.getUTCHours()).toBe(0);
        expect(values.current_period_end.getUTCDate()).toBe(1);
        expect(values.current_period_start.getUTCFullYear()).toBe(before.getUTCFullYear());
        expect(values.current_period_end.getTime()).toBeGreaterThan(after.getTime() - MS_PER_DAY);
        expect(result).toBe(created);
    });

    it('returns the contract-derived shape and never the retired entitlement fields', async () => {
        const subscription = makeSubscription();
        Subscription.findOne.mockResolvedValueOnce(subscription);

        const data = await subscriptionService.getSubscription('shop-1', 'user-1');

        expect(data.plan).toEqual({ code: 'MERCHANT', name: 'MERCHANT', billing_model: 'per_order' });
        expect(data.contract).toEqual(expect.objectContaining({
            model: 'DELIVERED_ORDER',
            currency: 'BDT',
            unitPriceMinor: 1000,
            dueDays: 7,
            conversationEntitlement: null,
            onOverdue: expect.objectContaining({
                blockCourierBooking: true,
                pauseAutomatedAi: true,
                deleteData: false,
            }),
        }));
        expect(data.contract_version).toBe('1.0.0');
        expect(data.contract_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(data.usage.conversations).toEqual(expect.objectContaining({ used: 12, limit: -1 }));

        expect(data).not.toHaveProperty('effective_conversation_limit');
        expect(data).not.toHaveProperty('conversation_quota_exhausted');
        expect(data).not.toHaveProperty('partner_eligibility');
        expect(data).not.toHaveProperty('extra_usage');
    });

    it('retires every plan selection with 410 CATALOG_RETIRED', async () => {
        const subscription = makeSubscription();
        Subscription.findOne.mockResolvedValue(subscription);

        await expect(subscriptionService.updatePlan('shop-1', 'user-1', {
            plan_code: 'MERCHANT',
        })).rejects.toMatchObject({ status: 410, code: 'CATALOG_RETIRED' });
        await expect(subscriptionService.updatePlan('shop-1', 'user-1', {
            plan_code: 'GROWTH',
        })).rejects.toMatchObject({ status: 410, code: 'CATALOG_RETIRED' });
        expect(Invoice.create).not.toHaveBeenCalled();
    });

    it('retires renewal invoices: delivered-order invoices are generated from lines', async () => {
        const subscription = makeSubscription();
        Subscription.findOne.mockResolvedValueOnce(subscription);

        await expect(subscriptionService.ensureRenewalInvoice('shop-1', 'user-1'))
            .rejects.toMatchObject({ status: 410, code: 'RENEWAL_RETIRED' });
        expect(Invoice.create).not.toHaveBeenCalled();
    });

    it('normalizes a historical yearly row to MERCHANT per_order on payment', async () => {
        const subscription = makeSubscription({
            plan_code: 'GROWTH',
            plan_name: 'Growth',
            plan_price: 9990,
            billing_cycle: 'yearly',
            conversations_limit: 500,
        });

        await subscriptionService.activateFromPaidInvoice(subscription, {
            targetPlanCode: 'GROWTH',
            targetBillingCycle: 'yearly',
        });

        expect(subscription.update).toHaveBeenCalledWith(expect.objectContaining({
            plan_code: 'MERCHANT',
            plan_name: 'MERCHANT',
            plan_price: 0,
            billing_cycle: 'monthly',
            billing_model: 'per_order',
            per_order_charge_bdt: 10,
            conversations_limit: -1,
            status: 'active',
        }));
        expect(daysBetween(subscription.current_period_start, subscription.current_period_end))
            .toBeGreaterThanOrEqual(28);
        expect(daysBetween(subscription.current_period_start, subscription.current_period_end))
            .toBeLessThanOrEqual(31);
    });

    it('keeps the recorded period when a late delivered-order invoice is paid', async () => {
        const periodStart = new Date('2026-08-01T00:00:00.000Z');
        const periodEnd = new Date('2026-09-01T00:00:00.000Z');
        const subscription = makeSubscription({
            plan_code: 'MERCHANT',
            billing_model: 'per_order',
            current_period_start: periodStart,
            current_period_end: periodEnd,
            next_billing_date: periodEnd,
            usage_reset_at: periodStart,
        });

        await subscriptionService.activateFromPaidInvoice(subscription, {
            preservePeriod: true,
            billingPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
        });

        expect(subscription.update).toHaveBeenCalledWith(expect.objectContaining({
            current_period_start: periodStart,
            current_period_end: periodEnd,
            next_billing_date: periodEnd,
            usage_reset_at: periodStart,
            status: 'active',
        }));
    });
});