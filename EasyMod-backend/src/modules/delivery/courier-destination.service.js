'use strict';

/**
 * Courier destination extraction and serviceability resolution.
 *
 * Why this exists (launch audit 2026-11-03): `buildCourierOrderData` emitted
 * no destination keys, and the RedX registry chain fell through to
 * `metadata.delivery_area_id` / `pickup.area_id` — the merchant's own pickup
 * area. Every RedX booking therefore targeted the wrong area unless the
 * provider rejected it. Destination must come from the ORDER, and a provider
 * directory hit is the only thing that may be called a serviceability verdict.
 *
 * Decisions are deliberately conservative:
 *   SERVICEABLE      — a directory entry matched the order's destination.
 *   NOT_SERVICEABLE  — the directory was readable and had no match.
 *   UNCERTAIN        — cannot decide (missing details, empty directory,
 *                      ambiguous match, provider has no directory at all).
 *   CHECK_UNAVAILABLE— the directory lookup itself failed. Never fail open.
 */

const CACHE_TTL_MS = 300 * 1000;
const LOOKUP_TIMEOUT_MS = 5000;

const DECISIONS = Object.freeze({
    SERVICEABLE: 'SERVICEABLE',
    NOT_SERVICEABLE: 'NOT_SERVICEABLE',
    UNCERTAIN: 'UNCERTAIN',
    CHECK_UNAVAILABLE: 'CHECK_UNAVAILABLE',
});

/** Definitive verdicts only; uncertainty is cheap to re-question. */
const cache = new Map();

const clearCache = () => cache.clear();

const normalizeProvider = (provider) => String(provider ?? '').trim().toLowerCase();

const normalizeName = (value) => String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const isPresent = (value) => value !== undefined && value !== null && String(value).trim() !== '';

const firstValue = (...values) => {
    for (const value of values) {
        if (isPresent(value)) return value;
    }
    return null;
};

const firstText = (...values) => {
    const value = firstValue(...values);
    return value === null ? null : String(value).trim();
};

const parseObject = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }
    return null;
};

const addressTextFrom = (address, fallback = null) => {
    if (!address) return fallback;
    const fields = [
        'street_address', 'address', 'road', 'house', 'area', 'upazila',
        'thana', 'district', 'city', 'postal_code',
    ];
    const parts = fields
        .map((key) => address[key])
        .filter(isPresent)
        .map((part) => String(part).trim());
    if (parts.length) return parts.join(', ');
    return fallback;
};

/**
 * Extract the order's own destination. Nothing here reads integration or
 * pickup metadata: a destination that did not come from the order does not
 * belong in a delivery payload.
 */
const extractDestinationFromOrder = (order = {}, { provider = null } = {}) => {
    const location = parseObject(order?.delivery_location) || {};
    const address = parseObject(order?.delivery_address) || {};
    const plainAddress = typeof order?.delivery_address === 'string' ? order.delivery_address : null;
    // A merchant-confirmed selection is stored under the courier's OWN key.
    // It wins over the unconfirmed text fields, and it is never read for a
    // different courier: a RedX area id means nothing to Pathao.
    const providerKey = provider ? normalizeProvider(provider) : null;
    const recordedSelection = providerKey
        ? parseObject(parseObject(location.provider_destination)?.[providerKey])
        : null;
    // Only the confirmation endpoint writes all three fields. Order intake
    // text and legacy unnamespaced ids remain candidates for a fresh directory
    // lookup, never trusted routing ids during an outage or kill-switch mode.
    const confirmed = recordedSelection?.source === 'merchant_confirmed'
        && isPresent(recordedSelection.confirmed_at)
        && isPresent(recordedSelection.confirmed_by)
        ? recordedSelection
        : null;

    const areaName = firstText(
        confirmed?.area_name,
        order?.delivery_area,
        location.area_name, location.area, address.area, address.area_name,
        // The BD administrative list behind the intake forms calls a city
        // thana an "upazila"; the courier directories call the same place an
        // area. Without this fallback every first-party order would be
        // unaddressable for RedX even though its thana was recorded.
        address.upazila,
    );
    const zoneName = firstText(
        confirmed?.zone_name,
        location.zone_name, location.zone,
        address.zone, address.upazila, address.thana,
        order?.delivery_zone,
    );
    const cityName = firstText(
        confirmed?.city_name,
        location.city_name, location.city,
        address.city, address.district,
    );
    const district = firstText(
        confirmed?.district,
        location.district, location.district_name,
        address.district, address.city,
    );
    const postcode = firstText(
        confirmed?.postcode,
        location.postcode, location.postal_code,
        address.postal_code, address.postcode,
    );

    return {
        area_id: firstValue(confirmed?.area_id, location.area_id, location.areaId, address.area_id, address.areaId),
        area_name: areaName,
        zone_id: firstValue(confirmed?.zone_id, location.zone_id, location.zoneId, address.zone_id, address.zoneId),
        zone_name: zoneName,
        city_id: firstValue(confirmed?.city_id, location.city_id, location.cityId, address.city_id, address.cityId),
        city_name: cityName,
        district,
        postcode,
        text: addressTextFrom(address, firstText(location.full_address, plainAddress)),
        provider_confirmed: Boolean(confirmed),
        confirmed_at: confirmed?.confirmed_at || null,
    };
};

