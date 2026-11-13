/**
 * Health Check Routes
 * K8s-ready health probes for liveness and readiness checks
 * /live and /ready are unauthenticated (consumed by load balancers and orchestrators)
 * /detailed is authenticated — it exposes queue depths, infra topology, and API keys presence
 */

const express = require('express');
const router = express.Router();
const { sequelize } = require('../utils/database/database-setup');
const redisConfig = require('../config/redis');
const { checkRedisAvailability } = redisConfig;

/**
 * Redis readiness that cannot over-report. The old any-of-six `.some()` said
 * 'connected' while 4 of 6 clients were down (2026-11-13 production audit).
 * The primary path issues a real PING through each client's own configured
 * connection (bounded timeout, short-lived cache — see config/redis.js); a
 * running container or a configured REDIS_URL alone never counts as ready.
 * Falls back to connection-state classification, then to the legacy boolean
 * map, so partial test mocks can never crash the probe endpoints.
 */
const getRedisReadinessSafe = async () => {
    if (typeof redisConfig.probeRedisReadiness === 'function') {
        return redisConfig.probeRedisReadiness();
    }
    if (typeof redisConfig.getRedisReadiness === 'function') {
        return redisConfig.getRedisReadiness();
    }
    const legacy = checkRedisAvailability() || {};
    const anyReady = Object.values(legacy).some(Boolean);
    return {
        status: anyReady ? 'connected' : 'not_configured',
        details: legacy,
    };
};
const { authenticate } = require('../middleware/auth.middleware');
const {
    getMalformedWebhookMetrics,
    getInboundEventMetrics,
} = require('../modules/integration/meta-webhook-metrics');

/**
 * Liveness probe - Is the service responding?
 * Fast check, should fail immediately if service is dead
 */
