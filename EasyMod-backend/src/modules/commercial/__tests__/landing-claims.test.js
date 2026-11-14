'use strict';

/**
 * Landing claim invariants (contract-derived marketing surface).
 *
 * B3: a contract that stops zero-rating returns must fail price.zero closed.
 * B4: a non-zero subscription/setup/monthly fee must fail price.nosub closed.
 * B5: courier.payout scopes on settlement_present, so reducing the providers
 *     with settlement code narrows the copy instead of overstating coverage.
 */

const {
    CLAIM_IDS,
    getClaim,
    registryHash,
} = require('../claim.registry');
const {
    predicateFacets,
    resolveScope,
    isCustomerAvailable,
    evaluateClaim,
} = require('../claim-gate.service');

const LANDING_CLAIMS = [
    'price.unit', 'price.zero', 'price.nosub',
    'courier.booking', 'courier.payout',
    'rto.verify', 'voice.transcribe', 'ai.notrain',
    'order.fromchat', 'customer.ledger', 'knowledge.gaps',
    'queue.priority', 'handoff.human',
];

const CAPABILITY_CLAIMS = [
    ['rto.verify', 'platform.rto'],
    ['order.fromchat', 'platform.order_from_chat'],
    ['customer.ledger', 'platform.customer_ledger'],
    ['knowledge.gaps', 'platform.knowledge_gaps'],
    ['queue.priority', 'platform.queue_priority'],
    ['handoff.human', 'platform.human_handoff'],
];

const allProviderFlags = (facet, value) => ({
    [`courier.pathao.${facet}`]: value,
    [`courier.steadfast.${facet}`]: value,
    [`courier.redx.${facet}`]: value,
});

