const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const CourierCodCollection = require('./courier-collection.entity');
const ReconciliationDispute = require('./reconciliation-dispute.entity');
const { DeliveryIntegration, Order } = require('../entities');
const deliveryService = require('../delivery/delivery.service');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger();

// Flag a discrepancy if it exceeds ৳100 or 5% of the linked amount.
const DISCREPANCY_THRESHOLD_FLAT = 100;
const DISCREPANCY_THRESHOLD_PCT  = 0.05;

// State vocabulary for a stored courier statement line. A line is only
// MATCHED when every consignment it covers links to an order AND every linked
// COD amount has a known basis. Everything else stays visibly unresolved —
// there is no "probably settled" state and no bank-receipt state in this table.
const STATES = Object.freeze({
    PROVIDER_REPORTED: 'PROVIDER_REPORTED', // stored, not yet evaluated
    MATCHED: 'MATCHED',
    DIFFERENCE_FOUND: 'DIFFERENCE_FOUND',   // courier claims more than expected
    UNDERPAID_REVIEW: 'UNDERPAID_REVIEW',   // courier claims less; may be fees
    UNMATCHED: 'UNMATCHED',                 // no consignment linkage at all
    INCOMPLETE_EVIDENCE: 'INCOMPLETE_EVIDENCE', // partial linkage / unknown basis
});

// Must stay in sync with order.service.js COD_PAYMENT_METHODS — the booking
// path decides the courier collection amount from this same vocabulary.
const COD_PAYMENT_METHODS = new Set(['cod', 'cash', 'cash_on_delivery']);
const OUTSTANDING_COD_STATUSES = new Set(['pending', 'unpaid']);

const normalizeToken = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

class ReconciliationService {
    /**
     * Pull Steadfast payout records for a shop and store them.
     * Called by the weekly job or manually via API.
     * @returns {{ collected: number, disputes: number, skipped: number, errors: Array }}
     */
    static async pullSteadfastPayments(shopId) {
        const integration = await DeliveryIntegration.findOne({
            where: { shop_id: shopId, provider: 'steadfast', is_active: true }
        });
        if (!integration) throw new Error('No active Steadfast integration for this shop');

        const provider = await deliveryService.getProviderInstance(shopId, 'steadfast');
        const payments = await provider.getPayments();

        const paymentList = Array.isArray(payments)
            ? payments
            : (payments.data || payments.payments || []);

        let collected = 0;
        let disputes = 0;
        let skipped = 0;
        const errors = [];

        for (const payment of paymentList) {
            const paymentId = payment?.id ?? payment?.payment_id;
            if (paymentId === undefined || paymentId === null || String(paymentId).trim() === '') {
                // Without a provider id the line cannot be deduplicated, so
                // importing it could double-count the same cash next week.
                skipped++;
                logger.warn('Skipping Steadfast payment without an id', { shopId });
                continue;
            }

            try {
                const result = await ReconciliationService.recordPayment(shopId, 'steadfast', payment);
                if (result.duplicate) skipped++;
                else collected++;
                if (result.dispute) disputes++;
            } catch (err) {
                errors.push({ paymentId: String(paymentId), error: err.message });
                logger.warn('Failed to record Steadfast payment', {
                    shopId,
                    paymentId,
                    error: err.message
                });
            }
        }

        return { collected, disputes, skipped, errors };
    }