const withTimeout = async (promise, timeoutMs) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('Courier destination lookup timed out');
                    error.code = 'LOOKUP_TIMEOUT';
                    reject(error);
                }, timeoutMs);
                if (typeof timer?.unref === 'function') timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const listFrom = (response) => {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.areas)) return response.areas;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.data?.areas)) return response.data.areas;
    return [];
};

const pickId = (entry) => firstValue(entry?.id, entry?.area_id, entry?.areaId, entry?.zone_id, entry?.zoneId, entry?.city_id, entry?.cityId);
const pickName = (entry) => firstText(entry?.name, entry?.area_name, entry?.areaName, entry?.zone_name, entry?.zoneName, entry?.city_name, entry?.cityName);
const pickDistrict = (entry) => firstText(entry?.district_name, entry?.districtName, entry?.district, entry?.city_name, entry?.cityName);
const pickPostcode = (entry) => firstText(entry?.postcode, entry?.post_code, entry?.postal_code);

const baseResult = (provider, destination) => ({
    provider,
    destination,
    source: 'order_destination',
    checked_at: new Date().toISOString(),
    ttl_seconds: Math.round(CACHE_TTL_MS / 1000),
});

const decide = (base, decision, reasonCode, extraDestination = null) => ({
    ...base,
    decision,
    reason_code: reasonCode,
    ...(extraDestination ? { destination: extraDestination } : {}),
});

const cacheKeyFor = (shopId, provider, destination) => [
    shopId, provider,
    normalizeName(destination.area_name),
    normalizeName(destination.district),
    normalizeName(destination.city_name),
    normalizeName(destination.zone_name),
    destination.postcode || '',
    destination.area_id ?? '',
].join('|');

