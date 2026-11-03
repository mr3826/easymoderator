/**
 * Orders worklist buckets — the predicates behind both the list filter and the
 * counter chips. A drift between the two would show a chip count that the list
 * cannot reproduce, so the definitions are asserted, not assumed.
 */

const { Op } = require('sequelize');
const {
    BUCKET_DEFINITIONS,
    BUCKET_KEYS,
    UNSTARTED_DELIVERY_STATUSES,
    buildBucketWhere,
    buildBucketSql,
} = require('../order-worklist.buckets');

// The delivery values this system actually writes. Sourced from
// delivery-tracking.service.js SAFE_LOG_STATUSES and the order.service.js
// constants; anything outside this set must not be silently bucketed.
const TRACKED_DELIVERY_STATUSES = new Set([
    'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered',
    'partial_delivered', 'failed_delivery', 'returned', 'partial_returned',
    'cancelled', 'unknown',
    'courier_setup_required', 'dispatch_indeterminate', 'confidence_hold',
    'unfulfilled', 'not_booked', '',
]);

describe('order worklist buckets', () => {
    it('exposes the seven worklist buckets in display order', () => {
        expect(BUCKET_KEYS).toEqual([
            'to_confirm', 'to_pack', 'booked', 'in_transit',
            'needs_action', 'returned', 'delivered',
        ]);
    });

    it('only buckets delivery values the system actually writes', () => {
        for (const bucket of BUCKET_DEFINITIONS) {
            for (const status of bucket.deliveryStatus || []) {
                if (status === null) continue;
                expect(TRACKED_DELIVERY_STATUSES.has(status)).toBe(true);
            }
        }
    });

    it('never lets two delivery buckets claim the same status', () => {
        const claimed = new Map();
        for (const bucket of BUCKET_DEFINITIONS) {
            if (!bucket.deliveryStatus) continue;
            for (const status of bucket.deliveryStatus) {
                if (status === null) continue;
                const previous = claimed.get(status);
                if (previous) {
                    // to_pack shares the "not booked" strings with no other
                    // bucket, so a shared status is a real defect.
                    throw new Error(`${status} is claimed by both ${previous} and ${bucket.key}`);
                }
                claimed.set(status, bucket.key);
            }
        }
    });

    it('builds a Sequelize predicate for every bucket', () => {
        for (const key of BUCKET_KEYS) {
            expect(buildBucketWhere(key)).toBeDefined();
        }
    });

    it('treats NULL and the legacy unstarted strings as not yet booked', () => {
        expect(buildBucketWhere('to_pack')).toEqual({
            [Op.and]: [
                { order_status: { [Op.in]: ['confirmed', 'processing'] } },
                {
                    [Op.or]: [
                        { delivery_status: { [Op.in]: ['', 'unfulfilled', 'not_booked'] } },
                        { delivery_status: null },
                    ],
                },
            ],
        });
        expect(UNSTARTED_DELIVERY_STATUSES).toContain(null);
    });

    it('matches a single-status bucket without an OR wrapper', () => {
        expect(buildBucketWhere('booked')).toEqual({ delivery_status: { [Op.in]: ['booked'] } });
    });

    it('renders the counter SQL from the same definition as the list filter', () => {
        // The two renderers must agree status-for-status, or a chip would
        // count rows the list cannot return.
        for (const bucket of BUCKET_DEFINITIONS) {
            const sql = buildBucketSql(bucket.key);
            for (const status of bucket.deliveryStatus || []) {
                if (status === null) {
                    expect(sql).toContain('delivery_status IS NULL');
                } else {
                    expect(sql).toContain(`'${status}'`);
                }
            }
            for (const status of bucket.orderStatus || []) {
                expect(sql).toContain(`'${status}'`);
            }
        }
    });

    it('renders an exact, reviewable SQL predicate', () => {
        // Values come only from the frozen definitions, and quoteList()
        // escapes any quote a future value might carry; pin the formatting so
        // the aggregate stays readable in logs and query plans.
        expect(buildBucketSql('delivered')).toBe("delivery_status IN ('delivered', 'partial_delivered')");
    });

    it('rejects an unknown bucket with a typed error', () => {
        expect(() => buildBucketWhere('everything')).toThrow(/Unknown order worklist bucket/);
        try {
            buildBucketSql('everything');
            throw new Error('expected buildBucketSql to throw');
        } catch (error) {
            expect(error.code).toBe('ORDER_WORKLIST_BUCKET_UNKNOWN');
        }
    });
});