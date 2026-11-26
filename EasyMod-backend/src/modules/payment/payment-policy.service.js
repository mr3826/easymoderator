'use strict';

/**
 * Payment POLICY service — the Payment Policies tab write/read (§5.2).
 *
 * Investigated per §5.1: the "advance payment policy" was NEVER persisted on the
 * server. The FE posted a `payment_methods` JSON blob to /shop/update, but
 * `payment_methods` is not a column of `shops` and not a Shop attribute, so
 * shop.update silently dropped it and getShop could never return it. There is no
 * legacy row to migrate — `settings.ai.payment_methods: ['COD']` is a DIFFERENT
 * chat vocabulary and is deliberately NOT conflated here. This service therefore
 * establishes the real store at `shop.settings.payments` and PERSERVES the
 * merchant's paymentMessage under the `payment_message` key (§5.2).
 *
 * delivery_charge authority (§5.2): the advance for `delivery_charge` EQUALS the
 * number already computed by the zone machinery (order step_data), which is passed
 * IN. This module references it and NEVER recomputes a delivery fee.
 *
 * Order-relative clamp rules (fixed>0, fixed<total) are enforced at CHECKOUT math
 * via computeAdvance(), not at config-save time (§5.2).
 */
const { Shop } = require('../entities');
const { AppError } = require('../../utils/AppError');
const taxonomy = require('./payment-taxonomy');

const {
    ADVANCE_POLICIES,
    ADVANCE_POLICY_ALIASES,
    ADVANCE_PERCENTAGE_MIN,
    ADVANCE_PERCENTAGE_MAX,
    ADVANCE_FIXED_MIN,
    ADVANCE_FIXED_MAX,
} = taxonomy;

const DEFAULT_POLICY = Object.freeze({
    advance_policy: 'none',
    advance_value: null,
    payment_message: '',
});

const PAYMENT_MESSAGE_MAX = 500;

// Accept BOTH canonical keys and the legacy FE radio keys (§5.2 alias note), so
// the FE migration can send either without a second server round of rework.
function normalizePolicyInput(body = {}) {
    const rawPolicy = body.advance_policy ?? body.advancePaymentRule;
    let policy = typeof rawPolicy === 'string' ? rawPolicy.trim().toLowerCase() : rawPolicy;
    if (policy && ADVANCE_POLICY_ALIASES[policy]) policy = ADVANCE_POLICY_ALIASES[policy];

    const rawValue = body.advance_value ?? (policy === 'percentage' ? body.advancePercentage : body.advanceFixed);
    const message = body.payment_message ?? body.paymentMessage;

    return { policy, rawValue, message };
}

function validateAndBuildPolicy(input) {
    const { policy, rawValue, message } = normalizePolicyInput(input);

    if (!ADVANCE_POLICIES.includes(policy)) {
        throw new AppError(
            `advance_policy must be one of: ${ADVANCE_POLICIES.join(', ')}`,
            400, 'INVALID_ADVANCE_POLICY',
        );
    }

    let advanceValue = null;
    const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== '';

    if (policy === 'percentage') {
        if (!hasValue) throw new AppError('percentage policy requires advance_value', 400, 'ADVANCE_VALUE_REQUIRED');
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < ADVANCE_PERCENTAGE_MIN || n > ADVANCE_PERCENTAGE_MAX) {
            throw new AppError(
                `advance_value for percentage must be an integer ${ADVANCE_PERCENTAGE_MIN}..${ADVANCE_PERCENTAGE_MAX}`,
                400, 'ADVANCE_PERCENTAGE_OUT_OF_RANGE',
            );
        }
        advanceValue = n;
    } else if (policy === 'fixed') {
        if (!hasValue) throw new AppError('fixed policy requires advance_value', 400, 'ADVANCE_VALUE_REQUIRED');
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < ADVANCE_FIXED_MIN || n > ADVANCE_FIXED_MAX) {
            throw new AppError(
                `advance_value for fixed must be an integer taka ${ADVANCE_FIXED_MIN}..${ADVANCE_FIXED_MAX}`,
                400, 'ADVANCE_FIXED_OUT_OF_RANGE',
            );
        }
        advanceValue = n;
    } else {
        // none | full | delivery_charge → advance_value MUST be null (§5.2).
        if (hasValue) {
            throw new AppError(
                `advance_value must be empty for the ${policy} policy`,
                400, 'ADVANCE_VALUE_NOT_ALLOWED',
            );
        }
        advanceValue = null;
    }

    let paymentMessage = '';
    if (message !== undefined && message !== null) {
        if (typeof message !== 'string') {
            throw new AppError('payment_message must be a string', 400, 'INVALID_PAYMENT_MESSAGE');
        }
        paymentMessage = message.trim();
        // sanitized as text; ≤500 chars (§5.2, #5.2 consumption "≤500 chars, sanitized as text")
        if (paymentMessage.length > PAYMENT_MESSAGE_MAX) {
            throw new AppError(
                `payment_message must be at most ${PAYMENT_MESSAGE_MAX} characters`,
                400, 'PAYMENT_MESSAGE_TOO_LONG',
            );
        }
    }

    return {
        advance_policy: policy,
        advance_value: advanceValue,
        payment_message: paymentMessage,
    };
}

