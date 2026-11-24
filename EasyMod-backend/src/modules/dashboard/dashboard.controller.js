const dashboardService = require('./dashboard.service');
const dashboardAnalytics = require('./dashboard.analytics');

/**
 * RESTful: Get dashboard metrics
 */
const getDashboardMetricsRest = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const period = parseInt(req.query.period) || 30;
        const metrics = await dashboardService.getDashboardMetrics(req.user.userId, shopId, period);

        res.status(200).json({ success: true, data: metrics });
    } catch (error) {
        next(error);
    }
};

const logAnalyticsEvent = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const row = await dashboardAnalytics.logEvent(shopId, req.body);

        res.status(201).json({
            event_id: String(row.id),
            logged: true
        });
    } catch (error) {
        next(error);
    }
};

const logAnalyticsMetric = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        await dashboardAnalytics.logMetric(shopId, req.body);

        res.status(201).json({
            recorded: true
        });
    } catch (error) {
        next(error);
    }
};

const getAnalyticsDashboard = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const data = await dashboardAnalytics.getDashboardAnalytics(shopId);

        res.status(200).json({
            total_messages:      data.totals.total_messages,
            llm_calls:           data.totals.llm_calls,
            cache_hits:          data.totals.cache_hits,
            keyword_matches:     data.totals.keyword_matches,
            cost_estimate:       data.totals.cost_estimate,
            avg_response_time_ms: 0,
            intent_breakdown:    {},
            handover_rate:       0,
            customer_satisfaction: 0,
            error_rate:          0
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get dashboard metrics by ID
 */
const getDashboardMetricsById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const { id } = req.params;
        const period  = parseInt(req.query.period) || 30;
        const metrics = await dashboardService.getDashboardMetricsById(id, req.user.userId, shopId, period);

        if (!metrics) {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Dashboard not found.' } });
        }

        res.status(200).json({ success: true, data: metrics });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: Get dashboard metrics (backward compatibility)
 */
const getDashboardMetrics = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const period  = parseInt(req.query.period) || 30;
        const metrics = await dashboardService.getDashboardMetrics(req.user.userId, shopId, period);

        res.status(200).json({ success: true, data: metrics });
    } catch (error) {
        next(error);
    }
};

/**
 * Bug #15: Lazy chart endpoint — returns only the GROUP-BY order-per-day data.
 * Called after the KPI summary is already rendered so the heavy query doesn't
 * block the initial page paint.
 */
const getDashboardChart = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const period    = parseInt(req.query.period) || 30;
        const chartData = await dashboardService.getDashboardChart(shopId, period);
        res.status(200).json({ success: true, data: chartData });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/dashboard/queue — Phase 1 C3/D3 rewrite (doc 05 §3).
 *
 * Every number here has ONE authority and the queue ALIGNS with it (not a
 * relabel): dispatch + at-risk counts use the authoritative
 * order-worklist.buckets.js predicates (`delivery_status` vocabulary) that
 * GET /api/order/counts and the Orders list use, so chip == bucket == list is
 * provable on the same fixtures; `needs_reply` comes from the shared C1
 * bounded service (same predicate as the Inbox badge); `pending_payment_count`
 * keeps its UNCHANGED predicate (destination /orders?payment=pending, #301
 * continuity). The stale `Conversation.status='unanswered'` count and the
 * dead local `startOfToday` are removed, and `at_risk_orders` no longer
 * projects customer_name/customer_phone (PII defect — projection is
 * {id, orderNumber, status, tracking_id, updatedAt} only). `unread_count` is
 * deprecated and no longer computed (doc 05 §3).
 */
const getTodayQueue = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const { Op } = require('sequelize');
        const { Order, BillingLine, AuditLog, User } = require('../entities');
        const { getCommerceSignals } = require('./dashboard-commerce-signals.service');
        const { buildBucketWhere } = require('../order/order-worklist.buckets');
        const { getNeedsReplyCount } = require('../inbox/inbox-needs-reply.service');

        const [
            pendingPaymentCount,
            readyToDispatchCount,
            needsReply,
            atRiskOrders,
            commerceSignals,
        ] = await Promise.all([
            // Orders placed but payment not confirmed yet — UNCHANGED predicate.
            Order.count({ where: { shop_id: shopId, payment_status: 'pending', order_status: { [Op.notIn]: ['cancelled', 'refunded'] } } }),
            // Dispatch chip = the authoritative `to_pack` bucket.
            Order.count({ where: { [Op.and]: [{ shop_id: shopId }, buildBucketWhere('to_pack')] } }),
            // Inbox chip = the shared C1 service object; null when that source
            // failed (never 0 — the queue must not answer for an unavailable
            // badge source). Sub-source failure never 5xxes the whole queue.
            getNeedsReplyCount({ shopId }).catch(() => null),
            // At-risk rows = the authoritative `needs_action` bucket sample.
            Order.findAll({
                where: { [Op.and]: [{ shop_id: shopId }, buildBucketWhere('needs_action')] },
                attributes: ['id', 'order_number', 'order_status', 'delivery_tracking_code', 'updated_at'],
                limit: 10,
                order: [['updated_at', 'DESC']]
            }),
            // Each sub-source is independently null-on-failure (allSettled inside).
            getCommerceSignals({ shopId, BillingLine, AuditLog, User }),
        ]);

        res.status(200).json({
            success: true,
            data: {
                commerce_signals: commerceSignals,
                needs_reply: needsReply,
                predicate_version: 'worklist-v1',
                pending_payment_count: pendingPaymentCount,
                ready_to_dispatch_count: readyToDispatchCount,
                at_risk_orders: atRiskOrders.map(o => ({
                    id: o.id,
                    orderNumber: o.order_number ?? o.id,
                    status: o.order_status,
                    tracking_id: o.delivery_tracking_code ?? null,
                    updatedAt: o.updated_at ? new Date(o.updated_at).toISOString() : null
                }))
            }
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    // RESTful methods
    getDashboardMetricsRest,
    getDashboardMetricsById,
    getDashboardChart,
    getTodayQueue,
    logAnalyticsEvent,
    logAnalyticsMetric,
    getAnalyticsDashboard,
    // Legacy methods for backward compatibility
    getDashboardMetrics
};
