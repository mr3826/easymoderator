'use strict';

const NOTIFICATION_EVENTS = Object.freeze({
    NEW_ORDER: 'new_order',
    AI_HITL: 'ai_hitl',
    CUSTOMER_WAITING_TOO_LONG: 'customer_waiting_too_long',
    COURIER_BOOKING_FAILED: 'courier_booking_failed',
    COURIER_SETUP_REQUIRED: 'courier_setup_required',
    // RTO Shield v2: automatic courier booking paused until the order is verified/approved.
    ORDER_REVIEW_REQUIRED: 'order_review_required',
    PAYMENT_SUBSCRIPTION_ISSUE: 'payment_subscription_issue',
    DAILY_SALES_SUMMARY: 'daily_sales_summary',
    TELEGRAM_TEST: 'telegram_test'
});

const NOTIFICATION_EVENT_META = Object.freeze({
    [NOTIFICATION_EVENTS.NEW_ORDER]: {
        label: 'New order',
        labelBn: 'নতুন অর্ডার',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.AI_HITL]: {
        label: 'AI needs human help',
        labelBn: 'AI মানব সহায়তা চায়',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.CUSTOMER_WAITING_TOO_LONG]: {
        label: 'Customer waiting too long',
        labelBn: 'কাস্টমার বেশি সময় অপেক্ষা করছে',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.COURIER_BOOKING_FAILED]: {
        label: 'Courier booking failed',
        labelBn: 'কুরিয়ার বুকিং ব্যর্থ',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.COURIER_SETUP_REQUIRED]: {
        label: 'Courier setup required',
        labelBn: 'কুরিয়ার সেটআপ প্রয়োজন',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.ORDER_REVIEW_REQUIRED]: {
        label: 'Order needs verification before courier booking',
        labelBn: 'কুরিয়ার বুকিংয়ের আগে অর্ডার যাচাই প্রয়োজন',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE]: {
        // Event key stays `payment_subscription_issue` (historical record
        // vocabulary); the merchant-facing label is the delivered-order model.
        label: 'Delivered-order billing issue',
        labelBn: 'ডেলিভারি-ভিত্তিক বিল সমস্যা',
        defaultEnabled: true
    },
    [NOTIFICATION_EVENTS.DAILY_SALES_SUMMARY]: {
        label: 'Daily sales summary',
        labelBn: 'দৈনিক বিক্রয় সারাংশ',
        defaultEnabled: true
    }
});

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze(
    Object.fromEntries(
        Object.entries(NOTIFICATION_EVENT_META).map(([eventType, meta]) => [
            eventType,
            meta.defaultEnabled
        ])
    )
);

function normalizePreferences(input = {}) {
    const normalized = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    for (const eventType of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
        if (typeof input[eventType] === 'boolean') {
            normalized[eventType] = input[eventType];
        }
    }
    return normalized;
}

function isConfigurableEvent(eventType) {
    return Object.prototype.hasOwnProperty.call(DEFAULT_NOTIFICATION_PREFERENCES, eventType);
}

module.exports = {
    NOTIFICATION_EVENTS,
    NOTIFICATION_EVENT_META,
    DEFAULT_NOTIFICATION_PREFERENCES,
    normalizePreferences,
    isConfigurableEvent
};
