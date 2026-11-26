const { cacheRedis } = require('../config/redis.js');

// In-memory fallback: evict oldest entries when this limit is reached
const MAX_MEMORY_ENTRIES = 10000;
const STRICT_REDIS_READY_TIMEOUT_MS = 5000;

const awaitWithTimeout = (promise, message) => {
    let timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), STRICT_REDIS_READY_TIMEOUT_MS);
            timeout.unref?.();
        }),
    ]).finally(() => clearTimeout(timeout));
};

/**
 * Cache Service — Redis-backed with in-memory fallback.
 *
 * TENANT ISOLATION
 * ─────────────────
 * All callers SHOULD use the tenant-scoped API:
 *   cache.getForShop(shopId, key)
 *   cache.setForShop(shopId, key, value, ttl)
 *   cache.deleteForShop(shopId, key)
 *   cache.deletePatternForShop(shopId, pattern)
 *   cache.clearForShop(shopId)
 *
 * The legacy un-scoped methods (get/set/delete/deletePattern/clear) are kept for
 * backward compatibility but are NOT tenant-isolated. Migrate callers to the
 * scoped API when touching those code paths.
 */
class CacheService {
    constructor() {
        this.memoryCache = new Map();
    }

    // ─── Internal helpers ───────────────────────────────────────────────────────

    /**
     * Build a tenant-namespaced Redis key.
     * Format: t:{shopId}:{key}
     */
    _tenantKey(shopId, key) {
        return `t:${shopId}:${key}`;
    }

    async _getStrictRedis() {
        if (!cacheRedis || cacheRedis._isMemoryFallback === true) {
            throw new Error('Redis cache is unavailable');
        }
        if (cacheRedis.status !== 'ready') {
            const readiness = cacheRedis.status === 'wait'
                && typeof cacheRedis.connect === 'function'
                ? cacheRedis.connect()
                : typeof cacheRedis.ping === 'function'
                    ? cacheRedis.ping()
                    : Promise.reject(new Error('Redis cache is unavailable'));
            await awaitWithTimeout(readiness, 'Redis cache readiness timed out');
        }
        if (cacheRedis.status !== 'ready') {
            throw new Error('Redis cache is unavailable');
        }
        return cacheRedis;
    }

