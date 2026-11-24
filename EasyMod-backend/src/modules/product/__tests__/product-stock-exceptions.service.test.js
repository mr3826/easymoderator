'use strict';

const {
    getStockExceptions,
    computeEffectiveQuantity,
    classifyStockExceptions,
    STOCK_SCAN_CAP,
} = require('../product-stock-exceptions.service');

const shopId = 'shop-a';
const now = new Date('2026-11-24T10:00:00.000Z');

const variant = (quantity, is_active = true, id = 'v-1') => ({ id, quantity, is_active });

const product = (overrides = {}) => ({
    id: 'p-1',
    quantity: 0,
    low_stock_threshold: 3,
    updated_at: now,
    ...overrides,
});

const makeModels = ({ rows = [], total = rows.length } = {}) => ({
    Product: {
        findAll: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(total),
    },
    ProductVariant: {},
});

const baseArgs = (overrides = {}) => ({ shopId, now, ...overrides });

describe('D2 effective quantity + classification (pure, exported for FE parity)', () => {
    it('variant sums are the ordering authority over the parent when ACTIVE variants exist', () => {
        expect(computeEffectiveQuantity(product({
            quantity: 999,
            product_variants: [variant(2), variant(3)],
        }))).toBe(5);
        expect(classifyStockExceptions(product({
            quantity: 999,
            low_stock_threshold: 10,
            product_variants: [variant(2), variant(3)],
        }))).toBe('low_stock');
        // Parent says healthy, variants say out — variants win.
        expect(classifyStockExceptions(product({
            quantity: 50,
            product_variants: [variant(0), variant(0)],
        }))).toBe('out_of_stock');
    });

    it('products without variants (or without ACTIVE variants) fall back to parent stock', () => {
        expect(computeEffectiveQuantity(product({ quantity: 7, product_variants: [] }))).toBe(7);
        expect(computeEffectiveQuantity(product({ quantity: 7 }))).toBe(7);
        expect(computeEffectiveQuantity(product({
            quantity: 7,
            product_variants: [variant(0, false), variant(0, false)],
        }))).toBe(7);
        expect(classifyStockExceptions(product({
            quantity: 1,
            low_stock_threshold: 3,
            product_variants: [variant(0, false)],
        }))).toBe('low_stock');
    });

    it('out ≤ 0, low 0 < eff ≤ threshold — the two sets are DISJOINT by construction', () => {
        expect(classifyStockExceptions(product({ quantity: 0 }))).toBe('out_of_stock');
        expect(classifyStockExceptions(product({ quantity: -5 }))).toBe('out_of_stock');
        expect(classifyStockExceptions(product({ quantity: 1, low_stock_threshold: 1 }))).toBe('low_stock');
        expect(classifyStockExceptions(product({ quantity: 3, low_stock_threshold: 3 }))).toBe('low_stock');
        expect(classifyStockExceptions(product({ quantity: 4, low_stock_threshold: 3 }))).toBe('ok');
        expect(classifyStockExceptions(product({ quantity: 1, low_stock_threshold: 0 }))).toBe('ok');
        expect(classifyStockExceptions(product({ quantity: 1, low_stock_threshold: null }))).toBe('ok');
    });

    it('an unparseable stock level fails toward a VISIBLE exception, never silent in_stock', () => {
        expect(classifyStockExceptions(product({ quantity: 'not-a-number' }))).toBe('out_of_stock');
        expect(classifyStockExceptions(product({ quantity: null }))).toBe('out_of_stock');
    });
});

describe('C2 getStockExceptions (doc 05 §2)', () => {
    it('scopes tenant FIRST + active + tracked, LEFT-joins ACTIVE variants only, caps 1000 updated_at DESC', async () => {
        const models = makeModels();
        await getStockExceptions(baseArgs(models));

        const options = models.Product.findAll.mock.calls[0][0];
        expect(options.where).toEqual({ shop_id: shopId, is_active: true, track_quantity: true });
        expect(Object.keys(options.where)[0]).toBe('shop_id');
        expect(options.include).toEqual([{
            model: models.ProductVariant,
            as: 'product_variants',
            required: false,
            where: { is_active: true },
            attributes: ['id', 'quantity', 'is_active'],
        }]);
        expect(options.attributes).toEqual(['id', 'quantity', 'low_stock_threshold', 'updated_at']);
        expect(options.order).toEqual([['updated_at', 'DESC']]);
        expect(options.limit).toBe(STOCK_SCAN_CAP);
        expect(options.limit).toBe(1000);
        expect(models.Product.count.mock.calls[0][0].where).toEqual({ shop_id: shopId, is_active: true, track_quantity: true });
    });

    it('counts out/low separately with disjoint totals (exceptions = outOfStock + lowStock)', async () => {
        const clearRows = [
            product({ id: 'out-1', quantity: 0 }),
            product({ id: 'out-2', quantity: 8, product_variants: [variant(-1), variant(0)] }),
            product({ id: 'low-1', quantity: 2, low_stock_threshold: 3 }),
            product({ id: 'low-2', quantity: 50, product_variants: [variant(1), variant(1)] }),
            product({ id: 'ok-1', quantity: 4, low_stock_threshold: 3 }),
        ];
        const models = makeModels({ rows: clearRows, total: clearRows.length });
        const result = await getStockExceptions(baseArgs(models));

        expect(result).toEqual({
            outOfStock: 2,
            lowStock: 2,
            exceptions: 4,
            scanned: 5,
            cap: 1000,
            coverageComplete: true,
            generated_at: '2026-11-24T10:00:00.000Z',
        });
        expect(result.exceptions).toBe(result.outOfStock + result.lowStock);
    });

    it('coverageComplete: scanned < cap AND scanned === in-scope total', async () => {
        const atCap = makeModels({
            rows: Array.from({ length: 1000 }, (_, index) => product({ id: `p-${index}`, quantity: 100 })),
            total: 1000,
        });
        const capped = await getStockExceptions(baseArgs(atCap));
        expect(capped.scanned).toBe(1000);
        expect(capped.coverageComplete).toBe(false);

        const complete = makeModels({ rows: [product({ quantity: 100 })], total: 1 });
        expect((await getStockExceptions(baseArgs(complete))).coverageComplete).toBe(true);

        const partial = makeModels({ rows: [product({ quantity: 100 })], total: 40 });
        expect((await getStockExceptions(baseArgs(partial))).coverageComplete).toBe(false);

        const empty = makeModels({ rows: [], total: 0 });
        expect((await getStockExceptions(baseArgs(empty))).coverageComplete).toBe(true);
    });

    it('requires the tenant scope — no shopId, no query', async () => {
        const models = makeModels();
        await expect(getStockExceptions(baseArgs({ ...models, shopId: '' }))).rejects.toThrow(/tenant scope/);
        expect(models.Product.findAll).not.toHaveBeenCalled();
    });

    it('rejects on any read failure — the route maps to 5xx, clients to null (never 0)', async () => {
        const models = makeModels();
        models.Product.findAll.mockRejectedValue(new Error('db down'));
        await expect(getStockExceptions(baseArgs(models))).rejects.toThrow('db down');
    });

    it('treats a non-array findAll result defensively (scanned 0, coverage honest)', async () => {
        const models = makeModels({ total: 0 });
        models.Product.findAll.mockResolvedValue(null);
        const result = await getStockExceptions(baseArgs(models));
        expect(result.scanned).toBe(0);
        expect(result.exceptions).toBe(0);
    });
});
