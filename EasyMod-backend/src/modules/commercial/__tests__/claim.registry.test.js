'use strict';

/**
 * UNIT lane — no DB, no network. The claim registry is the allowlist of what
 * the platform may say and where, so these tests pin its shape, its modes and
 * the fail-closed defaults later phases build against.
 */

const {
    CLAIM_REGISTRY,
    CLAIM_IDS,
    SURFACES,
    SURFACE_MODES,
    MERCHANT_SURFACES,
    INTERNAL_SURFACES,
    GATE_MODES,
    PLATFORM_EVIDENCE,
    CLAIM_REGISTRY_VERSION,
    registryHash,
    resolveMode,
    getClaim,
} = require('../claim.registry');
const { EVIDENCE_AUTHORITIES, assertManifestCovers } = require('../evidence-authorities');
const { COMMERCIAL_CONTRACT_VERSION } = require('../commercial.contract');
const snapshot = require('../__snapshots__/commercial.snapshot.json');

const FROZEN_IDS = [
    'billing.delivered_order',
    'billing.overdue_policy',
    'courier.pathao.booking_live',
    'courier.steadfast.booking_live',
    'courier.redx.booking_live',
    'courier.pathao.integration_status',
    'courier.steadfast.integration_status',
    'courier.redx.integration_status',
    'courier.all_providers',
    'courier.cod_settlement.pathao',
    'courier.cod_settlement.steadfast',
    'courier.cod_settlement.redx',
    'voice.transcription',
    'voice.auto_reply',
    'ai.auto_reply',
    'ai.draft_reply',
    'addons.ads_studio.pilot',
    'addons.storefront.pilot',
    'ai.reply_shadow_meter',
];

