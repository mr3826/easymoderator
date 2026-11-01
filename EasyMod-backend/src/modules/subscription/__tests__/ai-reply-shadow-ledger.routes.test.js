'use strict';

const mockGetShadowUsage = jest.fn();
const mockRouter = { use: jest.fn(), get: jest.fn() };
const mockVerifyShopAccess = jest.fn((req, _res, next) => next());
const mockAuthenticate = jest.fn((req, _res, next) => {
    req.user = { shopId: 'authenticated-shop' };
    return next();
});

jest.mock('express', () => ({ Router: () => mockRouter }));
jest.mock('../../../middleware/auth.middleware', () => ({ authenticate: mockAuthenticate }));
jest.mock('../../../middleware/shop-access.middleware', () => ({ verifyShopAccess: mockVerifyShopAccess }));
jest.mock('../ai-reply-shadow-ledger.service', () => ({ getShadowUsage: mockGetShadowUsage }));

const router = require('../ai-reply-shadow-ledger.routes');

beforeEach(() => {
    mockGetShadowUsage.mockReset();
    mockAuthenticate.mockClear();
    mockVerifyShopAccess.mockClear();
    mockGetShadowUsage.mockResolvedValue({
        candidate_units: 1,
        target: 300,
        current_shadow_use: 4,
        period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
        billing_mode: 'shadow',
        enforce: false,
    });
});

it('returns only the authenticated shop shadow projection', async () => {
    expect(router).toBe(mockRouter);
    const req = { query: { shop_id: 'attacker-shop' } };
    const body = {};
    const res = {
        status: jest.fn(() => res),
        json: jest.fn((value) => Object.assign(body, value)),
    };
    const next = jest.fn();
    const [authenticate, verifyShopAccess] = mockRouter.use.mock.calls[0];
    authenticate(req, res, next);
    verifyShopAccess(req, res, next);
    const [path, handler] = mockRouter.get.mock.calls[0];
    expect(path).toBe('/usage');
    await handler(req, res, next);

    expect(mockAuthenticate).toHaveBeenCalled();
    expect(mockVerifyShopAccess).toHaveBeenCalled();
    expect(mockGetShadowUsage).toHaveBeenCalledWith('authenticated-shop');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data).toEqual(expect.objectContaining({
        candidate_units: 1,
        target: 300,
        current_shadow_use: 4,
        billing_mode: 'shadow',
        enforce: false,
    }));
    expect(JSON.stringify(body)).not.toMatch(/message text|customer_id|reply text/i);
});
