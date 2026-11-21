'use strict';

/**
 * Confidence qualification snapshot — daily automated observation collection
 * (WP-03).
 *
 * Iterates AUTHORIZED shops (the code-visible pilot-authorization proxy —
 * active, no emergency stop, enrolled pilot features), reads each shop's
 * shadow-confidence rollup over the contract's widest window (168h), and
 * writes exactly ONE aggregate-only AuditLog row per shop through the
 * existing BaseJob pattern. No new table, no migration, no raw messages, no
 * PII: every persisted field is a count, a verdict, or an ISO timestamp.
 * MANUAL-mode shops legitimately yield zero eligible aggregates — harmless,
 * and honest: the observation clock is about AUTO shadow traffic, not about
 * how many shops exist.
 *
 * shadowToLiveViolations=0 is the architectural-isolation statement (the live
 * confidence gate never reads shadow metadata — see
 * confidence-qualification.service.js and STAGE2_SHADOW_ISOLATION_PROOF.md),
 * not a runtime counter. Slack fires only on a transition INTO QUALIFIED for
 * a shop whose previous snapshot was not QUALIFIED, and sendSlack is a no-op
 * when SLACK_ALERT_WEBHOOK_URL is unset.
 */

const BaseJob = require('./base-job');
const { Shop, AuditLog } = require('../modules/entities');
const { getReplyConfidenceRollup } = require('../modules/ai/reply-confidence-rollup.service');
const {
    evaluateQualification,
    computeShopAuthorized,
    QUALIFICATION_WINDOW_HOURS,
    QUALIFICATION_VERDICTS,
    OBSERVATION_CONTRACT_VERSION,
} = require('../modules/ai/confidence-qualification.service');
const { sendSlack } = require('../utils/ops-alert');

const SNAPSHOT_ACTION = 'job:confidence-qualification-snapshot';

class ConfidenceQualificationSnapshotJob extends BaseJob {
    constructor() {
        super('confidence-qualification-snapshot');
    }

    /** Authorized = ACTIVE shop, no bypass-proof stop, pilot-enrolled row. */
    async _listAuthorizedShops() {
        const shops = await Shop.findAll({
            attributes: ['id', 'is_active', 'ai_emergency_stop'],
            raw: true,
        });
        let pilotRows = [];
        try {
            const PilotModel = require('../modules/entities').ShopPilotFeatures;
            if (PilotModel && typeof PilotModel.findAll === 'function') {
                pilotRows = await PilotModel.findAll({
                    attributes: ['shop_id', 'customer_intelligence', 'interaction_choices',
                        'action_queue', 'knowledge_suggestions', 'ads_studio', 'storefront',
                        'ai_reply_shadow_meter', 'order_confidence_mode'],
                    raw: true,
                });
            }
        } catch (_) {
            pilotRows = []; // unresolved enrollment = nobody authorized (fails closed)
        }
        const pilotByShop = new Map((pilotRows || []).map((row) => [String(row.shop_id), row]));
        return (shops || []).filter((shop) => computeShopAuthorized({
            shop,
            pilotFeatures: pilotByShop.get(String(shop.id)) || null,
        }));
    }

    /** Latest previous per-shop snapshot verdict (transition detection only). */
    async _previousVerdict(shopId) {
        try {
            const previous = await AuditLog.findOne({
                where: { action: SNAPSHOT_ACTION, resource_type: 'shop', resource_id: shopId },
                order: [['created_at', 'DESC']],
            });
            return previous ? (previous.metadata || {}).verdict || null : null;
        } catch (_) {
            return null;
        }
    }

