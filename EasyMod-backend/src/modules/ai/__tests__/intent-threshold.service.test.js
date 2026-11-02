'use strict';

const mockUpdateSettings = jest.fn();

jest.mock('../../shop/shop.service', () => ({
    updateShopSettingsPreservingRtoConsent: (...args) => mockUpdateSettings(...args),
}));

const { mergeSettingsPreservingRtoConsent } = require('../../shop/shop-settings.validator');
const { updateIntentThresholds } = require('../intent-threshold.service');

describe('updateIntentThresholds', () => {
    let currentSettings;

    beforeEach(() => {
        jest.clearAllMocks();
        currentSettings = {
            rto_network: { contribute: false, enforce: true },
            ai: {
                confidence_threshold: 75,
                intentThresholds: { greeting: 60, order_support: 82 },
            },
        };
        mockUpdateSettings.mockImplementation(async (_shopId, patchBuilder) => {
            const patch = patchBuilder(currentSettings);
            return mergeSettingsPreservingRtoConsent(currentSettings, patch);
        });
    });

    it('merges thresholds from the fresh locked settings without restoring RTO consent', async () => {
        const result = await updateIntentThresholds('shop-1', { greeting: 70, returns: 90 });

        expect(result).toEqual({ greeting: 70, order_support: 82, returns: 90 });
        expect(mockUpdateSettings).toHaveBeenCalledWith('shop-1', expect.any(Function));
        expect(currentSettings.rto_network).toEqual({ contribute: false, enforce: true });
    });

    it('rejects invalid thresholds without entering the settings write path', async () => {
        await expect(updateIntentThresholds('shop-1', { refund: 101 })).rejects.toMatchObject({ status: 400 });
        expect(mockUpdateSettings).not.toHaveBeenCalled();
    });
});
