'use strict';

const { createStorefrontGate } = require('./storefront.gates');

describe('Storefront feature and add-on gate', () => {
    test('requires the storefront pilot flag and enabled STOREFRONT add-on', async () => {
        const getPilotFeatures = jest.fn().mockResolvedValue({ storefront: true });
        const assertAddonEnabled = jest.fn().mockResolvedValue(true);
        const gate = createStorefrontGate({ getPilotFeatures, assertAddonEnabled });

        await expect(gate('shop-a')).resolves.toBeUndefined();

        expect(getPilotFeatures).toHaveBeenCalledWith('shop-a');
        expect(assertAddonEnabled).toHaveBeenCalledWith('shop-a', 'STOREFRONT');
    });

    test('fails closed when the storefront pilot flag is off', async () => {
        const assertAddonEnabled = jest.fn();
        const gate = createStorefrontGate({
            getPilotFeatures: jest.fn().mockResolvedValue({ storefront: false }),
            assertAddonEnabled,
        });

        await expect(gate('shop-a')).rejects.toMatchObject({ status: 404, code: 'STOREFRONT_UNAVAILABLE' });
        expect(assertAddonEnabled).not.toHaveBeenCalled();
    });

    test('propagates disabled add-on failure rather than exposing the public store', async () => {
        const gate = createStorefrontGate({
            getPilotFeatures: jest.fn().mockResolvedValue({ storefront: true }),
            assertAddonEnabled: jest.fn().mockRejectedValue(Object.assign(new Error('disabled'), { status: 404 })),
        });

        await expect(gate('shop-a')).rejects.toMatchObject({ status: 404 });
    });
});
