const { Subscription, Invoice, UsageEvent, AuditLog } = require('../entities');
const { v5: uuidv5, validate: uuidValidate } = require('uuid');

const recordFunnelEventSafe = (event, values) => {
    try {
        return require('../analytics/funnel-events.service')
            .recordInternalFunnelEvent({ event, ...values })
            .catch(() => {});
    } catch (_) {
        return Promise.resolve();
    }
};
const { AppError } = require('../../utils/AppError');
const { UserShop } = require('../entities');
const { Op, Transaction } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const { createLogger } = require('../../utils/structured-logger');
const cacheService = require('../../utils/cache.service');
const {
    PlanCode,
    getTierByCode,
    isUnlimitedLimit,
    isLimitExceeded,
    RECURRING_INVOICE_TYPES
} = require('./subscription.plans');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    contractHash
} = require('../commercial/commercial.contract');

/**
 * Fixed namespace for hashing non-UUID idempotency keys into usage_events.
 * Never change it: the hash IS the dedup key, so a new namespace would let
 * every in-flight request meter a second time.
 */
const USAGE_REQUEST_NAMESPACE = '7b3f2c1e-9a4d-4f8b-8c2a-1d6e5f0a9b34';

/**
 * usage_events.request_id is a UUID column (widened from TEXT by
 * 20260611_003_schema_drift_sweep), but callers pass whatever identifies their
 * request: the Meta webhook path sends `conv:<uuid>`, and the HTTP path
 * forwards a client-supplied `x-request-id` header verbatim
 * (request-context.middleware.js). Postgres rejects both with "invalid input
 * syntax for type uuid" — and every caller wraps trackUsage in a catch so
 * ingestion is never blocked, so the rejection surfaced only as a log line
 * while the meter silently stayed at zero.
 *
 * Hash anything that is not already a UUID into a stable one. Same input still
 * means same key, so idempotency is unchanged. Every read and write of
 * usage_events.request_id must go through here, or a lookup will miss the row
 * its own write created.
 */
const usageRequestKey = (requestId) => (
    uuidValidate(String(requestId))
        ? String(requestId)
        : uuidv5(String(requestId), USAGE_REQUEST_NAMESPACE)
);

/**
 * Verify user has access to shop
 */
const verifyShopAccess = async (userId, shopId) => {
    const userShop = await UserShop.findOne({
        where: {
            user_id: userId,
            shop_id: shopId,
            is_active: true
        }
    });

    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }
    return userShop;
};

const cancelOpenRecurringInvoices = async (subscriptionId, transaction = null) => {
    if (typeof Invoice?.update !== 'function') return;
    const options = {
        where: {
            subscription_id: subscriptionId,
            invoice_type: { [Op.in]: RECURRING_INVOICE_TYPES },
            status: { [Op.in]: ['pending', 'overdue'] },
        },
    };
    if (transaction) options.transaction = transaction;
    await Invoice.update(
        { status: 'cancelled', notes: 'Cancelled because the subscription plan changed' },
        options,
    );
};

/**
 * Get subscription details for a shop.
 *
 * ADR-0011: the merchant-facing truth is the commercial contract, not a plan
 * catalog. The response carries the frozen contract plus the single MERCHANT
 * billing row; the retired conversation entitlement and band eligibility
 * fields are gone so no surface can render them again.
 */
const getSubscription = async (shopId, userId) => {
    await verifyShopAccess(userId, shopId);

    let subscription = await Subscription.findOne({
        where: { shop_id: shopId }
    });

    // Every shop starts on the single delivered-order merchant model.
    if (!subscription) {
        subscription = await createDefaultSubscription(shopId);
    }

    const usage = {
        conversations: usageMetric(subscription.conversations_used, subscription.conversations_limit),
        orders: usageMetric(subscription.orders_used, subscription.orders_limit),
        products: usageMetric(subscription.products_used, subscription.products_limit)
    };

    return {
        subscription,
        plan: {
            code: subscription.plan_code || PlanCode.MERCHANT,
            name: subscription.plan_name || PlanCode.MERCHANT,
            billing_model: subscription.billing_model || 'per_order'
        },
        contract: COMMERCIAL_CONTRACT,
        contract_version: COMMERCIAL_CONTRACT_VERSION,
        contract_hash: contractHash,
        usage,
        period: {
            start: subscription.current_period_start,
            end: subscription.current_period_end
        }
    };
};

