'use strict';

/**
 * ADR-0013 §9 + Verification Contract 5 — channel-settings tenant isolation on
 * real PostgreSQL.
 *
 * A shop-B principal must never read or write shop-A channel configuration, and
 * the same denial must hold at every layer behind the controller:
 *   - HTTP controller (list / GET / PATCH) — verified via the real router,
 *   - service (getSettings / updateSettings) — defense-in-depth shop predicate,
 *   - resolver loader (loadEffectiveChannelAutomation) — tenant assertion.
 *
 * The JWT `shopId` claim is the only tenant selector (verifyShopAccess), so the
 * tests also pin that an X-Shop-ID header cannot widen scope.
 */

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    Tenant, Shop, User, UserShop,
} = require('../../entities');
const MetaChannel = require('../meta-channel.entity');
const MetaChannelSettings = require('../meta-channel-settings.entity');
const metaChannelRoutes = require('../meta-channel.routes');
const metaChannelService = require('../meta-channel.service');
const { loadEffectiveChannelAutomation } = require('../channel-automation.resolver');
const { generateAccessToken } = require('../../../utils/jwt.util');
const { globalErrorHandler } = require('../../../utils/AppError');
const {
    IDS, syncSchema, truncateAll, seed,
} = require('../../../../tests/meta-e2e/fixtures');

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

async function makeMember(shopId, role, label) {
    const suffix = uuid().slice(0, 8);
    const user = await User.create({
        email: `tenant-${label}-${suffix}@example.test`,
        password: 'unused-test-hash',
        full_name: `${label} user`,
        settings: {},
        token_version: 0,
    });
    await UserShop.create({
        user_id: user.id, shop_id: shopId, role, is_active: true,
    });
    return user;
}

/** Point the business default at AUTO without going through the settings API. */
async function setBusinessMode(shopId, mode) {
    const shop = await Shop.findByPk(shopId);
    const settings = shop.settings && typeof shop.settings === 'object' ? shop.settings : {};
    const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
    await shop.update({ settings: { ...settings, ai: { ...ai, automation_mode: mode } } });
}

const auth = (user, shopId) => ({
    Authorization: `Bearer ${tokenFor(user, shopId)}`,
});

let ownerA;
let staffA;
let ownerB;

beforeAll(async () => {
    await syncSchema();
    await truncateAll();
    await seed();
    ownerA = await makeMember(IDS.shopA, 'owner', 'ownerA');
    staffA = await makeMember(IDS.shopA, 'staff', 'staffA');
    ownerB = await makeMember(IDS.shopB, 'owner', 'ownerB');
});

afterAll(async () => {
    // Integration suites share one disposable database (maxWorkers=1) and each
    // leaves it empty for the next file — see message-worker.action-gate.
    await truncateAll().catch(() => {});
    await sequelize.close();
});

beforeEach(async () => {
    await MetaChannelSettings.destroy({ where: {} });
    await setBusinessMode(IDS.shopA, 'AUTO');
    await setBusinessMode(IDS.shopB, 'AUTO');
});

describe('channel settings — HTTP tenant perimeter', () => {
    test('list returns only the caller shop channels, with effective fields', async () => {
        const response = await request(app)
            .get('/api/channels/meta')
            .set(auth(ownerA, IDS.shopA));

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        const ids = response.body.data.map((channel) => channel.id);
        expect(ids).toEqual(expect.arrayContaining([IDS.channelA, IDS.channelA2]));
        expect(ids).not.toContain(IDS.channelB);
        for (const channel of response.body.data) {
            expect(channel).toEqual(expect.objectContaining({
                effective_mode: expect.any(String),
                mode_source: expect.any(String),
                override_count: expect.any(Number),
                emergency_stop: expect.objectContaining({ active: false }),
                billing_ai_active: expect.any(Boolean),
            }));
        }
    });

    test('a cross-shop channel id is denied and leaks no settings', async () => {
        const response = await request(app)
            .get(`/api/channels/meta/${IDS.channelB}/settings`)
            .set(auth(ownerA, IDS.shopA));

        expect([403, 404]).toContain(response.status);
        expect(response.body.data).toBeUndefined();
        // No side effect: the B row was not created by the denied read.
        expect(await MetaChannelSettings.findByPk(IDS.channelB)).toBeNull();
    });

    test('a cross-shop PATCH is denied before mutation', async () => {
        const before = await MetaChannelSettings.findByPk(IDS.channelB);

        const response = await request(app)
            .patch(`/api/channels/meta/${IDS.channelB}/settings`)
            .set(auth(ownerA, IDS.shopA))
            .send({ overrides: { automation_mode: 'MANUAL' } });

        expect([403, 404]).toContain(response.status);
        const after = await MetaChannelSettings.findByPk(IDS.channelB);
        expect(before).toBeNull();
        expect(after).toBeNull();
    });

    test('an X-Shop-ID header cannot widen scope', async () => {
        const response = await request(app)
            .get(`/api/channels/meta/${IDS.channelB}/settings`)
            .set(auth(ownerA, IDS.shopA))
            .set('X-Shop-ID', IDS.shopB);

        expect([403, 404]).toContain(response.status);
    });

    test('staff cannot write channel settings (owner-only)', async () => {
        const response = await request(app)
            .patch(`/api/channels/meta/${IDS.channelA}/settings`)
            .set(auth(staffA, IDS.shopA))
            .send({ overrides: { automation_mode: 'MANUAL' } });

        expect(response.status).toBe(403);
        expect(await MetaChannelSettings.findByPk(IDS.channelA)).toBeNull();
    });

    test('owner PATCH returns the additive effective payload for their own channel', async () => {
        const response = await request(app)
            .patch(`/api/channels/meta/${IDS.channelA}/settings`)
            .set(auth(ownerA, IDS.shopA))
            .send({ overrides: { confidence_threshold: 90 } });

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expect.objectContaining({
            overrides: { confidence_threshold: 90 },
            effective: expect.objectContaining({ confidence_threshold: 90 }),
            mode_source: expect.any(String),
            warnings: expect.any(Array),
            emergency_stop: expect.objectContaining({ active: false }),
            billing_ai_active: expect.any(Boolean),
            deprecated_fields: expect.arrayContaining([
                'confidenceThresholdSend', 'confidenceThresholdSuggest',
            ]),
        }));
    });
});

