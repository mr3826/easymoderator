'use strict';

/**
 * A4 payment-confirmation fixes (contract §3.2-4 + §3.3, D-10 defect pins):
 *  - `payment_claimed` is accepted by the owner approve/reject gate (the
 *    minimal §3.2-4 status-list change); terminal states stay rejected.
 *  - formatPaymentConfirmationMessage no longer crashes on a missing
 *    paymentMethod (the delivery-failure misfire crash source) and labels a
 *    screenshot SUPPORTING-ONLY.
 *  - sendPaymentConfirmationRequest actually SETS expires_at (24 h) — the
 *    410 guard in handleOwnerResponse was dead without this — and returns the
 *    created row.
 *  - createDashboardNotification is honest: the OwnerNotification row IS the
 *    dashboard surface; nothing new is invented.
 */
process.env.NODE_ENV = 'test';

const mockNotificationRow = {
    id: 'notif-claim-1',
    shop_id: 'shop-1',
    type: 'payment_confirmation',
    status: 'pending',
    expires_at: null,
    customer_data: {},
    update: jest.fn(),
};

const mockModels = {
    AuditLog: { create: jest.fn() },
    CourierDispatch: { findOne: jest.fn() },
    DeliveryTracking: { findOne: jest.fn() },
    Order: { findOne: jest.fn() },
    OwnerNotification: {
        findByPk: jest.fn(),
        create: jest.fn(),
    },
    PaymentConfig: { findOne: jest.fn() },
    PaymentTransaction: { findOne: jest.fn() },
    Shop: {},
    User: {},
    UserShop: { findOne: jest.fn() },
};
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const mockSequelize = { transaction: jest.fn(async (cb) => cb(mockTransaction)) };
const mockCancelOrderInTransaction = jest.fn();

jest.mock('../../entities', () => mockModels);
jest.mock('../../../utils/database/database-setup', () => ({ sequelize: mockSequelize }));
jest.mock('../../../utils/email.service', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../order/order.service', () => ({ cancelOrderInTransaction: mockCancelOrderInTransaction }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const service = require('../owner-notification.service');
const paymentTaxonomy = require('../../payment/payment-taxonomy');

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(service, 'sendCustomerResponse').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('§3.2-4: owner approval accepts a payment_claimed row', () => {
    function claimFixtures(status) {
        const notification = {
            ...mockNotificationRow,
            status: 'pending',
            expires_at: new Date(Date.now() + 60_000),
            customer_data: { orderId: 'order-1', orderNumber: 'ORD-9', transactionId: 'TRXCLAIM1' },
            update: jest.fn(),
        };
        const order = {
            id: 'order-1', shop_id: 'shop-1', customer_id: null,
            payment_method: 'bkash', payment_method_id: null,
            update: jest.fn(),
        };
        const payment = { id: 'txn-1', status, update: jest.fn() };
        mockModels.OwnerNotification.findByPk.mockResolvedValue(notification);
        mockModels.Order.findOne.mockResolvedValue(order);
        mockModels.PaymentTransaction.findOne.mockResolvedValue(payment);
        mockModels.CourierDispatch.findOne.mockResolvedValue(null);
        mockModels.DeliveryTracking.findOne.mockResolvedValue(null);
        mockModels.AuditLog.create.mockResolvedValue({});
        return { notification, order, payment };
    }

    test('approve on payment_claimed settles order paid/confirmed + txn verified + audit', async () => {
        const { notification, order, payment } = claimFixtures(paymentTaxonomy.CLAIM_STATUS);
        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .resolves.toMatchObject({ success: true });
        expect(order.update).toHaveBeenCalledWith(
            expect.objectContaining({ payment_status: 'paid', order_status: 'confirmed' }),
            { transaction: mockTransaction },
        );
        expect(payment.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'verified' }),
            { transaction: mockTransaction },
        );
        expect(mockModels.AuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'owner_payment_approve' }),
            { transaction: mockTransaction },
        );
    });

    test('reject on payment_claimed cancels + marks rejected', async () => {
        const { notification, payment } = claimFixtures(paymentTaxonomy.CLAIM_STATUS);
        mockCancelOrderInTransaction.mockResolvedValue({ id: 'order-1', update: jest.fn() });
        await service.handleOwnerResponse(notification.id, 'reject', { userId: 'owner-1' });
        expect(payment.update).toHaveBeenCalledWith({ status: 'rejected' }, { transaction: mockTransaction });
    });

    test('terminal verified state remains 409 (guard intact)', async () => {
        const { notification, payment } = claimFixtures('verified');
        await expect(service.handleOwnerResponse(notification.id, 'approve', { userId: 'owner-1' }))
            .rejects.toMatchObject({ status: 409 });
        expect(payment.update).not.toHaveBeenCalled();
    });
});

