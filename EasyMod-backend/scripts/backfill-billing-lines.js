'use strict';

/**
 * Idempotent billing-line backfill CLI (ADR-0011).
 *
 * Reconstructs missing `billing_lines` for terminal orders that a dropped
 * courier callback or a deploy gap left unbilled. It is the same
 * `catchUpLines()` pass the invoice generator runs before aggregating, exposed
 * for operators.
 *
 * Safety:
 *  - DRY RUN by default; `--apply` is required to write.
 *  - Refuses to run when no commercial cutover instant is persisted: history
 *    before the recorded commercial start must never be turned into charges.
 *  - Deterministic idempotency keys + the unique indexes make re-runs safe;
 *    `catchUpLines` skips any order that already has a line.
 *
 * Usage:
 *   node scripts/backfill-billing-lines.js --month=2026-10
 *   node scripts/backfill-billing-lines.js --month=2026-10 --apply
 *   node scripts/backfill-billing-lines.js --shop=<uuid> --period-start=2026-10-01 --period-end=2026-11-01 --apply
 */

const { sequelize } = require('../src/utils/database/database-setup');
const { Subscription } = require('../src/modules/entities');
const {
    catchUpLines,
    getCommercialCutoverAt,
} = require('../src/modules/commercial/delivered-order-billing.service');

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const valueOf = (name) => {
    const prefix = `--${name}=`;
    const match = args.find((arg) => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
};

const APPLY = hasFlag('--apply');
const SHOP_ID = valueOf('shop');

function periodFromMonth(month) {
    if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
    const [year, monthIndex] = month.split('-').map(Number);
    if (monthIndex < 1 || monthIndex > 12) return null;
    return {
        start: new Date(Date.UTC(year, monthIndex - 1, 1)),
        end: new Date(Date.UTC(year, monthIndex, 1)),
    };
}

function resolvePeriod() {
    const startRaw = valueOf('period-start');
    const endRaw = valueOf('period-end');
    if (startRaw || endRaw) {
        const start = startRaw ? new Date(startRaw) : null;
        const end = endRaw ? new Date(endRaw) : null;
        if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            throw new Error('--period-start and --period-end must be valid ISO dates');
        }
        return { start, end };
    }
    const month = valueOf('month');
    const period = periodFromMonth(month);
    if (!period) {
        throw new Error('Provide --month=YYYY-MM or --period-start/--period-end (ISO dates)');
    }
    return period;
}

async function main() {
    const period = resolvePeriod();
    const cutoverAt = await getCommercialCutoverAt();
    if (!cutoverAt) {
        throw new Error('No persisted commercial cutover instant; refusing to reconstruct pre-cutover history');
    }

    const where = SHOP_ID ? { shop_id: SHOP_ID, status: 'active' } : { status: 'active' };
    const subscriptions = await Subscription.findAll({
        where,
        attributes: ['id', 'shop_id'],
        order: [['id', 'ASC']],
    });

    const totals = { shops: subscriptions.length, considered: 0, created: 0, skipped: 0 };
    for (const subscription of subscriptions) {
        // eslint-disable-next-line no-await-in-loop
        const result = await catchUpLines({
            shopId: subscription.shop_id,
            periodStart: period.start,
            periodEnd: period.end,
            cutoverAt,
        }, null);
        totals.considered += result.considered;
        totals.created += result.created;
        totals.skipped += result.skipped;
        if (!APPLY && result.created > 0) {
            console.log(`[dry-run] shop ${subscription.shop_id}: would create ${result.created}`);
        }
    }

    console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} backfill ${period.start.toISOString()}..${period.end.toISOString()}`);
    console.log(JSON.stringify(totals));
    if (!APPLY) console.log('Re-run with --apply to write the lines.');
}

main()
    .then(async () => { await sequelize.close(); process.exitCode = 0; })
    .catch(async (error) => {
        console.error(`backfill-billing-lines failed: ${error.message}`);
        try { await sequelize.close(); } catch { /* already closed */ }
        process.exitCode = 1;
    });