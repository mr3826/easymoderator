'use strict';

/**
 * Evidence authorities — the static manifest that says WHERE each claim
 * evidence flag is resolved. It carries no runtime work: no DB handle, no
 * service import, no environment read. The claim registry and the CI claims
 * scanner can both require it without booting the platform, and a resolver
 * added in a later phase must match the module/export named here.
 *
 * A flag is true only when its authority can evidence it. Anything unlisted is
 * unprovable, and an unprovable flag fails the claim registry at require time.
 */

const { deepFreeze } = require('./commercial.contract');

const SUPPORTED_PROVIDERS = Object.freeze(['pathao', 'steadfast', 'redx']);
const SUPPORTED_ADDONS = Object.freeze(['ads_studio', 'storefront']);

const COURIER_CAPABILITIES = Object.freeze({
    module: '../delivery/provider-capabilities',
    path: 'src/modules/delivery/provider-capabilities.js',
    exportName: 'PROVIDER_CAPABILITIES',
    pure: true,
});

const authority = (module, exportName, pure, resolveHint, path) => Object.freeze({
    module,
    path,
    exportName,
    pure,
    resolveHint,
});

const courierAuthority = (resolveHint) => authority(
    COURIER_CAPABILITIES.module,
    COURIER_CAPABILITIES.exportName,
    COURIER_CAPABILITIES.pure,
    resolveHint,
    COURIER_CAPABILITIES.path,
);

const EVIDENCE_AUTHORITIES = deepFreeze({
    contract: authority(
        './commercial.contract',
        'COMMERCIAL_CONTRACT',
        true,
        'always true: the frozen contract module is the price/term evidence',
        'src/modules/commercial/commercial.contract.js',
    ),

    ...Object.fromEntries(SUPPORTED_PROVIDERS.flatMap((provider) => [
        [`courier.${provider}.code_present`, courierAuthority(
            'code_present: create_parcel.level !== UNSUPPORTED',
        )],
        [`courier.${provider}.production_verified`, courierAuthority(
            'production_verified: last_verified_at !== null && level === LIVE_VERIFIED',
        )],
        [`courier.${provider}.settlement_present`, courierAuthority(
            'settlement capability entry (added in Phase 1)',
        )],
    ])),

    ...Object.fromEntries(SUPPORTED_ADDONS.map((code) => [
        `addons.${code}.merchant_enabled`,
        authority(
            '../pilot-features/pilot-features.service',
            'getPilotFeaturesStrict',
            false,
            `${code} storefront/adsStudio flag; lookup failure => false (claims fail closed)`,
            'src/modules/pilot-features/pilot-features.service.js',
        ),
    ])),

    'ai.auto_reply.merchant_enabled': authority(
        '../shop/shop.service',
        'getShopAiSettings',
        false,
        'settings.ai.auto_reply_enabled; unreadable settings => false (claims fail closed)',
        'src/modules/shop/shop.service.js',
    ),

    'platform.voice.transcription.code_present': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (mock-only route)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.voice.transcription.production_verified': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (never live-verified)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.voice.auto_reply.code_present': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (no auto-reply path for voice)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.voice.auto_reply.production_verified': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (voice auto-reply never production-verified; fail closed)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.ai.auto_reply.code_present': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (AUTO reply path exists)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.ai.auto_reply.production_verified': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (AUTO never proven live; fail closed)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.ai.draft_reply.code_present': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (DRAFT/manual pipeline exists)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.ai.draft_reply.production_verified': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (test-verified only; never proven in production; fail closed)',
        'src/modules/commercial/claim.registry.js',
    ),
    'platform.addons.code_present': authority(
        './claim.registry',
        'PLATFORM_EVIDENCE',
        true,
        'PLATFORM_EVIDENCE value (pilot add-on code ships)',
        'src/modules/commercial/claim.registry.js',
    ),
});

const EVIDENCE_FLAGS = Object.freeze(Object.keys(EVIDENCE_AUTHORITIES));

const assertManifestCovers = (requiredEvidenceIds) => {
    if (!Array.isArray(requiredEvidenceIds)) {
        throw new TypeError('requiredEvidenceIds must be an array of evidence flag ids');
    }
    const missing = requiredEvidenceIds.filter(
        (flagId) => !Object.prototype.hasOwnProperty.call(EVIDENCE_AUTHORITIES, flagId),
    );
    if (missing.length > 0) {
        throw new Error(`evidence manifest has no authority for: ${missing.join(', ')}`);
    }
    return true;
};

module.exports = {
    EVIDENCE_AUTHORITIES,
    EVIDENCE_FLAGS,
    SUPPORTED_PROVIDERS,
    SUPPORTED_ADDONS,
    assertManifestCovers,
};