'use strict';

/**
 * Business & FAQ Settings redesign (A5) — /shop/business-policies API lane.
 *
 * Contracts pinned here (00_A0_DATA_CONTRACT + bf1-a5-contracts):
 *  - GET is a MEMBER read of the TOKEN shop only (confused-deputy: the row is
 *    always the authenticated shop's, never a body/URL-selected shop);
 *    honest absence: a shop that never stated policies gets {} — no defaults,
 *    no empty skeletons, no 'not_offered' invention.
 *  - PUT is OWNER (verifyShopAccess + requireOwner, mirroring business-info).
 *  - Per-policy PARTIAL merge: absent kind untouched, absent field untouched,
 *    explicit null clears; unknown kinds/fields REJECTED (400); stance enum,
 *    period_days 0..365 (returns/exchange), warranty duration ≤120, all text
 *    fields ≤500.
 *  - Unrelated settings domains and the RTO consent block survive the merge.
 *  - Side effects: settings caches invalidated; the business-info knowledge
 *    vector re-sync is BEST-EFFORT — its failure must never fail the save.
 *  - Policies are INFORMATIONAL ONLY (the source-scan lane below).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';

const SHOP_ID = 'dddddddd-4444-4444-8444-dddddddddddd';

jest.mock('../../../config/redis', () => ({
    cacheRedis: null, sessionRedis: null, rateLimitRedis: null, legacyRedis: null,
}));
jest.mock('../../auth/session-invalidation.service', () => ({
    invalidateUserSessions: jest.fn().mockResolvedValue(1),
}));
const redisStore = {};
jest.mock('../../../utils/redis-client', () => ({
    get: jest.fn(async (k) => redisStore[k] ?? null),
    set: jest.fn(async (k, v) => { redisStore[k] = v; }),
    del: jest.fn(async (k) => { delete redisStore[k]; }),
    setex: jest.fn(async (k, _ttl, v) => { redisStore[k] = v; }),
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// Spy target for the invalidation contract (the real module keeps its shape).
jest.mock('../../../utils/shop-settings-cache', () => {
    const actual = jest.requireActual('../../../utils/shop-settings-cache');
    return { ...actual, invalidateShopSettingsCaches: jest.fn(async () => {}) };
});

// The knowledge side is exercised by its own suite; here it must be observed
// as a best-effort consumer of the saved policies.
jest.mock('../../knowledge/knowledge.service', () => ({
    getKnowledge: jest.fn(async () => ({ businessInfo: {} })),
    updateBusinessInfo: jest.fn(async () => ({})),
    syncBusinessInfoRagIndex: jest.fn(async () => {}),
}));

jest.mock('../../entities', () => ({
    User: { findByPk: jest.fn(), update: jest.fn() },
    Shop: {
        findByPk: jest.fn(), create: jest.fn(), destroy: jest.fn(), findAll: jest.fn(),
        sequelize: { transaction: jest.fn(async (cb) => cb({ commit: jest.fn(), rollback: jest.fn() })) },
    },
    UserShop: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn() },
    DeliveryIntegration: { findAll: jest.fn() },
    MetaChannel: { findAll: jest.fn() },
    PolicyDecision: { findAll: jest.fn() },
    Subscription: { create: jest.fn() },
    Tenant: { findByPk: jest.fn() },
    GrowthOsUserRole: { findOne: jest.fn() },
}));

// Real database-setup is never touched (entity layer mocked); the router's
// entity imports call sequelize.define at module load.
jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        define: jest.fn(() => ({
            findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(() => Promise.resolve([])),
            create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn(),
            belongsTo: jest.fn(), hasMany: jest.fn(), hasOne: jest.fn(), belongsToMany: jest.fn(),
            addScope: jest.fn(), scope: jest.fn(function () { return this; }),
        })),
        transaction: jest.fn(async (cb) => cb({ commit: jest.fn(), rollback: jest.fn() })),
        authenticate: jest.fn(() => Promise.resolve()),
        sync: jest.fn(() => Promise.resolve()),
        literal: jest.fn((s) => s),
        query: jest.fn(() => Promise.resolve([[]])),
        getDialect: jest.fn(() => 'postgres'),
    },
}));

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: (req, _res, next) => {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ')) {
            return _res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        req.user = { userId: 'user-1', shopId: SHOP_ID };
        next();
    },
}));

const request = require('supertest');
const express = require('express');

let app;
let shopRow;

const baseSettings = () => ({
    businessInfo: { shopName: 'Policy Shop', address: '123 Main St', phone: '01700' },
    ai: { automation_mode: 'AUTO', confidence_threshold: 80 },
    documents: [{ id: 'doc-1', name: 'guide.txt' }],
    brandingRules: { tone: 'friendly' },
    rto_network: { contribute: false, enforce: true },
    policies: {
        returns: { stance: 'offered', period_days: 7, details: 'unused only', exclusions: 'innerwear' },
        exchange: { stance: 'not_offered' },
    },
});

const makeShopRow = (settings) => {
    const row = {
        id: SHOP_ID,
        shop_name: 'Policy Shop',
        name: 'Policy Shop',
        settings,
        toJSON() {
            return { id: this.id, shop_name: this.shop_name, name: this.name, settings: this.settings };
        },
        update: jest.fn(async (fields) => {
            if (fields && fields.settings !== undefined) {
                // Round-trip JSON like the real JSONB column: cleared fields
                // (undefined after the merge) disappear from the persisted row.
                row.settings = JSON.parse(JSON.stringify(fields.settings));
            }
            return true;
        }),
    };
    return row;
};

beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/shop', require('src/modules/shop/shop.routes'));
});

beforeEach(() => {
    jest.clearAllMocks();
    shopRow = makeShopRow(baseSettings());
    const { Shop, UserShop } = require('../../entities');
    Shop.findByPk.mockResolvedValue(shopRow);
    UserShop.findOne.mockResolvedValue({
        user_id: 'user-1', shop_id: SHOP_ID, role: 'owner', is_active: true,
        shop: { id: SHOP_ID, is_active: true },
    });
});

const authHeader = 'Bearer test-token';

const put = (payload) => request(app)
    .put('/shop/business-policies')
    .set('Authorization', authHeader)
    .send(payload);

describe('business-policies validator matrix', () => {
    it('accepts the full documented shape', async () => {
        const res = await put({
            returns: { stance: 'conditional', period_days: 365, details: 'sealed', exclusions: 'sale items' },
            exchange: { stance: 'offered', period_days: 0 },
            refunds: { stance: 'not_offered', details: 'no refunds', process: 'N/A' },
            warranty: { stance: 'offered', duration: '6 months', coverage: 'manufacturing', coverage_exclusions: 'misuse' },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.policies.returns.period_days).toBe(365);
        expect(res.body.data.policies.exchange.period_days).toBe(0);
    });

    it.each(['unspecified', 'offered', 'not_offered', 'conditional'])(
        'accepts stance "%s" (including explicit unspecified)',
        async (stance) => {
            const res = await put({ returns: { stance } });
            expect(res.status).toBe(200);
            expect(res.body.data.policies.returns.stance).toBe(stance);
        },
    );

    it('rejects an out-of-enum stance', async () => {
        const res = await put({ returns: { stance: 'maybe' } });
        expect(res.status).toBe(400);
    });

    it('rejects period_days bounds / non-integers and kind misuse', async () => {
        expect((await put({ returns: { period_days: -1 } })).status).toBe(400);
        expect((await put({ returns: { period_days: 366 } })).status).toBe(400);
        expect((await put({ returns: { period_days: 7.5 } })).status).toBe(400);
        // period_days is the returns/exchange window — not a refunds/warranty concept.
        expect((await put({ refunds: { period_days: 30 } })).status).toBe(400);
        expect((await put({ warranty: { period_days: 30 } })).status).toBe(400);
    });

    it('enforces text bounds: ≤500 on details/exclusions/process/coverage/coverage_exclusions, ≤120 on warranty duration', async () => {
        expect((await put({ returns: { details: 'x'.repeat(501) } })).status).toBe(400);
        expect((await put({ returns: { exclusions: 'x'.repeat(501) } })).status).toBe(400);
        expect((await put({ refunds: { process: 'x'.repeat(501) } })).status).toBe(400);
        expect((await put({ warranty: { coverage: 'x'.repeat(501) } })).status).toBe(400);
        expect((await put({ warranty: { coverage_exclusions: 'x'.repeat(501) } })).status).toBe(400);
        expect((await put({ warranty: { duration: 'x'.repeat(121) } })).status).toBe(400);
        expect((await put({ warranty: { duration: 'x'.repeat(120) } })).status).toBe(200);
        expect((await put({ returns: { details: 'x'.repeat(500) } })).status).toBe(200);
    });

    it('rejects unknown top-level kinds and unknown fields inside a known kind', async () => {
        expect((await put({ shipping_policy: { stance: 'offered' } })).status).toBe(400);
        expect((await put({ returns: { stance: 'offered', fine_print: 'x' } })).status).toBe(400);
        // duration is a warranty concept — not a returns field.
        expect((await put({ returns: { duration: '1 year' } })).status).toBe(400);
    });

    it('rejects non-object bodies and accepts {} plus explicit null kinds', async () => {
        expect((await put([1, 2])).status).toBe(400);
        expect((await put({ returns: 'not an object' })).status).toBe(400);
        expect((await put({})).status).toBe(200); // no-op write (nothing invented)
        const res = await put({ exchange: null }); // explicit clear of the kind
        expect(res.status).toBe(200);
        expect(res.body.data.policies).not.toHaveProperty('exchange');
    });

    it('invents NO defaults: an empty PUT preserves exactly what was stated and adds nothing', async () => {
        const res = await put({});
        expect(res.status).toBe(200);
        expect(res.body.data.policies).toEqual(baseSettings().policies);
        expect(res.body.data.policies).not.toHaveProperty('refunds');
        expect(res.body.data.policies).not.toHaveProperty('warranty');
    });
});

describe('GET /shop/business-policies', () => {
    it('is honest about absence: a shop with no policies stated returns {}', async () => {
        shopRow.settings = { businessInfo: { shopName: 'Quiet Shop' } };
        const res = await request(app)
            .get('/shop/business-policies')
            .set('Authorization', authHeader);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: {} });
    });

    it('returns the stated policies verbatim', async () => {
        const res = await request(app)
            .get('/shop/business-policies')
            .set('Authorization', authHeader);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(baseSettings().policies);
    });

    it('reads the TOKEN shop only (confused-deputy guard)', async () => {
        const { Shop } = require('../../entities');
        await request(app)
            .get('/shop/business-policies')
            .set('Authorization', authHeader)
            .send({ shopId: 'attacker-shop' });
        expect(Shop.findByPk).toHaveBeenCalledWith(SHOP_ID);
        expect(Shop.findByPk).not.toHaveBeenCalledWith('attacker-shop');
    });

    it('allows any member role (read is informational)', async () => {
        const { UserShop } = require('../../entities');
        UserShop.findOne.mockResolvedValue({
            user_id: 'user-1', shop_id: SHOP_ID, role: 'staff', is_active: true,
            shop: { id: SHOP_ID, is_active: true },
        });
        const res = await request(app)
            .get('/shop/business-policies')
            .set('Authorization', authHeader);
        expect(res.status).toBe(200);
    });
});

describe('PUT /shop/business-policies merge semantics', () => {
    it('partial field merge: absent kinds/fields untouched; provided fields updated', async () => {
        const res = await put({ returns: { stance: 'conditional' }, refunds: { stance: 'offered', process: 'original payment method' } });
        expect(res.status).toBe(200);
        expect(res.body.data.policies.returns).toEqual({
            stance: 'conditional', period_days: 7, details: 'unused only', exclusions: 'innerwear',
        });
        expect(res.body.data.policies.exchange).toEqual({ stance: 'not_offered' }); // untouched
        expect(res.body.data.policies.refunds).toEqual({
            stance: 'offered', process: 'original payment method',
        }); // new kind, only what was sent
    });

    it('explicit null clears a field without touching its siblings', async () => {
        const res = await put({ returns: { details: null } });
        expect(res.status).toBe(200);
        expect(res.body.data.policies.returns).not.toHaveProperty('details');
        expect(res.body.data.policies.returns.stance).toBe('offered');
        expect(res.body.data.policies.returns.exclusions).toBe('innerwear');
    });

    it('preserves unrelated settings domains and the RTO consent block', async () => {
        const res = await put({ warranty: { stance: 'offered', duration: '1 year' } });
        expect(res.status).toBe(200);
        const saved = shopRow.update.mock.calls.at(-1)[0].settings;
        expect(saved.rto_network).toEqual({ contribute: false, enforce: true });
        expect(saved.ai).toEqual(baseSettings().ai);
        expect(saved.businessInfo.shopName).toBe('Policy Shop');
        expect(saved.documents).toEqual([{ id: 'doc-1', name: 'guide.txt' }]);
        expect(saved.brandingRules).toEqual({ tone: 'friendly' });
    });

    it('requires owner: staff and admin are rejected before the write (mirrors business-info PUT)', async () => {
        const { UserShop, Shop } = require('../../entities');
        for (const role of ['staff', 'admin']) {
            UserShop.findOne.mockResolvedValueOnce({
                user_id: 'user-1', shop_id: SHOP_ID, role, is_active: true,
                shop: { id: SHOP_ID, is_active: true },
            });
            const res = await put({ returns: { stance: 'offered' } });
            expect(res.status).toBe(403);
        }
        expect(shopRow.update).not.toHaveBeenCalled();
        expect(Shop.findByPk).not.toHaveBeenCalled();
    });

    it('a validation rejection never reaches the writer', async () => {
        const res = await put({ returns: { stance: 'yes' } });
        expect(res.status).toBe(400);
        expect(shopRow.update).not.toHaveBeenCalled();
    });

    it('PATCH /shop/business-policies is the identical partial-merge verb (A0 confirmed)', async () => {
        const res = await request(app)
            .patch('/shop/business-policies')
            .set('Authorization', authHeader)
            .send({ returns: { stance: 'conditional' } });
        expect(res.status).toBe(200);
        expect(res.body.data.policies.returns.stance).toBe('conditional');
        expect(res.body.data.policies.returns.period_days).toBe(7); // merge preserved
    });

    it('invalidates the shop-settings caches after the committed write', async () => {
        const { invalidateShopSettingsCaches } = require('../../../utils/shop-settings-cache');
        await put({ returns: { stance: 'not_offered' } });
        expect(invalidateShopSettingsCaches).toHaveBeenCalledWith(SHOP_ID);
    });

    it('re-syncs the business-info knowledge vector with the merged policies (best effort)', async () => {
        const knowledgeService = require('../../knowledge/knowledge.service');
        const res = await put({ returns: { details: 'sealed tags intact' } });
        expect(res.status).toBe(200);
        expect(knowledgeService.syncBusinessInfoRagIndex).toHaveBeenCalledTimes(1);
        const [shopId, businessInfo, policies] = knowledgeService.syncBusinessInfoRagIndex.mock.calls[0];
        expect(shopId).toBe(SHOP_ID);
        expect(businessInfo.shopName).toBe('Policy Shop');
        expect(policies.returns.details).toBe('sealed tags intact');
        expect(policies.exchange).toEqual({ stance: 'not_offered' });
    });

    it('a knowledge-sync failure must NOT fail the save', async () => {
        const knowledgeService = require('../../knowledge/knowledge.service');
        knowledgeService.syncBusinessInfoRagIndex.mockRejectedValueOnce(new Error('Qdrant unavailable'));
        const res = await put({ refunds: { stance: 'conditional' } });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('PUT /shop/business-info new-field bounds (A5 contract)', () => {
    it('rejects over-length nameEn/tagline/city and malformed email at the route', async () => {
        const knowledgeService = require('../../knowledge/knowledge.service');
        const long = (n) => 'x'.repeat(n);
        for (const body of [
            { nameEn: long(121) },
            { tagline: long(161) },
            { city: long(61) },
            { email: 'not-an-email' },
            { email: long(250) + '@rina.test' }, // >254 total
        ]) {
            const res = await request(app)
                .put('/shop/business-info')
                .set('Authorization', authHeader)
                .send(body);
            expect(res.status).toBe(400);
        }
        expect(knowledgeService.updateBusinessInfo).not.toHaveBeenCalled();
    });

    it('accepts the new fields (empty string clears)', async () => {
        const knowledgeService = require('../../knowledge/knowledge.service');
        knowledgeService.updateBusinessInfo.mockResolvedValueOnce({ businessInfo: {} });
        const res = await request(app)
            .put('/shop/business-info')
            .set('Authorization', authHeader)
            .send({ nameEn: 'Rina EN', tagline: 'Best fits', email: 'care@rina.test', city: 'Dhaka' });
        expect(res.status).toBe(200);
        expect(knowledgeService.updateBusinessInfo).toHaveBeenCalledWith(
            'user-1', SHOP_ID,
            expect.objectContaining({ nameEn: 'Rina EN', tagline: 'Best fits', email: 'care@rina.test', city: 'Dhaka' }),
        );
    });
});

describe('settings-level policies guard (defense-in-depth for general settings writes)', () => {
    const { validateSettings, mergeSettingsPreservingRtoConsent, validatePolicies } = require('../shop-settings.validator');

    it('a general settings merge with an invalid policies block is rejected', () => {
        expect(() => mergeSettingsPreservingRtoConsent(baseSettings(), {
            policies: { returns: { stance: 'yes-please' } },
        })).toThrow(/Business policies validation failed/);
        expect(() => mergeSettingsPreservingRtoConsent(baseSettings(), {
            policies: { shipping: {} },
        })).toThrow(/Business policies validation failed/);
    });

    it('absence stays valid (never coerced to an empty skeleton)', () => {
        expect(validatePolicies(undefined)).toBe(true);
        expect(validatePolicies(null)).toBe(true);
        const merged = mergeSettingsPreservingRtoConsent(baseSettings(), { ai: { confidence_threshold: 90 } });
        expect(merged.policies).toEqual(baseSettings().policies); // untouched
    });

    it('validateSettings accepts the documented bounds', () => {
        expect(() => validateSettings({
            policies: { returns: { stance: 'unspecified' }, warranty: { stance: 'conditional', duration: '2 years', coverage: 'motor' } },
        })).not.toThrow();
    });

    it('businessInfo schema bounds the new identity fields', () => {
        expect(() => validateSettings({
            businessInfo: { shopName: 'ok', nameEn: 'x'.repeat(121) },
        })).toThrow(/Invalid value for nameEn/);
        expect(() => validateSettings({
            businessInfo: { shopName: 'ok', tagline: 'x'.repeat(161) },
        })).toThrow(/Invalid value for tagline/);
        expect(() => validateSettings({
            businessInfo: { shopName: 'ok', email: 'not-an-email' },
        })).toThrow(/Invalid value for email/);
        expect(() => validateSettings({
            businessInfo: { shopName: 'ok', city: 'x'.repeat(61) },
        })).toThrow(/Invalid value for city/);
        expect(() => validateSettings({
            businessInfo: { shopName: 'ok', nameEn: 'Rina EN', tagline: 'fits', email: 'a@b.co', city: 'Dhaka' },
        })).not.toThrow();
    });
});