const usageMetric = (used, limit) => {
    const normalizedUsed = Math.max(0, Number(used) || 0);
    return {
        used: normalizedUsed,
        limit: isUnlimitedLimit(limit) ? limit : Number(limit),
        percentage: getUsagePercentage(normalizedUsed, limit),
        status: getUsageStatus(normalizedUsed, limit)
    };
};

/**
 * Get usage status
 */
const getUsageStatus = (used, limit) => {
    if (isUnlimitedLimit(limit)) return 'safe';
    const percentage = (used / limit) * 100;
    if (used >= limit) return 'exceeded';
    if (percentage >= 70) return 'warning';
    return 'safe';
};

const getUsagePercentage = (used, limit) => {
    if (isUnlimitedLimit(limit) || limit === 0) return 0;
    return Math.min(100, Math.max(0, (used / limit) * 100));
};

/**
 * Create the default subscription for a new shop: the single MERCHANT tier on
 * the delivered-order model (ADR-0011).
 *
 * The billing row is metadata only. Price authority stays in
 * `commercial.contract.js`; `per_order_charge_bdt` is copied from the contract
 * so no second hardcoded price exists here, and all entitlements are unlimited
 * because there is no conversation quota or plan gate any more.
 */
const createDefaultSubscription = async (shopId, { transaction = null, emitEvent = true } = {}) => {
    const tier = getTierByCode(PlanCode.MERCHANT);
    const now = new Date();

    // Current UTC calendar month, matching the delivered-order invoice period.
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const values = {
        shop_id: shopId,
        plan_code: tier.code,
        plan_name: tier.name,
        plan_price: 0,
        billing_cycle: 'monthly',
        billing_model: tier.billingModel,
        per_order_charge_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
        status: 'active',
        trial_ends_at: null,
        conversations_limit: tier.conversationsLimit,
        orders_limit: tier.ordersLimit,
        products_limit: tier.productsLimit,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_date: periodEnd,
        features: tier.features
    };
    const subscription = transaction
        ? await Subscription.create(values, { transaction })
        : await Subscription.create(values);
    if (emitEvent) {
        recordFunnelEventSafe('plan_assigned_shuru', {
            shopId,
            metadata: { plan_code: tier.code },
            onceKey: `plan_assigned_shuru:${shopId}`,
        });
    }
    return subscription;
};

/**
 * Plan selection is retired (ADR-0011). Every shop is on the single MERCHANT
 * delivered-order model, so there is nothing to upgrade to, prorate or renew.
 * Keeping the export fails closed for old clients and for the admin billing
 * route instead of silently rewriting a price.
 */
const updatePlan = async (shopId, userId, planData, { skipShopAccess = false } = {}) => {
    if (!skipShopAccess) await verifyShopAccess(userId, shopId);
    void planData;
    throw new AppError(
        'Plan selection is retired. Every shop is billed per delivered order; see /api/public/commercial-contract.',
        410,
        'CATALOG_RETIRED',
    );
};

/**
 * REFACTORED: Track usage with atomic transactions and idempotency
 * 
 * Ensures:
 * - Usage increments ONLY inside committed transactions
 * - If transaction fails → usage MUST NOT increment
 * - Prevent double counting using idempotency keys (shop_id, resource_type, request_id)
 * - Conversation usage is recorded for audit and cost reporting; ADR-0011 has no quota gate
 * - Persist every increment into audit_logs
 * 
 * @param {string} shopId - Shop UUID
 * @param {string} usageType - 'conversations' | 'orders' | 'products'
 * @param {number} amount - Amount to increment (default: 1)
 * @param {string} requestId - Idempotency key (required for transaction safety)
 * @param {object} metadata - Additional context (resource_id, etc)
 * @returns {Promise<object>} { subscription, usageEvent, isRetry, transactionId, within_allowance }
 * @throws {AppError} If subscription not found, an invalid amount is supplied, or transaction fails
 */