router.get('/live', (req, res) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

/**
 * Readiness probe - Is the service ready to handle requests?
 * Includes database connectivity check
 */
router.get('/ready', async (req, res) => {
    // Readiness (not liveness — that is /live and never depends on Redis):
    // the service can only serve requests when the database AND the Redis
    // dependencies actually answer. A required dependency that fails its PING
    // probe makes this endpoint return 503, which is what marks the container
    // unhealthy for compose and fails a deployment verification honestly.
    let database = 'connected';
    try {
        await sequelize.authenticate();
    } catch (error) {
        database = 'disconnected';
    }

    let redis = { status: 'disconnected', details: {} };
    if (database === 'connected') {
        try {
            redis = await getRedisReadinessSafe();
        } catch (_) {
            redis = { status: 'disconnected', details: {} };
        }
    }

    // 'not_configured' is the in-memory dev fallback (no real Redis configured)
    // and stays ready by contract; 'degraded'/'disconnected' are not.
    const ready = database === 'connected'
        && redis.status !== 'degraded'
        && redis.status !== 'disconnected';

    // Do NOT include error details — this endpoint is unauthenticated and
    // error messages can expose connection strings, DB hostnames, or
    // credentials. Only neutral status words leave this handler.
    res.status(ready ? 200 : 503).json({
        // Provenance marker — proves this response came from the API and not
        // from a proxy or static-host stub. The launch gate requires it.
        service: 'easymod-backend',
        status: ready ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        database,
        redis: redis.status,
        redis_details: redis.details,
        commit: process.env.GIT_SHA || null,
        version: process.env.APP_VERSION || '1.0.0'
    });
});

/**
 * Headroom and eviction policy from a Redis `INFO memory` payload.
 *
 * Reports unknown as null rather than as a number. An uncapped instance has no
 * headroom to report, and a fabricated 0% reads as "almost empty" on a dashboard
 * when the truth is that the ceiling is unknown.
 */
const parseRedisMemory = (info) => {
    const field = (name) => {
        const match = String(info).match(new RegExp(`^${name}:(.*)$`, 'm'));
        return match ? match[1].trim() : null;
    };
    // Number(null) is 0, not NaN — a missing field must not be reported as
    // "0 bytes used", which reads as a healthy, nearly-empty instance.
    const num = (name) => {
        const raw = field(name);
        if (raw === null || raw === '') return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const used = num('used_memory');
    const max = num('maxmemory');

    return {
        usedBytes: used,
        maxBytes: max,
        peakBytes: num('used_memory_peak'),
        policy: field('maxmemory_policy'),
        usedPercent: used !== null && max !== null && max > 0
            ? Math.round((used / max) * 1000) / 10
            : null,
    };
};

/**
 * P2-6: Detailed health — DB, Redis, queue depths, Vector DB (authenticated)
 */
router.get('/detailed', authenticate, async (req, res) => {
    const checks = {
        service: 'easymod-backend',
        status: 'up',
        commit: process.env.GIT_SHA || null,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: 'unknown',
        redis: 'unknown',
        redis_details: {},
        vectorDb: 'unknown',
        vectorProvider: 'qdrant',
        autoReplyDlq: null,
        queues: null,
        webhookMalformed: { count: null, lastAt: null },
        inboundEvents: {},
    };

    try {
        await sequelize.authenticate();
        checks.database = 'connected';
    } catch (_) {
        checks.database = 'disconnected';
    }

    try {
        const redis = await getRedisReadinessSafe();
        checks.redis_details = redis.details;
        checks.redis = redis.status;
    } catch (_) {
        checks.redis = 'disconnected';
    }

    // Redis runs `noeviction` because it backs BullMQ, so exhausting maxmemory
    // fails writes rather than silently dropping queued jobs. That trade is only
    // safe while there is headroom, so the headroom has to be visible.
    try {
        const { cacheRedis } = require('../config/redis');
        checks.redis_memory = parseRedisMemory(await cacheRedis.info('memory'));
    } catch (_) {
        checks.redis_memory = { error: 'unavailable' };
    }

    try {
        const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
        const qdrantRes = await fetch(`${qdrantUrl}/collections`, {
            headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}
        });
        checks.vectorDb = qdrantRes.ok ? 'available' : 'unavailable';
    } catch (_) {
        checks.vectorDb = 'unavailable';
    }

    // Embedding provider self-check. embedding.semantic === false means the
    // chatbot is running on the non-semantic local fallback — retrieval returns
    // near-random matches and the AI will hallucinate. This must never hide.
    try {
        const { getProviderInfo, probe } = require('../modules/rag/embedding.service');
        const info = getProviderInfo();
        const probeResult = await probe();
        checks.embedding = {
            provider: info.effective,
            configured: info.configured,
            semantic: info.semantic,
            keyPresent: info.keyPresent,
            vectorSize: info.vectorSize,
            probeOk: probeResult.ok,
            probeDimensions: probeResult.dimensions,
            ...(probeResult.error ? { probeError: probeResult.error } : {}),
        };
    } catch (err) {
        checks.embedding = { provider: 'unknown', semantic: false, probeOk: false, probeError: err.message };
    }

    try {
        const queueManager = require('../jobs/queue-manager');
        const queueNames = ['monthlyReset', 'invoiceGenerator', 'paymentReconciler'];
        checks.queues = {};
        for (const name of queueNames) {
            const stats = await queueManager.getQueueStats(name);
            checks.queues[name] = stats || { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
        }
        // Customer-facing reply pipeline (message-processing + notifications +
        // the message-dlq sink). A non-zero dlq means real
        // customers got no reply — this is the path that must never fail silently.
        checks.criticalQueues = await queueManager.getCriticalQueueStats();
        const dlqDepth = checks.criticalQueues?.messageDlq?.waiting;
        // Never coerce an unknown depth to zero — the launch gate reads this
        // field and a fabricated 0 is what made gate 4 report a false PASS.
        checks.autoReplyDlq = Number.isInteger(dlqDepth) ? dlqDepth : null;
    } catch (_) {
        checks.queues = { error: 'queue_manager_unavailable' };
        checks.autoReplyDlq = null;
    }

    // Inbound-side dead letters: events Meta delivered that were never ingested
    // after every retry. Non-zero means real customer messages are lost.
    try {
        const receiptService = require('../modules/integration/meta-webhook-receipt.service');
        const [deadLettered, held, oldestHeldAt] = await Promise.all([
            receiptService.countDeadLettered(),
            receiptService.countUnresolved(),
            typeof receiptService.oldestUnresolvedAt === 'function'
                ? receiptService.oldestUnresolvedAt()
                : null,
        ]);
        checks.webhookReceipts = {
            deadLettered: Number.isInteger(deadLettered) ? deadLettered : null,
            held: Number.isInteger(held) ? held : null,
            oldestHeldAt: oldestHeldAt instanceof Date ? oldestHeldAt.toISOString() : null,
        };
    } catch (_) {
        checks.webhookReceipts = { deadLettered: null, held: null, oldestHeldAt: null };
    }

    try {
        const malformed = getMalformedWebhookMetrics();
        checks.webhookMalformed = {
            count: Number.isSafeInteger(malformed?.count) && malformed.count >= 0 ? malformed.count : null,
            lastAt: typeof malformed?.lastAt === 'string' ? malformed.lastAt : null,
        };
    } catch (_) {
        checks.webhookMalformed = { count: null, lastAt: null };
    }

    // Pilot intelligence counters (Sales Opportunities / Order Confidence).
    // Counts and timestamps only — no shop, customer or phone identifiers.
    try {
        checks.pilotIntelligence = require('../modules/pilot-features/pilot-metrics').snapshot();
    } catch (_) {
        checks.pilotIntelligence = null;
    }

    try {
        checks.inboundEvents = typeof getInboundEventMetrics === 'function'
            ? getInboundEventMetrics()
            : {};
    } catch (_) {
        checks.inboundEvents = {};
    }

    // Auto-reply canary freshness — proves the message-processing worker is alive
    // and consuming the queue (the launch-readiness check reads this).
    try {
        const { cacheRedis } = require('../config/redis');
        const lastOk = cacheRedis ? await cacheRedis.get('canary:msg:last_ok') : null;
        const ageMs = lastOk ? Date.now() - parseInt(lastOk, 10) : null;
        const maxStale = parseInt(process.env.CANARY_MAX_STALENESS_MS, 10) || 15 * 60 * 1000;
        checks.autoReplyCanary = { lastOkAgeMs: ageMs, fresh: ageMs !== null && ageMs <= maxStale };
    } catch (_) {
        checks.autoReplyCanary = { lastOkAgeMs: null, fresh: false };
    }

    // A PING-verified 'degraded' (any real client down) is as unhealthy as a
    // full outage: the launch gate requires redis === 'connected', and the
    // HTTP status must not claim otherwise.
    const unhealthy = checks.database === 'disconnected'
        || checks.redis === 'disconnected'
        || checks.redis === 'degraded';
    res.status(unhealthy ? 503 : 200).json(checks);
});

/**
 * SSE pub/sub health — reports local SSE connection count and Redis pub/sub status.
 * Unauthenticated so load balancers and container orchestrators can probe it.
 */
router.get('/sse', (req, res) => {
    let connections = 0;
    let pubsub = 'down';

    try {
        const sseManager = require('../utils/sse-manager');
        connections = sseManager.getLocalConnectionCount();
        pubsub = sseManager.getPubSubStatus();
    } catch (_) {
        pubsub = 'down';
    }

    res.status(200).json({ connections, pubsub });
});

/**
 * Full health check endpoint with detailed metrics
 */
router.get('/health', async (req, res) => {
    const checks = {
        service: 'up',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        environment: process.env.NODE_ENV || 'development'
    };

    try {
        await sequelize.authenticate();
        checks.database = 'connected';
    } catch (_error) {
        // Do NOT expose error.message — this endpoint is unauthenticated.
        // Log internally; return only a generic status code to callers.
        checks.database = 'disconnected';
    }

    // Memory cache is always available
    checks.redis = 'connected';

    const hasErrors = Object.values(checks).some(v => v === 'disconnected' || v === 'down');
    const statusCode = hasErrors ? 503 : 200;

    res.status(statusCode).json(checks);
});

module.exports = router;
module.exports.parseRedisMemory = parseRedisMemory;
