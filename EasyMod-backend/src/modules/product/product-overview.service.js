'use strict';

const stockExceptionsService = require('./product-stock-exceptions.service');

/** Product counts plus the canonical bounded stock-exception projection. */
async function getOverview({ shopId, Product, getStockExceptions = stockExceptionsService.getStockExceptions } = {}) {
    if (!shopId) {
        throw new Error('product-overview: shopId is required (tenant scope)');
    }

    if (!Product) Product = require('../entities').Product;

    const [total, active, inactive, stock] = await Promise.all([
        Product.count({ where: { shop_id: shopId } }),
        Product.count({ where: { shop_id: shopId, is_active: true } }),
        Product.count({ where: { shop_id: shopId, is_active: false } }),
        getStockExceptions({ shopId }),
    ]);

    return {
        total: Number(total),
        active: Number(active),
        inactive: Number(inactive),
        low_stock: stock.lowStock,
        out_of_stock: stock.outOfStock,
        scanned: stock.scanned,
        cap: stock.cap,
        coverage_complete: stock.coverageComplete,
    };
}

module.exports = { getOverview };
