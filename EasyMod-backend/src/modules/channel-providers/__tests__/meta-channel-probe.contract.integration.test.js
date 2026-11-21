'use strict';

/**
 * WP-02 — probe-interaction-fields contract on the REAL auth chain.
 *
 * r3-messenger-ux.test.js proves the controller/provider branching with the
 * middlewares mocked away; MetaMessengerProvider.test.js proves every Graph
 * code path of probeInteractionWebhookFields. This file closes the remaining
 * gap: the production authorization chain itself, against real PostgreSQL —
 *
 *   global CSRF (skipped only because NODE_ENV=test — pinned separately in
 *   src/middleware/__tests__/csrf-middleware.test.js, which proves the probe
 *   path is NOT in the skip list)
 *     → authenticate (JWT)
 *     → verifyShopAccess (JWT shopId + live UserShop membership; ANY active
 *        role including staff; NO requireOwner; NO platform-admin bypass)
 *     → channelIdParam validation
 *     → controller probe (flag gate → ownership 404 → platform 400 → provider)
 *
 * The Graph HTTP transport is captured via jest.mock('axios'): this proves
 * what EasyModerator SENDS and how it reacts — never that Meta accepted a
 * subscription (scripts/p0-acceptance-matrix.js records that boundary as
 * LIVE_PROVIDER_UNVERIFIED).
 */

process.env.NODE_ENV = 'test';
process.env.META_APP_ID = 'probe-app-id';
process.env.META_APP_SECRET = 'probe-app-secret';
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
const { User, UserShop, ShopPilotFeatures } = require('../../entities');
const MetaChannel = require('../meta-channel.entity');
const metaChannelRoutes = require('../meta-channel.routes');
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