    /**
     * Core get — works on any raw Redis key.
     */
    async _get(rawKey) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') {
                const value = await cacheRedis.get(rawKey);
                return value ? JSON.parse(value) : null;
            }
            return this.memoryCache.get(rawKey) ?? null;
        } catch (error) {
            console.error('Cache get error:', error);
            return null;
        }
    }

    /**
     * Core set — works on any raw Redis key.
     */
    async _set(rawKey, value, ttl = null) {
        try {
            const serialized = JSON.stringify(value);
            if (cacheRedis && cacheRedis.status === 'ready') {
                if (ttl) {
                    await cacheRedis.setex(rawKey, ttl, serialized);
                } else {
                    await cacheRedis.set(rawKey, serialized);
                }
                return true;
            }
            // In-memory fallback: evict LRU entry when at capacity
            if (this.memoryCache.size >= MAX_MEMORY_ENTRIES) {
                const firstKey = this.memoryCache.keys().next().value;
                this.memoryCache.delete(firstKey);
            }
            this.memoryCache.set(rawKey, value);
            if (ttl) {
                setTimeout(() => this.memoryCache.delete(rawKey), ttl * 1000);
            }
            return true;
        } catch (error) {
            console.error('Cache set error:', error);
            return false;
        }
    }

    /**
     * Core delete — works on any raw Redis key.
     */
    async _delete(rawKey) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') {
                await cacheRedis.del(rawKey);
                return true;
            }
            return this.memoryCache.delete(rawKey);
        } catch (error) {
            console.error('Cache delete error:', error);
            return false;
        }
    }

    /**
     * Core pattern delete using SCAN (non-blocking, safe at scale).
     * NEVER uses KEYS * which blocks the Redis event loop.
     */
    async _deletePattern(rawPattern) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') {
                let cursor = '0';
                let deleted = 0;
                do {
                    const [nextCursor, keys] = await cacheRedis.scan(
                        cursor, 'MATCH', rawPattern, 'COUNT', 100
                    );
                    cursor = nextCursor;
                    if (keys.length > 0) {
                        await cacheRedis.del(...keys);
                        deleted += keys.length;
                    }
                } while (cursor !== '0');
                return deleted;
            }
            // Memory cache: iterate and delete matching keys
            let deleted = 0;
            const patternRegex = new RegExp(
                '^' + rawPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
            );
            for (const k of this.memoryCache.keys()) {
                if (patternRegex.test(k)) {
                    this.memoryCache.delete(k);
                    deleted++;
                }
            }
            return deleted;
        } catch (error) {
            console.error('Cache deletePattern error:', error);
            return 0;
        }
    }

    // ─── Tenant-scoped API (preferred) ──────────────────────────────────────────

    /**
     * Get a tenant-scoped cache value.
     * @param {string} shopId - Tenant identifier
     * @param {string} key
     */
    async getForShop(shopId, key) {
        return this._get(this._tenantKey(shopId, key));
    }

    /**
     * Read a tenant-scoped value without converting a real Redis outage into a
     * cache miss. The in-memory development client remains usable; a configured
     * but unavailable Redis client is treated as unavailable by callers that
     * require freshness guarantees.
     */
    async getForShopStrict(shopId, key) {
        const rawKey = this._tenantKey(shopId, key);
        if (cacheRedis?._isMemoryFallback === true) return this._get(rawKey);
        const redis = await this._getStrictRedis();
        const value = await redis.get(rawKey);
        return value ? JSON.parse(value) : undefined;
    }

    /**
     * Set a tenant-scoped cache value.
     * @param {string} shopId - Tenant identifier
     * @param {string} key
     * @param {any} value
     * @param {number} [ttl] - Seconds
     */
    async setForShop(shopId, key, value, ttl = null) {
        return this._set(this._tenantKey(shopId, key), value, ttl);
    }

    /**
     * Delete a tenant-scoped cache entry.
     */
    async deleteForShop(shopId, key) {
        return this._delete(this._tenantKey(shopId, key));
    }

    /**
     * Delete a tenant-scoped value without converting a Redis outage into a
     * successful no-op. The in-memory fallback remains valid for local runs.
     */
    async deleteForShopStrict(shopId, key) {
        const rawKey = this._tenantKey(shopId, key);
        if (cacheRedis?._isMemoryFallback === true) {
            await cacheRedis.del(rawKey);
            return true;
        }
        const redis = await this._getStrictRedis();
        await redis.del(rawKey);
        return true;
    }

    /**
     * Delete tenant-scoped entries matching a pattern (SCAN-based, non-blocking).
     * @param {string} shopId - Tenant identifier
     * @param {string} pattern - Glob pattern relative to tenant namespace (e.g. 'product:*')
     */
    async deletePatternForShop(shopId, pattern) {
        return this._deletePattern(this._tenantKey(shopId, pattern));
    }

    /**
     * Clear ALL cache entries for a single tenant.
     * Safe: only removes keys prefixed with t:{shopId}: — no cross-tenant impact.
     */
    async clearForShop(shopId) {
        return this._deletePattern(`t:${shopId}:*`);
    }

    /**
     * Check if a tenant-scoped key exists.
     */
    async existsForShop(shopId, key) {
        try {
            const rawKey = this._tenantKey(shopId, key);
            if (cacheRedis && cacheRedis.status === 'ready') {
                return (await cacheRedis.exists(rawKey)) === 1;
            }
            return this.memoryCache.has(rawKey);
        } catch (error) {
            console.error('Cache existsForShop error:', error);
            return false;
        }
    }

    /**
     * Increment a tenant-scoped numeric counter.
     */
    async incrementForShop(shopId, key, amount = 1) {
        try {
            const rawKey = this._tenantKey(shopId, key);
            if (cacheRedis && cacheRedis.status === 'ready') {
                return await cacheRedis.incrby(rawKey, amount);
            }
            const current = this.memoryCache.get(rawKey) || 0;
            const newValue = current + amount;
            this.memoryCache.set(rawKey, newValue);
            return newValue;
        } catch (error) {
            console.error('Cache incrementForShop error:', error);
            return 0;
        }
    }

    /**
     * Increment a tenant-scoped counter without hiding a Redis outage. This
     * is used for cache generations, where a missed increment can replay data.
     */
    async incrementForShopStrict(shopId, key, amount = 1) {
        const rawKey = this._tenantKey(shopId, key);
        if (cacheRedis?._isMemoryFallback === true) {
            return cacheRedis.incrby(rawKey, amount);
        }
        const redis = await this._getStrictRedis();
        return redis.incrby(rawKey, amount);
    }

    // ─── F-3 (A9-R2, 2026-11-26): atomic rolling-budget consumption ──────────
    //
    // One EVAL command performs ZREMRANGEBYSCORE → ZCARD → ZADD → PEXPIRE, so
    // the ≤2-per-rolling-hour provider hammer budget can NEVER be checked and
    // written non-atomically (the old get→filter→push→set sequence let two
    // concurrent grants both observe "0 used" and consume "1" — zero slots
    // actually recorded for two real grants). Unlike every other helper here,
    // this one does NOT swallow Redis failures: provider-hammer protection
    // must fail CLOSED, so an unavailable/erroring Redis THROWS and the caller
    // must refuse the grant.
    static GRANT_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= max then
  return -1
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window + 1000)
return count + 1
`;

    /**
     * Consume one slot of a rolling-window budget atomically.
     * @returns {Promise<number>} 1-based slot index, or -1 when spent.
     * @throws when the budget state cannot be reliably read OR written
     *         (fail-closed by contract — callers refuse the action).
     */
    async consumeSlotForShopStrict(shopId, key, { max, windowMs, member, now = Date.now() }) {
        if (!(Number(max) >= 1) || !(Number(windowMs) >= 1000) || !member) {
            throw new Error('consumeSlotForShopStrict requires max>=1, windowMs>=1000 and a member token');
        }
        const rawKey = this._tenantKey(shopId, key);
        if (cacheRedis && cacheRedis._isMemoryFallback === true) {
            // Dev/test fallback (single process): replay the Lua steps on the
            // memory ZSET shim. Each fallback method resolves without real I/O;
            // this path is explicitly documented NOT cross-process-safe
            // (config/redis.js header) and only local runs can observe its
            // microtask interleave — the real-Redis EVAL below is atomic.
            const window = Number(windowMs);
            await cacheRedis.zremrangebyscore(rawKey, '-inf', now - window);
            const count = await cacheRedis.zcard(rawKey);
            if (count >= max) return -1;
            await cacheRedis.zadd(rawKey, now, member);
            return count + 1;
        }
        // Real Redis: one EVAL round-trip, atomic server-side. NO catch here:
        // connection loss / non-ready status / EVAL rejection all THROW.
        const redis = await this._getStrictRedis();
        if (typeof redis.eval !== 'function') {
            throw new Error('Redis EVAL unavailable — atomic budget cannot be verified');
        }
        const result = await redis.eval(
            CacheService.GRANT_WINDOW_LUA, 1, rawKey,
            String(now), String(Math.ceil(windowMs)), String(Math.floor(max)), String(member),
        );
        const slot = Number(result);
        if (!Number.isInteger(slot)) {
            throw new Error('Unexpected EVAL reply for rolling budget — refusing open');
        }
        return slot;
    }

    /**
     * Atomically claim a tenant-scoped key for a TTL. Used for notification
     * dedupe where a get-then-set sequence would allow concurrent workers to
     * queue duplicate alerts.
     */
    async claimForShop(shopId, key, ttlSeconds) {
        try {
            const rawKey = this._tenantKey(shopId, key);
            if (cacheRedis && cacheRedis.status === 'ready') {
                const result = await cacheRedis.set(
                    rawKey,
                    '1',
                    'EX',
                    Math.max(1, Number(ttlSeconds) || 1),
                    'NX'
                );
                return result === 'OK' || result === true;
            }
            if (this.memoryCache.has(rawKey)) return false;
            this.memoryCache.set(rawKey, true);
            if (ttlSeconds) {
                setTimeout(() => this.memoryCache.delete(rawKey), Number(ttlSeconds) * 1000);
            }
            return true;
        } catch (error) {
            console.error('Cache claimForShop error:', error);
            return false;
        }
    }

    // ─── Legacy un-scoped API (backward compatible, not tenant-isolated) ─────────

    async get(key) { return this._get(key); }

    async set(key, value, ttl = null) { return this._set(key, value, ttl); }

    async delete(key) { return this._delete(key); }

    /**
     * Strict cache operations for security-sensitive authorization decisions.
     * These deliberately reject on Redis absence/failure instead of falling
     * back to process-local memory or converting the failure into a cache miss.
     */
    async getStrict(key) {
        const redis = await this._getStrictRedis();
        const value = await redis.get(key);
        return value ? JSON.parse(value) : null;
    }

    async setStrict(key, value, ttl = null) {
        const redis = await this._getStrictRedis();
        const serialized = JSON.stringify(value);
        if (ttl) {
            await redis.setex(key, ttl, serialized);
        } else {
            await redis.set(key, serialized);
        }
        return true;
    }

    /**
     * Delete keys matching a pattern.
     * Fixed: uses SCAN cursor instead of blocking KEYS *.
     */
    async deletePattern(pattern) { return this._deletePattern(pattern); }

    async exists(key) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') return (await cacheRedis.exists(key)) === 1;
            return this.memoryCache.has(key);
        } catch (error) {
            console.error('Cache exists error:', error);
            return false;
        }
    }

    async expire(key, ttl) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') { await cacheRedis.expire(key, ttl); return true; }
            const value = this.memoryCache.get(key);
            if (value !== undefined) {
                setTimeout(() => this.memoryCache.delete(key), ttl * 1000);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Cache expire error:', error);
            return false;
        }
    }

    /**
     * @deprecated NEVER calls redis.flushdb() — that would wipe ALL tenants' data.
     * Use clearForShop(shopId) to clear a specific tenant's cache instead.
     */
    async clear() {
        console.error(
            '[CacheService] cache.clear() is disabled — it would wipe all tenants. ' +
            'Use cache.clearForShop(shopId) to clear a single tenant.'
        );
        // Only clear the in-memory fallback; never touch Redis here
        this.memoryCache.clear();
        return false;
    }

    async increment(key, amount = 1) {
        try {
            if (cacheRedis && cacheRedis.status === 'ready') return await cacheRedis.incrby(key, amount);
            const current = this.memoryCache.get(key) || 0;
            const newValue = current + amount;
            this.memoryCache.set(key, newValue);
            return newValue;
        } catch (error) {
            console.error('Cache increment error:', error);
            return 0;
        }
    }
}

// Export singleton instance
module.exports = new CacheService();
