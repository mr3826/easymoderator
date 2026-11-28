'use strict';

/**
 * Products & Customers redesign — mission step 1, areas 1–3.
 *
 * REAL PostgreSQL integration coverage of the product-create billing path:
 *
 *   1. CONCURRENT PRODUCT CREATION — N parallel createProduct(...) calls on
 *      one shop with DISTINCT Idempotency-Keys must produce N products, N
 *      usage events, and products_used must end at exactly base + N
 *      (no lost increments — trackUsage takes the Subscription row
 *      FOR UPDATE before it reads the counter).
 *
 *   2. IDEMPOTENCY — the same Idempotency-Key replayed SEQUENTIALLY and
 *      CONCURRENTLY must yield exactly one Product row and one usage event,
 *      and createProduct's replay path must return the ORIGINAL product
 *      (the PRODUCT_CREATE_ALREADY_PROCESSED → error.productId re-fetch in
 *      product.service.js). Plus the cross-shop probe documented below.
 *
 *   3. TRANSACTIONAL USAGE TRACKING — product + usage event commit/rollback
 *      atomically in ONE transaction (subscriptionService.trackUsage(...,
 *      { transaction }) inside createProduct): limit-exceeded rejection,
 *      injected failure between trackUsage success and commit, and the
 *      successful create's single event carrying the new product id.
 *
 * ── Usage-ledger key scoping — FINDING (reported to lead, verified here) ──
 * The dedup key is the TRIPLE (shop_id, resource_type, request_id):
 *   - usage_events carries UNIQUE(shop_id, resource_type, request_id)
 *     (20260520_000_initial_schema.js:717 and the idx_usage_idempotency_key
 *     index on usage-event.entity.js). It is NOT a global request_id index,
 *     despite the looser phrasing in the Step-9b comment of
 *     subscription.service.js ("the unique index on usage_events.request_id").
 *   - Every key string is normalized to a UUID via uuidv5(key,
 *     USAGE_REQUEST_NAMESPACE) when it is not already a UUID
 *     (usageRequestKey, subscription.service.js:54). That mapping IS global —
 *     the same literal key hashes to the same request_id for every shop —
 *     but storage and replay detection are both filtered by shop_id, so a
 *     key used by shop A does NOT swallow shop B's legitimate create: shop B
 *     gets its own product and its own usage event (and the counters
 *     increment independently). The cross-shop suite below pins this.
 *   - Consequence for the redesign: Idempotency-Key protection is
 *     per-shop+per-resource-type only. Two shops colliding on one key string
 *     is legal and produces two ledger rows sharing one request_id value.
 *     If product/UX surfaces ever show "this key was already used", that is
 *     only true within the merchant's own shop. (No code change made — this
 *     is the ledger's documented contract, and it is the SAFE direction for
 *     tenant isolation.)
 *   - Redis holds NO part of this ledger. The "no Redis footprint" case at
 *     the bottom proves it on the live container rather than asserting it.
 *
 * ── Concurrency ceiling: why N = 4 (not 12) ────────────────────────────────
 * Sequelize 6.37.8 runs with its DEFAULT connection pool here (no pool option
 * anywhere in database-setup/config): max 5. Each in-flight createProduct
 * HOLDS its outer transaction connection while it also needs a second,
 * non-transactional connection (verifyShopAccess / the trackUsage Step-1
 * replay findOne / getProductById's access re-check). With 5 concurrent
 * callers every pool connection is pinned by an open transaction and all 5
 * then wait for a 6th connection none of them will release before commit —
 * a guaranteed 60 s PoolAcquireTimeout deadlock. N = 4 leaves exactly one
 * connection as the rotating short-lived slot. The existing
 * usage-tracking.integration.test.js can run 100 concurrent trackUsage
 * calls because bare trackUsage never holds a transaction and requests a
 * second connection at the same time; the createProduct wrapper does, so the
 * honest ceiling here is pool_max - 1. The FOR UPDATE serialization property
 * is fully exercised at N = 4 (all four contend on one Subscription row).
 *
 * Harness notes:
 *   - The fire-and-forget AI side effects (queueProductProcessing →
 *     processProduct → LLM/vision/embedding) and the post-update re-embed
 *     are stubbed at the module boundary, exactly as
 *     channel-automation.race.integration.test.js stubs the message queue.
 *     They are outside the billing contract under test and would otherwise
 *     make this suite depend on external AI providers.
 *   - Every case uses its own unique keys; per-suite cleanup deletes only
 *     this file's own shops (cascading products/variants/usage/audit via the
 *     FKs) — nothing is truncated.
 *   - DB/Redis come from tests/integration/env.js defaults; this file runs
 *     against a dedicated disposable database.
 */

