/**
 * FailedPaymentReconciler — contract due-window dunning logic (DB + email mocked).
 *
 * Policy under test (ADR-0011 C1/C5):
 *   - A recurring invoice (delivered_order, plus residual legacy recurring
 *     types) past its due date → SUSPEND the subscription (automated AI pauses;
 *     manual inbox + history stay readable) + send the overdue-policy email.
 *   - A one-off invoice (proration) past due → reminder email only, never
 *     touches subscription status.
 *   - There is no free plan: a legacy zero-price row is dunned like any other.
 */

jest.mock('../../modules/entities', () => ({
    Invoice: { findAll: jest.fn() },
    Subscription: {},
    Shop: {},
}));
jest.mock('../../utils/email.service', () => ({
    sendEmail: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../../modules/notification/merchant-notification.service', () => ({
    notifyShop: jest.fn().mockResolvedValue({ queued: true }),
}));

const { Invoice } = require('../../modules/entities');
const emailService = require('../../utils/email.service');
const merchantNotificationService = require('../../modules/notification/merchant-notification.service');
const { NOTIFICATION_EVENTS } = require('../../modules/notification/notification-events');
const FailedPaymentReconciler = require('../failed-payment-reconciler');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const makeInvoice = (overrides = {}) => {
    const shopId = overrides.shop_id || 'shop-1';
    return {
        id: overrides.id || 'inv-1',
        invoice_number: overrides.invoice_number || 'INV-1',
        shop_id: shopId,
        amount: overrides.amount ?? 999,
        status: overrides.status || 'pending',
        due_date: overrides.due_date || daysAgo(2),
        invoice_type: overrides.invoice_type || 'monthly_subscription',
        update: jest.fn().mockResolvedValue(undefined),
        subscription: {
            id: 'sub-1',
            shop_id: shopId,
            status: 'active',
            update: jest.fn().mockResolvedValue(undefined),
        },
        shop: { id: shopId, name: 'Test Shop', email: overrides.email ?? 'owner@test.com' },
        ...overrides,
    };
};

beforeEach(() => jest.clearAllMocks());