const resolveRedX = async (providerInstance, destination, timeoutMs) => {
    if (!destination.area_name && !destination.area_id) {
        return decide(baseResult('redx', destination), DECISIONS.UNCERTAIN, 'INSUFFICIENT_DESTINATION');
    }

    const filters = destination.postcode
        ? { postcode: destination.postcode }
        : destination.district
            ? { district: destination.district }
            : {};

    let areas;
    try {
        areas = listFrom(await withTimeout(providerInstance.getAreas(filters), timeoutMs));
    } catch (_) {
        return decide(baseResult('redx', destination), DECISIONS.CHECK_UNAVAILABLE, 'LOOKUP_FAILED');
    }

    if (!areas.length) {
        return decide(baseResult('redx', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_EMPTY');
    }

    let candidates = destination.area_id !== null && destination.area_id !== undefined
        ? areas.filter((area) => String(pickId(area)) === String(destination.area_id))
        : areas.filter((area) => normalizeName(pickName(area)) === normalizeName(destination.area_name));

    if (candidates.length === 1) {
        const match = candidates[0];
        return decide(baseResult('redx', destination), DECISIONS.SERVICEABLE, 'AREA_MATCHED', {
            ...destination,
            area_id: pickId(match),
            area_name: pickName(match) || destination.area_name,
            district: destination.district || pickDistrict(match),
            postcode: destination.postcode || pickPostcode(match),
        });
    }

    if (candidates.length > 1) {
        const district = normalizeName(destination.district || destination.city_name);
        if (district) {
            candidates = candidates.filter((area) => normalizeName(pickDistrict(area)) === district);
        }
        if (candidates.length === 1) {
            const match = candidates[0];
            return decide(baseResult('redx', destination), DECISIONS.SERVICEABLE, 'AREA_MATCHED', {
                ...destination,
                area_id: pickId(match),
                area_name: pickName(match) || destination.area_name,
                district: destination.district || pickDistrict(match),
                postcode: destination.postcode || pickPostcode(match),
            });
        }
        return decide(baseResult('redx', destination), DECISIONS.UNCERTAIN, 'AMBIGUOUS_MATCH');
    }

    return decide(baseResult('redx', destination), DECISIONS.NOT_SERVICEABLE, 'NO_AREA_MATCH');
};

const resolvePathao = async (providerInstance, destination, timeoutMs) => {
    const cityName = destination.city_name || destination.district;
    // A merchant-confirmed selection supplies ids instead of names; either is
    // enough to ask the directory, and asking is what turns it into a verdict.
    if ((!cityName && !isPresent(destination.city_id))
        || (!destination.area_name && !isPresent(destination.area_id))) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'INSUFFICIENT_DESTINATION');
    }

    let cities;
    let zones;
    let areas;
    try {
        cities = listFrom(await withTimeout(providerInstance.getCities(), timeoutMs));
    } catch (_) {
        return decide(baseResult('pathao', destination), DECISIONS.CHECK_UNAVAILABLE, 'LOOKUP_FAILED');
    }
    if (!cities.length) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_EMPTY');
    }

    const city = isPresent(destination.city_id)
        ? cities.find((entry) => String(pickId(entry)) === String(destination.city_id))
        : cities.find((entry) => normalizeName(pickName(entry)) === normalizeName(cityName));
    if (!city) {
        return decide(baseResult('pathao', destination), DECISIONS.NOT_SERVICEABLE, 'CITY_NOT_FOUND');
    }
    const cityId = firstValue(pickId(city), destination.city_id);
    if (!isPresent(cityId)) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_INCOMPLETE');
    }

    if (!destination.zone_name && !isPresent(destination.zone_id)) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'INSUFFICIENT_DESTINATION');
    }

    try {
        zones = listFrom(await withTimeout(providerInstance.getZones(cityId), timeoutMs));
    } catch (_) {
        return decide(baseResult('pathao', destination), DECISIONS.CHECK_UNAVAILABLE, 'LOOKUP_FAILED');
    }
    if (!zones.length) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_EMPTY');
    }

    const zone = isPresent(destination.zone_id)
        ? zones.find((entry) => String(pickId(entry)) === String(destination.zone_id))
        : zones.find((entry) => normalizeName(pickName(entry)) === normalizeName(destination.zone_name));
    if (!zone) {
        return decide(baseResult('pathao', destination), DECISIONS.NOT_SERVICEABLE, 'ZONE_NOT_FOUND');
    }
    const zoneId = firstValue(pickId(zone), destination.zone_id);
    if (!isPresent(zoneId)) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_INCOMPLETE');
    }

    try {
        areas = listFrom(await withTimeout(providerInstance.getAreas(zoneId), timeoutMs));
    } catch (_) {
        return decide(baseResult('pathao', destination), DECISIONS.CHECK_UNAVAILABLE, 'LOOKUP_FAILED');
    }
    if (!areas.length) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_EMPTY');
    }

    const area = isPresent(destination.area_id)
        ? areas.find((entry) => String(pickId(entry)) === String(destination.area_id))
        : areas.find((entry) => normalizeName(pickName(entry)) === normalizeName(destination.area_name));
    if (!area) {
        return decide(baseResult('pathao', destination), DECISIONS.NOT_SERVICEABLE, 'AREA_NOT_FOUND');
    }
    const areaId = firstValue(pickId(area), destination.area_id);
    if (!isPresent(areaId)) {
        return decide(baseResult('pathao', destination), DECISIONS.UNCERTAIN, 'DIRECTORY_INCOMPLETE');
    }

    return decide(baseResult('pathao', destination), DECISIONS.SERVICEABLE, 'AREA_MATCHED', {
        ...destination,
        city_id: cityId,
        city_name: pickName(city) || cityName,
        zone_id: zoneId,
        zone_name: pickName(zone) || destination.zone_name,
        area_id: areaId,
        area_name: pickName(area) || destination.area_name,
    });
};

/**
 * Resolve a provider serviceability verdict for one order's destination.
 * Network access happens here and only here; callers pass the already
 * connected provider instance.
 */
