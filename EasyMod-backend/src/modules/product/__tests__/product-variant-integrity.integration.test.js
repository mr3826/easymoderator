'use strict';

/**
 * Products & Customers redesign — mission step 1, area 4.
 *
 * VARIANT INVENTORY INTEGRITY against real PostgreSQL:
 *
 *   - Relational ProductVariant rows are the stock authority and are
 *     READ-ONLY through the product API path: createProduct/updateProduct
 *     must throw 400 AppError PRODUCT_VARIANTS_READ_ONLY for any payload
 *     that carries the `product_variants` key (product.service.js:209-211
 *     and 328-330), and variant rows must be left untouched.
 *   - The legacy JSON `variants` blob stays writable but is NOT stock
 *     authority: writing it must not create or mutate product_variants rows,
 *     and stock classification must keep following the relational rows.
 *   - The D2 predicate (product-stock-exceptions.service.js) and the
 *     product-overview.service.js low_stock/out_of_stock counts must AGREE
 *     with the real DB rows for a designed fixture set — including an
 *     untracked product (track_quantity false), a tracked qty-0 product, a
 *     tracked low product (≤ threshold), products whose relational variant
 *     stock overrides an inflated parent quantity, and an inactive-variant
 *     exclusion case — with SQL-derived expectations computed from the rows
 *     themselves, not from the service.
 *   - List/filter parity (listProducts) and tenant scoping: shop B never
 *     sees shop A's rows or counts, and cross-shop access fails closed
 *     (403 for membership, 404 for a foreign id).
 *
 * Harness notes: the AI fire-and-forget modules are stubbed at the module
 * boundary (same pattern as product-create-usage.integration.test.js and
 * channel-automation.race.integration.test.js). Fixture rows are created
 * directly through the models — deliberately NOT through createProduct —
 * because the read-only guard is the subject under test and the billing
 * ledger is covered in the sibling file. Teardown is scoped to this file's
 * own shops; nothing is truncated.
 */

const { v4: uuidv4 } = require('uuid');
const { Op, QueryTypes } = require('sequelize');

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
    Product, ProductVariant, Shop, User, UserShop, Tenant, Subscription, UsageEvent,
} = require('../../entities');
const { sequelize } = require('../../../utils/database/database-setup');
const { AppError } = require('../../../utils/AppError');
const productService = require('../product.service');
const stockExceptionsService = require('../product-stock-exceptions.service');
const overviewService = require('../product-overview.service');
const subscriptionService = require('../../subscription/subscription.service');

const productPayload = (tag, over = {}) => ({
    name: `PC Variant-Integrity ${tag}`,
    price: 100,
    sku: `pc-vi-${tag}`,
    quantity: 10,
    track_quantity: true,
    ...over,
});

const variantRow = (productId, optionValue, quantity, isActive = true) => ProductVariant.create({
    product_id: productId,
    option_name: 'Colour',
    option_value: optionValue,
    quantity,
    is_active: isActive,
});

