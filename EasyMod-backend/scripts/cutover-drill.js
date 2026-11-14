'use strict';

/**
 * Commercial-model cutover drill (A9 / ADR-0011).
 *
 * Proves migration 20261114_003 against production-SHAPED data:
 *
 *   1. bring a disposable PostgreSQL to the PRE-cutover head (001/002 applied,
 *      003 not yet),
 *   2. seed multiple tenants/shops, orders across every status with spread
 *      delivered_at values, an annual GROWTH test fixture with its PAID yearly
 *      invoice, a suspended shop with an overdue legacy invoice, a paid Partner
 *      invoice with a pending return credit, and pending top-up rows,
 *   3. capture row counts + paid-invoice count/SUM,
 *   4. apply 003 and assert counts and money are byte-identical, every
 *      subscription is MERCHANT/per_order, the fixture snapshot reason exists,
 *      legacy open invoices are cancelled, the suspended shop is active, and
 *      commercial_cutover_events.cutover_at is populated,
 *   5. exercise the new engine on synthetic post-cutover deliveries,
 *   6. roll back THREE migrations and assert subscription fields equal the
 *      snapshots, invoice statuses are restored, the archived billing_lines
 *      count equals the live count, and paid money is unchanged,
 *   7. re-apply and prove `up` is idempotent.
 *
 * `--against-restored` skips synthetic seeding and the destructive rollback.
 * Operator procedure for that mode:
 *
 *   pg_restore / restore-database.js a production backup into a DISPOSABLE
 *   database whose name contains "test" or "e2e", then:
 *
 *     DATABASE_URL=postgres://.../easymod_restored_test \
 *     NODE_ENV=test npm run migrate --workspace=easymod-backend
 *     DATABASE_URL=postgres://.../easymod_restored_test NODE_ENV=test \
 *     node EasyMod-backend/scripts/cutover-drill.js --against-restored
 *
 * This script never touches a database whose name is not provably disposable.
 */

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

const { assertDisposableDatabase } = require('../tests/helpers/disposable-database');

const migrations = require('../src/database/migrations/20261114_003_commercial_model_cutover');

const CUTOVER_MIGRATION = '20261114_003_commercial_model_cutover';
const BILLING_ARCHIVE = 'billing_lines_archived_20261114';

const ARGS = new Set(process.argv.slice(2));
const AGAINST_RESTORED = ARGS.has('--against-restored');

const uuid = () => crypto.randomUUID();

const fail = (message) => { throw new Error(message); };

const assert = (condition, message) => { if (!condition) fail(message); };

