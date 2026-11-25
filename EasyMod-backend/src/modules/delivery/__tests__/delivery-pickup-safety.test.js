'use strict';

/**
 * Delivery pickup safety contracts introduced with the Delivery Settings
 * redesign (A5): safe pickup-location deletion, RedX store-list
 * normalization, merchant-confirmed external store creation, the
 * pickup-mutation concurrency guard, and the metadata pickup_enabled
 * readiness gate. All provider traffic here is mocked; nothing calls a live
 * courier API and no credential is real.
 *
 * Ordering rule: suites that require the REAL pickup-location.service /
 * delivery.service run before suites whose jest.doMock registrations of the
 * same modules would leak across isolate boundaries.
 */

const { AppError } = require('../../../utils/AppError');

const fakeIntegration = (overrides = {}) => ({
    id: 'integration-1',
    provider: 'pathao',
    is_connected: true,
    is_active: false,
    is_sandbox: false,
    credentials: { api_key: 'fake-key-not-secret' },
    pickup_location_id: null,
    provider_store_id: null,
    pickup_store_id: null,
    pickup_enabled: false,
    metadata: {},
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
});

describe('safe pickup location deletion', () => {
    const pickupMocks = ({ location, integrations }) => {
        const ShopPickupLocation = {
            findOne: jest.fn().mockResolvedValue(location),
        };
        const DeliveryIntegration = {
            findAll: jest.fn().mockResolvedValue(integrations),
        };
        const sequelize = {
            transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }),
        };
        jest.doMock('../shop-pickup-location.entity', () => ShopPickupLocation);
        jest.doMock('../delivery-integration.entity', () => ({ findAll: jest.fn(), findOne: jest.fn() }));
        jest.doMock('../../../utils/database/database-setup', () => ({ sequelize }));
        return { ShopPickupLocation, DeliveryIntegration };
    };

    beforeEach(() => {
        // Replace the shared entity mock so each test controls findAll itself.
        jest.doMock('../delivery-integration.entity', () => ({
            findAll: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
            sequelize: { query: jest.fn().mockResolvedValue([]) },
        }));
    });

    const locationRow = (overrides = {}) => ({
        dataValues: {
            id: 'pickup-1',
            shop_id: 'shop-1',
            is_default: false,
            provider: 'pathao',
            provider_store_id: 'store-1',
            ...overrides,
        },
        destroy: jest.fn().mockResolvedValue(1),
    });

    test('blocks the shop default without confirmation and never destroys', async () => {
        await jest.isolateModulesAsync(async () => {
            const location = locationRow({ is_default: true });
            const ShopPickupLocation = { findOne: jest.fn().mockResolvedValue(location) };
            jest.doMock('../shop-pickup-location.entity', () => ShopPickupLocation);
            jest.doMock('../delivery-integration.entity', () => ({
                findAll: jest.fn().mockResolvedValue([]),
                findOne: jest.fn(),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            }));
            jest.doMock('../../../utils/database/database-setup', () => ({
                sequelize: { transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
            }));
            const service = require('../pickup-location.service');

            let captured;
            try {
                await service.deletePickupLocation('shop-1', 'pickup-1');
            } catch (error) {
                captured = error;
            }

            expect(captured).toMatchObject({
                status: 409,
                code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
            });
            expect(captured.details.requires_confirmation).toBe(true);
            expect(captured.details.blockers.map((blocker) => blocker.code)).toEqual(['IS_SHOP_DEFAULT']);
            expect(location.destroy).not.toHaveBeenCalled();

            const result = await service.deletePickupLocation('shop-1', 'pickup-1', { confirm: true });
            expect(location.destroy).toHaveBeenCalledTimes(1);
            expect(result.deleted).toBe(true);
        });
    });

    test('blocks deletion while an integration selects the location and lists providers on force', async () => {
        await jest.isolateModulesAsync(async () => {
            const location = locationRow({ provider: 'pathao', provider_store_id: 'store-1' });
            jest.doMock('../shop-pickup-location.entity', () => ({ findOne: jest.fn().mockResolvedValue(location) }));
            jest.doMock('../delivery-integration.entity', () => ({
                findAll: jest.fn().mockResolvedValue([
                    {
                        provider: 'pathao',
                        pickup_location_id: 'pickup-1',
                        pickup_enabled: true,
                        provider_store_id: 'store-1',
                        pickup_store_id: 'store-1',
                    },
                ]),
                findOne: jest.fn(),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            }));
            jest.doMock('../../../utils/database/database-setup', () => ({
                sequelize: { transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
            }));
            const service = require('../pickup-location.service');

            let captured;
            try {
                await service.deletePickupLocation('shop-1', 'pickup-1');
            } catch (error) {
                captured = error;
            }
            expect(captured).toMatchObject({ status: 409, code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED' });
            expect(captured.details.blockers.map((blocker) => blocker.code)).toEqual(['IN_USE']);
            expect(captured.details.blockers[0].providers).toEqual(['pathao']);

            const result = await service.deletePickupLocation('shop-1', 'pickup-1', { confirm: true });
            expect(result.released_providers).toEqual(['pathao']);
        });
    });

    test('deletes an unreferenced, non-default location without extra confirmation', async () => {
        await jest.isolateModulesAsync(async () => {
            const location = locationRow();
            jest.doMock('../shop-pickup-location.entity', () => ({ findOne: jest.fn().mockResolvedValue(location) }));
            jest.doMock('../delivery-integration.entity', () => ({
                findAll: jest.fn().mockResolvedValue([{ provider: 'redx', pickup_location_id: 'other', pickup_enabled: false }]),
                findOne: jest.fn(),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            }));
            jest.doMock('../../../utils/database/database-setup', () => ({
                sequelize: { transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
            }));
            const service = require('../pickup-location.service');

            const result = await service.deletePickupLocation('shop-1', 'pickup-1');
            expect(location.destroy).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ id: 'pickup-1', deleted: true, released_providers: [] });
        });
    });

    test('pickup location deletion stays shop-scoped (cross-tenant denial)', async () => {
        await jest.isolateModulesAsync(async () => {
            const ShopPickupLocation = { findOne: jest.fn().mockResolvedValue(null) };
            jest.doMock('../shop-pickup-location.entity', () => ShopPickupLocation);
            jest.doMock('../delivery-integration.entity', () => ({
                findAll: jest.fn().mockResolvedValue([]),
                findOne: jest.fn(),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            }));
            jest.doMock('../../../utils/database/database-setup', () => ({
                sequelize: { transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
            }));
            const service = require('../pickup-location.service');

            await expect(service.deletePickupLocation('shop-a', 'pickup-of-shop-b'))
                .rejects.toMatchObject({ status: 404, code: 'PICKUP_LOCATION_NOT_FOUND' });
            expect(ShopPickupLocation.findOne).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'pickup-of-shop-b', shop_id: 'shop-a' },
            }));
        });
    });
});

