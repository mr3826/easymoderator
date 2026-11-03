/**
 * Courier provider capabilities — the single source of truth for what each
 * provider integration can actually do, served to Delivery Settings.
 *
 * Capability truth rule: no entry here may claim more than this repository can
 * evidence. Every provider call is mocked in tests, and no live merchant
 * account was exercised in this work, so the ceiling is
 * IMPLEMENTED_NOT_LIVE_VERIFIED. `assertWithinCeiling` fails the module load if
 * a future edit claims LIVE_VERIFIED without raising the ceiling deliberately.
 *
 * Levels, weakest first:
 *   UNSUPPORTED                    the provider offers no such operation and
 *                                  EasyModerator exposes none
 *   UNKNOWN                        we cannot state either way (e.g. Steadfast
 *                                  has no city/zone/area serviceability list)
 *   IMPLEMENTED_NOT_LIVE_VERIFIED  code exists and is unit-tested against
 *                                  mocks; never confirmed with a live account
 *   LIVE_VERIFIED                  confirmed against a real account (not
 *                                  granted anywhere in this repository)
 */

const CAPABILITY_LEVELS = Object.freeze([
    'UNSUPPORTED',
    'UNKNOWN',
    'IMPLEMENTED_NOT_LIVE_VERIFIED',
    'LIVE_VERIFIED',
]);

const CAPABILITY_CEILING = 'IMPLEMENTED_NOT_LIVE_VERIFIED';

const CAPABILITIES_VERSION = 1;

const level = (value, extra = {}) => Object.freeze({ level: value, ...extra });

const notImplemented = () => level('IMPLEMENTED_NOT_LIVE_VERIFIED');

const unsupported = (reasonCode, manualStepCode) => level(
    'UNSUPPORTED',
    { reason_code: reasonCode, manual_step_code: manualStepCode },
);

const PROVIDER_CAPABILITIES = Object.freeze({
    pathao: Object.freeze({
        coverage: notImplemented('COVERAGE_DIRECTORY', null),
        rate_quote: notImplemented('PROVIDER_RATE_API', null),
        create_parcel: notImplemented('CREATE_PARCEL_API', null),
        tracking: notImplemented('TRACKING_API', null),
        // Verified against pathao.provider.js: no cancel or update method is
        // implemented, and Pathao's merchant API surface used here has none.
        cancel: unsupported('NO_PROVIDER_API', 'CANCEL_IN_PROVIDER_PORTAL'),
        edit: unsupported('NO_PROVIDER_API', 'EDIT_IN_PROVIDER_PORTAL'),
        last_verified_at: null,
    }),
    steadfast: Object.freeze({
        // Steadfast books by text address. It has a police-station lookup, but
        // that is not a city/zone/area serviceability directory, so coverage
        // cannot be answered — UNKNOWN, never a silent "serviceable".
        coverage: level('UNKNOWN', { reason_code: 'TEXT_ONLY_COVERAGE', manual_step_code: null }),
        // steadfast.provider.js: calculatePrice returns null by design.
        rate_quote: unsupported('NO_PROVIDER_API', 'RATE_SHOWN_AFTER_BOOKING'),
        create_parcel: notImplemented('CREATE_PARCEL_API', null),
        tracking: notImplemented('TRACKING_API', null),
        cancel: unsupported('NO_PROVIDER_API', 'CANCEL_IN_PROVIDER_PORTAL'),
        edit: unsupported('NO_PROVIDER_API', 'EDIT_IN_PROVIDER_PORTAL'),
        last_verified_at: null,
    }),
    redx: Object.freeze({
        coverage: notImplemented('COVERAGE_DIRECTORY', null),
        rate_quote: notImplemented('PROVIDER_RATE_API', null),
        create_parcel: notImplemented('CREATE_PARCEL_API', null),
        tracking: notImplemented('TRACKING_API', null),
        // redx.provider.js: cancelParcel() and updateParcel() exist.
        cancel: notImplemented('CANCEL_PARCEL_API', null),
        edit: notImplemented('UPDATE_PARCEL_API', null),
        last_verified_at: null,
    }),
});

const capabilityRank = (value) => {
    const index = CAPABILITY_LEVELS.indexOf(value);
    if (index === -1) {
        throw new Error(`Unknown courier capability level: ${String(value)}`);
    }
    return index;
};

/**
 * Fail fast at require-time if any declaration exceeds the ceiling. This is a
 * code invariant, not a runtime feature flag: a capability claim that has no
 * evidence must be impossible to ship.
 */
const assertWithinCeiling = () => {
    const ceilingRank = capabilityRank(CAPABILITY_CEILING);
    for (const [provider, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
        for (const [operation, entry] of Object.entries(capabilities)) {
            if (!entry || typeof entry.level !== 'string') continue;
            if (capabilityRank(entry.level) > ceilingRank) {
                throw new Error(
                    `Courier capability ${provider}.${operation} claims ${entry.level}, `
                    + `above the ${CAPABILITY_CEILING} ceiling`,
                );
            }
        }
    }
};

assertWithinCeiling();

const getProviderCapabilities = (provider) => {
    const capabilities = PROVIDER_CAPABILITIES[provider];
    if (!capabilities) return null;
    return {
        version: CAPABILITIES_VERSION,
        ceiling: CAPABILITY_CEILING,
        ...capabilities,
    };
};

module.exports = {
    CAPABILITY_LEVELS,
    CAPABILITY_CEILING,
    CAPABILITIES_VERSION,
    PROVIDER_CAPABILITIES,
    getProviderCapabilities,
};