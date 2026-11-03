/**
 * RedX destination exposure audit (launch audit 2026-11-03).
 *
 * READ-ONLY. Issues SELECTs only; never writes, never books, never calls a
 * provider. Run it against a database snapshot to size the blast radius:
 *
 *     node scripts/courier-redx-destination-exposure-audit.js
 *
 * Why: `buildCourierOrderData` emitted NO destination keys before this fix, so
 * the RedX registry chain fell through to `metadata.delivery_area_id` /
 * `pickup.area_id` — the merchant's OWN pickup area. That means the exposure
 * is structural, not address-driven: every RedX parcel booked through the
 * standard path carried the pickup area, whatever the customer's address said.
 * The per-row comparison below still matters, because it sizes how many of
 * those parcels were actually mis-targeted rather than coincidentally correct
 * (customer in the same area as the shop).
 *
 * Remediation of historical shipments is a FOUNDER decision. This script only
 * reports counts; it does not attempt to fix, rebook, notify or cancel.
 */

'use strict';

const path = require('path');

const APP_SRC = path.join(__dirname, '..', 'src');

const parseAddress = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return { street_address: String(value) };
    }
};

const normalize = (value) => String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

async function main() {
    const { sequelize } = require(path.join(APP_SRC, 'utils', 'database', 'database-setup'));

    const [statusRows] = await sequelize.query(`
        SELECT provider, status, COUNT(*)::int AS count
        FROM courier_dispatch
        GROUP BY provider, status
        ORDER BY provider, status
    `);

    const [rows] = await sequelize.query(`
        SELECT
            cd.id,
            cd.shop_id,
            cd.order_id,
            cd.status,
            cd.consignment_id,
            cd.tracking_code,
            cd.created_at,
            o.order_number,
            o.delivery_address,
            o.delivery_location,
            o.delivery_area,
            o.delivery_zone,
            di.provider_pickup_meta
        FROM courier_dispatch cd
        JOIN orders o
          ON o.id = cd.order_id AND o.shop_id = cd.shop_id
        LEFT JOIN delivery_integrations di
          ON di.shop_id = cd.shop_id
         AND LOWER(di.provider) = 'redx'
        WHERE LOWER(cd.provider) = 'redx'
          AND UPPER(cd.status) = 'COMMITTED'
        ORDER BY cd.created_at ASC
    `);

    const summary = {
        generated_at: new Date().toISOString(),
        redx_dispatch_by_status: statusRows.map((row) => ({
            status: row.status,
            count: row.count,
        })),
        committed_redx_dispatches: rows.length,
        structural_exposure:
            'ALL committed RedX dispatches booked before this fix carried the '
            + 'integration pickup area, because no order destination was ever '
            + 'sent. Count below is the subset whose order address indicates a '
            + 'different area — i.e. likely visibly mis-delivered.',
        address_differs_from_pickup_area: 0,
        address_indicates_pickup_area: 0,
        order_has_no_structured_area: 0,
        shops_without_redx_integration: 0,
        earliest_created_at: rows.length ? rows[0].created_at : null,
        latest_created_at: rows.length ? rows[rows.length - 1].created_at : null,
    };

    for (const row of rows) {
        const metadata = row.provider_pickup_meta && typeof row.provider_pickup_meta === 'object'
            ? row.provider_pickup_meta
            : parseAddress(row.provider_pickup_meta);
        const pickup = metadata.pickup || metadata.pickup_mapping || metadata.provider_pickup_meta || {};
        const pickupArea = normalize(
            metadata.delivery_area || metadata.area_name || pickup.area_name || pickup.delivery_area,
        );

        const address = parseAddress(row.delivery_address);
        const location = parseAddress(row.delivery_location);
        const orderArea = normalize(
            location.area_name || location.area || address.area || address.area_name
            || row.delivery_area,
        );

        if (!orderArea) {
            summary.order_has_no_structured_area += 1;
        } else if (!pickupArea) {
            summary.shops_without_redx_integration += 1;
        } else if (orderArea === pickupArea) {
            summary.address_indicates_pickup_area += 1;
        } else {
            summary.address_differs_from_pickup_area += 1;
        }
    }

    console.log(JSON.stringify(summary, null, 2));

    await sequelize.close().catch(() => {});
    process.exit(0);
}

main().catch((error) => {
    console.error('RedX destination exposure audit failed:', error.message);
    process.exit(2);
});