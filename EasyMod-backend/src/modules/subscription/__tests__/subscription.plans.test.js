'use strict';

/**
 * Single-tier plan catalog tests (ADR-0011).
 *
 * The retired SHURU/GROWTH/PARTNER catalog must not be renderable: no display
 * names, no subscription prices, no purchasable packs in this module.
 */

const {
    PlanCode,
    PRICING_TIERS,
    BASE_FEATURES,
    InvoiceType,
    RECURRING_INVOICE_TYPES,
    recurringInvoiceTypeFor,
    normalizePlanCode,
    getTierByCode,
    planHasFeature,
    PARTNER_ORDER_TIERS,
    getTopupPack,
} = require('../subscription.plans');

describe('single MERCHANT tier', () => {
    it('defines exactly one tier with the delivered-order entitlements', () => {
        expect(Object.keys(PRICING_TIERS)).toEqual([PlanCode.MERCHANT]);
        expect(PRICING_TIERS.MERCHANT).toEqual(expect.objectContaining({
            code: 'MERCHANT',
            billingModel: 'per_order',
            priceBdtMonthly: 0,
            priceBdtYearly: 0,
            conversationsLimit: -1,
            ordersLimit: -1,
            canPurchaseTopups: false,
        }));
    });

    it('carries no display name or public price', () => {
        // `name` exists only as a non-enumerable machine code so legacy writers
        // cannot fall back to a retired persisted label. It never enumerates.
        expect(Object.keys(PRICING_TIERS.MERCHANT)).not.toContain('name');
        expect(PRICING_TIERS.MERCHANT.name).toBe('MERCHANT');
        expect(PRICING_TIERS.MERCHANT).not.toHaveProperty('keyFeature');
        // The only price authority is the commercial contract.
        expect(PRICING_TIERS.MERCHANT.perOrderChargeBdt).toBeNull();
    });

    it('removes the never-verified voice transcription feature', () => {
        expect(BASE_FEATURES).not.toHaveProperty('voice_note_transcription');
        expect(planHasFeature('MERCHANT', 'voice_note_transcription')).toBe(false);
    });

    it('normalizes every historical code to MERCHANT', () => {
        expect(normalizePlanCode('SHURU')).toBe(PlanCode.MERCHANT);
        expect(normalizePlanCode('GROWTH')).toBe(PlanCode.MERCHANT);
        expect(normalizePlanCode('PARTNER')).toBe(PlanCode.MERCHANT);
        expect(normalizePlanCode('FREE')).toBe(PlanCode.MERCHANT);
        expect(normalizePlanCode(undefined)).toBe(PlanCode.MERCHANT);
    });

    it('resolves legacy codes to the same entitlement set', () => {
        expect(getTierByCode('SHURU')).toBe(PRICING_TIERS.MERCHANT);
        expect(getTierByCode('GROWTH')).toBe(PRICING_TIERS.MERCHANT);
        expect(getTierByCode(null)).toBeNull();
    });
});

describe('invoice typing', () => {
    it('adds delivered_order as a recurring type', () => {
        expect(InvoiceType.DELIVERED_ORDER).toBe('delivered_order');
        expect(RECURRING_INVOICE_TYPES).toEqual([
            'delivered_order',
            'monthly_subscription',
            'yearly_subscription',
            'partner_per_order',
        ]);
    });

    it('maps a per-order subscription to a delivered-order invoice', () => {
        expect(recurringInvoiceTypeFor('per_order')).toBe(InvoiceType.DELIVERED_ORDER);
        expect(recurringInvoiceTypeFor('yearly')).toBe(InvoiceType.YEARLY_SUBSCRIPTION);
        expect(recurringInvoiceTypeFor('monthly')).toBe(InvoiceType.MONTHLY_SUBSCRIPTION);
    });
});

describe('historical resolution stays available', () => {
    it('keeps the retired Partner band numbers for old invoices', () => {
        expect(PARTNER_ORDER_TIERS.map((t) => [t.minOrders, t.maxOrders, t.rateBdt])).toEqual([
            [300, 999, 15],
            [1000, 2999, 12],
            [3000, null, 10],
        ]);
    });

    it('still resolves a historical top-up pack code', () => {
        expect(getTopupPack('TOPUP_100')).toEqual({ code: 'TOPUP_100', conversations: 100, priceBdt: 150 });
    });
});