describe('RedX pickup store listing (mocked adapter contract only)', () => {
    const serviceMocks = ({ provider, integration }) => {
        // Non-Pathao providers are constructed from the registry entry, so the
        // fake classes copy the mocked method object onto the instance.
        class CopyingProvider {
            constructor() {
                Object.assign(this, provider);
            }
        }
        jest.doMock('../delivery-integration.entity', () => ({
            findOne: jest.fn().mockResolvedValue(integration),
            sequelize: { query: jest.fn().mockResolvedValue([]) },
        }));
        jest.doMock('../../entities', () => ({ DeliveryIntegration: {}, ShopPickupLocation: {} }));
        jest.doMock('../pickup-location.service', () => ({
            getPickupLocation: jest.fn(),
            serializePickupLocation: jest.fn((location) => location),
            syncProviderStores: jest.fn().mockResolvedValue([]),
        }));
        jest.doMock('../pathao-token.service', () => ({
            createProvider: jest.fn().mockResolvedValue(provider),
        }));
        jest.doMock('../providers/provider.registry', () => ({
            COURIER_REGISTRY: {
                pathao: { Provider: CopyingProvider },
                steadfast: { Provider: CopyingProvider },
                redx: { Provider: CopyingProvider },
            },
        }));
    };

    test('normalizes every tolerated store-list envelope to canonical records', async () => {
        await jest.isolateModulesAsync(async () => {
            serviceMocks({ provider: {}, integration: fakeIntegration() });
            const deliveryService = require('../delivery.service');
            const { normalizeProviderStoreList } = deliveryService._private;

            expect(normalizeProviderStoreList([
                { store_id: 'x', store_name: 'X Hub' },
                { no_id: true },
            ])).toEqual([
                {
                    store_id: 'x',
                    id: 'x',
                    name: 'X Hub',
                    address: null,
                    phone: null,
                    city_id: null,
                    zone_id: null,
                    area_id: null,
                },
            ]);

            const envelopeShapes = [
                { stores: [{ id: 7, name: 'Y Hub', cityId: 2, zoneId: 4, areaId: 9, address: 'House 1' }] },
                { data: { stores: [{ id: 7, name: 'Y Hub', city: { id: 2 }, zone: { id: 4 }, area: { id: 9 }, address: 'House 1' }] } },
                { data: [{ store_id: 7, store_name: 'Y Hub', city_id: '2', zone_id: '4', area_id: '9', address: 'House 1' }] },
            ];
            for (const shape of envelopeShapes) {
                expect(normalizeProviderStoreList(shape)).toEqual([
                    {
                        store_id: '7',
                        id: '7',
                        name: 'Y Hub',
                        address: 'House 1',
                        phone: null,
                        city_id: 2,
                        zone_id: 4,
                        area_id: 9,
                    },
                ]);
            }

            expect(normalizeProviderStoreList(null)).toEqual([]);
            expect(normalizeProviderStoreList({ unexpected: 'envelope' })).toEqual([]);
        });
    });

    test('lists RedX stores through the connected provider path, normalized', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {
                listPickupStores: jest.fn().mockResolvedValue({
                    data: { stores: [{ id: 77, store_name: 'Dhanmondi Hub', cityId: 2, zoneId: 4, areaId: 9 }] },
                }),
            };
            serviceMocks({ provider, integration: fakeIntegration({ provider: 'redx' }) });
            const deliveryService = require('../delivery.service');

            const stores = await deliveryService.getProviderStores('shop-1', 'redx');
            expect(stores).toEqual([
                {
                    store_id: '77',
                    id: '77',
                    name: 'Dhanmondi Hub',
                    address: null,
                    phone: null,
                    city_id: 2,
                    zone_id: 4,
                    area_id: 9,
                },
            ]);
        });
    });

    test('the pure-read flag canonicalizes the raw Pathao listing; the import path keeps it raw', async () => {
        await jest.isolateModulesAsync(async () => {
            const raw = [
                { store_id: 101, store_name: 'Gulshan Hub', address: 'House 1', phone: '01700000000', city_id: 1, zone_id: 2, area_id: 3 },
                { name: 'Ghost With No Id' },
            ];
            const provider = { getStores: jest.fn().mockResolvedValue(raw) };
            serviceMocks({ provider, integration: fakeIntegration({ provider: 'pathao' }) });
            const deliveryService = require('../delivery.service');

            // GET /:provider/stores passes through the same tolerant
            // normalizer RedX uses.
            await expect(deliveryService.getProviderStores('shop-1', 'pathao', { canonical: true }))
                .resolves.toEqual([
                    {
                        store_id: '101', id: '101', name: 'Gulshan Hub', address: 'House 1',
                        phone: '01700000000', city_id: 1, zone_id: 2, area_id: 3,
                    },
                ]);

            // POST/sync (no flag) keeps today's raw token-recovered listing.
            provider.getStores.mockResolvedValueOnce(raw);
            await expect(deliveryService.getProviderStores('shop-1', 'pathao')).resolves.toBe(raw);
        });
    });

    test('steadfast pickup store listing stays a manual 409 with manual guidance details', async () => {
        await jest.isolateModulesAsync(async () => {
            serviceMocks({ provider: {}, integration: fakeIntegration({ provider: 'steadfast' }) });
            const deliveryService = require('../delivery.service');

            await expect(deliveryService.getProviderStores('shop-1', 'steadfast'))
                .rejects.toMatchObject({
                    status: 409,
                    code: 'DELIVERY_PROVIDER_MANUAL_PICKUP',
                    details: { provider: 'steadfast', manual_step: 'CONFIGURE_PICKUP_MANUALLY' },
                });
        });
    });
});

