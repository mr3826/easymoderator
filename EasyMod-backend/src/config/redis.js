/**
 * Redis configuration.
 * Uses real ioredis when REDIS_URL or REDIS_HOST is set in the environment.
 * Falls back to in-memory cache for local development (single-process only —
 * distributed locks and cross-instance caching DO NOT work in fallback mode).
 */

const config = require('./config');
const { MemoryCache } = require('./memory-cache');

const hasRedisConfig = !!(
    process.env.REDIS_URL ||
    (config.redisHost && config.redisHost !== 'localhost' && config.redisHost !== '127.0.0.1')
);

// Allow staging to use memory store if Redis not explicitly configured
const forceMemoryStore = (config.env === 'staging' || config.env === 'development') && !process.env.REDIS_URL;

// DEBUG
if (config.env === 'staging' || config.env === 'development') {
    console.log(`[REDIS DEBUG] env=${config.env}, redisHost=${config.redisHost}, hasRedisConfig=${hasRedisConfig}, forceMemoryStore=${forceMemoryStore}`);
}

let sessionRedis, cacheRedis, rateLimitRedis, legacyRedis;
let sseRedisPub, sseRedisSub;

if (hasRedisConfig && !forceMemoryStore) {
    const Redis = require('ioredis');

    const baseOpts = config.redisUrl
        ? { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: true }
        : {
            host: config.redisHost,
            port: parseInt(config.redisPort) || 6379,
            password: config.redisPassword || undefined,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true
        };

    const createClient = (db, name) => {
        const opts = config.redisUrl
            ? { ...baseOpts, db }
            : { ...baseOpts, db };

        const client = config.redisUrl
            ? new Redis(config.redisUrl, opts)
            : new Redis(opts);

        client.on('connect', () => console.log(`✅ Redis ${name} (DB ${db}) connected`));
        client.on('error', (err) => console.error(`❌ Redis ${name} error:`, err.message));
        return client;
    };

    sessionRedis  = createClient(parseInt(config.redisSessionDb)  || 0, 'Sessions');
    cacheRedis    = createClient(parseInt(config.redisCacheDb)    || 1, 'Cache');
    rateLimitRedis= createClient(parseInt(config.redisRateLimitDb)|| 2, 'RateLimit');
    legacyRedis   = createClient(0, 'Legacy');

    // SSE pub/sub bridge clients — dedicated DB 3 so subscribe mode never
    // blocks the command pipeline shared by cache/rate-limit clients.
    // sseRedisSub enters subscribe mode exclusively; sseRedisPub stays in
    // command mode to issue INCR / LPUSH / LTRIM / EXPIRE / LRANGE.
    sseRedisPub = createClient(3, 'SSE-Pub');
    sseRedisSub = createClient(3, 'SSE-Sub');

    console.log('🔴 Redis clients initialised (real ioredis)');
} else {
    // Development / no-Redis fallback
    console.warn(
        '⚠️  Redis not configured — using in-memory cache.\n' +
        '   Distributed job locks and cross-process caching are DISABLED.\n' +
        '   Set REDIS_URL or REDIS_HOST to enable real Redis.'
    );

    const createMockClient = (cache) => ({
        // Expose the MemoryCache instance so callers that need the real client can detect it
        _isMemoryFallback: true,
        status: 'ready',

        get:     (key)            => cache.get(key),
        set:     (key, val, ...a) => cache.set(key, val, ...a),
         setex:   (key, ttl, val)  => cache.setex(key, ttl, val),
         incrby:  (key, amount)    => cache.incrby(key, amount),
         del:     (...keys)        => cache.del(...keys),
        exists:  (key)            => cache.exists(key),
         scan:    (cursor, ...args) => {
             const opts = args.length === 1 && typeof args[0] === 'object'
                 ? args[0]
                 : { MATCH: args[1], COUNT: args[3] };
             return cache.scan(cursor, opts);
         },
        flushall:()               => cache.flushall(),
        quit:    async ()         => Promise.resolve('OK'),
        on:      (event, cb)      => { if (event === 'connect') setTimeout(cb, 10); },
        zadd:    (key, score, member) => cache.zadd(key, score, member),
        zremrangebyscore: (key, min, max) => cache.zremrangebyscore(key, min, max),
        zcard:   (key) => cache.zcard(key),
        zrange:  (key, start, stop, withScores) => cache.zrange(key, start, stop, withScores)
    });

    sessionRedis   = createMockClient(new MemoryCache());
    cacheRedis     = createMockClient(new MemoryCache());
    rateLimitRedis = createMockClient(new MemoryCache());
    legacyRedis    = createMockClient(new MemoryCache());

    // SSE fallback: no-op pub/sub so sse-bus degrades gracefully in dev.
    // The bus detects _isMemoryFallback and uses in-process EventEmitter instead.
    const sseFallbackCache = new MemoryCache();
    sseRedisPub = createMockClient(sseFallbackCache);
    // sseRedisSub needs subscribe/psubscribe stubs in addition to the base mock
    sseRedisSub = Object.assign(createMockClient(sseFallbackCache), {
        subscribe:   async () => Promise.resolve(),
        unsubscribe: async () => Promise.resolve(),
        on:          (event, cb) => { if (event === 'connect') setTimeout(cb, 10); }
    });
}

async function closeAllRedis() {
    await Promise.all(
        [sessionRedis, cacheRedis, rateLimitRedis, legacyRedis, sseRedisPub, sseRedisSub]
            .map(c => c.quit?.().catch(() => {}))
    );
    console.log('Redis connections closed');
}

