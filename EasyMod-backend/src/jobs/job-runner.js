#!/usr/bin/env node

/**
 * Job Runner - CLI Tool
 * 
 * Executes scheduled jobs with dry-run support.
 * Can be invoked manually or via cron.
 * 
 * Usage:
 *   node src/jobs/job-runner.js <job-name> [--dry-run] [--date=YYYY-MM-DD]
 * 
 * Examples:
 *   node src/jobs/job-runner.js monthly_usage_reset --date=2026-02-01
 *   node src/jobs/job-runner.js invoice_generator
 *   node src/jobs/job-runner.js failed_payment_reconciler --dry-run
 */

const jobs = require('./index');

const JOB_MAP = {
    'monthly_usage_reset': jobs.MonthlyUsageReset,
    'invoice_generator': jobs.InvoiceGenerator,
    'failed_payment_reconciler': jobs.FailedPaymentReconciler,
    'courier_reconciliation': jobs.CourierReconciliationJob,  // Schedule: cron '0 3 * * 0' (Sunday 03:00 UTC)
    'inbox_delivery_reconciler': jobs.InboxDeliveryReconcilerJob,
    'opportunity_detector': jobs.OpportunityDetectorJob,
    'gap_suggester': jobs.GapSuggesterJob,
    'confidence_qualification_snapshot': jobs.ConfidenceQualificationSnapshotJob,  // Schedule: cron '30 3 * * *' (daily 03:30 UTC, WP-03)
};

async function runJob() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const jobName = args[0];
    const dryRun = args.includes('--dry-run');
    const dateArg = args.find(arg => arg.startsWith('--date='));
    const runDate = dateArg ? new Date(dateArg.split('=')[1]) : new Date();

    // Validate job name
    if (!jobName) {
        console.error('Error: Job name is required');
        console.error('');
        console.error('Available jobs:');
        Object.keys(JOB_MAP).forEach(name => {
            console.error(`  - ${name}`);
        });
        console.error('');
        console.error('Usage: node src/jobs/job-runner.js <job-name> [--dry-run] [--date=YYYY-MM-DD]');
        process.exit(1);
    }

    const JobClass = JOB_MAP[jobName];
    if (!JobClass) {
        console.error(`Error: Unknown job "${jobName}"`);
        console.error('');
        console.error('Available jobs:');
        Object.keys(JOB_MAP).forEach(name => {
            console.error(`  - ${name}`);
        });
        process.exit(1);
    }

    // Display execution info
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Job: ${jobName}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will make changes)'}`);
    console.log(`Date: ${runDate.toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    try {
        // Execute job
        const job = new JobClass();
        const result = await job.execute({ dryRun, runDate });

        // Display results
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('EXECUTION RESULT');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(JSON.stringify(result, null, 2));
        console.log('');

        // Exit with success
        process.exit(0);

    } catch (error) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════');
        console.error('EXECUTION FAILED');
        console.error('═══════════════════════════════════════════════════════════════');
        console.error(error);
        console.error('');

        // Exit with error
        process.exit(1);
    }
}

// Run job
runJob();
