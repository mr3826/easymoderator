'use strict';

/**
 * RTO Shield v2 / Order Confidence service.
 *
 * - gatherFacts: tenant-scoped inputs (own order history, the existing RTO
 *   Shield check under the shop's network setting, duplicate orders).
 * - evaluateAndPersist: deterministic evaluation, persisted with a
 *   compare-and-set on `version` (ADR-0010); a losing writer re-reads the
 *   winner instead of overwriting it.
 * - checkBookingGate: called from orderService.bookForOrder BEFORE the courier
 *   dispatch claim (ADR-0007). It never books and never replaces the claim.
 * - verify / approve: audited merchant resolution bound to the order's
 *   material-fact fingerprint.
 * - recordOutcome: idempotent delivery-outcome ground truth.
 */

const { Op } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');
const metrics = require('../pilot-features/pilot-metrics');
const rules = require('./order-confidence.rules');
const {
    classifyOrderOutcome, normalizeBdMobile, phoneVariants, OUTCOMES,
} = require('../customer-intelligence/order-outcome');
const { ORDER_FACT_ATTRIBUTES, toOrderFact } = require('../customer-intelligence/customer-orders');

const logger = createLogger('OrderConfidence');

const MAX_HISTORY_ENTRIES = 30;
const HISTORY_LOOKUP_LIMIT = 500;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const VERIFY_METHODS = Object.freeze(['PHONE_CALL', 'CHAT', 'IN_PERSON', 'OTHER']);
const HOLD_STATUS = 'confidence_hold';

const entities = () => require('../entities');
const plain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);
const reasonCodes = (reasons = []) => reasons.map((r) => r.code);

