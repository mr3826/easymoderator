'use strict';

/**
 * Courier destination resolution — the P0 fix for RedX mis-addressing.
 *
 * Before this service, `buildCourierOrderData` emitted no destination keys at
 * all, and the RedX registry chain fell through to `metadata.*` / `pickup.*` —
 * the merchant's OWN pickup area. Every RedX booking therefore targeted the
 * wrong area unless the provider happened to reject it.
 *
 * Contract under test:
 *   - Destination comes from the ORDER (delivery_location JSON, delivery_address
 *     object, or the legacy delivery_area/delivery_zone columns) and nowhere else.
 *   - RedX: directory lookup -> SERVICEABLE / NOT_SERVICEABLE / UNCERTAIN /
 *     CHECK_UNAVAILABLE; an ambiguous name match is never resolved by guessing.
 *   - Pathao: city -> zone -> area walk; required ids are returned only after a
 *     real directory hit.
 *   - Steadfast: no directory exists, so the honest answer is UNCERTAIN.
 *   - Lookup failures never fail open as "serviceable".
 *   - Definitive verdicts are cached briefly; lookup failures are not.
 */

const destinationService = require('../courier-destination.service');

const redxAreas = jest.fn();
const redxInstance = { getAreas: redxAreas };

const pathaoInstance = {
    getCities: jest.fn(),
    getZones: jest.fn(),
    getAreas: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    destinationService.clearCache();
});

const orderWithAddress = (address, extra = {}) => ({
    id: 'order-1',
    delivery_address: address,
    ...extra,
});

describe('extractDestinationFromOrder', () => {
    test('reads the structured delivery_address object', () => {
        const destination = destinationService.extractDestinationFromOrder(orderWithAddress({
            street_address: 'House 4, Road 2',
            area: 'Dhanmondi',
            upazila: 'Dhanmondi',
            district: 'Dhaka',
            postal_code: '1209',
        }));

        expect(destination).toMatchObject({
            area_name: 'Dhanmondi',
            zone_name: 'Dhanmondi',
            city_name: 'Dhaka',
            postcode: '1209',
        });
        expect(destination.text).toContain('House 4, Road 2');
    });

    test('reads a JSON-encoded delivery_location with explicit provider ids', () => {
        const destination = destinationService.extractDestinationFromOrder({
            delivery_location: JSON.stringify({
                area_id: 'area-9',
                area: 'Mirpur',
                zone: 'Mirpur',
                city: 'Dhaka',
            }),
        });

        expect(destination).toMatchObject({
            area_id: 'area-9',
            area_name: 'Mirpur',
            zone_name: 'Mirpur',
            city_name: 'Dhaka',
        });
    });

    test('falls back to the legacy delivery_area / delivery_zone columns', () => {
        const destination = destinationService.extractDestinationFromOrder({
            delivery_area: 'Uttara',
            delivery_zone: 'Dhaka North',
        });

        expect(destination).toMatchObject({
            area_name: 'Uttara',
            zone_name: 'Dhaka North',
        });
    });

    test('returns an empty destination rather than inventing one', () => {
        expect(destinationService.extractDestinationFromOrder({})).toMatchObject({
            area_name: null,
            area_id: null,
            city_name: null,
        });
    });
});

describe('resolveDestination — RedX', () => {
    test('matches a directory area by name and district', async () => {
        redxAreas.mockResolvedValue([
            { id: 1, name: 'Mirpur', district_name: 'Dhaka', postcode: '1216' },
            { id: 2, name: 'Gulshan', district_name: 'Dhaka', postcode: '1212' },
        ]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'mirpur', district: 'Dhaka' }),
        });

        expect(result).toMatchObject({
            provider: 'redx',
            decision: 'SERVICEABLE',
            reason_code: 'AREA_MATCHED',
            ttl_seconds: 300,
        });
        expect(result.destination).toMatchObject({ area_id: 1, area_name: 'Mirpur' });
        expect(redxAreas).toHaveBeenCalledWith({ district: 'Dhaka' });
    });

    test('reports NOT_SERVICEABLE when the directory has no match', async () => {
        redxAreas.mockResolvedValue([{ id: 1, name: 'Mirpur', district_name: 'Dhaka' }]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Atlantis', district: 'Dhaka' }),
        });

        expect(result.decision).toBe('NOT_SERVICEABLE');
        expect(result.reason_code).toBe('NO_AREA_MATCH');
        expect(result.destination.area_id).toBeNull();
    });

    test('an ambiguous match without a district is UNCERTAIN, never a guess', async () => {
        redxAreas.mockResolvedValue([
            { id: 1, name: 'Sadar', district_name: 'Dhaka' },
            { id: 2, name: 'Sadar', district_name: 'Chattogram' },
        ]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Sadar' }),
        });

        expect(result.decision).toBe('UNCERTAIN');
        expect(result.reason_code).toBe('AMBIGUOUS_MATCH');
        expect(result.destination.area_id).toBeNull();
    });

    test('an explicit area id is verified against the directory', async () => {
        redxAreas.mockResolvedValue([{ id: 7, name: 'Banani', district_name: 'Dhaka' }]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({}, {
                delivery_location: JSON.stringify({ area_id: 7, area: 'Banani', district: 'Dhaka' }),
            }),
        });

        expect(result).toMatchObject({ decision: 'SERVICEABLE', reason_code: 'AREA_MATCHED' });
        expect(result.destination.area_id).toBe(7);
    });

    test('a provider lookup failure is CHECK_UNAVAILABLE, not SERVICEABLE', async () => {
        redxAreas.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });

        expect(result.decision).toBe('CHECK_UNAVAILABLE');
        expect(result.reason_code).toBe('LOOKUP_FAILED');
    });

    test('a directory that cannot be read is UNCERTAIN, not a false negative', async () => {
        redxAreas.mockResolvedValue([]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });

        expect(result.decision).toBe('UNCERTAIN');
        expect(result.reason_code).toBe('DIRECTORY_EMPTY');
    });

    test('missing destination details are UNCERTAIN', async () => {
        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ street_address: 'Somewhere' }),
        });

        expect(result.decision).toBe('UNCERTAIN');
        expect(result.reason_code).toBe('INSUFFICIENT_DESTINATION');
        expect(redxAreas).not.toHaveBeenCalled();
    });
});