function checkRedisAvailability() {
    const ready = (c) => c.status === 'ready' || c._isMemoryFallback === true;
    return {
        session:   ready(sessionRedis),
        cache:     ready(cacheRedis),
        rateLimit: ready(rateLimitRedis),
        legacy:    ready(legacyRedis),
        ssePub:    ready(sseRedisPub),
        sseSub:    ready(sseRedisSub)
    };
}

/**
 * Honest readiness classification for health endpoints.
 *
 * All real clients are created with `lazyConnect: true`, so an unused client
 * legitimately sits in 'wait' until its first command — that is NOT a failure,
 * and the old any-of-six `.some()` reading hid real failures behind it (a
 * production audit found 4 of 6 clients down-reported as 'connected').
 *
 * Per-client states (synchronous, connection-state based):
 *   ready    — connected (or in-memory fallback active)
 *   idle     — created but not connected yet (lazyConnect), or transiently
 *              connecting/reconnecting
 *   down     — ioredis gave up ('end'): retries exhausted or client closed
 *
 * Overall status:
 *   connected      — nothing is down (ready/idle mix is normal)
 *   degraded       — at least one client is down
 *   not_configured — every client is the in-memory dev fallback
 */
function getRedisReadiness() {
    const details = {};
    for (const [name, client] of Object.entries(redisClients())) {
        if (!client) {
            details[name] = 'down';
            continue;
        }
        if (client._isMemoryFallback === true) {
            details[name] = 'fallback';
            continue;
        }
        if (client.status === 'ready') {
            details[name] = 'ready';
        } else if (client.status === 'end') {
            details[name] = 'down';
        } else {
            // 'wait' (lazy, never used yet), 'connecting', 'reconnecting',
            // 'close' — transient or unused, not a confirmed failure.
            details[name] = 'idle';
        }
    }
    return { status: summarize(details), details };
}

function redisClients() {
    return {
        session:   sessionRedis,
        cache:     cacheRedis,
        rateLimit: rateLimitRedis,
        legacy:    legacyRedis,
        ssePub:    sseRedisPub,
        sseSub:    sseRedisSub
    };
}

function summarize(details) {
    const values = Object.values(details);
    if (values.some((v) => v === 'down')) return 'degraded';
    if (values.every((v) => v === 'fallback')) return 'not_configured';
    return 'connected';
}

// ── Authenticated PING-based readiness probe ─────────────────────────────────
// A running container, an open TCP port, or a configured REDIS_URL does not
// make Redis ready. The probe below issues a real PING over each client's own
// configured connection (host/port/password/TLS come from the client's config,
// so credentials are never duplicated here), bounded by a timeout, and reuses
// the existing clients — no new connection per health request. Results are
// cached briefly so a fleet of probes cannot turn readiness into a PING storm.

const PROBE_TIMEOUT_MS = Math.min(10000, Math.max(100,
    Number.parseInt(process.env.REDIS_HEALTH_PROBE_TIMEOUT_MS, 10) || 1500));
const PROBE_CACHE_MS = Math.max(0,
    Number.parseInt(process.env.REDIS_HEALTH_CACHE_MS, 10) || 10000);

let readinessCache = null;

function pingWithTimeout(client, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const settle = (fn, value) => {
            if (timer) clearTimeout(timer);
            fn(value);
        };
        timer = setTimeout(
            () => settle(reject, new Error(`redis PING timed out after ${timeoutMs}ms`)),
            timeoutMs,
        );
        Promise.resolve()
            .then(() => client.ping())
            .then((reply) => settle(resolve, reply))
            .catch((err) => settle(reject, err));
    });
}

async function probeClient(name, client) {
    if (!client) return 'down';
    if (client._isMemoryFallback === true) return 'fallback';
    try {
        const reply = await pingWithTimeout(client, PROBE_TIMEOUT_MS);
        return reply === 'PONG' ? 'ready' : 'down';
    } catch (err) {
        // ioredis rejects non-subscription commands on the SSE subscriber
        // connection. PING is protocol-legal in subscribe mode, but if this
        // ioredis build refuses it, fall back to connection-state truth for
        // this one client instead of reporting a false 'down'. The shared
        // server was already PING-proven through ssePub.
        if (/subscriber mode/i.test(String(err && err.message))) {
            if (client.status === 'ready') return 'ready';
            return client.status === 'end' ? 'down' : 'idle';
        }
        return 'down';
    }
}

/**
 * Async, PING-verified Redis readiness. Returns
 * `{ status: connected|degraded|not_configured, details, probedAt }`.
 * `force: true` bypasses the short-lived cache (tests, incident triage).
 */
async function probeRedisReadiness({ force = false } = {}) {
    if (!force && readinessCache && (Date.now() - readinessCache.at) < PROBE_CACHE_MS) {
        return readinessCache.result;
    }
    const entries = Object.entries(redisClients());
    const results = await Promise.all(
        entries.map(async ([name, client]) => [name, await probeClient(name, client)]),
    );
    const details = Object.fromEntries(results);
    const result = {
        status: summarize(details),
        details,
        probedAt: new Date().toISOString(),
    };
    readinessCache = { at: Date.now(), result };
    return result;
}

/** Drop the cached probe result (tests, or after a config-affecting restart). */
function resetRedisReadinessCache() {
    readinessCache = null;
}

module.exports = {
    sessionRedis,
    cacheRedis,
    rateLimitRedis,
    legacyRedis,
    sseRedisPub,
    sseRedisSub,
    closeAllRedis,
    checkRedisAvailability,
    getRedisReadiness,
    probeRedisReadiness,
    resetRedisReadinessCache
};