// JSONB does not preserve object key order (it sorts keys), so a persisted
// reason compared with JSON.stringify would look "changed" on every read and
// bump the version forever. Compare a key-sorted canonical form instead.
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => ({ ...out, [key]: canonical(value[key]) }), {});
    }
    return value;
};
const reasonsKey = (reasons = []) => JSON.stringify(canonical(reasons.map((r) => [r.code, r.severity, r.evidence || {}])));
const COD_METHODS = new Set(['cod', 'cash', 'cash_on_delivery']);
const isCodOrder = (order) => COD_METHODS.has(
    String(order?.payment_method || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
);
const hasMandatoryRtoReview = (row) => Array.isArray(row?.reasons) && row.reasons.some((reason) => (
    reason.source === 'RTO_SHIELD' && ['RTO_SHIELD_BLOCK', 'RTO_SHIELD_VERIFY'].includes(reason.code)
));
// What a merchant's decision is about: which reasons apply, not their exact
// numbers. Evidence alone (e.g. a network count moving because another shop
// recorded a delivery) must not invalidate an approval in progress.
const materialReasonsKey = (reasons = []) => JSON.stringify(reasons.map((r) => `${r.code}:${r.severity}`).sort());

function appendHistory(history, entry) {
    return [...(Array.isArray(history) ? history : []), { at: new Date().toISOString(), ...entry }]
        .slice(-MAX_HISTORY_ENTRIES);
}

// ── Facts ───────────────────────────────────────────────────────────────────

async function loadHistory(order, shopId) {
    const { Order } = entities();
    const normalized = normalizeBdMobile(order.customer_phone);
    const or = [];
    if (order.customer_id) or.push({ customer_id: order.customer_id });
    if (normalized) or.push({ customer_phone: { [Op.in]: phoneVariants(normalized) } });
    if (!or.length) return { history: { delivered: 0, returned: 0, cancelled: 0, total: 0 }, recentActiveOrders: [] };

    const rows = await Order.findAll({
        where: { shop_id: shopId, id: { [Op.ne]: order.id }, [Op.or]: or },
        attributes: ORDER_FACT_ATTRIBUTES,
        order: [['created_at', 'DESC']],
        limit: HISTORY_LOOKUP_LIMIT,
    });
    const history = { delivered: 0, returned: 0, cancelled: 0, total: 0 };
    const recentActiveOrders = [];
    const orderCreatedMs = new Date(order.created_at || order.createdAt || Date.now()).getTime();
    for (const row of rows) {
        const fact = toOrderFact(row);
        const outcome = classifyOrderOutcome(fact);
        history.total += 1;
        if (outcome === OUTCOMES.DELIVERED) history.delivered += 1;
        else if (outcome === OUTCOMES.RETURNED) history.returned += 1;
        else if (outcome === OUTCOMES.CANCELLED) history.cancelled += 1;
        else if (Math.abs(new Date(fact.created_at).getTime() - orderCreatedMs) <= DUPLICATE_WINDOW_MS
            && normalized && normalizeBdMobile(fact.customer_phone) === normalized) {
            recentActiveOrders.push({ id: fact.id, order_number: fact.order_number });
        }
    }
    return { history, recentActiveOrders };
}

async function loadRtoShield(order, shopId) {
    const normalized = normalizeBdMobile(order.customer_phone);
    if (!normalized) return undefined; // PHONE_INVALID covers it; nothing to check
    const RtoShieldService = require('../rto-shield/rto-shield.service');
    const { getNetworkSettings } = require('../rto-shield/rto-network-settings');
    const { enforce } = await getNetworkSettings(shopId);
    return RtoShieldService.checkPhone(normalized, shopId, {
        trustedContext: true,
        enforceNetwork: enforce !== false,
    });
}

/**
 * Inputs for one order. A failing input is reported as `null`, which the
 * rules turn into INPUT_UNAVAILABLE (fail closed to verification), never
 * silently into a READY decision.
 */
async function gatherFacts(order, shopId, options = {}) {
    let history = null;
    let recentActiveOrders = [];
    let rtoShield = null;
    try {
        ({ history, recentActiveOrders } = await loadHistory(order, shopId));
    } catch (_) {
        metrics.increment('order_confidence.input_unavailable');
        logger.warn('order_confidence.history_unavailable', {
            shopId, orderId: order.id, code: 'ORDER_CONFIDENCE_HISTORY_UNAVAILABLE',
        });
    }
    try {
        rtoShield = Object.prototype.hasOwnProperty.call(options, 'rtoShieldOverride')
            ? options.rtoShieldOverride
            : await loadRtoShield(order, shopId);
    } catch (_) {
        metrics.increment('order_confidence.input_unavailable');
        logger.warn('order_confidence.rto_shield_unavailable', {
            shopId, orderId: order.id, code: 'ORDER_CONFIDENCE_RTO_SHIELD_UNAVAILABLE',
        });
        rtoShield = null;
    }
    return { order, history, recentActiveOrders, rtoShield };
}

// ── Persistence (compare-and-set on version) ────────────────────────────────

async function findRow(orderId, shopId, options = {}) {
    return entities().OrderConfidence.findOne({ where: { order_id: orderId, shop_id: shopId }, ...options });
}

/**
 * Compare-and-set on `version`. Decision, reason, fingerprint and resolution
 * changes bump the version (a merchant approving version N must still be
 * looking at version N). Gate bookkeeping passes bump=false: it is still
 * guarded by the version, so it can never overwrite a newer decision, but an
 * automatic booking retry does not invalidate an approval in progress.
 */
async function casUpdate(row, values, { transaction = null, bump = true } = {}) {
    const [updated] = await entities().OrderConfidence.update(
        bump ? { ...values, version: row.version + 1 } : values,
        { where: { id: row.id, version: row.version }, ...(transaction ? { transaction } : {}) },
    );
    if (!updated) metrics.increment('order_confidence.cas_conflict');
    return updated > 0;
}

async function auditSystemChange(order, shopId, previous, next) {
    try {
        const auditService = require('../audit/audit.service');
        await auditService.logOperation({
            userId: null,
            shopId,
            action: previous ? 'ORDER_CONFIDENCE_CHANGED' : 'ORDER_CONFIDENCE_EVALUATED',
            resourceType: 'ORDER',
            resourceId: order.id,
            oldValues: previous ? { decision: previous.decision, reasons: reasonCodes(previous.reasons) } : null,
            newValues: { decision: next.decision, reasons: reasonCodes(next.reasons) },
            metadata: { rules_version: next.rules_version, mode: next.mode },
        });
    } catch (_) { /* audit failure must not block evaluation; logOperation already logs */ }
}

/**
 * Evaluate from current facts and persist. Returns the persisted row (the
 * winner's row when this caller loses a concurrent write).
 */
async function evaluateAndPersist(order, shopId, options = {}) {
    const { mode, config, rtoShieldOverride } = options;
    const { OrderConfidence } = entities();
    const started = Date.now();
    const facts = await gatherFacts(
        order,
        shopId,
        Object.prototype.hasOwnProperty.call(options, 'rtoShieldOverride') ? { rtoShieldOverride } : {},
    );
    const result = rules.evaluate(facts, config);
    const inputFingerprint = rules.fingerprint(order);
    metrics.increment(`order_confidence.evaluated.${result.decision}`);

    const base = {
        decision: result.decision,
        reasons: result.reasons,
        rules_version: result.rules_version,
        input_fingerprint: inputFingerprint,
        evaluated_at: new Date(),
        mode,
        customer_id: order.customer_id || null,
    };

    let row = await findRow(order.id, shopId);
    if (!row) {
        try {
            row = await OrderConfidence.create({
                shop_id: shopId,
                order_id: order.id,
                ...base,
                history: appendHistory([], {
                    event: 'EVALUATED', decision: result.decision, reasons: reasonCodes(result.reasons), actor: null,
                }),
            });
            if (result.decision !== rules.DECISIONS.READY) await auditSystemChange(order, shopId, null, base);
        } catch (error) {
            if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
            row = await findRow(order.id, shopId); // a concurrent evaluator won the insert
        }
    } else {
        const materialChange = row.decision !== base.decision
            || row.input_fingerprint !== base.input_fingerprint
            || row.rules_version !== base.rules_version
            || materialReasonsKey(row.reasons) !== materialReasonsKey(base.reasons);
        const refreshOnly = !materialChange
            && (row.mode !== base.mode || reasonsKey(row.reasons) !== reasonsKey(base.reasons));
        if (refreshOnly) {
            // Same decision and reasons; newer evidence or mode. Version-guarded,
            // not version-bumping (see casUpdate).
            await casUpdate(row, {
                reasons: base.reasons, evaluated_at: base.evaluated_at, mode: base.mode,
            }, { bump: false });
            row = await findRow(order.id, shopId);
        } else if (materialChange) {
            const staleResolution = Boolean(row.resolution) && row.resolution_fingerprint !== base.input_fingerprint;
            const history = appendHistory(row.history, {
                event: staleResolution ? 'RESOLUTION_STALE' : 'CHANGED',
                from: row.decision,
                decision: base.decision,
                reasons: reasonCodes(base.reasons),
                actor: null,
            });
            if (staleResolution) metrics.increment('order_confidence.resolution_stale');
            const wrote = await casUpdate(row, { ...base, history });
            if (wrote && row.decision !== base.decision) await auditSystemChange(order, shopId, row, base);
            row = await findRow(order.id, shopId);
        }
    }
    logger.info('order_confidence.evaluated', {
        shopId,
        orderId: order.id,
        decision: result.decision,
        reasons: reasonCodes(result.reasons),
        latencyMs: Date.now() - started,
    });
    return { row, result, inputFingerprint };
}

// ── Booking gate ────────────────────────────────────────────────────────────

const hasBlock = (reasons = []) => reasons.some((r) => r.severity === rules.SEVERITY.BLOCK);

async function recordGate(initialRow, gateResult, { released = false } = {}) {
    let row = initialRow;
    for (let attempt = 0; row && attempt < 2; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await writeGate(row, gateResult, released)) return;
        // eslint-disable-next-line no-await-in-loop
        row = await findRow(row.order_id, row.shop_id);
    }
}

