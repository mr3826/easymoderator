'use strict';

/**
 * bKash gateway-attempt reconciler — A0 scheduler wiring for A3's §4.3 sweep.
 *
 * WHAT IT DOES: once per minute it hands off to
 * `bkash-tokenized.service.reconcileStaleGatewayAttempts`, which Query-reconciles
 * stale `initiated`/`processing` merchant-gateway attempts. The 1/5/15/30-minute
 * cadence is per ROW (attempt ledger inside
 * `payment_transactions.gateway_response.reconcile`), so this schedule is the
 * clock and the service is the ladder — a row gets provider traffic on exactly
 * four rungs, then goes quiet for automatic traffic and the READ-ONLY admin
 * report (`payment-processing-reconciliation.service.js`, pinned read-only by
 * its security test) stays the manual path.
 *
 * HARD RULES PRESERVED:
 *  - Query ONLY. Nothing here ever calls execute (contract §4.4 execute-once:
 *    "failed/timeout/ambiguous Execute must NEVER be retried blindly").
 *  - Inert by default (R-12): with BKASH_ENABLED !== "true" the whole sweep is
 *    skipped with zero provider calls — matching the fail-closed choke inside
 *    the v2 client itself.
 *  - Race-safe across replicas: duplicate sweeps may read, but every terminal
 *    transition is an atomic status-guarded update inside the service, and the
 *    one-active-attempt-per-order DB guard (20261127_002 fold-in, §4.4) keeps
 *    the ledger from ever having two live rows per order to fight over.
 *
 * Follows the webhook-receipt / inbox-delivery reconciler house shape (plain
 * execute class; BaseJob's per-period AuditLog idempotency is built for daily
 * jobs, not for a once-a-minute sweep).
 */
const tokenized = require('../modules/payment/bkash-tokenized.service');
const { createLogger } = require('../utils/structured-logger');

const logger = createLogger('GatewayAttemptReconciler');

const SWEEP_BATCH = 50; // re-capped inside the service (hard max 200)
const SWEEP_OLDER_THAN_MINUTES = 1;

class GatewayAttemptReconcilerJob {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.dryRun] report without touching the provider
     * @param {Date} [opts.runDate]
     */
    async execute({ dryRun = false, runDate } = {}) {
        const now = runDate ? new Date(runDate) : new Date();
        const results = { dryRun, skipped: false, reason: null, scanned: 0, confirmed: 0, failed: 0, deferred: 0 };

        if (dryRun) {
            results.skipped = true;
            results.reason = 'dry-run — gateway reconciliation never simulates provider traffic';
            return results;
        }

        // Inert deployment posture (R-12): never reach the provider.
        if (!tokenized.client.isEnabledGate()) {
            results.skipped = true;
            results.reason = 'BKASH_ENABLED is not "true" — automation inert; zero provider calls made.';
            logger.info('gateway attempt reconciliation skipped (disabled)');
            return results;
        }

        const sweep = await tokenized.reconcileStaleGatewayAttempts({
            olderThanMinutes: SWEEP_OLDER_THAN_MINUTES,
            limit: SWEEP_BATCH,
            now,
        });
        for (const r of sweep.results || []) {
            if (r.confirmed === true) results.confirmed += 1;
            else if (r.status === 'failed') results.failed += 1;
            else results.deferred += 1;
        }
        results.scanned = sweep.scanned;
        logger.info('gateway attempt reconciliation sweep complete', {
            scanned: results.scanned,
            confirmed: results.confirmed,
            failed: results.failed,
            deferred: results.deferred,
        });
        return results;
    }
}

module.exports = GatewayAttemptReconcilerJob;
