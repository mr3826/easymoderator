'use strict';

/**
 * Real-PostgreSQL fixtures for the pilot intelligence integration suites
 * (Customer 360 / Sales Opportunities / Order Confidence). Every row created
 * here is tracked and removed by cleanup(); nothing is truncated.
 */

const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');

const models = () => require('../../src/modules/entities');
const { sequelize } = require('../../src/utils/database/database-setup');

function createFixtures(label) {
    const created = { tenants: [], shops: [], users: [] };

    async function makeShop({ customerIntelligence = true, orderConfidenceMode = 'enforce', config = {} } = {}) {
        const { Tenant, Shop, ShopPilotFeatures } = models();
        const suffix = uuidv4();
        const tenant = await Tenant.create({ name: `${label} ${suffix}` });
        const shop = await Shop.create({
            unique_code: `PI-${suffix}`.slice(0, 20),
            tenant_id: tenant.id,
            shop_name: `${label} Shop`,
            name: `${label} Shop`,
        });
        created.tenants.push(tenant.id);
        created.shops.push(shop.id);
        await ShopPilotFeatures.create({
            shop_id: shop.id,
            customer_intelligence: customerIntelligence,
            order_confidence_mode: orderConfidenceMode,
            order_confidence_config: config,
        });
        return shop;
    }

    async function makeMember(shop, role = 'owner', { platformRole = null } = {}) {
        const { User, UserShop } = models();
        const user = await User.create({
            // Local part must stay under 64 characters for the isEmail validator.
            email: `pi-${role}-${uuidv4()}@example.test`,
            password: 'unused-test-hash',
            full_name: `${label} ${role}`,
            settings: {},
            ...(platformRole ? { platform_role: platformRole } : {}),
        });
        created.users.push(user.id);
        if (shop) await UserShop.create({ user_id: user.id, shop_id: shop.id, role, is_active: true });
        return user;
    }

    function tokenFor(user, shopId) {
        const { generateAccessToken } = require('../../src/utils/jwt.util');
        return generateAccessToken({
            userId: user.id,
            email: user.email,
            shopId,
            tokenVersion: user.token_version || 0,
            mfaVerified: true,
        });
    }

    async function makeCustomer(shop, overrides = {}) {
        const { Customer } = models();
        return Customer.create({
            shop_id: shop.id,
            name: 'Pilot Customer',
            channel_type: 'messenger',
            channel_user_id: `psid-${uuidv4()}`,
            messaging_consent: {},
            ...overrides,
        });
    }

    async function makeOrder(shop, overrides = {}) {
        const { Order } = models();
        return Order.create({
            shop_id: shop.id,
            order_number: `PI-${uuidv4()}`,
            customer_name: 'Pilot Customer',
            customer_phone: '01711111111',
            delivery_address: 'House 12, Road 5, Dhanmondi, Dhaka',
            // This shared integration fixture represents an order that already
            // passed merchant confirmation against Pathao's directory. Raw,
            // unnamespaced ids are intentionally not bookable without lookup.
            delivery_location: JSON.stringify({
                full_address: 'House 12, Road 5, Dhanmondi, Dhaka',
                provider_destination: {
                    pathao: {
                        area_id: 11,
                        area_name: 'Dhanmondi',
                        zone_id: 22,
                        zone_name: 'Dhanmondi',
                        city_id: 33,
                        city_name: 'Dhaka',
                        district: 'Dhaka',
                        source: 'merchant_confirmed',
                        confirmed_at: '2026-11-04T00:00:00.000Z',
                        confirmed_by: 'integration-merchant',
                    },
                },
            }),
            total: 1250,
            order_status: 'confirmed',
            // Booking requires a recorded payment method (or a paid order);
            // the canonical bookable fixture is a pending COD order.
            payment_method: 'COD',
            payment_status: 'pending',
            fulfillment_status: 'unfulfilled',
            items: [{ product_id: null, name: 'Pilot Item', quantity: 1 }],
            ...overrides,
        });
    }

    async function makeConversation(shop, customer, overrides = {}) {
        const { Conversation } = models();
        return Conversation.create({
            shop_id: shop.id,
            customer_id: customer.id,
            channel: 'messenger',
            status: 'active',
            role: 'user',
            message: 'hello',
            metadata: {},
            ...overrides,
        });
    }

    async function addCustomerMessage(conversation, content, minutesAgo, metadata = {}) {
        const { Message } = models();
        const at = new Date(Date.now() - minutesAgo * 60 * 1000);
        const message = await Message.create({
            conversation_id: conversation.id,
            content,
            sender: 'customer',
            external_id: `m_${uuidv4()}`,
            created_at: at,
            metadata,
        });
        await sequelize.query('UPDATE conversations SET updated_at = :at WHERE id = :id', {
            replacements: { at, id: conversation.id },
        });
        return message;
    }

    async function backdate(table, id, minutesAgo, column = 'created_at') {
        const at = new Date(Date.now() - minutesAgo * 60 * 1000);
        await sequelize.query(`UPDATE ${table} SET ${column} = :at WHERE id = :id`, { replacements: { at, id } });
        return at;
    }

    async function cleanup() {
        const {
            Tenant, Shop, User, UserShop, Customer, Order, Conversation, Message, CourierDispatch,
            DeliveryTracking, CustomerOpportunity, OrderConfidence, ShopPilotFeatures, AuditLog,
        } = models();
        const shopIds = created.shops;
        if (shopIds.length) {
            const conversations = await Conversation.findAll({ where: { shop_id: { [Op.in]: shopIds } }, attributes: ['id'] });
            const orders = await Order.findAll({ where: { shop_id: { [Op.in]: shopIds } }, attributes: ['id'] });
            await CustomerOpportunity.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await OrderConfidence.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await Message.destroy({ where: { conversation_id: { [Op.in]: conversations.map((c) => c.id) } } });
            await Conversation.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await DeliveryTracking.destroy({ where: { order_id: { [Op.in]: orders.map((o) => o.id) } } });
            await CourierDispatch.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await sequelize.query('DELETE FROM order_sessions WHERE shop_id IN (:shopIds)', { replacements: { shopIds } });
            if (orders.length) {
                await sequelize.query('DELETE FROM order_items WHERE order_id IN (:orderIds)', {
                    replacements: { orderIds: orders.map((o) => o.id) },
                });
            }
            await Order.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await sequelize.query('DELETE FROM products WHERE shop_id IN (:shopIds)', { replacements: { shopIds } });
            await Customer.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await AuditLog.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await ShopPilotFeatures.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
            await UserShop.destroy({ where: { shop_id: { [Op.in]: shopIds } } });
        }
        if (created.users.length) await User.destroy({ where: { id: { [Op.in]: created.users } } });
        if (shopIds.length) await Shop.destroy({ where: { id: { [Op.in]: shopIds } } });
        if (created.tenants.length) await Tenant.destroy({ where: { id: { [Op.in]: created.tenants } } });
    }

    return {
        makeShop, makeMember, tokenFor, makeCustomer, makeOrder, makeConversation, addCustomerMessage, backdate, cleanup,
    };
}

module.exports = { createFixtures };
