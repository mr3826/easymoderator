'use strict';

jest.mock('../conversation.service', () => ({}));
jest.mock('../../../config/redis', () => ({ cacheRedis: null }));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../utils/cache.service', () => ({
    getForShop: jest.fn(),
    setForShop: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
}));
jest.mock('../../channel-providers/meta-channel.service', () => ({}));
jest.mock('../../channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('../conversation-lock.service', () => ({}));
jest.mock('../../policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('../../entities', () => ({ Conversation: {}, Customer: {}, Message: {} }));

const controller = require('../conversation.controller');
const cacheService = require('../../../utils/cache.service');

function response() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

async function checkDuplicate(shopId, body = {
    customer_id: 'customer-fixture',
    message_id: 'message-fixture',
    timestamp: '2026-11-18T12:00:00.000Z',
}) {
    const res = response();
    await controller.checkDuplicate({ user: shopId ? { shopId } : {}, body }, res);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
}

beforeEach(() => {
    jest.clearAllMocks();
    cacheService.getForShop.mockResolvedValue(null);
    cacheService.setForShop.mockResolvedValue(true);
});

test('uses the authenticated shop namespace and keeps same-shop duplicate semantics', async () => {
    const first = await checkDuplicate('shop-a');
    expect(first).toEqual({
        status: 200,
        body: { is_duplicate: false, original_timestamp: null },
    });
    expect(cacheService.getForShop).toHaveBeenLastCalledWith('shop-a', 'dedup:customer-fixture:message-fixture');
    expect(cacheService.setForShop).toHaveBeenCalledWith(
        'shop-a',
        'dedup:customer-fixture:message-fixture',
        '2026-11-18T12:00:00.000Z',
        86400,
    );

    cacheService.getForShop.mockResolvedValueOnce('2026-11-18T12:00:00.000Z');
    expect(await checkDuplicate('shop-a')).toEqual({
        status: 200,
        body: { is_duplicate: true, original_timestamp: '2026-11-18T12:00:00.000Z' },
    });
    expect(cacheService.setForShop).toHaveBeenCalledTimes(1);
    expect(cacheService.get).not.toHaveBeenCalled();
    expect(cacheService.set).not.toHaveBeenCalled();
});

test('does not share a duplicate result between shops for the same message identity', async () => {
    cacheService.getForShop.mockImplementation(async (shopId) => (
        shopId === 'shop-a' ? '2026-11-18T12:00:00.000Z' : null
    ));

    const shopA = await checkDuplicate('shop-a');
    const shopB = await checkDuplicate('shop-b');

    expect(shopA.body.is_duplicate).toBe(true);
    expect(shopB.body.is_duplicate).toBe(false);
    expect(cacheService.getForShop.mock.calls).toEqual([
        ['shop-a', 'dedup:customer-fixture:message-fixture'],
        ['shop-b', 'dedup:customer-fixture:message-fixture'],
    ]);
    expect(cacheService.setForShop).toHaveBeenCalledWith(
        'shop-b',
        'dedup:customer-fixture:message-fixture',
        '2026-11-18T12:00:00.000Z',
        86400,
    );
});

test('requires an authenticated shop before accessing the duplicate cache', async () => {
    expect(await checkDuplicate(null)).toEqual({
        status: 400,
        body: {
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Shop ID is required' },
        },
    });
    expect(cacheService.getForShop).not.toHaveBeenCalled();
    expect(cacheService.setForShop).not.toHaveBeenCalled();
});