const resolveDestination = async ({
    shopId,
    provider,
    order,
    // A merchant-confirmed selection is passed in as an explicit destination:
    // it replaces extraction so the verdict answers "is THIS selection in the
    // directory?", not "does the order's text match something?".
    destination: providedDestination = null,
    providerInstance = null,
    timeoutMs = LOOKUP_TIMEOUT_MS,
    useCache = true,
} = {}) => {
    const name = normalizeProvider(provider);
    const destination = providedDestination
        ? { ...providedDestination }
        : extractDestinationFromOrder(order, { provider: name });
    const base = baseResult(name, destination);

    if (name === 'steadfast') {
        return decide(base, DECISIONS.UNCERTAIN, 'PROVIDER_HAS_NO_DIRECTORY');
    }

    if (!providerInstance || typeof providerInstance.getAreas !== 'function' && name === 'redx') {
        return decide(base, DECISIONS.CHECK_UNAVAILABLE, 'PROVIDER_UNAVAILABLE');
    }

    const key = cacheKeyFor(shopId, name, destination);
    if (useCache) {
        const hit = cache.get(key);
        if (hit && hit.expiresAt > Date.now()) {
            return { ...hit.value, cached: true };
        }
        if (hit) cache.delete(key);
    }

    let result;
    if (name === 'redx') {
        result = await resolveRedX(providerInstance, destination, timeoutMs);
    } else if (name === 'pathao') {
        result = await resolvePathao(providerInstance, destination, timeoutMs);
    } else {
        result = decide(base, DECISIONS.UNCERTAIN, 'PROVIDER_UNSUPPORTED');
    }

    if (useCache && (result.decision === DECISIONS.SERVICEABLE || result.decision === DECISIONS.NOT_SERVICEABLE)) {
        cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return result;
};

/**
 * Apply a resolved destination to the canonical order data. Absent ids stay
 * absent: the registry no longer invents them from pickup metadata.
 */
const applyDestinationToOrderData = (orderData, provider, resolution) => {
    const destination = resolution?.destination;
    if (!orderData || !destination) return orderData;
    const name = normalizeProvider(provider);

    if (name === 'redx') {
        if (isPresent(destination.area_id)) orderData.delivery_area_id = destination.area_id;
        if (isPresent(destination.area_name)) orderData.delivery_area = destination.area_name;
    } else if (name === 'pathao') {
        if (isPresent(destination.city_id)) orderData.recipient_city = destination.city_id;
        if (isPresent(destination.zone_id)) orderData.recipient_zone = destination.zone_id;
        if (isPresent(destination.area_id)) orderData.recipient_area = destination.area_id;
    }

    return orderData;
};

/**
 * The ids a merchant must name to confirm a destination for one courier.
 * Confirmation is per provider because the ids are: a RedX area id is not a
 * Pathao area id, and storing one as the other is the defect this guards.
 */
const REQUIRED_SELECTION_FIELDS = Object.freeze({
    redx: Object.freeze(['area_id']),
    pathao: Object.freeze(['city_id', 'zone_id', 'area_id']),
});

const buildDestinationSelection = (provider, input = {}) => {
    const name = normalizeProvider(provider);
    const required = REQUIRED_SELECTION_FIELDS[name];
    if (!required) {
        return { ok: false, code: 'PROVIDER_HAS_NO_DIRECTORY' };
    }
    const source = input && typeof input === 'object' ? input : {};
    const destination = {
        area_id: firstValue(source.area_id, source.areaId),
        area_name: firstText(source.area_name, source.areaName),
        zone_id: firstValue(source.zone_id, source.zoneId),
        zone_name: firstText(source.zone_name, source.zoneName),
        city_id: firstValue(source.city_id, source.cityId),
        city_name: firstText(source.city_name, source.cityName),
        district: firstText(source.district),
        postcode: firstText(source.postcode, source.postal_code),
    };
    const missing = required.filter((key) => !isPresent(destination[key]));
    if (missing.length) {
        return { ok: false, code: 'INSUFFICIENT_DESTINATION', missing, destination };
    }
    return { ok: true, destination };
};

/**
 * Store one courier's confirmed ids beside the address the customer gave.
 * Every other courier's entry is left untouched.
 */
const mergeProviderDestination = (deliveryLocation, provider, destination, { actor = null, confirmedAt = null } = {}) => {
    const base = parseObject(deliveryLocation) || {};
    const confirmed = {
        area_id: destination.area_id ?? null,
        area_name: destination.area_name ?? null,
        zone_id: destination.zone_id ?? null,
        zone_name: destination.zone_name ?? null,
        city_id: destination.city_id ?? null,
        city_name: destination.city_name ?? null,
        district: destination.district ?? null,
        postcode: destination.postcode ?? null,
        confirmed_at: confirmedAt || new Date().toISOString(),
        confirmed_by: actor || null,
        source: 'merchant_confirmed',
    };
    return {
        ...base,
        provider_destination: {
            ...(parseObject(base.provider_destination) || {}),
            [normalizeProvider(provider)]: confirmed,
        },
    };
};

module.exports = {
    DECISIONS,
    extractDestinationFromOrder,
    resolveDestination,
    applyDestinationToOrderData,
    buildDestinationSelection,
    mergeProviderDestination,
    clearCache,
    CACHE_TTL_MS,
    LOOKUP_TIMEOUT_MS,
};
