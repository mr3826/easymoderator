/**
 * businessHours rule
 *
 * If the channel has business_hours configured and the current time is outside
 * them, and the channel is in AUTO mode, the rule does NOT deny but emits
 * a SUGGEST_ONLY reason so the worker downgrades from auto-send to suggestion.
 *
 * Outside business hours but the message is a customer-triggered reply
 * (within_window=true) is allowed — we don't want to break replies to active
 * conversations just because the shop is "closed".
 *
 * business_hours shape (in MetaChannelSettings):
 *   {
 *     timezone: 'Asia/Dhaka',
 *     mon: { open: '09:00', close: '21:00' },
 *     ...
 *   }
 * or `{ mon: [{ open, close }, ...] }` (inside when ANY slot matches).
 *
 * Timezone precedence (ADR-0013 §7): `hours.timezone` → Shop.timezone →
 * 'Asia/Dhaka'. Evaluation is timezone-correct (Intl.formatToParts), so DST
 * transitions follow the IANA rules.
 *
 * Fail-closed: malformed/unparseable configuration (bad slot, bad time, bad
 * timezone) is CLOSED — an unreadable schedule must never authorize an
 * automatic send. `business_hours` NULL/missing means "always active".
 *
 * A transactional message bypasses hours; a non-AUTO mode never reaches the
 * CLOSED branch.
 */

'use strict';

const {
    AI_REPLY_MODES,
    normalizeAiReplyMode,
    isAutoSendMode,
} = require('../../shop/ai-reply-mode');

const DEFAULT_TIMEZONE = 'Asia/Dhaka';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse `HH:MM` (24h) into minutes since midnight. Returns null when the value
 * is not a well-formed time — callers treat null as CLOSED (fail-closed).
 */
