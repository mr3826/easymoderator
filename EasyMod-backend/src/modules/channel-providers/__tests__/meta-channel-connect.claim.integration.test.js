'use strict';

/**
 * Phase 1 P02 — Facebook Page connect/claim integrity on REAL PostgreSQL.
 *
 * Pins the isolation guards that keep one Page owned by exactly one shop, and
 * the D2 webhook-health hygiene on every path that ends a connection:
 *
 *   - upsertFromOAuth advisory-lock race (two shops, one fresh Page → exactly
 *     one winner; pg_advisory_xact_lock serializes before the cross-tenant
 *     lookup, so the per-shop unique index is never the only defense),
 *   - cross-shop claim blocks for CONNECTED / TOKEN_EXPIRED / REVOKED (409)
 *     and the only-DISCONNECTED release rule,
 *   - same-shop reconnect updates the row in place (no duplicate, ownership
 *     preserved) and duplicate connects stay idempotent,
 *   - disconnect / reconnect controller cross-shop 404 (assertChannelBelongsToShop),
 *   - D2: disconnect/revoke/release clears webhook_last_verified_at so the
 *     health grid can never show "Active" on a dead connection,
 *   - D3: subscribed_apps verification ignores foreign apps (multi-app shape),
 *   - testWebhook repairSubscription:true heals a CONNECTED channel whose
 *     subscription vanished,
 *   - revoked → reconnect → healed keeps the same channel id/owner and
 *     re-stamps verification only through the real verify path.
 *
 * Graph transport is jest-mocked (this proves our send/interpret logic, never
 * that Meta accepted anything) — same boundary as the probe contract suite.
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'claim-app-id';
process.env.META_APP_SECRET = 'claim-app-secret';
process.env.META_LOGIN_CONFIG_ID = '900000000000001';
process.env.META_GRAPH_API_VERSION = 'v22.0';

jest.mock('axios', () => ({
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
}));

const crypto = require('crypto');

const express = require('express');
const request = require('supertest');
const axios = require('axios');

const { sequelize } = require('../../../utils/database/database-setup');
const { User, UserShop } = require('../../entities');
const MetaChannel = require('../meta-channel.entity');
const MetaChannelSettings = require('../meta-channel-settings.entity');
const metaChannelRoutes = require('../meta-channel.routes');
const metaChannelService = require('../meta-channel.service');
const recovery = require('../meta-authorization-recovery.service');
const { globalErrorHandler } = require('../../../utils/AppError');
const { generateAccessToken } = require('../../../utils/jwt.util');

const { IDS, syncSchema, truncateAll, seed } = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();
const OUR_APP_ID = 'claim-app-id';

/** Realistic subscribed_apps entry for EasyModerator itself. */
const subscribedAsOurs = (...fields) => ({
    data: { data: [{ id: OUR_APP_ID, subscribed_fields: fields }] },
});
/** A third-party app's subscription — must never satisfy verification (D3). */
const subscribedAsForeign = (...fields) => ({
    data: { data: [{ id: 'foreign-app-777', subscribed_fields: fields }] },
});

const app = express();
app.use(express.json());
app.use('/api/channels/meta', metaChannelRoutes);
app.use(globalErrorHandler);

const tokenFor = (user, shopId) => generateAccessToken({
    userId: user.id,
    email: user.email,
    shopId,
    tokenVersion: user.token_version || 0,
    mfaVerified: true,
});
const auth = (user, shopId) => ({ Authorization: `Bearer ${tokenFor(user, shopId)}` });