describe('resolveDestination — Pathao', () => {
    beforeEach(() => {
        pathaoInstance.getCities.mockResolvedValue([{ city_id: 1, city_name: 'Dhaka' }]);
        pathaoInstance.getZones.mockResolvedValue([{ zone_id: 10, zone_name: 'Dhanmondi' }]);
        pathaoInstance.getAreas.mockResolvedValue([{ area_id: 100, area_name: 'Jigatola' }]);
    });

    test('walks city -> zone -> area and returns the resolved ids', async () => {
        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'pathao',
            providerInstance: pathaoInstance,
            order: orderWithAddress({
                area: 'Jigatola',
                upazila: 'Dhanmondi',
                district: 'Dhaka',
            }),
        });

        expect(result.decision).toBe('SERVICEABLE');
        expect(result.destination).toMatchObject({
            city_id: 1,
            zone_id: 10,
            area_id: 100,
        });
        expect(pathaoInstance.getZones).toHaveBeenCalledWith(1);
        expect(pathaoInstance.getAreas).toHaveBeenCalledWith(10);
    });

    test('a city miss is NOT_SERVICEABLE', async () => {
        pathaoInstance.getCities.mockResolvedValue([{ city_id: 1, city_name: 'Dhaka' }]);

        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'pathao',
            providerInstance: pathaoInstance,
            order: orderWithAddress({ area: 'Jigatola', district: 'Atlantis' }),
        });

        expect(result.decision).toBe('NOT_SERVICEABLE');
        expect(result.reason_code).toBe('CITY_NOT_FOUND');
    });

    test('incomplete destination is UNCERTAIN and never calls the directory', async () => {
        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'pathao',
            providerInstance: pathaoInstance,
            order: orderWithAddress({ district: 'Dhaka' }),
        });

        expect(result.decision).toBe('UNCERTAIN');
        expect(pathaoInstance.getCities).not.toHaveBeenCalled();
    });
});

describe('resolveDestination — Steadfast', () => {
    test('has no destination directory, so it answers UNCERTAIN honestly', async () => {
        const result = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'steadfast',
            providerInstance: {},
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });

        expect(result.decision).toBe('UNCERTAIN');
        expect(result.reason_code).toBe('PROVIDER_HAS_NO_DIRECTORY');
    });
});

describe('cache', () => {
    test('a definitive verdict is reused inside the TTL', async () => {
        redxAreas.mockResolvedValue([{ id: 1, name: 'Mirpur', district_name: 'Dhaka' }]);

        const first = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });
        const second = await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });

        expect(first.cached).toBeFalsy();
        expect(second.cached).toBe(true);
        expect(redxAreas).toHaveBeenCalledTimes(1);
    });

    test('a lookup failure is never cached', async () => {
        redxAreas.mockRejectedValue(new Error('boom'));

        await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });
        await destinationService.resolveDestination({
            shopId: 'shop-1',
            provider: 'redx',
            providerInstance: redxInstance,
            order: orderWithAddress({ area: 'Mirpur', district: 'Dhaka' }),
        });

        expect(redxAreas).toHaveBeenCalledTimes(2);
    });
});

describe('applyDestinationToOrderData', () => {
    test('writes RedX area keys from a resolved destination', () => {
        const orderData = { order_number: 'ORD-1' };
        destinationService.applyDestinationToOrderData(orderData, 'redx', {
            destination: { area_id: 5, area_name: 'Mirpur' },
        });

        expect(orderData).toMatchObject({ delivery_area_id: 5, delivery_area: 'Mirpur' });
    });

    test('writes Pathao location ids from a resolved destination', () => {
        const orderData = { order_number: 'ORD-1' };
        destinationService.applyDestinationToOrderData(orderData, 'pathao', {
            destination: { city_id: 1, zone_id: 10, area_id: 100 },
        });

        expect(orderData).toMatchObject({
            recipient_city: 1,
            recipient_zone: 10,
            recipient_area: 100,
        });
    });

    test('never writes destination keys when resolution produced none', () => {
        const orderData = { order_number: 'ORD-1' };
        destinationService.applyDestinationToOrderData(orderData, 'redx', {
            destination: {},
        });

        expect(orderData).not.toHaveProperty('delivery_area_id');
        expect(orderData).not.toHaveProperty('delivery_area');
    });
});