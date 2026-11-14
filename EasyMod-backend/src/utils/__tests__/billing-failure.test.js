'use strict';

/**
 * Billing-failure email — ADR-0011 contract-derived copy.
 *
 * The email must describe the delivered-order model, price the amount through
 * the contract formatter, and never reintroduce a retired plan name or monthly
 * subscription price.
 */

const { billingFailureEmail } = require('../email-templates/billing-failure');
const {
    COMMERCIAL_CONTRACT_VERSION,
} = require('../../modules/commercial/commercial.contract');

const invoice = (overrides = {}) => ({
    id: 'inv-1',
    invoice_number: 'INV-202611-ABC123',
    amount: 20,
    due_date: new Date('2026-11-08T00:00:00.000Z'),
    payment_link: 'https://pay.example.test/inv-1',
    ...overrides,
});

describe('billingFailureEmail', () => {
    it('renders the delivered-order contract terms in Bangla', () => {
        const { subject, html, text } = billingFailureEmail(
            { name: 'Test Shop' },
            invoice(),
            { locale: 'bn' },
        );

        expect(subject).not.toMatch(/subscription/i);
        expect(html).toContain('৳২০.০০');
        expect(html).toContain('প্রতি ডেলিভারি করা অর্ডার');
        expect(html).toContain('নতুন কুরিয়ার বুকিং এবং স্বয়ংক্রিয় AI উত্তর বন্ধ থাকবে');
        expect(html).toContain(`Commercial contract v${COMMERCIAL_CONTRACT_VERSION}`);
        expect(html).toContain('INV-202611-ABC123');
        expect(text).toContain(`Commercial contract v${COMMERCIAL_CONTRACT_VERSION}`);
    });

    it('renders the English contract terms without retired plan copy', () => {
        const { html, text } = billingFailureEmail(
            { name: 'Test Shop' },
            invoice(),
            { locale: 'en' },
        );

        expect(html).toContain('৳20.00');
        expect(html).toContain('per delivered order');
        expect(html).toContain('nothing is deleted');
        expect(html).not.toMatch(/shuru|growth|\b999\b/i);
        expect(text).toContain('per delivered order');
    });

    it('escapes merchant-supplied values before interpolation', () => {
        const { html } = billingFailureEmail(
            { name: '<script>alert(1)</script>' },
            invoice({ invoice_number: '<img src=x onerror=alert(1)>' }),
            { locale: 'en' },
        );

        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('omits the overdue-policy paragraph when the claim gate renders none', () => {
        const claimGate = require('../../modules/commercial/claim-gate.service');
        const spy = jest.spyOn(claimGate, 'renderClaim').mockReturnValue({
            claimId: 'billing.overdue_policy',
            available: false,
            render: 'none',
            textKey: null,
            locale: 'en',
            surface: 'email',
            mode: 'enforce',
            wouldBlock: false,
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            registryHash: 'sha256:test',
            scope: {},
            predicate: {},
            interpolation: {},
            format: 'html',
        });

        const { html } = billingFailureEmail({ name: 'Test Shop' }, invoice(), { locale: 'en' });

        expect(html).not.toContain('Overdue billing blocks');
        expect(html).toContain('per delivered order');
        spy.mockRestore();
    });
});