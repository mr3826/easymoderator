'use strict';

const { AppError } = require('../../utils/AppError');

function createStorefrontGate(overrides = {}) {
    return async function assertStorefrontEnabled(shopId) {
        let getPilotFeatures = overrides.getPilotFeaturesStrict || overrides.getPilotFeatures;
        let assertAddonEnabled = overrides.assertAddonEnabled;
        try {
            if (!getPilotFeatures) {
                const pilotFeatures = require('../pilot-features/pilot-features.service');
                getPilotFeatures = pilotFeatures.getPilotFeaturesStrict;
            }
            if (!assertAddonEnabled) {
                ({ assertAddonEnabled } = require('../shop-addons/shop-addons.service'));
            }
        } catch (_) {
            throw new AppError('Storefront availability cannot be verified', 503, 'STOREFRONT_GATE_UNAVAILABLE');
        }

        if (!shopId || typeof getPilotFeatures !== 'function' || typeof assertAddonEnabled !== 'function') {
            throw new AppError('Storefront availability cannot be verified', 503, 'STOREFRONT_GATE_UNAVAILABLE');
        }

        const features = await getPilotFeatures(shopId);
        if (features?.storefront !== true) {
            throw new AppError('Storefront is not enabled for this shop', 404, 'STOREFRONT_UNAVAILABLE');
        }

        const addonResult = await assertAddonEnabled(shopId, 'STOREFRONT');
        if (addonResult === false || addonResult?.enabled === false) {
            throw new AppError('Storefront is not enabled for this shop', 404, 'STOREFRONT_UNAVAILABLE');
        }
    };
}

module.exports = { createStorefrontGate };
