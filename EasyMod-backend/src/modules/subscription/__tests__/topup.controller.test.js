'use strict';

/**
 * Top-up endpoints are retired (ADR-0011). Purchase/checkout/catalog return
 * 410 Gone; only the historical read remains.
 */

jest.mock('../topup.service', () => ({
    getTopupPacks: jest.fn(),
    initiateTopup: jest.fn(),
    completeTopup: jest.fn(),
    getTopupHistory: jest.fn(),
}));

const topupService = require('../topup.service');
const topupController = require('../topup.controller');

const makeReq = (body = {}, query = {}) => ({
    user: { userId: 'user-1', shopId: 'shop-1' },
    body,
    query,
});

const makeRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
});

beforeEach(() => jest.clearAllMocks());

describe('retired purchase endpoints', () => {
    it.each([
        ['getPacks', {}],
        ['initiateTopup', { pack_code: 'PACK_100' }],
        ['completeTopup', { topup_id: 't-1', payment_id: 'p-1' }],
    ])('%s returns 410 Gone and never calls the service', (handler, body) => {
        const res = makeRes();
        topupController[handler](makeReq(body), res);

        expect(res.status).toHaveBeenCalledWith(410);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'TOPUP_PROGRAMME_RETIRED',
        }));
        expect(topupService.initiateTopup).not.toHaveBeenCalled();
        expect(topupService.completeTopup).not.toHaveBeenCalled();
    });
});

describe('historical read', () => {
    it('still returns paginated top-up history for the authenticated shop', async () => {
        topupService.getTopupHistory.mockResolvedValueOnce([{ id: 'old-1' }]);
        const res = makeRes();
        const next = jest.fn();

        await topupController.getHistory(makeReq({}, { limit: '5', offset: '2' }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(topupService.getTopupHistory).toHaveBeenCalledWith('shop-1', 5, 2);
        expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ id: 'old-1' }] });
    });
});