describe('channel settings — service and loader tenant assertions', () => {
    test('service getSettings asserts the shop predicate', async () => {
        await expect(
            metaChannelService.getSettings(IDS.channelB, { shopId: IDS.shopA }),
        ).rejects.toMatchObject({ status: 404 });
        expect(await MetaChannelSettings.findByPk(IDS.channelB)).toBeNull();
    });

    test('service updateSettings asserts the shop predicate before any write', async () => {
        await expect(
            metaChannelService.updateSettings(
                IDS.channelB,
                { overrides: { automation_mode: 'MANUAL' } },
                { shopId: IDS.shopA, userId: ownerA.id },
            ),
        ).rejects.toMatchObject({ status: 404 });
        expect(await MetaChannelSettings.findByPk(IDS.channelB)).toBeNull();
    });

    test('service returns a cross-shop 404 even for the correct channel id of another shop', async () => {
        // The channel exists (B) but is asserted against A.
        expect(await MetaChannel.findByPk(IDS.channelB)).not.toBeNull();
        await expect(
            metaChannelService.getSettings(IDS.channelB, { shopId: IDS.shopA }),
        ).rejects.toMatchObject({ status: 404 });
    });

    test('the resolver loader returns null for a cross-shop channel', async () => {
        expect(await loadEffectiveChannelAutomation(IDS.shopA, IDS.channelB)).toBeNull();
        expect(await loadEffectiveChannelAutomation(IDS.shopB, IDS.channelA)).toBeNull();
    });

    test('the resolver loader resolves the owning shop and reports tenant-scoped state', async () => {
        // The loader reads an existing row (it never INSERTs outside Guard 4).
        await MetaChannelSettings.findOrCreate({ where: { channel_id: IDS.channelA } });
        const state = await loadEffectiveChannelAutomation(IDS.shopA, IDS.channelA);
        expect(state).not.toBeNull();
        expect(state.mode).toBe('AUTO');
        expect(state.modeSource).toBe('business_default');
        expect(state.billingAiActive).toBe(true);
    });

    test('an overrides write on A never touches B', async () => {
        await metaChannelService.updateSettings(
            IDS.channelA,
            { overrides: { automation_mode: 'DRAFT' } },
            { shopId: IDS.shopA, userId: ownerA.id },
        );
        const a = await MetaChannelSettings.findByPk(IDS.channelA);
        expect(a.overrides).toEqual({ automation_mode: 'DRAFT' });
        expect(await MetaChannelSettings.findByPk(IDS.channelB)).toBeNull();

        // Owner B writes their own channel and A is untouched.
        await metaChannelService.updateSettings(
            IDS.channelB,
            { overrides: { automation_mode: 'AUTO' } },
            { shopId: IDS.shopB, userId: ownerB.id },
        );
        const aAfter = await MetaChannelSettings.findByPk(IDS.channelA);
        const bAfter = await MetaChannelSettings.findByPk(IDS.channelB);
        expect(aAfter.overrides).toEqual({ automation_mode: 'DRAFT' });
        expect(bAfter.overrides).toEqual({ automation_mode: 'AUTO' });
    });
});