describe('landing claim registry', () => {
    test('every required landing claim is registered on the landing surface', () => {
        for (const id of LANDING_CLAIMS) {
            expect(CLAIM_IDS).toContain(id);
            expect(getClaim(id).surfaces).toContain('landing');
            expect(getClaim(id).deprecated).toBe(false);
            expect(getClaim(id).internalOnly).toBe(false);
        }
    });

    test('registry hash is a sha256 digest', () => {
        expect(registryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test('every landing capability claim ships a truthful fallback', () => {
        for (const id of LANDING_CLAIMS.filter((entry) => entry !== 'price.unit')) {
            expect(getClaim(id).fallbackI18nKey).not.toBeNull();
        }
    });
});

describe('B3 — price.zero fails closed when returns are not zero-rated', () => {
    const entry = getClaim('price.zero');

    test('available when the contract zero-rates RETURNED and CANCELLED', () => {
        const predicate = predicateFacets(entry, { 'contract.zero_on_return': true });
        expect(isCustomerAvailable(predicate)).toBe(true);
    });

    test('unavailable when zeroOnReturn is false', () => {
        const predicate = predicateFacets(entry, { 'contract.zero_on_return': false });
        expect(isCustomerAvailable(predicate)).toBe(false);
        expect(entry.fallbackI18nKey).not.toBeNull();
    });
});

describe('B4 — price.nosub fails closed when a fee exists', () => {
    const entry = getClaim('price.nosub');

    test('available when subscription/setup/monthly fees are all zero', () => {
        const predicate = predicateFacets(entry, { 'contract.no_subscription': true });
        expect(isCustomerAvailable(predicate)).toBe(true);
    });

    test('unavailable when a non-zero subscription fee is configured', () => {
        const predicate = predicateFacets(entry, { 'contract.no_subscription': false });
        expect(isCustomerAvailable(predicate)).toBe(false);
        expect(entry.fallbackI18nKey).not.toBeNull();
    });
});

describe('B5 — courier.payout scopes on settlement_present', () => {
    const entry = getClaim('courier.payout');

    test('one settlement provider yields a scoped, still-available claim', () => {
        const evidence = {
            'courier.pathao.settlement_present': false,
            'courier.steadfast.settlement_present': true,
            'courier.redx.settlement_present': false,
        };
        const scope = resolveScope(entry, evidence);
        expect(scope.count).toBe(1);
        expect(scope.match).toBe(false);
        expect(scope.verifiedProviders).toEqual(['steadfast']);
        expect(isCustomerAvailable(predicateFacets(entry, evidence))).toBe(true);
    });

    test('no settlement provider makes the claim unavailable', () => {
        const evidence = allProviderFlags('settlement_present', false);
        expect(isCustomerAvailable(predicateFacets(entry, evidence))).toBe(false);
        expect(entry.fallbackI18nKey).not.toBeNull();
    });

    test('all settlement providers make the scope match', () => {
        const evidence = allProviderFlags('settlement_present', true);
        expect(resolveScope(entry, evidence).match).toBe(true);
        expect(isCustomerAvailable(predicateFacets(entry, evidence))).toBe(true);
    });

    test('production_verified does NOT leak into payout scope', () => {
        // Payout scopes on settlement, not on booking verification.
        const evidence = {
            ...allProviderFlags('production_verified', true),
            ...allProviderFlags('settlement_present', false),
        };
        expect(isCustomerAvailable(predicateFacets(entry, evidence))).toBe(false);
    });
});

describe('courier.booking — fails closed until a live booking is verified', () => {
    const entry = getClaim('courier.booking');

    test('0 of 3 production-verified renders the truthful fallback', () => {
        const evidence = allProviderFlags('production_verified', false);
        const predicate = predicateFacets(entry, evidence);
        expect(predicate.production_verified).toBe(false);
        expect(predicate.scope_match).toBe(false);
        expect(isCustomerAvailable(predicate)).toBe(false);
        expect(entry.fallbackI18nKey).not.toBeNull();
    });
});

describe('capability claims — code present, production verification pending', () => {
    test.each(CAPABILITY_CLAIMS)('%s falls back without production verification', (id, prefix) => {
        const entry = getClaim(id);
        const predicate = predicateFacets(entry, {
            [`${prefix}.code_present`]: true,
            [`${prefix}.production_verified`]: false,
        });
        expect(isCustomerAvailable(predicate)).toBe(false);
        expect(entry.fallbackI18nKey).not.toBeNull();
    });

    test('voice.transcribe reuses the existing voice-transcription evidence', () => {
        const entry = getClaim('voice.transcribe');
        const predicate = predicateFacets(entry, {
            'platform.voice.transcription.code_present': true,
            'platform.voice.transcription.production_verified': false,
        });
        expect(isCustomerAvailable(predicate)).toBe(false);
    });
});

describe('ai.notrain — published-policy claim', () => {
    test('available when the no-training policy fact is true', () => {
        const predicate = predicateFacets(getClaim('ai.notrain'), {
            'platform.ai.no_training_policy': true,
        });
        expect(isCustomerAvailable(predicate)).toBe(true);
    });

    test('fails closed when the policy fact is false', () => {
        const predicate = predicateFacets(getClaim('ai.notrain'), {
            'platform.ai.no_training_policy': false,
        });
        expect(isCustomerAvailable(predicate)).toBe(false);
    });
});

describe('decision interpolation derives from the contract', () => {
    test('price.unit interpolates BDT 10 in both locales', async () => {
        const decision = await evaluateClaim('price.unit', { surface: 'landing', locale: 'en' });
        expect(decision.available).toBe(true);
        expect(decision.render).toBe('claim');
        expect(decision.interpolation.unitPrice).toBe('৳10.00');
        expect(decision.interpolation.unitPriceBn).toBe('৳১০.০০');
    });

    test('price.zero interpolates the contract zero amount in Bengali numerals', async () => {
        const decision = await evaluateClaim('price.zero', { surface: 'landing', locale: 'bn' });
        expect(decision.interpolation.zeroAmount).toBe('৳0.00');
        expect(decision.interpolation.zeroAmountBn).toBe('৳০.০০');
    });

    test('courier.payout interpolates a brand-free provider count', async () => {
        const decision = await evaluateClaim('courier.payout', { surface: 'landing', locale: 'bn' });
        expect(decision.interpolation.providerCount).toBe('1');
        expect(decision.interpolation.providerCountBn).toBe('১');
        // Names may be present for app surfaces but the landing copy must not
        // use them; assert the count exists and is a bare numeral.
        expect(decision.scope.match).toBe(false);
    });
});