const trackUsage = async (shopId, usageType, amount = 1, requestId = null, metadata = {}) => {
    if (!requestId) {
        throw new AppError('requestId is required for idempotent usage tracking', 400);
    }

    if (!['conversations', 'orders', 'products'].includes(usageType)) {
        throw new AppError(`Invalid usage type: ${usageType}`, 400);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new AppError('amount must be a positive integer', 400);
    }

    const idempotencyKey = usageRequestKey(requestId);

    const logger = createLogger(requestId, shopId);
    let transaction = null;

    try {
        // Step 1: Check for duplicate request (idempotency)
        let existingEvent = await UsageEvent.findOne({
            where: {
                shop_id: shopId,
                resource_type: usageType,
                request_id: idempotencyKey
            }
        });

        if (existingEvent) {
            // Retry detected - return previous result
            logger.info('Duplicate usage tracking request detected (idempotent retry)', {
                usageType,
                previousStatus: existingEvent.status
            });

            // If previous attempt was rolled back, retry the transaction
            if (existingEvent.status === 'rolled_back') {
                logger.warn('Previous attempt was rolled back, retrying transaction', {
                    usageType
                });
            } else if (existingEvent.status === 'committed') {
                // Successful previous attempt - return without double counting
                const subscription = await Subscription.findOne({ where: { shop_id: shopId } });
                return {
                    subscription,
                    usageEvent: existingEvent,
                    isRetry: true,
                    transactionId: existingEvent.transaction_id,
                    within_allowance: usageType === 'conversations'
                        ? existingEvent.resource_metadata?.within_allowance === true
                        : true,
                    message: 'Usage already tracked for this request (idempotent)'
                };
            }
        }

        // Step 2: Create transaction
        transaction = await sequelize.transaction({
            // The literal 'READ_COMMITTED' is not SQL — Sequelize interpolates
            // the value straight into SET TRANSACTION ISOLATION LEVEL, so the
            // underscore form made Postgres reject every usage transaction.
            isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED
        });

        // Step 3: Lock subscription row for update (prevents concurrent increments)
        const subscription = await Subscription.findOne({
            where: { shop_id: shopId },
            transaction,
            lock: transaction.LOCK.UPDATE // Pessimistic locking
        });

        if (!subscription) {
            throw new AppError('Subscription not found', 404);
        }

        // Step 4: Validate limits before transaction
        const field = `${usageType}_used`;
        const limitField = `${usageType}_limit`;
        let currentUsage = Number(subscription[field]) || 0;
        let newUsage = currentUsage + amount;
        const limit = subscription[limitField];

        let periodResetUpdates = {};
        const currentPeriodEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end)
            : null;
        const now = new Date();
        if (currentPeriodEnd && !Number.isNaN(currentPeriodEnd.getTime()) && currentPeriodEnd <= now) {
            let nextPeriodStart = currentPeriodEnd;
            let nextPeriodEnd = new Date(nextPeriodStart);
            const yearly = subscription.billing_cycle === 'yearly';
            do {
                if (yearly) nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
                else nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
                if (nextPeriodEnd <= now) nextPeriodStart = nextPeriodEnd;
            } while (nextPeriodEnd <= now);

            currentUsage = 0;
            newUsage = amount;
            periodResetUpdates = {
                conversations_used: 0,
                orders_used: 0,
                products_used: 0,
                current_period_start: nextPeriodStart,
                current_period_end: nextPeriodEnd,
                next_billing_date: nextPeriodEnd,
                // Keep the prior period start as the renewal handoff marker. The
                // invoice job uses a marker strictly before the new period start
                // to bill the period that this inline reset just closed.
                usage_reset_at: subscription.current_period_start || currentPeriodEnd,
            };
        }

        if (usageType !== 'conversations' && isLimitExceeded(newUsage, limit)) {
            // Hard error if limit exceeded for non-conversation usage
            const error = new AppError(
                `Usage limit exceeded for ${usageType}: ${newUsage} > ${limit}`,
                402
            );
            error.code = 'USAGE_LIMIT_EXCEEDED';
            error.limit = limit;
            error.current = newUsage;
            throw error;
        }

        // A conversation consumes the included plan allowance first, then any
        // purchased/bonus top-up balance. The event is still recorded when the
        // allowance is exhausted so the worker can pause only that AI turn.
        let topupBalance = Math.max(0, Number(subscription.topup_balance) || 0);
        let withinAllowance = true;
        let crossedThresholds = [];
        let allowanceForEvent = null;
        if (usageType === 'conversations' && !isUnlimitedLimit(limit)) {
            const allowanceBefore = Number(limit) + topupBalance;
            allowanceForEvent = allowanceBefore;
            const includedRemaining = Math.max(0, Number(limit) - currentUsage);
            const beyondPlan = Math.max(0, amount - includedRemaining);
            const availableTopup = topupBalance;
            const fromTopup = Math.min(availableTopup, beyondPlan);
            topupBalance -= fromTopup;
            withinAllowance = beyondPlan <= availableTopup;
            const previousPercentage = allowanceBefore > 0 ? (currentUsage / allowanceBefore) * 100 : 100;
            const nextPercentage = allowanceBefore > 0 ? (newUsage / allowanceBefore) * 100 : 100;
            crossedThresholds = [70, 90, 100].filter((threshold) => (
                previousPercentage < threshold && nextPercentage >= threshold
            ));
        }

        const usageMetadata = {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
            within_allowance: withinAllowance
        };

        // Step 5: Create UsageEvent record (marks transaction as pending)
        const usageEvent = await UsageEvent.create({
            shop_id: shopId,
            resource_type: usageType,
            request_id: idempotencyKey,
            delta: amount,
            transaction_id: transaction.id,
            status: 'pending',
            resource_id: usageMetadata.resourceId || null,
            resource_metadata: usageMetadata
        }, { transaction });

        // Step 6: Increment subscription counter (ATOMIC inside transaction)
        const subscriptionUpdates = { ...periodResetUpdates, [field]: newUsage };
        if (usageType === 'conversations') subscriptionUpdates.topup_balance = topupBalance;
        await subscription.update(subscriptionUpdates, { transaction });

        // Step 7: Create audit log entry (ensures auditability)
        //
        // `metadata` and `idempotency_key`, not `details` and `request_id`:
        // audit_logs has no column by either of those names, and Sequelize
        // drops unknown attributes on create() without erroring. Every usage
        // audit row written so far therefore recorded the ids and the action
        // and silently lost BOTH the payload and the key that correlates the
        // row back to its request — the one field an idempotent billing audit
        // trail exists to carry.
        await AuditLog.create({
            shop_id: shopId,
            resource_type: 'subscription_usage',
            resource_id: subscription.id,
            action: 'usage_tracked',
            metadata: {
                usageType,
                amount,
                newTotal: newUsage,
                limit,
                withinAllowance,
                requestId,
                usageEventId: usageEvent.id
            },
            user_id: null, // System action
            idempotency_key: requestId
        }, { transaction });

        // Step 8: Mark UsageEvent as committed (MUST be inside transaction)
        await usageEvent.update({
            status: 'committed',
            committed_at: new Date()
        }, { transaction });

        // Step 9: Commit transaction
        await transaction.commit();

        for (const threshold of crossedThresholds) {
            recordFunnelEventSafe(`usage_threshold_${threshold}`, {
                shopId,
                metadata: {
                    usage_type: usageType,
                    used: newUsage,
                    allowance: allowanceForEvent,
                },
                onceKey: `usage_threshold:${shopId}:${subscription.current_period_start}:${threshold}`,
            });
        }

        logger.info('Usage tracked successfully (transaction committed)', {
            usageType,
            delta: amount,
            newTotal: newUsage,
            limit,
            withinAllowance,
            status: getUsageStatus(newUsage, limit)
        });

        return {
            subscription,
            usageEvent,
            isRetry: false,
            transactionId: transaction.id,
            within_allowance: withinAllowance,
            message: 'Usage tracked successfully'
        };

    } catch (error) {
        // Step 9b: Lost an idempotency race.
        //
        // The Step 1 check is check-then-act: concurrent callers with the same
        // requestId all see no existing event, all proceed, and the unique
        // index on usage_events.request_id lets exactly one insert win. The
        // losers were being reported as 500 "Usage tracking failed: Validation
        // error" — the opposite of idempotent, and only reachable under real
        // concurrency, which is why a mocked suite never saw it.
        //
        // The index is the arbiter. Roll our own work back, then return the
        // winner's committed event as the retry it is. Handled before the
        // rollback branch below because that branch marks pending rows for this
        // request_id as rolled_back, which here would be the WINNER's row.
        if (error?.name === 'SequelizeUniqueConstraintError') {
            if (transaction) {
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    logger.error('Failed to roll back after idempotency race', rollbackError, { usageType });
                }
                transaction = null;
            }

            const winner = await UsageEvent.findOne({
                where: { shop_id: shopId, resource_type: usageType, request_id: idempotencyKey }
            });

            if (winner) {
                logger.info('Concurrent duplicate resolved by unique index (idempotent retry)', {
                    usageType,
                    winnerStatus: winner.status
                });
                const currentSubscription = await Subscription.findOne({ where: { shop_id: shopId } });
                return {
                    subscription: currentSubscription,
                    usageEvent: winner,
                    isRetry: true,
                    transactionId: winner.transaction_id,
                    within_allowance: usageType === 'conversations'
                        ? winner.resource_metadata?.within_allowance === true
                        : true,
                    message: 'Usage already tracked for this request (idempotent)'
                };
            }
            // No winner found: fall through and report the original error
            // rather than inventing a success.
        }

        // Step 10: Rollback on error
        if (transaction) {
            try {
                await transaction.rollback();
                logger.warn('Transaction rolled back due to error', {
                    usageType,
                    errorMessage: error.message,
                    errorCode: error.code
                });

                // Mark UsageEvent as rolled_back (if it was created)
                await UsageEvent.update(
                    { status: 'rolled_back', error_message: error.message },
                    {
                        where: {
                            shop_id: shopId,
                            resource_type: usageType,
                            request_id: idempotencyKey,
                            status: 'pending'
                        }
                    }
                );
            } catch (rollbackError) {
                logger.error('Failed to rollback transaction', rollbackError, {
                    usageType,
                    originalError: error.message
                });
            }
        }

        // Rethrow original error
        if (error instanceof AppError) {
            throw error;
        }

        const appError = new AppError(
            `Usage tracking failed: ${error.message}`,
            500
        );
        appError.code = 'USAGE_TRACKING_FAILED';
        appError.originalError = error;
        throw appError;
    }
};