    /**
     * Store a single courier payout record and auto-dispute if discrepancy detected.
     */
    static async recordPayment(shopId, provider, rawPayment = {}) {
        const paymentId = rawPayment.id ?? rawPayment.payment_id;
        if (paymentId === undefined || paymentId === null || String(paymentId).trim() === '') {
            throw new Error('Courier payment record is missing an id and cannot be deduplicated');
        }
        const paymentRef  = String(paymentId);
        const rawAmount   = Number(rawPayment.amount ?? rawPayment.total_amount ?? 0);
        const claimedAmt  = Number.isFinite(rawAmount) ? roundMoney(rawAmount) : 0;
        const paymentDate = rawPayment.date || rawPayment.payment_date || new Date().toISOString().slice(0, 10);
        const consignmentIds = Array.isArray(rawPayment.consignment_ids)
            ? rawPayment.consignment_ids.map(String)
            : [];

        const [collection, created] = await CourierCodCollection.findOrCreate({
            where: { shop_id: shopId, provider, payment_reference: paymentRef },
            defaults: {
                id: uuidv4(),
                shop_id: shopId,
                provider,
                payment_reference: paymentRef,
                claimed_amount: claimedAmt,
                consignment_count: consignmentIds.length,
                consignment_ids: consignmentIds,
                payment_date: paymentDate,
                raw_payload: JSON.stringify(rawPayment),
                state: STATES.PROVIDER_REPORTED,
            }
        });

        if (!created) {
            // Same statement line imported again: re-evaluating could flip an
            // operator-reviewed state, and re-summing would double-count cash.
            return {
                collection,
                dispute: null,
                state: collection.state || STATES.PROVIDER_REPORTED,
                duplicate: true,
            };
        }

        // Expected = what the courier was asked to collect, from the same
        // locked order snapshot the booking path used: fee-inclusive
        // order.total for COD orders still awaiting payment; zero for prepaid.
        const evaluation = await ReconciliationService.evaluateLinkedOrders(shopId, consignmentIds);
        let state = evaluation.state;
        let expectedAmt = evaluation.expectedAmount;
        let dispute = null;

        if (state === null) {
            const diff = roundMoney(claimedAmt - expectedAmt);
            if (diff !== 0) {
                const absDiff = Math.abs(diff);
                const pctBase = Math.max(claimedAmt, expectedAmt, 1);
                const exceedsThreshold = absDiff > DISCREPANCY_THRESHOLD_FLAT
                    || (absDiff / pctBase) > DISCREPANCY_THRESHOLD_PCT;

                if (!exceedsThreshold) {
                    state = STATES.MATCHED;
                } else if (diff > 0) {
                    // Claimed more than any linked order could have collected:
                    // courier deductions cannot explain this direction.
                    state = STATES.DIFFERENCE_FOUND;
                    dispute = await ReconciliationDispute.create({
                        id: uuidv4(),
                        shop_id: shopId,
                        collection_id: collection.id,
                        provider,
                        payment_reference: paymentRef,
                        claimed_amount: claimedAmt,
                        expected_amount: expectedAmt,
                        discrepancy_amount: diff,
                        dispute_status: 'open',
                        notes: `Auto-detected: courier claims ৳${claimedAmt}, linked COD orders expect ৳${expectedAmt} (over-claim ৳${absDiff.toFixed(2)})`
                    });
                } else {
                    // Claimed LESS: courier fees/returns legitimately reduce the
                    // remittance, so this is a review flag, never a settlement.
                    state = STATES.UNDERPAID_REVIEW;
                }
            } else {
                state = STATES.MATCHED;
            }
        }

        await collection.update({ state, expected_amount: expectedAmt });

        if (dispute) {
            logger.warn('COD discrepancy auto-dispute created', {
                shopId, provider, paymentRef,
                claimed: claimedAmt, expected: expectedAmt,
                discrepancy: roundMoney(claimedAmt - expectedAmt)
            });
        } else if (state !== STATES.MATCHED) {
            logger.info('COD collection recorded without a numeric match', {
                shopId, provider, paymentRef, state
            });
        }

        return { collection, dispute, state };
    }

