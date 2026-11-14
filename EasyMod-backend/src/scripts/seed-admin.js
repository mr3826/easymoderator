require('module-alias/register');
require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const requireInProduction = (key) => {
    if (env === 'production' && !process.env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return process.env[key];
};

// Force file-based SQLite in development only
if (!process.env.DATABASE_URL && env !== 'production') {
    process.env.DATABASE_URL = 'sqlite:./database.sqlite';
}

const entities = require('../modules/entities');

const { sequelize } = require('../utils/database/database-setup');
const { User, Shop, UserShop, Tenant, Subscription } = entities;
const { hashPassword } = require('../utils/password.util');
const { generateUniqueShopCode } = require('../modules/auth/auth.service');
const cacheService = require('../utils/cache.service');
const { PlanCode, getTierByCode } = require('../modules/subscription/subscription.plans');
const { COMMERCIAL_CONTRACT } = require('../modules/commercial/commercial.contract');

const ADMIN_EMAIL = requireInProduction('SEED_ADMIN_EMAIL') || process.env.SEED_ADMIN_EMAIL || 'admin@test.local';
const ADMIN_PASSWORD = requireInProduction('SEED_ADMIN_PASSWORD') || process.env.SEED_ADMIN_PASSWORD || 'ChangeMe@LocalSeed1!';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Test Admin';
const ADMIN_PHONE = process.env.SEED_ADMIN_PHONE || '+8801000000000';
const ADMIN_SHOP_NAME = process.env.SEED_ADMIN_SHOP || 'EasyModerator Review Shop';
const ADMIN_PLATFORM_ROLE = process.env.SEED_ADMIN_PLATFORM_ROLE || 'SUPER_ADMIN';
const requestedPaidMonths = parseInt(process.env.SEED_ADMIN_PAID_MONTHS || '12', 10);
const PAID_MONTHS = Number.isInteger(requestedPaidMonths) && requestedPaidMonths > 0 ? requestedPaidMonths : 12;

const VALID_PLATFORM_ROLES = new Set(['SUPPORT_ADMIN', 'SUPER_ADMIN']);

function addMonths(date, months) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
}

async function ensurePaidSubscription(shopId) {
    const now = new Date();
    const periodEnd = addMonths(now, PAID_MONTHS);
    const tier = getTierByCode(PlanCode.MERCHANT);

    // ADR-0011: the row is a delivered-order entitlement, not a paid plan.
    // There is no subscription fee, so the period window is seeded but priced 0.
    const payload = {
        plan_code: tier.code,
        plan_name: tier.name,
        plan_price: 0,
        billing_cycle: 'monthly',
        billing_model: tier.billingModel,
        per_order_charge_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
        status: 'active',
        conversations_limit: tier.conversationsLimit,
        orders_limit: tier.ordersLimit,
        products_limit: tier.productsLimit,
        conversations_used: 0,
        orders_used: 0,
        products_used: 0,
        topup_balance: 0,
        features: { ...tier.features },
        current_period_start: now,
        current_period_end: periodEnd,
        next_billing_date: periodEnd,
        trial_ends_at: null,
        cancelled_at: null
    };

    const [subscription, created] = await Subscription.findOrCreate({
        where: { shop_id: shopId },
        defaults: payload
    });

    if (!created) {
        await subscription.update(payload);
    }

    await cacheService.clearForShop(shopId).catch(() => {});
    return { subscription, created };
}

async function ensureAdminUser() {
    await sequelize.authenticate();

    if (!VALID_PLATFORM_ROLES.has(ADMIN_PLATFORM_ROLE)) {
        throw new Error(`SEED_ADMIN_PLATFORM_ROLE must be one of: ${Array.from(VALID_PLATFORM_ROLES).join(', ')}`);
    }

    const existingUser = await User.findOne({ where: { email: ADMIN_EMAIL } });
    const hashedPassword = await hashPassword(ADMIN_PASSWORD);

    let user = existingUser;
    if (user) {
        await user.update({
            password: hashedPassword,
            full_name: ADMIN_NAME,
            phone: ADMIN_PHONE,
            platform_role: ADMIN_PLATFORM_ROLE,
            refresh_token: null,
            token_version: sequelize.literal('token_version + 1')
        });
        console.log(`Admin user updated: ${user.id}`);
    } else {
        user = await User.create({
            email: ADMIN_EMAIL,
            password: hashedPassword,
            full_name: ADMIN_NAME,
            phone: ADMIN_PHONE,
            platform_role: ADMIN_PLATFORM_ROLE
        });
        console.log(`Admin user created: ${user.id}`);
    }

    let userShop = await UserShop.findOne({
        where: { user_id: user.id, is_active: true },
        include: [{ model: Shop, as: 'shop' }]
    });

    let shop = userShop?.shop || null;
    if (!shop) {
        const tenant = await Tenant.create({ name: 'Admin Tenant' });
        const shopCode = await generateUniqueShopCode();
        shop = await Shop.create({
            unique_code: shopCode,
            tenant_id: tenant.id,
            name: ADMIN_SHOP_NAME,
            shop_name: ADMIN_SHOP_NAME,
            is_active: true,
            timezone: 'Asia/Dhaka',
            settings: {
                review_seed: true,
                seeded_for: 'production_review'
            }
        });
        userShop = await UserShop.create({
            user_id: user.id,
            shop_id: shop.id,
            role: 'owner',
            is_active: true
        });
        console.log(`Shop created: ${shop.unique_code} (${shop.id})`);
    } else {
        await shop.update({
            name: shop.name || ADMIN_SHOP_NAME,
            shop_name: shop.shop_name || ADMIN_SHOP_NAME,
            is_active: true
        });
        await userShop.update({ role: 'owner', is_active: true });
        console.log(`Active shop ensured: ${shop.unique_code} (${shop.id})`);
    }

    await user.update({ last_logged_shop_id: shop.id });
    await cacheService.delete(`user:${user.id}:platform_role`).catch(() => {});
    await cacheService.delete(`user:${user.id}:token_version`).catch(() => {});

    const { subscription, created: subscriptionCreated } = await ensurePaidSubscription(shop.id);

    console.log('Admin review account ready');
    console.log(`Email: ${ADMIN_EMAIL}`);
    console.log('Password: (set)');
    console.log(`Platform Role: ${ADMIN_PLATFORM_ROLE}`);
    console.log(`Shop Code: ${shop.unique_code}`);
    console.log(`Shop Role: owner`);
    console.log(`Subscription: ${subscription.plan_code} ${subscription.status} (${subscriptionCreated ? 'created' : 'updated'})`);
    console.log(`Paid Through: ${new Date(subscription.next_billing_date).toISOString()}`);
}

ensureAdminUser()
    .catch((error) => {
        console.error('Failed to seed admin user:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await sequelize.close();
        } catch (closeError) {
            console.error('Error closing database connection:', closeError);
        }
    });
