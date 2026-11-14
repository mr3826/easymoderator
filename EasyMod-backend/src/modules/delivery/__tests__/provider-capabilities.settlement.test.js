'use strict';

/**
 * Phase-1 settlement declarations (ADR-0011). COD settlement is a money-facing
 * capability, so each provider states exactly what this repository can evidence
 * and nothing above the existing capability ceiling.
 */

const {
    CAPABILITY_LEVELS,
    CAPABILITY_CEILING,
    PROVIDER_CAPABILITIES,
    getProviderCapabilities,
} = require('../provider-capabilities');

const rank = (value) => CAPABILITY_LEVELS.indexOf(value);

describe('courier settlement capabilities', () => {
    it('declares settlement for every supported provider', () => {
        for (const provider of ['pathao', 'steadfast', 'redx']) {
            expect(PROVIDER_CAPABILITIES[provider].settlement).toBeDefined();
            expect(typeof PROVIDER_CAPABILITIES[provider].settlement.level).toBe('string');
        }
    });

    it('marks Pathao settlement unsupported with a manual reconciliation step', () => {
        const settlement = PROVIDER_CAPABILITIES.pathao.settlement;
        expect(settlement.level).toBe('UNSUPPORTED');
        expect(settlement.reason_code).toBe('NO_PAYOUT_API');
        expect(settlement.manual_step_code).toBe('RECONCILE_IN_PROVIDER_PORTAL');
    });

    it('marks Steadfast settlement implemented but never live-verified', () => {
        // steadfast.provider.js has GET /payments, but no live account exercised it.
        expect(PROVIDER_CAPABILITIES.steadfast.settlement.level)
            .toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
        expect(PROVIDER_CAPABILITIES.steadfast.last_verified_at).toBeNull();
    });

    it('marks RedX settlement unknown because the paid status is discarded', () => {
        const settlement = PROVIDER_CAPABILITIES.redx.settlement;
        expect(settlement.level).toBe('UNKNOWN');
        expect(settlement.reason_code).toBe('PAID_STATUS_DISCARDED');
    });

    it('keeps every settlement declaration within the capability ceiling', () => {
        const ceiling = rank(CAPABILITY_CEILING);
        for (const capabilities of Object.values(PROVIDER_CAPABILITIES)) {
            expect(rank(capabilities.settlement.level)).toBeGreaterThanOrEqual(0);
            expect(rank(capabilities.settlement.level)).toBeLessThanOrEqual(ceiling);
        }
    });

    it('does not change the existing booking, tracking or cancel declarations', () => {
        for (const provider of ['pathao', 'steadfast', 'redx']) {
            expect(PROVIDER_CAPABILITIES[provider].create_parcel.level)
                .toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
            expect(PROVIDER_CAPABILITIES[provider].tracking.level)
                .toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
            expect(PROVIDER_CAPABILITIES[provider].last_verified_at).toBeNull();
        }
    });

    it('serves settlement through the versioned provider payload', () => {
        const payload = getProviderCapabilities('pathao');
        expect(payload.version).toBe(1);
        expect(payload.ceiling).toBe(CAPABILITY_CEILING);
        expect(payload.settlement.level).toBe('UNSUPPORTED');
    });
});