describe('merchant-confirmed external pickup store creation', () => {
    const createMocks = ({ provider, integration, pickupLocationService }) => {
        jest.doMock('../delivery-integration.entity', () => ({
            findOne: jest.fn().mockResolvedValue(integration),
            sequelize: { query: jest.fn().mockResolvedValue([]) },
        }));
        jest.doMock('../../entities', () => ({ DeliveryIntegration: {}, ShopPickupLocation: {} }));
        jest.doMock('../pickup-location.service', () => pickupLocationService);
        jest.doMock('../pathao-token.service', () => ({
            createProvider: jest.fn().mockResolvedValue(provider),
        }));
        jest.doMock('../providers/provider.registry', () => ({
            COURIER_REGISTRY: { pathao: { Provider: class FakePathao {} } },
        }));
    };

    const manualLocationService = () => ({
        getPickupLocation: jest.fn().mockResolvedValue({
            id: 'pickup-old', shop_id: 'shop-1', provider: 'manual', display_name: 'Old hub', address: 'Dhaka', area_name: 'Mirpur',
        }),
        serializePickupLocation: jest.fn((location) => location),
        syncProviderStores: jest.fn().mockResolvedValue([{ id: 'row-new' }]),
    });

    test('without confirm=true it never calls the provider and returns the preview contract', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = { createStore: jest.fn() };
            const integration = fakeIntegration();
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            let captured;
            try {
                await deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                    name: 'New Hub',
                    address: 'House 9, Dhaka',
                });
            } catch (error) {
                captured = error;
            }

            expect(captured).toMatchObject({
                status: 409,
                code: 'DELIVERY_PROVIDER_STORE_CONFIRMATION_REQUIRED',
            });
            expect(captured.details).toMatchObject({
                provider: 'pathao',
                requires_confirmation: true,
                action: 'create_provider_store',
                store_preview: { name: 'New Hub', address: 'House 9, Dhaka' },
            });
            expect(provider.createStore).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('with confirm=true it creates at the provider, syncs the row and persists the link', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = { createStore: jest.fn().mockResolvedValue({ success: true, store_id: 4242, store_name: 'New Hub' }) };
            const integration = fakeIntegration({ pickup_location_id: 'pickup-old', metadata: { pickup_location_id: 'pickup-old' } });
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            const result = await deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                confirm: true,
                name: 'New Hub',
                address: 'House 9, Dhaka',
                phone: '01700000000',
                city_id: 1,
                zone_id: 2,
                area_id: 3,
            });

            expect(provider.createStore).toHaveBeenCalledTimes(1);
            expect(provider.createStore).toHaveBeenCalledWith(expect.objectContaining({
                name: 'New Hub',
                store_name: 'New Hub',
                address: 'House 9, Dhaka',
                phone: '01700000000',
                city_id: 1,
                zone_id: 2,
                area_id: 3,
            }));
            expect(result).toMatchObject({ provider: 'pathao', created: true, capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED' });
            expect(result.store).toMatchObject({ store_id: '4242', name: 'New Hub' });
            expect(pickupLocationService.syncProviderStores).toHaveBeenCalledWith('shop-1', 'pathao', [
                expect.objectContaining({ store_id: '4242' }),
            ]);
            // Link persisted; previous pickup-location selection preserved.
            expect(result.config.pickup_store_id).toBe('4242');
            expect(result.config.pickup_location_id).toBe('pickup-old');
            expect(integration.provider_store_id).toBe('4242');
        });
    });

    test('a concurrent duplicate create is rejected while the first is in flight', async () => {
        await jest.isolateModulesAsync(async () => {
            let resolveCreate;
            const provider = {
                createStore: jest.fn(() => new Promise((resolve) => { resolveCreate = resolve; })),
            };
            const integration = fakeIntegration();
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            const first = deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                confirm: true, name: 'Race Hub', address: 'House 9, Dhaka',
            });
            // Let the first call reach the in-flight provider create before
            // submitting the duplicate.
            await new Promise((resolve) => setImmediate(resolve));
            expect(provider.createStore).toHaveBeenCalledTimes(1);
            await expect(deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                confirm: true, name: 'Race Hub', address: 'House 9, Dhaka',
            })).rejects.toMatchObject({ status: 409, code: 'DELIVERY_MUTATION_IN_PROGRESS' });

            resolveCreate({ store_id: 'store-concurrent', store_name: 'Race Hub' });
            const result = await first;
            expect(result.store.store_id).toBe('store-concurrent');
            expect(provider.createStore).toHaveBeenCalledTimes(1);
        });
    });

    test('a provider that returns no store id is never claimed as created', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = { createStore: jest.fn().mockResolvedValue({ success: true }) };
            const integration = fakeIntegration();
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            await expect(deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                confirm: true, name: 'No Id Hub', address: 'House 9, Dhaka',
            })).rejects.toMatchObject({ status: 502, code: 'DELIVERY_PICKUP_STORE_SYNC_FAILED' });
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
        });
    });

    test('steadfast creation stays manual with an explicit 409', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {};
            const integration = fakeIntegration({ provider: 'steadfast' });
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            await expect(deliveryService.createProviderPickupStore('shop-1', 'steadfast', {
                confirm: true, name: 'Hub', address: 'House 9, Dhaka',
            })).rejects.toMatchObject({
                status: 409,
                code: 'DELIVERY_PROVIDER_MANUAL_PICKUP',
                details: { provider: 'steadfast', manual_step: 'CONFIGURE_PICKUP_MANUALLY' },
            });
        });
    });

    test('a provider without a create-store hook answers CREATE_UNSUPPORTED and promises the portal step', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {}; // adapter exposes no createStore/createPickupStore hook
            const integration = fakeIntegration();
            const pickupLocationService = manualLocationService();
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            await expect(deliveryService.createProviderPickupStore('shop-1', 'pathao', {
                confirm: true, name: 'Hub', address: 'House 9, Dhaka',
            })).rejects.toMatchObject({
                status: 409,
                code: 'DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED',
                details: { provider: 'pathao', manual_step: 'CREATE_IN_PROVIDER_PORTAL' },
            });
            expect(provider.createStore).toBeUndefined();
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
        });
    });

    test('cross-tenant: a pickup location from another shop is never created against', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = { createStore: jest.fn() };
            const integration = fakeIntegration();
            const pickupLocationService = manualLocationService();
            pickupLocationService.getPickupLocation.mockRejectedValue(new AppError(
                'Pickup location not found', 404, 'PICKUP_LOCATION_NOT_FOUND',
            ));
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            // The create endpoint carries no location id at all (the provider
            // store id is authoritative and the row is synced afterwards), so
            // shop scoping is exercised through the shared guard here: an
            // unrelated location lookup failure must not be swallowed.
            await expect(deliveryService.setPickupConfiguration('shop-a', 'pathao', {
                pickup_location_id: 'pickup-of-shop-b',
            })).rejects.toMatchObject({ status: 404, code: 'PICKUP_LOCATION_NOT_FOUND' });
            expect(provider.createStore).not.toHaveBeenCalled();
        });
    });

    test('sync re-resolution is guarded against concurrent pickup mutations', async () => {
        await jest.isolateModulesAsync(async () => {
            let resolveStores;
            const provider = { getStores: jest.fn(() => new Promise((resolve) => { resolveStores = resolve; })) };
            const integration = fakeIntegration();
            const pickupLocationService = {
                getPickupLocation: jest.fn().mockResolvedValue({
                    id: 'pickup-1', shop_id: 'shop-1', provider: 'manual', provider_store_id: null,
                    display_name: 'Hub', address: 'Dhaka', area_name: 'Dhanmondi', city_id: 1, zone_id: 2, area_id: 3,
                }),
                serializePickupLocation: jest.fn((location) => location),
            };
            createMocks({ provider, integration, pickupLocationService });
            const deliveryService = require('../delivery.service');

            const first = deliveryService.syncProviderPickup('shop-1', 'pathao', { pickup_location_id: 'pickup-1' });
            await new Promise((resolve) => setImmediate(resolve));
            expect(provider.getStores).toHaveBeenCalledTimes(1);
            await expect(deliveryService.syncProviderPickup('shop-1', 'pathao', { pickup_location_id: 'pickup-1' }))
                .rejects.toMatchObject({ status: 409, code: 'DELIVERY_MUTATION_IN_PROGRESS' });

            resolveStores([]);
            const result = await first;
            expect(result.store_resolution).toBe('NO_MATCH');
        });
    });
});