const { v4: uuidv4, v5: uuidv5, validate: uuidValidate } = require('uuid');
const { Op } = require('sequelize');

jest.mock('../product-ai.service', () => ({
    queueProductProcessing: jest.fn(() => Promise.resolve()),
    processProduct: jest.fn(() => Promise.resolve(true)),
    processPendingProducts: jest.fn(() => Promise.resolve({ processed: 0 })),
}));
jest.mock('../product-embedding.service', () => ({
    embedProduct: jest.fn(() => Promise.resolve()),
    removeProductEmbedding: jest.fn(() => Promise.resolve()),
    embedShopCatalog: jest.fn(() => Promise.resolve()),
}));

const {
    Product, UsageEvent, AuditLog, Subscription,
    Shop, User, UserShop, Tenant,
} = require('../../entities');
const { sequelize } = require('../../../utils/database/database-setup');
const { AppError } = require('../../../utils/AppError');
const productService = require('../product.service');
const subscriptionService = require('../../subscription/subscription.service');
const redis = require('../../../config/redis');

// Mirrors USAGE_REQUEST_NAMESPACE in subscription.service.js:37. The ledger
// key is deterministic (uuidv5), so re-deriving it in the test verifies the
// mapping instead of trusting it.
const LEDGER_NAMESPACE = '7b3f2c1e-9a4d-4f8b-8c2a-1d6e5f0a9b34';

const expectedLedgerKey = (requestId) => (
    uuidValidate(String(requestId))
        ? String(requestId)
        : uuidv5(String(requestId), LEDGER_NAMESPACE)
);

const productPayload = (tag, over = {}) => ({
    name: `PC Create-Usage ${tag}`,
    price: 250,
    sku: `pc-cu-${tag}`,
    quantity: 10,
    track_quantity: true,
    ...over,
});

/** Count usage ledger rows for (shop, key) regardless of status. */
const ledgerRowsForKey = (shopId, requestId) => UsageEvent.findAll({
    where: {
        shop_id: shopId,
        resource_type: 'products',
        request_id: expectedLedgerKey(requestId),
    },
});