/**
 * Get invoices for a shop
 */
const getInvoices = async (shopId, userId) => {
    await verifyShopAccess(userId, shopId);

    const invoices = await Invoice.findAll({
        where: { shop_id: shopId },
        order: [['created_at', 'DESC']],
        limit: 50
    });

    return invoices;
};

/**
 * Get invoice by ID
 */
const getInvoiceById = async (invoiceId, shopId, userId) => {
    await verifyShopAccess(userId, shopId);

    const invoice = await Invoice.findOne({
        where: { 
            id: invoiceId,
            shop_id: shopId 
        }
    });

    if (!invoice) {
        throw new AppError('Invoice not found', 404);
    }

    return invoice;
};

/**
 * Reset usage counters (called monthly/yearly via cron)
 */
const resetUsageCounters = async (subscriptionId) => {
    const subscription = await Subscription.findByPk(subscriptionId);
    
    if (!subscription) {
        throw new AppError('Subscription not found', 404);
    }

        await subscription.update({
            conversations_used: 0,
            orders_used: 0,
            products_used: 0,
        });

    // Invalidate cached limits so the reset is immediately visible
    await cacheService.clearForShop(subscription.shop_id);

    return subscription;
};

/**
 * Get usage events for audit trail
 */
const getUsageEvents = async (shopId, filters = {}) => {
    const where = { shop_id: shopId };

    if (filters.resourceType) {
        where.resource_type = filters.resourceType;
    }

    if (filters.status) {
        where.status = filters.status;
    }

    if (filters.startDate || filters.endDate) {
        where.created_at = {};
        if (filters.startDate) {
            where.created_at[Op.gte] = new Date(filters.startDate);
        }
        if (filters.endDate) {
            where.created_at[Op.lte] = new Date(filters.endDate);
        }
    }

    const events = await UsageEvent.findAll({
        where,
        order: [['created_at', 'DESC']],
        limit: filters.limit || 100
    });

    return events;
};

