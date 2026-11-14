'use strict';

/**
 * Third-party brand tokens the merchant landing page must never render
 * (task C2 / B6). Facebook Page / Messenger are intentionally NOT here: naming
 * the supported channel is allowed. Every entry needs a reason (ADR-0002): this
 * is a maintained blocklist, edited deliberately, never a catch-all.
 */

const { deepFreeze } = require('../../../EasyMod-backend/src/modules/commercial/commercial.contract');

const brand = (id, name, description) => Object.freeze({
    id,
    source: `\\b${name}\\b`,
    flags: 'gi',
    reason: description,
});

const BRAND_BLOCKLIST = deepFreeze([
    brand('brand.pathao', 'pathao', 'third-party courier brand — landing must not name couriers'),
    brand('brand.steadfast', 'steadfast', 'third-party courier brand — landing must not name couriers'),
    brand('brand.redx', 'redx', 'third-party courier brand — landing must not name couriers'),
    brand('brand.bkash', 'bkash', 'third-party payment brand — landing must not name payment providers'),
    brand('brand.nagad', 'nagad', 'third-party payment brand — landing must not name payment providers'),
    brand('brand.stripe', 'stripe', 'third-party payment brand'),
    brand('brand.paypal', 'paypal', 'third-party payment brand'),
    brand('brand.shopify', 'shopify', 'platform competitor'),
    brand('brand.woocommerce', 'woocommerce', 'platform competitor'),
    brand('brand.whatsapp', 'whatsapp', 'unsupported channel — landing must not imply it'),
    brand('brand.telegram', 'telegram', 'unsupported channel — landing must not imply it'),
    brand('brand.instagram', 'instagram', 'unsupported platform — landing must not name it'),
    brand('brand.daraz', 'daraz', 'platform competitor'),
    brand('brand.amazon', 'amazon', 'platform competitor'),
]);

module.exports = { BRAND_BLOCKLIST };