describe('delivery controller structured pickup endpoints', () => {
    test('GET /:provider/stores is a PURE READ: canonical stores, zero writes, no pickup_locations', async () => {
        await jest.isolateModulesAsync(async () => {
            // Metadata pre-seeded by an earlier explicit import: a GET must
            // leave the cached listing and timestamp untouched.
            const cached = { store_id: '77', store_name: 'Old cache' };
            const integration = fakeIntegration({
                provider: 'redx',
                metadata: { stores: [cached], stores_synced_at: '2026-01-01T00:00:00.000Z' },
            });
            const canonical = {
                store_id: '77', id: '77', name: 'Dhanmondi Hub', address: 'House 1',
                phone: null, city_id: 2, zone_id: 4, area_id: 9,
            };
            const deliveryService = { getProviderStores: jest.fn().mockResolvedValue([canonical]) };
            const pickupLocationService = { syncProviderStores: jest.fn().mockResolvedValue([{ id: 'row-1' }]) };

            jest.doMock('../delivery-integration.entity', () => ({ findOne: jest.fn().mockResolvedValue(integration) }));
            jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
            jest.doMock('../delivery.service', () => deliveryService);
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
            jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { label: 'Pathao' }, steadfast: { label: 'Steadfast' }, redx: { label: 'RedX' } },
            }));

            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.getProviderStores(
                { user: { shopId: 'shop-1' }, params: { provider: 'redx' }, method: 'GET' },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
            // The read asks the service for the canonical listing shape.
            expect(deliveryService.getProviderStores).toHaveBeenCalledWith('shop-1', 'redx', { canonical: true });
            // Pure read: no pickup rows are upserted, nothing is saved, and
            // the cached listing / stores_synced_at are unchanged.
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
            expect(integration.metadata).toEqual({
                stores: [cached],
                stores_synced_at: '2026-01-01T00:00:00.000Z',
            });
            const body = json.mock.calls[0][0];
            expect(body).toMatchObject({
                success: true,
                data: {
                    provider: 'redx',
                    stores: [canonical],
                    capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
                },
            });
            // GET must OMIT pickup_locations entirely (A6 mocks this delta).
            expect(body.data).not.toHaveProperty('pickup_locations');
            expect(JSON.stringify(body)).not.toContain('fake-key-not-secret');

            // Steadfast stays the structured manual 409 WITH its guidance
            // details intact through the controller layer.
            const json2 = jest.fn();
            const res2 = { json: json2, status: jest.fn(() => res2) };
            const next2 = jest.fn();
            await controller.getProviderStores(
                { user: { shopId: 'shop-1' }, params: { provider: 'steadfast' }, method: 'GET' },
                res2,
                next2,
            );
            expect(next2).not.toHaveBeenCalled();
            expect(res2.status).toHaveBeenCalledWith(409);
            expect(json2).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'DELIVERY_PROVIDER_MANUAL_PICKUP',
                details: expect.objectContaining({
                    provider: 'steadfast',
                    manual_step: 'CONFIGURE_PICKUP_MANUALLY',
                }),
            }));
        });
    });

    test('GET /:provider/stores on a connected Pathao shop persists nothing (zero new pickup rows, metadata unchanged)', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration({ provider: 'pathao' });
            // The raw token-recovered Pathao listing (serializeStore keeps
            // these whitelisted fields when the mocked service bypasses the
            // real canonicalizer; the service-layer canonicalization is
            // asserted separately).
            const rawStores = [
                { store_id: 101, store_name: 'Gulshan Hub', address: 'House 1, Dhaka' },
                { store_id: 102, store_name: 'Mirpur Hub' },
            ];
            const deliveryService = { getProviderStores: jest.fn().mockResolvedValue(rawStores) };
            const pickupLocationService = { syncProviderStores: jest.fn().mockResolvedValue([]) };

            jest.doMock('../delivery-integration.entity', () => ({ findOne: jest.fn().mockResolvedValue(integration) }));
            jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
            jest.doMock('../delivery.service', () => deliveryService);
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
            jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { label: 'Pathao' } },
            }));

            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.getProviderStores(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, method: 'GET' },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            // Row upserts happen only through syncProviderStores — a GET must
            // not invoke it at all, and the integration row is not saved.
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
            expect(integration.metadata).toEqual({});
            expect(deliveryService.getProviderStores).toHaveBeenCalledWith('shop-1', 'pathao', { canonical: true });
            const body = json.mock.calls[0][0];
            expect(body.success).toBe(true);
            expect(body.data.stores.map((store) => store.store_id)).toEqual([101, 102]);
            expect(body.data).not.toHaveProperty('pickup_locations');
        });
    });

    test('structured AMBIGUOUS sync errors reach the merchant UI with candidates', async () => {
        await jest.isolateModulesAsync(async () => {
            const deliveryService = {
                syncProviderPickup: jest.fn().mockRejectedValue(new AppError(
                    'Multiple provider pickup stores match this location. Select the intended store explicitly.',
                    409,
                    'DELIVERY_PICKUP_AMBIGUOUS',
                    { provider: 'pathao', candidates: [{ store_id: 'store-a' }, { store_id: 'store-b' }] },
                )),
            };
            jest.doMock('../delivery-integration.entity', () => ({ findOne: jest.fn() }));
            jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
            jest.doMock('../delivery.service', () => deliveryService);
            jest.doMock('../pickup-location.service', () => ({ listPickupLocations: jest.fn() }));
            jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
            jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { label: 'Pathao' } },
            }));

            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.syncProviderPickup(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, body: { pickup_location_id: 'pickup-1' } },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(409);
            expect(json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'DELIVERY_PICKUP_AMBIGUOUS',
                details: expect.objectContaining({
                    candidates: [{ store_id: 'store-a' }, { store_id: 'store-b' }],
                }),
            }));
        });
    });

    test('the controller passes ?confirm=true through to the safe-delete guard and answers blockers', async () => {
        await jest.isolateModulesAsync(async () => {
            const pickupLocationService = { deletePickupLocation: jest.fn().mockResolvedValue({ id: 'pickup-1', deleted: true }) };
            jest.doMock('../delivery-integration.entity', () => ({ findOne: jest.fn() }));
            jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
            jest.doMock('../delivery.service', () => ({}));
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
            jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
            jest.doMock('../providers/provider.registry', () => ({ COURIER_REGISTRY: {} }));

            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.deletePickupLocation(
                { user: { shopId: 'shop-1' }, params: { locationId: 'pickup-1' }, query: { confirm: 'true' } },
                res,
                next,
            );
            expect(pickupLocationService.deletePickupLocation).toHaveBeenCalledWith('shop-1', 'pickup-1', { confirm: true });

            pickupLocationService.deletePickupLocation.mockRejectedValueOnce(new AppError(
                'Pickup location is in use. Confirm the deletion to continue.',
                409,
                'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                { blockers: [{ code: 'IN_USE' }], requires_confirmation: true },
            ));
            const next2 = jest.fn();
            await controller.deletePickupLocation(
                { user: { shopId: 'shop-1' }, params: { locationId: 'pickup-1' }, query: {} },
                res,
                next2,
            );
            expect(next2).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(409);
            expect(json).toHaveBeenLastCalledWith(expect.objectContaining({
                code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                details: expect.objectContaining({ blockers: [{ code: 'IN_USE' }] }),
            }));
        });
    });
});

