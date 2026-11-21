'use strict';

jest.mock('../conversation.service', () => ({ getHistoryByCustomer: jest.fn() }));
jest.mock('../../../config/redis', () => ({ cacheRedis: {} }));
jest.mock('../../../utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('../../../utils/cache.service', () => ({}));
jest.mock('../../channel-providers/meta-channel.service', () => ({}));
jest.mock('../../channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('../conversation-lock.service', () => ({}));
jest.mock('../../policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('../../entities', () => ({}));

const controller = require('../conversation.controller');
const { getHistoryByCustomer } = require('../conversation.service');
const customer = '00000000-0000-4000-8000-000000000001';

async function history(query = {}, user = { shopId: 'shop-a' }) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.getHistory({ query: { customer_id: customer, ...query }, user }, res);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
}

beforeEach(() => getHistoryByCustomer.mockReset());

test('returns only the history DTO and preserves the authenticated shop scope', async () => {
    const timestamp = new Date('2026-11-18T00:00:00.000Z');
    getHistoryByCustomer.mockResolvedValue([{
        id: 'history-1', role: 'user', message: 'Hello', createdAt: timestamp,
        metadata: { normalized_message: 'hello', last_intent_record: { slots: { note: 'internal' } }, unexpected: {} },
    }]);
    expect(await history({ limit: '2', within_hours: '24' })).toEqual({ status: 200, body: {
        conversations: [{ id: 'history-1', role: 'user', message: 'Hello', normalized_message: 'hello',
            intent: null, timestamp, metadata: {} }], total: 1,
    } });
    expect(getHistoryByCustomer).toHaveBeenCalledWith('shop-a', customer, { limit: '2', within_hours: '24' });
});

test.each([{ customer_id: [] }, { limit: '101' }, { limit: ['1', '2'] }, { within_hours: '0' }])(
    'rejects invalid history query %p without a database call', async (query) => {
        expect((await history(query)).status).toBe(400);
        expect(getHistoryByCustomer).not.toHaveBeenCalled();
    },
);

test('does not disclose error internals', async () => {
    getHistoryByCustomer.mockRejectedValue(new Error('internal fixture detail'));
    expect(await history()).toEqual({ status: 500, body: {
        success: false, error: { code: 'CONVERSATION_HISTORY_FAILED', message: 'Unable to load conversation history' },
    } });
});