async function makeMember(shopId, role, label, extra = {}) {
    const user = await User.create({
        email: `probe-${label}-${uuid().slice(0, 8)}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
        ...extra,
    });
    if (shopId) {
        await UserShop.create({ user_id: user.id, shop_id: shopId, role, is_active: true });
    }
    return user;
}

async function setFlag(shopId, value) {
    const existing = await ShopPilotFeatures.findByPk(shopId);
    if (existing) await existing.update({ interaction_choices: value });
    else await ShopPilotFeatures.create({ shop_id: shopId, interaction_choices: value });
}

// Real subscribed_apps entries carry the subscribing app's `id`; verification
// matches our app (META_APP_ID below) and ignores foreign apps' fields.
const subscribedGet = (...fields) => ({ data: { data: [{ id: 'probe-app-id', subscribed_fields: fields }] } });

let ownerA;
let staffA;
let ownerB;
let strandedAdmin;

beforeAll(async () => {
    await syncSchema();
    await truncateAll();
    await seed();
    ownerA = await makeMember(IDS.shopA, 'owner', 'ownerA');
    staffA = await makeMember(IDS.shopA, 'staff', 'staffA');
    ownerB = await makeMember(IDS.shopB, 'owner', 'ownerB');
    // Platform admin WITHOUT a membership row for shop A — the perimeter rule
    // says Growth/support roles act on their own surface only, never merchant
    // channel data.
    strandedAdmin = await makeMember(null, null, 'platformadmin', { platform_role: 'SUPPORT_ADMIN' });
}, 120000);

beforeEach(async () => {
    jest.clearAllMocks();
    await setFlag(IDS.shopA, true);
    await setFlag(IDS.shopB, false);
});

afterAll(async () => {
    await truncateAll().catch(() => {});
    await sequelize.close();
});

describe('probe-interaction-fields — real authenticate + verifyShopAccess chain', () => {
    test('staff (any active role) may probe their own shop and get the provider verdict', async () => {
        axios.get.mockResolvedValueOnce(subscribedGet('messages', 'messaging_postbacks', 'messaging_referrals'));

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/probe-interaction-fields`)
            .set(auth(staffA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            data: {
                channelId: IDS.channelA,
                platform: 'facebook',
                ok: true,
                code: 'ALREADY_SUBSCRIBED',
                coreMessagesIntact: true,
                addedFields: [],
            },
        });
        // The Graph call was made with the DECRYPTED Page token + appsecret_proof,
        // and neither appears anywhere in the response body.
        expect(axios.get).toHaveBeenCalledTimes(1);
        const params = axios.get.mock.calls[0][1].params;
        expect(params.access_token).toBeTruthy();
        expect(params.appsecret_proof).toEqual(expect.any(String));
        expect(JSON.stringify(res.body)).not.toContain(params.access_token);
    });

    test('SUBSCRIBED adds postbacks/referrals unioned with core messages and reports addedFields', async () => {
        axios.get
            .mockResolvedValueOnce(subscribedGet('messages'))
            .mockResolvedValueOnce(subscribedGet('messages', 'messaging_postbacks', 'messaging_referrals'));
        axios.post.mockResolvedValueOnce({ data: { success: true } });

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/probe-interaction-fields`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            ok: true, code: 'SUBSCRIBED', coreMessagesIntact: true,
        });
        expect(res.body.data.addedFields).toEqual(['messaging_postbacks', 'messaging_referrals']);
        // Core ['messages'] is ALWAYS part of the union — the probe may widen,
        // never replace, the approved subscription.
        expect(axios.post.mock.calls[0][2].params.subscribed_fields)
            .toBe('messages,messaging_postbacks,messaging_referrals');
    });

    test('a cross-shop channel id is a 404 with zero existence or token leakage', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelB}/probe-interaction-fields`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('Page B');
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a platform admin without live shop membership is denied — no bypass anywhere in the chain', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/probe-interaction-fields`)
            .set(auth(strandedAdmin, IDS.shopA))
            .send({});

        expect(res.status).toBe(403);
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('the feature flag closes the route before any Graph traffic (real ShopPilotFeatures row)', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelB}/probe-interaction-fields`)
            .set(auth(ownerB, IDS.shopB))
            .send({});

        expect(res.status).toBe(409);
        expect(res.body.code || res.body.error?.code).toBe('FEATURE_DISABLED');
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a non-UUID channel id is rejected by param validation before controllers', async () => {
        const res = await request(app)
            .post('/api/channels/meta/not-a-uuid/probe-interaction-fields')
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(400);
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('no Authorization at all never reaches the probe controller', async () => {
        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/probe-interaction-fields`)
            .send({});

        expect([401, 403]).toContain(res.status);
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('EXTERNALLY_BLOCKED from the route keeps core `messages` true and leaks no token', async () => {
        axios.get.mockResolvedValue(subscribedGet('messages'));
        axios.post.mockRejectedValueOnce({
            response: { status: 403, data: { error: { code: 200, error_subcode: 1545041, message: 'Permissions error' } } },
        });

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/probe-interaction-fields`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            ok: false,
            code: 'EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS',
            coreMessagesIntact: true,
            blockedFields: ['messaging_postbacks', 'messaging_referrals'],
            metaCode: 200,
        });
        expect(JSON.stringify(res.body)).not.toContain('EAAE2E');
        // The refusal to widen never disturbs the stored core subscription.
        const channel = await MetaChannel.findByPk(IDS.channelA);
        expect(channel.webhook_subscribed_fields).toEqual(['messages']);
    });

    test('read-back via test-webhook reports the widened fields and persists verification', async () => {
        axios.get.mockResolvedValueOnce(subscribedGet('messages', 'messaging_postbacks', 'messaging_referrals'));

        const res = await request(app)
            .post(`/api/channels/meta/${IDS.channelA}/test-webhook`)
            .set(auth(ownerA, IDS.shopA))
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.data.subscription).toMatchObject({
            ok: true,
            fields: ['messages', 'messaging_postbacks', 'messaging_referrals'],
            repaired: false,
        });
        // requiredFields stays the CORE contract — a probe may never rewrite it.
        expect(res.body.data.subscription.requiredFields).toEqual(['messages']);

        const channel = await MetaChannel.findByPk(IDS.channelA);
        expect(channel.webhook_subscribed_fields).toEqual(
            expect.arrayContaining(['messages', 'messaging_postbacks', 'messaging_referrals']),
        );
        expect(channel.webhook_last_verified_at).toBeTruthy();
    });
});