async function getPaymentPolicy(shopId, userId) {
    const shop = await Shop.findByPk(shopId, { attributes: ['id', 'settings'] });
    if (!shop) throw new AppError('Shop not found', 404);
    const stored = shop.settings?.payments || {};
    return {
        advance_policy: stored.advance_policy || DEFAULT_POLICY.advance_policy,
        advance_value: Number.isInteger(stored.advance_value) ? stored.advance_value : null,
        payment_message: typeof stored.payment_message === 'string' ? stored.payment_message : DEFAULT_POLICY.payment_message,
        updated_at: stored.updated_at || null,
        updated_by: stored.updated_by || null,
        _shop_id: shopId, // internal tenant marker; controller strips it
    };
}

async function updatePaymentPolicy(shopId, userId, body) {
    const built = validateAndBuildPolicy(body);

    const { mergeSettingsPreservingRtoConsent } = require('../shop/shop-settings.validator');
    const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');

    const result = await Shop.sequelize.transaction(async (transaction) => {
        const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
        if (!shop) throw new AppError('Shop not found', 404);
        const payments = {
            ...(shop.settings?.payments || {}),
            ...built,
            updated_at: new Date().toISOString(),
            updated_by: userId || null,
        };
        const merged = mergeSettingsPreservingRtoConsent(shop.settings || {}, { payments });
        await shop.update({ settings: merged }, { transaction });
        return merged.payments;
    });

    await invalidateShopSettingsCaches(shopId);
    return result;
}

/**
 * Order-relative advance computation (§5.2). PURE — takes the zone-computed
 * deliveryCharge and the order total; references, never recomputes, the fee.
 * The fixed>0/fixed<total clamp lives here (checkout math), not in config save.
 *
 * @returns {{ policy, advance_amount, remainder, note }}
 */
function computeAdvance({ policy, value, orderTotal, deliveryCharge }) {
    const total = Number(orderTotal) || 0;
    switch (policy) {
        case 'none':
            return { policy, advance_amount: 0, remainder: total, note: null };
        case 'full':
            return { policy, advance_amount: total, remainder: 0, note: null };
        case 'delivery_charge': {
            const charge = Number.isFinite(Number(deliveryCharge)) ? Number(deliveryCharge) : 0;
            const advance = Math.min(Math.max(charge, 0), total);
            return { policy, advance_amount: advance, remainder: Math.max(total - advance, 0), note: null };
        }
        case 'percentage': {
            const pct = Number(value) || 0;
            const advance = Math.min(Math.round((total * pct) / 100), total);
            return { policy, advance_amount: advance, remainder: Math.max(total - advance, 0), note: null };
        }
        case 'fixed': {
            const fixed = Number(value) || 0;
            // fixed ≥ total behaves as full; never silently exceed (§5.2).
            if (fixed >= total) return { policy: 'full', advance_amount: total, remainder: 0, note: 'fixed_gte_total_treated_as_full' };
            return { policy, advance_amount: Math.max(fixed, 0), remainder: Math.max(total - fixed, 0), note: null };
        }
        default:
            return { policy: 'none', advance_amount: 0, remainder: total, note: 'unknown_policy_default_none' };
    }
}

module.exports = {
    getPaymentPolicy,
    updatePaymentPolicy,
    computeAdvance,
    normalizePolicyInput,
    validateAndBuildPolicy,
    DEFAULT_POLICY,
    PAYMENT_MESSAGE_MAX,
};
