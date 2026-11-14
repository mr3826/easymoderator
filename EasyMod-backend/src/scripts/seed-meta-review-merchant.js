'use strict';

const fs = require('fs/promises');
const path = require('path');
const { v5: uuidv5 } = require('uuid');
const { Op } = require('sequelize');
const { joinOrigin, resolvePublicAssetOrigin } = require('../config/origins');
const {
    PlanCode,
    InvoiceType,
    RECURRING_INVOICE_TYPES,
    getTierByCode,
} = require('../modules/subscription/subscription.plans');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
} = require('../modules/commercial/commercial.contract');

const SEED_KEY = 'meta-review-merchant-v1';
const SEED_CONFIRMATION = 'META-REVIEW-SEED';
const EMAIL = 'merchant@easymod.tech';
const MERCHANT_NAME = 'Meta App Review Merchant';
const TENANT_NAME = 'EasyModerator Meta Review Tenant';
const BUSINESS_NAME = 'EasyModerator Review Store';
const SHOP_CODE = 'META-REVIEW-01';
const NAMESPACE = '06a7e6b9-7d4c-4e75-9a34-91fd3f8b7f11';
const INVOICE_TYPE = InvoiceType.DELIVERED_ORDER;
const PAYMENT_METHOD = 'manual_test_reconciliation';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 10_000;
const MEDIA_TOTAL_TIMEOUT_MS = 15_000;
const MEDIA_MAX_REDIRECTS = 2;
const MEDIA_HOSTS = Object.freeze(['unsplash.com', 'images.unsplash.com']);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

const PERIODS = Object.freeze([
    Object.freeze({
        key: '2026-09',
        display: 'September 2026',
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
    }),
    Object.freeze({
        key: '2026-10',
        display: 'October 2026',
        start: '2026-10-01T00:00:00.000Z',
        end: '2026-11-01T00:00:00.000Z',
    }),
]);

const BUSINESS_INFO = Object.freeze({
    shopName: BUSINESS_NAME,
    description: 'Clothing and fashion store for Meta App Review.',
    supportEmail: EMAIL,
    address: 'Bangladesh',
    country: 'Bangladesh',
    currency: 'BDT',
    businessType: 'retail',
    businessCategory: 'Clothing/Fashion',
    openingHours: '09:00-22:00',
    deliveryAreas: ['Bangladesh'],
    paymentMethods: ['COD'],
});

const PRODUCTS = Object.freeze([
    Object.freeze({
        sku: 'META-TSHIRT-001',
        name: 'Premium Cotton T-Shirt – White',
        category: "Men's Clothing / T-Shirt",
        price: 690,
        quantity: 40,
        color: 'White',
        sizes: ['S', 'M', 'L', 'XL'],
        material: 'Cotton',
        description: 'Soft breathable cotton crew-neck T-shirt for everyday wear. Comfortable regular fit and suitable for casual use.',
        keywords: ['white t-shirt', 'cotton t-shirt', 'mens tshirt', 'সাদা টি-শার্ট', 'কটন টি-শার্ট'],
        imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?fm=jpg&fit=crop&w=800&q=60',
        style: 'crew-neck regular-fit casual',
    }),
    Object.freeze({
        sku: 'META-KURTI-002',
        name: "Women's Floral Cotton Kurti – Pink",
        category: "Women's Clothing / Kurti",
        price: 1490,
        quantity: 25,
        color: 'Pink',
        sizes: ['M', 'L', 'XL', 'XXL'],
        material: 'Cotton',
        description: "Comfortable floral printed women's kurti suitable for casual, office and everyday wear.",
        keywords: ['pink kurti', 'floral kurti', 'women kurti', 'cotton kurti', 'গোলাপি কুর্তি', 'মহিলা কুর্তি'],
        imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?fm=jpg&fit=crop&w=800&q=60',
        style: 'floral printed casual office',
    }),
    Object.freeze({
        sku: 'META-JEANS-003',
        name: 'Classic Blue Denim Jeans',
        category: "Men's Clothing / Jeans",
        price: 1290,
        quantity: 30,
        color: 'Blue',
        sizes: ['28', '30', '32', '34', '36'],
        material: 'Denim',
        description: 'Classic blue denim jeans with comfortable everyday fit and durable denim construction.',
        keywords: ['blue jeans', 'denim jeans', 'mens jeans', 'নীল জিন্স', 'ডেনিম জিন্স'],
        imageUrl: 'https://images.unsplash.com/photo-1542272604-787c3835535d?fm=jpg&fit=crop&w=800&q=60',
        style: 'classic everyday fit',
    }),
    Object.freeze({
        sku: 'META-SHIRT-004',
        name: 'Essential Casual Shirt – White',
        category: "Men's Clothing / Shirt",
        price: 1190,
        quantity: 35,
        color: 'White',
        sizes: ['M', 'L', 'XL', 'XXL'],
        material: 'Cotton Blend',
        description: 'Clean and versatile casual shirt designed for everyday and smart-casual use.',
        keywords: ['white shirt', 'casual shirt', 'mens shirt', 'সাদা শার্ট', 'ক্যাজুয়াল শার্ট'],
        imageUrl: 'https://images.unsplash.com/photo-1603252110481-7ba873bf42ab?fm=jpg&fit=crop&w=800&q=60',
        style: 'clean smart-casual',
    }),
    Object.freeze({
        sku: 'META-HOODIE-005',
        name: 'Everyday Pullover Hoodie – White',
        category: 'Unisex Clothing / Hoodie',
        price: 1590,
        quantity: 20,
        color: 'White',
        sizes: ['M', 'L', 'XL'],
        material: 'Cotton Blend',
        description: 'Comfortable pullover hoodie for casual everyday wear, with hood and relaxed styling.',
        keywords: ['hoodie', 'white hoodie', 'pullover hoodie', 'unisex hoodie', 'হুডি', 'সাদা হুডি'],
        searchAliases: ['হুডির'],
        imageUrl: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?fm=jpg&fit=crop&w=800&q=60',
        style: 'relaxed pullover',
    }),
]);