describe('Variant inventory integrity — real PostgreSQL (area 4)', () => {
    const F = {}; // fixture shops
    const created = { shops: [], users: [], tenants: [], productIds: [] };

    async function createShopFixture(label) {
        const tenant = await Tenant.create({ name: `pc-vi-${label}-${uuidv4().slice(0, 8)}` });
        const user = await User.create({
            email: `pc-vi-${uuidv4()}@integration.local`,
            password: 'integration-only-password',
        });
        const shop = await Shop.create({
            name: `PC VI ${label}`,
            shop_name: `PC VI ${label}`,
            unique_code: `PV${uuidv4().replace(/-/g, '').slice(0, 16)}`,
            tenant_id: tenant.id,
            user_id: user.id,
        });
        await UserShop.create({ user_id: user.id, shop_id: shop.id, role: 'owner', is_active: true });
        const subscription = await subscriptionService.createDefaultSubscription(shop.id, { emitEvent: false });
        created.tenants.push(tenant);
        created.users.push(user);
        created.shops.push(shop);
        return { tenant, user, shop, subscription };
    }

    /** Catalog fixture on shop A implementing the D2 decision table. */
    async function seedShopACatalog() {
        const mk = (over) => Product.create({
            shop_id: F.a.shop.id,
            price: 100,
            is_active: true,
            ...over,
        });

        // 1. Untracked product: OUT OF SCOPE (track_quantity false).
        const untracked = await mk({ name: 'VI untracked', sku: 'pc-vi-untracked', track_quantity: false, quantity: 0, low_stock_threshold: 5 });
        // 2. Tracked, quantity 0: out_of_stock.
        const zero = await mk({ name: 'VI zero', sku: 'pc-vi-zero', track_quantity: true, quantity: 0, low_stock_threshold: 5 });
        // 3. Tracked, low: effective 3 ≤ threshold 5 → low_stock.
        const low = await mk({ name: 'VI low', sku: 'pc-vi-low', track_quantity: true, quantity: 3, low_stock_threshold: 5 });
        // 4. Tracked, healthy, NO relational rows → falls back to parent 100 → ok.
        const healthy = await mk({ name: 'VI healthy', sku: 'pc-vi-healthy', track_quantity: true, quantity: 100, low_stock_threshold: 5 });
        // 5. Relational variants (2 + 1 = 3) override parent 500 → low_stock.
        const variantLow = await mk({ name: 'VI variant-low', sku: 'pc-vi-variant-low', track_quantity: true, quantity: 500, low_stock_threshold: 5 });
        await variantRow(variantLow.id, 'Red', 2);
        await variantRow(variantLow.id, 'Blue', 1);
        // 6. Relational variants (0 + 0) override parent 500 → out_of_stock.
        const variantOut = await mk({ name: 'VI variant-out', sku: 'pc-vi-variant-out', track_quantity: true, quantity: 500, low_stock_threshold: 5 });
        await variantRow(variantOut.id, 'Red', 0);
        await variantRow(variantOut.id, 'Blue', 0);
        // 7. Inactive variant is EXCLUDED: active set empty → parent 7 → ok.
        const inactiveVariant = await mk({ name: 'VI inactive-variant', sku: 'pc-vi-inactive-variant', track_quantity: true, quantity: 7, low_stock_threshold: 5 });
        await variantRow(inactiveVariant.id, 'Green', 0, false);
        // 8. is_active false: excluded from exceptions, counted in overview totals.
        const disabled = await mk({ name: 'VI disabled', sku: 'pc-vi-disabled', track_quantity: true, quantity: 0, is_active: false, low_stock_threshold: 5 });

        return { untracked, zero, low, healthy, variantLow, variantOut, inactiveVariant, disabled };
    }

    /** Non-empty shop B catalog — isolation must fail loudly, not pass empty. */
    async function seedShopBCatalog() {
        const mk = (over) => Product.create({
            shop_id: F.b.shop.id,
            price: 100,
            is_active: true,
            ...over,
        });
        const zero = await mk({ name: 'B zero', sku: 'pc-vi-b-zero', track_quantity: true, quantity: 0, low_stock_threshold: 5 });
        const low = await mk({ name: 'B low', sku: 'pc-vi-b-low', track_quantity: true, quantity: 2, low_stock_threshold: 5 });
        const healthy = await mk({ name: 'B healthy', sku: 'pc-vi-b-healthy', track_quantity: true, quantity: 50, low_stock_threshold: 5 });
        const untracked = await mk({ name: 'B untracked', sku: 'pc-vi-b-untracked', track_quantity: false, quantity: 9 });
        return { zero, low, healthy, untracked };
    }

    beforeAll(async () => {
        F.a = await createShopFixture('vi-a');
        F.b = await createShopFixture('vi-b');
        // Shop C hosts the one SUCCESSFUL API create in this suite (legacy
        // blob) so shop A's designed decision-table counts stay exact for the
        // parity assertions no matter which case ran first.
        F.c = await createShopFixture('vi-c');
        F.aRows = await seedShopACatalog();
        F.bRows = await seedShopBCatalog();
        const allProducts = [...Object.values(F.aRows), ...Object.values(F.bRows)];
        created.productIds.push(...allProducts.map((p) => p.id));
    });

    afterAll(async () => {
        const shopIds = created.shops.map((s) => s.id);
        await ProductVariant.destroy({ where: { product_id: { [Op.in]: created.productIds } } });
        await Product.destroy({ where: { shop_id: { [Op.in]: shopIds } }, force: true });
        await UsageEvent.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        await Subscription.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        await UserShop.destroy({ where: { user_id: { [Op.in]: created.users.map((u) => u.id) } } });
        await Shop.destroy({ where: { id: { [Op.in]: shopIds } } });
        await User.destroy({ where: { id: { [Op.in]: created.users.map((u) => u.id) } } });
        await Tenant.destroy({ where: { id: { [Op.in]: created.tenants.map((t) => t.id) } } });
    });

    // ═════════════════════════════════════════════════════════════════════
    describe('product_variants payload guard (read-only through the API path)', () => {
        test('createProduct with a product_variants payload throws 400 PRODUCT_VARIANTS_READ_ONLY and writes nothing', async () => {
            const { user, shop } = F.a;
            const shopProductIds = () => Product.findAll({ where: { shop_id: shop.id }, attributes: ['id'] })
                .then((rows) => rows.map((r) => r.id));
            const idsBefore = await shopProductIds();
            const baseProducts = idsBefore.length;
            const baseVariants = await ProductVariant.count({ where: { product_id: { [Op.in]: idsBefore } } });

            let thrown;
            try {
                await productService.createProduct(user.id, shop.id, productPayload('guard-create', {
                    product_variants: [{ option_name: 'Colour', option_value: 'Neon', quantity: 99 }],
                }), `PC-VI-${uuidv4()}`);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(AppError);
            expect(thrown.status).toBe(400);
            expect(thrown.code).toBe('PRODUCT_VARIANTS_READ_ONLY');

            const idsAfter = await shopProductIds();
            expect(idsAfter.length).toBe(baseProducts);
            expect(await ProductVariant.count({ where: { product_id: { [Op.in]: idsAfter } } })).toBe(baseVariants);
            expect(await Product.findOne({ where: { shop_id: shop.id, sku: 'pc-vi-guard-create' } })).toBeNull();
        });

        test('the guard fires on the KEY itself — an empty product_variants array is still 400', async () => {
            const { user, shop } = F.a;
            await expect(
                productService.createProduct(user.id, shop.id, productPayload('guard-empty', {
                    product_variants: [],
                }), `PC-VI-${uuidv4()}`),
            ).rejects.toMatchObject({ status: 400, code: 'PRODUCT_VARIANTS_READ_ONLY' });
            expect(await Product.count({ where: { shop_id: shop.id, sku: 'pc-vi-guard-empty' } })).toBe(0);
        });

        test('updateProduct with a product_variants payload throws 400 and leaves rows AND product fields untouched', async () => {
            const { user, shop } = F.a;
            const target = F.aRows.variantLow;
            const variantsBefore = await ProductVariant.findAll({
                where: { product_id: target.id },
                order: [['option_value', 'ASC']],
            });
            const snapshotBefore = variantsBefore.map((v) => ({
                id: v.id, quantity: v.quantity, is_active: v.is_active,
            }));

            let thrown;
            try {
                await productService.updateProduct(target.id, user.id, shop.id, {
                    name: 'MUST NOT PERSIST',
                    product_variants: [{ option_name: 'Colour', option_value: 'Gold', quantity: 77 }],
                });
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(AppError);
            expect(thrown.status).toBe(400);
            expect(thrown.code).toBe('PRODUCT_VARIANTS_READ_ONLY');

            // Guard runs before any write — neither the relational rows nor the
            // product's own fields moved.
            await target.reload();
            expect(target.name).not.toBe('MUST NOT PERSIST');
            const variantsAfter = await ProductVariant.findAll({
                where: { product_id: target.id },
                order: [['option_value', 'ASC']],
            });
            expect(variantsAfter.map((v) => ({ id: v.id, quantity: v.quantity, is_active: v.is_active })))
                .toEqual(snapshotBefore);
            expect(variantsAfter.find((v) => v.option_value === 'Gold')).toBeUndefined();
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    describe('legacy JSON variants blob is writable but never authoritative', () => {
        // Runs on a dedicated shop C: a SUCCESSFUL create adds a product row,
        // and the parity suites below assert shop A's designed decision-table
        // counts absolutely. Writing through the real API here would otherwise
        // pollute those expectations (shop C's create is still fully metered —
        // see the sibling product-create-usage suite for the ledger).
        test('createProduct with a legacy `variants` blob succeeds without creating relational rows', async () => {
            const { user, shop } = F.c;

            const product = await productService.createProduct(user.id, shop.id, productPayload('blob-create', {
                variants: [{ option_value: 'Red', quantity: 5 }],
            }), `PC-VI-${uuidv4()}`);

            expect(Array.isArray(product.variants)).toBe(true);
            expect(await ProductVariant.count({ where: { product_id: product.id } })).toBe(0);
        });

        test('updateProduct with a legacy blob mutates the JSON only — variant rows byte-stable, classification follows rows', async () => {
            const { user, shop } = F.a;
            const target = F.aRows.variantLow; // active variants sum 3 → low_stock
            const before = await ProductVariant.findAll({ where: { product_id: target.id }, order: [['option_value', 'ASC']] });
            const snapshot = before.map((v) => ({ id: v.id, quantity: v.quantity, is_active: v.is_active, option_value: v.option_value }));

            const updated = await productService.updateProduct(target.id, user.id, shop.id, {
                variants: ['Swarovski', 'Mirror'],
            });
            expect(updated.variants).toEqual(['Swarovski', 'Mirror']);

            const after = await ProductVariant.findAll({ where: { product_id: target.id }, order: [['option_value', 'ASC']] });
            expect(after.map((v) => ({ id: v.id, quantity: v.quantity, is_active: v.is_active, option_value: v.option_value })))
                .toEqual(snapshot);

            // And the blob did not move stock authority: still low_stock (3 ≤ 5),
            // NOT reclassified by the two name-strings just written.
            const stock = await stockExceptionsService.getStockExceptions({ shopId: shop.id });
            const loaded = await Product.findOne({
                where: { id: target.id },
                include: [{ model: ProductVariant, as: 'product_variants', where: { is_active: true }, required: false }],
            });
            expect(stockExceptionsService.classifyStockExceptions(loaded)).toBe('low_stock');
            expect(stockExceptionsService.computeEffectiveQuantity(loaded)).toBe(3);
            expect(stock.lowStock).toBe(2); // low + variantLow, unchanged by blob writes
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    describe('stock authority parity — services vs the real DB rows', () => {
        /** Expected classification computed from RAW SQL over the actual rows. */
        async function sqlExpectations(shopId) {
            const rows = await sequelize.query(`
                SELECT p.id, p.quantity, p.low_stock_threshold, p.track_quantity, p.is_active,
                       COALESCE(SUM(v.quantity) FILTER (WHERE v.is_active), 0)::int AS variant_sum,
                       COUNT(v.id) FILTER (WHERE v.is_active)::int                 AS active_variants
                FROM products p
                LEFT JOIN product_variants v ON v.product_id = p.id
                WHERE p.shop_id = :shopId AND p.deleted_at IS NULL
                GROUP BY p.id, p.quantity, p.low_stock_threshold, p.track_quantity, p.is_active`,
            { replacements: { shopId }, type: QueryTypes.SELECT });

            let out = 0; let low = 0; let scope = 0;
            const verdicts = {};
            for (const row of rows) {
                if (!(row.is_active && row.track_quantity)) continue;
                scope += 1;
                const effective = Number(row.active_variants) > 0 ? Number(row.variant_sum) : Number(row.quantity);
                const threshold = Number(row.low_stock_threshold ?? 0);
                let verdict;
                if (!Number.isFinite(effective) || effective <= 0) verdict = 'out_of_stock';
                else if (Number.isFinite(threshold) && threshold > 0 && effective <= threshold) verdict = 'low_stock';
                else verdict = 'ok';
                verdicts[row.id] = verdict;
                if (verdict === 'out_of_stock') out += 1;
                else if (verdict === 'low_stock') low += 1;
            }
            return { out, low, scope, verdicts, total: rows.length };
        }

        test('classifyStockExceptions matches the designed D2 decision table per product', async () => {
            const loaded = await Product.findAll({
                where: { shop_id: F.a.shop.id },
                include: [{ model: ProductVariant, as: 'product_variants', where: { is_active: true }, required: false }],
            });
            const byName = Object.fromEntries(loaded.map((p) => [p.name, p]));

            expect(stockExceptionsService.classifyStockExceptions(byName['VI zero'])).toBe('out_of_stock');
            expect(stockExceptionsService.classifyStockExceptions(byName['VI low'])).toBe('low_stock');
            expect(stockExceptionsService.classifyStockExceptions(byName['VI healthy'])).toBe('ok');
            // Variants override the inflated parent: 2+1 ≤ 5 → low, despite qty 500.
            expect(stockExceptionsService.computeEffectiveQuantity(byName['VI variant-low'])).toBe(3);
            expect(stockExceptionsService.classifyStockExceptions(byName['VI variant-low'])).toBe('low_stock');
            // 0+0 → out, despite parent 500.
            expect(stockExceptionsService.computeEffectiveQuantity(byName['VI variant-out'])).toBe(0);
            expect(stockExceptionsService.classifyStockExceptions(byName['VI variant-out'])).toBe('out_of_stock');
            // Inactive variant excluded → empty active set → parent 7 → ok.
            expect(stockExceptionsService.computeEffectiveQuantity(byName['VI inactive-variant'])).toBe(7);
            expect(stockExceptionsService.classifyStockExceptions(byName['VI inactive-variant'])).toBe('ok');
        });

        test('getStockExceptions counts, scope and coverage agree with SQL-derived expectations', async () => {
            const expected = await sqlExpectations(F.a.shop.id);
            const stock = await stockExceptionsService.getStockExceptions({ shopId: F.a.shop.id });

            expect(expected).toMatchObject({ out: 2, low: 2, scope: 6 }); // the design table
            expect(stock.outOfStock).toBe(expected.out);
            expect(stock.lowStock).toBe(expected.low);
            expect(stock.exceptions).toBe(expected.out + expected.low);
            expect(stock.scanned).toBe(expected.scope);
            expect(stock.coverageComplete).toBe(true);
            expect(stock.cap).toBe(stockExceptionsService.STOCK_SCAN_CAP);
        });

        test('getOverview totals and stock tiles agree with the rows', async () => {
            const overview = await overviewService.getOverview({ shopId: F.a.shop.id });
            const stock = await stockExceptionsService.getStockExceptions({ shopId: F.a.shop.id });

            expect(overview.total).toBe(8);
            expect(overview.active).toBe(7);
            expect(overview.inactive).toBe(1);
            expect(overview.low_stock).toBe(stock.lowStock);
            expect(overview.out_of_stock).toBe(stock.outOfStock);
            expect(overview.scanned).toBe(stock.scanned);
            expect(overview.coverage_complete).toBe(true);

            // Tenant: shop B's overview is B's rows only.
            const expectedB = await sqlExpectations(F.b.shop.id);
            expect(expectedB).toMatchObject({ out: 1, low: 1, scope: 3 });
            const overviewB = await overviewService.getOverview({ shopId: F.b.shop.id });
            expect(overviewB.total).toBe(4);
            expect(overviewB.active).toBe(4);
            expect(overviewB.out_of_stock).toBe(expectedB.out);
            expect(overviewB.low_stock).toBe(expectedB.low);
            expect(overviewB.total).not.toBe(overview.total); // non-empty decoy catalog
        });

        test('listProducts parity: every in-scope listed row classifies identically to the exception scan', async () => {
            const expected = await sqlExpectations(F.a.shop.id);
            const listed = await productService.listProducts(F.a.user.id, F.a.shop.id);

            // Tenant scoping: nothing from shop B in shop A's list (and vice versa).
            expect(listed.every((p) => p.shop_id === F.a.shop.id)).toBe(true);
            const bNames = Object.values(F.bRows).map((p) => p.name);
            expect(listed.filter((p) => bNames.includes(p.name))).toEqual([]);

            // Parity: the per-row verdicts over listProducts' active-variant
            // includes equal the SQL-derived verdicts over the real rows.
            const inScope = listed.filter((p) => p.is_active && p.track_quantity);
            expect(inScope).toHaveLength(expected.scope);
            for (const row of inScope) {
                expect(stockExceptionsService.classifyStockExceptions(row)).toBe(expected.verdicts[row.id]);
            }
            const countedOut = inScope
                .filter((row) => stockExceptionsService.classifyStockExceptions(row) === 'out_of_stock').length;
            const countedLow = inScope
                .filter((row) => stockExceptionsService.classifyStockExceptions(row) === 'low_stock').length;
            const stock = await stockExceptionsService.getStockExceptions({ shopId: F.a.shop.id });
            expect(countedOut).toBe(stock.outOfStock);
            expect(countedLow).toBe(stock.lowStock);
        });

        test('exception services fail closed without a shopId (tenant scope is mandatory)', async () => {
            await expect(stockExceptionsService.getStockExceptions({})).rejects.toThrow(/shopId is required/);
            await expect(overviewService.getOverview({})).rejects.toThrow(/shopId is required/);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    describe('cross-shop access fails closed', () => {
        test('membership on a foreign shop is 403 on the create path', async () => {
            await expect(
                productService.createProduct(F.a.user.id, F.b.shop.id, productPayload('cross-create'), `PC-VI-${uuidv4()}`),
            ).rejects.toMatchObject({ status: 403 });
            expect(await ProductVariant.count({ where: { product_id: F.bRows.zero.id } })).toBe(0);
        });

        test('a foreign product id inside the caller\'s own shop is 404 (never 200, never cross-write)', async () => {
            const bZeroId = F.bRows.zero.id;
            await expect(
                productService.getProductById(bZeroId, F.a.user.id, F.a.shop.id),
            ).rejects.toMatchObject({ status: 404 });
            // ORDERS FACT (pinned, harmless): updateProduct evaluates the
            // product_variants guard BEFORE tenant row-scoping, so a
            // cross-tenant probe carrying `product_variants` is rejected 400
            // PRODUCT_VARIANTS_READ_ONLY, not 404 — the rejection is uniform
            // for own-shop and foreign ids alike, so it leaks nothing. The
            // tenant-scoping 404 is therefore probed with a plain field.
            await expect(
                productService.updateProduct(bZeroId, F.a.user.id, F.a.shop.id, { price: 123 }),
            ).rejects.toMatchObject({ status: 404 }); // membership passes, row scoping rejects
            await expect(
                productService.updateProduct(bZeroId, F.a.user.id, F.a.shop.id, { product_variants: [{ option_value: 'Steal', quantity: 1 }] }),
            ).rejects.toMatchObject({ status: 400, code: 'PRODUCT_VARIANTS_READ_ONLY' });

            await F.bRows.zero.reload();
            expect(F.bRows.zero.quantity).toBe(0); // untouched
            expect(F.bRows.zero.price).not.toBe(123); // never cross-written
            const stockB = await stockExceptionsService.getStockExceptions({ shopId: F.b.shop.id });
            expect(stockB.outOfStock).toBe(1); // B's counts unaffected by A's probing
        });

        test('shop B never sees shop A rows through the stock surfaces', async () => {
            const listedB = await productService.listProducts(F.b.user.id, F.b.shop.id);
            const aNames = Object.values(F.aRows).map((p) => p.name);
            expect(listedB.every((p) => p.shop_id === F.b.shop.id)).toBe(true);
            expect(listedB.filter((p) => aNames.includes(p.name))).toEqual([]);

            const stockB = await stockExceptionsService.getStockExceptions({ shopId: F.b.shop.id });
            expect(stockB.scanned).toBe(3);
            expect(stockB.outOfStock).toBe(1);
            expect(stockB.lowStock).toBe(1);
        });
    });
});
