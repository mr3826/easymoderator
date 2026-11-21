'use strict';

const mockModels = {
    AuditLog: { create: jest.fn() },
    Customer: { findOne: jest.fn() },
    MetaChannel: {},
    MetaChannelSettings: { update: jest.fn() },
    MetaUserIdentity: { findAll: jest.fn() },
    OwnerNotification: { create: jest.fn() },
};
const mockUnsubscribe = jest.fn();
const mockConsent = { recordDeauthorize: jest.fn() };
const mockDrain = jest.fn();
const mockAlert = jest.fn();

jest.mock('../../entities', () => mockModels);
jest.mock('../provider.registry', () => ({
    getProvider: () => ({ unsubscribeWebhook: mockUnsubscribe }),
}));
jest.mock('../../consent/consent.service', () => mockConsent);
jest.mock('../../../jobs/message-queue', () => ({ drainChannelJobs: mockDrain }));
jest.mock('../../../utils/ops-alert', () => ({ opsAlert: mockAlert }));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const service = require('../meta-authorization-recovery.service');

function channel(id, overrides = {}) {
    const row = {
        id,
        shop_id: `shop-${id}`,
        platform: 'facebook',
        meta_asset_id: `page-${id}`,
        display_name: `Page ${id}`,
        status: 'CONNECTED',
        page_access_token_ct: 'token',
        last_error: null,
        update: jest.fn(async (values) => Object.assign(row, values)),
        ...overrides,
    };
    return row;
}

function mapping(channelRow, overrides = {}) {
    return {
        app_scoped_user_id: 'app-user-1',
        page_scoped_user_id: `psid-${channelRow.id}`,
        shop_id: channelRow.shop_id,
        channel_id: channelRow.id,
        channel: channelRow,
        ...overrides,
    };
}

describe('Meta deauthorization and invalid-token recovery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUnsubscribe.mockResolvedValue({ ok: true });
        mockModels.AuditLog.create.mockResolvedValue({});
        mockModels.MetaChannelSettings.update.mockResolvedValue([1]);
        mockModels.OwnerNotification.create.mockResolvedValue({});
        mockModels.Customer.findOne.mockResolvedValue({ id: 'customer-1' });
        mockConsent.recordDeauthorize.mockResolvedValue({});
        mockDrain.mockResolvedValue({ removed: 2 });
        mockAlert.mockResolvedValue(undefined);
    });

    test('deauthorizes every mapped Page and creates reconnect state', async () => {
        const first = channel('1');
        const second = channel('2');
        mockModels.MetaUserIdentity.findAll.mockResolvedValue([
            mapping(first),
            mapping(second),
        ]);

        const result = await service.processDeauthorization('app-user-1');
        expect(result).toMatchObject({ channelsDisabled: 2, repeated: false });
        expect(mockModels.MetaUserIdentity.findAll).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                app_scoped_user_id: 'app-user-1',
                is_current_connection: true,
            },
        }));
        for (const item of [first, second]) {
            expect(item).toMatchObject({
                status: 'REVOKED',
                page_access_token_ct: null,
                last_error: 'meta_deauthorized_reconnect_required',
                // D2: revoke must wipe the webhook verification stamp — the
                // health grid shows "Active" purely from that field.
                webhook_last_verified_at: null,
                webhook_subscribed_fields: [],
            });
        }
        expect(mockModels.MetaChannelSettings.update).not.toHaveBeenCalled();
        expect(mockDrain).toHaveBeenCalledTimes(2);
        expect(mockModels.OwnerNotification.create).toHaveBeenCalledTimes(2);
        expect(mockConsent.recordDeauthorize).toHaveBeenCalledTimes(2);
    });

    test('repeated deauthorization is idempotent and does not duplicate notifications', async () => {
        const revoked = channel('1', {
            status: 'REVOKED',
            page_access_token_ct: null,
            last_error: 'meta_deauthorized_reconnect_required',
        });
        mockModels.MetaUserIdentity.findAll.mockResolvedValue([mapping(revoked)]);
        const result = await service.processDeauthorization('app-user-1');
        expect(result).toMatchObject({ channelsDisabled: 0, repeated: true });
        expect(mockModels.OwnerNotification.create).not.toHaveBeenCalled();
        expect(mockConsent.recordDeauthorize).not.toHaveBeenCalled();
        expect(mockModels.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            action: 'meta_channel_deauthorized',
            metadata: expect.objectContaining({ repeated_callback: true }),
        }));
    });

    test('unsubscribe and notification failures do not leave the channel connected', async () => {
        const active = channel('1');
        mockModels.MetaUserIdentity.findAll.mockResolvedValue([mapping(active)]);
        mockUnsubscribe.mockResolvedValue({ ok: false });
        mockModels.OwnerNotification.create.mockRejectedValue(new Error('notification unavailable'));
        await expect(service.processDeauthorization('app-user-1')).resolves.toMatchObject({
            channelsDisabled: 1,
        });
        expect(active.status).toBe('REVOKED');
        expect(active.page_access_token_ct).toBeNull();
    });

    test('repeated deauthorization still heals a stale webhook stamp left by older code (D2)', async () => {
        const stale = channel('1', {
            status: 'REVOKED',
            page_access_token_ct: null,
            last_error: 'meta_deauthorized_reconnect_required',
            webhook_last_verified_at: new Date('2026-01-01T00:00:00Z'),
            webhook_subscribed_fields: ['messages'],
        });
        mockModels.MetaUserIdentity.findAll.mockResolvedValue([mapping(stale)]);

        const result = await service.processDeauthorization('app-user-1');

        expect(result).toMatchObject({ channelsDisabled: 0, repeated: true });
        // Idempotent self-heal: the stamp is cleared, but no second round of
        // notifications, drains, or consent writes fires.
        expect(stale.webhook_last_verified_at).toBeNull();
        expect(stale.webhook_subscribed_fields).toEqual([]);
        expect(mockModels.OwnerNotification.create).not.toHaveBeenCalled();
        expect(mockConsent.recordDeauthorize).not.toHaveBeenCalled();
        expect(mockDrain).not.toHaveBeenCalled();
    });

    test('invalid token disables the channel and prevents futile queued retries', async () => {
        const active = channel('1');
        await service.recoverInvalidToken(active, { metaCode: 190 });
        expect(active).toMatchObject({
            status: 'TOKEN_EXPIRED',
            page_access_token_ct: null,
            last_error: 'meta_token_invalid_reconnect_required',
            // D2: expired tokens clear the webhook stamp too.
            webhook_last_verified_at: null,
            webhook_subscribed_fields: [],
        });
        expect(mockModels.MetaChannelSettings.update).not.toHaveBeenCalled();
        expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({
            metaChannelId: active.id,
        }));
        expect(mockAlert).toHaveBeenCalled();
    });
});