/**
 * Verify no double counting (for testing/debugging)
 */
const verifyNoDoubleCount = async (shopId, resourceType, requestId) => {
    const events = await UsageEvent.findAll({
        where: {
            shop_id: shopId,
            resource_type: resourceType,
            request_id: usageRequestKey(requestId)
        }
    });

    if (events.length > 1) {
        throw new AppError(
            `Double counting detected: ${events.length} events for same request_id`,
            500
        );
    }

    return events.length === 1 && events[0].status === 'committed';
};

const getRateLimitKey = (shopId, customerId) => {
    const bucket = Math.floor(Date.now() / 60000);
    return `rate:${shopId}:${customerId}:${bucket}`;
};

const getRateLimitReset = () => {
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 1);
    return now.toISOString();
};

const checkRateLimit = async (shopId, userId, customerId) => {
    await verifyShopAccess(userId, shopId);

    const subscription = await Subscription.findOne({ where: { shop_id: shopId } });
    const limit = subscription?.features?.rate_limit_per_minute || 10;

    const key = getRateLimitKey(shopId, customerId);
    const current = (await cacheService.get(key)) || 0;

    return {
        allowed: current < limit,
        limit,
        current,
        window: 'per_minute',
        reset_at: getRateLimitReset()
    };
};

/**
 * Check if shop can create one more order (usage limit).
 * Call BEFORE creating order to avoid creating orders that would exceed limit.
 * @throws {AppError} USAGE_LIMIT_EXCEEDED if orders_used + 1 > orders_limit
 */
