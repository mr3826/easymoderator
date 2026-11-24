const { Analytics } = require('../entities');
const { fn, col, Op } = require('sequelize');
const cacheService = require('../../utils/cache.service');

// Phase 1 D11 cache fix: the KPI summary is cached by dashboard.service under
// the TENANT-scoped key `dashboard:summary:{period}` (per-period keys). The
// old invalidation deleted `dashboard:metrics`, a key nothing ever read — so
// logged events left stale summaries cached for the full 300 s TTL. Evict the
// whole per-shop summary family via the tenant-prefixed SCAN pattern instead.
const SUMMARY_CACHE_PATTERN = 'dashboard:summary:*';

/**
 * Log an analytics event for a shop day-bucket.
 *
 * Uses findOrCreate (INSERT WHERE NOT EXISTS) to safely create the day-row,
 * then issues atomic SQL-level INCREMENT so concurrent callers never lose counts.
 * Only events with event_type === 'message' count toward total_messages.
 */
const logEvent = async (shopId, payload) => {
    const date = payload.timestamp ? new Date(payload.timestamp) : new Date();
    const dateKey = date.toISOString().split('T')[0];

    // Atomically create row for this day if it doesn't exist yet
    await Analytics.findOrCreate({
        where: { shop_id: shopId, date: dateKey },
        defaults: {
            total_messages: 0,
            llm_calls: 0,
            cache_hits: 0,
            keyword_matches: 0,
            cost_estimate: 0
        }
    });

    // Build increments — all are SQL-level (UPDATE SET col = col + n), never stale reads
    const increments = {};
    if (payload.event_type === 'message')          increments.total_messages  = 1;
    if (payload.metadata?.ai_model)                increments.llm_calls       = 1;
    if (payload.metadata?.cache_hit)               increments.cache_hits      = 1;
    if (payload.metadata?.keyword_match)           increments.keyword_matches = 1;
    const cost = Number(payload.metadata?.cost_estimate || 0);
    if (cost > 0)                                  increments.cost_estimate   = cost;

    if (Object.keys(increments).length > 0) {
        await Analytics.increment(increments, { where: { shop_id: shopId, date: dateKey } });
    }

    // Invalidate cached dashboard summary so next read reflects the new event.
    await cacheService.deletePatternForShop(shopId, SUMMARY_CACHE_PATTERN).catch(() => {});

    return Analytics.findOne({ where: { shop_id: shopId, date: dateKey } });
};

/**
 * Log a raw metric (e.g. response_time) for a shop day-bucket.
 * Uses the same atomic findOrCreate pattern as logEvent.
 */
const logMetric = async (shopId, payload) => {
    const date = payload.timestamp ? new Date(payload.timestamp) : new Date();
    const dateKey = date.toISOString().split('T')[0];

    await Analytics.findOrCreate({
        where: { shop_id: shopId, date: dateKey },
        defaults: {
            total_messages: 0,
            llm_calls: 0,
            cache_hits: 0,
            keyword_matches: 0,
            cost_estimate: 0
        }
    });

    // Currently only response_time is handled; extend as needed
    if (payload.metric_type === 'response_time' && Number(payload.value) > 0) {
        // response_time metrics are stored elsewhere; placeholder for future columns
    }

    await cacheService.deletePatternForShop(shopId, SUMMARY_CACHE_PATTERN).catch(() => {});
};

/**
 * Get aggregated analytics totals for a shop.
 * Uses a single SQL SUM query instead of loading all rows into memory.
 */
const getDashboardAnalytics = async (shopId) => {
    const result = await Analytics.findOne({
        attributes: [
            [fn('COALESCE', fn('SUM', col('total_messages')),  0), 'total_messages'],
            [fn('COALESCE', fn('SUM', col('llm_calls')),       0), 'llm_calls'],
            [fn('COALESCE', fn('SUM', col('cache_hits')),      0), 'cache_hits'],
            [fn('COALESCE', fn('SUM', col('keyword_matches')), 0), 'keyword_matches'],
            [fn('COALESCE', fn('SUM', col('cost_estimate')),   0), 'cost_estimate'],
        ],
        where: { shop_id: shopId },
        raw: true
    });

    const totals = {
        total_messages:  Number(result?.total_messages  || 0),
        llm_calls:       Number(result?.llm_calls       || 0),
        cache_hits:      Number(result?.cache_hits      || 0),
        keyword_matches: Number(result?.keyword_matches || 0),
        cost_estimate:   Number(result?.cost_estimate   || 0),
    };

    return { totals };
};

module.exports = { logEvent, logMetric, getDashboardAnalytics };
