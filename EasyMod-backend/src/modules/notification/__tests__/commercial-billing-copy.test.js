'use strict';

/**
 * Merchant notification copy — ADR-0011 contract-derived billing language.
 *
 * Event keys stay historical, but the merchant-facing label and alert body may
 * only describe the delivered-order model. No retired plan name, subscription
 * fee or conversation entitlement may be rendered.
 */

const { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_META } = require('../notification-events');
const { formatTelegramAlert, toPushPayload } = require('../telegram-alert.formatter');
const {
    COMMERCIAL_CONTRACT_VERSION,
} = require('../../commercial/commercial.contract');

describe('delivered-order billing notification copy', () => {
    const previousAppUrl = process.env.APP_URL;

    beforeEach(() => {
        process.env.APP_URL = 'https://app.easymod.tech';
    });

    afterAll(() => {
        if (previousAppUrl === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = previousAppUrl;
    });

    it('labels the billing event with the delivered-order model', () => {
        const meta = NOTIFICATION_EVENT_META[NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE];

        expect(meta.label).toBe('Delivered-order billing issue');
        expect(meta.labelBn).toBe('ডেলিভারি-ভিত্তিক বিল সমস্যা');
        expect(meta.label).not.toMatch(/subscription/i);
    });

    it('formats the billing alert from the contract, not a plan catalog', () => {
        const alert = formatTelegramAlert(NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE, {
            invoiceNumber: 'INV-202611-ABC123',
            amountMinor: 2000,
            issue: 'Card declined',
        });

        expect(alert.title).toBe('Delivered-order billing issue');
        expect(alert.body).toContain('Invoice: INV-202611-ABC123');
        expect(alert.body).toContain('Amount: ৳20.00');
        expect(alert.body).toContain(`Contract v${COMMERCIAL_CONTRACT_VERSION}`);
        expect(alert.body).toContain('৳10.00 per delivered order');
        expect(alert.body).not.toMatch(/shuru|growth|\b999\b|conversation limit/i);
    });

    it('keeps the push body free of retired copy', () => {
        const payload = toPushPayload(NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE, {
            invoiceNumber: 'INV-1',
            amountMinor: 1000,
        });

        expect(payload.title).toBe('Delivered-order billing issue');
        expect(payload.body).not.toMatch(/subscription|shuru|growth/i);
    });
});