'use strict';

const { NOTIFICATION_EVENTS } = require('./notification-events');
const { getOrigins } = require('../../config/origins');
const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    formatBdt,
} = require('../commercial/commercial.contract');

function baseAppUrl() {
    return getOrigins().app;
}

function money(value) {
    if (value === null || value === undefined || value === '') return null;
    const amount = Number(value);
    if (Number.isNaN(amount)) return String(value);
    return `BDT ${amount.toLocaleString('en-BD')}`;
}

function deepLink(path) {
    return `${baseAppUrl()}${path}`;
}

function compactLines(lines) {
    return lines.filter(Boolean).join('\n');
}

function safeAlertText(value, maxLength = 160) {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value !== 'string' && typeof value !== 'number') return null;

    const normalized = String(value)
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? normalized.slice(0, maxLength) : null;
}

function safeMissingFields(value) {
    const values = Array.isArray(value) ? value : [value];
    const normalized = values
        .map(item => safeAlertText(item, 80))
        .filter(Boolean)
        .slice(0, 8);
    return normalized.length ? normalized.join(', ') : null;
}

function formatTelegramAlert(eventType, payload = {}) {
    const orderNumber = payload.orderNumber || payload.order_number;
    const customerName = payload.customerName || payload.customer_name;
    const provider = payload.provider || payload.courierProvider;

    switch (eventType) {
        case NOTIFICATION_EVENTS.NEW_ORDER: {
            const url = payload.orderId
                ? deepLink(`/orders?orderId=${encodeURIComponent(payload.orderId)}`)
                : deepLink('/orders');
            return {
                title: 'New order received',
                body: compactLines([
                    'New order received / নতুন অর্ডার এসেছে',
                    orderNumber ? `Order: #${orderNumber}` : null,
                    customerName ? `Customer: ${customerName}` : null,
                    money(payload.total) ? `Total: ${money(payload.total)}` : null,
                    payload.channel ? `Channel: ${payload.channel}` : null
                ]),
                deepLink: url
            };
        }
        case NOTIFICATION_EVENTS.AI_HITL: {
            const url = payload.conversationId
                ? deepLink(`/inbox?conversationId=${encodeURIComponent(payload.conversationId)}`)
                : deepLink('/inbox');
            return {
                title: 'AI needs human help',
                body: compactLines([
                    'AI needs human help / AI মানব সহায়তা চায়',
                    payload.reason ? `Reason: ${payload.reason}` : null,
                    payload.customerName ? `Customer: ${payload.customerName}` : null,
                    payload.lastMessage ? `Last message: ${String(payload.lastMessage).slice(0, 180)}` : null
                ]),
                deepLink: url
            };
        }
        case NOTIFICATION_EVENTS.CUSTOMER_WAITING_TOO_LONG: {
            const url = payload.conversationId
                ? deepLink(`/inbox?conversationId=${encodeURIComponent(payload.conversationId)}`)
                : deepLink('/inbox');
            return {
                title: 'Customer waiting too long',
                body: compactLines([
                    'Customer waiting too long / কাস্টমার বেশি সময় অপেক্ষা করছে',
                    payload.waitMinutes ? `Waiting: ${payload.waitMinutes} minutes` : null,
                    payload.customerName ? `Customer: ${payload.customerName}` : null
                ]),
                deepLink: url
            };
        }
        case NOTIFICATION_EVENTS.COURIER_BOOKING_FAILED: {
            const url = payload.orderId
                ? deepLink(`/orders?orderId=${encodeURIComponent(payload.orderId)}`)
                : deepLink('/orders');
            return {
                title: 'Courier booking failed',
                body: compactLines([
                    'Courier booking failed / কুরিয়ার বুকিং ব্যর্থ',
                    orderNumber ? `Order: #${orderNumber}` : null,
                    provider ? `Courier: ${provider}` : null,
                    payload.error ? `Reason: ${String(payload.error).slice(0, 220)}` : null
                ]),
                deepLink: url
            };
        }
        case NOTIFICATION_EVENTS.COURIER_SETUP_REQUIRED: {
            const safeOrderNumber = safeAlertText(orderNumber);
            const safeProvider = safeAlertText(provider);
            const safeMissing = safeMissingFields(
                payload.missing ?? payload.missingFields ?? payload.missing_fields
            );
            const safeStatus = safeAlertText(
                payload.status ?? payload.activationStatus ?? payload.activation_status
            );
            const safeReason = safeAlertText(
                payload.reasonCode ?? payload.reason_code ?? payload.reason
            );

            return {
                title: 'Courier setup required',
                body: compactLines([
                    'Courier setup required / কুরিয়ার সেটআপ প্রয়োজন',
                    safeOrderNumber ? `Order: #${safeOrderNumber}` : null,
                    safeProvider ? `Courier: ${safeProvider}` : null,
                    safeMissing ? `Missing: ${safeMissing}` : null,
                    safeStatus ? `Status: ${safeStatus}` : null,
                    safeReason ? `Reason: ${safeReason}` : null,
                    'Open Delivery Settings to complete courier setup before dispatching.'
                ]),
                deepLink: deepLink('/manage-shop/delivery-settings')
            };
        }
        case NOTIFICATION_EVENTS.ORDER_REVIEW_REQUIRED: {
            const safeOrderNumber = safeAlertText(orderNumber);
            const safeDecision = safeAlertText(payload.decision);
            const safeReasons = safeMissingFields(payload.reasonCodes ?? payload.reason_codes);
            return {
                title: 'Order needs review before courier booking',
                body: compactLines([
                    'Order needs review / অর্ডার যাচাই প্রয়োজন',
                    safeOrderNumber ? `Order: #${safeOrderNumber}` : null,
                    safeDecision ? `Decision: ${safeDecision}` : null,
                    safeReasons ? `Reasons: ${safeReasons}` : null,
                    'Automatic courier booking is paused until the order is verified.'
                ]),
                deepLink: payload.orderId
                    ? deepLink(`/orders?orderId=${encodeURIComponent(payload.orderId)}`)
                    : deepLink('/orders')
            };
        }
        case NOTIFICATION_EVENTS.PAYMENT_SUBSCRIPTION_ISSUE: {
            // Copy is contract-derived: the merchant is billed per delivered
            // order, never by a subscription. The event key stays historical.
            const amountMinor = Number(payload.amountMinor);
            return {
                title: 'Delivered-order billing issue',
                body: compactLines([
                    'Delivered-order billing issue / ডেলিভারি-ভিত্তিক বিল সমস্যা',
                    payload.issue ? `Issue: ${payload.issue}` : null,
                    payload.invoiceNumber ? `Invoice: ${payload.invoiceNumber}` : null,
                    Number.isFinite(amountMinor) ? `Amount: ${formatBdt(amountMinor)}` : null,
                    `Contract v${COMMERCIAL_CONTRACT_VERSION}: `
                        + `${formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor)} per delivered order`
                ]),
                deepLink: deepLink('/subscription')
            };
        }
        case NOTIFICATION_EVENTS.DAILY_SALES_SUMMARY: {
            return {
                title: 'Daily sales summary',
                body: compactLines([
                    'Daily sales summary / দৈনিক বিক্রয় সারাংশ',
                    payload.date ? `Date: ${payload.date}` : null,
                    payload.orderCount !== undefined ? `Orders: ${payload.orderCount}` : null,
                    money(payload.salesTotal) ? `Sales: ${money(payload.salesTotal)}` : null
                ]),
                deepLink: deepLink('/dashboard')
            };
        }
        case NOTIFICATION_EVENTS.TELEGRAM_TEST:
            return {
                title: 'EasyModerator test alert',
                body: compactLines([
                    'EasyModerator test alert',
                    'বাংলা টেস্ট এলার্ট',
                    'Telegram alerts are connected for this shop.'
                ]),
                deepLink: deepLink('/manage-shop/notifications')
            };
        default:
            return {
                title: payload.title || 'EasyModerator alert',
                body: payload.body || 'Open EasyModerator to review this alert.',
                deepLink: deepLink('/dashboard')
            };
    }
}

function toPushPayload(eventType, payload = {}) {
    const alert = formatTelegramAlert(eventType, payload);
    const conversationId = payload.conversationId || payload.data?.conversationId;
    const orderId = payload.orderId || payload.data?.orderId;
    const entity = conversationId ? 'conversation' : orderId ? 'order' : undefined;
    const entityId = conversationId || orderId || payload.id || payload.data?.id;

    return {
        title: alert.title,
        body: alert.body.split('\n')[0],
        icon: '/icon-512.png',
        data: {
            ...(payload.data || {}),
            eventType,
            deepLink: alert.deepLink,
            ...(conversationId ? { conversationId: String(conversationId) } : {}),
            ...(orderId ? { orderId: String(orderId) } : {}),
            ...(entity ? { entity } : {}),
            ...(entityId ? { id: String(entityId) } : {})
        }
    };
}


module.exports = { formatTelegramAlert, toPushPayload };
