'use strict';

const mockPaymentConfig = {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
};
const mockUserShop = { findOne: jest.fn().mockResolvedValue({ is_active: true }) };
const mockUpdateBdSettings = jest.fn().mockResolvedValue(true);

jest.mock('../../entities', () => ({ PaymentConfig: mockPaymentConfig, UserShop: mockUserShop }));
jest.mock('../../shop/shop-bd-settings', () => ({ updateBdSettings: mockUpdateBdSettings }));
jest.mock('../payment.service', () => ({
    savePaymentConfig: jest.fn(),
}));

const paymentService = require('../payment.service');
const actualPaymentService = jest.requireActual('../payment.service');
const controller = require('../payment.controller');

describe('payment controller response serialization', () => {
    test('does not return decrypted payment credentials after save', async () => {
        paymentService.savePaymentConfig.mockResolvedValue({
            toJSON: () => ({
                id: 'config-1',
                gateway: 'self-mfs',
                is_enabled: true,
                credentials: {
                    mfs_type: 'bkash',
                    mfs_mode: 'self',
                    mfs_number: '01712345678',
                    app_secret: 'must-not-leak',
                },
                config: { display_name: 'bKash', api_secret: 'config-secret' },
            }),
        });

        const req = {
            user: { shopId: 'shop-1', userId: 'user-1' },
            body: { gateway: 'self-mfs', is_enabled: true, credentials: { mfs_number: '01712345678' } },
        };
        const json = jest.fn();
        const res = { status: jest.fn(() => ({ json })) };
        const next = jest.fn();

        await controller.savePaymentConfig(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.not.objectContaining({ credentials: expect.anything() }),
        }));
        const responseData = json.mock.calls[0][0].data;
        expect(responseData.credential_summary).toEqual({
            has_credentials: true,
            mfs_type: 'bkash',
            mfs_mode: 'self',
            mfs_number: '01712345678',
        });
        expect(responseData.credential_summary).not.toHaveProperty('app_secret');
        expect(responseData.config).toEqual({ display_name: 'bKash' });
    });

    describe('self-MFS enablement validation', () => {
        const validCredentials = () => ({
            mfs_type: 'bkash',
            mfs_number: '01712345678',
            mfs_mode: 'self',
        });

        beforeEach(() => {
            jest.clearAllMocks();
            mockPaymentConfig.findOne.mockResolvedValue(null);
            mockPaymentConfig.create.mockImplementation(async (attributes) => ({
                ...attributes,
                save: jest.fn().mockResolvedValue(true),
                credentials: attributes.credentials,
            }));
        });

        test('rejects invalid new credentials before creating an enabled record', async () => {
            await expect(actualPaymentService.savePaymentConfig(
                'shop-1', 'user-1', 'self-mfs', true,
                { mfs_type: 'wire', mfs_number: '01712345678', mfs_mode: 'self' },
            )).rejects.toMatchObject({ status: 400 });

            expect(mockPaymentConfig.findOne).not.toHaveBeenCalled();
            expect(mockPaymentConfig.create).not.toHaveBeenCalled();
        });

        test('validates decrypted stored credentials before enabling an existing record', async () => {
            const save = jest.fn().mockResolvedValue(true);
            const existing = {
                is_enabled: false,
                credentials: { mfs_type: 'bkash', mfs_number: 'not-a-number', mfs_mode: 'self' },
                save,
            };
            mockPaymentConfig.findOne.mockResolvedValue(existing);

            await expect(actualPaymentService.savePaymentConfig(
                'shop-1', 'user-1', 'self-mfs', true,
            )).rejects.toMatchObject({ status: 400 });

            expect(save).not.toHaveBeenCalled();
            expect(existing.is_enabled).toBe(false);
        });

        test('enables valid stored credentials when a toggle omits credentials', async () => {
            const save = jest.fn().mockResolvedValue(true);
            const existing = { is_enabled: false, credentials: validCredentials(), save };
            mockPaymentConfig.findOne.mockResolvedValue(existing);

            await actualPaymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', true);

            expect(existing.is_enabled).toBe(true);
            expect(save).toHaveBeenCalledTimes(1);
        });

        test('treats empty credentials as missing and keeps COD credential-free', async () => {
            await actualPaymentService.savePaymentConfig('shop-1', 'user-1', 'self-mfs', false, {});
            await actualPaymentService.savePaymentConfig('shop-1', 'user-1', 'cod', true, {});

            expect(mockPaymentConfig.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ credentials: null }));
            expect(mockPaymentConfig.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ gateway: 'cod', credentials: null }));
        });

        test('normalizes the legacy bkash alias before validation', async () => {
            await actualPaymentService.savePaymentConfig(
                'shop-1', 'user-1', 'bkash', true,
                { phone: '01712345678', accountType: 'self' },
            );

            expect(mockPaymentConfig.create).toHaveBeenCalledWith(expect.objectContaining({
                gateway: 'self-mfs',
                credentials: expect.objectContaining({
                    mfs_type: 'bkash',
                    mfs_number: '01712345678',
                    mfs_mode: 'self',
                }),
            }));
        });

        test('uses the same validator for the connection-test path', async () => {
            await expect(actualPaymentService.testPaymentConnection(
                'shop-1', 'user-1', 'self-mfs',
                { mfs_type: 'bkash', mfs_number: '01712345678', mfs_mode: 'invalid' },
            )).rejects.toMatchObject({ status: 400 });

            await expect(actualPaymentService.testPaymentConnection(
                'shop-1', 'user-1', 'self-mfs', validCredentials(),
            // §7 row 1 (misleading-claim cleanup): testPaymentConnection is a LOCAL
            // format check only; the old "number verified" wording implied a provider
            // connection. Intent preserved (same validator); the honest shape replaces it.
            )).resolves.toEqual({ success: true, status: 'format_validated', message: 'Number format validated — not a provider check' });
        });

        test('returns an approved summary without raw credentials on reads', async () => {
            mockPaymentConfig.findAll.mockResolvedValue([{
                id: 'payment-1',
                gateway: 'self-mfs',
                is_enabled: true,
                config: { display_name: 'bKash', api_secret: 'config-secret' },
                credentials: { ...validCredentials(), app_secret: 'must-not-leak' },
                created_at: '2026-08-27T00:00:00.000Z',
                updated_at: '2026-08-27T00:00:00.000Z',
            }]);

            const [config] = await actualPaymentService.getPaymentConfigs('shop-1', 'user-1');

            expect(config.credential_summary).toEqual({
                has_credentials: true,
                mfs_type: 'bkash',
                mfs_mode: 'self',
                mfs_number: '01712345678',
            });
            expect(config.config).toEqual({ display_name: 'bKash' });
            expect(config).not.toHaveProperty('credentials');
            expect(config.credential_summary).not.toHaveProperty('app_secret');
        });
    });
});
