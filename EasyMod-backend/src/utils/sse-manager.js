'use strict';

/**
 * SSE Manager — Redis-bridged Server-Sent Events registry.
 *
 * Public interface (unchanged from v1 — all existing callers work with zero modifications):
 *   register(shopId, res)
 *   unregister(shopId, res)
 *   emit(shopId, event, data)
 *
 * New additions (do not break existing callers):
 *   attachToRequest(req, res, shopId)  — preferred for new SSE endpoint code;
 *                                        reads Last-Event-ID, replays missed events,
 *                                        then registers the connection.
 *   emitToAll(event, data)             — broadcasts to all locally-connected shops;
 *                                        retained for circuit-breaker compatibility.
 *
 * Internal behaviour:
 *   - emit() publishes to the SSE bus (Redis pub/sub). Delivery to local res
 *     objects happens via the per-shop subscription callback — never directly
 *     from emit(). This prevents double-emit in multi-process deployments.
 *   - register() subscribes this process to the Redis channel for the given shop
 *     on the first local connection. Returns a cleanup function (internal use).
 *   - unregister() removes the res from the local registry. When no local
 *     connections remain for a shop, the process unsubscribes from Redis.
 *   - Stale connection cleanup: failed res.write calls remove the connection
 *     from the local registry (identical to v1 behaviour).
 *
 * Single-instance / dev mode:
 *   When Redis is not configured (memory-fallback clients), the bus degrades to
 *   in-process EventEmitter. Local dev works without Redis.
 */

const { createLogger } = require('./structured-logger');
const SSEBus = require('./sse-bus');
const { withoutInternalMessageEvent } = require('../modules/conversation/internal-message-metadata');

const logger = createLogger('SSEManager');

// ── Singleton bus ─────────────────────────────────────────────────────────────
// Lazily initialise the bus on first use so that tests can mock redis.js
// before requiring sse-manager.
let _bus = null;
function _getBus() {
    if (!_bus) _bus = SSEBus.getBus();
    return _bus;
}

// ── Local connection registry ─────────────────────────────────────────────────
// Map<shopId, Set<res>>
// Tracks which SSE response objects are connected to THIS process.
const connections = new Map();
// Map<res, { shopId: string, userId: string }>
// Lets membership revocation close the affected user's local streams.
const connectionUsers = new Map();

// ── Per-shop subscription handlers ───────────────────────────────────────────
// Map<shopId, Function>
// The handler registered with the bus for each shop. Stored so we can
// pass the exact same reference to unsubscribe().
const shopHandlers = new Map();

// ── Helper: write a formatted SSE frame to a res object ──────────────────────

/**
 * Write one SSE frame to a response object.
 * Returns false if the write failed (stale connection).
 *
 * @param {object}  res
 * @param {number}  id
 * @param {string}  event
 * @param {object}  data
 * @returns {boolean}
 */