const normalize = (value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

function run(command, args, env, cwd) {
    const options = { cwd: cwd || repoRoot, env, stdio: 'inherit', windowsHide: true };
    if (process.platform === 'win32' && command.endsWith('.cmd')) options.shell = true;
    const result = spawnSync(command, args, options);
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function migrate(command, env) {
    const code = run(
        process.execPath,
        [path.join(backendRoot, 'src/database/migrate.js'), command],
        env,
        backendRoot,
    );
    if (code !== 0) fail(`migration command "${command}" failed with exit code ${code}`);
}

async function main() {
    const env = process.env;
    assertDisposableDatabase(env.DATABASE_URL, 'the commercial cutover drill');

    const { sequelize } = require('../src/utils/database/database-setup');
    const { QueryTypes } = require('sequelize');
    const entities = require('../src/modules/entities');
    const {
        Tenant, Shop, Subscription, Invoice, Order, Conversation, Message,
        PartnerBillingAdjustment, BillingLine,
    } = entities;

    const select = (sql, replacements) => sequelize.query(sql, {
        type: QueryTypes.SELECT,
        ...(replacements ? { replacements } : {}),
    });
    const exec = (sql, replacements) => sequelize.query(sql, { replacements });

    const countOf = async (table) => {
        const [row] = await select(`SELECT COUNT(*)::int AS c FROM ${table}`);
        return row.c;
    };
    const counts = async () => ({
        subscriptions: await countOf('subscriptions'),
        invoices: await countOf('invoices'),
        orders: await countOf('orders'),
        messages: await countOf('messages'),
    });
    const paidSummary = async () => {
        const [row] = await select(
            "SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0)::numeric AS total FROM invoices WHERE status = 'paid'",
        );
        return { count: row.c, total: Number(row.total).toFixed(2) };
    };
    const invoiceStatuses = async () => {
        const rows = await select('SELECT id, status, notes FROM invoices');
        return rows.reduce((acc, row) => {
            acc[row.id] = { status: row.status, notes: row.notes ?? null };
            return acc;
        }, {});
    };

    // ── --against-restored: post-cutover invariants only ────────────────────
    if (AGAINST_RESTORED) {
        console.log('== restored-backup mode: asserting post-cutover invariants, no seeding, no rollback');
        const subs = await select('SELECT id, plan_code, plan_name, billing_cycle, billing_model, per_order_charge_bdt, conversations_limit, orders_limit, status, legacy_plan_snapshot FROM subscriptions');
        assert(subs.length > 0, 'restored database has no subscriptions');
        for (const sub of subs) {
            assert(sub.plan_code === 'MERCHANT', `subscription ${sub.id} is not MERCHANT`);
            assert(sub.billing_cycle === 'per_order', `subscription ${sub.id} is not per_order`);
            assert(sub.billing_model === 'per_order', `subscription ${sub.id} is not per_order model`);
            assert(Number(sub.per_order_charge_bdt) === 10, `subscription ${sub.id} rate is not 10.00`);
            assert(sub.conversations_limit === -1 && sub.orders_limit === -1, `subscription ${sub.id} limits not unlimited`);
            assert(sub.status === 'active', `subscription ${sub.id} is not active`);
        }
        const events = await select('SELECT cutover_at FROM commercial_cutover_events ORDER BY cutover_at DESC LIMIT 1');
        assert(events.length === 1 && events[0].cutover_at, 'commercial_cutover_events.cutover_at is not populated');
        const [paid] = await select("SELECT COUNT(*)::int AS c FROM invoices WHERE status = 'paid'");
        assert(paid.c >= 0, 'paid invoice read failed');
        console.log(`   subscriptions: ${subs.length}; cutover_at: ${events[0].cutover_at}`);
        console.log('\nCUTOVER-DRILL (restored): PASS');
        await sequelize.close();
        return;
    }

    // ── 1. pre-cutover head ──────────────────────────────────────────────────
    console.log('== 1/7 disposable stack: migrate to head, then roll 003 back to the pre-cutover head');
    migrate('up', env);
    migrate('down', env); // 003 is the newest migration
    const [stillApplied] = await select(
        "SELECT COUNT(*)::int AS c FROM migrations WHERE name IN ('20261114_001_billing_lines','20261114_002_delivered_order_invoice_index')",
    );
    assert(stillApplied.c === 2, '001/002 must stay applied at the pre-cutover head');
    const [cutoverApplied] = await select(
        'SELECT COUNT(*)::int AS c FROM migrations WHERE name = :name',
        { name: CUTOVER_MIGRATION },
    );
    assert(cutoverApplied.c === 0, '003 must not be applied before the drill seeds data');

    // ── 2. production-shaped seed ────────────────────────────────────────────
    console.log('== 2/7 seeding production-shaped data (4 shops, orders, annual fixture, overdue, credits, top-ups)');
    const makeShop = async (label) => {
        const tenant = await Tenant.create({ name: `${label}-${uuid()}` });
        const shop = await Shop.create({
            tenant_id: tenant.id,
            unique_code: `DR-${uuid().slice(0, 8)}`.slice(0, 20),
            shop_name: `${label} shop`,
            name: `${label} shop`,
        });
        return shop;
    };

    const shopLegacy = await makeShop('Cutover suspended legacy');
    const shopFixture = await makeShop('Cutover annual fixture');
    const shopPartner = await makeShop('Cutover partner');
    const shopEngine = await makeShop('Cutover engine');

    const periodStart = new Date(Date.UTC(2026, 7, 1));
    const periodEnd = new Date(Date.UTC(2026, 8, 1));

    const legacySub = await Subscription.create({
        shop_id: shopLegacy.id, status: 'suspended', plan_code: 'GROWTH', plan_name: 'Growth',
        plan_price: 999, billing_cycle: 'monthly', billing_model: 'flat_monthly',
        conversations_limit: 500, orders_limit: 500, products_limit: 500,
        current_period_start: periodStart, current_period_end: periodEnd, next_billing_date: periodEnd,
    });
    const fixtureSub = await Subscription.create({
        shop_id: shopFixture.id, status: 'active', plan_code: 'GROWTH', plan_name: 'Growth',
        plan_price: 9990, billing_cycle: 'yearly', billing_model: 'flat_monthly',
        conversations_limit: 500, orders_limit: 500, products_limit: 500,
        current_period_start: new Date('2026-08-10T11:40:39.602Z'),
        current_period_end: new Date('2027-08-10T11:40:39.602Z'),
        next_billing_date: new Date('2027-08-10T11:40:39.602Z'),
    });
    const partnerSub = await Subscription.create({
        shop_id: shopPartner.id, status: 'active', plan_code: 'PARTNER', plan_name: 'Partnership',
        plan_price: 0, billing_cycle: 'monthly', billing_model: 'flat_monthly',
        per_order_charge_bdt: 15, conversations_limit: -1, orders_limit: -1, products_limit: -1,
        current_period_start: periodStart, current_period_end: periodEnd, next_billing_date: periodEnd,
    });
    const engineSub = await Subscription.create({
        shop_id: shopEngine.id, status: 'active', plan_code: 'MERCHANT', plan_name: 'EasyModerator',
        plan_price: 0, billing_cycle: 'per_order', billing_model: 'per_order',
        per_order_charge_bdt: 10, conversations_limit: -1, orders_limit: -1, products_limit: -1,
        current_period_start: periodStart, current_period_end: periodEnd, next_billing_date: periodEnd,
    });

    const orders = [];
    const STATUSES = [
        ['delivered', 'delivered'],
        ['delivered', 'delivered'],
        ['cancelled', null],
        ['confirmed', null],
        ['returned', null],
        ['draft', null],
    ];
    for (const shop of [shopLegacy, shopFixture, shopPartner]) {
        for (let i = 0; i < 20; i += 1) {
            const [orderStatus, fulfillment] = STATUSES[i % STATUSES.length];
            const deliveredAt = orderStatus === 'delivered'
                ? new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000)
                : null;
            // eslint-disable-next-line no-await-in-loop
            const order = await Order.create({
                shop_id: shop.id,
                order_number: `DR-${uuid()}`,
                order_status: orderStatus,
                fulfillment_status: fulfillment || 'unfulfilled',
                delivered_at: deliveredAt,
                customer_name: 'Cutover Fixture',
                customer_phone: '01711111111',
                delivery_address: 'House 1, Dhaka',
                payment_method: 'bkash',
                payment_status: 'paid',
                total: 500,
            });
            orders.push(order);
        }
    }

    const conversation = await Conversation.create({
        shop_id: shopLegacy.id, channel: 'messenger', status: 'active', role: 'user', message: 'hello',
    });
    for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Message.create({
            conversation_id: conversation.id,
            sender: i % 2 === 0 ? 'customer' : 'business',
            content: `fixture message ${i}`,
            external_id: `dr-${uuid()}`,
        });
    }

    // Annual test fixture: PAID yearly invoice through manual reconciliation.
    const fixtureInvoice = await Invoice.create({
        subscription_id: fixtureSub.id, shop_id: shopFixture.id,
        invoice_number: `INV-DR-${uuid().slice(0, 6).toUpperCase()}`,
        invoice_type: 'yearly_subscription', amount: 9990, base_amount: 9990,
        billing_period: '2026-08', billing_period_start: new Date('2026-08-10T00:00:00.000Z'),
        billing_period_end: new Date('2027-08-10T00:00:00.000Z'),
        status: 'paid', paid_at: new Date('2026-08-10T11:40:39.602Z'),
        due_date: new Date('2026-08-17T00:00:00.000Z'),
        payment_method: 'manual_test_reconciliation', metadata: {},
    });
    // Open legacy invoice on the suspended shop.
    const overdueInvoice = await Invoice.create({
        subscription_id: legacySub.id, shop_id: shopLegacy.id,
        invoice_number: `INV-DR-${uuid().slice(0, 6).toUpperCase()}`,
        invoice_type: 'monthly_subscription', amount: 999, base_amount: 999,
        billing_period: '2026-08', billing_period_start: periodStart, billing_period_end: periodEnd,
        status: 'overdue', due_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), metadata: {},
    });
    // Paid Partner invoice + a pending return credit against one of its orders.
    const partnerOrder = orders.find((order) => order.shop_id === shopPartner.id);
    const partnerInvoice = await Invoice.create({
        subscription_id: partnerSub.id, shop_id: shopPartner.id,
        invoice_number: `INV-DR-${uuid().slice(0, 6).toUpperCase()}`,
        invoice_type: 'partner_per_order', amount: 120, base_amount: 0, extra_usage_amount: 120,
        billing_period: '2026-08', billing_period_start: periodStart, billing_period_end: periodEnd,
        status: 'paid', paid_at: new Date(), payment_method: 'bkash',
        due_date: new Date('2026-08-17T00:00:00.000Z'), metadata: {},
    });
    const adjustment = await PartnerBillingAdjustment.create({
        shop_id: shopPartner.id, order_id: partnerOrder.id, amount_bdt: 10.0,
        reason: 'return_reversal', status: 'pending',
    });
    // A small paid monthly invoice that must never be rewritten either.
    const paidMonthly = await Invoice.create({
        subscription_id: legacySub.id, shop_id: shopLegacy.id,
        invoice_number: `INV-DR-${uuid().slice(0, 6).toUpperCase()}`,
        invoice_type: 'monthly_subscription', amount: 50, base_amount: 50,
        billing_period: '2026-06', billing_period_start: new Date(Date.UTC(2026, 5, 1)),
        billing_period_end: new Date(Date.UTC(2026, 6, 1)),
        status: 'paid', paid_at: new Date(), payment_method: 'bkash',
        due_date: new Date('2026-06-08T00:00:00.000Z'), metadata: {},
    });

    for (let i = 0; i < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await exec(
            `INSERT INTO topup_transactions
                (id, shop_id, pack_code, pack_conversations, amount_bdt, status)
             VALUES (:id, :shop_id, 'PACK_100', 100, 99.00, 'pending')`,
            { id: uuid(), shop_id: shopLegacy.id },
        );
    }

    // ── 3. baseline ──────────────────────────────────────────────────────────
    const baselineCounts = await counts();
    const baselinePaid = await paidSummary();
    const baselineInvoices = await invoiceStatuses();
    console.log(`   baseline: ${JSON.stringify(baselineCounts)}, paid ${baselinePaid.count} / BDT ${baselinePaid.total}`);

    // ── 4. apply 003 ─────────────────────────────────────────────────────────
    console.log('== 3/7 applying 20261114_003');
    migrate('up', env);

    const afterCounts = await counts();
    assert(JSON.stringify(afterCounts) === JSON.stringify(baselineCounts),
        `row counts changed across the cutover: ${JSON.stringify(afterCounts)} != ${JSON.stringify(baselineCounts)}`);
    const afterPaid = await paidSummary();
    assert(JSON.stringify(afterPaid) === JSON.stringify(baselinePaid),
        `paid invoice count/SUM changed: ${JSON.stringify(afterPaid)} != ${JSON.stringify(baselinePaid)}`);

    const subs = await select('SELECT * FROM subscriptions');
    assert(subs.length === 4, `expected 4 subscriptions, found ${subs.length}`);
    for (const sub of subs) {
        assert(sub.plan_code === 'MERCHANT', `subscription ${sub.id} plan_code=${sub.plan_code}`);
        assert(sub.plan_name === 'EasyModerator', `subscription ${sub.id} plan_name=${sub.plan_name}`);
        assert(Number(sub.plan_price) === 0, `subscription ${sub.id} plan_price=${sub.plan_price}`);
        assert(sub.billing_cycle === 'per_order', `subscription ${sub.id} billing_cycle=${sub.billing_cycle}`);
        assert(sub.billing_model === 'per_order', `subscription ${sub.id} billing_model=${sub.billing_model}`);
        assert(Number(sub.per_order_charge_bdt) === 10, `subscription ${sub.id} rate=${sub.per_order_charge_bdt}`);
        assert(sub.conversations_limit === -1, `subscription ${sub.id} conversations_limit=${sub.conversations_limit}`);
        assert(sub.orders_limit === -1, `subscription ${sub.id} orders_limit=${sub.orders_limit}`);
        assert(sub.status === 'active', `subscription ${sub.id} status=${sub.status}`);
        assert(sub.current_period_start && sub.current_period_end, `subscription ${sub.id} period is not collapsed`);
    }

    const fixtureSnapshot = (await select(
        'SELECT legacy_plan_snapshot FROM subscriptions WHERE id = :id', { id: fixtureSub.id },
    ))[0].legacy_plan_snapshot;
    assert(fixtureSnapshot && fixtureSnapshot.reason === 'annual_test_fixture_full_credit_no_charge',
        `annual fixture snapshot reason missing: ${JSON.stringify(fixtureSnapshot && fixtureSnapshot.reason)}`);
    assert(fixtureSnapshot.previousPeriod && fixtureSnapshot.previousPeriod.start === '2026-08-10T11:40:39.602Z',
        'annual fixture snapshot must retain the original period');

    const restoredFixtureInvoice = await Invoice.findByPk(fixtureInvoice.id);
    assert(restoredFixtureInvoice.status === 'paid' && Number(restoredFixtureInvoice.amount) === 9990,
        'the annual fixture PAID yearly invoice was modified');

    const cancelledOverdue = await Invoice.findByPk(overdueInvoice.id);
    assert(cancelledOverdue.status === 'cancelled', `legacy overdue invoice status=${cancelledOverdue.status}`);
    assert(/Superseded by delivered-order model/.test(cancelledOverdue.notes || ''),
        'cancelled legacy invoice is missing the full-credit note');

    // A8 regression: the merchant pays the cancelled legacy invoice AFTER the
    // cutover. A rollback must never turn a settled payment back into a debt
    // (which would also corrupt the paid COUNT/SUM).
    await exec(
        "UPDATE invoices SET status = 'paid', paid_at = :paid_at WHERE id = :id",
        { id: overdueInvoice.id, paid_at: new Date() },
    );
    const paidAfterPostCutoverPayment = await paidSummary();
    assert(paidAfterPostCutoverPayment.count === baselinePaid.count + 1,
        `post-cutover payment not recorded: ${JSON.stringify(paidAfterPostCutoverPayment)}`);

    const stillPaidPartner = await Invoice.findByPk(partnerInvoice.id);
    assert(stillPaidPartner.status === 'paid', 'the paid Partner invoice was modified');
    const stillPaidMonthly = await Invoice.findByPk(paidMonthly.id);
    assert(stillPaidMonthly.status === 'paid', 'a paid monthly invoice was modified');
    await adjustment.reload();
    assert(adjustment.status === 'pending', 'a pending return credit was consumed at cutover');

    const events = await select('SELECT cutover_at FROM commercial_cutover_events');
    assert(events.length >= 4, `expected a cutover event per entity, found ${events.length}`);
    assert(events.every((event) => event.cutover_at instanceof Date), 'cutover_at is not populated');
    // The engine reads the newest event.
    const billingService = require('../src/modules/commercial/delivered-order-billing.service');
    billingService.__resetForTests();
    const readCutover = await billingService.getCommercialCutoverAt();
    assert(readCutover instanceof Date, 'getCommercialCutoverAt did not read the persisted cutover');

    // Snapshot of pre-cutover values, for the rollback comparison.
    const snapshots = (await select('SELECT id, legacy_plan_snapshot FROM subscriptions'))
        .reduce((acc, row) => { acc[row.id] = row.legacy_plan_snapshot; return acc; }, {});

    // ── 5. exercise the new engine ───────────────────────────────────────────
    console.log('== 4/7 exercising the delivered-order engine on post-cutover deliveries');
    const now = new Date();
    const engineDelivered = [];
    for (let i = 0; i < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const order = await Order.create({
            shop_id: shopEngine.id, order_number: `DR-ENG-${uuid()}`,
            order_status: 'delivered', fulfillment_status: 'delivered', delivered_at: now,
            customer_name: 'Engine Fixture', customer_phone: '01711111111', total: 500,
        });
        engineDelivered.push(order);
        // eslint-disable-next-line no-await-in-loop
        await billingService.recordOutcomeLine({
            shopId: shopEngine.id, orderId: order.id, outcome: 'DELIVERED',
            occurredAt: now, source: 'courier_webhook',
        });
    }
    const engineReturned = await Order.create({
        shop_id: shopEngine.id, order_number: `DR-ENG-${uuid()}`,
        order_status: 'cancelled', fulfillment_status: 'cancelled', delivered_at: null,
        customer_name: 'Engine Fixture', customer_phone: '01711111111', total: 500,
    });
    await billingService.recordOutcomeLine({
        shopId: shopEngine.id, orderId: engineReturned.id, outcome: 'RETURNED',
        occurredAt: now, source: 'courier_webhook',
    });

    const InvoiceGenerator = require('../src/jobs/invoice-generator');
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 1, 0, 0));
    await new InvoiceGenerator().run({ dryRun: false, runDate: nextMonth });

    const engineInvoice = await Invoice.findOne({
        where: { shop_id: shopEngine.id, invoice_type: 'delivered_order' },
    });
    assert(engineInvoice, 'the engine did not issue a delivered_order invoice');
    assert(Number(engineInvoice.amount) === 20,
        `engine invoice amount=${engineInvoice.amount}, expected 20.00 (2 delivered x BDT 10)`);
    assert(engineInvoice.metadata.deliveredCount === 2, 'engine deliveredCount mismatch');
    assert(engineInvoice.metadata.zeroRatedCount === 1, 'engine zeroRatedCount mismatch');
    assert(engineInvoice.metadata.netMinor === 2000, 'engine netMinor mismatch');
    const engineLines = await BillingLine.findAll({ where: { shop_id: shopEngine.id } });
    assert(engineLines.length === 3, `expected 3 billing lines for the engine shop, found ${engineLines.length}`);
    assert(engineLines.every((line) => line.invoice_id === engineInvoice.id),
        'not every engine line was claimed by the invoice');

    const liveBillingLines = await countOf('billing_lines');
    const postEngineInvoices = await countOf('invoices');

    // ── 6. roll back three migrations ────────────────────────────────────────
    console.log('== 5/7 rolling back 003, 002 and 001 (three migrations)');
    migrate('down', env);
    migrate('down', env);
    migrate('down', env);

    const restoredSubs = await select('SELECT * FROM subscriptions');
    assert(restoredSubs.length === subs.length, 'subscription rows were lost in rollback');
    for (const sub of restoredSubs) {
        const before = snapshots[sub.id]?.previous;
        assert(before, `subscription ${sub.id} has no pre-cutover snapshot`);
        for (const field of migrations.SUBSCRIPTION_FIELDS) {
            assert(
                normalize(sub[field]) === normalize(before[field]),
                `subscription ${sub.id}.${field} not restored: ${normalize(sub[field])} != ${normalize(before[field])}`,
            );
        }
    }

    const restoredInvoices = await invoiceStatuses();
    for (const [id, expected] of Object.entries(baselineInvoices)) {
        const actual = restoredInvoices[id];
        assert(actual, `invoice ${id} disappeared in rollback`);
        if (id === overdueInvoice.id) {
            // A8: paid after the cutover — `down` must leave it paid.
            assert(actual.status === 'paid',
                `A8: a legacy invoice paid after cutover was reverted to '${actual.status}'`);
            continue;
        }
        assert(actual.status === expected.status, `invoice ${id} status not restored: ${actual.status} != ${expected.status}`);
        assert(normalize(actual.notes) === normalize(expected.notes), `invoice ${id} notes not restored`);
    }

    const archiveCount = await countOf(BILLING_ARCHIVE);
    assert(archiveCount === liveBillingLines,
        `archived billing_lines count ${archiveCount} != pre-down live count ${liveBillingLines}`);
    assert(await countOf('invoices') === postEngineInvoices,
        'the rollback added or removed invoices (only statuses may be restored)');
    const restoredPaid = await paidSummary();
    assert(JSON.stringify(restoredPaid) === JSON.stringify(paidAfterPostCutoverPayment),
        `paid money changed across rollback: ${JSON.stringify(restoredPaid)} != ${JSON.stringify(paidAfterPostCutoverPayment)}`);

    const [legacyColumn] = await select(
        "SELECT COUNT(*)::int AS c FROM information_schema.columns WHERE table_name='subscriptions' AND column_name='legacy_plan_snapshot'",
    );
    assert(legacyColumn.c === 0, 'legacy_plan_snapshot column was not dropped');
    const [eventsTable] = await select(
        "SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name='commercial_cutover_events'",
    );
    assert(eventsTable.c === 0, 'commercial_cutover_events table was not dropped');

    // ── 7. re-apply and prove idempotence ────────────────────────────────────
    console.log('== 6/7 re-applying migrations');
    migrate('up', env);
    const reApplied = await select('SELECT id, plan_code, status, legacy_plan_snapshot FROM subscriptions');
    assert(reApplied.length === subs.length, 'subscription rows changed on re-apply');
    assert(reApplied.every((sub) => sub.plan_code === 'MERCHANT'), 're-apply did not restore MERCHANT tier');
    const reEvents = await countOf('commercial_cutover_events');
    assert(reEvents >= subs.length, `expected cutover events after re-apply, found ${reEvents}`);

    console.log('== 7/7 idempotence: calling up() again on a migrated database writes nothing');
    const deliveredInvoiceCount = await select("SELECT COUNT(*)::int AS c FROM invoices WHERE invoice_type='delivered_order'");
    await migrations.up(sequelize);
    const reEventsAgain = await countOf('commercial_cutover_events');
    assert(reEventsAgain === reEvents, `up() is not idempotent: events ${reEvents} -> ${reEventsAgain}`);
    const afterAngle = await select("SELECT COUNT(*)::int AS c FROM invoices WHERE invoice_type='delivered_order'");
    assert(afterAngle[0].c === deliveredInvoiceCount[0].c, 'up() created or removed delivered_order invoices');

    console.log(`   counts after re-apply: ${JSON.stringify(await counts())}`);
    console.log('   paid money: unchanged');
    console.log(`   archived billing lines: ${archiveCount}`);
    await sequelize.close();
    console.log('\nCUTOVER-DRILL: PASS');
}

main().catch((error) => {
    console.error('\nCUTOVER-DRILL: FAIL —', error.message);
    console.error('STACK:', String(error.stack).split('\n').slice(0, 8).join('\n'));
    try { require('../src/utils/database/database-setup').sequelize.close(); } catch { /* already closed */ }
    process.exitCode = 1;
});