describe('FailedPaymentReconciler.run', () => {
    it('suspends the subscription for a recurring invoice past its due date', async () => {
        const inv = makeInvoice({ invoice_type: 'monthly_subscription' });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const job = new FailedPaymentReconciler();
        const res = await job.run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'suspended' })
        );
        expect(inv.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'overdue' }));
        expect(res.subscriptionsSuspended).toBe(1);
        expect(res.invoicesOverdue).toBe(1);
        expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            inv.shop_id,
            NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE,
            expect.objectContaining({
                invoiceNumber: inv.invoice_number,
                issue: expect.stringMatching(/paused until payment/i)
            }),
            expect.objectContaining({ dedupeTtlSeconds: 24 * 60 * 60 })
        );
    });

    it('duns a delivered_order invoice (the only merchant bill) as recurring', async () => {
        const inv = makeInvoice({ invoice_type: 'delivered_order', amount: 10 });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const res = await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'suspended' })
        );
        expect(res.subscriptionsSuspended).toBe(1);
        expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('carries the C5 policy copy in the dunning email — pause, readable, nothing deleted', async () => {
        const inv = makeInvoice({ invoice_type: 'delivered_order', amount: 10 });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        const { html, subject } = emailService.sendEmail.mock.calls[0][0];
        expect(subject).toMatch(/overdue/i);
        expect(html).toContain('New courier bookings and automated AI replies are paused until payment.');
        expect(html).toContain('Your manual inbox and full history remain available.');
        expect(html).toContain('No data is deleted.');
        // No retired plan/price language in merchant copy (the billing URL
        // path is not copy).
        expect(html).not.toMatch(/Growth|top-up|conversations|per month/i);
        expect(html).not.toMatch(/subscription has been suspended/i);
    });

    it('formats the amount through the contract formatter', async () => {
        const inv = makeInvoice({ invoice_type: 'delivered_order', amount: 10 });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        const { html } = emailService.sendEmail.mock.calls[0][0];
        expect(html).toContain('৳10.00');
    });

    it('suspends for a partner_per_order recurring invoice too', async () => {
        const inv = makeInvoice({ invoice_type: 'partner_per_order' });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const job = new FailedPaymentReconciler();
        const res = await job.run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'suspended' })
        );
        expect(res.subscriptionsSuspended).toBe(1);
    });

    it('does not exempt a legacy zero-price plan — no free tier exists', async () => {
        const inv = makeInvoice({
            subscription: {
                id: 'sub-legacy-zero',
                shop_id: 'shop-1',
                plan_code: 'SHURU',
                plan_price: 0,
                billing_model: 'flat_monthly',
                status: 'active',
                update: jest.fn().mockResolvedValue(undefined),
            },
        });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const res = await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'suspended' })
        );
        expect(res.subscriptionsSuspended).toBe(1);
        expect(res.details[0].action).toBe('suspended');
    });

    it('does not suspend or notify when invoice and subscription tenants disagree', async () => {
        const inv = makeInvoice({
            subscription: {
                id: 'sub-foreign',
                shop_id: 'shop-foreign',
                plan_code: 'GROWTH',
                plan_price: 999,
                billing_model: 'flat_monthly',
                status: 'active',
                update: jest.fn().mockResolvedValue(undefined),
            },
        });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const res = await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(res.details[0].action).toBe('ignored_tenant_mismatch');
    });

    it('cancels zero-value invoices instead of dunning a Partner shop', async () => {
        const inv = makeInvoice({ amount: 0, invoice_type: 'partner_per_order' });
        expect(inv.amount).toBe(0);
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const res = await new FailedPaymentReconciler().run({ dryRun: false, runDate: new Date() });

        expect(inv.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
        expect(inv.subscription.update).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(res.details[0].action).toBe('ignored_zero_balance');
    });

    it('only reminds (never suspends) for a one-off / discretionary invoice', async () => {
        const inv = makeInvoice({ invoice_type: 'Proration (creator add-on)' });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const job = new FailedPaymentReconciler();
        const res = await job.run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).not.toHaveBeenCalled();
        expect(res.subscriptionsSuspended).toBe(0);
        expect(res.remindersSent).toBe(1);
        expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
        expect(merchantNotificationService.notifyShop).toHaveBeenCalledWith(
            inv.shop_id,
            NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE,
            expect.objectContaining({
                invoiceNumber: inv.invoice_number,
                issue: expect.stringMatching(/overdue/i)
            }),
            expect.any(Object)
        );
    });

    // BILLING-YEARLY-005: deferring annual dunning must not exempt annual
    // subscribers from it. Once a yearly renewal is genuinely past due — which
    // can only happen after the entitlement has expired, since the generator
    // writes no invoice before then — it suspends like any other renewal.
    it('suspends for a yearly renewal that is genuinely past due', async () => {
        const inv = makeInvoice({ invoice_type: 'yearly_subscription', amount: 9990 });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const job = new FailedPaymentReconciler();
        const res = await job.run({ dryRun: false, runDate: new Date() });

        expect(inv.subscription.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'suspended' })
        );
        expect(res.subscriptionsSuspended).toBe(1);
    });

    it('dry-run makes no writes and sends no email', async () => {
        const inv = makeInvoice({ invoice_type: 'monthly_subscription' });
        Invoice.findAll.mockResolvedValueOnce([inv]);

        const job = new FailedPaymentReconciler();
        const res = await job.run({ dryRun: true, runDate: new Date() });

        expect(inv.subscription.update).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(merchantNotificationService.notifyShop).not.toHaveBeenCalled();
        expect(res.invoicesOverdue).toBe(1); // counted, not applied
        expect(res.subscriptionsSuspended).toBe(1); // tallied as the action that *would* run
    });
});
