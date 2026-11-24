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
 * GET /api/dashboard/queue
 * Real-time today's action queue for BD F-commerce shop owners.
 * Returns counts for: unread conversations, orders awaiting payment,
 * orders ready to dispatch, and at-risk (RTO) deliveries.
 */
const getTodayQueue = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        const { Op } = require('sequelize');
        const { Order, Conversation, BillingLine, AuditLog } = require('../entities');
        const { getCommerceSignals } = require('./dashboard-commerce-signals.service');

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [unreadCount, pendingPaymentCount, readyToDispatchCount] = await Promise.all([
            // Unanswered conversations (customer waiting for reply)
            Conversation.count({ where: { shop_id: shopId, status: 'unanswered' } }),
            // Orders placed but payment not confirmed yet
            Order.count({ where: { shop_id: shopId, payment_status: 'pending', order_status: { [Op.notIn]: ['cancelled', 'refunded'] } } }),
            // Orders confirmed/paid but not yet dispatched
            Order.count({ where: { shop_id: shopId, order_status: { [Op.in]: ['placed', 'confirmed'] }, fulfillment_status: { [Op.notIn]: ['dispatched', 'shipped', 'delivered'] } } })
        ]);

        // At-risk orders: today's orders where courier hasn't picked up yet (use fulfilled orders with no tracking update)
        const atRiskOrders = await Order.findAll({
            where: {
                shop_id: shopId,
                order_status: 'fulfilled',
                fulfillment_status: { [Op.in]: ['attempted', 'returned'] }
            },
            attributes: ['id', 'customer_name', 'customer_phone', 'fulfillment_status', 'delivery_tracking_code'],
            limit: 10,
            order: [['updated_at', 'DESC']]
        });

        const commerceSignals = await getCommerceSignals({ shopId, BillingLine, AuditLog });

        res.status(200).json({
            success: true,
            data: {
                commerce_signals: commerceSignals,
                unread_count: unreadCount,
                pending_payment_count: pendingPaymentCount,
                ready_to_dispatch_count: readyToDispatchCount,
                at_risk_orders: atRiskOrders.map(o => ({
                    id: o.id,
                    customer_name: o.customer_name,
                    customer_phone: o.customer_phone,
                    status: o.fulfillment_status,
                    tracking_id: o.delivery_tracking_code
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