async function writeGate(row, gateResult, released) {
    const values = {
        last_gate_result: gateResult,
        last_gate_at: new Date(),
        history: appendHistory(row.history, {
            event: gateResult === 'HELD' ? 'HELD' : gateResult === 'ALLOWED' ? 'RELEASED' : gateResult,
            decision: row.decision,
            resolution: row.resolution || null,
            actor: null,
        }),
    };
    if (gateResult === 'HELD') values.held_count = (row.held_count || 0) + 1;
    if (released) {
        values.released_at = new Date();
        values.released_decision = {
            decision: row.decision,
            reasons: reasonCodes(row.reasons),
            resolution: row.resolution || null,
            rules_version: row.rules_version,
            version: row.version,
        };
    }
    // Advisory bookkeeping: version-guarded, never version-bumping.
    return casUpdate(row, values, { bump: false }).catch(() => false);
}

/**
 * @param {object} order   the order the caller is about to book (in-memory)
 * @param {string} shopId
 * @returns {Promise<{allowed:boolean, mode:string, decision?:string, reasons?:Array, decisionVersion?:number}>}
 */
async function checkBookingGate(order, shopId, { trigger = 'AUTO' } = {}) {
    const { getPilotFeatures } = require('../pilot-features/pilot-features.service');
    const features = await getPilotFeatures(shopId);
    let mode = features.orderConfidenceMode;
    let rtoShieldOverride;
    let hasRtoShieldOverride = false;
    if ((mode === 'off' || mode === 'shadow') && isCodOrder(order)) {
        try {
            rtoShieldOverride = await loadRtoShield(order, shopId);
            hasRtoShieldOverride = true;
        } catch (_) {
            // A failed safety lookup must not silently allow a COD courier mutation.
            mode = 'enforce';
            rtoShieldOverride = null;
            hasRtoShieldOverride = true;
        }
        if (['block', 'verify'].includes(rtoShieldOverride?.tier)) mode = 'enforce';
    }
    if (mode === 'off') return { allowed: true, mode };

    try {
        const { Order } = entities();
        const fresh = await Order.findOne({ where: { id: order.id, shop_id: shopId } });
        if (!fresh) throw new AppError('Order not found', 404, 'NOT_FOUND');

        const { row, inputFingerprint } = await evaluateAndPersist(fresh, shopId, {
            mode,
            config: features.orderConfidenceConfig,
            ...(hasRtoShieldOverride ? { rtoShieldOverride } : {}),
        });
        const effective = rules.effectiveState(row, { currentFingerprint: inputFingerprint });
        const bookable = !hasBlock(row.reasons);
        // The caller builds the courier payload from its in-memory copy. If that
        // copy no longer matches the stored order, the decision was not about
        // what would be shipped.
        const snapshotStale = rules.fingerprint(order) !== inputFingerprint;
        const wouldHold = !bookable || effective.state !== rules.DECISIONS.READY || snapshotStale;
        const outcome = {
            mode,
            trigger,
            decision: row.decision,
            effectiveState: effective.state,
            resolved: effective.resolved,
            resolutionStale: effective.stale,
            bookable,
            snapshotStale,
            reasons: row.reasons,
            decisionVersion: row.version,
        };

        if (mode === 'shadow') {
            if (wouldHold) metrics.increment('order_confidence.shadow_would_hold');
            await recordGate(row, wouldHold ? 'SHADOW_WOULD_HOLD' : 'ALLOWED', { released: true });
            return { ...outcome, allowed: true, wouldHold };
        }
        if (wouldHold) {
            metrics.increment('order_confidence.gate_held');
            await recordGate(row, 'HELD');
            logger.info('order_confidence.gate_held', {
                shopId, orderId: order.id, trigger, decision: row.decision, reasons: reasonCodes(row.reasons),
            });
            return { ...outcome, allowed: false };
        }
        metrics.increment('order_confidence.gate_allowed');
        await recordGate(row, 'ALLOWED', { released: true });
        return { ...outcome, allowed: true };
    } catch (_) {
        metrics.increment('order_confidence.engine_failure');
        logger.error('order_confidence.engine_failure', {
            shopId, orderId: order?.id, code: 'ORDER_CONFIDENCE_ENGINE_FAILURE',
        });
        if (mode === 'shadow') return { allowed: true, mode, engineFailure: true };
        return {
            allowed: false,
            mode,
            trigger,
            engineFailure: true,
            decision: null,
            reasons: [{ code: 'ENGINE_UNAVAILABLE', severity: rules.SEVERITY.VERIFY, source: 'SYSTEM', evidence: {} }],
        };
    }
}

