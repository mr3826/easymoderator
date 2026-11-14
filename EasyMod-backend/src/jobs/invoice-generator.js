const BaseJob = require('./base-job');
const {
    Subscription,
    Invoice,
    Shop,
    PartnerBillingAdjustment,
    BillingLine,
} = require('../modules/entities');
const { sequelize } = require('../utils/database/database-setup');
const { Op } = require('sequelize');
const crypto = require('crypto');
const {
    recurringInvoiceTypeFor,
    InvoiceType,
} = require('../modules/subscription/subscription.plans');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
} = require('../modules/commercial/commercial.contract');
const {
    aggregateUninvoicedLines,
    catchUpLines,
    computeInvoiceFromLines,
    getCommercialCutoverAt,
    lockLinesForInvoice,
    minorToBdt,
    toDateOnly,
} = require('../modules/commercial/delivered-order-billing.service');

/**
 * Invoice Generator Job
 *
 * One commercial model (ADR-0011): every active `per_order` subscription is on
 * the single MERCHANT tier and is invoiced monthly from `billing_lines`:
 *   gross = delivered billable lines at the contract unit price
 *   credits = pending reversal credits from settled invoices
 *   net = max(0, gross - credits)
 *
 * A period with only zero-rated lines still produces a BDT 0 invoice so every
 * order is explicitly accounted for (never omitted).
 *
 * Legacy `flat_monthly` / `yearly` subscriptions are still processed by the
 * original renewal path so residual pre-cutover invoices keep dunning.
 *
 * IDEMPOTENT: one delivered-order invoice per subscription per period, enforced
 * by `checkExistingInvoice`, a partial unique index, and unique-constraint
 * recovery. Catch-up lines are keyed deterministically, so re-runs are safe.
 *
 * Usage:
 *   const job = new InvoiceGenerator();
 *   await job.execute({ dryRun: true, runDate: new Date('2026-02-01') });
 *   await job.execute({ dryRun: false });
 */
class InvoiceGenerator extends BaseJob {
    constructor() {
        super('invoice_generator');
    }

    /**
     * Generate execution ID based on run date.
     * @param {Date} runDate
     */
    generateExecutionId(runDate) {
        const day = runDate.toISOString().substring(0, 10); // YYYY-MM-DD
        return `${this.jobName}-${day}`;
    }

    /**
     * Run invoice generation
     * @param {Object} options
     */
    async run({ dryRun, runDate, executionId }) {
        this.logger.info(`[${this.jobName}] Generating invoices`, { dryRun, runDate });

        const results = {
            subscriptionsProcessed: 0,
            invoicesGenerated: 0,
            invoicesSkipped: 0,
            totalInvoiceAmount: 0,
            invoiceDetails: []
        };

        // Process in batches of 100 — prevents OOM at 10k+ tenants
        const BATCH_SIZE = 100;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const subscriptions = await Subscription.findAll({
                where: { status: 'active' },
                limit: BATCH_SIZE,
                offset,
                order: [['id', 'ASC']], // stable ordering required for cursor pagination
                include: [{ model: Shop, as: 'shop', required: true }]
            });

            if (subscriptions.length < BATCH_SIZE) hasMore = false;
            offset += subscriptions.length;
            this.metrics.recordsProcessed += subscriptions.length;

            for (const subscription of subscriptions) {
                try {
                    // ADR-0011: all active per-order subscriptions aggregate
                    // the delivered-order ledger over the previous UTC month.
                    if (subscription.billing_model === 'per_order') {
                        await this.processDeliveredOrderSubscription(subscription, runDate, dryRun, results);
                        continue;
                    }

                    // Legacy flat subscriptions: free tiers are never invoiced.
                    if (String(subscription.plan_code || '').toUpperCase() === 'SHURU'
                        || parseFloat(subscription.plan_price || 0) <= 0) {
                        results.invoicesSkipped++;
                        continue;
                    }

                    // A subscription is billed when its paid period ends, not when
                    // the calendar month turns. Without this the monthly cron billed
                    // every active subscription on the 1st, so a yearly subscriber was
                    // charged the full annual amount a month into a year they had
                    // already paid for — and suspended three days later.
                    if (!this.isRenewalDue(subscription, runDate)) {
                        results.invoicesSkipped++;
                        continue;
                    }

                    const invoiceData = await this.calculateInvoice(subscription, runDate);

                    // Idempotency is keyed to the period being billed, so re-running
                    // the job for the same boundary finds the same invoice.
                    const invoiceType = recurringInvoiceTypeFor(invoiceData.billingCycle);
                    const existingInvoice = await this.checkExistingInvoice(
                        subscription, invoiceData.billingPeriodStart, invoiceType,
                    );
                    if (existingInvoice) {
                        this.logger.info(`Invoice already exists for this period`, {
                            shopId: subscription.shop_id,
                            invoiceId: existingInvoice.id,
                            invoiceNumber: existingInvoice.invoice_number
                        });
                        results.invoicesSkipped++;
                        continue;
                    }

                    if (!dryRun) {
                        const invoice = await this.createInvoice(subscription, invoiceData, runDate);
                        if (invoice?.__alreadyExisting) {
                            results.invoicesSkipped++;
                            continue;
                        }
                        invoiceData.invoiceId = invoice.id;
                        invoiceData.invoiceNumber = invoice.invoice_number;
                    }

                    results.invoicesGenerated++;
                    results.totalInvoiceAmount += invoiceData.totalAmount;
                    results.invoiceDetails.push(invoiceData);
                    this.metrics.recordsSucceeded++;

                } catch (error) {
                    this.logger.error(`Failed to generate invoice for shop ${subscription.shop_id}`, error);
                    this.metrics.recordsFailed++;
                    this.metrics.errors.push(`Shop ${subscription.shop_id}: ${error.message}`);
                }
            }
        }

