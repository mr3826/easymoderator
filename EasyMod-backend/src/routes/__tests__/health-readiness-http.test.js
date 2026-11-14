'use strict';

/**
 * HTTP semantics of the readiness contract:
 *   - /live  — liveness only; NEVER depends on Redis or the database.
 *   - /ready — 200 only when the database authenticates AND the PING-verified
 *              Redis readiness is not degraded/disconnected. The in-memory dev
 *              fallback ('not_configured') stays ready by contract.
 *   - No error internals (messages, hosts, connection strings) leak from /ready.
 */

const express = require('express');
const request = require('supertest');

const mockSequelize = { authenticate: jest.fn() };
const mockProbe = jest.fn();

jest.mock('../../utils/database/database-setup', () => ({ sequelize: mockSequelize }));
jest.mock('../../config/redis', () => ({
    checkRedisAvailability: jest.fn(() => ({})),
    probeRedisReadiness: (...args) => mockProbe(...args),
    cacheRedis: { info: jest.fn().mockResolvedValue(''), get: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../middleware/auth.middleware', () => ({
    authenticate: jest.fn((_req, _res, next) => next()),
}));
jest.mock('../../modules/integration/meta-webhook-metrics', () => ({
    getMalformedWebhookMetrics: () => ({ count: 0, lastAt: null }),
}));
jest.mock('../../jobs/queue-manager', () => ({
    getQueueStats: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getCriticalQueueStats: jest.fn().mockResolvedValue({ messageDlq: { waiting: 0 } }),
}));
jest.mock('../../modules/rag/embedding.service', () => ({
    getProviderInfo: jest.fn(() => ({ effective: 'test', configured: false, semantic: false, keyPresent: false, vectorSize: null })),
    probe: jest.fn().mockResolvedValue({ ok: true, dimensions: null }),
}));

global.fetch = jest.fn().mockResolvedValue({ ok: false });

const healthRouter = require('../health.routes');
const app = express();
app.use('/health', healthRouter);

const readyBody = (status, details) => ({ status, details, probedAt: '2026-11-14T00:00:00.000Z' });

beforeEach(() => {
    jest.clearAllMocks();
    mockSequelize.authenticate.mockResolvedValue(undefined);
    mockProbe.mockResolvedValue(readyBody('connected', {
        session: 'ready', cache: 'ready', rateLimit: 'ready',
        legacy: 'ready', ssePub: 'ready', sseSub: 'ready',
    }));
});

test('Redis answering PING on every client: ready 200', async () => {
    const res = await request(app).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('connected');
    expect(res.body.redis).toBe('connected');
    expect(res.body.service).toBe('easymod-backend');
});

test('any Redis client failing its PING: not ready 503 (degraded)', async () => {
    mockProbe.mockResolvedValue(readyBody('degraded', {
        session: 'ready', cache: 'down', rateLimit: 'ready',
        legacy: 'idle', ssePub: 'ready', sseSub: 'ready',
    }));
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.redis).toBe('degraded');
    expect(res.body.redis_details.cache).toBe('down');
});

test('Redis probe throwing (unreachable/timeout at the transport level): 503 without internals', async () => {
    mockProbe.mockRejectedValue(new Error('connect ECONNREFUSED redis://user:secret@redis.internal:6379'));
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.status).toBe('not_ready');
    // The connection string from the thrown error must never be echoed back.
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
});

test('in-memory fallback (no real Redis configured) stays ready by contract', async () => {
    mockProbe.mockResolvedValue(readyBody('not_configured', {
        session: 'fallback', cache: 'fallback', rateLimit: 'fallback',
        legacy: 'fallback', ssePub: 'fallback', sseSub: 'fallback',
    }));
    const res = await request(app).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.redis).toBe('not_configured');
});

test('database down: 503 and Redis is not probed', async () => {
    mockSequelize.authenticate.mockRejectedValue(new Error('db gone'));
    const res = await request(app).get('/health/ready').expect(503);
    expect(res.body.database).toBe('disconnected');
    expect(res.body.status).toBe('not_ready');
    expect(mockProbe).not.toHaveBeenCalled();
});

test('Redis recovering restores readiness on the next probe', async () => {
    mockProbe.mockResolvedValueOnce(readyBody('degraded', { cache: 'down' }));
    await request(app).get('/health/ready').expect(503);
    mockProbe.mockResolvedValueOnce(readyBody('connected', { cache: 'ready' }));
    const res = await request(app).get('/health/ready').expect(200);
    expect(res.body.redis).toBe('connected');
});

test('liveness is independent of Redis and database state', async () => {
    mockSequelize.authenticate.mockRejectedValue(new Error('db gone'));
    mockProbe.mockResolvedValue(readyBody('degraded', { cache: 'down' }));
    const res = await request(app).get('/health/live').expect(200);
    expect(res.body.status).toBe('alive');
    expect(mockProbe).not.toHaveBeenCalled();
});

test('detailed health reports degraded as unhealthy 503', async () => {
    mockProbe.mockResolvedValue(readyBody('degraded', {
        session: 'ready', cache: 'down', rateLimit: 'ready',
        legacy: 'idle', ssePub: 'ready', sseSub: 'ready',
    }));
    const res = await request(app).get('/health/detailed').expect(503);
    expect(res.body.redis).toBe('degraded');
    expect(res.body.redis_details.cache).toBe('down');
});
