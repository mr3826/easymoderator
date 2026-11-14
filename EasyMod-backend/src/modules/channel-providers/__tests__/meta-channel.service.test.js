'use strict';

const mockTransaction = {
    commit: jest.fn(),
    rollback: jest.fn(),
};

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

const mockDrainChannelJobs = jest.fn();

const mockMetaChannel = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
};

const mockMetaChannelSettings = {
    findOrCreate: jest.fn(),
    findByPk: jest.fn(),
};

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(),
        getDialect: jest.fn(() => 'postgres'),
        query: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => mockLogger),
}));

jest.mock('../../../jobs/message-queue', () => ({
    drainChannelJobs: mockDrainChannelJobs,
}));

jest.mock('../meta-channel.entity', () => mockMetaChannel);
jest.mock('../meta-channel-settings.entity', () => mockMetaChannelSettings);

const { sequelize } = require('../../../utils/database/database-setup');
const metaChannelService = require('../meta-channel.service');

function makeConflict(overrides = {}) {
    return {
        id: 'old-channel',
        shop_id: 'old-shop',
        platform: 'facebook',
        status: 'CONNECTED',
        connected_by_user_id: null,
        page_access_token_ct: 'old-page-token',
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeCreatedChannel(overrides = {}) {
    return {
        id: 'new-channel',
        shop_id: 'new-shop',
        platform: 'facebook',
        meta_asset_id: 'PAGE_1',
        status: 'CONNECTED',
        ...overrides,
    };
}

async function connect(overrides = {}) {
    return metaChannelService.upsertFromOAuth({
        shopId: 'new-shop',
        userId: 'new-user',
        platform: 'facebook',
        metaAssetId: 'PAGE_1',
        displayName: 'New Page',
        pageAccessToken: 'new-page-token',
        tokenExpiresAt: null,
        webhookVerifyToken: null,
        webhookSubscribedFields: [],
        ...overrides,
    });
}

describe('MetaChannelService cross-shop Meta asset claims', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTransaction.commit.mockResolvedValue(undefined);
        mockTransaction.rollback.mockResolvedValue(undefined);
        sequelize.transaction.mockResolvedValue(mockTransaction);
        mockMetaChannel.findAll.mockResolvedValue([]);
        mockMetaChannel.findOne.mockResolvedValue(null);
        mockMetaChannel.findByPk.mockResolvedValue(null);
        mockMetaChannel.create.mockResolvedValue(makeCreatedChannel());
        mockMetaChannelSettings.findOrCreate.mockResolvedValue([{}, true]);
        mockDrainChannelJobs.mockResolvedValue({ removed: 0 });
    });

    test('serializes cross-tenant connects for the same Page', async () => {
        await connect();

        expect(sequelize.query).toHaveBeenCalledWith(
            'SELECT pg_advisory_xact_lock(hashtext(:lockKey))',
            {
                replacements: { lockKey: 'easymod:meta-channel:PAGE_1' },
                transaction: mockTransaction,
            },
        );
    });

    test('blocks legacy cross-shop claims with no connected_by_user_id', async () => {
        const legacyClaim = makeConflict({ connected_by_user_id: null });
        mockMetaChannel.findAll.mockResolvedValue([legacyClaim]);

        await expect(connect()).rejects.toMatchObject({
            status: 409,
            code: 'META_ASSET_ALREADY_CONNECTED',
        });

        expect(legacyClaim.save).not.toHaveBeenCalled();
        expect(mockMetaChannel.create).not.toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    });

    test('does not use the same Meta user ID as cross-shop ownership proof', async () => {
        const sameUserClaim = makeConflict({ connected_by_user_id: 'new-user' });
        mockMetaChannel.findAll.mockResolvedValue([sameUserClaim]);

        await expect(connect()).rejects.toMatchObject({
            status: 409,
            code: 'META_ASSET_ALREADY_CONNECTED',
        });

        expect(sameUserClaim.save).not.toHaveBeenCalled();
        expect(mockMetaChannel.create).not.toHaveBeenCalled();
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    });

    test('blocks a modern active claim owned by a different EasyModerator user', async () => {
        const activeClaim = makeConflict({
            connected_by_user_id: 'other-user',
            page_access_token_ct: 'still-active-token',
        });
        mockMetaChannel.findAll.mockResolvedValue([activeClaim]);

        await expect(connect()).rejects.toMatchObject({
            status: 409,
            code: 'META_ASSET_ALREADY_CONNECTED',
        });

        expect(activeClaim.save).not.toHaveBeenCalled();
        expect(mockMetaChannel.create).not.toHaveBeenCalled();
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockDrainChannelJobs).not.toHaveBeenCalled();
    });

    test('blocks a TOKEN_EXPIRED cross-shop claim owned by a different user', async () => {
        const expiredClaim = makeConflict({
            status: 'TOKEN_EXPIRED',
            connected_by_user_id: 'other-user',
            page_access_token_ct: null,
        });
        mockMetaChannel.findAll.mockResolvedValue([expiredClaim]);

        await expect(connect()).rejects.toMatchObject({
            status: 409,
            code: 'META_ASSET_ALREADY_CONNECTED',
        });

        expect(expiredClaim.save).not.toHaveBeenCalled();
        expect(mockMetaChannel.create).not.toHaveBeenCalled();
        expect(mockDrainChannelJobs).not.toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    });

    test('releases an explicitly disconnected cross-shop claim', async () => {
        const disconnectedClaim = makeConflict({
            status: 'DISCONNECTED',
            connected_by_user_id: 'other-user',
            page_access_token_ct: null,
        });
        mockMetaChannel.findAll.mockResolvedValue([disconnectedClaim]);

        await connect();

        expect(disconnectedClaim.status).toBe('DISCONNECTED');
        expect(disconnectedClaim.page_access_token_ct).toBeNull();
        expect(mockMetaChannel.create).toHaveBeenCalledWith(
            expect.objectContaining({
                shop_id: 'new-shop',
                meta_asset_id: 'PAGE_1',
                status: 'CONNECTED',
            }),
            { transaction: mockTransaction }
        );
    });

    test('reconnects an existing same-tenant Page in place', async () => {
        const existingChannel = makeConflict({
            id: 'existing-channel',
            shop_id: 'new-shop',
            meta_asset_id: 'PAGE_1',
            status: 'TOKEN_EXPIRED',
            connected_by_user_id: 'old-user',
            page_access_token_ct: null,
        });
        mockMetaChannel.findOne.mockResolvedValue(existingChannel);

        const result = await connect();

        expect(result).toBe(existingChannel);
        expect(mockMetaChannel.create).not.toHaveBeenCalled();
        expect(existingChannel.status).toBe('CONNECTED');
        expect(existingChannel.last_error).toBeNull();
        expect(existingChannel.disconnected_at).toBeNull();
        expect(existingChannel.connected_by_user_id).toBe('new-user');
        expect(existingChannel.save).toHaveBeenCalledWith({ transaction: mockTransaction });
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
    });

    test('findUniqueConnectedByShopAndPlatform resolves the only connected Facebook channel', async () => {
        const connected = makeCreatedChannel({ shop_id: 'shop-1' });
        mockMetaChannel.findAll.mockResolvedValue([connected]);

        await expect(metaChannelService.findUniqueConnectedByShopAndPlatform('shop-1', 'facebook'))
            .resolves.toBe(connected);

        expect(mockMetaChannel.findAll).toHaveBeenCalledWith({
            where: { shop_id: 'shop-1', platform: 'facebook', status: 'CONNECTED' },
        });
    });

    test('findConnectedById resolves only a connected channel in the requested tenant, platform, and Page', async () => {
        const connected = makeCreatedChannel({ shop_id: 'shop-1', meta_asset_id: 'PAGE_1' });
        mockMetaChannel.findByPk.mockResolvedValue(connected);

        await expect(metaChannelService.findConnectedById('new-channel', {
            shopId: 'shop-1',
            platform: 'facebook',
            metaAssetId: 'PAGE_1',
        })).resolves.toBe(connected);
    });

    test('findConnectedById fails closed without tenant and platform scope', async () => {
        await expect(metaChannelService.findConnectedById('new-channel')).resolves.toBeNull();
        expect(mockMetaChannel.findByPk).not.toHaveBeenCalled();
    });

    test.each([
        ['wrong shop', { shop_id: 'other-shop' }],
        ['disconnected', { status: 'DISCONNECTED' }],
        ['platform mismatch', { platform: 'instagram' }],
        ['asset mismatch', { meta_asset_id: 'PAGE_2' }],
    ])('findConnectedById returns null for an explicit %s row', async (_reason, overrides) => {
        mockMetaChannel.findByPk.mockResolvedValue(makeCreatedChannel(overrides));

        await expect(metaChannelService.findConnectedById('new-channel', {
            shopId: 'shop-1',
            platform: 'facebook',
            metaAssetId: 'PAGE_1',
        })).resolves.toBeNull();
    });

    test('findUniqueConnectedByShopAndPlatform returns null and warns when no channel is connected', async () => {
        mockMetaChannel.findAll.mockResolvedValue([]);

        await expect(metaChannelService.findUniqueConnectedByShopAndPlatform('shop-1', 'facebook'))
            .resolves.toBeNull();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('unique connected channel'),
            expect.objectContaining({ shopId: 'shop-1', platform: 'facebook', connectedCount: 0 }),
        );
    });

    test('findUniqueConnectedByShopAndPlatform returns null and warns when multiple channels are connected', async () => {
        mockMetaChannel.findAll.mockResolvedValue([
            makeCreatedChannel({ id: 'channel-1', shop_id: 'shop-1' }),
            makeCreatedChannel({ id: 'channel-2', shop_id: 'shop-1', meta_asset_id: 'PAGE_2' }),
        ]);

        await expect(metaChannelService.findUniqueConnectedByShopAndPlatform('shop-1', 'facebook'))
            .resolves.toBeNull();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('unique connected channel'),
            expect.objectContaining({ shopId: 'shop-1', platform: 'facebook', connectedCount: 2 }),
        );
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('page-token');
    });

    test('findByMetaAssetId resolves the only connected claim for webhook routing', async () => {
        const connected = makeCreatedChannel();
        mockMetaChannel.findAll.mockResolvedValue([connected]);

        await expect(metaChannelService.findByMetaAssetId('PAGE_1')).resolves.toBe(connected);

        expect(mockMetaChannel.findAll).toHaveBeenCalledWith({
            where: { meta_asset_id: 'PAGE_1', status: 'CONNECTED' },
        });
    });

    test('findByMetaAssetId returns null when multiple connected rows claim the same Page', async () => {
        mockMetaChannel.findAll.mockResolvedValue([
            makeCreatedChannel({ id: 'channel-1' }),
            makeCreatedChannel({ id: 'channel-2' }),
        ]);

        await expect(metaChannelService.findByMetaAssetId('PAGE_1')).resolves.toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('multiple connected channels'),
            expect.objectContaining({ metaAssetId: 'PAGE_1', connectedCount: 2 }),
        );
    });
});

describe('MetaChannelService channel settings allowlist', () => {
    test('does not persist deprecated Page AI fields while keeping supported settings', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const settingsRow = { channel_id: 'channel-1', overrides: null, update };
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockMetaChannelSettings.findOrCreate.mockResolvedValueOnce([settingsRow, false]);
        mockMetaChannelSettings.findByPk.mockResolvedValue(settingsRow);
        const transaction = { LOCK: { UPDATE: 'UPDATE' } };
        sequelize.transaction.mockImplementation(async (callback) => callback(transaction));

        await metaChannelService.updateSettings('channel-1', {
            ai_auto_reply: false,
            automation_mode: 'AUTO',
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            purpose_label: 'Sales',
        }, { shopId: 'shop-1' });

        expect(update).toHaveBeenCalledWith({
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            purpose_label: 'Sales',
        }, { transaction });
    });
});
