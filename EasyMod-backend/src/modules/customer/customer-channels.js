'use strict';

/**
 * The canonical set of customer channel types.
 *
 * Order is load-bearing: Sequelize passes this list straight into
 * DataTypes.ENUM for `customers.channel_type`, and Postgres enum labels are
 * stored in declaration order. Keep it identical to the live schema
 * (migrations 20260520_000 + archive 20260209_003).
 *
 * The customer-intelligence list filter validates against this same list
 * instead of re-declaring it or reading `Model.rawAttributes` at import time
 * (rawAttributes is unavailable under mocked-sequelize unit suites).
 */
const CUSTOMER_CHANNEL_TYPES = [
    'messenger',
    'instagram',
    'webchat',
    'manual',
    'facebook',
    'telegram',
];

module.exports = { CUSTOMER_CHANNEL_TYPES };
