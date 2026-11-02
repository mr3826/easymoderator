const { AppError } = require('../../utils/AppError');
const shopService = require('../shop/shop.service');

/**
 * Get the effective confidence threshold for a specific intent in a shop.
 *
 * Reads from shop's aiSettings.intentThresholds[intentName].
 * Falls back to aiSettings.confidence_threshold (or 75) if no intent-specific override exists.
 *
 * @param {string} shopId
 * @param {string} intentName - e.g. 'greeting', 'refund', 'product_inquiry'
 * @returns {Promise<number>} Threshold as 0-100 integer
 */
const getThresholdForIntent = async (shopId, intentName) => {
    const aiSettings = await shopService.getShopAiSettings(shopId);
    if (!aiSettings) return 75;

    // Check intentThresholds map first (C2-specific key)
    const intentThresholds = aiSettings.intentThresholds || {};
    if (intentThresholds[intentName] !== undefined) {
        return intentThresholds[intentName];
    }

    // Also check legacy intent_confidence_map for backwards compat
    const intentMap = aiSettings.intent_confidence_map || {};
    if (intentMap[intentName] !== undefined) {
        return intentMap[intentName];
    }

    // Fall back to global confidence threshold
    return aiSettings.confidence_threshold || 75;
};

/**
 * Save a per-intent threshold map to shop's aiSettings.intentThresholds.
 *
 * @param {string} shopId
 * @param {object} thresholdMap - e.g. { greeting: 70, refund: 90, product_inquiry: 65 }
 * @returns {Promise<object>} Updated intentThresholds map
 */
const updateIntentThresholds = async (shopId, thresholdMap) => {
    if (!thresholdMap || typeof thresholdMap !== 'object' || Array.isArray(thresholdMap)) {
        throw new AppError('thresholdMap must be a plain object', 400);
    }

    // Validate all values are numbers in 0-100 range
    for (const [intent, value] of Object.entries(thresholdMap)) {
        if (typeof value !== 'number' || value < 0 || value > 100) {
            throw new AppError(`Threshold for intent "${intent}" must be a number between 0 and 100`, 400);
        }
    }

    let newThresholds;
    await shopService.updateShopSettingsPreservingRtoConsent(shopId, (currentSettings) => {
        const currentAI = currentSettings.ai || {};
        newThresholds = { ...(currentAI.intentThresholds || {}), ...thresholdMap };
        return {
            ai: {
                ...currentAI,
                intentThresholds: newThresholds,
            },
        };
    });

    return newThresholds;
};

module.exports = {
    getThresholdForIntent,
    updateIntentThresholds
};
