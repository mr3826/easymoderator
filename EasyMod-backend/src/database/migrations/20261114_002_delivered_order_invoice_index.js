'use strict';

/**
 * 20261114_002 — one delivered-order invoice per subscription per period.
 *
 * The invoice generator derives a "previous UTC calendar month" period, so the
 * same subscription must never receive two delivered-order invoices for that
 * period even under concurrent runs or unique-constraint recovery.
 */

const INDEX_NAME = 'idx_invoices_delivered_order_period';

module.exports = {
    name: '20261114_002_delivered_order_invoice_index',

    async up(sequelize) {
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
                ON invoices(subscription_id, invoice_type, billing_period_start)
                WHERE invoice_type = 'delivered_order';
        `);
    },

    async down(sequelize) {
        await sequelize.query(`DROP INDEX IF EXISTS ${INDEX_NAME};`);
    },
};