// ── Merchant resolution ─────────────────────────────────────────────────────

const OWNER_OR_ADMIN = new Set(['owner', 'admin']);

async function loadForResolution(shopId, orderId) {
    const { getPilotFeatures } = require('../pilot-features/pilot-features.service');
    const features = await getPilotFeatures(shopId);
    const order = await entities().Order.findOne({ where: { id: orderId, shop_id: shopId } });
    if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
    const existing = await findRow(order.id, shopId);
    const mandatoryRtoReview = existing?.mode === 'enforce' && hasMandatoryRtoReview(existing);
    if (features.orderConfidenceMode === 'off' && !mandatoryRtoReview) {
        throw new AppError('Order confidence is not enabled for this shop', 409, 'FEATURE_DISABLED');
    }
    const mode = mandatoryRtoReview ? 'enforce' : features.orderConfidenceMode;
    const evaluated = await evaluateAndPersist(order, shopId, {
        mode,
        config: features.orderConfidenceConfig,
    });
    return { order, features: { ...features, orderConfidenceMode: mode }, ...evaluated };
}

function conflict(message, code, row, inputFingerprint) {
    const error = new AppError(message, 409, code);
    error.details = { decision: serializeDecision(row, { currentFingerprint: inputFingerprint }) };
    return error;
}

