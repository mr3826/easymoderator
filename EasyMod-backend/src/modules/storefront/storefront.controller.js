'use strict';

const { AppError } = require('../../utils/AppError');
const storefrontService = require('./storefront.service');

const wrap = (handler) => async (req, res, next) => {
    try {
        await handler(req, res);
    } catch (error) {
        next(error);
    }
};

const merchantShopId = (req) => {
    const shopId = req.user?.shopId;
    if (!shopId) throw new AppError('Shop ID is required', 400, 'SHOP_REQUIRED');
    return shopId;
};

module.exports = {
    getMerchant: wrap(async (req, res) => {
        const data = await storefrontService.getMerchantStorefront(merchantShopId(req));
        res.json({ success: true, data });
    }),
    createMerchant: wrap(async (req, res) => {
        const data = await storefrontService.createMerchantStorefront(merchantShopId(req), req.body);
        res.status(201).json({ success: true, data });
    }),
    updateMerchant: wrap(async (req, res) => {
        const data = await storefrontService.updateMerchantStorefront(merchantShopId(req), req.body);
        res.json({ success: true, data });
    }),
    updateSettings: wrap(async (req, res) => {
        const data = await storefrontService.updateStorefrontSettings(merchantShopId(req), req.body);
        res.json({ success: true, data });
    }),
    updateProducts: wrap(async (req, res) => {
        const data = await storefrontService.replaceSelectedProducts(merchantShopId(req), req.body.selected_products);
        res.json({ success: true, data });
    }),
    publish: wrap(async (req, res) => {
        const data = await storefrontService.setPublished(merchantShopId(req), true);
        res.json({ success: true, data });
    }),
    unpublish: wrap(async (req, res) => {
        const data = await storefrontService.setPublished(merchantShopId(req), false);
        res.json({ success: true, data });
    }),
    getPublic: wrap(async (req, res) => {
        const storefront = req.storefront;
        await req.assertStorefrontEnabled(storefront.shop_id);
        res.json({ success: true, data: storefrontService.publicStorefrontDetails(storefront) });
    }),
    listPublicProducts: wrap(async (req, res) => {
        const storefront = req.storefront;
        await req.assertStorefrontEnabled(storefront.shop_id);
        res.json({ success: true, data: await storefrontService.listPublicProducts(storefront) });
    }),
    checkout: wrap(async (req, res) => {
        const data = await storefrontService.checkout(
            req.storefront,
            req.body,
            req.get('Idempotency-Key'),
            req.assertStorefrontEnabled,
        );
        res.status(201).json({ success: true, data });
    }),
};
