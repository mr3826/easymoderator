const express = require('express');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { body } = require('express-validator');
const config = require('../../config/config');
const { rateLimitRedis } = require('../../config/redis');
const AnalyticsController = require('./analytics.controller');
const growthMetrics = require('./growth-metrics.service');
const { validateFunnelEvent } = require('./analytics.validator');
const { authenticate } = require('../../middleware/auth.middleware');
const { requireGrowthOsAccess } = require('../growth-os/growth-os.middleware');
const { sequelize } = require('../../utils/database/database-setup');
const { QueryTypes } = require('sequelize');

const router = express.Router();
const growthAuthenticate = typeof authenticate.withOptions === 'function'
    ? authenticate.withOptions({ requireShopMembership: false })
    : authenticate;

const buildAnalyticsRateLimitStore = (prefix) => {
    // Keep unit tests deterministic and use the shared Redis-backed store in
    // deployed environments. Production configuration requires REDIS_URL;
    // development/staging can still use the documented single-process
    // fallback when Redis is intentionally absent.
    if (config.env === 'test') return undefined;
    if (!rateLimitRedis || rateLimitRedis._isMemoryFallback || typeof rateLimitRedis.call !== 'function') {
        return undefined;
    }
    try {
        return new RedisStore({
            prefix,
            sendCommand: (...args) => rateLimitRedis.call(...args),
        });
    } catch (_) {
        return undefined;
    }
};

const knowledgeGapWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildAnalyticsRateLimitStore('rl:analytics-knowledge-gap:'),
});
const publicFunnelWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildAnalyticsRateLimitStore('rl:analytics-funnel:'),
    message: {
        success: false,
        error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many funnel events. Please try again later.',
        },
    },
});

// Validation middleware
const validateKnowledgeGap = [
    body('question')
        .trim()
        .notEmpty().withMessage('question is required')
        .isLength({ max: 1000 }).withMessage('question must not exceed 1000 characters'),
    body('shop_id').optional().isUUID().withMessage('shop_id must be a UUID'),
    body('platform').isIn(['messenger']).withMessage('Invalid platform'),
    body('language').optional().isIn(['en', 'bn', 'mixed']).withMessage('Invalid language')
];

// Routes

// POST /api/analytics/funnel — first-party launch funnel instrumentation.
router.post('/funnel', publicFunnelWriteLimiter, validateFunnelEvent, AnalyticsController.logFunnelEvent);

/**
 * GET /api/analytics — summary payload (total_messages, llm_calls, cache_hits, keyword_matches, cost_estimate)
 * Consumed by the frontend dashboard (api/domains/dashboard.ts getAnalytics).
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const shopId = req.user?.shopId;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected.' } });
        }
        const period = Math.min(parseInt(req.query.period) || 30, 365);
        const since = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

        // Count messages in the period for this shop via conversations join
        const [msgRow] = await sequelize.query(
            `SELECT COUNT(m.id) AS total_messages
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE c.shop_id = :shopId AND m.created_at >= :since`,
            { replacements: { shopId, since }, type: QueryTypes.SELECT }
        );

        // Count knowledge-gap logs as a proxy for unanswered (llm) calls
        const [gapRow] = await sequelize.query(
            `SELECT COUNT(id) AS llm_calls FROM knowledge_gaps WHERE shop_id = :shopId AND created_at >= :since`,
            { replacements: { shopId, since }, type: QueryTypes.SELECT }
        );

        const total_messages = parseInt(msgRow?.total_messages) || 0;
        const llm_calls = parseInt(gapRow?.llm_calls) || 0;

        res.json({
            success: true,
            data: {
                total_messages,
                llm_calls,
                cache_hits: 0,
                keyword_matches: 0,
                cost_estimate: +(llm_calls * 0.002).toFixed(4)
            }
        });
    } catch (err) {
        console.error('Analytics summary error:', { name: err?.name, code: err?.code });
        res.status(503).json({
            success: false,
            error: {
                code: 'ANALYTICS_ERROR',
                message: 'Analytics are temporarily unavailable.',
            },
        });
    }
});

/**
 * POST /api/analytics/knowledge-gap
 * Log knowledge gaps when FAQ handler can't answer
 */
router.post(
    '/knowledge-gap',
    authenticate,
    knowledgeGapWriteLimiter,
    validateKnowledgeGap,
    AnalyticsController.logKnowledgeGap,
);

// GET /api/analytics/knowledge-gap — authenticated, scoped to the logged-in shop
router.get('/knowledge-gap', authenticate, AnalyticsController.getKnowledgeGaps);

// GET /api/analytics/top-unanswered — top unanswered questions
router.get('/top-unanswered', authenticate, AnalyticsController.getTopUnansweredQuestions);

// GET /api/analytics/peak-hours — message volume by hour of day
router.get('/peak-hours', authenticate, AnalyticsController.getPeakHours);

// GET /api/analytics/intent-breakdown — conversation count by intent
router.get('/intent-breakdown', authenticate, AnalyticsController.getIntentBreakdown);

// GET /api/analytics/confidence-distribution — AI confidence score buckets
router.get('/confidence-distribution', authenticate, AnalyticsController.getConfidenceDistribution);

/**
 * GET /api/analytics/growth — deprecated operational AI-reply + retention
 * report. Canonical Growth OS activation analytics live at the Growth OS
 * workspace prospect-ledger endpoint.
 */
router.get('/growth', growthAuthenticate, requireGrowthOsAccess('growth_os.reports.read_all'), async (req, res) => {
    try {
        const data = await growthMetrics.getGrowthMetrics();
        res.json({ success: true, data });
    } catch (err) {
        console.error('Growth OS metrics error:', { name: err?.name, code: err?.code });
        res.status(503).json({
            success: false,
            error: {
                code: 'GROWTH_METRICS_ERROR',
                message: 'Growth OS metrics are temporarily unavailable.',
            },
        });
    }
});

module.exports = router;