async function resolve(shopId, orderId, {
    userId, role, decisionVersion, method = null, note = null, kind,
}) {
    const { order, row, inputFingerprint } = await loadForResolution(shopId, orderId);

    if (Number(decisionVersion) !== row.version) {
        throw conflict('The order decision changed since it was reviewed. Review it again.', 'DECISION_CHANGED', row, inputFingerprint);
    }
    if (hasBlock(row.reasons)) {
        throw conflict('This order is cancelled and cannot be booked.', 'ORDER_NOT_BOOKABLE', row, inputFingerprint);
    }
    if (row.decision === rules.DECISIONS.READY) {
        throw conflict('This order does not need verification.', 'NO_RESOLUTION_REQUIRED', row, inputFingerprint);
    }
    if (kind === 'VERIFIED' && row.decision === rules.DECISIONS.MANUAL_REVIEW) {
        throw conflict('This order needs an owner or admin approval, not a verification.', 'APPROVAL_REQUIRED', row, inputFingerprint);
    }
    if (kind === 'APPROVED' && !OWNER_OR_ADMIN.has(role)) {
        throw new AppError('Only shop owners or admins can approve an order for booking', 403, 'FORBIDDEN');
    }

    const level = kind === 'APPROVED' ? rules.DECISIONS.MANUAL_REVIEW : rules.DECISIONS.VERIFY;
    const now = new Date();
    const values = {
        resolution: kind,
        resolution_level: level,
        resolution_fingerprint: inputFingerprint,
        resolution_method: method,
        resolution_note: note ? String(note).slice(0, 500) : null,
        resolved_by: userId,
        resolved_at: now,
        history: appendHistory(row.history, {
            event: kind, decision: row.decision, reasons: reasonCodes(row.reasons), actor: userId, method,
        }),
    };

    await sequelize.transaction(async (transaction) => {
        const wrote = await casUpdate(row, values, { transaction });
        if (!wrote) {
            throw conflict('The order decision changed while saving. Review it again.', 'DECISION_CHANGED', row, inputFingerprint);
        }
        const auditService = require('../audit/audit.service');
        await auditService.logOperation({
            userId,
            shopId,
            action: kind === 'APPROVED' ? 'ORDER_CONFIDENCE_APPROVED' : 'ORDER_CONFIDENCE_VERIFIED',
            resourceType: 'ORDER',
            resourceId: order.id,
            oldValues: { decision: row.decision, reasons: reasonCodes(row.reasons), version: row.version },
            newValues: {
                resolution: kind,
                resolution_level: level,
                method,
                note: values.resolution_note,
                fingerprint: inputFingerprint,
                version: row.version + 1,
            },
            metadata: { role, rules_version: row.rules_version },
        }, { transaction, required: true });
    });

    // Clear the operational hold marker so the order list no longer shows it held.
    await entities().Order.update(
        { delivery_status: null },
        { where: { id: order.id, shop_id: shopId, delivery_status: HOLD_STATUS } },
    ).catch(() => {});

    metrics.increment(kind === 'APPROVED' ? 'order_confidence.approved' : 'order_confidence.verified');
    logger.info(`order_confidence.${kind.toLowerCase()}`, { shopId, orderId: order.id, decision: row.decision, role });
    const updated = await findRow(order.id, shopId);
    return serializeDecision(updated, { currentFingerprint: inputFingerprint });
}

