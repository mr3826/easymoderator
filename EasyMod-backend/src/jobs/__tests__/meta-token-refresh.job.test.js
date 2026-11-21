/**
 * meta-token-refresh.job.test.js
 *
 * Phase 5 rewrite: mock meta-oauth-exchange.js instead of meta.service.
 *
 * Tests the `run()` method directly (bypassing BaseJob plumbing — Redis lock,
 * audit log) so the test stays a pure unit test without a database or Redis.
 *
 * Mocks:
 *   - MetaChannel.findAll                  → returns synthetic channels
 *   - meta-oauth-exchange.exchangeForLongLivedToken → controlled success/failure
 *   - metaChannelService.updateTokens      → records the call
 *   - OwnerNotification.findOne/create     → no-op (duplicate suppression tests)
 *   - sse-manager.emit                     → no-op
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.CHANNEL_ENCRYPTION_KEY = 'a'.repeat(64);

jest.mock('src/modules/channel-providers/meta-channel.entity', () => ({
    findAll: jest.fn(),
}));

jest.mock('src/modules/channel-providers/meta-channel.service', () => ({
    updateTokens: jest.fn(),
}));

// Phase 5: mock the new util, NOT meta.service
jest.mock('src/utils/meta-oauth-exchange', () => ({
    exchangeForLongLivedToken: jest.fn(),
}));

jest.mock('src/modules/entities', () => ({
    OwnerNotification: {
        findOne: jest.fn(),
        create: jest.fn(),
    },
}));

jest.mock('src/utils/sse-manager', () => ({
    emit: jest.fn(),
}));

const MetaChannel = require('src/modules/channel-providers/meta-channel.entity');
const metaChannelService = require('src/modules/channel-providers/meta-channel.service');
const { exchangeForLongLivedToken } = require('src/utils/meta-oauth-exchange');
const { OwnerNotification } = require('src/modules/entities');
const sse = require('src/utils/sse-manager');

const MetaTokenRefreshJob = require('src/jobs/meta-token-refresh.job');

function makeChannel(overrides = {}) {
    const channel = {
        id: 'ch-1',
        shop_id: 'shop-1',
        platform: 'facebook',
        meta_asset_id: 'PAGE_123',
        status: 'CONNECTED',
        token_expires_at: new Date(Date.now() + 5 * 24 * 3600 * 1000), // 5 days
        token_refresh_attempts: 0,
        last_error: null,
        page_access_token_ct: 'plaintext-token-stub',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
    return channel;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('MetaTokenRefreshJob.run()', () => {
    test('successful refresh: updates tokens and emits status SSE', async () => {
        const ch = makeChannel();
        MetaChannel.findAll.mockResolvedValue([ch]);

        const newExpiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000);
        exchangeForLongLivedToken.mockResolvedValue({
            access_token: 'new-long-lived-token',
            expiresAt: newExpiresAt,
        });
        metaChannelService.updateTokens.mockResolvedValue(ch);

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });

        expect(result.channelsChecked).toBe(1);
        expect(result.refreshed).toBe(1);
        expect(result.failed).toBe(0);
        expect(exchangeForLongLivedToken).toHaveBeenCalledWith('plaintext-token-stub');
        expect(metaChannelService.updateTokens).toHaveBeenCalledWith(
            'ch-1',
            { pageAccessToken: 'new-long-lived-token', tokenExpiresAt: newExpiresAt }
        );
        expect(sse.emit).toHaveBeenCalledWith('shop-1', 'channel_status_changed', expect.objectContaining({
            channelId: 'ch-1',
            status: 'CONNECTED',
        }));
    });

    test('dry-run: does not call updateTokens or emit SSE', async () => {
        const ch = makeChannel();
        MetaChannel.findAll.mockResolvedValue([ch]);

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: true, runDate: new Date() });

        expect(result.channelsChecked).toBe(1);
        expect(exchangeForLongLivedToken).not.toHaveBeenCalled();
        expect(metaChannelService.updateTokens).not.toHaveBeenCalled();
        expect(sse.emit).not.toHaveBeenCalled();
    });

    test('refresh failure: marks TOKEN_EXPIRED and increments attempts', async () => {
        const ch = makeChannel({ token_refresh_attempts: 1 });
        MetaChannel.findAll.mockResolvedValue([ch]);

        exchangeForLongLivedToken.mockRejectedValue(new Error('Meta 401'));

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });

        expect(result.failed).toBe(1);
        expect(result.refreshed).toBe(0);
        expect(ch.status).toBe('TOKEN_EXPIRED');
        expect(ch.token_refresh_attempts).toBe(2);
        expect(ch.last_error).toMatch(/Meta 401/);
        expect(ch.save).toHaveBeenCalled();
        expect(sse.emit).toHaveBeenCalledWith('shop-1', 'channel_status_changed', expect.objectContaining({
            status: 'TOKEN_EXPIRED',
        }));
        // Below threshold (3) — no OwnerNotification yet.
        expect(OwnerNotification.create).not.toHaveBeenCalled();
    });

    test('refresh failure clears webhook verification stamps while preserving the attempts counter (D2 bypass guard)', async () => {
        const ch = makeChannel({
            token_refresh_attempts: 4,
            webhook_last_verified_at: new Date(),
            webhook_subscribed_fields: ['messages', 'messaging_postbacks'],
        });
        MetaChannel.findAll.mockResolvedValue([ch]);

        exchangeForLongLivedToken.mockRejectedValue(new Error('Meta 190'));

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });

        expect(result.failed).toBe(1);
        expect(ch.status).toBe('TOKEN_EXPIRED');
        // The direct-write bypass exists to PRESERVE the counter — that must hold.
        expect(ch.token_refresh_attempts).toBe(5);
        // But it must not keep a webhook stamp an expired token cannot back up:
        // the health grid and setup-status read the stamp as proof of delivery.
        expect(ch.webhook_last_verified_at).toBeNull();
        expect(ch.webhook_subscribed_fields).toEqual([]);
        expect(ch.save).toHaveBeenCalled();
    });

    test('dry-run reports a no-token failure but clears nothing (stamps intact)', async () => {
        const stamp = new Date();
        const ch = makeChannel({
            page_access_token_ct: null, // fails before the dryRun short-circuit
            webhook_last_verified_at: stamp,
            webhook_subscribed_fields: ['messages'],
        });
        MetaChannel.findAll.mockResolvedValue([ch]);

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: true, runDate: new Date() });

        expect(result.failed).toBe(1);
        expect(ch.status).toBe('CONNECTED');
        expect(ch.webhook_last_verified_at).toBe(stamp);
        expect(ch.save).not.toHaveBeenCalled();
    });

    test('failure threshold reached: writes OwnerNotification + emits action_required', async () => {
        const ch = makeChannel({ token_refresh_attempts: 2 }); // becomes 3
        MetaChannel.findAll.mockResolvedValue([ch]);
        exchangeForLongLivedToken.mockRejectedValue(new Error('Token revoked'));
        OwnerNotification.findOne.mockResolvedValue(null);

        const job = new MetaTokenRefreshJob();
        await job.run({ dryRun: false, runDate: new Date() });

        expect(ch.token_refresh_attempts).toBe(3);
        expect(OwnerNotification.create).toHaveBeenCalledWith(expect.objectContaining({
            shop_id: 'shop-1',
            type: 'channel.refresh_failed_repeatedly',
            customer_data: expect.objectContaining({
                channel_id: 'ch-1',
                attempts: 3,
            }),
        }));
        expect(sse.emit).toHaveBeenCalledWith('shop-1', 'channel_action_required',
            expect.objectContaining({ reason: 'refresh_failed_repeatedly', attempts: 3 })
        );
    });

    test('failure threshold: suppresses duplicate OwnerNotification within 24h', async () => {
        const ch = makeChannel({ token_refresh_attempts: 2 });
        MetaChannel.findAll.mockResolvedValue([ch]);
        exchangeForLongLivedToken.mockRejectedValue(new Error('Token revoked'));
        OwnerNotification.findOne.mockResolvedValue({ id: 'existing-notif' });

        const job = new MetaTokenRefreshJob();
        await job.run({ dryRun: false, runDate: new Date() });

        expect(OwnerNotification.findOne).toHaveBeenCalled();
        expect(OwnerNotification.create).not.toHaveBeenCalled();
    });

    test('channel with no stored token: counted as failed, no Meta call', async () => {
        const ch = makeChannel({ page_access_token_ct: null });
        MetaChannel.findAll.mockResolvedValue([ch]);

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });

        expect(result.failed).toBe(1);
        expect(exchangeForLongLivedToken).not.toHaveBeenCalled();
        expect(ch.status).toBe('TOKEN_EXPIRED');
    });

    test('empty result set: no failures, no calls', async () => {
        MetaChannel.findAll.mockResolvedValue([]);
        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });
        expect(result.channelsChecked).toBe(0);
        expect(result.refreshed).toBe(0);
        expect(result.failed).toBe(0);
    });

    test('failure isolation: one failure does not block other refreshes', async () => {
        const ch1 = makeChannel({ id: 'ch-1' });
        const ch2 = makeChannel({ id: 'ch-2', shop_id: 'shop-2' });
        MetaChannel.findAll.mockResolvedValue([ch1, ch2]);

        exchangeForLongLivedToken
            .mockRejectedValueOnce(new Error('First failed'))
            .mockResolvedValueOnce({ access_token: 'tok2', expiresAt: new Date() });
        metaChannelService.updateTokens.mockResolvedValue(ch2);

        const job = new MetaTokenRefreshJob();
        const result = await job.run({ dryRun: false, runDate: new Date() });

        expect(result.refreshed).toBe(1);
        expect(result.failed).toBe(1);
        expect(metaChannelService.updateTokens).toHaveBeenCalledTimes(1);
        expect(metaChannelService.updateTokens).toHaveBeenCalledWith('ch-2', expect.any(Object));
    });
});