describe('Products create + usage tracking — real PostgreSQL (areas 1–3)', () => {
    const fixtures = {}; // main / peer / limiter / inject
    const created = { shops: [], users: [], tenants: [] };

    /** Tenant + user + shop + membership + default subscription, tracked for teardown. */
    async function createShopFixture(label) {
        const tenant = await Tenant.create({ name: `pc-cu-${label}-${uuidv4().slice(0, 8)}` });
        const user = await User.create({
            email: `pc-cu-${uuidv4()}@integration.local`,
            password: 'integration-only-password',
        });
        const shop = await Shop.create({
            name: `PC CU ${label}`,
            shop_name: `PC CU ${label}`,
            unique_code: `PC${uuidv4().replace(/-/g, '').slice(0, 16)}`,
            tenant_id: tenant.id,
            user_id: user.id,
        });
        await UserShop.create({
            user_id: user.id, shop_id: shop.id, role: 'owner', is_active: true,
        });
        const subscription = await subscriptionService.createDefaultSubscription(
            shop.id, { emitEvent: false },
        );
        created.tenants.push(tenant);
        created.users.push(user);
        created.shops.push(shop);
        return { tenant, user, shop, subscription };
    }

    beforeAll(async () => {
        fixtures.main = await createShopFixture('main');      // areas 1 + 2 + success paths
        fixtures.peer = await createShopFixture('peer');      // cross-shop probe
        fixtures.limiter = await createShopFixture('limiter'); // USAGE_LIMIT_EXCEEDED
        fixtures.inject = await createShopFixture('inject');   // post-trackUsage failure
    });

    afterAll(async () => {
        const shopIds = created.shops.map((s) => s.id);
        // Scoped teardown — ONLY this file's own shops. FK CASCADE on shops
        // covers products/product_variants/usage_events/audit_logs/subscriptions,
        // but delete explicitly (force:true defeats paranoid soft-delete) so a
        // CASCADE change upstream cannot silently leave rows behind.
        await Product.destroy({ where: { shop_id: { [Op.in]: shopIds } }, force: true });
        await UsageEvent.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        await AuditLog.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        await Subscription.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        await UserShop.destroy({ where: { user_id: { [Op.in]: created.users.map((u) => u.id) } } });
        await Shop.destroy({ where: { id: { [Op.in]: shopIds } } });
        await User.destroy({ where: { id: { [Op.in]: created.users.map((u) => u.id) } } });
        await Tenant.destroy({ where: { id: { [Op.in]: created.tenants.map((t) => t.id) } } });
        await redis.closeAllRedis().catch(() => {});
    });

    // ═════════════════════════════════════════════════════════════════════
    // AREA 1 — CONCURRENT PRODUCT CREATION, DISTINCT KEYS
    // ═════════════════════════════════════════════════════════════════════
    describe('AREA 1 — concurrent creates with distinct Idempotency-Keys', () => {
        test('N parallel createProduct calls produce N products, N usage events, counter = base + N', async () => {
            const { user, shop, subscription } = fixtures.main;
            const N = 4; // pool_max(5) - 1 — see header comment for the math
            const keys = Array.from({ length: N }, (_, i) => `PC-CONC-${i}-${uuidv4()}`);

            const baseProducts = await Product.count({ where: { shop_id: shop.id } });
            const baseEvents = await UsageEvent.count({
                where: { shop_id: shop.id, resource_type: 'products' },
            });
            await subscription.reload();
            const baseUsed = subscription.products_used;

            const results = await Promise.all(
                keys.map((key, i) => (
                    productService.createProduct(user.id, shop.id, productPayload(`conc-${i}`), key)
                )),
            );

            // All N service calls succeed (no spurious idempotency replays).
            expect(results).toHaveLength(N);
            const ids = results.map((p) => p.id);
            expect(new Set(ids).size).toBe(N);

            // Exactly N new product rows, no lost/merged writes.
            expect(await Product.count({ where: { shop_id: shop.id } })).toBe(baseProducts + N);

            // Exactly N new usage events — one per distinct key.
            const events = await UsageEvent.findAll({
                where: { shop_id: shop.id, resource_type: 'products' },
            });
            expect(events).toHaveLength(baseEvents + N);
            const eventKeys = events.map((e) => String(e.request_id)).sort();
            expect(eventKeys).toEqual(keys.map(expectedLedgerKey).sort());
            expect(events.every((e) => e.status === 'committed')).toBe(true);
            const deltaForOurKeys = events
                .filter((e) => keys.map(expectedLedgerKey).includes(String(e.request_id)))
                .reduce((sum, e) => sum + e.delta, 0);
            expect(deltaForOurKeys).toBe(N);

            // THE counter assertion: FOR UPDATE serialization, no lost increments.
            await subscription.reload();
            expect(subscription.products_used).toBe(baseUsed + N);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // AREA 2 — IDEMPOTENCY, SAME KEY
    // ═════════════════════════════════════════════════════════════════════
    describe('AREA 2 — Idempotency-Key replay', () => {
        test('sequential replay returns the ORIGINAL product and writes exactly one product + one event', async () => {
            const { user, shop, subscription } = fixtures.main;
            const key = `PC-IDEM-SEQ-${uuidv4()}`;
            const baseProducts = await Product.count({ where: { shop_id: shop.id } });
            await subscription.reload();
            const baseUsed = subscription.products_used;

            const first = await productService.createProduct(user.id, shop.id, productPayload('seq'), key);
            const second = await productService.createProduct(user.id, shop.id, productPayload('seq'), key);

            // Service replay path: PRODUCT_CREATE_ALREADY_PROCESSED is caught
            // in createProduct and re-fetched via error.productId — the caller
            // sees the original product, not an error and not a duplicate.
            expect(second.id).toBe(first.id);
            expect(second.name).toBe(first.name);
            expect(second.price).toBe(first.price);

            expect(await Product.count({ where: { shop_id: shop.id } })).toBe(baseProducts + 1);
            const rows = await ledgerRowsForKey(shop.id, key);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('committed');
            expect(rows[0].resource_id).toBe(first.id);

            await subscription.reload();
            // +1 for this key only — the replay must not have metered again.
            expect(subscription.products_used).toBe(baseUsed + 1);
        });

        test('concurrent replay of one key yields exactly one product, one event, one increment', async () => {
            const { user, shop, subscription } = fixtures.main;
            const key = `PC-IDEM-CONC-${uuidv4()}`;
            const baseProducts = await Product.count({ where: { shop_id: shop.id } });
            await subscription.reload();
            const baseUsed = subscription.products_used;

            const results = await Promise.all([
                productService.createProduct(user.id, shop.id, productPayload('racy'), key),
                productService.createProduct(user.id, shop.id, productPayload('racy'), key),
                productService.createProduct(user.id, shop.id, productPayload('racy'), key),
            ]);

            // Every caller resolves — losers of the index race return the
            // winner's product rather than 500ing (Step-9b idempotent-retry
            // branch + createProduct's PRODUCT_CREATE_ALREADY_PROCESSED catch).
            const ids = new Set(results.map((p) => p.id));
            expect(ids.size).toBe(1);

            // Exactly one committed product row (losers' speculative rows rolled
            // back with their transactions) and one ledger row.
            expect(await Product.count({ where: { shop_id: shop.id } })).toBe(baseProducts + 1);
            const rows = await ledgerRowsForKey(shop.id, key);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('committed');
            expect(rows[0].resource_id).toBe(ids.values().next().value);

            await subscription.reload();
            expect(subscription.products_used).toBe(baseUsed + 1);
        });

        test('a non-UUID Idempotency-Key is hash-normalized to a stable UUID and still dedupes', async () => {
            const { user, shop } = fixtures.main;
            const rawKey = `PC-RAW-${uuidv4()}`; // not a UUID → uuidv5 namespace mapping

            expect(uuidValidate(rawKey)).toBe(false);
            const first = await productService.createProduct(user.id, shop.id, productPayload('raw'), rawKey);
            const second = await productService.createProduct(user.id, shop.id, productPayload('raw'), rawKey);

            expect(second.id).toBe(first.id);
            const rows = await ledgerRowsForKey(shop.id, rawKey);
            expect(rows).toHaveLength(1);
            expect(String(rows[0].request_id)).toBe(uuidv5(rawKey, LEDGER_NAMESPACE));
            expect(rows[0].resource_id).toBe(first.id);
        });

        // Cross-shop probe — see the FINDING block in the header. This is the
        // assertion the lead asked for: it documents what the ledger scoping
        // ACTUALLY does. Reality: shop-scoped triple → shop B is NOT swallowed;
        // it gets its own product and event. Pinning the true behavior.
        test('cross-shop probe: the same key on shop B creates an INDEPENDENT product + event (dedupe is shop-scoped)', async () => {
            const a = fixtures.main;
            const b = fixtures.peer;
            const key = `PC-XSHOP-${uuidv4()}`;

            const productA = await productService.createProduct(a.user.id, a.shop.id, productPayload('xshop-a'), key);
            // Shop B uses the IDENTICAL key string. If dedupe were global on
            // request_id this create would either fail (500 via the race
            // branch, which cannot find a "winner" scoped to shop B) or
            // wrongly replay shop A's product.
            const productB = await productService.createProduct(b.user.id, b.shop.id, productPayload('xshop-b'), key);

            expect(productB.id).not.toBe(productA.id);

            const rowsA = await ledgerRowsForKey(a.shop.id, key);
            const rowsB = await ledgerRowsForKey(b.shop.id, key);
            expect(rowsA).toHaveLength(1);
            expect(rowsB).toHaveLength(1);
            // Global key→uuid normalization means BOTH rows carry the same
            // request_id VALUE, disambiguated only by shop_id. (Documented
            // consequence — redesign surfaces must not treat request_id alone
            // as identifying a request across tenants.)
            expect(String(rowsA[0].request_id)).toBe(String(rowsB[0].request_id));
            expect(rowsA[0].shop_id).not.toBe(rowsB[0].shop_id);
            expect(rowsA[0].resource_id).toBe(productA.id);
            expect(rowsB[0].resource_id).toBe(productB.id);

            // Counters are independent; A was untouched by B's create.
            await a.subscription.reload();
            await b.subscription.reload();
            expect(b.subscription.products_used).toBe(1);

            // And concurrently, from a cold cache, the same shared key string
            // on two shops still produces two products (no lock contention
            // across tenants — each serializes only on its OWN Subscription row).
            const key2 = `PC-XSHOP2-${uuidv4()}`;
            const [cA, cB] = await Promise.all([
                productService.createProduct(a.user.id, a.shop.id, productPayload('xshop2-a'), key2),
                productService.createProduct(b.user.id, b.shop.id, productPayload('xshop2-b'), key2),
            ]);
            expect(cA.id).not.toBe(cB.id);
            const evA = await ledgerRowsForKey(a.shop.id, key2);
            const evB = await ledgerRowsForKey(b.shop.id, key2);
            expect(evA).toHaveLength(1);
            expect(evB).toHaveLength(1);
            expect(String(evA[0].request_id)).toBe(String(evB[0].request_id));
        });

        test('the ledger tuple includes resource_type: same key on the same shop under two types = two events', async () => {
            const { shop } = fixtures.main;
            const key = `PC-TUPLE-${uuidv4()}`;
            // Documents the FULL scoping contract (shop_id, resource_type,
            // request_id). Uses trackUsage directly so no product side effect.
            const ordersResult = await subscriptionService.trackUsage(shop.id, 'orders', 1, key);
            const productsResult = await subscriptionService.trackUsage(shop.id, 'products', 1, key);
            expect(ordersResult.isRetry).toBe(false);
            expect(productsResult.isRetry).toBe(false);

            const ledgerKey = expectedLedgerKey(key);
            const [orders, products] = await Promise.all([
                UsageEvent.count({ where: { shop_id: shop.id, resource_type: 'orders', request_id: ledgerKey } }),
                UsageEvent.count({ where: { shop_id: shop.id, resource_type: 'products', request_id: ledgerKey } }),
            ]);
            expect(orders).toBe(1);
            expect(products).toBe(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // AREA 3 — TRANSACTIONAL USAGE TRACKING (atomicity of create + metering)
    // ═════════════════════════════════════════════════════════════════════
    describe('AREA 3 — product + usage event are atomic', () => {
        test('3a: USAGE_LIMIT_EXCEEDED when the allowance is exhausted changes NOTHING', async () => {
            const { user, shop, subscription } = fixtures.limiter;
            await subscription.update({ products_limit: 2, products_used: 2 });
            await subscription.reload();

            const baseProducts = await Product.count({ where: { shop_id: shop.id } });
            const baseEvents = await UsageEvent.count({ where: { shop_id: shop.id } });
            const key = `PC-LIMIT-${uuidv4()}`;

            let thrown;
            try {
                await productService.createProduct(user.id, shop.id, productPayload('limit'), key);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(AppError);
            expect(thrown.status).toBe(402);
            expect(thrown.code).toBe('USAGE_LIMIT_EXCEEDED');

            // Zero-diff battery:
            // (1) no orphan product row — the speculative Product.create inside
            //     the rolled-back transaction never became visible;
            expect(await Product.count({ where: { shop_id: shop.id } })).toBe(baseProducts);
            // (2) no usage event for that requestId at all — any status; the
            //     limit check runs BEFORE the event insert, and the rollback
            //     would have removed a pending row anyway;
            expect(await UsageEvent.count({ where: { shop_id: shop.id, request_id: expectedLedgerKey(key) } })).toBe(0);
            expect(await UsageEvent.count({ where: { shop_id: shop.id } })).toBe(baseEvents);
            // (3) counters ALL unchanged (used AND limit — no partial write);
            await subscription.reload();
            expect(subscription.products_used).toBe(2);
            expect(subscription.products_limit).toBe(2);
            // (4) no orphan audit row carrying the key.
            expect(await AuditLog.count({ where: { idempotency_key: key } })).toBe(0);
        });

        test('3b: a failure injected AFTER trackUsage succeeds but BEFORE commit changes NOTHING', async () => {
            const { user, shop, subscription } = fixtures.inject;
            const baseProducts = await Product.count({ where: { shop_id: shop.id } });
            const baseEvents = await UsageEvent.count({ where: { shop_id: shop.id } });
            await subscription.reload();
            const baseUsed = subscription.products_used;
            const key = `PC-INJECT-${uuidv4()}`;

            // Injection seam: in createProduct's transaction the FIRST (and
            // only) Product.findOne is getProductById's authoritative reload —
            // i.e. exactly "after trackUsage returned success, before commit".
            // (verifyShopAccess goes through UserShop.findOne; the ledger reads
            // go through UsageEvent/Subscription.findOne — different models.
            // Same induced-failure technique as usage-tracking.integration
            // .test.js's 'a failure after the event is created leaves no trace'.)
            const findOneSpy = jest.spyOn(Product, 'findOne')
                .mockRejectedValueOnce(new Error('induced getProductById failure (pre-commit)'));

            let thrown;
            try {
                await productService.createProduct(user.id, shop.id, productPayload('inject'), key);
            } catch (error) {
                thrown = error;
            } finally {
                findOneSpy.mockRestore();
            }
            expect(thrown).toBeInstanceOf(Error);
            expect(thrown.message).toContain('induced getProductById failure');

            // The whole point of trackUsage(..., { transaction }): the metering
            // succeeded inside the SAME transaction, so the rollback must take
            // the counter, the event, the audit row AND the product together.
            expect(await Product.count({ where: { shop_id: shop.id } })).toBe(baseProducts);
            expect(await UsageEvent.count({ where: { shop_id: shop.id } })).toBe(baseEvents);
            expect(await UsageEvent.count({ where: { shop_id: shop.id, request_id: expectedLedgerKey(key) } })).toBe(0);
            await subscription.reload();
            expect(subscription.products_used).toBe(baseUsed);
            expect(await AuditLog.count({ where: { idempotency_key: key } })).toBe(0);
        });

        test('3c: a successful create writes exactly ONE committed usage event carrying the new product id', async () => {
            const { user, shop, subscription } = fixtures.main;
            const key = `PC-SUCCESS-${uuidv4()}`;
            await subscription.reload();
            const baseUsed = subscription.products_used;

            const product = await productService.createProduct(
                user.id, shop.id,
                productPayload('success', { sku: `pc-cu-success-${uuidv4().slice(0, 8)}` }),
                key,
            );

            const rows = await ledgerRowsForKey(shop.id, key);
            expect(rows).toHaveLength(1);
            const event = rows[0];
            expect(event.status).toBe('committed');
            expect(event.committed_at).not.toBeNull();
            expect(event.delta).toBe(1);
            // resource_id IS the product id (UUID column), and metadata mirrors
            // it under resourceId plus the human fields.
            expect(event.resource_id).toBe(product.id);
            expect(event.resource_metadata.resourceId).toBe(product.id);
            expect(event.resource_metadata.productName).toBe(product.name);
            expect(event.resource_metadata.sku).toBe(product.sku);
            expect(event.resource_metadata.within_allowance).toBe(true);

            // The audit row trackUsage writes shares the transaction and carries
            // the RAW request id (not the hashed ledger key) — pin the column
            // the redesign's usage pages will correlate against.
            const auditRows = await AuditLog.findAll({ where: { idempotency_key: key } });
            expect(auditRows).toHaveLength(1);
            expect(auditRows[0].metadata.usageEventId).toBe(event.id);

            await subscription.reload();
            expect(subscription.products_used).toBe(baseUsed + 1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // REDIS — honest scope note for these four areas:
    // the product-create/usage path is PostgreSQL-only. These cases prove
    // (a) the lane's Redis is genuinely alive (so "PG + Redis integration"
    // is not a fiction) and (b) the idempotency ledger never touches Redis.
    // ═════════════════════════════════════════════════════════════════════
    describe('Redis lane — the usage ledger does NOT live in Redis', () => {
        test('the integration Redis container is live on the suite logical DBs', async () => {
            expect(await redis.cacheRedis.ping()).toBe('PONG');
            expect(await redis.rateLimitRedis.ping()).toBe('PONG');
            // The DB indices env.js asks us to keep.
            expect(redis.cacheRedis.options.db).toBe(11);
            expect(redis.rateLimitRedis.options.db).toBe(12);
            const probeKey = `easymod:pc-int:redis-probe:${uuidv4()}`;
            await redis.cacheRedis.set(probeKey, '1', 'EX', 60);
            expect(await redis.cacheRedis.get(probeKey)).toBe('1');
            await redis.cacheRedis.del(probeKey);
        });

        test('an Idempotency-Key leaves no Redis footprint under its raw or hashed form', async () => {
            const { user, shop } = fixtures.main;
            const key = `PC-NORED-${uuidv4()}`;
            await productService.createProduct(user.id, shop.id, productPayload('nored'), key);
            const hashed = expectedLedgerKey(key);

            // Search both Redis logical DBs the suite touches for either form
            // of the key. Patterns are anchored on the unique random substring,
            // so the scan stays cheap on a shared container.
            const patterns = [`*${key}*`, `*${hashed}*`];
            for (const client of [redis.cacheRedis, redis.rateLimitRedis, redis.sessionRedis]) {
                for (const pattern of patterns) {
                    const found = await client.keys(pattern);
                    expect(found).toEqual([]);
                }
            }
        });
    });
});