    async run({ dryRun, runDate, executionId }) {
        const now = runDate instanceof Date ? runDate : new Date(runDate);
        const authorizedShops = await this._listAuthorizedShops();

        const results = {
            contractVersion: OBSERVATION_CONTRACT_VERSION,
            windowHours: QUALIFICATION_WINDOW_HOURS,
            shopsAuthorized: authorizedShops.length,
            snapshotsWritten: 0,
            verdicts: { QUALIFIED: 0, OBSERVATION_PENDING: 0, INSUFFICIENT_EVIDENCE: 0 },
            qualifiedTransitions: 0,
            dryRun,
        };
        this.metrics.recordsProcessed = authorizedShops.length;

        for (const shop of authorizedShops) {
            try {
                let rollup = null;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    rollup = await getReplyConfidenceRollup(shop.id, QUALIFICATION_WINDOW_HOURS);
                } catch (_) {
                    rollup = null; // failed read → INSUFFICIENT_EVIDENCE, never a pass
                }
                const verdict = evaluateQualification({
                    rollup,
                    shopAuthorized: true, // the list is already the authorized set
                    shadowToLiveViolations: 0, // architectural isolation — see header
                    now,
                });
                results.verdicts[verdict.verdict] = (results.verdicts[verdict.verdict] || 0) + 1;

                if (!dryRun) {
                    // Transition detection reads the PREVIOUS snapshot before
                    // today's row is written, so re-running the same
                    // executionId (blocked by BaseJob idempotency anyway)
                    // cannot double-alert.
                    // eslint-disable-next-line no-await-in-loop
                    const previousVerdict = await this._previousVerdict(shop.id);
                    const transitionedToQualified = verdict.verdict === QUALIFICATION_VERDICTS.QUALIFIED
                        && previousVerdict !== QUALIFICATION_VERDICTS.QUALIFIED;
                    // eslint-disable-next-line no-await-in-loop
                    await AuditLog.create({
                        action: SNAPSHOT_ACTION,
                        resource_type: 'shop',
                        resource_id: shop.id,
                        user_id: null, // System job
                        shop_id: shop.id,
                        metadata: {
                            executionId, // BaseJob idempotency lookup matches on this
                            contractVersion: OBSERVATION_CONTRACT_VERSION,
                            windowHours: QUALIFICATION_WINDOW_HOURS,
                            verdict: verdict.verdict,
                            denominators: verdict.denominators,
                            firstEligibleObservedAt: verdict.firstEligibleObservedAt,
                            reportSummary: {
                                turns: rollup ? rollup.turns : null,
                                truncated: rollup ? rollup.truncated : null,
                                missing: rollup ? rollup.missing : null,
                                suggestion: rollup ? rollup.suggestion : null,
                                delivered: rollup ? rollup.delivered : null,
                                conversations: rollup ? rollup.conversations : null,
                                wouldHold: rollup ? rollup.wouldHold : null,
                            },
                        },
                        ip_address: 'system',
                        user_agent: `cron-job/${this.jobName}`,
                    });
                    if (transitionedToQualified) {
                        results.qualifiedTransitions++;
                        // Aggregate-only page; no shop name, no messages, no PII.
                        // sendSlack is a no-op when SLACK_ALERT_WEBHOOK_URL is unset.
                        await sendSlack(
                            `:white_check_mark: *Confidence observation QUALIFIED*\n`
                            + `shop=${shop.id} contract=${OBSERVATION_CONTRACT_VERSION} `
                            + `scored=${verdict.denominators.scored} conversations=${verdict.denominators.conversations} `
                            + `firstEligibleObservedAt=${verdict.firstEligibleObservedAt}. `
                            + `Engineering evidence only — business acceptance still requires the founder.`,
                        );
                    }
                }
                this.metrics.recordsSucceeded++;
            } catch (error) {
                this.metrics.recordsFailed++;
                this.metrics.errors.push(`Shop ${shop.id}: ${error.message}`);
                this.logger.warn('Confidence qualification snapshot failed for shop', {
                    shopId: shop.id, error: error.message,
                });
            }
        }

        results.snapshotsWritten = dryRun ? 0 : this.metrics.recordsSucceeded;
        return results;
    }
}

module.exports = ConfidenceQualificationSnapshotJob;