describe('§3.3: crash fix + expiry + dashboard honesty', () => {
    test('formatter survives a missing paymentMethod (old misfire crash source)', () => {
        const out = service.formatPaymentConfirmationMessage(
            { order_number: '100001', customer_name: 'A', customer_phone: '018', total: 500 },
            { type: 'delivery_failure' }, // NO paymentMethod — used to throw
            'notif-x',
        );
        expect(out).toContain('MANUAL PAYMENT');
        expect(out).toContain('100001');
    });

    test('formatter shows claim amount, mismatch warning and the number shown to the customer', () => {
        const out = service.formatPaymentConfirmationMessage(
            { order_number: '100001', customer_name: 'A', customer_phone: '018', total: 1650 },
            {
                paymentMethod: 'bKash',
                transactionId: 'TRX123456',
                claim_amount: 825,
                amount_kind: 'advance',
                amount_mismatch: { displayed_amount: 500, server_amount: 825, tolerance: 42 },
                wallet_number: '01711111111',
                screenshotUrl: 'https://media.example.test/pay.png',
                customerMessage: 'done',
            },
            'notif-y',
        );
        expect(out).toContain('TRX123456');
        expect(out).toMatch(/Claimed payment: ৳825/);
        expect(out).toMatch(/AMOUNT MISMATCH/);
        expect(out).toMatch(/Number shown to customer: 01711111111/);
        expect(out).toMatch(/SUPPORTING EVIDENCE ONLY/);
    });

    test('sendPaymentConfirmationRequest sets a real 24 h expires_at and returns the row', async () => {
        mockModels.UserShop.findOne.mockResolvedValue({ user: { id: 'u1', email: 'o@x.test', name: 'O' } });
        mockModels.OwnerNotification.create.mockImplementation(async (data) => ({
            ...data, id: 'notif-exp-1',
        }));
        const before = Date.now();
        const res = await service.sendPaymentConfirmationRequest('shop-1',
            { id: 'order-1', order_number: '100001', customer_name: 'A', customer_phone: '018', total: 500 },
            { paymentMethod: 'bKash', transactionId: 'TRX999999', customerMessage: 'paid' });
        const created = mockModels.OwnerNotification.create.mock.calls[0][0];
        expect(created.expires_at).toBeInstanceOf(Date);
        const ttl = new Date(created.expires_at).getTime() - before;
        expect(ttl).toBeGreaterThan(23 * 3600 * 1000);
        expect(ttl).toBeLessThan(25 * 3600 * 1000);
        expect(res.success).toBe(true);
        expect(res.row).toBeTruthy();
        expect(res.expiresAt).toBeInstanceOf(Date);
        // customer_data keeps the evidence context additive:
        expect(created.customer_data.walletNumber).toBeUndefined(); // not passed here
        expect(created.customer_data.transactionId).toBe('TRX999999');
    });

    test('createDashboardNotification reports the row-based truth instead of inventing success', async () => {
        const noRow = await service.createDashboardNotification('shop-1', 'msg', null);
        expect(noRow).toMatchObject({ success: false, channel: 'dashboard', mode: 'owner_notification_row' });
        const withRow = await service.createDashboardNotification('shop-1', 'msg', { id: 'notif-1' });
        expect(withRow).toMatchObject({ success: true, queued: true });
        expect(withRow.detail).toMatch(/in-app/i);
    });
});
