'use strict';

const {
    BUSINESS_NAME,
    EMAIL,
    INVOICE_TYPE,
    MERCHANT_NAME,
    PAYMENT_METHOD,
    PRODUCTS,
    SEED_CONFIRMATION,
    SEED_KEY,
    SHOP_CODE,
    buildShopSettings,
    runMetaReviewMerchantSeed,
    stableId,
} = require('../seed-meta-review-merchant');

const makeRow = (data) => {
    const row = { ...data };
    row.update = jest.fn(async (updates) => {
        Object.assign(row, updates);
        return row;
    });
    row.restore = jest.fn(async () => {
        delete row.deletedAt;
        return row;
    });
    return row;
};

const matchesWhere = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true;
    return String(row[key]) === String(value);
});

const makeModel = (initialRows = []) => {
    const rows = initialRows.map(makeRow);
    const model = {
        rows,
        findOne: jest.fn(async ({ where } = {}) => rows.find((row) => matchesWhere(row, where)) || null),
        findAll: jest.fn(async ({ where } = {}) => rows.filter((row) => matchesWhere(row, where))),
        create: jest.fn(async (values) => {
            const row = makeRow(values);
            rows.push(row);
            return row;
        }),
    };
    return model;
};

const makeHarness = ({ users = [], shops = [], tenants = [], memberships = [], subscriptions = [], invoices = [], products = [] } = {}) => {
    const models = {
        User: makeModel(users),
        Tenant: makeModel(tenants),
        Shop: makeModel(shops),
        UserShop: makeModel(memberships),
        Subscription: makeModel(subscriptions),
        Invoice: makeModel(invoices),
        Product: makeModel(products),
    };

    const sequelize = {
        getDialect: jest.fn(() => 'sqlite'),
        query: jest.fn(),
        transaction: jest.fn(async (callback) => callback({ id: 'transaction' })),
    };

    const hashPassword = jest.fn(async (password) => `bcrypt-test:${password.length}`);
    const comparePassword = jest.fn(async (password, hash) => hash === `bcrypt-test:${password.length}`);
    const safeFetchMedia = jest.fn(async () => ({
        buffer: Buffer.from('validated-image-bytes'),
        mimeType: 'image/jpeg',
    }));
    const storeProductImage = jest.fn(async ({ shopId }) => ({
        publicPath: `/uploads/product-images/${shopId}/${stableId(`image:${storeProductImage.mock.calls.length + 1}`)}.jpg`,
    }));
    const removeUnreferencedProductMedia = jest.fn(async () => ({ removed: 0, bytes: 0 }));
    const getProductMediaPaths = jest.fn((images, imageUrl, shopId) => [...new Set([
        ...(Array.isArray(images) ? images : []),
        imageUrl,
    ].map((value) => {
        if (typeof value !== 'string') return null;
        try { return new URL(value).pathname; } catch (_) { return value; }
    }).filter((value) => typeof value === 'string'
        && value.startsWith(`/uploads/product-images/${shopId}/`)))]);
    const embedProduct = jest.fn(async () => true);
    const searchForOrder = jest.fn(async ({ query }) => {
        const fixture = query.includes('গোলাপি')
            ? PRODUCTS[1]
            : query.includes('জিন্স')
                ? PRODUCTS[2]
                : query.includes('হুডি')
                    ? PRODUCTS[4]
                    : query.includes('সাদা টি-শার্ট')
                        ? PRODUCTS[0]
                        : PRODUCTS[3];
        return { products: [{ id: stableId(`product:${fixture.sku}`) }] };
    });

    return {
        entities: models,
        sequelize,
        hashPassword,
        comparePassword,
        safeFetchMedia,
        storeProductImage,
        removeUnreferencedProductMedia,
        getProductMediaPaths,
        embedProduct,
        searchForOrder,
        password: 'test-only-secret',
        env: { NODE_ENV: 'test', PUBLIC_ASSET_URL: 'https://assets.test.invalid' },
        now: new Date('2026-09-02T09:00:00.000Z'),
        imageExists: jest.fn(async ({ product }) => Boolean(product.image_url)),
    };
};

const runHarness = (harness) => runMetaReviewMerchantSeed(harness);

