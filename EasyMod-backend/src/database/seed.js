'use strict';

/**
 * Dev seed script — creates the founder's local development account.
 * Safe to run multiple times (idempotent).
 *
 * Usage:
 *   npm run seed
 *   node src/database/seed.js
 *
 * Environment overrides:
 *   SEED_EMAIL    — founder email (default: work.evan.ahmed@gmail.com)
 *   SEED_PASSWORD — founder password (default: EasyMod@Dev2026!)
 *   SEED_SHOP     — shop name (default: EasyMod Dev Shop)
 */

require('module-alias/register');
require('dotenv').config();

async function main() {
    // Load secrets from GCP Secret Manager before config.js is required
    await require('../config/secrets-loader')();

    const { sequelize } = require('../utils/database/database-setup');
    const { User, Shop, UserShop, Tenant, Subscription } = require('../modules/entities');
    const { hashPassword } = require('../utils/password.util');
    const { v4: uuidv4 } = require('uuid');
    const { PlanCode, getTierByCode } = require('../modules/subscription/subscription.plans');
    const { COMMERCIAL_CONTRACT } = require('../modules/commercial/commercial.contract');

    const SEED_EMAIL    = process.env.SEED_EMAIL    || 'work.evan.ahmed@gmail.com';
    const SEED_PASSWORD = process.env.SEED_PASSWORD || 'EasyMod@Dev2026!';
    const SEED_SHOP     = process.env.SEED_SHOP     || 'EasyMod Dev Shop';

    try {
        await sequelize.authenticate();
        console.log('[seed] Database connected');

        // 1. Find or create tenant
        let [tenant] = await Tenant.findOrCreate({
            where: { name: 'EasyMod Dev Tenant' },
            defaults: {
                id: uuidv4(),
                name: 'EasyMod Dev Tenant',
                is_active: true,
                settings: {}
            }
        });
        console.log(`[seed] Tenant: ${tenant.id}`);

        // 2. Find or create founder user
        let user = await User.findOne({ where: { email: SEED_EMAIL } });
        if (!user) {
            const hashed = await hashPassword(SEED_PASSWORD);
            user = await User.create({
                id: uuidv4(),
                email: SEED_EMAIL,
                password: hashed,
                name: 'Evan Ahmed (Founder)',
                role: 'owner',
                is_active: true,
                is_verified: true,
                token_version: 0
            });
            console.log(`[seed] Created user: ${user.id} (${SEED_EMAIL})`);
        } else {
            console.log(`[seed] User already exists: ${user.id} (${SEED_EMAIL})`);
        }

        // 3. Find or create default shop
        let existingUserShop = await UserShop.findOne({
            where: { user_id: user.id, is_active: true }
        });

        let shop;
        if (existingUserShop) {
            shop = await Shop.findByPk(existingUserShop.shop_id);
            console.log(`[seed] Shop already exists: ${shop.id} (${shop.shop_name})`);
        } else {
            const uniqueCode = 'DEVSHOP01';
            shop = await Shop.create({
                id: uuidv4(),
                unique_code: uniqueCode,
                tenant_id: tenant.id,
                shop_name: SEED_SHOP,
                name: SEED_SHOP,
                is_active: true,
                timezone: 'Asia/Dhaka',
                settings: { bd: { enabled: true } }
            });
            await UserShop.create({
                id: uuidv4(),
                user_id: user.id,
                shop_id: shop.id,
                role: 'owner',
                is_active: true
            });
            // Update user's last_shop_id
            await user.update({ last_shop_id: shop.id });
            console.log(`[seed] Created shop: ${shop.id} (${SEED_SHOP})`);
        }

        // 4. Find or create the single MERCHANT delivered-order subscription.
        // Price authority stays in the commercial contract; this row carries no
        // subscription fee or conversation entitlement.
        const merchantTier = getTierByCode(PlanCode.MERCHANT);
        const periodStart = new Date();
        const periodEnd = new Date(periodStart);
        periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
        const [sub, subCreated] = await Subscription.findOrCreate({
            where: { shop_id: shop.id },
            defaults: {
                id: uuidv4(),
                shop_id: shop.id,
                plan_name: merchantTier.name,
                plan_code: merchantTier.code,
                plan_price: 0,
                billing_cycle: 'monthly',
                billing_model: merchantTier.billingModel,
                per_order_charge_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
                status: 'active',
                conversations_limit: merchantTier.conversationsLimit,
                orders_limit: merchantTier.ordersLimit,
                products_limit: merchantTier.productsLimit,
                conversations_used: 0,
                topup_balance: 0,
                threshold_debt: 0,
                features: { ...merchantTier.features },
                current_period_start: periodStart,
                current_period_end: periodEnd,
                next_billing_date: periodEnd
            }
        });
        console.log(`[seed] Subscription: ${sub.id} (${sub.plan_code}) — ${subCreated ? 'created' : 'exists'}`);

        console.log('\n[seed] Done. Dev account ready:');
        console.log(`  Email:    ${SEED_EMAIL}`);
        console.log(`  Password: ${SEED_PASSWORD}`);
        console.log(`  Shop:     ${shop.shop_name} (${shop.id})`);
        console.log(`  Plan:     ${sub.plan_code}`);

    } catch (err) {
        console.error('[seed] Error:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        const { sequelize } = require('../utils/database/database-setup');
        await sequelize.close().catch(() => {});
        process.exit(0);
    }
}

main();
