/**
 * Order Tracking Notification Service — Unit Tests
 *
 * REPLACES an earlier suite that tested trackOrder / updateTrackingStatus /
 * syncTrackingStatus / batchSyncTracking against this module. None of those
 * functions has ever existed here: order-tracking.service.js is the B2 shipping
 * NOTIFICATION service, and exports exactly two things —
 * formatTrackingMessage and sendTrackingNotification.
 *
 * Courier tracking itself lives in delivery/delivery-tracking.service.js and is
 * covered by delivery-tracking.tenant-and-replay.test.js in the security gate.
 *
 * The three cases that "passed" in the old suite asserted on an array of
 * provider names declared inside the test file, touching no product code at
 * all — the exact shape of coverage that reports green and guards nothing.
 */

'use strict';

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

jest.mock('../../webhook/webhook.service', () => ({
    sendToCustomer: jest.fn()
}));

jest.mock('../../entities', () => ({
    Order: { findOne: jest.fn() }
}));

const trackingService = require('../order-tracking.service');
const webhookService = require('../../webhook/webhook.service');
const { Order } = require('../../entities');

const makeOrder = (overrides = {}) => ({
    id: 'order-1',
    order_number: 'ORD-001',
    shop_id: 'shop-1',
    customer_id: 'cust-1',
    delivery_tracking_code: 'TRACK123',
    ...overrides
});

beforeEach(() => {
    jest.clearAllMocks();
    webhookService.sendToCustomer.mockResolvedValue({ sent: true, channelType: 'messenger' });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('formatTrackingMessage', () => {
    it('includes the order number and tracking code', () => {
        const msg = trackingService.formatTrackingMessage(makeOrder(), { trackingNumber: 'SF-99' });
        expect(msg).toContain('ORD-001');
        expect(msg).toContain('SF-99');
    });

    it('falls back to the order id when there is no order number', () => {
        const msg = trackingService.formatTrackingMessage(makeOrder({ order_number: null }), {});
        expect(msg).toContain('order-1');
    });

    it('falls back to the tracking code stored on the order', () => {
        const msg = trackingService.formatTrackingMessage(makeOrder(), {});
        expect(msg).toContain('TRACK123');
    });

    it('says N/A rather than "undefined" when nothing is known', () => {
        const msg = trackingService.formatTrackingMessage(
            makeOrder({ delivery_tracking_code: null }), {}
        );
        expect(msg).toContain('N/A');
        expect(msg).not.toContain('undefined');
    });

    it('mentions the courier only when one is given', () => {
        expect(trackingService.formatTrackingMessage(makeOrder(), { courier: 'Steadfast' }))
            .toContain('Steadfast');
        expect(trackingService.formatTrackingMessage(makeOrder(), {}))
            .not.toContain('কুরিয়ার');
    });

    it('mentions the estimated date only when one is given', () => {
        expect(trackingService.formatTrackingMessage(makeOrder(), { estimatedDate: '2026-08-20' }))
            .toContain('2026-08-20');
        expect(trackingService.formatTrackingMessage(makeOrder(), {}))
            .not.toContain('আনুমানিক');
    });
});

describe('sendTrackingNotification', () => {
    it('sends the formatted message to the order customer', async () => {
        const result = await trackingService.sendTrackingNotification(makeOrder(), 'shop-1', {
            trackingNumber: 'SF-99',
            courier: 'Steadfast'
        });

        expect(webhookService.sendToCustomer).toHaveBeenCalledWith(expect.objectContaining({
            shopId: 'shop-1',
            customerId: 'cust-1',
            message: expect.stringContaining('SF-99')
        }));
        expect(result.sent).toBe(true);
        expect(result.orderNumber).toBe('ORD-001');
    });

    it('loads the order when given an id instead of an instance', async () => {
        Order.findOne.mockResolvedValue(makeOrder());

        await trackingService.sendTrackingNotification('order-1', 'shop-1', {});

        expect(Order.findOne).toHaveBeenCalledWith({
            where: { id: 'order-1', shop_id: 'shop-1' }
        });
        expect(webhookService.sendToCustomer).toHaveBeenCalled();
    });

    it('scopes the lookup to the shop, so one shop cannot notify another shop\'s order', async () => {
        Order.findOne.mockResolvedValue(null);

        await expect(trackingService.sendTrackingNotification('order-1', 'other-shop', {}))
            .rejects.toMatchObject({ status: 404 });
        expect(webhookService.sendToCustomer).not.toHaveBeenCalled();
    });

    it('does not attempt a send when the order has no customer', async () => {
        const result = await trackingService.sendTrackingNotification(
            makeOrder({ customer_id: null }), 'shop-1', {}
        );

        expect(webhookService.sendToCustomer).not.toHaveBeenCalled();
        expect(result).toMatchObject({ sent: false, reason: 'no_customer' });
    });

    it('reports the reason when the channel declines to deliver', async () => {
        webhookService.sendToCustomer.mockResolvedValue({ sent: false, reason: 'no_channel' });

        const result = await trackingService.sendTrackingNotification(makeOrder(), 'shop-1', {});

        expect(result).toMatchObject({ sent: false, reason: 'no_channel' });
    });

    it('does not throw when the send fails — a shipped order still ships', async () => {
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
        webhookService.sendToCustomer.mockRejectedValue(new Error('Meta returned 500'));

        const result = await trackingService.sendTrackingNotification(makeOrder(), 'shop-1', {});

        expect(result).toMatchObject({ sent: false, reason: 'send_error' });
        expect(result.message).toContain('ORD-001');
        expect(consoleLog).not.toHaveBeenCalled();
    });
});
