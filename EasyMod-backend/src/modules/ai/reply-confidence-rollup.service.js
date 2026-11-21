'use strict';

const { sequelize } = require('../../utils/database/database-setup');
const { CONFIDENCE_REASON } = require('./reply-confidence.service');
const {
    WOULD_HOLD_POLICY_VERSION,
    WOULD_HOLD_SETTINGS_SCOPE,
} = require('./confidence-gate.service');

// Operator-only: callers must authorize the shop before invoking this service.
// This query never runs in the worker, and needs no new table or data migration.
async function getReplyConfidenceRollup(shopId, hours = 24) {
    if (typeof shopId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(shopId)
        || !Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
        throw new TypeError('A shop UUID and a window of 1 to 168 hours are required');
    }
    return sequelize.transaction(async transaction => {
        await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        await sequelize.query("SET LOCAL statement_timeout = '2s'", { transaction });
        const [rows] = await sequelize.query(`
            SELECT
                t.conversation_id AS "conversationId",
                t.created_at AS "turnCreatedAt",
                m.metadata->>'confidence_scope' AS scope,
                m.metadata->'confidence_score' AS score,
                m.metadata->'confidence_reason_codes' AS reasons,
                m.metadata->'confidence_would_hold' AS "wouldHold",
                m.metadata->>'confidence_would_hold_policy_version' AS "wouldHoldPolicyVersion",
                m.metadata->>'confidence_would_hold_settings_scope' AS "wouldHoldSettingsScope",
                m.metadata->'confidence_components'->>'knowledgeOutcome' AS retrieval,
                m.metadata->'confidence_compute_ms' AS "computeMs"
            FROM conversation_turns t
            JOIN conversations c ON c.id = t.conversation_id AND c.shop_id = t.shop_id
            LEFT JOIN LATERAL (
                SELECT metadata, delivery_state FROM messages
                WHERE conversation_id = t.conversation_id AND sender = 'ai'
                  AND metadata->>'confidence_turn_id' = t.turn_id
                  AND metadata->>'confidence_mode' = 'shadow'
                  AND delivery_source IS DISTINCT FROM 'DRAFT_APPROVAL'
                  AND ((metadata->>'confidence_scope' = 'delivered' AND delivery_state IN ('SENT', 'DELIVERED'))
                    OR (metadata->>'confidence_scope' = 'suggestion' AND delivery_state NOT IN ('SENT', 'DELIVERED')))
                ORDER BY (metadata->>'confidence_scope' = 'delivered' AND delivery_state IN ('SENT', 'DELIVERED')) DESC NULLS LAST,
                    created_at DESC, id DESC
                LIMIT 1
            ) m ON TRUE
            WHERE t.shop_id = $shopId AND t.created_at >= NOW() - ($hours::int * INTERVAL '1 hour')
            ORDER BY t.created_at DESC, t.id DESC LIMIT 5001
        `, { transaction, bind: { shopId, hours } });
        const allowed = new Set(Object.values(CONFIDENCE_REASON));
        const report = {
            hours, turns: Math.min(rows.length, 5000), truncated: rows.length > 5000,
            missing: 0, suggestion: 0, delivered: 0, unscored: 0,
            wouldHold: 0, wouldHoldCovered: 0, wouldHoldUnknown: 0,
            scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 0, threeQuartersOrAbove: 0 },
            reasons: {}, retrieval: {}, retrievalCovered: 0, retrievalUnknown: 0, computeP95Ms: null,
            // WP-03 observation denominators (additive). "Eligible scored" = an
            // eligible scope (suggestion|delivered) AND a finite score in [0,1].
            // conversations/firstEligibleObservedAt aggregate over ELIGIBLE
            // SCORED rows only, inside the same 5000-row slice as every other
            // counter, so truncation semantics are identical: both are lower
            // bounds when truncated (rows beyond the cap are not seen).
            conversations: 0, firstEligibleObservedAt: null,
            scored: 0, eligible: 0, ineligible: 0,
        };
        const retrievalOutcomes = new Set(['FOUND', 'FAILED', 'TIMEOUT', 'NOT_REQUESTED',
            'EMPTY_RESULT', 'NO_MATCHES', 'NO_VALID_RESULTS', 'NO_KNOWLEDGE_EVIDENCE', 'UNKNOWN']);
        const compute = [];
        // Distinct conversation ids and the earliest observation time among
        // eligible scored rows. JS-side only: no extra query, no extra scan.
        const eligibleConversationIds = new Set();
        let firstEligibleObservedAtMs = null;
        for (const row of rows.slice(0, 5000)) {
            if (row.wouldHoldPolicyVersion === WOULD_HOLD_POLICY_VERSION
                && row.wouldHoldSettingsScope === WOULD_HOLD_SETTINGS_SCOPE
                && typeof row.wouldHold === 'boolean') {
                report.wouldHoldCovered++;
                if (row.wouldHold) report.wouldHold++;
            } else {
                report.wouldHoldUnknown++;
            }
            if (row.scope !== 'suggestion' && row.scope !== 'delivered') {
                report.missing++;
                report.retrievalUnknown++;
                continue;
            }
            report[row.scope]++;
            if (Number.isFinite(row.score) && row.score >= 0 && row.score <= 1) {
                report.scoreBuckets[row.score < 0.5 ? 'belowHalf'
                    : row.score < 0.75 ? 'halfToBelowThreeQuarters' : 'threeQuartersOrAbove']++;
                // Eligible scored row: contributes its conversation identity and
                // observation time. Both come from the turn spine (t), never
                // from message content, so this stays zero-PII aggregate data.
                if (typeof row.conversationId === 'string' && row.conversationId) {
                    eligibleConversationIds.add(row.conversationId);
                }
                const turnMs = row.turnCreatedAt ? new Date(row.turnCreatedAt).getTime() : NaN;
                if (Number.isFinite(turnMs) && (firstEligibleObservedAtMs === null || turnMs < firstEligibleObservedAtMs)) {
                    firstEligibleObservedAtMs = turnMs;
                }
            } else {
                report.unscored++;
            }
            if (retrievalOutcomes.has(row.retrieval)) {
                report.retrieval[row.retrieval] = (report.retrieval[row.retrieval] || 0) + 1;
                if (row.retrieval === 'UNKNOWN') report.retrievalUnknown++;
                else report.retrievalCovered++;
            } else {
                report.retrievalUnknown++;
            }
            if (Number.isSafeInteger(row.computeMs) && row.computeMs >= 0) compute.push(row.computeMs);
            for (const code of new Set(Array.isArray(row.reasons) ? row.reasons : [])) {
                if (allowed.has(code)) report.reasons[code] = (report.reasons[code] || 0) + 1;
            }
        }
        compute.sort((a, b) => a - b);
        report.computeP95Ms = compute[Math.ceil(compute.length * 0.95) - 1] ?? null;
        // Explicit observation denominators (WP-03 contract):
        //   scored    = eligible-scope rows carrying a finite [0,1] score
        //   unscored  = eligible-scope rows without one (already counted above)
        //   eligible  = rows the qualification counts may draw on (== scored)
        //   ineligible= rows that can never qualify a window (no observation,
        //               or an observation without a usable score)
        report.conversations = eligibleConversationIds.size;
        report.firstEligibleObservedAt = firstEligibleObservedAtMs === null
            ? null : new Date(firstEligibleObservedAtMs).toISOString();
        report.scored = report.suggestion + report.delivered - report.unscored;
        report.eligible = report.scored;
        report.ineligible = report.missing + report.unscored;
        return report;
    });
}

module.exports = { getReplyConfidenceRollup };