describe('claim registry — frozen interface', () => {
    test('exposes exactly the frozen id list', () => {
        expect(CLAIM_IDS).toEqual(FROZEN_IDS);
        expect(Object.keys(CLAIM_REGISTRY)).toEqual(FROZEN_IDS);
    });

    test('every entry is frozen and keyed by its own id', () => {
        expect(Object.isFrozen(CLAIM_REGISTRY)).toBe(true);
        for (const id of FROZEN_IDS) {
            const entry = CLAIM_REGISTRY[id];
            expect(entry.id).toBe(id);
            expect(Object.isFrozen(entry)).toBe(true);
            expect(Object.isFrozen(entry.surfaces)).toBe(true);
            expect(Object.isFrozen(entry.requiredEvidence)).toBe(true);
        }
    });

    test('entry shape is complete', () => {
        for (const id of FROZEN_IDS) {
            const entry = CLAIM_REGISTRY[id];
            expect(Array.isArray(entry.surfaces)).toBe(true);
            expect(Array.isArray(entry.requiredEvidence)).toBe(true);
            expect(entry.requiredEvidence.length).toBeGreaterThan(0);
            expect(entry.i18nKey).toEqual({ en: `claims.${id}.en`, bn: `claims.${id}.bn` });
            expect(entry.verifiedScope).toEqual(expect.any(String));
            expect(entry.deprecated).toBe(false);
            expect(typeof entry.internalOnly).toBe('boolean');
        }
    });

    test('a claim is looked up by id only', () => {
        expect(getClaim('billing.delivered_order')).toBe(CLAIM_REGISTRY['billing.delivered_order']);
        expect(getClaim('does.not.exist')).toBeNull();
    });

    test('registryHash is stable and matches the snapshot', () => {
        expect(registryHash).toBe(snapshot.registryHash);
        expect(registryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(CLAIM_REGISTRY_VERSION).toBe(COMMERCIAL_CONTRACT_VERSION);
        expect(CLAIM_REGISTRY_VERSION).toBe(snapshot.contractVersion);
    });
});

describe('claim registry — surfaces and modes', () => {
    test('every declared surface is in the allowlist', () => {
        for (const entry of Object.values(CLAIM_REGISTRY)) {
            for (const surface of entry.surfaces) {
                expect(SURFACES).toContain(surface);
            }
        }
    });

    test('merchant surfaces enforce, internal surfaces are off', () => {
        expect(MERCHANT_SURFACES).toEqual([
            'pricing', 'subscription', 'signup', 'landing',
            'email', 'usage-banner', 'mobile', 'collateral', 'invoice',
        ]);
        expect(INTERNAL_SURFACES).toEqual(['growth-os', 'admin']);
        for (const surface of MERCHANT_SURFACES) {
            expect(SURFACE_MODES[surface]).toBe('enforce');
        }
        for (const surface of INTERNAL_SURFACES) {
            expect(SURFACE_MODES[surface]).toBe('off');
        }
        expect(GATE_MODES).toEqual(['off', 'shadow', 'enforce']);
    });

    test('resolveMode defaults to the surface baseline', () => {
        expect(resolveMode('pricing')).toBe('enforce');
        expect(resolveMode('invoice', null)).toBe('enforce');
        expect(resolveMode('admin')).toBe('off');
        expect(resolveMode('growth-os', '')).toBe('off');
    });

    test('CLAIM_GATE_MODE can shadow a merchant surface globally', () => {
        expect(resolveMode('pricing', 'shadow')).toBe('shadow');
        expect(resolveMode('pricing', 'enforce')).toBe('enforce');
    });

    test('resolveMode never returns off for a merchant surface, even when forced off', () => {
        for (const surface of MERCHANT_SURFACES) {
            for (const mode of GATE_MODES) {
                expect(resolveMode(surface, mode)).not.toBe('off');
            }
            expect(resolveMode(surface, 'off')).toBe('shadow');
        }
    });

    test('an internal surface may be opted in, and stays off when forced off', () => {
        expect(resolveMode('admin', 'shadow')).toBe('shadow');
        expect(resolveMode('admin', 'enforce')).toBe('enforce');
        expect(resolveMode('admin', 'off')).toBe('off');
    });

    test('unknown surfaces and unsupported modes fail loud', () => {
        expect(() => resolveMode('billing-page')).toThrow(TypeError);
        expect(() => resolveMode('pricing', 'sometimes')).toThrow(TypeError);
    });
});

describe('claim registry — evidence', () => {
    test('every required evidence flag has an authority entry', () => {
        for (const entry of Object.values(CLAIM_REGISTRY)) {
            expect(assertManifestCovers(entry.requiredEvidence)).toBe(true);
            for (const flagId of entry.requiredEvidence) {
                expect(EVIDENCE_AUTHORITIES[flagId]).toBeDefined();
            }
        }
    });

    test('an unknown evidence flag is rejected', () => {
        expect(() => assertManifestCovers(['courier.pathao.proof_by_vibes'])).toThrow(/no authority/);
        expect(() => assertManifestCovers('contract')).toThrow(TypeError);
    });

    test('every platform evidence entry carries a non-empty pointer and boolean', () => {
        for (const [flagId, fact] of Object.entries(PLATFORM_EVIDENCE)) {
            expect(typeof fact.value).toBe('boolean');
            expect(typeof fact.evidence).toBe('string');
            expect(fact.evidence.trim()).not.toBe('');
            expect(fact.lastVerifiedAt === null || typeof fact.lastVerifiedAt === 'string').toBe(true);
            expect(EVIDENCE_AUTHORITIES[flagId]).toBeDefined();
        }
    });

    test('AUTO reply is fail-closed: code present, production never verified', () => {
        const entry = getClaim('ai.auto_reply');
        expect(entry.fallbackI18nKey).toEqual({
            en: 'claims.ai.auto_reply.fallback.en',
            bn: 'claims.ai.auto_reply.fallback.bn',
        });
        expect(entry.requiredEvidence).toContain('platform.ai.auto_reply.production_verified');
        expect(PLATFORM_EVIDENCE['platform.ai.auto_reply.code_present'].value).toBe(true);
        expect(PLATFORM_EVIDENCE['platform.ai.auto_reply.production_verified'].value).toBe(false);
    });

    test('courier booking and COD claims are unavailable today and carry truthful fallbacks', () => {
        for (const provider of ['pathao', 'steadfast', 'redx']) {
            const booking = getClaim(`courier.${provider}.booking_live`);
            expect(booking.fallbackI18nKey.en).toBe(`claims.courier.${provider}.booking_live.fallback.en`);
            expect(PLATFORM_EVIDENCE).not.toHaveProperty(`courier.${provider}.production_verified`);

            const settlement = getClaim(`courier.cod_settlement.${provider}`);
            expect(settlement.fallbackI18nKey.en).toBe(`claims.courier.cod_settlement.${provider}.fallback.en`);
        }
    });

    test('courier.all_providers claims all three and needs all three verified', () => {
        const entry = getClaim('courier.all_providers');
        expect(entry.claimedProviders).toEqual(['pathao', 'steadfast', 'redx']);
        expect(entry.requiredEvidence).toEqual([
            'courier.pathao.production_verified',
            'courier.steadfast.production_verified',
            'courier.redx.production_verified',
        ]);
        expect(entry.verifiedScope).toContain('scope_match N=3');
    });

    test('draft reply is available from the verified DRAFT pipeline', () => {
        const entry = getClaim('ai.draft_reply');
        expect(entry.fallbackI18nKey).toBeNull();
        expect(PLATFORM_EVIDENCE['platform.ai.draft_reply.production_verified'].value).toBe(true);
    });

    test('the shadow meter is internal-only and never merchant-rendered', () => {
        const entry = getClaim('ai.reply_shadow_meter');
        expect(entry.internalOnly).toBe(true);
        expect(entry.surfaces).toEqual(['growth-os', 'admin']);
        for (const surface of entry.surfaces) {
            expect(MERCHANT_SURFACES).not.toContain(surface);
        }
    });

    test('every merchant claim is renderable somewhere', () => {
        for (const entry of Object.values(CLAIM_REGISTRY)) {
            if (entry.internalOnly) continue;
            expect(entry.surfaces.some((surface) => MERCHANT_SURFACES.includes(surface))).toBe(true);
        }
    });
});