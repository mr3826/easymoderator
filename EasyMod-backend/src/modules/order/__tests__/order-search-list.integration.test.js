'use strict';

/**
 * W3 FIX 2 (agent A5, from agent A8's blind merchant pass 2026-11-24).
 * A8 typing a customer name into Orders fired GET /api/order?search=... and
 * every call returned a deterministic HTTP 500 mid order-capture, collapsing
 * the list to "Orders unavailable".
 *
 * Reproduced at head (origin/main ced06e8b — same source A8 ran): the 500 is
 * SequelizeDatabaseError 'missing FROM-clause entry for table "customer"'
 * from listOrders(). The include DOES carry Customer as 'customer'; the real
 * mechanism is the page-limit subquery: with `limit` + the hasMany
 * order_items include, Sequelize emits an inner subquery carrying the whole
 * top-level WHERE, while the optional (`required:false`) customer join is
 * kept only in the outer query. The '$customer.name$'/'$customer.phone$'
 * path references therefore resolve to an alias that is not in the
 * subquery's FROM. The OR makes it unconditional: even a pure
 * order-number search carries the failing path references and 500s.
 *
 * Fix semantics: resolve the tenant-scoped customer matches first and
 * constrain orders with customer_id IN (…) — the codebase's existing
 * semijoin idiom (order.service already uses Op.in) — keeping
 * order_number OR name OR phone search semantics and server-side tenant
 * scoping, with no join-path references inside the paginated subquery.
 */

const orderService = require('../order.service');
const {
    Tenant, Shop, User, UserShop, Customer, Product, Order, OrderItem,
} = require('../../entities');

describe('listOrders search on PostgreSQL (A8 F-5)', () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    let tenant;
    let user;
    let shopA;
    let shopB;
    let custA;
    let custB;
    let productA;
    let orderA;
    let orderB;

    beforeAll(async () => {
        tenant = await Tenant.create({ name: `W3 order search ${suffix}` });
        user = await User.create({
            name: 'W3 Search', email: `w3-search-${suffix}@pilot.test`, password: 'Passw0rd!x',
        });
        shopA = await Shop.create({
            unique_code: `W3A-${suffix}`.slice(0, 20), tenant_id: tenant.id,
            shop_name: 'Search Shop A', name: 'Search Shop A',
        });
        shopB = await Shop.create({
            unique_code: `W3B-${suffix}`.slice(0, 20), tenant_id: tenant.id,
            shop_name: 'Search Shop B', name: 'Search Shop B',
        });
        await UserShop.create({ user_id: user.id, shop_id: shopA.id, is_active: true });
        await UserShop.create({ user_id: user.id, shop_id: shopB.id, is_active: true });
        // Identical name AND phone in both shops: a tenant leak through the
        // search predicate becomes visible in the result rows.
        custA = await Customer.create({
            shop_id: shopA.id, name: 'Rahim Uddin', phone: '01711223344',
            channel_type: 'manual', channel_user_id: `w3a-${suffix}`,
        });
        custB = await Customer.create({
            shop_id: shopB.id, name: 'Rahim Uddin', phone: '01711223344',
            channel_type: 'manual', channel_user_id: `w3b-${suffix}`,
        });
        productA = await Product.create({
            shop_id: shopA.id, name: 'Classic Blue Denim Jeans', price: 1290,
        });
        orderA = await Order.create({
            shop_id: shopA.id, customer_id: custA.id,
            order_number: `ORD-W3A-${suffix}`, total: 1290,
            order_status: 'pending', payment_status: 'pending',
            fulfillment_status: 'unfulfilled', payment_method: 'COD',
        });
        await OrderItem.create({
            order_id: orderA.id, product_id: productA.id, quantity: 1, price: 1290, total: 1290,
        });
        orderB = await Order.create({
            shop_id: shopB.id, customer_id: custB.id,
            order_number: `ORD-W3B-${suffix}`, total: 500,
            order_status: 'pending', payment_status: 'pending',
            fulfillment_status: 'unfulfilled', payment_method: 'COD',
        });
    });

    afterAll(async () => {
        await OrderItem.destroy({ where: { order_id: [orderA.id, orderB.id] } });
        await Product.destroy({ where: { id: productA.id } });
        await Order.destroy({ where: { id: [orderA.id, orderB.id] } });
        await Customer.destroy({ where: { id: [custA.id, custB.id] } });
        await UserShop.destroy({ where: { user_id: user.id } });
        await Shop.destroy({ where: { id: [shopA.id, shopB.id] } });
        await User.destroy({ where: { id: user.id } });
        await Tenant.destroy({ where: { id: tenant.id } });
    });

    const numbers = (rows) => rows.map(r => r.order_number).sort();

    test('customer-name search returns filtered rows instead of the A8 500', async () => {
        // A8's exact client shape: GET /api/order?search=Rahim+Uddin&page=1&limit=100
        const rows = await orderService.listOrders(user.id, shopA.id, {
            search: 'Rahim Uddin', page: 1, limit: 100,
        });
        expect(numbers(rows)).toEqual([orderA.order_number]);
    });

    test('order-number search survives the same subquery (was collateral damage)', async () => {
        const rows = await orderService.listOrders(user.id, shopA.id, {
            search: `ORD-W3A-${suffix}`,
        });
        expect(numbers(rows)).toEqual([orderA.order_number]);
    });

    test('phone search finds by customer phone', async () => {
        const rows = await orderService.listOrders(user.id, shopA.id, { search: '0171122' });
        expect(numbers(rows)).toEqual([orderA.order_number]);
    });

    test('search is tenant-scoped: identical name/phone in another shop never leaks', async () => {
        const rowsA = await orderService.listOrders(user.id, shopA.id, { search: 'Rahim Uddin' });
        expect(numbers(rowsA)).toEqual([orderA.order_number]);
        expect(numbers(rowsA)).not.toContain(orderB.order_number);

        const rowsB = await orderService.listOrders(user.id, shopB.id, { search: 'Rahim Uddin' });
        expect(numbers(rowsB)).toEqual([orderB.order_number]);
        expect(numbers(rowsB)).not.toContain(orderA.order_number);
    });

    test('unmatched search is an empty list, not an error', async () => {
        const rows = await orderService.listOrders(user.id, shopA.id, { search: 'zz-no-such-customer-zz' });
        expect(rows).toEqual([]);
    });

    test('unfiltered list still works alongside the search branch', async () => {
        const rows = await orderService.listOrders(user.id, shopA.id, {});
        expect(numbers(rows)).toEqual([orderA.order_number]);
    });
});