async function makeMember(shopId, label) {
    const user = await User.create({
        email: `claim-${label}-${uuid().slice(0, 8)}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: user.id, shop_id: shopId, role: 'owner', is_active: true });
    return user;
}

let ownerA;
let ownerB;

async function prep() {
    await truncateAll();
    await seed();
    ownerA = await makeMember(IDS.shopA, 'ownerA');
    ownerB = await makeMember(IDS.shopB, 'ownerB');
}

beforeAll(async () => {
    await syncSchema();
    await prep();
}, 180000);

beforeEach(async () => {
    jest.clearAllMocks();
    await prep();
}, 120000);

afterAll(async () => {
    await truncateAll().catch(() => {});
    await sequelize.close();
});

describe('upsertFromOAuth cross-shop claims (real PostgreSQL)', () => {
    test('a CONNECTED cross-shop claim is a 409 and creates no row', async () => {
        await expect(metaChannelService.upsertFromOAuth({
            shopId: IDS.shopB,
            userId: ownerB.id,
            platform: 'facebook',
            metaAssetId: IDS.pageA,
            displayName: 'Stolen Page',
            pageAccessToken: 'tok-should-not-persist',
        })).rejects.toMatchObject({ status: 409, code: 'META_ASSET_ALREADY_CONNECTED' });

        expect(await MetaChannel.count({ where: { meta_asset_id: IDS.pageA } })).toBe(1);
        const a = await MetaChannel.findByPk(IDS.channelA);
        expect(a.status).toBe('CONNECTED');
        expect(a.shop_id).toBe(IDS.shopA);
    });

    test.each(['TOKEN_EXPIRED', 'REVOKED', 'ERROR'])(
        'a %s cross-shop claim still blocks takeover — only DISCONNECTED releases',
        async (status) => {
            await MetaChannel.update({ status }, { where: { id: IDS.channelA } });

            await expect(metaChannelService.upsertFromOAuth({
                shopId: IDS.shopB,
                userId: ownerB.id,
                platform: 'facebook',
                metaAssetId: IDS.pageA,
                displayName: 'Stolen Page',
                pageAccessToken: 'tok-should-not-persist',
            })).rejects.toMatchObject({ status: 409, code: 'META_ASSET_ALREADY_CONNECTED' });

            expect(await MetaChannel.count({ where: { meta_asset_id: IDS.pageA } })).toBe(1);
            const a = await MetaChannel.findByPk(IDS.channelA);
            expect(a.status).toBe(status);
            expect(a.shop_id).toBe(IDS.shopA);
        },
    );

    test('a DISCONNECTED claim releases: new owner connects, old row keeps history with webhook state cleared (D2)', async () => {
        await MetaChannel.update({
            status: 'DISCONNECTED',
            webhook_last_verified_at: new Date(),
            webhook_subscribed_fields: ['messages'],
        }, { where: { id: IDS.channelA } });

        const fresh = await metaChannelService.upsertFromOAuth({
            shopId: IDS.shopB,
            userId: ownerB.id,
            platform: 'facebook',
            metaAssetId: IDS.pageA,
            displayName: 'Page A under B',
            pageAccessToken: 'tok-b',
        });

        expect(fresh.shop_id).toBe(IDS.shopB);
        expect(fresh.status).toBe('CONNECTED');

        const old = await MetaChannel.findByPk(IDS.channelA);
        expect(old.status).toBe('DISCONNECTED');
        expect(old.page_access_token_ct).toBeNull();
        expect(old.webhook_last_verified_at).toBeNull();
        expect(old.webhook_subscribed_fields).toEqual([]);
    });

    test('same-shop reconnect updates the row in place — no duplicate, ownership preserved', async () => {
        const first = await metaChannelService.upsertFromOAuth({
            shopId: IDS.shopA,
            userId: ownerA.id,
            platform: 'facebook',
            metaAssetId: IDS.pageA,
            displayName: 'Page A',
            pageAccessToken: 'tok-1',
        });
        const second = await metaChannelService.upsertFromOAuth({
            shopId: IDS.shopA,
            userId: ownerA.id,
            platform: 'facebook',
            metaAssetId: IDS.pageA,
            displayName: 'Page A renamed',
            pageAccessToken: 'tok-2',
        });

        expect(first.id).toBe(IDS.channelA);
        expect(second.id).toBe(IDS.channelA);
        expect(await MetaChannel.count({ where: { meta_asset_id: IDS.pageA } })).toBe(1);
        expect(second.status).toBe('CONNECTED');
        expect(second.shop_id).toBe(IDS.shopA);
    });

    test('duplicate connects stay idempotent — one channel row and one settings row', async () => {
        for (let i = 0; i < 3; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await metaChannelService.upsertFromOAuth({
                shopId: IDS.shopA,
                userId: ownerA.id,
                platform: 'facebook',
                metaAssetId: IDS.pageA,
                displayName: 'Page A',
                pageAccessToken: 'tok',
            });
        }
        expect(await MetaChannel.count({ where: { meta_asset_id: IDS.pageA } })).toBe(1);
        expect(await MetaChannelSettings.count({ where: { channel_id: IDS.channelA } })).toBe(1);
    });

    test('concurrent cross-shop connects serialize on the advisory lock — exactly one wins', async () => {
        const page = '100000000000099';
        const connect = (shopId, userId, name) => metaChannelService.upsertFromOAuth({
            shopId,
            userId,
            platform: 'facebook',
            metaAssetId: page,
            displayName: name,
            pageAccessToken: `tok-${shopId}`,
        });

        const results = await Promise.allSettled([
            connect(IDS.shopA, ownerA.id, 'Race A'),
            connect(IDS.shopB, ownerB.id, 'Race B'),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toMatchObject({
            status: 409,
            code: 'META_ASSET_ALREADY_CONNECTED',
        });

        const rows = await MetaChannel.findAll({ where: { meta_asset_id: page } });
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe('CONNECTED');
        expect([IDS.shopA, IDS.shopB]).toContain(String(rows[0].shop_id));
    });
});

describe('channel lifecycle routes — cross-shop 404 and disconnect hygiene (real PostgreSQL)', () => {
    test('disconnecting another shop channel is a 404 with zero mutation', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelB}/disconnect`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(404);
        const b = await MetaChannel.findByPk(IDS.channelB);
        expect(b.status).toBe('CONNECTED');
        expect(b.page_access_token_ct).toBeTruthy();
        expect(b.disconnected_at).toBeNull();
        // The 404 never reached Meta for someone else's Page.
        expect(axios.delete).not.toHaveBeenCalled();
    });

    test('reconnecting another shop channel is a 404 and never issues an OAuth state', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelB}/reconnect`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(404);
        expect(res.body.data?.redirectUrl).toBeUndefined();
    });

    test("own-shop disconnect clears the webhook verification stamp (D2 via HTTP)", async () => {
        await MetaChannel.update({
            webhook_last_verified_at: new Date(),
            webhook_subscribed_fields: ['messages'],
        }, { where: { id: IDS.channelA } });

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/disconnect`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('DISCONNECTED');
        expect(res.body.data.webhookLastVerifiedAt).toBeNull();

        const row = await MetaChannel.findByPk(IDS.channelA);
        expect(row.page_access_token_ct).toBeNull();
        expect(row.webhook_last_verified_at).toBeNull();
        expect(row.webhook_subscribed_fields).toEqual([]);
    });
});