const GROUNDING_QUERIES = Object.freeze([
    Object.freeze({ query: 'সাদা টি-শার্টের দাম কত?', sku: 'META-TSHIRT-001' }),
    Object.freeze({ query: 'গোলাপি কুর্তি আছে?', sku: 'META-KURTI-002' }),
    Object.freeze({ query: '৩২ সাইজের জিন্স আছে?', sku: 'META-JEANS-003' }),
    Object.freeze({ query: 'সাদা শার্ট আছে?', sku: 'META-SHIRT-004' }),
    Object.freeze({ query: 'হুডির দাম কত?', sku: 'META-HOODIE-005' }),
    Object.freeze({ query: 'Do you have a white casual shirt?', sku: 'META-SHIRT-004' }),
]);

const REVIEW_SEED_MARKER = Object.freeze({
    seed_key: SEED_KEY,
    purpose: 'META_APP_REVIEW',
    version: 1,
});

const PAYMENT_METADATA = Object.freeze({
    seed_key: SEED_KEY,
    purpose: 'META_APP_REVIEW',
    payment_source: 'INTERNAL_SEED',
    reference: 'META_APP_REVIEW_SEED',
    plan_code: PlanCode.MERCHANT,
    contractVersion: COMMERCIAL_CONTRACT_VERSION,
    no_real_money_collected: true,
});