function parseHHMM(value) {
    if (typeof value !== 'string') return null;
    const match = HHMM_PATTERN.exec(value.trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Local day + minute in `timeZone`. Returns null when the timezone cannot be
 * resolved (undefined/legacy alias/garbage) so the caller can fail closed.
 */
function zonedDayMinutes(date, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);
        const get = (type) => parts.find((part) => part.type === type)?.value;
        const weekday = String(get('weekday') || '').slice(0, 3).toLowerCase();
        const dayKey = DAY_KEYS.includes(weekday) ? weekday : null;
        let hour = Number(get('hour'));
        if (hour === 24) hour = 0; // ICU can emit "24" for midnight
        const minute = Number(get('minute'));
        if (!dayKey || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        return { dayKey, minutes: hour * 60 + minute };
    } catch (_) {
        return null;
    }
}

const isSlotShape = (slot) => Boolean(slot) && typeof slot === 'object' && !Array.isArray(slot);

/** One slot matches `nowMinutes`; returns null when the slot is malformed. */
function matchesSlot(slot, nowMinutes, { overnightTailOnly = false } = {}) {
    if (!isSlotShape(slot)) return null;
    const open = parseHHMM(slot.open);
    const close = parseHHMM(slot.close);
    if (open === null || close === null) return null;
    if (close < open) {
        // Overnight range: e.g. Monday 22:00 → Tuesday 02:00.
        return overnightTailOnly
            ? nowMinutes < close
            : nowMinutes >= open || nowMinutes < close;
    }
    // A normal slot never spans into the next day.
    if (overnightTailOnly) return null;
    return nowMinutes >= open && nowMinutes < close;
}

function anySlotMatches(slot, nowMinutes, options) {
    if (Array.isArray(slot)) {
        if (slot.length === 0) return false;
        return slot.some((entry) => matchesSlot(entry, nowMinutes, options) === true);
    }
    return matchesSlot(slot, nowMinutes, options) === true;
}

/**
 * Pure hours check.
 *
 * @param {object|null} hours - channel business_hours
 * @param {Date} [now]
 * @param {{defaultTimeZone?: string}} [options] - Shop.timezone (or explicit)
 * @returns {boolean} CLOSED (false) on any malformed/unparseable input
 */
function isInsideHours(hours, now = new Date(), { defaultTimeZone = null } = {}) {
    if (hours === null || hours === undefined) return true; // always active
    if (typeof hours !== 'object' || Array.isArray(hours)) return false; // malformed

    const configuredZone = typeof hours.timezone === 'string' && hours.timezone.trim()
        ? hours.timezone.trim()
        : null;
    // A configured-but-unusable timezone must fail closed; only an ABSENT
    // timezone falls through to the shop/default timezone.
    const timeZone = configuredZone || defaultTimeZone || DEFAULT_TIMEZONE;
    if (configuredZone) {
        try {
            // Throws RangeError for an invalid IANA name.
            new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
        } catch (_) {
            return false;
        }
    }

    const local = zonedDayMinutes(now, timeZone);
    if (!local) return false;

    const slot = hours[local.dayKey];
    if (slot !== undefined && slot !== null && anySlotMatches(slot, local.minutes)) return true;

    // An overnight slot declared on the PREVIOUS day spans into today's early
    // hours (Monday 22:00 → Tuesday 02:00 covers Tuesday 00:30). A day with no
    // slot is still closed unless such a tail is active.
    const dayIndex = DAY_KEYS.indexOf(local.dayKey);
    const previousSlot = hours[DAY_KEYS[(dayIndex + 6) % 7]];
    return anySlotMatches(previousSlot, local.minutes, { overnightTailOnly: true });
}

/**
 * Resolve Shop.timezone lazily. Policy rules receive only `shopId`, so this is
 * a single primary-key read that only runs when `hours` carries no timezone.
 */
async function resolveShopTimeZone(ctx) {
    if (typeof ctx?.shopTimezone === 'string' && ctx.shopTimezone.trim()) {
        return ctx.shopTimezone.trim();
    }
    if (typeof ctx?.settings?.shop_timezone === 'string' && ctx.settings.shop_timezone.trim()) {
        return ctx.settings.shop_timezone.trim();
    }
    if (ctx?.shop?.timezone) return ctx.shop.timezone;
    if (!ctx?.shopId) return null;
    try {
        const Shop = require('../../shop/shop.entity');
        const shop = typeof Shop.findByPk === 'function'
            ? await Shop.findByPk(ctx.shopId, { attributes: ['id', 'timezone'] })
            : null;
        return shop?.timezone || null;
    } catch (_) {
        // Fall back to Asia/Dhaka; the send-time safety rails remain.
        return null;
    }
}

module.exports = {
    name: 'businessHours',

    async evaluate(_message, ctx) {
        if (ctx.messageType === 'transactional' || _message?.messageType === 'transactional') {
            return { allow: true, reason: 'TRANSACTIONAL_NOTIFICATION' };
        }
        const settings = ctx.settings || {};
        const automationMode = normalizeAiReplyMode(
            settings.automation_mode || AI_REPLY_MODES.MANUAL
        );
        const businessHours = settings.business_hours;
        if (!businessHours) return { allow: true, reason: 'NO_HOURS_CONFIG' };

        const defaultTimeZone = typeof businessHours === 'object'
            && !Array.isArray(businessHours)
            && !businessHours.timezone
            ? await resolveShopTimeZone(ctx)
            : null;

        if (isInsideHours(businessHours, new Date(), { defaultTimeZone })) {
            return { allow: true, reason: 'INSIDE_HOURS' };
        }
        if (isAutoSendMode(automationMode)) {
            // Downgrade — allow the engine to flag the worker to store-only.
            return { allow: false, reason: 'SUGGEST_ONLY' };
        }
        return { allow: true, reason: 'OUTSIDE_HOURS_NON_AI' };
    },
};

module.exports.isInsideHours = isInsideHours;
module.exports.resolveShopTimeZone = resolveShopTimeZone;