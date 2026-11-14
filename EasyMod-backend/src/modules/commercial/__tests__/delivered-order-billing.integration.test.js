'use strict';

/**
 * A5 + A6 — delivered-order billing against real PostgreSQL.
 *
 * A5: the invoice is derived exclusively from `billing_lines`: ten delivered
 * orders at the frozen BDT 10.00 unit price, plus one returned and one
 * cancelled order that MUST still appear as explicit BDT 0 lines. A pending
 * reversal credit nets against the gross, and a late prior-period arrival is
 * charged forward into the next invoice instead of rewriting an issued one.
 *
 * A6: concurrent identical terminal callbacks — through the real delivery
 * webhook and through catch-up — produce exactly ONE billable row per order.
 * The deterministic idempotency key plus the partial unique indexes are the
 * proof; the DB COUNT is the assertion.
 */

const crypto = require('crypto');

const { sequelize } = require('../../../utils/database/database-setup');
const {
    Tenant,
    Shop,
    Subscription,
    Invoice,
    Order,
    BillingLine,
    PartnerBillingAdjustment,
    DeliveryTracking,
} = require('../../entities');
const billing = require('../delivered-order-billing.service');
const InvoiceGenerator = require('../../../jobs/invoice-generator');
const deliveryTrackingService = require('../../delivery/delivery-tracking.service');
const { syncSchema, truncateAll } = require('../../../../tests/meta-e2e/fixtures');

const OCT_START = new Date(Date.UTC(2026, 9, 1));
const NOV_START = new Date(Date.UTC(2026, 10, 1));
const DEC_START = new Date(Date.UTC(2026, 11, 1));
const CUTOVER = new Date(Date.UTC(2026, 0, 1));
const RUN_NOV = new Date('2026-11-01T01:00:00.000Z');
const RUN_DEC = new Date('2026-12-01T01:00:00.000Z');

const uuid = () => crypto.randomUUID();

async function seedCutover() {
    // `commercial_cutover_events` is migration 20261114_003's state table; the
    // billing engine reads its newest cutover_at. Seed it as the migration would.
    await sequelize.query(
        `INSERT INTO commercial_cutover_events
            (id, entity_type, contract_version, cutover_at, created_at, before, after)
         VALUES (:id, 'test_seed', '1.0.0', :at, :at, '{}'::jsonb, '{}'::jsonb)`,
        { replacements: { id: uuid(), at: CUTOVER } },
    );
}

async function makeShop(label) {
    const suffix = uuid().slice(0, 8);
    const tenant = await Tenant.create({ name: `${label}-${suffix}` });
    const shop = await Shop.create({
        tenant_id: tenant.id,
        unique_code: `BS-${suffix}`.slice(0, 20),
        shop_name: `${label} shop`,
        name: `${label} shop`,
    });
    return shop;
}

async function makeSubscription(shop, overrides = {}) {
    return Subscription.create({
        shop_id: shop.id,
        status: 'active',
        plan_code: 'MERCHANT',
        plan_name: 'EasyModerator',
        plan_price: 0,
        billing_cycle: 'per_order',
        billing_model: 'per_order',
        per_order_charge_bdt: 10.0,
        conversations_limit: -1,
        orders_limit: -1,
        products_limit: -1,
        current_period_start: OCT_START,
        current_period_end: NOV_START,
        next_billing_date: NOV_START,
        ...overrides,
    });
}

async function makeOrder(shop, overrides = {}) {
    return Order.create({
        shop_id: shop.id,
        order_number: `ORD-${uuid()}`,
        order_status: 'delivered',
        delivered_at: new Date('2026-10-05T10:00:00.000Z'),
        customer_name: 'Billing Fixture',
        customer_phone: '01711111111',
        delivery_address: 'House 1, Dhaka',
        payment_method: 'bkash',
        payment_status: 'paid',
        fulfillment_status: 'delivered',
        total: 500,
        ...overrides,
    });
}

const record = (shop, order, outcome, occurredAt = '2026-10-05') => billing.recordOutcomeLine({
    shopId: shop.id,
    orderId: order.id,
    outcome,
    occurredAt,
    source: 'courier_webhook',
});

