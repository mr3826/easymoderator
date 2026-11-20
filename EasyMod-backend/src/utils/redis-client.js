const Redis = require('ioredis');
const config = require('../config/config');

let redisClient = null;
let redisDeadInDev = false;

/**
 * Validate Redis URL uses an internal host in production.
 * Warn on public IPs/FQDNs for security.
 */
function validateRedisUrl(url) {
    if (!url || config.env !== 'production') return;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        // Allow localhost for local dev; block public IPs in prod
        if (host === 'localhost' || host === '127.0.0.1') return;
        // Single-label hostnames (no dots) are typically Docker/compose
        // network aliases (e.g. redis://redis:6379) or local hostnames.
        // Outside compose a dotless DNS name could still resolve publicly —
        // this is a warning-only heuristic on an operator-controlled env.
        // Exclude IPv6 literals (bracketed, contain ':') and dotless IPv4
        // forms (all-integer, e.g. 3405803781, or hex, e.g. 0xcb007105):
        // getaddrinfo resolves those to a real, possibly public address,
        // so they must keep warning.
        if (host && !host.includes('.') && !host.includes(':')
            && !/^\d+$/.test(host) && !/^0x/i.test(host)) return;
        // Private/VPC ranges: 10.x, 172.16-31.x, 192.168.x
        const parts = host.split('.');
        if (parts.length === 4) {
            const first = parseInt(parts[0], 10);
            const second = parseInt(parts[1], 10);
            if (first === 10) return; // 10.0.0.0/8
            if (first === 172 && second >= 16 && second <= 31) return; // 172.16.0.0/12
            if (first === 192 && second === 168) return; // 192.168.0.0/16
        }
        console.warn('⚠️  REDIS_URL appears public in production. Prefer private networking or managed TLS Redis.');
    } catch (_) { /* ignore parse errors */ }
}

/**
 * Initialize Redis client with connection handling
 * @returns {Redis} Redis client instance
 */
function getRedisClient() {
    // If we've already determined Redis is dead in dev, don't even try
    if (redisDeadInDev && config.env === 'development') {
        return null;
    }

    // If client exists but is in a terminal state, clear it
    if (redisClient && (['end', 'closing'].includes(redisClient.status))) {
        redisClient = null;
    }

    if (redisClient) {
        return redisClient;
    }

    // Bypass Redis in development/staging if not configured or connection fails
    if (!config.redisUrl && (config.env === 'development' || config.env === 'staging')) {
        console.warn('⚠️  Redis not configured - using in-memory fallback');
        return null;
    }

    if (!config.redisUrl) {
        throw new Error('REDIS_URL is required in production');
    }

    validateRedisUrl(config.redisUrl);

    const redisOptions = {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy(times) {
            // In development, stop retrying after 3 attempts to avoid log spam
            if (config.env === 'development' && times > 3) {
                console.warn('⚠️  Redis not available — using in-memory fallback for development. Start Redis or set REDIS_URL=false to suppress this.');
                redisDeadInDev = true;
                redisClient = null;
                return null; // stop retrying
            }
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        reconnectOnError(err) {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
                return true;
            }
            return false;
        }
    };

    // Upstash and other managed Redis providers commonly use rediss://
    if (config.redisUrl && config.redisUrl.startsWith('rediss://')) {
        redisOptions.tls = { rejectUnauthorized: false };
    }

    if (config.redisPassword) {
        redisOptions.password = config.redisPassword;
    } else if ((config.env === 'production' || config.env === 'staging') && !(config.redisUrl || '').startsWith('rediss://')) {
        console.warn('⚠️  REDIS_PASSWORD recommended for non-TLS production Redis.');
    }

    try {
        redisClient = new Redis(config.redisUrl, redisOptions);

        redisClient.on('connect', () => {
            console.log('✅ Redis connected successfully');
        });

        redisClient.on('error', (err) => {
            console.error('❌ Redis connection error:', err.message);
            if (config.env === 'development') {
                console.warn('⚠️  Redis connection failed - using in-memory fallback for development');
                redisClient = null;
            }
        });

        redisClient.on('ready', () => {
            console.log('✅ Redis ready for commands');
        });

        redisClient.on('reconnecting', () => {
            console.log('🔄 Redis reconnecting...');
        });

        return redisClient;
    } catch (error) {
        console.error('Failed to initialize Redis client:', error);
        if (config.env === 'development') {
            console.warn('⚠️  Redis initialization failed - using in-memory fallback for development');
            return null;
        }
        throw error;
    }
}

/**
 * Close Redis connection gracefully
 */
async function closeRedis() {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        console.log('Redis connection closed');
    }
}

/**
 * Check if Redis is available
 * @returns {boolean}
 */
function isRedisAvailable() {
    return redisClient && redisClient.status === 'ready';
}

module.exports = {
    getRedisClient,
    closeRedis,
    isRedisAvailable,
    validateRedisUrl
};