describe('metadata pickup_enabled readiness gate', () => {
    const updateMetadataMocks = ({ integration, readiness }) => {
        jest.doMock('../delivery-integration.entity', () => ({
            findOne: jest.fn().mockResolvedValue(integration),
        }));
        jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
        jest.doMock('../delivery.service', () => ({}));
        jest.doMock('../pickup-location.service', () => ({ listPickupLocations: jest.fn() }));
        jest.doMock('../courier-readiness.service', () => ({
            getReadiness: jest.fn().mockResolvedValue(readiness),
        }));
        jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
        jest.doMock('../providers/provider.registry', () => ({
            COURIER_REGISTRY: { pathao: { label: 'Pathao' } },
        }));
    };

    test('store selection through /metadata must pass the activation readiness gate', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration({
                metadata: { pickup_enabled: false },
                pickup_enabled: false,
                pickup_store_id: null,
            });
            updateMetadataMocks({
                integration,
                readiness: { ready: false, missing: ['pickup_area_id', 'provider_not_active'] },
            });
            const controller = require('../delivery.controller');
            const next = jest.fn();
            const res = { json: jest.fn(), status: jest.fn(() => res) };

            await controller.updateMetadata(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, body: { metadata: { store_id: 'store-9' } } },
                res,
                next,
            );

            expect(next).toHaveBeenCalledWith(expect.objectContaining({
                status: 409,
                code: 'DELIVERY_NOT_READY',
            }));
            expect(next.mock.calls[0][0].details.missing).toEqual(['pickup_area_id']);
            expect(integration.pickup_enabled).toBe(false);
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('a ready courier setup accepts the store and enables pickup', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration({
                metadata: { pickup_enabled: false },
                pickup_enabled: false,
                pickup_store_id: null,
            });
            updateMetadataMocks({ integration, readiness: { ready: true, missing: [] } });
            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.updateMetadata(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, body: { metadata: { store_id: 'store-9' } } },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            expect(integration.pickup_enabled).toBe(true);
            expect(integration.pickup_store_id).toBe('store-9');
            expect(integration.provider_store_id).toBe('store-9');
            expect(integration.save).toHaveBeenCalledTimes(1);
            expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        });
    });
});

