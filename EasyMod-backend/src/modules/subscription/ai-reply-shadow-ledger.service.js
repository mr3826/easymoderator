'use strict';

const crypto = require('crypto');
const { AiReplyShadowLedger } = require('./ai-reply-shadow-ledger.entity');
const Subscription = require('./subscription.entity');
const { isProviderConfirmed, normalizeDeliveryState } = require('../conversation/message-lifecycle');
const { createLogger } = require('../../utils/structured-logger');

const logger = createLogger('AiReplyShadowLedger');
const SHADOW_TARGETS = Object.freeze({ SHURU: 300, GROWTH: 3000, PARTNER: null });

function metadataFor(message) {
    if (typeof message?.metadata === 'string') {
        try {
            const metadata = JSON.parse(message.metadata);
            return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
        } catch (_) {
            return {};
        }
    }
    return message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata
        : {};
}

function utcCalendarMonthPeriod(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('A valid accepted-at timestamp is required');

    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    return {
        start: start.toISOString(),
        end: end.toISOString(),
        startDate: start.toISOString().slice(0, 10),
    };
}

function idempotencyKeyFor(shopId, message, metadata) {
    const logicalTurnId = metadata.logical_turn_id || metadata.logicalTurnId || metadata.turn_id;
    const sourceType = logicalTurnId ? 'turn' : 'message';
    const sourceId = logicalTurnId || message.id;
    if (sourceId == null || String(sourceId).trim() === '') return null;
    return crypto.createHash('sha256')
        .update(`easymod:ai-reply-shadow:v1\0${shopId}\0${sourceType}\0${String(sourceId)}`)
        .digest('hex');
}

function isEligibleAcceptedAiReply(shopId, message, acceptedAt) {
    if (!shopId || !message || message.sender !== 'ai') return false;
    const metadata = metadataFor(message);
    const source = message.delivery_source || metadata.delivery_source;
    if (!['AUTO', 'DRAFT_APPROVAL'].includes(source)) return false;
    if (!isProviderConfirmed(message)) return false;
    if (metadata.delivered !== true || metadata.provider_send_confirmed !== true) return false;
    if (!['SENT', 'DELIVERED'].includes(normalizeDeliveryState(message))) return false;
    const timestamp = acceptedAt ?? metadata.provider_accepted_at;
    return timestamp != null
        && timestamp !== ''
        && Number.isFinite(new Date(timestamp).getTime());
}

function errorCode(error) {
    const value = String(error?.code || error?.name || 'UNKNOWN');
    return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : 'UNKNOWN';
}

async function readMeteringGates(shopId) {
    try {
        const pilotFeatures = require('../pilot-features/pilot-features.service');
        const shopAddons = require('../shop-addons/shop-addons.service');
        if (typeof pilotFeatures.getPilotFeaturesStrict !== 'function'
            || typeof shopAddons.assertAddonEnabled !== 'function') {
            throw new Error('Shadow metering gate API unavailable');
        }
        const features = await pilotFeatures.getPilotFeaturesStrict(shopId);
        if (features?.aiReplyShadowMeter !== true) return { permitted: false, reason: 'flag_off' };
        const addon = await shopAddons.assertAddonEnabled(shopId, 'AI_REPLY_METER');
        if (addon === false) return { permitted: false, reason: 'addon_off' };
        const enabledAt = features.aiReplyShadowMeterEnabledAt;
        if (!enabledAt || !Number.isFinite(new Date(enabledAt).getTime())) {
            return { permitted: false, reason: 'enablement_time_missing' };
        }
        return { permitted: true, enabledAt: new Date(enabledAt) };
    } catch (error) {
        logger.warn('AI reply shadow gate read failed; usage skipped', { code: errorCode(error) });
        return {
            permitted: false,
            reason: errorCode(error) === 'ADDON_NOT_AVAILABLE' ? 'flag_off' : 'gate_unavailable',
        };
    }
}

async function recordAcceptedAiReply({ shopId, message, acceptedAt } = {}) {
    const metadata = metadataFor(message);
    const timestamp = acceptedAt ?? metadata.provider_accepted_at;
    if (!isEligibleAcceptedAiReply(shopId, message, timestamp)) {
        return { recorded: false, reason: 'not_eligible' };
    }

    const key = idempotencyKeyFor(shopId, message, metadata);
    if (!key) return { recorded: false, reason: 'missing_idempotency_key' };

    const gates = await readMeteringGates(shopId);
    if (!gates.permitted) return { recorded: false, reason: gates.reason };
    if (new Date(timestamp).getTime() < gates.enabledAt.getTime()) {
        return { recorded: false, reason: 'before_meter_enabled' };
    }

    const period = utcCalendarMonthPeriod(timestamp);
    let subscription;
    try {
        subscription = await Subscription.findOne({
            where: { shop_id: shopId },
            attributes: ['plan_code'],
        });
    } catch (error) {
        logger.warn('Subscription unavailable; AI reply shadow usage skipped', { code: errorCode(error) });
        return { recorded: false, reason: 'subscription_unavailable' };
    }
    const defaults = {
        shop_id: shopId,
        idempotency_key: key,
        period_start: period.startDate,
        period_end: period.end.slice(0, 10),
        accepted_at: new Date(timestamp),
        plan_code: String(subscription?.plan_code || '').toUpperCase() || null,
        reply_source: message.delivery_source || metadata.delivery_source,
        units: 1,
    };

    // findOrCreate uses the database's unique constraint as the concurrent
    // delivery fence and never mutates an existing ledger row.
    const [, created] = await AiReplyShadowLedger.findOrCreate({
        where: { shop_id: shopId, idempotency_key: key },
        defaults,
    });
    return { recorded: created, reason: created ? null : 'duplicate' };
}

async function getShadowUsage(shopId, now = new Date()) {
    if (!shopId) throw new TypeError('shopId is required');
    const period = utcCalendarMonthPeriod(now);
    const [sum, subscription, gates] = await Promise.all([
        AiReplyShadowLedger.sum('units', {
            where: { shop_id: shopId, period_start: period.startDate },
        }),
        Subscription.findOne({
            where: { shop_id: shopId },
            attributes: ['plan_code', 'conversations_used', 'conversations_limit'],
        }).catch((error) => {
            logger.warn('Conversation usage unavailable for shadow response', { code: errorCode(error) });
            return null;
        }),
        readMeteringGates(shopId),
    ]);

    const planCode = String(subscription?.plan_code || '').toUpperCase();
    const target = Object.prototype.hasOwnProperty.call(SHADOW_TARGETS, planCode)
        ? SHADOW_TARGETS[planCode]
        : null;
    const result = {
        candidate_units: 1,
        unit: 'provider_accepted_ai_reply',
        target,
        current_shadow_use: Number.isFinite(Number(sum)) ? Number(sum) : 0,
        plan_code: Object.prototype.hasOwnProperty.call(SHADOW_TARGETS, planCode) ? planCode : null,
        period: { start: period.start, end: period.end },
        billing_mode: 'shadow',
        billable: false,
        enforce: false,
        recording_enabled: gates.permitted,
        recording_status: gates.permitted ? 'active' : gates.reason,
    };

    const used = Number(subscription?.conversations_used);
    const limit = Number(subscription?.conversations_limit);
    if (subscription && Number.isFinite(used) && Number.isFinite(limit)) {
        result.conversation_usage = { used, limit };
    }
        return result;
}

module.exports = {
    recordAcceptedAiReply,
    getShadowUsage,
    _private: {
        metadataFor,
        utcCalendarMonthPeriod,
        idempotencyKeyFor,
        isEligibleAcceptedAiReply,
        readMeteringGates,
    },
};
