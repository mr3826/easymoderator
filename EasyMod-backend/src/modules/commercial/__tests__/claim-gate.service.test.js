'use strict';

/**
 * UNIT lane — no DB, no network. Pins the claim gate's predicate truth table,
 * scope rewriting, fail-closed behaviour, mode semantics and log payload.
 */

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

const mockProviderCapabilities = {};

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => mockLogger,
}));

jest.mock('../../delivery/provider-capabilities', () => ({
    PROVIDER_CAPABILITIES: mockProviderCapabilities,
}));

jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeaturesStrict: jest.fn(),
}));

jest.mock('../../shop/shop.service', () => ({
    getShopAiSettings: jest.fn(),
}));

const { getPilotFeaturesStrict } = require('../../pilot-features/pilot-features.service');
const { getShopAiSettings } = require('../../shop/shop.service');
const metrics = require('../commercial-metrics');
const {
    registryHash,
    PLATFORM_EVIDENCE,
} = require('../claim.registry');
const { COMMERCIAL_CONTRACT_VERSION } = require('../commercial.contract');
const service = require('../claim-gate.service');

const ENV_KEY = 'CLAIM_GATE_MODE';
let previousEnv;

function setProvider(provider, {
    level = 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    verifiedAt = null,
    settlement = { level: 'UNSUPPORTED' },
} = {}) {
    mockProviderCapabilities[provider] = {
        create_parcel: { level },
        last_verified_at: verifiedAt,
        settlement,
    };
}

function resetProviders() {
    setProvider('pathao');
    setProvider('steadfast');
    setProvider('redx');
}

function liveVerify(provider) {
    setProvider(provider, { level: 'LIVE_VERIFIED', verifiedAt: '2026-11-14' });
}

beforeEach(() => {
    previousEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    metrics.reset();
    jest.clearAllMocks();
    resetProviders();
    getPilotFeaturesStrict.mockRejectedValue(new Error('pilot features unavailable'));
    getShopAiSettings.mockRejectedValue(new Error('shop settings unavailable'));
});

