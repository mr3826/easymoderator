'use strict';

/**
 * Billing standing — the overdue courier-booking gate (ADR-0011 C5).
 *
 * Invoice.count is mocked; the assertions pin the tenant scope, the due-date
 * semantics (invoice-based, not reconciler-timing-based), the 402 contract, and
 * fail-closed behaviour.
 */

jest.mock('../../entities', () => ({
    Invoice: { count: jest.fn() },
}));

const { Op } = require('sequelize');
const { Invoice } = require('../../entities');
const { AppError } = require('../../../utils/AppError');
const {
    hasOverdueBalance,
    assertBookingAllowed,
    buildOverduePolicySentence,
} = require('../billing-standing.service');
const { RECURRING_INVOICE_TYPES } = require('../../subscription/subscription.plans');

const SHOP = 'shop-1';

beforeEach(() => {
    jest.clearAllMocks();
    Invoice.count.mockResolvedValue(0);
});

describe('hasOverdueBalance', () => {
    it('is tenant-scoped and targets unpaid recurring invoices only', async () => {
        Invoice.count.mockResolvedValue(0);
        const now = new Date('2026-11-14T00:00:00.000Z');

        await hasOverdueBalance(SHOP, { now });

        expect(Invoice.count).toHaveBeenCalledTimes(1);
        const { where } = Invoice.count.mock.calls[0][0];
        expect(where.shop_id).toBe(SHOP);
        expect(where.invoice_type[Op.in]).toEqual([...RECURRING_INVOICE_TYPES]);
        expect(where.invoice_type[Op.in]).toEqual(expect.arrayContaining(['delivered_order']));
        expect(where.status[Op.in]).toEqual(['pending', 'overdue']);
        expect(where.due_date[Op.lt]).toBe(now);
        expect(where.amount[Op.gt]).toBe(0);
    });

    it('returns true when at least one invoice is past due', async () => {
        Invoice.count.mockResolvedValue(1);
        await expect(hasOverdueBalance(SHOP)).resolves.toBe(true);
    });

    it('returns false when no invoice is past due', async () => {
        Invoice.count.mockResolvedValue(0);
        await expect(hasOverdueBalance(SHOP)).resolves.toBe(false);
        // amount > 0 means a cancelled zero-balance invoice cannot block.
    });

    it('rejects a missing shop rather than running an unscoped query', async () => {
        await expect(hasOverdueBalance(null)).rejects.toMatchObject({
            status: 400,
            code: 'BILLING_TENANT_REQUIRED',
        });
        expect(Invoice.count).not.toHaveBeenCalled();
    });
});

describe('assertBookingAllowed', () => {
    it('allows the booking when nothing is overdue', async () => {
        Invoice.count.mockResolvedValue(0);
        await expect(assertBookingAllowed(SHOP)).resolves.toBe(true);
    });

    it('throws 402 BILLING_OVERDUE_BOOKING_BLOCKED when an invoice is past due', async () => {
        Invoice.count.mockResolvedValue(1);

        const error = await assertBookingAllowed(SHOP).catch((err) => err);

        expect(error).toBeInstanceOf(AppError);
        expect(error.status).toBe(402);
        expect(error.code).toBe('BILLING_OVERDUE_BOOKING_BLOCKED');
        expect(error.details.payUrl).toMatch(/\/subscription$/);
        expect(error.details.claimId).toBe('billing.overdue_policy');
        expect(error.details.claimTextKey).toBe('claims.billing.overdue_policy.en');
    });

    it('carries the contract-derived C5 policy copy and a pay URL', async () => {
        Invoice.count.mockResolvedValue(1);

        const error = await assertBookingAllowed(SHOP).catch((err) => err);

        expect(error.message).toContain(
            'New courier bookings and automated AI replies are paused until payment.',
        );
        expect(error.message).toContain('Your manual inbox and full history remain available.');
        expect(error.message).toContain('No data is deleted.');
        expect(error.message).toContain('/subscription');
        // Price truth comes from the contract, never a literal in this module.
        expect(error.message).toContain('৳10.00 per delivered order');
    });

    it('fails closed when standing cannot be read', async () => {
        Invoice.count.mockRejectedValue(new Error('db down'));

        const error = await assertBookingAllowed(SHOP).catch((err) => err);

        expect(error).toBeInstanceOf(AppError);
        expect(error.status).toBe(503);
        expect(error.code).toBe('BILLING_STANDING_UNAVAILABLE');
    });

    it('passes the caller transaction through to the query', async () => {
        Invoice.count.mockResolvedValue(0);
        const transaction = { id: 'txn-1' };

        await assertBookingAllowed(SHOP, { transaction });

        expect(Invoice.count.mock.calls[0][0].transaction).toBe(transaction);
    });
});

describe('buildOverduePolicySentence', () => {
    it('renders the founder-approved C5 policy verbatim', () => {
        expect(buildOverduePolicySentence()).toBe(
            'New courier bookings and automated AI replies are paused until payment. '
            + 'Your manual inbox and full history remain available. '
            + 'No data is deleted.',
        );
    });
});