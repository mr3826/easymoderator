'use strict';

const { Queue, Worker } = require('bullmq');
const config = require('../config/config');
const { isRuntimeFlagEnabled } = require('../config/ai-runtime-flags');
const { connection, messageQueue } = require('./message-queue');

const {
    MonthlyUsageReset,
    InvoiceGenerator,
    FailedPaymentReconciler,
    DailySalesSummaryNotifier,
    CustomerWaitingNotifier,
    MetaTokenRefreshJob,
    PipelineCanaryJob,
    WebhookReceiptReconcilerJob,
    InboxDeliveryReconcilerJob,
    OpportunityDetectorJob,
    GapSuggesterJob,
    CourierReconciliationJob,
} = require('./index');

class QueueManager {
    constructor() {
        this.queues = {};
        this.workers = {};
        this.workerStarted = false;

        if (!config.redisUrl && !config.redisHost) {
            console.warn('⚠️  Redis not available - job queues disabled');
            return;
        }

        this.initializeQueues();
    }

    initializeQueues() {
        const defaultJobOptions = {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 }, // 5s → 25s → 125s
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 200 }, // DLQ: retain last 200 failed jobs
        };

        const billingQueues = [
            ['monthly-usage-reset', 'monthlyReset', MonthlyUsageReset],
            ['invoice-generator', 'invoiceGenerator', InvoiceGenerator],
            ['failed-payment-reconciler', 'paymentReconciler', FailedPaymentReconciler],
            ['daily-sales-summary-notifier', 'dailySalesSummaryNotifier', DailySalesSummaryNotifier],
            ['customer-waiting-notifier', 'customerWaitingNotifier', CustomerWaitingNotifier],
            // Phase 2 — refresh Meta channel tokens before they expire.
            ['meta-token-refresh', 'metaTokenRefresh', MetaTokenRefreshJob],
            // Reliability — auto-reply pipeline canary (every 5 min, see scheduleJobs)
            ['pipeline-canary', 'pipelineCanary', PipelineCanaryJob],
            // Reliability — replay inbound Meta events held as durable receipts
            ['webhook-receipt-reconciler', 'webhookReceiptReconciler', WebhookReceiptReconcilerJob],
            ['inbox-delivery-reconciler', 'inboxDeliveryReconciler', InboxDeliveryReconcilerJob],
            // Pilot intelligence — Sales Opportunities sweep; a no-op for shops without the flag
            ['opportunity-detector', 'opportunityDetector', OpportunityDetectorJob],
            // Pilot+ P+05 — knowledge-gap suggestion sweep; no-op without the flag
            ['gap-suggester', 'gapSuggester', GapSuggesterJob],
            // COD reconciliation — scheduled only when COURIER_RECON_JOBS_ENABLED
            // is set (see scheduleJobs); manual trigger always available.
            ['courier-reconciliation', 'courierReconciliation', CourierReconciliationJob],
        ];

        this.workerDefinitions = billingQueues;
        for (const [queueName, key] of billingQueues) {
            this.queues[key] = new Queue(queueName, { connection, defaultJobOptions });
        }

        // Push notification — fire-and-forget, expired subs auto-cleaned
        this.queues.notifications = new Queue('notifications', {
            connection,
            defaultJobOptions: {
                attempts: 2,
                backoff: { type: 'fixed', delay: 3000 },
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 100 },
            },
        });

        // Observability-only handles for the customer-facing reply pipeline.
        // The message-processing queue is the singleton created in message-queue.js
        // (and consumed by the worker started below); message-dlq is the sink that
        // message-worker.js writes dead-lettered jobs into. Registering references
        // here lets /health/detailed and getCriticalQueueStats() read their depths.
        // No worker is attached — message-dlq is intentionally a manual-drain sink.
        this.queues.messageProcessing = messageQueue;
        this.queues.messageDlq = new Queue('message-dlq', { connection });

        console.log('✅ BullMQ queue handles initialized');
    }

    // Importing this module is safe for API routes and health reporting. Only
    // the dedicated worker entrypoint (or explicit single-process mode) calls
    // startWorkers(), so loading a controller cannot start job consumers.
    startWorkers() {
        if (this.workerStarted || (!config.redisUrl && !config.redisHost)) return;

        for (const [queueName, key, JobClass] of this.workerDefinitions) {
            this.workers[key] = new Worker(queueName, async (job) => {
                const instance = new JobClass();
                return instance.execute({
                    dryRun: job.data.dryRun,
                    runDate: job.data.runDate ? new Date(job.data.runDate) : new Date(),
                });
            }, { connection });
        }

        this.workers.notifications = new Worker('notifications', async (job) => {
            const { dispatchQueuedNotification } = require('../modules/notification/merchant-notification.service');
            return dispatchQueuedNotification(job.data || {});
        }, {
            connection,
            limiter: { max: 50, duration: 10000 },
        });

        for (const [name, worker] of Object.entries(this.workers)) {
            worker.on('completed', (job) => {
                console.log(`✅ Job ${name} #${job.id} completed`);
            });

            worker.on('failed', (job, err) => {
                const isTerminal = job.attemptsMade >= (job.opts.attempts || 1);
                if (isTerminal) {
                    console.error(
                        `[DLQ] Job ${name} #${job.id} exhausted all retries after ` +
                        `${job.attemptsMade} attempts. Error: ${err.message}`
                    );
                    QueueManager.sendSlackAlert(
                        `[DLQ] Job \`${name}\` #${job.id} exhausted all ${job.attemptsMade} retries.\n` +
                        `Error: \`${err.message}\``
                    ).catch(() => {});
                } else {
                    console.warn(
                        `⚠️  Job ${name} #${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${err.message}`
                    );
                }
            });

            worker.on('stalled', (jobId) => {
                console.warn(`⚠️  Job ${name} #${jobId} stalled — will be retried`);
            });
        }

        // Start the AI message-processing worker. Must be registered AFTER the generic
        // event-listener loop above so its own detailed listeners (set inside startWorker)
        // are not overridden by the generic ones.
        const { startWorker: startMessageProcessingWorker, getWorker } = require('./message-worker');
        this.workers.messageProcessing = getWorker() || startMessageProcessingWorker();

        this.workerStarted = true;
        console.log('✅ BullMQ workers started');
    }

    async waitUntilReady() {
        if (!this.workerStarted) return;
        await Promise.all(Object.values(this.workers).map((worker) => worker.waitUntilReady()));
    }

    async scheduleJobs() {
        if (!config.redisUrl && !config.redisHost) {
            console.warn('⚠️  Cannot schedule jobs - Redis not available');
            return;
        }

        await this.queues.monthlyReset.upsertJobScheduler(
            'monthly-usage-reset',
            { pattern: '0 0 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        await this.queues.invoiceGenerator.upsertJobScheduler(
            'invoice-generator',
            { pattern: '0 1 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        await this.queues.paymentReconciler.upsertJobScheduler(
            'failed-payment-reconciler',
            { pattern: '0 2 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Merchant alerts — summarize the previous 24h shortly after the
        // Bangladesh business day rolls over (00:05 Asia/Dhaka = 18:05 UTC).
        await this.queues.dailySalesSummaryNotifier.upsertJobScheduler(
            'daily-sales-summary-notifier',
            { pattern: '5 18 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        await this.queues.customerWaitingNotifier.upsertJobScheduler(
            'customer-waiting-notifier',
            { pattern: '*/15 * * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Phase 2 — refresh Meta tokens every 6 hours so they never expire silently.
        await this.queues.metaTokenRefresh.upsertJobScheduler(
            'meta-token-refresh',
            { pattern: '0 */6 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Reliability — run the auto-reply pipeline canary every 5 minutes so a
        // down/wedged worker or a non-empty DLQ pages within one interval.
        await this.queues.pipelineCanary.upsertJobScheduler(
            'pipeline-canary',
            { pattern: '*/5 * * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Reliability — replay held inbound Meta events every 2 minutes. A
        // message whose Page was momentarily unresolved reaches the merchant in
        // minutes rather than never.
        await this.queues.webhookReceiptReconciler.upsertJobScheduler(
            'webhook-receipt-reconciler',
            { pattern: '*/2 * * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        await this.queues.inboxDeliveryReconciler.upsertJobScheduler(
            'inbox-delivery-reconciler',
            { pattern: '*/2 * * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Pilot intelligence — detect/convert/expire Sales Opportunities. Each
        // shop is processed under a Postgres advisory lock, so an overlapping
        // run on another instance skips instead of racing.
        await this.queues.opportunityDetector.upsertJobScheduler(
            'opportunity-detector',
            { pattern: '*/10 * * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // Pilot+ P+05 — daily deterministic knowledge-gap grouping.
        await this.queues.gapSuggester.upsertJobScheduler(
            'gap-suggester',
            { pattern: '15 3 * * *', tz: 'UTC' },
            { name: 'run', data: { dryRun: false } }
        );

        // COD reconciliation — weekly Steadfast payout pull. The payments API's
        // account semantics are not live-verified yet (see
        // docs/mobile/COD_CAPABILITY_AUDIT.md), so the schedule stays OFF until
        // an operator sets COURIER_RECON_JOBS_ENABLED=true. Manual trigger via
        // triggerJob('courier_reconciliation') is unaffected by this gate.
        if (isRuntimeFlagEnabled('COURIER_RECON_JOBS_ENABLED')) {
            await this.queues.courierReconciliation.upsertJobScheduler(
                'courier-reconciliation',
                { pattern: '0 3 * * 0', tz: 'UTC' },
                { name: 'run', data: { dryRun: false } }
            );
        } else {
            console.log('ℹ️  Courier reconciliation schedule skipped (COURIER_RECON_JOBS_ENABLED off)');
        }

        console.log('✅ Scheduled jobs configured');
    }

    async triggerJob(jobName, options = {}) {
        const queueMap = {
            'monthly_usage_reset': 'monthlyReset',
            'invoice_generator': 'invoiceGenerator',
            'failed_payment_reconciler': 'paymentReconciler',
            'daily_sales_summary_notifier': 'dailySalesSummaryNotifier',
            'customer_waiting_notifier': 'customerWaitingNotifier',
            'meta_token_refresh': 'metaTokenRefresh',
            'pipeline_canary': 'pipelineCanary',
            'webhook_receipt_reconciler': 'webhookReceiptReconciler',
            'inbox_delivery_reconciler': 'inboxDeliveryReconciler',
            'opportunity_detector': 'opportunityDetector',
            'courier_reconciliation': 'courierReconciliation',
        };

        const queueKey = queueMap[jobName];
        if (!queueKey || !this.queues[queueKey]) {
            throw new Error(`Unknown job: ${jobName}`);
        }

        return this.queues[queueKey].add('run', {
            dryRun: options.dryRun || false,
            runDate: options.runDate ? new Date(options.runDate).toISOString() : new Date().toISOString(),
        }, { priority: 1, removeOnComplete: true });
    }

    async getQueueStats(queueName) {
        const queue = this.queues[queueName];
        if (!queue) return null;

        const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
        ]);

        return { waiting, active, completed, failed, delayed };
    }

    /**
     * Stats for the CUSTOMER-FACING reply pipeline — the queues that actually
     * decide whether a buyer gets an answer. Surfaced by /health/detailed so the
     * reply path and its dead-letter queue are observable (previously only the
     * billing queues were). `dlq > 0` means messages failed every retry.
     */
    async getCriticalQueueStats() {
        const keys = ['messageProcessing', 'notifications', 'messageDlq'];
        const out = {};
        await Promise.all(keys.map(async (key) => {
            try {
                out[key] = (await this.getQueueStats(key)) || null;
            } catch (_) {
                out[key] = { error: 'unavailable' };
            }
        }));
        return out;
    }

    async cleanup() {
        await Promise.all(
            Object.values(this.queues).map(q => q.clean(7 * 24 * 60 * 60 * 1000, 1000, 'completed'))
        );
        console.log('✅ Queue cleanup completed');
    }

    async close() {
        await Promise.all([
            ...Object.values(this.workers).map(w => w.close()),
            ...Object.values(this.queues).map(q => q.close()),
        ]);
        console.log('Queue manager closed');
    }

    static async sendSlackAlert(text) {
        const url = process.env.SLACK_ALERT_WEBHOOK_URL;
        if (!url) return;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
    }
}

const queueManager = new QueueManager();
module.exports = queueManager;