describe('test-webhook verification + repair (D2/D3) and the revoke→reconnect→heal cycle', () => {
    test('a foreign-only subscription fails closed and is not confirmed (D3 end-to-end)', async () => {
        await MetaChannel.update({ webhook_last_verified_at: null }, { where: { id: IDS.channelA } });
        axios.get.mockResolvedValue(subscribedAsForeign('messages'));

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/test-webhook`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data.subscription).toMatchObject({ ok: false, repaired: false });
        expect(res.body.data.ping.ok).toBe(false);

        const row = await MetaChannel.findByPk(IDS.channelA);
        expect(row.webhook_last_verified_at).toBeNull();
        // Without repair requested there is never a subscription write.
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('repairSubscription:true re-subscribes a vanished OUR-app subscription and re-stamps verification', async () => {
        await MetaChannel.update({ webhook_last_verified_at: null }, { where: { id: IDS.channelA } });
        // First verify: only a foreign app holds `messages` (D3 shape — under
        // the old flatMap code this would have "verified"). Then repair:
        // subscribe, re-verify sees OUR app entry, confirm stamps the row.
        axios.get
            .mockResolvedValueOnce(subscribedAsForeign('messages'))
            .mockResolvedValueOnce(subscribedAsOurs('messages'));
        axios.post.mockResolvedValueOnce({ data: { success: true } });

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/test-webhook`)
            .set(auth(ownerA, IDS.shopA))
            .send({ repairSubscription: true });

        expect(res.status).toBe(200);
        expect(res.body.data.subscription).toMatchObject({ ok: true, repaired: true });
        expect(axios.post).toHaveBeenCalledTimes(1);

        const row = await MetaChannel.findByPk(IDS.channelA);
        expect(row.status).toBe('CONNECTED');
        expect(row.webhook_last_verified_at).toBeTruthy();
        expect(row.webhook_subscribed_fields).toEqual(['messages']);
    });

    test('revoked → reconnect → healed keeps the same channel id/owner; stamp cleared on revoke, re-set only via verify', async () => {
        const before = await MetaChannel.findByPk(IDS.channelA);
        expect(before.status).toBe('CONNECTED');
        await before.update({ webhook_last_verified_at: new Date(), webhook_subscribed_fields: ['messages'] });

        // The Meta deauthorize path (same disableChannel the callback uses).
        await recovery._private.disableChannel(before, {
            status: 'REVOKED',
            reason: 'meta_deauthorized_reconnect_required',
            auditAction: 'meta_channel_deauthorized',
            strictAudit: false,
        });

        const revoked = await MetaChannel.findByPk(IDS.channelA);
        expect(revoked.status).toBe('REVOKED');
        expect(revoked.page_access_token_ct).toBeNull();
        // D2: revoke must not leave a stamp the health grid would render "Active".
        expect(revoked.webhook_last_verified_at).toBeNull();
        expect(revoked.webhook_subscribed_fields).toEqual([]);

        // Merchant completes a fresh OAuth for the same Page (same shop).
        const reconnected = await metaChannelService.upsertFromOAuth({
            shopId: IDS.shopA,
            userId: ownerA.id,
            platform: 'facebook',
            metaAssetId: IDS.pageA,
            displayName: 'Page A',
            pageAccessToken: 'tok-after-reconnect',
        });
        expect(reconnected.id).toBe(IDS.channelA);
        expect(String(reconnected.shop_id)).toBe(IDS.shopA);
        expect(reconnected.status).toBe('CONNECTED');
        // Reconnection alone proves nothing about the webhook subscription.
        expect(reconnected.webhook_last_verified_at).toBeNull();

        // Heal: verification sees OUR app subscribed for `messages` → re-stamp.
        axios.get.mockResolvedValueOnce(subscribedAsOurs('messages'));
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/test-webhook`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data.subscription.ok).toBe(true);

        const healed = await MetaChannel.findByPk(IDS.channelA);
        expect(healed.id).toBe(IDS.channelA);
        expect(String(healed.shop_id)).toBe(IDS.shopA);
        expect(healed.status).toBe('CONNECTED');
        expect(healed.webhook_last_verified_at).toBeTruthy();
    });
});