const checkOrderLimit = async (shopId) => {
    const subscription = await Subscription.findOne({ where: { shop_id: shopId } });
    if (!subscription) return;
    const newUsage = (subscription.orders_used || 0) + 1;
    const limit = subscription.orders_limit;
    if (isLimitExceeded(newUsage, limit)) {
        const error = new AppError(`Usage limit exceeded for orders: ${newUsage} > ${limit}`, 402);
        error.code = 'USAGE_LIMIT_EXCEEDED';
        throw error;
    }
};

const incrementRateLimit = async (shopId, userId, customerId) => {
    await verifyShopAccess(userId, shopId);

    const subscription = await Subscription.findOne({ where: { shop_id: shopId } });
    const limit = subscription?.features?.rate_limit_per_minute || 10;

    const key = getRateLimitKey(shopId, customerId);
    const currentCount = await cacheService.increment(key, 1);
    await cacheService.expire(key, 120);

    return {
        current_count: currentCount,
        limit
    };
};

/**
 * Grant bonus conversations to a shop (e.g. referral reward, promo credit).
 * Atomic increment on topup_balance; safe under concurrency and consumed after
 * the included plan allowance.
 * No-op if the shop has no subscription row yet (lazy-created on first use).
 *
 * @param {string} shopId - Shop UUID
 * @param {number} amount - Conversations to add (must be > 0)
 * @param {string} [reason] - Audit reason for structured logging
 * @param {object} [options]
 * @param {object} [options.transaction] - Existing Sequelize transaction
 * @returns {Promise<{ granted: boolean, amount: number }>}
 */
