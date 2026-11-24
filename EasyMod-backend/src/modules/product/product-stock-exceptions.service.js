'use strict';

/**
 * Phase 1 — C2 (doc 05 §2 / mission D2): the SINGLE server-side definition of
 * product stock exceptions.
 *
 * D2 predicate (shared verbatim with the Products page parity tests):
 *  - scope: shop_id (FIRST — tenant), is_active = true, track_quantity = true;
 *  - effectiveQuantity(product) = activeVariants.length
 *        ? Σ(active variant quantity)
 *        : product.quantity
 *    (variants are the ordering authority since D-P2-02 — ACTIVE variants
 *    only; a product with no active variant rows falls back to parent stock);
 *  - outOfStock: effective ≤ 0;
 *  - lowStock:   0 < effective ≤ low_stock_threshold;
 *  - exceptions = outOfStock + lowStock — the two are DISJOINT by
 *    construction, so the single badge/tile number is honest.
 *
 * Honesty contract: bounded scan (CAP, `updated_at DESC`), `coverageComplete`
 * only when the scan saw every in-scope product; failures REJECT (route →
 * 5xx → client null). An unparseable quantity classifies as out-of-stock
 * (fail toward a visible exception, never toward a silent "in stock").
 */

const { Op } = require('sequelize');

const STOCK_SCAN_CAP = 1000;

const activeVariantQuantities = (product) => {
    const variants = Array.isArray(product?.product_variants) ? product.product_variants : [];
    return variants
        .filter((variant) => variant && variant.is_active !== false)
        .map((variant) => Number(variant.quantity ?? 0))
        .filter((quantity) => Number.isFinite(quantity));
};

/** D2 effective-quantity definition — exported for parity tests. */
const computeEffectiveQuantity = (product) => {
    const variantQuantities = activeVariantQuantities(product);
    if (variantQuantities.length > 0) {
        return variantQuantities.reduce((sum, quantity) => sum + quantity, 0);
    }
    return Number(product?.quantity ?? 0);
};

/** 'out_of_stock' | 'low_stock' | 'ok' — exported for parity tests. */
const classifyStockExceptions = (product) => {
    const effectiveQuantity = computeEffectiveQuantity(product);
    if (!Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0) return 'out_of_stock';
    const threshold = Number(product?.low_stock_threshold ?? 0);
    if (Number.isFinite(threshold) && threshold > 0 && effectiveQuantity <= threshold) {
        return 'low_stock';
    }
    return 'ok';
};

/**
 * Bounded stock-exception scan for one shop. Product/ProductVariant models
 * are injectable for unit tests; production resolves them lazily from
 * '../entities'.
 */
async function getStockExceptions({
    shopId,
    now = new Date(),
    Product,
    ProductVariant,
} = {}) {
    if (!shopId) {
        throw new Error('product-stock-exceptions: shopId is required (tenant scope)');
    }

    if (!Product || !ProductVariant) {
        const entities = require('../entities');
        Product = Product || entities.Product;
        ProductVariant = ProductVariant || entities.ProductVariant;
    }

    const scopeWhere = {
        shop_id: shopId,
        is_active: true,
        track_quantity: true,
    };

    const [products, inScopeTotal] = await Promise.all([
        Product.findAll({
            where: scopeWhere,
            attributes: ['id', 'quantity', 'low_stock_threshold', 'updated_at'],
            include: [{
                model: ProductVariant,
                as: 'product_variants',
                // required:false keeps the LEFT JOIN: products WITHOUT active
                // variants stay in scope and fall back to parent quantity.
                required: false,
                where: { is_active: true },
                attributes: ['id', 'quantity', 'is_active'],
            }],
            order: [['updated_at', 'DESC']],
            limit: STOCK_SCAN_CAP,
        }),
        Product.count({ where: scopeWhere }),
    ]);

    const rows = Array.isArray(products) ? products : [];
    let outOfStock = 0;
    let lowStock = 0;
    for (const product of rows) {
        const verdict = classifyStockExceptions(product);
        if (verdict === 'out_of_stock') outOfStock += 1;
        else if (verdict === 'low_stock') lowStock += 1;
    }

    const scanned = rows.length;
    return {
        outOfStock,
        lowStock,
        exceptions: outOfStock + lowStock,
        scanned,
        cap: STOCK_SCAN_CAP,
        coverageComplete: scanned < STOCK_SCAN_CAP && scanned === inScopeTotal,
        generated_at: new Date(now).toISOString(),
    };
}

module.exports = {
    getStockExceptions,
    computeEffectiveQuantity,
    classifyStockExceptions,
    STOCK_SCAN_CAP,
};