describe('seed-meta-review-merchant', () => {
    it('creates one normal merchant on the delivered-order model with five products, owned images, and indexes', async () => {
        const harness = makeHarness();
        const result = await runHarness(harness);

        expect(result.accountCreated).toBe(true);
        expect(result.businessCreated).toBe(true);
        expect(result.subscriptionCreated).toBe(true);
        expect(result.user.password).not.toBe(harness.password);
        expect(result.user.platform_role).toBeNull();
        expect(result.user.is_verified).toBe(true);
        expect(result.user.is_active).toBe(true);
        expect(result.shop.name).toBe(BUSINESS_NAME);
        expect(result.shop.unique_code).toBe(SHOP_CODE);
        expect(result.shop.timezone).toBe('Asia/Dhaka');
        expect(result.shop.settings.businessInfo).toMatchObject({
            country: 'Bangladesh',
            currency: 'BDT',
            businessType: 'retail',
            businessCategory: 'Clothing/Fashion',
        });
        expect(result.shop.settings.ai.automation_mode).toBe('MANUAL');
        expect(result.shop.settings.ai.auto_reply_enabled).toBe(false);
        expect(result.subscription.plan_code).toBe('MERCHANT');
        expect(result.subscription.plan_price).toBe(0);
        expect(result.subscription.billing_model).toBe('per_order');
        expect(result.subscription.status).toBe('active');
        expect(result.subscription.conversations_used).toBe(0);
        expect(result.subscription.topup_balance).toBe(0);

        expect(harness.entities.UserShop.rows).toHaveLength(1);
        expect(harness.entities.UserShop.rows[0]).toMatchObject({ role: 'owner', is_active: true });
        expect(harness.entities.Invoice.rows).toHaveLength(2);
        expect(harness.entities.Invoice.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                billing_period: '2026-09',
                invoice_type: INVOICE_TYPE,
                status: 'paid',
                payment_method: PAYMENT_METHOD,
                transaction_id: null,
                payment_id: null,
                bkash_url: null,
            }),
            expect.objectContaining({
                billing_period: '2026-10',
                invoice_type: INVOICE_TYPE,
                status: 'paid',
            }),
        ]));
        expect(harness.entities.Invoice.rows[0].metadata).toMatchObject({
            seed_key: SEED_KEY,
            payment_source: 'INTERNAL_SEED',
            reference: 'META_APP_REVIEW_SEED',
            no_real_money_collected: true,
        });

        expect(result.productCount).toBe(5);
        expect(result.productSkus).toEqual(PRODUCTS.map((product) => product.sku));
        expect(harness.entities.Product.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sku: 'META-JEANS-003',
                price: 1290,
                quantity: 30,
                variants: ['28', '30', '32', '34', '36'],
                ai_color_primary: 'Blue',
                ai_material: 'Denim',
                is_active: true,
            }),
        ]));
        expect(harness.storeProductImage).toHaveBeenCalledTimes(5);
        expect(harness.embedProduct).toHaveBeenCalledTimes(5);
        expect(harness.searchForOrder).toHaveBeenCalledTimes(6);
        expect(harness.safeFetchMedia.mock.calls[0][1]).toMatchObject({
            maxBytes: 8 * 1024 * 1024,
            timeoutMs: 10_000,
            totalTimeoutMs: 15_000,
            maxRedirects: 2,
            env: expect.objectContaining({
                MEDIA_FETCH_ALLOWED_HOSTS: 'unsplash.com,images.unsplash.com',
            }),
        });
        expect(result.imageCount).toBe(5);
        expect(result.products?.[0]?.image_url).toMatch(/^https:\/\//);
        expect(new Set(harness.entities.Product.rows.map((product) => product.image_url)).size).toBe(5);
    });

    it('is idempotent, preserves usage, and does not touch founder Meta state on rerun', async () => {
        const harness = makeHarness();
        const first = await runHarness(harness);
        const shop = harness.entities.Shop.rows[0];
        const subscription = harness.entities.Subscription.rows[0];
        const metaState = { page_id: 'founder-page', encrypted_page_token: 'ciphertext' };
        shop.settings = {
            ...shop.settings,
            meta: metaState,
            ai: { ...shop.settings.ai, confidence_threshold: 88 },
        };
        const firstProduct = harness.entities.Product.rows[0];
        firstProduct.images = [firstProduct.image_url, 'https://images.unsplash.com/legacy-hotlink'];
        subscription.conversations_used = 7;
        subscription.topup_balance = 10;

        const second = await runHarness(harness);

        expect(first.shop.id).toBe(second.shop.id);
        expect(harness.entities.User.rows).toHaveLength(1);
        expect(harness.entities.Tenant.rows).toHaveLength(1);
        expect(harness.entities.Shop.rows).toHaveLength(1);
        expect(harness.entities.Subscription.rows).toHaveLength(1);
        expect(harness.entities.Invoice.rows).toHaveLength(2);
        expect(harness.entities.Product.rows).toHaveLength(5);
        expect(harness.storeProductImage).toHaveBeenCalledTimes(5);
        expect(harness.safeFetchMedia).toHaveBeenCalledTimes(5);
        expect(subscription.conversations_used).toBe(7);
        expect(subscription.topup_balance).toBe(10);
        expect(shop.settings.meta).toEqual(metaState);
        expect(shop.settings.ai.confidence_threshold).toBe(88);
        expect(shop.settings.ai.automation_mode).toBe('MANUAL');
        expect(firstProduct.images).toEqual([firstProduct.image_url]);
        expect(harness.entities.UserShop.rows).toHaveLength(1);
    });

    it.each(['json', 'jsonb'])('uses ordinary object updates for shops.settings with %s storage', async () => {
        const settings = buildShopSettings({
            meta: { page_id: 'page-from-founder' },
            ai: { automation_mode: 'DRAFT', confidence_threshold: 90 },
        });

        expect(settings.meta).toEqual({ page_id: 'page-from-founder' });
        expect(settings.ai).toMatchObject({ automation_mode: 'MANUAL', confidence_threshold: 90 });
        expect(settings.meta_review_seed.seed_key).toBe(SEED_KEY);
        expect(settings).not.toHaveProperty('settings::jsonb');
    });

    it('fails closed when the requested email already has a platform role', async () => {
        const harness = makeHarness({
            users: [{
                id: 'privileged-user',
                email: EMAIL,
                password: 'bcrypt-test:16',
                platform_role: 'SUPER_ADMIN',
                full_name: 'Existing operator',
                is_active: true,
                is_verified: true,
            }],
        });

        await expect(runHarness(harness)).rejects.toThrow('already has a platform role');
        expect(harness.entities.Tenant.rows).toHaveLength(0);
        expect(harness.entities.Shop.rows).toHaveLength(0);
        expect(harness.entities.Product.rows).toHaveLength(0);
    });

    it('normalizes an existing case-variant email before authentication', async () => {
        const harness = makeHarness({
            users: [{
                id: 'existing-user',
                email: 'Merchant@EasyMod.Tech',
                password: 'bcrypt-test:16',
                platform_role: null,
                settings: {},
                full_name: MERCHANT_NAME,
                is_active: true,
                is_verified: true,
            }],
        });
        harness.sequelize.getDialect.mockReturnValue('postgres');

        await runHarness(harness);

        expect(harness.entities.User.rows).toHaveLength(1);
        expect(harness.entities.User.rows[0].email).toBe(EMAIL);
    });

    it('fails closed when a real paid invoice already exists for the subscription', async () => {
        const harness = makeHarness();
        const first = await runHarness(harness);
        harness.entities.Invoice.rows.push({
            subscription_id: first.subscription.id,
            invoice_type: INVOICE_TYPE,
            billing_period: '2026-11',
            status: 'paid',
            metadata: { reference: 'real-renewal' },
        });

        await expect(runHarness(harness)).rejects.toThrow('billing state is not owned by this seed');
    });

    it('fails closed instead of selecting one row when an expected SKU is duplicated', async () => {
        const harness = makeHarness();
        const first = await runHarness(harness);
        harness.entities.Product.rows.push({
            ...harness.entities.Product.rows[0],
            id: 'duplicate-product',
        });

        await expect(runHarness(harness)).rejects.toThrow('duplicate SKU');
        expect(first.productCount).toBe(5);
    });

    it('requires the production confirmation and never provides a password default', () => {
        expect(() => require('../seed-meta-review-merchant').getPassword({})).toThrow('is required');
        expect(() => require('../seed-meta-review-merchant').assertProductionConfirmation({
            NODE_ENV: 'production',
            META_REVIEW_SEED_CONFIRMATION: 'wrong',
        })).toThrow(SEED_CONFIRMATION);
        expect(() => require('../seed-meta-review-merchant').assertProductionConfirmation({
            NODE_ENV: 'production',
            META_REVIEW_SEED_CONFIRMATION: SEED_CONFIRMATION,
        })).not.toThrow();
    });
});
