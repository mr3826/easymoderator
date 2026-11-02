'use strict';

const {
    OUTCOMES, classifyOrderOutcome, normalizeBdMobile, phoneVariants, summarizeOrders,
} = require('../order-outcome');
const { deriveCustomerState, STATES, INACTIVE_AFTER_DAYS } = require('../customer-state');

describe('classifyOrderOutcome', () => {
    test.each([
        ['courier delivered', { delivery_status: 'delivered' }, OUTCOMES.DELIVERED],
        ['partial delivery remains in progress without item-level value evidence', { delivery_status: 'partial_delivered' }, OUTCOMES.IN_PROGRESS],
        ['partial delivery remains in progress despite legacy full-delivery fields', { delivery_status: 'partial_delivered', order_status: 'delivered', delivered_at: '2026-09-01T00:00:00Z' }, OUTCOMES.IN_PROGRESS],
        ['order marked delivered', { order_status: 'delivered' }, OUTCOMES.DELIVERED],
        ['delivered_at recorded', { delivered_at: '2026-09-01T00:00:00Z' }, OUTCOMES.DELIVERED],
        ['courier returned', { delivery_status: 'returned', delivery_consignment_id: 'C1' }, OUTCOMES.RETURNED],
        ['partial return', { delivery_status: 'partial_returned', order_status: 'cancelled' }, OUTCOMES.RETURNED],
        ['partial return supersedes legacy partial-delivery completion fields', { delivery_status: 'partial_returned', order_status: 'delivered', delivered_at: '2026-09-01T00:00:00Z' }, OUTCOMES.RETURNED],
        ['courier cancel after pickup remains a cancellation', { delivery_status: 'cancelled', delivery_tracking_code: 'T1', order_status: 'cancelled' }, OUTCOMES.CANCELLED],
        ['courier-only cancellation status is not an RTO', { delivery_status: 'cancelled', delivery_tracking_code: 'T1' }, OUTCOMES.CANCELLED],
        ['authoritative return status remains an RTO', { delivery_status: 'returned', order_status: 'cancelled' }, OUTCOMES.RETURNED],
        ['merchant cancel before dispatch', { order_status: 'cancelled' }, OUTCOMES.CANCELLED],
        ['refund before dispatch', { order_status: 'refunded' }, OUTCOMES.CANCELLED],
        ['failed attempt is not an outcome', { delivery_status: 'failed_delivery', delivery_tracking_code: 'T1' }, OUTCOMES.IN_PROGRESS],
        ['in transit', { delivery_status: 'in_transit', delivery_tracking_code: 'T1' }, OUTCOMES.IN_PROGRESS],
        ['confirmed, not booked', { order_status: 'confirmed' }, OUTCOMES.IN_PROGRESS],
        ['held for review', { order_status: 'confirmed', delivery_status: 'confidence_hold' }, OUTCOMES.IN_PROGRESS],
    ])('%s', (_label, order, expected) => {
        expect(classifyOrderOutcome(order)).toBe(expected);
    });
});

describe('phone normalization and variants', () => {
    test('every stored spelling of a BD mobile normalizes to one value', () => {
        for (const raw of ['01711111111', '+8801711111111', '8801711111111', '017 1111 1111', '017-1111-1111']) {
            expect(normalizeBdMobile(raw)).toBe('01711111111');
        }
    });

    test('variants cover the spellings orders are stored with', () => {
        expect(phoneVariants('+8801711111111')).toEqual(['01711111111', '+8801711111111', '8801711111111']);
    });

    test('an invalid number never produces a variant, so it can never associate two records', () => {
        for (const raw of [null, undefined, '', '12345', '0241234567', 'Customer', '01211111111']) {
            expect(phoneVariants(raw)).toEqual([]);
        }
    });
});