afterEach(() => {
    if (previousEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previousEnv;
});

describe('claim gate — predicate truth table (all 32 combos)', () => {
    const bits = [
        'code_present',
        'merchant_enabled',
        'production_verified',
        'deprecated',
        'internal_only',
    ];

    const cases = Array.from({ length: 32 }, (_, mask) => {
        const predicate = {};
        bits.forEach((bit, index) => {
            predicate[bit] = (mask & (1 << index)) !== 0;
        });
        predicate.scope_match = true;
        const expected = predicate.code_present
            && predicate.merchant_enabled
            && predicate.production_verified
            && !predicate.deprecated
            && !predicate.internal_only;
        return [mask, predicate, expected];
    });

    it.each(cases)('mask %i', (_mask, predicate, expected) => {
        expect(service.isCustomerAvailable(predicate)).toBe(expected);
    });

    it('treats a missing or non-boolean predicate as unavailable', () => {
        expect(service.isCustomerAvailable(null)).toBe(false);
        expect(service.isCustomerAvailable({})).toBe(false);
        expect(service.isCustomerAvailable({ code_present: true })).toBe(false);
    });
});

describe('claim gate — contract claims render under enforce', () => {
    it('renders the delivered-order claim with the frozen version and hash', async () => {
        const decision = await service.evaluateClaim('billing.delivered_order', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision).toMatchObject({
            claimId: 'billing.delivered_order',
            available: true,
            render: 'claim',
            textKey: 'claims.billing.delivered_order.en',
            locale: 'en',
            surface: 'pricing',
            mode: 'enforce',
            wouldBlock: false,
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            registryHash,
        });
        expect(decision.predicate).toEqual({
            code_present: true,
            merchant_enabled: true,
            production_verified: true,
            deprecated: false,
            internal_only: false,
            scope_match: true,
        });
        expect(metrics.snapshot().counters['truth_gate.decisions']).toBe(1);
        expect(metrics.snapshot().counters['truth_gate.enforce_blocked']).toBe(0);
    });

    it('defaults to Bengali locale', async () => {
        const decision = await service.evaluateClaim('billing.delivered_order', { surface: 'pricing' });
        expect(decision.locale).toBe('bn');
        expect(decision.textKey).toBe('claims.billing.delivered_order.bn');
    });
});

describe('claim gate — evidence predicates', () => {
    it('renders the truthful fallback when courier booking is not live-verified', async () => {
        const decision = await service.evaluateClaim('courier.pathao.booking_live', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(false);
        expect(decision.render).toBe('fallback');
        expect(decision.textKey).toBe('claims.courier.pathao.booking_live.fallback.en');
        expect(decision.predicate).toMatchObject({
            code_present: true,
            production_verified: false,
        });
        expect(metrics.snapshot().counters['truth_gate.enforce_blocked']).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'truth_gate.enforce_blocked',
            expect.objectContaining({ claimId: 'courier.pathao.booking_live' }),
        );
    });

    it('fails closed when the add-on flag lookup throws', async () => {
        getPilotFeaturesStrict.mockRejectedValue(new Error('db down'));

        const decision = await service.evaluateClaim('addons.ads_studio.pilot', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(false);
        expect(decision.render).toBe('fallback');
        expect(decision.predicate.merchant_enabled).toBe(false);
        // A resolver failure is evidence-false, not a registry lookup failure.
        expect(metrics.snapshot().counters['truth_gate.lookup_failed']).toBe(0);
    });

    it('reads platform evidence from the frozen registry', async () => {
        expect(PLATFORM_EVIDENCE['platform.ai.draft_reply.production_verified'].value).toBe(true);

        const verified = await service.evaluateClaim('ai.draft_reply', { surface: 'pricing', locale: 'en' });
        expect(verified.available).toBe(true);
        expect(verified.render).toBe('claim');

        const unverified = await service.evaluateClaim('ai.auto_reply', { surface: 'pricing', locale: 'en' });
        expect(unverified.available).toBe(false);
        expect(unverified.render).toBe('fallback');
    });
});

describe('claim gate — scope_match (N=3)', () => {
    it('renders the full claim when all three providers are live-verified', async () => {
        liveVerify('pathao');
        liveVerify('steadfast');
        liveVerify('redx');

        const decision = await service.evaluateClaim('courier.all_providers', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(true);
        expect(decision.render).toBe('claim');
        expect(decision.predicate.scope_match).toBe(true);
        expect(decision.scope).toMatchObject({
            match: true,
            claimedProviders: ['pathao', 'steadfast', 'redx'],
            verifiedProviders: ['pathao', 'steadfast', 'redx'],
        });
        expect(decision.interpolation).toEqual({ providers: 'Pathao, Steadfast, RedX' });
    });

    it('rewrites copy to the verified provider scope when one of three passes', async () => {
        liveVerify('pathao');

        const decision = await service.evaluateClaim('courier.all_providers', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(true);
        expect(decision.render).toBe('claim');
        expect(decision.predicate.production_verified).toBe(true);
        expect(decision.predicate.scope_match).toBe(false);
        expect(decision.scope.verifiedProviders).toEqual(['pathao']);
        expect(decision.scope.text).toContain('verified 1 of 3');
        expect(decision.interpolation).toEqual({ providers: 'Pathao' });
    });

    it('is unavailable when none of the three providers is verified', async () => {
        const decision = await service.evaluateClaim('courier.all_providers', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(false);
        expect(decision.render).toBe('fallback');
        expect(decision.predicate.production_verified).toBe(false);
        expect(decision.predicate.scope_match).toBe(false);
        expect(decision.scope.verifiedProviders).toEqual([]);
        expect(decision.interpolation).toEqual({});
    });
});

describe('claim gate — fail closed', () => {
    it('renders none for an unregistered claim id under enforce', async () => {
        const decision = await service.evaluateClaim('claims.does_not_exist', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.available).toBe(false);
        expect(decision.render).toBe('none');
        expect(decision.textKey).toBeNull();
        expect(metrics.snapshot().counters['truth_gate.lookup_failed']).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'truth_gate.enforce_blocked',
            expect.objectContaining({ claimId: 'claims.does_not_exist' }),
        );
    });

    it('renders none when the claim is not registered to the surface', async () => {
        // billing.delivered_order is not a mobile-surface claim.
        const decision = await service.evaluateClaim('billing.delivered_order', {
            surface: 'mobile',
            locale: 'en',
        });

        expect(decision.render).toBe('none');
        expect(decision.available).toBe(false);
        expect(metrics.snapshot().counters['truth_gate.lookup_failed']).toBe(1);
    });

    it('fails closed for a shop-scoped claim evaluated without a shop', async () => {
        getPilotFeaturesStrict.mockResolvedValue({ adsStudio: true });

        const decision = await service.evaluateClaim('addons.ads_studio.pilot', {
            surface: 'pricing',
            locale: 'en',
        });

        // No shopId => merchant_enabled resolves false (fail closed).
        expect(decision.predicate.merchant_enabled).toBe(false);
        expect(decision.available).toBe(false);
        expect(decision.render).toBe('fallback');
    });
});

describe('claim gate — modes', () => {
    it('shadow renders the claim and logs a would-block', async () => {
        process.env[ENV_KEY] = 'shadow';

        const decision = await service.evaluateClaim('courier.pathao.booking_live', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.mode).toBe('shadow');
        expect(decision.available).toBe(false);
        expect(decision.render).toBe('claim');
        expect(decision.wouldBlock).toBe(true);
        expect(metrics.snapshot().counters['truth_gate.shadow_would_block']).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'truth_gate.shadow_would_block',
            expect.objectContaining({ claimId: 'courier.pathao.booking_live', mode: 'shadow' }),
        );
    });

    it('shadow renders claim even for an unknown claim id', async () => {
        process.env[ENV_KEY] = 'shadow';

        const decision = await service.evaluateClaim('unknown.claim', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.render).toBe('claim');
        expect(decision.wouldBlock).toBe(true);
        expect(metrics.snapshot().counters['truth_gate.lookup_failed']).toBe(1);
    });

    it('off renders the internal-only claim on an internal surface', async () => {
        const decision = await service.evaluateClaim('ai.reply_shadow_meter', {
            surface: 'growth-os',
            locale: 'en',
        });

        expect(decision.mode).toBe('off');
        expect(decision.render).toBe('claim');
        expect(decision.available).toBe(false);
        expect(decision.predicate.internal_only).toBe(true);
        expect(decision.textKey).toBe('claims.ai.reply_shadow_meter.en');
    });

    it('a merchant surface cannot be forced off', async () => {
        process.env[ENV_KEY] = 'off';

        const decision = await service.evaluateClaim('courier.pathao.booking_live', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.mode).toBe('shadow');
        expect(decision.render).toBe('claim');
    });
});

describe('claim gate — logging carries no tenant or customer data', () => {
    it('logs only identifiers, booleans and hashes', async () => {
        const shopId = '11111111-1111-4111-8111-111111111111';
        getPilotFeaturesStrict.mockResolvedValue({ adsStudio: true });

        await service.evaluateClaim('addons.ads_studio.pilot', {
            surface: 'pricing',
            locale: 'en',
            shopId,
        });

        const serialized = JSON.stringify([
            ...mockLogger.info.mock.calls,
            ...mockLogger.warn.mock.calls,
        ]);
        expect(serialized).not.toContain(shopId);
        expect(serialized).not.toContain('customer');
        expect(serialized).not.toContain('phone');

        const payload = mockLogger.info.mock.calls[0][1];
        expect(Object.keys(payload).sort()).toEqual([
            'available',
            'claimId',
            'contractVersion',
            'mode',
            'predicate',
            'registryHash',
            'rendered',
            'surface',
        ]);
        expect(Object.keys(payload.predicate).sort()).toEqual([
            'code_present',
            'deprecated',
            'internal_only',
            'merchant_enabled',
            'production_verified',
            'scope_match',
        ]);
    });
});

describe('claim gate — synchronous renderClaim for email/PDF', () => {
    it('renders the contract claim synchronously', () => {
        const decision = service.renderClaim('billing.delivered_order', {
            surface: 'email',
            locale: 'en',
            format: 'html',
        });

        expect(decision.render).toBe('claim');
        expect(decision.textKey).toBe('claims.billing.delivered_order.en');
        expect(decision.format).toBe('html');
        expect(decision.contractVersion).toBe(COMMERCIAL_CONTRACT_VERSION);
    });

    it('fails closed for add-on evidence it cannot read synchronously', () => {
        const decision = service.renderClaim('addons.ads_studio.pilot', {
            surface: 'pricing',
            locale: 'en',
        });

        expect(decision.render).toBe('fallback');
        expect(decision.available).toBe(false);
        expect(decision.predicate.merchant_enabled).toBe(false);
        expect(decision.format).toBe('text');
    });

    it('returns none for an unknown id under enforce', () => {
        const decision = service.renderClaim('unknown.claim', {
            surface: 'email',
            locale: 'en',
            format: 'text',
        });

        expect(decision.render).toBe('none');
        expect(decision.textKey).toBeNull();
        expect(metrics.snapshot().counters['truth_gate.lookup_failed']).toBe(1);
    });
});