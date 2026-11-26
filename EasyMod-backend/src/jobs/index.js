/**
 * Job Registry
 * 
 * Central registry for all scheduled jobs.
 * Import and export all job classes for easy access.
 */

const MonthlyUsageReset = require('./monthly-usage-reset');
const InvoiceGenerator = require('./invoice-generator');
const FailedPaymentReconciler = require('./failed-payment-reconciler');
const DailySalesSummaryNotifier = require('./daily-sales-summary-notifier');
const CustomerWaitingNotifier = require('./customer-waiting-notifier');
// Phase 5: token-refresh-check.job.js deleted (replaced by meta-token-refresh.job.js Phase 2)
const MetaTokenRefreshJob = require('./meta-token-refresh.job');
const CourierReconciliationJob = require('./courier-reconciliation.job');
// Reliability — synthetic auto-reply pipeline canary + DLQ/backlog watchdog
const PipelineCanaryJob = require('./pipeline-canary.job');
// Reliability — replay inbound Meta events held as durable webhook receipts
const WebhookReceiptReconcilerJob = require('./webhook-receipt-reconciler.job');
const InboxDeliveryReconcilerJob = require('./inbox-delivery-reconciler.job');
// Pilot intelligence — Sales Opportunities sweep (ADR-0006)
const OpportunityDetectorJob = require('./opportunity-detector.job');
// Pilot+ P+05 — knowledge-gap suggestion sweep (deterministic)
const GapSuggesterJob = require('./gap-suggester.job');
// WP-03 — daily aggregate-only confidence-observation qualification snapshot
const ConfidenceQualificationSnapshotJob = require('./confidence-qualification-snapshot.job');
// Payment redesign §4.3 (A0 wiring) — bounded Query-reconciliation sweep for
// stale bKash merchant-gateway attempts (1/5/15/30 per-row ladder; inert when
// BKASH_ENABLED is off — zero provider traffic by construction).
const GatewayAttemptReconcilerJob = require('./gateway-attempt-reconciler.job');

module.exports = {
    MonthlyUsageReset,
    InvoiceGenerator,
    FailedPaymentReconciler,
    DailySalesSummaryNotifier,
    CustomerWaitingNotifier,
    MetaTokenRefreshJob,
    CourierReconciliationJob,
    PipelineCanaryJob,
    WebhookReceiptReconcilerJob,
    InboxDeliveryReconcilerJob,
    OpportunityDetectorJob,
    GapSuggesterJob,
    ConfidenceQualificationSnapshotJob,
    GatewayAttemptReconcilerJob,
};
