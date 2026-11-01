'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { Storefront, StorefrontProduct } = require('./storefront.entity');
const { Shop, Product, ProductVariant } = require('../entities');
const orderService = require('../order/order.service');

const BUYER_CONSENT_POLICY_VERSION = 'storefront-order-processing-v1';
const PUBLIC_PRODUCT_ATTRIBUTES = ['id', 'name', 'name_bn', 'description', 'description_bn', 'price', 'image_url'];
const PUBLIC_VARIANT_ATTRIBUTES = ['id', 'product_id', 'option_name', 'option_value', 'price', 'is_active'];

const plain = (record) => record?.toJSON ? record.toJSON() : record;
const listValue = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
    }
    return [];
};
const safePrice = (value) => {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : null;
};
const slugPart = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'shop';

const stableStringify = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const getPublicStorefrontRecord = async (storeSlug) => {
    if (typeof storeSlug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(storeSlug)) return null;
    const storefront = await Storefront.findOne({ where: { slug: storeSlug, is_published: true } });
    if (!storefront) return null;
    const shop = await Shop.findByPk(storefront.shop_id, { attributes: ['id', 'is_active'] });
    if (!shop || shop.is_active === false) return null;
    return storefront;
};

const serializeMerchantStorefront = async (storefront, transaction = null) => {
    const data = plain(storefront);
    const selected = await StorefrontProduct.findAll({
        where: { storefront_id: data.id },
        order: [['position', 'ASC'], ['created_at', 'ASC']],
        ...(transaction ? { transaction } : {}),
    });
    return {
        id: data.id,
        shop_id: data.shop_id,
        slug: data.slug,
        title: data.title,
        description: data.description,
        logo_url: data.logo_url,
        settings: data.settings || { delivery_fee: 0 },
        is_published: data.is_published === true,
        published_at: data.published_at,
        selected_products: selected.map((item) => ({
            product_id: item.product_id,
            variant_ids: listValue(item.variant_ids),
            position: item.position,
        })),
    };
};

const getMerchantStorefront = async (shopId) => {
    const storefront = await Storefront.findOne({ where: { shop_id: shopId } });
    return storefront ? serializeMerchantStorefront(storefront) : null;
};

const createMerchantStorefront = async (shopId, payload) => {
    const exists = await Storefront.findOne({ where: { shop_id: shopId } });
    if (exists) throw new AppError('This shop already has a storefront', 409, 'STOREFRONT_EXISTS');
    const slug = payload.slug || `${slugPart(payload.title)}-${crypto.randomBytes(12).toString('hex')}`;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
        throw new AppError('Storefront slug must contain lowercase letters, numbers, and hyphens', 400, 'INVALID_STOREFRONT_SLUG');
    }
    try {
        const storefront = await Storefront.create({
            shop_id: shopId,
            slug,
            title: payload.title,
            description: payload.description || null,
            logo_url: payload.logo_url || null,
            settings: { delivery_fee: 0 },
        });
        return serializeMerchantStorefront(storefront);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            if (error.fields?.shop_id) {
                throw new AppError('This shop already has a storefront', 409, 'STOREFRONT_EXISTS');
            }
            throw new AppError('The storefront slug is already in use', 409, 'STOREFRONT_SLUG_TAKEN');
        }
        throw error;
    }
};

const updateMerchantStorefront = async (shopId, payload) => {
    const storefront = await Storefront.findOne({ where: { shop_id: shopId } });
    if (!storefront) throw new AppError('Storefront not found', 404, 'STOREFRONT_NOT_FOUND');
    const updates = {};
    for (const field of ['title', 'description', 'logo_url', 'slug']) {
        if (payload[field] !== undefined) updates[field] = payload[field] || null;
    }
    if (updates.title === null) throw new AppError('Storefront title is required', 400, 'INVALID_STOREFRONT_TITLE');
    try {
        await storefront.update(updates);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            throw new AppError('The storefront slug is already in use', 409, 'STOREFRONT_SLUG_TAKEN');
        }
        throw error;
    }
    return serializeMerchantStorefront(storefront);
};

const updateStorefrontSettings = async (shopId, updates) => {
    const storefront = await Storefront.findOne({ where: { shop_id: shopId } });
    if (!storefront) throw new AppError('Storefront not found', 404, 'STOREFRONT_NOT_FOUND');
    const current = plain(storefront).settings || {};
    await storefront.update({ settings: { ...current, ...updates } });
    return { settings: plain(storefront).settings };
};