    /**
     * Resolve the expected gross COD for a statement line from its linked orders.
     * Returns { state, expectedAmount } where state is null only when every
     * consignment resolved and every amount basis is known.
     */
    static async evaluateLinkedOrders(shopId, consignmentIds) {
        const uniqueConsignments = [...new Set((consignmentIds || []).map(String))];
        if (uniqueConsignments.length === 0) {
            return { state: STATES.UNMATCHED, expectedAmount: null, matchedCount: 0 };
        }

        const orders = await Order.findAll({
            where: {
                shop_id: shopId,
                delivery_consignment_id: { [Op.in]: uniqueConsignments }
            },
            attributes: ['total', 'payment_method', 'payment_status', 'delivery_consignment_id']
        });

        if (!orders.length) {
            return { state: STATES.UNMATCHED, expectedAmount: null, matchedCount: 0 };
        }

        const linkedConsignments = new Set(
            orders.map((order) => String(order.delivery_consignment_id))
        );
        if (linkedConsignments.size !== uniqueConsignments.length) {
            return {
                state: STATES.INCOMPLETE_EVIDENCE,
                expectedAmount: null,
                matchedCount: orders.length,
            };
        }

        let expected = 0;
        for (const order of orders) {
            const method = normalizeToken(order.payment_method);
            const status = normalizeToken(order.payment_status);
            const isCod = COD_PAYMENT_METHODS.has(method);

            if (isCod) {
                if (OUTSTANDING_COD_STATUSES.has(status)) {
                    expected += Number(order.total) || 0;
                    continue;
                }
                if (status === 'paid') {
                    // COD method fully prepaid: the courier collects nothing.
                    continue;
                }
                return {
                    state: STATES.INCOMPLETE_EVIDENCE,
                    expectedAmount: null,
                    matchedCount: orders.length,
                };
            }

            // Non-COD methods are collected before dispatch; the courier
            // remits nothing for them. A missing method with a non-paid status
            // means the amount basis is unknown, so it cannot be matched.
            if (!method && status !== 'paid') {
                return {
                    state: STATES.INCOMPLETE_EVIDENCE,
                    expectedAmount: null,
                    matchedCount: orders.length,
                };
            }
        }

        return {
            state: null,
            expectedAmount: roundMoney(expected),
            matchedCount: orders.length,
        };
    }

    /**
     * List COD collection records for a shop.
     */
    static async listCollections(shopId, { page = 1, limit = 20, provider } = {}) {
        const where = { shop_id: shopId };
        if (provider) where.provider = provider;

        const { count, rows } = await CourierCodCollection.findAndCountAll({
            where,
            order: [['payment_date', 'DESC']],
            limit,
            offset: (page - 1) * limit
        });

        return {
            data: rows,
            pagination: { total: count, page, limit, total_pages: Math.ceil(count / limit) }
        };
    }

    /**
     * List disputes for a shop.
     */
    static async listDisputes(shopId, { page = 1, limit = 20, status } = {}) {
        const where = { shop_id: shopId };
        if (status) where.dispute_status = status;

        const { count, rows } = await ReconciliationDispute.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit,
            offset: (page - 1) * limit
        });

        return {
            data: rows,
            pagination: { total: count, page, limit, total_pages: Math.ceil(count / limit) }
        };
    }

    /**
     * Manually create a dispute.
     */
    static async createDispute(shopId, { provider, paymentReference, claimedAmount, expectedAmount, notes }) {
        return ReconciliationDispute.create({
            id: uuidv4(),
            shop_id: shopId,
            provider,
            payment_reference: paymentReference,
            claimed_amount: claimedAmount,
            expected_amount: expectedAmount,
            discrepancy_amount: claimedAmount - expectedAmount,
            dispute_status: 'open',
            notes: notes || null
        });
    }

    /**
     * Update dispute status (under_review, resolved, rejected).
     */
    static async updateDisputeStatus(disputeId, shopId, { status, notes, resolvedBy }) {
        const dispute = await ReconciliationDispute.findOne({
            where: { id: disputeId, shop_id: shopId }
        });
        if (!dispute) throw new Error('Dispute not found');

        const updates = { dispute_status: status };
        if (notes) updates.notes = notes;
        if (['resolved', 'rejected'].includes(status)) {
            updates.resolved_at = new Date();
            updates.resolved_by = resolvedBy || null;
        }

        await dispute.update(updates);
        return dispute;
    }
}

ReconciliationService.STATES = STATES;

module.exports = ReconciliationService;
