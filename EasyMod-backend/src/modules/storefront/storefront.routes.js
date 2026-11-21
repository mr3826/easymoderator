'use strict';

const net = require('net');
const express = require('express');
const expressRateLimit = require('express-rate-limit');
const { rateLimit } = expressRateLimit;
const { RedisStore } = require('rate-limit-redis');
const config = require('../../config/config');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { requireOwner } = require('../../middleware/shop-permission.middleware');
const { validate } = require('../helpers');
const { AppError } = require('../../utils/AppError');
const controller = require('./storefront.controller');
const validator = require('./storefront.validator');
const service = require('./storefront.service');
const { createStorefrontGate } = require('./storefront.gates');

const ROUTE_CONTRACT = Object.freeze([
    'GET /manage',
    'POST /manage',
    'PATCH /manage',
    'PUT /manage/settings',
    'PUT /manage/products',
    'POST /manage/publish',
    'POST /manage/unpublish',
    'GET /public/:slug',
    'GET /public/:slug/products',
    'POST /public/:slug/checkout',
]);

function buildRateLimitStore(prefix) {
    if (config.env === 'test') return undefined;
    const { rateLimitRedis } = require('../../config/redis');
    if (!rateLimitRedis || rateLimitRedis._isMemoryFallback === true
        || typeof rateLimitRedis.call !== 'function') return undefined;
    return new RedisStore({
        prefix,
        sendCommand: (...args) => rateLimitRedis.call(...args),
    });
}

function expandIpv6(ip) {
    const clean = ip.split('%')[0].toLowerCase();
    const halves = clean.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    return [...left, ...Array(missing).fill('0'), ...right]
        .slice(0, 8)
        .map((group) => parseInt(group, 16) || 0);
}

function normalizeRateLimitIp(rawIp, ipv6Subnet = 56) {
    const candidate = typeof rawIp === 'string' && rawIp.trim() ? rawIp.trim() : '0.0.0.0';
    if (typeof expressRateLimit.ipKeyGenerator === 'function') {
        return expressRateLimit.ipKeyGenerator(candidate, ipv6Subnet);
    }
    const stripped = candidate.startsWith('::ffff:') ? candidate.slice(7) : candidate;
    if (net.isIPv4(stripped)) return stripped;
    if (net.isIPv6(candidate)) {
        const groups = expandIpv6(candidate);
        if (!groups) return candidate;
        let remaining = ipv6Subnet;
        const masked = groups.map((group) => {
            if (remaining >= 16) { remaining -= 16; return group; }
            if (remaining <= 0) return 0;
            const mask = (0xffff << (16 - remaining)) & 0xffff;
            remaining = 0;
            return group & mask;
        });
        return `${masked.map((g) => g.toString(16)).join(':')}/${ipv6Subnet}`;
    }
    return 'unknown';
}

const publicIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildRateLimitStore('rl:storefront-ip:'),
    passOnStoreError: false,
});
const publicBrowseLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    keyGenerator: (req) => `${String(req.params?.slug || 'invalid').toLowerCase().slice(0, 80)}:${normalizeRateLimitIp(req.ip, 56)}`,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildRateLimitStore('rl:storefront-browse:'),
    passOnStoreError: false,
});
const publicCheckoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => `${String(req.params?.slug || 'invalid').toLowerCase().slice(0, 80)}:${normalizeRateLimitIp(req.ip, 56)}`,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildRateLimitStore('rl:storefront-checkout:'),
    passOnStoreError: false,
});

function createStorefrontRouter(gateDependencies = {}) {
    const router = express.Router();
    const assertStorefrontEnabled = gateDependencies.assertStorefrontEnabled
        || createStorefrontGate(gateDependencies);

    router.use('/manage', authenticate, verifyShopAccess, requireOwner, async (req, res, next) => {
        try {
            await assertStorefrontEnabled(req.user?.shopId);
            next();
        } catch (error) {
            next(error);
        }
    });

    const resolvePublishedStorefront = async (req, res, next) => {
        try {
            const storefront = await service.getPublicStorefrontRecord(req.params.slug);
            if (!storefront) throw new AppError('Storefront not found', 404, 'STOREFRONT_NOT_FOUND');
            req.storefront = storefront;
            req.assertStorefrontEnabled = assertStorefrontEnabled;
            next();
        } catch (error) {
            next(error);
        }
    };

    router.get('/manage', controller.getMerchant);
    router.post('/manage', validate(validator.create), controller.createMerchant);
    router.patch('/manage', validate(validator.update), controller.updateMerchant);
    router.put('/manage/settings', validate(validator.settings), controller.updateSettings);
    router.put('/manage/products', validate(validator.products), controller.updateProducts);
    router.post('/manage/publish', controller.publish);
    router.post('/manage/unpublish', controller.unpublish);

    router.get('/public/:slug', publicIpLimiter, publicBrowseLimiter, validate(validator.slug), resolvePublishedStorefront, controller.getPublic);
    router.get('/public/:slug/products', publicIpLimiter, publicBrowseLimiter, validate(validator.slug), resolvePublishedStorefront, controller.listPublicProducts);
    router.post('/public/:slug/checkout', publicIpLimiter, publicCheckoutLimiter, validate(validator.checkout), resolvePublishedStorefront, controller.checkout);
    return router;
}

const router = createStorefrontRouter();
router.createStorefrontRouter = createStorefrontRouter;
router.routeContract = ROUTE_CONTRACT;

module.exports = router;
