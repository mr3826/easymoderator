/**
 * Courier provider capability declarations.
 *
 * These values are shown to merchants, so they are asserted against what the
 * provider classes actually implement — not against what the providers claim
 * in their own marketing. Nothing here may exceed the stated ceiling.
 */

const {
    CAPABILITY_LEVELS,
    CAPABILITY_CEILING,
    PROVIDER_CAPABILITIES,
    getProviderCapabilities,
} = require('../provider-capabilities');

const rank = (value) => CAPABILITY_LEVELS.indexOf(value);

describe('courier provider capabilities', () => {
    it('never claims more than the ceiling for any provider or operation', () => {
        const ceiling = rank(CAPABILITY_CEILING);
        for (const [provider, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
            for (const [operation, entry] of Object.entries(capabilities)) {
                if (!entry || typeof entry.level !== 'string') continue;
                expect(rank(entry.level)).toBeGreaterThanOrEqual(0);
                expect(rank(entry.level)).toBeLessThanOrEqual(ceiling);
                expect(operation).toBeTruthy();
                expect(provider).toBeTruthy();
            }
        }
    });

    it('records no live verification for any provider', () => {
        for (const capabilities of Object.values(PROVIDER_CAPABILITIES)) {
            expect(capabilities.last_verified_at).toBeNull();
        }
    });

    it('marks Steadfast coverage unknown and its price quote unsupported', () => {
        // Steadfast books by text address and its calculatePrice() returns null
        // by design (steadfast.provider.js), so neither may look implemented.
        expect(PROVIDER_CAPABILITIES.steadfast.coverage.level).toBe('UNKNOWN');
        expect(PROVIDER_CAPABILITIES.steadfast.rate_quote.level).toBe('UNSUPPORTED');
    });

    it('marks Pathao cancel and edit unsupported', () => {
        // pathao.provider.js implements neither operation.
        expect(PROVIDER_CAPABILITIES.pathao.cancel.level).toBe('UNSUPPORTED');
        expect(PROVIDER_CAPABILITIES.pathao.edit.level).toBe('UNSUPPORTED');
    });

    it('marks RedX cancel and edit implemented but not live verified', () => {
        // redx.provider.js: cancelParcel() and updateParcel() exist.
        expect(PROVIDER_CAPABILITIES.redx.cancel.level).toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
        expect(PROVIDER_CAPABILITIES.redx.edit.level).toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
    });

    it('gives every unsupported operation a reason and a manual next step', () => {
        for (const capabilities of Object.values(PROVIDER_CAPABILITIES)) {
            for (const entry of Object.values(capabilities)) {
                if (!entry || entry.level !== 'UNSUPPORTED') continue;
                expect(typeof entry.reason_code).toBe('string');
                expect(entry.reason_code.length).toBeGreaterThan(0);
                expect(typeof entry.manual_step_code).toBe('string');
                expect(entry.manual_step_code.length).toBeGreaterThan(0);
            }
        }
    });

    it('serves a versioned payload with the ceiling attached', () => {
        const payload = getProviderCapabilities('redx');
        expect(payload.version).toBe(1);
        expect(payload.ceiling).toBe(CAPABILITY_CEILING);
        expect(payload.coverage.level).toBe('IMPLEMENTED_NOT_LIVE_VERIFIED');
    });

    it('returns null for a provider it has no declaration for', () => {
        expect(getProviderCapabilities('unknown-courier')).toBeNull();
    });
});