describe('summarizeOrders', () => {
    test('counts outcomes and only recorded values; cancelled orders add no value', () => {
        const summary = summarizeOrders([
            { total: '1000.00', delivery_status: 'delivered', created_at: '2026-09-01T00:00:00Z', delivered_at: '2026-09-03T00:00:00Z' },
            { total: 500, delivery_status: 'returned', delivery_consignment_id: 'C2', created_at: '2026-09-05T00:00:00Z' },
            { total: 300, order_status: 'cancelled', created_at: '2026-09-06T00:00:00Z' },
            { total: 700, order_status: 'confirmed', createdAt: '2026-09-07T00:00:00Z' },
        ]);
        expect(summary).toMatchObject({
            total_orders: 4,
            delivered_orders: 1,
            returned_orders: 1,
            cancelled_orders: 1,
            in_progress_orders: 1,
            ordered_value: 2200,
            delivered_value: 1000,
            first_order_at: '2026-09-01T00:00:00.000Z',
            last_order_at: '2026-09-07T00:00:00.000Z',
            last_delivered_at: '2026-09-03T00:00:00.000Z',
        });
    });

    test('does not include a dispatched courier cancellation in returned-order stats', () => {
        const summary = summarizeOrders([{
            total: 300,
            order_status: 'cancelled',
            delivery_status: 'cancelled',
            delivery_tracking_code: 'T1',
        }]);

        expect(summary).toMatchObject({ returned_orders: 0, cancelled_orders: 1 });
    });

    test('partial delivery is not included in delivered order counts or value', () => {
        const summary = summarizeOrders([{
            total: 1250,
            delivery_status: 'partial_delivered',
            order_status: 'processing',
        }]);

        expect(summary).toMatchObject({
            delivered_orders: 0,
            in_progress_orders: 1,
            delivered_value: 0,
        });
    });

    test('empty history', () => {
        expect(summarizeOrders([])).toMatchObject({ total_orders: 0, delivered_value: 0, last_order_at: null });
    });
});

describe('deriveCustomerState', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    const summary = (overrides) => ({
        total_orders: 0, delivered_orders: 0, returned_orders: 0, cancelled_orders: 0, ...overrides,
    });
    const recent = '2026-09-20T00:00:00Z';

    test('NEW with no orders and no opportunity', () => {
        expect(deriveCustomerState({ summary: summary(), lastActivityAt: recent }, now).state).toBe(STATES.NEW);
    });

    test('INTERESTED when a live opportunity exists and nothing was ordered', () => {
        const result = deriveCustomerState({ summary: summary(), lastActivityAt: recent, hasLiveOpportunity: true }, now);
        expect(result).toMatchObject({ state: STATES.INTERESTED, reasons: [{ code: 'OPEN_OPPORTUNITY' }] });
    });

    test('BUYER with one non-cancelled order', () => {
        expect(deriveCustomerState({ summary: summary({ total_orders: 1 }), lastActivityAt: recent }, now).state)
            .toBe(STATES.BUYER);
    });

    test('a cancelled-only customer is not a buyer', () => {
        expect(deriveCustomerState({
            summary: summary({ total_orders: 1, cancelled_orders: 1 }), lastActivityAt: recent,
        }, now).state).toBe(STATES.NEW);
    });

    test('REPEAT_BUYER with at least two successful deliveries', () => {
        const result = deriveCustomerState({
            summary: summary({ total_orders: 3, delivered_orders: 2 }), lastActivityAt: recent,
        }, now);
        expect(result).toMatchObject({ state: STATES.REPEAT_BUYER, reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 2 } }] });
    });

    test('AT_RISK takes precedence when returns are not fewer than deliveries', () => {
        const result = deriveCustomerState({
            summary: summary({ total_orders: 4, delivered_orders: 2, returned_orders: 2 }), lastActivityAt: recent,
        }, now);
        expect(result).toMatchObject({
            state: STATES.AT_RISK,
            reasons: [{ code: 'RETURNS_NOT_LESS_THAN_DELIVERIES', params: { returned: 2, delivered: 2 } }],
        });
    });

    test('INACTIVE after the threshold of no activity, even for a repeat buyer', () => {
        const old = new Date(now.getTime() - (INACTIVE_AFTER_DAYS + 5) * 86400000).toISOString();
        const result = deriveCustomerState({
            summary: summary({ total_orders: 3, delivered_orders: 3 }), lastActivityAt: old,
        }, now);
        expect(result.state).toBe(STATES.INACTIVE);
        expect(result.reasons[0].params.days).toBe(INACTIVE_AFTER_DAYS + 5);
    });

    test('every state carries its rules version', () => {
        expect(deriveCustomerState({ summary: summary() }, now).rules_version).toBe('customer-state/1.0.0');
    });
});