describe('selective provider store import (POST /:provider/stores/sync store_ids)', () => {
    const canonicalStore = (id, name) => ({
        store_id: id, id, name, address: 'House 1', phone: null,
        city_id: 2, zone_id: 4, area_id: 9,
    });

    const controllerMocks = ({ stores, integration, syncResult }) => {
        const deliveryService = { getProviderStores: jest.fn().mockResolvedValue(stores) };
        const pickupLocationService = {
            syncProviderStores: jest.fn().mockResolvedValue(syncResult || []),
            listPickupLocations: jest.fn(),
        };
        const DeliveryIntegration = { findOne: jest.fn().mockResolvedValue(integration) };
        jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
        jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
        jest.doMock('../delivery.service', () => deliveryService);
        jest.doMock('../pickup-location.service', () => pickupLocationService);
        jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
        jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
        jest.doMock('../providers/provider.registry', () => ({
            COURIER_REGISTRY: { pathao: { label: 'Pathao' }, redx: { label: 'RedX' } },
        }));
        return { deliveryService, pickupLocationService, DeliveryIntegration };
    };

    const call = (controller, { method = 'POST', provider = 'pathao', body, shopId = 'shop-1' } = {}) => {
        const json = jest.fn();
        const res = { json, status: jest.fn(() => res) };
        const next = jest.fn();
        const req = { user: { shopId }, params: { provider }, method };
        if (body !== undefined) req.body = body;
        return controller.getProviderStores(req, res, next).then(() => ({ json, res, next }));
    };

    test('mirrors only the requested store and keeps the full catalog cached', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('77', 'Dhanmondi Hub'), canonicalStore('88', 'Uttara Hub')];
            const { pickupLocationService } = controllerMocks({
                stores, integration, syncResult: [{ id: 'row-77', provider_store_id: '77' }],
            });
            const controller = require('../delivery.controller');

            const { json, next } = await call(controller, { body: { store_ids: ['77'] } });

            expect(next).not.toHaveBeenCalled();
            expect(pickupLocationService.syncProviderStores).toHaveBeenCalledTimes(1);
            expect(pickupLocationService.syncProviderStores).toHaveBeenCalledWith('shop-1', 'pathao', [
                expect.objectContaining({ store_id: '77', name: 'Dhanmondi Hub' }),
            ]);
            const synced = pickupLocationService.syncProviderStores.mock.calls[0][2];
            expect(synced).toHaveLength(1);
            expect(synced[0].store_id).toBe('77');
            expect(json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    stores: [expect.objectContaining({ store_id: '77' })],
                    pickup_locations: [{ id: 'row-77', provider_store_id: '77' }],
                }),
            }));
            expect(integration.metadata.stores.map((s) => s.store_id)).toEqual(['77', '88']);
        });
    });

    test('an unmatched id answers a structured 409 listing it and never syncs', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('77', 'Dhanmondi Hub')];
            const { pickupLocationService } = controllerMocks({ stores, integration });
            const controller = require('../delivery.controller');

            const { json, res, next } = await call(controller, { body: { store_ids: ['77', 'does-not-exist'] } });

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(409);
            expect(json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'DELIVERY_STORE_IDS_UNMATCHED',
                details: expect.objectContaining({
                    provider: 'pathao',
                    unmatched_store_ids: ['does-not-exist'],
                }),
            }));
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('matching is case/whitespace tolerant and unmatched ids keep their original casing', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('AB', 'Alpha Hub')];
            const { pickupLocationService } = controllerMocks({ stores, integration, syncResult: [{ id: 'row-ab' }] });
            const controller = require('../delivery.controller');

            const ok = await call(controller, { body: { store_ids: ['  ab  '] } });
            expect(ok.next).not.toHaveBeenCalled();
            expect(pickupLocationService.syncProviderStores).toHaveBeenCalledWith('shop-1', 'pathao', [
                expect.objectContaining({ store_id: 'AB' }),
            ]);

            pickupLocationService.syncProviderStores.mockClear();
            const bad = await call(controller, { body: { store_ids: ['AB', 'MissingId'] } });
            expect(bad.res.status).toHaveBeenCalledWith(409);
            expect(bad.json).toHaveBeenCalledWith(expect.objectContaining({
                code: 'DELIVERY_STORE_IDS_UNMATCHED',
                details: expect.objectContaining({ unmatched_store_ids: ['MissingId'] }),
            }));
        });
    });

    test('absent or empty store_ids keeps the full-listing sync; a GET never imports even with a body', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('77', 'Dhanmondi Hub'), canonicalStore('88', 'Uttara Hub')];
            const { pickupLocationService } = controllerMocks({ stores, integration, syncResult: [{ id: 'row-77' }, { id: 'row-88' }] });
            const controller = require('../delivery.controller');

            await call(controller, {});
            expect(pickupLocationService.syncProviderStores).toHaveBeenLastCalledWith('shop-1', 'pathao', [
                expect.objectContaining({ store_id: '77' }),
                expect.objectContaining({ store_id: '88' }),
            ]);

            await call(controller, { body: { store_ids: [] } });
            expect(pickupLocationService.syncProviderStores).toHaveBeenLastCalledWith('shop-1', 'pathao', [
                expect.objectContaining({ store_id: '77' }),
                expect.objectContaining({ store_id: '88' }),
            ]);

            // GET is a pure read now: an ignored body must not trigger the
            // import path — zero row upserts, zero saves, unchanged cache.
            pickupLocationService.syncProviderStores.mockClear();
            integration.save.mockClear();
            const cacheBeforeGet = JSON.parse(JSON.stringify(integration.metadata));
            const { json, next } = await call(controller, { method: 'GET', body: { store_ids: ['77'] } });
            expect(next).not.toHaveBeenCalled();
            expect(pickupLocationService.syncProviderStores).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
            // The cached listing written by the earlier POSTs survives a GET
            // byte-identical: staleness keeps reflecting the last IMPORT.
            expect(integration.metadata).toEqual(cacheBeforeGet);
            const body = json.mock.calls[0][0];
            expect(body.data.stores.map((store) => store.store_id)).toEqual(['77', '88']);
            expect(body.data).not.toHaveProperty('pickup_locations');
        });
    });

    test('the POST import path still reads the provider listing without the canonical flag', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('77', 'Dhanmondi Hub')];
            const { deliveryService } = controllerMocks({ stores, integration, syncResult: [{ id: 'row-77' }] });
            const controller = require('../delivery.controller');

            const { next } = await call(controller, { body: { store_ids: ['77'] } });
            expect(next).not.toHaveBeenCalled();
            expect(deliveryService.getProviderStores).toHaveBeenCalledWith('shop-1', 'pathao', { canonical: false });
            expect(integration.save).toHaveBeenCalledTimes(1);
            expect(typeof integration.metadata.stores_synced_at).toBe('string');
        });
    });

    test('selective import stays bound to the JWT shop (cross-tenant isolation)', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = fakeIntegration();
            const stores = [canonicalStore('77', 'Dhanmondi Hub')];
            const { pickupLocationService, DeliveryIntegration } = controllerMocks({ stores, integration, syncResult: [{ id: 'row-77' }] });
            const controller = require('../delivery.controller');

            await call(controller, { shopId: 'shop-2', body: { store_ids: ['77'] } });

            expect(DeliveryIntegration.findOne).toHaveBeenCalledWith(expect.objectContaining({
                where: { shop_id: 'shop-2', provider: 'pathao' },
            }));
            expect(pickupLocationService.syncProviderStores).toHaveBeenCalledWith('shop-2', 'pathao', [
                expect.objectContaining({ store_id: '77' }),
            ]);
            expect(DeliveryIntegration.findOne.mock.calls[0][0].where.shop_id).toBe('shop-2');
            expect(pickupLocationService.syncProviderStores.mock.calls[0][0]).toBe('shop-2');
        });
    });
});

