const BaseJob = require('./base-job');
const { DeliveryIntegration } = require('../modules/entities');
const ReconciliationService = require('../modules/reconciliation/reconciliation.service');

/**
 * Courier Reconciliation Job
 *
 * Pulls Steadfast payout records for every shop with an active Steadfast integration
 * and auto-creates disputes when COD collection claims don't match order records.
 *
 * Schedule: weekly (e.g. Sunday 03:00 UTC — after couriers settle the week's payouts)
 * Usage: node src/jobs/job-runner.js courier_reconciliation [--dry-run]
 */
class CourierReconciliationJob extends BaseJob {
    constructor() {
        super('courier_reconciliation');
    }

    async run({ dryRun, runDate, executionId }) {
        this.logger.info(`[${this.jobName}] Starting courier reconciliation`, { dryRun, runDate });

        const results = {
            shopsProcessed: 0,
            collectionsRecorded: 0,
            disputesCreated: 0,
            duplicatesSkipped: 0,
            errors: []
        };

        // Bounded pages: one large merchant set must not hold every active
        // integration row (and its payment pull) in memory at once.
        const PAGE_SIZE = 50;
        let offset = 0;
        let page;

        do {
            page = await DeliveryIntegration.findAll({
                where: { provider: 'steadfast', is_active: true },
                attributes: ['shop_id'],
                order: [['shop_id', 'ASC']],
                limit: PAGE_SIZE,
                offset
            });

            for (const { shop_id } of page) {
                try {
                    if (dryRun) {
                        this.logger.info(`[${this.jobName}] DRY RUN: would pull payments for shop ${shop_id}`);
                        results.shopsProcessed++;
                        continue;
                    }

                    const { collected, disputes, skipped } = await ReconciliationService.pullSteadfastPayments(shop_id);
                    results.shopsProcessed++;
                    results.collectionsRecorded += collected;
                    results.disputesCreated += disputes;
                    results.duplicatesSkipped += skipped || 0;

                    this.logger.info(`[${this.jobName}] Shop ${shop_id}: ${collected} collections, ${disputes} disputes`);
                } catch (err) {
                    results.errors.push({ shop_id, error: err.message });
                    this.logger.error(`[${this.jobName}] Failed for shop ${shop_id}`, { error: err.message });
                }
            }

            offset += page.length;
        } while (page.length === PAGE_SIZE);

        this.logger.info(`[${this.jobName}] Run complete`, {
            shopsProcessed: results.shopsProcessed,
            collectionsRecorded: results.collectionsRecorded,
            disputesCreated: results.disputesCreated,
            duplicatesSkipped: results.duplicatesSkipped,
            errors: results.errors.length,
        });

        return results;
    }
}

module.exports = CourierReconciliationJob;
