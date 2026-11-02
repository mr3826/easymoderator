'use strict';

const mockAxiosPost = jest.fn();
const mockPaymentConfigFindOne = jest.fn();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('axios', () => ({ post: mockAxiosPost }));
jest.mock('../../entities', () => ({
    PaymentConfig: { findOne: mockPaymentConfigFindOne },
    Order: { update: jest.fn() },
}));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: () => mockLogger }));

const bkashService = require('../bkash-merchant.service');

describe('bKash merchant log redaction', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        bkashService.getOAuthToken = jest.fn().mockResolvedValue('test-token');
        mockPaymentConfigFindOne.mockResolvedValue({ credentials: { app_key: 'test-app' } });
    });

    test.each(['createPayment', 'executePayment', 'queryPaymentStatus'])(
        '%s logs only a safe provider error code',
        async (operation) => {
            mockAxiosPost.mockRejectedValue(Object.assign(
                new Error('Rahim 01711111111, Mirpur address, transcript and payment payload'),
                {
                    code: 'UPSTREAM_TIMEOUT',
                    response: { data: { customer_name: 'Rahim', customer_phone: '01711111111', amount: '2400.00' } },
                },
            ));

            const call = operation === 'createPayment'
                ? bkashService[operation]('shop-1', {
                    id: 'order-1', order_number: 'ORDER-1', total: 2400,
                    customer_name: 'Rahim', customer_phone: '01711111111',
                })
                : bkashService[operation]('shop-1', 'PRIVATE-PAYMENT-ID');

            await expect(call).rejects.toMatchObject({ message: expect.stringMatching(/Failed to/) });

            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('bKash payment'), expect.objectContaining({
                errorCode: 'UPSTREAM_TIMEOUT',
            }));
            const logs = JSON.stringify(mockLogger.error.mock.calls);
            expect(logs).not.toContain('01711111111');
            expect(logs).not.toContain('Mirpur address');
            expect(logs).not.toContain('transcript');
            expect(logs).not.toContain('payment payload');
            expect(logs).not.toContain('2400.00');
        },
    );
});