describe('structured pickup error details survive the controller layer', () => {
    const wireController = ({ createError, configureError }) => {
        const deliveryService = {
            createProviderPickupStore: jest.fn().mockRejectedValue(createError),
            setPickupConfiguration: jest.fn().mockRejectedValue(configureError),
        };
        jest.doMock('../delivery-integration.entity', () => ({ findOne: jest.fn() }));
        jest.doMock('../../entities', () => ({ Shop: { findByPk: jest.fn() } }));
        jest.doMock('../delivery.service', () => deliveryService);
        jest.doMock('../pickup-location.service', () => ({ listPickupLocations: jest.fn() }));
        jest.doMock('../courier-readiness.service', () => ({ getReadiness: jest.fn() }));
        jest.doMock('../../../utils/shop-settings-cache', () => ({ invalidateShopSettingsCaches: jest.fn() }));
        jest.doMock('../providers/provider.registry', () => ({
            COURIER_REGISTRY: { pathao: { label: 'Pathao' }, steadfast: { label: 'Steadfast' } },
        }));
        return deliveryService;
    };

    test('DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED answers with manual_step guidance, not a stripped 409', async () => {
        await jest.isolateModulesAsync(async () => {
            wireController({
                createError: new AppError(
                    'This provider cannot create pickup stores from EasyModerator. Create it in the provider portal and link it.',
                    409,
                    'DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED',
                    { provider: 'pathao', manual_step: 'CREATE_IN_PROVIDER_PORTAL' },
                ),
            });
            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.createProviderPickupStore(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, body: { confirm: true, name: 'Hub', address: 'House 9, Dhaka' } },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(409);
            expect(json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED',
                details: expect.objectContaining({
                    provider: 'pathao',
                    manual_step: 'CREATE_IN_PROVIDER_PORTAL',
                }),
            }));
        });
    });

    test('DELIVERY_PICKUP_SOURCE_REQUIRED answers through the pickup-configuration route with missing[]', async () => {
        await jest.isolateModulesAsync(async () => {
            wireController({
                configureError: new AppError(
                    'Pickup can only be enabled with a pickup location or a provider store selected',
                    409,
                    'DELIVERY_PICKUP_SOURCE_REQUIRED',
                    { provider: 'pathao', missing: ['pickup_location', 'provider_store'] },
                ),
            });
            const controller = require('../delivery.controller');
            const json = jest.fn();
            const res = { json, status: jest.fn(() => res) };
            const next = jest.fn();

            await controller.setPickupConfiguration(
                { user: { shopId: 'shop-1' }, params: { provider: 'pathao' }, body: { enabled: true } },
                res,
                next,
            );

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(409);
            expect(json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'DELIVERY_PICKUP_SOURCE_REQUIRED',
                // Mirrors DELIVERY_NOT_READY's missing[] so the existing
                // getConflictMissing path in the UI reads it.
                details: expect.objectContaining({
                    provider: 'pathao',
                    missing: ['pickup_location', 'provider_store'],
                }),
            }));
        });
    });
});
