'use strict';

/**
 * Phase 1 P02 — OAuth state single-use + tenant binding on REAL Redis.
 *
 * The unit suite proves the Lua script and the memory-fallback semantics with
 * mocks; this file proves the two properties that only a shared Redis can show:
 *
 *   - a state can be consumed exactly ONCE even when several callbacks race
 *     (the atomic GET+DEL under concurrent replays of a leaked URL), and
 *   - a consumed-or-cross-bound state never reaches the Graph exchange —
 *     the tenant binding (initiating user + shop) is a 403 at the HTTP edge
 *     behind the real authenticate + verifyShopAccess chain, and the state is
 *     already gone for the legitimate initiator afterwards (400 on replay).
 *
 * TTL wiring is pinned here too (900 s window, and a lapsed key reads back
 * null through the store).
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'state-app-id';
process.env.META_APP_SECRET = 'state-app-secret';
process.env.META_LOGIN_CONFIG_ID = '900000000000002';
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

const { cacheRedis } = require('../../../config/redis');
const { sequelize } = require('../../../utils/database/database-setup');
const { User, UserShop } = require('../../entities');
const metaChannelRoutes = require('../meta-channel.routes');
const oauthStateStore = require('../oauth-state.store');
const oauthService = require('../meta-oauth.service');
const { globalErrorHandler } = require('../../../utils/AppError');
const { generateAccessToken } = require('../../../utils/jwt.util');

const { IDS, syncSchema, truncateAll, seed } = require('../../../../tests/meta-e2e/fixtures');

const uuid = () => crypto.randomUUID();

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

async function makeMember(shopId, role, label) {
    const user = await User.create({
        email: `oauthstate-${label}-${uuid().slice(0, 8)}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({ user_id: user.id, shop_id: shopId, role, is_active: true });
    return user;
}

let ownerA;
let staffA;
let ownerB;

beforeAll(async () => {
    // This suite is meaningless against the dev memory fallback — fail loudly.
    expect(cacheRedis._isMemoryFallback).not.toBe(true);
    await expect(cacheRedis.ping()).resolves.toBe('PONG');
    await syncSchema();
    await truncateAll();
    await seed();
    ownerA = await makeMember(IDS.shopA, 'owner', 'ownerA');
    staffA = await makeMember(IDS.shopA, 'staff', 'staffA');
    ownerB = await makeMember(IDS.shopB, 'owner', 'ownerB');
}, 180000);

afterAll(async () => {
    await truncateAll().catch(() => {});
    await sequelize.close().catch(() => {});
    await cacheRedis.quit().catch(() => {});
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('oauth-state.store on real Redis', () => {
    test('concurrent take() consumes the state exactly once (replay under race)', async () => {
        const key = `race-${uuid()}`;
        await oauthStateStore.put(key, { userId: ownerA.id, shopId: IDS.shopA, platform: 'facebook' });

        const takes = await Promise.all([
            oauthStateStore.take(key),
            oauthStateStore.take(key),
            oauthStateStore.take(key),
        ]);
        const winners = takes.filter((t) => t !== null);

        expect(winners.length).toBe(1);
        expect(winners[0]).toMatchObject({ shopId: IDS.shopA });
        expect(await oauthStateStore.take(key)).toBeNull();
        expect(await oauthStateStore.get(key)).toBeNull();
    });

    test('put stores the state inside the 15-minute single-use window', async () => {
        const key = `ttl-${uuid()}`;
        await oauthStateStore.put(key, { shopId: IDS.shopA });

        const ttl = await cacheRedis.ttl(`oauth:state:${key}`);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(oauthStateStore.TTL_SECONDS);

        await cacheRedis.del(`oauth:state:${key}`);
    });

    test('a lapsed state reads back null through take()', async () => {
        const stateKey = `expired-${uuid()}`;
        await cacheRedis.set(`oauth:state:${stateKey}`, JSON.stringify({ shopId: IDS.shopA }), 'EX', 1);
        await delay(1200);

        expect(await oauthStateStore.take(stateKey)).toBeNull();
        // The actual expired key is gone from Redis too.
        expect(await cacheRedis.exists(`oauth:state:${stateKey}`)).toBe(0);
    });
});

describe('OAuth callback — tenant binding at the HTTP edge (real auth + real Redis)', () => {
    test('a different shop cannot consume shop A state, and the state dies with the attempt', async () => {
        const { state } = await oauthService.initiateOAuth(ownerA.id, IDS.shopA, 'facebook');
        expect(state).toMatch(/^facebook:/);

        const stolen = await request(app)
            .post('/api/channels/meta/oauth/callback')
            .set(auth(ownerB, IDS.shopB))
            .send({ code: 'a-code-value-123456', state });

        // Binding failure happens BEFORE any Graph exchange.
        expect(stolen.status).toBe(403);
        expect(JSON.stringify(stolen.body)).toContain('does not match');
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();

        // Single-use holds even against the legitimate initiator: the 403
        // attempt already consumed the state, so the replay is "invalid or
        // expired", not a second binding check.
        const replay = await request(app)
            .post('/api/channels/meta/oauth/callback')
            .set(auth(ownerA, IDS.shopA))
            .send({ code: 'a-code-value-123456', state });
        expect(replay.status).toBe(400);
    });

    test('a different user inside the same shop cannot consume the state either', async () => {
        const { state } = await oauthService.initiateOAuth(ownerA.id, IDS.shopA, 'facebook');

        const res = await request(app)
            .post('/api/channels/meta/oauth/callback')
            .set(auth(staffA, IDS.shopA))
            .send({ code: 'a-code-value-123456', state });

        expect(res.status).toBe(403);
        expect(axios.get).not.toHaveBeenCalled();
        expect(await oauthStateStore.take(state)).toBeNull();
    });
});
