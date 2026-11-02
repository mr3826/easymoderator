'use strict';

const mockUpdateSettings = jest.fn();

jest.mock('../../entities', () => ({ Message: {}, Conversation: {}, Customer: {} }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../../shop/shop.service', () => ({
    updateShopSettingsPreservingRtoConsent: (...args) => mockUpdateSettings(...args),
}));

const { mergeSettingsPreservingRtoConsent } = require('../../shop/shop-settings.validator');
const { configureVoiceProcessing } = require('../voice-processing.service');

describe('configureVoiceProcessing settings writes', () => {
    it('merges into the fresh settings while preserving the current RTO opt-out', async () => {
        const current = {
            rto_network: { contribute: false, enforce: true },
            ai: { confidence_threshold: 74 },
        };
        let savedSettings;
        mockUpdateSettings.mockImplementationOnce(async (_shopId, patchBuilder) => {
            savedSettings = mergeSettingsPreservingRtoConsent(current, patchBuilder(current));
        });

        await expect(configureVoiceProcessing('shop-1', true)).resolves.toEqual({
            success: true,
            voiceProcessingEnabled: true,
        });

        expect(mockUpdateSettings).toHaveBeenCalledWith('shop-1', expect.any(Function));
        expect(savedSettings).toMatchObject({
            rto_network: { contribute: false, enforce: true },
            ai: { confidence_threshold: 74, voice_processing_enabled: true },
        });
    });
});
