'use strict';

const PathaoProvider = require('./pathao.provider');
const SteadfastProvider = require('./steadfast.provider');
const RedXProvider = require('./redx.provider');

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

function firstPresent(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== '');
}

function pickProviderStore(orderData = {}, metadata = {}) {
    const pickup = metadata.pickup || metadata.pickup_mapping || metadata.provider_pickup_meta || {};
    const orderPickup = orderData.pickup || orderData.pickup_mapping || {};
    return firstPresent(
        metadata.provider_store_id,
        metadata.store_id,
        metadata.pickup_store_id,
        pickup.provider_store_id,
        pickup.store_id,
        pickup.pickup_store_id,
        orderData.provider_store_id,
        orderData.pickup_store_id,
        orderData.store_id,
        orderPickup.provider_store_id,
        orderPickup.store_id,
        orderPickup.pickup_store_id,
    );
}

function normalizeStatus(status, statusMap = {}) {
    if (status === undefined || status === null || status === '') {
        return status;
    }

    const raw = String(status);
    return statusMap[raw] || statusMap[raw.toLowerCase()] || raw;
}

const COURIER_REGISTRY = {
    pathao: {
        Provider: PathaoProvider,
        label: 'Pathao',
        envHosts: {
            production: 'https://api-hermes.pathao.com',
            sandbox: 'https://courier-api-sandbox.pathao.com',
        },
        pickup: {
            requiredFields: ['display_name', 'contact_name', 'phone', 'address', 'city_id', 'zone_id', 'area_id'],
            locationApi: ['cities', 'zones', 'areas'],
            createStoreHook: 'createStore',
            listStoresHook: 'getStores',
        },
        normalizePayload: (orderData = {}, metadata = {}) => {
            const rawWeight = firstPresent(orderData.item_weight, orderData.weight_kg, orderData.weight, 0.5);
            const weight = Number(rawWeight);
            if (!Number.isFinite(weight) || weight < 0.5 || weight > 10) {
                const error = new Error('Pathao parcel weight must be between 0.5 and 10 kg');
                error.code = 'INVALID_WEIGHT';
                error.status = 400;
                throw error;
            }

            const payload = {
                store_id: pickProviderStore(orderData, metadata),
                merchant_order_id: firstPresent(orderData.merchant_order_id, orderData.order_number),
                recipient_name: firstPresent(orderData.recipient_name, orderData.customer_name),
                recipient_phone: firstPresent(orderData.recipient_phone, orderData.customer_phone),
                recipient_address: firstPresent(orderData.recipient_address, orderData.delivery_address),
                delivery_type: orderData.delivery_type ?? 48,
                item_type: orderData.item_type ?? 2,
                special_instruction: firstDefined(orderData.special_instruction, orderData.note, ''),
                item_quantity: orderData.item_quantity ?? 1,
                item_weight: weight,
                item_description: firstDefined(orderData.item_description, ''),
                amount_to_collect: firstPresent(orderData.amount_to_collect, orderData.cod_amount, orderData.total, 0),
            };

            const locationData = orderData.location
                || orderData.delivery_location
                || orderData.destination
                || {};
            const location = {
                // Destination ids may originate only from the order payload.
                // Integration metadata describes the merchant's PICKUP setup,
                // so using it here sends the parcel to the wrong area (launch
                // audit 2026-11-03). Resolution happens in
                // courier-destination.service before this adapter runs.
                recipient_city: firstPresent(
                    orderData.recipient_city,
                    orderData.recipient_city_id,
                    orderData.delivery_city_id,
                    orderData.city_id,
                    locationData.recipient_city,
                    locationData.city_id,
                ),
                recipient_zone: firstPresent(
                    orderData.recipient_zone,
                    orderData.recipient_zone_id,
                    orderData.delivery_zone_id,
                    orderData.zone_id,
                    locationData.recipient_zone,
                    locationData.zone_id,
                ),
                recipient_area: firstPresent(
                    orderData.recipient_area,
                    orderData.recipient_area_id,
                    orderData.delivery_area_id,
                    orderData.area_id,
                    locationData.recipient_area,
                    locationData.area_id,
                ),
            };

            Object.entries(location).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    payload[key] = value;
                }
            });

            return payload;
        },
        normalizeResponse: (response = {}) => {
            const body = response.data?.data && typeof response.data.data === 'object'
                ? response.data.data
                : response.data && typeof response.data === 'object' && !Array.isArray(response.data)
                    ? response.data
                    : response;
            const consignmentId = body.consignment_id || body.tracking_code || body.tracking_id;
            return {
                consignment_id: consignmentId,
                tracking_code: consignmentId,
                status: body.order_status || body.status,
                raw_status: body.order_status || body.status,
                delivery_fee: body.delivery_fee,
            };
        },
        statusMap: {
            pending: 'pending',
            picked_up: 'picked_up',
            in_transit: 'in_transit',
            delivered: 'delivered',
            cancelled: 'cancelled',
            returned: 'returned',
            hold: 'hold',
            Pending: 'pending',
            Picked_Up: 'picked_up',
            In_Transit: 'in_transit',
            Delivered: 'delivered',
            Cancelled: 'cancelled',
            Returned: 'returned',
            Hold: 'hold',
            PACKAGE_RECEIVED: 'picked_up',
            IN_TRANSIT: 'in_transit',
            OUT_FOR_DELIVERY: 'out_for_delivery',
            FAILED_DELIVERY: 'failed_delivery',
            DELIVERED: 'delivered',
            CANCELLED: 'cancelled',
            RETURNED: 'returned',
        },
        credentialFields: ['client_id', 'client_secret', 'username', 'password'],
    },

    steadfast: {
        Provider: SteadfastProvider,
        label: 'Steadfast',
        envHosts: {
            production: 'https://portal.packzy.com/api/v1',
            sandbox: 'https://portal.packzy.com/api/v1',
        },
        pickup: {
            requiredFields: ['display_name', 'contact_name', 'phone', 'address'],
            locationApi: null,
            createStoreHook: null,
            listStoresHook: null,
        },
        normalizePayload: (orderData, metadata = {}) => ({
            invoice: orderData.order_number,
            recipient_name: orderData.customer_name,
            recipient_phone: orderData.customer_phone,
            recipient_address: orderData.delivery_address,
            // Prefer the explicit collection amount (0 for a prepaid order)
            // over `total`, mirroring the Pathao/RedX fallback chains below —
            // `total` remains only as a fallback for callers that never set
            // cod_amount/amount_to_collect.
            cod_amount: firstPresent(orderData.cod_amount, orderData.amount_to_collect, orderData.total, 0),
            note: orderData.note || '',
            item_description: orderData.item_description || '',
            total_lot: orderData.item_quantity || 1,
            delivery_type: orderData.delivery_type || 0,
        }),
        normalizeResponse: (response) => ({
            consignment_id: response.consignment_id,
            tracking_code: response.tracking_code,
            status: response.status,
            raw_status: response.status,
            invoice: response.invoice,
        }),
        statusMap: {
            pending: 'pending',
            in_review: 'in_review',
            hold: 'hold',
            delivered_approval_pending: 'delivered_pending',
            delivered: 'delivered',
            partial_delivered: 'partial_delivered',
            cancelled_approval_pending: 'cancelled_pending',
            cancelled: 'cancelled',
            unknown: 'unknown',
        },
        credentialFields: ['api_key', 'secret_key'],
    },

    redx: {
        Provider: RedXProvider,
        label: 'RedX',
        envHosts: {
            production: 'https://openapi.redx.com.bd/v1.0.0-beta',
            sandbox: 'https://sandbox.redx.com.bd/v1.0.0-beta',
        },
        pickup: {
            requiredFields: ['display_name', 'contact_name', 'phone', 'address', 'area_id'],
            locationApi: ['areas'],
            createStoreHook: 'createPickupStore',
            listStoresHook: 'listPickupStores',
        },
        normalizePayload: (orderData = {}, metadata = {}) => {
            // Destination comes from the ORDER only. `metadata` here is the
            // integration's pickup configuration; falling back to it sent
            // parcels to the merchant's own pickup area (launch audit
            // 2026-11-03). courier-destination.service resolves the order's
            // area before this adapter is reached.
            const deliveryArea = firstPresent(
                orderData.delivery_area,
                orderData.delivery_area_name,
                orderData.area_name,
            );
            const deliveryAreaId = firstPresent(
                orderData.delivery_area_id,
                orderData.area_id,
            );
            const explicitGrams = firstDefined(
                orderData.parcel_weight,
                orderData.weight_grams,
                metadata.parcel_weight,
            );
            const rawWeight = firstPresent(
                orderData.item_weight,
                orderData.weight_kg,
                orderData.weight,
                0.5,
            );
            const explicitWeight = Number(explicitGrams);
            const numericWeight = Number(rawWeight);
            const parcelWeight = Number.isFinite(explicitWeight) && explicitWeight > 0
                ? explicitWeight
                : Number.isFinite(numericWeight) && numericWeight > 0
                    ? (numericWeight <= 10 ? numericWeight * 1000 : numericWeight)
                    : 500;

            const payload = {
                customer_name: firstPresent(orderData.customer_name, orderData.recipient_name),
                customer_phone: firstPresent(orderData.customer_phone, orderData.recipient_phone),
                customer_address: firstPresent(
                    orderData.customer_address,
                    orderData.recipient_address,
                    orderData.delivery_address,
                ),
                merchant_invoice_id: firstPresent(orderData.merchant_invoice_id, orderData.order_number),
                cash_collection_amount: firstPresent(
                    orderData.cash_collection_amount,
                    orderData.amount_to_collect,
                    orderData.cod_amount,
                    orderData.total,
                    0,
                ),
                parcel_weight: parcelWeight,
                instruction: firstDefined(orderData.instruction, orderData.special_instruction, orderData.note, ''),
                value: firstPresent(orderData.value, orderData.item_value, orderData.total, 0),
            };

            // Omit unresolvable destination keys rather than sending null: a
            // null area is still a (wrong) claim that the destination is known.
            if (deliveryArea !== undefined) payload.delivery_area = deliveryArea;
            if (deliveryAreaId !== undefined && deliveryAreaId !== null) {
                payload.delivery_area_id = deliveryAreaId;
            }

            const pickupStoreId = pickProviderStore(orderData, metadata);
            if (pickupStoreId !== undefined) payload.pickup_store_id = pickupStoreId;
            for (const key of ['type', 'is_closed_box', 'parcel_details_json']) {
                if (orderData[key] !== undefined) payload[key] = orderData[key];
            }
            return payload;
        },
        normalizeResponse: (response = {}) => {
            const body = response.parcel && typeof response.parcel === 'object'
                ? response.parcel
                : response.data?.parcel && typeof response.data.parcel === 'object'
                    ? response.data.parcel
                    : response.data && typeof response.data === 'object' && !Array.isArray(response.data)
                        ? response.data
                        : response;
            const trackingCode = body.tracking_number
                || body.tracking_id
                || body.tracking_code
                || body.parcel_id
                || response.tracking_number
                || response.tracking_id
                || response.tracking_code
                || response.parcel_id;
            const status = body.status || body.parcel_status || response.status || response.parcel_status;
            return {
                consignment_id: body.consignment_id || response.consignment_id || trackingCode,
                tracking_code: trackingCode,
                status,
                raw_status: status,
            };
        },
        statusMap: {
            initiated: 'pending',
            'pickup-pending': 'pending',
            'ready-for-delivery': 'picked_up',
            'delivery-in-progress': 'out_for_delivery',
            'agent-hold': 'hold',
            'agent-returning': 'returning',
            'agent-area-change': 'in_transit',
            delivered: 'delivered',
            returned: 'returned',
            paid: 'paid',
            'partial-delivered': 'partial_delivered',
            'partial-returned': 'partial_returned',
            cancelled: 'cancelled',
            Initiated: 'pending',
            'Pickup-Pending': 'pending',
            'Ready-For-Delivery': 'picked_up',
            'Delivery-In-Progress': 'out_for_delivery',
            Delivered: 'delivered',
            Returned: 'returned',
            'Picked Up': 'picked_up',
            'In Transit': 'in_transit',
            Cancelled: 'cancelled',
            'Partially Returned': 'partial_returned',
            Hold: 'hold',
            PICKED: 'picked_up',
            TRANSIT: 'in_transit',
            OUT_FOR_DELIVERY: 'out_for_delivery',
            FAILED: 'failed_delivery',
            DELIVERED: 'delivered',
            CANCELLED: 'cancelled',
            RETURNED: 'returned',
        },
        credentialFields: ['api_key'],
    },
};

const PROVIDER_NAMES = Object.keys(COURIER_REGISTRY);

module.exports = {
    COURIER_REGISTRY,
    PROVIDER_NAMES,
    normalizeStatus,
};
