'use strict';

/**
 * Unit tests for the PING-verified Redis readiness probe (config/redis.js).
 *
 * Task contract under test:
 *   - Redis is 'ready' ONLY when an actual PING over the client's own
 *     configured connection returns PONG — a constructed client, an open port
 *     or a configured REDIS_URL alone never qualify.
 *   - Connection failures, wrong credentials and timeouts classify 'down'
 *     (→ overall 'degraded'), bounded by REDIS_HEALTH_PROBE_TIMEOUT_MS.
 *   - Recovery is reported on the next probe; results are cached briefly and
 *     `force`/reset bypasses the cache.
 *   - The in-memory dev fallback reports 'not_configured', not 'connected'.
 */

const mockInstances = [];

jest.mock('ioredis', () => {
    function MockRedis(urlOrOpts, maybeOpts) {
        this.status = 'wait';
        this._url = typeof urlOrOpts === 'string' ? urlOrOpts : null;
        this._opts = (typeof urlOrOpts === 'string' ? maybeOpts : urlOrOpts) || {};
        this.on = jest.fn();
        this.ping = jest.fn(() => Promise.resolve('PONG'));
        this.quit = jest.fn(() => Promise.resolve('OK'));
        mockInstances.push(this);
    }
    return MockRedis;
});

jest.mock('../config', () => ({
    get env() { return 'production'; },
    get redisUrl() { return process.env.REDIS_URL || ''; },
    get redisHost() { return process.env.MOCK_REDIS_HOST || 'redis.internal'; },
    get redisPort() { return '6379'; },
    get redisPassword() { return 'testpw'; },
    get redisSessionDb() { return '0'; },
    get redisCacheDb() { return '1'; },
    get redisRateLimitDb() { return '2'; },
}));

process.env.REDIS_HEALTH_PROBE_TIMEOUT_MS = '80';
process.env.REDIS_HEALTH_CACHE_MS = '10000';
process.env.REDIS_URL = 'redis://:testpw@redis.internal:6379';

let redisMod;

beforeEach(() => {
    jest.resetModules();
    mockInstances.length = 0;
    process.env.REDIS_URL = 'redis://:testpw@redis.internal:6379';
    delete process.env.MOCK_REDIS_HOST;
    redisMod = require('../redis');
});

test('a constructed client is NOT ready until its PING answers PONG', async () => {
    // Fresh module: all six clients exist (lazyConnect → status 'wait').
    expect(mockInstances.length).toBe(6);
    // Make one client refuse to answer to prove PING is what decides.
    mockInstances[0].ping = jest.fn(() => Promise.resolve('NOT_PONG'));
    const result = await redisMod.probeRedisReadiness({ force: true });
    expect(result.status).toBe('degraded');
    expect(result.details.session).toBe('down');
});

test('all clients answering PING → connected with per-client ready details', async () => {
    const result = await redisMod.probeRedisReadiness({ force: true });
    expect(result.status).toBe('connected');
    expect(result.details).toEqual({
        session: 'ready', cache: 'ready', rateLimit: 'ready',
        legacy: 'ready', ssePub: 'ready', sseSub: 'ready',
    });
    expect(result.probedAt).toEqual(expect.any(String));
    // Each probe reuses existing clients: exactly one PING per client.
    for (const client of mockInstances) {
        expect(client.ping).toHaveBeenCalledTimes(1);
    }
});

test('wrong credentials (WRONGPASS) → degraded, that client down', async () => {
    mockInstances[2].ping = jest.fn(() => Promise.reject(
        new Error('WRONGPASS invalid username-password pair or user is disabled'),
    ));
    const result = await redisMod.probeRedisReadiness({ force: true });
    expect(result.status).toBe('degraded');
    expect(result.details.rateLimit).toBe('down');
    expect(result.details.session).toBe('ready');
});

test('Redis stopped/unreachable (ECONNREFUSED on every client) → degraded', async () => {
    for (const client of mockInstances) {
        client.ping = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')));
    }
    const result = await redisMod.probeRedisReadiness({ force: true });
    expect(result.status).toBe('degraded');
    expect(Object.values(result.details).every((v) => v === 'down')).toBe(true);
});

test('a hung PING is bounded by the probe timeout, not the client retries', async () => {
    mockInstances[1].ping = jest.fn(() => new Promise(() => {})); // never settles
    const started = Date.now();
    const result = await redisMod.probeRedisReadiness({ force: true });
    const elapsed = Date.now() - started;
    expect(result.details.cache).toBe('down');
    expect(result.status).toBe('degraded');
    expect(elapsed).toBeLessThan(1000); // 80ms timeout + generous CI slack
});

test('recovery is reported on the next forced probe', async () => {
    mockInstances[3].ping = jest.fn(() => Promise.reject(new Error('down')));
    const failed = await redisMod.probeRedisReadiness({ force: true });
    expect(failed.status).toBe('degraded');

    mockInstances[3].ping = jest.fn(() => Promise.resolve('PONG'));
    const recovered = await redisMod.probeRedisReadiness({ force: true });
    expect(recovered.status).toBe('connected');
    expect(recovered.details.legacy).toBe('ready');
});

test('results are cached within the window; force and reset bypass the cache', async () => {
    const first = await redisMod.probeRedisReadiness({ force: true });
    const cached = await redisMod.probeRedisReadiness();
    expect(cached).toBe(first); // identical object — no second PING storm
    const pingCallsBefore = mockInstances[0].ping.mock.calls.length;

    redisMod.resetRedisReadinessCache();
    const fresh = await redisMod.probeRedisReadiness();
    expect(fresh).not.toBe(first);
    expect(mockInstances[0].ping.mock.calls.length).toBe(pingCallsBefore + 1);
});

test('subscriber-mode command refusal falls back to connection state, not false-down', async () => {
    const sub = mockInstances[5]; // sseRedisSub
    sub.status = 'ready';
    sub.ping = jest.fn(() => Promise.reject(
        new Error('Connection in subscriber mode, only subscriber commands may be issued out-of-band.'),
    ));
    const result = await redisMod.probeRedisReadiness({ force: true });
    expect(result.details.sseSub).toBe('ready');
    expect(result.status).toBe('connected');
});

test('in-memory fallback (no real Redis configured) reports not_configured, never connected', async () => {
    jest.resetModules();
    delete process.env.REDIS_URL;
    process.env.MOCK_REDIS_HOST = 'localhost';
    const fallbackMod = require('../redis');
    const result = await fallbackMod.probeRedisReadiness({ force: true });
    expect(result.status).toBe('not_configured');
    expect(Object.values(result.details).every((v) => v === 'fallback')).toBe(true);
});
