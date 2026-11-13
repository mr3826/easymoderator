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
 * Per-client states:
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
    const clients = {
        session:   sessionRedis,
        cache:     cacheRedis,
        rateLimit: rateLimitRedis,
        legacy:    legacyRedis,
        ssePub:    sseRedisPub,
        sseSub:    sseRedisSub
    };

    const details = {};
    for (const [name, client] of Object.entries(clients)) {
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

    const values = Object.values(details);
    let status;
    if (values.some((v) => v === 'down')) {
        status = 'degraded';
    } else if (values.every((v) => v === 'fallback')) {
        status = 'not_configured';
    } else {
        status = 'connected';
    }
    return { status, details };
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
    getRedisReadiness
};