const grantBonusConversations = async (shopId, amount, reason = 'bonus', { transaction = null } = {}) => {
    if (!shopId || !Number.isInteger(amount) || amount <= 0) {
        return { granted: false, amount: 0 };
    }

    const incrementOptions = { where: { shop_id: shopId } };
    if (transaction) incrementOptions.transaction = transaction;
    const [affected] = await Subscription.increment(
        { topup_balance: amount },
        incrementOptions
    );

    // Sequelize returns affectedCount differently per dialect; treat falsy as no-op
    const granted = Array.isArray(affected) ? affected[1] > 0 : true;

    const logger = createLogger('subscription-bonus', shopId);
    logger.info('Bonus conversations granted', { amount, reason });

    return { granted, amount };
};

/**
 * Activate (or reactivate) a subscription once a delivered-order invoice is paid.
 *
 * Flips a non-active subscription (suspended / past_due / trial_expired /
 * inactive) back to `active` so automated AI resumes (see
 * subscription.access.isAiActive) and anchors a fresh monthly access window.
 * Historical plan codes and annual cycles normalize to the single MERCHANT
 * delivered-order tier; no plan price or entitlement is reintroduced.
 *
 * `preservePeriod` keeps the recorded period for a late delivered-order invoice
 * so settlement never shifts the monthly ledger window.
 *
 * @param {Object} subscription - Subscription Sequelize instance
 * @returns {Promise<Object>} the updated subscription
 */
const activateFromPaidInvoice = async (subscription, {
    targetPlanCode = null,
    targetBillingCycle = null,
    preservePeriod = false,
    billingPeriodEnd = null,
    transaction = null,
} = {}) => {
    void targetPlanCode;
    void targetBillingCycle;
    const tier = getTierByCode(PlanCode.MERCHANT);
    const now = new Date();
    let periodStart = now;
    let periodEnd = new Date(now);
    if (preservePeriod && subscription.current_period_start && subscription.current_period_end) {
        periodStart = new Date(subscription.current_period_start);
        periodEnd = new Date(subscription.current_period_end);
    } else if (preservePeriod && billingPeriodEnd) {
        periodStart = new Date(billingPeriodEnd);
        periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const updates = {
        plan_code: tier.code,
        plan_name: tier.name,
        plan_price: 0,
        billing_cycle: 'monthly',
        billing_model: tier.billingModel,
        per_order_charge_bdt: COMMERCIAL_CONTRACT.unitPriceMinor / 100,
        conversations_limit: tier.conversationsLimit,
        orders_limit: tier.ordersLimit,
        products_limit: tier.productsLimit,
        features: tier.features,
        status: 'active',
        usage_reset_at: preservePeriod ? subscription.usage_reset_at || null : null,
        trial_ends_at: null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        next_billing_date: periodEnd
    };

    if (transaction) await subscription.update(updates, { transaction });
    else await subscription.update(updates);

    if (!transaction) await cacheService.clearForShop(subscription.shop_id);

    const logger = createLogger('subscription-activate', subscription.shop_id);
    logger.info('Subscription activated after invoice payment', {
        subscriptionId: subscription.id,
        nextBillingDate: periodEnd
    });

    return subscription;
};

/**
 * Renewal invoice creation is retired (ADR-0011). Delivered-order invoices are
 * produced by the monthly billing job from `billing_lines`; there is no plan fee
 * an owner can pay to re-activate, and no annual/flat renewal to issue. The
 * export remains so old clients get an explicit refusal instead of a 404.
 *
 * @throws {AppError} 410 RENEWAL_RETIRED for every request
 */
const ensureRenewalInvoice = async (shopId, userId, targetPlanCode = null) => {
    await verifyShopAccess(userId, shopId);
    void targetPlanCode;
    throw new AppError(
        'Renewal invoices are retired. Delivered-order invoices are generated from recorded outcomes; see /api/public/commercial-contract.',
        410,
        'RENEWAL_RETIRED',
    );
};

module.exports = {
    getSubscription,
    updatePlan,
    trackUsage,
    checkOrderLimit,
    getInvoices,
    getInvoiceById,
    resetUsageCounters,
    createDefaultSubscription,
    getUsageEvents,
    verifyNoDoubleCount,
    checkRateLimit,
    incrementRateLimit,
    grantBonusConversations,
    activateFromPaidInvoice,
    ensureRenewalInvoice,
    cancelOpenRecurringInvoices
};