describe('A5/A6 delivered-order billing on PostgreSQL', () => {
    beforeAll(async () => {
        await syncSchema();
    });

    beforeEach(async () => {
        await truncateAll();
        await seedCutover();
    });

    afterAll(async () => {
        await sequelize.close();
    });

    it('A5 — ten delivered, one returned, one cancelled => BDT 100.00 with explicit BDT 0 lines', async () => {
        const shop = await makeShop('A5');
        await makeSubscription(shop);

        for (let i = 0; i < 10; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const order = await makeOrder(shop);
            // eslint-disable-next-line no-await-in-loop
            await record(shop, order, 'DELIVERED', '2026-10-05');
        }
        const returnedOrder = await makeOrder(shop, { order_status: 'cancelled', delivered_at: new Date('2026-10-06T10:00:00.000Z') });
        await record(shop, returnedOrder, 'RETURNED', '2026-10-06');
        const cancelledOrder = await makeOrder(shop, { order_status: 'cancelled', delivered_at: null });
        await record(shop, cancelledOrder, 'CANCELLED', '2026-10-07');

        const result = await new InvoiceGenerator().run({ dryRun: false, runDate: RUN_NOV });
        expect(result.invoicesGenerated).toBe(1);

        const invoice = await Invoice.findOne({
            where: { shop_id: shop.id, invoice_type: 'delivered_order' },
        });
        expect(invoice).not.toBeNull();
        // Server-side persisted total: 10 * BDT 10.00, nothing client-supplied.
        expect(Number(invoice.amount)).toBe(100);
        expect(Number(invoice.base_amount)).toBe(0);
        expect(Number(invoice.extra_usage_amount)).toBe(100);
        expect(invoice.billing_period_start).toEqual(OCT_START);
        expect(invoice.billing_period_end).toEqual(NOV_START);
        expect(invoice.metadata).toMatchObject({
            contractVersion: '1.0.0',
            model: 'DELIVERED_ORDER',
            unitPriceMinor: 1000,
            deliveredCount: 10,
            zeroRatedCount: 2,
            grossMinor: 10000,
            creditMinor: 0,
            netMinor: 10000,
            priorPeriodAdjustmentMinor: 0,
        });
        expect(invoice.metadata.lines).toHaveLength(12);

        const zeroLines = invoice.metadata.lines.filter((line) => line.amountMinor === 0);
        expect(zeroLines).toHaveLength(2);
        expect(zeroLines.map((line) => line.outcome).sort()).toEqual(['CANCELLED', 'RETURNED']);

        const lines = await BillingLine.findAll({ where: { shop_id: shop.id } });
        expect(lines).toHaveLength(12);
        expect(lines.filter((line) => line.invoice_id === invoice.id)).toHaveLength(12);
        expect(lines.filter((line) => line.line_kind === 'billable')).toHaveLength(10);
    });

    it('A5 — a pending reversal credit nets against the delivered gross', async () => {
        const shop = await makeShop('A5-credit');
        await makeSubscription(shop);
        const order = await makeOrder(shop);
        await record(shop, order, 'DELIVERED', '2026-10-05');

        const adjustment = await PartnerBillingAdjustment.create({
            shop_id: shop.id,
            order_id: order.id,
            amount_bdt: 5.0,
            reason: 'return_reversal',
            status: 'pending',
        });

        await new InvoiceGenerator().run({ dryRun: false, runDate: RUN_NOV });

        const invoice = await Invoice.findOne({
            where: { shop_id: shop.id, invoice_type: 'delivered_order' },
        });
        expect(Number(invoice.amount)).toBe(5);
        expect(invoice.metadata).toMatchObject({
            grossMinor: 1000,
            creditMinor: 500,
            netMinor: 500,
        });
        await adjustment.reload();
        expect(adjustment.status).toBe('applied');
        expect(adjustment.invoice_id).toBe(invoice.id);
    });

    it('A5 — a late prior-period arrival is charged forward without rewriting the issued invoice', async () => {
        const shop = await makeShop('A5-late');
        await makeSubscription(shop);
        const octoberOrder = await makeOrder(shop);
        await record(shop, octoberOrder, 'DELIVERED', '2026-10-05');

        // The October invoice is issued and its line is settled (immutable).
        await new InvoiceGenerator().run({ dryRun: false, runDate: RUN_NOV });
        const octoberInvoice = await Invoice.findOne({
            where: { shop_id: shop.id, invoice_type: 'delivered_order' },
        });
        expect(Number(octoberInvoice.amount)).toBe(10);
        const octoberLine = await BillingLine.findOne({
            where: { shop_id: shop.id, order_id: octoberOrder.id },
        });
        expect(octoberLine.invoice_id).toBe(octoberInvoice.id);

        // A September delivery callback arrives AFTER September/October billing
        // had already run. Its line keeps the real occurrence date.
        const lateOrder = await makeOrder(shop, {
            order_status: 'delivered',
            delivered_at: new Date('2026-09-20T10:00:00.000Z'),
        });
        await record(shop, lateOrder, 'DELIVERED', '2026-09-20');

        // Next month's run charges it forward, flagged as a prior-period line.
        await new InvoiceGenerator().run({ dryRun: false, runDate: RUN_DEC });
        const novemberInvoice = await Invoice.findOne({
            where: { shop_id: shop.id, invoice_type: 'delivered_order', billing_period_start: NOV_START },
        });
        expect(novemberInvoice).not.toBeNull();
        expect(Number(novemberInvoice.amount)).toBe(10);
        expect(novemberInvoice.metadata).toMatchObject({
            grossMinor: 1000,
            priorPeriodAdjustmentMinor: 1000,
            priorPeriodAdjustmentCount: 1,
        });
        const lateLine = novemberInvoice.metadata.lines.find((line) => line.orderId === lateOrder.id);
        expect(lateLine).toMatchObject({ priorPeriodAdjustment: true, occurredAt: '2026-09-20' });

        // The already-issued October document was not rewritten.
        await octoberInvoice.reload();
        expect(Number(octoberInvoice.amount)).toBe(10);
        await octoberLine.reload();
        expect(octoberLine.invoice_id).toBe(octoberInvoice.id);
    });

    it('A6 — ten concurrent identical DELIVERED webhooks create exactly one billable line', async () => {
        const shop = await makeShop('A6-webhook');
        await makeSubscription(shop);
        const order = await makeOrder(shop, {
            order_status: 'confirmed',
            fulfillment_status: 'unfulfilled',
            delivered_at: null,
        });
        const trackingNumber = `TRK-${uuid()}`;
        await DeliveryTracking.create({
            order_id: order.id,
            provider: 'pathao',
            tracking_number: trackingNumber,
            current_status: 'in_transit',
            status_history: [],
        });

        const attempts = await Promise.all(Array.from({ length: 10 }, () => (
            deliveryTrackingService.handleDeliveryWebhook('pathao', trackingNumber, { status: 'DELIVERED' })
        )));
        expect(attempts.some((attempt) => attempt?.success)).toBe(true);

        expect(await BillingLine.count({
            where: { shop_id: shop.id, order_id: order.id, line_kind: 'billable' },
        })).toBe(1);
        expect(await BillingLine.count({ where: { shop_id: shop.id, order_id: order.id } })).toBe(1);

        const line = await BillingLine.findOne({ where: { shop_id: shop.id, order_id: order.id } });
        expect(line.amount_minor).toBe(1000);
        expect(line.idempotency_key).toBe(billing.billingIdempotencyKey(shop.id, order.id, 'billable'));
    });

    it('A6 — ten concurrent catch-up runs insert exactly one billable line', async () => {
        const shop = await makeShop('A6-catchup');
        await makeSubscription(shop);
        const order = await makeOrder(shop);

        const results = await Promise.all(Array.from({ length: 10 }, () => billing.catchUpLines({
            shopId: shop.id,
            periodStart: OCT_START,
            periodEnd: NOV_START,
            cutoverAt: CUTOVER,
        })));

        expect(results.reduce((total, result) => total + result.created, 0)).toBe(1);
        expect(await BillingLine.count({
            where: { shop_id: shop.id, order_id: order.id, line_kind: 'billable' },
        })).toBe(1);
    });
});