const verify = (shopId, orderId, input) => {
    if (input.method && !VERIFY_METHODS.includes(input.method)) {
        throw new AppError('Invalid verification method', 400, 'VALIDATION_ERROR');
    }
    return resolve(shopId, orderId, { ...input, kind: 'VERIFIED' });
};

const approve = (shopId, orderId, input) => resolve(shopId, orderId, { ...input, kind: 'APPROVED' });

async function getDecision(shopId, orderId) {
    const { getPilotFeatures } = require('../pilot-features/pilot-features.service');
    const features = await getPilotFeatures(shopId);
    if (features.orderConfidenceMode === 'off') {
        const order = await entities().Order.findOne({ where: { id: orderId, shop_id: shopId } });
        if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
        const existing = await findRow(orderId, shopId);
        if (existing?.mode !== 'enforce' || !hasMandatoryRtoReview(existing)) {
            return { order_id: orderId, mode: 'off', decision: null };
        }
        const evaluated = await evaluateAndPersist(order, shopId, {
            mode: 'enforce',
            config: features.orderConfidenceConfig,
        });
        return serializeDecision(evaluated.row, { currentFingerprint: evaluated.inputFingerprint, mode: 'enforce' });
    }
    const { row, inputFingerprint, features: resolutionFeatures } = await loadForResolution(shopId, orderId);
    return serializeDecision(row, { currentFingerprint: inputFingerprint, mode: resolutionFeatures.orderConfidenceMode });
}

// ── Outcome feedback ────────────────────────────────────────────────────────

/**
 * Record the delivery ground truth once. First terminal outcome wins, so a
 * duplicate or out-of-order courier webhook cannot rewrite it.
 */
async function recordOutcome(order) {
    try {
        if (!order?.id || !order?.shop_id) return false;
        const outcome = classifyOrderOutcome(order);
        if (outcome !== OUTCOMES.DELIVERED && outcome !== OUTCOMES.RETURNED) return false;
        const [updated] = await entities().OrderConfidence.update({
            outcome,
            outcome_at: new Date(),
            version: sequelize.literal('version + 1'),
        }, {
            where: { order_id: order.id, shop_id: order.shop_id, outcome: null },
        });
        if (updated) {
            metrics.increment('order_confidence.outcome_recorded');
            logger.info('order_confidence.outcome_recorded', { shopId: order.shop_id, orderId: order.id, outcome });
        }
        return updated > 0;
    } catch (_) {
        metrics.increment('order_confidence.outcome_hook_failed');
        logger.warn('order_confidence.outcome_hook_failed', {
            shopId: order?.shop_id, orderId: order?.id, code: 'ORDER_CONFIDENCE_OUTCOME_HOOK_FAILED',
        });
        return false;
    }
}

