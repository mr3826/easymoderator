'use strict';

process.env.NODE_ENV = 'test';

const mockFindByPk = jest.fn();
const mockConfirmWebhookActive = jest.fn();
const mockGetProvider = jest.fn();
const mockSerializeChannel = jest.fn((channel) => channel);

jest.mock('../meta-channel.entity', () => ({ findByPk: mockFindByPk }));
jest.mock('../meta-channel-settings.entity', () => ({}));
jest.mock('../meta-channel-consent-event.entity', () => ({}));
jest.mock('../meta-channel.service', () => ({ confirmWebhookActive: mockConfirmWebhookActive }));
jest.mock('../meta-oauth.service', () => ({}));
jest.mock('../provider.registry', () => ({ getProvider: mockGetProvider }));
jest.mock('../meta-channel.serializer', () => ({ serializeChannel: mockSerializeChannel }));

const controller = require('../meta-channel.controller');

function response() {
    return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

const connectedChannel = () => ({
    id: 'channel-1',
    shop_id: 'shop-1',
    platform: 'facebook',
    status: 'CONNECTED',
    meta_asset_id: 'PAGE_1',
    page_access_token_ct: 'server-only-token',
});

let provider;

beforeEach(() => {
    jest.clearAllMocks();
    provider = {
        ping: jest.fn(),
        webhookFields: jest.fn(() => ['messages']),
        verifyWebhookSubscription: jest.fn().mockResolvedValue({ ok: true, fields: ['messages'] }),
        subscribeWebhook: jest.fn(),
    };
    mockGetProvider.mockReturnValue(provider);
    mockFindByPk.mockResolvedValue(connectedChannel());
});

describe('testWebhook canonical health contract', () => {
    test('uses subscribed_apps verification and never invokes the legacy Page-node ping', async () => {
        const res = response();

        await controller.testWebhook({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
            body: {},
        }, res, jest.fn());

        expect(provider.ping).not.toHaveBeenCalled();
        expect(provider.verifyWebhookSubscription).toHaveBeenCalledWith({ channel: expect.objectContaining({
            id: 'channel-1',
            meta_asset_id: 'PAGE_1',
        }) });
        expect(mockConfirmWebhookActive).toHaveBeenCalledWith('channel-1', ['messages']);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                ping: expect.objectContaining({ ok: true }),
                connection: { ok: true, status: 'CONNECTED' },
                subscription: expect.objectContaining({ ok: true, fields: ['messages'] }),
                transport: { status: 'NOT_PROBED', reason: 'requires an inbound Messenger event' },
            }),
        }));
    });

    test('reports missing subscription as an unhealthy webhook without repair', async () => {
        provider.verifyWebhookSubscription.mockResolvedValueOnce({ ok: false, fields: [] });
        const res = response();

        await controller.testWebhook({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
            body: {},
        }, res, jest.fn());

        expect(provider.subscribeWebhook).not.toHaveBeenCalled();
        expect(mockConfirmWebhookActive).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0].data.ping.ok).toBe(false);
        expect(res.json.mock.calls[0][0].data.subscription.ok).toBe(false);
    });

    test('degrades safely when Meta verification fails', async () => {
        provider.verifyWebhookSubscription.mockRejectedValueOnce(new Error('Meta unavailable'));
        const res = response();

        await controller.testWebhook({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
            body: {},
        }, res, jest.fn());

        expect(res.json.mock.calls[0][0].data.ping).toMatchObject({
            ok: false,
            error: 'verification_failed',
        });
        expect(mockConfirmWebhookActive).not.toHaveBeenCalled();
    });

    test('rejects a channel from another shop before any Meta request', async () => {
        mockFindByPk.mockResolvedValueOnce({ ...connectedChannel(), shop_id: 'shop-other' });
        const next = jest.fn();

        await controller.testWebhook({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
            body: {},
        }, response(), next);

        // API_CONTRACT §2: cross-shop is a 404 (no existence leak); rejection
        // still precedes any Meta request.
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
        expect(provider.verifyWebhookSubscription).not.toHaveBeenCalled();
    });

    test.each([
        ['DISCONNECTED', 'server-only-token'],
        ['CONNECTED', null],
    ])('fails health for %s or missing Page token', async (status, token) => {
        mockFindByPk.mockResolvedValueOnce({ ...connectedChannel(), status, page_access_token_ct: token });
        const res = response();

        await controller.testWebhook({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
            body: {},
        }, res, jest.fn());

        expect(provider.verifyWebhookSubscription).not.toHaveBeenCalled();
        expect(res.json.mock.calls[0][0].data).toMatchObject({
            ping: { ok: false },
            connection: { ok: false, status },
            subscription: { ok: false, fields: [] },
        });
    });
});
