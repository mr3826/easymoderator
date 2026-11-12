'use strict';

/**
 * In-process counters for the pilot intelligence features, surfaced on
 * /health/detailed under `pilotIntelligence`. Same convention as
 * integration/meta-webhook-metrics.js: counts and timestamps only — names are
 * fixed identifiers and never carry shop, customer, phone or message data.
 */

const counters = new Map();
let lastEventAt = null;

const KNOWN = new Set([
    'opportunity.created',
    'opportunity.updated',
    'opportunity.converted',
    'opportunity.expired',
    'opportunity.dismissed',
    'opportunity.actioned',
    'opportunity.detector_run',
    'opportunity.detector_shop_failed',
    'opportunity.detector_lock_skipped',
    'opportunity.conversion_hook_failed',
    'customer.phone_match_ambiguous',
    'order_confidence.evaluated.READY',
    'order_confidence.evaluated.VERIFY',
    'order_confidence.evaluated.MANUAL_REVIEW',
    'order_confidence.gate_allowed',
    'order_confidence.gate_held',
    'order_confidence.shadow_would_hold',
    'order_confidence.committed_reconcile_allowed',
    'order_confidence.verified',
    'order_confidence.approved',
    'order_confidence.resolution_stale',
    'order_confidence.cas_conflict',
    'order_confidence.engine_failure',
    'order_confidence.input_unavailable',
    'order_confidence.outcome_recorded',
    'order_confidence.outcome_hook_failed',
    'pilot_features.lookup_failed',
    'interaction.generated',
    'interaction.rejected',
    'interaction.consumed',
    'interaction.dispatch_failed',
    'gap_suggestion.generated',
    'gap_suggestion.published',
    'gap_suggestion.dismissed',
    // Shadow-mode count of bookings whose destination the provider directory
    // could not serve. Counter names never carry shop/provider data.
    'courier.serviceability.not_serviceable_shadow',
    // Enforcement-mode count of the same verdict when policy blocking is on.
    'courier.serviceability.not_serviceable_blocked',
    // Payload-validity count: bookings stopped before the provider call because
    // the destination was not addressable at all (never shadowed — D5-1).
    'courier.serviceability.destination_payload_invalid',
    // Shadow-mode count of the distinct case where the directory CONTRADICTED
    // a recorded destination. Reported separately so an operator can tell
    // "never recorded" from "recorded and contradicted" (review R-1).
    'courier.serviceability.not_serviceable_contradicted',
    // Merchant-confirmed destination selections, per outcome.
    'courier.destination.confirmed',
    'courier.destination.confirmation_rejected',
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