// ── Read models ─────────────────────────────────────────────────────────────

function requiredAction(row, effective) {
    if (hasBlock(row.reasons)) return 'NOT_BOOKABLE';
    if (effective.state === rules.DECISIONS.READY) return 'NONE';
    return row.decision === rules.DECISIONS.MANUAL_REVIEW ? 'APPROVE' : 'VERIFY';
}

function serializeDecision(rowInput, { currentFingerprint, mode } = {}) {
    const row = plain(rowInput);
    if (!row) return null;
    const effective = rules.effectiveState(row, { currentFingerprint });
    return {
        order_id: row.order_id,
        mode: mode || row.mode,
        decision: row.decision,
        effective_state: effective.state,
        bookable: !hasBlock(row.reasons),
        required_action: requiredAction(row, effective),
        reasons: row.reasons || [],
        rules_version: row.rules_version,
        evaluated_at: row.evaluated_at,
        decision_version: row.version,
        resolution: row.resolution ? {
            type: row.resolution,
            level: row.resolution_level,
            method: row.resolution_method,
            note: row.resolution_note,
            resolved_by: row.resolved_by,
            resolved_at: row.resolved_at,
            applies: effective.resolved,
            stale: effective.stale,
        } : null,
        gate: {
            last_result: row.last_gate_result,
            last_at: row.last_gate_at,
            held_count: row.held_count || 0,
        },
        released_at: row.released_at,
        outcome: row.outcome,
        outcome_at: row.outcome_at,
        history: (row.history || []).slice(-20),
    };
}

async function summary(shopId, { days = 30 } = {}) {
    const { OrderConfidence } = entities();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await OrderConfidence.findAll({
        where: { shop_id: shopId, created_at: { [Op.gte]: since } },
        attributes: ['decision', 'resolution', 'last_gate_result', 'held_count', 'released_decision', 'outcome'],
        limit: 20000,
    });
    const byDecision = { READY: 0, VERIFY: 0, MANUAL_REVIEW: 0 };
    const outcomes = {};
    let held = 0;
    let verified = 0;
    let approved = 0;
    let shadowWouldHold = 0;
    for (const row of rows) {
        byDecision[row.decision] = (byDecision[row.decision] || 0) + 1;
        if ((row.held_count || 0) > 0) held += 1;
        if (row.resolution === 'VERIFIED') verified += 1;
        if (row.resolution === 'APPROVED') approved += 1;
        if (row.last_gate_result === 'SHADOW_WOULD_HOLD') shadowWouldHold += 1;
        if (row.outcome) {
            const releasedAs = row.released_decision?.resolution
                ? `${row.released_decision.decision}+${row.released_decision.resolution}`
                : (row.released_decision?.decision || row.decision);
            outcomes[releasedAs] = outcomes[releasedAs] || { DELIVERED: 0, RETURNED: 0 };
            outcomes[releasedAs][row.outcome] = (outcomes[releasedAs][row.outcome] || 0) + 1;
        }
    }
    return {
        window_days: days,
        evaluated_orders: rows.length,
        by_decision: byDecision,
        held_orders: held,
        shadow_would_hold: shadowWouldHold,
        verified,
        approved,
        outcomes_by_released_decision: outcomes,
    };
}

module.exports = {
    HOLD_STATUS,
    VERIFY_METHODS,
    gatherFacts,
    evaluateAndPersist,
    checkBookingGate,
    verify,
    approve,
    getDecision,
    recordOutcome,
    serializeDecision,
    summary,
};