const asPlainObject = (value, label) => {
    if (value === null || value === undefined) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} is not a JSON object; refusing to overwrite it`);
    }
    return value;
};

const cloneJson = (value) => {
    if (Array.isArray(value)) return value.map(cloneJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
    }
    return value;
};

const stableId = (scope) => uuidv5(`${SEED_KEY}:${scope}`, NAMESPACE);

const conflict = (message) => new Error(`Meta review seed conflict: ${message}`);

const readSeedMarker = (value, label) => {
    if (value === undefined || value === null) return null;
    const marker = asPlainObject(value, label);
    if (marker.seed_key !== SEED_KEY) throw conflict(`${label} is owned by another workflow`);
    return marker;
};

const buildShopSettings = (currentSettings) => {
    const current = cloneJson(asPlainObject(currentSettings, 'shops.settings'));
    const existingMarker = readSeedMarker(current.meta_review_seed, 'shops.settings.meta_review_seed');
    const businessInfo = asPlainObject(current.businessInfo, 'shops.settings.businessInfo');
    const ai = asPlainObject(current.ai, 'shops.settings.ai');

    return {
        ...current,
        businessInfo: { ...businessInfo, ...cloneJson(BUSINESS_INFO) },
        ai: {
            ...ai,
            // Business-level canonical mode. Do not create Page-level AI data.
            automation_mode: 'MANUAL',
            auto_reply_enabled: false,
        },
        meta_review_seed: { ...existingMarker, ...REVIEW_SEED_MARKER },
    };
};

const getPassword = (env) => {
    const password = env.META_REVIEW_MERCHANT_PASSWORD;
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('META_REVIEW_MERCHANT_PASSWORD is required and is never supplied by a source default');
    }
    return password;
};

const assertProductionConfirmation = (env) => {
    if (env.NODE_ENV === 'production' && env.META_REVIEW_SEED_CONFIRMATION !== SEED_CONFIRMATION) {
        throw new Error(`Production seed requires META_REVIEW_SEED_CONFIRMATION=${SEED_CONFIRMATION}`);
    }
};

const assertProductionDatabase = async (sequelize, env) => {
    if (env.NODE_ENV !== 'production') return;
    const expectedName = env.META_REVIEW_EXPECTED_DB_NAME || 'easymod_prod';
    const [rows] = await sequelize.query('SELECT current_database() AS database_name');
    if (rows?.[0]?.database_name !== expectedName) {
        throw new Error('Production seed refused an unexpected database');
    }
};

const getPublicAssetOrigin = (env) => {
    const origin = resolvePublicAssetOrigin(null, env);
    if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
        throw new Error('Production seed requires an HTTPS public asset origin');
    }
    return origin;
};

const lockSeedTransaction = async (sequelize, transaction) => {
    if (typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') return;
    await sequelize.query(
        "SELECT pg_advisory_xact_lock(hashtext('easymod:meta-review-merchant-seed'))",
        { transaction },
    );
};

const ensureAccountFlags = async ({ sequelize, user, transaction }) => {
    const enabledValue = typeof sequelize.getDialect === 'function'
        && sequelize.getDialect() === 'postgres'
        ? 'TRUE'
        : '1';
    // The legacy users table retains these account-state columns even though the
    // current User entity does not expose them. Keep the seed scoped and update
    // them with a parameterized statement rather than relying on ignored model
    // attributes or database defaults.
    await sequelize.query(
        `UPDATE users SET is_verified = ${enabledValue}, is_active = ${enabledValue} WHERE id = :userId`,
        { replacements: { userId: user.id }, transaction },
    );
    user.is_verified = true;
    user.is_active = true;
};

const ensureUser = async ({ User, sequelize, transaction, password, hashPassword, comparePassword }) => {
    const email = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres'
        ? { [Op.iLike]: EMAIL }
        : EMAIL;
    const existingUsers = typeof User.findAll === 'function'
        ? await User.findAll({ where: { email }, transaction })
        : [await User.findOne({ where: { email }, transaction })].filter(Boolean);
    if (existingUsers.length > 1) throw conflict('multiple users match the review email');
    const existing = existingUsers[0] || null;
    if (existing) {
        if (existing.platform_role !== null && existing.platform_role !== undefined
            && String(existing.platform_role).trim() !== '') {
            throw conflict('the requested email already has a platform role');
        }
        if (asPlainObject(existing.settings, 'users.settings').totp_enabled === true) {
            throw conflict('the requested email has two-factor authentication enabled');
        }

        const updates = {};
        let passwordMatches = false;
        try {
            passwordMatches = await comparePassword(password, existing.password);
        } catch (_) {
            passwordMatches = false;
        }
        if (!passwordMatches) {
            updates.password = await hashPassword(password);
            updates.refresh_token = null;
            updates.token_version = Math.max(1, Number(existing.token_version) || 1) + 1;
        }
        if (existing.email !== EMAIL) updates.email = EMAIL;
        if (existing.full_name !== MERCHANT_NAME) updates.full_name = MERCHANT_NAME;
        if (existing.is_verified !== true) updates.is_verified = true;
        if (existing.is_active !== true) updates.is_active = true;
        if (Object.keys(updates).length > 0) await existing.update(updates, { transaction });
        return {
            user: existing,
            created: false,
            passwordChanged: Object.prototype.hasOwnProperty.call(updates, 'password'),
        };
    }

    const user = await User.create({
        id: stableId('user'),
        email: EMAIL,
        password: await hashPassword(password),
        full_name: MERCHANT_NAME,
        platform_role: null,
        is_verified: true,
        is_active: true,
        token_version: 1,
    }, { transaction });
    return { user, created: true, passwordChanged: true };
};

const ensureTenant = async ({ Tenant, transaction }) => {
    let tenant = await Tenant.findOne({ where: { id: stableId('tenant') }, transaction });
    if (!tenant) tenant = await Tenant.findOne({ where: { name: TENANT_NAME }, transaction });

    if (tenant) {
        const marker = readSeedMarker(asPlainObject(tenant.settings, 'tenants.settings').meta_review_seed, 'tenants.settings.meta_review_seed');
        if (!marker) throw conflict('the deterministic review tenant name is already in use');
        await tenant.update({ name: TENANT_NAME, is_active: true }, { transaction });
        return tenant;
    }

    return Tenant.create({
        id: stableId('tenant'),
        name: TENANT_NAME,
        is_active: true,
        settings: { meta_review_seed: REVIEW_SEED_MARKER },
    }, { transaction });
};

const ensureShop = async ({ Shop, tenant, transaction }) => {
    let shop = await Shop.findOne({ where: { id: stableId('shop') }, transaction });
    if (!shop) shop = await Shop.findOne({ where: { unique_code: SHOP_CODE }, transaction });

    if (shop) {
        const settings = asPlainObject(shop.settings, 'shops.settings');
        const marker = readSeedMarker(settings.meta_review_seed, 'shops.settings.meta_review_seed');
        if (!marker) throw conflict(`shop ${SHOP_CODE} exists without this seed marker`);
        if (String(shop.tenant_id) !== String(tenant.id)) {
            throw conflict(`shop ${SHOP_CODE} belongs to another tenant`);
        }
        await shop.update({
            unique_code: SHOP_CODE,
            tenant_id: tenant.id,
            shop_name: BUSINESS_NAME,
            name: BUSINESS_NAME,
            is_active: true,
            timezone: 'Asia/Dhaka',
            settings: buildShopSettings(settings),
        }, { transaction });
        return { shop, created: false };
    }

    const shopSettings = buildShopSettings({});
    shop = await Shop.create({
        id: stableId('shop'),
        unique_code: SHOP_CODE,
        tenant_id: tenant.id,
        shop_name: BUSINESS_NAME,
        name: BUSINESS_NAME,
        is_active: true,
        timezone: 'Asia/Dhaka',
        settings: shopSettings,
    }, { transaction });
    return { shop, created: true };
};

const ensureOwnerMembership = async ({ UserShop, user, shop, transaction }) => {
    const memberships = await UserShop.findAll({ where: { shop_id: shop.id }, transaction });
    const userMemberships = await UserShop.findAll({ where: { user_id: user.id }, transaction });
    const activeOtherShops = userMemberships.filter((item) => (
        String(item.shop_id) !== String(shop.id) && item.is_active === true
    ));
    if (activeOtherShops.length > 0) {
        throw conflict('the requested merchant email already has another active shop');
    }
    const targetMemberships = memberships.filter((item) => String(item.user_id) === String(user.id));
    if (targetMemberships.length > 1) throw conflict('duplicate owner memberships exist for the review shop');

    const otherActiveMembers = memberships.filter((item) => (
        String(item.user_id) !== String(user.id) && item.is_active === true
    ));
    if (otherActiveMembers.length > 0) {
        throw conflict('the review shop has another active member and will not be taken over');
    }

    if (targetMemberships[0]) {
        await targetMemberships[0].update({ role: 'owner', is_active: true }, { transaction });
        return targetMemberships[0];
    }

    return UserShop.create({
        id: stableId('user-shop'),
        user_id: user.id,
        shop_id: shop.id,
        role: 'owner',
        is_active: true,
    }, { transaction });
};

const planSubscriptionValues = (subscription, { initializeUsage, periodStart, periodEnd }) => {
    const tier = getTierByCode(PlanCode.MERCHANT);
    if (!tier || tier.billingModel !== 'per_order') {
        throw new Error('The active merchant tier is not the delivered-order model');
    }

    const values = {
        plan_code: tier.code,
        plan_name: tier.name,
        plan_price: 0,
        billing_cycle: 'monthly',
        billing_model: tier.billingModel,
        per_order_charge_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
        partner_orders_this_week: 0,
        partner_pending_invoice_amount: 0,
        status: 'active',
        conversations_limit: tier.conversationsLimit,
        orders_limit: tier.ordersLimit,
        products_limit: tier.productsLimit,
        features: cloneJson(tier.features),
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_date: periodEnd,
        usage_reset_at: null,
        trial_ends_at: null,
        cancelled_at: null,
    };

    if (initializeUsage) {
        Object.assign(values, {
            conversations_used: 0,
            orders_used: 0,
            products_used: 0,
            extra_conversations: 0,
            extra_charge: 0,
            topup_balance: 0,
            threshold_debt: 0,
        });
    } else {
        const debt = Number(subscription.threshold_debt) || 0;
        const extraCharge = Number(subscription.extra_charge) || 0;
        const extraConversations = Number(subscription.extra_conversations) || 0;
        if (debt !== 0 || extraCharge !== 0 || extraConversations !== 0) {
            throw conflict('existing subscription has usage debt and will not be reset');
        }
    }

    return values;
};

const ensureSubscription = async ({ Subscription, Invoice, shop, transaction }) => {
    const periodStart = new Date('2026-09-01T00:00:00.000Z');
    const periodEnd = new Date('2026-11-01T00:00:00.000Z');
    let subscription = await Subscription.findOne({ where: { shop_id: shop.id }, transaction });

    if (subscription) {
        // Re-runs must recognize their own MERCHANT/per_order row. Only a
        // foreign Partner or per_order subscription is a conflict.
        const seedOwned = String(subscription.id) === String(stableId('subscription'));
        const legacyPartner = String(subscription.plan_code || '').toUpperCase() === PlanCode.PARTNER;
        if (!seedOwned && (legacyPartner || subscription.billing_model === 'per_order')) {
            throw conflict('the review shop already has an incompatible per-order subscription');
        }
        const invoices = await Invoice.findAll({ where: { subscription_id: subscription.id }, transaction });
        const billingStateConflict = invoices.filter((invoice) => (
            ['paid', 'pending', 'overdue'].includes(invoice.status)
            && (!invoiceIsSeedOwned(invoice)
                || invoice.transaction_id || invoice.payment_id || invoice.bkash_url)
        ));
        if (billingStateConflict.length > 0) {
            throw conflict('existing subscription billing state is not owned by this seed');
        }
        await subscription.update(
            planSubscriptionValues(subscription, { initializeUsage: false, periodStart, periodEnd }),
            { transaction },
        );
        return { subscription, created: false };
    }

    subscription = await Subscription.create({
        id: stableId('subscription'),
        shop_id: shop.id,
        ...planSubscriptionValues({}, { initializeUsage: true, periodStart, periodEnd }),
    }, { transaction });
    return { subscription, created: true };
};

const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const invoiceMatchesPeriod = (invoice, period) => {
    const billingPeriod = String(invoice.billing_period || '').toLowerCase();
    return billingPeriod === period.key
        || billingPeriod === period.display.toLowerCase()
        || parseDate(invoice.billing_period_start) === period.start;
};

const invoiceIsSeedOwned = (invoice) => {
    const metadata = asPlainObject(invoice.metadata, 'invoices.metadata');
    return metadata.seed_key === SEED_KEY;
};

const ensureInvoice = async ({ Invoice, subscription, shop, period, now, transaction }) => {
    const invoices = await Invoice.findAll({ where: { subscription_id: subscription.id }, transaction });
    const invoiceNumber = `META-REVIEW-${period.key.replace('-', '')}`;
    const matches = invoices.filter((invoice) => (
        invoiceMatchesPeriod(invoice, period) || invoice.invoice_number === invoiceNumber
    ));
    if (matches.length > 1) throw conflict(`multiple recurring invoices exist for ${period.key}`);

    let invoice = matches[0] || null;
    if (invoice && !invoiceIsSeedOwned(invoice)) {
        throw conflict(`an existing non-seed recurring invoice occupies ${period.key}`);
    }
    if (invoice && invoice.invoice_type !== INVOICE_TYPE) {
        throw conflict(`an existing invoice with type ${invoice.invoice_type} occupies ${period.key}`);
    }

    const currentMetadata = invoice ? asPlainObject(invoice.metadata, 'invoices.metadata') : {};
    if (invoice && (invoice.transaction_id || invoice.payment_id || invoice.bkash_url)) {
        throw conflict(`seed invoice ${period.key} already contains gateway provenance`);
    }

    const values = {
        subscription_id: subscription.id,
        shop_id: shop.id,
        invoice_number: invoiceNumber,
        billing_period: period.key,
        billing_period_start: new Date(period.start),
        billing_period_end: new Date(period.end),
        invoice_type: INVOICE_TYPE,
        // ADR-0011: no subscription fee. A review period with no delivered
        // orders is an explicit BDT 0 delivered-order invoice.
        amount: 0,
        base_amount: 0,
        extra_usage_amount: 0,
        addon_amount: 0,
        status: 'paid',
        due_date: new Date(period.start),
        paid_at: invoice?.paid_at || now,
        payment_method: PAYMENT_METHOD,
        transaction_id: null,
        payment_id: null,
        bkash_url: null,
        checkout_lease_id: null,
        checkout_lease_expires_at: null,
        notes: 'Internal Meta App Review seed settlement; no real money was collected; exclude from revenue reporting.',
        metadata: {
            ...currentMetadata,
            ...PAYMENT_METADATA,
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            model: COMMERCIAL_CONTRACT.model,
            currency: COMMERCIAL_CONTRACT.currency,
            unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
            deliveredCount: 0,
            zeroRatedCount: 0,
            grossMinor: 0,
            creditMinor: 0,
            netMinor: 0,
        },
    };

    if (!invoice) {
        invoice = await Invoice.create({ id: stableId(`invoice:${period.key}`), ...values }, { transaction });
    } else {
        await invoice.update(values, { transaction });
    }
    return invoice;
};

const ensureNoOpenRecurringInvoices = async ({ Invoice, subscription, transaction }) => {
    const invoices = await Invoice.findAll({ where: { subscription_id: subscription.id }, transaction });
    const open = invoices.filter((invoice) => (
        RECURRING_INVOICE_TYPES.includes(invoice.invoice_type)
        && ['pending', 'overdue'].includes(invoice.status)
    ));
    if (open.length > 0) throw conflict('the review subscription still has an outstanding recurring invoice');
};

const productSeedAttributes = (product) => asPlainObject(product.ai_attributes, `product ${product.sku} ai_attributes`);

const productPayload = (fixture, existingAttributes = {}) => {
    const aiAttributes = {
        ...cloneJson(existingAttributes),
        seed_key: SEED_KEY,
        source_image_url: fixture.imageUrl,
        color: fixture.color,
        material: fixture.material,
        size_options: [...fixture.sizes],
        style: fixture.style,
    };
    const searchText = [
        fixture.name,
        fixture.category,
        fixture.color,
        fixture.material,
        fixture.sizes.join(' '),
        fixture.keywords.join(' '),
        ...(fixture.searchAliases || []),
        fixture.description,
    ].join(' ');

    return {
        name: fixture.name,
        category: fixture.category,
        price: fixture.price,
        description: fixture.description,
        sku: fixture.sku,
        quantity: fixture.quantity,
        low_stock_threshold: 5,
        track_quantity: true,
        brand: 'EasyModerator',
        tags: [...fixture.keywords],
        aliases: [...fixture.keywords],
        variants: [...fixture.sizes],
        allow_discounts: true,
        charge_tax: false,
        send_low_stock_alert: false,
        in_stock: true,
        is_active: true,
        ai_description: fixture.description,
        ai_tags: [...fixture.keywords],
        ai_category: fixture.category,
        ai_color_primary: fixture.color,
        ai_material: fixture.material,
        ai_attributes: aiAttributes,
        ai_search_text: searchText,
    };
};

const ensureProducts = async ({ Product, shop, transaction }) => {
    const allProducts = await Product.findAll({ where: { shop_id: shop.id }, paranoid: false, transaction });
    const expectedSkus = new Set(PRODUCTS.map((fixture) => fixture.sku));
    const unexpected = allProducts.filter((product) => (
        typeof product.sku === 'string'
        && product.sku.startsWith('META-')
        && !expectedSkus.has(product.sku)
    ));
    if (unexpected.length > 0) throw conflict('the review shop contains an unexpected META-* product');
    for (const sku of expectedSkus) {
        const matches = allProducts.filter((product) => product.sku === sku);
        if (matches.length > 1) throw conflict(`duplicate SKU ${sku} exists in the review shop`);
    }

    const products = [];
    for (const fixture of PRODUCTS) {
        let product = await Product.findOne({
            where: { shop_id: shop.id, sku: fixture.sku },
            paranoid: false,
            transaction,
        });

        if (!product) {
            const sameSku = await Product.findOne({ where: { sku: fixture.sku }, paranoid: false, transaction });
            if (sameSku) throw conflict(`SKU ${fixture.sku} exists in another shop`);
            product = await Product.create({
                id: stableId(`product:${fixture.sku}`),
                shop_id: shop.id,
                image_url: null,
                images: [],
                ...productPayload(fixture),
            }, { transaction });
        } else {
            const attributes = productSeedAttributes(product);
            if (attributes.seed_key !== SEED_KEY) {
                throw conflict(`SKU ${fixture.sku} exists without this seed marker`);
            }
            if (product.deletedAt && typeof product.restore === 'function') {
                await product.restore({ transaction });
            }
            await product.update(productPayload(fixture, attributes), { transaction });
        }
        products.push(product);
    }

    if (products.length !== 5 || new Set(products.map((product) => product.sku)).size !== 5) {
        throw new Error('Meta review seed did not produce exactly five unique products');
    }
    return products;
};

const defaultImageExists = async ({ product, shopId, getProductMediaPaths, uploadRoot, publicAssetOrigin }) => {
    const values = [
        ...(Array.isArray(product.images) ? product.images : []),
        product.image_url,
    ];
    const hasOwnedOrigin = values.some((value) => {
        if (typeof value !== 'string') return false;
        if (value.startsWith('/uploads/')) return true;
        try {
            return new URL(value).origin === new URL(publicAssetOrigin).origin;
        } catch (_) {
            return false;
        }
    });
    if (!hasOwnedOrigin) return false;
    const paths = getProductMediaPaths(product.images, product.image_url, shopId);
    if (paths.length !== 1) return false;
    const relative = paths[0].slice('/uploads/'.length);
    const absolute = path.resolve(uploadRoot, relative);
    if (!absolute.startsWith(`${uploadRoot}${path.sep}`)) return false;
    try {
        const stat = await fs.stat(absolute);
        return stat.isFile() && stat.size > 0;
    } catch (_) {
        return false;
    }
};

const persistProductImage = async ({ product, fixture, shopId, deps }) => {
    const attributes = productSeedAttributes(product);
    const localImageExists = deps.imageExists
        ? await deps.imageExists({ product, shopId, fixture })
        : await defaultImageExists({
            product,
            shopId,
            getProductMediaPaths: deps.getProductMediaPaths,
            uploadRoot: deps.uploadRoot,
            publicAssetOrigin: deps.publicAssetOrigin,
        });
    if (attributes.source_image_url === fixture.imageUrl && localImageExists) {
        if (product.image_url && (!Array.isArray(product.images)
            || product.images.length !== 1 || product.images[0] !== product.image_url)) {
            await product.update({ images: [product.image_url] });
        }
        return false;
    }

    const media = await deps.safeFetchMedia(fixture.imageUrl, {
        env: { ...deps.env, MEDIA_FETCH_ALLOWED_HOSTS: MEDIA_HOSTS.join(',') },
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        totalTimeoutMs: MEDIA_TOTAL_TIMEOUT_MS,
        maxRedirects: MEDIA_MAX_REDIRECTS,
    });
    if (!media || !Buffer.isBuffer(media.buffer) || media.buffer.length === 0) {
        throw new Error(`Image fetch returned no bytes for ${fixture.sku}`);
    }
    if (media.buffer.length > MAX_IMAGE_BYTES || !ALLOWED_IMAGE_MIME_TYPES.has(media.mimeType)) {
        throw new Error(`Image response failed validation for ${fixture.sku}`);
    }

    const oldPaths = deps.getProductMediaPaths(product.images, product.image_url, shopId);
    const dataUrl = `data:${media.mimeType};base64,${media.buffer.toString('base64')}`;
    const stored = await deps.storeProductImage({
        dataUrl,
        shopId,
        maxBytes: MAX_IMAGE_BYTES,
    });
    if (!stored || typeof stored.publicPath !== 'string' || !stored.publicPath.startsWith('/uploads/')) {
        throw new Error(`Image storage returned no application-owned path for ${fixture.sku}`);
    }
    const publicImageUrl = joinOrigin(deps.publicAssetOrigin, stored.publicPath);

    try {
        await product.update({
            image_url: publicImageUrl,
            images: [publicImageUrl],
            ai_attributes: attributes,
        });
    } catch (error) {
        await deps.removeUnreferencedProductMedia({
            shopId,
            images: [publicImageUrl],
            excludeProductId: product.id,
        }).catch(() => {});
        throw error;
    }

    if (oldPaths.length > 0) {
        await deps.removeUnreferencedProductMedia({
            shopId,
            images: oldPaths,
            excludeProductId: product.id,
        });
    }
    return true;
};

const indexAndVerifyProducts = async ({ products, shopId, embedProduct, searchForOrder }) => {
    const productsBySku = new Map(products.map((product) => [product.sku, product]));
    for (const product of products) {
        const indexed = await embedProduct(product.id, shopId);
        if (indexed !== true) throw new Error(`Product indexing failed for ${product.sku}`);
    }

    for (const check of GROUNDING_QUERIES) {
        const expected = productsBySku.get(check.sku);
        const result = await searchForOrder({ shopId, query: check.query, limit: 5 });
        const grounded = Array.isArray(result?.products)
            && result.products.some((product) => String(product.id) === String(expected.id));
        if (!grounded) throw new Error(`Product grounding failed for ${check.sku}`);
    }
};

const validateDependencies = ({ entities, hashPassword, comparePassword, safeFetchMedia, storeProductImage, removeUnreferencedProductMedia, embedProduct, searchForOrder }) => {
    const requiredEntities = ['User', 'Tenant', 'Shop', 'UserShop', 'Subscription', 'Invoice', 'Product'];
    for (const name of requiredEntities) {
        if (!entities?.[name]) throw new Error(`Missing seed entity: ${name}`);
    }
    for (const [name, dependency] of Object.entries({
        hashPassword,
        comparePassword,
        safeFetchMedia,
        storeProductImage,
        removeUnreferencedProductMedia,
        embedProduct,
        searchForOrder,
    })) {
        if (typeof dependency !== 'function') throw new Error(`Missing seed dependency: ${name}`);
    }
};

/**
 * Run only the fixed Meta App Review merchant seed. The caller supplies the
 * password through an operational secret; this function never has a default.
 */
const runMetaReviewMerchantSeed = async ({
    sequelize,
    entities,
    password,
    hashPassword,
    comparePassword,
    safeFetchMedia,
    storeProductImage,
    removeUnreferencedProductMedia,
    getProductMediaPaths,
    uploadRoot,
    embedProduct,
    searchForOrder,
    clearShopCache,
    invalidateUserCache,
    env = process.env,
    now = new Date(),
    imageExists,
}) => {
    validateDependencies({
        entities,
        hashPassword,
        comparePassword,
        safeFetchMedia,
        storeProductImage,
        removeUnreferencedProductMedia,
        embedProduct,
        searchForOrder,
    });
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Seed clock is invalid');
    if (typeof password !== 'string' || password.length === 0) throw new Error('Seed password is required');

    const { User, Tenant, Shop, UserShop, Subscription, Invoice, Product } = entities;
    const run = async (transaction) => {
        await lockSeedTransaction(sequelize, transaction);
        const { user, created: accountCreated, passwordChanged } = await ensureUser({
            User,
            sequelize,
            transaction,
            password,
            hashPassword,
            comparePassword,
        });
        await ensureAccountFlags({ sequelize, user, transaction });
        const tenant = await ensureTenant({ Tenant, transaction });
        const { shop, created: businessCreated } = await ensureShop({ Shop, tenant, transaction });
        await ensureOwnerMembership({ UserShop, user, shop, transaction });
        if (user.last_logged_shop_id !== shop.id) {
            await user.update({ last_logged_shop_id: shop.id }, { transaction });
        }
        const { subscription, created: subscriptionCreated } = await ensureSubscription({
            Subscription,
            Invoice,
            shop,
            transaction,
        });
        const invoices = [];
        for (const period of PERIODS) {
            invoices.push(await ensureInvoice({ Invoice, subscription, shop, period, now, transaction }));
        }
        await ensureNoOpenRecurringInvoices({ Invoice, subscription, transaction });
        const products = await ensureProducts({ Product, shop, transaction });
        return {
            user,
            tenant,
            shop,
            subscription,
            invoices,
            products,
            accountCreated,
            passwordChanged,
            businessCreated,
            subscriptionCreated,
        };
    };

    const result = await sequelize.transaction(run);
    if (typeof clearShopCache === 'function') await clearShopCache(result.shop.id).catch(() => {});
    if (result.passwordChanged && typeof invalidateUserCache === 'function') {
        await invalidateUserCache(result.user.id).catch(() => {});
    }
    const deps = {
        safeFetchMedia,
        storeProductImage,
        removeUnreferencedProductMedia,
        getProductMediaPaths,
        uploadRoot,
        env,
        imageExists,
        publicAssetOrigin: getPublicAssetOrigin(env),
    };
    for (const fixture of PRODUCTS) {
        const product = result.products.find((item) => item.sku === fixture.sku);
        await persistProductImage({ product, fixture, shopId: result.shop.id, deps });
    }
    await indexAndVerifyProducts({
        products: result.products,
        shopId: result.shop.id,
        embedProduct,
        searchForOrder,
    });

    const imagePaths = result.products.flatMap((product) => (
        getProductMediaPaths(product.images, product.image_url, result.shop.id)
    ));
    if (imagePaths.length !== PRODUCTS.length || new Set(imagePaths).size !== PRODUCTS.length) {
        throw new Error('Meta review seed did not produce five distinct application-owned product images');
    }

    return {
        ...result,
        productCount: result.products.length,
        imageCount: imagePaths.length,
        aiReplyMode: result.shop.settings?.ai?.automation_mode,
        productSkus: result.products.map((product) => product.sku),
    };
};

const main = async () => {
    require('dotenv').config();
    const config = require('../config/config');
    const env = process.env;
    if (config.env !== 'production') {
        throw new Error('Meta review merchant seed is production-only; use the exported runner for isolated tests');
    }
    assertProductionConfirmation({ ...env, NODE_ENV: config.env });
    const password = getPassword(env);
    const { sequelize } = require('../utils/database/database-setup');
    const entities = require('../modules/entities');
    const { hashPassword, comparePassword } = require('../utils/password.util');
    const { safeFetchMedia } = require('../utils/safe-media-fetch');
    const media = require('../modules/product/product-media.service');
    const { embedProduct } = require('../modules/product/product-embedding.service');
    const { searchForOrder } = require('../modules/product/product-search.service');
    const cacheService = require('../utils/cache.service');

    try {
        await assertProductionDatabase(sequelize, { ...env, NODE_ENV: config.env });
        const result = await runMetaReviewMerchantSeed({
            sequelize,
            entities,
            password,
            hashPassword,
            comparePassword,
            safeFetchMedia,
            storeProductImage: media.storeProductImage,
            removeUnreferencedProductMedia: media.removeUnreferencedProductMedia,
            getProductMediaPaths: media.getProductMediaPaths,
            uploadRoot: require('../utils/image-upload.service').UPLOAD_ROOT,
            embedProduct,
            searchForOrder,
            clearShopCache: (shopId) => cacheService.clearForShop(shopId),
            invalidateUserCache: (userId) => Promise.all([
                cacheService.delete(`user:${userId}:token_version`),
                cacheService.delete(`user:${userId}:platform_role`),
            ]),
            env,
        });
        console.log('META_REVIEW_SEED=PASS');
        console.log(`ACCOUNT_CREATED=${result.accountCreated ? 'YES' : 'RECONCILED'}`);
        console.log(`BUSINESS_CREATED=${result.businessCreated ? 'YES' : 'RECONCILED'}`);
        console.log(`SUBSCRIPTION_CREATED=${result.subscriptionCreated ? 'YES' : 'RECONCILED'}`);
        console.log('SUBSCRIPTION_STATUS=ACTIVE');
        console.log('PAID_PERIODS=2026-09,2026-10');
        console.log(`PRODUCT_COUNT=${result.productCount}`);
        console.log(`PRODUCT_IMAGES=${result.imageCount}`);
        console.log('PRODUCT_GROUNDING=PASS');
        console.log(`AI_REPLY_MODE=${result.aiReplyMode}`);
        console.log('META_PAGE_CONNECTED=NO');
        console.log('META_DATA_SEEDED=NO');
    } finally {
        await sequelize.close().catch(() => {});
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error('META_REVIEW_SEED=FAIL');
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    ALLOWED_IMAGE_MIME_TYPES,
    BUSINESS_INFO,
    BUSINESS_NAME,
    EMAIL,
    GROUNDING_QUERIES,
    INVOICE_TYPE,
    MERCHANT_NAME,
    MEDIA_HOSTS,
    PAYMENT_METHOD,
    PERIODS,
    PRODUCTS,
    REVIEW_SEED_MARKER,
    SEED_CONFIRMATION,
    SEED_KEY,
    SHOP_CODE,
    TENANT_NAME,
    assertProductionConfirmation,
    assertProductionDatabase,
    buildShopSettings,
    getPassword,
    runMetaReviewMerchantSeed,
    stableId,
};