        results.subscriptionsProcessed = offset;
        return results;
    }

    // ── ADR-0011 delivered-order path ────────────────────────────────────────

    /** The previous complete UTC calendar month for a run instant. */
    previousUtcMonth(runDate) {
        const anchor = runDate instanceof Date && !Number.isNaN(runDate.getTime())
            ? runDate
            : new Date();
        const year = anchor.getUTCFullYear();
        const month = anchor.getUTCMonth();
        return {
            periodStart: new Date(Date.UTC(year, month - 1, 1)),
            periodEnd: new Date(Date.UTC(year, month, 1)),
        };
    }

    async pendingReversalCredits(shopId) {
        if (!PartnerBillingAdjustment || typeof PartnerBillingAdjustment.findAll !== 'function') {
            return [];
        }
        return PartnerBillingAdjustment.findAll({
            where: { shop_id: shopId, status: 'pending' },
            order: [['created_at', 'ASC']],
        });
    }

    /**
     * Charge-forward for late deliveries (ADR-0011 "reversal rule" symmetry).
     *
     * A courier callback can arrive after its period's invoice was already
     * issued. Its billing line keeps the real `occurred_at` (the prior period)
     * but was never attached to an invoice. Rewriting an issued invoice is
     * forbidden, so the line is carried forward into the CURRENT invoice as a
     * prior-period adjustment, exactly as a post-payment return produces a
     * credit that nets forward.
     *
     * Only un-invoiced lines are eligible, and only at/after the persisted
     * cutover instant. With no cutover state (migration 003 absent) this is a
     * no-op: pre-cutover history is never manufactured into a charge.
     *
     * @param {string} shopId
     * @param {Date} periodStart
     * @param {Date|null} cutoverAt
     * @returns {Promise<Array<object>>}
     */
    async priorPeriodUninvoicedLines(shopId, periodStart, cutoverAt) {
        if (!shopId || !BillingLine || typeof BillingLine.findAll !== 'function') return [];
        const start = periodStart instanceof Date ? periodStart : new Date(periodStart);
        if (Number.isNaN(start.getTime())) return [];
        const cutover = cutoverAt ? new Date(cutoverAt) : null;
        if (!cutover || Number.isNaN(cutover.getTime())) return [];

        // The cutover floor ALWAYS applies. In the cutover month the instant
        // can fall inside (or after) the period being invoiced, and without the
        // floor pre-cutover lines from the prior period would leak forward as a
        // charge that was never contracted.
        const occurredAt = {
            [Op.lt]: toDateOnly(start),
            [Op.gte]: toDateOnly(cutover),
        };

        return BillingLine.findAll({
            where: {
                shop_id: shopId,
                invoice_id: null,
                occurred_at: occurredAt,
            },
            order: [['occurred_at', 'ASC'], ['created_at', 'ASC']],
        });
    }

    /**
     * Catch up missed terminal outcomes, aggregate the period's un-invoiced
     * lines, net pending credits, and issue one delivered-order invoice.
     */
    async processDeliveredOrderSubscription(subscription, runDate, dryRun, results) {
        const { periodStart, periodEnd } = this.previousUtcMonth(runDate);
        const cutoverAt = await getCommercialCutoverAt();

        // Fail closed (A5): without the persisted cutover instant we cannot
        // separate pre-cutover history from billable usage. Deferring is safe;
        // falling back to periodStart would bill usage that was never
        // contracted.
        if (!cutoverAt) {
            this.logger.warn('Commercial cutover instant unavailable; deferring delivered-order invoicing', {
                shopId: subscription.shop_id,
            });
            results.invoicesSkipped++;
            return;
        }

        if (!dryRun) {
            // Reconstruct terminal outcomes whose webhook never produced a line.
            await catchUpLines({
                shopId: subscription.shop_id,
                periodStart,
                periodEnd,
                cutoverAt,
            });
        }

        const existingInvoice = await this.checkExistingInvoice(
            subscription, periodStart, InvoiceType.DELIVERED_ORDER,
        );
        if (existingInvoice) {
            this.logger.info('Delivered-order invoice already exists for this period', {
                shopId: subscription.shop_id,
                invoiceId: existingInvoice.id,
            });
            results.invoicesSkipped++;
            return;
        }

        const lines = await aggregateUninvoicedLines({
            shopId: subscription.shop_id,
            periodStart,
            periodEnd,
            cutoverAt,
        });

        // Late courier callbacks whose `occurred_at` is in an ALREADY-INVOICED
        // prior period. They are charge-forwarded, never written back into the
        // issued document.
        const priorLines = await this.priorPeriodUninvoicedLines(
            subscription.shop_id, periodStart, cutoverAt,
        );

        const combinedLines = [...priorLines, ...lines];

        // No lines at all means nothing happened; a period containing only
        // zero-rated lines still invoices explicitly at BDT 0.
        if (!combinedLines.length) {
            results.invoicesSkipped++;
            return;
        }

        const adjustments = await this.pendingReversalCredits(subscription.shop_id);

        // Preview derivation. The authoritative amount for a real invoice is
        // recomputed inside the transaction from the LOCKED rows (A3); this is
        // what a dry run reports and what the pre-check metadata uses.
        const previewGrossMinor = computeInvoiceFromLines(combinedLines, 0).grossMinor;
        const { creditsMinor } = this.selectApplicableAdjustments(adjustments, previewGrossMinor);
        const computed = computeInvoiceFromLines(combinedLines, creditsMinor);

        const priorLineIds = new Set(priorLines.map((line) => String(line.id)));
        const priorOrderIds = new Set(priorLines.map((line) => String(line.order_id)));
        const priorPeriodAdjustmentMinor = priorLines.reduce(
            (total, line) => total + Math.max(0, Math.trunc(Number(line.amount_minor) || 0)),
            0,
        );
        // The derivation is the invoice's metadata; flag every carried-forward
        // line so a reader can tell current-period usage from a late arrival.
        computed.priorPeriodAdjustmentMinor = priorPeriodAdjustmentMinor;
        computed.lines = computed.lines.map((line) => ({
            ...line,
            priorPeriodAdjustment: priorOrderIds.has(String(line.orderId)),
        }));

        const invoiceData = {
            shopId: subscription.shop_id,
            billingCycle: 'per_order',
            billingPeriodStart: periodStart,
            billingPeriodEnd: periodEnd,
            baseAmount: 0,
            extraCharges: 0,
            totalAmount: minorToBdt(computed.netMinor),
            computed,
            // Pending credits are re-selected against the locked gross inside
            // the transaction; the preview list is informational only.
            pendingAdjustments: adjustments,
            adjustments,
            candidateLines: combinedLines,
            lineIds: combinedLines.map((line) => line.id),
            priorLineIds: [...priorLineIds],
            priorPeriodAdjustmentMinor,
            cutoverAt,
        };

        if (!dryRun) {
            const invoice = await this.createDeliveredOrderInvoice(subscription, invoiceData, runDate);
            if (invoice?.__alreadyExisting || invoice?.__noLines) {
                results.invoicesSkipped++;
                return;
            }
            // The transaction recomputed from locked rows; use its values.
            if (invoice.__computed) {
                invoiceData.computed = invoice.__computed;
                invoiceData.totalAmount = minorToBdt(invoice.__computed.netMinor);
                invoiceData.priorPeriodAdjustmentMinor = invoice.__computed.priorPeriodAdjustmentMinor;
            }
            invoiceData.invoiceId = invoice.id;
            invoiceData.invoiceNumber = invoice.invoice_number;
        }

        results.invoicesGenerated++;
        results.totalInvoiceAmount += invoiceData.totalAmount;
        results.invoiceDetails.push(invoiceData);
        this.metrics.recordsSucceeded++;
    }

    /**
     * A1 — choose which pending reversal credits this invoice may consume.
     *
     * Credits can only offset a charge that exists. Whole adjustments are
     * applied in FIFO order while they fit under the gross; the first one that
     * would exceed the remaining gross stays pending (together with everything
     * after it) so the surplus carries forward instead of being destroyed.
     *
     * @returns {{applicable:Array<{adjustment:object, amountMinor:number}>, creditsMinor:number}}
     */
    selectApplicableAdjustments(adjustments = [], grossMinor = 0) {
        const applicable = [];
        let remaining = Math.max(0, Math.trunc(Number(grossMinor) || 0));
        for (const adjustment of Array.isArray(adjustments) ? adjustments : []) {
            const amountMinor = Math.max(0, Math.round(Number(adjustment.amount_bdt) * 100));
            if (amountMinor > remaining) break;
            applicable.push({ adjustment, amountMinor });
            remaining -= amountMinor;
        }
        const creditsMinor = applicable.reduce((total, entry) => total + entry.amountMinor, 0);
        return { applicable, creditsMinor };
    }

    /**
     * Persist one delivered-order invoice and claim its lines + credits in the
     * same transaction. Money columns are legacy DECIMAL BDT; metadata carries
     * integer poisha and the derivation, with no customer data.
     */
    async createDeliveredOrderInvoice(subscription, invoiceData, runDate) {
        const {
            candidateLines = [],
            pendingAdjustments = [],
            priorLineIds = [],
            billingPeriodStart,
            billingPeriodEnd,
        } = invoiceData;
        const invoiceNumber = await this.generateInvoiceNumber(subscription, runDate);
        const priorIdSet = new Set(priorLineIds.map((id) => String(id)));

        try {
            return await sequelize.transaction(async (transaction) => {
                // A3: lock the candidate rows inside the transaction and derive
                // the invoice from the LOCKED state. A reversal that commits
                // between aggregation and this point re-reads as zero-rated,
                // so its stale price can never be charged.
                const locked = await lockLinesForInvoice(
                    { shopId: subscription.shop_id, lines: candidateLines },
                    transaction,
                );
                const claimable = locked.filter((line) => line.invoice_id === null);
                if (!claimable.length) return { __noLines: true };

                // A1: only the credits that fit under THIS gross are consumed;
                // any surplus stays pending for a later invoice.
                const grossMinor = computeInvoiceFromLines(claimable, 0).grossMinor;
                const { applicable, creditsMinor } = this.selectApplicableAdjustments(
                    pendingAdjustments, grossMinor,
                );
                const computed = computeInvoiceFromLines(claimable, creditsMinor);
                const priorClaimable = claimable.filter((line) => priorIdSet.has(String(line.id)));
                const priorOrderIds = new Set(priorClaimable.map((line) => String(line.order_id)));
                computed.priorPeriodAdjustmentMinor = priorClaimable.reduce(
                    (total, line) => total + Math.max(0, Math.trunc(Number(line.amount_minor) || 0)),
                    0,
                );
                computed.priorPeriodAdjustmentCount = priorClaimable.length;
                computed.lines = computed.lines.map((line) => ({
                    ...line,
                    priorPeriodAdjustment: priorOrderIds.has(String(line.orderId)),
                }));

                const amountBdt = minorToBdt(computed.netMinor);
                const values = {
                    subscription_id: subscription.id,
                    shop_id: subscription.shop_id,
                    invoice_number: invoiceNumber,
                    invoice_type: InvoiceType.DELIVERED_ORDER,
                    amount: amountBdt,
                    base_amount: 0,
                    // Usage-based delivered-order charge, net of reversal credits.
                    extra_usage_amount: amountBdt,
                    billing_period: billingPeriodStart.toISOString().substring(0, 7),
                    status: 'pending',
                    billing_period_start: billingPeriodStart,
                    billing_period_end: billingPeriodEnd,
                    due_date: new Date(runDate.getTime() + COMMERCIAL_CONTRACT.dueDays * 24 * 60 * 60 * 1000),
                    metadata: {
                        contractVersion: COMMERCIAL_CONTRACT_VERSION,
                        model: COMMERCIAL_CONTRACT.model,
                        currency: COMMERCIAL_CONTRACT.currency,
                        unit_price_minor: COMMERCIAL_CONTRACT.unitPriceMinor,
                        unitPriceMinor: COMMERCIAL_CONTRACT.unitPriceMinor,
                        deliveredCount: computed.deliveredCount,
                        zeroRatedCount: computed.zeroRatedCount,
                        grossMinor: computed.grossMinor,
                        creditMinor: computed.creditMinor,
                        netMinor: computed.netMinor,
                        // Late prior-period arrivals carried forward into this
                        // invoice. They are real charges, never a rewrite of
                        // the issued document.
                        priorPeriodAdjustmentMinor: computed.priorPeriodAdjustmentMinor,
                        priorPeriodAdjustmentCount: computed.priorPeriodAdjustmentCount,
                        lines: computed.lines,
                        // VAT stays 0 (all-in pricing); kept so it can be enabled centrally.
                        vatRate: 0,
                    },
                };

                const created = await Invoice.create(values, { transaction });

                // Claim every locked line that is still un-invoiced — both
                // billable and explicit BDT 0 lines — so the period's orders are
                // accounted for exactly once. Lines claimed or reversed by
                // another transaction are excluded by `invoice_id IS NULL`.
                const claimableIds = claimable.map((line) => line.id);
                if (claimableIds.length) {
                    await BillingLine.update(
                        { invoice_id: created.id },
                        {
                            where: {
                                id: { [Op.in]: claimableIds },
                                shop_id: subscription.shop_id,
                                invoice_id: null,
                            },
                            transaction,
                        },
                    );
                }

                for (const { adjustment } of applicable) {
                    await adjustment.update({
                        status: 'applied',
                        invoice_id: created.id,
                        applied_at: new Date(),
                    }, { transaction });
                }

                created.__computed = computed;
                return created;
            });
        } catch (error) {
            if (error?.name === 'SequelizeUniqueConstraintError') {
                const existing = await this.checkExistingInvoice(
                    subscription, billingPeriodStart, InvoiceType.DELIVERED_ORDER,
                );
                if (existing) {
                    existing.__alreadyExisting = true;
                    return existing;
                }
            }
            throw error;
        }
    }

    // ── Legacy flat/period subscription path ─────────────────────────────────

    /**
     * Whether the subscription's paid period has ended, so a renewal is owed.
     */
    isRenewalDue(subscription, runDate) {
        if (this.periodWasJustReset(subscription, runDate)) return true;
        const dueAt = subscription.next_billing_date || subscription.current_period_end;
        if (!dueAt) return true;
        return new Date(dueAt).getTime() <= runDate.getTime();
    }

    periodWasJustReset(subscription, runDate) {
        if (!subscription?.usage_reset_at || !subscription?.current_period_start) return false;
        const currentPeriodEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end).getTime()
            : Number.POSITIVE_INFINITY;
        return new Date(subscription.usage_reset_at).getTime()
            < new Date(subscription.current_period_start).getTime()
            && currentPeriodEnd > runDate.getTime();
    }

    /**
     * The invoice already covering this exact period, if one was written.
     */
    async checkExistingInvoice(subscription, billingPeriodStart, invoiceType = null) {
        return Invoice.findOne({
            where: {
                subscription_id: subscription.id,
                billing_period_start: billingPeriodStart,
                ...(invoiceType ? { invoice_type: invoiceType } : {}),
            }
        });
    }

    /**
     * Calculate invoice amounts for a legacy subscription.
     * @param {Object} subscription
     * @param {Date} runDate
     */
    async calculateInvoice(subscription, runDate) {
        const startOfMonth = new Date(runDate.getFullYear(), runDate.getMonth() - 1, 1);
        const endOfMonth = new Date(runDate.getFullYear(), runDate.getMonth(), 0, 23, 59, 59);

        const hasRecordedPeriod = subscription.current_period_start
            && subscription.current_period_end;
        const periodWasJustReset = this.periodWasJustReset(subscription, runDate);

        const billingPeriodStart = hasRecordedPeriod
            ? (periodWasJustReset ? new Date(subscription.usage_reset_at) : new Date(subscription.current_period_start))
            : startOfMonth;
        const billingPeriodEnd = hasRecordedPeriod
            ? (periodWasJustReset ? new Date(subscription.current_period_start) : new Date(subscription.current_period_end))
            : endOfMonth;

        const invoiceData = {
            shopId: subscription.shop_id,
            shopName: subscription.shop?.name || 'Unknown',
            planName: subscription.plan_name,
            billingCycle: subscription.billing_cycle,
            billingPeriodStart,
            billingPeriodEnd,
            baseAmount: parseFloat(subscription.plan_price),
            conversationsUsed: subscription.conversations_used,
            ordersUsed: subscription.orders_used,
            productsUsed: subscription.products_used,
            extraCharges: 0,
            subtotal: 0,
            tax: 0,
            totalAmount: 0,
        };

        invoiceData.subtotal = invoiceData.baseAmount + invoiceData.extraCharges;

        // Pricing is VAT-inclusive / all-in. Kept as a named rate so VAT can be
        // re-enabled centrally if NBR registration requires it.
        const BD_VAT_RATE = 0;
        invoiceData.tax = Math.round(invoiceData.subtotal * BD_VAT_RATE);
        invoiceData.vatRate = BD_VAT_RATE;
        invoiceData.totalAmount = invoiceData.subtotal + invoiceData.tax;

        return invoiceData;
    }

    /**
     * Create a legacy invoice in database.
     */
    async createInvoice(subscription, invoiceData, runDate) {
        const invoiceNumber = await this.generateInvoiceNumber(subscription, runDate);
        const values = {
            subscription_id: subscription.id,
            shop_id: subscription.shop_id,
            invoice_number: invoiceNumber,
            invoice_type: recurringInvoiceTypeFor(invoiceData.billingCycle),
            amount: invoiceData.totalAmount,
            base_amount: invoiceData.baseAmount,
            extra_usage_amount: invoiceData.extraCharges,
            billing_period: invoiceData.billingPeriodStart.toISOString().substring(0, 7),
            status: 'pending',
            billing_period_start: invoiceData.billingPeriodStart,
            billing_period_end: invoiceData.billingPeriodEnd,
            // 3-day due threshold for legacy renewals (founder spec).
            due_date: new Date(runDate.getTime() + 3 * 24 * 60 * 60 * 1000),
            metadata: {
                plan_code: subscription.plan_code,
                planName: invoiceData.planName,
                billingCycle: invoiceData.billingCycle,
                baseAmount: invoiceData.baseAmount,
                extraCharges: invoiceData.extraCharges,
                conversationsUsed: invoiceData.conversationsUsed,
                ordersUsed: invoiceData.ordersUsed,
                productsUsed: invoiceData.productsUsed,
                subtotal: invoiceData.subtotal,
                tax: invoiceData.tax,
                vatRate: invoiceData.vatRate
            }
        };

        try {
            return await sequelize.transaction(async (transaction) => (
                Invoice.create(values, { transaction })
            ));
        } catch (error) {
            if (error?.name === 'SequelizeUniqueConstraintError') {
                const existing = await this.checkExistingInvoice(
                    subscription,
                    invoiceData.billingPeriodStart,
                    recurringInvoiceTypeFor(invoiceData.billingCycle),
                );
                if (existing) {
                    existing.__alreadyExisting = true;
                    return existing;
                }
            }
            throw error;
        }
    }

    /**
     * Generate a collision-resistant invoice number.
     *
     * Format: INV-YYYYMM-XXXXXX (6 random hex chars = 1-in-16M collision chance per month)
     * The invoice_number column has a UNIQUE constraint as the final safety net.
     */
    async generateInvoiceNumber(subscription, runDate) {
        const yearMonth = runDate.toISOString().substring(0, 7).replace('-', ''); // 202602
        const uniqueSuffix = crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. A3F9C2
        return `INV-${yearMonth}-${uniqueSuffix}`;
    }
}

module.exports = InvoiceGenerator;