const validateSelectedProducts = async (shopId, selectedProducts, transaction) => {
    if (selectedProducts.length === 0) return [];
    const productIds = selectedProducts.map((item) => item.product_id).sort();
    const products = await Product.findAll({
        where: { id: { [Op.in]: productIds }, shop_id: shopId, is_active: true },
        order: [['id', 'ASC']],
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (products.length !== new Set(productIds).size) {
        throw new AppError('Every selected product must be active and belong to this shop', 400, 'INVALID_STOREFRONT_PRODUCT');
    }
    const variants = await ProductVariant.findAll({
        where: { product_id: { [Op.in]: productIds }, is_active: true },
        order: [['product_id', 'ASC'], ['id', 'ASC']],
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const activeByProduct = new Map();
    for (const variant of variants) {
        if (!activeByProduct.has(variant.product_id)) activeByProduct.set(variant.product_id, new Set());
        activeByProduct.get(variant.product_id).add(variant.id);
    }
    return selectedProducts.map((selection, position) => {
        const activeIds = activeByProduct.get(selection.product_id) || new Set();
        const requestedIds = selection.variant_ids === undefined
            ? [...activeIds]
            : selection.variant_ids;
        if (activeIds.size > 0 && requestedIds.length === 0) {
            throw new AppError('Select at least one active variant for each variant product', 400, 'INVALID_STOREFRONT_VARIANTS');
        }
        if (activeIds.size === 0 && requestedIds.length > 0) {
            throw new AppError('A selected variant does not belong to an active variant product', 400, 'INVALID_STOREFRONT_VARIANTS');
        }
        if (requestedIds.some((variantId) => !activeIds.has(variantId))) {
            throw new AppError('Every selected variant must be active and belong to its selected product', 400, 'INVALID_STOREFRONT_VARIANTS');
        }
        return {
            product_id: selection.product_id,
            variant_ids: requestedIds,
            position,
        };
    });
};

const replaceSelectedProducts = async (shopId, selections) => sequelize.transaction(async (transaction) => {
    const query = { where: { shop_id: shopId }, transaction };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const storefront = await Storefront.findOne(query);
    if (!storefront) throw new AppError('Storefront not found', 404, 'STOREFRONT_NOT_FOUND');
    const rows = await validateSelectedProducts(shopId, selections, transaction);
    await StorefrontProduct.destroy({ where: { storefront_id: storefront.id }, transaction });
    if (rows.length) {
        await StorefrontProduct.bulkCreate(rows.map((row) => ({ storefront_id: storefront.id, ...row })), { transaction });
    }
    return serializeMerchantStorefront(storefront, transaction);
});

const setPublished = async (shopId, isPublished) => sequelize.transaction(async (transaction) => {
    const query = { where: { shop_id: shopId }, transaction };
    if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    const storefront = await Storefront.findOne(query);
    if (!storefront) throw new AppError('Storefront not found', 404, 'STOREFRONT_NOT_FOUND');
    if (isPublished) {
        const selections = await StorefrontProduct.findAll({
            where: { storefront_id: storefront.id },
            order: [['position', 'ASC']],
            transaction,
            ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        if (selections.length === 0) {
            throw new AppError('Select at least one active product before publishing', 409, 'STOREFRONT_CATALOG_EMPTY');
        }
        const normalized = await validateSelectedProducts(shopId, selections.map((item) => ({
            product_id: item.product_id,
            variant_ids: listValue(item.variant_ids),
        })), transaction);
        if (normalized.length !== selections.length) {
            throw new AppError('Storefront catalog is not publishable', 409, 'STOREFRONT_CATALOG_INVALID');
        }
    }
    await storefront.update({
        is_published: isPublished,
        published_at: isPublished ? new Date() : null,
    }, { transaction });
    return serializeMerchantStorefront(storefront, transaction);
});

const publicStorefrontDetails = (storefront) => {
    const data = plain(storefront);
    const settings = data.settings || {};
    return {
        slug: data.slug,
        title: data.title,
        description: data.description,
        logo_url: data.logo_url,
        settings: {
            delivery_fee: Number.isFinite(Number(settings.delivery_fee)) ? Number(settings.delivery_fee) : 0,
            delivery_note: typeof settings.delivery_note === 'string' ? settings.delivery_note : null,
        },
    };
};

const listPublicProducts = async (storefront) => {
    const selections = await StorefrontProduct.findAll({
        where: { storefront_id: storefront.id },
        order: [['position', 'ASC'], ['created_at', 'ASC']],
    });
    if (!selections.length) return [];
    const productIds = selections.map((item) => item.product_id);
    const [products, variants] = await Promise.all([
        Product.findAll({
            where: { id: { [Op.in]: productIds }, shop_id: storefront.shop_id, is_active: true },
            attributes: PUBLIC_PRODUCT_ATTRIBUTES,
        }),
        ProductVariant.findAll({
            where: { product_id: { [Op.in]: productIds }, is_active: true },
            attributes: PUBLIC_VARIANT_ATTRIBUTES,
            order: [['product_id', 'ASC'], ['created_at', 'ASC']],
        }),
    ]);
    const productById = new Map(products.map((record) => [record.id, plain(record)]));
    const variantsByProduct = new Map();
    for (const record of variants) {
        const item = plain(record);
        if (!variantsByProduct.has(item.product_id)) variantsByProduct.set(item.product_id, []);
        variantsByProduct.get(item.product_id).push(item);
    }

    const result = [];
    for (const selection of selections) {
        const product = productById.get(selection.product_id);
        if (!product) continue;
        const selectedVariantIds = new Set(listValue(selection.variant_ids));
        const activeVariants = variantsByProduct.get(product.id) || [];
        if (activeVariants.length > 0) {
            const publicVariants = activeVariants
                .filter((variant) => selectedVariantIds.has(variant.id))
                .map((variant) => {
                    const rawPrice = variant.price === null || variant.price === undefined
                        ? product.price
                        : variant.price;
                    return {
                        id: variant.id,
                        option_name: variant.option_name,
                        option_value: variant.option_value,
                        price: safePrice(rawPrice),
                    };
                })
                .filter((variant) => variant.price !== null);
            if (!publicVariants.length) continue;
            result.push({
                id: product.id,
                name: product.name,
                name_bn: product.name_bn || null,
                description: product.description || null,
                description_bn: product.description_bn || null,
                image_url: product.image_url || null,
                variants: publicVariants,
            });
            continue;
        }
        if (selectedVariantIds.size > 0) continue;
        const price = safePrice(product.price);
        if (price === null) continue;
        result.push({
            id: product.id,
            name: product.name,
            name_bn: product.name_bn || null,
            description: product.description || null,
            description_bn: product.description_bn || null,
            image_url: product.image_url || null,
            price,
        });
    }
    return result;
};

const validateSelectionWithinOrder = (storefrontId) => async ({ transaction, items }) => {
    const sharedLock = transaction?.LOCK?.SHARE || transaction?.LOCK?.UPDATE;
    const storefrontQuery = {
        where: { id: storefrontId, is_published: true },
        transaction,
    };
    if (sharedLock) storefrontQuery.lock = sharedLock;
    const currentStorefront = await Storefront.findOne(storefrontQuery);
    if (!currentStorefront) throw new AppError('Storefront is not available', 404, 'STOREFRONT_UNAVAILABLE');
    const selections = await StorefrontProduct.findAll({
        where: { storefront_id: storefrontId },
        transaction,
        ...(sharedLock ? { lock: sharedLock } : {}),
    });
    const byProduct = new Map(selections.map((selection) => [selection.product_id, new Set(listValue(selection.variant_ids))]));
    for (const item of items) {
        if (!byProduct.has(item.product_id)) {
            throw new AppError('A product in this order is not listed in the storefront', 400, 'STOREFRONT_PRODUCT_NOT_SELECTED');
        }
        const selectedVariantIds = byProduct.get(item.product_id);
        if (item.variant_id ? !selectedVariantIds.has(item.variant_id) : selectedVariantIds.size > 0) {
            throw new AppError('Choose a listed product variant before checkout', 400, 'STOREFRONT_VARIANT_NOT_SELECTED');
        }
    }
};

const validateIdempotencyKey = (key) => {
    if (typeof key !== 'string' || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
        throw new AppError('A valid Idempotency-Key header is required', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    }
};

const checkout = async (storefront, payload, idempotencyKey, assertEnabled) => {
    validateIdempotencyKey(idempotencyKey);
    if (typeof assertEnabled === 'function') await assertEnabled(storefront.shop_id);
    const safeItems = payload.items.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id || null,
        quantity: item.quantity,
    }));
    const hashPayload = {
        storefront_id: storefront.id,
        items: safeItems,
        customer_name: payload.customer_name,
        customer_phone: payload.customer_phone,
        delivery_address: payload.delivery_address,
        consent: payload.consent,
    };
    const payloadHash = crypto.createHash('sha256').update(stableStringify(hashPayload)).digest('hex');
    const settings = plain(storefront).settings || {};
    const deliveryFee = Number(settings.delivery_fee ?? 0);
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 50000) {
        throw new AppError('Storefront delivery fee is not configured correctly', 409, 'STOREFRONT_SETTINGS_INVALID');
    }
    const order = await orderService.createStorefrontCodOrder(storefront.shop_id, {
        items: safeItems,
        customer_name: payload.customer_name,
        customer_phone: payload.customer_phone,
        delivery_address: payload.delivery_address,
        delivery_fee: deliveryFee,
        discount: 0,
        tax: 0,
        order_status: 'confirmed',
        payment_status: 'unpaid',
        fulfillment_status: 'unfulfilled',
        payment_method: 'COD',
        channel: 'storefront',
        metadata: {
            storefront: {
                slug: storefront.slug,
                idempotency_payload_hash: payloadHash,
                buyer_consent: {
                    accepted: true,
                    policy_version: BUYER_CONSENT_POLICY_VERSION,
                    accepted_at: new Date().toISOString(),
                },
            },
        },
    }, idempotencyKey, {
        payloadHash,
        validateSelection: validateSelectionWithinOrder(storefront.id),
    });
    return {
        order_id: order.id,
        order_number: order.order_number,
        total: Number(order.total),
        payment_status: order.payment_status,
        order_status: order.order_status,
    };
};

module.exports = {
    BUYER_CONSENT_POLICY_VERSION,
    getPublicStorefrontRecord,
    getMerchantStorefront,
    createMerchantStorefront,
    updateMerchantStorefront,
    updateStorefrontSettings,
    replaceSelectedProducts,
    setPublished,
    publicStorefrontDetails,
    listPublicProducts,
    checkout,
};
