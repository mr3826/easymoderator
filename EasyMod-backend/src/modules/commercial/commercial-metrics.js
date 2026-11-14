'use strict';

/**
 * In-process counters for the commercial truth gate (ADR-0011), surfaced on
 * /health/detailed next to `pilotIntelligence`. Same convention as
 * pilot-features/pilot-metrics.js: counts and a timestamp only. Counter names
 * are fixed identifiers and never carry shop, customer, phone or order data.
 */

const counters = new Map();
let lastEventAt = null;

const KNOWN = new Set([
    // Every claim decision emitted by claim-gate.service (render or lookup).
    'truth_gate.decisions',
    // Decisions that WOULD have been blocked had the surface been enforcing.
    'truth_gate.shadow_would_block',
    // Claims actually blocked (render:'none' or fallback) under enforce.
    'truth_gate.enforce_blocked',
    // Unknown claim id, surface mismatch, or an evidence resolver failure.
    // Fail-closed: an unprovable claim is never rendered as available.
    'truth_gate.lookup_failed',
]);

function increment(name, by = 1) {
    if (!KNOWN.has(name)) return;
    counters.set(name, (counters.get(name) || 0) + by);
    lastEventAt = new Date().toISOString();
}

function snapshot() {
    const out = {};
    for (const name of KNOWN) out[name] = counters.get(name) || 0;
    return { counters: out, lastEventAt };
}

function reset() {
    counters.clear();
    lastEventAt = null;
}

module.exports = { increment, snapshot, reset, KNOWN };