function _writeFrame(res, id, event, data) {
    try {
        const payload =
            `id: ${id}\n` +
            `event: ${event}\n` +
            `data: ${JSON.stringify(withoutInternalMessageEvent(event, data))}\n\n`;
        res.write(payload);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensure this process has a Redis subscription for the given shop.
 * On the first local connection for a shop, subscribes to the bus channel.
 * The subscription callback writes incoming events to all local res objects.
 *
 * @param {string} shopId
 */
async function _ensureSubscribed(shopId) {
    if (shopHandlers.has(shopId)) return; // already subscribed

    const handler = (envelope) => {
        const conns = connections.get(shopId);
        if (!conns || conns.size === 0) return;

        for (const res of conns) {
            const ok = _writeFrame(res, envelope.id, envelope.event, envelope.data);
            if (!ok) {
                // Stale connection — remove from registry
                conns.delete(res);
                connectionUsers.delete(res);
                logger.debug('SSEManager: removed stale connection', { shopId });
            }
        }

        if (conns.size === 0) {
            connections.delete(shopId);
        }
    };

    shopHandlers.set(shopId, handler);
    await _getBus().subscribe(shopId, handler);
    logger.debug('SSEManager: subscribed shop to bus', { shopId });
}

/**
 * Unsubscribe this process from the bus channel for a shop when no local
 * connections remain.
 *
 * @param {string} shopId
 */
async function _maybeUnsubscribe(shopId) {
    const conns = connections.get(shopId);
    if (conns && conns.size > 0) return; // still have local connections

    const handler = shopHandlers.get(shopId);
    if (!handler) return;

    shopHandlers.delete(shopId);
    connections.delete(shopId);
    await _getBus().unsubscribe(shopId, handler);
    logger.debug('SSEManager: unsubscribed shop from bus', { shopId });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register an SSE response object for a shop.
 *
 * On the first connection for a shop, subscribes this process to the Redis
 * channel so that events published by any backend instance are delivered to
 * local res objects via the subscription callback.
 *
 * Backwards-compatible with v1: callers need no changes.
 *
 * @param {string} shopId
 * @param {object} res    Express response in SSE mode
 * @param {string} userId optional authenticated user identity
 */
function register(shopId, res, userId) {
    if (!connections.has(shopId)) {
        connections.set(shopId, new Set());
    }
    connections.get(shopId).add(res);
    if (userId) connectionUsers.set(res, { shopId, userId });

    // Subscribe asynchronously; errors are non-fatal (dev fallback handles it)
    _ensureSubscribed(shopId).catch((err) => {
        logger.warn('SSEManager: subscribe failed', { shopId, err: err.message });
    });
}

/**
 * Remove a response from the registry.
 *
 * When the last local connection for a shop closes, this process unsubscribes
 * from the Redis channel to release the subscription.
 *
 * Backwards-compatible with v1.
 *
 * @param {string} shopId
 * @param {object} res
 */
function unregister(shopId, res) {
    connectionUsers.delete(res);
    const conns = connections.get(shopId);
    if (!conns) return;
    conns.delete(res);
    if (conns.size === 0) connections.delete(shopId);

    _maybeUnsubscribe(shopId).catch((err) => {
        logger.warn('SSEManager: unsubscribe failed', { shopId, err: err.message });
    });
}

/**
 * Close locally-connected streams for a revoked user. Other instances enforce
 * the same membership check on their next request.
 */
function disconnectUser(userId) {
    for (const [res, connection] of connectionUsers.entries()) {
        if (String(connection.userId) !== String(userId)) continue;
        try {
            res.end();
        } catch (_) {
            // The response close handler will still remove the stale stream.
        }
        unregister(connection.shopId, res);
    }
}

/**
 * Emit a named SSE event to all connections for a shop across ALL instances.
 *
 * Publishes to Redis; delivery to local res objects is via the subscription
 * callback — never via a direct write in this function. This is the critical
 * no-double-emit guarantee.
 *
 * Backwards-compatible with v1: callers need no changes.
 *
 * @param {string} shopId
 * @param {string} event   SSE event name
 * @param {object} data    JSON-serialisable payload
 */
function emit(shopId, event, data) {
    try {
        _getBus().publish(shopId, event, withoutInternalMessageEvent(event, data)).catch((err) => {
            logger.warn('SSEManager: publish failed', { shopId, event, err: err.message });
        });
    } catch (err) {
        // A missing or partially initialised Redis client must not fail the
        // database/provider operation that emitted the UI notification.
        logger.warn('SSEManager: publish initialisation failed', { shopId, event, err: err.message });
    }
}

/**
 * Preferred entry point for SSE endpoint handlers.
 *
 * Reads the Last-Event-ID header from the request, replays any missed events
 * from the Redis replay buffer (events with id > lastEventId), then registers
 * the connection normally.
 *
 * Existing callers using register() directly continue to work — they simply
 * do not get replay on reconnect. New SSE routes should switch to this.
 *
 * @param {object} req    Express request (reads req.headers['last-event-id'])
 * @param {object} res    Express response in SSE mode
 * @param {string} shopId
 * @param {string} userId authenticated user identity
 */
async function attachToRequest(req, res, shopId, userId) {
    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

    // Register first so the connection is in the registry before replay starts.
    // This ensures no events are missed during the gap between replay and live delivery.
    register(shopId, res, userId);

    if (lastEventId > 0) {
        // Send replay events for this reconnecting client only
        try {
            const replayEvents = await _getBus().getReplay(shopId, lastEventId);
            for (const ev of replayEvents) {
                const ok = _writeFrame(res, ev.id, ev.event, ev.data);
                if (!ok) {
                    // Connection already closed during replay — nothing to do
                    unregister(shopId, res);
                    return;
                }
            }
            logger.debug('SSEManager: replayed missed events', {
                shopId,
                lastEventId,
                count: replayEvents.length
            });
        } catch (err) {
            logger.warn('SSEManager: replay failed', { shopId, lastEventId, err: err.message });
        }
    }
}

/**
 * Broadcast an event to ALL locally-connected shops.
 *
 * Retained for backwards compatibility with circuit-breaker.service.js which
 * calls emitToAll('llm_outage', ...). Emits to every shop currently connected
 * to THIS process only (circuit-breaker uses it as a best-effort local alert).
 *
 * @param {string} event
 * @param {object} data
 */
function emitToAll(event, data) {
    for (const shopId of connections.keys()) {
        emit(shopId, event, data);
    }
}

/**
 * Returns the count of locally connected SSE clients across all shops.
 * Used by the /health/sse endpoint.
 *
 * @returns {number}
 */
function getLocalConnectionCount() {
    let total = 0;
    for (const conns of connections.values()) total += conns.size;
    return total;
}

/**
 * Returns the pub/sub readiness status of the underlying bus.
 * 'ready' when Redis pub/sub clients are connected, 'fallback' in dev mode.
 *
 * @returns {'ready'|'fallback'|'down'}
 */
function getPubSubStatus() {
    try {
        const bus = _getBus();
        return bus._fallback ? 'fallback' : 'ready';
    } catch {
        return 'down';
    }
}

module.exports = {
    register,
    unregister,
    disconnectUser,
    emit,
    attachToRequest,
    emitToAll,
    getLocalConnectionCount,
    getPubSubStatus
};
