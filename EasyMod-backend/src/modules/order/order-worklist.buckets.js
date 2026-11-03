/**
 * Orders worklist buckets — one predicate source for the list filter and the
 * counters.
 *
 * The worklist chips and the filtered list must never disagree, so both are
 * derived from BUCKET_DEFINITIONS below: `buildBucketWhere` renders the
 * definitions for Sequelize, `buildBucketSql` renders the same definitions for
 * the single aggregate that powers GET /api/order/counts. Adding a status to a
 * bucket changes both at once.
 *
 * Vocabulary provenance (no assumptions): the delivery statuses here are the
 * ones the code actually writes and reads —
 *   - booked/picked_up/in_transit/out_for_delivery/delivered/partial_delivered/
 *     failed_delivery/returned/partial_returned/cancelled/unknown
 *     (delivery-tracking.service.js SAFE_LOG_STATUSES + normalizeRegistryStatus)
 *   - courier_setup_required / dispatch_indeterminate (order.service.js:46-47)
 *   - confidence_hold (order.service.js:49, written on the booking gate)
 * `delivery_status` is a free STRING column, so anything outside this set is
 * deliberately NOT bucketed: an unknown value shows in "All" only rather than
 * being silently claimed by a bucket.
 */

const { Op } = require('sequelize');

// A delivery that has not started. NULL is the column default for a new order;
// the two strings are what older writes used instead of NULL.
const UNSTARTED_DELIVERY_STATUSES = Object.freeze([null, '', 'unfulfilled', 'not_booked']);

const BUCKET_DEFINITIONS = Object.freeze([
    { key: 'to_confirm', orderStatus: Object.freeze(['draft', 'pending']) },
    {
        key: 'to_pack',
        orderStatus: Object.freeze(['confirmed', 'processing']),
        deliveryStatus: UNSTARTED_DELIVERY_STATUSES,
    },
    { key: 'booked', deliveryStatus: Object.freeze(['booked']) },
    {
        key: 'in_transit',
        deliveryStatus: Object.freeze(['picked_up', 'in_transit', 'out_for_delivery']),
    },
    {
        key: 'needs_action',
        deliveryStatus: Object.freeze([
            'failed_delivery',
            'dispatch_indeterminate',
            'courier_setup_required',
            'confidence_hold',
        ]),
    },
    { key: 'returned', deliveryStatus: Object.freeze(['returned', 'partial_returned']) },
    { key: 'delivered', deliveryStatus: Object.freeze(['delivered', 'partial_delivered']) },
]);

const BUCKET_KEYS = Object.freeze(BUCKET_DEFINITIONS.map((bucket) => bucket.key));

const getBucket = (key) => {
    const bucket = BUCKET_DEFINITIONS.find((candidate) => candidate.key === key);
    if (!bucket) {
        const error = new Error(`Unknown order worklist bucket: ${key}`);
        error.code = 'ORDER_WORKLIST_BUCKET_UNKNOWN';
        throw error;
    }
    return bucket;
};

const deliveryStatusPredicate = (statuses) => {
    const values = statuses.filter((status) => status !== null);
    const matchesNull = statuses.includes(null);

    if (!matchesNull) return { delivery_status: { [Op.in]: [...values] } };

    const alternatives = [{ delivery_status: null }];
    if (values.length) alternatives.unshift({ delivery_status: { [Op.in]: [...values] } });
    return alternatives.length === 1 ? alternatives[0] : { [Op.or]: alternatives };
};

/**
 * Sequelize `where` fragment for a bucket. Callers must AND this with the shop
 * scope; a bucket alone is never tenant-scoped.
 */
const buildBucketWhere = (key) => {
    const bucket = getBucket(key);
    const clauses = [];
    if (bucket.orderStatus) clauses.push({ order_status: { [Op.in]: [...bucket.orderStatus] } });
    if (bucket.deliveryStatus) clauses.push(deliveryStatusPredicate(bucket.deliveryStatus));
    return clauses.length === 1 ? clauses[0] : { [Op.and]: clauses };
};

const quoteList = (values) => values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');

/**
 * SQL predicate for the same bucket, for the counter aggregate. Values come
 * only from the frozen definitions above, never from a request.
 */
const buildBucketSql = (key) => {
    const bucket = getBucket(key);
    const parts = [];
    if (bucket.orderStatus) parts.push(`order_status IN (${quoteList(bucket.orderStatus)})`);
    if (bucket.deliveryStatus) {
        const values = bucket.deliveryStatus.filter((status) => status !== null);
        const alternatives = [];
        if (values.length) alternatives.push(`delivery_status IN (${quoteList(values)})`);
        if (bucket.deliveryStatus.includes(null)) alternatives.push('delivery_status IS NULL');
        parts.push(alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(' OR ')})`);
    }
    return parts.join(' AND ');
};

module.exports = {
    BUCKET_DEFINITIONS,
    BUCKET_KEYS,
    UNSTARTED_DELIVERY_STATUSES,
    buildBucketWhere,
    buildBucketSql,
};